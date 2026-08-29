import {
	PARENT_CONTROLLER_CAPABILITIES,
	PARENT_CONTROLLER_MAX_POLICY_LENGTH,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	type ParentFrameContext,
	type VerifiedEmbedPolicyChildFrameGrant,
	type VerifiedEmbedPolicyClaims,
} from './protocol'
import { normalizeParentControllerOrigin } from './security'

/** Audience used by the default managed parent-controller authorization service. */
export const MANAGED_EMBED_POLICY_AUDIENCE = 'page-agent-parent-bridge'
/** Default lifetime for an opaque policy. Keep this short in production. */
export const MANAGED_EMBED_POLICY_TTL_SECONDS = 120
/** Clock tolerance used for short-lived policy claims. */
export const MANAGED_EMBED_POLICY_CLOCK_SKEW_SECONDS = 5
/** Opaque policy entropy in bytes (256 bits). */
export const MANAGED_EMBED_POLICY_ENTROPY_BYTES = 32
/** Stable marker that makes opaque policies distinguishable from JWTs. */
export const MANAGED_EMBED_POLICY_PREFIX = 'pao_'
/** Stable marker for the independently generated policy id (`jti`). */
export const MANAGED_EMBED_POLICY_ID_PREFIX = 'pao_id_'

const MAX_IDENTIFIER_LENGTH = 256
const MAX_CHILD_FRAME_GRANTS = 8
const DEFAULT_MAX_TTL_SECONDS = 300
const MAX_CLOCK_SKEW_SECONDS = 60
const CHILD_FRAME_CAPABILITIES = new Set(
	PARENT_CONTROLLER_CAPABILITIES.filter((capability) => capability !== 'visual')
)

/** The minimal Web Crypto surface used by the issuer and digest store. */
export type ManagedAuthCrypto = Pick<Crypto, 'getRandomValues' | 'subtle'>

export type ManagedAuthClock = () => number

