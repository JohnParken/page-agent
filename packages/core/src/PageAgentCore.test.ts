import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod/v4'

import { PageAgentCore, tool } from './PageAgentCore'

import type { ExecutionResult } from './types'
import type { BrowserState, PageController } from '@page-agent/page-controller'

type TestFetch = (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>
type TestFetchArgs = Parameters<TestFetch>
type TestFetchResult = ReturnType<TestFetch>

function agentResponse(args: unknown): Response {
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
									arguments: JSON.stringify(args),
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

function tlSseAgentResponse(args: unknown): Response {
	const content = JSON.stringify(args)
	return tlSseContentResponse(content)
}

function tlSseContentResponse(content: string): Response {
	const splitAt = Math.ceil(content.length / 2)
	const events = [content.slice(0, splitAt), content.slice(splitAt)]
		.map(
			(chunk, index) =>
				`id: ${index}\nevent: chunk\ndata: ${JSON.stringify({ content: chunk })}\n\n`
		)
		.join('')

	return new Response(`${events}event: done\ndata: {"finished":true}\n\n`, {
		headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
	})
}

function extractAgentOutputSchema(prompt: string): unknown {
	const match = /<agent_output_schema>\s*([\s\S]*?)\s*<\/agent_output_schema>/.exec(prompt)
	if (!match?.[1]) throw new Error('AgentOutput schema was not found in prompt')
	return JSON.parse(match[1])
}

function extractQuotationExample(prompt: string): Record<string, unknown> {
	const section = /<quotation_example>\s*([\s\S]*?)\s*<\/quotation_example>/.exec(prompt)?.[1]
	const example = section?.split('\n').find((line) => line.trim().startsWith('{'))
	if (!example) throw new Error('Quotation example was not found in prompt')
	return JSON.parse(example)
}

/** OpenAI-compatible SSE stream whose delta.content carries the AgentOutput JSON. */
function openaiSseAgentResponse(args: unknown): Response {
	const content = JSON.stringify(args)
	const events = [
		`data: {"choices":[{"delta":{"content":${JSON.stringify(
			content.slice(0, Math.ceil(content.length / 2))
		)}}}]}\n\n`,
		`data: {"choices":[{"delta":{"content":${JSON.stringify(
			content.slice(Math.ceil(content.length / 2))
		)}}}]}\n\n`,
		`data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n`,
		'data: [DONE]\n\n',
	].join('')

	return new Response(events, {
		headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
	})
}

function createPageController(): PageController {
	const browserState: BrowserState = {
		url: 'https://example.test/',
		title: 'Test page',
		header: '',
		content: '',
		footer: '',
	}

	return {
		showMask: vi.fn(async () => {}),
		hideMask: vi.fn(),
		cleanUpHighlights: vi.fn(),
		getLastUpdateTime: vi.fn(() => Date.now()),
		getBrowserState: vi.fn(async () => browserState),
		dispose: vi.fn(),
	} as unknown as PageController
}

function createAgent(
	customFetch: TestFetch,
	options: Partial<ConstructorParameters<typeof PageAgentCore>[0]> = {}
): PageAgentCore {
	return new PageAgentCore({
		baseURL: 'https://llm.test',
		model: 'test-model',
		maxRetries: 0,
		stepDelay: 0,
		customFetch,
		customSystemPrompt: 'test',
		pageController: createPageController(),
		...options,
	})
}

function createFetchMock() {
	return vi.fn<TestFetchArgs, TestFetchResult>()
}

function onceActivity(
	agent: PageAgentCore,
	predicate: (detail: unknown) => boolean
): Promise<void> {
	return new Promise((resolve) => {
		const onActivity = (event: Event) => {
			if (!predicate((event as CustomEvent).detail)) return
			agent.removeEventListener('activity', onActivity)
			resolve()
		}

		agent.addEventListener('activity', onActivity)
	})
}

function isExecutingTool(detail: unknown, toolName: string): boolean {
	return (
		typeof detail === 'object' &&
		detail !== null &&
		'type' in detail &&
		'tool' in detail &&
		detail.type === 'executing' &&
		detail.tool === toolName
	)
}

function doneResponse(text: string, success = true): Response {
	return agentResponse({ action: { done: { text, success } } })
}

function waitResponse(seconds = 10): Response {
	return agentResponse({ action: { wait: { seconds } } })
}

/**
 * Start a task that blocks on `wait`, returning once the tool is executing.
 * The running promise is wrapped so awaiting this helper does not await the task.
 */
async function startBlockedTask(
	agent: PageAgentCore,
	task = 'first'
): Promise<{ result: Promise<ExecutionResult> }> {
	const waitStarted = onceActivity(agent, (detail) => isExecutingTool(detail, 'wait'))
	const result = agent.execute(task)
	await waitStarted
	return { result }
}

describe.concurrent('PageAgentCore lifecycle', () => {
	describe('normal execution', () => {
		it('runs a task to natural completion', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock)

			const result = await agent.execute('do something')

			expect(result).toMatchObject({ success: true, data: 'all done' })
			expect(agent.status).toBe('completed')
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('completes (not errors) when the LLM reports task failure', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('gave up', false))
			const agent = createAgent(fetchMock)

			const result = await agent.execute('do something')

			expect(result).toMatchObject({ success: false, data: 'gave up' })
			expect(agent.status).toBe('completed')
		})

		it('throws when a task is already running', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result } = await startBlockedTask(agent)

			await expect(agent.execute('second')).rejects.toThrow('A task is already running.')

			await agent.stop()
			await result
		})
	})

	describe('stop', () => {
		it('aborts the running task and keeps the agent reusable', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(waitResponse())
				.mockResolvedValueOnce(doneResponse('second task'))
			const agent = createAgent(fetchMock)
			const { result: firstTask } = await startBlockedTask(agent)

			await agent.stop()
			expect(agent.status).toBe('stopped')
			await expect(firstTask).resolves.toMatchObject({ success: false, data: 'Task aborted' })

			const secondTask = await agent.execute('second')
			expect(secondTask).toMatchObject({ success: true, data: 'second task' })
			expect(agent.status).toBe('completed')
		})

		it('resolves only after the run has fully settled', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result } = await startBlockedTask(agent)

			await agent.stop()
			expect(agent.status).toBe('stopped')
			await expect(result).resolves.toMatchObject({ success: false })
		})

		it('is a no-op when no task is running', async () => {
			const agent = createAgent(createFetchMock())

			await expect(agent.stop()).resolves.toBeUndefined()
			await expect(agent.stop()).resolves.toBeUndefined()
			expect(agent.status).toBe('idle')
		})
	})

	describe('dispose', () => {
		it('aborts the running task and blocks further execution', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result: task } = await startBlockedTask(agent)

			agent.dispose()
			await expect(task).resolves.toMatchObject({ success: false, data: 'Task aborted' })

			expect(agent.disposed).toBe(true)
			await expect(agent.execute('again')).rejects.toThrow('has been disposed')
		})

		it('is idempotent', () => {
			const agent = createAgent(createFetchMock())

			expect(() => {
				agent.dispose()
				agent.dispose()
			}).not.toThrow()
			expect(agent.disposed).toBe(true)
		})
	})

	describe('error handling', () => {
		it('fails the task when the network request rejects', async () => {
			const fetchMock = createFetchMock().mockRejectedValue(new Error('network down'))
			const agent = createAgent(fetchMock)

			const result = await agent.execute('do something')

			expect(result.success).toBe(false)
			expect(agent.status).toBe('error')
		})

		it('fails the task when a tool throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValue(agentResponse({ action: { boom: {} } }))
			const agent = createAgent(fetchMock, {
				customTools: {
					boom: tool({
						description: 'Always throws.',
						inputSchema: z.object({}),
						execute: async () => {
							throw new Error('tool exploded')
						},
					}),
				},
			})

			const result = await agent.execute('trigger tool error')

			expect(result.success).toBe(false)
			expect(agent.status).toBe('error')
		})

		it('re-throws and sets error status when onBeforeTask throws', async () => {
			const agent = createAgent(createFetchMock(), {
				onBeforeTask: async () => {
					throw new Error('setup failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('setup failed')
			expect(agent.status).toBe('error')
			expect(agent.history.some((e) => e.type === 'error')).toBe(false)
		})

		it('re-throws and sets error status when onAfterTask throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock, {
				onAfterTask: async () => {
					throw new Error('teardown failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('teardown failed')
			expect(agent.status).toBe('error')
		})

		it('stays reusable after onBeforeTask throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('second'))
			let failOnce = true
			const agent = createAgent(fetchMock, {
				onBeforeTask: async () => {
					if (failOnce) {
						failOnce = false
						throw new Error('setup failed')
					}
				},
			})

			await expect(agent.execute('first')).rejects.toThrow('setup failed')
			const result = await agent.execute('second')
			expect(result).toMatchObject({ success: true, data: 'second' })
		})

		it('re-throws and sets error status when onBeforeStep throws', async () => {
			const agent = createAgent(createFetchMock(), {
				onBeforeStep: async () => {
					throw new Error('before step failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('before step failed')
			expect(agent.status).toBe('error')
			expect(agent.history.some((e) => e.type === 'error')).toBe(false)
		})

		it('re-throws and sets error status when onAfterStep throws', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))
			const agent = createAgent(fetchMock, {
				onAfterStep: async () => {
					throw new Error('after step failed')
				},
			})

			await expect(agent.execute('do something')).rejects.toThrow('after step failed')
			expect(agent.status).toBe('error')
			expect(agent.history.some((e) => e.type === 'error')).toBe(false)
		})
	})

	describe('system_prompt tool injection', () => {
		it('defaults Tl provider to system_prompt mode and injects the canonical schema', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'test-session' } }))
				)
				.mockResolvedValueOnce(tlSseAgentResponse({ action: { done: { text: 'all done' } } }))

			const agent = createAgent(fetchMock, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: 'custom system prompt',
			})

			expect(agent.config.toolCallingMode).toBe('system_prompt')
			const result = await agent.execute('do something')
			expect(result).toMatchObject({ success: true, data: 'all done' })

			const chatBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string) as {
				data: { txt: string }
			}
			expect(chatBody.data.txt).toContain('<output_contract mode="system_prompt">')
			expect(chatBody.data.txt).toContain('<agent_output_schema>')
			expect(chatBody.data.txt).toContain('"action"')
			expect(chatBody.data.txt).toContain('"done"')
			expect(chatBody.data.txt).not.toContain('<tools>')
			expect(chatBody.data.txt).not.toContain('"type": "function"')
		})

		it('uses the same AgentOutput schema for system-prompt and native tool modes', async () => {
			const nativeFetch = createFetchMock().mockResolvedValueOnce(doneResponse('native done'))
			const nativeAgent = createAgent(nativeFetch, { customSystemPrompt: undefined })
			await nativeAgent.execute('do something')

			const nativeBody = JSON.parse(nativeFetch.mock.calls[0][1]!.body as string) as {
				tools: { function: { name: string; parameters: unknown } }[]
			}
			const nativeSchema = nativeBody.tools.find(
				(toolDefinition) => toolDefinition.function.name === 'AgentOutput'
			)?.function.parameters

			const tlFetch = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'test-session' } }))
				)
				.mockResolvedValueOnce(tlSseAgentResponse({ action: { done: { text: 'tl done' } } }))
			const tlAgent = createAgent(tlFetch, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: undefined,
			})
			await tlAgent.execute('do something')

			const tlBody = JSON.parse(tlFetch.mock.calls[1][1]!.body as string) as {
				data: { txt: string }
			}
			const tlSchema = extractAgentOutputSchema(tlBody.data.txt)

			expect(tlSchema).toEqual(nativeSchema)
			expect(tlSchema).toMatchObject({ required: ['action'] })
			expect(tlBody.data.txt.match(/<output_contract\b/g)).toHaveLength(1)
			expect(tlBody.data.txt).toContain('use JSON-escaped ASCII double quotes \\"...\\"')
			expect(tlBody.data.txt).not.toContain('"tool_name"')
		})

		it('generates the canonical schema from every enabled action', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'test-session' } }))
				)
				.mockResolvedValueOnce(tlSseAgentResponse({ action: { done: { text: 'all done' } } }))
			const agent = createAgent(fetchMock, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: undefined,
			})

			await agent.execute('do something')

			const requestBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string) as {
				data: { txt: string }
			}
			const systemContent = requestBody.data.txt

			// Enabled by default: always documented
			for (const actionName of [
				'done',
				'wait',
				'click_element_by_index',
				'input_text',
				'select_dropdown_option',
				'scroll',
				'scroll_horizontally',
			]) {
				expect(systemContent).toContain(`"${actionName}"`)
			}
			// Disabled by default: never advertised (ask_user has no callback, execute_javascript is gated)
			for (const actionName of ['ask_user', 'execute_javascript']) {
				expect(systemContent).not.toContain(`"${actionName}"`)
			}
			expect(systemContent).toContain('"additionalProperties": false')
			expect(systemContent).toContain('"index"')
			expect(systemContent).toContain('"num_pages"')
		})

		it('includes conditionally-enabled actions in the canonical schema', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'test-session' } }))
				)
				.mockResolvedValueOnce(tlSseAgentResponse({ action: { done: { text: 'all done' } } }))
			const agent = createAgent(fetchMock, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: undefined,
				experimentalScriptExecutionTool: true,
			})
			agent.onAskUser = async () => 'yes'

			await agent.execute('do something')

			const requestBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string) as {
				data: { txt: string }
			}
			const systemContent = requestBody.data.txt

			expect(systemContent).toContain('"ask_user"')
			expect(systemContent).toContain('"execute_javascript"')
		})

		it('injects the canonical schema even when a customSystemPrompt is used', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'test-session' } }))
				)
				.mockResolvedValueOnce(tlSseAgentResponse({ action: { done: { text: 'all done' } } }))

			const agent = createAgent(fetchMock, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				toolCallingMode: 'system_prompt',
				customSystemPrompt: 'custom system prompt',
			})

			await agent.execute('do something')

			expect(fetchMock).toHaveBeenCalledTimes(2)

			const chatCall = fetchMock.mock.calls[1]
			const chatUrl = chatCall[0] as string
			const chatBody = JSON.parse(chatCall[1]!.body as string) as { data: { txt: string } }
			const chatText = chatBody.data.txt

			expect(chatUrl).toContain('/chatbbc/chat')
			expect(chatText).toContain('custom system prompt')
			expect(chatText).toContain('<quotation_example>')
			expect(chatText).toContain('<output_contract mode="system_prompt">')
			expect(chatText).toContain('<agent_output_schema>')
			expect(chatText).toContain('use JSON-escaped ASCII double quotes \\"...\\"')
			expect(chatText).toContain('"done"')
			expect(chatText).not.toContain('<tools>')
		})

		it('keeps system prompt variables separate from dynamic user state across Tl steps', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'first-session' } }))
				)
				.mockResolvedValueOnce(
					tlSseAgentResponse({
						action: { record_observation: { value: 'first observation' } },
					})
				)
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'second-session' } }))
				)
				.mockResolvedValueOnce(
					tlSseAgentResponse({ action: { done: { text: 'all done', success: true } } })
				)

			const agent = createAgent(fetchMock, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: undefined,
				tlPromptTransport: 'prompt_variables',
				customTools: {
					record_observation: tool({
						description: 'Record an observation before completing the task.',
						inputSchema: z.object({ value: z.string() }),
						execute: async (input) => `Recorded observation: ${input.value}`,
					}),
				},
			})

			const result = await agent.execute('two step task')

			expect(result).toMatchObject({ success: true, data: 'all done' })
			expect(fetchMock).toHaveBeenCalledTimes(4)

			const initBodies = [0, 2].map(
				(callIndex) =>
					JSON.parse(fetchMock.mock.calls[callIndex][1]!.body as string) as {
						data: { prompt_variables: { name: string; value: string }[] }
					}
			)
			const firstPromptVariables = initBodies[0].data.prompt_variables
			const secondPromptVariables = initBodies[1].data.prompt_variables

			expect(firstPromptVariables.map(({ name }) => name)).toEqual(['system_prompt'])
			const firstSystemPrompt = firstPromptVariables[0].value
			expect(firstSystemPrompt).toContain('<agent_output_schema>')
			expect(firstSystemPrompt).toContain('record_observation')
			expect(firstSystemPrompt).toContain('use JSON-escaped ASCII double quotes \\"...\\"')
			expect(firstSystemPrompt).toContain('页面显示\\"父页面异步内容已加载\\"')
			expect(extractQuotationExample(firstSystemPrompt)).toMatchObject({
				evaluation_previous_goal: '页面显示"父页面异步内容已加载"，判定：成功',
				memory: '已确认姓名为"张三"',
				next_goal: '等待"提交"按钮变为可用',
				action: { wait: { seconds: 1 } },
			})
			expect(firstSystemPrompt.indexOf('<quotation_example>')).toBeLessThan(
				firstSystemPrompt.indexOf('<output_contract mode="system_prompt">')
			)
			expect(firstSystemPrompt.trim().endsWith('</output_contract>')).toBe(true)
			expect(secondPromptVariables).toEqual(firstPromptVariables)

			const chatTexts = [1, 3].map((callIndex) => {
				const body = JSON.parse(fetchMock.mock.calls[callIndex][1]!.body as string) as {
					data: { txt: string }
				}
				return body.data.txt
			})

			for (const chatText of chatTexts) {
				expect(chatText).not.toMatch(/(?:^|\n)(?:system|user):/)
				expect(chatText).not.toContain('<agent_output_schema>')
				expect(chatText).toContain('<user_request>')
				expect(chatText).toContain('<browser_state>')
			}
			expect(chatTexts[0]).toContain('two step task')
			expect(chatTexts[1]).toContain('<step_1>')
			expect(chatTexts[1]).toContain('Recorded observation: first observation')
		})

		it('corrects malformed reflection quotes through a fresh Tl session', async () => {
			const malformedContent =
				'{"evaluation_previous_goal":"异步内容已加载（显示"父页面异步内容已加载"）。Verdict: 成功","memory":"继续操作","next_goal":"点击按钮","action":{"done":{"text":"finished","success":true}}}'
			const failureLogger = vi.fn()
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'first-session' } }))
				)
				.mockResolvedValueOnce(tlSseContentResponse(malformedContent))
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'correction-session' } }))
				)
				.mockResolvedValueOnce(
					tlSseAgentResponse({
						evaluation_previous_goal: '异步内容已加载（显示"父页面异步内容已加载"）。Verdict: 成功',
						memory: '继续操作',
						next_goal: '点击按钮',
						action: { done: { text: 'finished', success: true } },
					})
				)

			const agent = createAgent(fetchMock, {
				provider: 'tl',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: undefined,
				tlPromptTransport: 'prompt_variables',
				tlFailureLogger: failureLogger,
			})

			await expect(agent.execute('test malformed reflection quotes')).resolves.toMatchObject({
				success: true,
				data: 'finished',
			})
			expect(fetchMock).toHaveBeenCalledTimes(4)
			expect(failureLogger).toHaveBeenCalledTimes(1)

			const firstInit = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
			const correctionInit = JSON.parse(fetchMock.mock.calls[2][1]!.body as string)
			expect(correctionInit.data.prompt_variables).toEqual(firstInit.data.prompt_variables)

			const correctionChat = JSON.parse(fetchMock.mock.calls[3][1]!.body as string).data.txt
			const correctionPayload = JSON.parse(correctionChat)
			expect(correctionPayload.failed_assistant_content).toBe(malformedContent)
			expect(correctionPayload.parse_error).toMatchObject({
				type: 'invalid_response',
				message: 'Extracted AgentOutput object is not valid JSON',
				cause: { name: 'SyntaxError' },
			})
		})

		it('does not inject a textual schema for native tool mode with a customSystemPrompt', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(doneResponse('all done'))

			const agent = createAgent(fetchMock, {
				customSystemPrompt: 'custom system prompt',
			})

			await agent.execute('do something')

			const requestBody = JSON.parse((fetchMock.mock.calls[0][1]!.body as string) ?? '{}') as {
				messages: { role: string; content: string }[]
			}
			const systemContent = requestBody.messages.find((m) => m.role === 'system')?.content ?? ''

			expect(systemContent).toContain('custom system prompt')
			expect(systemContent).not.toContain('<agent_output_schema>')
			expect(systemContent).not.toContain('<output_contract')
		})

		it('defaults Ds provider to system_prompt mode and injects the canonical schema in gateway mode', async () => {
			const fetchMock = createFetchMock()
				.mockResolvedValueOnce(
					new Response(JSON.stringify({ code: 0, data: { session_id: 'test-session' } }))
				)
				.mockResolvedValueOnce(tlSseAgentResponse({ action: { done: { text: 'all done' } } }))

			const agent = createAgent(fetchMock, {
				provider: 'ds',
				endpointAgent: 'localhost:8089',
				customSystemPrompt: undefined,
			})

			expect(agent.config.toolCallingMode).toBe('system_prompt')
			const result = await agent.execute('do something')
			expect(result).toMatchObject({ success: true, data: 'all done' })

			const chatBody = JSON.parse(fetchMock.mock.calls[1][1]!.body as string) as {
				data: { txt: string }
			}
			expect(chatBody.data.txt).toContain('<output_contract mode="system_prompt">')
			expect(chatBody.data.txt).toContain('<deepseek_json_output>')
			expect(chatBody.data.txt).toContain('<agent_output_schema>')
			expect(chatBody.data.txt).toContain('"done"')
		})

		it('injects the canonical schema for Ds provider in api mode and sends response_format', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(
				openaiSseAgentResponse({ action: { done: { text: 'all done' } } })
			)

			const agent = createAgent(fetchMock, {
				provider: 'ds',
				baseURL: 'https://api.deepseek.com',
				apiKey: 'sk-test',
				customSystemPrompt: undefined,
			})

			const result = await agent.execute('do something')
			expect(result).toMatchObject({ success: true, data: 'all done' })

			const request = fetchMock.mock.calls[0][1]!
			const body = JSON.parse(request.body as string) as {
				messages: { role: string; content: string }[]
				response_format: { type: string }
				tools?: unknown
			}
			expect((request.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
			expect(body.response_format).toEqual({ type: 'json_object' })
			expect(body.tools).toBeUndefined()
			const systemContent = body.messages.find((m) => m.role === 'system')?.content ?? ''
			expect(systemContent).toContain('<output_contract mode="system_prompt">')
			expect(systemContent).toContain('<deepseek_json_output>')
			expect(systemContent).toContain('"action":{"done"')
			expect(systemContent).toContain('<agent_output_schema>')
		})

		it('injects the canonical schema for Ds provider even with a customSystemPrompt', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(
				openaiSseAgentResponse({ action: { done: { text: 'all done' } } })
			)

			const agent = createAgent(fetchMock, {
				provider: 'ds',
				baseURL: 'https://api.deepseek.com',
				customSystemPrompt: 'custom ds prompt',
			})

			await agent.execute('do something')

			const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as {
				messages: { role: string; content: string }[]
			}
			const systemContent = body.messages.find((m) => m.role === 'system')?.content ?? ''
			expect(systemContent).toContain('custom ds prompt')
			expect(systemContent).toContain('<output_contract mode="system_prompt">')
			expect(systemContent).toContain('<agent_output_schema>')
		})
	})

	describe('cancellation edge cases', () => {
		it('rejects a new task while a stop is still settling', async () => {
			const fetchMock = createFetchMock().mockResolvedValueOnce(waitResponse())
			const agent = createAgent(fetchMock)
			const { result: firstTask } = await startBlockedTask(agent)

			const stopped = agent.stop()

			await expect(agent.execute('too early')).rejects.toThrow('A task is already running.')

			await stopped
			await expect(firstTask).resolves.toMatchObject({ success: false, data: 'Task aborted' })
			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('discards a custom tool result that resolves after stop', async () => {
			let resolveTool!: () => void
			let notifyToolStarted!: () => void
			const toolFinished = new Promise<void>((resolve) => {
				resolveTool = resolve
			})
			const toolStarted = new Promise<void>((resolve) => {
				notifyToolStarted = resolve
			})
			const fetchMock = createFetchMock().mockResolvedValue(
				agentResponse({ action: { slow_tool: {} } })
			)
			const agent = createAgent(fetchMock, {
				customTools: {
					slow_tool: tool({
						description: 'A tool that deliberately ignores cancellation.',
						inputSchema: z.object({}),
						execute: async () => {
							notifyToolStarted()
							await toolFinished
							return 'ignored stop'
						},
					}),
				},
			})

			const task = agent.execute('run slow tool')
			await toolStarted

			const stopped = agent.stop()
			resolveTool()
			await stopped

			await expect(task).resolves.toMatchObject({ success: false, data: 'Task aborted' })
			expect(agent.status).toBe('stopped')
		})
	})
})
