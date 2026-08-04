import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'

import { DsAiClient } from './DsClient'
import { InvokeErrorTypes } from './errors'

import type { InvokeOptions, Tool } from './types'

type DsConfig = ConstructorParameters<typeof DsAiClient>[0]
type FetchMock = ReturnType<typeof vi.fn>

function makeTool(): Tool<{ name: string }, string> {
	return {
		description: 'greet',
		inputSchema: z.object({ name: z.string() }),
		execute: vi.fn(async ({ name }) => `hello ${name}`),
	}
}

function makeGatewayClient(overrides: Partial<DsConfig> = {}) {
	const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
	const client = new DsAiClient({
		endpointAgent: 'localhost:8090',
		model: 'deepseek-chat',
		appId: 'test-app',
		trCode: 'test-code',
		trVersion: '1.0',
		...overrides,
		customFetch: fetchMock,
	})
	return { client, fetchMock }
}

function makeApiClient(overrides: Partial<DsConfig> = {}) {
	const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
	const client = new DsAiClient({
		baseURL: 'https://api.deepseek.com',
		model: 'deepseek-chat',
		...overrides,
		customFetch: fetchMock,
	})
	return { client, fetchMock }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

function textResponse(body: string, status = 200, contentType = 'text/plain') {
	return new Response(body, { status, headers: { 'Content-Type': contentType } })
}

function gatewaySse(content: string): Response {
	const splitAt = Math.max(1, Math.ceil(content.length / 2))
	const chunks = [content.slice(0, splitAt), content.slice(splitAt)]
	const body = chunks
		.map(
			(chunk, index) =>
				`id: ${index}\nevent: chunk\ndata: ${JSON.stringify({ content: chunk })}\n\n`
		)
		.join('')
	return textResponse(`${body}event: done\ndata: {"finished":true}\n\n`, 200, 'text/event-stream')
}

function openAiSse(
	content: string,
	usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } = {
		prompt_tokens: 4,
		completion_tokens: 6,
		total_tokens: 10,
	}
): Response {
	const splitAt = Math.max(1, Math.ceil(content.length / 2))
	const chunks = [content.slice(0, splitAt), content.slice(splitAt)]
	const body = chunks
		.map((chunk) => `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`)
		.join('')
	return textResponse(
		`${body}data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`,
		200,
		'text/event-stream; charset=utf-8'
	)
}

function initSessionBody(sessionId = 'session_123') {
	return { code: 0, message: 'success', data: { session_id: sessionId } }
}

function macroContent(name = 'greet', args: unknown = { name: 'Alice' }): string {
	return JSON.stringify({ action: { [name]: args } })
}

function requestBody(fetchMock: FetchMock, index = 0): Record<string, any> {
	const request = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
	if (typeof request?.body !== 'string') throw new Error('Request body was not serialized as JSON')
	return JSON.parse(request.body) as Record<string, any>
}

