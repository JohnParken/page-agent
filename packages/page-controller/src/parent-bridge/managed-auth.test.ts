import { webcrypto } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import {
	InMemoryOpaqueEmbedAuthorizationStore,
	MANAGED_EMBED_POLICY_ID_PREFIX,
	MANAGED_EMBED_POLICY_PREFIX,
	type ManagedAuthCrypto,
	ManagedEmbedAuthClient,
	ManagedEmbedAuthorizationErrorCode,
	type ManagedEmbedAuthorizationExchangeRequest,
	type ManagedEmbedAuthorizationOffer,
	type ManagedEmbedPolicyGrant,
	type ManagedEmbedPolicyIssueRequest,
	OpaqueEmbedAuthorizationService,
} from './managed-auth'

const parentOrigin = 'https://parent.example.test'
const assistantOrigin = 'https://assistant.example.test'
const scopeId = 'orders'
const issuer = 'https://issuer.example.test'
const audience = 'managed-parent-bridge'

let nowSeconds = 1_700_000_000

function request(
	overrides: Partial<ManagedEmbedPolicyIssueRequest> = {}
): ManagedEmbedPolicyIssueRequest {
	return {
		tenant: 'tenant-a',
		user: 'user-a',
		targetId: 'target-a',
		scopeId,
		parentOrigin,
		assistantOrigin,
		capabilities: ['observe', 'click', 'input'],
		...overrides,
	}
}

function createService(
	options: Partial<ConstructorParameters<typeof OpaqueEmbedAuthorizationService>[0]> = {}
) {
	const store = options.store ?? new InMemoryOpaqueEmbedAuthorizationStore(() => nowSeconds)
	return new OpaqueEmbedAuthorizationService({
		store,
		assistantOrigin,
		allowedParentOrigins: [parentOrigin],
		scopeId,
		issuer,
		audience,
		crypto: webcrypto as unknown as ManagedAuthCrypto,
		now: () => nowSeconds,
		...options,
	})
}

function context(overrides: Record<string, unknown> = {}) {
	return {
		actualParentOrigin: parentOrigin,
		assistantOrigin,
		frameContext: {
			parentOrigin,
			assistantOrigin,
			directChild: true,
		},
		...overrides,
	}
}

function offer(
	grant: ManagedEmbedPolicyGrant,
	overrides: Record<string, unknown> = {}
): ManagedEmbedAuthorizationOffer {
	return {
		policyId: grant.claims.jti,
		sessionId: 'session-a',
		challenge: 'challenge-a',
		frameInstanceId: 'frame-a',
		hostInstanceId: 'host-a',
		capabilities: ['observe', 'click'],
		...overrides,
	} as ManagedEmbedAuthorizationOffer
}

function clientResponse(grant: ManagedEmbedPolicyGrant, overrides: Record<string, unknown> = {}) {
	return { policy: grant.policy, claims: grant.claims, ...overrides }
}

function createClient(response: unknown) {
	const fetchImpl: typeof fetch = async (_input, init) => {
		return {
			ok: true,
			json: async () => response,
		} as Response
	}
	return new ManagedEmbedAuthClient({
		endpoint: `${parentOrigin}/api/parent-bridge/embed-policy`,
		runtimeOrigin: parentOrigin,
		expectedParentOrigin: parentOrigin,
		expectedAssistantOrigin: assistantOrigin,
		expectedScopeId: scopeId,
		expectedIssuer: issuer,
		expectedAudience: audience,
		fetchImpl,
		now: () => nowSeconds,
	})
}

