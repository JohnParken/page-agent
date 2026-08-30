import {
	IntegrationAwareAuthorizationError,
	IntegrationAwareAuthorizationErrorCode,
} from './integration-auth-authority'
import {
	MANAGED_EMBED_POLICY_AUDIENCE,
	MANAGED_EMBED_POLICY_CLOCK_SKEW_SECONDS,
	MANAGED_EMBED_POLICY_PREFIX,
	type ManagedAuthClock,
	type ManagedEmbedPolicyVerificationContext,
} from './managed-auth'
import {
	PARENT_CONTROLLER_CAPABILITIES,
	PARENT_CONTROLLER_MAX_POLICY_LENGTH,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	type VerifiedEmbedPolicyChildFrameGrant,
} from './protocol'
import { normalizeParentControllerOrigin } from './security'

import type {
	IntegrationAwareManagedEmbedPolicyClaims,
	IntegrationAwareManagedEmbedPolicyGrant,
} from './integration-auth-contracts'
import type { ParentControllerEmbedPolicyRequestContext } from './types'

const MAX_IDENTIFIER_LENGTH = 256
const DEFAULT_MAX_POLICY_TTL_SECONDS = 5 * 60
const DEFAULT_MAX_BRIDGE_SESSION_TTL_SECONDS = 60 * 60
const MAX_CHILD_FRAME_GRANTS = 8

export interface IntegrationAwareManagedEmbedAuthClientOptions {
	readonly endpoint?: string | URL
	readonly runtimeOrigin?: string
	readonly allowInsecureHttp?: boolean
	readonly fetchImpl?: typeof fetch
	readonly expectedIntegrationId: string
	readonly expectedParentAppId: string
	readonly expectedAssistantAppId: string
	readonly expectedParentOrigin: string
	readonly expectedAssistantOrigin: string
	readonly expectedScopeId: string
	readonly expectedIssuer: string
	readonly expectedAudience?: string
	readonly expectedConfigVersion?: number
	readonly allowedCapabilities?: readonly ParentControllerCapability[]
	readonly protocolVersion?: number
	readonly clockSkewSeconds?: number
	readonly maxPolicyTtlSeconds?: number
	readonly maxBridgeSessionTtlSeconds?: number
	readonly now?: ManagedAuthClock
}

function unixNow(): number {
	return Math.floor(Date.now() / 1_000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function identifier(value: unknown, label: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_IDENTIFIER_LENGTH ||
		// eslint-disable-next-line no-control-regex
		/[\u0000-\u001f\u007f]/.test(value)
	) {
		throw new IntegrationAwareAuthorizationError(
			`${label} is invalid`,
			IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
		)
	}
	return value
}

function exactOrigin(value: unknown, label: string, allowInsecureHttp: boolean): string {
	if (typeof value !== 'string') {
		throw new IntegrationAwareAuthorizationError(
			`${label} is invalid`,
			IntegrationAwareAuthorizationErrorCode.ORIGIN_MISMATCH
		)
	}
	let origin: string
	try {
		origin = normalizeParentControllerOrigin(value)
	} catch {
		throw new IntegrationAwareAuthorizationError(
			`${label} must be an exact HTTP(S) origin`,
			IntegrationAwareAuthorizationErrorCode.ORIGIN_MISMATCH
		)
	}
	if (!allowInsecureHttp && new URL(origin).protocol !== 'https:') {
		throw new IntegrationAwareAuthorizationError(
			`${label} must use HTTPS`,
			IntegrationAwareAuthorizationErrorCode.ORIGIN_MISMATCH
		)
	}
	return origin
}

function integer(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value)) {
		throw new IntegrationAwareAuthorizationError(
			`${label} is invalid`,
			IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
		)
	}
	return value as number
}

