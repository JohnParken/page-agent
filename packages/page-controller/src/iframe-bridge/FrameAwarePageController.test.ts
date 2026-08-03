import { describe, expect, it, vi } from 'vitest'

import { CHILD_ORIGIN, createBridgeHarness } from './bridge-test-helpers'
import { FrameAwarePageController } from './FrameAwarePageController'
import { BridgeErrorCode } from './protocol'

import type { IndexedPageControllerAdapter } from '../PageController'

function createLocalController(): IndexedPageControllerAdapter {
	return {
		getCurrentUrl: vi.fn(async () => 'https://parent.example.test/'),
		getLastUpdateTime: vi.fn(async () => 1),
		getBrowserState: vi.fn(async () => ({
			url: 'https://parent.example.test/',
			title: 'Parent',
			header: 'Parent header',
			content: '[5]<button>Local</button>',
			footer: 'Parent footer',
			treeRevision: 1,
			indices: [5],
		})),
		updateTree: vi.fn(async () => '[5]<button>Local</button>'),
		cleanUpHighlights: vi.fn(async () => undefined),
		clickElement: vi.fn(async () => ({ success: true, message: 'local click' })),
		inputText: vi.fn(async () => ({ success: true, message: 'local input' })),
		selectOption: vi.fn(async () => ({ success: true, message: 'local select' })),
		scroll: vi.fn(async () => ({ success: true, message: 'local scroll' })),
		scrollHorizontally: vi.fn(async () => ({ success: true, message: 'local hscroll' })),
		executeJavascript: vi.fn(async () => ({ success: true, message: 'local js' })),
		showMask: vi.fn(async () => undefined),
		hideMask: vi.fn(async () => undefined),
		dispose: vi.fn(),
	}
}

describe('FrameAwarePageController', () => {
	it('merges remote content, remaps only element markers and routes actions', async () => {
		const harness = createBridgeHarness()
		const local = createLocalController()
		const scrollIntoView = vi.fn()
		Object.defineProperty(harness.iframe, 'scrollIntoView', {
			configurable: true,
			value: scrollIntoView,
		})
		const controller = new FrameAwarePageController({
			localController: local,
			frameSelector: 'iframe[data-page-agent-bridge], iframe',
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			document: harness.iframe.ownerDocument,
			requestTimeoutMs: 100,
		})

		const state = await controller.getBrowserState()
		expect(state.indices).toEqual([5, 6, 7, 8])
		expect(state.content).toContain('[6]<button>Remote</button>')
		expect(state.content).toContain('  *[7]<input>')
		expect(state.content).toContain('*[8]<iframe-document>Child</iframe-document>')
		expect(state.content).toContain('Child header')
		expect(state.content).toContain('Remote [1] ordinary') // Non-marker text is not remapped.

		expect((await controller.clickElement(6)).success).toBe(true)
		expect(scrollIntoView).toHaveBeenCalled()
		expect((await controller.scroll({ down: true, numPages: 1, index: 8 })).success).toBe(true)
		expect(
			(await controller.scrollHorizontally({ right: true, pixels: 10, index: 8 })).success
		).toBe(true)

		const stale = await controller.clickElement(999)
		expect(stale.success).toBe(false)
		expect(stale.message).toContain(BridgeErrorCode.STALE_TREE)
		controller.dispose()
		harness.dispose()
	})

	it('degrades unavailable frames, handles removal and aborts before discovery', async () => {
		const harness = createBridgeHarness()
		const local = createLocalController()
		const controller = new FrameAwarePageController({
			localController: local,
			frameSelector: 'iframe',
			allowedChildOrigins: [CHILD_ORIGIN],
			window: harness.ownerWindow,
			document: harness.iframe.ownerDocument,
			handshakeTimeoutMs: 5,
		})
		const abortController = new AbortController()
		abortController.abort()
		await expect(
			controller.getBrowserState({ signal: abortController.signal })
		).rejects.toMatchObject({
			code: BridgeErrorCode.ABORTED,
		})

		await controller.getBrowserState()
		expect(controller.frameClients).toHaveLength(1)
		const remoteClient = controller.frameClients[0]
		const remoteClick = vi.spyOn(remoteClient, 'clickElement')
		harness.iframe.remove()
		const staleAction = await controller.clickElement(6)
		expect(staleAction.success).toBe(false)
		expect(staleAction.message).toContain(BridgeErrorCode.STALE_TREE)
		expect(remoteClick).not.toHaveBeenCalled()
		await controller.getBrowserState()
		expect(controller.frameClients).toHaveLength(0)
		controller.dispose()
		harness.dispose()
	})
})
