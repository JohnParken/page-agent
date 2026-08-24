/* eslint-disable @typescript-eslint/unbound-method */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { hashFrameBridgePayload } from './action-security'
import { FrameBridgeHost } from './FrameBridgeHost'
import {
	BRIDGE_PROTOCOL_VERSION,
	BridgeErrorCode,
	IFRAME_BRIDGE_PROTOCOL,
	isBridgeAvailableMessage,
	isBridgeConnectedMessage,
	isBridgeResponseMessage,
} from './protocol'

import type { FrameBridgeHostWindow, FrameBridgeMessagePort } from './FrameBridgeHost'
import type { FrameBridgePolicyController } from './FrameBridgeHost'
import type { BridgeResponseMessage } from './protocol'
import type { IndexedPageControllerAdapter } from '../PageController'

const PARENT_ORIGIN = 'https://parent.example.test'
const CHILD_ORIGIN = 'https://child.example.test'
const SESSION_ID = 'session-1'
const FRAME_INSTANCE_ID = 'frame-1'

interface MessageRecord {
	message: unknown
	origin?: string
	transfer?: readonly unknown[]
}

class FakePort implements FrameBridgeMessagePort {
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null
	onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
	peer: FakePort | null = null
	closed = false
	messages: unknown[] = []
	private messageWaiters: {
		predicate: (message: unknown) => boolean
		resolve: (message: unknown) => void
	}[] = []

	postMessage(message: unknown): void {
		if (this.closed) throw new Error('closed')
		this.receive(message)
		const peer = this.peer
		if (peer && !peer.closed)
			queueMicrotask(() => peer.onmessage?.({ data: message } as MessageEvent))
	}

	receive(message: unknown): void {
		this.messages.push(message)
		for (let index = this.messageWaiters.length - 1; index >= 0; index--) {
			const waiter = this.messageWaiters[index]
			if (!waiter.predicate(message)) continue
			this.messageWaiters.splice(index, 1)
			waiter.resolve(message)
		}
	}

	waitForMessage<T>(predicate: (message: unknown) => message is T): Promise<T> {
		const existing = this.messages.find(predicate)
		if (existing !== undefined) return Promise.resolve(existing)
		return new Promise<T>((resolve) => {
			this.messageWaiters.push({
				predicate,
				resolve: (message) => resolve(message as T),
			})
		})
	}

	start(): void {}

	close(): void {
		this.closed = true
	}
}

function createPortPair(): [FakePort, FakePort] {
	const first = new FakePort()
	const second = new FakePort()
	first.peer = second
	second.peer = first
	return [first, second]
}

class FakeParent {
	messages: MessageRecord[] = []

	postMessage(message: unknown, origin: string, transfer?: readonly unknown[]): void {
		this.messages.push({ message, origin, transfer })
	}
}

class FakeWindow implements FrameBridgeHostWindow {
	readonly parent: FakeParent
	private listeners = new Map<string, Set<EventListener>>()

	constructor(parent: FakeParent) {
		this.parent = parent
	}

	addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
	addEventListener(type: string, listener: EventListener): void
	addEventListener(
		type: string,
		listener: EventListener | ((event: MessageEvent<unknown>) => void)
	): void {
		const listeners = this.listeners.get(type) ?? new Set<EventListener>()
		listeners.add(listener as EventListener)
		this.listeners.set(type, listeners)
	}

	removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
	removeEventListener(type: string, listener: EventListener): void
	removeEventListener(
		type: string,
		listener: EventListener | ((event: MessageEvent<unknown>) => void)
	): void {
		this.listeners.get(type)?.delete(listener as EventListener)
	}

	dispatch(
		data: unknown,
		origin = PARENT_ORIGIN,
		source: unknown = this.parent,
		ports: FakePort[] = []
	): void {
		this.emit('message', { data, origin, source, ports } as unknown as Event)
	}

	dispatchPointer(type: 'PageAgent::MovePointerTo' | 'PageAgent::ClickPointer', detail?: unknown) {
		this.emit(type, { type, detail } as CustomEvent<unknown>)
	}

