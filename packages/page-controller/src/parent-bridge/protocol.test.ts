import { describe, expect, it } from 'vitest'

import {
	isIdentifier,
	isParentControllerConnectMessage,
	isParentControllerMessageSizeAllowed,
	isParentControllerPortMessage,
	isParentControllerPortMessageBase,
	isParentControllerRequestMessage,
	isParentControllerResult,
	isRecord,
	isTreeRevision,
	PARENT_CONTROLLER_MAX_MESSAGE_BYTES,
	PARENT_CONTROLLER_PROTOCOL,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
} from './protocol'

const ids = {
	policyId: 'policy-1',
	challenge: 'challenge-1',
	sessionId: 'session-1',
	hostInstanceId: 'host-1',
	frameInstanceId: 'frame-1',
}

function base() {
	return {
		protocol: PARENT_CONTROLLER_PROTOCOL,
		version: PARENT_CONTROLLER_PROTOCOL_VERSION,
		...ids,
		treeRevision: 1,
	}
}

describe('parent-controller protocol guards', () => {
	it('rejects unknown envelope fields and oversized messages', () => {
		const { challenge: _challenge, ...portBase } = base()
		const request = {
			...portBase,
			type: 'request' as const,
			requestId: 'request-1',
			method: 'getCurrentUrl',
			capability: 'observe',
			payload: null,
		}
		expect(isRecord(request)).toBe(true)
		expect(isTreeRevision(request.treeRevision)).toBe(true)
		expect(isIdentifier(request.requestId)).toBe(true)
		expect(isIdentifier(request.method)).toBe(true)
		expect(isIdentifier(request.capability, 64)).toBe(true)
		expect(isParentControllerMessageSizeAllowed(request)).toBe(true)
		expect(isParentControllerPortMessageBase(request)).toBe(true)
		expect(isParentControllerRequestMessage(request)).toBe(true)
		expect(isParentControllerRequestMessage({ ...request, unexpected: true })).toBe(false)
		expect(
			isParentControllerMessageSizeAllowed({
				value: 'x'.repeat(PARENT_CONTROLLER_MAX_MESSAGE_BYTES),
			})
		).toBe(false)
	})

	it('requires method-specific result schemas', () => {
		expect(isParentControllerResult('getCurrentUrl', 'https://example.test/')).toBe(true)
		expect(isParentControllerResult('getCurrentUrl', { value: 'not a url' })).toBe(false)
		expect(isParentControllerResult('clickElement', { success: true, message: 'ok' })).toBe(true)
		expect(isParentControllerResult('clickElement', { success: 'yes', message: 'ok' })).toBe(false)
		expect(
			isParentControllerResult('getBrowserState', {
				url: '',
				title: '',
				header: '',
				content: '',
				footer: '',
				treeRevision: 1,
				indices: [0, 1],
			})
		).toBe(true)
		expect(
			isParentControllerResult('getBrowserState', {
				url: '',
				title: '',
				header: '',
				content: '',
				footer: '',
				treeRevision: 1,
				indices: [1, 1],
			})
		).toBe(false)
	})

	it('validates the parent-created connect envelope', () => {
		const connect = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'connect' as const,
			...ids,
			capabilities: ['observe' as const],
			frameContext: {
				parentOrigin: 'https://parent.example.test',
				assistantOrigin: 'https://assistant.example.test',
				directChild: true,
				sandbox: [],
				allowScripts: true,
				allowSameOrigin: true,
			},
		}
		expect(isParentControllerConnectMessage(connect)).toBe(true)
		expect(
			isParentControllerConnectMessage({
				...connect,
				frameContext: { ...connect.frameContext, unknown: true },
			})
		).toBe(false)
		const { challenge: _challenge, ...responseBase } = base()
		expect(
			isParentControllerPortMessage({
				...responseBase,
				type: 'response',
				requestId: 'request-1',
				method: 'getCurrentUrl',
				ok: true,
				result: 'https://example.test/',
			})
		).toBe(true)
	})

	it('accepts only redacted approval summaries and non-empty capabilities', () => {
		const { challenge: _challenge, ...portBase } = base()
		const approvalBase = {
			...portBase,
			type: 'approval-required' as const,
			requestId: 'request-1',
			approvalId: 'approval-1',
			reason: 'Confirmation is required.',
		}

		expect(
			isParentControllerPortMessage({
				...approvalBase,
				method: 'inputText',
				capability: 'input',
				payload: { index: 1, text: 'do-not-echo' },
			})
		).toBe(false)
		expect(
			isParentControllerPortMessage({
				...approvalBase,
				method: 'selectOption',
				capability: 'select',
				payload: { index: 1, optionText: 'do-not-echo' },
			})
		).toBe(false)
		expect(
			isParentControllerPortMessage({
				...approvalBase,
				method: 'inputText',
				capability: 'input',
				payload: {
					index: 1,
					textLength: 11,
					target: { tag: 'input', role: 'textbox', label: 'Email' },
				},
			})
		).toBe(true)
		expect(
			isParentControllerPortMessage({
				...approvalBase,
				method: 'selectOption',
				capability: 'select',
				payload: {
					index: 1,
					optionLength: 4,
					target: { tag: 'select', role: 'combobox' },
				},
			})
		).toBe(true)
		expect(
			isParentControllerPortMessage({
				...approvalBase,
				method: 'scroll',
				capability: 'scroll',
				payload: {
					index: 2,
					direction: true,
					pixels: 12.5,
					numPages: 0.5,
					target: { tag: 'section', label: 'Results' },
				},
			})
		).toBe(true)

		const connect = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'connect' as const,
			...ids,
			capabilities: ['observe' as const],
			frameContext: {
				parentOrigin: 'https://parent.example.test',
				assistantOrigin: 'https://assistant.example.test',
				directChild: true,
				sandbox: [],
				allowScripts: true,
				allowSameOrigin: true,
			},
		}
		expect(isParentControllerConnectMessage({ ...connect, capabilities: [] })).toBe(false)
	})
})
