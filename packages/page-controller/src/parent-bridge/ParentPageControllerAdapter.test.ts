import { afterEach, describe, expect, it, vi } from 'vitest'

import { ACTIVE_LEASE_STALE_AFTER_MS } from './active-lease'
import { ParentPageControllerAdapter } from './ParentPageControllerAdapter'
import {
	PARENT_CONTROLLER_PROTOCOL,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	type ParentControllerOfferMessage,
} from './protocol'

import type {
	ParentControllerActiveLeaseOptions,
	ParentControllerAdapterWindow,
	ParentControllerMessagePort,
	ParentControllerTargetWindow,
} from './types'

const PARENT_ORIGIN = 'https://parent.example.test'
const ASSISTANT_ORIGIN = 'https://assistant.example.test'
const CAPABILITIES: ParentControllerCapability[] = [
	'observe',
	'click',
	'input',
	'select',
	'scroll',
	'scrollHorizontally',
]

type MessageListener = (event: MessageEvent<unknown>) => void

class FakePort implements ParentControllerMessagePort {
	onmessage: MessageListener | null = null
	readonly messages: unknown[] = []
	private readonly messageListeners = new Set<MessageListener>()
	private readonly messageErrorListeners = new Set<MessageListener>()
	closed = false

	postMessage(message: unknown): void {
		if (this.closed) throw new Error('port is closed')
		this.messages.push(message)
	}

	addEventListener(type: string, listener: MessageListener): void {
		if (type === 'message') this.messageListeners.add(listener)
		else if (type === 'messageerror') this.messageErrorListeners.add(listener)
	}

	removeEventListener(type: string, listener: MessageListener): void {
		if (type === 'message') this.messageListeners.delete(listener)
		else if (type === 'messageerror') this.messageErrorListeners.delete(listener)
	}

	start(): void {}

	close(): void {
		this.closed = true
	}

	emit(data: unknown): void {
		const event = { data } as MessageEvent<unknown>
		for (const listener of this.messageListeners) listener(event)
		this.onmessage?.(event)
	}

	emitError(data: unknown = null): void {
		const event = { data } as MessageEvent<unknown>
		for (const listener of this.messageErrorListeners) listener(event)
	}
}

class FakeParent implements ParentControllerTargetWindow {
	readonly messages: { message: unknown; targetOrigin: string; transfer?: Transferable[] }[] = []

	postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void {
		this.messages.push({ message, targetOrigin, transfer })
	}
}

class FakeWindow implements ParentControllerAdapterWindow {
	readonly location = { origin: ASSISTANT_ORIGIN } as Location
	readonly parent: FakeParent
	private readonly listeners = new Set<MessageListener>()

	constructor(parent: FakeParent) {
		this.parent = parent
	}

	addEventListener(_type: string, listener: MessageListener): void {
		this.listeners.add(listener)
	}

	removeEventListener(_type: string, listener: MessageListener): void {
		this.listeners.delete(listener)
	}

	emit(data: unknown, origin = PARENT_ORIGIN, ports: ParentControllerMessagePort[] = []): void {
		const event = {
			data,
			origin,
			source: this.parent,
			ports,
		} as unknown as MessageEvent<unknown>
		for (const listener of this.listeners) listener(event)
	}
}

function frameContext() {
	return {
		parentOrigin: PARENT_ORIGIN,
		assistantOrigin: ASSISTANT_ORIGIN,
		directChild: true,
		sandbox: [],
		allowScripts: true,
		allowSameOrigin: true,
	}
}

function offer(
	overrides: Partial<ParentControllerOfferMessage> = {}
): ParentControllerOfferMessage {
	return {
		protocol: PARENT_CONTROLLER_PROTOCOL,
		version: PARENT_CONTROLLER_PROTOCOL_VERSION,
		type: 'offer',
		policy: 'signed-policy',
		policyId: 'policy-1',
		challenge: 'challenge-1',
		sessionId: 'session-1',
		hostInstanceId: 'host-1',
		frameInstanceId: 'frame-1',
		assistantOrigin: ASSISTANT_ORIGIN,
		capabilities: [...CAPABILITIES],
		frameContext: frameContext(),
		...overrides,
	}
}