function capabilities(value: unknown, allowed: ReadonlySet<string>): ParentControllerCapability[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new IntegrationAwareAuthorizationError(
			'Capabilities are invalid',
			IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
		)
	}
	const result = value.map((capability) => {
		if (typeof capability !== 'string' || !allowed.has(capability)) {
			throw new IntegrationAwareAuthorizationError(
				'Capability is not allowed',
				IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
			)
		}
		return capability as ParentControllerCapability
	})
	if (new Set(result).size !== result.length) {
		throw new IntegrationAwareAuthorizationError(
			'Capabilities must be unique',
			IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
		)
	}
	return result
}

function normalizeChildFrames(
	value: unknown,
	parentCapabilities: ReadonlySet<string>,
	allowInsecureHttp: boolean
): VerifiedEmbedPolicyChildFrameGrant[] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value) || value.length > MAX_CHILD_FRAME_GRANTS) {
		throw new IntegrationAwareAuthorizationError(
			'Child-frame Grants are invalid',
			IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
		)
	}
	const seen = new Set<string>()
	return value.map((entry) => {
		if (!isRecord(entry)) {
			throw new IntegrationAwareAuthorizationError(
				'Child-frame Grant is invalid',
				IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
			)
		}
		const id = identifier(entry.id, 'Child-frame id')
		if (seen.has(id)) {
			throw new IntegrationAwareAuthorizationError(
				'Child-frame ids must be unique',
				IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
			)
		}
		const origin = exactOrigin(entry.origin, 'Child-frame origin', allowInsecureHttp)
		const cap = capabilities(entry.cap, new Set(PARENT_CONTROLLER_CAPABILITIES))
		if (cap.includes('visual') || cap.some((item) => !parentCapabilities.has(item))) {
			throw new IntegrationAwareAuthorizationError(
				'Child-frame capability exceeds the parent Grant',
				IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
			)
		}
		seen.add(id)
		return { id, origin, cap }
	})
}

function isOpaquePolicy(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(MANAGED_EMBED_POLICY_PREFIX) &&
		value.length <= PARENT_CONTROLLER_MAX_POLICY_LENGTH &&
		/^[A-Za-z0-9_-]+$/.test(value)
	)
}

