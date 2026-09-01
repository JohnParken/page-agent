import type { DomRoot } from '../dom'
import type { FrameBridgeCapability, FrameBridgeTargetSummary } from '../iframe-bridge/protocol'
import type {
	BrowserState,
	HorizontalScrollOptions,
	IndexedBrowserState,
	IndexedPageControllerAdapter,
	PageActionResult,
	PageControllerAdapter,
	PageControllerCallContext,
	PageControllerConfig,
	ScrollOptions,
} from '../PageController'
import type { ParentControllerActiveLeaseOptions } from './active-lease'
import type {
	ParentControllerBridgeBinding,
	ParentControllerCapability,
	ParentControllerMethod,
	ParentControllerPortMessage,
	ParentControllerRequestMessage,
	ParentControllerResponseMessage,
	ParentFrameContext,
	VerifiedEmbedPolicyClaims,
} from './protocol'

/** Safe metadata only. Never add payload, state, policy text, or input text. */
export interface ParentControllerLogEntry {
	event:
		| 'handshake_request'
		| 'offer'
		| 'offer_denied'
		| 'connected'
		| 'disconnected'
		| 'request'
		| 'response'
		| 'approval_required'
		| 'approval_result'
		| 'error'
		| 'deactivated'
		| 'disposed'
	code?: string
	sessionId?: string
	requestId?: string
	method?: string
	capability?: string
	durationMs?: number
	/** Message byte length, not message content. */
	messageBytes?: number
}

export type ParentControllerLogger = (entry: ParentControllerLogEntry) => void | Promise<void>

export interface ParentControllerMessagePort {
	onmessage: ((event: MessageEvent<unknown>) => void) | null
	onmessageerror?: ((event: MessageEvent<unknown>) => void) | null
	postMessage(message: unknown): void
	start?: () => void
	close?: () => void
	addEventListener?: (type: string, listener: (event: MessageEvent<unknown>) => void) => void
	removeEventListener?: (type: string, listener: (event: MessageEvent<unknown>) => void) => void
}

export interface ParentControllerHostWindow {
	readonly document: Document
	readonly location?: Location
	readonly getComputedStyle?: (element: Element) => CSSStyleDeclaration
	readonly MessageChannel?: typeof MessageChannel
	addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void
	removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void
}

export interface ParentControllerAdapterWindow {
	readonly parent: ParentControllerTargetWindow
	readonly location?: Location
	readonly MessageChannel?: typeof MessageChannel
	addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void
	removeEventListener(type: string, listener: (event: MessageEvent<unknown>) => void): void
}

export interface ParentControllerTargetWindow {
	postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void
}

export interface ParentControllerOffer {
	readonly policy: string
	readonly policyId: string
	readonly challenge: string
	readonly sessionId: string
	readonly hostInstanceId: string
	readonly frameInstanceId: string
	readonly assistantOrigin: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly frameContext: ParentFrameContext
}

export interface AuthorizedParent<TAuthorizationContext = unknown> {
	readonly parentOrigin: string
	readonly policyId: string
	readonly capabilities: readonly ParentControllerCapability[]
	/** Optional backend/TL runtime returned by the application authorizer. */
	readonly authorizationContext?: TAuthorizationContext
}

export type ParentControllerOfferAuthorization<TAuthorizationContext = unknown> =
	| AuthorizedParent<TAuthorizationContext>
	| false
	| null
	| undefined

export type AuthorizeOffer<TAuthorizationContext = unknown> = (
	offer: ParentControllerOffer,
	actualParentOrigin: string,
	signal: AbortSignal
) =>
	| ParentControllerOfferAuthorization<TAuthorizationContext>
	| Promise<ParentControllerOfferAuthorization<TAuthorizationContext>>

export interface ParentControllerApprovalRequest {
	readonly approvalId: string
	readonly requestId: string
	readonly method: ParentControllerMethod
	readonly capability: ParentControllerCapability
	/** Sanitized method-specific summary; raw input values are never sent. */
	readonly payload: unknown
	readonly reason?: string
	readonly signal: AbortSignal
}

export interface ParentControllerApprovalDecisionDetail {
	approved: boolean
	reason?: string
}

