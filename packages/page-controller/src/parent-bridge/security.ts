import type { IndexedBrowserState } from '../PageController'
import type { ParentFrameContext } from './protocol'

/** A subset of the Window surface used by tests and non-global browser hosts. */
export interface ParentBridgeWindowLike {
	readonly parent?: unknown
	readonly document?: Document
	addEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
	removeEventListener?(type: string, listener: EventListenerOrEventListenerObject): void
}

/** Reject wildcard, opaque, credential-bearing, and path-bearing origins. */
export function normalizeParentControllerOrigin(origin: string): string {
	if (
		typeof origin !== 'string' ||
		origin.length === 0 ||
		origin.trim() !== origin ||
		origin === '*' ||
		origin === 'null' ||
		origin.includes('*')
	) {
		throw new TypeError('Origin must be an exact HTTP(S) origin')
	}

	let parsed: URL
	try {
		parsed = new URL(origin)
	} catch {
		throw new TypeError(`Invalid origin: ${origin}`)
	}

	if (
		parsed.origin === 'null' ||
		(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
		parsed.username !== '' ||
		parsed.password !== '' ||
		parsed.pathname !== '/' ||
		parsed.search !== '' ||
		parsed.hash !== ''
	) {
		throw new TypeError(`Origin must be an exact HTTP(S) origin: ${origin}`)
	}
	return parsed.origin
}

/**
 * Generate an identifier with Web Crypto only. A non-cryptographic fallback is
 * intentionally not provided: session and approval identifiers are security
 * boundaries, not display-only IDs.
 */
export function secureParentControllerId(prefix: string): string {
	if (typeof prefix !== 'string' || prefix.length === 0 || prefix.length > 32) {
		throw new TypeError('ID prefix must be a non-empty string no longer than 32 characters')
	}

	const cryptoObject = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto
	if (cryptoObject?.randomUUID) return `${prefix}-${cryptoObject.randomUUID()}`

	if (cryptoObject?.getRandomValues) {
		const bytes = new Uint8Array(16)
		cryptoObject.getRandomValues(bytes)
		const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
		return `${prefix}-${value}`
	}

	throw new Error('Web Crypto is required for Parent Controller Bridge identifiers')
}

function resolveFrameOrigin(iframe: HTMLIFrameElement, ownerDocument: Document): string {
	const source = iframe.getAttribute('src') || iframe.src
	if (!source) return 'null'
	try {
		const parsed = new URL(source, ownerDocument.baseURI || ownerDocument.location.href)
		if (parsed.origin === 'null') return 'null'
		return normalizeParentControllerOrigin(parsed.origin)
	} catch {
		return 'null'
	}
}

function sandboxTokens(iframe: HTMLIFrameElement): string[] {
	const value = iframe.getAttribute('sandbox')
	if (!value) return []
	return value
		.trim()
		.split(/\s+/)
		.filter((token, index, all) => token.length > 0 && all.indexOf(token) === index)
}

/**
 * Read the embedding properties visible to the parent document.
 *
 * Response headers such as CSP `frame-ancestors` are not readable here; this
 * policy intentionally contains only facts available from the iframe element
 * and the parent document. A host may enrich it through the callback option.
 */
export function readParentFrameContext(
	iframe: HTMLIFrameElement,
	ownerDocument: Document = iframe.ownerDocument || document
): ParentFrameContext {
	const parentOrigin = ownerDocument.defaultView?.location.origin || ownerDocument.location.origin
	const sandbox = sandboxTokens(iframe)
	return {
		parentOrigin:
			parentOrigin && parentOrigin !== 'null'
				? normalizeParentControllerOrigin(parentOrigin)
				: 'null',
		assistantOrigin: resolveFrameOrigin(iframe, ownerDocument),
		directChild:
			iframe.ownerDocument === ownerDocument && ownerDocument.documentElement.contains(iframe),
		sandbox,
		allowScripts: sandbox.length === 0 || sandbox.includes('allow-scripts'),
		allowSameOrigin: sandbox.length === 0 || sandbox.includes('allow-same-origin'),
	}
}

export interface EmbedPolicyRequirements {
	parentOrigin?: string
	assistantOrigin?: string
	directChild?: boolean
	requireAllowScripts?: boolean
	requireAllowSameOrigin?: boolean
	requiredSandboxTokens?: readonly string[]
}

/**
 * Verify an embed policy against exact-origin and sandbox requirements.
 * This returns a boolean so callers can fail closed without parsing errors.
 */
export function verifyParentFrameContext(
	policy: ParentFrameContext,
	requirements: EmbedPolicyRequirements = {}
): boolean {
	if (!policy || !policy.directChild) return false
	if (requirements.parentOrigin !== undefined) {
		try {
			if (policy.parentOrigin !== normalizeParentControllerOrigin(requirements.parentOrigin))
				return false
		} catch {
			return false
		}
	}
	if (requirements.assistantOrigin !== undefined) {
		try {
			if (
				policy.assistantOrigin !== normalizeParentControllerOrigin(requirements.assistantOrigin)
			) {
				return false
			}
		} catch {
			return false
		}
	}
	if (requirements.directChild !== undefined && policy.directChild !== requirements.directChild) {
		return false
	}
	if (requirements.requireAllowScripts && !policy.allowScripts) return false
	if (requirements.requireAllowSameOrigin && !policy.allowSameOrigin) return false
	if (requirements.requiredSandboxTokens?.some((token) => !policy.sandbox.includes(token))) {
		return false
	}
	return true
}

const SENSITIVE_QUERY_KEY =
	/(?:^|[?&\s])(token|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|api[_-]?key)=([^&#\s]+)/gi
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
const JWT_TOKEN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g
const MANAGED_OPAQUE_POLICY = /\bpao_[A-Za-z0-9_-]{43,}\b/g
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^@\s]*@/gi

function stripControlCharacters(value: string): string {
	let result = ''
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (
			(code >= 0 && code <= 8) ||
			code === 11 ||
			code === 12 ||
			(code >= 14 && code <= 31) ||
			code === 127
		)
			continue
		result += character
	}
	return result
}

export function sanitizeParentControllerText(value: string): string {
	return stripControlCharacters(value)
		.replace(URL_CREDENTIALS, '$1[REDACTED]@')
		.replace(SENSITIVE_QUERY_KEY, (_match, key: string) => `${key}=[REDACTED]`)
		.replace(BEARER_TOKEN, 'Bearer [REDACTED]')
		.replace(JWT_TOKEN, '[REDACTED]')
		.replace(MANAGED_OPAQUE_POLICY, '[REDACTED]')
}

export function sanitizeParentControllerUrl(value: string): string {
	try {
		const url = new URL(value)
		url.username = ''
		url.password = ''
		url.search = ''
		url.hash = ''
		return url.toString()
	} catch {
		return sanitizeParentControllerText(value.replace(/[?#].*$/, ''))
	}
}

/**
 * Baseline state redaction performed before an application transform callback.
 * It deliberately keeps tree metadata unchanged while removing URL query/hash
 * and common credential-shaped values from every text field.
 */
export function sanitizeParentControllerState(state: IndexedBrowserState): IndexedBrowserState {
	return {
		url: sanitizeParentControllerUrl(state.url),
		title: sanitizeParentControllerText(state.title),
		header: sanitizeParentControllerText(state.header),
		content: sanitizeParentControllerText(state.content),
		footer: sanitizeParentControllerText(state.footer),
		treeRevision: state.treeRevision,
		indices: [...state.indices],
	}
}