	private emit(type: string, event: Event): void {
		for (const listener of this.listeners.get(type) ?? []) listener(event)
	}
}

function messageBase(type: string, extra: Record<string, unknown> = {}) {
	return {
		protocol: IFRAME_BRIDGE_PROTOCOL,
		version: BRIDGE_PROTOCOL_VERSION,
		type,
		...extra,
	}
}

function createController(overrides: Partial<FrameBridgePolicyController> = {}) {
	const target = document.createElement('button')
	target.type = 'button'
	const controller: FrameBridgePolicyController = {
		getCurrentUrl: vi.fn(async () => CHILD_ORIGIN),
		getLastUpdateTime: vi.fn(async () => 0),
		getBrowserState: vi.fn(async () => ({
			url: CHILD_ORIGIN,
			title: 'Child',
			header: 'header',
			content: '[1]<button>Remote</button>',
			footer: 'footer',
			treeRevision: 1,
			indices: [1],
		})),
		updateTree: vi.fn(async () => ''),
		cleanUpHighlights: vi.fn(async () => undefined),
		clickElement: vi.fn(async () => ({ success: true, message: 'clicked' })),
		inputText: vi.fn(async () => ({ success: true, message: 'input' })),
		selectOption: vi.fn(async () => ({ success: true, message: 'selected' })),
		scroll: vi.fn(async () => ({ success: true, message: 'scrolled' })),
		scrollHorizontally: vi.fn(async () => ({ success: true, message: 'scrolled horizontally' })),
		executeJavascript: vi.fn(async () => ({ success: true, message: 'executed' })),
		showMask: vi.fn(async () => undefined),
		hideMask: vi.fn(async () => undefined),
		dispose: vi.fn(),
		getIndexedElementForPolicy: vi.fn(() => target),
		...overrides,
	}
	return controller
}

