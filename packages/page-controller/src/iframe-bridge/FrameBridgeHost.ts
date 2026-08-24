import {
	fingerprintFrameBridgeTarget,
	hashFrameBridgePayload,
	summarizeFrameBridgePayload,
	summarizeFrameBridgeTarget,
} from './action-security'
import {
	BRIDGE_PROTOCOL_VERSION,
	BridgeErrorCode,
	FRAME_BRIDGE_CAPABILITIES,
	IFRAME_BRIDGE_PROTOCOL,
	isBridgeCancelMessage,
	isBridgeCommitActionMessage,
	isBridgeConnectMessage,
	isBridgeDiscoverMessage,
	isBridgePrepareActionMessage,
	isBridgeRequestMessage,
	isBridgeWindowMessage,
	isHorizontalScrollPayload,
	isIndexPayload,
	isInputPayload,
	isScrollPayload,
	isSelectPayload,
} from './protocol'

import type {
	BridgeActionPayloadSummary,
	BridgeAvailableMessage,
	BridgeCancelMessage,
	BridgeCommitActionMessage,
	BridgeConnectedMessage,
	BridgeConnectMessage,
	BridgeErrorCode as BridgeErrorCodeType,
	BridgePointerMessage,
	BridgePortMessage,
	BridgePrepareActionMessage,
	BridgeRequestMessage,
	BridgeResponseMessage,
	BridgeStartedMessage,
	BridgeSuccessResponseMessage,
	FrameBridgeActionMethod,
	FrameBridgeCapability,
	FrameBridgeMethod,
	FrameBridgePolicyDecision,
	FrameBridgePreparedAction,
	SerializedBridgeError,
} from './protocol'
import type {
	HorizontalScrollOptions,
	IndexedBrowserState,
	IndexedPageControllerAdapter,
	PageActionResult,
	ScrollOptions,
} from '../PageController'

export interface FrameBridgePolicyController extends IndexedPageControllerAdapter {
	/** Resolve a current, root-contained target without exposing it over RPC. */
	getIndexedElementForPolicy(index: number): HTMLElement
}

export interface FrameBridgeActionPolicyRequest {
	readonly method: FrameBridgeActionMethod
	readonly capability: FrameBridgeCapability
	readonly summary: BridgeActionPayloadSummary
	readonly target?: Element
	readonly parentOrigin: string
	readonly signal: AbortSignal
}

export interface FrameBridgeActionPolicyDecisionDetail {
	decision: FrameBridgePolicyDecision
	reason?: string
}

export type FrameBridgeActionPolicyDecision = boolean | FrameBridgeActionPolicyDecisionDetail

export type FrameBridgeActionPolicy = (
	request: FrameBridgeActionPolicyRequest
) => FrameBridgeActionPolicyDecision | Promise<FrameBridgeActionPolicyDecision>

export interface FrameBridgeTransformStateContext {
	readonly parentOrigin: string
	readonly signal: AbortSignal
}

export type FrameBridgeTransformState = (
	state: IndexedBrowserState,
	context: FrameBridgeTransformStateContext
) => IndexedBrowserState | Promise<IndexedBrowserState>

/** The subset of MessagePort used by the bridge. */
export interface FrameBridgeMessagePort {
	onmessage: ((event: MessageEvent<unknown>) => void) | null
	onmessageerror?: ((event: MessageEvent<unknown>) => void) | null
	postMessage(message: unknown): void
	start?: () => void
	close?: () => void
}

/**
 * Window methods used by the host. Keeping this structural makes the host
 * straightforward to test without creating a real browser window.
 */
export interface FrameBridgeHostWindow {
	readonly parent: unknown
	addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
	removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
}

interface BridgeWindowMessageEvent {
	readonly data: unknown
	readonly origin: string
	readonly source: unknown
	readonly ports?: readonly FrameBridgeMessagePort[]
}

interface BridgePortMessageEvent {
	readonly data: unknown
}

export interface FrameBridgeHostOptions {
	/** Controller owned by the child iframe. */
	controller: FrameBridgePolicyController
	/** Exact parent origins allowed to discover/connect to this host. */
	allowedParentOrigins: readonly string[]
	/** Capabilities exposed to a parent. Defaults to all safe bridge capabilities. */
	capabilities?: readonly FrameBridgeCapability[]
	/** Stable for this host lifetime; a new host/navigation must use a new id. */
	frameInstanceId?: string
	/** Window-like object, primarily useful for unit tests. */
	window?: FrameBridgeHostWindow
	/** Event target that emits PageController visual pointer events. Defaults to window. */
	pointerEventTarget?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
	/** Whether dispose() also disposes the supplied controller (default: true). */
	disposeController?: boolean
	/** Child-owned policy that can only narrow bridge action access. */
	actionPolicy?: FrameBridgeActionPolicy
	/** Redact browser state before it leaves the child origin. */
	transformState?: FrameBridgeTransformState
	/** Lifetime of a prepared, single-use action token (default: 60 seconds). */
	preparedActionTtlMs?: number
}

type InboundRequestMessage =
	| BridgeRequestMessage
	| BridgePrepareActionMessage
	| BridgeCommitActionMessage

interface PendingRequest {
	message: InboundRequestMessage
	method: FrameBridgeMethod
	abortController: AbortController
	state: 'queued' | 'running'
}

