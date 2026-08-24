import { hashFrameBridgePayload, summarizeFrameBridgePayload } from './action-security'
import {
	BRIDGE_PROTOCOL_VERSION,
	type BridgeActionPayloadSummary,
	type BridgeAvailableMessage,
	BridgeErrorCode,
	type BridgeErrorCode as BridgeErrorCodeValue,
	type BridgePortMessage,
	type FrameBridgeActionMethod,
	type FrameBridgeCapability,
	type FrameBridgeMethod,
	type FrameBridgePreparedAction,
	type FrameBridgeTargetSummary,
	IFRAME_BRIDGE_PROTOCOL,
	isBridgeAvailableMessage,
	isBridgePortMessage,
	isBridgeResponseMessage,
} from './protocol'

import type {
	HorizontalScrollOptions,
	IndexedBrowserState,
	PageActionResult,
	PageControllerCallContext,
	ScrollOptions,
} from '../PageController'

/** Options for the parent-side client of an iframe bridge. */
export interface FrameBridgeClientOptions {
	iframe: HTMLIFrameElement
	allowedChildOrigins: readonly string[]
	handshakeTimeoutMs?: number
	requestTimeoutMs?: number
	window?: Window
	/** Direct-controller approval hook. Missing hooks fail closed for confirm targets. */
	onApprovalRequired?: FrameBridgeApprovalHandler
}

export interface FrameBridgeApprovalRequest {
	readonly method: FrameBridgeActionMethod
	readonly summary: BridgeActionPayloadSummary
	readonly target?: FrameBridgeTargetSummary
	readonly reason?: string
}

export type FrameBridgeApprovalHandler = (
	request: FrameBridgeApprovalRequest
) => boolean | Promise<boolean>

export interface FrameBridgeConnection {
	frameInstanceId: string
	origin: string
	capabilities: FrameBridgeCapability[]
}

/** Parent-facing visual pointer feedback emitted by an authenticated child host. */
export type FrameBridgePointerDetail =
	| { action: 'move'; x: number; y: number }
	| { action: 'click' }

interface PendingRequest {
	method: FrameBridgeMethod
	phase: 'request' | 'prepare' | 'commit'
	resolve: (value: unknown) => void
	reject: (reason?: unknown) => void
	timer: ReturnType<typeof setTimeout>
	started: boolean
	posted: boolean
	abortCleanup?: () => void
}

/**
 * Error returned by the cooperative iframe bridge.
 *
 * `code` is intentionally stable so an integrator can distinguish a stale
 * observation from a timeout or an unknown outcome without parsing messages.
 */
export class FrameBridgeError extends Error {
	readonly code: BridgeErrorCodeValue

	constructor(code: BridgeErrorCodeValue, message: string) {
		super(message)
		this.name = code === BridgeErrorCode.ABORTED ? 'AbortError' : 'FrameBridgeError'
		this.code = code
	}
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000

const METHOD_CAPABILITY: Readonly<Record<FrameBridgeMethod, FrameBridgeCapability>> = {
	getBrowserState: 'observe',
	clickElement: 'click',
	inputText: 'input',
	selectOption: 'select',
	scroll: 'scroll',
	scrollHorizontally: 'scrollHorizontally',
	cleanUpHighlights: 'cleanup',
}

function isMutatingMethod(method: FrameBridgeMethod): boolean {
	return method !== 'getBrowserState' && method !== 'cleanUpHighlights'
}

function hasUnknownOutcomeRisk(request: PendingRequest): boolean {
	return (
		request.phase === 'commit' || (request.phase === 'request' && isMutatingMethod(request.method))
	)
}

function requestAbortError(request: PendingRequest): FrameBridgeError {
	// A mutating request may execute synchronously after the host receives it,
	// before its `started` notification reaches this client. Once postMessage
	// succeeded, cancellation therefore cannot prove that no side effect ran.
	return (request.started || request.posted) && hasUnknownOutcomeRisk(request)
		? new FrameBridgeError(
				BridgeErrorCode.OUTCOME_UNKNOWN,
				`Iframe bridge ${request.method} was sent before abort; outcome is unknown.`
			)
		: new FrameBridgeError(BridgeErrorCode.ABORTED, 'Bridge request was aborted')
}

function randomId(prefix: string): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return `${prefix}-${crypto.randomUUID()}`
	}
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function asError(error: unknown, fallbackCode: BridgeErrorCodeValue): FrameBridgeError {
	if (error instanceof FrameBridgeError) return error
	return new FrameBridgeError(fallbackCode, error instanceof Error ? error.message : String(error))
}

