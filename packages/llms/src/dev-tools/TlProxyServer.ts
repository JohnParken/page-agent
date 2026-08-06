import { once } from 'events'
import http from 'http'

import { FileLogger, type LogLevel } from './logger.ts'

import type { Message } from '../types'

/** Configuration for the development Tl gateway bridge. */
export interface TlProxyConfig {
	port: number
	qwenBaseUrl: string
	qwenModel: string
	qwenApiKey?: string
	/** Name of the init prompt variable containing the native system message. */
	systemPromptVariableName?: string
	/** Inject an upstream fetch implementation for tests. */
	customFetch?: typeof globalThis.fetch
}

interface PromptVariable {
	name: string
	value: string
}

interface ResponseFormat {
	type: 'json_object'
}

interface InitSessionRequest {
	appId?: string
	trCode?: string
	trVersion?: string
	timestamp?: number
	requestId?: string
	data?: {
		prompt_variables?: unknown
		response_format?: unknown
	}
}

interface ChatRequest {
	appId?: string
	trCode?: string
	trVersion?: string
	timestamp?: number
	requestId?: string
	data?: {
		session_id?: unknown
		txt?: unknown
		files?: { file_id: string; url: string; content_type: string }[]
		stream?: unknown
	}
}

interface Session {
	promptVariables: ReadonlyMap<string, string>
	responseFormat?: ResponseFormat
}

class SessionStore {
	private readonly sessions = new Map<string, Session>()

	createSession(promptVariables: PromptVariable[], responseFormat?: ResponseFormat): string {
		const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
		this.sessions.set(sessionId, {
			promptVariables: new Map(promptVariables.map(({ name, value }) => [name, value])),
			responseFormat,
		})
		return sessionId
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId)
	}

	getPromptVariables(sessionId: string): ReadonlyMap<string, string> | undefined {
		return this.sessions.get(sessionId)?.promptVariables
	}

	getResponseFormat(sessionId: string): ResponseFormat | undefined {
		return this.sessions.get(sessionId)?.responseFormat
	}
}

class ProxyRequestError extends Error {
	readonly statusCode: number

	constructor(message: string, statusCode: number) {
		super(message)
		this.name = 'ProxyRequestError'
		this.statusCode = statusCode
	}
}

export class TlProxyServer {
	private readonly config: {
		port: number
		qwenBaseUrl: string
		qwenModel: string
		qwenApiKey?: string
		systemPromptVariableName: string
	}
	private readonly server: http.Server
	private readonly sessionStore: SessionStore
	private readonly logger: FileLogger
	private readonly fetch: typeof globalThis.fetch

	constructor(config: TlProxyConfig) {
		const systemPromptVariableName = config.systemPromptVariableName ?? 'system_prompt'
		if (typeof systemPromptVariableName !== 'string' || !systemPromptVariableName.trim()) {
			throw new TypeError('TlProxyServer system prompt variable name must not be empty')
		}
		if (systemPromptVariableName !== systemPromptVariableName.trim()) {
			throw new TypeError(
				'TlProxyServer system prompt variable name must not include leading or trailing whitespace'
			)
		}
		if (systemPromptVariableName === 'name') {
			throw new TypeError(
				'TlProxyServer system prompt variable name must not be the reserved variable "name"'
			)
		}
		if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65_535) {
			throw new TypeError(
				`TlProxyServer port must be an integer between 0 and 65535 (received ${config.port})`
			)
		}