export const ManagedEmbedAuthorizationErrorCode = {
	CONFIG_INVALID: 'CONFIG_INVALID',
	REQUEST_INVALID: 'REQUEST_INVALID',
	ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
	SCOPE_MISMATCH: 'SCOPE_MISMATCH',
	CAPABILITY_DENIED: 'CAPABILITY_DENIED',
	POLICY_INVALID: 'POLICY_INVALID',
	POLICY_NOT_FOUND_OR_REPLAYED: 'POLICY_NOT_FOUND_OR_REPLAYED',
	POLICY_UNAVAILABLE: 'POLICY_UNAVAILABLE',
	OFFER_MISMATCH: 'OFFER_MISMATCH',
	INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ManagedEmbedAuthorizationErrorCode =
	(typeof ManagedEmbedAuthorizationErrorCode)[keyof typeof ManagedEmbedAuthorizationErrorCode]

export class ManagedEmbedAuthorizationError extends Error {
	readonly code: ManagedEmbedAuthorizationErrorCode

	constructor(
		message: string,
		code: ManagedEmbedAuthorizationErrorCode = ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID
	) {
		super(message)
		this.name = 'ManagedEmbedAuthorizationError'
		this.code = code
	}
}

/** Claims returned by the managed endpoint after server-side authorization. */
export interface ManagedEmbedPolicyClaims extends VerifiedEmbedPolicyClaims {
	readonly iss: string
	readonly aud: string
}

export interface ManagedEmbedPolicyChildFrameGrantInput {
	readonly id: string
	readonly origin: string
	readonly cap: readonly ParentControllerCapability[]
}

export interface ManagedEmbedPolicyIssueRequest {
	readonly tenant: string
	readonly user: string
	readonly targetId: string
	readonly scopeId: string
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly childFrames?: readonly ManagedEmbedPolicyChildFrameGrantInput[]
}

export interface ManagedEmbedPolicyGrant {
	/** High-entropy opaque bearer value. It is not a JWT and must not be parsed. */
	readonly policy: string
	readonly claims: ManagedEmbedPolicyClaims
}

/**
 * Server-side record. Deliberately contains no raw policy string; stores only
 * this record under a SHA-256 digest key.
 */
export interface OpaqueEmbedAuthorizationRecord {
	readonly claims: ManagedEmbedPolicyClaims
}

/**
 * Storage contract for opaque policies.
 *
 * `consume` must atomically evaluate `matches` against an unexpired record and
 * delete the digest only when it returns true. A false result leaves the record
 * available for the correctly bound exchange. Implementations should keep the
 * digest as the only policy lookup key and never persist the raw policy value.
 */
export interface OpaqueEmbedAuthorizationStore {
	putIfAbsent(
		policyDigest: string,
		record: OpaqueEmbedAuthorizationRecord,
		expiresAt: number
	): Promise<boolean>
	consume(
		policyDigest: string,
		matches: (record: OpaqueEmbedAuthorizationRecord) => boolean,
		nowSeconds?: number
	): Promise<OpaqueEmbedAuthorizationRecord | null>
}

/**
 * In-memory single-process implementation for tests and local demos only.
 * Production deployments must provide a shared atomic TTL store (for example,
 * a transaction or SETNX-style primitive) implementing the interface above.
 */
export class InMemoryOpaqueEmbedAuthorizationStore implements OpaqueEmbedAuthorizationStore {
	private readonly entries = new Map<
		string,
		{ readonly record: OpaqueEmbedAuthorizationRecord; readonly expiresAt: number }
	>()
	private readonly now: ManagedAuthClock

	constructor(now: ManagedAuthClock = unixNow) {
		this.now = now
	}

	async putIfAbsent(
		policyDigest: string,
		record: OpaqueEmbedAuthorizationRecord,
		expiresAt: number
	): Promise<boolean> {
		if (!isDigest(policyDigest) || !Number.isSafeInteger(expiresAt)) return false
		const now = this.now()
		this.sweep(now)
		if (expiresAt <= now || this.entries.has(policyDigest)) return false
		this.entries.set(policyDigest, {
			record: cloneRecord(record),
			expiresAt,
		})
		return true
	}

	async consume(
		policyDigest: string,
		matches: (record: OpaqueEmbedAuthorizationRecord) => boolean,
		nowSeconds = this.now()
	): Promise<OpaqueEmbedAuthorizationRecord | null> {
		if (!isDigest(policyDigest) || !Number.isSafeInteger(nowSeconds)) return null
		this.sweep(nowSeconds)
		const entry = this.entries.get(policyDigest)
		if (!entry) return null

		// This method has no await before the delete: the check-and-delete is one
		// event-loop turn and therefore atomic within this single-process store.
		const candidate = cloneRecord(entry.record)
		let matched = false
		try {
			matched = matches(candidate)
		} catch {
			return null
		}
		if (!matched) return null
		this.entries.delete(policyDigest)
		return candidate
	}

	private sweep(nowSeconds: number): void {
		for (const [digest, entry] of this.entries) {
			if (entry.expiresAt <= nowSeconds) this.entries.delete(digest)
		}
	}
}

export interface ManagedEmbedAuthorizationOffer {
	readonly policyId: string
	readonly sessionId: string
	readonly challenge: string
	readonly frameInstanceId: string
	readonly hostInstanceId: string
	readonly capabilities: readonly ParentControllerCapability[]
}

export interface ManagedEmbedAuthorizationExchangeRequest {
	/** The opaque policy itself; the service hashes it and does not persist it. */
	readonly policy: string
	readonly actualParentOrigin: string
	readonly offer: ManagedEmbedAuthorizationOffer
}

/** Safe context returned after a one-use exchange. It never contains the policy. */
export interface ManagedAuthorizationContext {
	readonly policyId: string
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly tenant: string
	readonly user: string
	readonly targetId: string
	readonly scopeId: string
	readonly sessionId: string
	readonly challenge: string
	readonly frameInstanceId: string
	readonly hostInstanceId: string
	readonly capabilities: ParentControllerCapability[]
	readonly expiresAt: number
}

export interface OpaqueEmbedAuthorizationServiceOptions {
	readonly store: OpaqueEmbedAuthorizationStore
	readonly assistantOrigin: string
	readonly allowedParentOrigins: readonly string[]
	readonly scopeId: string
	/**
	 * Allow exact `http:` origins for a controlled private-network deployment.
	 * Defaults to false. This does not encrypt or authenticate the transport.
	 */
	readonly allowInsecureHttp?: boolean
	readonly issuer?: string
	readonly audience?: string
	readonly allowedCapabilities?: readonly ParentControllerCapability[]
	readonly ttlSeconds?: number
	readonly clockSkewSeconds?: number
	readonly protocolVersion?: number
	readonly crypto?: ManagedAuthCrypto
	readonly now?: ManagedAuthClock
}

export interface ManagedEmbedPolicyVerificationContext {
	readonly actualParentOrigin: string
	readonly assistantOrigin: string
	readonly scopeId?: string
	readonly capabilities?: readonly ParentControllerCapability[]
	readonly frameContext?: Pick<
		ParentFrameContext,
		'parentOrigin' | 'assistantOrigin' | 'directChild'
	>
}

export interface ManagedEmbedAuthClientOptions {
	/** Same-origin endpoint returning `{ policy, claims }`. */
	readonly endpoint?: string | URL
	/** Explicit runtime origin for SSR/tests; browsers default to location.origin. */
	readonly runtimeOrigin?: string
	/**
	 * Allow exact `http:` origins and an HTTP same-origin endpoint for a
	 * controlled private-network deployment. Defaults to false.
	 */
	readonly allowInsecureHttp?: boolean
	readonly fetchImpl?: typeof fetch
	readonly expectedParentOrigin: string
	readonly expectedAssistantOrigin: string
	readonly expectedScopeId: string
	readonly expectedIssuer?: string
	readonly expectedAudience?: string
	readonly allowedCapabilities?: readonly ParentControllerCapability[]
	readonly protocolVersion?: number
	readonly clockSkewSeconds?: number
	readonly maxTtlSeconds?: number
	readonly now?: ManagedAuthClock
}

interface ClaimsValidationOptions {
	readonly issuer: string
	readonly audience: string
	readonly expectedParentOrigin: string
	readonly expectedAssistantOrigin: string
	readonly expectedScopeId: string
	readonly allowedCapabilities: ReadonlySet<string>
	readonly protocolVersion: number
	readonly clockSkewSeconds: number
	readonly maxTtlSeconds: number
	readonly allowInsecureHttp: boolean
}

interface NormalizedOffer {
	readonly policyId: string
	readonly sessionId: string
	readonly challenge: string
	readonly frameInstanceId: string
	readonly hostInstanceId: string
	readonly capabilities: ParentControllerCapability[]
}

function unixNow(): number {
	return Math.floor(Date.now() / 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIdentifier(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_IDENTIFIER_LENGTH &&
		// This escaped class intentionally rejects C0 controls and DEL.
		// eslint-disable-next-line no-control-regex
		!/[\u0000-\u001f\u007f]/.test(value)
	)
}

function requireIdentifier(value: unknown, label: string): string {
	if (!isIdentifier(value)) {
		throw new ManagedEmbedAuthorizationError(`${label} is invalid`)
	}
	return value
}

function requireTokenString(value: unknown, label: string): string {
	if (!isIdentifier(value)) {
		throw new ManagedEmbedAuthorizationError(
			`${label} is invalid`,
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	return value
}

function exactOrigin(
	value: unknown,
	label: string,
	code: ManagedEmbedAuthorizationErrorCode = ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID,
	allowInsecureHttp = false
): string {
	if (typeof value !== 'string')
		throw new ManagedEmbedAuthorizationError(`${label} is invalid`, code)
	let origin: string
	try {
		origin = normalizeParentControllerOrigin(value)
	} catch {
		throw new ManagedEmbedAuthorizationError(`${label} must be an exact HTTP(S) origin`, code)
	}
	if (!allowInsecureHttp && new URL(origin).protocol !== 'https:') {
		throw new ManagedEmbedAuthorizationError(
			`${label} must use HTTPS unless allowInsecureHttp is enabled`,
			code
		)
	}
	return origin
}

function validateInteger(
	value: unknown,
	label: string,
	code: ManagedEmbedAuthorizationErrorCode
): number {
	if (!Number.isSafeInteger(value)) {
		throw new ManagedEmbedAuthorizationError(`${label} is invalid`, code)
	}
	return value as number
}

function normalizeCapabilities(
	value: unknown,
	allowed: ReadonlySet<string>,
	code: ManagedEmbedAuthorizationErrorCode
): ParentControllerCapability[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new ManagedEmbedAuthorizationError('Capabilities are invalid', code)
	}
	const capabilities = value.map((capability) => {
		if (typeof capability !== 'string' || !allowed.has(capability)) {
			throw new ManagedEmbedAuthorizationError('Capabilities are not allowed', code)
		}
		return capability
	})
	if (new Set(capabilities).size !== capabilities.length) {
		throw new ManagedEmbedAuthorizationError('Capabilities must be unique', code)
	}
	return capabilities as ParentControllerCapability[]
}

function normalizeChildFrames(
	value: unknown,
	parentCapabilities: ReadonlySet<string>,
	code: ManagedEmbedAuthorizationErrorCode,
	allowInsecureHttp: boolean
): VerifiedEmbedPolicyChildFrameGrant[] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value) || value.length > MAX_CHILD_FRAME_GRANTS) {
		throw new ManagedEmbedAuthorizationError('Child-frame grants are invalid', code)
	}
	const ids = new Set<string>()
	return value.map((entry) => {
		if (
			!isRecord(entry) ||
			Object.keys(entry).some((key) => !['id', 'origin', 'cap'].includes(key))
		) {
			throw new ManagedEmbedAuthorizationError('Child-frame grants are invalid', code)
		}
		const id = requireIdentifier(entry.id, 'Child-frame id')
		if (ids.has(id))
			throw new ManagedEmbedAuthorizationError('Child-frame ids must be unique', code)
		const origin = exactOrigin(entry.origin, 'Child-frame origin', code, allowInsecureHttp)
		const capabilities = normalizeCapabilities(entry.cap, CHILD_FRAME_CAPABILITIES, code)
		if (capabilities.some((capability) => !parentCapabilities.has(capability))) {
			throw new ManagedEmbedAuthorizationError('Child-frame capability exceeds policy', code)
		}
		ids.add(id)
		return { id, origin, cap: [...capabilities] }
	})
}

