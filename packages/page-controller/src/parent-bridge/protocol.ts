/**
 * Reverse parent-controller bridge wire protocol.
 *
 * The parent page signs and sends an offer first. The child iframe validates
 * the offer through its application-owned authorizer and sends an accept
 * acknowledgement. The parent then creates the MessageChannel and transfers
 * a port with a separate connect message. This is intentionally separate from
 * `page-agent:iframe-bridge`, whose handshake direction is the opposite.
 */
export const PARENT_CONTROLLER_PROTOCOL = 'page-agent:parent-controller' as const
export const PARENT_CONTROLLER_PROTOCOL_VERSION = 1 as const

/** Hard limits protect both window messages and MessagePort payloads. */
export const PARENT_CONTROLLER_MAX_MESSAGE_BYTES = 64 * 1024
export const PARENT_CONTROLLER_MAX_TEXT_LENGTH = 16 * 1024
export const PARENT_CONTROLLER_MAX_POLICY_LENGTH = 16 * 1024
export const PARENT_CONTROLLER_MAX_REASON_LENGTH = 1024

export const ParentControllerErrorCode = {
	INVALID_MESSAGE: 'INVALID_MESSAGE',
	PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
	SESSION_MISMATCH: 'SESSION_MISMATCH',
	POLICY_REPLAYED: 'POLICY_REPLAYED',
	POLICY_EXPIRED: 'POLICY_EXPIRED',
	HOST_MISMATCH: 'HOST_MISMATCH',
	FRAME_MISMATCH: 'FRAME_MISMATCH',
	STALE_TREE: 'STALE_TREE',
	ROOT_UNAVAILABLE: 'ROOT_UNAVAILABLE',
	UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
	CAPABILITY_DENIED: 'CAPABILITY_DENIED',
	INVALID_PAYLOAD: 'INVALID_PAYLOAD',
	ABORTED: 'ABORTED',
	DISPOSED: 'DISPOSED',
	CONNECTION_CLOSED: 'CONNECTION_CLOSED',
	TIMEOUT: 'TIMEOUT',
	OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN',
	APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
	APPROVAL_DENIED: 'APPROVAL_DENIED',
	APPROVAL_TIMEOUT: 'APPROVAL_TIMEOUT',
	EMBED_POLICY_DENIED: 'EMBED_POLICY_DENIED',
	INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type ParentControllerErrorCode =
	(typeof ParentControllerErrorCode)[keyof typeof ParentControllerErrorCode]

export const PARENT_CONTROLLER_CAPABILITIES = [
	'observe',
	'click',
	'input',
	'select',
	'scroll',
	'scrollHorizontally',
	'cleanup',
	'visual',
] as const

export type ParentControllerCapability = (typeof PARENT_CONTROLLER_CAPABILITIES)[number]

/** `executeJavascript` is deliberately absent. */
export const PARENT_CONTROLLER_METHODS = [
	'getCurrentUrl',
	'getLastUpdateTime',
	'getBrowserState',
	'updateTree',
	'cleanUpHighlights',
	'clickElement',
	'inputText',
	'selectOption',
	'scroll',
	'scrollHorizontally',
	'showMask',
	'hideMask',
] as const

export type ParentControllerMethod = (typeof PARENT_CONTROLLER_METHODS)[number]

export interface ParentControllerSerializedError {
	code: ParentControllerErrorCode
	message: string
}

export interface ParentControllerMessageBase {
	protocol: typeof PARENT_CONTROLLER_PROTOCOL
	version: typeof PARENT_CONTROLLER_PROTOCOL_VERSION
}

/** Browser facts visible to the parent; this is not a signed policy. */
export interface ParentFrameContext {
	parentOrigin: string
	assistantOrigin: string
	directChild: boolean
	sandbox: string[]
	allowScripts: boolean
	allowSameOrigin: boolean
}

/** Claims returned by an application-owned ES256/JWKS policy verifier. */
export interface VerifiedEmbedPolicyClaims {
	jti: string
	tenant: string
	user: string
	targetId: string
	scopeId: string
	parentOrigin: string
	assistantOrigin: string
	cap: string[]
	protocolVersionMin: number
	protocolVersionMax: number
	nbf: number
	exp: number
	[key: string]: unknown
}

/** Parent sends this offer before the child sends any bridge message. */
export interface ParentControllerOfferMessage extends ParentControllerMessageBase {
	type: 'offer'
	policy: string
	policyId: string
	challenge: string
	sessionId: string
	hostInstanceId: string
	frameInstanceId: string
	assistantOrigin: string
	capabilities: ParentControllerCapability[]
	frameContext: ParentFrameContext
}

/** Child sends this only after its authorizeOffer callback accepts the offer. */
export interface ParentControllerAcceptMessage extends ParentControllerMessageBase {
	type: 'accept'
	policyId: string
	challenge: string
	sessionId: string
	hostInstanceId: string
	frameInstanceId: string
	capabilities: ParentControllerCapability[]
}

/** Parent transfers the MessagePort only after validating an accept. */
export interface ParentControllerConnectMessage extends ParentControllerMessageBase {
	type: 'connect'
	policyId: string
	challenge: string
	sessionId: string
	hostInstanceId: string
	frameInstanceId: string
	capabilities: ParentControllerCapability[]
	frameContext: ParentFrameContext
}

export interface ParentControllerPortMessageBase extends ParentControllerMessageBase {
	policyId: string
	sessionId: string
	hostInstanceId: string
	frameInstanceId: string
	treeRevision: number
}

export interface ParentControllerConnectedMessage extends ParentControllerPortMessageBase {
	type: 'connected'
	capabilities: ParentControllerCapability[]
	frameContext: ParentFrameContext
}

export interface ParentControllerRequestMessage extends ParentControllerPortMessageBase {
	type: 'request'
	requestId: string
	method: string
	capability: string
	payload: unknown
}

export interface ParentControllerStartedMessage extends ParentControllerPortMessageBase {
	type: 'started'
	requestId: string
	method: ParentControllerMethod
	capability: ParentControllerCapability
}

export interface ParentControllerApprovalRequiredMessage extends ParentControllerPortMessageBase {
	type: 'approval-required'
	requestId: string
	approvalId: string
	method: ParentControllerMethod
	capability: ParentControllerCapability
	payload: unknown
	reason?: string
}

export interface ParentControllerApprovalResponseMessage extends ParentControllerPortMessageBase {
	type: 'approval-response'
	requestId: string
	approvalId: string
	approved: boolean
	reason?: string
}

export interface ParentControllerSuccessResponseMessage extends ParentControllerPortMessageBase {
	type: 'response'
	requestId: string
	method: string
	ok: true
	result: unknown
}

export interface ParentControllerErrorResponseMessage extends ParentControllerPortMessageBase {
	type: 'response'
	requestId: string
	method: string
	ok: false
	error: ParentControllerSerializedError
}

export type ParentControllerResponseMessage =
	| ParentControllerSuccessResponseMessage
	| ParentControllerErrorResponseMessage

export interface ParentControllerCancelMessage extends ParentControllerPortMessageBase {
	type: 'cancel'
	requestId: string
	method: string
	capability: string
}

export type ParentControllerWindowMessage =
	| ParentControllerOfferMessage
	| ParentControllerAcceptMessage
	| ParentControllerConnectMessage

export type ParentControllerPortMessage =
	| ParentControllerConnectedMessage
	| ParentControllerRequestMessage
	| ParentControllerStartedMessage
	| ParentControllerApprovalRequiredMessage
	| ParentControllerApprovalResponseMessage
	| ParentControllerResponseMessage
	| ParentControllerCancelMessage

const capabilities = new Set<string>(PARENT_CONTROLLER_CAPABILITIES)
const methods = new Set<string>(PARENT_CONTROLLER_METHODS)
const errorCodes = new Set<string>(Object.values(ParentControllerErrorCode))

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys)
	return Object.keys(value).every((key) => allowed.has(key))
}

