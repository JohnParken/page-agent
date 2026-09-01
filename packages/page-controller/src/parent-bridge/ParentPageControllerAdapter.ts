import {
	type ParentControllerActiveLeaseFailure,
	ParentControllerActiveLeaseMonitor,
} from './active-lease'
import { emitParentControllerLog, messageByteLength } from './logger'
import {
	isCapability,
	isParentControllerAcceptMessage,
	isParentControllerConnectMessage,
	isParentControllerDeactivateMessage,
	isParentControllerMessageSizeAllowed,
	isParentControllerOfferMessage,
	isParentControllerPayload,
	isParentControllerPortMessage,
	isParentControllerResult,
	PARENT_CONTROLLER_MAX_MESSAGE_BYTES,
	PARENT_CONTROLLER_MAX_REASON_LENGTH,
	PARENT_CONTROLLER_PROTOCOL,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	ParentControllerErrorCode,
	type ParentControllerMethod,
	type ParentControllerOfferMessage,
	type ParentControllerPortMessage,
} from './protocol'
import { normalizeParentControllerOrigin, secureParentControllerId } from './security'

import type {
	AuthorizedParent,
	AuthorizeOffer,
	OnApprovalRequired,
	ParentControllerAdapterOptions,
	ParentControllerAdapterWindow,
	ParentControllerApprovalRequest,
	ParentControllerConnection,
	ParentControllerMessagePort,
	ParentControllerOffer,
} from './types'
import type {
	HorizontalScrollOptions,
	IndexedBrowserState,
	IndexedPageControllerAdapter,
	PageActionResult,
	PageControllerCallContext,
	ScrollOptions,
} from '../PageController'

interface PendingRequest {
	readonly method: ParentControllerMethod
	readonly capability: ParentControllerCapability
	readonly resolve: (value: unknown) => void
	readonly reject: (reason?: unknown) => void
	readonly timer: ReturnType<typeof setTimeout>
	readonly abortController: AbortController
	readonly startedAt: number
	cleanup?: () => void
	started: boolean
	posted: boolean
}

function defaultWindow(): ParentControllerAdapterWindow {
	const value = (globalThis as typeof globalThis & { window?: ParentControllerAdapterWindow })
		.window
	if (!value?.parent) throw new Error('ParentPageControllerAdapter requires a browser window')
	return value
}

function asError(code: string, message: string): Error {
	const error = new Error(message)
	error.name = code === ParentControllerErrorCode.ABORTED ? 'AbortError' : code
	;(error as Error & { code?: string }).code = code
	return error
}

function normalizeTimeout(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback
	if (!Number.isFinite(value) || value <= 0)
		throw new TypeError(`${name} must be positive and finite`)
	return Math.max(1, Math.floor(value))
}

function isMutating(method: ParentControllerMethod): boolean {
	return (
		method === 'clickElement' ||
		method === 'inputText' ||
		method === 'selectOption' ||
		method === 'scroll' ||
		method === 'scrollHorizontally'
	)
}

function getErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== 'object' || !('code' in error)) return undefined
	const code = (error as { code?: unknown }).code
	return typeof code === 'string' && code.length > 0 ? code : undefined
}

function normalizedActionResult(value: unknown): PageActionResult {
	if (
		value &&
		typeof value === 'object' &&
		typeof (value as { success?: unknown }).success === 'boolean' &&
		typeof (value as { message?: unknown }).message === 'string'
	) {
		return value as PageActionResult
	}
	return { success: false, message: '❌ Parent controller returned an invalid action result.' }
}

/**
 * Child-side IndexedPageControllerAdapter. Only type imports from
 * PageController are used, so importing this module has no DOM side effects.
 */
