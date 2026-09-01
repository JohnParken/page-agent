import {
	MANAGED_EMBED_POLICY_AUDIENCE,
	MANAGED_EMBED_POLICY_ENTROPY_BYTES,
	MANAGED_EMBED_POLICY_ID_PREFIX,
	MANAGED_EMBED_POLICY_PREFIX,
	type ManagedAuthClock,
	type ManagedAuthCrypto,
} from './managed-auth'
import {
	PARENT_CONTROLLER_CAPABILITIES,
	PARENT_CONTROLLER_MAX_POLICY_LENGTH,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerBridgeBinding,
	type ParentControllerCapability,
	type VerifiedEmbedPolicyChildFrameGrant,
} from './protocol'
import { normalizeParentControllerOrigin } from './security'

import type {
	AuthenticatedServiceActor,
	BrowserActiveLeaseStatus,
	BrowserAuthorizationContext,
	CanonicalAuthSubject,
	IntegrationAwareActiveLease,
	IntegrationAwareActiveLeaseLookup,
	IntegrationAwareAuthorizationDecision,
	IntegrationAwareAuthorizationRecord,
	IntegrationAwareAuthorizationStore,
	IntegrationAwareConsumeAndCreateLeaseResult,
	IntegrationAwareConsumeExpectation,
	IntegrationAwareExchangeRequest,
	IntegrationAwareIssueRequest,
	IntegrationAwareManagedEmbedPolicyClaims,
	IntegrationAwareManagedEmbedPolicyGrant,
	IntegrationAwareRevocationResult,
	IntegrationAwareRevocationSelector,
	ManagedAuthAssistantApp,
	ManagedAuthExecutionContext,
	ManagedAuthIntegration,
	ManagedAuthParentApp,
	ManagedEmbedAuthorizationRegistry,
} from './integration-auth-contracts'

const MAX_IDENTIFIER_LENGTH = 256
const MAX_CHILD_FRAME_GRANTS = 8
const BROWSER_SUBJECT_PLACEHOLDER = 'server-verified'
const DEFAULT_POLICY_TTL_SECONDS = 120
const DEFAULT_BRIDGE_SESSION_TTL_SECONDS = 15 * 60
const MAX_POLICY_TTL_SECONDS = 5 * 60
const MAX_BRIDGE_SESSION_TTL_SECONDS = 60 * 60
const ACTIVE_LEASE_TTL_SECONDS = 15 * 60
const ACTIVE_LEASE_ID_PREFIX = 'pao_lease_'
const IN_MEMORY_TERMINAL_LEASE_RETENTION_SECONDS = 15 * 60
const CHILD_FRAME_CAPABILITIES: ReadonlySet<string> = new Set(
	PARENT_CONTROLLER_CAPABILITIES.filter((capability) => capability !== 'visual')
)