export function isIdentifier(value: unknown, maxLength = 256): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

export function isTreeRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function hasProtocol(value: Record<string, unknown>): boolean {
	return (
		value.protocol === PARENT_CONTROLLER_PROTOCOL &&
		value.version === PARENT_CONTROLLER_PROTOCOL_VERSION
	)
}

function isCapabilityList(value: unknown): value is ParentControllerCapability[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.length <= PARENT_CONTROLLER_CAPABILITIES.length &&
		new Set(value).size === value.length &&
		value.every((item) => typeof item === 'string' && capabilities.has(item))
	)
}

function isPolicyContext(value: unknown): value is ParentFrameContext {
	if (!isRecord(value)) return false
	if (
		!hasOnlyKeys(value, [
			'parentOrigin',
			'assistantOrigin',
			'directChild',
			'sandbox',
			'allowScripts',
			'allowSameOrigin',
		])
	)
		return false
	if (
		!isIdentifier(value.parentOrigin) ||
		!isIdentifier(value.assistantOrigin) ||
		typeof value.directChild !== 'boolean' ||
		typeof value.allowScripts !== 'boolean' ||
		typeof value.allowSameOrigin !== 'boolean'
	) {
		return false
	}
	return (
		Array.isArray(value.sandbox) &&
		value.sandbox.length <= 64 &&
		value.sandbox.every((token) => isIdentifier(token, 64))
	)
}

