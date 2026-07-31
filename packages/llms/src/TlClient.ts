/**
 * Tl AI Client
 * Supports session initialization and streaming chat for the chatbbc API.
 */
import * as z from 'zod/v4'

import { InvokeError, InvokeErrorTypes } from './errors'

import type { InvokeOptions, InvokeResult, LLMClient, Message, Tool } from './types'

/**
 * Tool calling mode for Tl AI.
 */
export type ToolCallingMode = 'api' | 'system_prompt'

/**
 * Configuration for Tl AI (chatbbc) endpoint.
 */
export interface TlAiConfig {
	/** Agent host or HTTP(S) base URL, e.g. "localhost:8089" or "https://api.example.com". */
	endpointAgent: string
	/** Model / prompt name used during session initialization. */
	model: string
	appId?: string
	trCode?: string
	trVersion?: string
	/** Tool calling mode, default 'system_prompt'. */
	toolCallingMode?: ToolCallingMode
	/** Optional custom fetch implementation. */
	customFetch?: typeof globalThis.fetch
}

interface InitSessionRequest {
	appId: string
	trCode: string
	trVersion: string
	timestamp: number
	requestId: string
	data: {
		prompt_variables: { name: string; value: string }[]
	}
}

interface ChatRequest {
	appId: string
	trCode: string
	trVersion: string
	timestamp: number
	requestId: string
	data: {
		session_id: string
		txt: string
		files: { file_id: string; url: string; content_type: string }[]
		stream: boolean
	}
}

