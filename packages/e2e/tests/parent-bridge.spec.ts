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
	reverseAuthorizationContext?: {
		policyId: string
		integrationId: string
		parentAppId: string
		assistantAppId: string
		parentOrigin: string
		assistantOrigin: string
		targetId: string
		scopeId: string
		capabilities: string[]
	}
	reverseParentController?: {
		readonly connected: boolean
		readonly activationActive: boolean
		reconnect(): Promise<{ policyId: string }>
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
	reverseApprovalRequests?: {
		method: string
		capability: string
		payload: unknown
		reason?: string
	}[]
	brokeredInputResult?: Promise<ActionResult>
	reversePageAgent?: {
		readonly status: string
		readonly history: readonly {
			type: string
			action?: { name: string }
		}[]
	}
}

interface ReverseParentWindow extends Window {
	reverseParentHost?: { controller?: unknown; deactivate(): void }
	PageAgentParentHost?: unknown
}

const parentOrigins = ['http://127.0.0.1:4173', 'http://127.0.0.1:4175'] as const
const childOrigin = 'http://127.0.0.1:4174'
const businessOrigin = 'http://127.0.0.1:4176'

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
	const connect = frame.locator('#assistant-connect')
	await expect(connect).toBeVisible()
	if (await connect.isEnabled()) await connect.click()
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

