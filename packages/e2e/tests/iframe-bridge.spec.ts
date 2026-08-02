import { expect, type Page, test } from '@playwright/test'

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

interface ControllerHandle {
	getBrowserState(): Promise<BrowserState>
	clickElement(index: number): Promise<ActionResult>
	inputText(index: number, text: string): Promise<ActionResult>
	selectOption(index: number, optionText: string): Promise<ActionResult>
	scroll(options: { down: boolean; numPages: number; index?: number }): Promise<ActionResult>
	frameClients: readonly {
		iframe: HTMLIFrameElement
		origin: string | null
		executeJavascript(script?: string): Promise<ActionResult>
	}[]
}

type WindowWithController = Window & {
	pageController?: ControllerHandle
}

const hostOrigin = 'http://127.0.0.1:4173'
const childOrigin = 'http://127.0.0.1:4174'

function markerIndex(content: string, pattern: RegExp): number {
	for (const line of content.split('\n')) {
		const match = /^\s*\*?\[(\d+)\](?=<)/.exec(line)
		if (match && pattern.test(line)) return Number(match[1])
	}
	throw new Error(`No indexed element matched ${pattern} in:\n${content}`)
}

async function controller(page: Page): Promise<BrowserState> {
	return page.evaluate(async () => {
		const pageController = (window as WindowWithController).pageController
		if (!pageController) throw new Error('FrameAwarePageController has not been installed')
		return pageController.getBrowserState()
	})
}

async function action(
	page: Page,
	method: 'clickElement' | 'inputText' | 'selectOption' | 'scroll',
	args: unknown[]
): Promise<ActionResult> {
	return page.evaluate(
		async ({ method, args }) => {
			const pageController = (window as WindowWithController).pageController
			if (!pageController) throw new Error('FrameAwarePageController has not been installed')
			if (method === 'clickElement') return pageController.clickElement(args[0] as number)
			if (method === 'inputText')
				return pageController.inputText(args[0] as number, args[1] as string)
			if (method === 'selectOption')
				return pageController.selectOption(args[0] as number, args[1] as string)
			return pageController.scroll(args[0] as { index: number; down: boolean; numPages: number })
		},
		{ method, args }
	)
}

async function cooperativeFrame(page: Page) {
	await expect
		.poll(() => page.frames().find((frame) => frame.url().startsWith(`${childOrigin}/child.html`)))
		.toBeTruthy()
	return page.frames().find((frame) => frame.url().startsWith(`${childOrigin}/child.html`))!
}

