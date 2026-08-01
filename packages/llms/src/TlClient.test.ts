import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'

import { InvokeError, InvokeErrorTypes } from './errors'
import { TlAiClient } from './TlClient'

import type { InvokeOptions, Tool } from './types'

// ---------- Fixtures ----------

function makeClient(overrides: Partial<ConstructorParameters<typeof TlAiClient>[0]> = {}) {
	const fetchMock = vi.fn<Parameters<typeof fetch>, ReturnType<typeof fetch>>()
	const client = new TlAiClient({
		endpointAgent: 'localhost:8089',
		model: 'qwen3.5-plus',
		appId: 'test-app',
		trCode: 'test-code',
		trVersion: '1.0',
		customFetch: fetchMock,
		...overrides,
	})
	return { client, fetchMock }
}

function makeTool(): Tool<{ name: string }, string> {
	return {
		description: 'greet',
		inputSchema: z.object({ name: z.string() }),
		execute: vi.fn(async (args) => `hello ${args.name}`),
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

function textStreamResponse(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { 'Content-Type': 'text/plain' },
	})
}

function initSessionBody(sessionId: string) {
	return {
		code: 0,
		message: 'success',
		data: { session_id: sessionId },
	}
}

function chatResponse(content: string) {
	return textStreamResponse(content)
}

function setupSession(fetchMock: ReturnType<typeof vi.fn>, sessionId = 'session_123') {
	fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody(sessionId)))
}

function getLastSentBody(fetchMock: ReturnType<typeof vi.fn>): {
	data: { session_id: string }
} {
	const calls = fetchMock.mock.calls
	const init = calls[calls.length - 1][1] as RequestInit
	return JSON.parse(init.body as string)
}

const signal = new AbortController().signal

// ---------- Request construction ----------

describe('TlAiClient.invoke — request construction', () => {
	const tools = { greet: makeTool() }

	it('defaults to system_prompt tool calling mode', () => {
		const { client } = makeClient()

		expect(client.config.toolCallingMode).toBe('system_prompt')
	})

	it('calls init_session before chat and uses its session_id', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'world' } }))
		)

		await client.invoke([], tools, signal)

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8089/chatbbc/init_session')
		expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8089/chatbbc/chat')
		expect(getLastSentBody(fetchMock).data.session_id).toBe('session_123')
	})

	it('initializes a fresh session before every chat', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock, 'session_1')
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'world' } }))
		)
		await client.invoke([], tools, signal)

		setupSession(fetchMock, 'session_2')
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'again' } }))
		)
		await client.invoke([], tools, signal)

		expect(fetchMock).toHaveBeenCalledTimes(4)
		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8089/chatbbc/init_session')
		expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:8089/chatbbc/chat')
		expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:8089/chatbbc/init_session')
		expect(fetchMock.mock.calls[3][0]).toBe('http://localhost:8089/chatbbc/chat')
		expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).data.session_id).toBe('session_1')
		expect(JSON.parse(fetchMock.mock.calls[3][1]!.body as string).data.session_id).toBe('session_2')
	})
})

// ---------- Session initialization ----------

describe('TlAiClient.initSession', () => {
	it('rejects endpoint protocols other than HTTP(S)', () => {
		expect(() => makeClient({ endpointAgent: 'ftp://api.example.com' })).toThrow(
			'Unsupported Tl endpointAgent protocol "ftp:"'
		)
	})

	it('accepts a full HTTPS endpoint and sends valid request metadata', async () => {
		const { client, fetchMock } = makeClient({ endpointAgent: 'https://api.example.com/' })
		fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody('secure-session')))

		await expect(client.initSession(signal)).resolves.toBe('secure-session')

		expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/chatbbc/init_session')
		const request = fetchMock.mock.calls[0][1]!
		const body = JSON.parse(request.body as string)
		expect(body.timestamp).toEqual(expect.any(Number))
		expect(body.timestamp).toBeGreaterThan(1)
		expect(body.requestId).toEqual(expect.any(String))
		expect(body.requestId.length).toBeGreaterThan(0)
		expect(request.signal).toBe(signal)
	})

	it('includes the endpoint and underlying cause when the request fails', async () => {
		const { client, fetchMock } = makeClient()
		const failure = new TypeError('fetch failed') as TypeError & { cause?: unknown }
		failure.cause = new Error('connect ECONNREFUSED 127.0.0.1:8089')
		fetchMock.mockRejectedValueOnce(failure)

		await expect(client.initSession()).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.NETWORK_ERROR,
			message: expect.stringMatching(
				/http:\/\/localhost:8089\/chatbbc\/init_session.*ECONNREFUSED/
			),
			rawError: failure,
		})
	})

	it('maps an HTTP authentication failure and preserves the response', async () => {
		const { client, fetchMock } = makeClient()
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'invalid credentials' }, 403))

		await expect(client.initSession()).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.AUTH_ERROR,
			statusCode: 403,
			message: 'Session initialization failed with HTTP 403: invalid credentials',
			rawResponse: { message: 'invalid credentials' },
		})
	})

	it('surfaces a successful HTTP response that the service rejects', async () => {
		const { client, fetchMock } = makeClient()
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ code: 1001, message: 'model configuration not found' })
		)

		await expect(client.initSession()).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
			message: 'Session initialization was rejected: model configuration not found',
			rawResponse: { code: 1001, message: 'model configuration not found' },
		})
	})
})

// ---------- Success path ----------

