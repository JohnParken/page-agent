import http from 'http'

import { FileLogger, type LogLevel } from './logger.ts'

import type { Message } from '../types'

interface ProxyConfig {
	port: number
	qwenBaseUrl: string
	qwenModel: string
	qwenApiKey?: string
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

class SessionStore {
	private sessions: Map<string, Message[]> = new Map<string, Message[]>()

	createSession(): string {
		const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
		this.sessions.set(sessionId, [])
		return sessionId
	}
}

export class TlProxyServer {
	private config: ProxyConfig
	private server: http.Server
	private sessionStore: SessionStore
	private logger: FileLogger

	constructor(config: ProxyConfig) {
		this.config = config
		this.sessionStore = new SessionStore()
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
		return http.createServer(async (req, res) => {
			res.setHeader('Content-Type', 'application/json')
			res.setHeader('Access-Control-Allow-Origin', '*')
			res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
			res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

			if (req.method === 'OPTIONS') {
				res.writeHead(200)
				res.end()
				return
			}

			try {
				if (req.url?.includes('/chatbbc/init_session')) {
					await this.handleInitSession(req, res)
				} else if (req.url?.includes('/chatbbc/chat')) {
					await this.handleChat(req, res)
				} else {
					this.logger.warn('Unhandled request', req.method, req.url)
					res.writeHead(404)
					res.end(JSON.stringify({ error: 'Not found' }))
				}
			} catch (error) {
				this.logger.error('Proxy error', error)
				res.writeHead(500)
				res.end(JSON.stringify({ error: 'Internal server error' }))
			}
		})
	}

	private async handleInitSession(
		req: http.IncomingMessage,
		res: http.ServerResponse
	): Promise<void> {
		const body = await this.getRequestBody<InitSessionRequest>(req)

		this.logger.info('📥 INIT_SESSION Request')
		this.logger.debug('INIT_SESSION request body', JSON.stringify(body))

		const sessionId = this.sessionStore.createSession()
		const responseData = {
			code: 0,
			message: 'success',
			data: {
				session_id: sessionId,
			},
		}

		this.logger.info('📤 INIT_SESSION Response', sessionId)

		res.writeHead(200)
		res.end(JSON.stringify(responseData))
	}

	private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await this.getRequestBody<ChatRequest>(req)
		const { session_id, txt, stream } = body.data

		this.logger.info('📥 CHAT Request', {
			sessionId: session_id,
			stream,
			textLength: txt.length,
			text: txt,
		})

		// Parse the chat text to extract messages
		const messages = this.parseChatText(txt)

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
			}

			this.logger.info('📤 Sending to Qwen API', {
				url: `${this.config.qwenBaseUrl}/chat/completions`,
				model: this.config.qwenModel,
				messagesCount: messages.length,
			})
			this.logger.debug('Qwen request body', JSON.stringify(requestBody))

			const apiResponse = await fetch(`${this.config.qwenBaseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody),
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

			if (stream) {
				// Streaming response - TlClient expects a plain text stream
				res.writeHead(200, { 'Content-Type': 'text/plain' })

				let responseContent = ''
				if (apiData.choices?.[0]?.message?.content) {
					responseContent = apiData.choices[0].message.content
				} else if (apiData.choices?.[0]?.message?.tool_calls) {
					// If there's a tool call, extract and return the tool call JSON
					const toolCall = apiData.choices[0].message.tool_calls[0]
					responseContent = JSON.stringify({
						tool_name: toolCall.function.name,
						parameters: JSON.parse(toolCall.function.arguments),
					})
				}

				this.logger.info('📤 Streaming Response to Client', {
					contentLength: responseContent.length,
					content: responseContent,
				})

				res.write(responseContent)
				res.end()
			} else {
				// Non-streaming response
				let responseContent = ''
				if (apiData.choices?.[0]?.message?.content) {
					responseContent = apiData.choices[0].message.content
				} else if (apiData.choices?.[0]?.message?.tool_calls) {
					const toolCall = apiData.choices[0].message.tool_calls[0]
					responseContent = JSON.stringify({
						tool_name: toolCall.function.name,
						parameters: JSON.parse(toolCall.function.arguments),
					})
				}

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

				res.writeHead(200)
				res.end(JSON.stringify(responseData))
			}
		} catch (error) {
			this.logger.error('❌ Error calling qwen API', error)
			res.writeHead(500)
			res.end(JSON.stringify({ error: 'Failed to call qwen API' }))
		}
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

	private async getRequestBody<T>(req: http.IncomingMessage): Promise<T> {
		return new Promise((resolve, reject) => {
			let body = ''
			req.on('data', (chunk) => {
				body += chunk.toString()
			})
			req.on('end', () => {
				try {
					resolve(JSON.parse(body) as T)
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)))
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

	const proxy = new TlProxyServer({ port, qwenBaseUrl, qwenModel })
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
