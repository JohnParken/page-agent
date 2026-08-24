/** Wire protocol used by the cooperative cross-origin iframe bridge. */
export const IFRAME_BRIDGE_PROTOCOL = 'page-agent:iframe-bridge'

/** Increment this value whenever a wire-level breaking change is introduced. */
export const BRIDGE_PROTOCOL_VERSION = 2

export const BridgeErrorCode = {
	INVALID_MESSAGE: 'INVALID_MESSAGE',
	PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
	SESSION_MISMATCH: 'SESSION_MISMATCH',
	FRAME_MISMATCH: 'FRAME_MISMATCH',
	STALE_TREE: 'STALE_TREE',
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
	INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const

export type BridgeErrorCode = (typeof BridgeErrorCode)[keyof typeof BridgeErrorCode]

export const FRAME_BRIDGE_CAPABILITIES = [
	'observe',
	'click',
	'input',
	'select',
	'scroll',
	'scrollHorizontally',
	'cleanup',
] as const

export type FrameBridgeCapability = (typeof FRAME_BRIDGE_CAPABILITIES)[number]

export const FRAME_BRIDGE_METHODS = [
	'getBrowserState',
	'cleanUpHighlights',
	'clickElement',
	'inputText',
	'selectOption',
	'scroll',
	'scrollHorizontally',
] as const

export type FrameBridgeMethod = (typeof FRAME_BRIDGE_METHODS)[number]

export const FRAME_BRIDGE_ACTION_METHODS = [
	'clickElement',
	'inputText',
	'selectOption',
	'scroll',
	'scrollHorizontally',
] as const

export type FrameBridgeActionMethod = (typeof FRAME_BRIDGE_ACTION_METHODS)[number]

export type FrameBridgePolicyDecision = 'allow' | 'deny' | 'approval_required'

/** Sanitized action details used for policy checks before raw input is released. */
export interface BridgeActionPayloadSummary {
	index?: number
	textLength?: number
	optionLength?: number
	down?: boolean
	right?: boolean
	numPages?: number
	pixels?: number
}

export interface FrameBridgeTargetSummary {
	tag: string
	role?: string
	label?: string
}

export interface FrameBridgePreparedAction {
	preparedActionId: string
	method: FrameBridgeActionMethod
	payloadHash: string
	decision: FrameBridgePolicyDecision
	reason?: string
	target?: FrameBridgeTargetSummary
}

export interface SerializedBridgeError {
	code: BridgeErrorCode
	message: string
}

/** Common fields included in every bridge message. */
export interface BridgeMessageBase {
	protocol: typeof IFRAME_BRIDGE_PROTOCOL
	version: typeof BRIDGE_PROTOCOL_VERSION
}

export interface BridgeDiscoverMessage extends BridgeMessageBase {
	type: 'discover'
	sessionId: string
}

export interface BridgeAvailableMessage extends BridgeMessageBase {
	type: 'available'
	sessionId: string
	frameInstanceId: string
	capabilities: FrameBridgeCapability[]
}

export interface BridgeConnectMessage extends BridgeMessageBase {
	type: 'connect'
	sessionId: string
	frameInstanceId: string
}

export interface BridgePortMessageBase extends BridgeMessageBase {
	sessionId: string
	frameInstanceId: string
	treeRevision: number
}

export interface BridgeConnectedMessage extends BridgePortMessageBase {
	type: 'connected'
	capabilities: FrameBridgeCapability[]
}

export interface BridgeRequestMessage extends BridgePortMessageBase {
	type: 'request'
	requestId: string
	method: FrameBridgeMethod
	payload: unknown
}

export interface BridgePrepareActionMessage extends BridgePortMessageBase {
	type: 'prepare-action'
	requestId: string
	method: FrameBridgeActionMethod
	payloadHash: string
	summary: BridgeActionPayloadSummary
}

export interface BridgeCommitActionMessage extends BridgePortMessageBase {
	type: 'commit-action'
	requestId: string
	method: FrameBridgeActionMethod
	preparedActionId: string
	approved: boolean
	payload: unknown
}

export interface BridgeStartedMessage extends BridgePortMessageBase {
	type: 'started'
	requestId: string
	method: FrameBridgeMethod
}

/** Visual pointer movement emitted while an authorized child action is running. */
export interface BridgePointerMoveMessage extends BridgePortMessageBase {
	type: 'pointer'
	requestId: string
	action: 'move'
	x: number
	y: number
}

/** Visual pointer click emitted while an authorized child action is running. */
export interface BridgePointerClickMessage extends BridgePortMessageBase {
	type: 'pointer'
	requestId: string
	action: 'click'
}

export type BridgePointerMessage = BridgePointerMoveMessage | BridgePointerClickMessage

export interface BridgeSuccessResponseMessage extends BridgePortMessageBase {
	type: 'response'
	requestId: string
	method: FrameBridgeMethod
	ok: true
	result: unknown
}

/**
 * Error responses may echo a method that is not part of the executable method
 * set (for example `executeJavascript`). Runtime validation still constrains
 * this to a non-empty identifier no longer than 256 characters.
 */
export interface BridgeErrorResponseMessage extends BridgePortMessageBase {
	type: 'response'
	requestId: string
	method: string
	ok: false
	error: SerializedBridgeError
}

export type BridgeResponseMessage = BridgeSuccessResponseMessage | BridgeErrorResponseMessage

export interface BridgeCancelMessage extends BridgePortMessageBase {
	type: 'cancel'
	requestId: string
	method: FrameBridgeMethod
}

export type BridgeWindowMessage =
	| BridgeDiscoverMessage
	| BridgeAvailableMessage
	| BridgeConnectMessage

export type BridgePortMessage =
	| BridgeConnectedMessage
	| BridgeRequestMessage
	| BridgePrepareActionMessage
	| BridgeCommitActionMessage
	| BridgeStartedMessage
	| BridgePointerMessage
	| BridgeResponseMessage
	| BridgeCancelMessage

const errorCodes = new Set<string>(Object.values(BridgeErrorCode))
const capabilities = new Set<string>(FRAME_BRIDGE_CAPABILITIES)
const methods = new Set<string>(FRAME_BRIDGE_METHODS)
const actionMethods = new Set<string>(FRAME_BRIDGE_ACTION_METHODS)

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const allowed = new Set(keys)
	return Object.keys(value).every((key) => allowed.has(key))
}