export function isParentControllerOfferMessage(
	value: unknown
): value is ParentControllerOfferMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'policy',
			'policyId',
			'challenge',
			'sessionId',
			'hostInstanceId',
			'frameInstanceId',
			'assistantOrigin',
			'capabilities',
			'frameContext',
		]) &&
		hasProtocol(value) &&
		value.type === 'offer' &&
		isIdentifier(value.policy, PARENT_CONTROLLER_MAX_POLICY_LENGTH) &&
		isIdentifier(value.policyId) &&
		isIdentifier(value.challenge) &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.hostInstanceId) &&
		isIdentifier(value.frameInstanceId) &&
		isIdentifier(value.assistantOrigin) &&
		isCapabilityList(value.capabilities) &&
		isPolicyContext(value.frameContext) &&
		isParentControllerMessageSizeAllowed(value)
	)
}

export function isParentControllerAcceptMessage(
	value: unknown
): value is ParentControllerAcceptMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'policyId',
			'challenge',
			'sessionId',
			'hostInstanceId',
			'frameInstanceId',
			'capabilities',
		]) &&
		hasProtocol(value) &&
		value.type === 'accept' &&
		isIdentifier(value.policyId) &&
		isIdentifier(value.challenge) &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.hostInstanceId) &&
		isIdentifier(value.frameInstanceId) &&
		isCapabilityList(value.capabilities) &&
		isParentControllerMessageSizeAllowed(value)
	)
}

export function isParentControllerConnectMessage(
	value: unknown
): value is ParentControllerConnectMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'policyId',
			'challenge',
			'sessionId',
			'hostInstanceId',
			'frameInstanceId',
			'capabilities',
			'frameContext',
		]) &&
		hasProtocol(value) &&
		value.type === 'connect' &&
		isIdentifier(value.policyId) &&
		isIdentifier(value.challenge) &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.hostInstanceId) &&
		isIdentifier(value.frameInstanceId) &&
		isCapabilityList(value.capabilities) &&
		isPolicyContext(value.frameContext) &&
		isParentControllerMessageSizeAllowed(value)
	)
}

function isPortBase(value: Record<string, unknown>): boolean {
	return (
		hasProtocol(value) &&
		isIdentifier(value.policyId) &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.hostInstanceId) &&
		isIdentifier(value.frameInstanceId) &&
		isTreeRevision(value.treeRevision)
	)
}

export function isParentControllerPortMessageBase(
	value: unknown
): value is ParentControllerPortMessageBase {
	return isRecord(value) && isPortBase(value)
}

function isRequestEnvelope(value: Record<string, unknown>): boolean {
	return (
		isPortBase(value) &&
		isIdentifier(value.requestId) &&
		isIdentifier(value.method) &&
		isIdentifier(value.capability, 64)
	)
}

