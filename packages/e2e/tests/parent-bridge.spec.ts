import { expect, type Frame, type Page, test } from '@playwright/test'

interface BrowserState {
	url: string
	title: string
	header: string
	content: string
	footer: string
	treeRevision: number
	indices: number[]
}

interface ActionResult {
	success: boolean
	message: string
}

interface ReverseChildWindow extends Window {
	reverseParentController?: {
		getBrowserState(): Promise<BrowserState>
		clickElement(index: number): Promise<ActionResult>
		inputText(index: number, text: string): Promise<ActionResult>
		selectOption(index: number, optionText: string): Promise<ActionResult>
		scroll(options: { down: boolean; numPages: number; index: number }): Promise<ActionResult>
		cleanUpHighlights(): Promise<void>
		showMask?(): Promise<void>
		hideMask?(): Promise<void>
		executeJavascript(script: string): Promise<ActionResult>
	}
	reverseParentConnection?: Promise<unknown>
	reversePageAgent?: {
		readonly status: string
		readonly history: readonly {
			type: string
			action?: { name: string }
		}[]
	}
}

interface ReverseParentWindow extends Window {
	reverseParentHost?: { controller?: unknown }
}

const parentOrigins = ['http://127.0.0.1:4173', 'http://127.0.0.1:4175'] as const
const childOrigin = 'http://127.0.0.1:4174'

function markerIndex(content: string, pattern: RegExp): number {
	for (const line of content.split('\n')) {
		const match = /^\s*\*?\[(\d+)\](?=<)/.exec(line)
		if (match && pattern.test(line)) return Number(match[1])
	}
	throw new Error(`No indexed element matched ${pattern} in:\n${content}`)
}

async function childFrame(page: Page, origin = childOrigin): Promise<Frame> {
	await expect
		.poll(() =>
			page.frames().find((frame) => frame.url().startsWith(`${origin}/reverse-child.html`))
		)
		.toBeTruthy()
	return page.frames().find((frame) => frame.url().startsWith(`${origin}/reverse-child.html`))!
}

async function connectedChildFrame(page: Page, parentOrigin: string): Promise<Frame> {
	const frame = await childFrame(page)
	await expect(page.locator('#assistant-frame')).toHaveAttribute(
		'sandbox',
		'allow-scripts allow-same-origin'
	)
	await expect(frame.locator('#assistant-root')).toBeVisible()
	await expect
		.poll(() => frame.locator('#assistant-status').textContent(), { timeout: 5_000 })
		.toContain(`connected:${parentOrigin}`)
	await frame.evaluate(async () => {
		const connection = (window as ReverseChildWindow).reverseParentConnection
		if (!connection) throw new Error('Parent bridge connection promise is missing')
		await connection
	})
	return frame
}

async function openParent(
	page: Page,
	parentOrigin: (typeof parentOrigins)[number] = parentOrigins[0]
) {
	await page.goto(`${parentOrigin}/reverse-parent.html`)
	await expect(page).toHaveURL(`${parentOrigin}/reverse-parent.html`)
	await expect
		.poll(() => page.evaluate(() => Boolean((window as ReverseParentWindow).reverseParentHost)))
		.toBe(true)
	return connectedChildFrame(page, parentOrigin)
}

async function state(frame: Frame): Promise<BrowserState> {
	return frame.evaluate(async () => {
		const adapter = (window as ReverseChildWindow).reverseParentController
		if (!adapter) throw new Error('Parent controller adapter has not been installed')
		return adapter.getBrowserState()
	})
}

async function visibleParentHighlightCount(page: Page): Promise<number> {
	return page.evaluate(() => {
		const container = document.querySelector('#playwright-highlight-container')
		if (!container) return 0
		return Array.from(container.children).filter((element) => {
			const style = getComputedStyle(element)
			const rect = element.getBoundingClientRect()
			return (
				style.display !== 'none' &&
				style.visibility !== 'hidden' &&
				style.opacity !== '0' &&
				rect.width > 0 &&
				rect.height > 0
			)
		}).length
	})
}

async function expectNoVisibleParentHighlights(page: Page): Promise<void> {
	await expect.poll(() => visibleParentHighlightCount(page)).toBe(0)
}

