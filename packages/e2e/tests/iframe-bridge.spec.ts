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

interface ControllerHandle {
	getBrowserState(): Promise<BrowserState>
	clickElement(index: number): Promise<ActionResult>
	inputText(index: number, text: string): Promise<ActionResult>
	selectOption(index: number, optionText: string): Promise<ActionResult>
	scroll(options: { down: boolean; numPages: number; index?: number }): Promise<ActionResult>
	scrollHorizontally(options: {
		right: boolean
		pixels: number
		index?: number
	}): Promise<ActionResult>
	executeJavascript(script: string): Promise<ActionResult>
	frameClients: readonly {
		iframe: HTMLIFrameElement
		executeJavascript(script?: string): Promise<ActionResult>
	}[]
}

type DemoWindow = Window & {
	pageController?: ControllerHandle
	pageAgent?: {
		config: { provider?: string; toolCallingMode?: string; language?: string }
		status: string
	}
	frameBridgeHost?: unknown
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
		const pageController = (window as DemoWindow).pageController
		if (!pageController) throw new Error('FrameAwarePageController has not been installed')
		return pageController.getBrowserState()
	})
}

async function action(
	page: Page,
	method:
		| 'clickElement'
		| 'inputText'
		| 'selectOption'
		| 'scroll'
		| 'scrollHorizontally'
		| 'executeJavascript',
	args: unknown[]
): Promise<ActionResult> {
	return page.evaluate(
		async ({ method, args }) => {
			const pageController = (window as DemoWindow).pageController
			if (!pageController) throw new Error('FrameAwarePageController has not been installed')
			if (method === 'clickElement') return pageController.clickElement(args[0] as number)
			if (method === 'inputText')
				return pageController.inputText(args[0] as number, args[1] as string)
			if (method === 'selectOption')
				return pageController.selectOption(args[0] as number, args[1] as string)
			if (method === 'scrollHorizontally')
				return pageController.scrollHorizontally(
					args[0] as { index: number; right: boolean; pixels: number }
				)
			if (method === 'executeJavascript') return pageController.executeJavascript(args[0] as string)
			return pageController.scroll(args[0] as { index?: number; down: boolean; numPages: number })
		},
		{ method, args }
	)
}

async function cooperativeFrame(page: Page): Promise<Frame> {
	await expect
		.poll(() => page.frames().find((frame) => frame.url().startsWith(`${childOrigin}/child.html`)))
		.toBeTruthy()
	return page.frames().find((frame) => frame.url().startsWith(`${childOrigin}/child.html`))!
}

