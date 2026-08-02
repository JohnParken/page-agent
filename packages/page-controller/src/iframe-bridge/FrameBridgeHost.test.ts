/* eslint-disable @typescript-eslint/unbound-method */
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

	postMessage(message: unknown): void {
		if (this.closed) throw new Error('closed')
		this.messages.push(message)
		const peer = this.peer
		if (peer && !peer.closed)
			queueMicrotask(() => peer.onmessage?.({ data: message } as MessageEvent))
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
	private listener: ((event: MessageEvent<unknown>) => void) | null = null

	constructor(parent: FakeParent) {
		this.parent = parent
	}

	addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
		this.listener = listener
	}

	removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
		if (this.listener === listener) this.listener = null
	}

	dispatch(
		data: unknown,
		origin = PARENT_ORIGIN,
		source: unknown = this.parent,
		ports: FakePort[] = []
	): void {
		this.listener?.({ data, origin, source, ports } as unknown as MessageEvent)
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

function createController(overrides: Partial<IndexedPageControllerAdapter> = {}) {
	const controller: IndexedPageControllerAdapter = {
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
	parentPort.onmessage = (event) => parentPort.messages.push(event.data)
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

describe('FrameBridgeHost', () => {
	let parent: FakeParent
	let hostWindow: FakeWindow
	let controller: IndexedPageControllerAdapter

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
		await new Promise((resolve) => setTimeout(resolve, 0))
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
		await new Promise((resolve) => setTimeout(resolve, 0))
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
})
