import { afterEach, describe, expect, it, vi } from 'vitest'

import { DomRootUnavailableError, PageController } from './PageController'

describe('PageController', () => {
	afterEach(() => {
		document.body.innerHTML = ''
	})

	it('constructs and exposes the current url', async () => {
		const controller = new PageController()
		expect(controller).toBeInstanceOf(PageController)
		expect(await controller.getCurrentUrl()).toBe(window.location.href)
	})

	describe('indexed browser state', () => {
		it('exposes the current index map and a new revision for each tree update', async () => {
			document.body.innerHTML = '<button type="button">Continue</button>'
			const controller = new PageController()

			const first = await controller.getBrowserState()
			const second = await controller.getBrowserState()

			expect(first.treeRevision).toBeGreaterThan(0)
			expect(second.treeRevision).toBeGreaterThan(first.treeRevision)
			expect(first.indices).toEqual(expect.any(Array))
			expect(second.indices).toEqual(first.indices)
		})

		it('honors an aborted call context before touching the DOM', async () => {
			const controller = new PageController()
			const abort = new AbortController()
			abort.abort()

			await expect(controller.getBrowserState({ signal: abort.signal })).rejects.toMatchObject({
				name: 'AbortError',
			})
			await expect(controller.updateTree({ signal: abort.signal })).rejects.toMatchObject({
				name: 'AbortError',
			})
		})
	})

	describe('executeJavascript', () => {
		it('runs a script and returns its result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return 1 + 2')
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('3')
		})

		it('exposes the abort signal to the script scope', async () => {
			const controller = new PageController()
			const controllerSignal = new AbortController()
			controllerSignal.abort()

			const result = await controller.executeJavascript(
				'return signal.aborted',
				controllerSignal.signal
			)
			expect(result).toMatchObject({ success: true })
			expect(result.message).toContain('true')
		})

		it('reports a syntax error as a failed result', async () => {
			const controller = new PageController()
			const result = await controller.executeJavascript('return (')
			expect(result.success).toBe(false)
			expect(result.message).toContain('❌')
		})
	})

	describe('iframe boundary', () => {
		it('treats same-origin iframe documents as opaque leaves', async () => {
			document.body.innerHTML = `
				<button id="parent-button" type="button">Parent action</button>
				<iframe id="same-origin-frame" title="Same-origin frame"></iframe>
			`
			const parentButton = document.querySelector<HTMLElement>('#parent-button')!
			const iframe = document.querySelector<HTMLIFrameElement>('#same-origin-frame')!
			const iframeDocument = iframe.contentDocument!
			iframeDocument.body.innerHTML = `
				<button id="child-button" type="button">Same-origin child action</button>
				<input id="child-input" aria-label="Same-origin child input" />
			`
			const childButton = iframeDocument.querySelector<HTMLElement>('#child-button')!
			const childInput = iframeDocument.querySelector<HTMLElement>('#child-input')!
			for (const element of [parentButton, iframe, childButton, childInput]) {
				Object.defineProperties(element, {
					offsetWidth: { configurable: true, value: 120 },
					offsetHeight: { configurable: true, value: 32 },
				})
			}
			const controller = new PageController()

			const state = await controller.getBrowserState()

			expect(state.content).toContain('Parent action')
			expect(state.content).not.toContain('Same-origin child action')
			expect(state.content).not.toContain('Same-origin child input')
			expect(state.content).not.toContain('id=child-button')
			expect(state.content).not.toContain('id=child-input')
			for (const index of state.indices) {
				expect(controller.getIndexedElementForPolicy(index).ownerDocument).toBe(document)
			}
		})
	})

	describe('scoped root boundary', () => {
		const makeVisible = (element: HTMLElement) => {
			Object.defineProperties(element, {
				offsetWidth: { configurable: true, value: 120 },
				offsetHeight: { configurable: true, value: 32 },
			})
		}

		it('extracts only descendants and does not index the root itself', async () => {
			document.body.innerHTML = `
				<button id="outside">outside</button>
				<div id="scope" onclick="this.dataset.clicked = 'true'">
					<button id="inside">inside</button>
				</div>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('button')!)
			const controller = new PageController({ root: scope })

			const state = await controller.getBrowserState()

			expect(state.content).toContain('inside')
			expect(state.content).not.toContain('outside')
			expect(state.content).not.toContain('scope')
			expect(state.indices.length).toBeGreaterThan(0)
		})

		it('fails closed when a configured root is unavailable', async () => {
			const controller = new PageController({ root: () => null })

			await expect(controller.getBrowserState()).rejects.toMatchObject({
				name: 'DomRootUnavailableError',
				code: 'ROOT_UNAVAILABLE',
			})
		})

		it('does not create a document-wide blocking mask for a scoped root', async () => {
			document.body.innerHTML = '<div id="scope"></div>'
			const scope = document.querySelector<HTMLElement>('#scope')!
			const controller = new PageController({ root: scope, enableMask: true })

			controller.initMask()
			await controller.showMask()
			expect(document.querySelector('#page-agent-runtime_simulator-mask')).toBeNull()
			await controller.hideMask()
			expect(document.querySelector('#page-agent-runtime_simulator-mask')).toBeNull()
		})

		it('invalidates old indices when the resolver returns a replacement root', async () => {
			let root: HTMLElement | null
			document.body.innerHTML = '<div id="scope"><button>first</button></div>'
			root = document.querySelector<HTMLElement>('#scope')!
			makeVisible(root.querySelector<HTMLElement>('button')!)
			const controller = new PageController({ root: () => root })

			const first = await controller.getBrowserState()
			const firstIndex = first.indices[0]
			expect(controller.getTreeRevision()).toBe(first.treeRevision)
			root.remove()
			document.body.insertAdjacentHTML('beforeend', '<div id="scope"><button>second</button></div>')
			root = document.querySelector<HTMLElement>('#scope')!
			makeVisible(root.querySelector<HTMLElement>('button')!)

			const staleAction = await controller.clickElement(firstIndex)
			expect(staleAction.success).toBe(false)
			expect(staleAction.message).toContain('root changed')
			expect(controller.getTreeRevision()).toBeGreaterThan(first.treeRevision)

			const second = await controller.getBrowserState()
			expect(second.treeRevision).toBeGreaterThan(first.treeRevision)
			expect(second.content).toContain('second')
		})

		it('exposes only a live in-root element to local policy checks', async () => {
			document.body.innerHTML =
				'<button id="outside">outside</button><div id="scope"><button id="inside">inside</button></div>'
			const scope = document.querySelector<HTMLElement>('#scope')!
			const inside = scope.querySelector<HTMLElement>('button')!
			const outside = document.querySelector<HTMLElement>('#outside')!
			makeVisible(inside)
			const controller = new PageController({ root: scope })
			const state = await controller.getBrowserState()

			expect(controller.getIndexedElementForPolicy(state.indices[0])).toBe(inside)
			expect(controller.getIndexedElementForPolicy(state.indices[0])).not.toBe(outside)

			inside.remove()
			expect(() => controller.getIndexedElementForPolicy(state.indices[0])).toThrow(
				DomRootUnavailableError
			)
		})

		it('rejects local policy lookup after the root resolver replaces its root', async () => {
			let root: HTMLElement | null
			document.body.innerHTML = '<div id="scope"><button>first</button></div>'
			root = document.querySelector<HTMLElement>('#scope')!
			makeVisible(root.querySelector<HTMLElement>('button')!)
			const controller = new PageController({ root: () => root })
			const state = await controller.getBrowserState()

			root.remove()
			document.body.insertAdjacentHTML('beforeend', '<div id="scope"><button>second</button></div>')
			root = document.querySelector<HTMLElement>('#scope')!
			makeVisible(root.querySelector<HTMLElement>('button')!)

			expect(() => controller.getIndexedElementForPolicy(state.indices[0])).toThrow(
				DomRootUnavailableError
			)
		})

		it('uses root dimensions for page info and never falls back to window scroll', async () => {
			document.body.innerHTML = '<div id="scope"><button>inside</button></div>'
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('button')!)
			Object.defineProperties(scope, {
				clientWidth: { configurable: true, value: 300 },
				clientHeight: { configurable: true, value: 200 },
				scrollWidth: { configurable: true, value: 600 },
				scrollHeight: { configurable: true, value: 900 },
				scrollTop: { configurable: true, writable: true, value: 100 },
				scrollLeft: { configurable: true, writable: true, value: 20 },
			})
			const controller = new PageController({ root: scope })
			const state = await controller.getBrowserState()

			expect(state.header).toContain('300x200px viewport')
			expect(state.header).toContain('600x900px total page size')

			const windowScroll = vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined)
			await controller.scroll({ down: true, numPages: 1 })
			expect(windowScroll).not.toHaveBeenCalled()
			windowScroll.mockRestore()
		})

		it('patches React markers only within the configured root', async () => {
			document.body.innerHTML =
				'<div id="app">outside</div><section id="scope"><div id="app"><button>inside</button></div></section>'
			const scope = document.querySelector<HTMLElement>('#scope')!
			const roots = document.querySelectorAll<HTMLElement>('#app')
			const outside = roots[0]
			const inside = roots[1]
			makeVisible(inside.querySelector<HTMLElement>('button')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()

			expect(outside.hasAttribute('data-page-agent-not-interactive')).toBe(false)
			expect(inside.getAttribute('data-page-agent-not-interactive')).toBe('true')
		})

		it('disables arbitrary JavaScript in scoped mode', async () => {
			document.body.innerHTML = '<div id="scope"></div>'
			const scope = document.querySelector<HTMLElement>('#scope')!
			const controller = new PageController({ root: scope })
			const result = await controller.executeJavascript('return 1 + 2')

			expect(result.success).toBe(false)
			expect(result.message).toContain('scoped DOM root')
		})

		it('omits sensitive content subtrees from LLM state', async () => {
			document.body.innerHTML = `
				<section id="scope">
					<div data-page-agent-sensitive>secret subtree text</div>
					<input type="password" value="raw-password" />
					<input name="csrfToken" value="raw-token" />
					<input aria-label="profile field" value="ordinary-pii-value" />
					<button>safe action</button>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('input[aria-label="profile field"]')!)
			makeVisible(scope.querySelector<HTMLElement>('button')!)
			const controller = new PageController({ root: scope })

			const state = await controller.getBrowserState()

			expect(state.content).not.toContain('secret subtree text')
			expect(state.content).not.toContain('raw-password')
			expect(state.content).not.toContain('raw-token')
			expect(state.content).not.toContain('ordinary-pii-value')
			expect(state.content).toContain('profile field')
			expect(state.content).toContain('safe action')
		})

		it('cleans up highlights per controller without clearing another controller', async () => {
			document.body.innerHTML = `
				<section id="scope-a"><button>a</button></section>
				<section id="scope-b"><button>b</button></section>
			`
			const buttonA = document.querySelector<HTMLElement>('#scope-a button')!
			const buttonB = document.querySelector<HTMLElement>('#scope-b button')!
			makeVisible(buttonA)
			makeVisible(buttonB)
			const rect = {
				top: 10,
				left: 10,
				right: 110,
				bottom: 42,
				width: 100,
				height: 32,
				x: 10,
				y: 10,
				toJSON: () => ({}),
			} as DOMRect
			buttonA.getClientRects = () => [rect] as unknown as DOMRectList
			buttonB.getClientRects = () => [rect] as unknown as DOMRectList
			buttonA.getBoundingClientRect = () => rect
			buttonB.getBoundingClientRect = () => rect

			const controllerA = new PageController({
				root: document.querySelector<HTMLElement>('#scope-a')!,
			})
			const controllerB = new PageController({
				root: document.querySelector<HTMLElement>('#scope-b')!,
			})
			await controllerA.updateTree()
			await controllerB.updateTree()

			const container = document.querySelector<HTMLElement>('#playwright-highlight-container')!
			const bothControllers = container.children.length
			expect(bothControllers).toBeGreaterThanOrEqual(2)

			await controllerA.cleanUpHighlights()
			expect(container.children.length).toBeLessThan(bothControllers)
			expect(container.children.length).toBeGreaterThan(0)

			await controllerB.cleanUpHighlights()
			expect(container.children.length).toBe(0)
		})
	})
})
