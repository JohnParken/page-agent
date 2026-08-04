/**
 * DeepSeek client.
 *
 * Supports both the Tl-compatible chatbbc gateway transport and DeepSeek's
 * native OpenAI-compatible Chat Completions API. PageAgent uses the same
 * system-prompt JSON tool contract in both transports.
 */
import * as z from 'zod/v4'

import { InvokeError, InvokeErrorTypes } from './errors'
import {
	describeError,
	isSse,
	normalizeEndpointAgent,
	parseAccumulatedContent,
	parseChatbbcSseContent,
	parseOpenAISseContent,
	readStreamResponse,
} from './streaming'
import { modelPatch } from './utils'

import type { ToolCallingMode } from './TlClient'
import type { InvokeOptions, InvokeResult, LLMClient, Message, Tool } from './types'

export type DsMode = 'gateway' | 'api'

/** Configuration for the DeepSeek client. */
export interface DsAiConfig {
	/** Explicit transport mode. When omitted, endpointAgent selects gateway and baseURL selects api. */
	dsMode?: DsMode
	/** Tl-compatible gateway host or HTTP(S) base URL. */
	endpointAgent?: string
	/** DeepSeek-compatible API base URL, for example https://api.deepseek.com. */
	baseURL?: string
	model: string
	apiKey?: string
	appId?: string
	trCode?: string
	trVersion?: string
	/** PageAgent uses system_prompt mode by default. */
	toolCallingMode?: ToolCallingMode
	temperature?: number
	maxTokens?: number
	/** Apply the shared model-specific request patch in native API mode. Default false. */
	applyModelPatch?: boolean
	transformRequestBody?: (
		requestBody: Record<string, unknown>
	) => Record<string, unknown> | undefined
	customFetch?: typeof globalThis.fetch
}

export interface ResolvedDsAiConfig {
	dsMode: DsMode
	endpointAgent?: string
	baseURL?: string
	model: string
	apiKey: string
	appId: string
	trCode: string
	trVersion: string
	toolCallingMode: ToolCallingMode
	temperature?: number
	maxTokens?: number
	applyModelPatch: boolean
	transformRequestBody: (
		requestBody: Record<string, unknown>
	) => Record<string, unknown> | undefined
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

interface GatewayChatRequest {
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

interface TokenUsage {
	prompt_tokens?: number
	completion_tokens?: number
	total_tokens?: number
	prompt_cache_hit_tokens?: number
	completion_tokens_details?: { reasoning_tokens?: number }
	prompt_tokens_details?: { cached_tokens?: number }
}

/** DeepSeek client with gateway and native API transports. */
export class DsAiClient implements LLMClient {
	config: ResolvedDsAiConfig
	private fetch: typeof globalThis.fetch

	constructor(config: DsAiConfig) {
		if (!config.model?.trim()) {
			throw new InvokeError(InvokeErrorTypes.CONFIG_ERROR, 'DsAiClient requires model')
		}

		const dsMode = this.resolveMode(config)
		if (dsMode === 'gateway' && !config.endpointAgent) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'DsAiClient gateway mode requires endpointAgent'
			)
		}
		if (dsMode === 'api' && !config.baseURL) {
			throw new InvokeError(InvokeErrorTypes.CONFIG_ERROR, 'DsAiClient api mode requires baseURL')
		}

		this.config = {
			dsMode,
			endpointAgent: config.endpointAgent
				? normalizeEndpointAgent(config.endpointAgent, 'DeepSeek gateway')
				: undefined,
			baseURL: config.baseURL ? normalizeEndpointAgent(config.baseURL, 'DeepSeek API') : undefined,
			model: config.model,
			apiKey: config.apiKey ?? '',
			appId: config.appId ?? '',
			trCode: config.trCode ?? '',
			trVersion: config.trVersion ?? '',
			toolCallingMode: config.toolCallingMode ?? 'system_prompt',
			temperature: config.temperature,
			maxTokens: config.maxTokens,
			applyModelPatch: config.applyModelPatch ?? false,
			transformRequestBody: config.transformRequestBody ?? ((body) => body),
			customFetch: config.customFetch,
		}
		this.fetch = config.customFetch ?? fetch.bind(globalThis)
	}

	private resolveMode(config: DsAiConfig): DsMode {
		if (config.dsMode) return config.dsMode
		if (config.endpointAgent) return 'gateway'
		if (config.baseURL) return 'api'
		throw new InvokeError(
			InvokeErrorTypes.CONFIG_ERROR,
			'DsAiClient requires endpointAgent (gateway) or baseURL (api)'
		)
	}

