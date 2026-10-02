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

	describe('extractFormData', () => {
		const makeVisible = (element: HTMLElement) => {
			Object.defineProperties(element, {
				offsetWidth: { configurable: true, value: 120 },
				offsetHeight: { configurable: true, value: 32 },
			})
		}

		it('extracts basic form fields with name, value, and label', async () => {
			document.body.innerHTML = `
				<section id="scope">
					<label for="username">Username</label>
					<input id="username" name="user" value="alice" />
					<select name="role">
						<option>Admin</option>
						<option selected>Editor</option>
					</select>
					<textarea name="notes">some notes</textarea>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('input')!)
			makeVisible(scope.querySelector<HTMLElement>('select')!)
			makeVisible(scope.querySelector<HTMLElement>('textarea')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			expect(fields.length).toBe(3)

			const inputField = fields.find((f) => f.name === 'user')
			expect(inputField).toBeDefined()
			expect(inputField!.tagName).toBe('input')
			expect(inputField!.value).toBe('alice')
			expect(inputField!.label).toBe('Username')

			const selectField = fields.find((f) => f.name === 'role')
			expect(selectField).toBeDefined()
			expect(selectField!.tagName).toBe('select')
			expect(selectField!.options).toContain('Admin')
			expect(selectField!.options).toContain('Editor')

			const textareaField = fields.find((f) => f.name === 'notes')
			expect(textareaField).toBeDefined()
			expect(textareaField!.tagName).toBe('textarea')
			expect(textareaField!.value).toBe('some notes')
		})

		it('excludes fields marked with data-page-agent-no-export', async () => {
			document.body.innerHTML = `
				<section id="scope">
					<input name="visible" value="ok" />
					<input name="hidden" value="secret" data-page-agent-no-export />
					<div data-page-agent-no-export>
						<input name="nested-hidden" value="also-secret" />
					</div>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			for (const el of scope.querySelectorAll<HTMLElement>('input')) makeVisible(el)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			expect(fields.some((f) => f.name === 'visible')).toBe(true)
			expect(fields.some((f) => f.name === 'hidden')).toBe(false)
			expect(fields.some((f) => f.name === 'nested-hidden')).toBe(false)
		})

		it('handles checkbox and radio fields', async () => {
			document.body.innerHTML = `
				<section id="scope">
					<input type="checkbox" name="agree" checked />
					<input type="radio" name="color" value="red" />
					<input type="radio" name="color" value="blue" checked />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			for (const el of scope.querySelectorAll<HTMLElement>('input')) makeVisible(el)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const checkbox = fields.find((f) => f.name === 'agree')
			expect(checkbox).toBeDefined()
			expect(checkbox!.checked).toBe(true)

			const radios = fields.filter((f) => f.name === 'color')
			expect(radios.length).toBe(2)
			const checkedRadio = radios.find((f) => f.checked)
			expect(checkedRadio!.value).toBe('blue')
		})

		it('returns empty array when no form fields exist', async () => {
			document.body.innerHTML = `
				<section id="scope">
					<button>Click me</button>
					<a href="#">Link</a>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('button')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			expect(fields).toEqual([])
		})

		it('throws when tree is not indexed', async () => {
			document.body.innerHTML = '<section id="scope"><input /></section>'
			const scope = document.querySelector<HTMLElement>('#scope')!
			const controller = new PageController({ root: scope })

			await expect(controller.extractFormData()).rejects.toThrow('not indexed')
		})

		it('suppresses label text that is inside a data-page-agent-sensitive subtree', async () => {
			// Bug 1 regression: resolveLabel must not leak text from sensitive nodes
			document.body.innerHTML = `
				<section id="scope">
					<label for="field-a">
						<span data-page-agent-sensitive>SECRET</span>
						Public Label
					</label>
					<input id="field-a" name="field-a" value="v" />
					<label for="field-b" data-page-agent-sensitive>Fully Sensitive Label</label>
					<input id="field-b" name="field-b" value="w" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			for (const el of scope.querySelectorAll<HTMLElement>('input')) makeVisible(el)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const fieldA = fields.find((f) => f.name === 'field-a')
			expect(fieldA?.label).toBe('Public Label')
			// The sensitive span text must NOT appear in the label
			expect(fieldA?.label).not.toContain('SECRET')

			const fieldB = fields.find((f) => f.name === 'field-b')
			// Entire label is sensitive — should produce no label text
			expect(fieldB?.label).toBeUndefined()
		})

		it('suppresses label text inside a data-page-agent-no-export subtree', async () => {
			// Bug 1 regression: no-export boundary must also be respected for labels
			document.body.innerHTML = `
				<section id="scope">
					<label for="field-c" data-page-agent-no-export>No-Export Label</label>
					<input id="field-c" name="field-c" value="x" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('input')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const fieldC = fields.find((f) => f.name === 'field-c')
			expect(fieldC?.label).toBeUndefined()
		})

		it('captures all selected options for a multi-select element', async () => {
			// Bug 5 regression: select.value only returns first selected item
			document.body.innerHTML = `
				<section id="scope">
					<select name="tags" multiple>
						<option value="a">Alpha</option>
						<option value="b" selected>Beta</option>
						<option value="c" selected>Gamma</option>
						<option value="d">Delta</option>
					</select>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('select')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const selectField = fields.find((f) => f.name === 'tags')
			expect(selectField).toBeDefined()
			// Both selected options must appear in the value string using their option values
			expect(selectField!.value).toContain('b')
			expect(selectField!.value).toContain('c')
			// Non-selected options must not appear in the value
			expect(selectField!.value).not.toContain('a')
			expect(selectField!.value).not.toContain('d')
			// All options (candidates) must still be listed with their display texts
			expect(selectField!.options).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta'])
		})

		it('strips sensitive text nested inside an aria-labelledby target element', async () => {
			// P1-1 regression: aria-labelledby ref containing sensitive child nodes
			// must not leak those nodes' text into the extracted label.
			document.body.innerHTML = `
				<section id="scope">
					<span id="label-with-secret">
						Public text
						<span data-page-agent-sensitive>SECRET</span>
					</span>
					<input id="field-x" name="field-x" aria-labelledby="label-with-secret" value="v" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('input')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'field-x')
			expect(field?.label).toContain('Public text')
			expect(field?.label).not.toContain('SECRET')
		})

		it('suppresses entire aria-labelledby label when the ref element itself is blocked', async () => {
			// P1-1 regression: when the ref element is fully sensitive the label must be undefined.
			document.body.innerHTML = `
				<section id="scope">
					<span id="sensitive-label" data-page-agent-sensitive>Fully Secret Label</span>
					<input id="field-y" name="field-y" aria-labelledby="sensitive-label" value="w" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('input')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'field-y')
			expect(field?.label).toBeUndefined()
		})

		it('excludes sensitive <option> elements from field.options and field.value', async () => {
			// P1-2 regression: <option data-page-agent-sensitive> text must not
			// appear in the extracted options list or selected value.
			document.body.innerHTML = `
				<section id="scope">
					<select name="color" multiple>
						<option value="a">Alpha</option>
						<option value="s" data-page-agent-sensitive selected>SECRET OPTION</option>
						<option value="b" selected>Beta</option>
					</select>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('select')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'color')
			expect(field).toBeDefined()
			// Sensitive option must not appear in candidates list
			expect(field!.options).not.toContain('SECRET OPTION')
			expect(field!.options).toContain('Alpha')
			expect(field!.options).toContain('Beta')
			// Sensitive option must not appear in the selected value
			expect(field!.value).not.toContain('s')
			expect(field!.value).toContain('b')
		})

		it('suppresses selected value when the selected option is marked sensitive', async () => {
			// P1-2 regression: single-select where the currently selected option is
			// sensitive must not leak the value.
			document.body.innerHTML = `
				<section id="scope">
					<select name="tier">
						<option value="a">Public</option>
						<option value="s" selected data-page-agent-sensitive>Secret Tier</option>
					</select>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('select')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'tier')
			expect(field).toBeDefined()
			expect(field!.value).toBe('')
			expect(field!.options).not.toContain('Secret Tier')
			expect(field!.options).toContain('Public')
		})

		it('strips child nodes matching contentBlacklist from label text', async () => {
			// Issue 1 regression: spans in contentBlacklist inside <label> must not leak text
			document.body.innerHTML = `
				<section id="scope">
					<label for="field-secret-child">
						Visible Label
						<span id="secret-span">SECRET</span>
					</label>
					<input id="field-secret-child" name="field-secret-child" value="hello" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const secretSpan = document.querySelector<HTMLElement>('#secret-span')!
			makeVisible(scope.querySelector<HTMLElement>('input')!)

			const controller = new PageController({
				root: scope,
				contentBlacklist: [secretSpan],
			})
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'field-secret-child')
			expect(field).toBeDefined()
			expect(field!.label).toContain('Visible Label')
			expect(field!.label).not.toContain('SECRET')
		})

		it('excludes fields marked sensitive after tree update', async () => {
			// Issue 2 regression: element dynamically marked sensitive after indexing
			document.body.innerHTML = `
				<section id="scope">
					<input id="dynamic-field" name="dynamic-field" value="secret-val" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const input = scope.querySelector<HTMLElement>('input')!
			makeVisible(input)

			const controller = new PageController({ root: scope })
			await controller.updateTree()

			// Dynamically mark sensitive after indexing, before extractFormData is called
			input.setAttribute('data-page-agent-sensitive', '')

			const fields = await controller.extractFormData()
			const field = fields.find((f) => f.name === 'dynamic-field')
			expect(field).toBeUndefined()
		})

		it('excludes fields moved outside root after tree update', async () => {
			// Issue 2 regression: element moved outside configured root after indexing
			document.body.innerHTML = `
				<div id="outside"></div>
				<section id="scope">
					<input id="moved-field" name="moved-field" value="outside-val" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const outside = document.querySelector<HTMLElement>('#outside')!
			const input = scope.querySelector<HTMLElement>('input')!
			makeVisible(input)

			const controller = new PageController({ root: scope })
			await controller.updateTree()

			// Move element outside configured root
			outside.appendChild(input)

			const fields = await controller.extractFormData()
			const field = fields.find((f) => f.name === 'moved-field')
			expect(field).toBeUndefined()
		})

		it('extracts programmatic option value and preserves display text in field.options', async () => {
			// Issue 3 regression: <option value="42">Account</option> returns value="42"
			document.body.innerHTML = `
				<section id="scope">
					<select name="account-type">
						<option value="42" selected>Account</option>
						<option value="99">Savings</option>
					</select>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			makeVisible(scope.querySelector<HTMLElement>('select')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'account-type')
			expect(field).toBeDefined()
			expect(field!.value).toBe('42')
			expect(field!.options).toEqual(['Account', 'Savings'])
		})

		it('excludes dynamically mutated password and token fields', async () => {
			// Issue 1 regression: input dynamically mutated to password after indexing
			document.body.innerHTML = `
				<section id="scope">
					<input id="pwd-field" name="regular-name" value="secret-password-123" />
					<input id="token-field" name="user-token" value="sensitive-jwt-token" />
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const pwdInput = scope.querySelector<HTMLInputElement>('#pwd-field')!
			const tokenInput = scope.querySelector<HTMLInputElement>('#token-field')!
			makeVisible(pwdInput)
			makeVisible(tokenInput)

			const controller = new PageController({ root: scope })
			await controller.updateTree()

			// Mutate pwd field to password dynamically
			pwdInput.type = 'password'

			const fields = await controller.extractFormData()
			expect(fields.find((f) => f.name === 'regular-name')).toBeUndefined()
			expect(fields.find((f) => f.name === 'user-token')).toBeUndefined()
		})

		it('ignores label references located outside the configured root', async () => {
			// Issue 2 regression: aria-labelledby or label[for] pointing to elements outside root
			document.body.innerHTML = `
				<header id="external-header">
					<span id="external-title">External Header Text</span>
					<label for="scoped-input">External Explicit Label</label>
				</header>
				<main id="scoped-main">
					<input id="scoped-input" name="scoped-input" aria-labelledby="external-title" value="v1" />
				</main>
			`
			const main = document.querySelector<HTMLElement>('#scoped-main')!
			const input = main.querySelector<HTMLElement>('#scoped-input')!
			makeVisible(input)

			const controller = new PageController({ root: main })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'scoped-input')
			expect(field).toBeDefined()
			// Neither external aria-labelledby nor external label[for] should be read
			expect(field?.label).toBeUndefined()
		})

		it('retains form fields inside open Shadow DOM within the configured root', async () => {
			// Issue 3 regression: fields inside open ShadowRoot must not be dropped by boundary check
			document.body.innerHTML = `
				<section id="scope">
					<div id="shadow-host"></div>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const host = scope.querySelector<HTMLElement>('#shadow-host')!
			const shadow = host.attachShadow({ mode: 'open' })
			const shadowInput = document.createElement('input')
			shadowInput.setAttribute('id', 'shadow-input')
			shadowInput.setAttribute('name', 'shadow-field')
			shadowInput.value = 'shadow-value'
			shadow.appendChild(shadowInput)

			makeVisible(host)
			makeVisible(shadowInput)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'shadow-field')
			expect(field).toBeDefined()
			expect(field?.value).toBe('shadow-value')
		})

		it('blocks fields inside a shadow root when the shadow host is marked sensitive', async () => {
			// Issue 3 + 1 regression: host element marked sensitive blocks its shadow DOM descendants
			document.body.innerHTML = `
				<section id="scope">
					<div id="sensitive-host" data-page-agent-sensitive></div>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const host = scope.querySelector<HTMLElement>('#sensitive-host')!
			const shadow = host.attachShadow({ mode: 'open' })
			const shadowInput = document.createElement('input')
			shadowInput.setAttribute('name', 'nested-sensitive')
			shadowInput.value = 'should-not-export'
			shadow.appendChild(shadowInput)

			makeVisible(host)
			makeVisible(shadowInput)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			expect(fields.find((f) => f.name === 'nested-sensitive')).toBeUndefined()
		})

		it('strips sensitive descendant text inside options and falls back to safe text for value', async () => {
			// Issue 1 regression: option dynamically appended with sensitive child elements
			document.body.innerHTML = `
				<section id="scope">
					<select name="tier">
						<option id="opt-standard" selected>Standard </option>
						<option id="opt-vip" value="vip">VIP </option>
					</select>
				</section>
			`
			const scope = document.querySelector<HTMLElement>('#scope')!
			const optStandard = scope.querySelector<HTMLOptionElement>('#opt-standard')!
			const optVip = scope.querySelector<HTMLOptionElement>('#opt-vip')!

			// Dynamically append sensitive child nodes
			const noExportSpan = document.createElement('span')
			noExportSpan.setAttribute('data-page-agent-no-export', '')
			noExportSpan.textContent = 'INTERNAL NOTE'
			optStandard.appendChild(noExportSpan)

			const sensitiveSpan = document.createElement('span')
			sensitiveSpan.setAttribute('data-page-agent-sensitive', '')
			sensitiveSpan.textContent = 'SECRET'
			optVip.appendChild(sensitiveSpan)

			makeVisible(scope.querySelector<HTMLElement>('select')!)

			const controller = new PageController({ root: scope })
			await controller.updateTree()
			const fields = await controller.extractFormData()

			const field = fields.find((f) => f.name === 'tier')
			expect(field).toBeDefined()
			// Options display text must strip sensitive child text
			expect(field!.options).toEqual(['Standard', 'VIP'])
			// Without explicit value attribute, value must use safe text rather than leaking INTERNAL NOTE
			expect(field!.value).toBe('Standard')
		})

		it('does not crash when a form contains an input named "type"', async () => {
			// Issue 2 regression: HTMLFormElement named getter form.type shadows property
			document.body.innerHTML = `
				<form id="scope">
					<input name="type" value="user-type-data" />
					<input name="email" value="user@example.com" />
				</form>
			`
			const form = document.querySelector<HTMLFormElement>('#scope')!
			for (const input of form.querySelectorAll('input')) makeVisible(input)

			const controller = new PageController({ root: form })
			await controller.updateTree()

			// Must not throw TypeError: (el as HTMLInputElement).type?.toLowerCase is not a function
			let fields: any[] = []
			await expect(
				(async () => {
					fields = await controller.extractFormData()
				})()
			).resolves.not.toThrow()

			expect(fields.find((f) => f.name === 'type')?.value).toBe('user-type-data')
			expect(fields.find((f) => f.name === 'email')?.value).toBe('user@example.com')
		})

		it('fails closed and invalidates tree when root becomes unavailable', async () => {
			// Issue 3 regression: dynamic root getter returning null must throw DomRootUnavailableError
			let currentRoot: HTMLElement | null = document.createElement('div')
			document.body.appendChild(currentRoot)
			currentRoot.innerHTML = '<input name="test-field" value="test-val" />'
			makeVisible(currentRoot.querySelector('input')!)

			const controller = new PageController({ root: () => currentRoot })
			await controller.updateTree()

			// Disconnect root element so getter returns null or disconnected
			document.body.removeChild(currentRoot)
			currentRoot = null

			// extractFormData must throw DomRootUnavailableError rather than masking as []
			await expect(controller.extractFormData()).rejects.toThrow()
			// Controller must be invalidated
			await expect(controller.extractFormData()).rejects.toThrow('not indexed')
		})
	})
})