function normalizeOrigin(origin: string): string | null {
	if (
		typeof origin !== 'string' ||
		!origin ||
		origin === '*' ||
		origin === 'null' ||
		origin.includes('*')
	) {
		return null
	}
	try {
		const url = new URL(origin)
		if (url.origin === 'null' || !/^https?:$/.test(url.protocol)) return null
		if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null
		return url.origin
	} catch {
		return null
	}
}

/** Normalize and validate exact origins. Wildcards and opaque origins are never accepted. */
export function normalizeAllowedChildOrigins(origins: readonly string[]): string[] {
	const normalized: string[] = []
	for (const origin of origins) {
		const value = normalizeOrigin(origin)
		if (!value) throw new TypeError(`Invalid exact child origin: ${origin}`)
		if (!normalized.includes(value)) normalized.push(value)
	}
	return normalized
}

/**
 * Resolve the origin of the URL currently assigned to an iframe. This does not
 * access the child DOM, and therefore works for cross-origin frames.
 */
export function getFrameSourceOrigin(
	iframe: HTMLIFrameElement,
	parentDocument?: Document
): string | null {
	const source = iframe.getAttribute('src') || iframe.src
	if (!source) return parentDocument?.location.origin ?? null
	try {
		const url = new URL(source, parentDocument?.baseURI ?? document.baseURI)
		return normalizeOrigin(url.origin)
	} catch {
		return null
	}
}

/**
 * Returns true only when the parent cannot synchronously inspect the child
 * document. Same-origin frames are not eligible for this cooperative bridge;
 * the regular PageController treats their child documents as opaque leaves and
 * does not read or operate their contents.
 */
export function isDirectCrossOriginFrame(
	iframe: HTMLIFrameElement,
	parentDocument?: Document
): boolean {
	const declaredOrigin = getFrameSourceOrigin(iframe, parentDocument)
	const parentOrigin = parentDocument?.location.origin
	if (declaredOrigin && parentOrigin && declaredOrigin !== parentOrigin) return true
	const source = iframe.getAttribute('src') || iframe.src
	if (source && !declaredOrigin) {
		try {
			const protocol = new URL(source, parentDocument?.baseURI ?? document.baseURI).protocol
			if (protocol !== 'about:') return true
		} catch {
			return true
		}
	}
	try {
		if (iframe.contentDocument) return false
		const childWindow = iframe.contentWindow
		if (!childWindow) return false
		// Reading location.href throws for a normal cross-origin WindowProxy.
		void childWindow.location.href
		return false
	} catch {
		return true
	}
}

/**
 * Parent-side RPC client. A client only handles one direct iframe and one
 * MessageChannel at a time; a navigation invalidates the channel and its
 * pending requests.
 */
export class FrameBridgeClient extends EventTarget {
	readonly iframe: HTMLIFrameElement
	readonly allowedChildOrigins: readonly string[]
	readonly handshakeTimeoutMs: number
	readonly requestTimeoutMs: number
	readonly onApprovalRequired: FrameBridgeApprovalHandler | undefined