function requestHeaders(fetchMock: FetchMock, index = 0): Record<string, string> {
	const headers = (fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.headers
	if (headers instanceof Headers) {
		return Object.fromEntries(headers.entries())
	}
	return (headers ?? {}) as Record<string, string>
}

function abortError(message = 'aborted'): Error {
	const error = new Error(message)
	error.name = 'AbortError'
	return error
}

const signal = new AbortController().signal

describe('DsAiClient — configuration and transport selection', () => {
	it('infers gateway mode from endpointAgent and defaults to system_prompt', async () => {
		const { client, fetchMock } = makeGatewayClient()
		fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody()))
		fetchMock.mockResolvedValueOnce(gatewaySse(macroContent()))

		expect((client as any).config.toolCallingMode).toBe('system_prompt')
		await client.invoke([], { greet: makeTool() }, signal)

		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8090/chatbbc/init_session')
	})

	it('infers API mode from baseURL when endpointAgent is absent', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))

		await client.invoke([], { greet: makeTool() }, signal)

		expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
	})

	it('honors explicit dsMode when both transports are configured', async () => {
		const api = makeApiClient({
			dsMode: 'api',
			endpointAgent: 'https://gateway.example.com',
		})
		api.fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))
		await api.client.invoke([], { greet: makeTool() }, signal)
		expect(api.fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')

		const gateway = makeGatewayClient({
			dsMode: 'gateway',
			endpointAgent: 'https://gateway.example.com',
			baseURL: 'https://api.deepseek.com',
		})
		gateway.fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody()))
		gateway.fetchMock.mockResolvedValueOnce(gatewaySse(macroContent()))
		await gateway.client.invoke([], { greet: makeTool() }, signal)
		expect(gateway.fetchMock.mock.calls[0][0]).toBe(
			'https://gateway.example.com/chatbbc/init_session'
		)
	})

	it('rejects a configuration without endpointAgent or baseURL', () => {
		expect(
			() =>
				new DsAiClient({
					model: 'deepseek-chat',
					customFetch: vi.fn(),
				} as DsConfig)
		).toThrow(/endpointAgent|baseURL|transport/i)
	})

	it('rejects a non-HTTP gateway endpoint', () => {
		expect(() => makeGatewayClient({ endpointAgent: 'ftp://gateway.example.com' })).toThrow(
			/Unsupported .* endpointAgent protocol "ftp:"/
		)
	})

	it('rejects native tool calling instead of silently changing the DS wire contract', async () => {
		const { client, fetchMock } = makeApiClient({ toolCallingMode: 'api' })

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.CONFIG_ERROR,
			message: expect.stringContaining('system_prompt'),
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('DsAiClient — gateway transport', () => {
	it('initializes a session and sends the chatbbc request with all messages', async () => {
		const { client, fetchMock } = makeGatewayClient()
		const tool = makeTool()
		fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody('gateway-session')))
		fetchMock.mockResolvedValueOnce(gatewaySse(macroContent('greet', { name: 'SSE' })))

		const messages = [
			{ role: 'system' as const, content: 'system instructions' },
			{ role: 'user' as const, content: 'say hello' },
		]
		const result = await client.invoke(messages, { greet: tool }, signal)

		expect(fetchMock).toHaveBeenCalledTimes(2)
		const init = requestBody(fetchMock, 0)
		expect(init).toMatchObject({
			appId: 'test-app',
			trCode: 'test-code',
			trVersion: '1.0',
			timestamp: expect.any(Number),
			requestId: expect.any(String),
			data: { prompt_variables: [{ name: 'name', value: 'deepseek-chat' }] },
		})

		const chat = requestBody(fetchMock, 1)
		expect(chat).toMatchObject({
			appId: 'test-app',
			trCode: 'test-code',
			trVersion: '1.0',
			timestamp: expect.any(Number),
			requestId: expect.any(String),
			data: {
				session_id: 'gateway-session',
				files: [{ file_id: '', url: '', content_type: '' }],
				stream: true,
			},
		})
		expect(chat.data.txt).toContain('system: system instructions')
		expect(chat.data.txt).toContain('user: say hello')
		expect(requestHeaders(fetchMock, 1)).toMatchObject({
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		})
		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'SSE' } })
		expect(result.toolResult).toBe('hello SSE')
		expect(result.usage).toMatchObject({ promptTokens: 0, completionTokens: 0, totalTokens: 0 })
	})

	it('creates a fresh gateway session for every invocation', async () => {
		const { client, fetchMock } = makeGatewayClient()
		fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody('session-1')))
		fetchMock.mockResolvedValueOnce(gatewaySse(macroContent('greet', { name: 'one' })))
		await client.invoke([], { greet: makeTool() }, signal)

		fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody('session-2')))
		fetchMock.mockResolvedValueOnce(gatewaySse(macroContent('greet', { name: 'two' })))
		await client.invoke([], { greet: makeTool() }, signal)

		expect(fetchMock).toHaveBeenCalledTimes(4)
		expect(requestBody(fetchMock, 1).data.session_id).toBe('session-1')
		expect(requestBody(fetchMock, 3).data.session_id).toBe('session-2')
	})

	it('maps a rejected gateway session response to INVALID_RESPONSE', async () => {
		const { client, fetchMock } = makeGatewayClient()
		fetchMock.mockResolvedValueOnce(jsonResponse({ code: 1001, message: 'model unavailable' }))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('maps a malformed successful gateway session response to INVALID_SCHEMA', async () => {
		const { client, fetchMock } = makeGatewayClient()
		fetchMock.mockResolvedValueOnce(jsonResponse({ code: 0, data: {} }))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_SCHEMA,
		})
	})
})

