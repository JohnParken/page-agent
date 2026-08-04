import { once } from 'events'
import http from 'http'

import { FileLogger, type LogLevel } from './logger.ts'

import type { Message } from '../types'

/** Configuration for the local DeepSeek gateway simulator. */
export interface DsProxyConfig {
	/** Port to listen on. Use 0 in tests to let the OS choose a free port. */
	port?: number
	/** Bind address. Defaults to loopback so the development key is not exposed. */
	host?: string
	/** DeepSeek-compatible API base URL, without the `/chat/completions` path. */
	deepseekBaseUrl?: string
	/** Model sent to the native DeepSeek API. */
	deepseekModel?: string
	/** API key kept on the proxy process; never read from browser requests. */
	deepseekApiKey?: string
	/** Maximum number of output tokens sent to DeepSeek. */
	maxTokens?: number
	/** Inject an upstream fetch implementation for tests. */
	customFetch?: typeof globalThis.fetch
	/** Alias accepted for callers that use the native fetch naming. */
	fetch?: typeof globalThis.fetch
}

interface InitSessionRequest {
	appId?: string
	trCode?: string
	trVersion?: string
	timestamp?: number
	requestId?: string
	data?: {
		prompt_variables?: { name: string; value: string }[]
	}
}

interface ChatRequest {
	appId?: string
	trCode?: string
	trVersion?: string
	timestamp?: number
	requestId?: string
	data?: {
		session_id?: string
		txt?: string
		files?: { file_id: string; url: string; content_type: string }[]
		stream?: boolean
	}
}

interface Session {
	createdAt: number
	model?: string
}

class SessionStore {
	private readonly sessions = new Map<string, Session>()

	createSession(model?: string): string {
		const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
		this.sessions.set(sessionId, { createdAt: Date.now(), model })
		return sessionId
	}

	has(sessionId: string): boolean {
		return this.sessions.has(sessionId)
	}

	getModel(sessionId: string): string | undefined {
		return this.sessions.get(sessionId)?.model
	}
}

class UpstreamError extends Error {
	readonly statusCode: number
	readonly responseBody: string

	constructor(message: string, statusCode: number, responseBody = '') {
		super(message)
		this.name = 'UpstreamError'
		this.statusCode = statusCode
		this.responseBody = responseBody
	}
}

const DEFAULT_PORT = 8090
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_MAX_TOKENS = 4096

/**
 * Development-only bridge between DsAiClient's chatbbc protocol and the
 * OpenAI-compatible DeepSeek API.
 *
 * The browser-facing side intentionally has no API-key configuration. The key
 * is supplied to this Node process through its environment and is attached
 * only to the upstream request.
 */
export class DsProxyServer {
	readonly config: Required<
		Pick<DsProxyConfig, 'port' | 'host' | 'deepseekBaseUrl' | 'deepseekModel' | 'maxTokens'>
	> &
		Pick<DsProxyConfig, 'deepseekApiKey'>

	private readonly server: http.Server
	private readonly sessionStore = new SessionStore()
	private readonly logger: FileLogger
	private readonly fetch: typeof globalThis.fetch
	private started = false

	constructor(config: DsProxyConfig = {}) {
		const port = config.port ?? DEFAULT_PORT
		if (!Number.isInteger(port) || port < 0 || port > 65_535) {
			throw new TypeError(
				`DsProxyServer port must be an integer between 0 and 65535 (received ${port})`
			)
		}

		const baseUrl = (config.deepseekBaseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
		if (!baseUrl) throw new TypeError('DsProxyServer deepseekBaseUrl must not be empty')

		const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS
		if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
			throw new TypeError(
				`DsProxyServer maxTokens must be a positive integer (received ${maxTokens})`
			)
		}

		this.config = {
			port,
			host: config.host?.trim() || DEFAULT_HOST,
			deepseekBaseUrl: baseUrl,
			deepseekModel: config.deepseekModel?.trim() || DEFAULT_MODEL,
			deepseekApiKey: config.deepseekApiKey,
			maxTokens,
		}

		this.fetch = config.customFetch ?? config.fetch ?? globalThis.fetch.bind(globalThis)
		this.logger = new FileLogger({
			module: 'DsProxy',
			level: (process.env.DS_PROXY_LOG_LEVEL as LogLevel) || 'info',
			echoToConsole: process.env.DS_PROXY_LOG_SILENT !== '1',
		})
		this.server = this.createServer()
	}