export type ParentControllerApprovalDecision = boolean | ParentControllerApprovalDecisionDetail

export type OnApprovalRequired = (
	request: ParentControllerApprovalRequest
) => ParentControllerApprovalDecision | Promise<ParentControllerApprovalDecision>

export interface ParentControllerActionRequest {
	readonly sessionId: string
	readonly requestId: string
	readonly method: ParentControllerMethod
	readonly capability: ParentControllerCapability
	readonly payload: unknown
	/** Live parent-side target for trusted selector/business policy checks. */
	readonly target?: Element
	/** Distinguishes a parent DOM target from a cooperatively proxied child target. */
	readonly targetContext: ParentControllerActionTargetContext
	readonly origin: string
	readonly iframe: HTMLIFrameElement
	readonly policyId: string
	readonly signal: AbortSignal
}

export interface ParentControllerLocalActionTargetContext {
	readonly kind: 'local'
	readonly target?: Element
}

export interface ParentControllerChildFrameActionTargetContext {
	readonly kind: 'child-frame'
	readonly frameId: string
	readonly origin: string
	readonly iframe: HTMLIFrameElement
	readonly childTarget?: FrameBridgeTargetSummary
}

export type ParentControllerActionTargetContext =
	| ParentControllerLocalActionTargetContext
	| ParentControllerChildFrameActionTargetContext

export interface ParentControllerActionPolicyDecisionDetail {
	decision: 'allow' | 'deny' | 'approval_required'
	reason?: string
}

export type ParentControllerActionPolicyDecision =
	| boolean
	| ParentControllerActionPolicyDecisionDetail

export type ParentControllerActionPolicy = (
	request: ParentControllerActionRequest
) => ParentControllerActionPolicyDecision | Promise<ParentControllerActionPolicyDecision>

export interface ParentControllerStateContext {
	readonly sessionId: string
	readonly policyId: string
	readonly origin: string
	readonly iframe: HTMLIFrameElement
}

export type ParentControllerTransformState = (
	state: IndexedBrowserState
) => IndexedBrowserState | Promise<IndexedBrowserState>

export interface ParentControllerEmbedPolicyRequestContext extends ParentControllerBridgeBinding {
	readonly parentOrigin: string
	readonly assistantOrigin: string
	readonly scopeId: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly signal: AbortSignal
}

/**
 * The Host supplies a pre-generated handshake binding. Existing zero-argument
 * callbacks remain assignable and may ignore the context during migration.
 */
export type ParentControllerGetEmbedPolicy = (
	context: ParentControllerEmbedPolicyRequestContext
) => string | Promise<string>

export interface ParentControllerVerifyPolicyContext {
	readonly actualParentOrigin: string
	readonly assistantOrigin: string
	readonly frameContext: ParentFrameContext
	readonly signal: AbortSignal
}

export type ParentControllerVerifyEmbedPolicy = (
	policy: string,
	context: ParentControllerVerifyPolicyContext
) => VerifiedEmbedPolicyClaims | false | null | Promise<VerifiedEmbedPolicyClaims | false | null>

export interface ParentControllerChildFrameTarget {
	/** Stable identifier matched exactly against the verified childFrames claim. */
	readonly id: string
	/** Direct iframe element, or a resolver for applications that replace it on navigation. */
	readonly iframe: HTMLIFrameElement | (() => HTMLIFrameElement | null)
	/** Exact expected child origin. Wildcards and opaque origins are rejected. */
	readonly origin: string
	/** Maximum cooperative iframe-bridge capabilities this target may receive. */
	readonly capabilities: readonly FrameBridgeCapability[]
}

export interface ParentControllerChildFramesOptions {
	readonly targets: readonly ParentControllerChildFrameTarget[]
	readonly handshakeTimeoutMs?: number
	readonly requestTimeoutMs?: number
}