interface PreparedActionRecord {
	readonly preparedActionId: string
	readonly method: FrameBridgeActionMethod
	readonly treeRevision: number
	readonly payloadHash: string
	readonly summary: BridgeActionPayloadSummary
	readonly target: HTMLElement | undefined
	readonly fingerprint: string
	readonly decision: FrameBridgePolicyDecision
	readonly reason?: string
	readonly expiresAt: number
}

interface ActiveConnection {
	readonly sessionId: string
	readonly origin: string
	readonly port: FrameBridgeMessagePort
	treeRevision: number
	hasObserved: boolean
	pending: Map<string, PendingRequest>
	queue: PendingRequest[]
	running: PendingRequest | null
	processing: boolean
	preparedActions: Map<string, PreparedActionRecord>
}

class BridgeHostError extends Error {
	readonly code: BridgeErrorCodeType

	constructor(code: BridgeErrorCodeType, message: string) {
		super(message)
		this.name = 'BridgeHostError'
		this.code = code
	}
}

const DEFAULT_CAPABILITIES: readonly FrameBridgeCapability[] = FRAME_BRIDGE_CAPABILITIES
const DEFAULT_PREPARED_ACTION_TTL_MS = 60_000

const METHOD_CAPABILITY: Readonly<Record<FrameBridgeMethod, FrameBridgeCapability>> = {
	getBrowserState: 'observe',
	clickElement: 'click',
	inputText: 'input',
	selectOption: 'select',
	scroll: 'scroll',
	scrollHorizontally: 'scrollHorizontally',
	cleanUpHighlights: 'cleanup',
}

const NO_PAYLOAD_METHODS = new Set<FrameBridgeMethod>(['getBrowserState', 'cleanUpHighlights'])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys)
	return Object.keys(value).every((key) => allowed.has(key))
}

function normalizeOrigin(origin: string): string {
	if (
		typeof origin !== 'string' ||
		origin.length === 0 ||
		origin === 'null' ||
		origin.includes('*') ||
		origin.trim() !== origin
	) {
		throw new TypeError('allowedParentOrigins must contain exact, non-wildcard origins')
	}

	let parsed: URL
	try {
		parsed = new URL(origin)
	} catch {
		throw new TypeError(`Invalid parent origin: ${origin}`)
	}

	// URL.origin is "null" for opaque origins (for example data: and file:).
	if (
		parsed.origin === 'null' ||
		(parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
		parsed.username !== '' ||
		parsed.password !== ''
	) {
		throw new TypeError(`Parent origin must be an HTTP(S) origin: ${origin}`)
	}

	// A path, query, or fragment is not part of an origin and is almost always a
	// configuration error. A trailing slash is harmless and is normalized away.
	if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
		throw new TypeError(`Parent origin must not contain a path or query: ${origin}`)
	}

	return parsed.origin
}