	/** Expose the logger for tests and graceful shutdown handlers. */
	getLogger(): FileLogger {
		return this.logger
	}

	/** Return the bound port, including the ephemeral port selected for port 0. */
	getPort(): number {
		const address = this.server.address()
		return typeof address === 'object' && address ? address.port : this.config.port
	}

	private createServer(): http.Server {
		return http.createServer((req, res) => {
			void this.handleRequest(req, res)
		})
	}

	/**
	 * Handle one HTTP request. This is public so tests can exercise the proxy
	 * with an in-memory request/response pair without opening a network port.
	 */
	async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		this.setCorsHeaders(res)

		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			res.end()
			return
		}

		const pathname = this.getPathname(req.url)
		try {
			if (req.method !== 'POST') {
				this.writeJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, OPTIONS' })
				return
			}

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

	private setCorsHeaders(res: http.ServerResponse): void {
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
	}

	private getPathname(url: string | undefined): string {
		if (!url) return '/'
		try {
			return new URL(url, 'http://localhost').pathname
		} catch {
			return url.split('?')[0] || '/'
		}
	}

	private async handleInitSession(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		const body = await this.getRequestBody<InitSessionRequest>(req)
		const sessionModel = body.data?.prompt_variables?.find((variable) => variable.name === 'name')
			?.value
		const sessionId = this.sessionStore.createSession(sessionModel?.trim() || undefined)

		this.logger.info('📥 INIT_SESSION Request', {
			requestId: body.requestId,
			model: this.config.deepseekModel,
		})
		this.logger.debug('INIT_SESSION request body', body)

		this.writeJson(res, 200, {
			code: 0,
			message: 'success',
			data: { session_id: sessionId },
		})
		this.logger.info('📤 INIT_SESSION Response', sessionId)
	}

	private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await this.getRequestBody<ChatRequest>(req)
		const data = body.data
		if (!data || typeof data.txt !== 'string') {
			throw new UpstreamError('Chat request must include data.txt', 400)
		}

		const sessionId = data.session_id || ''
		const sessionModel = sessionId ? this.sessionStore.getModel(sessionId) : undefined
		if (sessionId && !this.sessionStore.has(sessionId)) {
			this.logger.warn('CHAT Request referenced unknown session', sessionId)
		}

		const stream = data.stream ?? true
		const messages = this.parseChatText(data.txt)
		this.logger.info('📥 CHAT Request', {
			sessionId,
			stream,
			textLength: data.txt.length,
		})
		this.logger.debug('Parsed messages', messages)

		const upstreamAbortController = new AbortController()
		res.once('close', () => {
			if (!res.writableEnded) upstreamAbortController.abort()
		})

		const requestBody: Record<string, unknown> = {
			model: sessionModel || this.config.deepseekModel,
			messages: this.ensureJsonPrompt(messages),
			response_format: { type: 'json_object' },
			// DsAiClient consumes chatbbc SSE. Keep the upstream response complete
			// and adapt it below so the bridge works with both stream=true/false.
			stream: false,
			max_tokens: this.config.maxTokens,
		}

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			Accept: 'application/json',
		}
		if (this.config.deepseekApiKey) {
			headers.Authorization = `Bearer ${this.config.deepseekApiKey}`
		}

		const url = `${this.config.deepseekBaseUrl}/chat/completions`
		this.logger.info('📤 Sending to DeepSeek API', {
			url,
			model: requestBody.model,
			messagesCount: messages.length,
			stream: false,
		})
		this.logger.debug('DeepSeek request body', requestBody)

		let apiResponse: Response
		try {
			apiResponse = await this.fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody),
				signal: upstreamAbortController.signal,
			})
		} catch (error: unknown) {
			if ((error as { name?: string })?.name === 'AbortError') throw error
			throw new UpstreamError(`DeepSeek API request failed: ${this.describeError(error)}`, 502)
		}

		this.logger.info('📥 DeepSeek API Response', {
			status: apiResponse.status,
			statusText: apiResponse.statusText,
		})

		if (!apiResponse.ok) {
			const errorText = await apiResponse.text()
			this.logger.error('DeepSeek API error body', errorText)
			throw new UpstreamError(
				`DeepSeek API request failed with HTTP ${apiResponse.status}`,
				this.normalizeStatus(apiResponse.status),
				errorText
			)
		}

		let apiData: unknown
		try {
			apiData = await apiResponse.json()
		} catch (error: unknown) {
			throw new UpstreamError(
				`DeepSeek API returned invalid JSON: ${this.describeError(error)}`,
				502
			)
		}

		this.logger.debug('DeepSeek response body', apiData)
		const responseContent = this.extractResponseContent(apiData)
		if (stream) {
			await this.writeSimulatedStream(responseContent, res)
			return
		}

		this.writeJson(res, 200, {
			code: 0,
			message: 'success',
			data: { txt: responseContent },
		})
	}

	private parseChatText(txt: string): Message[] {
		const messages: Message[] = []
		// Role markers are emitted by DsAiClient at the beginning of lines. Keep
		// multiline prompt content intact while mapping it to native messages.
		const parts = txt.split(/^(system|user|assistant|tool):\s*/m)
		for (let i = 1; i < parts.length; i += 2) {
			const role = parts[i] as Message['role']
			const content = (parts[i + 1] || '').trim()
			messages.push({ role, content })
		}
		return messages.length > 0 ? messages : [{ role: 'user', content: txt }]
	}

	private ensureJsonPrompt(messages: Message[]): Message[] {
		const hasJsonInstruction = messages.some(
			(message) => typeof message.content === 'string' && /\bjson\b/i.test(message.content)
		)
		if (hasJsonInstruction) return messages

		const firstSystemIndex = messages.findIndex((message) => message.role === 'system')
		const instruction: Message = {
			role: 'system',
			content:
				'Output a valid JSON object. Example: {"action":{"done":{"success":true,"text":"ok"}}}.',
		}

		if (firstSystemIndex === -1) return [instruction, ...messages]
		const copy = messages.slice()
		const system = copy[firstSystemIndex]
		copy[firstSystemIndex] = {
			...system,
			content: `${system.content ?? ''}\n\n${instruction.content}`,
		}
		return copy
	}

	private extractResponseContent(apiData: unknown): string {
		const data = apiData as {
			choices?: {
				message?: {
					content?: unknown
					tool_calls?: { function?: { name?: unknown; arguments?: unknown } }[]
				}
			}[]
		}
		const message = data?.choices?.[0]?.message
		if (typeof message?.content === 'string' && message.content.trim()) return message.content

		const toolCall = message?.tool_calls?.[0]
		const toolName = toolCall?.function?.name
		const rawArguments = toolCall?.function?.arguments
		if (typeof toolName === 'string' && typeof rawArguments === 'string') {
			let parameters: unknown = rawArguments
			try {
				parameters = JSON.parse(rawArguments)
			} catch {
				// Preserve malformed arguments in the bridge response for diagnostics.
			}
			return JSON.stringify({ tool_name: toolName, parameters })
		}

		throw new UpstreamError(
			'DeepSeek response did not include a non-empty message.content or tool call',
			502,
			JSON.stringify(apiData)
		)
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

	private async handleRequestError(res: http.ServerResponse, error: unknown): Promise<void> {
		const isAbortError = (error as { name?: string })?.name === 'AbortError'
		if (isAbortError) {
			if (!res.writableEnded) res.end()
			return
		}

		this.logger.error('❌ DsProxy request failed', error)
		if (res.headersSent) {
			if (!res.writableEnded) {
				res.end(
					`event: error\ndata: ${JSON.stringify({
						message: 'Failed to stream DeepSeek response',
					})}\n\n`
				)
			}
			return
		}

		if (error instanceof UpstreamError) {
			this.writeJson(res, error.statusCode, {
				error: error.message,
				...(error.responseBody ? { details: error.responseBody } : {}),
			})
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
			req.on('data', (chunk: string) => {
				body += chunk
			})
			req.on('end', () => {
				try {
					resolve(JSON.parse(body) as T)
				} catch (error: unknown) {
					reject(new UpstreamError('Request body is not valid JSON', 400, String(error)))
				}
			})
			req.on('error', (error: unknown) =>
				reject(error instanceof Error ? error : new Error(String(error)))
			)
		})
	}

	private normalizeStatus(status: number): number {
		return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502
	}

	private describeError(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}

	/** Start listening. Resolves once the port is bound. */
	start(): Promise<void> {
		if (this.started) return Promise.resolve()
		return new Promise((resolve, reject) => {
			const onError = (error: Error) => {
				this.server.off('listening', onListening)
				reject(error instanceof Error ? error : new Error(String(error)))
			}
			const onListening = () => {
				this.server.off('error', onError)
				this.started = true
				this.logger.info(
					[
						''.padEnd(60, '='),
						'🚀 DsProxyServer started',
						''.padEnd(60, '='),
						`📍 Proxy address: http://localhost:${this.getPort()}`,
						`🔗 Forwarding to DeepSeek API: ${this.config.deepseekBaseUrl}`,
						`🤖 Model: ${this.config.deepseekModel}`,
						`📝 Log directory: ${this.logger.logDir}`,
						'',
						'Use DsAiClient with:',
						'{',
						`  endpointAgent: "localhost:${this.getPort()}",`,
						`  model: "${this.config.deepseekModel}",`,
						'}',
						'',
						'Press Ctrl+C to stop the server',
						''.padEnd(60, '='),
					].join('\n')
				)
				resolve()
			}
			this.server.once('error', onError)
			this.server.once('listening', onListening)
			this.server.listen(this.config.port, this.config.host)
		})
	}

	/** Stop listening and flush the file logger. Safe to call repeatedly. */
	async stop(): Promise<void> {
		if (this.started || this.server.listening) {
			await new Promise<void>((resolve, reject) => {
				this.server.close((error) => (error ? reject(error) : resolve()))
			})
		}
		this.started = false
		this.logger.info('Server stopped')
		await this.logger.close()
	}
}

// Standalone execution (`node src/dev-tools/DsProxyServer.ts`).
if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
	const port = parseInt(process.env.DS_PROXY_PORT || String(DEFAULT_PORT), 10)
	const host = process.env.DS_PROXY_HOST || DEFAULT_HOST
	const deepseekBaseUrl = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
	const deepseekModel = process.env.DEEPSEEK_MODEL || DEFAULT_MODEL
	const deepseekApiKey = process.env.DEEPSEEK_API_KEY
	const parsedMaxTokens = process.env.DEEPSEEK_MAX_TOKENS
	const maxTokens = parsedMaxTokens ? parseInt(parsedMaxTokens, 10) : DEFAULT_MAX_TOKENS

	const proxy = new DsProxyServer({
		port,
		host,
		deepseekBaseUrl,
		deepseekModel,
		deepseekApiKey,
		maxTokens,
	})
	void proxy.start()

	const shutdown = async () => {
		try {
			await proxy.stop()
		} finally {
			process.exit(0)
		}
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)
}
