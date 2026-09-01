import type {
	ParentControllerBridgeBinding,
	ParentControllerCapability,
	VerifiedEmbedPolicyChildFrameGrant,
	VerifiedEmbedPolicyClaims,
} from './protocol'

export type ManagedAuthRegistrationStatus = 'enabled' | 'disabled'
export type ManagedAuthServiceRole = 'parent-bff' | 'assistant-bff'
export type ManagedAuthGrantState = 'ISSUED' | 'CONSUMED' | 'REVOKED'
export type ManagedAuthActiveLeaseState = 'ACTIVE' | 'REVOKED' | 'EXPIRED'
export type ManagedAuthTransportMode = 'https-only' | 'trusted-intranet-http'

/** Canonical user identity produced by a trusted BFF after its own SSO validation. */
export interface CanonicalAuthSubject {
	readonly issuer: string
	readonly tenantId: string
	readonly userId: string
	readonly authenticatedAt?: number
	readonly credentialExpiresAt?: number
}

/** Workload identity produced by the Auth service transport or gateway. */
export interface AuthenticatedServiceActor {
	readonly actorId: string
	readonly appId: string
	readonly environment: string
	readonly role: ManagedAuthServiceRole
}

export interface ManagedAuthExecutionContext {
	readonly actor: AuthenticatedServiceActor
	readonly subject: CanonicalAuthSubject
}

export interface ManagedAuthAssistantApp {
	readonly assistantAppId: string
	readonly environment: string
	readonly origins: readonly string[]
	readonly serviceActorIds: readonly string[]
	readonly status: ManagedAuthRegistrationStatus
}

export interface ManagedAuthParentApp {
	readonly parentAppId: string
	readonly environment: string
	readonly origins: readonly string[]
	readonly serviceActorIds: readonly string[]
	readonly status: ManagedAuthRegistrationStatus
}

export interface ManagedAuthChildTarget {
	readonly childId: string
	readonly origin: string
	readonly maxCapabilities: readonly ParentControllerCapability[]
	readonly status: ManagedAuthRegistrationStatus
}

export interface ManagedAuthIntegration {
	readonly integrationId: string
	readonly parentAppId: string
	readonly assistantAppId: string
	readonly environment: string
	readonly scopeId: string
	readonly parentOrigins: readonly string[]
	readonly assistantOrigins: readonly string[]
	readonly maxCapabilities: readonly ParentControllerCapability[]
	readonly childTargets: readonly ManagedAuthChildTarget[]
	readonly configVersion: number
	readonly status: ManagedAuthRegistrationStatus
	readonly transportMode?: ManagedAuthTransportMode
	readonly maxPolicyTtlSeconds?: number
	readonly maxBridgeSessionTtlSeconds?: number
}

export interface ManagedEmbedAuthorizationRegistry {
	getAssistantApp(assistantAppId: string): Promise<ManagedAuthAssistantApp | null>
	getParentApp(parentAppId: string): Promise<ManagedAuthParentApp | null>
	getIntegration(integrationId: string): Promise<ManagedAuthIntegration | null>
}

export interface IntegrationAwareManagedEmbedPolicyClaims extends VerifiedEmbedPolicyClaims {
	/** `tenant`/`user` inherited from the legacy Host shape are redacted placeholders. */
	readonly iss: string
	readonly aud: string
	readonly integrationId: string
	readonly parentAppId: string
	readonly assistantAppId: string
	readonly configVersion: number
	readonly bridgeBinding: ParentControllerBridgeBinding
	readonly bridgeSessionExp: number
}

export interface IntegrationAwareChildFrameGrantInput {
	readonly id: string
	readonly origin: string
	readonly cap: readonly ParentControllerCapability[]
}

export interface IntegrationAwareIssueRequest {
	readonly integrationId: string
	readonly targetId: string
	readonly scopeId: string
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly childFrames?: readonly IntegrationAwareChildFrameGrantInput[]
	readonly bridgeBinding: ParentControllerBridgeBinding
	/** Opaque digest/reference derived by P BFF; never use a raw browser session token. */
	readonly parentSessionBinding: string
}

export interface IntegrationAwareAuthorizationOffer extends ParentControllerBridgeBinding {
	readonly policyId: string
	readonly capabilities: readonly ParentControllerCapability[]
}

export interface IntegrationAwareExchangeRequest {
	readonly policy: string
	readonly actualParentOrigin: string
	readonly actualAssistantOrigin: string
	readonly offer: IntegrationAwareAuthorizationOffer
}

export interface IntegrationAwareManagedEmbedPolicyGrant {
	readonly policy: string
	readonly claims: IntegrationAwareManagedEmbedPolicyClaims
}

export interface IntegrationAwareAuthorizationRecord {
	readonly claims: IntegrationAwareManagedEmbedPolicyClaims
	readonly environment: string
	readonly parentSubject: CanonicalAuthSubject
	readonly parentSessionBinding: string
	readonly state: ManagedAuthGrantState
	readonly consumedAt?: number
	readonly revokedAt?: number
}