	private readonly ownerWindow: Window
	private readonly pending = new Map<string, PendingRequest>()
	private port: MessagePort | null = null
	private portMessageHandler: ((event: MessageEvent) => void) | null = null
	private disposed = false
	private connecting: Promise<FrameBridgeConnection> | null = null
	private sessionId: string | null = null
	private frameInstanceId: string | null = null
	private targetOrigin: string | null = null
	private capabilities: FrameBridgeCapability[] = []
	private treeRevision = 0
	private established = false
	private handshakeResolve: ((connection: FrameBridgeConnection) => void) | null = null
	private handshakeReject: ((error: FrameBridgeError) => void) | null = null

	constructor(options: FrameBridgeClientOptions) {
		super()
		if (!options?.iframe) throw new TypeError('FrameBridgeClient requires an iframe')
		const origins = normalizeAllowedChildOrigins(options.allowedChildOrigins ?? [])
		if (origins.length === 0) {
			throw new TypeError('FrameBridgeClient requires at least one exact allowed child origin')
		}
		this.iframe = options.iframe
		this.allowedChildOrigins = origins
		this.handshakeTimeoutMs = Math.max(
			1,
			options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
		)
		this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
		this.ownerWindow = options.window ?? window
		this.onApprovalRequired = options.onApprovalRequired
	}

	get connected(): boolean {
		return this.established && this.port !== null && this.frameInstanceId !== null && !this.disposed
	}

	get frameInstance(): string | null {
		return this.frameInstanceId
	}

	get origin(): string | null {
		return this.targetOrigin
	}

	get supportedCapabilities(): readonly FrameBridgeCapability[] {
		return this.capabilities
	}

	get currentTreeRevision(): number {
		return this.treeRevision
	}

