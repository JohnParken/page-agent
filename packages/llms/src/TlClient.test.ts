import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'

import { TlAiClient } from './TlClient'
import { InvokeError, InvokeErrorTypes } from './errors'
import type { InvokeOptions, Tool } from './types'

// ---------- Fixtures ----------

function makeClient(overrides: Partial<ConstructorParameters<typeof TlAiClient>[0]> = {}) {
	const fetchMock = vi.fn<typeof fetch>()
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

	it('calls init_session first and reuses session_id for chat', async () => {
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

	it('skips init_session when session already initialized', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'world' } }))
		)
		await client.invoke([], tools, signal)

		fetchMock.mockClear()
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'again' } }))
		)
		await client.invoke([], tools, signal)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:8089/chatbbc/chat')
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

		const normalizeResponse = vi.fn<Required<InvokeOptions>['normalizeResponse']>(() => ({
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
		}))

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

		const normalizeResponse = vi.fn<Required<InvokeOptions>['normalizeResponse']>(() => ({
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
		}))

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