function cloneClaims(
	claims: IntegrationAwareManagedEmbedPolicyClaims
): IntegrationAwareManagedEmbedPolicyClaims {
	return {
		...claims,
		cap: [...claims.cap],
		bridgeBinding: { ...claims.bridgeBinding },
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

function normalizeOptions(options: IntegrationAwareManagedEmbedAuthClientOptions) {
	if (!options) {
		throw new IntegrationAwareAuthorizationError(
			'Client options are required',
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const allowInsecureHttp = options.allowInsecureHttp === true
	const expectedParentOrigin = exactOrigin(
		options.expectedParentOrigin,
		'Expected parent origin',
		allowInsecureHttp
	)
	const expectedAssistantOrigin = exactOrigin(
		options.expectedAssistantOrigin,
		'Expected assistant origin',
		allowInsecureHttp
	)
	const runtimeOrigin = options.runtimeOrigin
		? exactOrigin(options.runtimeOrigin, 'Runtime origin', allowInsecureHttp)
		: globalThis.location?.origin
			? exactOrigin(globalThis.location.origin, 'Runtime origin', allowInsecureHttp)
			: undefined
	const endpoint = new URL(
		options.endpoint ?? '/api/parent-bridge/embed-policy',
		globalThis.location?.href ?? `${runtimeOrigin ?? 'http://localhost'}/`
	)
	if (endpoint.protocol !== 'https:' && !(allowInsecureHttp && endpoint.protocol === 'http:')) {
		throw new IntegrationAwareAuthorizationError(
			'Managed policy endpoint must use HTTPS',
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	if (runtimeOrigin && endpoint.origin !== runtimeOrigin) {
		throw new IntegrationAwareAuthorizationError(
			'Managed policy endpoint must be same-origin',
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	const allowedCapabilities = new Set(
		capabilities(
			options.allowedCapabilities ?? PARENT_CONTROLLER_CAPABILITIES,
			new Set(PARENT_CONTROLLER_CAPABILITIES)
		)
	)
	const clockSkewSeconds = options.clockSkewSeconds ?? MANAGED_EMBED_POLICY_CLOCK_SKEW_SECONDS
	const maxPolicyTtlSeconds = options.maxPolicyTtlSeconds ?? DEFAULT_MAX_POLICY_TTL_SECONDS
	const maxBridgeSessionTtlSeconds =
		options.maxBridgeSessionTtlSeconds ?? DEFAULT_MAX_BRIDGE_SESSION_TTL_SECONDS
	const protocolVersion = options.protocolVersion ?? PARENT_CONTROLLER_PROTOCOL_VERSION
	if (
		!Number.isSafeInteger(clockSkewSeconds) ||
		clockSkewSeconds < 0 ||
		clockSkewSeconds > 60 ||
		!Number.isSafeInteger(maxPolicyTtlSeconds) ||
		maxPolicyTtlSeconds < 1 ||
		maxPolicyTtlSeconds > DEFAULT_MAX_POLICY_TTL_SECONDS ||
		!Number.isSafeInteger(maxBridgeSessionTtlSeconds) ||
		maxBridgeSessionTtlSeconds < 1 ||
		maxBridgeSessionTtlSeconds > DEFAULT_MAX_BRIDGE_SESSION_TTL_SECONDS ||
		!Number.isSafeInteger(protocolVersion) ||
		protocolVersion < 0 ||
		(options.expectedConfigVersion !== undefined &&
			(!Number.isSafeInteger(options.expectedConfigVersion) || options.expectedConfigVersion < 1))
	) {
		throw new IntegrationAwareAuthorizationError(
			'Client time, version, or protocol options are invalid',
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	return {
		...options,
		allowInsecureHttp,
		expectedIntegrationId: identifier(options.expectedIntegrationId, 'Expected Integration'),
		expectedParentAppId: identifier(options.expectedParentAppId, 'Expected parent app'),
		expectedAssistantAppId: identifier(options.expectedAssistantAppId, 'Expected assistant app'),
		expectedParentOrigin,
		expectedAssistantOrigin,
		expectedScopeId: identifier(options.expectedScopeId, 'Expected scope'),
		expectedIssuer: identifier(options.expectedIssuer, 'Expected issuer'),
		expectedAudience: identifier(
			options.expectedAudience ?? MANAGED_EMBED_POLICY_AUDIENCE,
			'Expected audience'
		),
		allowedCapabilities,
		clockSkewSeconds,
		maxPolicyTtlSeconds,
		maxBridgeSessionTtlSeconds,
		protocolVersion,
		runtimeOrigin,
		endpoint,
		now: options.now ?? unixNow,
	}
}

function normalizeGrant(
	value: unknown,
	config: ReturnType<typeof normalizeOptions>,
	requestContext: ParentControllerEmbedPolicyRequestContext,
	nowSeconds: number
): IntegrationAwareManagedEmbedPolicyGrant {
	if (!isRecord(value) || !isOpaquePolicy(value.policy) || !isRecord(value.claims)) {
		throw new IntegrationAwareAuthorizationError(
			'Managed policy response is invalid',
			IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
		)
	}
	const valueClaims = value.claims
	const parentOrigin = exactOrigin(
		valueClaims.parentOrigin,
		'Policy parent origin',
		config.allowInsecureHttp
	)
	const assistantOrigin = exactOrigin(
		valueClaims.assistantOrigin,
		'Policy assistant origin',
		config.allowInsecureHttp
	)
	const bridgeBinding = isRecord(valueClaims.bridgeBinding)
		? {
				sessionId: identifier(valueClaims.bridgeBinding.sessionId, 'Bridge session id'),
				challenge: identifier(valueClaims.bridgeBinding.challenge, 'Bridge challenge'),
				hostInstanceId: identifier(valueClaims.bridgeBinding.hostInstanceId, 'Host instance id'),
				frameInstanceId: identifier(valueClaims.bridgeBinding.frameInstanceId, 'Frame instance id'),
			}
		: null
	if (
		!bridgeBinding ||
		bridgeBinding.sessionId !== requestContext.sessionId ||
		bridgeBinding.challenge !== requestContext.challenge ||
		bridgeBinding.hostInstanceId !== requestContext.hostInstanceId ||
		bridgeBinding.frameInstanceId !== requestContext.frameInstanceId
	) {
		throw new IntegrationAwareAuthorizationError(
			'Policy bridge binding does not match',
			IntegrationAwareAuthorizationErrorCode.OFFER_MISMATCH
		)
	}
	const nbf = integer(valueClaims.nbf, 'Policy not-before')
	const exp = integer(valueClaims.exp, 'Policy expiry')
	const bridgeSessionExp = integer(valueClaims.bridgeSessionExp, 'Bridge session expiry')
	if (
		nbf > nowSeconds + config.clockSkewSeconds ||
		exp <= nowSeconds - config.clockSkewSeconds ||
		exp <= nbf ||
		exp - nbf > config.maxPolicyTtlSeconds + config.clockSkewSeconds ||
		bridgeSessionExp <= exp ||
		bridgeSessionExp - nbf > config.maxBridgeSessionTtlSeconds + config.clockSkewSeconds
	) {
		throw new IntegrationAwareAuthorizationError(
			'Policy lifetime is invalid',
			IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
		)
	}
	const protocolVersionMin = integer(valueClaims.protocolVersionMin, 'Minimum protocol version')
	const protocolVersionMax = integer(valueClaims.protocolVersionMax, 'Maximum protocol version')
	if (protocolVersionMin > config.protocolVersion || protocolVersionMax < config.protocolVersion) {
		throw new IntegrationAwareAuthorizationError(
			'Policy protocol version does not match',
			IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
		)
	}
	const cap = capabilities(valueClaims.cap, config.allowedCapabilities)
	const childFrames = normalizeChildFrames(
		valueClaims.childFrames,
		new Set(cap),
		config.allowInsecureHttp
	)
	const claims: IntegrationAwareManagedEmbedPolicyClaims = {
		jti: identifier(valueClaims.jti, 'Policy id'),
		tenant: identifier(valueClaims.tenant, 'Tenant'),
		user: identifier(valueClaims.user, 'User'),
		targetId: identifier(valueClaims.targetId, 'Target'),
		scopeId: identifier(valueClaims.scopeId, 'Scope'),
		parentOrigin,
		assistantOrigin,
		cap,
		protocolVersionMin,
		protocolVersionMax,
		nbf,
		exp,
		iss: identifier(valueClaims.iss, 'Policy issuer'),
		aud: identifier(valueClaims.aud, 'Policy audience'),
		integrationId: identifier(valueClaims.integrationId, 'Integration id'),
		parentAppId: identifier(valueClaims.parentAppId, 'Parent app id'),
		assistantAppId: identifier(valueClaims.assistantAppId, 'Assistant app id'),
		configVersion: integer(valueClaims.configVersion, 'Integration config version'),
		bridgeBinding,
		bridgeSessionExp,
		...(childFrames === undefined ? {} : { childFrames }),
	}
	if (
		claims.iss !== config.expectedIssuer ||
		claims.aud !== config.expectedAudience ||
		claims.integrationId !== config.expectedIntegrationId ||
		claims.parentAppId !== config.expectedParentAppId ||
		claims.assistantAppId !== config.expectedAssistantAppId ||
		(config.expectedConfigVersion !== undefined &&
			claims.configVersion !== config.expectedConfigVersion) ||
		claims.parentOrigin !== config.expectedParentOrigin ||
		claims.assistantOrigin !== config.expectedAssistantOrigin ||
		claims.scopeId !== config.expectedScopeId ||
		requestContext.parentOrigin !== config.expectedParentOrigin ||
		requestContext.assistantOrigin !== config.expectedAssistantOrigin ||
		requestContext.scopeId !== config.expectedScopeId ||
		requestContext.capabilities.some((capability) => !claims.cap.includes(capability))
	) {
		throw new IntegrationAwareAuthorizationError(
			'Policy does not match the configured Integration',
			IntegrationAwareAuthorizationErrorCode.INTEGRATION_DENIED
		)
	}
	return { policy: value.policy, claims }
}

export class IntegrationAwareManagedEmbedAuthClient {
	private readonly config: ReturnType<typeof normalizeOptions>
	private currentGrant: IntegrationAwareManagedEmbedPolicyGrant | undefined

	constructor(options: IntegrationAwareManagedEmbedAuthClientOptions) {
		this.config = normalizeOptions(options)
	}

	async getEmbedPolicy(context: ParentControllerEmbedPolicyRequestContext): Promise<string> {
		this.currentGrant = undefined
		if (!context || context.signal.aborted) {
			throw new IntegrationAwareAuthorizationError(
				'Policy request was aborted',
				IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
			)
		}
		const fetchImpl = this.config.fetchImpl ?? globalThis.fetch?.bind(globalThis)
		if (typeof fetchImpl !== 'function') {
			throw new IntegrationAwareAuthorizationError(
				'Fetch is required for managed authorization',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		let response: Response
		try {
			response = await fetchImpl(this.config.endpoint, {
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					integrationId: this.config.expectedIntegrationId,
					parentOrigin: context.parentOrigin,
					assistantOrigin: context.assistantOrigin,
					scopeId: context.scopeId,
					capabilities: context.capabilities,
					bridgeBinding: {
						sessionId: context.sessionId,
						challenge: context.challenge,
						hostInstanceId: context.hostInstanceId,
						frameInstanceId: context.frameInstanceId,
					},
				}),
				signal: context.signal,
			})
		} catch {
			throw new IntegrationAwareAuthorizationError(
				'Managed policy endpoint is unavailable',
				IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
			)
		}
		if (!response.ok) {
			throw new IntegrationAwareAuthorizationError(
				'Managed policy endpoint rejected the request',
				IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
			)
		}
		const payload = await response.json().catch(() => null)
		const grant = normalizeGrant(payload, this.config, context, this.config.now())
		this.currentGrant = grant
		return grant.policy
	}

	verifyEmbedPolicy(
		policy: string,
		context: ManagedEmbedPolicyVerificationContext
	): IntegrationAwareManagedEmbedPolicyClaims | false {
		const grant = this.currentGrant
		if (!grant || policy !== grant.policy || !isRecord(context)) return false
		this.currentGrant = undefined
		try {
			const parentOrigin = exactOrigin(
				context.actualParentOrigin,
				'Actual parent origin',
				this.config.allowInsecureHttp
			)
			const assistantOrigin = exactOrigin(
				context.assistantOrigin,
				'Assistant origin',
				this.config.allowInsecureHttp
			)
			if (
				parentOrigin !== grant.claims.parentOrigin ||
				assistantOrigin !== grant.claims.assistantOrigin ||
				(context.scopeId !== undefined && context.scopeId !== grant.claims.scopeId) ||
				(context.frameContext !== undefined &&
					(!context.frameContext.directChild ||
						context.frameContext.parentOrigin !== parentOrigin ||
						context.frameContext.assistantOrigin !== assistantOrigin))
			)
				return false
			if (
				context.capabilities !== undefined &&
				context.capabilities.some((capability) => !grant.claims.cap.includes(capability))
			)
				return false
			return cloneClaims(grant.claims)
		} catch {
			return false
		}
	}
}

export function createIntegrationAwareManagedEmbedAuthClient(
	options: IntegrationAwareManagedEmbedAuthClientOptions
): IntegrationAwareManagedEmbedAuthClient {
	return new IntegrationAwareManagedEmbedAuthClient(options)
}
