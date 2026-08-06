import { describe, expect, it, vi } from 'vitest'
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

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder()
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
				controller.close()
			},
		}),
		{ headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } }
	)
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

	it('uses prompt_variables transport for the fixed system prompt and raw user payload', async () => {
		const { client, fetchMock } = makeClient({ tlPromptTransport: 'prompt_variables' })
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'world' } }))
		)

		await client.invoke(
			[
				{ role: 'system', content: 'Fixed system instructions' },
				{
					role: 'user',
					content: '<user_request>Say hello</user_request>\n<browser_state>...</browser_state>',
				},
			],
			tools,
			signal
		)

		const initBody = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
		expect(initBody.data).not.toHaveProperty('response_format')
		expect(initBody.data.prompt_variables).toEqual([
			{ name: 'system_prompt', value: 'Fixed system instructions' },
		])
		const chatBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string)
		expect(chatBody.data.txt).toBe(
			'<user_request>Say hello</user_request>\n<browser_state>...</browser_state>'
		)
	})

	it('joins multiple system messages with a blank line and accepts a custom variable name', async () => {
		const { client, fetchMock } = makeClient({
			tlPromptTransport: 'prompt_variables',
			tlSystemPromptVariableName: 'fixed_instructions',
		})
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'world' } }))
		)

		await client.invoke(
			[
				{ role: 'system', content: 'First' },
				{ role: 'system', content: 'Second' },
				{ role: 'user', content: 'dynamic request' },
			],
			tools,
			signal
		)

		const initBody = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
		expect(initBody.data.prompt_variables).toEqual([
			{ name: 'fixed_instructions', value: 'First\n\nSecond' },
		])
		expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string).data.txt).toBe('dynamic request')
	})

	it('rejects invalid prompt_variables configuration and dynamic message shapes', async () => {
		expect(() =>
			makeClient({ tlPromptTransport: 'prompt_variables', toolCallingMode: 'api' })
		).toThrow('requires toolCallingMode="system_prompt"')
		expect(() => makeClient({ tlPromptTransport: 'unsupported' as never })).toThrow(
			'must be "legacy_txt" or "prompt_variables"'
		)
		expect(() =>
			makeClient({ tlPromptTransport: 'prompt_variables', tlSystemPromptVariableName: '  ' })
		).toThrow('must not be empty')
		expect(() =>
			makeClient({
				tlPromptTransport: 'prompt_variables',
				tlSystemPromptVariableName: ' system_prompt ',
			})
		).toThrow('leading or trailing whitespace')
		expect(() =>
			makeClient({ tlPromptTransport: 'prompt_variables', tlSystemPromptVariableName: 'name' })
		).toThrow('reserved')

		const { client, fetchMock } = makeClient({ tlPromptTransport: 'prompt_variables' })
		await expect(
			client.invoke(
				[
					{ role: 'system', content: 'fixed' },
					{ role: 'user', content: 'first' },
					{ role: 'user', content: 'second' },
				],
				tools,
				signal
			)
		).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.CONFIG_ERROR,
			message: expect.stringContaining('exactly one user message'),
		})
		await expect(
			client.invoke(
				[
					{ role: 'system', content: '   ' },
					{ role: 'user', content: 'request' },
				],
				tools,
				signal
			)
		).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.CONFIG_ERROR,
			message: expect.stringContaining('non-empty system prompt'),
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

// ---------- Wire logging ----------