	private generateRequestId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
	}

	/** Initialize one fresh Tl-compatible gateway session. */
	async initSession(abortSignal?: AbortSignal): Promise<string> {
		if (this.config.dsMode !== 'gateway' || !this.config.endpointAgent) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'initSession is only available in DeepSeek gateway mode'
			)
		}

		const url = `${this.config.endpointAgent}/chatbbc/init_session`
		const requestBody: InitSessionRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				prompt_variables: [{ name: 'name', value: this.config.model }],
			},
		}

		const response = await this.request(url, requestBody, abortSignal)
		if (!response.ok) await this.throwHttpError(response, 'Session initialization')

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
		const sessionId = data?.data?.session_id
		if (typeof sessionId !== 'string' || !sessionId) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_SCHEMA,
				'Session initialization response did not include data.session_id',
				undefined,
				data
			)
		}
		return sessionId
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		if (this.config.toolCallingMode !== 'system_prompt') {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'DsAiClient currently supports toolCallingMode="system_prompt" only'
			)
		}

		return this.config.dsMode === 'gateway'
			? this.invokeGateway(messages, tools, abortSignal, options)
			: this.invokeApi(messages, tools, abortSignal, options)
	}

	private async invokeGateway(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		const sessionId = await this.initSession(abortSignal)
		const chatText = messages
			.map((message) => `${message.role}: ${message.content ?? ''}`)
			.join('\n')
		const requestBody: GatewayChatRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				session_id: sessionId,
				txt: chatText,
				files: [{ file_id: '', url: '', content_type: '' }],
				stream: true,
			},
		}

		const url = `${this.config.endpointAgent}/chatbbc/chat`
		const response = await this.request(url, requestBody, abortSignal, {
			Accept: 'text/event-stream',
		})
		if (!response.ok) await this.throwHttpError(response, 'Gateway chat')

		const rawContent = await readStreamResponse(response, abortSignal)
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
		const content = isSse(rawContent, contentType)
			? parseChatbbcSseContent(rawContent, 'DsAiClient').content
			: this.extractGatewayContent(rawContent)
		const parsed = parseAccumulatedContent(content, tools, options?.normalizeResponse)

		return this.validateAndExecute(parsed, tools, requestBody, { content }, undefined, abortSignal)
	}

	private extractGatewayContent(rawContent: string): string {
		try {
			const data = JSON.parse(rawContent)
			const txt = data?.data?.txt
			return typeof txt === 'string' ? txt : rawContent
		} catch {
			return rawContent
		}
	}

	private async invokeApi(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult> {
		const requestBody: Record<string, unknown> = {
			model: this.config.model,
			messages,
			stream: true,
			stream_options: { include_usage: true },
			response_format: { type: 'json_object' },
		}
		if (this.config.temperature !== undefined) requestBody.temperature = this.config.temperature
		if (this.config.maxTokens !== undefined) requestBody.max_tokens = this.config.maxTokens
		if (this.config.applyModelPatch) modelPatch(requestBody, this.config.baseURL)

		let transformedBody: Record<string, unknown> | undefined
		try {
			transformedBody = this.config.transformRequestBody(requestBody)
		} catch (error: unknown) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				`transformRequestBody failed: ${(error as Error)?.message}`,
				error
			)
		}
		const finalRequestBody = transformedBody ?? requestBody
		const url = `${this.config.baseURL}/chat/completions`
		const headers: Record<string, string> = { Accept: 'text/event-stream' }
		if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`

		const response = await this.request(url, finalRequestBody, abortSignal, headers)
		if (!response.ok) await this.throwHttpError(response, 'DeepSeek chat')

		const rawContent = await readStreamResponse(response, abortSignal)
		const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
		let content: string
		let usage: TokenUsage | undefined
		let rawResponse: unknown

		if (isSse(rawContent, contentType)) {
			this.assertStreamFinishReason(rawContent)
			const parsedStream = parseOpenAISseContent(rawContent, 'DsAiClient')
			content = parsedStream.content
			usage = parsedStream.usage as TokenUsage | undefined
			rawResponse = { content, usage }
		} else {
			const parsedResponse = this.parseApiJsonResponse(rawContent)
			content = parsedResponse.content
			usage = parsedResponse.usage
			rawResponse = parsedResponse.raw
		}

		if (!content.trim()) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'DeepSeek returned an empty JSON Output content',
				undefined,
				rawResponse
			)
		}

		const parsed = parseAccumulatedContent(content, tools, options?.normalizeResponse)
		return this.validateAndExecute(parsed, tools, finalRequestBody, rawResponse, usage, abortSignal)
	}

	private parseApiJsonResponse(rawContent: string): {
		content: string
		usage?: TokenUsage
		raw: unknown
	} {
		let data: any
		try {
			data = JSON.parse(rawContent)
		} catch (error: unknown) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'DeepSeek response body is not valid JSON',
				error,
				{ content: rawContent }
			)
		}

		const choice = data?.choices?.[0]
		if (!choice) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_SCHEMA,
				'DeepSeek response did not include choices[0]',
				undefined,
				data
			)
		}
		this.throwForFinishReason(choice.finish_reason, data)
		return {
			content: typeof choice.message?.content === 'string' ? choice.message.content : '',
			usage: data.usage,
			raw: data,
		}
	}

	private assertStreamFinishReason(rawContent: string): void {
		for (const line of rawContent.replace(/\r\n?/g, '\n').split('\n')) {
			if (!line.startsWith('data:')) continue
			const data = line.slice(5).trim()
			if (!data || data === '[DONE]') continue
			try {
				const payload = JSON.parse(data)
				const finishReason = payload?.choices?.[0]?.finish_reason
				if (finishReason) this.throwForFinishReason(finishReason, payload)
			} catch (error: unknown) {
				if (error instanceof InvokeError) throw error
			}
		}
	}

	private throwForFinishReason(finishReason: unknown, rawResponse: unknown): void {
		if (finishReason === undefined || finishReason === null || finishReason === 'stop') return
		if (finishReason === 'length') {
			throw new InvokeError(
				InvokeErrorTypes.CONTEXT_LENGTH,
				'DeepSeek JSON Output was truncated because max tokens or context length was reached',
				undefined,
				rawResponse
			)
		}
		if (finishReason === 'content_filter') {
			throw new InvokeError(
				InvokeErrorTypes.CONTENT_FILTER,
				'DeepSeek response was filtered by the safety system',
				undefined,
				rawResponse
			)
		}
		if (finishReason === 'insufficient_system_resource') {
			throw new InvokeError(
				InvokeErrorTypes.SERVER_ERROR,
				'DeepSeek response was interrupted by insufficient system resources',
				undefined,
				rawResponse
			)
		}
		throw new InvokeError(
			InvokeErrorTypes.INVALID_SCHEMA,
			`Unexpected DeepSeek finish_reason: ${JSON.stringify(finishReason)}`,
			undefined,
			rawResponse
		)
	}

	private async request(
		url: string,
		body: unknown,
		abortSignal?: AbortSignal,
		extraHeaders: Record<string, string> = {}
	): Promise<Response> {
		try {
			return await this.fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...extraHeaders },
				body: JSON.stringify(body),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.NETWORK_ERROR,
				`Request to "${url}" failed: ${describeError(
					error
				)}. Verify the endpoint, protocol, and service availability.`,
				error
			)
		}
	}

	private async throwHttpError(response: Response, operation: string): Promise<never> {
		let errorData: any
		try {
			errorData = await response.json()
		} catch {
			errorData = {}
		}
		const serverMessage =
			errorData?.error?.message || errorData?.message || response.statusText || 'Request failed'
		const type =
			response.status === 401 || response.status === 403
				? InvokeErrorTypes.AUTH_ERROR
				: response.status === 429
					? InvokeErrorTypes.RATE_LIMIT
					: response.status >= 500
						? InvokeErrorTypes.SERVER_ERROR
						: InvokeErrorTypes.UNKNOWN
		const error = new InvokeError(
			type,
			`${operation} failed with HTTP ${response.status}: ${serverMessage}`,
			undefined,
			errorData
		)
		error.statusCode = response.status
		throw error
	}

	private async validateAndExecute(
		parsed: { toolName: string; toolArgs: unknown },
		tools: Record<string, Tool>,
		rawRequest: unknown,
		rawResponse: unknown,
		usage?: TokenUsage,
		abortSignal?: AbortSignal
	): Promise<InvokeResult> {
		const tool = tools[parsed.toolName]
		if (!tool) {
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Tool "${parsed.toolName}" not found in tools`,
				undefined,
				{ toolName: parsed.toolName, availableTools: Object.keys(tools), rawResponse }
			)
		}

		let parsedArgs = parsed.toolArgs
		if (typeof parsedArgs === 'string') {
			try {
				parsedArgs = JSON.parse(parsedArgs)
			} catch (error: unknown) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_TOOL_ARGS,
					'Failed to parse tool arguments as JSON',
					error,
					{ rawArgs: parsed.toolArgs, rawResponse }
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
				{ rawArgs: parsedArgs, rawResponse }
			)
		}

		abortSignal?.throwIfAborted()
		let toolResult: unknown
		try {
			toolResult = await tool.execute(validation.data)
			abortSignal?.throwIfAborted()
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.TOOL_EXECUTION_ERROR,
				`Tool execution failed: ${(error as Error)?.message}`,
				error,
				{ toolName: parsed.toolName, args: validation.data }
			)
		}

		return {
			toolCall: { name: parsed.toolName, args: validation.data },
			toolResult,
			usage: {
				promptTokens: usage?.prompt_tokens ?? 0,
				completionTokens: usage?.completion_tokens ?? 0,
				totalTokens: usage?.total_tokens ?? 0,
				cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens,
				reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
			},
			rawRequest,
			rawResponse,
		}
	}
}
