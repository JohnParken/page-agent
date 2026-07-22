import http from 'http'

import type { Message } from './types'

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

export class YmProxyServer {
	private config: ProxyConfig
	private server: http.Server
	private sessionStore: SessionStore

	constructor(config: ProxyConfig) {
		this.config = config
		this.sessionStore = new SessionStore()
		this.server = this.createServer()
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
				if (req.url?.includes('/chatabc/init_session')) {
					await this.handleInitSession(req, res)
				} else if (req.url?.includes('/chatabc/chat')) {
					await this.handleChat(req, res)
				} else {
					res.writeHead(404)
					res.end(JSON.stringify({ error: 'Not found' }))
				}
			} catch (error) {
				console.error('Proxy error:', error)
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

		console.log('\n' + '='.repeat(80))
		console.log('[YmProxy] 📥 INIT_SESSION Request')
		console.log('='.repeat(80))
		console.log('Request Body:', JSON.stringify(body, null, 2))

		const sessionId = this.sessionStore.createSession()
		const responseData = {
			code: 0,
			message: 'success',
			data: {
				session_id: sessionId,
			},
		}

		console.log('\n[YmProxy] 📤 INIT_SESSION Response')
		console.log('Response Body:', JSON.stringify(responseData, null, 2))
		console.log('='.repeat(80) + '\n')

		res.writeHead(200)
		res.end(JSON.stringify(responseData))
	}

	private async handleChat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await this.getRequestBody<ChatRequest>(req)
		const { session_id, txt, stream } = body.data

		console.log('\n' + '='.repeat(80))
		console.log('[YmProxy] 📥 CHAT Request')
		console.log('='.repeat(80))
		console.log('Session ID:', session_id)
		console.log('Stream:', stream)
		console.log('Request Text Length:', txt.length)
		console.log('Request Text Preview:', txt.substring(0, 200) + (txt.length > 200 ? '...' : ''))

		// Parse the chat text to extract messages
		const messages = this.parseChatText(txt)

		console.log('\n[YmProxy] Parsed Messages:')
		messages.forEach((msg, idx) => {
			console.log(`  [${idx}] role: ${msg.role}`)
			console.log(`      content length: ${msg.content.length}`)
			console.log(
				`      content preview: ${msg.content.substring(0, 100)}${msg.content.length > 100 ? '...' : ''}`
			)
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

			console.log('\n[YmProxy] 📤 Sending to Qwen API:')
			console.log('  URL:', `${this.config.qwenBaseUrl}/chat/completions`)
			console.log('  Model:', this.config.qwenModel)
			console.log('  Messages count:', messages.length)
			console.log('  Request Body:', JSON.stringify(requestBody, null, 2).substring(0, 500) + '...')

			const apiResponse = await fetch(`${this.config.qwenBaseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(requestBody),
			})

			console.log('\n[YmProxy] 📥 Qwen API Response:')
			console.log('  Status:', apiResponse.status, apiResponse.statusText)

			if (!apiResponse.ok) {
				const errorText = await apiResponse.text()
				console.error('  Error Body:', errorText)
				throw new Error(`API request failed: ${apiResponse.statusText}`)
			}

			const apiData = await apiResponse.json()
			console.log('  Response Body:', JSON.stringify(apiData, null, 2).substring(0, 500) + '...')

			if (stream) {
				// Streaming response - YmClient expects a plain text stream
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

				console.log('\n[YmProxy] 📤 Streaming Response to Client:')
				console.log('  Content Length:', responseContent.length)
				console.log('  Content Preview:', responseContent.substring(0, 200) + '...')
				console.log('='.repeat(80) + '\n')

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

				console.log('\n[YmProxy] 📤 Non-streaming Response to Client:')
				console.log(
					'  Response Body:',
					JSON.stringify(responseData, null, 2).substring(0, 300) + '...'
				)
				console.log('='.repeat(80) + '\n')

				res.writeHead(200)
				res.end(JSON.stringify(responseData))
			}
		} catch (error) {
			console.error('\n[YmProxy] ❌ Error calling qwen API:')
			console.error('  Error:', error)
			console.log('='.repeat(80) + '\n')
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
			console.log('='.repeat(60))
			console.log('🚀 YmProxyServer 已启动!')
			console.log('='.repeat(60))
			console.log(`📍 代理地址: http://localhost:${this.config.port}`)
			console.log(`🔗 转发到 qwen API: ${this.config.qwenBaseUrl}`)
			console.log(`🤖 使用模型: ${this.config.qwenModel}`)
			console.log('')
			console.log('📝 使用方法:')
			console.log('  在 YimingAiClient 配置中设置:')
			console.log('  {')
			console.log(`    endpointAgent: "localhost:${this.config.port}",`)
			console.log('    model: "your-model-name",')
			console.log('    ...')
			console.log('  }')
			console.log('')
			console.log('⏹️  按 Ctrl+C 停止服务器')
			console.log('='.repeat(60))
		})
	}

	stop(): void {
		this.server.close(() => {
			console.log('\n[YmProxy] Server stopped')
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

	const proxy = new YmProxyServer({ port, qwenBaseUrl, qwenModel })
	proxy.start()

	// Handle shutdown
	process.on('SIGINT', () => {
		proxy.stop()
		process.exit(0)
	})

	process.on('SIGTERM', () => {
		proxy.stop()
		process.exit(0)
	})
}