function connectedMessage(currentOffer: ParentControllerOfferMessage) {
	return {
		protocol: PARENT_CONTROLLER_PROTOCOL,
		version: PARENT_CONTROLLER_PROTOCOL_VERSION,
		type: 'connected' as const,
		policyId: currentOffer.policyId,
		sessionId: currentOffer.sessionId,
		hostInstanceId: currentOffer.hostInstanceId,
		frameInstanceId: currentOffer.frameInstanceId,
		treeRevision: 0,
		capabilities: [...currentOffer.capabilities],
		frameContext: currentOffer.frameContext,
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const startedAt = Date.now()
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error('condition timed out')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 2_000; i++) {
		if (predicate()) return
		await Promise.resolve()
	}
	throw new Error('condition timed out')
}

async function connectAdapter(
	options: { requestTimeoutMs?: number; autoReconnect?: boolean } = {}
) {
	const parent = new FakeParent()
	const bridgeWindow = new FakeWindow(parent)
	let authorizationCalls = 0
	const adapter = new ParentPageControllerAdapter({
		window: bridgeWindow,
		requestedCapabilities: CAPABILITIES,
		authorizeOffer: async (currentOffer, actualParentOrigin) => {
			authorizationCalls += 1
			return {
				parentOrigin: actualParentOrigin,
				policyId: currentOffer.policyId,
				capabilities: [...CAPABILITIES],
			}
		},
		onApprovalRequired: async () => false,
		requestTimeoutMs: options.requestTimeoutMs ?? 30,
		autoReconnect: options.autoReconnect,
	})
	expect(parent.messages).toEqual([])
	expect(authorizationCalls).toBe(0)
	const connectionPromise = adapter.connect()
	await waitUntil(() =>
		parent.messages.some(
			(entry) => (entry.message as { type?: string }).type === 'handshake-request'
		)
	)
	const handshakeRequest = parent.messages.find(
		(entry): entry is typeof entry & { message: { requestId: string } } =>
			(entry.message as { type?: string }).type === 'handshake-request'
	)
	expect(handshakeRequest?.targetOrigin).toBe('*')
	const currentOffer = offer({ handshakeRequestId: handshakeRequest!.message.requestId })
	bridgeWindow.emit(currentOffer)
	await waitUntil(() =>
		parent.messages.some((entry) => (entry.message as { type?: string }).type === 'accept')
	)
	const port = new FakePort()
	bridgeWindow.emit(
		{
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'connect',
			policyId: currentOffer.policyId,
			challenge: currentOffer.challenge,
			sessionId: currentOffer.sessionId,
			hostInstanceId: currentOffer.hostInstanceId,
			frameInstanceId: currentOffer.frameInstanceId,
			capabilities: [...CAPABILITIES],
			frameContext: currentOffer.frameContext,
		},
		PARENT_ORIGIN,
		[port]
	)
	port.emit(connectedMessage(currentOffer))
	const connection = await connectionPromise
	return {
		adapter,
		bridgeWindow,
		parent,
		port,
		offer: currentOffer,
		connection,
		getAuthorizationCalls: () => authorizationCalls,
	}
}

async function connectAdapterWithActiveLease({
	autoReconnect,
	requestTimeoutMs,
	activeLease,
}: {
	autoReconnect?: boolean
	requestTimeoutMs?: number
	activeLease: ParentControllerActiveLeaseOptions
}) {
	const parent = new FakeParent()
	const bridgeWindow = new FakeWindow(parent)
	let authorizationCalls = 0
	const adapter = new ParentPageControllerAdapter({
		window: bridgeWindow,
		requestedCapabilities: CAPABILITIES,
		authorizeOffer: async (currentOffer, actualParentOrigin) => {
			authorizationCalls += 1
			return {
				parentOrigin: actualParentOrigin,
				policyId: currentOffer.policyId,
				capabilities: [...CAPABILITIES],
			}
		},
		onApprovalRequired: async () => false,
		requestTimeoutMs: requestTimeoutMs ?? 30,
		autoReconnect,
		activeLease,
	})

	expect(parent.messages).toEqual([])
	expect(authorizationCalls).toBe(0)
	const connectionPromise = adapter.connect()
	await waitFor(() =>
		parent.messages.some(
			(entry) => (entry.message as { type?: string }).type === 'handshake-request'
		)
	)
	const handshakeRequest = parent.messages.find(
		(entry): entry is typeof entry & { message: { requestId: string } } =>
			(entry.message as { type?: string }).type === 'handshake-request'
	)
	expect(handshakeRequest?.targetOrigin).toBe('*')
	const currentOffer = offer({ handshakeRequestId: handshakeRequest!.message.requestId })
	bridgeWindow.emit(currentOffer)
	await waitFor(() =>
		parent.messages.some((entry) => (entry.message as { type?: string }).type === 'accept')
	)
	const port = new FakePort()
	bridgeWindow.emit(
		{
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'connect',
			policyId: currentOffer.policyId,
			challenge: currentOffer.challenge,
			sessionId: currentOffer.sessionId,
			hostInstanceId: currentOffer.hostInstanceId,
			frameInstanceId: currentOffer.frameInstanceId,
			capabilities: [...CAPABILITIES],
			frameContext: currentOffer.frameContext,
		},
		PARENT_ORIGIN,
		[port]
	)
	port.emit(connectedMessage(currentOffer))
	const connection = await connectionPromise
	return {
		adapter,
		bridgeWindow,
		parent,
		port,
		offer: currentOffer,
		connection,
		getAuthorizationCalls: () => authorizationCalls,
	}
}

