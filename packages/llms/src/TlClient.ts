/**
 * Tl AI Client
 * Supports session initialization and streaming chat for the chatbbc API.
 */
import * as z from 'zod/v4'

import { InvokeError, InvokeErrorTypes } from './errors'
import {
	describeError,
	normalizeEndpointAgent,
	parseAccumulatedContent,
	parseChatbbcSseContent,
	readStreamResponse,
} from './streaming'

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
			endpointAgent: normalizeEndpointAgent(config.endpointAgent, 'Tl'),
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
	 * Parse a streaming response body and extract the tool call.
	 *
	 * Delegates to the shared streaming pipeline: reads the body, decodes the
	 * chatbbc SSE format, then canonicalizes the accumulated content through
	 * `parseAccumulatedContent` (normalizeResponse path or extractToolCall).
	 */
	private async parseStreamingResponse(
		response: Response,
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		normalizeResponse?: (response: any) => any
	): Promise<{ toolName: string; toolArgs: unknown }> {
		const rawContent = await readStreamResponse(response, abortSignal)

		const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
		const isSseResponse = /^(?:\uFEFF)?(?:id|event|data|retry):/m.test(rawContent)
		if (contentType.includes('text/event-stream') || isSseResponse) {
			return parseAccumulatedContent(
				parseChatbbcSseContent(rawContent, 'TlAiClient').content,
				tools,
				normalizeResponse
			)
		}

		return parseAccumulatedContent(rawContent, tools, normalizeResponse)
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
					Accept: 'text/event-stream',
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