function normalizeClaims(
	value: unknown,
	settings: ClaimsValidationOptions,
	nowSeconds: number,
	code: ManagedEmbedAuthorizationErrorCode
): ManagedEmbedPolicyClaims {
	if (!isRecord(value)) throw new ManagedEmbedAuthorizationError('Policy claims are invalid', code)
	const jti = requireIdentifier(value.jti, 'Policy id')
	const tenant = requireIdentifier(value.tenant, 'Tenant')
	const user = requireIdentifier(value.user, 'User')
	const targetId = requireIdentifier(value.targetId, 'Target')
	const scopeId = requireIdentifier(value.scopeId, 'Scope')
	if (scopeId !== settings.expectedScopeId)
		throw new ManagedEmbedAuthorizationError(
			'Policy scope does not match',
			ManagedEmbedAuthorizationErrorCode.SCOPE_MISMATCH
		)
	if (value.iss !== settings.issuer || value.aud !== settings.audience) {
		throw new ManagedEmbedAuthorizationError('Policy issuer or audience does not match', code)
	}
	const parentOrigin = exactOrigin(
		value.parentOrigin,
		'Policy parent origin',
		code,
		settings.allowInsecureHttp
	)
	const assistantOrigin = exactOrigin(
		value.assistantOrigin,
		'Policy assistant origin',
		code,
		settings.allowInsecureHttp
	)
	if (
		parentOrigin !== settings.expectedParentOrigin ||
		assistantOrigin !== settings.expectedAssistantOrigin
	) {
		throw new ManagedEmbedAuthorizationError(
			'Policy origin does not match',
			ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH
		)
	}
	const nbf = validateInteger(value.nbf, 'Policy not-before', code)
	const exp = validateInteger(value.exp, 'Policy expiry', code)
	if (
		nbf > nowSeconds + settings.clockSkewSeconds ||
		exp <= nowSeconds - settings.clockSkewSeconds ||
		exp <= nbf ||
		exp - nbf > settings.maxTtlSeconds + settings.clockSkewSeconds
	) {
		throw new ManagedEmbedAuthorizationError(
			'Policy is expired or outside its lifetime',
			ManagedEmbedAuthorizationErrorCode.POLICY_INVALID
		)
	}
	const protocolVersionMin = validateInteger(
		value.protocolVersionMin,
		'Minimum protocol version',
		code
	)
	const protocolVersionMax = validateInteger(
		value.protocolVersionMax,
		'Maximum protocol version',
		code
	)
	if (
		protocolVersionMin < 0 ||
		protocolVersionMax < protocolVersionMin ||
		protocolVersionMin > settings.protocolVersion ||
		protocolVersionMax < settings.protocolVersion
	) {
		throw new ManagedEmbedAuthorizationError('Policy protocol version does not match', code)
	}
	const cap = normalizeCapabilities(value.cap, settings.allowedCapabilities, code)
	const childFrames = normalizeChildFrames(
		value.childFrames,
		new Set(cap),
		code,
		settings.allowInsecureHttp
	)
	return {
		jti,
		tenant,
		user,
		targetId,
		scopeId,
		parentOrigin,
		assistantOrigin,
		cap,
		protocolVersionMin,
		protocolVersionMax,
		nbf,
		exp,
		iss: settings.issuer,
		aud: settings.audience,
		...(childFrames === undefined ? {} : { childFrames }),
	}
}