describe('TlAiClient — wire logging', () => {
	it('logs client send and receive packets with titles distinct from TlProxy', async () => {
		const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined)
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock, 'logged-session')
		const rawChatResponse = JSON.stringify({
			tool_name: 'greet',
			parameters: { name: 'logged' },
		})
		fetchMock.mockResolvedValueOnce(chatResponse(rawChatResponse))

		try {
			await client.invoke(
				[{ role: 'user', content: 'show the wire packets' }],
				{ greet: makeTool() },
				signal
			)

			expect(infoSpy).toHaveBeenCalledTimes(4)
			expect(infoSpy).toHaveBeenNthCalledWith(
				1,
				'[TlClient] 📤 INIT_SESSION request:',
				expect.objectContaining({
					url: 'http://localhost:8089/chatbbc/init_session',
					method: 'POST',
					body: expect.objectContaining({ requestId: expect.any(String) }),
				})
			)
			expect(infoSpy).toHaveBeenNthCalledWith(
				2,
				'[TlClient] 📥 INIT_SESSION response:',
				expect.objectContaining({
					status: 200,
					body: initSessionBody('logged-session'),
				})
			)
			expect(infoSpy).toHaveBeenNthCalledWith(
				3,
				'[TlClient] 📤 CHAT request:',
				expect.objectContaining({
					url: 'http://localhost:8089/chatbbc/chat',
					body: expect.objectContaining({
						data: expect.objectContaining({
							session_id: 'logged-session',
							txt: 'user: show the wire packets',
							stream: true,
						}),
					}),
				})
			)
			expect(infoSpy).toHaveBeenNthCalledWith(
				4,
				'[TlClient] 📥 CHAT response:',
				expect.objectContaining({ status: 200, body: rawChatResponse })
			)
			for (const [title] of infoSpy.mock.calls) {
				expect(title).not.toContain('[TlProxy]')
			}
		} finally {
			infoSpy.mockRestore()
		}
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
		expect(body.data).not.toHaveProperty('response_format')
		expect(body.timestamp).toEqual(expect.any(Number))
		expect(body.timestamp).toBeGreaterThan(1)
		expect(body.requestId).toEqual(expect.any(String))
		expect(body.requestId.length).toBeGreaterThan(0)
		expect(request.signal).toBe(signal)
	})

	it('does not send the legacy model variable through prompt_variables initSession', async () => {
		const { client, fetchMock } = makeClient({ tlPromptTransport: 'prompt_variables' })
		fetchMock.mockResolvedValueOnce(jsonResponse(initSessionBody('prompt-session')))

		await expect(client.initSession(signal)).resolves.toBe('prompt-session')

		const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
		expect(body.data.prompt_variables).toEqual([])
		expect(body.data.prompt_variables).not.toContainEqual({
			name: 'name',
			value: 'qwen3.5-plus',
		})
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
	it('parses Tl SSE chunk events and concatenates their content', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			sseResponse([
				'id: 123\nevent: chunk\ndata: {"content":"{\\"tool_name\\":\\"greet\\","}\n\n',
				'id: 124\nevent: chunk\ndata: {"content":"\\"parameters\\":{\\"name\\":\\"SSE\\"}}"}\n\n',
				'event: done\ndata: {"finished":true}\n\n',
			])
		)

		const result = await client.invoke([], { greet: tool }, signal)

		expect(fetchMock.mock.calls[1][1]?.headers).toEqual({
			'Content-Type': 'application/json',
			Accept: 'text/event-stream',
		})
		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'SSE' } })
		expect(result.toolResult).toBe('hello SSE')
		expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('event: chunk'))
		expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('data: {"finished":true}'))
		debugSpy.mockRestore()
	})

	it('parses SSE correctly when lines and UTF-8 characters cross network chunks', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		setupSession(fetchMock)
		const frame =
			'event: chunk\r\ndata: ' +
			JSON.stringify({
				content: JSON.stringify({ tool_name: 'greet', parameters: { name: '你好' } }),
			}) +
			'\r\n\r\n'
		const bytes = new TextEncoder().encode(frame)
		const splitAt = frame.indexOf('你') + 1
		fetchMock.mockResolvedValueOnce(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(bytes.slice(0, splitAt))
						controller.enqueue(bytes.slice(splitAt))
						controller.close()
					},
				}),
				{ headers: { 'Content-Type': 'text/event-stream' } }
			)
		)

		const result = await client.invoke([], { greet: tool }, signal)
		expect(result.toolCall.args).toEqual({ name: '你好' })
	})

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
	it('passes the complete payload.content accumulation from SSE chunks to normalizeResponse', async () => {
		const { client, fetchMock } = makeClient()
		const tool = makeTool()
		setupSession(fetchMock)
		const rawContent = JSON.stringify({
			evaluation_previous_goal: 'ok',
			action: { greet: { name: '流式' } },
		})
		const splitAt = rawContent.indexOf('流') + 1
		fetchMock.mockResolvedValueOnce(
			sseResponse([
				`event: chunk\ndata: ${JSON.stringify({ content: rawContent.slice(0, splitAt) })}\n\n`,
				`event: chunk\ndata: ${JSON.stringify({ content: rawContent.slice(splitAt) })}\n\n`,
				'event: done\ndata: {"finished":true}\n\n',
			])
		)

		const normalizeResponse = vi.fn<Parameters<Required<InvokeOptions>['normalizeResponse']>>(
			() => ({
				choices: [
					{
						message: {
							tool_calls: [
								{
									function: {
										name: 'greet',
										arguments: JSON.stringify({ name: '流式' }),
									},
								},
							],
						},
					},
				],
			})
		)

		const result = await client.invoke([], { greet: tool }, signal, { normalizeResponse })

		expect(normalizeResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				choices: [
					expect.objectContaining({
						message: expect.objectContaining({ content: rawContent }),
					}),
				],
			})
		)
		expect(result.toolCall.args).toEqual({ name: '流式' })
	})

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
		const { client, fetchMock } = makeClient({ toolCallingMode: 'api' })
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
		const { client, fetchMock } = makeClient({ toolCallingMode: 'api' })
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
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