function deferred<T>(): {
	promise: Promise<T>
	resolve: (value: T) => void
	reject: (reason?: unknown) => void
} {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function discoverAndConnect(
	hostWindow: FakeWindow,
	host: FrameBridgeHost,
	sessionId = SESSION_ID
): FakePort {
	hostWindow.dispatch(messageBase('discover', { sessionId }))
	const available = hostWindow.parent.messages.at(-1)?.message
	expect(isBridgeAvailableMessage(available)).toBe(true)

	const [parentPort, childPort] = createPortPair()
	parentPort.onmessage = (event) => parentPort.receive(event.data)
	hostWindow.dispatch(
		messageBase('connect', {
			sessionId,
			frameInstanceId: FRAME_INSTANCE_ID,
		}),
		PARENT_ORIGIN,
		hostWindow.parent,
		[childPort]
	)
	expect(isBridgeConnectedMessage(childPort.messages[0])).toBe(true)
	return parentPort
}

function waitForResponse(port: FakePort, requestId: string): Promise<BridgeResponseMessage> {
	return port.waitForMessage(
		(message): message is BridgeResponseMessage =>
			isBridgeResponseMessage(message) && message.requestId === requestId
	)
}

describe('FrameBridgeHost', () => {
	let parent: FakeParent
	let hostWindow: FakeWindow
	let controller: FrameBridgePolicyController

	beforeEach(() => {
		parent = new FakeParent()
		hostWindow = new FakeWindow(parent)
		controller = createController()
	})

	it('performs exact-origin/source discover, available and connect handshake', () => {
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()

		hostWindow.dispatch(messageBase('discover', { sessionId: SESSION_ID }), PARENT_ORIGIN, {})
		expect(parent.messages).toHaveLength(0)

		hostWindow.dispatch(messageBase('discover', { sessionId: SESSION_ID }), 'https://evil.test')
		expect(parent.messages).toHaveLength(0)

		hostWindow.dispatch(messageBase('discover', { sessionId: SESSION_ID }))
		expect(parent.messages).toHaveLength(1)
		expect(parent.messages[0].origin).toBe(PARENT_ORIGIN)
		expect(isBridgeAvailableMessage(parent.messages[0].message)).toBe(true)

		const [parentPort, childPort] = createPortPair()
		parentPort.onmessage = (event) => parentPort.messages.push(event.data)
		hostWindow.dispatch(
			messageBase('connect', { sessionId: SESSION_ID, frameInstanceId: FRAME_INSTANCE_ID }),
			PARENT_ORIGIN,
			hostWindow.parent,
			[childPort]
		)
		expect(isBridgeConnectedMessage(childPort.messages[0])).toBe(true)
		expect((childPort.messages[0] as { treeRevision: number }).treeRevision).toBe(0)
		expect(parentPort.closed).toBe(false)
	})

	it('requires a successful observation before index-based actions', async () => {
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'click-before-observe',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await waitForResponse(port, 'click-before-observe')
		expect(controller.clickElement).not.toHaveBeenCalled()
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.STALE_TREE
		)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'observe',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await waitForResponse(port, 'observe')
		expect(isBridgeResponseMessage(port.messages.at(-1))).toBe(true)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'click-after-observe',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(controller.clickElement).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
	})

	it('relays pointer feedback only while an authorized pointer action is running', async () => {
		const clickElement = vi.fn(async () => {
			hostWindow.dispatchPointer('PageAgent::MovePointerTo', { x: 12, y: 34 })
			hostWindow.dispatchPointer('PageAgent::ClickPointer')
			return { success: true, message: 'clicked' }
		})
		controller = createController({ clickElement })
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		hostWindow.dispatchPointer('PageAgent::MovePointerTo', { x: 1, y: 2 })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(port.messages.some((message) => (message as { type?: string }).type === 'pointer')).toBe(
			false
		)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'observe-before-pointer',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'click-with-pointer',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))

		const pointerMessages = port.messages.filter(
			(message): message is Record<string, unknown> =>
				typeof message === 'object' &&
				message !== null &&
				(message as { type?: unknown }).type === 'pointer'
		)
		expect(pointerMessages).toEqual([
			expect.objectContaining({ action: 'move', x: 12, y: 34, treeRevision: 1 }),
			expect.objectContaining({ action: 'click', treeRevision: 1 }),
		])
	})

	it('holds the global controller lock across a replaced connection', async () => {
		const oldMutation = deferred<{ success: boolean; message: string }>()
		const clickElement = vi.fn(() => oldMutation.promise)
		const getBrowserState = vi.fn(async () => ({
			url: CHILD_ORIGIN,
			title: 'Child',
			header: '',
			content: '',
			footer: '',
			treeRevision: 1,
			indices: [1],
		}))
		controller = createController({ clickElement, getBrowserState })
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const oldPort = discoverAndConnect(hostWindow, host)

		oldPort.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'old-observe',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		oldPort.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'old-mutation',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(clickElement).toHaveBeenCalledOnce()

		const newPort = discoverAndConnect(hostWindow, host, 'session-2')
		newPort.postMessage(
			messageBase('request', {
				sessionId: 'session-2',
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'new-observe',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(getBrowserState).toHaveBeenCalledOnce()

		oldMutation.resolve({ success: true, message: 'old mutation settled' })
		await new Promise((resolve) => setTimeout(resolve, 0))
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(getBrowserState).toHaveBeenCalledTimes(2)
		expect(
			oldPort.messages.some(
				(message) =>
					typeof message === 'object' &&
					message !== null &&
					(message as { type?: unknown }).type === 'response' &&
					(message as { requestId?: unknown }).requestId === 'old-mutation'
			)
		).toBe(false)
		expect(
			newPort.messages.some(
				(message) =>
					typeof message === 'object' &&
					message !== null &&
					(message as { type?: unknown }).type === 'response' &&
					(message as { requestId?: unknown }).requestId === 'new-observe'
			)
		).toBe(true)
	})

	it('serves observe and action RPC with started/response and revision routing', async () => {
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'observe-1',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(controller.getBrowserState).toHaveBeenCalledWith(
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
		expect(isBridgeResponseMessage(port.messages.at(-1))).toBe(true)
		expect((port.messages.at(-1) as { treeRevision: number }).treeRevision).toBe(1)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'click-1',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(controller.clickElement).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
		expect(isBridgeResponseMessage(port.messages.at(-1))).toBe(true)

		const requests = [
			['inputText', { index: 1, text: 'hello' }],
			['selectOption', { index: 1, optionText: 'Beta' }],
			['scroll', { down: true, numPages: 1 }],
			['scrollHorizontally', { right: true, pixels: 12 }],
			['cleanUpHighlights', undefined],
		] as const
		for (const [method, payload] of requests) {
			port.postMessage(
				messageBase('request', {
					sessionId: SESSION_ID,
					frameInstanceId: FRAME_INSTANCE_ID,
					treeRevision: 1,
					requestId: `request-${method}`,
					method,
					payload,
				})
			)
			await new Promise((resolve) => setTimeout(resolve, 0))
			expect(isBridgeResponseMessage(port.messages.at(-1))).toBe(true)
		}
		expect(controller.inputText).toHaveBeenCalledWith(
			1,
			'hello',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
		expect(controller.selectOption).toHaveBeenCalledWith(
			1,
			'Beta',
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
		expect(controller.scroll).toHaveBeenCalledWith(
			{ down: true, numPages: 1 },
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
		expect(controller.scrollHorizontally).toHaveBeenCalledWith(
			{ right: true, pixels: 12 },
			expect.objectContaining({ signal: expect.any(AbortSignal) })
		)
		expect(controller.cleanUpHighlights).toHaveBeenCalledOnce()
	})

	it('rejects stale revisions, unsupported executeJavascript and invalid payloads', async () => {
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 2,
				requestId: 'stale',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.STALE_TREE
		)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'bad-payload',
				method: 'clickElement',
				payload: { index: 1, extra: true },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.INVALID_PAYLOAD
		)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'javascript',
				method: 'executeJavascript',
				payload: { script: 'return 1' },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.UNSUPPORTED_METHOD
		)
		expect(isBridgeResponseMessage(port.messages.at(-1))).toBe(true)
		expect((port.messages.at(-1) as { method: string }).method).toBe('executeJavascript')
		expect(controller.executeJavascript).not.toHaveBeenCalled()
	})

	it('serializes observations and validates a queued action at execution time', async () => {
		const firstObservation =
			deferred<Awaited<ReturnType<IndexedPageControllerAdapter['getBrowserState']>>>()
		const secondObservation =
			deferred<Awaited<ReturnType<IndexedPageControllerAdapter['getBrowserState']>>>()
		let observationCount = 0
		const getBrowserState = vi.fn(() => {
			const observation = observationCount++ === 0 ? firstObservation : secondObservation
			return observation.promise
		})
		controller = createController({
			getBrowserState: getBrowserState as IndexedPageControllerAdapter['getBrowserState'],
		})
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		const request = (requestId: string, method: string, treeRevision: number, payload: unknown) =>
			port.postMessage(
				messageBase('request', {
					sessionId: SESSION_ID,
					frameInstanceId: FRAME_INSTANCE_ID,
					treeRevision,
					requestId,
					method,
					payload,
				})
			)

		request('observe-1', 'getBrowserState', 0, {})
		request('observe-2', 'getBrowserState', 0, {})
		request('queued-click', 'clickElement', 0, { index: 1 })
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(getBrowserState).toHaveBeenCalledOnce()
		expect(controller.clickElement).not.toHaveBeenCalled()
		expect(
			port.messages
				.filter(
					(message): message is { type: string; requestId: string } =>
						typeof message === 'object' &&
						message !== null &&
						(message as { type?: unknown }).type === 'started'
				)
				.map((message) => message.requestId)
		).toEqual(['observe-1'])

		firstObservation.resolve({
			url: CHILD_ORIGIN,
			title: 'Child',
			header: '',
			content: '',
			footer: '',
			treeRevision: 1,
			indices: [1],
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(getBrowserState).toHaveBeenCalledTimes(2)
		expect(controller.clickElement).not.toHaveBeenCalled()

		secondObservation.resolve({
			url: CHILD_ORIGIN,
			title: 'Child',
			header: '',
			content: '',
			footer: '',
			treeRevision: 2,
			indices: [1],
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(controller.clickElement).not.toHaveBeenCalled()
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.STALE_TREE
		)
		expect(
			port.messages
				.filter(
					(message): message is { type: string; requestId: string } =>
						typeof message === 'object' &&
						message !== null &&
						(message as { type?: unknown }).type === 'started'
				)
				.map((message) => message.requestId)
		).toEqual(['observe-1', 'observe-2'])
	})

	it('cancels a queued request without sending started or invoking the controller', async () => {
		const observation =
			deferred<Awaited<ReturnType<IndexedPageControllerAdapter['getBrowserState']>>>()
		controller = createController({
			getBrowserState: vi.fn(
				() => observation.promise
			) as IndexedPageControllerAdapter['getBrowserState'],
		})
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		const requestBase = {
			sessionId: SESSION_ID,
			frameInstanceId: FRAME_INSTANCE_ID,
			treeRevision: 0,
		}
		port.postMessage(
			messageBase('request', {
				...requestBase,
				requestId: 'observe',
				method: 'getBrowserState',
				payload: {},
			})
		)
		port.postMessage(
			messageBase('request', {
				...requestBase,
				requestId: 'queued-click',
				method: 'clickElement',
				payload: { index: 1 },
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		port.postMessage(
			messageBase('cancel', {
				...requestBase,
				requestId: 'queued-click',
				method: 'clickElement',
			})
		)

		observation.resolve({
			url: CHILD_ORIGIN,
			title: 'Child',
			header: '',
			content: '',
			footer: '',
			treeRevision: 1,
			indices: [1],
		})
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(controller.clickElement).not.toHaveBeenCalled()
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.ABORTED
		)
		expect(
			port.messages
				.filter(
					(message): message is { type: string; requestId: string } =>
						typeof message === 'object' &&
						message !== null &&
						(message as { type?: unknown }).type === 'started'
				)
				.map((message) => message.requestId)
		).toEqual(['observe'])
	})

	it('cancels in-flight work and disposes the host safely', async () => {
		let resolveObserve!: (
			value: IndexedPageControllerAdapter extends never ? never : unknown
		) => void
		const observe = vi.fn(
			({ signal }: { signal?: AbortSignal }) =>
				new Promise((resolve) => {
					resolveObserve = resolve
					signal?.addEventListener('abort', () =>
						resolve({
							url: CHILD_ORIGIN,
							title: 'Child',
							header: '',
							content: '',
							footer: '',
							treeRevision: 1,
							indices: [],
						})
					)
				})
		)
		controller = createController({
			getBrowserState: observe as IndexedPageControllerAdapter['getBrowserState'],
		})
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)

		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'cancel-me',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		port.postMessage(
			messageBase('cancel', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'cancel-me',
				method: 'getBrowserState',
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect((port.messages.at(-1) as { error: { code: string } }).error.code).toBe(
			BridgeErrorCode.ABORTED
		)

		host.dispose()
		expect(controller.dispose).toHaveBeenCalledOnce()
		resolveObserve?.(undefined)
		hostWindow.dispatch(messageBase('discover', { sessionId: 'after-dispose' }))
		expect(parent.messages.filter((item) => isBridgeAvailableMessage(item.message))).toHaveLength(1)
	})

	it('rejects wildcard, opaque and path-bearing parent origins', () => {
		for (const origin of [
			'*',
			'https://*.example.test',
			'null',
			'file:///tmp',
			`${PARENT_ORIGIN}/path`,
		]) {
			expect(
				() =>
					new FrameBridgeHost({
						controller,
						allowedParentOrigins: [origin],
						window: hostWindow,
					})
			).toThrow()
		}
	})

	it('transforms child state without allowing index metadata changes', async () => {
		const transformState = vi.fn(
			(state: Awaited<ReturnType<typeof controller.getBrowserState>>) => ({
				...state,
				content: '[1]<button>Redacted child control</button>',
			})
		)
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
			transformState,
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)
		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'observe-transformed',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(port.messages.filter(isBridgeResponseMessage).at(-1)).toMatchObject({
			ok: true,
			result: {
				content: '[1]<button>Redacted child control</button>',
				treeRevision: 1,
				indices: [1],
			},
		})
		expect(transformState).toHaveBeenCalledWith(
			expect.objectContaining({ treeRevision: 1, indices: [1] }),
			expect.objectContaining({ parentOrigin: PARENT_ORIGIN, signal: expect.any(AbortSignal) })
		)
	})

	it('binds confirm actions to a single prepared token and unchanged payload', async () => {
		const target = document.createElement('input')
		target.setAttribute('aria-label', 'Sensitive child input')
		controller = createController({
			getIndexedElementForPolicy: vi.fn(() => target),
		})
		const host = new FrameBridgeHost({
			controller,
			allowedParentOrigins: [PARENT_ORIGIN],
			frameInstanceId: FRAME_INSTANCE_ID,
			window: hostWindow,
			actionPolicy: () => ({ decision: 'approval_required', reason: 'Sensitive action' }),
		})
		host.start()
		const port = discoverAndConnect(hostWindow, host)
		port.postMessage(
			messageBase('request', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 0,
				requestId: 'observe-v2',
				method: 'getBrowserState',
				payload: {},
			})
		)
		await waitForResponse(port, 'observe-v2')

		const payload = { index: 1, text: 'approved value' }
		const prepare = async (
			requestId: string,
			summary: Record<string, unknown> = { index: 1, textLength: payload.text.length }
		) => {
			port.postMessage(
				messageBase('prepare-action', {
					sessionId: SESSION_ID,
					frameInstanceId: FRAME_INSTANCE_ID,
					treeRevision: 1,
					requestId,
					method: 'inputText',
					payloadHash: await hashFrameBridgePayload(payload),
					summary,
				})
			)
			const response = await waitForResponse(port, requestId)
			expect(response).toMatchObject({
				ok: true,
				result: {
					decision: 'approval_required',
					reason: 'Sensitive action',
				},
			})
			if (summary.index === 1)
				expect(response).toMatchObject({
					result: { target: { tag: 'input', label: 'Sensitive child input' } },
				})
			return (response as { result: { preparedActionId: string } }).result.preparedActionId
		}

		const deniedToken = await prepare('prepare-denied')
		port.postMessage(
			messageBase('commit-action', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'commit-denied',
				method: 'inputText',
				preparedActionId: deniedToken,
				approved: false,
				payload,
			})
		)
		const deniedResponse = await waitForResponse(port, 'commit-denied')
		expect(deniedResponse).toMatchObject({
			ok: false,
			error: { code: BridgeErrorCode.APPROVAL_REQUIRED },
		})
		expect(controller.inputText).not.toHaveBeenCalled()

		const misleadingToken = await prepare('prepare-misleading', {
			textLength: payload.text.length,
		})
		port.postMessage(
			messageBase('commit-action', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'commit-misleading',
				method: 'inputText',
				preparedActionId: misleadingToken,
				approved: true,
				payload,
			})
		)
		const misleadingResponse = await waitForResponse(port, 'commit-misleading')
		expect(misleadingResponse).toMatchObject({
			ok: false,
			error: { code: BridgeErrorCode.APPROVAL_DENIED },
		})
		expect(controller.inputText).not.toHaveBeenCalled()

		const approvedToken = await prepare('prepare-approved')
		port.postMessage(
			messageBase('commit-action', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'commit-approved',
				method: 'inputText',
				preparedActionId: approvedToken,
				approved: true,
				payload,
			})
		)
		const approvedResponse = await waitForResponse(port, 'commit-approved')
		expect(controller.inputText).toHaveBeenCalledOnce()
		expect(approvedResponse).toMatchObject({ ok: true })

		port.postMessage(
			messageBase('commit-action', {
				sessionId: SESSION_ID,
				frameInstanceId: FRAME_INSTANCE_ID,
				treeRevision: 1,
				requestId: 'commit-replay',
				method: 'inputText',
				preparedActionId: approvedToken,
				approved: true,
				payload,
			})
		)
		const replayResponse = await waitForResponse(port, 'commit-replay')
		expect(replayResponse).toMatchObject({
			ok: false,
			error: { code: BridgeErrorCode.APPROVAL_DENIED },
		})
		expect(controller.inputText).toHaveBeenCalledOnce()
	})
})