async function businessFrame(page: Page): Promise<Frame> {
	await expect
		.poll(() =>
			page
				.frames()
				.find(
					(frame) =>
						frame.url().startsWith(`${businessOrigin}/reverse-business-child.html`) &&
						frame.url().includes('role=authorized')
				)
		)
		.toBeTruthy()
	return page
		.frames()
		.find(
			(frame) =>
				frame.url().startsWith(`${businessOrigin}/reverse-business-child.html`) &&
				frame.url().includes('role=authorized')
		)!
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
	const assistant = await connectedChildFrame(page, parentOrigin)
	const business = await businessFrame(page)
	await expect(business.locator('#business-button')).toBeVisible()
	return assistant
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

async function parentFeedbackBecameVisible(page: Page): Promise<boolean> {
	return page.evaluate(
		() =>
			new Promise<boolean>((resolve) => {
				const feedback = document.querySelector<HTMLElement>('[data-page-agent-parent-feedback]')
				if (!feedback) {
					resolve(false)
					return
				}
				let settled = false
				const observer = new MutationObserver(() => check())
				const finish = (value: boolean) => {
					if (settled) return
					settled = true
					observer.disconnect()
					window.clearTimeout(timeout)
					resolve(value)
				}
				const check = () => {
					if (!feedback.hidden && feedback.dataset.state === 'running') finish(true)
				}
				observer.observe(feedback, { attributes: true, attributeFilter: ['data-state', 'hidden'] })
				const timeout = window.setTimeout(() => finish(false), 5_000)
				check()
			})
	)
}

test.describe('reverse parent-controller bridge cross-origin fixtures', () => {
	test('does not issue or redeem authorization before the user clicks Connect', async ({
		page,
	}) => {
		const authorizationRequests: string[] = []
		page.on('request', (request) => {
			const path = new URL(request.url()).pathname
			if (
				path === '/api/parent-bridge/embed-policy' ||
				path === '/api/parent-bridge/authorize-offer'
			)
				authorizationRequests.push(path)
		})

		await page.goto(`${parentOrigins[0]}/reverse-parent.html`)
		await expect
			.poll(() => page.evaluate(() => Boolean((window as ReverseParentWindow).reverseParentHost)))
			.toBe(true)
		const frame = await childFrame(page)
		await expect(frame.locator('#assistant-status')).toContainText('Disconnected')
		await expect(frame.locator('#assistant-connect')).toBeEnabled()
		expect(authorizationRequests).toEqual([])

		await frame.locator('#assistant-connect').click()
		await expect(frame.locator('#assistant-status')).toContainText(`connected:${parentOrigins[0]}`)
		await expect
			.poll(() => [...new Set(authorizationRequests)].sort())
			.toEqual(['/api/parent-bridge/authorize-offer', '/api/parent-bridge/embed-policy'])
	})

	test('observes only the trusted parent root and excludes outside/assistant DOM', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const browserState = await state(frame)

		expect(browserState.content).toContain('parent-button')
		expect(browserState.content).toContain('parent-input')
		expect(browserState.content).toContain('authorized-child-frames')
		expect(browserState.content).toContain('business-button')
		expect(browserState.content).toContain('business-input')
		expect(browserState.content).not.toContain('outside-host-control')
		expect(browserState.content).not.toContain('assistant-root')
		expect(browserState.content).not.toContain('Vue assistant origin fixture')
		expect(browserState.content).not.toContain('UNAUTHORIZED_CHILD_SECRET')
		expect(
			await page.evaluate(() => Boolean((window as ReverseParentWindow).PageAgentParentHost))
		).toBe(true)

		const business = await businessFrame(page)
		expect(new URL(frame.url()).origin).toBe(childOrigin)
		expect(new URL(business.url()).origin).toBe(businessOrigin)
		expect(new URL(page.url()).origin).not.toBe(new URL(business.url()).origin)
		expect(new URL(frame.url()).origin).not.toBe(new URL(business.url()).origin)
		const authorizationContext = await frame.evaluate(
			() => (window as ReverseChildWindow).reverseAuthorizationContext
		)
		expect(authorizationContext).toMatchObject({
			integrationId: 'reverse-primary-assistant',
			parentAppId: 'reverse-primary',
			assistantAppId: 'reverse-assistant',
			parentOrigin: parentOrigins[0],
			assistantOrigin: childOrigin,
			targetId: 'reverse-e2e-target',
			scopeId: 'reverse-e2e-root',
			capabilities: [
				'observe',
				'click',
				'input',
				'select',
				'scroll',
				'scrollHorizontally',
				'cleanup',
				'visual',
			],
		})
		expect(authorizationContext).not.toHaveProperty('subject')
		expect(authorizationContext).not.toHaveProperty('tenant')
		expect(authorizationContext).not.toHaveProperty('user')
	})

	test('redeems a managed opaque policy once and rejects tampering without burning the valid token', async ({
		page,
	}) => {
		const bridgeBinding = {
			sessionId: 'e2e-session',
			challenge: 'e2e-challenge',
			frameInstanceId: 'e2e-frame',
			hostInstanceId: 'e2e-host',
		}
		const issue = await page.request.post(`${parentOrigins[0]}/api/parent-bridge/embed-policy`, {
			headers: { Origin: parentOrigins[0] },
			data: {
				integrationId: 'reverse-primary-assistant',
				bridgeBinding,
			},
		})
		expect(issue.ok()).toBe(true)
		const grant = (await issue.json()) as {
			policy: string
			claims: { jti: string; cap: string[] }
		}
		expect(grant.policy).toMatch(/^pao_[A-Za-z0-9_-]{43}$/)
		expect(grant.policy).not.toContain('.')

		const offer = {
			policyId: grant.claims.jti,
			...bridgeBinding,
			capabilities: grant.claims.cap,
		}
		const authorize = (policy: string, actualParentOrigin = parentOrigins[0]) =>
			page.request.post(`${childOrigin}/api/parent-bridge/authorize-offer`, {
				headers: { Origin: childOrigin },
				data: { policy, actualParentOrigin, offer },
			})
		const lastCharacter = grant.policy.at(-1)
		const tampered = `${grant.policy.slice(0, -1)}${lastCharacter === 'A' ? 'B' : 'A'}`
		expect((await authorize(tampered)).status()).toBe(403)

		const accepted = await authorize(grant.policy)
		expect(accepted.ok()).toBe(true)
		expect(await accepted.json()).toMatchObject({
			authorized: true,
			authorizationContext: {
				policyId: grant.claims.jti,
				integrationId: 'reverse-primary-assistant',
				parentAppId: 'reverse-primary',
				assistantAppId: 'reverse-assistant',
				parentOrigin: parentOrigins[0],
				assistantOrigin: childOrigin,
				sessionId: offer.sessionId,
				challenge: offer.challenge,
				frameInstanceId: offer.frameInstanceId,
				hostInstanceId: offer.hostInstanceId,
				capabilities: offer.capabilities,
			},
		})
		const replay = await authorize(grant.policy)
		expect(replay.status()).toBe(403)
		expect(await replay.json()).toEqual({ error: 'POLICY_NOT_FOUND_OR_REPLAYED' })
	})

	test('rejects an A subject mismatch without burning the valid policy', async ({ page }) => {
		const bridgeBinding = {
			sessionId: 'subject-session',
			challenge: 'subject-challenge',
			frameInstanceId: 'subject-frame',
			hostInstanceId: 'subject-host',
		}
		const issue = await page.request.post(`${parentOrigins[0]}/api/parent-bridge/embed-policy`, {
			headers: { Origin: parentOrigins[0] },
			data: { integrationId: 'reverse-primary-assistant', bridgeBinding },
		})
		expect(issue.ok()).toBe(true)
		const grant = (await issue.json()) as {
			policy: string
			claims: { jti: string; cap: string[] }
		}
		const request = {
			policy: grant.policy,
			actualParentOrigin: parentOrigins[0],
			offer: { policyId: grant.claims.jti, ...bridgeBinding, capabilities: grant.claims.cap },
		}
		const mismatch = await page.request.post(`${childOrigin}/api/parent-bridge/authorize-offer`, {
			headers: { Origin: childOrigin, 'X-E2E-User-Id': 'different-user' },
			data: request,
		})
		expect(mismatch.status()).toBe(403)
		expect(await mismatch.json()).toEqual({ error: 'SUBJECT_MISMATCH' })

		const accepted = await page.request.post(`${childOrigin}/api/parent-bridge/authorize-offer`, {
			headers: { Origin: childOrigin },
			data: request,
		})
		expect(accepted.ok()).toBe(true)
	})

	test('routes allowed and confirmed actions through the parent into the business iframe', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const business = await businessFrame(page)
		const browserState = await state(frame)
		const buttonIndex = markerIndex(browserState.content, /<button[^>]*id=business-button/)

		const clickResult = await frame.evaluate(
			async (index) => (window as ReverseChildWindow).reverseParentController!.clickElement(index),
			buttonIndex
		)
		expect(clickResult.success).toBe(true)
		await expect(business.locator('#business-result')).toHaveText('shipment released')

		const inputValue = 'approved brokered input'
		const refreshedState = await state(frame)
		const inputIndex = markerIndex(refreshedState.content, /<input[^>]*id=business-input/)
		await frame.evaluate(
			({ index, text }) => {
				;(window as ReverseChildWindow).brokeredInputResult = (
					window as ReverseChildWindow
				).reverseParentController!.inputText(index, text)
			},
			{ index: inputIndex, text: inputValue }
		)
		await expect
			.poll(() =>
				frame.evaluate(() => (window as ReverseChildWindow).reverseApprovalRequests?.length ?? 0)
			)
			.toBe(1)
		await expect(frame.locator('#assistant-approval')).toBeVisible()
		await frame.locator('#assistant-approval-allow').click()
		const inputResult = await frame.evaluate(async () => {
			const result = (window as ReverseChildWindow).brokeredInputResult
			if (!result) throw new Error('Brokered input result promise is missing')
			return await result
		})
		expect(inputResult.success).toBe(true)
		expect(inputResult.message).not.toContain(inputValue)
		await expect(business.locator('#business-input')).toHaveValue(inputValue)

		const approvals = await frame.evaluate(
			() => (window as ReverseChildWindow).reverseApprovalRequests ?? []
		)
		expect(approvals).toHaveLength(1)
		expect(approvals[0]).toMatchObject({
			method: 'inputText',
			capability: 'input',
			payload: {
				textLength: inputValue.length,
				frame: { id: 'fulfilment-app', origin: businessOrigin },
				target: { tag: 'input', label: 'business approval note' },
			},
		})
		expect(JSON.stringify(approvals)).not.toContain(inputValue)
	})

	test('does not let parent or assistant approval override a business-frame deny', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const business = await businessFrame(page)
		const browserState = await state(frame)
		const deniedIndex = markerIndex(browserState.content, /<button[^>]*id=business-deny-button/)
		const result = await frame.evaluate(
			async (index) => (window as ReverseChildWindow).reverseParentController!.clickElement(index),
			deniedIndex
		)
		expect(result.success).toBe(false)
		expect(result.message).toContain('CAPABILITY_DENIED')
		await expect(business.locator('#business-result')).toHaveText('not released')
		expect(
			await frame.evaluate(
				() => (window as ReverseChildWindow).reverseApprovalRequests?.length ?? 0
			)
		).toBe(0)
	})

	test('fails a sensitive business input closed when the user denies the one-use approval', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const business = await businessFrame(page)
		const browserState = await state(frame)
		const inputIndex = markerIndex(browserState.content, /<input[^>]*id=business-input/)

		await frame.evaluate((index) => {
			;(window as ReverseChildWindow).brokeredInputResult = (
				window as ReverseChildWindow
			).reverseParentController!.inputText(index, 'must not be written')
		}, inputIndex)
		await expect(frame.locator('#assistant-approval')).toBeVisible()
		await frame.locator('#assistant-approval-deny').click()

		const result = await frame.evaluate(async () => {
			const pending = (window as ReverseChildWindow).brokeredInputResult
			if (!pending) throw new Error('Brokered input result promise is missing')
			return pending
		})
		expect(result.success).toBe(false)
		expect(result.message).toContain('APPROVAL_DENIED')
		await expect(business.locator('#business-input')).toHaveValue('')
		await expect(frame.locator('#assistant-approval')).toBeHidden()
	})

	test('invalidates a brokered child index on reload and reconnects after observation', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const firstState = await state(frame)
		const staleIndex = markerIndex(firstState.content, /<button[^>]*id=business-button/)
		await page.locator('#business-frame').evaluate((element: HTMLIFrameElement) => {
			const source = element.getAttribute('src')
			if (!source) throw new Error('Business iframe source is missing')
			element.setAttribute('src', source)
		})
		const reloadedBusiness = await businessFrame(page)
		await expect(reloadedBusiness.locator('#business-result')).toHaveText('not released')

		const staleResult = await frame.evaluate(
			async (index) => (window as ReverseChildWindow).reverseParentController!.clickElement(index),
			staleIndex
		)
		expect(staleResult.success).toBe(false)
		expect(staleResult.message).toMatch(/stale|reload|connected|CONNECTION_CLOSED/i)

		const refreshedState = await state(frame)
		expect(refreshedState.treeRevision).toBeGreaterThan(firstState.treeRevision)
		const refreshedIndex = markerIndex(refreshedState.content, /<button[^>]*id=business-button/)
		const refreshedResult = await frame.evaluate(
			async (index) => (window as ReverseChildWindow).reverseParentController!.clickElement(index),
			refreshedIndex
		)
		expect(refreshedResult.success).toBe(true)
	})

	test('keeps configured business-frame contents hidden when verified claims omit the grant', async ({
		page,
	}) => {
		const parentOrigin = parentOrigins[0]
		await page.goto(`${parentOrigin}/reverse-parent.html?authorizeBusiness=false`)
		const frame = await connectedChildFrame(page, parentOrigin)
		const browserState = await state(frame)
		expect(browserState.content).not.toContain('authorized-child-frames')
		expect(browserState.content).not.toContain('business-button')
		expect(browserState.content).not.toContain('authorized-business-content')
		expect(browserState.content).not.toContain('UNAUTHORIZED_CHILD_SECRET')
	})

	test('labels each demo origin with a distinct color and role', async ({ page }) => {
		const assistant = await openParent(page)
		const business = await businessFrame(page)
		await expect
			.poll(() =>
				page
					.frames()
					.some(
						(frame) =>
							frame.url().startsWith(`${businessOrigin}/reverse-business-child.html`) &&
							frame.url().includes('role=unauthorized')
					)
			)
			.toBe(true)
		const unconfiguredBusiness = page
			.frames()
			.find(
				(frame) =>
					frame.url().startsWith(`${businessOrigin}/reverse-business-child.html`) &&
					frame.url().includes('role=unauthorized')
			)!

		const parentMarker = page.locator('[data-testid="parent-origin-marker"]')
		const assistantMarker = assistant.locator('[data-testid="assistant-origin-marker"]')
		const businessMarker = business.locator('[data-testid="business-origin-marker"]')
		const unconfiguredMarker = unconfiguredBusiness.locator(
			'[data-testid="business-origin-marker"]'
		)

		await expect(parentMarker).toContainText('Parent host page')
		await expect(parentMarker).toContainText(parentOrigins[0])
		await expect(assistantMarker).toContainText('Assistant iframe')
		await expect(assistantMarker).toContainText(childOrigin)
		await expect(assistantMarker).toContainText('connected target')
		await expect(businessMarker).toContainText('Business iframe')
		await expect(businessMarker).toContainText(businessOrigin)
		await expect(businessMarker).toContainText('authorized target')
		await expect(unconfiguredMarker).toContainText('unconfigured sibling')

		const markerColors = await Promise.all(
			[parentMarker, assistantMarker, businessMarker].map((marker) =>
				marker.evaluate((element) => getComputedStyle(element).color)
			)
		)
		expect(new Set(markerColors).size).toBe(3)
	})

	test('renders the assistant as a right-side floating panel over the rich parent page', async ({
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

	test('presents the assistant as a floating window with an editable instruction', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const assistant = page.locator('#assistant-frame')
		const position = await assistant.evaluate((element) => {
			const style = getComputedStyle(element)
			return { position: style.position, bottom: style.bottom, zIndex: style.zIndex }
		})
		expect(position.position).toBe('fixed')
		expect(position.bottom).not.toBe('auto')
		expect(Number(position.zIndex)).toBeGreaterThan(0)

		const task = frame.locator('#assistant-agent-task')
		await expect(task).toBeEditable()
		await expect(task).toHaveValue(/父页面/)
		await expect(task).toHaveValue(/业务 iframe/)
		await task.fill('只观察当前页面，不执行修改。')
		await expect(task).toHaveValue('只观察当前页面，不执行修改。')
	})

	test('runs PageAgent against a same-origin Tl service and controls the parent and business iframe', async ({
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
		const business = await businessFrame(page)
		await expect(business.locator('#business-result')).toHaveText('shipment released')
		await expect(frame.locator('#assistant-approval')).toBeVisible()
		await expect(frame.locator('#assistant-approval-summary')).toContainText('inputText (input)')
		await frame.locator('#assistant-approval-allow').click()
		await expect(business.locator('#business-input')).toHaveValue('PageAgent business approval')
		await expect(frame.locator('#assistant-agent-status')).toHaveText('agent:completed:true')
		await expect(frame.locator('#assistant-agent-result')).toContainText(
			'父页面及业务子 iframe 操作已完成'
		)
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
			'click_element_by_index',
			'input_text',
			'done',
		])

		await expect.poll(() => tlResponses.length).toBe(12)
		for (const response of tlResponses) {
			expect(new URL(response.url).origin).toBe(childOrigin)
			expect(response.allowOrigin).toBeNull()
		}
	})

	test('shows and clears feedback after every manual bridge operation', async ({ page }) => {
		const frame = await openParent(page)
		const feedback = page.locator('[data-page-agent-parent-feedback]')
		await frame.locator('#assistant-run-observe').click()
		await expect(frame.locator('#assistant-status')).toHaveText(/observed:/)
		await expectNoVisibleParentHighlights(page)

		const operations = [
			{ control: '#assistant-run-click', status: 'click:true' },
			{ control: '#assistant-run-input', status: 'input:true' },
			{ control: '#assistant-run-select', status: 'select:true' },
			{ control: '#assistant-run-scroll', status: 'scroll:true' },
		] as const

		for (const operation of operations) {
			const feedbackVisible = parentFeedbackBecameVisible(page)
			await frame.locator(operation.control).click()
			expect(await feedbackVisible).toBe(true)
			await expect(frame.locator('#assistant-status')).toHaveText(operation.status)
			await expect(feedback).toBeHidden()
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
		expect(browserState.content).not.toContain('business-button')
		expect(
			await frame.evaluate(
				() => (window as ReverseChildWindow).reverseAuthorizationContext?.integrationId
			)
		).toBe('reverse-secondary-assistant')
		await expect(frame.locator('#assistant-status')).toContainText(parentOrigins[1])
	})

	test('supports A- and P-initiated reconnects only after the first activation', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const firstPolicyId = await frame.evaluate(
			() => (window as ReverseChildWindow).reverseAuthorizationContext?.policyId
		)
		expect(firstPolicyId).toMatch(/^pao_id_/)

		const assistantPolicyId = await frame.evaluate(async () => {
			const adapter = (window as ReverseChildWindow).reverseParentController
			if (!adapter?.activationActive) throw new Error('Assistant activation is not active')
			return (await adapter.reconnect()).policyId
		})
		expect(assistantPolicyId).toMatch(/^pao_id_/)
		expect(assistantPolicyId).not.toBe(firstPolicyId)

		await page.evaluate(() => window.dispatchEvent(new Event('popstate')))
		await expect
			.poll(async () => {
				const policyId = await frame.evaluate(
					() => (window as ReverseChildWindow).reverseAuthorizationContext?.policyId
				)
				return typeof policyId === 'string' && policyId !== assistantPolicyId
			})
			.toBe(true)
		await expect(frame.locator('#assistant-status')).toContainText(`connected:${parentOrigins[0]}`)
		await expect(frame.locator('#assistant-connect')).toBeDisabled()
	})

	test('propagates P deactivation to A and requires another visible Connect action', async ({
		page,
	}) => {
		const frame = await openParent(page)
		const firstPolicyId = await frame.evaluate(
			() => (window as ReverseChildWindow).reverseAuthorizationContext?.policyId
		)

		await page.evaluate(() => {
			const host = (window as ReverseParentWindow).reverseParentHost
			if (!host) throw new Error('Parent host is unavailable')
			host.deactivate()
		})
		await expect
			.poll(() =>
				frame.evaluate(() => {
					const adapter = (window as ReverseChildWindow).reverseParentController
					return adapter ? { connected: adapter.connected, active: adapter.activationActive } : null
				})
			)
			.toEqual({ connected: false, active: false })
		await expect(frame.locator('#assistant-status')).toHaveText('disconnected')
		await expect(frame.locator('#assistant-connect')).toBeEnabled()

		await page.waitForTimeout(150)
		expect(
			await frame.evaluate(() => (window as ReverseChildWindow).reverseParentController?.connected)
		).toBe(false)

		await frame.locator('#assistant-connect').click()
		await expect(frame.locator('#assistant-status')).toContainText(`connected:${parentOrigins[0]}`)
		await expect
			.poll(() =>
				frame.evaluate(() => (window as ReverseChildWindow).reverseAuthorizationContext?.policyId)
			)
			.not.toBe(firstPolicyId)
	})

	test('issues and redeems a fresh opaque policy after the assistant iframe reloads', async ({
		page,
	}) => {
		const firstFrame = await openParent(page)
		const firstPolicyId = await firstFrame.evaluate(
			() => (window as ReverseChildWindow).reverseAuthorizationContext?.policyId
		)
		expect(firstPolicyId).toMatch(/^pao_id_/)

		await page.locator('#assistant-frame').evaluate((element: HTMLIFrameElement) => {
			const source = element.getAttribute('src')
			if (!source) throw new Error('Assistant iframe source is missing')
			element.setAttribute('src', source)
		})
		const reloadedFrame = await connectedChildFrame(page, parentOrigins[0])
		const secondPolicyId = await reloadedFrame.evaluate(
			() => (window as ReverseChildWindow).reverseAuthorizationContext?.policyId
		)
		expect(secondPolicyId).toMatch(/^pao_id_/)
		expect(secondPolicyId).not.toBe(firstPolicyId)
		expect((await state(reloadedFrame)).content).toContain('parent-button')
	})

	test('rejects an offer when the child expects a different parent origin', async ({ page }) => {
		await page.goto(
			`${parentOrigins[1]}/reverse-parent.html?childExpectedParentOrigin=${encodeURIComponent(
				parentOrigins[0]
			)}`
		)
		const frame = await childFrame(page)
		await frame.locator('#assistant-connect').click()
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
		await sibling!.evaluate(
			() => document.querySelector<HTMLButtonElement>('#assistant-connect')?.click()
		)
		await wrongSource!.evaluate(
			() => document.querySelector<HTMLButtonElement>('#assistant-connect')?.click()
		)
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
		await expect(page.locator('#page-agent-runtime_simulator-mask')).toHaveCount(0)
		const assistantFrameHit = await page.evaluate(() => {
			const iframe = document.querySelector('#assistant-frame')
			if (!(iframe instanceof HTMLIFrameElement)) return false
			const rect = iframe.getBoundingClientRect()
			const target = document.elementFromPoint(
				rect.left + rect.width / 2,
				rect.top + rect.height / 2
			)
			return target === iframe
		})
		expect(assistantFrameHit).toBe(true)

		const cursor = page.locator('[data-page-agent-parent-cursor]')
		await frame.locator('#assistant-run-click').click()
		await Promise.all([expect(feedback.first()).toBeVisible(), expect(cursor).toBeVisible()])
		await expect(page.locator('#parent-click-result')).toHaveText('clicked')
		await expectNoVisibleParentHighlights(page)
		await expect(cursor).toHaveCount(1)
		await expect(cursor).toBeHidden()
		await expect(feedback.first()).toBeHidden()

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
