import {
	BRIDGE_PROTOCOL_VERSION,
	type FrameBridgeCapability,
	IFRAME_BRIDGE_PROTOCOL,
} from './protocol'

export const PARENT_ORIGIN = 'https://parent.example.test'
export const CHILD_ORIGIN = 'https://child.example.test'
export const ALL_CAPABILITIES: FrameBridgeCapability[] = [
	'observe',
	'click',
	'input',
	'select',
	'scroll',
	'scrollHorizontally',
	'cleanup',
]

export interface BridgeHarness {
	ownerWindow: Window
	iframe: HTMLIFrameElement
	childWindow: Window
	setActionResult(result: { success: boolean; message: string }): void
	setResponseTreeRevision(revision: number): void
	setDropStarted(drop: boolean): void
	setDropResponses(drop: boolean): void
	setActionPointerFeedback(
		pointers: ({ action: 'move'; x: number; y: number } | { action: 'click' })[]
	): void
	sendPointer(
		pointer: { action: 'move'; x: number; y: number } | { action: 'click' },
		requestId: string
	): void
	dispose(): void
}

/**
 * A small browser-like harness for parent tests. The child Window is only a
 * WindowProxy stand-in; all RPC still travels through a real MessageChannel.
 */
export function createBridgeHarness(): BridgeHarness {
	const document = globalThis.document
	const iframe = document.createElement('iframe')
	iframe.setAttribute('src', `${CHILD_ORIGIN}/child.html`)
	Object.defineProperty(iframe, 'contentDocument', { configurable: true, value: null })
	document.body.append(iframe)
	const childWindow = iframe.contentWindow!

	const ownerWindow = new EventTarget() as Window & {
		document: Document
		MessageChannel: typeof MessageChannel
	}
	Object.defineProperty(ownerWindow, 'document', { configurable: true, value: document })
	Object.defineProperty(ownerWindow, 'MessageChannel', {
		configurable: true,
		value: globalThis.MessageChannel,
	})

	let dropResponses = false
	let dropStarted = false
	let actionResult = { success: true, message: 'ok' }
	let treeRevision = 0
	let responseTreeRevision = 1
	let disposed = false
	let childPort: MessagePort | null = null
	let activeSessionId = 'session-1'
	let activeFrameInstanceId = 'frame-1'
	let actionPointerFeedback: ({ action: 'move'; x: number; y: number } | { action: 'click' })[] = []

	const dispatchAvailable = (sessionId: string) => {
		ownerWindow.dispatchEvent(
			new MessageEvent('message', {
				data: {
					protocol: IFRAME_BRIDGE_PROTOCOL,
					version: BRIDGE_PROTOCOL_VERSION,
					type: 'available',
					sessionId,
					frameInstanceId: 'frame-1',
					capabilities: ALL_CAPABILITIES,
				},
				origin: CHILD_ORIGIN,
				source: childWindow,
			})
		)
	}

	const handleRequest = (request: Record<string, unknown>) => {
		if (!childPort || disposed) return
		const method = request.method as string
		// The host emits `started` for every queued request, including
		// observations and cleanup. This lets the client distinguish an
		// explicit abort from a request that was cancelled before execution.
		if (!dropStarted) {
			childPort.postMessage({
				protocol: IFRAME_BRIDGE_PROTOCOL,
				version: BRIDGE_PROTOCOL_VERSION,
				type: 'started',
				sessionId: request.sessionId,
				frameInstanceId: request.frameInstanceId,
				treeRevision,
				requestId: request.requestId,
				method,
			})
		}
		if (method === 'clickElement' || method === 'inputText') {
			for (const pointer of actionPointerFeedback) {
				childPort.postMessage({
					protocol: IFRAME_BRIDGE_PROTOCOL,
					version: BRIDGE_PROTOCOL_VERSION,
					type: 'pointer',
					sessionId: request.sessionId,
					frameInstanceId: request.frameInstanceId,
					treeRevision,
					requestId: request.requestId,
					...pointer,
				})
			}
		}
		if (dropResponses) return
		if (method === 'getBrowserState') treeRevision = responseTreeRevision
		const result =
			method === 'getBrowserState'
				? {
						url: `${CHILD_ORIGIN}/child.html`,
						title: 'Child',
						header: 'Child header',
						content: '[1]<button>Remote</button>\n  *[2]<input>\nRemote [1] ordinary',
						footer: 'Child footer',
						treeRevision,
						indices: [1, 2],
					}
				: method === 'cleanUpHighlights'
					? undefined
					: actionResult
		if (dropResponses) return
		childPort.postMessage({
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'response',
			sessionId: request.sessionId,
			frameInstanceId: request.frameInstanceId,
			treeRevision,
			requestId: request.requestId,
			method,
			ok: true,
			result,
		})
	}

	const originalPostMessage = childWindow.postMessage.bind(childWindow)
	Object.defineProperty(childWindow, 'postMessage', {
		configurable: true,
		value: (message: Record<string, unknown>, _origin: string, transfer?: Transferable[]) => {
			if (message.type === 'discover') {
				dispatchAvailable(message.sessionId as string)
				return
			}
			if (message.type === 'connect') {
				activeSessionId = message.sessionId as string
				activeFrameInstanceId = message.frameInstanceId as string
				childPort = (transfer?.[0] as MessagePort | undefined) ?? null
				if (!childPort) return
				childPort.addEventListener('message', (event) =>
					handleRequest(event.data as Record<string, unknown>)
				)
				childPort.start()
				childPort.postMessage({
					protocol: IFRAME_BRIDGE_PROTOCOL,
					version: BRIDGE_PROTOCOL_VERSION,
					type: 'connected',
					sessionId: message.sessionId,
					frameInstanceId: message.frameInstanceId,
					treeRevision,
					capabilities: ALL_CAPABILITIES,
				})
			}
		},
	})

	return {
		ownerWindow,
		iframe,
		childWindow,
		setActionResult(result) {
			actionResult = result
		},
		setResponseTreeRevision(revision) {
			responseTreeRevision = revision
		},
		setDropStarted(drop) {
			dropStarted = drop
		},
		setDropResponses(drop) {
			dropResponses = drop
		},
		setActionPointerFeedback(pointers) {
			actionPointerFeedback = pointers
		},
		sendPointer(pointer, requestId) {
			childPort?.postMessage({
				protocol: IFRAME_BRIDGE_PROTOCOL,
				version: BRIDGE_PROTOCOL_VERSION,
				type: 'pointer',
				sessionId: activeSessionId,
				frameInstanceId: activeFrameInstanceId,
				treeRevision,
				requestId,
				...pointer,
			})
		},
		dispose() {
			disposed = true
			childPort?.close()
			Object.defineProperty(childWindow, 'postMessage', {
				configurable: true,
				value: originalPostMessage,
			})
			iframe.remove()
		},
	}
}
