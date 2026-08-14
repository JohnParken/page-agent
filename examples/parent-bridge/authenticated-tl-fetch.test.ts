import { describe, expect, it, vi } from 'vitest'

import { createAuthenticatedFetch, readSseStream } from './authenticated-tl-fetch'

type FetchMockArgs = [input: RequestInfo | URL, init?: RequestInit]

describe('createAuthenticatedFetch', () => {
	it('returns a successful JSON response unchanged and adds auth context headers', async () => {
		const response = new Response(JSON.stringify({ ok: true }), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
		const fetchImpl = vi.fn<FetchMockArgs, Promise<Response>>(async () => response)
		const customFetch = createAuthenticatedFetch({
			fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
			token: 'access-token',
			headers: {
				'X-Tenant-Id': 'tenant-a',
				'X-Target-Id': 'tl-gateway',
				'X-Page-Agent-Session': 'session-a',
			},
		})

		const result = await customFetch('https://gateway.example.test/chat', {
			method: 'POST',
			body: JSON.stringify({ prompt: 'hello' }),
		})

		expect(result).toBe(response)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		const request = fetchImpl.mock.calls[0]?.[0]
		expect(request).toBeInstanceOf(Request)
		if (!(request instanceof Request)) throw new Error('fetch request was not captured')
		expect(request.headers.get('authorization')).toBe('Bearer access-token')
		expect(request.headers.get('x-tenant-id')).toBe('tenant-a')
		expect(request.headers.get('x-target-id')).toBe('tl-gateway')
		expect(request.headers.get('x-page-agent-session')).toBe('session-a')
		expect(await result.json()).toEqual({ ok: true })
	})

	it('refreshes a token proactively inside the configured expiry window', async () => {
		const response = new Response(JSON.stringify({ ok: true }), { status: 200 })
		const fetchImpl = vi.fn<FetchMockArgs, Promise<Response>>(async () => response)
		const refreshToken = vi.fn(async ({ reason }: { reason: 'proactive' | 'unauthorized' }) => {
			expect(reason).toBe('proactive')
			return { value: 'fresh-token', expiresAt: Date.now() + 120_000 }
		})
		const customFetch = createAuthenticatedFetch({
			fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
			token: { value: 'near-expiry', expiresAt: Date.now() + 1_000 },
			refreshToken,
			refreshSkewMs: 30_000,
		})

		await customFetch('https://gateway.example.test/chat')

		expect(refreshToken).toHaveBeenCalledTimes(1)
		expect(fetchImpl).toHaveBeenCalledTimes(1)
		expect((fetchImpl.mock.calls[0]?.[0] as Request).headers.get('authorization')).toBe(
			'Bearer fresh-token'
		)
	})

	it('leaves an SSE response body as a streaming response', async () => {
		const response = new Response('data: {"delta":"hello"}\n\n', {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		})
		const customFetch = createAuthenticatedFetch({
			fetchImpl: (async () => response) as typeof globalThis.fetch,
		})

		const result = await customFetch('https://gateway.example.test/chat')
		expect(result).toBe(response)
		expect(readSseStream(result)).toBe(result.body)
		expect(await new Response(readSseStream(result)).text()).toContain('delta')
	})

	it('refreshes once after a 401 and retries with the new bearer token', async () => {
		const firstResponse = new Response('expired', { status: 401 })
		const secondResponse = new Response(JSON.stringify({ ok: true }), { status: 200 })
		const fetchImpl = vi
			.fn<FetchMockArgs, Promise<Response>>()
			.mockResolvedValueOnce(firstResponse)
			.mockResolvedValueOnce(secondResponse)
		const refreshToken = vi.fn(async () => 'refreshed-token')
		const customFetch = createAuthenticatedFetch({
			fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
			token: 'expired-token',
			refreshToken,
		})

		const result = await customFetch('https://gateway.example.test/chat', {
			method: 'POST',
			body: JSON.stringify({ prompt: 'retry me' }),
		})

		expect(result).toBe(secondResponse)
		expect(refreshToken).toHaveBeenCalledTimes(1)
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		expect(fetchImpl.mock.calls[0]?.[0]).toBeInstanceOf(Request)
		expect(fetchImpl.mock.calls[1]?.[0]).toBeInstanceOf(Request)
		expect((fetchImpl.mock.calls[0]?.[0] as Request).headers.get('authorization')).toBe(
			'Bearer expired-token'
		)
		expect((fetchImpl.mock.calls[1]?.[0] as Request).headers.get('authorization')).toBe(
			'Bearer refreshed-token'
		)
	})

	it('fails before dispatch when the caller signal is already aborted', async () => {
		const controller = new AbortController()
		controller.abort()
		const fetchImpl = vi.fn<FetchMockArgs, Promise<Response>>(
			async () => new Response('should not dispatch')
		)
		const customFetch = createAuthenticatedFetch({
			fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
		})

		await expect(
			customFetch('https://gateway.example.test/chat', { signal: controller.signal })
		).rejects.toMatchObject({ name: 'AbortError' })
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('propagates a live AbortSignal to the underlying Request', async () => {
		const controller = new AbortController()
		const fetchImpl = vi.fn<FetchMockArgs, Promise<Response>>(async () => new Response('ok'))
		const customFetch = createAuthenticatedFetch({
			fetchImpl: fetchImpl as unknown as typeof globalThis.fetch,
		})

		await customFetch('https://gateway.example.test/chat', { signal: controller.signal })
		const request = fetchImpl.mock.calls[0]?.[0]
		expect(request).toBeInstanceOf(Request)
		if (!(request instanceof Request)) throw new Error('fetch request was not captured')
		expect(request.signal.aborted).toBe(false)
		controller.abort()
		expect(request.signal.aborted).toBe(true)
	})
})