		this.config = {
			port: config.port,
			qwenBaseUrl: config.qwenBaseUrl.replace(/\/+$/, ''),
			qwenModel: config.qwenModel,
			qwenApiKey: config.qwenApiKey,
			systemPromptVariableName,
		}
		this.sessionStore = new SessionStore()
		this.fetch = config.customFetch ?? globalThis.fetch.bind(globalThis)
		this.logger = new FileLogger({
			module: 'TlProxy',
			level: (process.env.TL_PROXY_LOG_LEVEL as LogLevel) || 'info',
			echoToConsole: process.env.TL_PROXY_LOG_SILENT !== '1',
		})
		this.server = this.createServer()
	}

	/** Expose the logger for ad-hoc inspection/tests. */
	getLogger(): FileLogger {
		return this.logger
	}

	private createServer(): http.Server {
		return http.createServer((req, res) => {
			void this.handleRequest(req, res)
		})
	}

	/**
	 * Handle one HTTP request. Exposing the dispatcher keeps the proxy easy to
	 * exercise with in-memory request/response objects in unit tests.
	 */
	async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

		if (req.method === 'OPTIONS') {
			res.writeHead(200)
			res.end()
			return
		}

		try {
			if (req.method !== 'POST') {
				this.writeJson(res, 405, { error: 'Method not allowed' })
				return
			}

			const pathname = this.getPathname(req.url)
			if (pathname === '/chatbbc/init_session') {
				await this.handleInitSession(req, res)
			} else if (pathname === '/chatbbc/chat') {
				await this.handleChat(req, res)
			} else {
				this.logger.warn('Unhandled request', req.method, req.url)
				this.writeJson(res, 404, { error: 'Not found' })
			}
		} catch (error: unknown) {
			await this.handleRequestError(res, error)
		}
	}

	private async handleInitSession(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		const body = await this.getRequestBody<InitSessionRequest>(req)
		const promptVariables = this.validatePromptVariables(body)
		const responseFormat = this.validateResponseFormat(body)

		this.logger.info('📥 INIT_SESSION Request', {
			requestId: body.requestId,
			promptVariableCount: promptVariables.length,
		})
		this.logger.debug('INIT_SESSION request body', body)

		const sessionId = this.sessionStore.createSession(promptVariables, responseFormat)
		const responseData = {
			code: 0,
			message: 'success',
			data: {
				session_id: sessionId,
			},
		}

		this.logger.info('📤 INIT_SESSION Response', sessionId)

		this.writeJson(res, 200, responseData)
	}

	private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await this.getRequestBody<ChatRequest>(req)
		const data = body.data
		if (!data || typeof data.txt !== 'string') {
			throw new ProxyRequestError('Chat request must include data.txt', 400)
		}
		if (typeof data.session_id !== 'string' || !data.session_id.trim()) {
			throw new ProxyRequestError('Chat request must include data.session_id', 400)
		}

		const sessionId = data.session_id
		if (!this.sessionStore.has(sessionId)) {
			throw new ProxyRequestError(`Unknown session_id "${sessionId}"`, 404)
		}

		const stream = data.stream === undefined ? true : this.parseBoolean(data.stream, 'data.stream')
		const sessionPromptVariables = this.sessionStore.getPromptVariables(sessionId)
		if (!sessionPromptVariables) {
			// This should be unreachable after the has() check, but keeping the
			// guard makes a corrupted/expired session fail explicitly.
			throw new ProxyRequestError(`Unknown session_id "${sessionId}"`, 404)
		}

		const systemPrompt = sessionPromptVariables.get(this.config.systemPromptVariableName)
		const hasSystemPromptVariable = sessionPromptVariables.has(this.config.systemPromptVariableName)
		if (hasSystemPromptVariable && !systemPrompt?.trim()) {
			throw new ProxyRequestError(
				`Session prompt variable "${this.config.systemPromptVariableName}" is missing or empty`,
				400
			)
		}

		const messages: Message[] = hasSystemPromptVariable
			? [
					{ role: 'system', content: systemPrompt! },
					{ role: 'user', content: data.txt },
				]
			: this.parseChatText(data.txt)

		this.logger.info('📥 CHAT Request', {
			sessionId,
			stream,
			textLength: data.txt.length,
			text: data.txt,
		})

		this.logger.debug('Parsed messages', {
			count: messages.length,
			messages: messages.map((msg, idx) => {
				const content = msg.content ?? ''
				return {
					idx,
					role: msg.role,
					contentLength: content.length,
					content: content,
				}
			}),
		})

		try {
			const upstreamAbortController = new AbortController()
			res.once('close', () => {
				if (!res.writableEnded) upstreamAbortController.abort()
			})

			// Call qwen API directly
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
				Origin: 'http://localhost', // Required by qwen API origin check
			}
			if (this.config.qwenApiKey) {
				headers.Authorization = `Bearer ${this.config.qwenApiKey}`
			}

			const requestBody = {
				model: this.config.qwenModel,
				messages,
				response_format: this.sessionStore.getResponseFormat(sessionId),
				// The development Qwen endpoint does not support streaming. The proxy
				// converts this complete response into Tl-compatible SSE when requested.
				stream: false,
			}

			this.logger.info('📤 Sending to Qwen API', {
				url: `${this.config.qwenBaseUrl}/chat/completions`,
				model: this.config.qwenModel,
				messagesCount: messages.length,
			})
			this.logger.debug('Qwen request body', JSON.stringify(requestBody))

			const apiResponse = await this.fetch(`${this.config.qwenBaseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody),
				signal: upstreamAbortController.signal,
			})

			this.logger.info('📥 Qwen API Response', {
				status: apiResponse.status,
				statusText: apiResponse.statusText,
			})

			if (!apiResponse.ok) {
				const errorText = await apiResponse.text()
				this.logger.error('Qwen API error body', errorText)
				throw new Error(`API request failed: ${apiResponse.statusText}`)
			}

			const apiData = await apiResponse.json()
			this.logger.debug('Qwen response body', JSON.stringify(apiData))
			const responseContent = this.extractResponseContent(apiData)

			if (stream) {
				await this.writeSimulatedStream(responseContent, res)
			} else {
				const responseData = {
					code: 0,
					message: 'success',
					data: {
						txt: responseContent,
					},
				}

				this.logger.info('📤 Non-streaming Response to Client', {
					body: responseData,
				})

				this.writeJson(res, 200, responseData)
			}
		} catch (error) {
			this.logger.error('❌ Error calling qwen API', error)
			if (res.headersSent) {
				if (!res.writableEnded) {
					res.end(
						`event: error\ndata: ${JSON.stringify({
							message: 'Failed to stream API response',
						})}\n\n`
					)
				}
			} else {
				res.writeHead(500)
				res.end(JSON.stringify({ error: 'Failed to call qwen API' }))
			}
		}
	}

	private extractResponseContent(apiData: any): string {
		if (typeof apiData.choices?.[0]?.message?.content === 'string') {
			return apiData.choices[0].message.content
		}

		const toolCall = apiData.choices?.[0]?.message?.tool_calls?.[0]
		if (toolCall?.function?.name && typeof toolCall.function.arguments === 'string') {
			return JSON.stringify({
				tool_name: toolCall.function.name,
				parameters: JSON.parse(toolCall.function.arguments),
			})
		}

		throw new Error('Qwen response did not include message.content or a tool call')
	}

	private async writeSimulatedStream(
		responseContent: string,
		res: http.ServerResponse
	): Promise<void> {
		res.writeHead(200, {
			'Content-Type': 'text/event-stream; charset=utf-8',
			'Cache-Control': 'no-cache, no-transform',
			Connection: 'keep-alive',
			'X-Accel-Buffering': 'no',
		})
		res.flushHeaders()

		let eventId = 0

		const writeEvent = async (event: string, data: unknown): Promise<void> => {
			const frame = `id: ${Date.now()}-${eventId++}\nevent: ${event}\ndata: ${JSON.stringify(
				data
			)}\n\n`
			if (!res.write(frame)) await once(res, 'drain')
		}

		// Array.from splits by Unicode code point, avoiding broken surrogate pairs.
		const characters = Array.from(responseContent)
		const chunkSize = 32
		for (let offset = 0; offset < characters.length; offset += chunkSize) {
			await writeEvent('chunk', { content: characters.slice(offset, offset + chunkSize).join('') })
		}
		await writeEvent('done', { finished: true })
		res.end()
	}

	private getPathname(url: string | undefined): string {
		if (!url) return '/'
		try {
			return new URL(url, 'http://localhost').pathname
		} catch {
			return url.split('?')[0] || '/'
		}
	}

	private validatePromptVariables(body: InitSessionRequest): PromptVariable[] {
		if (!body || typeof body !== 'object') {
			throw new ProxyRequestError('Init request body must be a JSON object', 400)
		}

		const rawVariables = body.data?.prompt_variables
		if (rawVariables === undefined) return []
		if (!Array.isArray(rawVariables)) {
			throw new ProxyRequestError('data.prompt_variables must be an array', 400)
		}

		const seenNames = new Set<string>()
		const promptVariables: PromptVariable[] = []
		for (const [index, rawVariable] of rawVariables.entries()) {
			if (!rawVariable || typeof rawVariable !== 'object') {
				throw new ProxyRequestError(
					`data.prompt_variables[${index}] must be an object with name and value`,
					400
				)
			}

			const variable = rawVariable as { name?: unknown; value?: unknown }
			if (typeof variable.name !== 'string' || !variable.name.trim()) {
				throw new ProxyRequestError(`data.prompt_variables[${index}].name must not be empty`, 400)
			}
			if (typeof variable.value !== 'string') {
				throw new ProxyRequestError(`data.prompt_variables[${index}].value must be a string`, 400)
			}
			if (seenNames.has(variable.name)) {
				throw new ProxyRequestError(
					`data.prompt_variables contains duplicate name "${variable.name}"`,
					400
				)
			}

			seenNames.add(variable.name)
			promptVariables.push({ name: variable.name, value: variable.value })
		}

		const hasSystemPrompt = seenNames.has(this.config.systemPromptVariableName)
		const hasNonLegacyVariable = promptVariables.some(({ name }) => name !== 'name')
		if (hasNonLegacyVariable && !hasSystemPrompt) {
			throw new ProxyRequestError(
				`data.prompt_variables must include the system prompt variable "${this.config.systemPromptVariableName}"`,
				400
			)
		}

		const systemPrompt = promptVariables.find(
			({ name }) => name === this.config.systemPromptVariableName
		)?.value
		if (hasSystemPrompt && !systemPrompt?.trim()) {
			throw new ProxyRequestError(
				`data.prompt_variables system prompt variable "${this.config.systemPromptVariableName}" is missing or empty`,
				400
			)
		}

		return promptVariables
	}

	private validateResponseFormat(body: InitSessionRequest): ResponseFormat | undefined {
		const rawResponseFormat = body.data?.response_format
		if (rawResponseFormat === undefined) return undefined
		if (
			!rawResponseFormat ||
			typeof rawResponseFormat !== 'object' ||
			Array.isArray(rawResponseFormat) ||
			(rawResponseFormat as { type?: unknown }).type !== 'json_object'
		) {
			throw new ProxyRequestError(
				'data.response_format must be an object with type "json_object"',
				400
			)
		}

		return { type: 'json_object' }
	}

	private parseBoolean(value: unknown, fieldName: string): boolean {
		if (typeof value !== 'boolean') {
			throw new ProxyRequestError(`${fieldName} must be a boolean`, 400)
		}
		return value
	}

	private parseChatText(txt: string): Message[] {
		const messages: Message[] = []
		// Split by role markers at the start of a line
		// Using split with capturing group includes the role in the result array
		const parts = txt.split(/^(system|user|assistant):\s*/m)

		// parts[0] is anything before the first role marker (usually empty)
		// parts[1] is the first role, parts[2] is its content
		// parts[3] is the second role, parts[4] is its content, etc.
		for (let i = 1; i < parts.length; i += 2) {
			const role = parts[i] as 'system' | 'user' | 'assistant'
			const content = (parts[i + 1] || '').trim()
			messages.push({ role, content })
		}

		return messages.length > 0 ? messages : [{ role: 'user', content: txt }]
	}

	private async handleRequestError(res: http.ServerResponse, error: unknown): Promise<void> {
		if (error instanceof ProxyRequestError) {
			this.logger.warn('Rejected TlProxy request', error.message)
			if (!res.headersSent) {
				this.writeJson(res, error.statusCode, { error: error.message })
			}
			return
		}

		this.logger.error('Proxy error', error)
		if (res.headersSent) {
			if (!res.writableEnded) {
				res.end(
					`event: error\ndata: ${JSON.stringify({
						message: 'Failed to stream API response',
					})}\n\n`
				)
			}
			return
		}

		this.writeJson(res, 500, { error: 'Internal server error' })
	}

	private writeJson(
		res: http.ServerResponse,
		statusCode: number,
		body: unknown,
		extraHeaders?: Record<string, string>
	): void {
		res.writeHead(statusCode, {
			'Content-Type': 'application/json; charset=utf-8',
			...extraHeaders,
		})
		res.end(JSON.stringify(body))
	}

	private async getRequestBody<T>(req: http.IncomingMessage): Promise<T> {
		return new Promise((resolve, reject) => {
			let body = ''
			req.setEncoding('utf8')
			req.on('data', (chunk) => {
				body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
			})
			req.on('end', () => {
				try {
					resolve(JSON.parse(body) as T)
				} catch (error) {
					reject(new ProxyRequestError('Request body is not valid JSON', 400))
				}
			})
			req.on('error', (error) => {
				reject(error instanceof Error ? error : new Error(String(error)))
			})
		})
	}

	start(): void {
		this.server.listen(this.config.port, () => {
			const banner = [
				''.padEnd(60, '='),
				'🚀 TlProxyServer 已启动!',
				''.padEnd(60, '='),
				`📍 代理地址: http://localhost:${this.config.port}`,
				`🔗 转发到 qwen API: ${this.config.qwenBaseUrl}`,
				`🤖 使用模型: ${this.config.qwenModel}`,
				`📝 日志目录: ${this.logger.logDir}`,
				'',
				'📝 使用方法:',
				'  在 TlAiClient 配置中设置:',
				'  {',
				`    endpointAgent: "localhost:${this.config.port}",`,
				'    model: "your-model-name",',
				'    ...',
				'  }',
				'',
				'⏹️  按 Ctrl+C 停止服务器',
				''.padEnd(60, '='),
			].join('\n')
			this.logger.info(banner)
		})
	}

	stop(): void {
		this.server.close(async () => {
			this.logger.info('Server stopped')
			await this.logger.close()
		})
	}
}

// For standalone execution
if (import.meta.url.endsWith(process.argv[1])) {
	const DEFAULT_PORT = 8089
	const DEFAULT_QWEN_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
	const DEFAULT_QWEN_MODEL = 'qwen3.5-plus'

	const port = parseInt(process.env.PROXY_PORT || String(DEFAULT_PORT), 10)
	const qwenBaseUrl = process.env.QWEN_BASE_URL || DEFAULT_QWEN_BASE_URL
	const qwenModel = process.env.QWEN_MODEL || DEFAULT_QWEN_MODEL
	const systemPromptVariableName = process.env.TL_SYSTEM_PROMPT_VARIABLE_NAME || 'system_prompt'

	const proxy = new TlProxyServer({
		port,
		qwenBaseUrl,
		qwenModel,
		systemPromptVariableName,
	})
	proxy.start()

	// Handle shutdown — give the logger a chance to flush its buffer.
	const shutdown = async () => {
		proxy.stop()
		await proxy.getLogger().close()
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}