// ---------- JSON correction ----------

describe('TlAiClient.invoke — JSON correction', () => {
	it('retries one invalid response with a structured correction payload in prompt_variables mode', async () => {
		const { client, fetchMock } = makeClient({ tlPromptTransport: 'prompt_variables' })
		const tool = makeTool()
		const messages = [
			{ role: 'system' as const, content: 'Stable system prompt' },
			{ role: 'user' as const, content: 'Find the item named "quoted item"' },
		]
		const invalidContent =
			'{"memory":"Find the "quoted item" next.","action":{"greet":{"name":"broken"}}}'
		setupSession(fetchMock, 'first-session')
		fetchMock.mockResolvedValueOnce(chatResponse(invalidContent))
		setupSession(fetchMock, 'correction-session')
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ action: { greet: { name: 'corrected' } } }))
		)
		const normalizeResponse = (response: any) => {
			const content = response.choices[0].message.content as string
			let parsed: { action: { greet: { name: string } } }
			try {
				parsed = JSON.parse(content)
			} catch (error) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_RESPONSE,
					'Extracted AgentOutput object is not valid JSON',
					error,
					content
				)
			}
			return {
				choices: [
					{
						message: {
							tool_calls: [
								{
									function: {
										name: 'greet',
										arguments: JSON.stringify(parsed.action.greet),
									},
								},
							],
						},
					},
				],
			}
		}

		const result = await client.invoke(messages, { greet: tool }, signal, { normalizeResponse })

		expect(result.toolCall).toEqual({ name: 'greet', args: { name: 'corrected' } })
		expect(fetchMock).toHaveBeenCalledTimes(4)
		const firstInit = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
		const secondInit = JSON.parse(fetchMock.mock.calls[2][1]!.body as string)
		expect(firstInit.data).not.toHaveProperty('response_format')
		expect(secondInit.data).not.toHaveProperty('response_format')
		expect(firstInit.data.prompt_variables).toEqual([
			{ name: 'system_prompt', value: 'Stable system prompt' },
		])
		expect(secondInit.data.prompt_variables).toEqual(firstInit.data.prompt_variables)
		expect(secondInit.data.prompt_variables).not.toContainEqual({
			name: 'name',
			value: 'qwen3.5-plus',
		})

		const correctionChat = JSON.parse(fetchMock.mock.calls[3][1]!.body as string).data.txt as string
		expect(correctionChat).not.toContain('system:')
		expect(correctionChat).not.toContain('user:')
		expect(correctionChat).toContain('untrusted failed output')
		expect(correctionChat).toContain('Do not include markdown, XML, or reasoning')
		const correction = JSON.parse(correctionChat)
		expect(correction.instruction).toContain('JSON escape sequence \\"...\\"')
		expect(correction.original_user_payload).toBe(messages[1].content)
		expect(correction.failed_assistant_content).toBe(invalidContent)
		expect(correction.parse_error.type).toBe(InvokeErrorTypes.INVALID_RESPONSE)
		expect(correction.parse_error.message).toBe('Extracted AgentOutput object is not valid JSON')
		expect(correction.parse_error.cause).toMatchObject({
			name: 'SyntaxError',
			message: expect.any(String),
		})
	})

	it('keeps a valid response at the normal init/chat boundary', async () => {
		const { client, fetchMock } = makeClient({ tlPromptTransport: 'prompt_variables' })
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'valid' } }))
		)

		await client.invoke(
			[
				{ role: 'system', content: 'Stable system prompt' },
				{ role: 'user', content: 'Do the task' },
			],
			{ greet: makeTool() },
			signal
		)

		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('fails strictly after one correction response also fails and records both parse failures', async () => {
		const failureLogger = vi.fn()
		const { client, fetchMock } = makeClient({
			tlPromptTransport: 'prompt_variables',
			failureLogger,
		})
		const invalidContent = '{"still":"invalid"}'
		setupSession(fetchMock, 'first-session')
		fetchMock.mockResolvedValueOnce(chatResponse(invalidContent))
		setupSession(fetchMock, 'second-session')
		fetchMock.mockResolvedValueOnce(chatResponse('{"still":"invalid again"}'))

		await expect(
			client.invoke(
				[
					{ role: 'system', content: 'Stable system prompt' },
					{ role: 'user', content: 'Do the task' },
				],
				{ greet: makeTool() },
				signal
			)
		).rejects.toMatchObject({ type: InvokeErrorTypes.INVALID_RESPONSE })
		expect(fetchMock).toHaveBeenCalledTimes(4)
		expect(failureLogger).toHaveBeenCalledTimes(2)
		expect(failureLogger.mock.calls[0][0]).toMatchObject({
			stage: 'response_parse',
			response: { accumulatedContent: invalidContent },
		})
		expect(failureLogger.mock.calls[1][0]).toMatchObject({
			stage: 'response_parse',
			response: { accumulatedContent: '{"still":"invalid again"}' },
		})
	})

	it('supports legacy_txt correction while preserving the original system prompt', async () => {
		const { client, fetchMock } = makeClient()
		setupSession(fetchMock, 'first-session')
		fetchMock.mockResolvedValueOnce(chatResponse('{"broken":true}'))
		setupSession(fetchMock, 'second-session')
		fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'legacy' } }))
		)

		await client.invoke(
			[
				{ role: 'system', content: 'Legacy system prompt' },
				{ role: 'user', content: 'Legacy task' },
			],
			{ greet: makeTool() },
			signal
		)

		expect(fetchMock).toHaveBeenCalledTimes(4)
		const firstInit = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
		const secondInit = JSON.parse(fetchMock.mock.calls[2][1]!.body as string)
		expect(firstInit.data.prompt_variables).toEqual([{ name: 'name', value: 'qwen3.5-plus' }])
		expect(secondInit.data.prompt_variables).toEqual(firstInit.data.prompt_variables)
		const correctionChat = JSON.parse(fetchMock.mock.calls[3][1]!.body as string).data.txt as string
		expect(correctionChat).toMatch(/^system: Legacy system prompt\nuser: \{"instruction"/)
		expect(correctionChat).toContain('Legacy task')
	})

	it('does not correct native api mode responses', async () => {
		const { client, fetchMock } = makeClient({ toolCallingMode: 'api' })
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(chatResponse('{"not":"a tool call"}'))

		await expect(
			client.invoke([{ role: 'user', content: 'Do the task' }], { greet: makeTool() }, signal)
		).rejects.toMatchObject({ type: InvokeErrorTypes.INVALID_RESPONSE })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('does not correct invalid tool arguments or tool execution failures', async () => {
		const invalidArgs = makeClient()
		setupSession(invalidArgs.fetchMock)
		invalidArgs.fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 123 } }))
		)
		await expect(
			invalidArgs.client.invoke([], { greet: makeTool() }, signal)
		).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_TOOL_ARGS,
		})
		expect(invalidArgs.fetchMock).toHaveBeenCalledTimes(2)

		const executionFailure = makeTool()
		executionFailure.execute = vi.fn(async () => {
			throw new Error('execution failed')
		})
		const execution = makeClient()
		setupSession(execution.fetchMock)
		execution.fetchMock.mockResolvedValueOnce(
			chatResponse(JSON.stringify({ tool_name: 'greet', parameters: { name: 'x' } }))
		)
		await expect(
			execution.client.invoke([], { greet: executionFailure }, signal)
		).rejects.toMatchObject({
			type: InvokeErrorTypes.TOOL_EXECUTION_ERROR,
		})
		expect(execution.fetchMock).toHaveBeenCalledTimes(2)
	})
})