function requestMessage(
	connection: Awaited<ReturnType<typeof connectAdapter>>['connection'],
	requestId: string
) {
	return {
		protocol: PARENT_CONTROLLER_PROTOCOL,
		version: PARENT_CONTROLLER_PROTOCOL_VERSION,
		type: 'response' as const,
		policyId: connection.policyId,
		sessionId: connection.sessionId,
		hostInstanceId: connection.hostInstanceId,
		frameInstanceId: connection.frameInstanceId,
		treeRevision: 0,
		requestId,
		method: 'clickElement',
		ok: true as const,
		result: { success: true, message: 'ok' },
	}
}

afterEach(() => {
	vi.useRealTimers()
})

describe('ParentPageControllerAdapter regressions', () => {
	it('stays passive until connect is explicitly invoked by A', async () => {
		const parent = new FakeParent()
		const bridgeWindow = new FakeWindow(parent)
		const authorizeOffer = vi.fn(async () => false as const)
		const adapter = new ParentPageControllerAdapter({
			window: bridgeWindow,
			requestedCapabilities: ['observe'],
			authorizeOffer,
			onApprovalRequired: async () => false,
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(parent.messages).toEqual([])
		expect(authorizeOffer).not.toHaveBeenCalled()
		await expect(adapter.reconnect()).rejects.toMatchObject({
			code: 'CONNECTION_CLOSED',
		})

		const connection = adapter.connect()
		await waitUntil(() => parent.messages.length === 1)
		expect(parent.messages[0]).toMatchObject({
			targetOrigin: '*',
			message: { type: 'handshake-request', reason: 'user' },
		})
		adapter.dispose()
		await expect(connection).rejects.toMatchObject({ code: 'DISPOSED' })
	})

	it('ignores an offer for a stale handshake request', async () => {
		const parent = new FakeParent()
		const bridgeWindow = new FakeWindow(parent)
		const authorizeOffer = vi.fn(async () => false as const)
		const adapter = new ParentPageControllerAdapter({
			window: bridgeWindow,
			requestedCapabilities: ['observe'],
			authorizeOffer,
			onApprovalRequired: async () => false,
		})
		const connection = adapter.connect()
		await waitUntil(() => parent.messages.length === 1)
		bridgeWindow.emit(offer({ handshakeRequestId: 'stale-handshake-request' }))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(authorizeOffer).not.toHaveBeenCalled()
		expect(parent.messages).toHaveLength(1)
		adapter.dispose()
		await expect(connection).rejects.toMatchObject({ code: 'DISPOSED' })
	})

	it('reports OUTCOME_UNKNOWN after a posted mutation times out before started', async () => {
		const { adapter, port } = await connectAdapter({ requestTimeoutMs: 10 })
		vi.useFakeTimers()
		try {
			const resultPromise = adapter.clickElement(1)
			vi.advanceTimersByTime(20)
			const result = await resultPromise
			expect(result.success).toBe(false)
			expect(result.message).toContain('[OUTCOME_UNKNOWN]')
			expect(port.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: 'cancel' })])
			)
		} finally {
			adapter.dispose()
		}
	})

	it('reports OUTCOME_UNKNOWN when a posted mutation is aborted before started', async () => {
		const { adapter, port } = await connectAdapter()
		try {
			const controller = new AbortController()
			const resultPromise = adapter.clickElement(1, { signal: controller.signal })
			controller.abort()
			const result = await resultPromise
			expect(result.success).toBe(false)
			expect(result.message).toContain('[OUTCOME_UNKNOWN]')
			expect(port.messages).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: 'cancel' })])
			)
		} finally {
			adapter.dispose()
		}
	})

	it('reports OUTCOME_UNKNOWN when the live port closes after posting a mutation', async () => {
		const { adapter, port } = await connectAdapter()
		try {
			const resultPromise = adapter.clickElement(1)
			adapter.invalidate('port closed')
			const result = await resultPromise
			expect(result.success).toBe(false)
			expect(result.message).toContain('[OUTCOME_UNKNOWN]')
			expect(port.closed).toBe(true)
		} finally {
			adapter.dispose()
		}
	})

	it('does not interrupt a live adapter when connect is called repeatedly', async () => {
		const { adapter, port, connection } = await connectAdapter()
		try {
			const resultPromise = adapter.clickElement(1)
			expect(await adapter.connect()).toBe(connection)
			const request = port.messages.find(
				(message): message is { requestId: string } =>
					!!message &&
					typeof message === 'object' &&
					(message as { type?: string }).type === 'request'
			)
			expect(request).toBeDefined()
			port.emit(requestMessage(connection, request!.requestId))
			expect(await resultPromise).toEqual({ success: true, message: 'ok' })
			expect(adapter.connected).toBe(true)
		} finally {
			adapter.dispose()
		}
	})

	it('automatically requests an A-side reconnect after a real port messageerror', async () => {
		const { adapter, parent, port } = await connectAdapter()
		try {
			expect(adapter.activationActive).toBe(true)
			port.emitError()
			await waitUntil(
				() =>
					parent.messages.filter(
						(entry) => (entry.message as { type?: string }).type === 'handshake-request'
					).length === 2
			)
			const reconnectRequest = parent.messages.filter(
				(entry) => (entry.message as { type?: string }).type === 'handshake-request'
			)[1]
			expect(reconnectRequest).toMatchObject({
				targetOrigin: '*',
				message: { type: 'handshake-request', reason: 'reconnect' },
			})
			expect(port.closed).toBe(true)

			adapter.deactivate()
			expect(adapter.activationActive).toBe(false)
			expect(parent.messages.at(-1)?.message).toMatchObject({ type: 'deactivate' })
			await expect(adapter.reconnect()).rejects.toMatchObject({ code: 'CONNECTION_CLOSED' })
		} finally {
			adapter.dispose()
		}
	})

	it('rejects ActiveLease configuration with autoReconnect=true', () => {
		expect(() => {
			const parent = new FakeParent()
			const bridgeWindow = new FakeWindow(parent)
			new ParentPageControllerAdapter({
				window: bridgeWindow,
				requestedCapabilities: ['observe'],
				authorizeOffer: async (currentOffer, actualParentOrigin) => ({
					parentOrigin: actualParentOrigin,
					policyId: currentOffer.policyId,
					capabilities: ['observe'],
				}),
				onApprovalRequired: async () => false,
				autoReconnect: true,
				activeLease: {
					getStatus: async () => ({
						leaseId: 'lease-1',
						policyId: 'policy-1',
						state: 'ACTIVE' as const,
						expiresAt: Math.floor(Date.now() / 1000) + 120,
						checkedAt: Math.floor(Date.now() / 1000),
					}),
				},
			})
		}).toThrow(/autoReconnect must be false when ActiveLease monitoring is enabled/)
	})

	it('stops active-lease auto reconnect on 90s stale while allowing user reconnect', async () => {
		vi.useFakeTimers()
		const random = vi.spyOn(Math, 'random').mockReturnValue(0.5)
		try {
			const now = Math.floor(Date.now() / 1000)
			const getStatus = vi.fn(async () => {
				if (getStatus.mock.calls.length === 1)
					return {
						leaseId: 'lease-1',
						policyId: 'policy-1',
						state: 'ACTIVE' as const,
						expiresAt: now + 120,
						checkedAt: now,
					}
				throw new Error('status unavailable')
			})
			const { adapter, parent, bridgeWindow, connection } = await connectAdapterWithActiveLease({
				autoReconnect: false,
				activeLease: { getStatus },
			})
			expect(adapter.activationActive).toBe(true)
			expect(connection.policyId).toBe('policy-1')
			await vi.advanceTimersByTimeAsync(30_000)
			expect(getStatus).toHaveBeenCalledTimes(2)

			await vi.advanceTimersByTimeAsync(ACTIVE_LEASE_STALE_AFTER_MS - 30_000)
			expect(adapter.activationActive).toBe(false)
			expect(adapter.connected).toBe(false)
			expect(
				parent.messages.some((entry) => (entry.message as { type?: string }).type === 'deactivate')
			).toBe(true)
			const preConnectCount = parent.messages.length
			await vi.advanceTimersByTimeAsync(1)
			expect(parent.messages).toHaveLength(preConnectCount)
			const reconnect = (adapter as ParentPageControllerAdapter).connect().catch(() => undefined)
			await waitFor(() => parent.messages.length > preConnectCount)
			expect(parent.messages.at(-1)).toMatchObject({
				message: { type: 'handshake-request', reason: 'user' },
			})

			adapter.dispose()
			await reconnect
		} finally {
			random.mockRestore()
			vi.useRealTimers()
		}
	})

	it('invalidates on port messageerror without reconnecting when autoReconnect is disabled', async () => {
		const { adapter, parent, port } = await connectAdapter({ autoReconnect: false })
		try {
			const handshakeCount = parent.messages.filter(
				(entry) => (entry.message as { type?: string }).type === 'handshake-request'
			).length
			port.emitError()
			expect(adapter.connected).toBe(false)
			expect(adapter.activationActive).toBe(true)
			expect(port.closed).toBe(true)
			expect(
				parent.messages.filter(
					(entry) => (entry.message as { type?: string }).type === 'handshake-request'
				).length
			).toBe(handshakeCount)
		} finally {
			adapter.dispose()
		}
	})

	it('clears local activation on parent deactivation and requires a user handshake', async () => {
		const { adapter, bridgeWindow, parent } = await connectAdapter()
		try {
			const deactivation = {
				protocol: PARENT_CONTROLLER_PROTOCOL,
				version: PARENT_CONTROLLER_PROTOCOL_VERSION,
				type: 'deactivate' as const,
				requestId: 'deactivate-1',
			}
			const messageCount = parent.messages.length
			bridgeWindow.emit(deactivation, 'https://wrong-parent.example.test')
			expect(adapter.connected).toBe(true)
			expect(adapter.activationActive).toBe(true)

			bridgeWindow.emit(deactivation)
			expect(adapter.connected).toBe(false)
			expect(adapter.activationActive).toBe(false)
			expect(parent.messages).toHaveLength(messageCount)

			const connection = adapter.connect()
			await waitUntil(
				() =>
					parent.messages.filter(
						(entry) => (entry.message as { type?: string }).type === 'handshake-request'
					).length === 2
			)
			expect(parent.messages.at(-1)).toMatchObject({
				targetOrigin: '*',
				message: { type: 'handshake-request', reason: 'user' },
			})
			adapter.dispose()
			await expect(connection).rejects.toMatchObject({ code: 'DISPOSED' })
		} finally {
			adapter.dispose()
		}
	})

	it('reauthorizes and reconnects when a new offer replaces the live offer', async () => {
		const {
			adapter,
			bridgeWindow,
			parent,
			port,
			offer: firstOffer,
			getAuthorizationCalls,
		} = await connectAdapter()
		try {
			const replacement = offer({
				policyId: 'policy-2',
				challenge: 'challenge-2',
				sessionId: 'session-2',
				frameInstanceId: 'frame-2',
				automaticReconnect: true,
			})
			bridgeWindow.emit(replacement)
			await waitUntil(() => getAuthorizationCalls() === 2)
			await waitUntil(
				() =>
					parent.messages.filter((entry) => (entry.message as { type?: string }).type === 'accept')
						.length === 2
			)
			const replacementPort = new FakePort()
			bridgeWindow.emit(
				{
					protocol: PARENT_CONTROLLER_PROTOCOL,
					version: PARENT_CONTROLLER_PROTOCOL_VERSION,
					type: 'connect',
					policyId: replacement.policyId,
					challenge: replacement.challenge,
					sessionId: replacement.sessionId,
					hostInstanceId: replacement.hostInstanceId,
					frameInstanceId: replacement.frameInstanceId,
					capabilities: [...CAPABILITIES],
					frameContext: replacement.frameContext,
				},
				PARENT_ORIGIN,
				[replacementPort]
			)
			replacementPort.emit(connectedMessage(replacement))
			await waitUntil(() => adapter.connected && adapter.connection?.policyId === 'policy-2')
			expect(adapter.connection?.policyId).toBe('policy-2')
			expect(port.closed).toBe(true)
			expect(firstOffer.policyId).toBe('policy-1')
		} finally {
			adapter.dispose()
		}
	})
})
