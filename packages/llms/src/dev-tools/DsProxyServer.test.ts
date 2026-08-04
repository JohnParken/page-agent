import { EventEmitter } from 'events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DsProxyServer } from './DsProxyServer'

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function requestBody(sessionId: string, stream: boolean, txt: string) {
	return {
		appId: 'test-app',
		trCode: 'test-code',
		trVersion: '1.0',
		timestamp: Date.now(),
		requestId: 'test-request',
		data: {
			session_id: sessionId,
			txt,
			files: [],
			stream,
		},
	}
}

class MockRequest extends EventEmitter {
	method = 'POST'
	url: string

	constructor(url: string, body: unknown) {
		super()
		this.url = url
		queueMicrotask(() => {
			this.emit('data', Buffer.from(JSON.stringify(body)))
			this.emit('end')
		})
	}

	setEncoding(): this {
		return this
	}
}

class MockResponse extends EventEmitter {
	statusCode = 0
	headersSent = false
	writableEnded = false
	readonly headers = new Map<string, string>()
	readonly chunks: string[] = []

	setHeader(name: string, value: string): this {
		this.headers.set(name.toLowerCase(), value)
		return this
	}

	writeHead(statusCode: number, headers?: Record<string, string>): this {
		this.statusCode = statusCode
		this.headersSent = true
		for (const [name, value] of Object.entries(headers ?? {})) this.setHeader(name, value)
		return this
	}

	flushHeaders(): void {
		this.headersSent = true
	}

	write(chunk: string): boolean {
		this.chunks.push(chunk)
		return true
	}

	end(chunk?: string): this {
		if (chunk) this.chunks.push(chunk)
		this.writableEnded = true
		this.emit('close')
		return this
	}

	bodyText(): string {
		return this.chunks.join('')
	}
}

async function dispatch(proxy: DsProxyServer, url: string, body: unknown): Promise<MockResponse> {
	const request = new MockRequest(url, body)
	const response = new MockResponse()
	await proxy.handleRequest(request as never, response as never)
	return response
}

describe('DsProxyServer', () => {
	const servers: DsProxyServer[] = []

	afterEach(async () => {
		while (servers.length > 0) {
			await servers.pop()!.stop()
		}
	})

	it('translates chatbbc init/chat requests into DeepSeek JSON Output and Tl SSE', async () => {
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(
				jsonResponse({
					choices: [
						{
							message: {
								content: '{"action":{"done":{"success":true,"text":"ok"}}}',
							},
						},
					],
				})
			)
		const proxy = new DsProxyServer({
			port: 0,
			deepseekBaseUrl: 'https://api.deepseek.example/v1/',
			deepseekModel: 'deepseek-default',
			deepseekApiKey: 'sk-test',
			customFetch: upstreamFetch,
		})
		servers.push(proxy)

		const initResponse = await dispatch(proxy, '/chatbbc/init_session', {
			appId: 'test-app',
			data: { prompt_variables: [{ name: 'name', value: 'deepseek-test' }] },
		})
		const initData = JSON.parse(initResponse.bodyText())
		const sessionId = initData.data.session_id as string
		expect(initResponse.statusCode).toBe(200)
		expect(initData).toMatchObject({ code: 0, data: { session_id: expect.any(String) } })

		const chatResponse = await dispatch(
			proxy,
			'/chatbbc/chat',
			requestBody(sessionId, true, 'system: Return a JSON object.\nuser: complete the task')
		)
		const sse = chatResponse.bodyText()

		expect(chatResponse.statusCode).toBe(200)
		expect(chatResponse.headers.get('content-type')).toContain('text/event-stream')
		expect(sse).toContain('event: chunk')
		expect(sse).toContain('event: done')
		expect(sse).toContain('success')

		expect(upstreamFetch).toHaveBeenCalledOnce()
		const [url, init] = upstreamFetch.mock.calls[0]
		expect(url).toBe('https://api.deepseek.example/v1/chat/completions')
		expect(init?.method).toBe('POST')
		expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
		const body = JSON.parse(init?.body as string)
		expect(body).toMatchObject({
			// init_session's prompt variable is bound to this session and takes
			// precedence over the proxy-wide fallback model.
			model: 'deepseek-test',
			response_format: { type: 'json_object' },
			stream: false,
			max_tokens: 4096,
			messages: [
				{ role: 'system', content: 'Return a JSON object.' },
				{ role: 'user', content: 'complete the task' },
			],
		})
	})

	it('returns non-streaming chatbbc JSON and adds a JSON instruction when needed', async () => {
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] }))
		const proxy = new DsProxyServer({ port: 0, customFetch: upstreamFetch })
		servers.push(proxy)

		const response = await dispatch(
			proxy,
			'/chatbbc/chat',
			requestBody('session_missing', false, 'user: say hello')
		)

		expect(response.statusCode).toBe(200)
		expect(JSON.parse(response.bodyText())).toEqual({
			code: 0,
			message: 'success',
			data: { txt: '{"ok":true}' },
		})

		const body = JSON.parse(upstreamFetch.mock.calls[0][1]?.body as string)
		expect(body.model).toBe('deepseek-chat')
		expect(body.messages[0]).toMatchObject({ role: 'system' })
		expect(body.messages[0].content).toMatch(/json/i)
		expect(body.messages[1]).toEqual({ role: 'user', content: 'say hello' })
	})

	it('maps an upstream DeepSeek failure without making a real network request', async () => {
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401))
		const proxy = new DsProxyServer({ port: 0, customFetch: upstreamFetch })
		servers.push(proxy)

		const response = await dispatch(
			proxy,
			'/chatbbc/chat',
			requestBody('session_missing', true, 'user: hello')
		)

		expect(response.statusCode).toBe(401)
		expect(JSON.parse(response.bodyText())).toMatchObject({
			error: expect.stringContaining('HTTP 401'),
		})
	})
})
