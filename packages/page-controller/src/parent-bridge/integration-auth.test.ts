import { webcrypto } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
	type AuthenticatedServiceActor,
	type CanonicalAuthSubject,
	createIntegrationAwareManagedEmbedAuthClient,
	InMemoryIntegrationAwareAuthorizationStore,
	InMemoryManagedEmbedAuthorizationRegistry,
	IntegrationAwareAuthorizationErrorCode,
	IntegrationAwareEmbedAuthorizationAuthority,
	type IntegrationAwareExchangeRequest,
	type IntegrationAwareIssueRequest,
	type ManagedAuthIntegration,
	toBrowserAuthorizationContext,
} from './integration-auth'

import type { ManagedAuthCrypto } from './managed-auth'

const nowSeconds = 1_700_000_000
const assistantOrigin = 'https://assistant.example.test'
const parentOneOrigin = 'https://parent-one.example.test'
const parentTwoOrigin = 'https://parent-two.example.test'
const businessOneOrigin = 'https://business-one.example.test'
const businessTwoOrigin = 'https://business-two.example.test'

const subject: CanonicalAuthSubject = {
	issuer: 'corp-sso',
	tenantId: 'tenant-a',
	userId: 'user-a',
	credentialExpiresAt: nowSeconds + 3_600,
}

const parentOneActor: AuthenticatedServiceActor = {
	actorId: 'parent-one-service',
	appId: 'parent-one',
	environment: 'test',
	role: 'parent-bff',
}

const parentTwoActor: AuthenticatedServiceActor = {
	actorId: 'parent-two-service',
	appId: 'parent-two',
	environment: 'test',
	role: 'parent-bff',
}

const assistantActor: AuthenticatedServiceActor = {
	actorId: 'assistant-service',
	appId: 'assistant',
	environment: 'test',
	role: 'assistant-bff',
}

const bridgeBinding = {
	sessionId: 'session-a',
	challenge: 'challenge-a',
	hostInstanceId: 'host-a',
	frameInstanceId: 'frame-a',
}

function integration(overrides: Partial<ManagedAuthIntegration> = {}): ManagedAuthIntegration {
	return {
		integrationId: 'parent-one-assistant',
		parentAppId: 'parent-one',
		assistantAppId: 'assistant',
		environment: 'test',
		scopeId: 'orders',
		parentOrigins: [parentOneOrigin],
		assistantOrigins: [assistantOrigin],
		maxCapabilities: ['observe', 'click', 'input', 'cleanup'],
		childTargets: [
			{
				childId: 'business-one',
				origin: businessOneOrigin,
				maxCapabilities: ['observe', 'click', 'cleanup'],
				status: 'enabled',
			},
		],
		configVersion: 1,
		status: 'enabled',
		...overrides,
	}
}

function registry(integrations: readonly ManagedAuthIntegration[] = [integration()]) {
	return new InMemoryManagedEmbedAuthorizationRegistry({
		assistantApps: [
			{
				assistantAppId: 'assistant',
				environment: 'test',
				origins: [assistantOrigin],
				serviceActorIds: ['assistant-service'],
				status: 'enabled',
			},
		],
		parentApps: [
			{
				parentAppId: 'parent-one',
				environment: 'test',
				origins: [parentOneOrigin],
				serviceActorIds: ['parent-one-service'],
				status: 'enabled',
			},
			{
				parentAppId: 'parent-two',
				environment: 'test',
				origins: [parentTwoOrigin],
				serviceActorIds: ['parent-two-service'],
				status: 'enabled',
			},
		],
		integrations,
	})
}

function authority(
	registryValue = registry(),
	store = new InMemoryIntegrationAwareAuthorizationStore(() => nowSeconds),
	overrides: Partial<
		ConstructorParameters<typeof IntegrationAwareEmbedAuthorizationAuthority>[0]
	> = {}
) {
	return new IntegrationAwareEmbedAuthorizationAuthority({
		registry: registryValue,
		store,
		issuer: 'page-agent-auth',
		crypto: webcrypto as unknown as ManagedAuthCrypto,
		now: () => nowSeconds,
		...overrides,
	})
}

function issueRequest(
	overrides: Partial<IntegrationAwareIssueRequest> = {}
): IntegrationAwareIssueRequest {
	return {
		integrationId: 'parent-one-assistant',
		targetId: 'order-1',
		scopeId: 'orders',
		parentOrigin: parentOneOrigin,
		assistantOrigin,
		capabilities: ['observe', 'click', 'cleanup'],
		childFrames: [
			{
				id: 'business-one',
				origin: businessOneOrigin,
				cap: ['observe', 'click', 'cleanup'],
			},
		],
		bridgeBinding,
		parentSessionBinding: 'p-session-digest',
		...overrides,
	}
}