export const IntegrationAwareAuthorizationErrorCode = {
	CONFIG_INVALID: 'CONFIG_INVALID',
	REQUEST_INVALID: 'REQUEST_INVALID',
	ACTOR_DENIED: 'ACTOR_DENIED',
	SUBJECT_MISMATCH: 'SUBJECT_MISMATCH',
	INTEGRATION_DENIED: 'INTEGRATION_DENIED',
	ORIGIN_MISMATCH: 'ORIGIN_MISMATCH',
	SCOPE_MISMATCH: 'SCOPE_MISMATCH',
	CAPABILITY_DENIED: 'CAPABILITY_DENIED',
	OFFER_MISMATCH: 'OFFER_MISMATCH',
	POLICY_INVALID: 'POLICY_INVALID',
	POLICY_NOT_FOUND_OR_REPLAYED: 'POLICY_NOT_FOUND_OR_REPLAYED',
	ACTIVE_LEASE_NOT_FOUND_OR_DENIED: 'ACTIVE_LEASE_NOT_FOUND_OR_DENIED',
	ACTIVE_LEASE_STATUS_UNAVAILABLE: 'ACTIVE_LEASE_STATUS_UNAVAILABLE',
	INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type IntegrationAwareAuthorizationErrorCode =
	(typeof IntegrationAwareAuthorizationErrorCode)[keyof typeof IntegrationAwareAuthorizationErrorCode]

export class IntegrationAwareAuthorizationError extends Error {
	readonly code: IntegrationAwareAuthorizationErrorCode

	constructor(message: string, code: IntegrationAwareAuthorizationErrorCode) {
		super(message)
		this.name = 'IntegrationAwareAuthorizationError'
		this.code = code
	}
}

export interface IntegrationAwareEmbedAuthorizationAuthorityOptions {
	readonly registry: ManagedEmbedAuthorizationRegistry
	readonly store: IntegrationAwareAuthorizationStore
	readonly issuer: string
	readonly audience?: string
	readonly policyTtlSeconds?: number
	readonly bridgeSessionTtlSeconds?: number
	/** Global risk gate. The Integration must also opt in to trusted-intranet-http. */
	readonly allowInsecureHttp?: boolean
	readonly protocolVersion?: number
	readonly crypto?: ManagedAuthCrypto
	readonly now?: ManagedAuthClock
}

interface RegisteredIntegration {
	readonly integration: ManagedAuthIntegration
	readonly parentApp: ManagedAuthParentApp
	readonly assistantApp: ManagedAuthAssistantApp
}

interface StoredEntry {
	record: IntegrationAwareAuthorizationRecord
	readonly expiresAt: number
}

interface StoredActiveLeaseEntry {
	record: IntegrationAwareActiveLease
	readonly purgeAt: number
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

function configIdentifier(value: unknown, label: string): string {
	try {
		return identifier(value, label)
	} catch {
		throw new IntegrationAwareAuthorizationError(
			`${label} is invalid`,
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
	}
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

function normalizeCapabilities(
	value: unknown,
	allowed: ReadonlySet<string>,
	code: IntegrationAwareAuthorizationErrorCode
): ParentControllerCapability[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new IntegrationAwareAuthorizationError('Capabilities are invalid', code)
	}
	const result = value.map((capability) => {
		if (typeof capability !== 'string' || !allowed.has(capability)) {
			throw new IntegrationAwareAuthorizationError('Capability is not allowed', code)
		}
		return capability as ParentControllerCapability
	})
	if (new Set(result).size !== result.length) {
		throw new IntegrationAwareAuthorizationError('Capabilities must be unique', code)
	}
	return result
}

function normalizeSubject(value: unknown, nowSeconds: number): CanonicalAuthSubject {
	if (!isRecord(value)) {
		throw new IntegrationAwareAuthorizationError(
			'Canonical subject is invalid',
			IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
		)
	}
	const authenticatedAt = value.authenticatedAt
	const credentialExpiresAt = value.credentialExpiresAt
	if (
		(authenticatedAt !== undefined && !Number.isSafeInteger(authenticatedAt)) ||
		(credentialExpiresAt !== undefined && !Number.isSafeInteger(credentialExpiresAt)) ||
		(typeof credentialExpiresAt === 'number' && credentialExpiresAt <= nowSeconds)
	) {
		throw new IntegrationAwareAuthorizationError(
			'Canonical subject session is invalid or expired',
			IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
		)
	}
	return {
		issuer: identifier(value.issuer, 'Subject issuer'),
		tenantId: identifier(value.tenantId, 'Subject tenant'),
		userId: identifier(value.userId, 'Subject user'),
		...(authenticatedAt === undefined ? {} : { authenticatedAt: authenticatedAt as number }),
		...(credentialExpiresAt === undefined
			? {}
			: { credentialExpiresAt: credentialExpiresAt as number }),
	}
}

function normalizeActor(value: unknown): AuthenticatedServiceActor {
	if (!isRecord(value)) {
		throw new IntegrationAwareAuthorizationError(
			'Service actor is invalid',
			IntegrationAwareAuthorizationErrorCode.ACTOR_DENIED
		)
	}
	if (value.role !== 'parent-bff' && value.role !== 'assistant-bff') {
		throw new IntegrationAwareAuthorizationError(
			'Service actor role is invalid',
			IntegrationAwareAuthorizationErrorCode.ACTOR_DENIED
		)
	}
	return {
		actorId: identifier(value.actorId, 'Service actor'),
		appId: identifier(value.appId, 'Service actor app'),
		environment: identifier(value.environment, 'Service actor environment'),
		role: value.role,
	}
}

function normalizeBinding(value: unknown): ParentControllerBridgeBinding {
	if (!isRecord(value)) {
		throw new IntegrationAwareAuthorizationError(
			'Bridge binding is invalid',
			IntegrationAwareAuthorizationErrorCode.OFFER_MISMATCH
		)
	}
	return {
		sessionId: identifier(value.sessionId, 'Bridge session id'),
		challenge: identifier(value.challenge, 'Bridge challenge'),
		hostInstanceId: identifier(value.hostInstanceId, 'Host instance id'),
		frameInstanceId: identifier(value.frameInstanceId, 'Frame instance id'),
	}
}

function sameSubject(left: CanonicalAuthSubject, right: CanonicalAuthSubject): boolean {
	return (
		left.issuer === right.issuer && left.tenantId === right.tenantId && left.userId === right.userId
	)
}

function sameBinding(
	left: ParentControllerBridgeBinding,
	right: ParentControllerBridgeBinding
): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.challenge === right.challenge &&
		left.hostInstanceId === right.hostInstanceId &&
		left.frameInstanceId === right.frameInstanceId
	)
}

const REVOCATION_SELECTOR_KEYS: readonly (keyof IntegrationAwareRevocationSelector)[] = [
	'leaseId',
	'policyId',
	'environment',
	'integrationId',
	'parentAppId',
	'assistantAppId',
	'configVersion',
	'subject',
	'parentSessionBinding',
	'scopeId',
	'targetId',
	'bridgeSessionId',
	'hostInstanceId',
	'frameInstanceId',
]

function hasRevocationCriterion(value: unknown): value is IntegrationAwareRevocationSelector {
	return isRecord(value) && REVOCATION_SELECTOR_KEYS.some((key) => value[key] !== undefined)
}

function normalizeRevocationSubject(value: unknown): CanonicalAuthSubject {
	if (!isRecord(value)) {
		throw new IntegrationAwareAuthorizationError(
			'Revocation subject is invalid',
			IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
		)
	}
	return {
		issuer: identifier(value.issuer, 'Revocation subject issuer'),
		tenantId: identifier(value.tenantId, 'Revocation subject tenant'),
		userId: identifier(value.userId, 'Revocation subject user'),
	}
}

function normalizeRevocationSelector(value: unknown): IntegrationAwareRevocationSelector {
	if (!hasRevocationCriterion(value)) {
		throw new IntegrationAwareAuthorizationError(
			'Revocation requires at least one selector',
			IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
		)
	}
	const configVersion = value.configVersion
	if (
		configVersion !== undefined &&
		(!Number.isSafeInteger(configVersion) || (configVersion as number) < 1)
	) {
		throw new IntegrationAwareAuthorizationError(
			'Revocation config version is invalid',
			IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
		)
	}
	type MutableSelector = {
		-readonly [Key in keyof IntegrationAwareRevocationSelector]: IntegrationAwareRevocationSelector[Key]
	}
	const normalized: MutableSelector = {}
	if (value.leaseId !== undefined)
		normalized.leaseId = identifier(value.leaseId, 'Revocation ActiveLease id')
	if (value.policyId !== undefined)
		normalized.policyId = identifier(value.policyId, 'Revocation policy id')
	if (value.environment !== undefined)
		normalized.environment = identifier(value.environment, 'Revocation environment')
	if (value.integrationId !== undefined)
		normalized.integrationId = identifier(value.integrationId, 'Revocation Integration id')
	if (value.parentAppId !== undefined)
		normalized.parentAppId = identifier(value.parentAppId, 'Revocation parent app')
	if (value.assistantAppId !== undefined)
		normalized.assistantAppId = identifier(value.assistantAppId, 'Revocation assistant app')
	if (configVersion !== undefined) normalized.configVersion = configVersion as number
	if (value.subject !== undefined) normalized.subject = normalizeRevocationSubject(value.subject)
	if (value.parentSessionBinding !== undefined)
		normalized.parentSessionBinding = identifier(
			value.parentSessionBinding,
			'Revocation parent session binding'
		)
	if (value.scopeId !== undefined)
		normalized.scopeId = identifier(value.scopeId, 'Revocation scope')
	if (value.targetId !== undefined)
		normalized.targetId = identifier(value.targetId, 'Revocation target')
	if (value.bridgeSessionId !== undefined)
		normalized.bridgeSessionId = identifier(value.bridgeSessionId, 'Revocation bridge session')
	if (value.hostInstanceId !== undefined)
		normalized.hostInstanceId = identifier(value.hostInstanceId, 'Revocation host instance')
	if (value.frameInstanceId !== undefined)
		normalized.frameInstanceId = identifier(value.frameInstanceId, 'Revocation frame instance')
	return normalized
}

function cloneSubject(subject: CanonicalAuthSubject): CanonicalAuthSubject {
	return { ...subject }
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

function cloneRecord(
	record: IntegrationAwareAuthorizationRecord
): IntegrationAwareAuthorizationRecord {
	return {
		...record,
		claims: cloneClaims(record.claims),
		parentSubject: cloneSubject(record.parentSubject),
	}
}

function cloneActiveLease(lease: IntegrationAwareActiveLease): IntegrationAwareActiveLease {
	return {
		...lease,
		subject: cloneSubject(lease.subject),
		bridgeBinding: { ...lease.bridgeBinding },
		capabilities: [...lease.capabilities],
		...(lease.childFrames === undefined
			? {}
			: {
					childFrames: lease.childFrames.map((frame) => ({
						id: frame.id,
						origin: frame.origin,
						cap: [...frame.cap],
					})),
				}),
	}
}

function cloneAssistantApp(app: ManagedAuthAssistantApp): ManagedAuthAssistantApp {
	return { ...app, origins: [...app.origins], serviceActorIds: [...app.serviceActorIds] }
}

function cloneParentApp(app: ManagedAuthParentApp): ManagedAuthParentApp {
	return { ...app, origins: [...app.origins], serviceActorIds: [...app.serviceActorIds] }
}

function cloneIntegration(integration: ManagedAuthIntegration): ManagedAuthIntegration {
	return {
		...integration,
		parentOrigins: [...integration.parentOrigins],
		assistantOrigins: [...integration.assistantOrigins],
		maxCapabilities: [...integration.maxCapabilities],
		childTargets: integration.childTargets.map((target) => ({
			...target,
			maxCapabilities: [...target.maxCapabilities],
		})),
	}
}

function selectorMatches(
	record: IntegrationAwareAuthorizationRecord,
	selector: IntegrationAwareRevocationSelector
): boolean {
	return (
		selector.leaseId === undefined &&
		(selector.policyId === undefined || selector.policyId === record.claims.jti) &&
		(selector.environment === undefined || selector.environment === record.environment) &&
		(selector.integrationId === undefined ||
			selector.integrationId === record.claims.integrationId) &&
		(selector.parentAppId === undefined || selector.parentAppId === record.claims.parentAppId) &&
		(selector.assistantAppId === undefined ||
			selector.assistantAppId === record.claims.assistantAppId) &&
		(selector.configVersion === undefined ||
			selector.configVersion === record.claims.configVersion) &&
		(selector.subject === undefined || sameSubject(selector.subject, record.parentSubject)) &&
		(selector.parentSessionBinding === undefined ||
			selector.parentSessionBinding === record.parentSessionBinding) &&
		(selector.scopeId === undefined || selector.scopeId === record.claims.scopeId) &&
		(selector.targetId === undefined || selector.targetId === record.claims.targetId) &&
		(selector.bridgeSessionId === undefined ||
			selector.bridgeSessionId === record.claims.bridgeBinding.sessionId) &&
		(selector.hostInstanceId === undefined ||
			selector.hostInstanceId === record.claims.bridgeBinding.hostInstanceId) &&
		(selector.frameInstanceId === undefined ||
			selector.frameInstanceId === record.claims.bridgeBinding.frameInstanceId)
	)
}

function activeLeaseSelectorMatches(
	lease: IntegrationAwareActiveLease,
	selector: IntegrationAwareRevocationSelector
): boolean {
	return (
		(selector.leaseId === undefined || selector.leaseId === lease.leaseId) &&
		(selector.policyId === undefined || selector.policyId === lease.policyId) &&
		(selector.environment === undefined || selector.environment === lease.environment) &&
		(selector.integrationId === undefined || selector.integrationId === lease.integrationId) &&
		(selector.parentAppId === undefined || selector.parentAppId === lease.parentAppId) &&
		(selector.assistantAppId === undefined || selector.assistantAppId === lease.assistantAppId) &&
		(selector.configVersion === undefined || selector.configVersion === lease.configVersion) &&
		(selector.subject === undefined || sameSubject(selector.subject, lease.subject)) &&
		(selector.parentSessionBinding === undefined ||
			selector.parentSessionBinding === lease.parentSessionBinding) &&
		(selector.scopeId === undefined || selector.scopeId === lease.scopeId) &&
		(selector.targetId === undefined || selector.targetId === lease.targetId) &&
		(selector.bridgeSessionId === undefined ||
			selector.bridgeSessionId === lease.bridgeBinding.sessionId) &&
		(selector.hostInstanceId === undefined ||
			selector.hostInstanceId === lease.bridgeBinding.hostInstanceId) &&
		(selector.frameInstanceId === undefined ||
			selector.frameInstanceId === lease.bridgeBinding.frameInstanceId)
	)
}

function activeLeaseLookupMatches(
	lease: IntegrationAwareActiveLease,
	lookup: IntegrationAwareActiveLeaseLookup
): boolean {
	return (
		(lookup.leaseId === undefined || lookup.leaseId === lease.leaseId) &&
		(lookup.policyId === undefined || lookup.policyId === lease.policyId) &&
		sameBinding(lookup.bridgeBinding, lease.bridgeBinding)
	)
}

function consumeMatches(
	record: IntegrationAwareAuthorizationRecord,
	expected: IntegrationAwareConsumeExpectation
): boolean {
	return (
		record.state === 'ISSUED' &&
		record.claims.jti === expected.policyId &&
		record.claims.integrationId === expected.integrationId &&
		record.claims.configVersion === expected.configVersion &&
		record.claims.parentOrigin === expected.parentOrigin &&
		record.claims.assistantOrigin === expected.assistantOrigin &&
		sameSubject(record.parentSubject, expected.parentSubject) &&
		sameBinding(record.claims.bridgeBinding, expected.bridgeBinding) &&
		expected.requestedCapabilities.every((capability) => record.claims.cap.includes(capability))
	)
}

function activeLeaseMatchesConsumedGrant(
	record: IntegrationAwareAuthorizationRecord,
	expected: IntegrationAwareConsumeExpectation,
	lease: IntegrationAwareActiveLease,
	nowSeconds: number
): boolean {
	const capabilitiesMatch =
		lease.capabilities.length === expected.requestedCapabilities.length &&
		lease.capabilities.every((capability) => expected.requestedCapabilities.includes(capability))
	const childFramesMatch =
		lease.childFrames === undefined ||
		lease.childFrames.every((leaseFrame) => {
			const grantFrame = record.claims.childFrames?.find((frame) => frame.id === leaseFrame.id)
			return (
				grantFrame !== undefined &&
				grantFrame.origin === leaseFrame.origin &&
				leaseFrame.cap.every(
					(capability) =>
						lease.capabilities.includes(capability as ParentControllerCapability) &&
						grantFrame.cap.includes(capability)
				)
			)
		})
	return (
		lease.state === 'ACTIVE' &&
		lease.policyId === record.claims.jti &&
		lease.environment === record.environment &&
		lease.integrationId === record.claims.integrationId &&
		lease.parentAppId === record.claims.parentAppId &&
		lease.assistantAppId === record.claims.assistantAppId &&
		lease.configVersion === record.claims.configVersion &&
		lease.parentOrigin === record.claims.parentOrigin &&
		lease.assistantOrigin === record.claims.assistantOrigin &&
		lease.targetId === record.claims.targetId &&
		lease.scopeId === record.claims.scopeId &&
		lease.parentSessionBinding === record.parentSessionBinding &&
		sameSubject(lease.subject, record.parentSubject) &&
		sameBinding(lease.bridgeBinding, record.claims.bridgeBinding) &&
		capabilitiesMatch &&
		childFramesMatch &&
		lease.issuedAt === nowSeconds &&
		lease.expiresAt > nowSeconds &&
		lease.expiresAt <= record.claims.bridgeSessionExp
	)
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomOpaqueValue(cryptoObject: ManagedAuthCrypto, prefix: string): string {
	const bytes = new Uint8Array(MANAGED_EMBED_POLICY_ENTROPY_BYTES)
	cryptoObject.getRandomValues(bytes)
	return `${prefix}${encodeBase64Url(bytes)}`
}

async function digestPolicy(policy: string, cryptoObject: ManagedAuthCrypto): Promise<string> {
	const digest = await cryptoObject.subtle.digest('SHA-256', new TextEncoder().encode(policy))
	return encodeBase64Url(new Uint8Array(digest))
}

function isOpaquePolicy(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.startsWith(MANAGED_EMBED_POLICY_PREFIX) &&
		value.length <= PARENT_CONTROLLER_MAX_POLICY_LENGTH &&
		/^[A-Za-z0-9_-]+$/.test(value)
	)
}

function validTtl(value: unknown, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
		throw new IntegrationAwareAuthorizationError(
			`${label} is invalid`,
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
	}
	return value as number
}

/** Mutable registry for tests and service bootstrap. Production may use a database-backed registry. */
export class InMemoryManagedEmbedAuthorizationRegistry
	implements ManagedEmbedAuthorizationRegistry
{
	private readonly assistantApps = new Map<string, ManagedAuthAssistantApp>()
	private readonly parentApps = new Map<string, ManagedAuthParentApp>()
	private readonly integrations = new Map<string, ManagedAuthIntegration>()

	constructor(
		options: {
			readonly assistantApps?: readonly ManagedAuthAssistantApp[]
			readonly parentApps?: readonly ManagedAuthParentApp[]
			readonly integrations?: readonly ManagedAuthIntegration[]
		} = {}
	) {
		for (const app of options.assistantApps ?? []) this.setAssistantApp(app)
		for (const app of options.parentApps ?? []) this.setParentApp(app)
		for (const integration of options.integrations ?? []) this.setIntegration(integration)
	}

	setAssistantApp(app: ManagedAuthAssistantApp): void {
		this.assistantApps.set(
			configIdentifier(app.assistantAppId, 'Assistant app id'),
			cloneAssistantApp(app)
		)
	}

	setParentApp(app: ManagedAuthParentApp): void {
		this.parentApps.set(configIdentifier(app.parentAppId, 'Parent app id'), cloneParentApp(app))
	}

	setIntegration(integration: ManagedAuthIntegration): void {
		this.integrations.set(
			configIdentifier(integration.integrationId, 'Integration id'),
			cloneIntegration(integration)
		)
	}

	async getAssistantApp(assistantAppId: string): Promise<ManagedAuthAssistantApp | null> {
		const app = this.assistantApps.get(assistantAppId)
		return app ? cloneAssistantApp(app) : null
	}

	async getParentApp(parentAppId: string): Promise<ManagedAuthParentApp | null> {
		const app = this.parentApps.get(parentAppId)
		return app ? cloneParentApp(app) : null
	}

	async getIntegration(integrationId: string): Promise<ManagedAuthIntegration | null> {
		const integration = this.integrations.get(integrationId)
		return integration ? cloneIntegration(integration) : null
	}
}

/** Single-process conformance implementation. Do not deploy it as the shared production Store. */
export class InMemoryIntegrationAwareAuthorizationStore
	implements IntegrationAwareAuthorizationStore
{
	private readonly entries = new Map<string, StoredEntry>()
	private readonly activeLeases = new Map<string, StoredActiveLeaseEntry>()
	private readonly now: ManagedAuthClock

	constructor(now: ManagedAuthClock = unixNow) {
		this.now = now
	}

	async putIfAbsent(
		policyDigest: string,
		record: IntegrationAwareAuthorizationRecord,
		expiresAt: number
	): Promise<boolean> {
		const nowSeconds = this.now()
		this.sweep(nowSeconds)
		if (
			!Number.isSafeInteger(expiresAt) ||
			expiresAt <= nowSeconds ||
			this.entries.has(policyDigest)
		)
			return false
		this.entries.set(policyDigest, { record: cloneRecord(record), expiresAt })
		return true
	}

	async get(
		policyDigest: string,
		nowSeconds: number
	): Promise<IntegrationAwareAuthorizationRecord | null> {
		this.sweep(nowSeconds)
		const entry = this.entries.get(policyDigest)
		if (!entry || entry.record.state !== 'ISSUED' || entry.record.claims.exp <= nowSeconds)
			return null
		return cloneRecord(entry.record)
	}

	async consumeAndCreateActiveLease(
		policyDigest: string,
		expected: IntegrationAwareConsumeExpectation,
		activeLease: IntegrationAwareActiveLease,
		nowSeconds: number
	): Promise<IntegrationAwareConsumeAndCreateLeaseResult | null> {
		this.sweep(nowSeconds)
		const entry = this.entries.get(policyDigest)
		if (
			!entry ||
			entry.record.claims.exp <= nowSeconds ||
			!consumeMatches(entry.record, expected) ||
			!activeLeaseMatchesConsumedGrant(entry.record, expected, activeLease, nowSeconds) ||
			this.activeLeases.has(activeLease.leaseId)
		)
			return null
		entry.record = { ...entry.record, state: 'CONSUMED', consumedAt: nowSeconds }
		const lease = cloneActiveLease(activeLease)
		this.activeLeases.set(lease.leaseId, {
			record: lease,
			purgeAt: lease.expiresAt + IN_MEMORY_TERMINAL_LEASE_RETENTION_SECONDS,
		})
		return {
			authorization: cloneRecord(entry.record),
			activeLease: cloneActiveLease(lease),
		}
	}

	async getActiveLease(
		lookup: IntegrationAwareActiveLeaseLookup,
		nowSeconds: number
	): Promise<IntegrationAwareActiveLease | null> {
		this.sweep(nowSeconds)
		if (lookup.leaseId === undefined && lookup.policyId === undefined) return null
		for (const entry of this.activeLeases.values()) {
			if (activeLeaseLookupMatches(entry.record, lookup)) return cloneActiveLease(entry.record)
		}
		return null
	}

	async revoke(
		selector: IntegrationAwareRevocationSelector,
		nowSeconds: number
	): Promise<IntegrationAwareRevocationResult> {
		if (!hasRevocationCriterion(selector)) {
			throw new IntegrationAwareAuthorizationError(
				'Revocation requires at least one selector',
				IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
			)
		}
		this.sweep(nowSeconds)
		let grantsRevoked = 0
		for (const entry of this.entries.values()) {
			if (entry.record.state !== 'ISSUED' || !selectorMatches(entry.record, selector)) continue
			entry.record = { ...entry.record, state: 'REVOKED', revokedAt: nowSeconds }
			grantsRevoked += 1
		}
		let activeLeasesRevoked = 0
		for (const entry of this.activeLeases.values()) {
			if (entry.record.state !== 'ACTIVE' || !activeLeaseSelectorMatches(entry.record, selector))
				continue
			entry.record = { ...entry.record, state: 'REVOKED', revokedAt: nowSeconds }
			activeLeasesRevoked += 1
		}
		return {
			grantsRevoked,
			activeLeasesRevoked,
			totalRevoked: grantsRevoked + activeLeasesRevoked,
		}
	}

	private sweep(nowSeconds: number): void {
		for (const [digest, entry] of this.entries) {
			if (entry.expiresAt <= nowSeconds) this.entries.delete(digest)
		}
		for (const [leaseId, entry] of this.activeLeases) {
			if (entry.purgeAt <= nowSeconds) {
				this.activeLeases.delete(leaseId)
				continue
			}
			if (entry.record.state === 'ACTIVE' && entry.record.expiresAt <= nowSeconds) {
				entry.record = {
					...entry.record,
					state: 'EXPIRED',
					expiredAt: entry.record.expiresAt,
				}
			}
		}
	}
}

export class IntegrationAwareEmbedAuthorizationAuthority {
	private readonly config: {
		readonly registry: ManagedEmbedAuthorizationRegistry
		readonly store: IntegrationAwareAuthorizationStore
		readonly issuer: string
		readonly audience: string
		readonly policyTtlSeconds: number
		readonly bridgeSessionTtlSeconds: number
		readonly allowInsecureHttp: boolean
		readonly protocolVersion: number
		readonly crypto: ManagedAuthCrypto
		readonly now: ManagedAuthClock
	}

	constructor(options: IntegrationAwareEmbedAuthorizationAuthorityOptions) {
		if (!options?.registry || !options.store) {
			throw new IntegrationAwareAuthorizationError(
				'Registry and Store are required',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		const cryptoObject =
			options.crypto ?? (globalThis as typeof globalThis & { crypto?: ManagedAuthCrypto }).crypto
		if (!cryptoObject?.subtle || typeof cryptoObject.getRandomValues !== 'function') {
			throw new IntegrationAwareAuthorizationError(
				'Web Crypto is required',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		const protocolVersion = options.protocolVersion ?? PARENT_CONTROLLER_PROTOCOL_VERSION
		if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 0) {
			throw new IntegrationAwareAuthorizationError(
				'Protocol version is invalid',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		this.config = {
			registry: options.registry,
			store: options.store,
			issuer: configIdentifier(options.issuer, 'Authority issuer'),
			audience: configIdentifier(
				options.audience ?? MANAGED_EMBED_POLICY_AUDIENCE,
				'Authority audience'
			),
			policyTtlSeconds: validTtl(
				options.policyTtlSeconds ?? DEFAULT_POLICY_TTL_SECONDS,
				MAX_POLICY_TTL_SECONDS,
				'Policy TTL'
			),
			bridgeSessionTtlSeconds: validTtl(
				options.bridgeSessionTtlSeconds ?? DEFAULT_BRIDGE_SESSION_TTL_SECONDS,
				MAX_BRIDGE_SESSION_TTL_SECONDS,
				'Bridge session TTL'
			),
			allowInsecureHttp: options.allowInsecureHttp === true,
			protocolVersion,
			crypto: cryptoObject,
			now: options.now ?? unixNow,
		}
	}

	async issue(
		context: ManagedAuthExecutionContext,
		request: IntegrationAwareIssueRequest
	): Promise<IntegrationAwareManagedEmbedPolicyGrant> {
		if (!isRecord(request)) {
			throw new IntegrationAwareAuthorizationError(
				'Issue request is invalid',
				IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
			)
		}
		const nowSeconds = this.now()
		const actor = normalizeActor(context?.actor)
		const subject = normalizeSubject(context?.subject, nowSeconds)
		const registered = await this.resolveRegisteredIntegration(request.integrationId)
		this.assertActor(actor, registered, 'parent-bff')
		const allowHttp = this.allowHttp(registered.integration)
		const parentOrigin = exactOrigin(request.parentOrigin, 'Parent origin', allowHttp)
		const assistantOrigin = exactOrigin(request.assistantOrigin, 'Assistant origin', allowHttp)
		this.assertOrigins(registered, parentOrigin, assistantOrigin, allowHttp)
		const scopeId = identifier(request.scopeId, 'Scope')
		if (scopeId !== registered.integration.scopeId) {
			throw new IntegrationAwareAuthorizationError(
				'Scope does not match the Integration',
				IntegrationAwareAuthorizationErrorCode.SCOPE_MISMATCH
			)
		}
		const capabilities = normalizeCapabilities(
			request.capabilities,
			new Set(registered.integration.maxCapabilities),
			IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
		)
		const bridgeBinding = normalizeBinding(request.bridgeBinding)
		const parentSessionBinding = identifier(request.parentSessionBinding, 'Parent session binding')
		const childFrames = this.normalizeChildFrames(
			request.childFrames,
			registered.integration,
			new Set(capabilities),
			allowHttp
		)
		const policyTtlSeconds = Math.min(
			this.config.policyTtlSeconds,
			registered.integration.maxPolicyTtlSeconds ?? MAX_POLICY_TTL_SECONDS
		)
		const bridgeSessionTtlSeconds = Math.min(
			this.config.bridgeSessionTtlSeconds,
			registered.integration.maxBridgeSessionTtlSeconds ?? MAX_BRIDGE_SESSION_TTL_SECONDS
		)
		const policyExpiresAt = nowSeconds + policyTtlSeconds
		const subjectSessionExpiresAt = subject.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER
		const bridgeSessionExpiresAt = Math.min(
			nowSeconds + bridgeSessionTtlSeconds,
			subjectSessionExpiresAt
		)
		if (bridgeSessionExpiresAt <= policyExpiresAt) {
			throw new IntegrationAwareAuthorizationError(
				'Authenticated P session is too short for the configured bridge lifetime',
				IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
			)
		}
		const claims: IntegrationAwareManagedEmbedPolicyClaims = {
			jti: randomOpaqueValue(this.config.crypto, MANAGED_EMBED_POLICY_ID_PREFIX),
			// Legacy Host claims require these keys, but identity remains in the
			// server-side record and must not be returned to the P browser.
			tenant: BROWSER_SUBJECT_PLACEHOLDER,
			user: BROWSER_SUBJECT_PLACEHOLDER,
			targetId: identifier(request.targetId, 'Target'),
			scopeId,
			parentOrigin,
			assistantOrigin,
			cap: capabilities,
			protocolVersionMin: this.config.protocolVersion,
			protocolVersionMax: this.config.protocolVersion,
			nbf: nowSeconds,
			exp: policyExpiresAt,
			iss: this.config.issuer,
			aud: this.config.audience,
			integrationId: registered.integration.integrationId,
			parentAppId: registered.integration.parentAppId,
			assistantAppId: registered.integration.assistantAppId,
			configVersion: registered.integration.configVersion,
			bridgeBinding,
			bridgeSessionExp: bridgeSessionExpiresAt,
			...(childFrames === undefined ? {} : { childFrames }),
		}
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const policy = randomOpaqueValue(this.config.crypto, MANAGED_EMBED_POLICY_PREFIX)
			const digest = await digestPolicy(policy, this.config.crypto)
			const stored = await this.config.store.putIfAbsent(
				digest,
				{
					claims,
					environment: registered.integration.environment,
					parentSubject: subject,
					parentSessionBinding,
					state: 'ISSUED',
				},
				bridgeSessionExpiresAt
			)
			if (stored) return { policy, claims: cloneClaims(claims) }
		}
		throw new IntegrationAwareAuthorizationError(
			'Could not reserve an opaque policy',
			IntegrationAwareAuthorizationErrorCode.INTERNAL_ERROR
		)
	}

	async exchange(
		context: ManagedAuthExecutionContext,
		request: IntegrationAwareExchangeRequest
	): Promise<IntegrationAwareAuthorizationDecision> {
		if (!isRecord(request) || !isOpaquePolicy(request.policy)) {
			throw new IntegrationAwareAuthorizationError(
				'Exchange request or policy is invalid',
				IntegrationAwareAuthorizationErrorCode.POLICY_INVALID
			)
		}
		const nowSeconds = this.now()
		const actor = normalizeActor(context?.actor)
		const subject = normalizeSubject(context?.subject, nowSeconds)
		const digest = await digestPolicy(request.policy, this.config.crypto)
		const candidate = await this.config.store.get(digest, nowSeconds)
		if (!candidate) this.policyUnavailable()
		const record = candidate as IntegrationAwareAuthorizationRecord
		const registered = await this.resolveRegisteredIntegration(record.claims.integrationId)
		this.assertActor(actor, registered, 'assistant-bff')
		if (record.claims.configVersion !== registered.integration.configVersion) {
			throw new IntegrationAwareAuthorizationError(
				'Integration configuration changed before exchange',
				IntegrationAwareAuthorizationErrorCode.INTEGRATION_DENIED
			)
		}
		if (!sameSubject(record.parentSubject, subject)) {
			throw new IntegrationAwareAuthorizationError(
				'P and A canonical subjects do not match',
				IntegrationAwareAuthorizationErrorCode.SUBJECT_MISMATCH
			)
		}
		const allowHttp = this.allowHttp(registered.integration)
		const parentOrigin = exactOrigin(request.actualParentOrigin, 'Actual parent origin', allowHttp)
		const assistantOrigin = exactOrigin(
			request.actualAssistantOrigin,
			'Actual assistant origin',
			allowHttp
		)
		this.assertOrigins(registered, parentOrigin, assistantOrigin, allowHttp)
		const offer = request.offer
		if (!isRecord(offer)) {
			throw new IntegrationAwareAuthorizationError(
				'Offer is invalid',
				IntegrationAwareAuthorizationErrorCode.OFFER_MISMATCH
			)
		}
		const bridgeBinding = normalizeBinding(offer)
		const policyId = identifier(offer.policyId, 'Offer policy id')
		const capabilities = normalizeCapabilities(
			offer.capabilities,
			new Set(registered.integration.maxCapabilities),
			IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
		)
		if (
			policyId !== record.claims.jti ||
			parentOrigin !== record.claims.parentOrigin ||
			assistantOrigin !== record.claims.assistantOrigin ||
			!sameBinding(bridgeBinding, record.claims.bridgeBinding) ||
			capabilities.some((capability) => !record.claims.cap.includes(capability))
		) {
			throw new IntegrationAwareAuthorizationError(
				'Offer does not match the issued Grant',
				IntegrationAwareAuthorizationErrorCode.OFFER_MISMATCH
			)
		}
		const leaseTtlSeconds = Math.min(
			ACTIVE_LEASE_TTL_SECONDS,
			this.config.bridgeSessionTtlSeconds,
			registered.integration.maxBridgeSessionTtlSeconds ?? MAX_BRIDGE_SESSION_TTL_SECONDS
		)
		const leaseExpiresAt = Math.min(
			nowSeconds + leaseTtlSeconds,
			record.claims.bridgeSessionExp,
			subject.credentialExpiresAt ?? Number.MAX_SAFE_INTEGER
		)
		if (leaseExpiresAt <= nowSeconds) this.policyUnavailable()
		const leaseChildFrames = record.claims.childFrames
			?.map((frame) => ({
				id: frame.id,
				origin: frame.origin,
				cap: frame.cap.filter((capability) =>
					capabilities.includes(capability as ParentControllerCapability)
				),
			}))
			.filter((frame) => frame.cap.length > 0)
		const activeLease: IntegrationAwareActiveLease = {
			leaseId: randomOpaqueValue(this.config.crypto, ACTIVE_LEASE_ID_PREFIX),
			policyId: record.claims.jti,
			state: 'ACTIVE',
			subject: cloneSubject(subject),
			environment: registered.integration.environment,
			integrationId: record.claims.integrationId,
			parentAppId: record.claims.parentAppId,
			assistantAppId: record.claims.assistantAppId,
			configVersion: record.claims.configVersion,
			parentOrigin,
			assistantOrigin,
			targetId: record.claims.targetId,
			scopeId: record.claims.scopeId,
			parentSessionBinding: record.parentSessionBinding,
			bridgeBinding: { ...bridgeBinding },
			capabilities: [...capabilities],
			...(leaseChildFrames === undefined ? {} : { childFrames: leaseChildFrames }),
			issuedAt: nowSeconds,
			expiresAt: leaseExpiresAt,
		}
		const consumed = await this.config.store.consumeAndCreateActiveLease(
			digest,
			{
				policyId,
				integrationId: record.claims.integrationId,
				configVersion: record.claims.configVersion,
				parentSubject: subject,
				parentOrigin,
				assistantOrigin,
				bridgeBinding,
				requestedCapabilities: capabilities,
			},
			activeLease,
			nowSeconds
		)
		if (!consumed) this.policyUnavailable()
		const createdLease = consumed.activeLease
		return {
			leaseId: createdLease.leaseId,
			leaseState: 'ACTIVE',
			leaseIssuedAt: createdLease.issuedAt,
			policyId: record.claims.jti,
			environment: registered.integration.environment,
			integrationId: record.claims.integrationId,
			parentAppId: record.claims.parentAppId,
			assistantAppId: record.claims.assistantAppId,
			configVersion: record.claims.configVersion,
			parentOrigin,
			assistantOrigin,
			subject: cloneSubject(subject),
			targetId: record.claims.targetId,
			scopeId: record.claims.scopeId,
			bridgeBinding: { ...bridgeBinding },
			capabilities,
			...(createdLease.childFrames === undefined
				? {}
				: {
						childFrames: createdLease.childFrames.map((frame) => ({
							id: frame.id,
							origin: frame.origin,
							cap: [...frame.cap],
						})),
					}),
			policyExpiresAt: record.claims.exp,
			expiresAt: createdLease.expiresAt,
		}
	}

	async getActiveLeaseStatus(
		context: ManagedAuthExecutionContext,
		lookup: IntegrationAwareActiveLeaseLookup
	): Promise<BrowserActiveLeaseStatus> {
		if (!isRecord(lookup) || (lookup.leaseId === undefined && lookup.policyId === undefined)) {
			throw new IntegrationAwareAuthorizationError(
				'ActiveLease lookup is invalid',
				IntegrationAwareAuthorizationErrorCode.REQUEST_INVALID
			)
		}
		const normalizedLookup = {
			...(lookup.leaseId === undefined
				? {}
				: { leaseId: identifier(lookup.leaseId, 'ActiveLease id') }),
			...(lookup.policyId === undefined
				? {}
				: { policyId: identifier(lookup.policyId, 'Policy id') }),
			bridgeBinding: normalizeBinding(lookup.bridgeBinding),
		}
		const nowSeconds = this.now()
		const actor = normalizeActor(context?.actor)
		const subject = normalizeSubject(context?.subject, nowSeconds)
		const activeLease = await this.config.store.getActiveLease(normalizedLookup, nowSeconds)
		if (!activeLease) this.activeLeaseUnavailable()
		const lease = activeLease as IntegrationAwareActiveLease
		const registered = await this.resolveRegisteredIntegration(lease.integrationId)
		this.assertActor(actor, registered, actor.role)
		if (lease.configVersion !== registered.integration.configVersion) {
			await this.config.store.revoke({ leaseId: lease.leaseId }, nowSeconds)
			return {
				leaseId: lease.leaseId,
				policyId: lease.policyId,
				state: 'REVOKED',
				expiresAt: lease.expiresAt,
				checkedAt: nowSeconds,
			}
		}
		if (
			lease.environment !== registered.integration.environment ||
			lease.parentAppId !== registered.integration.parentAppId ||
			lease.assistantAppId !== registered.integration.assistantAppId ||
			!sameSubject(lease.subject, subject)
		) {
			this.activeLeaseUnavailable()
		}
		return {
			leaseId: lease.leaseId,
			policyId: lease.policyId,
			state: lease.state,
			expiresAt: lease.expiresAt,
			checkedAt: nowSeconds,
		}
	}

	async revoke(
		selector: IntegrationAwareRevocationSelector
	): Promise<IntegrationAwareRevocationResult> {
		return this.config.store.revoke(normalizeRevocationSelector(selector), this.now())
	}

	private now(): number {
		const value = this.config.now()
		if (!Number.isSafeInteger(value)) {
			throw new IntegrationAwareAuthorizationError(
				'Clock value is invalid',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		return value
	}

	private async resolveRegisteredIntegration(
		integrationIdValue: unknown
	): Promise<RegisteredIntegration> {
		const integrationId = identifier(integrationIdValue, 'Integration id')
		const integration = await this.config.registry.getIntegration(integrationId)
		if (!integration || integration.status !== 'enabled') {
			throw new IntegrationAwareAuthorizationError(
				'Integration is not enabled',
				IntegrationAwareAuthorizationErrorCode.INTEGRATION_DENIED
			)
		}
		if (!Number.isSafeInteger(integration.configVersion) || integration.configVersion < 1) {
			throw new IntegrationAwareAuthorizationError(
				'Integration config version is invalid',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		const transportMode = integration.transportMode ?? 'https-only'
		if (
			identifier(integration.integrationId, 'Registered Integration id') !== integrationId ||
			!['https-only', 'trusted-intranet-http'].includes(transportMode)
		) {
			throw new IntegrationAwareAuthorizationError(
				'Integration registration is invalid',
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		normalizeCapabilities(
			integration.maxCapabilities,
			new Set(PARENT_CONTROLLER_CAPABILITIES),
			IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
		)
		const childIds = new Set<string>()
		for (const target of integration.childTargets) {
			const childId = configIdentifier(target.childId, 'Registered child target id')
			if (childIds.has(childId)) {
				throw new IntegrationAwareAuthorizationError(
					'Registered child target ids must be unique',
					IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
				)
			}
			childIds.add(childId)
			normalizeCapabilities(
				target.maxCapabilities,
				CHILD_FRAME_CAPABILITIES,
				IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID
			)
		}
		const [parentApp, assistantApp] = await Promise.all([
			this.config.registry.getParentApp(integration.parentAppId),
			this.config.registry.getAssistantApp(integration.assistantAppId),
		])
		if (
			!parentApp ||
			!assistantApp ||
			parentApp.status !== 'enabled' ||
			assistantApp.status !== 'enabled' ||
			parentApp.environment !== integration.environment ||
			assistantApp.environment !== integration.environment
		) {
			throw new IntegrationAwareAuthorizationError(
				'Integration applications are not enabled in the same environment',
				IntegrationAwareAuthorizationErrorCode.INTEGRATION_DENIED
			)
		}
		return { integration, parentApp, assistantApp }
	}

	private assertActor(
		actor: AuthenticatedServiceActor,
		registered: RegisteredIntegration,
		expectedRole: 'parent-bff' | 'assistant-bff'
	): void {
		const app = expectedRole === 'parent-bff' ? registered.parentApp : registered.assistantApp
		const appId =
			expectedRole === 'parent-bff'
				? registered.integration.parentAppId
				: registered.integration.assistantAppId
		if (
			actor.role !== expectedRole ||
			actor.appId !== appId ||
			actor.environment !== registered.integration.environment ||
			!app.serviceActorIds.includes(actor.actorId)
		) {
			throw new IntegrationAwareAuthorizationError(
				'Service actor is not authorized for this operation',
				IntegrationAwareAuthorizationErrorCode.ACTOR_DENIED
			)
		}
	}

	private allowHttp(integration: ManagedAuthIntegration): boolean {
		return this.config.allowInsecureHttp && integration.transportMode === 'trusted-intranet-http'
	}

	private assertOrigins(
		registered: RegisteredIntegration,
		parentOrigin: string,
		assistantOrigin: string,
		allowHttp: boolean
	): void {
		const integrationParentOrigins = registered.integration.parentOrigins.map((origin) =>
			exactOrigin(origin, 'Integration parent origin', allowHttp)
		)
		const parentAppOrigins = registered.parentApp.origins.map((origin) =>
			exactOrigin(origin, 'Parent app origin', allowHttp)
		)
		const integrationAssistantOrigins = registered.integration.assistantOrigins.map((origin) =>
			exactOrigin(origin, 'Integration assistant origin', allowHttp)
		)
		const assistantAppOrigins = registered.assistantApp.origins.map((origin) =>
			exactOrigin(origin, 'Assistant app origin', allowHttp)
		)
		if (
			!integrationParentOrigins.includes(parentOrigin) ||
			!parentAppOrigins.includes(parentOrigin) ||
			!integrationAssistantOrigins.includes(assistantOrigin) ||
			!assistantAppOrigins.includes(assistantOrigin)
		) {
			throw new IntegrationAwareAuthorizationError(
				'Origin is outside the registered Integration',
				IntegrationAwareAuthorizationErrorCode.ORIGIN_MISMATCH
			)
		}
	}

	private normalizeChildFrames(
		value: IntegrationAwareIssueRequest['childFrames'],
		integration: ManagedAuthIntegration,
		parentCapabilities: ReadonlySet<string>,
		allowHttp: boolean
	): VerifiedEmbedPolicyChildFrameGrant[] | undefined {
		if (value === undefined) return undefined
		if (!Array.isArray(value) || value.length > MAX_CHILD_FRAME_GRANTS) {
			throw new IntegrationAwareAuthorizationError(
				'Child-frame Grants are invalid',
				IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
			)
		}
		const configured = new Map(integration.childTargets.map((target) => [target.childId, target]))
		const seen = new Set<string>()
		return value.map((entry) => {
			if (!isRecord(entry)) {
				throw new IntegrationAwareAuthorizationError(
					'Child-frame Grant is invalid',
					IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
				)
			}
			const id = identifier(entry.id, 'Child-frame id')
			const target = configured.get(id)
			if (!target || target.status !== 'enabled' || seen.has(id)) {
				throw new IntegrationAwareAuthorizationError(
					'Child-frame is not registered for the Integration',
					IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
				)
			}
			const origin = exactOrigin(entry.origin, 'Child-frame origin', allowHttp)
			const configuredOrigin = exactOrigin(
				target.origin,
				'Registered child-frame origin',
				allowHttp
			)
			if (origin !== configuredOrigin) {
				throw new IntegrationAwareAuthorizationError(
					'Child-frame origin does not match',
					IntegrationAwareAuthorizationErrorCode.ORIGIN_MISMATCH
				)
			}
			const capabilities = normalizeCapabilities(
				entry.cap,
				new Set(target.maxCapabilities),
				IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
			)
			if (
				capabilities.some(
					(capability) =>
						!CHILD_FRAME_CAPABILITIES.has(capability) || !parentCapabilities.has(capability)
				)
			) {
				throw new IntegrationAwareAuthorizationError(
					'Child-frame capability exceeds the parent Grant',
					IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED
				)
			}
			seen.add(id)
			return { id, origin, cap: capabilities }
		})
	}

	private policyUnavailable(): never {
		throw new IntegrationAwareAuthorizationError(
			'Policy is missing, expired, consumed, or revoked',
			IntegrationAwareAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED
		)
	}

	private activeLeaseUnavailable(): never {
		throw new IntegrationAwareAuthorizationError(
			'ActiveLease is missing or unavailable to this caller',
			IntegrationAwareAuthorizationErrorCode.ACTIVE_LEASE_NOT_FOUND_OR_DENIED
		)
	}
}

export function toBrowserAuthorizationContext(
	decision: IntegrationAwareAuthorizationDecision
): BrowserAuthorizationContext {
	return {
		leaseId: decision.leaseId,
		leaseState: decision.leaseState,
		leaseIssuedAt: decision.leaseIssuedAt,
		policyId: decision.policyId,
		integrationId: decision.integrationId,
		parentAppId: decision.parentAppId,
		assistantAppId: decision.assistantAppId,
		configVersion: decision.configVersion,
		parentOrigin: decision.parentOrigin,
		assistantOrigin: decision.assistantOrigin,
		targetId: decision.targetId,
		scopeId: decision.scopeId,
		sessionId: decision.bridgeBinding.sessionId,
		challenge: decision.bridgeBinding.challenge,
		hostInstanceId: decision.bridgeBinding.hostInstanceId,
		frameInstanceId: decision.bridgeBinding.frameInstanceId,
		capabilities: [...decision.capabilities],
		expiresAt: decision.expiresAt,
	}
}