function isIdentifier(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256
}

function isTreeRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

function hasProtocol(value: Record<string, unknown>): boolean {
	return value.protocol === IFRAME_BRIDGE_PROTOCOL && value.version === BRIDGE_PROTOCOL_VERSION
}

function isCapabilityList(value: unknown): value is FrameBridgeCapability[] {
	return (
		Array.isArray(value) &&
		value.length <= FRAME_BRIDGE_CAPABILITIES.length &&
		new Set(value).size === value.length &&
		value.every((item) => typeof item === 'string' && capabilities.has(item))
	)
}

function isMethod(value: unknown): value is FrameBridgeMethod {
	return typeof value === 'string' && methods.has(value)
}

export function isFrameBridgeActionMethod(value: unknown): value is FrameBridgeActionMethod {
	return typeof value === 'string' && actionMethods.has(value)
}

function isPortBase(value: Record<string, unknown>): boolean {
	return (
		hasProtocol(value) &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.frameInstanceId) &&
		isTreeRevision(value.treeRevision)
	)
}

/**
 * Keep this validator deliberately small. Payload values are validated by the
 * host for the selected method; the wire-level guard only verifies that a
 * payload field is present and can safely be passed to that validator.
 */
export function isBridgePayload(value: unknown): value is Record<string, unknown> {
	return isRecord(value)
}

