import { describe, expect, it } from 'vitest'

import {
	BRIDGE_PROTOCOL_VERSION,
	BridgeErrorCode,
	IFRAME_BRIDGE_PROTOCOL,
	isBridgeAvailableMessage,
	isBridgePortMessage,
	isBridgeRequestMessage,
	isBridgeResponseMessage,
	isHorizontalScrollPayload,
	isScrollPayload,
} from './protocol'

const base = {
	protocol: IFRAME_BRIDGE_PROTOCOL,
	version: BRIDGE_PROTOCOL_VERSION,
}

describe('iframe bridge protocol validators', () => {
	it('rejects wrong protocol/version, unknown capabilities, methods and extra fields', () => {
		const available = {
			...base,
			type: 'available',
			sessionId: 'session',
			frameInstanceId: 'frame',
			capabilities: ['observe'],
		}
		expect(isBridgeAvailableMessage(available)).toBe(true)
		expect(isBridgeAvailableMessage({ ...available, version: 999 })).toBe(false)
		expect(isBridgeAvailableMessage({ ...available, capabilities: ['executeJavascript'] })).toBe(
			false
		)
		expect(isBridgeAvailableMessage({ ...available, extra: true })).toBe(false)

		const request = {
			...base,
			type: 'request',
			sessionId: 'session',
			frameInstanceId: 'frame',
			treeRevision: 1,
			requestId: 'request',
			method: 'clickElement',
			payload: { index: 1 },
		}
		expect(isBridgeRequestMessage(request)).toBe(true)
		expect(isBridgeRequestMessage({ ...request, method: 'executeJavascript' })).toBe(false)
		expect(isBridgeRequestMessage({ ...request, extra: true })).toBe(false)
	})

	it('validates numeric scroll payloads and response error shape', () => {
		expect(isScrollPayload({ down: true, numPages: 0.1 })).toBe(true)
		expect(isScrollPayload({ down: true, numPages: Number.NaN })).toBe(false)
		expect(isScrollPayload({ down: true, numPages: 1, index: -1 })).toBe(false)
		expect(isHorizontalScrollPayload({ right: false, pixels: 20 })).toBe(true)
		expect(isHorizontalScrollPayload({ right: true, pixels: Infinity })).toBe(false)

		const response = {
			...base,
			type: 'response',
			sessionId: 'session',
			frameInstanceId: 'frame',
			treeRevision: 1,
			requestId: 'request',
			method: 'clickElement',
			ok: false,
			error: { code: BridgeErrorCode.CAPABILITY_DENIED, message: 'denied' },
		}
		expect(isBridgeResponseMessage(response)).toBe(true)
		expect(
			isBridgeResponseMessage({
				...response,
				method: 'executeJavascript',
			})
		).toBe(true)
		expect(
			isBridgeResponseMessage({
				...response,
				method: '',
			})
		).toBe(false)
		expect(isBridgePortMessage({ ...response, error: { code: 'NOPE', message: 'bad' } })).toBe(
			false
		)

		const pointerMove = {
			...base,
			type: 'pointer',
			sessionId: 'session',
			frameInstanceId: 'frame',
			treeRevision: 1,
			requestId: 'request',
			action: 'move',
			x: 12.5,
			y: -3,
		}
		expect(isBridgePortMessage(pointerMove)).toBe(true)
		expect(isBridgePortMessage({ ...pointerMove, x: Number.NaN })).toBe(false)
		expect(isBridgePortMessage({ ...pointerMove, extra: true })).toBe(false)
		expect(isBridgePortMessage({ ...pointerMove, action: 'click', x: undefined })).toBe(false)
		expect(
			isBridgePortMessage({
				...base,
				type: 'pointer',
				sessionId: 'session',
				frameInstanceId: 'frame',
				treeRevision: 1,
				requestId: 'request',
				action: 'click',
			})
		).toBe(true)
	})
})