function normalizeEndpointAgent(endpointAgent: string): string {
	const value = endpointAgent.trim()
	const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`

	let url: URL
	try {
		url = new URL(candidate)
	} catch (error) {
		throw new InvokeError(
			InvokeErrorTypes.CONFIG_ERROR,
			`Invalid Tl endpointAgent "${endpointAgent}". Use a host such as "localhost:8089" or a full HTTP(S) URL.`,
			error
		)
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new InvokeError(
			InvokeErrorTypes.CONFIG_ERROR,
			`Unsupported Tl endpointAgent protocol "${url.protocol}". Use HTTP or HTTPS.`
		)
	}

	url.search = ''
	url.hash = ''
	return url.toString().replace(/\/$/, '')
}

function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error)

	const cause = (error as Error & { cause?: unknown }).cause
	if (!cause || cause === error) return error.message

	let causeMessage: string
	if (cause instanceof Error) {
		causeMessage = cause.message
	} else if (typeof cause === 'string') {
		causeMessage = cause
	} else {
		try {
			causeMessage = JSON.stringify(cause) ?? Object.prototype.toString.call(cause)
		} catch {
			causeMessage = Object.prototype.toString.call(cause)
		}
	}
	return causeMessage && causeMessage !== error.message
		? `${error.message}: ${causeMessage}`
		: error.message
}

/**
 * Extract `{ toolName, toolArgs }` from a parsed response object.
 *
 * Recognized shapes (checked in order):
 * 1. `{ tool_name: "...", parameters|args: {...} }`          — legacy Tl shape
 * 2. `{ name: "...", arguments: {...} }`                       — OpenAI tool_call shape
 * 3. `{ action: { "<tool>": {...} }, ...reflection fields }`   — PageAgent MacroTool shape
 * 4. `{ action: "<tool>", parameters|args: {...} }`            — legacy string-action shape
 *
 * For shape 3, if the inner tool name is not registered but an `AgentOutput`
 * macro tool exists, the entire object is returned as `AgentOutput`'s args
 * so PageAgentCore can still drive the macro-tool execution path.
 *
 * Returns `null` when no recognizable tool call is present.
 */
function extractToolCall(
	obj: any,
	tools: Record<string, Tool>
): { toolName: string; toolArgs: unknown } | null {
	if (!obj || typeof obj !== 'object') return null

	// 1) { tool_name, parameters|args }
	if (typeof obj.tool_name === 'string') {
		return { toolName: obj.tool_name, toolArgs: obj.parameters ?? obj.args ?? {} }
	}

	// 2) { name, arguments }
	if (typeof obj.name === 'string') {
		return { toolName: obj.name, toolArgs: obj.arguments ?? {} }
	}

	// 3) { action: { <tool>: {...} } }
	if (obj.action && typeof obj.action === 'object') {
		const actionKeys = Object.keys(obj.action)
		if (actionKeys.length === 0) return null
		const extractedToolName = actionKeys[0]
		const extractedToolArgs = obj.action[extractedToolName]

		if (tools[extractedToolName]) {
			return { toolName: extractedToolName, toolArgs: extractedToolArgs }
		}
		if (tools.AgentOutput) {
			// Macro tool case: hand the whole reflection+action object to AgentOutput
			return { toolName: 'AgentOutput', toolArgs: obj }
		}
		// Fallback: surface the unknown name so the caller emits a clear error
		return { toolName: extractedToolName, toolArgs: extractedToolArgs }
	}

	// 4) { action: "<tool>", parameters|args }
	if (typeof obj.action === 'string') {
		return { toolName: obj.action, toolArgs: obj.parameters ?? obj.args ?? {} }
	}

	return null
}

/**
 * Client for Tl AI chatbbc API.
 */
export class TlAiClient implements LLMClient {
	config: Required<Omit<TlAiConfig, 'customFetch'>> & Pick<TlAiConfig, 'customFetch'>
	private fetch: typeof globalThis.fetch

	constructor(config: TlAiConfig) {
		if (!config.endpointAgent || !config.model) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient requires endpointAgent and model'
			)
		}

		this.config = {
			endpointAgent: normalizeEndpointAgent(config.endpointAgent),
			model: config.model,
			appId: config.appId ?? '',
			trCode: config.trCode ?? '',
			trVersion: config.trVersion ?? '',
			toolCallingMode: config.toolCallingMode ?? 'system_prompt',
			customFetch: config.customFetch,
		}
		this.fetch = config.customFetch ?? fetch.bind(globalThis)
	}

	/**
	 * Initialize a session via the init_session endpoint.
	 */
	async initSession(abortSignal?: AbortSignal): Promise<string> {
		const url = `${this.config.endpointAgent}/chatbbc/init_session`

		const requestBody: InitSessionRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				prompt_variables: [
					{
						name: 'name',
						value: this.config.model,
					},
				],
			},
		}

		let response: Response
		try {
			response = await this.fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.NETWORK_ERROR,
				`Session initialization request to "${url}" failed: ${describeError(
					error
				)}. Verify endpointAgent, protocol, and service availability.`,
				error
			)
		}

		if (!response.ok) {
			let errorData: unknown
			try {
				errorData = await response.json()
			} catch {
				errorData = {}
			}
			const serverMessage = (errorData as any)?.message || response.statusText || 'Request failed'
			const type =
				response.status === 401 || response.status === 403
					? InvokeErrorTypes.AUTH_ERROR
					: response.status === 429
						? InvokeErrorTypes.RATE_LIMIT
						: response.status >= 500
							? InvokeErrorTypes.SERVER_ERROR
							: InvokeErrorTypes.UNKNOWN
			const invokeError = new InvokeError(
				type,
				`Session initialization failed with HTTP ${response.status}: ${serverMessage}`,
				undefined,
				errorData
			)
			invokeError.statusCode = response.status
			throw invokeError
		}

		let data: any
		try {
			data = await response.json()
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Session initialization response is not valid JSON',
				error
			)
		}

		if (data?.code !== undefined && data.code !== 0) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`Session initialization was rejected: ${data.message || `code ${data.code}`}`,
				undefined,
				data
			)
		}

		const sessionId = data.data?.session_id
		if (!sessionId) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_SCHEMA,
				'Session initialization response did not include data.session_id',
				undefined,
				data
			)
		}

		return sessionId
	}

	/**
	 * Generate a unique request ID.
	 */
	private generateRequestId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
	}

	/**
	 * Convert a Zod schema to a JSON Schema object.
	 * Uses `z.toJSONSchema()` from zod/v4 when available; falls back to a
	 * permissive empty object schema on failure so tool registration never
	 * breaks the request pipeline.
	 */
	private zodToJsonSchema(schema: z.ZodTypeAny): any {
		try {
			return z.toJSONSchema(schema)
		} catch (e) {
			console.warn('[TlAiClient] zodToJsonSchema fallback used:', e)
			return { type: 'object', properties: {} }
		}
	}

	/**
	 * Format tools into a system prompt fragment for `system_prompt` tool-calling mode.
	 *
	 * Each tool is rendered as an OpenAI-style function-tool descriptor and wrapped
	 * in a `<tools>` block. The PageAgentCore already injects its own `<tools>` block
	 * (generated from the live tools map) into the system message, so this method
	 * returns an empty string to avoid duplicating tool definitions.
	 *
	 * Kept for backward compatibility with the `formatToolsToSystemPrompt` contract.
	 */
	private formatToolsToSystemPrompt(tools: Record<string, Tool>): string {
		return ''
	}

	/**
	 * Parse a streaming response body and extract the tool call.
	 *
	 * If `normalizeResponse` is provided (e.g. PageAgentCore's autoFixer), the
	 * raw accumulated content is wrapped into an OpenAI-style response as
	 * `message.content` and passed to it. This lets the normalizer use its
	 * tolerant `retrieveJsonFromString` extraction to repair common format
	 * issues (missing action, double-JSON wrapping, markdown fences, etc.),
	 * mirroring `OpenAIClient` behavior.
	 *
	 * Without a normalizer, falls back to direct `extractToolCall` parsing.
	 *
	 * On unrecoverable parse failures, throws `InvokeError(INVALID_RESPONSE)`
	 * with the raw content attached — never returns empty args.
	 */
	private async parseStreamingResponse(
		response: Response,
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		normalizeResponse?: (response: any) => any
	): Promise<{ toolName: string; toolArgs: unknown }> {
		const accumulatedContent = await this.readStream(response, abortSignal)

		// 1) Normalizer path (autoFixer): let it extract and repair from raw content.
		if (normalizeResponse) {
			const openaiFormat = {
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant' as const,
							content: accumulatedContent,
						},
					},
				],
			}

			let normalized: any
			try {
				normalized = normalizeResponse(openaiFormat)
			} catch (error: unknown) {
				if ((error as any)?.name === 'AbortError') throw error
				if (error instanceof InvokeError) throw error
				throw new InvokeError(
					InvokeErrorTypes.INVALID_RESPONSE,
					`normalizeResponse failed: ${(error as Error)?.message}`,
					error,
					{ content: accumulatedContent }
				)
			}

			const fn = normalized?.choices?.[0]?.message?.tool_calls?.[0]?.function
			if (!fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_RESPONSE,
					'normalizeResponse did not return a valid tool call',
					undefined,
					{ content: accumulatedContent, normalized }
				)
			}
			// Keep arguments as a JSON string; the caller (invoke) handles JSON.parse
			// and schema validation uniformly for both string and object toolArgs.
			return { toolName: fn.name, toolArgs: fn.arguments }
		}

		// 2) Fallback path: direct extraction without a normalizer.
		try {
			let cleaned = accumulatedContent.trim()
			// Strip markdown code fences if present (e.g. ```json ... ```)
			cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

			// Prefer <tool_call>...</tool_call> payload when present.
			const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i
			const toolCallMatch = toolCallRe.exec(cleaned)
			if (toolCallMatch) {
				const inner = toolCallMatch[1].trim()
				const innerObj: any = JSON.parse(inner)
				const parsed = extractToolCall(innerObj, tools)
				if (parsed) return parsed
			}

			// Fall back to plain JSON (with or without surrounding text).
			const responseObj: any = JSON.parse(cleaned)
			const parsed = extractToolCall(responseObj, tools)
			if (parsed) return parsed

			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Response JSON did not contain a recognizable tool call',
				undefined,
				{ content: accumulatedContent }
			)
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			if (error instanceof InvokeError) throw error
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`Failed to parse streaming response as JSON: ${(error as Error)?.message}`,
				error,
				{ content: accumulatedContent }
			)
		}
	}

	/**
	 * Read the entire streaming response body into a single string.
	 * Lines are trimmed and concatenated; empty lines are skipped.
	 */
	private async readStream(response: Response, abortSignal?: AbortSignal): Promise<string> {
		const reader = response.body?.getReader()
		if (!reader) {
			throw new InvokeError(InvokeErrorTypes.UNKNOWN, 'No response body')
		}

		const decoder = new TextDecoder()
		let accumulatedContent = ''

		try {
			while (true) {
				abortSignal?.throwIfAborted()
				const { done, value } = await reader.read()
				if (done) break

				const chunk = decoder.decode(value, { stream: true })
				const lines = chunk.split('\n')
				for (const line of lines) {
					const trimmedLine = line.trim()
					if (trimmedLine) {
						accumulatedContent += trimmedLine
						console.log(trimmedLine)
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		return accumulatedContent
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		// 1. Start a fresh session for every model invocation.
		// The session returned here is scoped to this init → chat request pair.
		const sessionId = await this.initSession(abortSignal)

		// 2. Build chat request text, considering tool calling mode.
		let chatText: string

		if (this.config.toolCallingMode === 'system_prompt') {
			// For system_prompt mode, include ALL messages (including system)
			// The system message already contains system_prompt.md which has all instructions
			const messageTexts = messages.map((m) => {
				return `${m.role}: ${m.content ?? ''}`
			})
			chatText = messageTexts.join('\n')
		} else {
			// For api mode, proceed with the native API request format.
			chatText = messages
				.filter((m) => m.role !== 'system')
				.map((m) => `${m.role}: ${m.content ?? ''}`)
				.join('\n')
		}

		const requestBody: ChatRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				session_id: sessionId,
				txt: chatText,
				files: [
					{
						file_id: '',
						url: '',
						content_type: '',
					},
				],
				stream: true,
			},
		}

		// 3. Call chat endpoint.
		const url = `${this.config.endpointAgent}/chatbbc/chat`

		let response: Response
		try {
			response = await this.fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.NETWORK_ERROR,
				`Chat request to "${url}" failed: ${describeError(
					error
				)}. Verify endpointAgent, protocol, and service availability.`,
				error
			)
		}

		// 4. Handle HTTP errors.
		if (!response.ok) {
			let errorData: unknown
			try {
				errorData = await response.json()
			} catch {
				errorData = {}
			}
			const errorMessage = (errorData as any)?.message || response.statusText

			if (response.status === 401 || response.status === 403) {
				throw new InvokeError(
					InvokeErrorTypes.AUTH_ERROR,
					`Authentication failed: ${errorMessage}`,
					errorData
				)
			}
			if (response.status === 429) {
				throw new InvokeError(
					InvokeErrorTypes.RATE_LIMIT,
					`Rate limit exceeded: ${errorMessage}`,
					errorData
				)
			}
			if (response.status >= 500) {
				throw new InvokeError(
					InvokeErrorTypes.SERVER_ERROR,
					`Server error: ${errorMessage}`,
					errorData
				)
			}
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`HTTP ${response.status}: ${errorMessage}`,
				errorData
			)
		}

		// 5. Parse streaming response.
		const { toolName, toolArgs } = await this.parseStreamingResponse(
			response,
			tools,
			abortSignal,
			options?.normalizeResponse
		)

		// 6. Validate tool exists.
		const tool = tools[toolName]
		if (!tool) {
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Tool "${toolName}" not found in tools`,
				undefined,
				{ toolName, availableTools: Object.keys(tools) }
			)
		}

		// 7. Parse and validate tool arguments.
		let parsedArgs: unknown = toolArgs
		if (typeof toolArgs === 'string') {
			try {
				parsedArgs = JSON.parse(toolArgs)
			} catch (error: unknown) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_TOOL_ARGS,
					'Failed to parse tool arguments as JSON',
					error,
					{ rawArgs: toolArgs }
				)
			}
		}

		const validation = tool.inputSchema.safeParse(parsedArgs)
		if (!validation.success) {
			console.error(z.prettifyError(validation.error))
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'Tool arguments validation failed',
				validation.error,
				{ rawArgs: parsedArgs }
			)
		}
		const toolInput = validation.data

		// 8. Execute tool.
		let toolResult: unknown
		try {
			toolResult = await tool.execute(toolInput)
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.TOOL_EXECUTION_ERROR,
				`Tool execution failed: ${(error as Error)?.message}`,
				error,
				{ toolName, args: toolInput }
			)
		}

		// 9. Return result.
		return {
			toolCall: {
				name: toolName,
				args: toolInput,
			},
			toolResult,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
			},
			rawResponse: { toolName, toolArgs: toolInput },
			rawRequest: requestBody,
		}
	}
}