test.describe('reverse parent-controller bridge cross-origin fixtures', () => {
	test('observes only the trusted parent root and excludes outside/assistant DOM', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const browserState = await state(frame)

		expect(browserState.content).toContain('parent-button')
		expect(browserState.content).toContain('parent-input')
		expect(browserState.content).not.toContain('outside-host-control')
		expect(browserState.content).not.toContain('assistant-root')
		expect(browserState.content).not.toContain('Vue assistant origin fixture')
	})

	test('renders the assistant as a right-side floating panel beside the rich parent page', async ({
		page,
	}) => {
		await openParent(page)

		await expect(page.locator('[data-testid="parent-demo-dashboard"]')).toBeVisible()
		await expect(page.locator('[data-testid="assistant-floating-panel"]')).toBeVisible()

		const layout = await page.evaluate(() => {
			const assistant = document.querySelector<HTMLIFrameElement>('#assistant-frame')
			const floatingPanel = document.querySelector<HTMLElement>(
				'[data-testid="assistant-floating-panel"]'
			)
			const parentRoot = document.querySelector('#parent-agent-root')
			if (!assistant || !floatingPanel || !parentRoot) {
				throw new Error('Floating assistant fixture markers are missing')
			}

			const viewport = { width: window.innerWidth, height: window.innerHeight }
			const assistantRect = assistant.getBoundingClientRect()
			const panelRect = floatingPanel.getBoundingClientRect()
			return {
				assistant: {
					position: getComputedStyle(assistant).position,
					x: assistantRect.x,
					y: assistantRect.y,
					width: assistantRect.width,
					height: assistantRect.height,
				},
				panel: {
					position: getComputedStyle(floatingPanel).position,
					x: panelRect.x,
					y: panelRect.y,
					width: panelRect.width,
					height: panelRect.height,
				},
				viewport,
				assistantInsideParentRoot: parentRoot.contains(assistant),
				panelInsideParentRoot: parentRoot.contains(floatingPanel),
			}
		})

		expect(layout.assistant.position).toBe('fixed')
		expect(layout.panel.position).toBe('fixed')
		expect(layout.assistant.x).toBeGreaterThan(layout.viewport.width * 0.6)
		expect(layout.assistant.x + layout.assistant.width).toBeGreaterThan(layout.viewport.width * 0.9)
		expect(layout.assistant.width / layout.viewport.width).toBeGreaterThanOrEqual(0.18)
		expect(layout.assistant.width / layout.viewport.width).toBeLessThanOrEqual(0.35)
		expect(layout.assistant.height / layout.viewport.height).toBeGreaterThanOrEqual(0.7)
		expect(layout.assistant.height / layout.viewport.height).toBeLessThanOrEqual(0.9)
		expect(layout.assistantInsideParentRoot).toBe(false)
		expect(layout.panelInsideParentRoot).toBe(false)
		await expectNoVisibleParentHighlights(page)
	})

	test('routes parent-root actions while denying JavaScript', async ({ page }) => {
		const frame = await openParent(page)
		const browserState = await state(frame)
		const buttonIndex = markerIndex(browserState.content, /<button[^>]*id=parent-button/)
		const inputIndex = markerIndex(browserState.content, /<input[^>]*id=parent-input/)

		const clickResult = await frame.evaluate(
			async (index) => (window as ReverseChildWindow).reverseParentController!.clickElement(index),
			buttonIndex
		)
		expect(clickResult.success).toBe(true)
		await expect(page.locator('#parent-click-result')).toHaveText('clicked')

		const inputResult = await frame.evaluate(
			async (index) =>
				(window as ReverseChildWindow).reverseParentController!.inputText(index, 'bridge-input'),
			inputIndex
		)
		expect(inputResult.success).toBe(true)
		await expect(page.locator('#parent-input')).toHaveValue('bridge-input')
		expect(inputResult.message).not.toContain('bridge-input')

		const scriptResult = await frame.evaluate(async () => {
			const adapter = (window as ReverseChildWindow).reverseParentController
			if (!adapter) throw new Error('Parent controller adapter has not been installed')
			return adapter.executeJavascript('return document.title')
		})
		expect(scriptResult.success).toBe(false)
		expect(scriptResult.message).toContain('CAPABILITY_DENIED')
	})

	test('exposes working controls in the runnable demo', async ({ page }) => {
		const frame = await openParent(page)

		await frame.locator('#assistant-run-click').click()
		await expect(page.locator('#parent-click-result')).toHaveText('clicked')

		await frame.locator('#assistant-run-input').click()
		await expect(page.locator('#parent-input')).toHaveValue('bridge-input')

		await frame.locator('#assistant-run-select').click()
		await expect(page.locator('#parent-select')).toHaveValue('Pro')

		await frame.locator('#assistant-run-scroll').click()
		await expect
			.poll(() => page.locator('#parent-scroll').evaluate((element) => element.scrollTop))
			.toBeGreaterThan(0)

		await frame.locator('#assistant-run-script').click()
		await expect(frame.locator('#assistant-status')).toHaveText('script:false')
	})

	test('runs PageAgent in the child against a same-origin Tl service and controls the parent', async ({
		page,
	}) => {
		const tlResponses: { url: string; allowOrigin: string | null }[] = []
		page.on('response', (response) => {
			if (!response.url().includes('/api/tl/chatbbc/')) return
			tlResponses.push({
				url: response.url(),
				allowOrigin: response.headers()['access-control-allow-origin'] ?? null,
			})
		})

		const frame = await openParent(page)
		await expect(frame.locator('#assistant-run-agent')).toBeEnabled()
		await frame.locator('#assistant-run-agent').click()

		await expect(page.locator('#parent-click-result')).toHaveText('clicked')
		await expect(page.locator('#parent-input')).toHaveValue('PageAgent Demo')
		await expect(page.locator('#parent-select')).toHaveValue('Pro')
		await expect(frame.locator('#assistant-agent-status')).toHaveText('agent:completed:true')
		await expect(frame.locator('#assistant-agent-result')).toContainText('父页面操作已完成')
		await expectNoVisibleParentHighlights(page)

		const actions = await frame.evaluate(
			() =>
				(window as ReverseChildWindow).reversePageAgent?.history
					.filter((event) => event.type === 'step')
					.map((event) => event.action?.name)
		)
		expect(actions).toEqual([
			'click_element_by_index',
			'input_text',
			'select_dropdown_option',
			'done',
		])

		await expect.poll(() => tlResponses.length).toBe(8)
		for (const response of tlResponses) {
			expect(new URL(response.url).origin).toBe(childOrigin)
			expect(response.allowOrigin).toBeNull()
		}
	})

	test('cleans parent highlights after every manual bridge operation', async ({ page }) => {
		const frame = await openParent(page)
		const operations = [
			{ control: '#assistant-run-observe', status: /observed:/ },
			{ control: '#assistant-run-click', status: 'click:true' },
			{ control: '#assistant-run-input', status: 'input:true' },
			{ control: '#assistant-run-select', status: 'select:true' },
			{ control: '#assistant-run-scroll', status: 'scroll:true' },
		] as const

		for (const operation of operations) {
			await frame.locator(operation.control).click()
			if (typeof operation.status === 'string') {
				await expect(frame.locator('#assistant-status')).toHaveText(operation.status)
			} else {
				await expect(frame.locator('#assistant-status')).toHaveText(operation.status)
			}
			await expectNoVisibleParentHighlights(page)
		}
	})

	test('cleans parent highlights when PageAgent is stopped', async ({ page }) => {
		let chatRequestStarted = false
		await page.route('**/api/tl/chatbbc/chat', async (route) => {
			chatRequestStarted = true
			await new Promise((resolve) => setTimeout(resolve, 1_000))
			try {
				await route.continue()
			} catch {
				// The request may be aborted by PageAgent.stop().
			}
		})

		const frame = await openParent(page)
		await expect(frame.locator('#assistant-run-agent')).toBeEnabled()
		await frame.locator('#assistant-run-agent').click()
		await expect.poll(() => chatRequestStarted).toBe(true)
		await expect(frame.locator('#assistant-stop-agent')).toBeEnabled()
		await frame.locator('#assistant-stop-agent').click()
		await expect(frame.locator('#assistant-agent-status')).toContainText('agent:stopped')
		await expectNoVisibleParentHighlights(page)
	})

	test('cleans parent highlights when PageAgent reports an error', async ({ page }) => {
		await page.route('**/api/tl/chatbbc/chat', async (route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'intentional reverse bridge error' }),
			})
		})

		const frame = await openParent(page)
		await expect(frame.locator('#assistant-run-agent')).toBeEnabled()
		await frame.locator('#assistant-run-agent').click()
		await expect(frame.locator('#assistant-agent-status')).toContainText('agent:error')
		await expectNoVisibleParentHighlights(page)
	})

	test('invalidates stale indices after parent root replacement', async ({ page }) => {
		const frame = await openParent(page)
		const firstState = await state(frame)
		const buttonIndex = markerIndex(firstState.content, /<button[^>]*id=parent-button/)

		await page.locator('#replace-parent-root').click()
		const staleResult = await frame.evaluate(
			async (index) => (window as ReverseChildWindow).reverseParentController!.clickElement(index),
			buttonIndex
		)
		expect(staleResult.success).toBe(false)
		expect(staleResult.message).toMatch(/root|DOM|stale/i)

		const replacementState = await state(frame)
		expect(replacementState.treeRevision).toBeGreaterThan(firstState.treeRevision)
		expect(replacementState.content).toContain('replacement')
	})

	test('uses the same child origin from a second parent deployment origin', async ({ page }) => {
		const frame = await openParent(page, parentOrigins[1])
		const browserState = await state(frame)
		expect(browserState.content).toContain('parent-button')
		await expect(frame.locator('#assistant-status')).toContainText(parentOrigins[1])
	})

	test('rejects an offer when the child expects a different parent origin', async ({ page }) => {
		await page.goto(
			`${parentOrigins[1]}/reverse-parent.html?childExpectedParentOrigin=${encodeURIComponent(
				parentOrigins[0]
			)}`
		)
		const frame = await childFrame(page)
		await expect
			.poll(() => frame.locator('#assistant-status').textContent(), { timeout: 3_000 })
			.toMatch(/error:(EMBED_POLICY_DENIED|TIMEOUT|CONNECTION_CLOSED)/)
	})

	test('does not authorize a sibling iframe source', async ({ page }) => {
		const target = await openParent(page)
		const sibling = page
			.frames()
			.find(
				(frame) =>
					frame !== target &&
					frame.url().includes('/reverse-child.html') &&
					frame.url().includes('role=sibling')
			)
		const wrongSource = page
			.frames()
			.find(
				(frame) =>
					frame !== target &&
					frame.url().includes('/reverse-child.html') &&
					frame.url().includes('role=wrong-source')
			)
		expect(sibling).toBeTruthy()
		expect(wrongSource).toBeTruthy()
		await expect(sibling!.locator('#assistant-status')).not.toContainText('connected:', {
			timeout: 1_500,
		})
		await expect(wrongSource!.locator('#assistant-status')).not.toContainText('connected:', {
			timeout: 1_500,
		})
	})

	test('keeps visual feedback non-blocking for the child controls', async ({ page }) => {
		const frame = await openParent(page)
		await frame.evaluate(async () => {
			await (window as ReverseChildWindow).reverseParentController?.showMask?.()
		})

		const feedback = page.locator('[data-page-agent-parent-feedback]')
		expect(await feedback.count()).toBeGreaterThan(0)
		await expect(feedback.first()).toHaveCSS('pointer-events', 'none')

		await frame.locator('#assistant-run-click').click()
		await expect(page.locator('#parent-click-result')).toHaveText('clicked')
		await expectNoVisibleParentHighlights(page)
		const cursor = page.locator('[data-page-agent-parent-cursor]')
		await expect(cursor).toHaveCount(1)
		await expect(cursor).toBeHidden()

		await frame.evaluate(async () => {
			await (window as ReverseChildWindow).reverseParentController?.showMask?.()
		})
		const rootBox = await page.locator('#parent-agent-root').boundingBox()
		expect(rootBox).not.toBeNull()
		const pointer = { x: rootBox!.x + rootBox!.width / 2, y: rootBox!.y + rootBox!.height / 2 }
		await page.evaluate(({ x, y }) => {
			window.dispatchEvent(new CustomEvent('PageAgent::MovePointerTo', { detail: { x, y } }))
			window.dispatchEvent(new CustomEvent('PageAgent::ClickPointer'))
		}, pointer)
		await expect(cursor).toBeVisible()
		await expect(cursor).toHaveCSS('position', 'fixed')
		await expect(cursor).toHaveCSS('pointer-events', 'none')
		await expect(cursor).toHaveClass(/page-agent-parent-cursor-clicking/)
		await expect(cursor.locator('[data-page-agent-parent-cursor-ripple]')).toHaveCount(1)
		const palette = await cursor.evaluate((element) => {
			const pointer = element.querySelector<HTMLElement>('[data-page-agent-parent-cursor-pointer]')
			const ripple = element.querySelector<HTMLElement>('[data-page-agent-parent-cursor-ripple]')
			if (!pointer || !ripple) throw new Error('Parent cursor presentation is incomplete')
			return {
				fill: getComputedStyle(pointer, '::before').backgroundColor,
				stroke: getComputedStyle(pointer, '::after').backgroundImage,
				ripple: getComputedStyle(ripple, '::after').borderTopColor,
				width: getComputedStyle(element).width,
				height: getComputedStyle(element).height,
			}
		})
		expect(palette.fill).toBe('rgb(255, 255, 255)')
		expect(palette.stroke).toContain('linear-gradient')
		expect(palette.stroke).toContain('rgb(57, 182, 255)')
		expect(palette.stroke).toContain('rgb(189, 69, 251)')
		expect(palette.ripple).toBe('rgb(57, 182, 255)')
		expect(palette.width).toBe('75px')
		expect(palette.height).toBe('75px')

		const cursorBox = await cursor.boundingBox()
		expect(cursorBox).not.toBeNull()
		expect(cursorBox!.x).toBeGreaterThanOrEqual(rootBox!.x)
		expect(cursorBox!.y).toBeGreaterThanOrEqual(rootBox!.y)
		expect(cursorBox!.x).toBeLessThan(rootBox!.x + rootBox!.width)
		expect(cursorBox!.y).toBeLessThan(rootBox!.y + rootBox!.height)

		await frame.evaluate(async () => {
			await (window as ReverseChildWindow).reverseParentController?.hideMask?.()
		})
		await expect(cursor).toBeHidden()
		await frame.locator('#assistant-run-observe').click()
		await expect(frame.locator('#assistant-status')).toContainText('observed:')
		await expectNoVisibleParentHighlights(page)
	})
})