export function isParentControllerRequestMessage(
	value: unknown
): value is ParentControllerRequestMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'policyId',
			'sessionId',
			'hostInstanceId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
			'capability',
			'payload',
		]) &&
		isRequestEnvelope(value) &&
		value.type === 'request' &&
		Object.prototype.hasOwnProperty.call(value, 'payload') &&
		isParentControllerMessageSizeAllowed(value)
	)
}

export function isParentControllerPortMessage(
	value: unknown
): value is ParentControllerPortMessage {
	if (!isRecord(value) || !isPortBase(value)) return false

	if (value.type === 'connected') {
		return (
			hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'capabilities',
				'frameContext',
			]) &&
			isCapabilityList(value.capabilities) &&
			isPolicyContext(value.frameContext) &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	if (value.type === 'request') {
		return (
			hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'method',
				'capability',
				'payload',
			]) &&
			value.type === 'request' &&
			isRequestEnvelope(value) &&
			Object.prototype.hasOwnProperty.call(value, 'payload') &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	if (value.type === 'started') {
		return (
			hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'method',
				'capability',
			]) &&
			isIdentifier(value.requestId) &&
			isKnownMethod(value.method) &&
			isCapability(value.capability) &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	if (value.type === 'approval-required') {
		return (
			hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'approvalId',
				'method',
				'capability',
				'payload',
				'reason',
			]) &&
			isIdentifier(value.requestId) &&
			isIdentifier(value.approvalId) &&
			isKnownMethod(value.method) &&
			isCapability(value.capability) &&
			isApprovalSummary(value.method, value.payload) &&
			(value.reason === undefined ||
				(typeof value.reason === 'string' &&
					value.reason.length <= PARENT_CONTROLLER_MAX_REASON_LENGTH)) &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	if (value.type === 'approval-response') {
		return (
			hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'approvalId',
				'approved',
				'reason',
			]) &&
			isIdentifier(value.requestId) &&
			isIdentifier(value.approvalId) &&
			typeof value.approved === 'boolean' &&
			(value.reason === undefined ||
				(typeof value.reason === 'string' &&
					value.reason.length <= PARENT_CONTROLLER_MAX_REASON_LENGTH)) &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	if (value.type === 'response') {
		if (
			!hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'method',
				'ok',
				'result',
				'error',
			]) ||
			!isIdentifier(value.requestId) ||
			typeof value.method !== 'string' ||
			value.method.length === 0 ||
			value.method.length > 256 ||
			typeof value.ok !== 'boolean'
		) {
			return false
		}
		if (value.ok) {
			return (
				Object.prototype.hasOwnProperty.call(value, 'result') &&
				value.error === undefined &&
				isParentControllerResult(value.method, value.result) &&
				isParentControllerMessageSizeAllowed(value)
			)
		}
		return (
			isRecord(value.error) &&
			hasOnlyKeys(value.error, ['code', 'message']) &&
			Object.values(ParentControllerErrorCode).includes(
				value.error.code as ParentControllerErrorCode
			) &&
			typeof value.error.message === 'string' &&
			value.error.message.length <= PARENT_CONTROLLER_MAX_REASON_LENGTH * 4 &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	if (value.type === 'cancel') {
		return (
			hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'policyId',
				'sessionId',
				'hostInstanceId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'method',
				'capability',
			]) &&
			isIdentifier(value.requestId) &&
			isIdentifier(value.method) &&
			isIdentifier(value.capability, 64) &&
			isParentControllerMessageSizeAllowed(value)
		)
	}
	return false
}

export function isKnownMethod(value: unknown): value is ParentControllerMethod {
	return (
		typeof value === 'string' && (PARENT_CONTROLLER_METHODS as readonly string[]).includes(value)
	)
}