function cloneClaims(claims: ManagedEmbedPolicyClaims): ManagedEmbedPolicyClaims {
	return {
		jti: claims.jti,
		tenant: claims.tenant,
		user: claims.user,
		targetId: claims.targetId,
		scopeId: claims.scopeId,
		parentOrigin: claims.parentOrigin,
		assistantOrigin: claims.assistantOrigin,
		cap: [...claims.cap],
		protocolVersionMin: claims.protocolVersionMin,
		protocolVersionMax: claims.protocolVersionMax,
		nbf: claims.nbf,
		exp: claims.exp,
		iss: claims.iss,
		aud: claims.aud,
		...(claims.childFrames === undefined
			? {}
			: {
					childFrames: claims.childFrames.map((frame) => ({
						id: frame.id,
						origin: frame.origin,
						cap: [...frame.cap],
					})),
				}),
	}
}

function cloneRecord(record: OpaqueEmbedAuthorizationRecord): OpaqueEmbedAuthorizationRecord {
	return { claims: cloneClaims(record.claims) }
}

function isDigest(value: string): boolean {
	return /^[A-Za-z0-9_-]{43}$/.test(value)
}

function isOpaquePolicy(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(MANAGED_EMBED_POLICY_PREFIX) &&
		value.length >= MANAGED_EMBED_POLICY_PREFIX.length + encodedEntropyLength() &&
		value.length <= PARENT_CONTROLLER_MAX_POLICY_LENGTH &&
		/^[A-Za-z0-9_-]+$/.test(value)
	)
}