export function isIndexPayload(value: unknown): value is { index: number } {
	return isRecord(value) && Number.isSafeInteger(value.index) && Number(value.index) >= 0
}

export function isInputPayload(value: unknown): value is { index: number; text: string } {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.index) &&
		Number(value.index) >= 0 &&
		typeof value.text === 'string'
	)
}

export function isSelectPayload(value: unknown): value is { index: number; optionText: string } {
	return (
		isRecord(value) &&
		Number.isSafeInteger(value.index) &&
		Number(value.index) >= 0 &&
		typeof value.optionText === 'string'
	)
}

export function isScrollPayload(
	value: unknown
): value is { down: boolean; numPages: number; pixels?: number; index?: number } {
	if (!isRecord(value) || typeof value.down !== 'boolean') return false
	if (
		typeof value.numPages !== 'number' ||
		!Number.isFinite(value.numPages) ||
		value.numPages < 0
	) {
		return false
	}
	if (
		value.pixels !== undefined &&
		(typeof value.pixels !== 'number' || !Number.isFinite(value.pixels) || value.pixels < 0)
	) {
		return false
	}
	return (
		value.index === undefined ||
		(typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0)
	)
}

export function isHorizontalScrollPayload(
	value: unknown
): value is { right: boolean; pixels: number; index?: number } {
	if (!isRecord(value) || typeof value.right !== 'boolean') return false
	if (typeof value.pixels !== 'number' || !Number.isFinite(value.pixels) || value.pixels < 0) {
		return false
	}
	return (
		value.index === undefined ||
		(typeof value.index === 'number' && Number.isSafeInteger(value.index) && value.index >= 0)
	)
}

function isRequestBase(value: Record<string, unknown>): boolean {
	return isPortBase(value) && isIdentifier(value.requestId) && isMethod(value.method)
}

function isResponseBase(value: Record<string, unknown>): boolean {
	return isPortBase(value) && isIdentifier(value.requestId) && isIdentifier(value.method)
}

export function isBridgeDiscoverMessage(value: unknown): value is BridgeDiscoverMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ['protocol', 'version', 'type', 'sessionId']) &&
		hasProtocol(value) &&
		value.type === 'discover' &&
		isIdentifier(value.sessionId)
	)
}

export function isBridgeAvailableMessage(value: unknown): value is BridgeAvailableMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'capabilities',
		]) &&
		hasProtocol(value) &&
		value.type === 'available' &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.frameInstanceId) &&
		isCapabilityList(value.capabilities)
	)
}

export function isBridgeConnectMessage(value: unknown): value is BridgeConnectMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ['protocol', 'version', 'type', 'sessionId', 'frameInstanceId']) &&
		hasProtocol(value) &&
		value.type === 'connect' &&
		isIdentifier(value.sessionId) &&
		isIdentifier(value.frameInstanceId)
	)
}

export function isBridgeConnectedMessage(value: unknown): value is BridgeConnectedMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'capabilities',
		]) &&
		isPortBase(value) &&
		value.type === 'connected' &&
		isCapabilityList(value.capabilities)
	)
}

export function isBridgeRequestMessage(value: unknown): value is BridgeRequestMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
			'payload',
		]) &&
		isRequestBase(value) &&
		value.type === 'request' &&
		Object.prototype.hasOwnProperty.call(value, 'payload')
	)
}

function isPayloadHash(value: unknown): value is string {
	return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function isBridgeActionPayloadSummary(value: unknown): value is BridgeActionPayloadSummary {
	if (!isRecord(value)) return false
	if (
		!hasOnlyKeys(value, [
			'index',
			'textLength',
			'optionLength',
			'down',
			'right',
			'numPages',
			'pixels',
		])
	)
		return false
	for (const key of ['index', 'textLength', 'optionLength'] as const) {
		if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0))
			return false
	}
	for (const key of ['numPages', 'pixels'] as const) {
		if (
			value[key] !== undefined &&
			(typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < 0)
		)
			return false
	}
	return (
		(value.down === undefined || typeof value.down === 'boolean') &&
		(value.right === undefined || typeof value.right === 'boolean')
	)
}