/** Server-side runtime authorization created atomically with Grant consumption. */
export interface IntegrationAwareActiveLease {
	readonly leaseId: string
	readonly policyId: string
	readonly state: ManagedAuthActiveLeaseState
	readonly subject: CanonicalAuthSubject
	readonly environment: string
	readonly integrationId: string
	readonly parentAppId: string
	readonly assistantAppId: string
	readonly configVersion: number
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly targetId: string
	readonly scopeId: string
	readonly parentSessionBinding: string
	readonly bridgeBinding: ParentControllerBridgeBinding
	readonly capabilities: readonly ParentControllerCapability[]
	readonly childFrames?: readonly VerifiedEmbedPolicyChildFrameGrant[]
	readonly issuedAt: number
	readonly expiresAt: number
	readonly revokedAt?: number
	readonly expiredAt?: number
}

export interface IntegrationAwareConsumeExpectation {
	readonly policyId: string
	readonly integrationId: string
	readonly configVersion: number
	readonly parentSubject: CanonicalAuthSubject
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly bridgeBinding: ParentControllerBridgeBinding
	readonly requestedCapabilities: readonly ParentControllerCapability[]
}

export interface IntegrationAwareRevocationSelector {
	readonly leaseId?: string
	readonly policyId?: string
	readonly environment?: string
	readonly integrationId?: string
	readonly parentAppId?: string
	readonly assistantAppId?: string
	readonly configVersion?: number
	readonly subject?: CanonicalAuthSubject
	readonly parentSessionBinding?: string
	readonly scopeId?: string
	readonly targetId?: string
	readonly bridgeSessionId?: string
	readonly hostInstanceId?: string
	readonly frameInstanceId?: string
}

export interface IntegrationAwareActiveLeaseLookup {
	readonly leaseId?: string
	readonly policyId?: string
	readonly bridgeBinding: ParentControllerBridgeBinding
}

export interface IntegrationAwareConsumeAndCreateLeaseResult {
	readonly authorization: IntegrationAwareAuthorizationRecord
	readonly activeLease: IntegrationAwareActiveLease
}

export interface IntegrationAwareRevocationResult {
	readonly grantsRevoked: number
	readonly activeLeasesRevoked: number
	readonly totalRevoked: number
}

/** Browser-safe status returned by a same-origin P or A BFF. */
export interface BrowserActiveLeaseStatus {
	readonly leaseId: string
	readonly policyId: string
	readonly state: ManagedAuthActiveLeaseState
	readonly expiresAt: number
	readonly checkedAt: number
}

/**
 * Production implementations must make Grant consumption plus ActiveLease
 * creation one atomic operation across Auth replicas. Revocation must also use
 * conditional atomic updates and terminal records must be retained long enough
 * for polling and replay diagnostics.
 */
export interface IntegrationAwareAuthorizationStore {
	putIfAbsent(
		policyDigest: string,
		record: IntegrationAwareAuthorizationRecord,
		expiresAt: number
	): Promise<boolean>
	get(policyDigest: string, nowSeconds: number): Promise<IntegrationAwareAuthorizationRecord | null>
	consumeAndCreateActiveLease(
		policyDigest: string,
		expected: IntegrationAwareConsumeExpectation,
		activeLease: IntegrationAwareActiveLease,
		nowSeconds: number
	): Promise<IntegrationAwareConsumeAndCreateLeaseResult | null>
	getActiveLease(
		lookup: IntegrationAwareActiveLeaseLookup,
		nowSeconds: number
	): Promise<IntegrationAwareActiveLease | null>
	/** At least one selector field is required; an empty selector must be rejected. */
	revoke(
		selector: IntegrationAwareRevocationSelector,
		nowSeconds: number
	): Promise<IntegrationAwareRevocationResult>
}

export interface IntegrationAwareAuthorizationDecision {
	readonly leaseId: string
	readonly leaseState: 'ACTIVE'
	readonly leaseIssuedAt: number
	readonly policyId: string
	readonly environment: string
	readonly integrationId: string
	readonly parentAppId: string
	readonly assistantAppId: string
	readonly configVersion: number
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly subject: CanonicalAuthSubject
	readonly targetId: string
	readonly scopeId: string
	readonly bridgeBinding: ParentControllerBridgeBinding
	readonly capabilities: readonly ParentControllerCapability[]
	readonly childFrames?: readonly VerifiedEmbedPolicyChildFrameGrant[]
	readonly policyExpiresAt: number
	readonly expiresAt: number
}

/** Safe subset that an A BFF may return to its own browser runtime. */
export interface BrowserAuthorizationContext {
	readonly leaseId: string
	readonly leaseState: 'ACTIVE'
	readonly leaseIssuedAt: number
	readonly policyId: string
	readonly integrationId: string
	readonly parentAppId: string
	readonly assistantAppId: string
	readonly configVersion: number
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly targetId: string
	readonly scopeId: string
	readonly sessionId: string
	readonly challenge: string
	readonly hostInstanceId: string
	readonly frameInstanceId: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly expiresAt: number
}
