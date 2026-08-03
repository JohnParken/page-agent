import { describe, expect, it, vi } from 'vitest'

import { PageAgentCore } from './PageAgentCore'

import type {
	BrowserState,
	PageControllerAdapter,
	PageControllerCallContext,
} from '@page-agent/page-controller'

type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>
type TestFetchArgs = Parameters<TestFetch>
type TestFetchResult = ReturnType<TestFetch>

function agentResponse(action: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			choices: [
				{
					finish_reason: 'tool_calls',
					message: {
						tool_calls: [
							{
								function: {
									name: 'AgentOutput',
									arguments: JSON.stringify({ action }),
								},
							},
						],
					},
				},
			],
			usage: {},
		})
	)
}

const browserState: BrowserState = {
	url: 'https://child.example.test/',
	title: 'Child page',
	header: '',
	content: '',
	footer: '',
}

function createAdapter() {
	const contextAware = (fn: (context?: PageControllerCallContext) => void) =>
		vi.fn(async (context?: PageControllerCallContext) => {
			fn(context)
		})

	return {
		getCurrentUrl: vi.fn(async () => browserState.url),
		getLastUpdateTime: vi.fn(async (_context?: PageControllerCallContext) => Date.now()),
		getBrowserState: vi.fn(async (_context?: PageControllerCallContext) => browserState),
		updateTree: vi.fn(async () => browserState.content),
		cleanUpHighlights: contextAware(() => {}),
		clickElement: vi.fn(async (_index: number, _context?: PageControllerCallContext) => ({
			success: true,
			message: 'clicked',
		})),
		inputText: vi.fn(async () => ({ success: true, message: 'input' })),
		selectOption: vi.fn(async () => ({ success: true, message: 'selected' })),
		scroll: vi.fn(async () => ({ success: true, message: 'scrolled' })),
		scrollHorizontally: vi.fn(async () => ({ success: true, message: 'scrolled horizontally' })),
		executeJavascript: vi.fn(async () => ({ success: true, message: 'executed' })),
		showMask: contextAware(() => {}),
		hideMask: contextAware(() => {}),
		dispose: vi.fn(),
	} satisfies PageControllerAdapter
}

function createAgent(customFetch: TestFetch, controller: PageControllerAdapter): PageAgentCore {
	return new PageAgentCore({
		baseURL: 'https://llm.example.test',
		model: 'test-model',
		maxRetries: 0,
		stepDelay: 0,
		customFetch,
		customSystemPrompt: 'test',
		pageController: controller,
	})
}

describe('PageAgentCore controller adapter contract', () => {
	it('retains an injected adapter and disposes it with the agent', () => {
		const controller = createAdapter()
		const agent = createAgent(vi.fn(), controller)

		expect(agent.pageController).toBe(controller)
		agent.dispose()

		expect(controller.dispose).toHaveBeenCalledOnce()
	})

	it('passes the task AbortSignal to observation and action calls', async () => {
		const controller = createAdapter()
		const fetchMock = vi
			.fn<TestFetchArgs, TestFetchResult>()
			.mockResolvedValueOnce(agentResponse({ click_element_by_index: { index: 0 } }))
			.mockResolvedValueOnce(agentResponse({ done: { text: 'done', success: true } }))
		const agent = createAgent(fetchMock, controller)

		await expect(agent.execute('click once')).resolves.toMatchObject({ success: true })

		const firstObservationSignal = controller.getBrowserState.mock.calls[0]?.[0]?.signal
		const secondObservationSignal = controller.getBrowserState.mock.calls[1]?.[0]?.signal
		const actionSignal = controller.clickElement.mock.calls[0]?.[1]?.signal

		expect(firstObservationSignal).toBeInstanceOf(AbortSignal)
		expect(secondObservationSignal).toBe(firstObservationSignal)
		expect(actionSignal).toBe(firstObservationSignal)
	})
})
