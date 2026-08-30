import { FRAME_BRIDGE_CAPABILITIES, type FrameBridgeCapability } from '../iframe-bridge/protocol'
import {
	type IndexedBrowserState,
	type IndexedPageControllerAdapter,
	type PageActionResult,
	PageController,
	type PageControllerCallContext,
} from '../PageController'

import { emitParentControllerLog, messageByteLength } from './logger'
import {
	ParentFrameProxyController,
	type ParentFrameProxyGrant,
	type ParentFrameProxyPreparedAction,
} from './ParentFrameProxyController'
import { ParentVisualCursor } from './ParentVisualCursor'
import {
	isCapability,
	isKnownMethod,
	isParentControllerAcceptMessage,
	isParentControllerDeactivateMessage,
	isParentControllerHandshakeRequestMessage,
	isParentControllerMessageSizeAllowed,
	isParentControllerPayload,
	isParentControllerPortMessage,
	isParentControllerRequestMessage,
	isParentControllerResult,
	PARENT_CONTROLLER_CAPABILITIES,
	PARENT_CONTROLLER_MAX_MESSAGE_BYTES,
	PARENT_CONTROLLER_MAX_POLICY_LENGTH,
	PARENT_CONTROLLER_MAX_REASON_LENGTH,
	PARENT_CONTROLLER_METHODS,
	PARENT_CONTROLLER_PROTOCOL,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	ParentControllerErrorCode,
	type ParentControllerMethod,
	type ParentControllerOfferMessage,
	type ParentControllerPortMessage,
	type ParentFrameContext,
	type VerifiedEmbedPolicyClaims,
} from './protocol'
import {
	normalizeParentControllerOrigin,
	readParentFrameContext,
	sanitizeParentControllerState,
	sanitizeParentControllerText,
	sanitizeParentControllerUrl,
	secureParentControllerId,
} from './security'

import type {
	ParentControllerActionPolicy,
	ParentControllerActionPolicyDecision,
	ParentControllerActionRequest,
	ParentControllerApprovalDecision,
	ParentControllerHostWindow,
	ParentControllerLogger,
	ParentControllerMessagePort,
	ParentControllerTargetWindow,
	ParentControllerTransformState,
	ParentControllerVerifyEmbedPolicy,
	ParentPageControllerHostOptions,
} from './types'

const METHOD_CAPABILITY: Record<ParentControllerMethod, ParentControllerCapability> = {
	getCurrentUrl: 'observe',
	getLastUpdateTime: 'observe',
	getBrowserState: 'observe',
	updateTree: 'observe',
	cleanUpHighlights: 'cleanup',
	clickElement: 'click',
	inputText: 'input',
	selectOption: 'select',
	scroll: 'scroll',
	scrollHorizontally: 'scrollHorizontally',
	showMask: 'visual',
	hideMask: 'visual',
}

const MUTATING_METHODS = new Set<ParentControllerMethod>([
	'clickElement',
	'inputText',
	'selectOption',
	'scroll',
	'scrollHorizontally',
])
const MAX_REQUESTS_PER_SESSION = 10_000
const MAX_CONCURRENT_REQUESTS = 128
const MAX_HANDSHAKE_REQUEST_IDS = 128
const REQUIRED_SANDBOX_TOKENS = new Set(['allow-scripts', 'allow-same-origin'])

interface OfferPublishMetadata {
	readonly handshakeRequestId?: string
	readonly automaticReconnect?: boolean
}

interface ActiveRequest {
	readonly message: Omit<
		Extract<import('./protocol').ParentControllerRequestMessage, { type: 'request' }>,
		'method' | 'capability'
	> & {
		readonly method: ParentControllerMethod
		readonly capability: ParentControllerCapability
	}
	readonly abortController: AbortController
	readonly connection: HostConnection
	readonly generation: number
	started: boolean
	settled: boolean
	approval?: ApprovalWaiter
	approvalTarget?: Element | null
	approvalTargetFingerprint?: string
	policyTarget?: Element | null
	policyTargetFingerprint?: string
	policyReason?: string
	approvalTimedOut?: boolean
	timedOut?: boolean
	timer?: ReturnType<typeof setTimeout>
	responseSent: boolean
	preparedAction?: ParentFrameProxyPreparedAction
	approved?: boolean
}

interface ApprovalWaiter {
	readonly approvalId: string
	readonly request: ActiveRequest
	readonly hash: string
	readonly expiresAt: number
	readonly resolve: (approved: boolean) => void
	readonly timer: ReturnType<typeof setTimeout>
	used: boolean
}

interface HostConnection {
	readonly policyId: string
	readonly sessionId: string
	readonly hostInstanceId: string
	readonly frameInstanceId: string
	readonly frameContext: ParentFrameContext
	readonly capabilities: readonly ParentControllerCapability[]
	readonly expiresAt: number
	readonly seenRequestIds: Set<string>
	readonly childFrameGrants: readonly ParentFrameProxyGrant[]
	treeRevision: number
	state: IndexedBrowserState | null
}

interface ParentNavigationApi {
	addEventListener(type: 'navigate', listener: EventListener): void
	removeEventListener(type: 'navigate', listener: EventListener): void
}

type ParentWindowWithNavigation = Window & { navigation?: ParentNavigationApi }

function defaultHostWindow(): ParentControllerHostWindow {
	const value = (globalThis as typeof globalThis & { window?: ParentControllerHostWindow }).window
	if (!value?.document) throw new Error('ParentPageControllerHost requires a browser window')
	return value
}

function timeoutValue(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback
	if (!Number.isFinite(value) || value <= 0)
		throw new TypeError(`${name} must be positive and finite`)
	return Math.floor(value)
}

function asError(code: string, message: string): Error {
	const error = new Error(message)
	error.name = code
	;(error as Error & { code?: string }).code = code
	return error
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted)
		return Promise.reject(asError(ParentControllerErrorCode.ABORTED, 'Operation was aborted'))
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(asError(ParentControllerErrorCode.ABORTED, 'Operation was aborted'))
		}
		signal.addEventListener('abort', onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				reject(error instanceof Error ? error : new Error('Asynchronous operation failed'))
			}
		)
	})
}

function errorCode(error: unknown): ParentControllerErrorCode {
	const rawCode =
		error && typeof error === 'object' && 'code' in error
			? (error as { code?: unknown }).code
			: undefined
	const code = typeof rawCode === 'string' ? rawCode : ''
	if (Object.values(ParentControllerErrorCode).includes(code as ParentControllerErrorCode))
		return code as ParentControllerErrorCode
	if (error instanceof Error && /stale|indexed element|not indexed/i.test(error.message))
		return ParentControllerErrorCode.STALE_TREE
	if (error instanceof Error && /root|configured DOM root/i.test(error.message))
		return ParentControllerErrorCode.ROOT_UNAVAILABLE
	return ParentControllerErrorCode.INTERNAL_ERROR
}

function safeErrorMessage(code: ParentControllerErrorCode): string {
	if (code === ParentControllerErrorCode.ROOT_UNAVAILABLE)
		return 'The configured DOM root is unavailable.'
	if (code === ParentControllerErrorCode.STALE_TREE)
		return 'The indexed tree is stale; observe state again.'
	if (code === ParentControllerErrorCode.OUTCOME_UNKNOWN)
		return 'Outcome is unknown; re-observe state before retrying.'
	if (code === ParentControllerErrorCode.APPROVAL_DENIED) return 'The action was not approved.'
	if (code === ParentControllerErrorCode.APPROVAL_TIMEOUT) return 'Approval timed out.'
	if (code === ParentControllerErrorCode.CAPABILITY_DENIED)
		return 'The requested capability is not authorized.'
	if (code === ParentControllerErrorCode.ABORTED) return 'The request was aborted.'
	return 'Parent controller request failed.'
}

function isActionMethod(method: ParentControllerMethod): boolean {
	return MUTATING_METHODS.has(method)
}

function isSafeString(value: unknown, max = PARENT_CONTROLLER_MAX_REASON_LENGTH): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isIndexedState(value: unknown): value is IndexedBrowserState {
	if (!value || typeof value !== 'object') return false
	const state = value as Record<string, unknown>
	return (
		Object.keys(state).every((key) =>
			['url', 'title', 'header', 'content', 'footer', 'treeRevision', 'indices'].includes(key)
		) &&
		typeof state.url === 'string' &&
		typeof state.title === 'string' &&
		typeof state.header === 'string' &&
		typeof state.content === 'string' &&
		typeof state.footer === 'string' &&
		Number.isSafeInteger(state.treeRevision) &&
		Number(state.treeRevision) >= 0 &&
		Array.isArray(state.indices) &&
		new Set(state.indices).size === state.indices.length &&
		state.indices.every(
			(index) => typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
		)
	)
}