test.describe('cross-origin iframe bridge', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/host.html')
		await expect(page).toHaveURL(`${hostOrigin}/host.html`)
		await expect
			.poll(() => page.evaluate(() => Boolean((window as WindowWithController).pageController)))
			.toBe(true)
		const frame = await cooperativeFrame(page)
		await expect
			.poll(() =>
				frame.evaluate(() =>
					Boolean((window as Window & { frameBridgeHost?: unknown }).frameBridgeHost)
				)
			)
			.toBe(true)
	})

	test('aggregates local and cooperative observations while preserving an unavailable frame', async ({
		page,
	}) => {
		const state = await controller(page)

		expect(state.url).toBe(`${hostOrigin}/host.html`)
		expect(state.content).toContain('id=local-button')
		expect(state.content).toContain('Remote button')
		expect(state.content).toContain('<cross-origin-frame src="http://127.0.0.1:4174/child.html"')
		expect(state.content).toContain('unavailable="true"')
		expect(state.content).toContain('Frame unavailable:')
		expect(state.indices.length).toBeGreaterThan(3)
	})

	test('routes remote click, input, select, and synthetic document scroll actions', async ({
		page,
	}) => {
		const state = await controller(page)
		const remoteButton = markerIndex(state.content, /<button[^>]*id=remote-button/)
		const remoteInput = markerIndex(state.content, /<input[^>]*id=remote-input/)
		const remoteSelect = markerIndex(state.content, /<select[^>]*id=remote-select/)
		const remoteDocument = markerIndex(state.content, /<iframe-document>/)
		const frame = await cooperativeFrame(page)

		expect((await action(page, 'clickElement', [remoteButton])).success).toBe(true)
		expect((await frame.locator('#remote-button').getAttribute('data-clicked')) ?? '').toBe('true')

		expect((await action(page, 'inputText', [remoteInput, 'from parent'])).success).toBe(true)
		expect(await frame.locator('#remote-input').inputValue()).toBe('from parent')

		expect((await action(page, 'selectOption', [remoteSelect, 'Beta'])).success).toBe(true)
		expect(await frame.locator('#remote-select').inputValue()).toBe('Beta')

		const beforeScroll = await frame.evaluate(() => window.scrollY)
		const scrollResult = await action(page, 'scroll', [
			{ index: remoteDocument, down: true, numPages: 1 },
		])
		expect(scrollResult.success).toBe(true)
		await expect.poll(() => frame.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll)
	})

	test('does not expose remote executeJavascript', async ({ page }) => {
		await controller(page)
		const result = await page.evaluate(async () => {
			const pageController = (window as WindowWithController).pageController
			if (!pageController) throw new Error('FrameAwarePageController has not been installed')
			const client = pageController.frameClients.find(
				(candidate) => candidate.iframe.id === 'cooperative-frame'
			)
			if (!client) throw new Error('Cooperative frame client was not connected')
			try {
				await client.executeJavascript('document.body.dataset.remoteExecuted = "true"')
				return { success: true, code: null }
			} catch (error) {
				return {
					success: false,
					code: (error as { code?: string }).code ?? null,
				}
			}
		})

		expect(result).toEqual({ success: false, code: 'CAPABILITY_DENIED' })
		const frame = await cooperativeFrame(page)
		expect(await frame.evaluate(() => document.body.dataset.remoteExecuted)).toBeUndefined()
	})

	test('runs all remote actions through the visual demo controls', async ({ page }) => {
		const frame = await cooperativeFrame(page)
		const refreshButton = page.getByRole('button', { name: 'Refresh browser state' })

		await refreshButton.click()
		await expect(page.locator('#browser-state')).toContainText('cross-origin-frames')
		await expect(page.locator('#browser-state')).toContainText('id=remote-button')
		await expect(page.locator('.frame-badge.cooperative')).toBeVisible()
		await expect(page.locator('.frame-badge.unavailable')).toBeVisible()

		const initialState = JSON.parse(
			(await page.locator('#browser-state').textContent()) ?? '{}'
		) as BrowserState
		const remoteClickButton = page.getByRole('button', { name: 'Click remote button' })
		await refreshButton.click()
		await expect(remoteClickButton).toBeDisabled()
		await expect(remoteClickButton).toBeEnabled()

		await remoteClickButton.click()
		await expect(frame.locator('#remote-button')).toHaveAttribute('data-clicked', 'true')
		await expect
			.poll(async () => {
				try {
					return (
						JSON.parse((await page.locator('#browser-state').textContent()) ?? '{}') as BrowserState
					).treeRevision
				} catch {
					return initialState.treeRevision
				}
			})
			.toBeGreaterThan(initialState.treeRevision)
		const latestState = JSON.parse(
			(await page.locator('#browser-state').textContent()) ?? '{}'
		) as BrowserState
		expect(latestState.content).not.toContain('id=browser-state')

		await page.getByLabel('Remote input text').fill('from visual controls')
		await page.getByRole('button', { name: 'Send text to remote input' }).click()
		await expect(frame.locator('#remote-input')).toHaveValue('from visual controls')

		await page.getByLabel('Remote select option').selectOption('Beta')
		await page.getByRole('button', { name: 'Select remote option' }).click()
		await expect(frame.locator('#remote-select')).toHaveValue('Beta')

		const beforeScroll = await frame.evaluate(() => window.scrollY)
		await page.getByRole('button', { name: 'Scroll remote document' }).click()
		await expect.poll(() => frame.evaluate(() => window.scrollY)).toBeGreaterThan(beforeScroll)
	})
})