describe('managed opaque parent-bridge authorization', () => {
	it('requires an explicit opt-in before accepting exact intranet HTTP origins', async () => {
		const httpParentOrigin = 'http://parent.intranet.test:8080'
		const httpAssistantOrigin = 'http://assistant.intranet.test:8081'
		const httpBusinessOrigin = 'http://business.intranet.test:8082'
		const serviceOptions = {
			store: new InMemoryOpaqueEmbedAuthorizationStore(() => nowSeconds),
			assistantOrigin: httpAssistantOrigin,
			allowedParentOrigins: [httpParentOrigin],
			scopeId,
			allowedCapabilities: ['observe', 'click'] as const,
			crypto: webcrypto as unknown as ManagedAuthCrypto,
			now: () => nowSeconds,
		}

		expect(() => new OpaqueEmbedAuthorizationService(serviceOptions)).toThrow(/HTTPS/)
		expect(
			() =>
				new ManagedEmbedAuthClient({
					endpoint: `${httpParentOrigin}/api/parent-bridge/embed-policy`,
					runtimeOrigin: httpParentOrigin,
					expectedParentOrigin: httpParentOrigin,
					expectedAssistantOrigin: httpAssistantOrigin,
					expectedScopeId: scopeId,
				})
		).toThrow(/HTTPS/)

		const service = new OpaqueEmbedAuthorizationService({
			...serviceOptions,
			allowInsecureHttp: true,
		})
		const grant = await service.issue({
			...request(),
			parentOrigin: httpParentOrigin,
			assistantOrigin: httpAssistantOrigin,
			capabilities: ['observe', 'click'],
			childFrames: [{ id: 'business', origin: httpBusinessOrigin, cap: ['observe'] }],
		})
		const fetchImpl: typeof fetch = async () =>
			({ ok: true, json: async () => clientResponse(grant) }) as Response
		const client = new ManagedEmbedAuthClient({
			endpoint: `${httpParentOrigin}/api/parent-bridge/embed-policy`,
			runtimeOrigin: httpParentOrigin,
			allowInsecureHttp: true,
			expectedParentOrigin: httpParentOrigin,
			expectedAssistantOrigin: httpAssistantOrigin,
			expectedScopeId: scopeId,
			allowedCapabilities: ['observe', 'click'],
			fetchImpl,
			now: () => nowSeconds,
		})

		const policy = await client.getEmbedPolicy()
		expect(
			client.verifyEmbedPolicy(policy, {
				actualParentOrigin: httpParentOrigin,
				assistantOrigin: httpAssistantOrigin,
				frameContext: {
					parentOrigin: httpParentOrigin,
					assistantOrigin: httpAssistantOrigin,
					directChild: true,
				},
			})
		).toMatchObject({
			parentOrigin: httpParentOrigin,
			assistantOrigin: httpAssistantOrigin,
			childFrames: [{ id: 'business', origin: httpBusinessOrigin, cap: ['observe'] }],
		})
	})

	it('issues a prefixed opaque policy, stores only its digest, and exchanges it once', async () => {
		const store = new InMemoryOpaqueEmbedAuthorizationStore(() => nowSeconds)
		const service = createService({ store })
		const grant = await service.issue(request())

		expect(grant.policy.startsWith(MANAGED_EMBED_POLICY_PREFIX)).toBe(true)
		expect(grant.policy).not.toContain('.')
		expect(grant.policy.length).toBeGreaterThanOrEqual(MANAGED_EMBED_POLICY_PREFIX.length + 43)
		expect(grant.claims.jti.startsWith(MANAGED_EMBED_POLICY_ID_PREFIX)).toBe(true)

		const internalStore = store as unknown as {
			entries: Map<string, { record: unknown; expiresAt: number }>
		}
		expect([...internalStore.entries.keys()]).not.toContain(grant.policy)
		expect(JSON.stringify([...internalStore.entries.values()])).not.toContain(grant.policy)

		const authorizationContext = await service.exchange({
			policy: grant.policy,
			actualParentOrigin: parentOrigin,
			offer: offer(grant),
		})
		expect(authorizationContext).toMatchObject({
			policyId: grant.claims.jti,
			parentOrigin,
			assistantOrigin,
			scopeId,
			sessionId: 'session-a',
		})
		expect(authorizationContext).not.toHaveProperty('policy')
		expect(internalStore.entries.size).toBe(0)
	})

	it('fetches a fresh grant on every get and only verifies the latest exact policy/context', async () => {
		const service = createService()
		const first = await service.issue(request())
		const second = await service.issue(request())
		const responses = [clientResponse(first), clientResponse(second)]
		const calls = vi.fn()
		const fetchImpl: typeof fetch = async (_input, init) => {
			calls(init)
			return {
				ok: true,
				json: async () => responses.shift(),
			} as Response
		}
		const freshClient = new ManagedEmbedAuthClient({
			endpoint: `${parentOrigin}/api/parent-bridge/embed-policy`,
			runtimeOrigin: parentOrigin,
			expectedParentOrigin: parentOrigin,
			expectedAssistantOrigin: assistantOrigin,
			expectedScopeId: scopeId,
			expectedIssuer: issuer,
			expectedAudience: audience,
			fetchImpl,
			now: () => nowSeconds,
		})

		const firstPolicy = await freshClient.getEmbedPolicy()
		const secondPolicy = await freshClient.getEmbedPolicy()
		expect(firstPolicy).toBe(first.policy)
		expect(secondPolicy).toBe(second.policy)
		expect(secondPolicy).not.toBe(firstPolicy)
		expect(calls).toHaveBeenCalledTimes(2)
		for (const [init] of calls.mock.calls) {
			expect(init).toMatchObject({
				method: 'POST',
				credentials: 'same-origin',
				cache: 'no-store',
				body: '{}',
			})
			expect(init.headers).toMatchObject({ 'Content-Type': 'application/json' })
		}
		expect(freshClient.verifyEmbedPolicy(firstPolicy, context())).toBe(false)
		expect(freshClient.verifyEmbedPolicy(secondPolicy, context())).toMatchObject({
			jti: second.claims.jti,
		})
		expect(freshClient.verifyEmbedPolicy(secondPolicy, context())).toBe(false)

		const contextGrant = await service.issue(request())
		const contextClient = createClient(clientResponse(contextGrant))
		const contextPolicy = await contextClient.getEmbedPolicy()
		expect(
			contextClient.verifyEmbedPolicy(
				contextPolicy,
				context({ actualParentOrigin: 'https://other.example.test' })
			)
		).toBe(false)
		expect(contextClient.verifyEmbedPolicy(contextPolicy, context())).toBe(false)

		const assistantGrant = await service.issue(request())
		const assistantClient = createClient(clientResponse(assistantGrant))
		const assistantPolicy = await assistantClient.getEmbedPolicy()
		expect(
			assistantClient.verifyEmbedPolicy(
				assistantPolicy,
				context({ assistantOrigin: 'https://other.example.test' })
			)
		).toBe(false)

		const scopeGrant = await service.issue(request())
		const scopeClient = createClient(clientResponse(scopeGrant))
		const scopePolicy = await scopeClient.getEmbedPolicy()
		expect(scopeClient.verifyEmbedPolicy(scopePolicy, context({ scopeId: 'other-scope' }))).toBe(
			false
		)

		const capabilityGrant = await service.issue(request())
		const capabilityClient = createClient(clientResponse(capabilityGrant))
		const capabilityPolicy = await capabilityClient.getEmbedPolicy()
		expect(
			capabilityClient.verifyEmbedPolicy(capabilityPolicy, context({ capabilities: ['scroll'] }))
		).toBe(false)
	})

	it('fails closed for policy tampering and malformed claims', async () => {
		const service = createService()
		const grant = await service.issue(request())
		const tamperedPolicy = `${grant.policy.slice(0, -1)}${grant.policy.endsWith('A') ? 'B' : 'A'}`
		await expect(
			service.exchange({
				policy: tamperedPolicy,
				actualParentOrigin: parentOrigin,
				offer: offer(grant),
			})
		).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED,
		})

		const client = createClient(
			clientResponse(grant, {
				claims: { ...grant.claims, scopeId: 'wrong-scope' },
			})
		)
		await expect(client.getEmbedPolicy()).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.SCOPE_MISMATCH,
		})
	})

	it('atomically consumes a policy and rejects replay, including concurrent exchanges', async () => {
		const service = createService()
		const grant = await service.issue(request())
		const exchange: ManagedEmbedAuthorizationExchangeRequest = {
			policy: grant.policy,
			actualParentOrigin: parentOrigin,
			offer: offer(grant),
		}
		const results = await Promise.allSettled([
			service.exchange(exchange),
			service.exchange(exchange),
		])
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
		await expect(service.exchange(exchange)).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED,
		})
	})

	it('rejects expired policies and issue scope/origin mismatches', async () => {
		const service = createService({ ttlSeconds: 10 })
		const grant = await service.issue(request())
		nowSeconds += 20
		await expect(
			service.exchange({
				policy: grant.policy,
				actualParentOrigin: parentOrigin,
				offer: offer(grant, { capabilities: ['observe'] }),
			})
		).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED,
		})
		await expect(createClient(clientResponse(grant)).getEmbedPolicy()).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.POLICY_INVALID,
		})

		nowSeconds = 1_700_000_000
		await expect(service.issue(request({ scopeId: 'wrong-scope' }))).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.SCOPE_MISMATCH,
		})
		await expect(
			service.issue(request({ parentOrigin: 'https://other.example.test' }))
		).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH,
		})
		await expect(
			service.issue(request({ assistantOrigin: 'https://other.example.test' }))
		).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH,
		})
	})

	it('keeps a policy available after a mismatched offer and rejects unsafe bindings', async () => {
		const service = createService()
		const grant = await service.issue(request({ capabilities: ['observe'] }))
		await expect(
			service.exchange({
				policy: grant.policy,
				actualParentOrigin: parentOrigin,
				offer: offer(grant, { policyId: 'wrong-policy' }),
			})
		).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED,
		})
		await expect(
			service.exchange({
				policy: grant.policy,
				actualParentOrigin: parentOrigin,
				offer: offer(grant, { capabilities: ['click'] }),
			})
		).rejects.toMatchObject({
			code: ManagedEmbedAuthorizationErrorCode.POLICY_NOT_FOUND_OR_REPLAYED,
		})
		await expect(
			service.exchange({
				policy: grant.policy,
				actualParentOrigin: 'https://other.example.test',
				offer: offer(grant),
			})
		).rejects.toMatchObject({ code: ManagedEmbedAuthorizationErrorCode.ORIGIN_MISMATCH })
		await expect(
			service.exchange({
				policy: grant.policy,
				actualParentOrigin: parentOrigin,
				offer: offer(grant, { sessionId: '' }),
			})
		).rejects.toMatchObject({ code: ManagedEmbedAuthorizationErrorCode.REQUEST_INVALID })

		// A valid offer still succeeds because invalid attempts did not consume jti.
		await expect(
			service.exchange({
				policy: grant.policy,
				actualParentOrigin: parentOrigin,
				offer: offer(grant, { capabilities: ['observe'] }),
			})
		).resolves.toMatchObject({ policyId: grant.claims.jti, capabilities: ['observe'] })
	})
})