function sameIndices(left: readonly number[], right: readonly number[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index])
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const record = value as Record<string, unknown>
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		.join(',')}}`
}

async function payloadHash(value: unknown): Promise<string> {
	const cryptoObject = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto
	if (!cryptoObject?.subtle) throw new Error('Web Crypto is required for approval payload binding')
	const digest = await cryptoObject.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(stableStringify(value))
	)
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function normalizePolicyDecision(
	value: ParentControllerActionPolicyDecision
): 'allow' | 'deny' | 'approval_required' {
	if (typeof value === 'boolean') return value ? 'allow' : 'deny'
	if (
		value &&
		typeof value === 'object' &&
		(value.decision === 'allow' ||
			value.decision === 'deny' ||
			value.decision === 'approval_required')
	)
		return value.decision
	return 'deny'
}

function combinePolicyDecisions(
	...decisions: ('allow' | 'deny' | 'approval_required')[]
): 'allow' | 'deny' | 'approval_required' {
	if (decisions.includes('deny')) return 'deny'
	if (decisions.includes('approval_required')) return 'approval_required'
	return 'allow'
}

/** Parent-side host that owns one scoped PageController and one child iframe. */
export class ParentPageControllerHost extends EventTarget {
	readonly iframe: HTMLIFrameElement
	readonly assistantOrigin: string
	readonly root: NonNullable<ParentPageControllerHostOptions['root']>
	readonly scopeId: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly controller: IndexedPageControllerAdapter
	readonly hostInstanceId: string

	private readonly options: ParentPageControllerHostOptions
	private readonly ownerDocument: Document
	private readonly hostWindow: ParentControllerHostWindow
	private readonly handshakeTimeoutMs: number
	private readonly requestTimeoutMs: number
	private readonly approvalTimeoutMs: number
	private readonly logger: ParentControllerLogger | undefined
	private readonly actionPolicy: ParentControllerActionPolicy | undefined
	private readonly transformState: ParentControllerTransformState | undefined
	private readonly disposeController: boolean
	private readonly visualFeedback: 'non-blocking' | 'none'
	private readonly handshakeMode: 'assistant-initiated' | 'parent-initiated'
	private readonly autoReconnect: boolean
	private readonly addedNotInteractive: boolean
	private previousNotInteractive: string | null = null
	private feedback: HTMLElement | null = null
	private visualCursor: ParentVisualCursor | null = null
	private started = false
	private disposed = false
	private offer: ParentControllerOfferMessage | null = null
	private offerFrameContext: ParentFrameContext | null = null
	private offerExpiresAt = 0
	private offerSessionExpiresAt = 0
	private offerChildFrameGrants: readonly ParentFrameProxyGrant[] = []
	private offerPublishPromise: Promise<void> | null = null
	private offerGeneration = 0
	private offerAbortController: AbortController | null = null
	private activated = false
	private readonly seenHandshakeRequestIds = new Set<string>()
	private usedPolicyIds = new Map<string, number>()
	private connection: HostConnection | null = null
	private connectionExpiryTimer: ReturnType<typeof setTimeout> | null = null
	private connectionGeneration = 0
	private port: ParentControllerMessagePort | null = null
	private portMessageHandler: ((event: MessageEvent<unknown>) => void) | null = null
	private portMessageErrorHandler: ((event: MessageEvent<unknown>) => void) | null = null
	private requests = new Map<string, ActiveRequest>()
	private approvals = new Map<string, ApprovalWaiter>()
	private executionTail: Promise<void> = Promise.resolve()
	private feedbackRequested = false
	private readonly windowMessageListener = (event: MessageEvent<unknown>) =>
		this.handleWindowMessage(event)
	private readonly iframeLoadListener = () => {
		if (this.disposed || !this.started) return
		// A new document cannot inherit the previous document's in-memory
		// activation. Require the new A instance to request another user handshake.
		this.activated = false
		this.seenHandshakeRequestIds.clear()
		this.offerGeneration += 1
		this.offerAbortController?.abort()
		this.offerAbortController = null
		this.visualCursor?.clear()
		this.resetConnection()
		this.offer = null
		this.offerFrameContext = null
		this.offerChildFrameGrants = []
		if (this.handshakeMode === 'parent-initiated') void this.publishOffer(true)
	}
	private readonly navigationListener = () => {
		if (this.disposed || !this.started) return
		const shouldReconnect = this.activated && this.autoReconnect
		this.offerGeneration += 1
		this.offerAbortController?.abort()
		this.offerAbortController = null
		this.visualCursor?.clear()
		this.resetConnection()
		this.offer = null
		this.offerFrameContext = null
		this.offerChildFrameGrants = []
		if (shouldReconnect) this.publishAutomaticReconnect()
		else if (this.handshakeMode === 'parent-initiated') void this.publishOffer(true)
	}
	private readonly pagehideListener = () => {
		if (!this.disposed) this.dispose()
	}
	private readonly navigationApiListener = () => this.navigationListener()
	private navigationApi: ParentNavigationApi | null = null

	constructor(options: ParentPageControllerHostOptions) {
		super()
		if (!options || typeof options !== 'object')
			throw new TypeError('ParentPageControllerHost requires options')
		this.options = options
		this.iframe = options.iframe
		if (!this.iframe || !('contentWindow' in this.iframe))
			throw new TypeError('iframe must be an HTMLIFrameElement')
		this.ownerDocument = this.iframe.ownerDocument
		this.hostWindow = options.window ?? defaultHostWindow()
		this.assistantOrigin = normalizeParentControllerOrigin(options.assistantOrigin)
		this.root = options.root
		if (
			typeof options.scopeId !== 'string' ||
			options.scopeId.length === 0 ||
			options.scopeId.length > 256
		)
			throw new TypeError('scopeId must be a non-empty identifier')
		this.scopeId = options.scopeId
		if (
			!Array.isArray(options.capabilities) ||
			options.capabilities.length === 0 ||
			new Set(options.capabilities).size !== options.capabilities.length ||
			options.capabilities.some((capability) => !isCapability(capability))
		)
			throw new TypeError('capabilities must contain known unique capabilities')
		this.capabilities = [...options.capabilities]
		this.handshakeTimeoutMs = timeoutValue(options.handshakeTimeoutMs, 5_000, 'handshakeTimeoutMs')
		this.requestTimeoutMs = timeoutValue(options.requestTimeoutMs, 30_000, 'requestTimeoutMs')
		this.approvalTimeoutMs = timeoutValue(options.approvalTimeoutMs, 30_000, 'approvalTimeoutMs')
		this.logger = options.logger
		this.actionPolicy = options.actionPolicy
		this.transformState = options.transformState
		this.disposeController = options.disposeController ?? true
		this.visualFeedback = options.visualFeedback ?? 'none'
		if (
			options.handshakeMode !== undefined &&
			options.handshakeMode !== 'assistant-initiated' &&
			options.handshakeMode !== 'parent-initiated'
		)
			throw new TypeError('handshakeMode is invalid')
		if (options.autoReconnect !== undefined && typeof options.autoReconnect !== 'boolean')
			throw new TypeError('autoReconnect must be a boolean')
		this.handshakeMode = options.handshakeMode ?? 'assistant-initiated'
		this.autoReconnect = options.autoReconnect ?? true
		this.validateRoot()
		const controllerOptions = options.controllerOptions ?? {}
		const childFrames = options.childFrames
		if (childFrames && (!Array.isArray(childFrames.targets) || childFrames.targets.length === 0))
			throw new TypeError('childFrames.targets must contain at least one explicit target')
		const childFrameBoundaries =
			childFrames?.targets.map((target) => {
				const iframeOrResolver = target.iframe
				if (typeof iframeOrResolver !== 'function') return iframeOrResolver
				return () => {
					try {
						return iframeOrResolver() ?? this.iframe
					} catch {
						return this.iframe
					}
				}
			}) ?? []
		const localController = new PageController({
			...controllerOptions,
			root: options.root,
			viewportExpansion: controllerOptions.viewportExpansion ?? 0,
			enableMask: false,
			interactiveBlacklist: [
				...(controllerOptions.interactiveBlacklist ?? []),
				...childFrameBoundaries,
			],
			contentBlacklist: [...(controllerOptions.contentBlacklist ?? []), ...childFrameBoundaries],
		})
		this.controller = childFrames
			? new ParentFrameProxyController({
					localController,
					root: options.root,
					assistantIframe: this.iframe,
					targets: childFrames.targets,
					handshakeTimeoutMs: timeoutValue(
						childFrames.handshakeTimeoutMs,
						1_000,
						'childFrames.handshakeTimeoutMs'
					),
					requestTimeoutMs: timeoutValue(
						childFrames.requestTimeoutMs,
						5_000,
						'childFrames.requestTimeoutMs'
					),
					window: this.hostWindow as unknown as Window,
					disposeLocalController: this.disposeController,
				})
			: localController
		this.hostInstanceId = secureParentControllerId('host')
		if (!this.iframe.hasAttribute('data-page-agent-not-interactive')) {
			this.addedNotInteractive = true
			this.iframe.setAttribute('data-page-agent-not-interactive', '')
		} else this.addedNotInteractive = false
		this.previousNotInteractive = this.iframe.getAttribute('data-page-agent-not-interactive')
	}

	private validateRoot(): Element {
		let root: Element | null | undefined
		try {
			root = typeof this.root === 'function' ? this.root() : this.root
		} catch {
			root = null
		}
		if (
			!root ||
			root.nodeType !== 1 ||
			root.ownerDocument !== this.ownerDocument ||
			!root.isConnected ||
			!this.ownerDocument.documentElement.contains(root) ||
			root.contains(this.iframe)
		) {
			this.visualCursor?.clear()
			throw asError(
				ParentControllerErrorCode.ROOT_UNAVAILABLE,
				'The configured DOM root is unavailable'
			)
		}
		return root
	}

	private parentOrigin(): string {
		const origin =
			this.hostWindow.location?.origin ??
			this.ownerDocument.defaultView?.location.origin ??
			this.ownerDocument.location.origin
		return normalizeParentControllerOrigin(origin)
	}

	private frameWindow(): ParentControllerTargetWindow | null {
		return (this.iframe.contentWindow as unknown as ParentControllerTargetWindow | null) ?? null
	}

	start(): this {
		if (this.disposed) throw asError(ParentControllerErrorCode.DISPOSED, 'Host is disposed')
		if (this.started) return this
		this.validateRoot()
		this.started = true
		this.hostWindow.addEventListener('message', this.windowMessageListener)
		this.hostWindow.addEventListener('popstate', this.navigationListener)
		this.hostWindow.addEventListener('hashchange', this.navigationListener)
		this.hostWindow.addEventListener('pagehide', this.pagehideListener)
		this.iframe.addEventListener('load', this.iframeLoadListener)
		const parentWindow = this.ownerDocument.defaultView as ParentWindowWithNavigation | null
		const navigationApi = parentWindow?.navigation
		if (navigationApi) {
			this.navigationApi = navigationApi
			navigationApi.addEventListener('navigate', this.navigationApiListener)
		}
		this.ensureFeedback()
		this.ensureVisualCursor()
		if (this.handshakeMode === 'parent-initiated') void this.publishOffer(false)
		return this
	}

	get activationActive(): boolean {
		return this.activated && !this.disposed
	}

	/** P-side automatic reconnect. It is available only after a successful activation. */
	reconnect(): boolean {
		if (this.disposed || !this.started || !this.activated || !this.autoReconnect) return false
		this.resetConnection()
		this.offer = null
		this.offerFrameContext = null
		this.offerChildFrameGrants = []
		this.publishAutomaticReconnect()
		return true
	}

	private publishAutomaticReconnect(): void {
		if (this.handshakeMode === 'assistant-initiated')
			void this.publishOffer(true, { automaticReconnect: true })
		else void this.publishOffer(true)
	}

	/** Clear the activation lease; the next connection must be requested explicitly by A. */
	deactivate(): void {
		if (this.disposed) return
		const message = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'deactivate' as const,
			requestId: secureParentControllerId('deactivate'),
		}
		try {
			if (isParentControllerMessageSizeAllowed(message))
				this.frameWindow()?.postMessage(message, this.assistantOrigin)
		} catch {
			/* A may no longer be ready. */
		}
		this.clearActivation()
	}

	private clearActivation(): void {
		this.activated = false
		this.offerGeneration += 1
		this.offerAbortController?.abort()
		this.offerAbortController = null
		this.resetConnection()
		this.offer = null
		this.offerFrameContext = null
		this.offerChildFrameGrants = []
		this.seenHandshakeRequestIds.clear()
		this.emitLog({ event: 'deactivated' })
		this.dispatchEvent(new Event('deactivated'))
	}

	private ensureFeedback(): void {
		if (this.visualFeedback !== 'non-blocking' || this.feedback) return
		const element = this.ownerDocument.createElement('div')
		element.className = 'page-agent-parent-feedback'
		element.setAttribute('data-page-agent-parent-feedback', '')
		element.setAttribute('aria-live', 'polite')
		element.setAttribute('aria-hidden', 'true')
		element.hidden = true
		element.dataset.state = 'idle'
		this.ownerDocument.body?.appendChild(element)
		const computed =
			this.hostWindow.getComputedStyle?.(element) ??
			this.ownerDocument.defaultView?.getComputedStyle(element)
		if (computed && computed.pointerEvents !== 'none') {
			element.remove()
			return
		}
		this.feedback = element
	}

	private ensureVisualCursor(): void {
		if (this.visualFeedback !== 'non-blocking' || this.visualCursor) return
		this.visualCursor = new ParentVisualCursor({
			document: this.ownerDocument,
			window: this.hostWindow,
			root: this.root,
			iframe: this.iframe,
		})
	}

	private setFeedback(state: 'idle' | 'running' | 'approval' | 'error'): void {
		if (!this.feedback) return
		this.feedback.dataset.state = state
		this.feedback.hidden = state === 'idle'
		this.feedback.setAttribute('aria-hidden', state === 'idle' ? 'true' : 'false')
		this.feedback.textContent =
			state === 'approval'
				? 'Approval required'
				: state === 'running'
					? 'Assistant is operating'
					: ''
	}

	private setFeedbackRequested(requested: boolean): void {
		this.feedbackRequested = requested
		this.visualCursor?.setEnabled(requested)
		this.setFeedback(requested ? 'running' : 'idle')
	}

	/**
	 * Clear presentation owned by this host and its controller.
	 *
	 * The controller cleanup is deliberately scoped to this controller instance.
	 * Calling the global DOM cleanup helper here could remove highlights owned by
	 * another PageController in the same document.
	 */
	private cleanupVisualState(): Promise<void> {
		this.setFeedbackRequested(false)
		try {
			return Promise.resolve(this.controller.cleanUpHighlights()).catch(() => undefined)
		} catch {
			return Promise.resolve()
		}
	}

	private async publishOffer(force: boolean, metadata: OfferPublishMetadata = {}): Promise<void> {
		if (force) {
			this.offerGeneration += 1
			this.offerAbortController?.abort()
			this.offerAbortController = null
		}
		if (this.offerPublishPromise && !force) return this.offerPublishPromise
		const generation = this.offerGeneration
		const task = this.publishOfferImpl(force, generation, metadata)
		this.offerPublishPromise = task
		try {
			await task
		} finally {
			if (this.offerPublishPromise === task) this.offerPublishPromise = null
		}
	}

	private isCurrentOfferGeneration(generation: number): boolean {
		return !this.disposed && this.started && generation === this.offerGeneration
	}

	private async publishOfferImpl(
		force: boolean,
		generation: number,
		metadata: OfferPublishMetadata
	): Promise<void> {
		if (!this.isCurrentOfferGeneration(generation)) return
		const target = this.frameWindow()
		if (!target) return
		if (!force && this.offer && this.offerFrameContext) {
			try {
				target.postMessage(this.offer, this.assistantOrigin)
			} catch {
				/* child may not be ready */
			}
			return
		}
		let parentOrigin: string
		try {
			parentOrigin = this.parentOrigin()
		} catch {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.EMBED_POLICY_DENIED })
			return
		}
		let frameContext: ParentFrameContext
		try {
			frameContext = readParentFrameContext(this.iframe, this.ownerDocument)
		} catch {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.EMBED_POLICY_DENIED })
			return
		}
		if (
			!frameContext.directChild ||
			frameContext.parentOrigin !== parentOrigin ||
			frameContext.assistantOrigin !== this.assistantOrigin ||
			frameContext.sandbox.length !== REQUIRED_SANDBOX_TOKENS.size ||
			frameContext.sandbox.some((token) => !REQUIRED_SANDBOX_TOKENS.has(token)) ||
			!frameContext.sandbox.includes('allow-scripts') ||
			!frameContext.sandbox.includes('allow-same-origin') ||
			!frameContext.allowScripts ||
			!frameContext.allowSameOrigin
		) {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.EMBED_POLICY_DENIED })
			return
		}
		const bridgeBinding = {
			challenge: secureParentControllerId('challenge'),
			sessionId: secureParentControllerId('session'),
			hostInstanceId: this.hostInstanceId,
			frameInstanceId: secureParentControllerId('frame'),
		}
		let policy: string
		const policyController = new AbortController()
		this.offerAbortController = policyController
		const policyTimer = setTimeout(() => policyController.abort(), this.handshakeTimeoutMs)
		try {
			policy = await waitForAbort(
				Promise.resolve().then(() =>
					this.options.getEmbedPolicy({
						...bridgeBinding,
						parentOrigin,
						assistantOrigin: this.assistantOrigin,
						scopeId: this.scopeId,
						capabilities: [...this.capabilities],
						signal: policyController.signal,
					})
				),
				policyController.signal
			)
		} catch {
			if (this.isCurrentOfferGeneration(generation))
				this.emitLog({
					event: 'offer_denied',
					code: policyController.signal.aborted
						? ParentControllerErrorCode.TIMEOUT
						: ParentControllerErrorCode.EMBED_POLICY_DENIED,
				})
			return
		} finally {
			clearTimeout(policyTimer)
			if (this.offerAbortController === policyController) this.offerAbortController = null
		}
		if (!this.isCurrentOfferGeneration(generation)) return
		if (!isSafeString(policy, PARENT_CONTROLLER_MAX_POLICY_LENGTH)) {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.INVALID_MESSAGE })
			return
		}
		const signalController = new AbortController()
		this.offerAbortController = signalController
		const timer = setTimeout(() => signalController.abort(), this.handshakeTimeoutMs)
		let claims: VerifiedEmbedPolicyClaims | false | null
		try {
			claims = await waitForAbort(
				Promise.resolve().then(() =>
					this.options.verifyEmbedPolicy(policy, {
						actualParentOrigin: parentOrigin,
						assistantOrigin: this.assistantOrigin,
						frameContext,
						signal: signalController.signal,
					})
				),
				signalController.signal
			)
		} catch {
			claims = false
		}
		clearTimeout(timer)
		if (this.offerAbortController === signalController) this.offerAbortController = null
		if (!this.isCurrentOfferGeneration(generation) || signalController.signal.aborted) return
		const claimsCode = claims
			? this.validateClaims(claims, parentOrigin, frameContext, bridgeBinding)
			: ParentControllerErrorCode.EMBED_POLICY_DENIED
		if (!claims || claimsCode !== true) {
			this.emitLog({
				event: 'offer_denied',
				code: claimsCode === true ? ParentControllerErrorCode.EMBED_POLICY_DENIED : claimsCode,
			})
			return
		}
		const childFrameGrants = this.validateChildFrameClaims(claims)
		if (childFrameGrants === false) {
			this.emitLog({
				event: 'offer_denied',
				code: ParentControllerErrorCode.EMBED_POLICY_DENIED,
			})
			return
		}
		const now = Math.floor(Date.now() / 1000)
		for (const [policyId, expiresAt] of this.usedPolicyIds) {
			if (expiresAt <= now) this.usedPolicyIds.delete(policyId)
		}
		if (this.usedPolicyIds.has(claims.jti)) {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.POLICY_REPLAYED })
			return
		}
		this.usedPolicyIds.set(claims.jti, claims.bridgeSessionExp ?? claims.exp)
		const offer: ParentControllerOfferMessage = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'offer',
			...(metadata.handshakeRequestId === undefined
				? {}
				: { handshakeRequestId: metadata.handshakeRequestId }),
			...(metadata.automaticReconnect === true ? { automaticReconnect: true } : {}),
			policy,
			policyId: claims.jti,
			challenge: bridgeBinding.challenge,
			sessionId: bridgeBinding.sessionId,
			hostInstanceId: bridgeBinding.hostInstanceId,
			frameInstanceId: bridgeBinding.frameInstanceId,
			assistantOrigin: this.assistantOrigin,
			capabilities: this.capabilities.filter((capability) => claims.cap.includes(capability)),
			frameContext,
		}
		if (offer.capabilities.length === 0 || !isParentControllerMessageSizeAllowed(offer)) {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.CAPABILITY_DENIED })
			return
		}
		this.offer = offer
		this.offerFrameContext = frameContext
		this.offerExpiresAt = claims.exp
		this.offerSessionExpiresAt = claims.bridgeSessionExp ?? claims.exp
		this.offerChildFrameGrants = childFrameGrants
		try {
			if (!this.isCurrentOfferGeneration(generation)) return
			target.postMessage(offer, this.assistantOrigin)
			this.emitLog({
				event: 'offer',
				sessionId: offer.sessionId,
				messageBytes: messageByteLength(offer),
			})
		} catch {
			this.emitLog({ event: 'offer_denied', code: ParentControllerErrorCode.CONNECTION_CLOSED })
		}
	}

	private validateClaims(
		claims: VerifiedEmbedPolicyClaims,
		parentOrigin: string,
		frameContext: ParentFrameContext,
		bridgeBinding: import('./protocol').ParentControllerBridgeBinding
	): true | ParentControllerErrorCode {
		if (
			!claims ||
			typeof claims !== 'object' ||
			!isSafeString(claims.jti, 256) ||
			!isSafeString(claims.tenant, 256) ||
			!isSafeString(claims.user, 256) ||
			!isSafeString(claims.targetId, 256) ||
			!isSafeString(claims.scopeId, 256) ||
			claims.scopeId !== this.scopeId ||
			claims.parentOrigin !== parentOrigin ||
			claims.assistantOrigin !== this.assistantOrigin ||
			frameContext.parentOrigin !== parentOrigin ||
			frameContext.assistantOrigin !== this.assistantOrigin
		)
			return ParentControllerErrorCode.EMBED_POLICY_DENIED
		if (
			!Array.isArray(claims.cap) ||
			new Set(claims.cap).size !== claims.cap.length ||
			claims.cap.some((capability) => !isCapability(capability))
		)
			return ParentControllerErrorCode.CAPABILITY_DENIED
		if (
			!Number.isSafeInteger(claims.protocolVersionMin) ||
			!Number.isSafeInteger(claims.protocolVersionMax) ||
			claims.protocolVersionMin > PARENT_CONTROLLER_PROTOCOL_VERSION ||
			claims.protocolVersionMax < PARENT_CONTROLLER_PROTOCOL_VERSION
		)
			return ParentControllerErrorCode.PROTOCOL_MISMATCH
		const now = Math.floor(Date.now() / 1000)
		if (!Number.isSafeInteger(claims.exp) || claims.exp <= now)
			return ParentControllerErrorCode.POLICY_EXPIRED
		if (!Number.isSafeInteger(claims.nbf) || claims.nbf > now || claims.exp <= claims.nbf)
			return ParentControllerErrorCode.EMBED_POLICY_DENIED
		if (claims.bridgeBinding !== undefined) {
			const binding = claims.bridgeBinding
			if (
				!binding ||
				binding.sessionId !== bridgeBinding.sessionId ||
				binding.challenge !== bridgeBinding.challenge ||
				binding.hostInstanceId !== bridgeBinding.hostInstanceId ||
				binding.frameInstanceId !== bridgeBinding.frameInstanceId
			)
				return ParentControllerErrorCode.SESSION_MISMATCH
		}
		if (
			claims.bridgeSessionExp !== undefined &&
			(!Number.isSafeInteger(claims.bridgeSessionExp) || claims.bridgeSessionExp <= now)
		)
			return ParentControllerErrorCode.POLICY_EXPIRED
		return true
	}

	private validateChildFrameClaims(
		claims: VerifiedEmbedPolicyClaims
	): readonly ParentFrameProxyGrant[] | false {
		if (claims.childFrames === undefined) return []
		if (!Array.isArray(claims.childFrames)) return false
		const configured = this.options.childFrames?.targets ?? []
		if (claims.childFrames.length > configured.length) return false
		const configuredById = new Map(configured.map((target) => [target.id, target]))
		const seen = new Set<string>()
		const grants: ParentFrameProxyGrant[] = []
		for (const value of claims.childFrames) {
			if (
				!value ||
				typeof value !== 'object' ||
				Object.keys(value).some((key) => !['id', 'origin', 'cap'].includes(key)) ||
				!isSafeString(value.id, 256) ||
				seen.has(value.id)
			)
				return false
			const target = configuredById.get(value.id)
			if (!target) return false
			let origin: string
			let configuredOrigin: string
			try {
				origin = normalizeParentControllerOrigin(value.origin)
				configuredOrigin = normalizeParentControllerOrigin(target.origin)
			} catch {
				return false
			}
			if (origin !== configuredOrigin) return false
			if (
				!Array.isArray(value.cap) ||
				value.cap.length === 0 ||
				new Set(value.cap).size !== value.cap.length ||
				value.cap.some(
					(capability) =>
						typeof capability !== 'string' ||
						!(FRAME_BRIDGE_CAPABILITIES as readonly string[]).includes(capability) ||
						!target.capabilities.includes(capability as FrameBridgeCapability) ||
						!claims.cap.includes(capability) ||
						!this.capabilities.includes(capability as ParentControllerCapability)
				)
			)
				return false
			seen.add(value.id)
			grants.push({
				id: value.id,
				origin,
				capabilities: value.cap as FrameBridgeCapability[],
			})
		}
		return grants
	}

	private handleHandshakeRequest(
		message: import('./protocol').ParentControllerHandshakeRequestMessage
	): void {
		if (!this.started || (message.reason === 'reconnect' && !this.activated)) return
		if (this.seenHandshakeRequestIds.has(message.requestId)) {
			if (this.offer?.handshakeRequestId === message.requestId) {
				try {
					this.frameWindow()?.postMessage(this.offer, this.assistantOrigin)
				} catch {
					/* A may no longer be ready. */
				}
			}
			return
		}
		if (this.seenHandshakeRequestIds.size >= MAX_HANDSHAKE_REQUEST_IDS) {
			const oldest = this.seenHandshakeRequestIds.values().next().value as string | undefined
			if (oldest) this.seenHandshakeRequestIds.delete(oldest)
		}
		this.seenHandshakeRequestIds.add(message.requestId)
		this.emitLog({ event: 'handshake_request', requestId: message.requestId })
		if (this.connection || this.port) this.resetConnection()
		this.offer = null
		this.offerFrameContext = null
		this.offerChildFrameGrants = []
		void this.publishOffer(true, {
			handshakeRequestId: message.requestId,
			automaticReconnect: message.reason === 'reconnect',
		})
	}

	private handleWindowMessage(event: MessageEvent<unknown>): void {
		if (this.disposed || event.source !== this.frameWindow()) return
		let origin: string
		try {
			origin = normalizeParentControllerOrigin(event.origin)
		} catch {
			return
		}
		if (origin !== this.assistantOrigin || !isParentControllerMessageSizeAllowed(event.data)) return
		if (isParentControllerHandshakeRequestMessage(event.data)) {
			this.handleHandshakeRequest(event.data)
			return
		}
		if (isParentControllerDeactivateMessage(event.data)) {
			// A-originated deactivation is already addressed to this host. Clear
			// local state without sending a second deactivate back to A.
			this.clearActivation()
			return
		}
		if (!isParentControllerAcceptMessage(event.data)) return
		const offer = this.offer
		if (
			!offer ||
			event.data.policyId !== offer.policyId ||
			event.data.challenge !== offer.challenge ||
			event.data.sessionId !== offer.sessionId ||
			event.data.hostInstanceId !== offer.hostInstanceId ||
			event.data.frameInstanceId !== offer.frameInstanceId
		)
			return
		if (this.offerExpiresAt <= Math.floor(Date.now() / 1000)) {
			const handshakeRequestId = offer.handshakeRequestId
			const automaticReconnect = offer.automaticReconnect === true
			this.offer = null
			this.offerFrameContext = null
			this.offerChildFrameGrants = []
			if (handshakeRequestId)
				void this.publishOffer(true, { handshakeRequestId, automaticReconnect })
			else if (this.activated && this.autoReconnect) this.publishAutomaticReconnect()
			return
		}
		try {
			const frameContext = readParentFrameContext(this.iframe, this.ownerDocument)
			if (
				frameContext.parentOrigin !== offer.frameContext.parentOrigin ||
				frameContext.assistantOrigin !== offer.frameContext.assistantOrigin ||
				!frameContext.directChild ||
				frameContext.allowScripts !== offer.frameContext.allowScripts ||
				frameContext.allowSameOrigin !== offer.frameContext.allowSameOrigin ||
				frameContext.sandbox.join('\u0000') !== offer.frameContext.sandbox.join('\u0000')
			)
				return
		} catch {
			return
		}
		if (
			event.data.capabilities.length === 0 ||
			event.data.capabilities.some((capability) => !offer.capabilities.includes(capability))
		)
			return
		if (this.connection || this.port) return
		const Channel =
			this.hostWindow.MessageChannel ??
			(typeof MessageChannel !== 'undefined' ? MessageChannel : undefined)
		if (!Channel) return
		let channel: { port1: ParentControllerMessagePort; port2: ParentControllerMessagePort }
		try {
			channel = new Channel() as unknown as typeof channel
		} catch {
			return
		}
		const acceptedCapabilities = [...event.data.capabilities]
		this.connection = {
			policyId: offer.policyId,
			sessionId: offer.sessionId,
			hostInstanceId: offer.hostInstanceId,
			frameInstanceId: offer.frameInstanceId,
			frameContext: offer.frameContext,
			capabilities: acceptedCapabilities,
			childFrameGrants: this.offerChildFrameGrants.map((grant) => ({
				...grant,
				capabilities: grant.capabilities.filter((capability) =>
					acceptedCapabilities.includes(capability as ParentControllerCapability)
				),
			})),
			expiresAt: this.offerSessionExpiresAt,
			seenRequestIds: new Set(),
			treeRevision: 0,
			state: null,
		}
		this.activated = true
		if (this.controller instanceof ParentFrameProxyController)
			this.controller.setAuthorizedFrames(this.connection.childFrameGrants)
		this.connectionGeneration += 1
		this.attachPort(channel.port2)
		this.scheduleConnectionExpiry(this.connection)
		const connect = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'connect' as const,
			policyId: offer.policyId,
			challenge: offer.challenge,
			sessionId: offer.sessionId,
			hostInstanceId: offer.hostInstanceId,
			frameInstanceId: offer.frameInstanceId,
			capabilities: [...event.data.capabilities],
			frameContext: offer.frameContext,
		}
		try {
			this.frameWindow()?.postMessage(connect, this.assistantOrigin, [
				channel.port1 as unknown as Transferable,
			])
			this.postConnected()
		} catch {
			this.resetConnection()
			if (this.activated && this.autoReconnect) this.publishAutomaticReconnect()
		}
	}

	private attachPort(port: ParentControllerMessagePort): void {
		this.port = port
		this.portMessageHandler = (event) => this.handlePortMessage(event)
		this.portMessageErrorHandler = () => {
			if (this.disposed || this.port !== port) return
			this.emitLog({ event: 'error', code: ParentControllerErrorCode.INVALID_MESSAGE })
			this.resetConnection()
			this.offer = null
			this.offerFrameContext = null
			this.offerChildFrameGrants = []
			if (this.activated && this.autoReconnect) this.publishAutomaticReconnect()
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

	private scheduleConnectionExpiry(connection: HostConnection): void {
		if (this.connectionExpiryTimer) clearTimeout(this.connectionExpiryTimer)
		const delay = Math.min(2_147_483_647, Math.max(0, connection.expiresAt * 1000 - Date.now()))
		this.connectionExpiryTimer = setTimeout(() => {
			if (this.disposed || this.connection !== connection) return
			this.resetConnection()
			this.offer = null
			this.offerFrameContext = null
			this.offerChildFrameGrants = []
			if (this.activated && this.autoReconnect) this.publishAutomaticReconnect()
		}, delay)
	}

	private postConnected(): void {
		const connection = this.connection
		if (!connection) return
		this.postPort({
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'connected',
			policyId: connection.policyId,
			sessionId: connection.sessionId,
			hostInstanceId: connection.hostInstanceId,
			frameInstanceId: connection.frameInstanceId,
			treeRevision: connection.treeRevision,
			capabilities: [...connection.capabilities],
			frameContext: connection.frameContext,
		})
	}

	private postPort(message: unknown): boolean {
		if (!this.port || !isParentControllerMessageSizeAllowed(message)) return false
		try {
			this.port.postMessage(message)
			return true
		} catch {
			return false
		}
	}

	private handlePortMessage(event: MessageEvent<unknown>): void {
		if (
			this.disposed ||
			!this.connection ||
			!this.port ||
			!isParentControllerMessageSizeAllowed(event.data) ||
			!isParentControllerPortMessage(event.data)
		)
			return
		const message = event.data
		const connection = this.connection
		if (
			message.policyId !== connection.policyId ||
			message.sessionId !== connection.sessionId ||
			message.hostInstanceId !== connection.hostInstanceId ||
			message.frameInstanceId !== connection.frameInstanceId
		)
			return
		if (Date.now() / 1000 >= connection.expiresAt) {
			if (message.type === 'request')
				this.sendErrorForConnection(
					connection,
					message.requestId,
					message.method,
					ParentControllerErrorCode.POLICY_EXPIRED
				)
			this.resetConnection()
			this.offer = null
			this.offerFrameContext = null
			this.offerChildFrameGrants = []
			if (this.activated && this.autoReconnect) this.publishAutomaticReconnect()
			return
		}
		if (message.type === 'request') {
			if (!isParentControllerRequestMessage(message)) return
			this.acceptRequest(message)
		} else if (message.type === 'cancel') {
			if (!isKnownMethod(message.method) || !isCapability(message.capability)) return
			this.cancelRequest(message.requestId, message.method, message.capability)
		} else if (message.type === 'approval-response') this.handleApprovalResponse(message)
	}

	private acceptRequest(
		message: Extract<import('./protocol').ParentControllerRequestMessage, { type: 'request' }>
	): void {
		const connection = this.connection
		if (!connection) return
		if (connection.seenRequestIds.has(message.requestId)) return
		if (
			connection.seenRequestIds.size >= MAX_REQUESTS_PER_SESSION ||
			this.requests.size >= MAX_CONCURRENT_REQUESTS
		) {
			this.sendError(message.requestId, message.method, ParentControllerErrorCode.INVALID_MESSAGE)
			return
		}
		connection.seenRequestIds.add(message.requestId)
		if (
			!isKnownMethod(message.method) ||
			!isCapability(message.capability) ||
			METHOD_CAPABILITY[message.method] !== message.capability ||
			!isParentControllerPayload(message.method, message.payload)
		) {
			this.sendError(message.requestId, message.method, ParentControllerErrorCode.INVALID_PAYLOAD)
			return
		}
		if (!connection.capabilities.includes(message.capability)) {
			this.sendError(message.requestId, message.method, ParentControllerErrorCode.CAPABILITY_DENIED)
			return
		}
		const active: ActiveRequest = {
			message: message as ActiveRequest['message'],
			abortController: new AbortController(),
			connection,
			generation: this.connectionGeneration,
			started: false,
			settled: false,
			responseSent: false,
		}
		active.timer = setTimeout(() => {
			if (active.settled) return
			active.timedOut = true
			if (
				!active.responseSent &&
				this.connection === active.connection &&
				this.connectionGeneration === active.generation
			) {
				active.responseSent = true
				this.sendErrorForConnection(
					active.connection,
					active.message.requestId,
					active.message.method,
					active.started && isActionMethod(active.message.method)
						? ParentControllerErrorCode.OUTCOME_UNKNOWN
						: ParentControllerErrorCode.TIMEOUT
				)
			}
			active.abortController.abort()
			const approval = active.approval
			if (approval) {
				this.consumeApproval(approval)
				approval.resolve(false)
			}
		}, this.requestTimeoutMs)
		this.requests.set(message.requestId, active)
		this.executionTail = this.executionTail.then(() => this.execute(active)).catch(() => undefined)
	}

	private async execute(active: ActiveRequest): Promise<void> {
		const message = active.message
		const connection = active.connection
		try {
			if (this.connection !== connection || this.connectionGeneration !== active.generation) return
			if (Date.now() / 1000 >= connection.expiresAt)
				throw asError(ParentControllerErrorCode.POLICY_EXPIRED, 'Embed policy expired')
			if (active.abortController.signal.aborted)
				throw asError(ParentControllerErrorCode.ABORTED, 'Request was aborted')
			if (
				isActionMethod(message.method) &&
				(!connection.state || message.treeRevision !== connection.treeRevision)
			)
				throw asError(ParentControllerErrorCode.STALE_TREE, 'Indexed tree is stale')
			if (isActionMethod(message.method) && this.controller instanceof ParentFrameProxyController)
				active.preparedAction = await this.controller.prepareAction(
					message.method as ParentFrameProxyPreparedAction['method'],
					message.payload,
					{ signal: active.abortController.signal }
				)
			const decision = isActionMethod(message.method)
				? await this.evaluateActionPolicy(active)
				: 'allow'
			if (isActionMethod(message.method)) this.assertPolicyTargetUnchanged(active)
			if (decision === 'deny')
				throw asError(ParentControllerErrorCode.CAPABILITY_DENIED, 'Action denied by policy')
			if (decision === 'approval_required') {
				const snapshot = this.captureActionTarget(active)
				active.approvalTarget = snapshot.target
				active.approvalTargetFingerprint = snapshot.fingerprint
				if (this.connection !== connection || this.connectionGeneration !== active.generation)
					throw asError(ParentControllerErrorCode.ABORTED, 'Request was aborted')
				this.setFeedback('approval')
				const approved = await this.awaitApproval(active)
				if (!approved)
					throw asError(
						active.approvalTimedOut
							? ParentControllerErrorCode.APPROVAL_TIMEOUT
							: ParentControllerErrorCode.APPROVAL_DENIED,
						'Action was not approved'
					)
				active.approved = true
				const currentSnapshot = this.captureActionTarget(active)
				if (
					currentSnapshot.target !== active.approvalTarget ||
					currentSnapshot.fingerprint !== active.approvalTargetFingerprint
				)
					throw asError(
						ParentControllerErrorCode.APPROVAL_DENIED,
						'Action target changed after approval'
					)
				const recheckedDecision = await this.evaluateActionPolicy(active)
				this.assertPolicyTargetUnchanged(active)
				if (recheckedDecision === 'deny')
					throw asError(
						ParentControllerErrorCode.CAPABILITY_DENIED,
						'Action was denied after approval'
					)
				const postPolicySnapshot = this.captureActionTarget(active)
				if (
					postPolicySnapshot.target !== active.approvalTarget ||
					postPolicySnapshot.fingerprint !== active.approvalTargetFingerprint
				)
					throw asError(
						ParentControllerErrorCode.APPROVAL_DENIED,
						'Action target changed after approval'
					)
			}
			if (active.abortController.signal.aborted)
				throw asError(ParentControllerErrorCode.ABORTED, 'Request was aborted')
			if (isActionMethod(message.method)) {
				if (Date.now() / 1000 >= connection.expiresAt)
					throw asError(ParentControllerErrorCode.POLICY_EXPIRED, 'Embed policy expired')
				if (
					this.connection !== connection ||
					this.connectionGeneration !== active.generation ||
					!connection.state ||
					message.treeRevision !== connection.treeRevision
				)
					throw asError(ParentControllerErrorCode.STALE_TREE, 'Indexed tree is stale')
				this.resolveActionTarget(active)
				active.started = true
				this.postPort({
					protocol: PARENT_CONTROLLER_PROTOCOL,
					version: PARENT_CONTROLLER_PROTOCOL_VERSION,
					type: 'started',
					policyId: message.policyId,
					sessionId: message.sessionId,
					hostInstanceId: message.hostInstanceId,
					frameInstanceId: message.frameInstanceId,
					treeRevision: connection.treeRevision,
					requestId: message.requestId,
					method: message.method,
					capability: message.capability,
				})
			}
			if (this.connection !== connection || this.connectionGeneration !== active.generation)
				throw asError(ParentControllerErrorCode.ABORTED, 'Request was aborted')
			this.setFeedback('running')
			const result = await this.invoke(
				message.method,
				message.payload,
				active.abortController.signal,
				connection,
				active
			)
			if (active.abortController.signal.aborted && isActionMethod(message.method))
				throw asError(ParentControllerErrorCode.OUTCOME_UNKNOWN, 'Outcome is unknown')
			if (
				!active.responseSent &&
				this.connection === connection &&
				this.connectionGeneration === active.generation
			) {
				active.responseSent = true
				this.sendSuccessForConnection(connection, message.requestId, message.method, result)
			}
		} catch (error) {
			let code = errorCode(error)
			if (active.timedOut)
				code =
					active.started && isActionMethod(message.method)
						? ParentControllerErrorCode.OUTCOME_UNKNOWN
						: ParentControllerErrorCode.TIMEOUT
			if (active.abortController.signal.aborted && active.started && isActionMethod(message.method))
				code = ParentControllerErrorCode.OUTCOME_UNKNOWN
			if (
				code === ParentControllerErrorCode.INTERNAL_ERROR &&
				error instanceof Error &&
				error.name === 'AbortError'
			)
				code = active.started
					? ParentControllerErrorCode.OUTCOME_UNKNOWN
					: ParentControllerErrorCode.ABORTED
			if (!active.responseSent) {
				active.responseSent = true
				this.sendErrorForConnection(connection, message.requestId, message.method, code)
			}
		} finally {
			active.settled = true
			if (active.timer) clearTimeout(active.timer)
			if (this.requests.get(message.requestId) === active) this.requests.delete(message.requestId)
			if (active.approval) this.consumeApproval(active.approval)
			if (this.connection === connection && this.connectionGeneration === active.generation)
				this.setFeedback(this.feedbackRequested ? 'running' : 'idle')
		}
	}

	private async evaluateActionPolicy(
		active: ActiveRequest
	): Promise<'allow' | 'deny' | 'approval_required'> {
		const childDecision = active.preparedAction?.decision ?? 'allow'
		if (active.preparedAction?.kind === 'child-frame' && active.preparedAction.reason)
			active.policyReason = sanitizeParentControllerText(active.preparedAction.reason).slice(
				0,
				PARENT_CONTROLLER_MAX_REASON_LENGTH
			)
		const before = combinePolicyDecisions(this.evaluateLocalActionPolicy(active), childDecision)
		if (!this.actionPolicy) return this.recordPolicyTarget(active, before)
		const message = active.message
		const targetContext = active.preparedAction?.targetContext ?? {
			kind: 'local' as const,
			target: this.resolveActionTarget(active),
		}
		const request: ParentControllerActionRequest = {
			sessionId: message.sessionId,
			requestId: message.requestId,
			method: message.method,
			capability: message.capability,
			payload: message.payload,
			target: targetContext.kind === 'local' ? targetContext.target : undefined,
			targetContext,
			origin: this.assistantOrigin,
			iframe: this.iframe,
			policyId: message.policyId,
			signal: active.abortController.signal,
		}
		const customValue = await waitForAbort(
			Promise.resolve().then(() => this.actionPolicy!(request)),
			active.abortController.signal
		)
		const custom = normalizePolicyDecision(customValue)
		const customReason =
			typeof customValue === 'object' && customValue.reason
				? sanitizeParentControllerText(customValue.reason).slice(
						0,
						PARENT_CONTROLLER_MAX_REASON_LENGTH
					)
				: undefined
		if (customReason) active.policyReason = customReason
		const after = this.evaluateLocalActionPolicy(active)
		return this.recordPolicyTarget(
			active,
			combinePolicyDecisions(before, custom, after, childDecision)
		)
	}

	private resolveActionTarget(active: ActiveRequest): Element | undefined {
		if (active.preparedAction && this.controller instanceof ParentFrameProxyController)
			return this.controller.resolvePreparedElement(active.preparedAction)
		const payload = active.message.payload as Record<string, unknown>
		if (typeof payload.index !== 'number') return undefined
		const resolver = (
			this.controller as unknown as {
				getIndexedElementForPolicy?: (index: number) => HTMLElement
			}
		).getIndexedElementForPolicy
		if (!resolver)
			throw asError(
				ParentControllerErrorCode.ROOT_UNAVAILABLE,
				'Indexed element validation is unavailable'
			)
		try {
			return resolver.call(this.controller, payload.index)
		} catch (error) {
			throw asError(errorCode(error), 'Indexed element is unavailable')
		}
	}

	private evaluateLocalActionPolicy(active: ActiveRequest): 'allow' | 'deny' | 'approval_required' {
		const target = this.resolveActionTarget(active)
		if (!target) return 'allow'
		const root = this.validateRoot()
		let baseline: 'allow' | 'deny' | 'approval_required' = 'allow'
		let cursor: Element | null = target
		while (cursor) {
			const marker = cursor.getAttribute('data-page-agent-policy')
			if (marker && marker !== 'allow' && marker !== 'confirm' && marker !== 'deny')
				baseline = 'deny'
			else if (marker === 'deny') baseline = 'deny'
			else if (marker === 'confirm' && baseline !== 'deny') baseline = 'approval_required'
			if (cursor === root) break
			cursor = cursor.parentElement
		}
		if (active.message.method !== 'clickElement') return baseline

		const submitTarget = target.closest('button, input, form')
		const submitTag = submitTarget?.tagName.toLowerCase()
		const submitType = submitTarget?.getAttribute('type')?.toLowerCase()
		const isSubmit =
			submitTag === 'form' ||
			(submitTag === 'button' && (submitType === undefined || submitType === 'submit')) ||
			(submitTag === 'input' && (submitType === 'submit' || submitType === 'image'))
		if (isSubmit) {
			const form =
				submitTag === 'form'
					? submitTarget
					: (submitTarget as (Element & { form?: HTMLFormElement | null }) | null)?.form ?? null
			baseline =
				form && !root.contains(form)
					? 'deny'
					: combinePolicyDecisions(baseline, 'approval_required')
		}

		const anchor = target.closest('a[href]') as HTMLAnchorElement | null
		if (anchor?.href) {
			try {
				if (
					normalizeParentControllerOrigin(
						new URL(anchor.href, this.ownerDocument.baseURI).origin
					) !== this.parentOrigin()
				)
					baseline = combinePolicyDecisions(baseline, 'approval_required')
			} catch {
				baseline = 'deny'
			}
		}
		return baseline
	}

	private captureActionTarget(active: ActiveRequest): {
		target: Element | null
		fingerprint: string
	} {
		const target = this.resolveActionTarget(active) ?? null
		if (!target) return { target, fingerprint: 'unindexed' }
		const root = this.validateRoot()
		const markers: (string | null)[] = []
		let cursor: Element | null = target
		while (cursor) {
			markers.push(cursor.getAttribute('data-page-agent-policy'))
			if (cursor === root) break
			cursor = cursor.parentElement
		}
		const anchor = target.closest('a[href]')
		const submitTarget = target.closest('button, input, form') as
			| (Element & { form?: HTMLFormElement | null })
			| null
		return {
			target,
			fingerprint: stableStringify({
				markers,
				tag: target.tagName,
				type: target.getAttribute('type'),
				href: anchor?.getAttribute('href'),
				formAction: submitTarget?.getAttribute('formaction'),
				formMethod: submitTarget?.form?.method,
				formTarget: submitTarget?.form?.target,
				childFrame:
					active.preparedAction?.kind === 'child-frame'
						? {
								id: active.preparedAction.targetContext.frameId,
								origin: active.preparedAction.targetContext.origin,
								src: active.preparedAction.targetContext.iframe.getAttribute('src'),
								childTarget: active.preparedAction.targetContext.childTarget,
							}
						: undefined,
			}),
		}
	}

	private recordPolicyTarget(
		active: ActiveRequest,
		decision: 'allow' | 'deny' | 'approval_required'
	): 'allow' | 'deny' | 'approval_required' {
		const snapshot = this.captureActionTarget(active)
		active.policyTarget = snapshot.target
		active.policyTargetFingerprint = snapshot.fingerprint
		return decision
	}

	private assertPolicyTargetUnchanged(active: ActiveRequest): void {
		const snapshot = this.captureActionTarget(active)
		if (
			snapshot.target !== active.policyTarget ||
			snapshot.fingerprint !== active.policyTargetFingerprint
		)
			throw asError(
				ParentControllerErrorCode.STALE_TREE,
				'Action target changed during policy evaluation'
			)
	}

	private async awaitApproval(active: ActiveRequest): Promise<boolean> {
		const connection = this.connection
		if (!connection) return false
		const approvalId = secureParentControllerId('approval')
		const hash = await payloadHash(active.message.payload)
		if (
			active.abortController.signal.aborted ||
			this.connection !== connection ||
			this.connectionGeneration !== active.generation ||
			Date.now() / 1000 >= connection.expiresAt
		)
			return false
		return new Promise<boolean>((resolve) => {
			const waiter: ApprovalWaiter = {
				approvalId,
				request: active,
				hash,
				expiresAt: Date.now() + this.approvalTimeoutMs,
				resolve,
				timer: setTimeout(() => {
					active.approvalTimedOut = true
					this.consumeApproval(waiter)
					resolve(false)
				}, this.approvalTimeoutMs),
				used: false,
			}
			active.approval = waiter
			this.approvals.set(approvalId, waiter)
			emitParentControllerLog(this.logger, {
				event: 'approval_required',
				sessionId: connection.sessionId,
				requestId: active.message.requestId,
				method: active.message.method,
				capability: active.message.capability,
			})
			const sent = this.postPort({
				protocol: PARENT_CONTROLLER_PROTOCOL,
				version: PARENT_CONTROLLER_PROTOCOL_VERSION,
				type: 'approval-required',
				policyId: connection.policyId,
				sessionId: connection.sessionId,
				hostInstanceId: connection.hostInstanceId,
				frameInstanceId: connection.frameInstanceId,
				treeRevision: connection.treeRevision,
				requestId: active.message.requestId,
				approvalId,
				method: active.message.method,
				capability: active.message.capability,
				payload: this.approvalSummary(
					active.message.method,
					active.message.payload,
					active.approvalTarget ?? undefined,
					active.preparedAction
				),
				reason: active.policyReason ?? 'Confirmation is required for this action.',
			})
			if (!sent) {
				this.consumeApproval(waiter)
				resolve(false)
			}
		})
	}

	/** Do not echo input/select values to the child approval UI. */
	private approvalSummary(
		method: ParentControllerMethod,
		payload: unknown,
		target?: Element,
		prepared?: ParentFrameProxyPreparedAction
	): unknown {
		if (!payload || typeof payload !== 'object') return undefined
		const value = payload as Record<string, unknown>
		const targetSummary =
			prepared?.kind === 'child-frame'
				? prepared.targetContext.childTarget
				: this.approvalTargetSummary(target)
		const frameSummary =
			prepared?.kind === 'child-frame'
				? { id: prepared.targetContext.frameId, origin: prepared.targetContext.origin }
				: undefined
		if (method === 'inputText')
			return {
				index: value.index,
				textLength: typeof value.text === 'string' ? value.text.length : 0,
				target: targetSummary,
				frame: frameSummary,
			}
		if (method === 'selectOption')
			return {
				index: value.index,
				optionLength: typeof value.optionText === 'string' ? value.optionText.length : 0,
				target: targetSummary,
				frame: frameSummary,
			}
		if (method === 'clickElement')
			return { index: value.index, target: targetSummary, frame: frameSummary }
		if (method === 'scroll' || method === 'scrollHorizontally')
			return {
				index: value.index,
				direction: value.down ?? value.right,
				pixels: value.pixels,
				numPages: value.numPages,
				target: targetSummary,
				frame: frameSummary,
			}
		return undefined
	}

	private approvalTargetSummary(
		target?: Element
	): { tag: string; role?: string; label?: string } | undefined {
		if (!target) return undefined
		const label =
			target.getAttribute('aria-label') ??
			target.getAttribute('title') ??
			target.textContent?.trim() ??
			''
		return {
			tag: target.tagName.toLowerCase(),
			role: target.getAttribute('role') ?? undefined,
			label: label ? sanitizeParentControllerText(label).slice(0, 160) : undefined,
		}
	}

	private consumeApproval(waiter: ApprovalWaiter): void {
		if (waiter.used) return
		waiter.used = true
		clearTimeout(waiter.timer)
		this.approvals.delete(waiter.approvalId)
		if (waiter.request.approval === waiter) waiter.request.approval = undefined
	}

	private handleApprovalResponse(
		message: Extract<ParentControllerPortMessage, { type: 'approval-response' }>
	): void {
		const waiter = this.approvals.get(message.approvalId)
		if (
			!waiter ||
			waiter.used ||
			waiter.request.message.requestId !== message.requestId ||
			waiter.request.message.sessionId !== message.sessionId
		)
			return
		this.consumeApproval(waiter)
		emitParentControllerLog(this.logger, {
			event: 'approval_result',
			sessionId: message.sessionId,
			requestId: message.requestId,
			method: waiter.request.message.method,
			capability: waiter.request.message.capability,
			code: message.approved ? 'approved' : 'denied',
		})
		if (
			Date.now() > waiter.expiresAt ||
			!message.approved ||
			waiter.request.abortController.signal.aborted
		) {
			waiter.resolve(false)
			return
		}
		const connection = this.connection
		if (
			!connection ||
			connection.treeRevision !== waiter.request.message.treeRevision ||
			!connection.state ||
			connection.state.treeRevision !== waiter.request.message.treeRevision
		) {
			waiter.resolve(false)
			return
		}
		try {
			this.resolveActionTarget(waiter.request)
		} catch {
			waiter.resolve(false)
			return
		}
		void payloadHash(waiter.request.message.payload)
			.then((hash) => waiter.resolve(hash === waiter.hash))
			.catch(() => waiter.resolve(false))
	}

	private async invoke(
		method: ParentControllerMethod,
		payload: unknown,
		signal: AbortSignal,
		connection: HostConnection,
		active?: ActiveRequest
	): Promise<unknown> {
		const context: PageControllerCallContext = { signal }
		const controller = this.controller
		if (
			active?.preparedAction &&
			this.controller instanceof ParentFrameProxyController &&
			isActionMethod(method)
		)
			return this.controller.commitPreparedAction(
				active.preparedAction,
				active.approved ?? false,
				context
			)
		switch (method) {
			case 'getCurrentUrl':
				return sanitizeParentControllerUrl(await controller.getCurrentUrl(context))
			case 'getLastUpdateTime':
				return controller.getLastUpdateTime(context)
			case 'getBrowserState':
				return this.observeState(context, connection)
			case 'updateTree': {
				return (await this.observeState(context, connection)).content
			}
			case 'cleanUpHighlights':
				await controller.cleanUpHighlights()
				return undefined
			case 'clickElement':
				return controller.clickElement((payload as { index: number }).index, context)
			case 'inputText':
				return controller.inputText(
					(payload as { index: number }).index,
					(payload as { text: string }).text,
					context
				)
			case 'selectOption':
				return controller.selectOption(
					(payload as { index: number }).index,
					(payload as { optionText: string }).optionText,
					context
				)
			case 'scroll':
				return controller.scroll(payload as import('../PageController').ScrollOptions, context)
			case 'scrollHorizontally':
				return controller.scrollHorizontally(
					payload as import('../PageController').HorizontalScrollOptions,
					context
				)
			case 'showMask':
				if (this.connection !== connection) return undefined
				this.setFeedbackRequested(true)
				return undefined
			case 'hideMask':
				if (this.connection !== connection) return undefined
				this.setFeedbackRequested(false)
				return undefined
			default:
				throw asError(ParentControllerErrorCode.UNSUPPORTED_METHOD, 'Unsupported method')
		}
	}

	private async observeState(
		context: PageControllerCallContext,
		connection: HostConnection
	): Promise<IndexedBrowserState> {
		const raw = await this.controller.getBrowserState(context)
		if (!isIndexedState(raw))
			throw asError(
				ParentControllerErrorCode.INVALID_MESSAGE,
				'Controller returned invalid indexed state'
			)
		const sanitized = sanitizeParentControllerState(raw)
		const transformedValue = this.transformState
			? await waitForAbort(
					Promise.resolve().then(() => this.transformState!(sanitized)),
					context.signal ?? new AbortController().signal
				)
			: sanitized
		const transformed = sanitizeParentControllerState(transformedValue)
		if (
			!isIndexedState(transformed) ||
			transformed.treeRevision !== sanitized.treeRevision ||
			!sameIndices(transformed.indices, sanitized.indices)
		)
			throw asError(
				ParentControllerErrorCode.INVALID_MESSAGE,
				'Transformed state metadata is invalid'
			)
		if (this.connection === connection) {
			connection.treeRevision = transformed.treeRevision
			connection.state = transformed
		}
		return transformed
	}

	private sendSuccessForConnection(
		connection: HostConnection,
		requestId: string,
		method: ParentControllerMethod,
		result: unknown
	): void {
		const safeResult =
			isActionMethod(method) && result && typeof result === 'object'
				? {
						success: (result as PageActionResult).success,
						message: sanitizeParentControllerText((result as PageActionResult).message),
					}
				: result
		if (this.connection !== connection || !isParentControllerResult(method, safeResult)) {
			this.sendErrorForConnection(
				connection,
				requestId,
				method,
				ParentControllerErrorCode.INTERNAL_ERROR
			)
			return
		}
		this.postPort({
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'response',
			policyId: connection.policyId,
			sessionId: connection.sessionId,
			hostInstanceId: connection.hostInstanceId,
			frameInstanceId: connection.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId,
			method,
			ok: true,
			result: safeResult,
		})
	}

	private sendError(requestId: string, method: string, code: ParentControllerErrorCode): void {
		const connection = this.connection
		if (!connection) return
		this.sendErrorForConnection(connection, requestId, method, code)
	}

	private sendErrorForConnection(
		connection: HostConnection,
		requestId: string,
		method: string,
		code: ParentControllerErrorCode
	): void {
		if (this.connection !== connection) return
		this.postPort({
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'response',
			policyId: connection.policyId,
			sessionId: connection.sessionId,
			hostInstanceId: connection.hostInstanceId,
			frameInstanceId: connection.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId,
			method,
			ok: false,
			error: { code, message: safeErrorMessage(code) },
		})
		emitParentControllerLog(this.logger, {
			event: 'error',
			code,
			sessionId: connection.sessionId,
			requestId,
			method,
		})
	}

	private cancelRequest(
		requestId: string,
		method: ParentControllerMethod,
		capability: ParentControllerCapability
	): void {
		const active = this.requests.get(requestId)
		if (!active || active.message.method !== method || active.message.capability !== capability)
			return
		active.abortController.abort()
		const approval = active.approval
		if (approval) {
			this.consumeApproval(approval)
			approval.resolve(false)
		}
	}

	private resetConnection(): void {
		const previousExecutionTail = this.executionTail
		const immediateCleanup = this.cleanupVisualState()
		if (this.controller instanceof ParentFrameProxyController)
			this.controller.clearAuthorizedFrames()
		// A request already executing may ignore its abort signal and finish after
		// reset. Run a second cleanup after that request tail so late observation
		// highlights cannot survive into the next session. Requests accepted by a
		// replacement connection are chained after this barrier.
		this.executionTail = Promise.allSettled([previousExecutionTail, immediateCleanup])
			.then(() => this.cleanupVisualState())
			.catch(() => undefined)
		this.connectionGeneration += 1
		if (this.connectionExpiryTimer) clearTimeout(this.connectionExpiryTimer)
		this.connectionExpiryTimer = null
		for (const active of this.requests.values()) {
			if (active.timer) clearTimeout(active.timer)
			active.abortController.abort()
		}
		for (const waiter of this.approvals.values()) {
			this.consumeApproval(waiter)
			waiter.resolve(false)
		}
		this.requests.clear()
		this.approvals.clear()
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
		this.connection = null
	}

	private emitLog(entry: Parameters<typeof emitParentControllerLog>[1]): void {
		emitParentControllerLog(this.logger, entry)
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		this.started = false
		this.hostWindow.removeEventListener('message', this.windowMessageListener)
		this.hostWindow.removeEventListener('popstate', this.navigationListener)
		this.hostWindow.removeEventListener('hashchange', this.navigationListener)
		this.hostWindow.removeEventListener('pagehide', this.pagehideListener)
		this.iframe.removeEventListener('load', this.iframeLoadListener)
		this.navigationApi?.removeEventListener('navigate', this.navigationApiListener)
		this.navigationApi = null
		this.offerGeneration += 1
		this.offerAbortController?.abort()
		this.offerAbortController = null
		this.resetConnection()
		if (this.controller instanceof ParentFrameProxyController) this.controller.dispose()
		else if (this.disposeController) this.controller.dispose()
		this.visualCursor?.dispose()
		this.visualCursor = null
		if (this.feedback) {
			this.feedback.remove()
			this.feedback = null
		}
		if (this.addedNotInteractive) this.iframe.removeAttribute('data-page-agent-not-interactive')
		else if (this.previousNotInteractive !== null)
			this.iframe.setAttribute('data-page-agent-not-interactive', this.previousNotInteractive)
		this.offer = null
		this.offerFrameContext = null
		this.offerChildFrameGrants = []
		this.activated = false
		this.seenHandshakeRequestIds.clear()
		this.usedPolicyIds.clear()
		this.emitLog({ event: 'disposed' })
		this.dispatchEvent(new Event('dispose'))
	}
}

export function startParentPageControllerHost(
	options: ParentPageControllerHostOptions
): ParentPageControllerHost {
	const host = new ParentPageControllerHost(options)
	host.start()
	return host
}

export type { ParentPageControllerHostOptions }
