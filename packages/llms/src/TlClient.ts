/**
 * Tl AI Client
 * Supports session initialization and streaming chat for the chatbbc API.
 */
import * as z from 'zod'

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
	/** Agent host, e.g. "api.example.com". The client calls http://${endpointAgent}/chatbbc/... */
	endpointAgent: string
	/** Model / prompt name used during session initialization. */
	model: string
	appId?: string
	trCode?: string
	trVersion?: string
	/** Tool calling mode, default 'api'. */
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
	private sessionId: string | null = null

	constructor(config: TlAiConfig) {
		if (!config.endpointAgent || !config.model) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient requires endpointAgent and model'
			)
		}

		this.config = {
			endpointAgent: config.endpointAgent,
			model: config.model,
			appId: config.appId ?? '',
			trCode: config.trCode ?? '',
			trVersion: config.trVersion ?? '',
			toolCallingMode: config.toolCallingMode ?? 'api',
			customFetch: config.customFetch,
		}
		this.fetch = config.customFetch ?? fetch.bind(globalThis)
	}

	/**
	 * Initialize a session via the init_session endpoint.
	 */
	async initSession(): Promise<string> {
		const url = `http://${this.config.endpointAgent}/chatbbc/init_session`

		const requestBody: InitSessionRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: 1,
			requestId: '',
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
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'Session initialization failed', error)
		}

		if (!response.ok) {
			let errorData: unknown
			try {
				errorData = await response.json()
			} catch {
				errorData = {}
			}
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Session initialization failed: ${response.statusText}`,
				errorData
			)
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

		this.sessionId = data.data?.session_id ?? null
		if (!this.sessionId) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_SCHEMA,
				'No session_id in initialization response',
				undefined,
				data
			)
		}

		return this.sessionId
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
	 */
	private async parseStreamingResponse(
		response: Response,
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal
	): Promise<{ toolName: string; toolArgs: unknown }> {
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

		try {
			let cleaned = accumulatedContent.trim()

			// 1) Strip markdown code fences if present (e.g. ```json ... ```)
			cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

			// 2) Prefer <tool_call>...</tool_call> payload when present.
			//    Supports two inner shapes:
			//      a) { "name": "<tool>", "arguments": {...} }              (OpenAI style)
			//      b) { "action": { "<tool>": {...} }, ...reflection fields } (MacroTool style)
			const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i
			const toolCallMatch = toolCallRe.exec(cleaned)
			if (toolCallMatch) {
				const inner = toolCallMatch[1].trim()
				const innerObj: any = JSON.parse(inner)
				const parsed = extractToolCall(innerObj, tools)
				if (parsed) return parsed
			}

			// 3) Fall back to plain JSON (with or without surrounding text).
			const responseObj: any = JSON.parse(cleaned)
			const parsed = extractToolCall(responseObj, tools)
			if (parsed) return parsed

			// 4) Unparseable shape — surface a clear error.
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Response JSON did not contain a recognizable tool call',
				undefined,
				{ content: accumulatedContent }
			)
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			if (error instanceof InvokeError) throw error

			const firstToolName = Object.keys(tools)[0]
			if (!firstToolName) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_RESPONSE,
					'No tools available and response is not JSON',
					undefined,
					{ content: accumulatedContent }
				)
			}
			return { toolName: firstToolName, toolArgs: {} }
		}
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		_options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		// 1. Initialize session if needed.
		if (!this.sessionId) {
			await this.initSession()
		}

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
			// For api mode (default), proceed as before
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
				session_id: this.sessionId!,
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
		const url = `http://${this.config.endpointAgent}/chatbbc/chat`

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
			console.error(error)
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'Network request failed', error)
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
		const { toolName, toolArgs } = await this.parseStreamingResponse(response, tools, abortSignal)

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