describe('DsAiClient — native API request and response', () => {
	it('uses JSON Output mode with system messages, streaming, auth, and no native tools', async () => {
		const { client, fetchMock } = makeApiClient({
			apiKey: 'sk-test',
			maxTokens: 321,
			temperature: 0.2,
		})
		const messages = [
			{ role: 'system' as const, content: 'Return JSON.' },
			{ role: 'user' as const, content: 'Greet Alice.' },
		]
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent('greet', { name: 'Alice' })))

		const result = await client.invoke(messages, { greet: makeTool() }, signal, {
			toolChoiceName: 'AgentOutput',
		})

		const body = requestBody(fetchMock)
		expect(fetchMock.mock.calls[0][0]).toBe('https://api.deepseek.com/chat/completions')
		expect(body).toMatchObject({
			model: 'deepseek-chat',
			messages,
			stream: true,
			stream_options: { include_usage: true },
			response_format: { type: 'json_object' },
			max_tokens: 321,
			temperature: 0.2,
		})
		expect(body).not.toHaveProperty('tools')
		expect(body).not.toHaveProperty('tool_choice')
		expect(requestHeaders(fetchMock)).toMatchObject({
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
			Authorization: 'Bearer sk-test',
		})
		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'Alice' } })
		expect(result.toolResult).toBe('hello Alice')
		expect(result.usage).toMatchObject({
			promptTokens: 4,
			completionTokens: 6,
			totalTokens: 10,
		})
	})

	it('uses native API mode when explicitly selected and keeps system_prompt tool calling', async () => {
		const { client, fetchMock } = makeApiClient({ dsMode: 'api', toolCallingMode: 'system_prompt' })
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))

		await client.invoke(
			[
				{ role: 'system', content: 'System' },
				{ role: 'user', content: 'User' },
			],
			{ greet: makeTool() },
			signal
		)
		expect(requestBody(fetchMock).messages).toEqual([
			{ role: 'system', content: 'System' },
			{ role: 'user', content: 'User' },
		])
	})

	it('passes usage from the final OpenAI SSE frame', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(
			openAiSse(macroContent(), { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 })
		)

		const result = await client.invoke([], { greet: makeTool() }, signal)
		expect(result.usage).toMatchObject({ promptTokens: 11, completionTokens: 7, totalTokens: 18 })
	})

	it('accepts a non-streaming OpenAI JSON response when the transport falls back to JSON', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				choices: [
					{
						finish_reason: 'stop',
						message: { role: 'assistant', content: macroContent() },
					},
				],
				usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
			})
		)

		const result = await client.invoke([], { greet: makeTool() }, signal)
		expect(result.toolResult).toBe('hello Alice')
		expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 3, totalTokens: 5 })
	})

	it('maps a streaming length finish reason to CONTEXT_LENGTH', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(
			textResponse(
				'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',
				200,
				'text/event-stream'
			)
		)

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.CONTEXT_LENGTH,
		})
	})

	it('passes the accumulated API content to normalizeResponse', async () => {
		const { client, fetchMock } = makeApiClient()
		const rawContent = macroContent('greet', { name: 'normalized' })
		fetchMock.mockResolvedValueOnce(openAiSse(rawContent))
		const normalizeResponse = vi.fn<Parameters<Required<InvokeOptions>['normalizeResponse']>>(
			() => ({
				choices: [
					{
						message: {
							tool_calls: [
								{
									function: {
										name: 'greet',
										arguments: JSON.stringify({ name: 'normalized' }),
									},
								},
							],
						},
					},
				],
			})
		)

		const result = await client.invoke([], { greet: makeTool() }, signal, { normalizeResponse })
		expect(normalizeResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [
					expect.objectContaining({ message: expect.objectContaining({ content: rawContent }) }),
				],
			})
		)
		expect(result.toolCall.args).toEqual({ name: 'normalized' })
	})

	it('applies modelPatch only when requested and lets transformRequestBody mutate the final body', async () => {
		const transformRequestBody = vi.fn((body: Record<string, unknown>) => {
			body.custom_flag = true
			return undefined
		})
		const { client, fetchMock } = makeApiClient({
			applyModelPatch: true,
			transformRequestBody,
		})
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))

		await client.invoke([], { greet: makeTool() }, signal)

		expect(transformRequestBody).toHaveBeenCalledOnce()
		expect(requestBody(fetchMock)).toMatchObject({
			custom_flag: true,
			thinking: { type: 'disabled' },
		})
	})

	it('does not apply modelPatch by default', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))

		await client.invoke([], { greet: makeTool() }, signal)

		expect(requestBody(fetchMock)).not.toHaveProperty('thinking')
	})

	it('wraps transformRequestBody failures as CONFIG_ERROR', async () => {
		const { client, fetchMock } = makeApiClient({
			transformRequestBody: () => {
				throw new Error('bad transform')
			},
		})
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.CONFIG_ERROR,
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('DsAiClient — parsing and tool execution errors', () => {
	it('rejects empty API content as INVALID_RESPONSE', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(
			textResponse(
				'data: {"choices":[{"delta":{}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":0,"total_tokens":1}}\n\ndata: [DONE]\n\n',
				200,
				'text/event-stream'
			)
		)

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('rejects invalid JSON output as INVALID_RESPONSE', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(openAiSse('not-json'))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('rejects invalid tool arguments as INVALID_TOOL_ARGS', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent('greet', { name: 123 })))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_TOOL_ARGS,
		})
	})

	it('maps unknown actions to UNKNOWN', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent('missing', {})))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.UNKNOWN,
		})
	})

	it('maps tool execution failures to TOOL_EXECUTION_ERROR', async () => {
		const { client, fetchMock } = makeApiClient()
		const tool = makeTool()
		tool.execute = vi.fn(async () => {
			throw new Error('tool failed')
		})
		fetchMock.mockResolvedValueOnce(openAiSse(macroContent()))

		await expect(client.invoke([], { greet: tool }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.TOOL_EXECUTION_ERROR,
		})
	})

	it('rejects a non-JSON plain response as INVALID_RESPONSE', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(textResponse('not json'))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})
})