function makeFrameInstanceId(): string {
	const cryptoObject = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined
	if (cryptoObject?.randomUUID) return cryptoObject.randomUUID()
	return `frame-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isSafeFrameInstanceId(value: unknown): value is string {
	return isSafeIdentifier(value)
}

function isValidCapabilities(value: readonly FrameBridgeCapability[]): boolean {
	return (
		new Set(value).size === value.length &&
		value.every((capability) =>
			(FRAME_BRIDGE_CAPABILITIES as readonly string[]).includes(capability)
		)
	)
}

function combinePolicyDecisions(
	...decisions: FrameBridgePolicyDecision[]
): FrameBridgePolicyDecision {
	if (decisions.includes('deny')) return 'deny'
	if (decisions.includes('approval_required')) return 'approval_required'
	return 'allow'
}

function normalizeActionPolicyDecision(value: unknown): FrameBridgePolicyDecision {
	return value === 'allow' || value === 'deny' || value === 'approval_required' ? value : 'deny'
}

function sanitizePolicyReason(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0)
		return code <= 31 || code === 127 ? ' ' : character
	})
		.join('')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 1024)
}

function connectionOrigin(target: Element): string {
	try {
		return target.ownerDocument.location.origin
	} catch {
		return ''
	}
}

function sameActionSummary(
	left: BridgeActionPayloadSummary,
	right: BridgeActionPayloadSummary
): boolean {
	for (const key of [
		'index',
		'textLength',
		'optionLength',
		'down',
		'right',
		'numPages',
		'pixels',
	] as const) {
		if (left[key] !== right[key]) return false
	}
	return true
}

function asWindowMessageEvent(
	event: MessageEvent<unknown> | BridgeWindowMessageEvent
): BridgeWindowMessageEvent {
	return event as BridgeWindowMessageEvent
}

function serializeError(error: unknown, signal?: AbortSignal): SerializedBridgeError {
	const isAbortError =
		typeof DOMException !== 'undefined' &&
		error instanceof DOMException &&
		error.name === 'AbortError'
	if (signal?.aborted || isAbortError) {
		return {
			code: BridgeErrorCode.ABORTED,
			message: 'Bridge request was cancelled.',
		}
	}

	if (error instanceof BridgeHostError) {
		return { code: error.code, message: error.message }
	}

	return {
		code: BridgeErrorCode.INTERNAL_ERROR,
		message: error instanceof Error ? error.message : String(error),
	}
}

function isPageActionResult(value: unknown): value is PageActionResult {
	return isRecord(value) && typeof value.success === 'boolean' && typeof value.message === 'string'
}

function isIndexedBrowserState(value: unknown): value is IndexedBrowserState {
	return (
		isRecord(value) &&
		typeof value.url === 'string' &&
		typeof value.title === 'string' &&
		typeof value.header === 'string' &&
		typeof value.content === 'string' &&
		typeof value.footer === 'string' &&
		Number.isSafeInteger(value.treeRevision) &&
		Number(value.treeRevision) >= 0 &&
		Array.isArray(value.indices) &&
		value.indices.every((index) => Number.isSafeInteger(index) && Number(index) >= 0)
	)
}

/**
 * Child-side endpoint for the cooperative iframe bridge.
 *
 * The parent owns the MessageChannel and transfers one port in the `connect`
 * message. This host never exposes arbitrary JavaScript execution: that method
 * is intentionally absent from the bridge method union and dispatch table.
 */
export class FrameBridgeHost {
	readonly controller: FrameBridgePolicyController
	readonly frameInstanceId: string
	readonly allowedParentOrigins: readonly string[]
	readonly capabilities: readonly FrameBridgeCapability[]

	private readonly bridgeWindow: FrameBridgeHostWindow
	private readonly pointerEventTarget: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
	private readonly disposeController: boolean
	private readonly actionPolicy: FrameBridgeActionPolicy | undefined
	private readonly transformState: FrameBridgeTransformState | undefined
	private readonly preparedActionTtlMs: number
	private readonly discoveredSessions = new Map<string, string>()
	/**
	 * Serializes controller calls across connection replacements as well as
	 * requests on one connection. A detached old connection can still hold this
	 * lock until an adapter promise settles, so a new iframe cannot race it.
	 */
	private executionTail: Promise<void> = Promise.resolve()
	private activeConnection: ActiveConnection | null = null
	private started = false
	private disposed = false

	private readonly windowMessageListener = (event: MessageEvent<unknown>) => {
		this.handleWindowMessage(asWindowMessageEvent(event))
	}

	private readonly movePointerListener: EventListener = (event) => {
		const detail = (event as CustomEvent<unknown>).detail
		if (
			!isRecord(detail) ||
			typeof detail.x !== 'number' ||
			!Number.isFinite(detail.x) ||
			typeof detail.y !== 'number' ||
			!Number.isFinite(detail.y)
		) {
			return
		}
		this.forwardPointer({ action: 'move', x: detail.x, y: detail.y })
	}

	private readonly clickPointerListener: EventListener = () => {
		this.forwardPointer({ action: 'click' })
	}

	constructor(options: FrameBridgeHostOptions) {
		if (!options || !options.controller)
			throw new TypeError('FrameBridgeHost requires a controller')

		if (typeof options.controller.getIndexedElementForPolicy !== 'function') {
			throw new TypeError('FrameBridgeHost requires a policy-aware controller')
		}
		this.controller = options.controller
		this.allowedParentOrigins = Object.freeze(
			Array.from(new Set(options.allowedParentOrigins.map(normalizeOrigin)))
		)
		if (this.allowedParentOrigins.length === 0) {
			throw new TypeError('FrameBridgeHost requires at least one allowed parent origin')
		}

		const configuredCapabilities = options.capabilities
			? Array.from(options.capabilities)
			: Array.from(DEFAULT_CAPABILITIES)
		if (!isValidCapabilities(configuredCapabilities)) {
			throw new TypeError('FrameBridgeHost capabilities contain an unknown or duplicate value')
		}
		this.capabilities = Object.freeze(configuredCapabilities)

		this.frameInstanceId = options.frameInstanceId ?? makeFrameInstanceId()
		if (!isSafeFrameInstanceId(this.frameInstanceId)) {
			throw new TypeError(
				'frameInstanceId must be a non-empty string no longer than 256 characters'
			)
		}

		const defaultWindow = typeof window === 'undefined' ? undefined : window
		this.bridgeWindow = (options.window ?? defaultWindow) as FrameBridgeHostWindow
		if (!this.bridgeWindow) throw new Error('FrameBridgeHost requires a browser window')
		this.pointerEventTarget =
			options.pointerEventTarget ??
			(this.bridgeWindow as unknown as Pick<
				EventTarget,
				'addEventListener' | 'removeEventListener'
			>)
		this.disposeController = options.disposeController ?? true
		this.actionPolicy = options.actionPolicy
		this.transformState = options.transformState
		if (
			options.preparedActionTtlMs !== undefined &&
			(!Number.isFinite(options.preparedActionTtlMs) || options.preparedActionTtlMs <= 0)
		)
			throw new TypeError('preparedActionTtlMs must be a positive finite number')
		this.preparedActionTtlMs = options.preparedActionTtlMs ?? DEFAULT_PREPARED_ACTION_TTL_MS
	}

	/** Register the global discover/connect listener. Calling start twice is safe. */
	start(): this {
		if (this.disposed)
			throw new BridgeHostError(BridgeErrorCode.DISPOSED, 'Bridge host is disposed.')
		if (!this.started) {
			this.bridgeWindow.addEventListener('message', this.windowMessageListener)
			this.pointerEventTarget.addEventListener('PageAgent::MovePointerTo', this.movePointerListener)
			this.pointerEventTarget.addEventListener('PageAgent::ClickPointer', this.clickPointerListener)
			this.started = true
		}
		return this
	}

	/** Close the port, cancel requests, remove listeners, and release the controller. */
	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		if (this.started) {
			this.bridgeWindow.removeEventListener('message', this.windowMessageListener)
			this.pointerEventTarget.removeEventListener(
				'PageAgent::MovePointerTo',
				this.movePointerListener
			)
			this.pointerEventTarget.removeEventListener(
				'PageAgent::ClickPointer',
				this.clickPointerListener
			)
			this.started = false
		}
		this.discoveredSessions.clear()
		this.closeActiveConnection()
		if (this.disposeController) this.controller.dispose()
	}

	private handleWindowMessage(event: BridgeWindowMessageEvent): void {
		if (this.disposed || !this.started) return
		if (!event.source || !this.bridgeWindow.parent || event.source !== this.bridgeWindow.parent)
			return
		if (!this.allowedParentOrigins.includes(event.origin)) return

		const message = event.data
		if (isBridgeDiscoverMessage(message)) {
			this.handleDiscover(event, message)
			return
		}
		if (isBridgeConnectMessage(message)) {
			this.handleConnect(event, message)
			return
		}

		// A child host only consumes global handshake messages. Requests sent to
		// window instead of the dedicated port are deliberately ignored.
		if (isBridgeWindowMessage(message)) return
	}

	private handleDiscover(event: BridgeWindowMessageEvent, message: { sessionId: string }): void {
		this.discoveredSessions.set(message.sessionId, event.origin)

		const available: BridgeAvailableMessage = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'available',
			sessionId: message.sessionId,
			frameInstanceId: this.frameInstanceId,
			capabilities: Array.from(this.capabilities),
		}
		this.postToParent(event.source, event.origin, available)
	}

	private handleConnect(event: BridgeWindowMessageEvent, message: BridgeConnectMessage): void {
		if (message.frameInstanceId !== this.frameInstanceId) return
		if (this.discoveredSessions.get(message.sessionId) !== event.origin) return

		if (!event.ports || event.ports.length !== 1) return
		const port = event.ports[0]
		if (!port || typeof port.postMessage !== 'function') return

		this.closeActiveConnection()
		this.discoveredSessions.delete(message.sessionId)
		const connection: ActiveConnection = {
			sessionId: message.sessionId,
			origin: event.origin,
			port,
			treeRevision: 0,
			hasObserved: false,
			pending: new Map(),
			queue: [],
			running: null,
			processing: false,
			preparedActions: new Map(),
		}
		this.activeConnection = connection
		port.onmessage = (portEvent: MessageEvent<unknown>) => {
			this.handlePortMessage(connection, { data: portEvent.data })
		}
		if (port.start) port.start()

		const connected: BridgeConnectedMessage = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'connected' as const,
			sessionId: connection.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: connection.treeRevision,
			capabilities: Array.from(this.capabilities),
		}
		this.postToPort(connection, connected)
	}

	private postToParent(target: unknown, origin: string, message: BridgeAvailableMessage): void {
		if (!target || typeof (target as { postMessage?: unknown }).postMessage !== 'function') return
		try {
			;(target as { postMessage(message: unknown, targetOrigin: string): void }).postMessage(
				message,
				origin
			)
		} catch {
			// The parent may have navigated away between discover and available.
		}
	}

	private postToPort(connection: ActiveConnection, message: unknown): void {
		if (this.activeConnection !== connection) return
		try {
			connection.port.postMessage(message)
		} catch {
			this.closeActiveConnection()
		}
	}

	/** Relay pointer feedback only while the authenticated parent is running a pointer action. */
	private forwardPointer(
		pointer: { action: 'move'; x: number; y: number } | { action: 'click' }
	): void {
		const connection = this.activeConnection
		const running = connection?.running
		if (
			!connection ||
			!running ||
			running.abortController.signal.aborted ||
			(running.method !== 'clickElement' && running.method !== 'inputText')
		) {
			return
		}

		const message: BridgePointerMessage = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'pointer',
			sessionId: connection.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: running.message.requestId,
			...pointer,
		}
		this.postToPort(connection, message)
	}

	private handlePortMessage(connection: ActiveConnection, event: BridgePortMessageEvent): void {
		if (this.disposed || this.activeConnection !== connection) return
		const message = event.data

		if (isBridgeRequestMessage(message)) {
			this.handleRequest(connection, message)
			return
		}
		if (isBridgePrepareActionMessage(message) || isBridgeCommitActionMessage(message)) {
			this.handleRequest(connection, message)
			return
		}
		if (isBridgeCancelMessage(message)) {
			this.handleCancel(connection, message)
			return
		}

		// Strictly reject malformed/forbidden request envelopes when enough safe
		// metadata is available to correlate an error. Unknown methods (including
		// executeJavascript) are never dispatched to the supplied controller.
		this.rejectUnknownRequest(connection, message)
	}

	private handleRequest(connection: ActiveConnection, message: InboundRequestMessage): void {
		if (message.sessionId !== connection.sessionId) {
			this.sendError(
				connection,
				message,
				BridgeErrorCode.SESSION_MISMATCH,
				'Bridge session does not match.'
			)
			return
		}
		if (message.frameInstanceId !== this.frameInstanceId) {
			this.sendError(
				connection,
				message,
				BridgeErrorCode.FRAME_MISMATCH,
				'Bridge frame instance does not match.'
			)
			return
		}

		if (connection.pending.has(message.requestId)) {
			this.sendError(connection, message, BridgeErrorCode.INVALID_PAYLOAD, 'Duplicate request id.')
			return
		}

		const capability = METHOD_CAPABILITY[message.method]
		if (!this.capabilities.includes(capability)) {
			this.sendError(
				connection,
				message,
				BridgeErrorCode.CAPABILITY_DENIED,
				`Capability "${capability}" is not enabled.`
			)
			return
		}

		const payload = 'payload' in message ? message.payload : undefined
		if (message.type !== 'prepare-action' && !this.validatePayload(message.method, payload)) {
			this.sendError(
				connection,
				message,
				BridgeErrorCode.INVALID_PAYLOAD,
				'Invalid request payload.'
			)
			return
		}

		const pending: PendingRequest = {
			message,
			method: message.method,
			abortController: new AbortController(),
			state: 'queued',
		}
		connection.pending.set(message.requestId, pending)
		connection.queue.push(pending)
		void this.processQueue(connection)
	}

	/**
	 * Execute one request at a time per connection. Besides preventing DOM
	 * operations from racing, this makes the tree revision check authoritative:
	 * an action waits for all earlier observations and is checked immediately
	 * before it starts.
	 */
	private async processQueue(connection: ActiveConnection): Promise<void> {
		if (connection.processing || this.activeConnection !== connection) return
		connection.processing = true
		try {
			while (this.activeConnection === connection && connection.queue.length > 0) {
				const pending = connection.queue.shift()!
				const message = pending.message
				if (connection.pending.get(message.requestId) !== pending) continue

				await this.executeRequest(connection, pending)
				connection.running = null
			}
		} finally {
			connection.processing = false
			if (this.activeConnection === connection && connection.queue.length > 0 && !this.disposed) {
				void this.processQueue(connection)
			}
		}
	}

	private validateRevision(
		connection: ActiveConnection,
		message: InboundRequestMessage
	): { code: BridgeErrorCodeType; message: string } | null {
		// Observation can intentionally refresh a stale tree. All index-based
		// actions must use the revision returned by the latest observation.
		if (message.type === 'request' && message.method === 'getBrowserState') return null
		if (message.type === 'request' && message.method === 'cleanUpHighlights') return null
		if (!connection.hasObserved) {
			return {
				code: BridgeErrorCode.STALE_TREE,
				message: 'Observe the iframe before sending index-based actions.',
			}
		}
		if (message.treeRevision !== connection.treeRevision) {
			return {
				code: BridgeErrorCode.STALE_TREE,
				message: `Tree revision ${message.treeRevision} is stale; current revision is ${connection.treeRevision}.`,
			}
		}
		return null
	}

	private validatePayload(method: FrameBridgeMethod, payload: unknown): boolean {
		if (NO_PAYLOAD_METHODS.has(method)) {
			return (
				payload === undefined ||
				payload === null ||
				(isRecord(payload) && Object.keys(payload).length === 0)
			)
		}

		if (method === 'clickElement') {
			return isRecord(payload) && hasOnlyKeys(payload, ['index']) && isIndexPayload(payload)
		}
		if (method === 'inputText') {
			return isRecord(payload) && hasOnlyKeys(payload, ['index', 'text']) && isInputPayload(payload)
		}
		if (method === 'selectOption') {
			return (
				isRecord(payload) &&
				hasOnlyKeys(payload, ['index', 'optionText']) &&
				isSelectPayload(payload)
			)
		}
		if (method === 'scroll') {
			return (
				isRecord(payload) &&
				hasOnlyKeys(payload, ['down', 'numPages', 'pixels', 'index']) &&
				isScrollPayload(payload)
			)
		}
		if (method === 'scrollHorizontally') {
			return (
				isRecord(payload) &&
				hasOnlyKeys(payload, ['right', 'pixels', 'index']) &&
				isHorizontalScrollPayload(payload)
			)
		}
		return false
	}

	private async executeRequest(
		connection: ActiveConnection,
		pending: PendingRequest
	): Promise<void> {
		const message = pending.message
		const releaseExecution = await this.acquireExecutionSlot()
		try {
			// The connection may have been replaced while this request waited for
			// the global controller lock. Never leak old work into a new port.
			if (
				this.activeConnection !== connection ||
				connection.pending.get(message.requestId) !== pending
			) {
				return
			}
			if (pending.abortController.signal.aborted) {
				connection.pending.delete(message.requestId)
				this.sendError(
					connection,
					message,
					BridgeErrorCode.ABORTED,
					'Bridge request was cancelled before it started.'
				)
				return
			}

			const revisionError = this.validateRevision(connection, message)
			if (revisionError) {
				connection.pending.delete(message.requestId)
				this.sendError(connection, message, revisionError.code, revisionError.message)
				return
			}

			pending.state = 'running'
			connection.running = pending
			if (message.type === 'prepare-action') {
				const prepared = await this.prepareAction(
					connection,
					message,
					pending.abortController.signal
				)
				this.sendSuccess(connection, message, prepared)
				return
			}

			let actionPayload: unknown
			if (message.type === 'commit-action') {
				actionPayload = await this.consumePreparedAction(
					connection,
					message,
					pending.abortController.signal
				)
			} else if (message.method !== 'getBrowserState' && message.method !== 'cleanUpHighlights') {
				const inline = await this.evaluateAction(
					connection,
					message.method,
					message.payload,
					pending.abortController.signal
				)
				if (inline.decision === 'deny')
					throw new BridgeHostError(
						BridgeErrorCode.CAPABILITY_DENIED,
						inline.reason ?? 'Action denied by child policy.'
					)
				if (inline.decision === 'approval_required')
					throw new BridgeHostError(
						BridgeErrorCode.APPROVAL_REQUIRED,
						inline.reason ?? 'Action requires approval.'
					)
				actionPayload = message.payload
			}

			this.sendStarted(connection, message)
			if (this.activeConnection !== connection) return

			const result = await this.dispatchRequest(
				message.method,
				message.type === 'request' ? message.payload : actionPayload,
				pending.abortController.signal,
				connection
			)
			if (pending.abortController.signal.aborted) {
				throw new BridgeHostError(BridgeErrorCode.ABORTED, 'Bridge request was cancelled.')
			}

			if (message.type === 'request' && message.method === 'getBrowserState') {
				if (!isIndexedBrowserState(result)) {
					throw new BridgeHostError(
						BridgeErrorCode.INTERNAL_ERROR,
						'Controller returned an invalid indexed browser state.'
					)
				}
				if (result.treeRevision < connection.treeRevision) {
					throw new BridgeHostError(
						BridgeErrorCode.STALE_TREE,
						`Controller returned tree revision ${result.treeRevision} behind current revision ${connection.treeRevision}.`
					)
				}
				connection.treeRevision = result.treeRevision
				connection.hasObserved = true
			} else if (message.method !== 'cleanUpHighlights' && !isPageActionResult(result)) {
				throw new BridgeHostError(
					BridgeErrorCode.INTERNAL_ERROR,
					'Controller returned an invalid action result.'
				)
			}

			this.sendSuccess(connection, message, result)
		} catch (error) {
			const serialized = serializeError(error, pending.abortController.signal)
			this.sendError(connection, message, serialized.code, serialized.message)
		} finally {
			if (connection.pending.get(message.requestId) === pending) {
				connection.pending.delete(message.requestId)
			}
			releaseExecution()
		}
	}

	private sendStarted(connection: ActiveConnection, message: InboundRequestMessage): void {
		const started: BridgeStartedMessage = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'started',
			sessionId: connection.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: message.requestId,
			method: message.method,
		}
		this.postToPort(connection, started)
	}

	private async prepareAction(
		connection: ActiveConnection,
		message: BridgePrepareActionMessage,
		signal: AbortSignal
	): Promise<FrameBridgePreparedAction> {
		this.sweepPreparedActions(connection)
		const evaluation = await this.evaluateActionFromSummary(
			connection,
			message.method,
			message.summary,
			signal
		)
		const preparedActionId = makeFrameInstanceId()
		if (evaluation.decision !== 'deny') {
			connection.preparedActions.set(preparedActionId, {
				preparedActionId,
				method: message.method,
				treeRevision: message.treeRevision,
				payloadHash: message.payloadHash,
				summary: message.summary,
				target: evaluation.target,
				fingerprint: evaluation.fingerprint,
				decision: evaluation.decision,
				reason: evaluation.reason,
				expiresAt: Date.now() + this.preparedActionTtlMs,
			})
		}
		return {
			preparedActionId,
			method: message.method,
			payloadHash: message.payloadHash,
			decision: evaluation.decision,
			reason: evaluation.reason,
			target: summarizeFrameBridgeTarget(evaluation.target),
		}
	}

	private async consumePreparedAction(
		connection: ActiveConnection,
		message: BridgeCommitActionMessage,
		signal: AbortSignal
	): Promise<unknown> {
		this.sweepPreparedActions(connection)
		const prepared = connection.preparedActions.get(message.preparedActionId)
		connection.preparedActions.delete(message.preparedActionId)
		if (!prepared || prepared.expiresAt <= Date.now())
			throw new BridgeHostError(
				BridgeErrorCode.APPROVAL_DENIED,
				'Prepared action is missing, expired, or already consumed.'
			)
		if (
			prepared.method !== message.method ||
			prepared.treeRevision !== message.treeRevision ||
			prepared.treeRevision !== connection.treeRevision
		)
			throw new BridgeHostError(BridgeErrorCode.STALE_TREE, 'Prepared action tree is stale.')
		if ((await hashFrameBridgePayload(message.payload)) !== prepared.payloadHash)
			throw new BridgeHostError(BridgeErrorCode.APPROVAL_DENIED, 'Prepared action payload changed.')
		if (
			!sameActionSummary(
				prepared.summary,
				summarizeFrameBridgePayload(message.method, message.payload)
			)
		)
			throw new BridgeHostError(
				BridgeErrorCode.APPROVAL_DENIED,
				'Prepared action summary does not match the committed payload.'
			)
		const current = await this.evaluateActionFromSummary(
			connection,
			message.method,
			prepared.summary,
			signal
		)
		if (current.target !== prepared.target || current.fingerprint !== prepared.fingerprint)
			throw new BridgeHostError(BridgeErrorCode.STALE_TREE, 'Prepared action target changed.')
		if (current.decision === 'deny')
			throw new BridgeHostError(
				BridgeErrorCode.CAPABILITY_DENIED,
				current.reason ?? 'Action denied by child policy.'
			)
		if (
			(prepared.decision === 'approval_required' || current.decision === 'approval_required') &&
			!message.approved
		)
			throw new BridgeHostError(
				BridgeErrorCode.APPROVAL_REQUIRED,
				current.reason ?? prepared.reason ?? 'Action requires approval.'
			)
		return message.payload
	}

	private async evaluateAction(
		connection: ActiveConnection,
		method: FrameBridgeActionMethod,
		payload: unknown,
		signal: AbortSignal
	): Promise<{
		target: HTMLElement | undefined
		fingerprint: string
		decision: FrameBridgePolicyDecision
		reason?: string
	}> {
		return this.evaluateActionFromSummary(
			connection,
			method,
			summarizeFrameBridgePayload(method, payload),
			signal
		)
	}

	private async evaluateActionFromSummary(
		connection: ActiveConnection,
		method: FrameBridgeActionMethod,
		summary: BridgeActionPayloadSummary,
		signal: AbortSignal
	): Promise<{
		target: HTMLElement | undefined
		fingerprint: string
		decision: FrameBridgePolicyDecision
		reason?: string
	}> {
		if (signal.aborted)
			throw new BridgeHostError(BridgeErrorCode.ABORTED, 'Bridge request was cancelled.')
		let target: HTMLElement | undefined
		try {
			target =
				typeof summary.index === 'number'
					? this.controller.getIndexedElementForPolicy(summary.index)
					: undefined
		} catch {
			throw new BridgeHostError(BridgeErrorCode.STALE_TREE, 'Action target is unavailable.')
		}
		const fingerprint = fingerprintFrameBridgeTarget(target)
		const before = this.evaluateBuiltInPolicy(target, method)
		let custom: FrameBridgePolicyDecision = 'allow'
		let reason: string | undefined
		if (this.actionPolicy) {
			const value = await this.actionPolicy({
				method,
				capability: METHOD_CAPABILITY[method],
				summary,
				target,
				parentOrigin: connection.origin,
				signal,
			})
			if (typeof value === 'boolean') custom = value ? 'allow' : 'deny'
			else {
				custom = normalizeActionPolicyDecision(value.decision)
				reason = value.reason ? sanitizePolicyReason(value.reason) : undefined
			}
		}
		if (signal.aborted)
			throw new BridgeHostError(BridgeErrorCode.ABORTED, 'Bridge request was cancelled.')
		let currentTarget: HTMLElement | undefined
		try {
			currentTarget =
				typeof summary.index === 'number'
					? this.controller.getIndexedElementForPolicy(summary.index)
					: undefined
		} catch {
			throw new BridgeHostError(BridgeErrorCode.STALE_TREE, 'Action target is unavailable.')
		}
		if (currentTarget !== target || fingerprintFrameBridgeTarget(currentTarget) !== fingerprint)
			throw new BridgeHostError(
				BridgeErrorCode.STALE_TREE,
				'Action target changed during child policy evaluation.'
			)
		const after = this.evaluateBuiltInPolicy(currentTarget, method)
		return {
			target,
			fingerprint,
			decision: combinePolicyDecisions(before, custom, after),
			reason,
		}
	}

	private evaluateBuiltInPolicy(
		target: Element | undefined,
		method: FrameBridgeActionMethod
	): FrameBridgePolicyDecision {
		if (!target) return 'allow'
		let decision: FrameBridgePolicyDecision = 'allow'
		let cursor: Element | null = target
		while (cursor) {
			const marker = cursor.getAttribute('data-page-agent-policy')
			if (marker && marker !== 'allow' && marker !== 'confirm' && marker !== 'deny')
				decision = 'deny'
			else if (marker === 'deny') decision = 'deny'
			else if (marker === 'confirm' && decision !== 'deny') decision = 'approval_required'
			cursor = cursor.parentElement
		}
		if (method !== 'clickElement') return decision

		const submitTarget = target.closest('button, input, form')
		const submitTag = submitTarget?.tagName.toLowerCase()
		const submitType = submitTarget?.getAttribute('type')?.toLowerCase()
		if (
			submitTag === 'form' ||
			(submitTag === 'button' && (submitType === undefined || submitType === 'submit')) ||
			(submitTag === 'input' && (submitType === 'submit' || submitType === 'image'))
		)
			decision = combinePolicyDecisions(decision, 'approval_required')

		const anchor = target.closest('a[href]') as HTMLAnchorElement | null
		if (anchor?.href) {
			try {
				if (new URL(anchor.href, target.ownerDocument.baseURI).origin !== connectionOrigin(target))
					decision = combinePolicyDecisions(decision, 'approval_required')
			} catch {
				decision = 'deny'
			}
		}
		return decision
	}

	private sweepPreparedActions(connection: ActiveConnection): void {
		const now = Date.now()
		for (const [id, prepared] of connection.preparedActions) {
			if (prepared.expiresAt <= now) connection.preparedActions.delete(id)
		}
	}

	private acquireExecutionSlot(): Promise<() => void> {
		const previous = this.executionTail
		let release!: () => void
		this.executionTail = new Promise<void>((resolve) => {
			release = resolve
		})
		return previous.then(() => release)
	}

	private async dispatchRequest(
		method: FrameBridgeMethod,
		payload: unknown,
		signal: AbortSignal,
		connection: ActiveConnection
	): Promise<IndexedBrowserState | PageActionResult | undefined> {
		if (signal.aborted) {
			throw new BridgeHostError(BridgeErrorCode.ABORTED, 'Bridge request was cancelled.')
		}
		switch (method) {
			case 'getBrowserState': {
				const raw = await this.controller.getBrowserState({ signal })
				if (!isIndexedBrowserState(raw))
					throw new BridgeHostError(
						BridgeErrorCode.INTERNAL_ERROR,
						'Controller returned an invalid indexed browser state.'
					)
				const rawTreeRevision = raw.treeRevision
				const rawIndices = [...raw.indices]
				const transformed = this.transformState
					? await this.transformState(raw, { parentOrigin: connection.origin, signal })
					: raw
				if (
					!isIndexedBrowserState(transformed) ||
					transformed.treeRevision !== rawTreeRevision ||
					transformed.indices.length !== rawIndices.length ||
					!transformed.indices.every((index, position) => index === rawIndices[position])
				)
					throw new BridgeHostError(
						BridgeErrorCode.INTERNAL_ERROR,
						'Transformed iframe state metadata is invalid.'
					)
				return transformed
			}
			case 'cleanUpHighlights':
				await this.controller.cleanUpHighlights()
				return undefined
			case 'clickElement':
				return this.controller.clickElement((payload as { index: number }).index, {
					signal,
				})
			case 'inputText': {
				const value = payload as { index: number; text: string }
				return this.controller.inputText(value.index, value.text, { signal })
			}
			case 'selectOption': {
				const value = payload as { index: number; optionText: string }
				return this.controller.selectOption(value.index, value.optionText, { signal })
			}
			case 'scroll':
				return this.controller.scroll(payload as ScrollOptions, { signal })
			case 'scrollHorizontally':
				return this.controller.scrollHorizontally(payload as HorizontalScrollOptions, {
					signal,
				})
		}
	}

	private handleCancel(connection: ActiveConnection, message: BridgeCancelMessage): void {
		if (!this.matchesConnection(connection, message)) return
		const pending = connection.pending.get(message.requestId)
		if (pending?.method === message.method) pending.abortController.abort()
	}

	private matchesConnection(
		connection: ActiveConnection,
		message: Pick<BridgePortMessage, 'sessionId' | 'frameInstanceId'>
	): boolean {
		return (
			message.sessionId === connection.sessionId && message.frameInstanceId === this.frameInstanceId
		)
	}

	private sendSuccess(
		connection: ActiveConnection,
		request: InboundRequestMessage,
		result: unknown
	): void {
		const response: BridgeSuccessResponseMessage = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'response',
			sessionId: connection.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: request.requestId,
			method: request.method,
			ok: true,
			result,
		}
		this.postToPort(connection, response)
	}

	private sendError(
		connection: ActiveConnection,
		request: Pick<InboundRequestMessage, 'requestId' | 'method'>,
		code: BridgeErrorCodeType,
		message: string
	): void {
		const response: BridgeResponseMessage = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'response',
			sessionId: connection.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: request.requestId,
			method: request.method,
			ok: false,
			error: { code, message },
		}
		this.postToPort(connection, response)
	}

	private rejectUnknownRequest(connection: ActiveConnection, value: unknown): void {
		if (!isRecord(value) || value.type !== 'request') return
		if (
			value.protocol !== IFRAME_BRIDGE_PROTOCOL ||
			value.version !== BRIDGE_PROTOCOL_VERSION ||
			!isSafeIdentifier(value.requestId) ||
			!isSafeIdentifier(value.method) ||
			!isSafeIdentifier(value.sessionId) ||
			!isSafeIdentifier(value.frameInstanceId) ||
			!Number.isSafeInteger(value.treeRevision) ||
			Number(value.treeRevision) < 0
		) {
			return
		}
		if (value.sessionId !== connection.sessionId || value.frameInstanceId !== this.frameInstanceId)
			return

		// Keep the raw method in the wire response so a caller can diagnose a
		// forbidden executeJavascript attempt. It is intentionally not accepted
		// by isBridgeRequestMessage and is never dispatched.
		const response = {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type: 'response' as const,
			sessionId: connection.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: value.requestId,
			method: value.method,
			ok: false as const,
			error: {
				code: BridgeErrorCode.UNSUPPORTED_METHOD,
				message: `Unsupported bridge method: ${value.method}`,
			},
		}
		this.postToPort(connection, response)
	}

	private closeActiveConnection(): void {
		const connection = this.activeConnection
		if (!connection) return
		this.activeConnection = null
		for (const pending of connection.pending.values()) pending.abortController.abort()
		connection.pending.clear()
		connection.queue.length = 0
		connection.running = null
		connection.preparedActions.clear()
		connection.port.onmessage = null
		if (connection.port.onmessageerror !== undefined) connection.port.onmessageerror = null
		try {
			connection.port.close?.()
		} catch {
			// Closing an already-closed MessagePort is harmless for the host.
		}
	}
}
