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
	pageAgentDemoConfig?: {
		maxRetries?: unknown
		provider?: unknown
	}
	pageAgent?: {
		config: {
			provider?: string
			maxRetries?: number
			toolCallingMode?: string
			language?: string
			tlSystemPromptVariableName?: string
		}
		status: string
	}
	frameBridgeHost?: unknown
	frameBridgeHandle?: {
		controller: ControllerHandle
		dispose(): void
	}
	frameHostHandle?: {
		host: { capabilities: readonly string[] }
		dispose(): void
	}
	iifeUnhandledRejections?: string[]
	PageAgentFrameBridge?: {
		FrameAwarePageController: new (...args: never[]) => unknown
		PageController: new (...args: never[]) => unknown
		createFrameAwareController(options: unknown): unknown
	}
	PageAgentFrameHost?: {
		FrameBridgeHost: new (...args: never[]) => unknown
		PageController: new (...args: never[]) => unknown
		startFrameBridge(options: unknown): unknown
	}
}

const hostOrigin = 'http://127.0.0.1:4173'
const childOrigin = 'http://127.0.0.1:4174'
const demoPath = '/host.html?provider=tl&maxRetries=1&tlSystemPromptVariableName=system_prompt'

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
		// Keep this test independent from any developer-local .env values. The
		// The system prompt variable is explicitly selected through the supported URL
		// parameter, while the manual demo can still resolve it from .env.
		await page.goto(demoPath)
		await expect(page).toHaveURL(`${hostOrigin}${demoPath}`)
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
			maxRetries: 1,
			toolCallingMode: 'system_prompt',
			language: 'zh-CN',
			tlSystemPromptVariableName: 'system_prompt',
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

	test('rejects malformed maxRetries values instead of coercing them', async ({ page }) => {
		const messages = await page.evaluate(async () => {
			history.replaceState(null, '', '/host.html')
			// The fixture server exposes this module at runtime; it is not part of the TypeScript project.
			// @ts-expect-error The absolute fixture URL is resolved by the browser.
			const { queryConfig } = await import('/page-agent-setup.js')
			const originalBuildConfig = (window as DemoWindow).pageAgentDemoConfig
			const invalidValues: unknown[] = ['1x', true, {}]
			const result = invalidValues.map((maxRetries) => {
				;(window as DemoWindow).pageAgentDemoConfig = { maxRetries }
				try {
					queryConfig({})
					return 'no error'
				} catch (error) {
					return error instanceof Error ? error.message : String(error)
				}
			})
			;(window as DemoWindow).pageAgentDemoConfig = originalBuildConfig
			return result
		})

		expect(messages).toHaveLength(3)
		expect(
			messages.every(
				(message) => message.includes('maxRetries') && message.includes('non-negative integer')
			)
		).toBe(true)
	})

	test('uses the same short provider identifiers across demo configuration sources', async ({
		page,
	}) => {
		const result = await page.evaluate(async () => {
			// The fixture server exposes this module at runtime; it is not part of the TypeScript project.
			// @ts-expect-error The absolute fixture URL is resolved by the browser.
			const { queryConfig } = await import('/page-agent-setup.js')
			const originalBuildConfig = (window as DemoWindow).pageAgentDemoConfig
			;(window as DemoWindow).pageAgentDemoConfig = {}

			const queryProviders = ['openai', 'tl', 'ds'].map((provider) => {
				history.replaceState(
					null,
					'',
					`/host.html?provider=${provider}&baseURL=https%3A%2F%2Fapi.example%2Fv1&endpointAgent=http%3A%2F%2F127.0.0.1%3A8089&dsMode=api`
				)
				return queryConfig({}).provider
			})
			const envProviders = ['openai', 'tl', 'ds'].map((provider) => {
				history.replaceState(null, '', '/host.html')
				;(window as DemoWindow).pageAgentDemoConfig = {}
				return queryConfig({ LLM_PROVIDER: provider }).provider
			})
			const buildProviders = ['openai', 'tl', 'ds'].map((provider) => {
				history.replaceState(null, '', '/host.html')
				;(window as DemoWindow).pageAgentDemoConfig = { provider }
				return queryConfig({}).provider
			})

			const legacyErrors = ['openaiclient', 'tlclient', 'dsclient'].map((provider) => {
				history.replaceState(null, '', `/host.html?provider=${provider}`)
				try {
					queryConfig({})
					return 'no error'
				} catch (error) {
					return error instanceof Error ? error.message : String(error)
				}
			})

			;(window as DemoWindow).pageAgentDemoConfig = originalBuildConfig
			return { queryProviders, envProviders, buildProviders, legacyErrors }
		})

		expect(result.queryProviders).toEqual(['openai', 'tl', 'ds'])
		expect(result.envProviders).toEqual(['openai', 'tl', 'ds'])
		expect(result.buildProviders).toEqual(['openai', 'tl', 'ds'])
		expect(
			result.legacyErrors.every(
				(message) => message.includes('provider') && message.includes('"openai", "tl", or "ds"')
			)
		).toBe(true)
	})

	test('aggregates parent and child iframe controls into one browser state', async ({ page }) => {
		const state = await controller(page)

		expect(state.url).toBe(`${hostOrigin}${demoPath}`)
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

test.describe('standalone iframe bridge IIFE bundles', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/iife-host.html')
		await expect(page).toHaveURL(`${hostOrigin}/iife-host.html`)
		await expect
			.poll(() => page.evaluate(() => Boolean((window as DemoWindow).PageAgentFrameBridge)))
			.toBe(true)
		await expect
			.poll(() => page.evaluate(() => Boolean((window as DemoWindow).pageController)))
			.toBe(true)
		const frame = await cooperativeIifeFrame(page)
		await expect
			.poll(() => frame.evaluate(() => Boolean((window as DemoWindow).frameBridgeHost)))
			.toBe(true)
	})

	test('reads script maxRetries as a number in the demo bundle', async ({ page }) => {
		const result = await page.evaluate(async () => {
			await new Promise<void>((resolve, reject) => {
				const script = document.createElement('script')
				script.src = '/page-agent/page-agent.demo.js?autoInit=false&maxRetries=2'
				script.onload = () => resolve()
				script.onerror = () => reject(new Error('Failed to load page-agent demo bundle'))
				document.head.appendChild(script)
			})
			const maxRetries = (window as DemoWindow).pageAgentDemoConfig?.maxRetries
			return { maxRetries, type: typeof maxRetries }
		})

		expect(result).toEqual({ maxRetries: 2, type: 'number' })
	})

	test('loads both globals through classic scripts', async ({ page }) => {
		const parentApi = await page.evaluate(() => {
			const api = (window as DemoWindow).PageAgentFrameBridge
			return {
				controller: typeof api?.FrameAwarePageController,
				localController: typeof api?.PageController,
				create: typeof api?.createFrameAwareController,
				scriptTypes: [...document.scripts].map((script) => script.type),
			}
		})
		expect(parentApi).toEqual({
			controller: 'function',
			localController: 'function',
			create: 'function',
			scriptTypes: ['', ''],
		})

		const frame = await cooperativeIifeFrame(page)
		const childApi = await frame.evaluate(() => {
			const api = (window as DemoWindow).PageAgentFrameHost
			return {
				host: typeof api?.FrameBridgeHost,
				controller: typeof api?.PageController,
				start: typeof api?.startFrameBridge,
				scriptTypes: [...document.scripts].map((script) => script.type),
			}
		})
		expect(childApi).toEqual({
			host: 'function',
			controller: 'function',
			start: 'function',
			scriptTypes: ['', ''],
		})
	})

	test('observes and performs authorized child actions', async ({ page }) => {
		const state = await controller(page)
		const childButton = markerIndex(state.content, /<button[^>]*id=child-button/)
		const childInput = markerIndex(state.content, /<input[^>]*id=child-input/)
		const childSelect = markerIndex(state.content, /<select[^>]*id=child-select/)
		const childScroll = markerIndex(state.content, /<div[^>]*aria-label=Child vertical area/)
		const frame = await cooperativeIifeFrame(page)

		expect((await action(page, 'clickElement', [childButton])).success).toBe(true)
		await expect(frame.locator('#child-button')).toHaveAttribute('data-clicked', 'true')

		expect((await action(page, 'inputText', [childInput, 'IIFE input'])).success).toBe(true)
		await expect(frame.locator('#child-input')).toHaveValue('IIFE input')

		expect((await action(page, 'selectOption', [childSelect, 'Pro'])).success).toBe(true)
		await expect(frame.locator('#child-select')).toHaveValue('pro')

		const beforeScroll = await frame
			.locator('#child-scroll')
			.evaluate((element) => element.scrollTop)
		expect(
			(await action(page, 'scroll', [{ index: childScroll, down: true, numPages: 0.5 }])).success
		).toBe(true)
		await expect
			.poll(() => frame.locator('#child-scroll').evaluate((element) => element.scrollTop))
			.toBeGreaterThan(beforeScroll)

		expect(await page.evaluate(() => (window as DemoWindow).iifeUnhandledRejections)).toEqual([])
	})

	test('defaults the script host to observe-only', async ({ page }) => {
		await page.goto('/iife-observe-host.html')
		const frame = await observeOnlyIifeFrame(page)
		await expect
			.poll(() => frame.evaluate(() => (window as DemoWindow).frameHostHandle?.host.capabilities))
			.toEqual(['observe'])

		const state = await controller(page)
		const button = markerIndex(state.content, /<button[^>]*id=observe-only-button/)
		const result = await action(page, 'clickElement', [button])
		expect(result.success).toBe(false)
		expect(result.message).toContain('CAPABILITY_DENIED')
	})

	test('reconnects after the child iframe reloads', async ({ page }) => {
		expect((await controller(page)).content).toContain('id=child-button')
		const frame = await cooperativeIifeFrame(page)
		await frame.evaluate(() => window.location.reload())
		const reloadedFrame = await cooperativeIifeFrame(page)
		await expect
			.poll(() => reloadedFrame.evaluate(() => Boolean((window as DemoWindow).frameBridgeHost)))
			.toBe(true)
		await expect.poll(async () => (await controller(page)).content).toContain('id=child-button')
	})

	test('rejects mismatched child and parent origins', async ({ page }) => {
		const cases = [
			['iife-wrong-child-host.html', 'CAPABILITY_DENIED'],
			['iife-wrong-parent-host.html', 'TIMEOUT'],
		] as const
		for (const [fixture, errorCode] of cases) {
			await page.goto(`/${fixture}`)
			const state = await controller(page)
			expect(state.content).toContain('unavailable="true"')
			expect(state.content).toContain(errorCode)
		}
	})

	test('validates script options and disposes idempotently', async ({ page }) => {
		const validationMessages = await page.evaluate(() => {
			const api = (window as DemoWindow).PageAgentFrameBridge
			if (!api) throw new Error('Parent IIFE API is missing')
			const invalidOptions = [
				{ frameSelector: '', allowedChildOrigins: ['http://127.0.0.1:4174'] },
				{ frameSelector: 'iframe', allowedChildOrigins: [] },
				{ frameSelector: 'iframe', allowedChildOrigins: ['*'] },
				{ frameSelector: 'iframe', allowedChildOrigins: ['http://127.0.0.1:4174/path'] },
			]
			return invalidOptions.map((options) => {
				try {
					api.createFrameAwareController(options)
					return 'no error'
				} catch (error) {
					return error instanceof Error ? error.message : String(error)
				}
			})
		})
		expect(validationMessages.every((message) => message !== 'no error')).toBe(true)

		const disposedError = await page.evaluate(async () => {
			const handle = (window as DemoWindow).frameBridgeHandle
			if (!handle) throw new Error('Parent IIFE handle is missing')
			handle.dispose()
			handle.dispose()
			try {
				await handle.controller.getBrowserState()
				return 'no error'
			} catch (error) {
				return error instanceof Error ? error.message : String(error)
			}
		})
		expect(disposedError).toContain('disposed')
	})
})

async function cooperativeIifeFrame(page: Page): Promise<Frame> {
	await expect
		.poll(() => page.frames().find((frame) => frame.url() === `${childOrigin}/iife-child.html`))
		.toBeTruthy()
	return page.frames().find((frame) => frame.url() === `${childOrigin}/iife-child.html`)!
}

async function observeOnlyIifeFrame(page: Page): Promise<Frame> {
	await expect
		.poll(() =>
			page.frames().find((frame) => frame.url() === `${childOrigin}/iife-observe-child.html`)
		)
		.toBeTruthy()
	return page.frames().find((frame) => frame.url() === `${childOrigin}/iife-observe-child.html`)!
}