describe('DsAiClient — HTTP, network, and cancellation errors', () => {
	it.each([
		[401, InvokeErrorTypes.AUTH_ERROR],
		[403, InvokeErrorTypes.AUTH_ERROR],
		[429, InvokeErrorTypes.RATE_LIMIT],
		[500, InvokeErrorTypes.SERVER_ERROR],
		[502, InvokeErrorTypes.SERVER_ERROR],
		[418, InvokeErrorTypes.UNKNOWN],
	] as const)('maps API HTTP %i to %s', async (status, type) => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'request failed' } }, status))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({ type })
	})

	it('maps gateway init HTTP failures and preserves the status', async () => {
		const { client, fetchMock } = makeGatewayClient()
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 403))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.AUTH_ERROR,
			statusCode: 403,
		})
	})

	it('wraps network errors with the endpoint', async () => {
		const { client, fetchMock } = makeApiClient()
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.NETWORK_ERROR,
			message: expect.stringContaining('/chat/completions'),
		})
	})

	it('propagates an AbortError from fetch unchanged', async () => {
		const { client, fetchMock } = makeApiClient()
		const error = abortError()
		fetchMock.mockRejectedValueOnce(error)

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toBe(error)
	})

	it('does not call fetch when the signal is already aborted', async () => {
		const { client, fetchMock } = makeApiClient()
		const controller = new AbortController()
		controller.abort()

		await expect(client.invoke([], { greet: makeTool() }, controller.signal)).rejects.toMatchObject(
			{
				name: 'AbortError',
			}
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
