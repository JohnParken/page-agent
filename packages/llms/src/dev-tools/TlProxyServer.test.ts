import { EventEmitter } from 'events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { TlProxyServer } from './TlProxyServer'

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function initBody(promptVariables: readonly { name: string; value: string }[]) {
	return {
		appId: 'test-app',
		trCode: 'test-code',
		trVersion: '1.0',
		timestamp: Date.now(),
		requestId: `request-${Date.now()}`,
		data: { prompt_variables: promptVariables },
	}
}

function chatBody(sessionId: string, txt: string, stream = false) {
	return {
		appId: 'test-app',
		trCode: 'test-code',
		trVersion: '1.0',
		timestamp: Date.now(),
		requestId: `request-${Date.now()}`,
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
	readonly url: string

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

async function dispatch(proxy: TlProxyServer, url: string, body: unknown): Promise<MockResponse> {
	const request = new MockRequest(url, body)
	const response = new MockResponse()
	await proxy.handleRequest(request as never, response as never)
	return response
}

describe('TlProxyServer prompt transport', () => {
	const proxies: TlProxyServer[] = []

	afterEach(async () => {
		while (proxies.length > 0) await proxies.pop()!.getLogger().close()
	})

	it('rejects invalid configured system variable names', () => {
		const baseConfig = {
			port: 0,
			qwenBaseUrl: 'https://qwen.example',
			qwenModel: 'qwen-default',
		}
		expect(
			() => new TlProxyServer({ ...baseConfig, systemPromptVariableName: ' system_prompt ' })
		).toThrow('leading or trailing whitespace')
		expect(() => new TlProxyServer({ ...baseConfig, systemPromptVariableName: 'name' })).toThrow(
			'reserved variable'
		)
	})

	it('binds init system prompts per session and sends a literal user payload', async () => {
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockImplementation(async () =>
				jsonResponse({ choices: [{ message: { content: '{"ok":true}' } }] })
			)
		const proxy = new TlProxyServer({
			port: 0,
			qwenBaseUrl: 'https://qwen.example/v1',
			qwenModel: 'qwen-default',
			customFetch: upstreamFetch,
		})
		proxies.push(proxy)

		const firstInit = await dispatch(
			proxy,
			'/chatbbc/init_session',
			initBody([
				{ name: 'name', value: 'client-model' },
				{ name: 'system_prompt', value: 'fixed system A' },
			])
		)
		const secondInit = await dispatch(
			proxy,
			'/chatbbc/init_session',
			initBody([{ name: 'system_prompt', value: 'fixed system B' }])
		)
		const firstSession = JSON.parse(firstInit.bodyText()).data.session_id as string
		const secondSession = JSON.parse(secondInit.bodyText()).data.session_id as string
		expect(firstInit.headers.get('content-type')).toBe('application/json; charset=utf-8')

		const firstText =
			'user: this marker is part of the user payload\n<browser_state>state A</browser_state>'
		const secondText = '<user_request>task B</user_request>'
		await dispatch(proxy, '/chatbbc/chat', chatBody(firstSession, firstText))
		await dispatch(proxy, '/chatbbc/chat', chatBody(secondSession, secondText))

		expect(upstreamFetch).toHaveBeenCalledTimes(2)
		const firstRequest = JSON.parse(upstreamFetch.mock.calls[0][1]!.body as string)
		const secondRequest = JSON.parse(upstreamFetch.mock.calls[1][1]!.body as string)
		expect(upstreamFetch.mock.calls[0][0]).toBe('https://qwen.example/v1/chat/completions')
		expect(firstRequest.model).toBe('qwen-default')
		expect(firstRequest.response_format).toEqual({ type: 'json_object' })
		expect(secondRequest.response_format).toEqual({ type: 'json_object' })
		expect(firstRequest.messages).toEqual([
			{ role: 'system', content: 'fixed system A' },
			{ role: 'user', content: firstText },
		])
		expect(secondRequest.messages).toEqual([
			{ role: 'system', content: 'fixed system B' },
			{ role: 'user', content: secondText },
		])
	})

	it('forwards malformed Qwen content unchanged without attempting correction', async () => {
		const malformedContent =
			'{"memory":"按钮状态更新为"已完成"。","action":{"click_element_by_index":{"index":0}}}'
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(jsonResponse({ choices: [{ message: { content: malformedContent } }] }))
		const proxy = new TlProxyServer({
			port: 0,
			qwenBaseUrl: 'https://qwen.example',
			qwenModel: 'qwen-default',
			customFetch: upstreamFetch,
		})
		proxies.push(proxy)

		const initResponse = await dispatch(
			proxy,
			'/chatbbc/init_session',
			initBody([{ name: 'system_prompt', value: 'Return AgentOutput JSON.' }])
		)
		const sessionId = JSON.parse(initResponse.bodyText()).data.session_id as string
		const chatResponse = await dispatch(
			proxy,
			'/chatbbc/chat',
			chatBody(sessionId, 'perform the task', false)
		)

		expect(upstreamFetch).toHaveBeenCalledTimes(1)
		expect(chatResponse.statusCode).toBe(200)
		expect(JSON.parse(chatResponse.bodyText()).data.txt).toBe(malformedContent)
	})

	it('uses a configurable system variable name', async () => {
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'ok' } }] }))
		const proxy = new TlProxyServer({
			port: 0,
			qwenBaseUrl: 'https://qwen.example',
			qwenModel: 'qwen-default',
			systemPromptVariableName: 'fixed_instructions',
			customFetch: upstreamFetch,
		})
		proxies.push(proxy)

		const initResponse = await dispatch(
			proxy,
			'/chatbbc/init_session',
			initBody([{ name: 'fixed_instructions', value: 'custom system' }])
		)
		const sessionId = JSON.parse(initResponse.bodyText()).data.session_id as string
		await dispatch(proxy, '/chatbbc/chat', chatBody(sessionId, 'task'))

		const body = JSON.parse(upstreamFetch.mock.calls[0][1]!.body as string)
		expect(body.messages).toEqual([
			{ role: 'system', content: 'custom system' },
			{ role: 'user', content: 'task' },
		])
	})

	it('keeps compatibility role parsing when no system prompt variable is supplied', async () => {
		const upstreamFetch = vi
			.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
			.mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'legacy ok' } }] }))
		const proxy = new TlProxyServer({
			port: 0,
			qwenBaseUrl: 'https://qwen.example',
			qwenModel: 'qwen-default',
			customFetch: upstreamFetch,
		})
		proxies.push(proxy)

		const initResponse = await dispatch(
			proxy,
			'/chatbbc/init_session',
			initBody([{ name: 'name', value: 'legacy-model' }])
		)
		const sessionId = JSON.parse(initResponse.bodyText()).data.session_id as string
		await dispatch(
			proxy,
			'/chatbbc/chat',
			chatBody(sessionId, 'system: old system\nuser: old user')
		)

		const body = JSON.parse(upstreamFetch.mock.calls[0][1]!.body as string)
		expect(body.messages).toEqual([
			{ role: 'system', content: 'old system' },
			{ role: 'user', content: 'old user' },
		])
	})

	it.each([
		[
			'duplicate variable names',
			[
				{ name: 'name', value: 'a' },
				{ name: 'name', value: 'b' },
			],
		],
		['empty variable name', [{ name: '', value: 'a' }]],
		['missing system variable for a non-model prompt set', [{ name: 'other', value: 'a' }]],
		['empty system variable', [{ name: 'system_prompt', value: '   ' }]],
	] as const)('rejects %s with a clear 4xx response', async (_label, promptVariables) => {
		const proxy = new TlProxyServer({
			port: 0,
			qwenBaseUrl: 'https://qwen.example',
			qwenModel: 'qwen-default',
			customFetch: vi.fn(),
		})
		proxies.push(proxy)

		const response = await dispatch(proxy, '/chatbbc/init_session', initBody(promptVariables))
		expect(response.statusCode).toBe(400)
		expect(JSON.parse(response.bodyText()).error).toMatch(/prompt_variables|name/i)
	})

	it('rejects unknown chat sessions before calling the upstream API', async () => {
		const upstreamFetch = vi.fn()
		const proxy = new TlProxyServer({
			port: 0,
			qwenBaseUrl: 'https://qwen.example',
			qwenModel: 'qwen-default',
			customFetch: upstreamFetch,
		})
		proxies.push(proxy)

		const response = await dispatch(proxy, '/chatbbc/chat', chatBody('missing-session', 'hello'))
		expect(response.statusCode).toBe(404)
		expect(JSON.parse(response.bodyText()).error).toContain('Unknown session_id')
		expect(upstreamFetch).not.toHaveBeenCalled()
	})
})