	/**
	 * Perform discover/available/connect handshake. Requests are sent to the
	 * iframe's declared source origin and only accepted from its WindowProxy.
	 */
	connect(
		sessionId = randomId('session'),
		context?: PageControllerCallContext
	): Promise<FrameBridgeConnection> {
		if (this.disposed) {
			return Promise.reject(
				new FrameBridgeError(BridgeErrorCode.DISPOSED, 'Bridge client is disposed')
			)
		}
		if (context?.signal?.aborted) {
			return Promise.reject(
				new FrameBridgeError(BridgeErrorCode.ABORTED, 'Bridge handshake was aborted')
			)
		}
		if (this.connected && this.sessionId === sessionId) {
			return Promise.resolve({
				frameInstanceId: this.frameInstanceId!,
				origin: this.targetOrigin!,
				capabilities: [...this.capabilities],
			})
		}
		if (this.connecting) return this.connecting

		const sourceOrigin = getFrameSourceOrigin(this.iframe, this.ownerWindow.document)
		if (!sourceOrigin || !this.allowedChildOrigins.includes(sourceOrigin)) {
			return Promise.reject(
				new FrameBridgeError(
					BridgeErrorCode.CAPABILITY_DENIED,
					`Iframe origin ${sourceOrigin ?? '<unknown>'} is not in allowedChildOrigins`
				)
			)
		}
		const targetWindow = this.iframe.contentWindow
		if (!targetWindow) {
			return Promise.reject(
				new FrameBridgeError(BridgeErrorCode.CONNECTION_CLOSED, 'Iframe has no contentWindow')
			)
		}

		this.closePort(
			new FrameBridgeError(BridgeErrorCode.CONNECTION_CLOSED, 'Bridge session replaced')
		)
		this.sessionId = sessionId
		this.targetOrigin = sourceOrigin
		this.frameInstanceId = null
		this.capabilities = []
		this.established = false

		this.connecting = new Promise<FrameBridgeConnection>((resolve, reject) => {
			let available: BridgeAvailableMessage | null = null
			let finished = false
			let removeHandshakeListener: (() => void) | null = null
			let removeAbortListener: (() => void) | null = null

			const finish = (error?: FrameBridgeError, connection?: FrameBridgeConnection) => {
				if (finished) return
				finished = true
				clearTimeout(timer)
				removeHandshakeListener?.()
				removeHandshakeListener = null
				removeAbortListener?.()
				removeAbortListener = null
				this.connecting = null
				this.handshakeResolve = null
				this.handshakeReject = null
				if (error) {
					this.closePort(error, false)
					this.established = false
					this.frameInstanceId = null
					this.capabilities = []
					this.treeRevision = 0
				}
				if (error) reject(error)
				else resolve(connection!)
			}
			this.handshakeResolve = (connection) => finish(undefined, connection)
			this.handshakeReject = (error) => finish(error)
			if (context?.signal) {
				const onAbort = () =>
					finish(new FrameBridgeError(BridgeErrorCode.ABORTED, 'Bridge handshake was aborted'))
				context.signal.addEventListener('abort', onAbort, { once: true })
				removeAbortListener = () => context.signal?.removeEventListener('abort', onAbort)
			}

			const onHandshake = (event: MessageEvent) => {
				if (event.source !== targetWindow || !this.allowedChildOrigins.includes(event.origin))
					return
				if (isBridgeAvailableMessage(event.data)) {
					if (event.data.sessionId !== sessionId) return
					if (available) return
					available = event.data
					this.targetOrigin = event.origin
					this.frameInstanceId = event.data.frameInstanceId
					this.capabilities = [...event.data.capabilities]
					try {
						const MessageChannelConstructor =
							(this.ownerWindow as Window & typeof globalThis).MessageChannel ??
							(typeof MessageChannel !== 'undefined' ? MessageChannel : undefined)
						if (!MessageChannelConstructor) {
							finish(
								new FrameBridgeError(
									BridgeErrorCode.CONNECTION_CLOSED,
									'MessageChannel is unavailable in this browser'
								)
							)
							return
						}
						const channel = new MessageChannelConstructor()
						this.attachPort(channel.port1)
						targetWindow.postMessage(
							{
								protocol: IFRAME_BRIDGE_PROTOCOL,
								version: BRIDGE_PROTOCOL_VERSION,
								type: 'connect',
								sessionId,
								frameInstanceId: event.data.frameInstanceId,
							},
							event.origin,
							[channel.port2]
						)
					} catch (error) {
						finish(asError(error, BridgeErrorCode.CONNECTION_CLOSED))
					}
					return
				}

				// `connected` is sent over the transferred MessageChannel port,
				// not through the window-level handshake channel.
			}

			this.ownerWindow.addEventListener('message', onHandshake)
			removeHandshakeListener = () => this.ownerWindow.removeEventListener('message', onHandshake)
			const timer = setTimeout(
				() =>
					finish(
						new FrameBridgeError(BridgeErrorCode.TIMEOUT, 'Iframe bridge handshake timed out')
					),
				this.handshakeTimeoutMs
			)
			try {
				const discover = {
					protocol: IFRAME_BRIDGE_PROTOCOL,
					version: BRIDGE_PROTOCOL_VERSION,
					type: 'discover' as const,
					sessionId,
				}
				// The src origin is checked above. Probing the other explicitly
				// allowed origins lets a child reconnect after it navigates to a
				// different allow-listed origin without ever using `*`.
				for (const origin of this.allowedChildOrigins) {
					targetWindow.postMessage(discover, origin)
				}
			} catch (error) {
				finish(asError(error, BridgeErrorCode.CONNECTION_CLOSED))
			}
		})

		return this.connecting
	}

	/** Invalidate the current frame instance after load/navigation/removal. */
	invalidate(reason = 'Iframe navigated') {
		if (this.disposed) return
		this.closePort(new FrameBridgeError(BridgeErrorCode.CONNECTION_CLOSED, reason))
		this.frameInstanceId = null
		this.capabilities = []
		this.treeRevision = 0
		this.established = false
		this.sessionId = null
		this.targetOrigin = null
		this.dispatchEvent(new CustomEvent('invalidate', { detail: { reason } }))
	}

	getBrowserState(context?: PageControllerCallContext): Promise<IndexedBrowserState> {
		return this.request('getBrowserState', undefined, context) as Promise<IndexedBrowserState>
	}