function isIndexedBrowserState(value: unknown): boolean {
	if (!isRecord(value)) return false
	if (
		!hasOnlyKeys(value, [
			'url',
			'title',
			'header',
			'content',
			'footer',
			'treeRevision',
			'indices',
		]) ||
		typeof value.url !== 'string' ||
		typeof value.title !== 'string' ||
		typeof value.header !== 'string' ||
		typeof value.content !== 'string' ||
		typeof value.footer !== 'string' ||
		!isTreeRevision(value.treeRevision) ||
		!Array.isArray(value.indices) ||
		new Set(value.indices).size !== value.indices.length ||
		!value.indices.every((index) => isNonNegativeSafeInteger(index))
	)
		return false
	return (
		value.url.length <= PARENT_CONTROLLER_MAX_TEXT_LENGTH &&
		value.title.length <= PARENT_CONTROLLER_MAX_TEXT_LENGTH &&
		value.header.length <= PARENT_CONTROLLER_MAX_TEXT_LENGTH &&
		value.content.length <= PARENT_CONTROLLER_MAX_MESSAGE_BYTES &&
		value.footer.length <= PARENT_CONTROLLER_MAX_TEXT_LENGTH
	)
}

/** Strict method-specific result validation for success responses. */
export function isParentControllerResult(method: string, value: unknown): boolean {
	if (method === 'getCurrentUrl' || method === 'updateTree')
		return typeof value === 'string' && value.length <= PARENT_CONTROLLER_MAX_MESSAGE_BYTES
	if (method === 'getLastUpdateTime') return typeof value === 'number' && Number.isFinite(value)
	if (method === 'getBrowserState') return isIndexedBrowserState(value)
	if (method === 'cleanUpHighlights' || method === 'showMask' || method === 'hideMask')
		return value === undefined || value === null
	if (
		method === 'clickElement' ||
		method === 'inputText' ||
		method === 'selectOption' ||
		method === 'scroll' ||
		method === 'scrollHorizontally'
	) {
		return (
			isRecord(value) &&
			hasOnlyKeys(value, ['success', 'message']) &&
			typeof value.success === 'boolean' &&
			typeof value.message === 'string' &&
			value.message.length <= PARENT_CONTROLLER_MAX_REASON_LENGTH * 4
		)
	}
	return false
}

export function isCapability(value: unknown): value is ParentControllerCapability {
	return (
		typeof value === 'string' &&
		(PARENT_CONTROLLER_CAPABILITIES as readonly string[]).includes(value)
	)
}

export function isParentControllerMessageSizeAllowed(value: unknown): boolean {
	try {
		const encoded = JSON.stringify(value)
		if (encoded === undefined) return true
		return new TextEncoder().encode(encoded).byteLength <= PARENT_CONTROLLER_MAX_MESSAGE_BYTES
	} catch {
		return false
	}
}

function isSafePayload(value: unknown): boolean {
	return isParentControllerMessageSizeAllowed(value)
}

function isApprovalTargetSummary(value: unknown): boolean {
	return (
		value === undefined ||
		(isRecord(value) &&
			hasOnlyKeys(value, ['tag', 'role', 'label']) &&
			isIdentifier(value.tag, 64) &&
			(value.role === undefined || isIdentifier(value.role, 128)) &&
			(value.label === undefined || (typeof value.label === 'string' && value.label.length <= 160)))
	)
}