export class ParentPageControllerAdapter<TAuthorizationContext = unknown>
	extends EventTarget
	implements IndexedPageControllerAdapter
{
	readonly requestedCapabilities: readonly ParentControllerCapability[]
	readonly handshakeTimeoutMs: number
	readonly requestTimeoutMs: number
	readonly authorizeOffer: AuthorizeOffer<TAuthorizationContext>
	readonly onApprovalRequired: OnApprovalRequired
	readonly autoReconnect: boolean

	private readonly bridgeWindow: ParentControllerAdapterWindow
	private readonly parentWindow: ParentControllerAdapterWindow['parent']
	private readonly logger: ParentControllerAdapterOptions<TAuthorizationContext>['logger']
	private readonly activeLeaseMonitor: ParentControllerActiveLeaseMonitor<TAuthorizationContext> | null
	private readonly pending = new Map<string, PendingRequest>()
	private readonly consumedApprovalIds = new Set<string>()
	private readonly approvalControllers = new Map<string, AbortController>()
	private readonly approvalRequestIds = new Map<string, string>()
	private disposed = false
	private connectedState = false
	private connectionState: ParentControllerConnection<TAuthorizationContext> | null = null
	private port: ParentControllerMessagePort | null = null
	private portMessageHandler: ((event: MessageEvent<unknown>) => void) | null = null
	private portMessageErrorHandler: ((event: MessageEvent<unknown>) => void) | null = null
	private offer: ParentControllerOfferMessage | null = null
	private offerWaiter: ((offer: ParentControllerOfferMessage) => void) | null = null
	private accepted: {
		offer: ParentControllerOfferMessage
		parentOrigin: string
		authorized: AuthorizedParent<TAuthorizationContext>
		capabilities: readonly ParentControllerCapability[]
	} | null = null
	private connecting: Promise<ParentControllerConnection<TAuthorizationContext>> | null = null
	private connectionResolve:
		| ((value: ParentControllerConnection<TAuthorizationContext>) => void)
		| null = null
	private connectionReject: ((reason?: unknown) => void) | null = null
	private connectionAbortCleanup: (() => void) | null = null
	private connectTimer: ReturnType<typeof setTimeout> | null = null
	private treeRevision = 0
	private currentParentOrigin: string | null = null
	private authorizationController: AbortController | null = null
	private authorizationGeneration = 0
	private authorizedParentState: AuthorizedParent<TAuthorizationContext> | null = null
	private activated = false
	private pendingHandshakeRequestId: string | null = null
	private readonly windowMessageListener = (event: MessageEvent<unknown>) =>
		this.handleWindowMessage(event)

	constructor(options: ParentControllerAdapterOptions<TAuthorizationContext>) {
		super()
		if (!options || typeof options !== 'object')
			throw new TypeError('ParentPageControllerAdapter requires options')
		if (typeof options.authorizeOffer !== 'function')
			throw new TypeError('ParentPageControllerAdapter requires authorizeOffer')
		if (typeof options.onApprovalRequired !== 'function')
			throw new TypeError('ParentPageControllerAdapter requires onApprovalRequired')
		if (
			!Array.isArray(options.requestedCapabilities) ||
			options.requestedCapabilities.length === 0
		) {
			throw new TypeError('requestedCapabilities must be a non-empty array')
		}
		const requested = [...options.requestedCapabilities]
		if (
			new Set(requested).size !== requested.length ||
			requested.some((item) => !isCapability(item))
		) {
			throw new TypeError('requestedCapabilities contains an unknown or duplicate capability')
		}
		this.requestedCapabilities = requested
		this.authorizeOffer = options.authorizeOffer
		this.onApprovalRequired = options.onApprovalRequired
		if (options.autoReconnect !== undefined && typeof options.autoReconnect !== 'boolean')
			throw new TypeError('autoReconnect must be a boolean')
		if (options.activeLease && typeof options.activeLease.getStatus !== 'function')
			throw new TypeError('activeLease.getStatus must be a function')
		if (options.activeLease && options.autoReconnect === true)
			throw new TypeError('autoReconnect must be false when ActiveLease monitoring is enabled')
		this.autoReconnect = options.autoReconnect ?? options.activeLease === undefined
		this.activeLeaseMonitor = options.activeLease
			? new ParentControllerActiveLeaseMonitor<TAuthorizationContext>({
					getStatus: options.activeLease.getStatus,
					onFailure: (failure) => this.failActiveLease(failure),
				})
			: null
		this.handshakeTimeoutMs = normalizeTimeout(
			options.handshakeTimeoutMs,
			5_000,
			'handshakeTimeoutMs'
		)
		this.requestTimeoutMs = normalizeTimeout(options.requestTimeoutMs, 30_000, 'requestTimeoutMs')
		this.bridgeWindow = options.window ?? defaultWindow()
		this.parentWindow = this.bridgeWindow.parent
		this.logger = options.logger
		this.bridgeWindow.addEventListener('message', this.windowMessageListener)
	}

	get connected(): boolean {
		return this.connectedState && this.port !== null && !this.disposed
	}

	get activationActive(): boolean {
		return this.activated && !this.disposed
	}

	get connection(): ParentControllerConnection<TAuthorizationContext> | null {
		return this.connectionState
	}

	get authorizedParent(): AuthorizedParent<TAuthorizationContext> | null {
		return this.authorizedParentState
	}

	get authorizationContext(): TAuthorizationContext | undefined {
		return this.authorizedParentState?.authorizationContext
	}

	get parentOrigin(): string | null {
		return this.currentParentOrigin
	}

	get currentTreeRevision(): number {
		return this.treeRevision
	}

	connect(
		context?: PageControllerCallContext
	): Promise<ParentControllerConnection<TAuthorizationContext>> {
		if (this.disposed)
			return Promise.reject(asError(ParentControllerErrorCode.DISPOSED, 'Adapter is disposed'))
		if (context?.signal?.aborted)
			return Promise.reject(asError(ParentControllerErrorCode.ABORTED, 'Connection was aborted'))
		if (this.connected && this.connectionState) return Promise.resolve(this.connectionState)
		if (this.connecting) return this.connecting

		const connecting = new Promise<ParentControllerConnection<TAuthorizationContext>>(
			(resolve, reject) => {
				this.connectionResolve = resolve
				this.connectionReject = reject
			}
		)
		// Publish the in-flight state before accepting an already buffered offer. The
		// authorizer may complete synchronously and acceptOffer intentionally rejects
		// work when no connection attempt is registered.
		this.connecting = connecting
		if (this.offer?.handshakeRequestId) {
			this.offer = null
			this.currentParentOrigin = null
		}
		const handshakeRequestId = secureParentControllerId('handshake')
		this.pendingHandshakeRequestId = handshakeRequestId
		this.connectTimer = setTimeout(
			() =>
				this.finishConnect(
					asError(ParentControllerErrorCode.TIMEOUT, 'Parent controller offer timed out')
				),
			this.handshakeTimeoutMs
		)
		if (context?.signal) {
			const onAbort = () =>
				this.finishConnect(
					asError(ParentControllerErrorCode.ABORTED, 'Parent controller connection was aborted')
				)
			context.signal.addEventListener('abort', onAbort, { once: true })
			this.connectionAbortCleanup = () => context.signal?.removeEventListener('abort', onAbort)
			if (context.signal.aborted) onAbort()
		}
		if (this.connecting !== connecting) return connecting
		if (this.offer) {
			void this.acceptOffer(this.offer, this.currentParentOrigin ?? undefined, context?.signal)
		} else {
			this.offerWaiter = (offer) =>
				void this.acceptOffer(offer, this.currentParentOrigin ?? undefined, context?.signal)
			try {
				this.postHandshakeRequest(handshakeRequestId, this.activated ? 'reconnect' : 'user')
			} catch (error) {
				this.finishConnect(error)
			}
		}
		return connecting
	}

	private postHandshakeRequest(
		requestId: string,
		reason: import('./protocol').ParentControllerHandshakeReason
	): void {
		const message = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'handshake-request' as const,
			requestId,
			reason,
		}
		if (!isParentControllerMessageSizeAllowed(message))
			throw asError(ParentControllerErrorCode.INVALID_MESSAGE, 'Handshake request is invalid')
		// The bootstrap request contains no policy, identity, or business data. A
		// cannot read a cross-origin parent origin before the first trusted message.
		this.parentWindow.postMessage(message, this.currentParentOrigin ?? '*')
	}

	/** A-side automatic reconnect after the first successful activation. */
	reconnect(
		context?: PageControllerCallContext
	): Promise<ParentControllerConnection<TAuthorizationContext>> {
		if (this.activeLeaseMonitor)
			return Promise.reject(
				asError(
					ParentControllerErrorCode.CONNECTION_CLOSED,
					'Automatic rebind is unavailable in ActiveLease mode; start a new user connection'
				)
			)
		if (!this.activated)
			return Promise.reject(
				asError(
					ParentControllerErrorCode.CONNECTION_CLOSED,
					'The parent bridge has not been activated by the user'
				)
			)
		if (this.connected) this.invalidate('Assistant requested a reconnect')
		return this.connect(context)
	}

	/** Clear the activation lease; a later connect() is a new explicit activation. */
	deactivate(reason = 'Assistant deactivated the parent bridge'): void {
		if (this.disposed) return
		const message = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'deactivate' as const,
			requestId: secureParentControllerId('deactivate'),
		}
		try {
			if (isParentControllerMessageSizeAllowed(message))
				this.parentWindow.postMessage(message, this.currentParentOrigin ?? '*')
		} catch {
			/* Local deactivation still succeeds if the parent is already gone. */
		}
		this.clearActivation(reason)
	}

	private clearActivation(reason: string): void {
		this.activated = false
		this.invalidate(reason)
		this.dispatchEvent(new CustomEvent('deactivated', { detail: { reason } }))
	}

	private failActiveLease(failure: ParentControllerActiveLeaseFailure): void {
		if (this.disposed) return
		this.dispatchEvent(new CustomEvent('activeleasefailure', { detail: failure }))
		this.deactivate(`ActiveLease ${failure.reason.toLowerCase()}`)
	}

	private getAssistantOrigin(): string | null {
		try {
			const origin = this.bridgeWindow.location?.origin
			if (!origin || origin === 'null') return null
			return normalizeParentControllerOrigin(origin)
		} catch {
			return null
		}
	}

	private handleWindowMessage(event: MessageEvent<unknown>): void {
		if (this.disposed || event.source !== this.parentWindow) return
		let actualParentOrigin: string
		try {
			actualParentOrigin = normalizeParentControllerOrigin(event.origin)
		} catch {
			return
		}
		if (!isParentControllerMessageSizeAllowed(event.data)) return
		if (isParentControllerDeactivateMessage(event.data)) {
			if (this.currentParentOrigin !== null && actualParentOrigin !== this.currentParentOrigin)
				return
			// P-originated deactivation is already addressed to A. Clear local
			// state without replying and requiring a second handshake message.
			this.clearActivation('Parent controller deactivated the bridge')
			return
		}
		if (isParentControllerOfferMessage(event.data)) {
			const assistantOrigin = this.getAssistantOrigin()
			if (!assistantOrigin || event.data.assistantOrigin !== assistantOrigin) return
			if (event.data.frameContext.assistantOrigin !== assistantOrigin) return
			if (event.data.frameContext.parentOrigin !== actualParentOrigin) return
			if (
				event.data.handshakeRequestId !== undefined &&
				event.data.handshakeRequestId !== this.pendingHandshakeRequestId
			)
				return
			if (event.data.automaticReconnect === true && !this.activated && !this.connecting) return
			const sameOffer =
				!!this.offer &&
				this.offer.handshakeRequestId === event.data.handshakeRequestId &&
				this.offer.policyId === event.data.policyId &&
				this.offer.challenge === event.data.challenge &&
				this.offer.sessionId === event.data.sessionId &&
				this.offer.hostInstanceId === event.data.hostInstanceId &&
				this.offer.frameInstanceId === event.data.frameInstanceId
			const replacingOffer = !!this.offer && !sameOffer
			const wasConnecting = replacingOffer && this.connecting !== null
			const shouldReconnect =
				replacingOffer && this.connected && this.activated && this.autoReconnect
			const shouldAutoConnect =
				!this.connecting &&
				event.data.automaticReconnect === true &&
				this.activated &&
				this.autoReconnect
			if (replacingOffer) {
				if (wasConnecting) this.invalidateForOfferReplacement('Parent offer replaced')
				else this.invalidate('Parent offer replaced')
			}
			if (!sameOffer) this.offer = event.data
			this.currentParentOrigin = actualParentOrigin
			if (
				this.accepted &&
				this.accepted.offer.policyId === event.data.policyId &&
				this.accepted.offer.challenge === event.data.challenge &&
				this.accepted.offer.sessionId === event.data.sessionId &&
				this.accepted.offer.hostInstanceId === event.data.hostInstanceId &&
				this.accepted.offer.frameInstanceId === event.data.frameInstanceId
			)
				this.sendAccept(this.accepted)
			this.dispatchEvent(new CustomEvent<ParentControllerOffer>('offer', { detail: event.data }))
			if (wasConnecting)
				void this.acceptOffer(event.data, actualParentOrigin).catch(() => undefined)
			else if (shouldReconnect || shouldAutoConnect) this.reconnectAfterOffer()
			else {
				this.offerWaiter?.(event.data)
				this.offerWaiter = null
			}
			return
		}
		if (isParentControllerConnectMessage(event.data)) {
			if (!event.ports || event.ports.length !== 1) return
			const transferred = event.ports[0] as unknown as ParentControllerMessagePort
			this.handleConnect(event.data, actualParentOrigin, transferred)
		}
	}

	private async acceptOffer(
		offer: ParentControllerOfferMessage,
		parentOrigin: string | undefined,
		signal?: AbortSignal
	): Promise<void> {
		if (this.disposed || this.connected || !this.connecting || this.accepted) return
		if (!parentOrigin) {
			this.finishConnect(
				asError(ParentControllerErrorCode.HOST_MISMATCH, 'Parent origin is unavailable')
			)
			return
		}
		if (signal?.aborted) {
			this.finishConnect(asError(ParentControllerErrorCode.ABORTED, 'Connection was aborted'))
			return
		}
		const authorizationGeneration = ++this.authorizationGeneration
		let authorized: AuthorizedParent<TAuthorizationContext> | false | null | undefined
		const authorizationController = new AbortController()
		this.authorizationController = authorizationController
		const relayAbort = () => authorizationController.abort()
		signal?.addEventListener('abort', relayAbort, { once: true })
		try {
			authorized = await this.authorizeOffer(offer, parentOrigin, authorizationController.signal)
		} catch (error) {
			if (authorizationGeneration !== this.authorizationGeneration) return
			signal?.removeEventListener('abort', relayAbort)
			if (this.authorizationController === authorizationController)
				this.authorizationController = null
			this.finishConnect(error)
			return
		}
		signal?.removeEventListener('abort', relayAbort)
		if (this.authorizationController === authorizationController)
			this.authorizationController = null
		if (
			authorizationGeneration !== this.authorizationGeneration ||
			authorizationController.signal.aborted ||
			this.disposed ||
			!this.connecting ||
			this.offer !== offer ||
			this.currentParentOrigin !== parentOrigin
		) {
			this.finishConnect(
				asError(
					ParentControllerErrorCode.CONNECTION_CLOSED,
					'Parent offer changed during authorization'
				)
			)
			return
		}
		if (!authorized) {
			this.finishConnect(
				asError(
					ParentControllerErrorCode.EMBED_POLICY_DENIED,
					'Parent embed policy was not authorized'
				)
			)
			return
		}
		if (authorized.parentOrigin !== parentOrigin || authorized.policyId !== offer.policyId) {
			this.finishConnect(
				asError(
					ParentControllerErrorCode.EMBED_POLICY_DENIED,
					'Authorized parent does not match offer'
				)
			)
			return
		}
		const authorizedCapabilities = [...authorized.capabilities]
		if (
			new Set(authorizedCapabilities).size !== authorizedCapabilities.length ||
			authorizedCapabilities.some((item) => !isCapability(item))
		) {
			this.finishConnect(
				asError(ParentControllerErrorCode.CAPABILITY_DENIED, 'Authorized capabilities are invalid')
			)
			return
		}
		const capabilities = this.requestedCapabilities.filter(
			(capability) =>
				offer.capabilities.includes(capability) && authorizedCapabilities.includes(capability)
		)
		if (capabilities.length === 0) {
			this.finishConnect(
				asError(ParentControllerErrorCode.CAPABILITY_DENIED, 'No authorized parent capabilities')
			)
			return
		}
		this.accepted = { offer, parentOrigin, authorized, capabilities }
		this.authorizedParentState = authorized
		this.consumedApprovalIds.clear()
		try {
			this.sendAccept(this.accepted)
		} catch (error) {
			this.finishConnect(error)
		}
	}

	private sendAccept(
		accepted: NonNullable<ParentPageControllerAdapter<TAuthorizationContext>['accepted']>
	): void {
		const offer = accepted.offer
		const message = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'accept' as const,
			policyId: offer.policyId,
			challenge: offer.challenge,
			sessionId: offer.sessionId,
			hostInstanceId: offer.hostInstanceId,
			frameInstanceId: offer.frameInstanceId,
			capabilities: [...accepted.capabilities],
		}
		if (!isParentControllerAcceptMessage(message))
			throw asError(ParentControllerErrorCode.INVALID_MESSAGE, 'Invalid accept message')
		this.parentWindow.postMessage(message, accepted.parentOrigin)
	}

	private handleConnect(
		message: Extract<import('./protocol').ParentControllerConnectMessage, { type: 'connect' }>,
		actualParentOrigin: string,
		port: ParentControllerMessagePort
	): void {
		const accepted = this.accepted
		if (
			!accepted ||
			this.connected ||
			this.connectionState !== null ||
			actualParentOrigin !== accepted.parentOrigin
		) {
			try {
				port.close?.()
			} catch {
				/* invalid transferred port */
			}
			return
		}
		if (
			message.policyId !== accepted.offer.policyId ||
			message.challenge !== accepted.offer.challenge ||
			message.sessionId !== accepted.offer.sessionId ||
			message.hostInstanceId !== accepted.offer.hostInstanceId ||
			message.frameInstanceId !== accepted.offer.frameInstanceId
		) {
			try {
				port.close?.()
			} catch {
				/* invalid transferred port */
			}
			return
		}
		if (message.capabilities.some((capability) => !accepted.capabilities.includes(capability))) {
			try {
				port.close?.()
			} catch {
				/* invalid transferred port */
			}
			return
		}
		this.attachPort(port)
	}

	private attachPort(port: ParentControllerMessagePort): void {
		this.closePort(asError(ParentControllerErrorCode.CONNECTION_CLOSED, 'Port replaced'), false)
		this.port = port
		this.portMessageHandler = (event) => this.handlePortMessage(event)
		this.portMessageErrorHandler = () => {
			if (this.disposed || this.port !== port) return
			emitParentControllerLog(this.logger, {
				event: 'error',
				code: ParentControllerErrorCode.INVALID_MESSAGE,
				sessionId: this.connectionState?.sessionId,
			})
			this.dispatchEvent(new Event('messageerror'))
			if (this.activeLeaseMonitor && this.activated)
				this.deactivate('Parent controller port failed during ActiveLease')
			else this.invalidate('Parent controller port failed')
			if (this.activated && this.autoReconnect) {
				void this.connect().catch((error: unknown) => {
					this.dispatchEvent(new CustomEvent('connectionerror', { detail: { error } }))
				})
			}
		}
		if (port.addEventListener) {
			port.addEventListener('message', this.portMessageHandler)
			port.addEventListener('messageerror', this.portMessageErrorHandler)
		} else {
			port.onmessage = this.portMessageHandler
			port.onmessageerror = this.portMessageErrorHandler
		}
		port.start?.()
	}

	private handlePortMessage(event: MessageEvent<unknown>): void {
		if (
			this.disposed ||
			!this.port ||
			!isParentControllerMessageSizeAllowed(event.data) ||
			!isParentControllerPortMessage(event.data)
		)
			return
		const message = event.data
		const state = this.connectionState
		if (!state) {
			if (message.type === 'connected') this.handleConnected(message)
			return
		}
		if (
			message.policyId !== state.policyId ||
			message.sessionId !== state.sessionId ||
			message.hostInstanceId !== state.hostInstanceId ||
			message.frameInstanceId !== state.frameInstanceId
		)
			return
		this.treeRevision = Math.max(this.treeRevision, message.treeRevision)
		if (message.type === 'connected') {
			this.handleConnected(message)
		} else if (message.type === 'started') {
			const pending = this.pending.get(message.requestId)
			if (pending?.method === message.method && pending.capability === message.capability)
				pending.started = true
		} else if (message.type === 'approval-required') {
			void this.handleApprovalRequired(message)
		} else if (message.type === 'response') {
			const pending = this.pending.get(message.requestId)
			if (!pending || pending.method !== message.method) return
			this.pending.delete(message.requestId)
			clearTimeout(pending.timer)
			pending.cleanup?.()
			pending.abortController.abort()
			this.abortApprovalForRequest(message.requestId)
			if (message.ok) {
				if (!isParentControllerResult(message.method, message.result))
					pending.reject(
						asError(ParentControllerErrorCode.INVALID_MESSAGE, 'Invalid parent controller result')
					)
				else pending.resolve(message.result)
			} else pending.reject(asError(message.error.code, message.error.message))
			emitParentControllerLog(this.logger, {
				event: message.ok ? 'response' : 'error',
				code: message.ok ? undefined : message.error.code,
				sessionId: state.sessionId,
				requestId: message.requestId,
				method: message.method,
				durationMs: Math.max(0, Date.now() - pending.startedAt),
			})
		}
	}

	private handleConnected(
		message: Extract<ParentControllerPortMessage, { type: 'connected' }>
	): void {
		const accepted = this.accepted
		if (!this.connecting || this.disposed || !accepted) return
		if (
			message.policyId !== accepted.offer.policyId ||
			message.sessionId !== accepted.offer.sessionId ||
			message.hostInstanceId !== accepted.offer.hostInstanceId ||
			message.frameInstanceId !== accepted.offer.frameInstanceId ||
			message.frameContext.parentOrigin !== accepted.offer.frameContext.parentOrigin ||
			message.frameContext.assistantOrigin !== accepted.offer.frameContext.assistantOrigin ||
			message.frameContext.directChild !== accepted.offer.frameContext.directChild ||
			message.frameContext.allowScripts !== accepted.offer.frameContext.allowScripts ||
			message.frameContext.allowSameOrigin !== accepted.offer.frameContext.allowSameOrigin ||
			message.frameContext.sandbox.length !== accepted.offer.frameContext.sandbox.length ||
			message.frameContext.sandbox.some(
				(token, index) => token !== accepted.offer.frameContext.sandbox[index]
			) ||
			message.capabilities.some((capability) => !accepted.capabilities.includes(capability))
		)
			return
		this.treeRevision = message.treeRevision
		this.connectedState = true
		this.activated = true
		this.connectionState = {
			policyId: accepted.offer.policyId,
			sessionId: accepted.offer.sessionId,
			hostInstanceId: accepted.offer.hostInstanceId,
			frameInstanceId: accepted.offer.frameInstanceId,
			parentOrigin: accepted.parentOrigin,
			capabilities: [...message.capabilities],
			frameContext: message.frameContext,
			authorizedParent: accepted.authorized,
		}
		this.activeLeaseMonitor?.start({
			role: 'assistant',
			policyId: accepted.offer.policyId,
			sessionId: accepted.offer.sessionId,
			challenge: accepted.offer.challenge,
			hostInstanceId: accepted.offer.hostInstanceId,
			frameInstanceId: accepted.offer.frameInstanceId,
			parentOrigin: accepted.parentOrigin,
			assistantOrigin: accepted.offer.frameContext.assistantOrigin,
			authorizationContext: accepted.authorized.authorizationContext,
		})
		emitParentControllerLog(this.logger, {
			event: 'connected',
			sessionId: accepted.offer.sessionId,
		})
		this.dispatchEvent(new CustomEvent('connected', { detail: this.connectionState }))
		this.finishConnect(undefined, this.connectionState)
	}

	private async handleApprovalRequired(
		message: Extract<ParentControllerPortMessage, { type: 'approval-required' }>
	): Promise<void> {
		if (this.consumedApprovalIds.has(message.approvalId)) return
		const pending = this.pending.get(message.requestId)
		if (!pending || pending.method !== message.method || pending.capability !== message.capability)
			return
		this.consumedApprovalIds.add(message.approvalId)
		const approvalController = new AbortController()
		this.approvalControllers.set(message.approvalId, approvalController)
		this.approvalRequestIds.set(message.approvalId, message.requestId)
		const request: ParentControllerApprovalRequest = {
			approvalId: message.approvalId,
			requestId: message.requestId,
			method: message.method,
			capability: message.capability,
			payload: message.payload,
			reason: message.reason?.slice(0, PARENT_CONTROLLER_MAX_REASON_LENGTH),
			signal: approvalController.signal,
		}
		emitParentControllerLog(this.logger, {
			event: 'approval_required',
			sessionId: this.connectionState?.sessionId,
			requestId: message.requestId,
			method: message.method,
			capability: message.capability,
		})
		this.dispatchEvent(new CustomEvent('approvalrequired', { detail: request }))
		let decision: { approved: boolean; reason?: string } = { approved: false }
		const acceptedConnection = this.connectionState
		try {
			const result = await this.onApprovalRequired(request)
			decision =
				typeof result === 'boolean'
					? { approved: result }
					: { approved: result.approved, reason: result.reason }
		} catch (error) {
			decision = {
				approved: false,
				reason: error instanceof Error ? error.message : 'Approval callback failed',
			}
		}
		const connection = this.connectionState
		try {
			if (
				connection &&
				connection === acceptedConnection &&
				this.approvalControllers.get(message.approvalId) === approvalController
			) {
				const response = {
					protocol: PARENT_CONTROLLER_PROTOCOL,
					version: PARENT_CONTROLLER_PROTOCOL_VERSION,
					type: 'approval-response' as const,
					policyId: connection.policyId,
					sessionId: connection.sessionId,
					hostInstanceId: connection.hostInstanceId,
					frameInstanceId: connection.frameInstanceId,
					treeRevision: this.treeRevision,
					requestId: message.requestId,
					approvalId: message.approvalId,
					approved: decision.approved,
					reason: decision.reason?.slice(0, PARENT_CONTROLLER_MAX_REASON_LENGTH),
				}
				if (isParentControllerMessageSizeAllowed(response)) this.port?.postMessage(response)
			}
		} catch {
			// Host-side timeout/connection closure resolves the request.
		}
		approvalController.abort()
		this.approvalControllers.delete(message.approvalId)
		this.approvalRequestIds.delete(message.approvalId)
		emitParentControllerLog(this.logger, {
			event: 'approval_result',
			sessionId: connection?.sessionId,
			requestId: message.requestId,
			method: message.method,
			capability: message.capability,
			code: decision.approved ? 'approved' : 'denied',
		})
	}

	private finishConnect(
		error?: unknown,
		connection?: ParentControllerConnection<TAuthorizationContext>
	): void {
		this.authorizationController?.abort()
		this.authorizationController = null
		if (this.connectTimer) clearTimeout(this.connectTimer)
		this.connectTimer = null
		this.connectionAbortCleanup?.()
		this.connectionAbortCleanup = null
		const resolve = this.connectionResolve
		const reject = this.connectionReject
		this.connectionResolve = null
		this.connectionReject = null
		this.connecting = null
		this.pendingHandshakeRequestId = null
		if (error) {
			this.closePort(asError(ParentControllerErrorCode.CONNECTION_CLOSED, 'Connection failed'))
			this.accepted = null
			this.authorizedParentState = null
			this.connectionState = null
			reject?.(error)
		} else if (connection) resolve?.(connection)
		else reject?.(asError(ParentControllerErrorCode.CONNECTION_CLOSED, 'Connection ended'))
	}

	private request(
		method: ParentControllerMethod,
		capability: ParentControllerCapability,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<unknown> {
		if (this.disposed)
			return Promise.reject(asError(ParentControllerErrorCode.DISPOSED, 'Adapter is disposed'))
		if (context?.signal?.aborted)
			return Promise.reject(
				asError(ParentControllerErrorCode.ABORTED, 'Parent controller request was aborted')
			)
		if (!this.connected || !this.port || !this.connectionState)
			return Promise.reject(
				asError(ParentControllerErrorCode.CONNECTION_CLOSED, 'Parent controller is not connected')
			)
		if (!this.connectionState.capabilities.includes(capability))
			return Promise.reject(
				asError(
					ParentControllerErrorCode.CAPABILITY_DENIED,
					`Capability ${capability} is not authorized`
				)
			)
		if (!isParentControllerPayload(method, payload))
			return Promise.reject(
				asError(ParentControllerErrorCode.INVALID_PAYLOAD, 'Invalid controller payload')
			)
		const requestId = secureParentControllerId('request')
		const message = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			policyId: this.connectionState.policyId,
			sessionId: this.connectionState.sessionId,
			hostInstanceId: this.connectionState.hostInstanceId,
			frameInstanceId: this.connectionState.frameInstanceId,
			treeRevision: this.treeRevision,
			type: 'request' as const,
			requestId,
			method,
			capability,
			payload,
		}
		if (
			!isParentControllerMessageSizeAllowed(message) ||
			messageByteLength(message) > PARENT_CONTROLLER_MAX_MESSAGE_BYTES
		)
			return Promise.reject(
				asError(ParentControllerErrorCode.INVALID_PAYLOAD, 'Parent request exceeds size limit')
			)
		return new Promise((resolve, reject) => {
			const abortController = new AbortController()
			const pending: PendingRequest = {
				method,
				capability,
				resolve,
				reject,
				timer: setTimeout(() => {
					const current = this.pending.get(requestId)
					if (!current) return
					this.pending.delete(requestId)
					current.cleanup?.()
					this.abortApprovalForRequest(requestId)
					this.sendCancel(requestId, method, capability)
					const code =
						(current.started || current.posted) && isMutating(method)
							? ParentControllerErrorCode.OUTCOME_UNKNOWN
							: ParentControllerErrorCode.TIMEOUT
					current.reject(
						asError(
							code,
							code === ParentControllerErrorCode.OUTCOME_UNKNOWN
								? 'Outcome is unknown; re-observe state before retrying.'
								: `Parent controller request timed out (${method})`
						)
					)
				}, this.requestTimeoutMs),
				abortController,
				startedAt: Date.now(),
				started: false,
				posted: false,
			}
			if (context?.signal) {
				const onAbort = () => {
					const current = this.pending.get(requestId)
					if (!current) return
					this.pending.delete(requestId)
					clearTimeout(current.timer)
					current.cleanup?.()
					this.abortApprovalForRequest(requestId)
					this.sendCancel(requestId, method, capability)
					const code =
						(current.started || current.posted) && isMutating(method)
							? ParentControllerErrorCode.OUTCOME_UNKNOWN
							: ParentControllerErrorCode.ABORTED
					current.reject(
						asError(
							code,
							code === ParentControllerErrorCode.OUTCOME_UNKNOWN
								? 'Outcome is unknown; re-observe state before retrying.'
								: 'Parent controller request was aborted'
						)
					)
				}
				context.signal.addEventListener('abort', onAbort, { once: true })
				pending.cleanup = () => context.signal?.removeEventListener('abort', onAbort)
			}
			this.pending.set(requestId, pending)
			try {
				this.port?.postMessage(message)
				pending.posted = true
				emitParentControllerLog(this.logger, {
					event: 'request',
					sessionId: message.sessionId,
					requestId,
					method,
					capability,
					messageBytes: messageByteLength(message),
				})
			} catch (error) {
				this.pending.delete(requestId)
				clearTimeout(pending.timer)
				pending.cleanup?.()
				reject(
					error instanceof Error
						? error
						: asError(ParentControllerErrorCode.CONNECTION_CLOSED, 'Failed to post request')
				)
			}
		})
	}

	private sendCancel(
		requestId: string,
		method: ParentControllerMethod,
		capability: ParentControllerCapability
	): void {
		const state = this.connectionState
		if (!state) return
		const message = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			policyId: state.policyId,
			sessionId: state.sessionId,
			hostInstanceId: state.hostInstanceId,
			frameInstanceId: state.frameInstanceId,
			treeRevision: this.treeRevision,
			type: 'cancel' as const,
			requestId,
			method,
			capability,
		}
		try {
			if (isParentControllerMessageSizeAllowed(message)) this.port?.postMessage(message)
		} catch {
			// A closed port is already reflected in the local rejection.
		}
	}

	private abortApprovalForRequest(requestId: string): void {
		for (const [approvalId, mappedRequestId] of this.approvalRequestIds) {
			if (mappedRequestId !== requestId) continue
			this.approvalControllers.get(approvalId)?.abort()
			this.approvalControllers.delete(approvalId)
			this.approvalRequestIds.delete(approvalId)
		}
	}

	private action(
		method: ParentControllerMethod,
		capability: ParentControllerCapability,
		payload: unknown,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.request(method, capability, payload, context)
			.then(normalizedActionResult)
			.catch((error) => {
				const code = getErrorCode(error)
				if (code === ParentControllerErrorCode.ABORTED && (error as Error).name === 'AbortError')
					throw error
				const message = error instanceof Error ? error.message : 'Parent controller action failed.'
				return {
					success: false,
					message: `❌ [${code ?? ParentControllerErrorCode.INTERNAL_ERROR}] ${message}`,
				}
			})
	}

	getCurrentUrl(context?: PageControllerCallContext): Promise<string> {
		return this.request('getCurrentUrl', 'observe', undefined, context) as Promise<string>
	}
	getLastUpdateTime(context?: PageControllerCallContext): Promise<number> {
		return this.request('getLastUpdateTime', 'observe', undefined, context) as Promise<number>
	}
	getBrowserState(context?: PageControllerCallContext): Promise<IndexedBrowserState> {
		return this.request(
			'getBrowserState',
			'observe',
			undefined,
			context
		) as Promise<IndexedBrowserState>
	}
	updateTree(context?: PageControllerCallContext): Promise<string> {
		return this.request('updateTree', 'observe', undefined, context) as Promise<string>
	}
	cleanUpHighlights(): Promise<void> {
		return this.request('cleanUpHighlights', 'cleanup', undefined).then(() => undefined)
	}
	clickElement(index: number, context?: PageControllerCallContext): Promise<PageActionResult> {
		return this.action('clickElement', 'click', { index }, context)
	}
	inputText(
		index: number,
		text: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.action('inputText', 'input', { index, text }, context)
	}
	selectOption(
		index: number,
		optionText: string,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.action('selectOption', 'select', { index, optionText }, context)
	}
	scroll(options: ScrollOptions, context?: PageControllerCallContext): Promise<PageActionResult> {
		return this.action('scroll', 'scroll', options, context)
	}
	scrollHorizontally(
		options: HorizontalScrollOptions,
		context?: PageControllerCallContext
	): Promise<PageActionResult> {
		return this.action('scrollHorizontally', 'scrollHorizontally', options, context)
	}

	executeJavascript(_script: string, _signal?: AbortSignal): Promise<PageActionResult> {
		return Promise.resolve({
			success: false,
			message:
				'❌ [CAPABILITY_DENIED] executeJavascript is unavailable through the parent controller bridge.',
		})
	}
	showMask(): Promise<void> {
		return this.request('showMask', 'visual', undefined).then(() => undefined)
	}
	hideMask(): Promise<void> {
		return this.request('hideMask', 'visual', undefined).then(() => undefined)
	}

	private closePort(reason: Error, rejectPending = true): void {
		this.activeLeaseMonitor?.stop()
		for (const controller of this.approvalControllers.values()) controller.abort()
		this.approvalControllers.clear()
		this.approvalRequestIds.clear()
		if (this.portMessageHandler && this.port?.removeEventListener)
			this.port.removeEventListener('message', this.portMessageHandler)
		if (this.portMessageErrorHandler && this.port?.removeEventListener)
			this.port.removeEventListener('messageerror', this.portMessageErrorHandler)
		if (this.port && !this.port.removeEventListener) {
			this.port.onmessage = null
			this.port.onmessageerror = null
		}
		try {
			this.port?.close?.()
		} catch {
			/* already closed */
		}
		this.port = null
		this.portMessageHandler = null
		this.portMessageErrorHandler = null
		this.connectedState = false
		if (rejectPending) {
			for (const [requestId, pending] of this.pending) {
				this.pending.delete(requestId)
				clearTimeout(pending.timer)
				pending.cleanup?.()
				const code =
					(pending.started || pending.posted) && isMutating(pending.method)
						? ParentControllerErrorCode.OUTCOME_UNKNOWN
						: getErrorCode(reason) ?? ParentControllerErrorCode.CONNECTION_CLOSED
				pending.reject(
					asError(
						code,
						code === ParentControllerErrorCode.OUTCOME_UNKNOWN
							? 'Outcome is unknown; re-observe state before retrying.'
							: reason.message
					)
				)
			}
		}
	}

	private invalidateForOfferReplacement(reason: string): void {
		const deactivated = this.activeLeaseMonitor !== null && this.activated
		if (deactivated) this.activated = false
		this.activeLeaseMonitor?.stop()
		this.authorizationGeneration += 1
		this.authorizationController?.abort()
		this.authorizationController = null
		this.closePort(asError(ParentControllerErrorCode.CONNECTION_CLOSED, reason))
		this.connectionState = null
		this.accepted = null
		this.authorizedParentState = null
		this.consumedApprovalIds.clear()
		this.offer = null
		this.offerWaiter = null
		this.currentParentOrigin = null
		this.dispatchEvent(new CustomEvent('invalidate', { detail: { reason } }))
		if (deactivated) this.dispatchEvent(new CustomEvent('deactivated', { detail: { reason } }))
	}

	private reconnectAfterOffer(): void {
		void this.connect().catch((error: unknown) => {
			this.dispatchEvent(new CustomEvent('connectionerror', { detail: { error } }))
		})
	}

	invalidate(reason = 'Parent controller bridge invalidated'): void {
		if (this.disposed) return
		const deactivated = this.activeLeaseMonitor !== null && this.activated
		if (deactivated) this.activated = false
		this.activeLeaseMonitor?.stop()
		const error = asError(ParentControllerErrorCode.CONNECTION_CLOSED, reason)
		this.authorizationGeneration += 1
		this.authorizationController?.abort()
		this.authorizationController = null
		if (this.connecting) this.finishConnect(error)
		else this.closePort(error)
		this.connectionState = null
		this.accepted = null
		this.authorizedParentState = null
		this.consumedApprovalIds.clear()
		this.offer = null
		this.currentParentOrigin = null
		this.dispatchEvent(new CustomEvent('invalidate', { detail: { reason } }))
		if (deactivated) this.dispatchEvent(new CustomEvent('deactivated', { detail: { reason } }))
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.activeLeaseMonitor?.stop()
		this.authorizationGeneration += 1
		this.bridgeWindow.removeEventListener('message', this.windowMessageListener)
		if (this.connectTimer) clearTimeout(this.connectTimer)
		this.connectTimer = null
		this.connectionAbortCleanup?.()
		this.connectionAbortCleanup = null
		if (this.connecting)
			this.finishConnect(asError(ParentControllerErrorCode.DISPOSED, 'Adapter is disposed'))
		else this.closePort(asError(ParentControllerErrorCode.DISPOSED, 'Adapter is disposed'))
		this.connectionState = null
		this.accepted = null
		this.authorizedParentState = null
		this.activated = false
		this.pendingHandshakeRequestId = null
		this.offer = null
		this.offerWaiter = null
		emitParentControllerLog(this.logger, { event: 'disposed' })
		this.dispatchEvent(new Event('dispose'))
	}
}