	updateTree(context?: PageControllerCallContext): Promise<string> {
		return this.getBrowserState(context).then((state) => state.content)
	}

	cleanUpHighlights(context?: PageControllerCallContext): Promise<void> {
		return this.request('cleanUpHighlights', undefined, context).then(() => undefined)
	}

	clickElement(index: number, context?: PageControllerCallContext): Promise<PageActionResult> {
		return this.runPreparedAction('clickElement', { index }, context)
	}

	inputText(
		index: number,
		text: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.runPreparedAction('inputText', { index, text }, context)
	}

	selectOption(
		index: number,
		optionText: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.runPreparedAction('selectOption', { index, optionText }, context)
	}

	scroll(options: ScrollOptions, context?: PageControllerCallContext): Promise<PageActionResult> {
		return this.runPreparedAction('scroll', options, context)
	}

	scrollHorizontally(
		options: HorizontalScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.runPreparedAction('scrollHorizontally', options, context)
	}

	async prepareAction(
		method: FrameBridgeActionMethod,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<FrameBridgePreparedAction> {
		const payloadHash = await hashFrameBridgePayload(payload)
		const summary = summarizeFrameBridgePayload(method, payload)
		const message = this.messageBase('prepare-action', method, {
			payloadHash,
			summary,
		})
		return this.postRequest(
			message,
			method,
			'prepare',
			context
		) as Promise<FrameBridgePreparedAction>
	}

	async commitPreparedAction(
		prepared: FrameBridgePreparedAction,
		payload: unknown,
		approved: boolean,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		if ((await hashFrameBridgePayload(payload)) !== prepared.payloadHash) {
			throw new FrameBridgeError(
				BridgeErrorCode.APPROVAL_DENIED,
				'Prepared iframe action payload changed.'
			)
		}
		const message = this.messageBase('commit-action', prepared.method, {
			preparedActionId: prepared.preparedActionId,
			approved,
			payload,
		})
		return this.postRequest(
			message,
			prepared.method,
			'commit',
			context
		) as Promise<PageActionResult>
	}

	private async runPreparedAction(
		method: FrameBridgeActionMethod,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		const prepared = await this.prepareAction(method, payload, context)
		if (prepared.decision === 'deny') {
			throw new FrameBridgeError(
				BridgeErrorCode.CAPABILITY_DENIED,
				prepared.reason ?? 'Iframe action denied by child policy.'
			)
		}
		let approved = false
		if (prepared.decision === 'approval_required') {
			if (!this.onApprovalRequired) {
				throw new FrameBridgeError(
					BridgeErrorCode.APPROVAL_REQUIRED,
					prepared.reason ?? 'Iframe action requires approval.'
				)
			}
			approved = await this.onApprovalRequired({
				method,
				summary: summarizeFrameBridgePayload(method, payload),
				target: prepared.target,
				reason: prepared.reason,
			})
			if (!approved)
				throw new FrameBridgeError(
					BridgeErrorCode.APPROVAL_DENIED,
					'Iframe action approval was denied.'
				)
		}
		return this.commitPreparedAction(prepared, payload, approved, context)
	}

	/** Execute JavaScript is intentionally not part of the bridge surface. */
	executeJavascript(): Promise<PageActionResult> {
		return Promise.reject(
			new FrameBridgeError(
				BridgeErrorCode.CAPABILITY_DENIED,
				'executeJavascript is only available on the local page controller'
			)
		)
	}

	private request(
		method: FrameBridgeMethod,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<unknown> {
		return this.postRequest(
			this.messageBase('request', method, { payload }),
			method,
			'request',
			context
		)
	}

	private messageBase(
		type: 'request' | 'prepare-action' | 'commit-action',
		method: FrameBridgeMethod,
		extra: Record<string, unknown>
	): Record<string, unknown> {
		return {
			protocol: IFRAME_BRIDGE_PROTOCOL,
			version: BRIDGE_PROTOCOL_VERSION,
			type,
			sessionId: this.sessionId,
			frameInstanceId: this.frameInstanceId,
			treeRevision: this.treeRevision,
			requestId: randomId('request'),
			method,
			...extra,
		}
	}

	private postRequest(
		message: Record<string, unknown>,
		method: FrameBridgeMethod,
		phase: PendingRequest['phase'],
		context?: PageControllerCallContext
	): Promise<unknown> {
		if (this.disposed) {
			return Promise.reject(
				new FrameBridgeError(BridgeErrorCode.DISPOSED, 'Bridge client is disposed')
			)
		}
		if (!this.established || !this.port || !this.frameInstanceId || !this.sessionId) {
			return Promise.reject(
				new FrameBridgeError(BridgeErrorCode.CONNECTION_CLOSED, 'Iframe bridge is not connected')
			)
		}
		if (context?.signal?.aborted) {
			return Promise.reject(
				new FrameBridgeError(BridgeErrorCode.ABORTED, 'Bridge request was aborted')
			)
		}
		const capability = METHOD_CAPABILITY[method]
		if (!this.capabilities.includes(capability)) {
			return Promise.reject(
				new FrameBridgeError(
					BridgeErrorCode.CAPABILITY_DENIED,
					`Iframe bridge does not allow ${capability}`
				)
			)
		}

		const requestId = message.requestId as string

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = this.pending.get(requestId)
				if (!pending) return
				this.pending.delete(requestId)
				pending.abortCleanup?.()
				try {
					this.port?.postMessage({
						protocol: IFRAME_BRIDGE_PROTOCOL,
						version: BRIDGE_PROTOCOL_VERSION,
						type: 'cancel',
						sessionId: this.sessionId,
						frameInstanceId: this.frameInstanceId,
						treeRevision: this.treeRevision,
						requestId,
						method: pending.method,
					})
				} catch {
					// The channel may already have been closed; the timeout is final.
				}
				const code =
					(pending.started || pending.posted) && hasUnknownOutcomeRisk(pending)
						? BridgeErrorCode.OUTCOME_UNKNOWN
						: BridgeErrorCode.TIMEOUT
				pending.reject(new FrameBridgeError(code, `Iframe bridge request timed out (${method})`))
			}, this.requestTimeoutMs)
			const pending: PendingRequest = {
				method,
				phase,
				resolve,
				reject,
				timer,
				started: false,
				posted: false,
			}
			if (context?.signal) {
				const onAbort = () => {
					const current = this.pending.get(requestId)
					if (!current) return
					this.pending.delete(requestId)
					clearTimeout(current.timer)
					current.abortCleanup?.()
					try {
						this.port?.postMessage({
							protocol: IFRAME_BRIDGE_PROTOCOL,
							version: BRIDGE_PROTOCOL_VERSION,
							type: 'cancel',
							sessionId: this.sessionId,
							frameInstanceId: this.frameInstanceId,
							treeRevision: this.treeRevision,
							requestId,
							method,
						})
					} catch {
						// The request is already rejected; a closed channel is expected.
					}
					current.reject(requestAbortError(current))
				}
				context.signal.addEventListener('abort', onAbort, { once: true })
				pending.abortCleanup = () => context.signal?.removeEventListener('abort', onAbort)
			}
			this.pending.set(requestId, pending)
			try {
				this.port?.postMessage(message)
				pending.posted = true
			} catch (error) {
				this.pending.delete(requestId)
				clearTimeout(timer)
				pending.abortCleanup?.()
				reject(asError(error, BridgeErrorCode.CONNECTION_CLOSED))
			}
		})
	}

	private attachPort(port: MessagePort) {
		this.closePort(
			new FrameBridgeError(BridgeErrorCode.CONNECTION_CLOSED, 'Bridge port replaced'),
			false
		)
		this.port = port
		this.portMessageHandler = (event) => this.onPortMessage(event)
		port.addEventListener('message', this.portMessageHandler)
		port.addEventListener('messageerror', this.onPortError)
		port.start?.()
	}

	private readonly onPortError = () => {
		this.closePort(
			new FrameBridgeError(BridgeErrorCode.CONNECTION_CLOSED, 'Bridge message port failed')
		)
	}

	private onPortMessage(event: MessageEvent) {
		if (!isBridgePortMessage(event.data)) return
		const message = event.data as BridgePortMessage
		if (message.sessionId !== this.sessionId || message.frameInstanceId !== this.frameInstanceId) {
			return
		}
		if (message.type === 'connected') {
			this.advanceTreeRevision(message.treeRevision)
			this.capabilities = [...message.capabilities]
			this.established = true
			if (
				this.handshakeResolve &&
				this.sessionId === message.sessionId &&
				this.frameInstanceId === message.frameInstanceId &&
				this.targetOrigin
			) {
				const resolve = this.handshakeResolve
				this.handshakeResolve = null
				resolve({
					frameInstanceId: message.frameInstanceId,
					origin: this.targetOrigin,
					capabilities: [...message.capabilities],
				})
			}
			return
		}
		if (message.type === 'pointer') {
			if (!this.established) return
			const pending = this.pending.get(message.requestId)
			if (
				!pending?.started ||
				(pending.method !== 'clickElement' && pending.method !== 'inputText')
			) {
				return
			}
			const detail: FrameBridgePointerDetail =
				message.action === 'move'
					? { action: 'move', x: message.x, y: message.y }
					: { action: 'click' }
			this.dispatchEvent(new CustomEvent<FrameBridgePointerDetail>('pointer', { detail }))
			return
		}
		if (message.type === 'started') {
			const pending = this.pending.get(message.requestId)
			if (pending && pending.method === message.method) pending.started = true
			return
		}
		if (!isBridgeResponseMessage(message)) return
		const pending = this.pending.get(message.requestId)
		if (!pending || pending.method !== message.method) return
		this.pending.delete(message.requestId)
		clearTimeout(pending.timer)
		pending.abortCleanup?.()
		this.advanceTreeRevision(message.treeRevision)
		if (message.ok) {
			pending.resolve(message.result)
		} else {
			pending.reject(new FrameBridgeError(message.error.code, message.error.message))
		}
	}

	private advanceTreeRevision(revision: number): void {
		if (Number.isSafeInteger(revision) && revision >= this.treeRevision) {
			this.treeRevision = revision
		}
	}

	private closePort(reason: FrameBridgeError, rejectHandshake = true) {
		if (rejectHandshake && this.handshakeReject) {
			const reject = this.handshakeReject
			this.handshakeReject = null
			reject(reason)
		}
		if (this.portMessageHandler && this.port) {
			this.port.removeEventListener('message', this.portMessageHandler)
			this.port.removeEventListener('messageerror', this.onPortError)
		}
		try {
			this.port?.close()
		} catch {
			// Closing an already closed MessagePort is harmless.
		}
		this.port = null
		this.portMessageHandler = null
		for (const [requestId, pending] of this.pending) {
			this.pending.delete(requestId)
			clearTimeout(pending.timer)
			pending.abortCleanup?.()
			const pendingError =
				(pending.started || pending.posted) && hasUnknownOutcomeRisk(pending)
					? new FrameBridgeError(
							BridgeErrorCode.OUTCOME_UNKNOWN,
							`Iframe bridge closed after ${pending.method} was sent; outcome is unknown.`
						)
					: reason
			pending.reject(pendingError)
		}
	}

	dispose() {
		if (this.disposed) return
		this.disposed = true
		this.established = false
		this.closePort(new FrameBridgeError(BridgeErrorCode.DISPOSED, 'Bridge client is disposed'))
		this.frameInstanceId = null
		this.sessionId = null
		this.targetOrigin = null
		this.capabilities = []
	}
}

export type { FrameBridgeCapability, FrameBridgeMethod }
