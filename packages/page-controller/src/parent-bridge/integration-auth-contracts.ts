import type {
	ParentControllerBridgeBinding,
	ParentControllerCapability,
	VerifiedEmbedPolicyChildFrameGrant,
	VerifiedEmbedPolicyClaims,
} from './protocol'

export type ManagedAuthRegistrationStatus = 'enabled' | 'disabled'
export type ManagedAuthServiceRole = 'parent-bff' | 'assistant-bff'
export type ManagedAuthGrantState = 'ISSUED' | 'CONSUMED' | 'REVOKED'
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
	readonly parentSessionBinding?: string
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
	readonly parentSubject: CanonicalAuthSubject
	readonly parentSessionBinding?: string
	readonly state: ManagedAuthGrantState
	readonly consumedAt?: number
	readonly revokedAt?: number
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
	readonly policyId?: string
	readonly integrationId?: string
	readonly subject?: CanonicalAuthSubject
	readonly parentSessionBinding?: string
}

/**
 * Production implementations must make consume and revoke atomic across Auth
 * replicas and retain state until the record TTL for replay diagnostics.
 */
export interface IntegrationAwareAuthorizationStore {
	putIfAbsent(
		policyDigest: string,
		record: IntegrationAwareAuthorizationRecord,
		expiresAt: number
	): Promise<boolean>
	get(policyDigest: string, nowSeconds: number): Promise<IntegrationAwareAuthorizationRecord | null>
	consume(
		policyDigest: string,
		expected: IntegrationAwareConsumeExpectation,
		nowSeconds: number
	): Promise<IntegrationAwareAuthorizationRecord | null>
	revoke(selector: IntegrationAwareRevocationSelector, nowSeconds: number): Promise<number>
}

export interface IntegrationAwareAuthorizationDecision {
	readonly policyId: string
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
