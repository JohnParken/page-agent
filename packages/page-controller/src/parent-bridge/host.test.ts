import { describe, expect, it, vi } from 'vitest'

import { CHILD_ORIGIN, createBridgeHarness } from '../iframe-bridge/bridge-test-helpers'

import { ParentPageControllerHost } from './host'
import { ParentFrameProxyController } from './ParentFrameProxyController'
import {
	PARENT_CONTROLLER_PROTOCOL,
	PARENT_CONTROLLER_PROTOCOL_VERSION,
	type ParentControllerCapability,
	ParentControllerErrorCode,
} from './protocol'

import type { VerifiedEmbedPolicyClaims } from './protocol'
import type { ParentControllerMessagePort, ParentPageControllerHostOptions } from './types'

class TestPort implements ParentControllerMessagePort {
	onmessage: ((event: MessageEvent<unknown>) => void) | null = null
	readonly messages: unknown[] = []
	closed = false

	postMessage(message: unknown): void {
		if (this.closed) throw new Error('port is closed')
		this.messages.push(message)
	}

	addEventListener(): void {}
	removeEventListener(): void {}
	start(): void {}
	close(): void {
		this.closed = true
	}
}

function options(iframe: HTMLIFrameElement, root: ParentPageControllerHostOptions['root']) {
	return {
		iframe,
		assistantOrigin: 'https://assistant.example.test',
		root,
		scopeId: 'scope-1',
		capabilities: ['observe' as const],
		getEmbedPolicy: async () => 'policy',
		verifyEmbedPolicy: async () => false as const,
		visualFeedback: 'none' as const,
	}
}

function makeInjectedHost(
	config: {
		tagName?: string
		actionPolicy?: ParentPageControllerHostOptions['actionPolicy']
		capabilities?: ParentControllerCapability[]
		disposeController?: boolean
	} = {}
) {
	const capabilities =
		config.capabilities ??
		(['observe', 'click', 'input', 'select', 'scroll', 'scrollHorizontally'] as const)
	const root = document.createElement('div')
	const iframe = document.createElement('iframe')
	const target = document.createElement(config.tagName ?? 'button')
	if (target.tagName === 'BUTTON') target.setAttribute('type', 'button')
	target.setAttribute('data-test-target', '')
	root.append(target)
	document.body.append(root, iframe)
	const host = new ParentPageControllerHost({
		...options(iframe, root),
		capabilities,
		actionPolicy: config.actionPolicy,
		disposeController: config.disposeController,
		requestTimeoutMs: 1_000,
	})
	const controller = {
		getIndexedElementForPolicy: vi.fn(() => target),
		clickElement: vi.fn(async () => ({ success: true, message: 'clicked' })),
		inputText: vi.fn(async () => ({ success: true, message: 'input' })),
		selectOption: vi.fn(async () => ({ success: true, message: 'selected' })),
		scroll: vi.fn(async () => ({ success: true, message: 'scrolled' })),
		scrollHorizontally: vi.fn(async () => ({ success: true, message: 'scrolled' })),
		getCurrentUrl: vi.fn(async () => 'https://parent.example.test/'),
		getLastUpdateTime: vi.fn(async () => 0),
		getBrowserState: vi.fn(async () => ({
			url: 'https://parent.example.test/',
			title: '',
			header: '',
			content: '',
			footer: '',
			treeRevision: 1,
			indices: [0],
		})),
		updateTree: vi.fn(async () => ''),
		cleanUpHighlights: vi.fn(async () => undefined),
		showMask: vi.fn(async () => undefined),
		hideMask: vi.fn(async () => undefined),
		executeJavascript: vi.fn(async () => ({ success: false, message: 'unsupported' })),
		dispose: vi.fn(),
	}
	;(host as unknown as { controller: typeof controller }).controller = controller
	const port = new TestPort()
	const frameContext = {
		parentOrigin: window.location.origin,
		assistantOrigin: 'https://assistant.example.test',
		directChild: true,
		sandbox: [],
		allowScripts: true,
		allowSameOrigin: true,
	}
	const connection = {
		policyId: 'policy-1',
		sessionId: 'session-1',
		hostInstanceId: 'host-1',
		frameInstanceId: 'frame-1',
		frameContext,
		capabilities,
		expiresAt: Math.floor(Date.now() / 1000) + 60,
		seenRequestIds: new Set<string>(),
		treeRevision: 1,
		state: {
			url: 'https://parent.example.test/',
			title: '',
			header: '',
			content: '',
			footer: '',
			treeRevision: 1,
			indices: [0],
		},
	}
	;(host as unknown as { connection: typeof connection }).connection = connection
	;(host as unknown as { connectionGeneration: number }).connectionGeneration = 1
	;(host as unknown as { port: TestPort }).port = port
	return { host, root, iframe, target, controller, port, connection }
}