function isApprovalSummary(method: ParentControllerMethod, value: unknown): boolean {
	if (!isRecord(value) || !isSafePayload(value)) return false
	if (method === 'clickElement') {
		return (
			hasOnlyKeys(value, ['index', 'target']) &&
			isNonNegativeSafeInteger(value.index) &&
			isApprovalTargetSummary(value.target)
		)
	}
	if (method === 'inputText') {
		return (
			hasOnlyKeys(value, ['index', 'textLength', 'target']) &&
			isNonNegativeSafeInteger(value.index) &&
			isNonNegativeSafeInteger(value.textLength) &&
			value.textLength <= PARENT_CONTROLLER_MAX_TEXT_LENGTH &&
			isApprovalTargetSummary(value.target)
		)
	}
	if (method === 'selectOption') {
		return (
			hasOnlyKeys(value, ['index', 'optionLength', 'target']) &&
			isNonNegativeSafeInteger(value.index) &&
			isNonNegativeSafeInteger(value.optionLength) &&
			value.optionLength <= PARENT_CONTROLLER_MAX_TEXT_LENGTH &&
			isApprovalTargetSummary(value.target)
		)
	}
	if (method === 'scroll' || method === 'scrollHorizontally') {
		return (
			hasOnlyKeys(value, ['index', 'direction', 'pixels', 'numPages', 'target']) &&
			(value.index === undefined || isNonNegativeSafeInteger(value.index)) &&
			(value.direction === undefined || typeof value.direction === 'boolean') &&
			(value.pixels === undefined ||
				(typeof value.pixels === 'number' &&
					Number.isFinite(value.pixels) &&
					value.pixels >= 0 &&
					value.pixels <= 1e7)) &&
			(value.numPages === undefined ||
				(typeof value.numPages === 'number' &&
					Number.isFinite(value.numPages) &&
					value.numPages >= 0 &&
					value.numPages <= 100)) &&
			isApprovalTargetSummary(value.target)
		)
	}
	return false
}

/** Validate a method payload before dispatching it to a controller. */
export function isParentControllerPayload(method: ParentControllerMethod, value: unknown): boolean {
	const record = value === undefined ? undefined : isRecord(value) ? value : null
	if (
		method === 'getCurrentUrl' ||
		method === 'getLastUpdateTime' ||
		method === 'getBrowserState' ||
		method === 'updateTree' ||
		method === 'cleanUpHighlights' ||
		method === 'showMask' ||
		method === 'hideMask'
	) {
		return (
			value === undefined ||
			value === null ||
			(record !== null && record !== undefined && Object.keys(record).length === 0)
		)
	}
	if (method === 'clickElement') {
		return (
			record !== null &&
			record !== undefined &&
			hasOnlyKeys(record, ['index']) &&
			isNonNegativeSafeInteger(record.index)
		)
	}
	if (method === 'inputText') {
		return (
			record !== null &&
			record !== undefined &&
			hasOnlyKeys(record, ['index', 'text']) &&
			isNonNegativeSafeInteger(record.index) &&
			typeof record.text === 'string' &&
			record.text.length <= PARENT_CONTROLLER_MAX_TEXT_LENGTH
		)
	}
	if (method === 'selectOption') {
		return (
			record !== null &&
			record !== undefined &&
			hasOnlyKeys(record, ['index', 'optionText']) &&
			isNonNegativeSafeInteger(record.index) &&
			typeof record.optionText === 'string' &&
			record.optionText.length <= PARENT_CONTROLLER_MAX_TEXT_LENGTH
		)
	}
	if (method === 'scroll') return isScrollPayload(record)
	if (method === 'scrollHorizontally') return isHorizontalScrollPayload(record)
	return false
}

function isScrollPayload(value: Record<string, unknown> | null | undefined): boolean {
	if (!value || !hasOnlyKeys(value, ['down', 'numPages', 'pixels', 'index'])) return false
	if (
		typeof value.down !== 'boolean' ||
		typeof value.numPages !== 'number' ||
		!Number.isFinite(value.numPages) ||
		value.numPages < 0 ||
		value.numPages > 100
	) {
		return false
	}
	if (
		value.pixels !== undefined &&
		(typeof value.pixels !== 'number' ||
			!Number.isFinite(value.pixels) ||
			value.pixels < 0 ||
			value.pixels > 1e7)
	) {
		return false
	}
	return value.index === undefined || isNonNegativeSafeInteger(value.index)
}

function isHorizontalScrollPayload(value: Record<string, unknown> | null | undefined): boolean {
	if (!value || !hasOnlyKeys(value, ['right', 'pixels', 'index'])) return false
	if (
		typeof value.right !== 'boolean' ||
		typeof value.pixels !== 'number' ||
		!Number.isFinite(value.pixels) ||
		value.pixels < 0 ||
		value.pixels > 1e7
	) {
		return false
	}
	return value.index === undefined || isNonNegativeSafeInteger(value.index)
}