describe('TlAiClient.invoke — success', () => {
	it('extracts legacy { tool_name, parameters } shape and executes the tool', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'Alice' } }))
		)

		const result = await client.invoke([], { greet: tool }, signal)

		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'Alice' } })
		expect(result.toolResult).toBe('hello Alice')
		expect(tool.execute).toHaveBeenCalledWith({ name: 'Alice' })
	})

	it('extracts OpenAI { name, arguments } shape and executes the tool', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ name: 'greet', arguments: { name: 'Bob' } }))
		)

		const result = await client.invoke([], { greet: tool }, signal)

		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'Bob' } })
		expect(result.toolResult).toBe('hello Bob')
	})

	it('extracts MacroTool { action: { <tool>: ... } } shape and executes the tool', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(
				JSON.stringify({
					evaluation_previous_goal: 'ok',
					action: { greet: { name: 'Carol' } },
				})
			)
		)

		const result = await client.invoke([], { greet: tool }, signal)

		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'Carol' } })
		expect(result.toolResult).toBe('hello Carol')
	})
})

// ---------- normalizeResponse ----------

describe('TlAiClient.invoke — normalizeResponse', () => {
	it('calls normalizeResponse with raw content as message.content and uses the normalized tool call', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		setupSession(fetchMock)
		const rawContent = JSON.stringify({ tool_name: 'greet', parameters: { name: 'raw' } })
		fetchMock.mockResolvedValueOnce(chatResponse(rawContent))

		const normalizeResponse = vi.fn<Parameters<Required<InvokeOptions>['normalizeResponse']>>(
			() => ({
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant',
							tool_calls: [
								{
									type: 'function',
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

		const result = await client.invoke([], { greet: tool }, signal, { normalizeResponse })

		expect(normalizeResponse).toHaveBeenCalledTimes(1)
		expect(normalizeResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [
					expect.objectContaining({
						index: 0,
						message: expect.objectContaining({
							role: 'assistant',
							content: rawContent,
						}),
					}),
				],
			})
		)
		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'normalized' } })
		expect(result.toolResult).toBe('hello normalized')
	})

	it('uses the tool name returned by normalizeResponse', async () => {
		const { client, fetchMock } = makeClient()
		const greetTool = makeTool()
		const otherTool = makeTool()
		setupSession(fetchMock)
		const rawContent = JSON.stringify({ tool_name: 'greet', parameters: { name: 'original' } })
		fetchMock.mockResolvedValueOnce(chatResponse(rawContent))

		const normalizeResponse = vi.fn<Parameters<Required<InvokeOptions>['normalizeResponse']>>(
			() => ({
				choices: [
					{
						index: 0,
						message: {
							role: 'assistant',
							tool_calls: [
								{
									type: 'function',
									function: {
										name: 'other',
										arguments: JSON.stringify({ name: 'switched' }),
									},
								},
							],
						},
					},
				],
			})
		)

		const result = await client.invoke([], { greet: greetTool, other: otherTool }, signal, {
			normalizeResponse,
		})

		expect(result.toolCall).toEqual({ name: 'other', args: { name: 'switched' } })
		expect(otherTool.execute).toHaveBeenCalledWith({ name: 'switched' })
		expect(greetTool.execute).not.toHaveBeenCalled()
	})

	it('throws INVALID_RESPONSE when normalizeResponse returns an invalid payload', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'x' } }))
		)

		await expect(
			client.invoke([], { greet: makeTool() }, signal, {
				normalizeResponse: () => ({ choices: [{ message: {} }] }),
			})
		).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('throws INVALID_RESPONSE when normalizeResponse throws a non-InvokeError', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'x' } }))
		)

		await expect(
			client.invoke([], { greet: makeTool() }, signal, {
				normalizeResponse: () => {
					throw new Error('boom')
				},
			})
		).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('lets AbortError thrown by normalizeResponse propagate unchanged', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'x' } }))
		)

		const abortErr = new Error('aborted')
		abortErr.name = 'AbortError'

		await expect(
			client.invoke([], { greet: makeTool() }, signal, {
				normalizeResponse: () => {
					throw abortErr
				},
			})
		).rejects.toBe(abortErr)
	})
})

// ---------- Error handling ----------

describe('TlAiClient.invoke — errors', () => {
	it('throws INVALID_RESPONSE when response content is not valid JSON', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(textStreamResponse('not json'))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('throws INVALID_RESPONSE when JSON has no recognizable tool call', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(chatResponse(JSON.stringify({ hello: 'world' })))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('throws INVALID_TOOL_ARGS when normalized arguments are not valid JSON', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'x' } }))
		)

		await expect(
			client.invoke([], { greet: makeTool() }, signal, {
				normalizeResponse: () => ({
					choices: [
						{
							index: 0,
							message: {
								role: 'assistant',
								tool_calls: [
									{
										type: 'function',
										function: { name: 'greet', arguments: 'not-json' },
									},
								],
							},
						},
					],
				}),
			})
		).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_TOOL_ARGS,
		})
	})

	it('throws INVALID_TOOL_ARGS when tool args fail Zod validation', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 123 } }))
		)

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_TOOL_ARGS,
		})
	})

	it('throws UNKNOWN when model calls a tool that does not exist', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'mystery', parameters: {} }))
		)

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.UNKNOWN,
		})
	})

	it('maps HTTP 401 to AUTH_ERROR', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 401))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.AUTH_ERROR,
		})
	})
})