function requestMessage(
	connection: ReturnType<typeof makeInjectedHost>['connection'],
	overrides: Record<string, unknown> = {}
) {
	return {
		protocol: PARENT_CONTROLLER_PROTOCOL,
		version: PARENT_CONTROLLER_PROTOCOL_VERSION,
		type: 'request' as const,
		policyId: connection.policyId,
		sessionId: connection.sessionId,
		hostInstanceId: connection.hostInstanceId,
		frameInstanceId: connection.frameInstanceId,
		treeRevision: connection.treeRevision,
		requestId: 'request-1',
		method: 'clickElement',
		capability: 'click',
		payload: { index: 0 },
		...overrides,
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const startedAt = Date.now()
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error('condition timed out')
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
}

function deferred<T>(): {
	promise: Promise<T>
	resolve: (value: T | PromiseLike<T>) => void
} {
	let resolve!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((nextResolve) => {
		resolve = nextResolve
	})
	return { promise, resolve }
}

describe('ParentPageControllerHost lifecycle', () => {
	it('chains child prepare policy with parent approval before committing a remote action', async () => {
		const root = document.createElement('main')
		const assistant = document.createElement('iframe')
		document.body.append(root, assistant)
		const harness = createBridgeHarness(root)
		harness.setPreparedDecision('approval_required')
		const actionPolicy = vi.fn(
			async (
				request: Parameters<NonNullable<ParentPageControllerHostOptions['actionPolicy']>>[0]
			) => {
				expect(request.target).toBeUndefined()
				expect(request.targetContext).toMatchObject({
					kind: 'child-frame',
					frameId: 'child-1',
					origin: CHILD_ORIGIN,
					childTarget: { tag: 'button', label: 'Remote' },
				})
				return { decision: 'allow' as const }
			}
		)
		const host = new ParentPageControllerHost({
			...options(assistant, root),
			capabilities: ['observe', 'click'],
			actionPolicy,
			window: harness.ownerWindow,
			childFrames: {
				targets: [
					{
						id: 'child-1',
						iframe: harness.iframe,
						origin: CHILD_ORIGIN,
						capabilities: ['observe', 'click'],
					},
				],
			},
			requestTimeoutMs: 1_000,
		})
		const controller = host.controller as ParentFrameProxyController
		controller.setAuthorizedFrames([
			{
				id: 'child-1',
				origin: CHILD_ORIGIN,
				capabilities: ['observe', 'click'],
			},
		])
		vi.spyOn(controller.localController, 'getBrowserState').mockResolvedValue({
			url: window.location.href,
			title: 'Parent',
			header: '',
			content: '',
			footer: '',
			treeRevision: 1,
			indices: [],
		})
		const state = await controller.getBrowserState()
		expect(state.indices).toEqual([0, 1, 2])

		const port = new TestPort()
		const connection = {
			policyId: 'policy-1',
			sessionId: 'session-1',
			hostInstanceId: 'host-1',
			frameInstanceId: 'frame-1',
			frameContext: {
				parentOrigin: window.location.origin,
				assistantOrigin: 'https://assistant.example.test',
				directChild: true,
				sandbox: [],
				allowScripts: true,
				allowSameOrigin: true,
			},
			capabilities: ['observe' as const, 'click' as const],
			childFrameGrants: [
				{
					id: 'child-1',
					origin: CHILD_ORIGIN,
					capabilities: ['observe' as const, 'click' as const],
				},
			],
			expiresAt: Math.floor(Date.now() / 1000) + 60,
			seenRequestIds: new Set<string>(),
			treeRevision: state.treeRevision,
			state,
		}
		;(host as unknown as { connection: typeof connection }).connection = connection
		;(host as unknown as { connectionGeneration: number }).connectionGeneration = 1
		;(host as unknown as { port: TestPort }).port = port
		const request = {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'request' as const,
			policyId: connection.policyId,
			sessionId: connection.sessionId,
			hostInstanceId: connection.hostInstanceId,
			frameInstanceId: connection.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: 'remote-click',
			method: 'clickElement',
			capability: 'click',
			payload: { index: 0 },
		}
		;(
			host as unknown as {
				acceptRequest(message: typeof request): void
			}
		).acceptRequest(request)
		await waitUntil(() =>
			port.messages.some((message) => (message as { type?: string }).type === 'approval-required')
		)
		const approval = port.messages.find(
			(message) => (message as { type?: string }).type === 'approval-required'
		) as {
			approvalId: string
			payload: { frame: { id: string; origin: string }; target: { label: string } }
		}
		expect(approval.payload).toMatchObject({
			frame: { id: 'child-1', origin: CHILD_ORIGIN },
			target: { label: 'Remote' },
		})
		;(
			host as unknown as {
				handleApprovalResponse(message: Record<string, unknown>): void
			}
		).handleApprovalResponse({
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'approval-response',
			policyId: connection.policyId,
			sessionId: connection.sessionId,
			hostInstanceId: connection.hostInstanceId,
			frameInstanceId: connection.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: request.requestId,
			approvalId: approval.approvalId,
			approved: true,
		})
		await waitUntil(() =>
			port.messages.some(
				(message) =>
					(message as { type?: string; requestId?: string; ok?: boolean }).type === 'response' &&
					(message as { requestId?: string }).requestId === request.requestId
			)
		)
		expect(
			port.messages.find(
				(message) =>
					(message as { type?: string; requestId?: string }).type === 'response' &&
					(message as { requestId?: string }).requestId === request.requestId
			)
		).toMatchObject({ ok: true, result: { success: true } })
		expect(actionPolicy).toHaveBeenCalledTimes(2)

		harness.setPreparedDecision('deny')
		const deniedRequest = { ...request, requestId: 'remote-click-denied' }
		;(
			host as unknown as {
				acceptRequest(message: typeof deniedRequest): void
			}
		).acceptRequest(deniedRequest)
		await waitUntil(() =>
			port.messages.some(
				(message) =>
					(message as { type?: string; requestId?: string }).type === 'response' &&
					(message as { requestId?: string }).requestId === deniedRequest.requestId
			)
		)
		expect(
			port.messages.find(
				(message) =>
					(message as { type?: string; requestId?: string }).type === 'response' &&
					(message as { requestId?: string }).requestId === deniedRequest.requestId
			)
		).toMatchObject({
			ok: false,
			error: { code: ParentControllerErrorCode.CAPABILITY_DENIED },
		})
		expect(actionPolicy).toHaveBeenCalledTimes(3)
		host.dispose()
		harness.dispose()
	})

	it('accepts only configured exact-origin child frame grants from verified claims', () => {
		const root = document.createElement('main')
		const child = document.createElement('iframe')
		child.src = 'https://child.example.test/app'
		const assistant = document.createElement('iframe')
		root.append(child)
		document.body.append(root, assistant)
		const host = new ParentPageControllerHost({
			...options(assistant, root),
			capabilities: ['observe', 'click'],
			childFrames: {
				targets: [
					{
						id: 'child-1',
						iframe: child,
						origin: 'https://child.example.test',
						capabilities: ['observe', 'click'],
					},
				],
			},
		})
		const claims: VerifiedEmbedPolicyClaims = {
			jti: 'policy-1',
			tenant: 'tenant-1',
			user: 'user-1',
			targetId: 'assistant-1',
			scopeId: 'scope-1',
			parentOrigin: window.location.origin,
			assistantOrigin: 'https://assistant.example.test',
			cap: ['observe', 'click'],
			protocolVersionMin: 1,
			protocolVersionMax: 1,
			nbf: Math.floor(Date.now() / 1000) - 1,
			exp: Math.floor(Date.now() / 1000) + 60,
		}
		const validate = (
			host as unknown as {
				validateChildFrameClaims(
					value: VerifiedEmbedPolicyClaims
				): readonly { id: string; origin: string; capabilities: readonly string[] }[] | false
			}
		).validateChildFrameClaims.bind(host)

		expect(validate(claims)).toEqual([])
		expect(
			validate({
				...claims,
				childFrames: [
					{ id: 'child-1', origin: 'https://child.example.test', cap: ['observe', 'click'] },
				],
			})
		).toEqual([
			{
				id: 'child-1',
				origin: 'https://child.example.test',
				capabilities: ['observe', 'click'],
			},
		])
		expect(
			validate({
				...claims,
				childFrames: [{ id: 'child-1', origin: 'https://evil.example.test', cap: ['observe'] }],
			})
		).toBe(false)
		expect(
			validate({
				...claims,
				childFrames: [{ id: 'child-1', origin: 'https://child.example.test', cap: ['input'] }],
			})
		).toBe(false)
		host.dispose()
	})

	it('keeps visual feedback disabled when visualFeedback is none', () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		document.body.append(root, iframe)
		const host = new ParentPageControllerHost(options(iframe, root)).start()

		window.dispatchEvent(new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 20, y: 20 } }))
		expect(document.querySelector('[data-page-agent-parent-cursor]')).toBeNull()

		host.dispose()
		root.remove()
		iframe.remove()
	})

	it('renders a non-blocking cursor only inside the trusted root and ripples on click', () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		document.body.append(root, iframe)
		vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
			left: 10,
			top: 20,
			right: 210,
			bottom: 220,
			width: 200,
			height: 200,
			x: 10,
			y: 20,
			toJSON: () => ({}),
		} as DOMRect)
		const host = new ParentPageControllerHost({
			...options(iframe, root),
			visualFeedback: 'non-blocking',
		}).start()

		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 120 } })
		)
		const cursor = document.querySelector<HTMLElement>('[data-page-agent-parent-cursor]')
		expect(cursor).not.toBeNull()
		expect(cursor?.getAttribute('aria-hidden')).toBe('true')
		expect(cursor?.getAttribute('data-state')).toBe('idle')
		expect(cursor?.style.position).toBe('fixed')
		expect(cursor?.style.pointerEvents).toBe('none')
		expect(cursor?.style.getPropertyPriority('pointer-events')).toBe('important')
		expect(cursor?.hidden).toBe(false)
		expect(cursor?.style.left).toBe('100px')
		expect(cursor?.style.top).toBe('120px')
		expect(cursor?.querySelector('[data-page-agent-parent-cursor-ripple]')).not.toBeNull()

		window.dispatchEvent(new CustomEvent('PageAgent::ClickPointer'))
		expect(cursor?.classList.contains('page-agent-parent-cursor-clicking')).toBe(true)
		expect(cursor?.getAttribute('data-state')).toBe('clicking')

		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 211, y: 120 } })
		)
		expect(cursor?.hidden).toBe(true)

		host.dispose()
		expect(document.querySelector('[data-page-agent-parent-cursor]')).toBeNull()
		root.remove()
		iframe.remove()
	})

	it('clears the cursor on navigation and when the trusted root is removed', async () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		document.body.append(root, iframe)
		vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
			left: 0,
			top: 0,
			right: 300,
			bottom: 300,
			width: 300,
			height: 300,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect)
		const host = new ParentPageControllerHost({
			...options(iframe, root),
			visualFeedback: 'non-blocking',
		}).start()
		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		const cursor = document.querySelector<HTMLElement>('[data-page-agent-parent-cursor]')
		expect(cursor?.hidden).toBe(false)

		window.dispatchEvent(new Event('popstate'))
		expect(cursor?.hidden).toBe(true)

		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		expect(cursor?.hidden).toBe(true)
		root.remove()
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(cursor?.hidden).toBe(true)

		host.dispose()
		iframe.remove()
	})

	it('clears local feedback and controller highlights on navigation', async () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		document.body.append(root, iframe)
		vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
			left: 0,
			top: 0,
			right: 300,
			bottom: 300,
			width: 300,
			height: 300,
			x: 0,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect)
		const getComputedStyle = vi
			.spyOn(window, 'getComputedStyle')
			.mockImplementation(() => ({ pointerEvents: 'none' }) as CSSStyleDeclaration)
		const host = new ParentPageControllerHost({
			...options(iframe, root),
			visualFeedback: 'non-blocking',
			disposeController: false,
		}).start()
		const cleanUpHighlights = vi.spyOn(host.controller, 'cleanUpHighlights')
		const feedback = document.querySelector<HTMLElement>('[data-page-agent-parent-feedback]')
		;(
			host as unknown as { setFeedbackRequested: (requested: boolean) => void }
		).setFeedbackRequested(true)
		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		const cursor = document.querySelector<HTMLElement>('[data-page-agent-parent-cursor]')
		expect(cursor?.hidden).toBe(false)
		expect(feedback?.hidden).toBe(false)

		window.dispatchEvent(new Event('popstate'))
		expect(cursor?.hidden).toBe(true)
		expect(feedback?.hidden).toBe(true)
		// The first cleanup starts immediately. The second one runs after the
		// reset barrier, even when no request was in flight.
		expect(cleanUpHighlights).toHaveBeenCalledTimes(1)
		await waitUntil(() => cleanUpHighlights.mock.calls.length >= 2)
		expect(cleanUpHighlights).toHaveBeenCalledTimes(2)
		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		expect(cursor?.hidden).toBe(true)

		host.dispose()
		getComputedStyle.mockRestore()
		root.remove()
		iframe.remove()
	})

	it.each([true, false])(
		'cleans controller highlights when disposed (disposeController=%s)',
		(disposeController) => {
			const created = makeInjectedHost({ disposeController })
			created.host.dispose()
			expect(created.controller.cleanUpHighlights).toHaveBeenCalled()
			expect(created.controller.dispose).toHaveBeenCalledTimes(disposeController ? 1 : 0)
			created.root.remove()
			created.iframe.remove()
		}
	)

	it('clears a replaced root cursor and hides it when hideMask is requested', () => {
		const root = document.createElement('div')
		const replacement = document.createElement('div')
		const iframe = document.createElement('iframe')
		document.body.append(root, replacement, iframe)
		for (const candidate of [root, replacement]) {
			vi.spyOn(candidate, 'getBoundingClientRect').mockReturnValue({
				left: 0,
				top: 0,
				right: 300,
				bottom: 300,
				width: 300,
				height: 300,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			} as DOMRect)
		}
		let activeRoot: Element | null = root
		const host = new ParentPageControllerHost({
			...options(iframe, () => activeRoot),
			visualFeedback: 'non-blocking',
		}).start()

		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		const cursor = document.querySelector<HTMLElement>('[data-page-agent-parent-cursor]')
		expect(cursor?.hidden).toBe(false)

		activeRoot = replacement
		window.dispatchEvent(new CustomEvent('PageAgent::ClickPointer'))
		expect(cursor?.hidden).toBe(true)

		const setFeedbackRequested = (
			host as unknown as {
				setFeedbackRequested: (requested: boolean) => void
			}
		).setFeedbackRequested
		setFeedbackRequested.call(host, true)
		expect(cursor?.hidden).toBe(true)
		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		expect(cursor?.hidden).toBe(false)
		setFeedbackRequested.call(host, false)
		expect(cursor?.hidden).toBe(true)
		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		expect(cursor?.hidden).toBe(true)
		setFeedbackRequested.call(host, true)
		expect(cursor?.hidden).toBe(true)
		window.dispatchEvent(
			new CustomEvent('PageAgent::MovePointerTo', { detail: { x: 100, y: 100 } })
		)
		expect(cursor?.hidden).toBe(false)

		host.dispose()
		root.remove()
		replacement.remove()
		iframe.remove()
	})

	it('fails closed when the scoped root contains the assistant iframe', () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		root.append(iframe)
		document.body.append(root)
		expect(() => new ParentPageControllerHost(options(iframe, root))).toThrow(/root/i)
		root.remove()
	})

	it('restores a host-owned iframe marker on dispose', () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		iframe.src = 'https://assistant.example.test/child'
		document.body.append(root, iframe)
		const host = new ParentPageControllerHost(options(iframe, root))
		expect(iframe.hasAttribute('data-page-agent-not-interactive')).toBe(true)
		host.dispose()
		expect(iframe.hasAttribute('data-page-agent-not-interactive')).toBe(false)
		root.remove()
		iframe.remove()
	})

	it('rejects sandbox capabilities beyond scripts and same-origin', async () => {
		const root = document.createElement('div')
		const iframe = document.createElement('iframe')
		iframe.src = 'https://assistant.example.test/child'
		iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups')
		document.body.append(root, iframe)
		const logger = vi.fn()
		const verifyEmbedPolicy = vi.fn(async () => false as const)
		const host = new ParentPageControllerHost({
			...options(iframe, root),
			getEmbedPolicy: async () => 'policy',
			verifyEmbedPolicy,
			logger,
		}).start()

		await waitUntil(() =>
			logger.mock.calls.some(
				([entry]) => entry.code === ParentControllerErrorCode.EMBED_POLICY_DENIED
			)
		)
		expect(verifyEmbedPolicy).not.toHaveBeenCalled()

		host.dispose()
		root.remove()
		iframe.remove()
	})

	it('suppresses duplicate request IDs while the first action is live', async () => {
		const { host, root, iframe, connection, controller, port } = makeInjectedHost()
		const message = requestMessage(connection)
		const handlePortMessage = (
			host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage
		handlePortMessage.call(host, { data: message } as MessageEvent)
		handlePortMessage.call(host, { data: message } as MessageEvent)
		await waitUntil(
			() =>
				controller.clickElement.mock.calls.length === 1 &&
				port.messages.filter((value) => (value as { type?: string }).type === 'response').length ===
					1
		)
		expect(controller.clickElement).toHaveBeenCalledTimes(1)
		expect(
			port.messages.filter((value) => (value as { type?: string }).type === 'response')
		).toHaveLength(1)
		host.dispose()
		root.remove()
		iframe.remove()
	})

	it('sends a redacted approval summary without raw input text', async () => {
		const actionPolicy = vi.fn(async () => ({ decision: 'approval_required' as const }))
		const { host, root, iframe, target, connection, port } = makeInjectedHost({
			tagName: 'input',
			actionPolicy,
		})
		target.setAttribute('aria-label', 'token=secret-value')
		const message = requestMessage(connection, {
			method: 'inputText',
			capability: 'input',
			payload: { index: 0, text: 'raw-secret-value' },
		})
		;(
			host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage.call(host, { data: message } as MessageEvent)
		await waitUntil(() =>
			port.messages.some((value) => (value as { type?: string }).type === 'approval-required')
		)
		const approval = port.messages.find(
			(value): value is { type: string; payload: Record<string, unknown>; approvalId: string } =>
				(value as { type?: string }).type === 'approval-required'
		)
		expect(approval).toBeDefined()
		expect(approval!.payload).toEqual({
			index: 0,
			textLength: 'raw-secret-value'.length,
			target: { tag: 'input', label: 'token=[REDACTED]' },
		})
		expect(approval!.payload).not.toHaveProperty('text')
		port.postMessage({})
		;(
			host as unknown as { handleApprovalResponse: (message: unknown) => void }
		).handleApprovalResponse.call(host, {
			protocol: PARENT_CONTROLLER_PROTOCOL,
			version: PARENT_CONTROLLER_PROTOCOL_VERSION,
			type: 'approval-response',
			policyId: connection.policyId,
			sessionId: connection.sessionId,
			hostInstanceId: connection.hostInstanceId,
			frameInstanceId: connection.frameInstanceId,
			treeRevision: connection.treeRevision,
			requestId: message.requestId,
			approvalId: approval!.approvalId,
			approved: false,
		})
		await waitUntil(() =>
			port.messages.some((value) => (value as { type?: string }).type === 'response')
		)
		host.dispose()
		root.remove()
		iframe.remove()
	})

	it('rechecks an element marker after an asynchronous policy callback', async () => {
		const policyTarget: { current?: HTMLElement } = {}
		const actionPolicy = vi.fn(async () => {
			await Promise.resolve()
			policyTarget.current!.setAttribute('data-page-agent-policy', 'deny')
			return { decision: 'allow' as const }
		})
		const created = makeInjectedHost({ actionPolicy })
		policyTarget.current = created.target
		created.target.setAttribute('data-page-agent-policy', 'allow')
		const message = requestMessage(created.connection)
		;(
			created.host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage.call(created.host, { data: message } as MessageEvent)
		await waitUntil(() =>
			created.port.messages.some((value) => (value as { type?: string }).type === 'response')
		)
		const response = created.port.messages.find(
			(value): value is { type: string; ok: boolean; error?: { code: string } } =>
				(value as { type?: string }).type === 'response'
		)
		expect(response).toMatchObject({
			type: 'response',
			ok: false,
			error: { code: ParentControllerErrorCode.CAPABILITY_DENIED },
		})
		expect(created.controller.clickElement).not.toHaveBeenCalled()
		created.host.dispose()
		created.root.remove()
		created.iframe.remove()
	})

	it('rotates an expired connection by publishing a fresh offer', () => {
		const { host, root, iframe, connection, port } = makeInjectedHost()
		connection.expiresAt = Math.floor(Date.now() / 1000) - 1
		const publishOffer = vi.fn(() => Promise.resolve())
		;(host as unknown as { publishOffer: typeof publishOffer }).publishOffer = publishOffer
		const message = requestMessage(connection, {
			method: 'getCurrentUrl',
			capability: 'observe',
			payload: null,
		})
		;(
			host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage.call(host, { data: message } as MessageEvent)
		expect(port.messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'response',
					ok: false,
					error: expect.objectContaining({ code: ParentControllerErrorCode.POLICY_EXPIRED }),
				}),
			])
		)
		expect(publishOffer).toHaveBeenCalledWith(true)
		expect((host as unknown as { connection: unknown }).connection).toBeNull()
		host.dispose()
		root.remove()
		iframe.remove()
	})

	it('runs reset cleanup after a late observe before accepting replacement requests', async () => {
		const created = makeInjectedHost()
		const events: string[] = []
		const oldObserve = deferred<boolean>()
		let observeCalls = 0
		created.controller.getBrowserState.mockImplementation(async () => {
			observeCalls += 1
			if (observeCalls === 1) {
				events.push('old-observe-start')
				await oldObserve.promise
				events.push('old-observe-end')
			} else events.push('new-observe')
			return {
				url: 'https://parent.example.test/',
				title: '',
				header: '',
				content: '',
				footer: '',
				treeRevision: 1,
				indices: [0],
			}
		})
		created.controller.cleanUpHighlights.mockImplementation(async () => {
			events.push('cleanup')
		})
		const handlePortMessage = (
			created.host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage
		handlePortMessage.call(created.host, {
			data: requestMessage(created.connection, {
				requestId: 'old-observe',
				method: 'getBrowserState',
				capability: 'observe',
				payload: null,
			}),
		} as MessageEvent)
		await waitUntil(() => events.includes('old-observe-start'))
		;(created.host as unknown as { resetConnection: () => void }).resetConnection()
		expect(events).toEqual(['old-observe-start', 'cleanup'])

		const replacementConnection = {
			...created.connection,
			policyId: 'policy-2',
			sessionId: 'session-2',
			frameInstanceId: 'frame-2',
			seenRequestIds: new Set<string>(),
		}
		const replacementPort = new TestPort()
		;(created.host as unknown as { connection: typeof replacementConnection }).connection =
			replacementConnection
		;(created.host as unknown as { port: TestPort }).port = replacementPort
		handlePortMessage.call(created.host, {
			data: requestMessage(replacementConnection, {
				requestId: 'new-observe',
				method: 'getBrowserState',
				capability: 'observe',
				payload: null,
			}),
		} as MessageEvent)
		await Promise.resolve()
		expect(events).toEqual(['old-observe-start', 'cleanup'])

		oldObserve.resolve(true)
		await waitUntil(() => events.includes('new-observe'))
		expect(events).toEqual([
			'old-observe-start',
			'cleanup',
			'old-observe-end',
			'cleanup',
			'new-observe',
		])
		await waitUntil(() =>
			replacementPort.messages.some((value) => (value as { type?: string }).type === 'response')
		)

		created.host.dispose()
		created.root.remove()
		created.iframe.remove()
	})

	it('allows cleanup RPC only when the cleanup capability is explicitly granted', async () => {
		const allowed = makeInjectedHost({
			capabilities: [
				'observe',
				'click',
				'input',
				'select',
				'scroll',
				'scrollHorizontally',
				'cleanup',
			],
		})
		const handleAllowed = (
			allowed.host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage
		handleAllowed.call(allowed.host, {
			data: requestMessage(allowed.connection, {
				requestId: 'cleanup-allowed',
				method: 'cleanUpHighlights',
				capability: 'cleanup',
				payload: null,
			}),
		} as MessageEvent)
		await waitUntil(() =>
			allowed.port.messages.some((value) => (value as { type?: string }).type === 'response')
		)
		const allowedResponse = allowed.port.messages.find(
			(value): value is { type: string; ok: boolean } =>
				(value as { type?: string }).type === 'response'
		)
		expect(allowedResponse).toMatchObject({ type: 'response', ok: true })
		expect(allowed.controller.cleanUpHighlights).toHaveBeenCalledTimes(1)
		allowed.host.dispose()
		allowed.root.remove()
		allowed.iframe.remove()

		const denied = makeInjectedHost()
		const handleDenied = (
			denied.host as unknown as { handlePortMessage: (event: MessageEvent) => void }
		).handlePortMessage
		handleDenied.call(denied.host, {
			data: requestMessage(denied.connection, {
				requestId: 'cleanup-denied',
				method: 'cleanUpHighlights',
				capability: 'cleanup',
				payload: null,
			}),
		} as MessageEvent)
		await waitUntil(() =>
			denied.port.messages.some((value) => (value as { type?: string }).type === 'response')
		)
		const deniedResponse = denied.port.messages.find(
			(value): value is { type: string; ok: boolean; error?: { code: string } } =>
				(value as { type?: string }).type === 'response'
		)
		expect(deniedResponse).toMatchObject({
			type: 'response',
			ok: false,
			error: { code: ParentControllerErrorCode.CAPABILITY_DENIED },
		})
		expect(denied.controller.cleanUpHighlights).not.toHaveBeenCalled()
		denied.host.dispose()
		denied.root.remove()
		denied.iframe.remove()
	})
})