function encodedEntropyLength(): number {
	return Math.ceil((MANAGED_EMBED_POLICY_ENTROPY_BYTES * 8) / 6)
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function resolveCrypto(value?: ManagedAuthCrypto): ManagedAuthCrypto {
	const cryptoObject =
		value ?? (globalThis as typeof globalThis & { crypto?: ManagedAuthCrypto }).crypto
	if (!cryptoObject?.subtle || typeof cryptoObject.getRandomValues !== 'function') {
		throw new ManagedEmbedAuthorizationError(
			'Web Crypto is required for managed opaque authorization',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	return cryptoObject
}

function randomOpaqueValue(cryptoObject: ManagedAuthCrypto, prefix = ''): string {
	const bytes = new Uint8Array(MANAGED_EMBED_POLICY_ENTROPY_BYTES)
	cryptoObject.getRandomValues(bytes)
	return `${prefix}${encodeBase64Url(bytes)}`
}

async function digestOpaquePolicy(
	policy: string,
	cryptoObject: ManagedAuthCrypto
): Promise<string> {
	const digest = await cryptoObject.subtle.digest('SHA-256', new TextEncoder().encode(policy))
	return encodeBase64Url(new Uint8Array(digest))
}

function normalizeServiceOptions(options: OpaqueEmbedAuthorizationServiceOptions) {
	if (!options || !options.store) {
		throw new ManagedEmbedAuthorizationError(
			'A policy store is required',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const allowInsecureHttp = options.allowInsecureHttp === true
	const assistantOrigin = exactOrigin(
		options.assistantOrigin,
		'Assistant origin',
		ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID,
		allowInsecureHttp
	)
	const allowedParentOrigins = new Set(
		(options.allowedParentOrigins || []).map((origin) =>
			exactOrigin(
				origin,
				'Allowed parent origin',
				ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID,
				allowInsecureHttp
			)
		)
	)
	if (allowedParentOrigins.size === 0) {
		throw new ManagedEmbedAuthorizationError(
			'At least one allowed parent origin is required',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const scopeId = requireTokenString(options.scopeId, 'Scope')
	const issuer = requireTokenString(options.issuer ?? assistantOrigin, 'Issuer')
	const audience = requireTokenString(options.audience ?? MANAGED_EMBED_POLICY_AUDIENCE, 'Audience')
	const allowedCapabilities = new Set<ParentControllerCapability>(
		normalizeCapabilities(
			options.allowedCapabilities ?? PARENT_CONTROLLER_CAPABILITIES,
			new Set(PARENT_CONTROLLER_CAPABILITIES),
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	)
	const ttlSeconds = options.ttlSeconds ?? MANAGED_EMBED_POLICY_TTL_SECONDS
	if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > DEFAULT_MAX_TTL_SECONDS) {
		throw new ManagedEmbedAuthorizationError(
			'Policy TTL is invalid',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const clockSkewSeconds = options.clockSkewSeconds ?? MANAGED_EMBED_POLICY_CLOCK_SKEW_SECONDS
	if (
		!Number.isSafeInteger(clockSkewSeconds) ||
		clockSkewSeconds < 0 ||
		clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS
	) {
		throw new ManagedEmbedAuthorizationError(
			'Clock skew is invalid',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const protocolVersion = options.protocolVersion ?? PARENT_CONTROLLER_PROTOCOL_VERSION
	if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 0) {
		throw new ManagedEmbedAuthorizationError(
			'Protocol version is invalid',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const now = options.now ?? unixNow
	return {
		store: options.store,
		crypto: resolveCrypto(options.crypto),
		assistantOrigin,
		allowedParentOrigins,
		scopeId,
		issuer,
		audience,
		allowedCapabilities,
		ttlSeconds,
		clockSkewSeconds,
		protocolVersion,
		allowInsecureHttp,
		now,
	}
}

function serviceClaimsSettings(
	service: ReturnType<typeof normalizeServiceOptions>,
	parentOrigin: string
): ClaimsValidationOptions {
	return {
		issuer: service.issuer,
		audience: service.audience,
		expectedParentOrigin: parentOrigin,
		expectedAssistantOrigin: service.assistantOrigin,
		expectedScopeId: service.scopeId,
		allowedCapabilities: service.allowedCapabilities,
		protocolVersion: service.protocolVersion,
		clockSkewSeconds: service.clockSkewSeconds,
		maxTtlSeconds: service.ttlSeconds,
		allowInsecureHttp: service.allowInsecureHttp,
	}
}

function normalizeOffer(value: unknown, allowedCapabilities: ReadonlySet<string>): NormalizedOffer {
	if (!isRecord(value)) throw new ManagedEmbedAuthorizationError('Offer is invalid')
	const policyId = requireIdentifier(value.policyId, 'Offer policy id')
	const sessionId = requireIdentifier(value.sessionId, 'Offer session id')
	const challenge = requireIdentifier(value.challenge, 'Offer challenge')
	const frameInstanceId = requireIdentifier(value.frameInstanceId, 'Offer frame instance id')
	const hostInstanceId = requireIdentifier(value.hostInstanceId, 'Offer host instance id')
	const capabilities = normalizeCapabilities(
		value.capabilities,
		allowedCapabilities,
		ManagedEmbedAuthorizationErrorCode.CAPABILITY_DENIED
	)
	return { policyId, sessionId, challenge, frameInstanceId, hostInstanceId, capabilities }
}

function normalizedFrameContextMatches(
	frameContext: ManagedEmbedPolicyVerificationContext['frameContext'],
	parentOrigin: string,
	assistantOrigin: string
): boolean {
	if (!frameContext) return true
	try {
		return (
			frameContext.directChild &&
			normalizeParentControllerOrigin(frameContext.parentOrigin) === parentOrigin &&
			normalizeParentControllerOrigin(frameContext.assistantOrigin) === assistantOrigin
		)
	} catch {
		return false
	}
}

/**
 * Service-side managed opaque authorization authority.
 *
 * It issues random bearer policies and stores only their SHA-256 digest. The
 * exchange validates every offer binding before atomically consuming the digest.
 */
export class OpaqueEmbedAuthorizationService {
	private readonly config: ReturnType<typeof normalizeServiceOptions>

	constructor(options: OpaqueEmbedAuthorizationServiceOptions) {
		this.config = normalizeServiceOptions(options)
	}

	async issue(request: ManagedEmbedPolicyIssueRequest): Promise<ManagedEmbedPolicyGrant> {
		if (!isRecord(request)) throw new ManagedEmbedAuthorizationError('Issue request is invalid')
		const parentOrigin = exactOrigin(
			request.parentOrigin,
			'Parent origin',
			ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID,
			this.config.allowInsecureHttp
		)
		if (!this.config.allowedParentOrigins.has(parentOrigin)) {
			throw new ManagedEmbedAuthorizationError(
				'Parent origin is not authorized',
				ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH
			)
		}
		const assistantOrigin = exactOrigin(
			request.assistantOrigin,
			'Assistant origin',
			ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID,
			this.config.allowInsecureHttp
		)
		if (assistantOrigin !== this.config.assistantOrigin) {
			throw new ManagedEmbedAuthorizationError(
				'Assistant origin is not authorized',
				ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH
			)
		}
		const tenant = requireIdentifier(request.tenant, 'Tenant')
		const user = requireIdentifier(request.user, 'User')
		const targetId = requireIdentifier(request.targetId, 'Target')
		const scopeId = requireIdentifier(request.scopeId, 'Scope')
		if (scopeId !== this.config.scopeId) {
			throw new ManagedEmbedAuthorizationError(
				'Policy scope does not match',
				ManagedEmbedAuthorizationErrorCode.SCOPE_MISMATCH
			)
		}
		const cap = normalizeCapabilities(
			request.capabilities,
			this.config.allowedCapabilities,
			ManagedEmbedAuthorizationErrorCode.CAPABILITY_DENIED
		)
		const childFrames = normalizeChildFrames(
			request.childFrames,
			new Set(cap),
			ManagedEmbedAuthorizationErrorCode.CAPABILITY_DENIED,
			this.config.allowInsecureHttp
		)
		const nowSeconds = this.config.now()
		if (!Number.isSafeInteger(nowSeconds)) {
			throw new ManagedEmbedAuthorizationError(
				'Clock value is invalid',
				ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		const claims = normalizeClaims(
			{
				jti: randomOpaqueValue(this.config.crypto, MANAGED_EMBED_POLICY_ID_PREFIX),
				tenant,
				user,
				targetId,
				scopeId,
				parentOrigin,
				assistantOrigin,
				cap,
				protocolVersionMin: this.config.protocolVersion,
				protocolVersionMax: this.config.protocolVersion,
				nbf: nowSeconds,
				exp: nowSeconds + this.config.ttlSeconds,
				iss: this.config.issuer,
				aud: this.config.audience,
				...(childFrames === undefined ? {} : { childFrames }),
			},
			serviceClaimsSettings(this.config, parentOrigin),
			nowSeconds,
			ManagedEmbedAuthorizationErrorCode.INTERNAL_ERROR
		)

		for (let attempt = 0; attempt < 3; attempt += 1) {
			const policy = randomOpaqueValue(this.config.crypto, MANAGED_EMBED_POLICY_PREFIX)
			const digest = await digestOpaquePolicy(policy, this.config.crypto)
			if (await this.config.store.putIfAbsent(digest, { claims }, claims.exp)) {
				return { policy, claims: cloneClaims(claims) }
			}
		}
		throw new ManagedEmbedAuthorizationError(
			'Could not reserve an opaque policy',
			ManagedEmbedAuthorizationErrorCode.INTERNAL_ERROR
		)
	}

	async exchange(
		request: ManagedEmbedAuthorizationExchangeRequest
	): Promise<ManagedAuthorizationContext> {
		if (!isRecord(request)) throw new ManagedEmbedAuthorizationError('Exchange request is invalid')
		if (!isOpaquePolicy(request.policy)) {
			throw new ManagedEmbedAuthorizationError(
				'Policy is invalid',
				ManagedEmbedAuthorizationErrorCode.POLICY_INVALID
			)
		}
		const actualParentOrigin = exactOrigin(
			request.actualParentOrigin,
			'Actual parent origin',
			ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID,
			this.config.allowInsecureHttp
		)
		if (!this.config.allowedParentOrigins.has(actualParentOrigin)) {
			throw new ManagedEmbedAuthorizationError(
				'Actual parent origin is not authorized',
				ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH
			)
		}
		const offer = normalizeOffer(request.offer, this.config.allowedCapabilities)
		const digest = await digestOpaquePolicy(request.policy, this.config.crypto)
		const nowSeconds = this.config.now()
		if (!Number.isSafeInteger(nowSeconds)) {
			throw new ManagedEmbedAuthorizationError(
				'Clock value is invalid',
				ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		const record = await this.config.store.consume(
			digest,
			(candidate) => {
				try {
					const claims = normalizeClaims(
						candidate.claims,
						serviceClaimsSettings(this.config, actualParentOrigin),
						nowSeconds,
						ManagedEmbedAuthorizationErrorCode.POLICY_INVALID
					)
					return (
						claims.jti === offer.policyId &&
						claims.parentOrigin === actualParentOrigin &&
						claims.assistantOrigin === this.config.assistantOrigin &&
						offer.capabilities.every((capability) => claims.cap.includes(capability))
					)
				} catch {
					return false
				}
			},
			nowSeconds
		)
		if (!record) {
			throw new ManagedEmbedAuthorizationError(
				'Policy is missing, expired, or already consumed',
				ManagedEmbedAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED
			)
		}
		const claims = normalizeClaims(
			record.claims,
			serviceClaimsSettings(this.config, actualParentOrigin),
			nowSeconds,
			ManagedEmbedAuthorizationErrorCode.POLICY_INVALID
		)
		return {
			policyId: claims.jti,
			parentOrigin: claims.parentOrigin,
			assistantOrigin: claims.assistantOrigin,
			tenant: claims.tenant,
			user: claims.user,
			targetId: claims.targetId,
			scopeId: claims.scopeId,
			sessionId: offer.sessionId,
			challenge: offer.challenge,
			frameInstanceId: offer.frameInstanceId,
			hostInstanceId: offer.hostInstanceId,
			capabilities: [...offer.capabilities],
			expiresAt: claims.exp,
		}
	}
}

interface ClientClaimsSettingsInput {
	readonly expectedScopeId: string
	readonly expectedIssuer?: string
	readonly expectedAudience?: string
	readonly allowedCapabilities?: readonly ParentControllerCapability[] | ReadonlySet<string>
	readonly protocolVersion?: number
	readonly clockSkewSeconds?: number
	readonly maxTtlSeconds?: number
	readonly allowInsecureHttp?: boolean
}

function clientClaimsSettings(
	options: ClientClaimsSettingsInput,
	parentOrigin: string,
	assistantOrigin: string
): ClaimsValidationOptions {
	const clockSkewSeconds = options.clockSkewSeconds ?? MANAGED_EMBED_POLICY_CLOCK_SKEW_SECONDS
	const maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS
	return {
		issuer: options.expectedIssuer ?? assistantOrigin,
		audience: options.expectedAudience ?? MANAGED_EMBED_POLICY_AUDIENCE,
		expectedParentOrigin: parentOrigin,
		expectedAssistantOrigin: assistantOrigin,
		expectedScopeId: options.expectedScopeId,
		allowedCapabilities: new Set(options.allowedCapabilities ?? PARENT_CONTROLLER_CAPABILITIES),
		protocolVersion: options.protocolVersion ?? PARENT_CONTROLLER_PROTOCOL_VERSION,
		clockSkewSeconds,
		maxTtlSeconds,
		allowInsecureHttp: options.allowInsecureHttp === true,
	}
}

function normalizeClientOptions(options: ManagedEmbedAuthClientOptions) {
	if (!options) {
		throw new ManagedEmbedAuthorizationError(
			'Client options are required',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const allowInsecureHttp = options.allowInsecureHttp === true
	const expectedParentOrigin = exactOrigin(
		options.expectedParentOrigin,
		'Expected parent origin',
		ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID,
		allowInsecureHttp
	)
	const expectedAssistantOrigin = exactOrigin(
		options.expectedAssistantOrigin,
		'Expected assistant origin',
		ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID,
		allowInsecureHttp
	)
	const expectedScopeId = requireTokenString(options.expectedScopeId, 'Expected scope')
	const expectedIssuer = requireTokenString(
		options.expectedIssuer ?? expectedAssistantOrigin,
		'Expected issuer'
	)
	const expectedAudience = requireTokenString(
		options.expectedAudience ?? MANAGED_EMBED_POLICY_AUDIENCE,
		'Expected audience'
	)
	const allowedCapabilities = new Set<ParentControllerCapability>(
		normalizeCapabilities(
			options.allowedCapabilities ?? PARENT_CONTROLLER_CAPABILITIES,
			new Set(PARENT_CONTROLLER_CAPABILITIES),
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	)
	const clockSkewSeconds = options.clockSkewSeconds ?? MANAGED_EMBED_POLICY_CLOCK_SKEW_SECONDS
	const maxTtlSeconds = options.maxTtlSeconds ?? DEFAULT_MAX_TTL_SECONDS
	const protocolVersion = options.protocolVersion ?? PARENT_CONTROLLER_PROTOCOL_VERSION
	if (
		!Number.isSafeInteger(clockSkewSeconds) ||
		clockSkewSeconds < 0 ||
		clockSkewSeconds > MAX_CLOCK_SKEW_SECONDS ||
		!Number.isSafeInteger(maxTtlSeconds) ||
		maxTtlSeconds < 1 ||
		maxTtlSeconds > DEFAULT_MAX_TTL_SECONDS ||
		!Number.isSafeInteger(protocolVersion) ||
		protocolVersion < 0
	) {
		throw new ManagedEmbedAuthorizationError(
			'Client time or protocol options are invalid',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const runtimeOrigin = options.runtimeOrigin
		? exactOrigin(
				options.runtimeOrigin,
				'Runtime origin',
				ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID,
				allowInsecureHttp
			)
		: globalThis.location?.origin
			? exactOrigin(
					globalThis.location.origin,
					'Runtime origin',
					ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID,
					allowInsecureHttp
				)
			: undefined
	const endpoint = new URL(
		options.endpoint ?? '/api/parent-bridge/embed-policy',
		globalThis.location?.href ?? `${runtimeOrigin ?? 'http://localhost'}/`
	)
	if (endpoint.protocol !== 'https:' && !(allowInsecureHttp && endpoint.protocol === 'http:')) {
		throw new ManagedEmbedAuthorizationError(
			'Managed policy endpoint must use HTTPS unless allowInsecureHttp is enabled',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	if (runtimeOrigin && endpoint.origin !== runtimeOrigin) {
		throw new ManagedEmbedAuthorizationError(
			'Managed policy endpoint must be same-origin',
			ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	return {
		...options,
		expectedParentOrigin,
		expectedAssistantOrigin,
		expectedScopeId,
		expectedIssuer,
		expectedAudience,
		allowedCapabilities,
		clockSkewSeconds,
		maxTtlSeconds,
		protocolVersion,
		allowInsecureHttp,
		runtimeOrigin,
		endpoint,
		now: options.now ?? unixNow,
	}
}

function normalizeGrant(
	value: unknown,
	settings: ClaimsValidationOptions,
	nowSeconds: number
): ManagedEmbedPolicyGrant {
	if (!isRecord(value) || !isOpaquePolicy(value.policy)) {
		throw new ManagedEmbedAuthorizationError(
			'Managed policy response is invalid',
			ManagedEmbedAuthorizationErrorCode.POLICY_UNAVAILABLE
		)
	}
	const claims = normalizeClaims(
		value.claims,
		settings,
		nowSeconds,
		ManagedEmbedAuthorizationErrorCode.POLICY_UNAVAILABLE
	)
	return { policy: value.policy, claims }
}

/**
 * Front-end client for a same-origin managed endpoint.
 *
 * The client intentionally does not decode, parse, or locally verify the
 * opaque policy. It accepts only the exact policy/context pair returned by its
 * latest same-origin fetch and validates the accompanying claims shape.
 */
export class ManagedEmbedAuthClient {
	private readonly config: ReturnType<typeof normalizeClientOptions>
	private currentGrant: ManagedEmbedPolicyGrant | undefined

	constructor(options: ManagedEmbedAuthClientOptions) {
		this.config = normalizeClientOptions(options)
	}

	async getEmbedPolicy(signal?: AbortSignal): Promise<string> {
		// Always issue a fresh one-use policy. Reusing a still-live grant could
		// collide with a host handshake that has already consumed its jti.
		this.currentGrant = undefined
		const fetchImpl = this.config.fetchImpl ?? globalThis.fetch?.bind(globalThis)
		if (typeof fetchImpl !== 'function') {
			throw new ManagedEmbedAuthorizationError(
				'Fetch is required for managed authorization',
				ManagedEmbedAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		let response: Response
		try {
			response = await fetchImpl(this.config.endpoint, {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
				signal,
			})
		} catch {
			throw new ManagedEmbedAuthorizationError(
				'Managed policy endpoint is unavailable',
				ManagedEmbedAuthorizationErrorCode.POLICY_UNAVAILABLE
			)
		}
		if (!response.ok) {
			throw new ManagedEmbedAuthorizationError(
				'Managed policy endpoint rejected the request',
				ManagedEmbedAuthorizationErrorCode.POLICY_UNAVAILABLE
			)
		}
		let payload: unknown
		try {
			payload = await response.json()
		} catch {
			throw new ManagedEmbedAuthorizationError(
				'Managed policy response is not JSON',
				ManagedEmbedAuthorizationErrorCode.POLICY_UNAVAILABLE
			)
		}
		try {
			const grant = normalizeGrant(
				payload,
				clientClaimsSettings(
					this.config,
					this.config.expectedParentOrigin,
					this.config.expectedAssistantOrigin
				),
				this.config.now()
			)
			this.currentGrant = grant
			return grant.policy
		} catch (error) {
			this.currentGrant = undefined
			if (error instanceof ManagedEmbedAuthorizationError) throw error
			throw new ManagedEmbedAuthorizationError(
				'Managed policy response is invalid',
				ManagedEmbedAuthorizationErrorCode.POLICY_UNAVAILABLE
			)
		}
	}

	verifyEmbedPolicy(
		policy: string,
		context: ManagedEmbedPolicyVerificationContext
	): ManagedEmbedPolicyClaims | false {
		const grant = this.currentGrant
		if (!grant || typeof policy !== 'string' || policy !== grant.policy || !isRecord(context))
			return false
		// The fetched policy/claims pair is itself one-use in the parent runtime.
		// Clear it before validation so a failed context check cannot be retried.
		this.currentGrant = undefined
		try {
			const actualParentOrigin = exactOrigin(
				context.actualParentOrigin,
				'Actual parent origin',
				ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID,
				this.config.allowInsecureHttp
			)
			const assistantOrigin = exactOrigin(
				context.assistantOrigin,
				'Assistant origin',
				ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID,
				this.config.allowInsecureHttp
			)
			if (
				actualParentOrigin !== this.config.expectedParentOrigin ||
				assistantOrigin !== this.config.expectedAssistantOrigin ||
				!normalizedFrameContextMatches(context.frameContext, actualParentOrigin, assistantOrigin)
			) {
				return false
			}
			if (context.scopeId !== undefined && context.scopeId !== this.config.expectedScopeId)
				return false
			if (context.capabilities !== undefined) {
				const capabilities = normalizeCapabilities(
					context.capabilities,
					this.config.allowedCapabilities,
					ManagedEmbedAuthorizationErrorCode.CAPABILITY_DENIED
				)
				if (!capabilities.every((capability) => grant.claims.cap.includes(capability))) return false
			}
			const claims = normalizeClaims(
				grant.claims,
				clientClaimsSettings(this.config, actualParentOrigin, assistantOrigin),
				this.config.now(),
				ManagedEmbedAuthorizationErrorCode.POLICY_INVALID
			)
			return cloneClaims(claims)
		} catch {
			return false
		}
	}
}

export function createManagedEmbedAuthClient(
	options: ManagedEmbedAuthClientOptions
): ManagedEmbedAuthClient {
	return new ManagedEmbedAuthClient(options)
}