export interface ParentPageControllerHostOptions {
	/** Exactly one assistant iframe is bound to a host instance. */
	readonly iframe: HTMLIFrameElement
	/** Exact origin of the assistant application iframe. */
	readonly assistantOrigin: string
	/** Trusted root boundary in the parent page. Never falls back to body. */
	readonly root: DomRoot
	/** Tenant/application scope checked against verified policy claims. */
	readonly scopeId: string
	/** Capabilities exposed by this host instance. */
	readonly capabilities: readonly ParentControllerCapability[]
	/** Applied when the host constructs its scoped PageController. `root` wins. */
	readonly controllerOptions?: import('../PageController').PageControllerConfig
	readonly getEmbedPolicy: ParentControllerGetEmbedPolicy
	readonly verifyEmbedPolicy: ParentControllerVerifyEmbedPolicy
	/**
	 * `assistant-initiated` keeps start() passive until A explicitly requests a
	 * handshake. `parent-initiated` is a one-release compatibility mode.
	 */
	readonly handshakeMode?: 'assistant-initiated' | 'parent-initiated'
	/** Allow P to reconnect automatically after the first successful activation. */
	readonly autoReconnect?: boolean
	/** Required in managed ActiveLease mode. Automatic reconnect is then forbidden. */
	readonly activeLease?: ParentControllerActiveLeaseOptions
	readonly transformState?: ParentControllerTransformState
	readonly actionPolicy?: ParentControllerActionPolicy
	/** Explicit parent-brokered child iframe targets. Claims remain authoritative. */
	readonly childFrames?: ParentControllerChildFramesOptions
	readonly approvalTimeoutMs?: number
	readonly handshakeTimeoutMs?: number
	readonly requestTimeoutMs?: number
	readonly disposeController?: boolean
	/** `non-blocking` adds a status element and scoped visual cursor; `none` adds no feedback. */
	readonly visualFeedback?: 'non-blocking' | 'none'
	readonly window?: ParentControllerHostWindow
	readonly logger?: ParentControllerLogger
}

export interface ParentControllerAdapterOptions<TAuthorizationContext = unknown> {
	/** Capabilities requested by this child application. */
	readonly requestedCapabilities: readonly ParentControllerCapability[]
	readonly authorizeOffer: AuthorizeOffer<TAuthorizationContext>
	/** Accept P-initiated reconnect offers after this adapter has been activated. */
	readonly autoReconnect?: boolean
	/** Required in managed ActiveLease mode. Automatic reconnect is then forbidden. */
	readonly activeLease?: ParentControllerActiveLeaseOptions<TAuthorizationContext>
	/** Required one-use approval callback for action policy prompts. */
	readonly onApprovalRequired: OnApprovalRequired
	readonly handshakeTimeoutMs?: number
	readonly requestTimeoutMs?: number
	readonly window?: ParentControllerAdapterWindow
	readonly logger?: ParentControllerLogger
}

export interface ParentControllerConnection<TAuthorizationContext = unknown> {
	readonly policyId: string
	readonly sessionId: string
	readonly hostInstanceId: string
	readonly frameInstanceId: string
	readonly parentOrigin: string
	readonly capabilities: readonly ParentControllerCapability[]
	readonly frameContext: ParentFrameContext
	readonly authorizedParent: AuthorizedParent<TAuthorizationContext>
}

export interface ParentControllerHostHandle {
	readonly host: import('./host').ParentPageControllerHost
	readonly dispose: () => void
}

export interface ParentControllerAdapterCallContext extends PageControllerCallContext {
	signal?: AbortSignal
}

export type ParentControllerAdapterContract = IndexedPageControllerAdapter

/** Keep imports above type-only: this file must have no runtime DOM side effects. */
export type {
	ParentControllerActiveLeaseOptions,
	ParentControllerActiveLeaseCheckContext,
	ParentControllerActiveLeaseFailure,
	ParentControllerActiveLeaseFailureReason,
	ParentControllerActiveLeaseStatusProvider,
} from './active-lease'

export type {
	BrowserState,
	HorizontalScrollOptions,
	IndexedBrowserState,
	IndexedPageControllerAdapter,
	PageActionResult,
	PageControllerAdapter,
	PageControllerCallContext,
	PageControllerConfig,
	ScrollOptions,
}

export type {
	ParentControllerPortMessage,
	ParentControllerRequestMessage,
	ParentControllerResponseMessage,
}