test.describe('cross-origin iframe bridge demo', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/host.html')
		await expect(page).toHaveURL(`${hostOrigin}/host.html`)
		await expect
			.poll(() => page.evaluate(() => Boolean((window as DemoWindow).pageAgent)))
			.toBe(true)
		await expect
			.poll(() => page.evaluate(() => Boolean((window as DemoWindow).pageController)))
			.toBe(true)

		const frame = await cooperativeFrame(page)
		await expect
			.poll(() => frame.evaluate(() => Boolean((window as DemoWindow).frameBridgeHost)))
			.toBe(true)
	})

	test('installs PageAgent only on the Chinese parent page', async ({ page }) => {
		const frame = await cooperativeFrame(page)
		const parentAgent = await page.evaluate(() => (window as DemoWindow).pageAgent?.config)

		expect(parentAgent).toMatchObject({
			provider: 'tl',
			toolCallingMode: 'system_prompt',
			language: 'zh-CN',
		})
		expect(await frame.evaluate(() => Boolean((window as DemoWindow).pageAgent))).toBe(false)
		await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN')
		await expect(frame.locator('html')).toHaveAttribute('lang', 'zh-CN')
		await expect(page.locator('.frame-header')).toContainText('未安装 PageAgent')
		await expect(page.locator('#cooperative-frame')).toHaveAttribute(
			'title',
			'协作子 iframe 测试页面'
		)
		await expect(frame.getByText('子 iframe · 仅安装 iframe bridge')).toBeVisible()
	})

	test('aggregates parent and child iframe controls into one browser state', async ({ page }) => {
		const state = await controller(page)

		expect(state.url).toBe(`${hostOrigin}/host.html`)
		expect(state.content).toContain('id=parent-button')
		expect(state.content).toContain('id=child-button')
		expect(state.content).toContain('子页面备注')
		expect(state.content).toContain('子页面横向列表')
		expect(state.content).toContain('<cross-origin-frame src="http://127.0.0.1:4174/child.html"')
		expect(state.indices.length).toBeGreaterThan(8)
	})

	test('supports every page operation type on the parent page', async ({ page }) => {
		const state = await controller(page)
		const parentButton = markerIndex(state.content, /<button[^>]*id=parent-button/)
		const parentInput = markerIndex(state.content, /<input[^>]*id=parent-name/)
		const parentSelect = markerIndex(state.content, /<select[^>]*id=parent-city/)
		const parentHorizontal = markerIndex(state.content, /<div[^>]*aria-label=父页面横向列表/)

		expect((await action(page, 'clickElement', [parentButton])).success).toBe(true)
		await expect(page.locator('#parent-click-result')).toHaveText('父页面按钮已点击')

		expect((await action(page, 'inputText', [parentInput, '张三'])).success).toBe(true)
		await expect(page.locator('#parent-name')).toHaveValue('张三')

		expect((await action(page, 'selectOption', [parentSelect, '杭州'])).success).toBe(true)
		await expect(page.locator('#parent-city')).toHaveValue('杭州')

		const beforeHorizontal = await page
			.locator('#parent-horizontal-scroll')
			.evaluate((element) => element.scrollLeft)
		expect(
			(
				await action(page, 'scrollHorizontally', [
					{ index: parentHorizontal, right: true, pixels: 300 },
				])
			).success
		).toBe(true)
		await expect
			.poll(() =>
				page.locator('#parent-horizontal-scroll').evaluate((element) => element.scrollLeft)
			)
			.toBeGreaterThan(beforeHorizontal)

		const scriptResult = await action(page, 'executeJavascript', ['return document.title'])
		expect(scriptResult).toMatchObject({ success: true })
		expect(scriptResult.message).toContain('PageAgent 跨域 iframe 中文测试页')

		const beforeDocumentScroll = await page.evaluate(() => window.scrollY)
		expect((await action(page, 'scroll', [{ down: true, numPages: 0.5 }])).success).toBe(true)
		await expect
			.poll(() => page.evaluate(() => window.scrollY))
			.toBeGreaterThan(beforeDocumentScroll)
	})

	test('routes every bridge-supported operation type into the child iframe', async ({ page }) => {
		const state = await controller(page)
		const childButton = markerIndex(state.content, /<button[^>]*id=child-button/)
		const childInput = markerIndex(state.content, /<input[^>]*id=child-input/)
		const childSelect = markerIndex(state.content, /<select[^>]*id=child-select/)
		const childVertical = markerIndex(state.content, /<div[^>]*aria-label=子页面纵向区域/)
		const childHorizontal = markerIndex(state.content, /<div[^>]*aria-label=子页面横向列表/)
		const childDocument = markerIndex(state.content, /<iframe-document>/)
		const frame = await cooperativeFrame(page)

		expect((await action(page, 'clickElement', [childButton])).success).toBe(true)
		await expect(frame.locator('#child-button')).toHaveAttribute('data-clicked', 'true')

		expect((await action(page, 'inputText', [childInput, '桥接测试成功'])).success).toBe(true)
		await expect(frame.locator('#child-input')).toHaveValue('桥接测试成功')

		expect((await action(page, 'selectOption', [childSelect, '专业版'])).success).toBe(true)
		await expect(frame.locator('#child-select')).toHaveValue('专业版')

		const beforeVertical = await frame
			.locator('#child-vertical-scroll')
			.evaluate((element) => element.scrollTop)
		expect(
			(await action(page, 'scroll', [{ index: childVertical, down: true, numPages: 0.5 }])).success
		).toBe(true)
		await expect
			.poll(() => frame.locator('#child-vertical-scroll').evaluate((element) => element.scrollTop))
			.toBeGreaterThan(beforeVertical)

		const beforeHorizontal = await frame
			.locator('#child-horizontal-scroll')
			.evaluate((element) => element.scrollLeft)
		expect(
			(
				await action(page, 'scrollHorizontally', [
					{ index: childHorizontal, right: true, pixels: 300 },
				])
			).success
		).toBe(true)
		await expect
			.poll(() =>
				frame.locator('#child-horizontal-scroll').evaluate((element) => element.scrollLeft)
			)
			.toBeGreaterThan(beforeHorizontal)

		const beforeDocumentScroll = await frame.evaluate(() => window.scrollY)
		expect(
			(await action(page, 'scroll', [{ index: childDocument, down: true, numPages: 1 }])).success
		).toBe(true)
		await expect
			.poll(() => frame.evaluate(() => window.scrollY))
			.toBeGreaterThan(beforeDocumentScroll)
	})

	test('keeps JavaScript execution local to the parent page', async ({ page }) => {
		await controller(page)
		const result = await page.evaluate(async () => {
			const pageController = (window as DemoWindow).pageController
			if (!pageController) throw new Error('FrameAwarePageController has not been installed')
			const client = pageController.frameClients.find(
				(candidate) => candidate.iframe.id === 'cooperative-frame'
			)
			if (!client) throw new Error('Cooperative frame client was not connected')
			try {
				await client.executeJavascript('document.body.dataset.remoteExecuted = "true"')
				return { success: true, code: null }
			} catch (error) {
				return { success: false, code: (error as { code?: string }).code ?? null }
			}
		})

		expect(result).toEqual({ success: false, code: 'CAPABILITY_DENIED' })
		const frame = await cooperativeFrame(page)
		expect(await frame.evaluate(() => document.body.dataset.remoteExecuted)).toBeUndefined()
	})
})
