/**
 * Framework-agnostic authenticated fetch helper for the parent-bridge
 * examples.
 *
 * This file intentionally lives under `examples/`: it is an integration
 * recipe for an application's gateway, not part of Page Agent's runtime or
 * published API. The helper returns the original `Response` unchanged, so a
 * caller can consume JSON, an SSE stream, or any other response format.
 */

export type MaybePromise<T> = T | Promise<T>

export interface AuthenticatedFetchContext {
	input: RequestInfo | URL
	init?: RequestInit
	signal?: AbortSignal
}

export interface AccessToken {
	value: string
	/** Unix epoch in milliseconds. A token within `refreshSkewMs` is refreshed before fetch. */
	expiresAt?: number
}

export type AccessTokenValue = string | AccessToken

export type AccessTokenProvider = (
	context: AuthenticatedFetchContext
) => MaybePromise<AccessTokenValue | undefined>

export type AdditionalHeadersProvider = (
	context: AuthenticatedFetchContext
) => MaybePromise<HeadersInit | undefined>

export interface RefreshTokenContext extends AuthenticatedFetchContext {
	/** Present for a response-triggered refresh; omitted for proactive refresh. */
	response?: Response
	reason: 'proactive' | 'unauthorized'
}

export type RefreshTokenProvider = (
	context: RefreshTokenContext
) => MaybePromise<AccessTokenValue | undefined>

export interface AuthenticatedFetchOptions {
	/** Fetch implementation injection keeps this helper straightforward to test. */
	fetchImpl?: typeof globalThis.fetch
	/** A fixed access token or a provider that resolves one per request. */
	token?: AccessTokenValue | AccessTokenProvider
	/** Headers applied before per-request headers. */
	headers?: HeadersInit | AdditionalHeadersProvider
	/** Called before fetch when a token is near expiry and after a refreshable response. */
	refreshToken?: RefreshTokenProvider
	/** Refresh window before expiry, in milliseconds (default: 30 seconds). */
	refreshSkewMs?: number
	/** Defaults to a single 401 retry. */
	shouldRefresh?: (response: Response) => boolean
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return
	if (typeof signal.throwIfAborted === 'function') {
		signal.throwIfAborted()
		return
	}
	throw (
		signal.reason ??
		(typeof DOMException === 'function'
			? new DOMException('The operation was aborted.', 'AbortError')
			: Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
	)
}

async function resolveToken(
	token: AccessTokenValue | AccessTokenProvider | undefined,
	context: AuthenticatedFetchContext
): Promise<AccessToken | undefined> {
	const resolved = typeof token === 'function' ? await token(context) : token
	if (resolved === undefined) return undefined
	if (typeof resolved === 'string') {
		if (resolved.trim() === '')
			throw new TypeError('Authenticated fetch token must be a non-empty string')
		return { value: resolved }
	}
	if (
		!resolved ||
		typeof resolved.value !== 'string' ||
		resolved.value.trim() === '' ||
		(resolved.expiresAt !== undefined &&
			(!Number.isFinite(resolved.expiresAt) || resolved.expiresAt <= 0))
	) {
		throw new TypeError('Authenticated fetch token must be a non-empty string')
	}
	return resolved
}

function normalizeRefreshSkew(value: number | undefined): number {
	if (value === undefined) return 30_000
	if (!Number.isFinite(value) || value < 0) {
		throw new TypeError('refreshSkewMs must be finite and non-negative')
	}
	return value
}

async function resolveHeaders(
	headers: HeadersInit | AdditionalHeadersProvider | undefined,
	context: AuthenticatedFetchContext
): Promise<Headers> {
	const resolved = typeof headers === 'function' ? await headers(context) : headers
	return new Headers(resolved)
}

/**
 * Create a `fetch`-compatible function that adds bearer authentication and
 * performs at most one token refresh retry.
 *
 * The first request is cloned before dispatch so a retry can safely replay a
 * JSON/string/FormData body. A caller that supplies a non-cloneable streaming
 * body should disable refresh for that request (or provide an idempotent
 * request factory at the gateway layer).
 */
export function createAuthenticatedFetch(
	options: AuthenticatedFetchOptions = {}
): typeof globalThis.fetch {
	const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
	const shouldRefresh = options.shouldRefresh ?? ((response: Response) => response.status === 401)
	const refreshSkewMs = normalizeRefreshSkew(options.refreshSkewMs)

	const authenticatedFetch = async (
		input: RequestInfo | URL,
		init?: RequestInit
	): Promise<Response> => {
		const context: AuthenticatedFetchContext = { input, init, signal: init?.signal ?? undefined }
		throwIfAborted(context.signal)

		let token = await resolveToken(options.token, context)
		throwIfAborted(context.signal)
		if (
			options.refreshToken &&
			token?.expiresAt !== undefined &&
			token.expiresAt - Date.now() <= refreshSkewMs
		) {
			const proactivelyRefreshed = await options.refreshToken({
				...context,
				reason: 'proactive',
			})
			throwIfAborted(context.signal)
			if (proactivelyRefreshed !== undefined) {
				token = await resolveToken(proactivelyRefreshed, context)
			}
		}
		const headers = await resolveHeaders(options.headers, context)
		// Request-specific headers win over helper defaults, except that a
		// resolved token always controls the bearer value for this helper.
		if (init?.headers) {
			new Headers(init.headers).forEach((value, key) => headers.set(key, value))
		}
		if (token !== undefined) headers.set('Authorization', `Bearer ${token.value}`)

		const request = new Request(input, { ...init, headers })
		// Clone before fetch consumes the body. The clone is only used if the
		// response triggers refresh, and therefore does not alter normal fetch
		// behavior or streaming responses.
		let retryTemplate: Request | undefined
		try {
			retryTemplate = request.clone()
		} catch {
			// The first request remains valid. If refresh is requested later, we
			// return the original response because a one-shot body is not replayable.
			retryTemplate = undefined
		}

		const response = await fetchImpl(request)
		if (!options.refreshToken || !shouldRefresh(response)) return response
		if (!retryTemplate) return response

		throwIfAborted(context.signal)
		const refreshedToken = await options.refreshToken({
			...context,
			response,
			reason: 'unauthorized',
		})
		throwIfAborted(context.signal)
		if (refreshedToken === undefined) return response
		const refreshed = await resolveToken(refreshedToken, context)
		if (!refreshed) return response

		const retryHeaders = new Headers(retryTemplate.headers)
		retryHeaders.set('Authorization', `Bearer ${refreshed.value}`)
		const retryRequest = new Request(retryTemplate, { headers: retryHeaders })
		return await fetchImpl(retryRequest)
	}

	// `authenticatedFetch` has the same two-argument call shape as the
	// platform fetch function; this cast preserves the overloaded browser type
	// for use as TlAiClient's `customFetch` option.
	return authenticatedFetch as typeof globalThis.fetch
}

/**
 * Small JSON helper used by the examples. It intentionally leaves status
 * handling to the caller so error bodies remain inspectable.
 */
export async function readJsonResponse<T = unknown>(response: Response): Promise<T> {
	return (await response.json()) as T
}

/**
 * Return an SSE body stream without buffering it. The caller can feed this to
 * a `TextDecoderStream`/line parser and retain normal streaming backpressure.
 */
export function readSseStream(response: Response): ReadableStream<Uint8Array> {
	if (!response.body) throw new Error('SSE response has no readable body')
	return response.body
}