// ---------- Error handling ----------

describe('TlAiClient.invoke — errors', () => {
	it('logs the raw non-SSE response when tool-call parsing fails', async () => {
		const failureLogger = vi.fn()
		const { client, fetchMock } = makeClient({ failureLogger, toolCallingMode: 'api' })
		setupSession(fetchMock, 'failed-session')
		fetchMock.mockResolvedValueOnce(textStreamResponse('not valid tool JSON'))

		await expect(
			client.invoke(
				[{ role: 'user', content: 'request text must not be copied into the failure log' }],
				{ greet: makeTool() },
				signal
			)
		).rejects.toMatchObject({ type: InvokeErrorTypes.INVALID_RESPONSE })

		expect(failureLogger).toHaveBeenCalledTimes(1)
		const entry = failureLogger.mock.calls[0][0]
		expect(entry).toMatchObject({
			stage: 'response_parse',
			endpoint: 'http://localhost:8089/chatbbc/chat',
			sessionId: 'failed-session',
			requestId: expect.any(String),
			response: {
				status: 200,
				contentType: 'text/plain',
				rawBody: 'not valid tool JSON',
				accumulatedContent: 'not valid tool JSON',
			},
			error: {
				name: 'InvokeError',
				type: InvokeErrorTypes.INVALID_RESPONSE,
				retryable: true,
			},
		})
		expect(JSON.stringify(entry)).not.toContain('request text must not be copied')
	})

	it('logs both the raw SSE body and accumulated model content from normalize failures', async () => {
		const failureLogger = vi.fn()
		const { client, fetchMock } = makeClient({ failureLogger, toolCallingMode: 'api' })
		setupSession(fetchMock)
		const accumulatedContent =
			'{"memory":"Search for "widgets" next.","action":{"greet":{"name":"x"}}}'
		const rawBody =
			`event: chunk\ndata: ${JSON.stringify({ content: accumulatedContent })}\n\n` +
			'event: done\ndata: {"finished":true}\n\n'
		fetchMock.mockResolvedValueOnce(sseResponse([rawBody]))
		const syntaxError = new SyntaxError('Unexpected token at position 22')

		await expect(
			client.invoke([], { greet: makeTool() }, signal, {
				normalizeResponse: () => {
					throw new InvokeError(
						InvokeErrorTypes.INVALID_RESPONSE,
						'Extracted AgentOutput object is not valid JSON',
						syntaxError,
						accumulatedContent
					)
				},
			})
		).rejects.toMatchObject({ type: InvokeErrorTypes.INVALID_RESPONSE })

		expect(failureLogger).toHaveBeenCalledTimes(1)
		expect(failureLogger.mock.calls[0][0]).toMatchObject({
			stage: 'response_parse',
			response: {
				rawBody,
				accumulatedContent,
			},
			error: {
				message: 'Extracted AgentOutput object is not valid JSON',
				rawError: {
					name: 'SyntaxError',
					message: 'Unexpected token at position 22',
				},
				rawResponse: accumulatedContent,
			},
		})
	})

	it('logs parsed tool details when argument validation fails', async () => {
		const failureLogger = vi.fn()
		const { client, fetchMock } = makeClient({ failureLogger })
		setupSession(fetchMock)
		const rawContent = JSON.stringify({ tool_name: 'greet', parameters: { name: 123 } })
		fetchMock.mockResolvedValueOnce(chatResponse(rawContent))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_TOOL_ARGS,
		})

		expect(failureLogger).toHaveBeenCalledWith(
			expect.objectContaining({
				stage: 'tool_args_validation',
				response: expect.objectContaining({
					rawBody: rawContent,
					accumulatedContent: rawContent,
				}),
				toolCall: { name: 'greet', args: { name: 123 } },
			})
		)
	})

	it('does not let an async failure logger error replace the original invocation error', async () => {
		const { client, fetchMock } = makeClient({
			toolCallingMode: 'api',
			failureLogger: async () => {
				throw new Error('disk full')
			},
		})
		const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(textStreamResponse('not json'))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
		expect(consoleSpy).toHaveBeenCalledWith(
			'[TlAiClient] Failure logger threw while recording a tool error',
			expect.objectContaining({ message: 'disk full' })
		)
		consoleSpy.mockRestore()
	})

	it('throws INVALID_RESPONSE when response content is not valid JSON', async () => {
		const { client, fetchMock } = makeClient({ toolCallingMode: 'api' })
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(textStreamResponse('not json'))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('throws INVALID_RESPONSE when JSON has no recognizable tool call', async () => {
		const { client, fetchMock } = makeClient({ toolCallingMode: 'api' })
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(chatResponse(JSON.stringify({ hello: 'world' })))

		await expect(client.invoke([], { greet: makeTool() }, signal)).rejects.toMatchObject({
			name: 'InvokeError',
			type: InvokeErrorTypes.INVALID_RESPONSE,
		})
	})

	it('throws INVALID_RESPONSE when a direct response contains multiple actions', async () => {
		const { client, fetchMock } = makeClient({ toolCallingMode: 'api' })
		setupSession(fetchMock)
		fetchMock.mockResolvedValueOnce(
			chatResponse(
				JSON.stringify({
					action: {
						greet: { name: 'first' },
						other: { name: 'second' },
					},
				})
			)
		)

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
