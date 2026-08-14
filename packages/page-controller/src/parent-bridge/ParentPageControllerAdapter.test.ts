import { afterEach, describe, expect, it, vi } from 'vitest'

import { ParentPageControllerAdapter } from './ParentPageControllerAdapter'
import {
	PARENT_CONTROLLER_PROTOCOL,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	type ParentControllerOfferMessage,
} from './protocol'

import type {
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
	private readonly listeners = new Set<MessageListener>()
	closed = false

	postMessage(message: unknown): void {
		if (this.closed) throw new Error('port is closed')
		this.messages.push(message)
	}

	addEventListener(_type: string, listener: MessageListener): void {
		this.listeners.add(listener)
	}

	removeEventListener(_type: string, listener: MessageListener): void {
		this.listeners.delete(listener)
	}

	start(): void {}

	close(): void {
		this.closed = true
	}

	emit(data: unknown): void {
		const event = { data } as MessageEvent<unknown>
		for (const listener of this.listeners) listener(event)
		this.onmessage?.(event)
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

async function connectAdapter(options: { requestTimeoutMs?: number } = {}) {
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
	})
	const currentOffer = offer()
	bridgeWindow.emit(currentOffer)
	const connectionPromise = adapter.connect()
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
