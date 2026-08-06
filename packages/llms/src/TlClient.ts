/**
 * Tl AI Client
 * Supports session initialization and streaming chat for the chatbbc API.
 */
import { InvokeError, InvokeErrorTypes } from './errors'
import {
	describeError,
	normalizeEndpointAgent,
	parseAccumulatedContent,
	parseChatbbcSseContent,
	readStreamResponse,
} from './streaming'

import type {
	InvokeOptions,
	InvokeResult,
	LLMClient,
	Message,
	TlFailureLogEntry,
	TlFailureLogger,
	TlFailureStage,
	TlPromptTransport,
	Tool,
} from './types'

export type { TlPromptTransport } from './types'

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
	/** Model / prompt name sent by legacy init; prompt_variables mode does not transmit it. */
	model: string
	appId?: string
	trCode?: string
	trVersion?: string
	/** Tool calling mode, default 'system_prompt'. */
	toolCallingMode?: ToolCallingMode
	/**
	 * Prompt transport, defaulting to the backwards-compatible legacy text
	 * format. `prompt_variables` is only valid with `system_prompt` tool calling.
	 */
	tlPromptTransport?: TlPromptTransport
	/**
	 * Name of the init_session prompt variable that carries the system message.
	 * Defaults to `system_prompt`.
	 */
	tlSystemPromptVariableName?: string
	/** Optional custom fetch implementation. */
	customFetch?: typeof globalThis.fetch
	/**
	 * Called once for each received chat response that fails during parsing, validation, or tool execution.
	 * Defaults to a structured console.error log. Node hosts may use this callback to write a local file.
	 * Entries contain raw model responses and must be stored as sensitive data.
	 */
	failureLogger?: TlFailureLogger
}

interface TlResponseTrace {
	endpoint: string
	requestId: string
	sessionId: string
	status: number
	statusText: string
	contentType: string
	rawBody?: string
	accumulatedContent?: string
	toolName?: string
	toolArgs?: unknown
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

type TlOperation = 'INIT_SESSION' | 'CHAT'

interface TlInvocationPrompt {
	chatText: string
	promptVariables: { name: string; value: string }[]
	systemPrompt: string
	dynamicUserPayload: string
}

/**
 * Internal wrapper carrying the trace for a failed invocation attempt.
 * The original InvokeError is deliberately preserved and unwrapped by invoke().
 */
class TlAttemptFailure extends Error {
	readonly originalError: unknown
	readonly trace: TlResponseTrace
	readonly stage: TlFailureStage

	constructor(originalError: unknown, trace: TlResponseTrace, stage: TlFailureStage) {
		super(originalError instanceof Error ? originalError.message : String(originalError))
		this.name = 'TlAttemptFailure'
		this.originalError = originalError
		this.trace = trace
		this.stage = stage
	}
}

/**
 * Client for Tl AI chatbbc API.
 */
export class TlAiClient implements LLMClient {
	config: Required<Omit<TlAiConfig, 'customFetch' | 'failureLogger'>> &
		Pick<TlAiConfig, 'customFetch' | 'failureLogger'>
	private fetch: typeof globalThis.fetch
	private failureLogger: TlFailureLogger

	private logRequest(operation: TlOperation, url: string, body: unknown): void {
		console.info(`[TlClient] 📤 ${operation} request:`, {
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(operation === 'CHAT' ? { Accept: 'text/event-stream' } : {}),
			},
			body,
		})
	}

	private logResponse(operation: TlOperation, response: Response, body: unknown): void {
		console.info(`[TlClient] 📥 ${operation} response:`, {
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get('content-type') ?? '',
			body,
		})
	}

