import { afterEach, describe, expect, it, vi } from 'vitest'
import { TlClient } from './tl-client'

interface FetchCall {
	url: string
	body?: Record<string, unknown>
}

function createClient(): TlClient {
	return new TlClient({
		endpointAgent: 'http://tl.example.test',
		appId: 'test-app',
		trCode: 'test-code',
		trVersion: '1.0',
	})
}

function initResponse(sessionId: string): Response {
	return new Response(JSON.stringify({ code: 0, data: { session_id: sessionId } }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})
}

function sseResponse(text: string, chunkSize = text.length): Response {
	const bytes = new TextEncoder().encode(text)
	let offset = 0
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= bytes.length) {
				controller.close()
				return
			}
			const nextOffset = Math.min(offset + chunkSize, bytes.length)
			controller.enqueue(bytes.slice(offset, nextOffset))
			offset = nextOffset
		},
	})
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

function chunkEvent(content: string, event = 'chunk'): string {
	return `event: ${event}\ndata: ${JSON.stringify({ content })}\n\n`
}

function doneEvent(event = 'done'): string {
	return `event: ${event}\ndata: ${JSON.stringify({ finished: true })}\n\n`
}

function installFetch(responses: Response[]): {
	fetchMock: ReturnType<typeof vi.fn>
	calls: FetchCall[]
} {
	const calls: FetchCall[] = []
	const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			body:
				typeof init?.body === 'string'
					? (JSON.parse(init.body) as Record<string, unknown>)
					: undefined,
		})
		const response = responses.shift()
		if (!response) throw new Error('Unexpected fetch call')
		return response
	})
	vi.stubGlobal('fetch', fetchMock)
	return { fetchMock, calls }
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('TlClient SSE parsing', () => {
	it('keeps event state across reads and reports split error events', async () => {
		const { fetchMock } = installFetch([
			sseResponse(`${chunkEvent('before-error')}event: error\ndata: gateway failure\n\n`, 1),
		])

		await expect(createClient().chatStream('session', 'hello')).rejects.toThrow(
			'SSE error event: gateway failure'
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('dispatches a complete done event before ignoring a later sentinel payload', async () => {
		const { fetchMock } = installFetch([
			sseResponse(
				`${chunkEvent('kept')}event: done\ndata: complete\n\n${chunkEvent('discarded')}`,
				1
			),
		])

		await expect(createClient().chatStream('session', 'hello')).resolves.toBe('kept')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('resets event state after an event-only blank frame', async () => {
		const { fetchMock } = installFetch([
			sseResponse('event: error\n\ndata: {"content":"kept"}\n\ndata: [DONE]\n\n'),
		])

		await expect(createClient().chatStream('session', 'hello')).resolves.toBe('kept')
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	it('joins multiple data lines, handles CRLF, and preserves UTF-8 across byte splits', async () => {
		const response = [
			'event: message\r\n',
			'data: {"content":\r\n',
			'data: "你好"}\r\n',
			'\r\n',
			'data: [DONE]\r\n',
			'\r\n',
		].join('')
		installFetch([sseResponse(response, 1)])

		await expect(createClient().chatStream('session', 'hello')).resolves.toBe('你好')
	})

	it('handles lone CR line endings and leaves an unterminated event undispatched', async () => {
		installFetch([sseResponse('event: message\rdata: {"content":"kept"}\r\rdata: [DONE]\r\r')])
		await expect(createClient().chatStream('session', 'hello')).resolves.toBe('kept')

		installFetch([sseResponse('data: {"content":"ignored"}\n')])
		await expect(createClient().chatStream('session', 'hello')).resolves.toBe('')
	})

	it('fails visibly for malformed complete SSE JSON data', async () => {
		installFetch([sseResponse('event: chunk\ndata: malformed\n\n')])

		await expect(createClient().chatStream('session', 'hello')).rejects.toThrow(
			'Malformed SSE data JSON'
		)
	})

	it('preserves ordinary chunk and message content payloads', async () => {
		installFetch([
			sseResponse(`${chunkEvent('first')}event: message\ndata: {"content":" second"}\n\n`),
		])

		await expect(createClient().chatStream('session', 'hello')).resolves.toBe('first second')
	})
})

describe('TlClient tool parsing and correction', () => {
	it('keeps nullable parseToolCall behavior for invalid JSON shapes and nested arguments', () => {
		const client = createClient()

		expect(client.parseToolCall('null')).toBeNull()
		expect(client.parseToolCall('[]')).toBeNull()
		expect(client.parseToolCall('{"text":"ordinary response"}')).toBeNull()
		expect(client.parseToolCall('{"name":"tool","arguments":"not-json"}')).toBeNull()
		expect(client.parseToolCall('{"action":{"tool":null}}')).toBeNull()
		expect(client.parseToolCall('{"name":"tool","arguments":{"value":1}}')).toEqual({
			name: 'tool',
			args: { value: 1 },
		})
	})

	it('adds the genuine outer JSON diagnostic and reuses the system prompt for correction', async () => {
		const systemPrompt = 'Keep the system contract'
		const userPrompt = 'Do the task'
		const corrected = '{"action":{"sayHello":{"message":"hi"}}}'
		const { calls } = installFetch([
			initResponse('initial-session'),
			sseResponse(`${chunkEvent('not-json')}${doneEvent()}`),
			initResponse('correction-session'),
			sseResponse(`${chunkEvent(corrected)}${doneEvent()}`),
		])

		const result = await createClient().invokeWithTool(systemPrompt, userPrompt)

		expect(result.toolCall).toEqual({ name: 'sayHello', args: { message: 'hi' } })
		expect(calls.filter((call) => call.url.endsWith('/init_session'))).toHaveLength(2)
		expect(calls[0].body?.data).toEqual({
			prompt_variables: [{ name: 'system_prompt', value: systemPrompt }],
		})
		expect(calls[2].body?.data).toEqual({
			prompt_variables: [{ name: 'system_prompt', value: systemPrompt }],
		})

		const correctionPayload = calls[3].body?.data as { txt: string }
		const correctionContext = JSON.parse(correctionPayload.txt) as Record<string, unknown>
		expect(correctionContext.original_user_payload).toBe(userPrompt)
		expect(correctionContext.failed_assistant_content).toBe('not-json')
		expect(correctionPayload).toMatchObject({ session_id: 'correction-session' })

		let actualParseError: unknown
		try {
			JSON.parse('not-json')
		} catch (error) {
			actualParseError = error
		}
		expect(actualParseError).toBeInstanceOf(SyntaxError)
		const parseError = correctionContext.parse_error as {
			type: string
			message: string
			cause: { name: string; message: string }
		}
		expect(parseError.type).toBe('INVALID_RESPONSE')
		expect(parseError.message).toContain('json_parse')
		expect(parseError.cause).toEqual({
			name: (actualParseError as SyntaxError).name,
			message: (actualParseError as SyntaxError).message,
		})
	})

	it.each([
		['empty response', `${doneEvent()}`, 'empty_response'],
		['valid non-tool JSON', `${chunkEvent('{"text":"ordinary"}')}${doneEvent()}`, 'tool_shape'],
		[
			'malformed nested arguments',
			`${chunkEvent('{"name":"tool","arguments":"not-json"}')}${doneEvent()}`,
			'tool_args_parse',
		],
		['SSE error', 'event: error\ndata: upstream failed\n\n', 'SSE error event'],
	])('does not retry for %s', async (_caseName, stream, expectedError) => {
		const { fetchMock } = installFetch([initResponse('session'), sseResponse(stream)])

		await expect(createClient().invokeWithTool('system', 'user')).rejects.toThrow(expectedError)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('stops after one failed correction and exposes its actual stage', async () => {
		const { fetchMock } = installFetch([
			initResponse('initial-session'),
			sseResponse(`${chunkEvent('not-json')}${doneEvent()}`),
			initResponse('correction-session'),
			sseResponse(`${chunkEvent('still-not-json')}${doneEvent()}`),
		])

		await expect(createClient().invokeWithTool('system', 'user')).rejects.toThrow('json_parse')
		expect(fetchMock).toHaveBeenCalledTimes(4)
	})
})
