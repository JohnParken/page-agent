import { afterEach, describe, expect, it, vi } from 'vitest'

import { CHILD_ORIGIN, createBridgeHarness } from '../iframe-bridge/bridge-test-helpers'
import { BridgeErrorCode } from '../iframe-bridge/protocol'

import { ParentFrameProxyController } from './ParentFrameProxyController'

import type { IndexedPageControllerAdapter } from '../PageController'

function createLocalController(target: HTMLElement): IndexedPageControllerAdapter {
	return {
		getCurrentUrl: vi.fn(async () => window.location.href),
		getLastUpdateTime: vi.fn(async () => 0),
		getBrowserState: vi.fn(async () => ({
			url: window.location.href,
			title: 'Parent',
			header: 'Parent header',
			content: '[1]<button>Parent action</button>',
			footer: 'Parent footer',
			treeRevision: 1,
			indices: [1],
		})),
		updateTree: vi.fn(async () => ''),
		cleanUpHighlights: vi.fn(async () => undefined),
		clickElement: vi.fn(async () => ({ success: true, message: 'local click' })),
		inputText: vi.fn(async () => ({ success: true, message: 'local input' })),
		selectOption: vi.fn(async () => ({ success: true, message: 'local select' })),
		scroll: vi.fn(async () => ({ success: true, message: 'local scroll' })),
		scrollHorizontally: vi.fn(async () => ({ success: true, message: 'local horizontal' })),
		executeJavascript: vi.fn(async () => ({ success: false, message: 'unsupported' })),
		showMask: vi.fn(async () => undefined),
		hideMask: vi.fn(async () => undefined),
		dispose: vi.fn(),
		getIndexedElementForPolicy: vi.fn(() => target),
	} as IndexedPageControllerAdapter
}

describe('ParentFrameProxyController', () => {
	const disposals: (() => void)[] = []

	afterEach(() => {
		for (const dispose of disposals.splice(0)) dispose()
		document.body.replaceChildren()
	})

	function setup() {
		const root = document.createElement('main')
		const assistant = document.createElement('iframe')
		const localTarget = document.createElement('button')
		localTarget.type = 'button'
		root.append(localTarget)
		document.body.append(root, assistant)
		const harness = createBridgeHarness(root)
		const localController = createLocalController(localTarget)
		const controller = new ParentFrameProxyController({
			localController,
			root,
			assistantIframe: assistant,
			targets: [
				{
					id: 'payments',
					iframe: harness.iframe,
					origin: CHILD_ORIGIN,
					capabilities: ['observe', 'click', 'input', 'scroll'],
				},
			],
			handshakeTimeoutMs: 100,
			requestTimeoutMs: 100,
			window: harness.ownerWindow,
			disposeLocalController: false,
		})
		disposals.push(() => {
			controller.dispose()
			harness.dispose()
		})
		return { controller, harness, localController, root }
	}

	it('keeps unauthorized child frames invisible and merges exact signed grants', async () => {
		const { controller } = setup()
		const localOnly = await controller.getBrowserState()
		expect(localOnly.content).not.toContain('authorized-child-frame')
		expect(localOnly.indices).toEqual([1])

		controller.setAuthorizedFrames([
			{
				id: 'payments',
				origin: CHILD_ORIGIN,
				capabilities: ['observe', 'click'],
			},
		])
		const combined = await controller.getBrowserState()
		expect(combined.content).toContain(
			`<authorized-child-frame id="payments" origin="${CHILD_ORIGIN}">`
		)
		expect(combined.content).toContain('[2]<button>Remote</button>')
		expect(combined.indices).toEqual([1, 2, 3, 4])
	})

	it('prepares and commits remote actions through the child v2 policy token', async () => {
		const { controller, harness } = setup()
		controller.setAuthorizedFrames([
			{
				id: 'payments',
				origin: CHILD_ORIGIN,
				capabilities: ['observe', 'click'],
			},
		])
		await controller.getBrowserState()
		harness.setPreparedDecision('approval_required')

		const prepared = await controller.prepareAction('clickElement', { index: 2 })
		expect(prepared).toMatchObject({
			kind: 'child-frame',
			decision: 'approval_required',
			targetContext: {
				kind: 'child-frame',
				frameId: 'payments',
				origin: CHILD_ORIGIN,
				childTarget: { tag: 'button', label: 'Remote' },
			},
		})
		expect((await controller.commitPreparedAction(prepared, true)).success).toBe(true)
	})

	it('enforces the signed capability subset and invalidates mappings on reload', async () => {
		const { controller, harness } = setup()
		controller.setAuthorizedFrames([
			{
				id: 'payments',
				origin: CHILD_ORIGIN,
				capabilities: ['observe'],
			},
		])
		await controller.getBrowserState()
		await expect(controller.prepareAction('clickElement', { index: 2 })).rejects.toMatchObject({
			code: BridgeErrorCode.CAPABILITY_DENIED,
		})

		controller.setAuthorizedFrames([
			{
				id: 'payments',
				origin: CHILD_ORIGIN,
				capabilities: ['observe', 'click'],
			},
		])
		await controller.getBrowserState()
		harness.iframe.dispatchEvent(new Event('load'))
		await expect(controller.prepareAction('clickElement', { index: 2 })).rejects.toMatchObject({
			code: BridgeErrorCode.STALE_TREE,
		})
	})

	it('fails closed when the configured iframe leaves the trusted root', async () => {
		const { controller, harness, root } = setup()
		controller.setAuthorizedFrames([
			{
				id: 'payments',
				origin: CHILD_ORIGIN,
				capabilities: ['observe', 'click'],
			},
		])
		await controller.getBrowserState()
		document.body.append(harness.iframe)
		expect(root.contains(harness.iframe)).toBe(false)
		await expect(controller.prepareAction('clickElement', { index: 2 })).rejects.toMatchObject({
			code: BridgeErrorCode.CAPABILITY_DENIED,
		})
	})
})