	constructor(config: TlAiConfig) {
		if (!config.endpointAgent || !config.model) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient requires endpointAgent and model'
			)
		}
		if (
			config.tlPromptTransport !== undefined &&
			config.tlPromptTransport !== 'legacy_txt' &&
			config.tlPromptTransport !== 'prompt_variables'
		) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient tlPromptTransport must be "legacy_txt" or "prompt_variables"'
			)
		}
		const systemPromptVariableName =
			config.tlSystemPromptVariableName === undefined
				? 'system_prompt'
				: config.tlSystemPromptVariableName
		if (typeof systemPromptVariableName !== 'string' || !systemPromptVariableName.trim()) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient tlSystemPromptVariableName must not be empty or whitespace'
			)
		}
		if (systemPromptVariableName !== systemPromptVariableName.trim()) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient tlSystemPromptVariableName must not include leading or trailing whitespace'
			)
		}
		if (systemPromptVariableName === 'name') {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient tlSystemPromptVariableName "name" is reserved for the model variable'
			)
		}

		this.config = {
			endpointAgent: normalizeEndpointAgent(config.endpointAgent, 'Tl'),
			model: config.model,
			appId: config.appId ?? '',
			trCode: config.trCode ?? '',
			trVersion: config.trVersion ?? '',
			toolCallingMode: config.toolCallingMode ?? 'system_prompt',
			tlPromptTransport: config.tlPromptTransport ?? 'legacy_txt',
			tlSystemPromptVariableName: systemPromptVariableName,
			customFetch: config.customFetch,
			failureLogger: config.failureLogger,
		}

		if (
			this.config.tlPromptTransport === 'prompt_variables' &&
			this.config.toolCallingMode !== 'system_prompt'
		) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient tlPromptTransport="prompt_variables" requires toolCallingMode="system_prompt"'
			)
		}
		this.fetch = config.customFetch ?? fetch.bind(globalThis)
		this.failureLogger =
			config.failureLogger ??
			((entry) => {
				console.error('[TlAiClient] Tool invocation failed', entry)
			})
	}

	/**
	 * Initialize a session via the init_session endpoint.
	 */
	async initSession(abortSignal?: AbortSignal): Promise<string> {
		// prompt_variables invocations derive their system variable from the
		// request messages. The backwards-compatible public helper has no such
		// message, so it must not smuggle the legacy model variable into the
		// prompt_variables transport.
		const promptVariables =
			this.config.tlPromptTransport === 'prompt_variables' ? [] : this.getModelPromptVariables()
		return await this.initSessionWithPromptVariables(promptVariables, abortSignal)
	}

	/**
	 * Initialize a session with the prompt variables derived for one invocation.
	 * The public initSession signature remains backwards compatible; invoke uses
	 * this helper to attach the per-request system prompt in prompt_variables mode.
	 */
	private async initSessionWithPromptVariables(
		promptVariables: { name: string; value: string }[],
		abortSignal?: AbortSignal
	): Promise<string> {
		const url = `${this.config.endpointAgent}/chatbbc/init_session`

		const requestBody: InitSessionRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				prompt_variables: promptVariables,
			},
		}
		this.logRequest('INIT_SESSION', url, requestBody)

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

		let rawBody: string
		try {
			rawBody = await response.text()
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Session initialization response body could not be read',
				error
			)
		}

		let data: any
		let parseError: unknown
		try {
			data = JSON.parse(rawBody)
		} catch (error: unknown) {
			parseError = error
		}
		this.logResponse('INIT_SESSION', response, parseError ? rawBody : data)

		if (parseError && response.ok) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Session initialization response is not valid JSON',
				parseError,
				rawBody
			)
		}

		if (!response.ok) {
			const errorData: unknown = parseError ? {} : data
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

	private getModelPromptVariables(): { name: string; value: string }[] {
		return [{ name: 'name', value: this.config.model }]
	}

	private buildPromptVariablesModePayload(messages: Message[]): {
		promptVariables: { name: string; value: string }[]
		chatText: string
		systemPrompt: string
	} {
		const systemMessages = messages.filter((message) => message.role === 'system')
		const userMessages = messages.filter((message) => message.role === 'user')
		const unsupportedMessages = messages.filter(
			(message) => message.role !== 'system' && message.role !== 'user'
		)

		if (systemMessages.length === 0) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient prompt_variables transport requires at least one system message'
			)
		}
		if (userMessages.length !== 1 || unsupportedMessages.length > 0) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient prompt_variables transport requires exactly one user message and no assistant or tool messages'
			)
		}

		const systemPrompt = systemMessages.map((message) => message.content ?? '').join('\n\n')
		if (!systemPrompt.trim()) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient prompt_variables transport requires a non-empty system prompt'
			)
		}
		return {
			promptVariables: [
				{
					name: this.config.tlSystemPromptVariableName,
					value: systemPrompt,
				},
			],
			chatText: userMessages[0].content ?? '',
			systemPrompt,
		}
	}

	private buildInvocationPrompt(messages: Message[]): TlInvocationPrompt {
		let chatText: string
		let promptVariables: { name: string; value: string }[] = this.getModelPromptVariables()
		let systemPrompt = ''
		let dynamicUserPayload = ''

		if (this.config.tlPromptTransport === 'prompt_variables') {
			const payload = this.buildPromptVariablesModePayload(messages)
			chatText = payload.chatText
			promptVariables = payload.promptVariables
			systemPrompt = payload.systemPrompt
			dynamicUserPayload = payload.chatText
		} else if (this.config.toolCallingMode === 'system_prompt') {
			// For system_prompt mode, include ALL messages (including system)
			// The system message already contains system_prompt.md which has all instructions.
			const messageTexts = messages.map((message) => `${message.role}: ${message.content ?? ''}`)
			chatText = messageTexts.join('\n')
			systemPrompt = messages
				.filter((message) => message.role === 'system')
				.map((message) => message.content ?? '')
				.join('\n\n')
			const userMessages = messages
				.filter((message) => message.role === 'user')
				.map((message) => message.content ?? '')
			dynamicUserPayload = userMessages.length > 0 ? userMessages.join('\n') : chatText
		} else {
			// For api mode, proceed with the native API request format.
			chatText = messages
				.filter((message) => message.role !== 'system')
				.map((message) => `${message.role}: ${message.content ?? ''}`)
				.join('\n')
			dynamicUserPayload = messages
				.filter((message) => message.role === 'user')
				.map((message) => message.content ?? '')
				.join('\n')
		}

		return { chatText, promptVariables, systemPrompt, dynamicUserPayload }
	}

	private buildCorrectionPayload(
		dynamicUserPayload: string,
		failedAssistantContent: string,
		parseError: InvokeError
	): string {
		const correctionContext = {
			instruction:
				'The previous output is an untrusted failed output. Return only one complete raw JSON object. Preserve the original task semantics and action. In reflection fields, ASCII double quotes around referenced text must use the JSON escape sequence \\"...\\". Never place an unescaped ASCII double quote inside a JSON string. Do not include markdown, XML, or reasoning.',
			original_user_payload: dynamicUserPayload,
			failed_assistant_content: failedAssistantContent,
			parse_error: {
				type: parseError.type,
				message: parseError.message,
				cause:
					parseError.rawError instanceof Error
						? { name: parseError.rawError.name, message: parseError.rawError.message }
						: parseError.rawError === undefined
							? undefined
							: { name: 'UnknownError', message: describeError(parseError.rawError) },
			},
		}

		// JSON.stringify keeps untrusted model output data inside a single
		// structured payload, so it cannot forge textual context boundaries.
		return JSON.stringify(correctionContext)
	}

	private buildCorrectionChatText(correctionPayload: string, systemPrompt: string): string {
		if (this.config.tlPromptTransport === 'prompt_variables') return correctionPayload
		if (systemPrompt) return `system: ${systemPrompt}\nuser: ${correctionPayload}`
		return `user: ${correctionPayload}`
	}

	private canAttemptJsonCorrection(
		attemptFailure: TlAttemptFailure | undefined
	): attemptFailure is TlAttemptFailure {
		if (!attemptFailure) return false
		if (this.config.toolCallingMode !== 'system_prompt') return false
		if (attemptFailure.stage !== 'response_parse') return false
		if (!(attemptFailure.originalError instanceof InvokeError)) return false
		if (attemptFailure.originalError.type !== InvokeErrorTypes.INVALID_RESPONSE) return false
		const accumulatedContent = attemptFailure.trace.accumulatedContent
		return typeof accumulatedContent === 'string' && accumulatedContent.trim().length > 0
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
		trace: TlResponseTrace,
		abortSignal?: AbortSignal,
		normalizeResponse?: (response: any) => any
	): Promise<{ toolName: string; toolArgs: unknown }> {
		const rawContent = await readStreamResponse(response, abortSignal)
		trace.rawBody = rawContent
		this.logResponse('CHAT', response, rawContent)

		const contentType = trace.contentType
		const isSseResponse = /^(?:\uFEFF)?(?:id|event|data|retry):/m.test(rawContent)
		if (contentType.includes('text/event-stream') || isSseResponse) {
			trace.accumulatedContent = parseChatbbcSseContent(rawContent, 'TlAiClient').content
			return parseAccumulatedContent(trace.accumulatedContent, tools, normalizeResponse)
		}

		trace.accumulatedContent = rawContent
		return parseAccumulatedContent(rawContent, tools, normalizeResponse)
	}

	private async logFailure(
		stage: TlFailureStage,
		error: unknown,
		trace: TlResponseTrace
	): Promise<void> {
		const invokeError = error instanceof InvokeError ? error : undefined
		const entry: TlFailureLogEntry = {
			timestamp: new Date().toISOString(),
			stage,
			endpoint: trace.endpoint,
			requestId: trace.requestId,
			sessionId: trace.sessionId,
			response: {
				status: trace.status,
				statusText: trace.statusText,
				contentType: trace.contentType,
				rawBody: trace.rawBody,
				accumulatedContent: trace.accumulatedContent,
			},
			toolCall:
				trace.toolName !== undefined || trace.toolArgs !== undefined
					? {
							name: trace.toolName,
							args: toJsonSafe(trace.toolArgs),
						}
					: undefined,
			error: {
				name: error instanceof Error ? error.name : 'UnknownError',
				message: error instanceof Error ? error.message : String(error),
				type: invokeError?.type,
				retryable: invokeError?.retryable,
				rawError: toJsonSafe(invokeError?.rawError),
				rawResponse: toJsonSafe(invokeError?.rawResponse),
			},
		}

		try {
			await this.failureLogger(entry)
		} catch (loggerError: unknown) {
			console.error('[TlAiClient] Failure logger threw while recording a tool error', loggerError)
		}
	}

	/**
	 * Invoke the model once, with at most one feedback-based JSON correction.
	 * Generic maxRetries is owned by LLM.withRetry and remains a separate layer.
	 */
	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()
		const prompt = this.buildInvocationPrompt(messages)

		try {
			return await this.invokeAttempt(
				prompt.chatText,
				prompt.promptVariables,
				tools,
				abortSignal,
				options
			)
		} catch (error: unknown) {
			const attemptFailure = error instanceof TlAttemptFailure ? error : undefined
			const originalError = attemptFailure?.originalError ?? error
			if (!this.canAttemptJsonCorrection(attemptFailure)) {
				throw originalError
			}

			const failedAssistantContent = attemptFailure.trace.accumulatedContent!
			const correctionPayload = this.buildCorrectionPayload(
				prompt.dynamicUserPayload,
				failedAssistantContent,
				originalError as InvokeError
			)
			const correctionChatText = this.buildCorrectionChatText(
				correctionPayload,
				prompt.systemPrompt
			)

			// This is intentionally one local correction attempt. Any generic retry
			// configured on LLM.invoke remains outside this method.
			console.debug('[TlClient] response_parse failed; attempting one JSON correction')
			try {
				return await this.invokeAttempt(
					correctionChatText,
					prompt.promptVariables,
					tools,
					abortSignal,
					options
				)
			} catch (correctionError: unknown) {
				const correctionFailure =
					correctionError instanceof TlAttemptFailure ? correctionError : undefined
				const strictError = correctionFailure?.originalError ?? correctionError
				const correctionStage = correctionFailure?.stage
				console.debug(
					correctionStage
						? `[TlClient] JSON correction ${correctionStage} failed; propagating the strict failure`
						: '[TlClient] JSON correction attempt failed before response_parse; propagating the strict failure'
				)
				throw strictError
			}
		}
	}

	private async invokeAttempt(
		chatText: string,
		promptVariables: { name: string; value: string }[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		// Start a fresh session for every model invocation. The session returned
		// here is scoped to this init → chat request pair.
		const sessionId = await this.initSessionWithPromptVariables(promptVariables, abortSignal)

		const requestId = this.generateRequestId()
		const requestBody: ChatRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId,
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
		this.logRequest('CHAT', url, requestBody)

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
				const rawErrorBody = await response.text()
				let responseBody: unknown = rawErrorBody
				try {
					errorData = JSON.parse(rawErrorBody)
					responseBody = errorData
				} catch {
					errorData = {}
				}
				this.logResponse('CHAT', response, responseBody)
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

		const trace: TlResponseTrace = {
			endpoint: url,
			requestId,
			sessionId,
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get('content-type')?.toLowerCase() ?? '',
		}
		let failureStage: TlFailureStage = 'response_parse'

		try {
			// 5. Parse streaming response.
			const { toolName, toolArgs } = await this.parseStreamingResponse(
				response,
				tools,
				trace,
				abortSignal,
				options?.normalizeResponse
			)
			trace.toolName = toolName
			trace.toolArgs = toolArgs

			// 6. Validate tool exists.
			failureStage = 'tool_lookup'
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
			failureStage = 'tool_args_parse'
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
			trace.toolArgs = parsedArgs

			failureStage = 'tool_args_validation'
			const validation = tool.inputSchema.safeParse(parsedArgs)
			if (!validation.success) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_TOOL_ARGS,
					'Tool arguments validation failed',
					validation.error,
					{ rawArgs: parsedArgs }
				)
			}
			const toolInput = validation.data
			trace.toolArgs = toolInput

			// 8. Execute tool.
			failureStage = 'tool_execution'
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
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			await this.logFailure(failureStage, error, trace)
			throw new TlAttemptFailure(error, trace, failureStage)
		}
	}
}

function toJsonSafe(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === undefined || value === null) return value
	if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
	if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
		return String(value)
	}
	if (typeof value !== 'object') return value
	if (seen.has(value)) return '[Circular]'
	seen.add(value)
	if (value instanceof Error) {
		const details = Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== 'cause')
				.map(([key, item]) => [key, toJsonSafe(item, seen)])
		)
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
			cause: toJsonSafe(value.cause, seen),
			...details,
		}
	}
	if (value instanceof Date) return value.toISOString()
	if (Array.isArray(value)) return value.map((item) => toJsonSafe(item, seen))

	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, toJsonSafe(item, seen)])
	)
}