function exchangeRequest(
	grant: Awaited<ReturnType<IntegrationAwareEmbedAuthorizationAuthority['issue']>>,
	overrides: Partial<IntegrationAwareExchangeRequest> = {}
): IntegrationAwareExchangeRequest {
	return {
		policy: grant.policy,
		actualParentOrigin: parentOneOrigin,
		actualAssistantOrigin: assistantOrigin,
		offer: {
			policyId: grant.claims.jti,
			...bridgeBinding,
			capabilities: ['observe', 'click'],
		},
		...overrides,
	}
}

describe('integration-aware parent-bridge authorization', () => {
	it('issues a pre-bound Grant and exchanges it into separate server and browser contexts', async () => {
		const service = authority()
		const grant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		expect(grant.claims).toMatchObject({
			integrationId: 'parent-one-assistant',
			parentAppId: 'parent-one',
			assistantAppId: 'assistant',
			bridgeBinding,
		})
		expect(grant.claims.tenant).not.toBe(subject.tenantId)
		expect(grant.claims.user).not.toBe(subject.userId)
		expect(grant.claims.bridgeSessionExp).toBeGreaterThan(grant.claims.exp)

		const decision = await service.exchange(
			{ actor: assistantActor, subject },
			exchangeRequest(grant)
		)
		expect(decision.subject).toEqual(subject)
		const browserContext = toBrowserAuthorizationContext(decision)
		expect(browserContext).toMatchObject({
			integrationId: 'parent-one-assistant',
			parentAppId: 'parent-one',
			sessionId: bridgeBinding.sessionId,
		})
		expect(browserContext).not.toHaveProperty('subject')
		expect(browserContext).not.toHaveProperty('parentSessionBinding')
	})

	it('rejects a different A subject without consuming the valid policy', async () => {
		const service = authority()
		const grant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		await expect(
			service.exchange(
				{ actor: assistantActor, subject: { ...subject, userId: 'user-b' } },
				exchangeRequest(grant)
			)
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.SUBJECT_MISMATCH })
		await expect(
			service.exchange({ actor: assistantActor, subject }, exchangeRequest(grant))
		).resolves.toMatchObject({ policyId: grant.claims.jti })
	})

	it('enforces caller direction and application service identity', async () => {
		const service = authority()
		await expect(
			service.issue({ actor: assistantActor, subject }, issueRequest())
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.ACTOR_DENIED })

		const grant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		await expect(
			service.exchange({ actor: parentTwoActor, subject }, exchangeRequest(grant))
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.ACTOR_DENIED })
	})

	it('isolates each P Integration and enforces its registered B maximum', async () => {
		const parentTwoIntegration = integration({
			integrationId: 'parent-two-assistant',
			parentAppId: 'parent-two',
			parentOrigins: [parentTwoOrigin],
			childTargets: [
				{
					childId: 'business-two',
					origin: businessTwoOrigin,
					maxCapabilities: ['observe'],
					status: 'enabled',
				},
			],
		})
		const service = authority(registry([integration(), parentTwoIntegration]))
		await expect(
			service.issue(
				{ actor: parentTwoActor, subject },
				issueRequest({
					integrationId: 'parent-two-assistant',
					parentOrigin: parentTwoOrigin,
					childFrames: [{ id: 'business-one', origin: businessOneOrigin, cap: ['observe'] }],
				})
			)
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.CAPABILITY_DENIED })
	})

	it('fails closed when registered child capabilities are invalid', async () => {
		const invalidIntegration = integration({
			childTargets: [
				{
					childId: 'business-one',
					origin: businessOneOrigin,
					maxCapabilities: ['observe', 'visual'],
					status: 'enabled',
				},
			],
		})
		await expect(
			authority(registry([invalidIntegration])).issue(
				{ actor: parentOneActor, subject },
				issueRequest()
			)
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.CONFIG_INVALID })
	})

	it('rejects exchange after the Integration config version changes', async () => {
		const registryValue = registry()
		const service = authority(registryValue)
		const grant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		registryValue.setIntegration(integration({ configVersion: 2 }))
		await expect(
			service.exchange({ actor: assistantActor, subject }, exchangeRequest(grant))
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.INTEGRATION_DENIED })
	})

	it('atomically consumes once and supports targeted revocation', async () => {
		const service = authority()
		const grant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		const results = await Promise.allSettled([
			service.exchange({ actor: assistantActor, subject }, exchangeRequest(grant)),
			service.exchange({ actor: assistantActor, subject }, exchangeRequest(grant)),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)

		const revokedGrant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		expect(await service.revoke({ policyId: revokedGrant.claims.jti })).toBe(1)
		await expect(
			service.exchange({ actor: assistantActor, subject }, exchangeRequest(revokedGrant))
		).rejects.toMatchObject({
			code: IntegrationAwareAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED,
		})
	})

	it('requires both authority and Integration opt-in for intranet HTTP', async () => {
		const httpParent = 'http://parent.intranet.test:8080'
		const httpAssistant = 'http://assistant.intranet.test:8081'
		const httpIntegration = integration({
			parentOrigins: [httpParent],
			assistantOrigins: [httpAssistant],
			transportMode: 'trusted-intranet-http',
		})
		const registryValue = new InMemoryManagedEmbedAuthorizationRegistry({
			assistantApps: [
				{
					assistantAppId: 'assistant',
					environment: 'test',
					origins: [httpAssistant],
					serviceActorIds: ['assistant-service'],
					status: 'enabled',
				},
			],
			parentApps: [
				{
					parentAppId: 'parent-one',
					environment: 'test',
					origins: [httpParent],
					serviceActorIds: ['parent-one-service'],
					status: 'enabled',
				},
			],
			integrations: [httpIntegration],
		})
		await expect(
			authority(registryValue).issue(
				{ actor: parentOneActor, subject },
				issueRequest({ parentOrigin: httpParent, assistantOrigin: httpAssistant, childFrames: [] })
			)
		).rejects.toMatchObject({ code: IntegrationAwareAuthorizationErrorCode.ORIGIN_MISMATCH })
		await expect(
			authority(registryValue, undefined, { allowInsecureHttp: true }).issue(
				{ actor: parentOneActor, subject },
				issueRequest({ parentOrigin: httpParent, assistantOrigin: httpAssistant, childFrames: [] })
			)
		).resolves.toMatchObject({ claims: { parentOrigin: httpParent } })
	})

	it('binds the same-origin browser client request and returns verified Integration claims once', async () => {
		const service = authority()
		const grant = await service.issue({ actor: parentOneActor, subject }, issueRequest())
		const fetchCall = vi.fn()
		const client = createIntegrationAwareManagedEmbedAuthClient({
			endpoint: `${parentOneOrigin}/api/parent-bridge/embed-policy`,
			runtimeOrigin: parentOneOrigin,
			expectedIntegrationId: 'parent-one-assistant',
			expectedParentAppId: 'parent-one',
			expectedAssistantAppId: 'assistant',
			expectedParentOrigin: parentOneOrigin,
			expectedAssistantOrigin: assistantOrigin,
			expectedScopeId: 'orders',
			expectedIssuer: 'page-agent-auth',
			allowedCapabilities: ['observe', 'click', 'cleanup'],
			fetchImpl: async (_input, init) => {
				fetchCall(init)
				return { ok: true, json: async () => grant } as Response
			},
			now: () => nowSeconds,
		})
		const abortController = new AbortController()
		const requestContext = {
			...bridgeBinding,
			parentOrigin: parentOneOrigin,
			assistantOrigin,
			scopeId: 'orders',
			capabilities: ['observe', 'click', 'cleanup'] as const,
			signal: abortController.signal,
		}
		const policy = await client.getEmbedPolicy(requestContext)
		const requestBody = JSON.parse(fetchCall.mock.calls[0][0].body as string)
		expect(requestBody).toMatchObject({
			integrationId: 'parent-one-assistant',
			bridgeBinding,
		})
		expect(requestBody).not.toHaveProperty('subject')
		expect(
			client.verifyEmbedPolicy(policy, {
				actualParentOrigin: parentOneOrigin,
				assistantOrigin,
				scopeId: 'orders',
				capabilities: ['observe', 'click'],
				frameContext: { parentOrigin: parentOneOrigin, assistantOrigin, directChild: true },
			})
		).toMatchObject({ integrationId: 'parent-one-assistant', bridgeBinding })
		expect(
			client.verifyEmbedPolicy(policy, {
				actualParentOrigin: parentOneOrigin,
				assistantOrigin,
			})
		).toBe(false)
	})
})