export function isBridgePrepareActionMessage(value: unknown): value is BridgePrepareActionMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
			'payloadHash',
			'summary',
		]) &&
		isPortBase(value) &&
		value.type === 'prepare-action' &&
		isIdentifier(value.requestId) &&
		isFrameBridgeActionMethod(value.method) &&
		isPayloadHash(value.payloadHash) &&
		isBridgeActionPayloadSummary(value.summary)
	)
}

export function isBridgeCommitActionMessage(value: unknown): value is BridgeCommitActionMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
			'preparedActionId',
			'approved',
			'payload',
		]) &&
		isPortBase(value) &&
		value.type === 'commit-action' &&
		isIdentifier(value.requestId) &&
		isFrameBridgeActionMethod(value.method) &&
		isIdentifier(value.preparedActionId) &&
		typeof value.approved === 'boolean' &&
		Object.prototype.hasOwnProperty.call(value, 'payload')
	)
}

export function isBridgeStartedMessage(value: unknown): value is BridgeStartedMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
		]) &&
		isRequestBase(value) &&
		value.type === 'started'
	)
}

export function isBridgePointerMessage(value: unknown): value is BridgePointerMessage {
	if (
		!isRecord(value) ||
		!isPortBase(value) ||
		!isIdentifier(value.requestId) ||
		value.type !== 'pointer'
	) {
		return false
	}
	if (value.action === 'click') {
		return hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'action',
		])
	}
	return (
		value.action === 'move' &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'action',
			'x',
			'y',
		]) &&
		typeof value.x === 'number' &&
		Number.isFinite(value.x) &&
		typeof value.y === 'number' &&
		Number.isFinite(value.y)
	)
}

export function isSerializedBridgeError(value: unknown): value is SerializedBridgeError {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ['code', 'message']) &&
		typeof value.code === 'string' &&
		errorCodes.has(value.code) &&
		typeof value.message === 'string'
	)
}

export function isBridgeResponseMessage(value: unknown): value is BridgeResponseMessage {
	if (!isRecord(value) || !isResponseBase(value) || value.type !== 'response') return false
	if (
		value.ok === true &&
		(!isMethod(value.method) ||
			!hasOnlyKeys(value, [
				'protocol',
				'version',
				'type',
				'sessionId',
				'frameInstanceId',
				'treeRevision',
				'requestId',
				'method',
				'ok',
				'result',
			]))
	)
		return false
	if (
		value.ok === false &&
		!hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
			'ok',
			'error',
		])
	)
		return false

	return value.ok === true
		? Object.prototype.hasOwnProperty.call(value, 'result')
		: value.ok === false && isSerializedBridgeError(value.error)
}

export function isBridgeCancelMessage(value: unknown): value is BridgeCancelMessage {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, [
			'protocol',
			'version',
			'type',
			'sessionId',
			'frameInstanceId',
			'treeRevision',
			'requestId',
			'method',
		]) &&
		isRequestBase(value) &&
		value.type === 'cancel'
	)
}

export function isBridgeWindowMessage(value: unknown): value is BridgeWindowMessage {
	return (
		isBridgeDiscoverMessage(value) ||
		isBridgeAvailableMessage(value) ||
		isBridgeConnectMessage(value)
	)
}

export function isBridgePortMessage(value: unknown): value is BridgePortMessage {
	return (
		isBridgeConnectedMessage(value) ||
		isBridgeRequestMessage(value) ||
		isBridgePrepareActionMessage(value) ||
		isBridgeCommitActionMessage(value) ||
		isBridgeStartedMessage(value) ||
		isBridgePointerMessage(value) ||
		isBridgeResponseMessage(value) ||
		isBridgeCancelMessage(value)
	)
}
