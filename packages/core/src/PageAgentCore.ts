/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * Copyright (C) 2026 SimonLuvRamen
 * All rights reserved.
 */
import { InvokeError, LLM, type Tool } from '@page-agent/llms'
import chalk from 'chalk'
import * as z from 'zod/v4'

import SYSTEM_PROMPT from './prompts/system_prompt.md?raw'
import SYSTEM_PROMPT_TOOLS from './prompts/system_prompt_tools.md?raw'
import { tools } from './tools'
import {
	assert,
	buildAgentOutputSchema,
	fetchLlmsTxt,
	normalizeResponse,
	suppress,
	uid,
	waitFor,
} from './utils'

import type {
	AgentActivity,
	AgentConfig,
	AgentReflection,
	AgentStatus,
	AgentStepEvent,
	ExecutionResult,
	HistoricalEvent,
	MacroToolInput,
	MacroToolResult,
} from './types'
import type { BrowserState, PageControllerAdapter } from '@page-agent/page-controller'

export { tool, type PageAgentTool, type ToolContext } from './tools'
export type * from './types'

/**
 * Providers whose client only supports `system_prompt` tool calling. For these,
 * PageAgentCore injects the canonical AgentOutput schema into the system prompt
 * instead of relying on native function calling.
 */
const SYSTEM_PROMPT_PROVIDERS: ReadonlySet<string> = new Set(['tl', 'ds'])

export type PageAgentCoreConfig<TController extends PageControllerAdapter = PageControllerAdapter> =
	AgentConfig & { pageController: TController }

/**
 * AI agent for browser automation.
 *
 * @remarks
 * ## Re-act Agent Loop
 * - step
 *    - observe (gather information about current environment and context)
 *    - think (LLM calling)
 *      - reflection (evaluate history, generate memory, short-term planning)
 *      - action (give the action to approach the next goal)
 *    - act (execute the action)
 * - loop
 *
 * ## Event System
 * - `statuschange` - Agent status transitions (idle → running → completed/error/stopped)
 * - `historychange` - History events updated (persistent, part of agent memory)
 * - `activity` - Real-time activity feedback (transient, for UI only)
 * - `dispose` - Agent cleanup triggered
 *
 * ## Information Streams
 * 1. **History Events** (`history` array)
 *    - Persistent event stream that forms agent's memory
 *    - Included in LLM context across steps
 *    - Types: steps, observations, user takeovers, llm errors
 *
 * 2. **Activity Events** (via `activity` event)
 *    - Transient UI feedback during task execution
 *    - NOT included in LLM context
 *    - Types: thinking, executing, executed, retrying, error
 */
export class PageAgentCore<
	TController extends PageControllerAdapter = PageControllerAdapter,
> extends EventTarget {
	readonly id = uid()
	readonly config: PageAgentCoreConfig<TController> & { maxSteps: number }
	readonly tools: typeof tools
	/** Controller used for page observation and actions. */
	readonly pageController: TController

	task = ''
	taskId = ''
	/** History events */
	history: HistoricalEvent[] = []
	/** Whether this agent has been disposed */
	disposed = false

	/**
	 * Called when the agent needs to ask the user questions.
	 * If unset, the `ask_user` tool will be disabled.
	 * Implementations should reject the promise when `signal` aborts.
	 * @example onAskUser: (q) => window.prompt(q) || ''
	 */
	onAskUser?: (question: string, options?: { signal: AbortSignal }) => Promise<string>

	#status: AgentStatus = 'idle'
	#llm: LLM
	/**
	 * Task cancellation primitive: its signal reaches the LLM fetch, tools
	 * (via `ctx.signal`) and async callbacks. Aborted only by `stop`/`dispose`
	 * (during a task) or task setup, always WITHOUT a reason so `signal.reason`
	 * stays a standard `AbortError`.
	 */
	#abortController = new AbortController()
	#observations: string[] = []

	/** Resolves when the current run has fully settled. Awaited by `stop()`. */
	#running: Promise<void> = Promise.resolve()
	#lastResult: ExecutionResult | null = null

	/** internal states during a single task execution */
	#states = {
		/** Accumulated wait time in seconds */
		totalWaitTime: 0,
		/** For detecting navigation */
		lastURL: '',
		/** Browser state */
		browserState: null as BrowserState | null,
	}

	constructor(config: PageAgentCoreConfig<TController>) {
		super()

		const toolCallingMode = SYSTEM_PROMPT_PROVIDERS.has(config.provider ?? '')
			? config.toolCallingMode ?? 'system_prompt'
			: config.toolCallingMode
		this.config = { ...config, toolCallingMode, maxSteps: config.maxSteps ?? 40 }

		this.#llm = new LLM(this.config)
		this.tools = new Map(tools)
		this.pageController = config.pageController

		this.#llm.addEventListener('retry', (e) => {
			const { attempt, maxAttempts, lastError } = (e as CustomEvent).detail
			this.#emitActivity({ type: 'retrying', attempt, maxAttempts })
			this.history.push({
				type: 'error',
				message: String(lastError),
				rawResponse: (lastError as InvokeError).rawResponse,
			})
			this.history.push({
				type: 'retry',
				message: `LLM retry attempt ${attempt} of ${maxAttempts}`,
				attempt,
				maxAttempts,
			})
			this.#emitHistoryChange()
		})

		if (this.config.customTools) {
			for (const [name, tool] of Object.entries(this.config.customTools)) {
				if (tool === null) {
					this.tools.delete(name)
					continue
				}
				this.tools.set(name, tool)
			}
		}

		if (!this.config.experimentalScriptExecutionTool) {
			this.tools.delete('execute_javascript')
		}
	}

	/** Get current agent status */
	get status(): AgentStatus {
		return this.#status
	}

	/** Result of the most recent run, or `null` before the first run completes. */
	get lastResult(): ExecutionResult | null {
		return this.#lastResult
	}

	/** Emit statuschange event */
	#emitStatusChange(): void {
		this.dispatchEvent(new Event('statuschange'))
	}

	/** Emit historychange event */
	#emitHistoryChange(pushHistoricalEvent?: HistoricalEvent): void {
		if (pushHistoricalEvent) this.history.push(pushHistoricalEvent)
		this.dispatchEvent(new Event('historychange'))
	}

	/**
	 * Emit activity event - for transient UI feedback
	 * @param activity - Current agent activity
	 */
	#emitActivity(activity: AgentActivity): void {
		this.dispatchEvent(new CustomEvent('activity', { detail: activity }))
	}

	/** Update status and emit event */
	#setStatus(status: AgentStatus): void {
		if (this.#status !== status) {
			this.#status = status
			this.#emitStatusChange()
		}
	}

	/**
	 * Push an observation message to the history event stream.
	 * This will be visible in <agent_history> and remain persistent in memory across steps.
	 * @experimental @internal
	 * @note history change will be emitted before next step starts
	 */
	pushObservation(content: string): void {
		this.#observations.push(content)
	}

	/**
	 * Stop the current task and wait until the run has fully settled (including lifecycle hooks).
	 * @note never await .stop() in a lifecycle hook.
	 */
	async stop(): Promise<void> {
		if (this.#status !== 'running') return
		this.#abortController.abort()
		await this.#running
	}

	/**
	 * external errors (pre-checks/config/hooks) will threw;
	 * agent errors will be caught and added to history, and return a failed result
	 */
	async execute(task: string): Promise<ExecutionResult> {
		// pre-checks
		if (this.disposed) throw new Error('PageAgent has been disposed. Create a new instance.')
		if (this.#status === 'running') throw new Error('A task is already running.')
		if (!task) throw new Error('Task is required')

		this.task = task
		this.taskId = uid()

		this.history = []
		this.#observations = []
		this.#states = { totalWaitTime: 0, lastURL: '', browserState: null }
		this.#abortController = new AbortController()
		const signal = this.#abortController.signal

		let resolveRunning!: () => void
		this.#running = new Promise<void>((r) => (resolveRunning = r))

		this.#setStatus('running')
		this.#emitHistoryChange()

		// Disable ask_user tool if onAskUser is not set
		if (!this.onAskUser) this.tools.delete('ask_user')

		const onBeforeStep = this.config.onBeforeStep
		const onAfterStep = this.config.onAfterStep
		const onBeforeTask = this.config.onBeforeTask
		const onAfterTask = this.config.onAfterTask
		const stepDelay = this.config.stepDelay ?? 0.4
		const maxSteps = this.config.maxSteps

		let step = 0
		let taskResult: ExecutionResult
		let finalStatus: AgentStatus = 'error'

		await suppress(() => this.pageController.showMask())

		// graceful exit
		try {
			await onBeforeTask?.(this)

			while (true) {
				await onBeforeStep?.(this, step)

				// handle internal agent errors
				try {
					console.group(`step: ${step}`)

					// @note It's convenient to treat stepDelay as part of the next step.
					// Maybe move it to a dedicated try block for better semantics?
					if (step > 0) await waitFor(stepDelay, signal)

					signal.throwIfAborted()

					// observe

					console.log(chalk.blue.bold('👀 Observing...'))

					this.#states.browserState = await this.pageController.getBrowserState({ signal })
					await this.#handleObservations(step, signal)

					// assemble prompts

					const messages = [
						{ role: 'system' as const, content: this.#getSystemPrompt() },
						{ role: 'user' as const, content: await this.#assembleUserPrompt() },
					]

					const macroTool = { AgentOutput: this.#packMacroTool() }

					// invoke LLM

					console.log(chalk.blue.bold('🧠 Thinking...'))
					this.#emitActivity({ type: 'thinking' })

					const result = await this.#llm.invoke(messages, macroTool, signal, {
						toolChoiceName: 'AgentOutput',
						normalizeResponse: (res) => normalizeResponse(res, this.tools),
					})

					// assemble history

					const macroResult = result.toolResult as MacroToolResult
					const input = macroResult.input
					const output = macroResult.output
					const reflection: Partial<AgentReflection> = {
						evaluation_previous_goal: input.evaluation_previous_goal,
						memory: input.memory,
						next_goal: input.next_goal,
					}
					const actionName = Object.keys(input.action)[0]
					const action: AgentStepEvent['action'] = {
						name: actionName,
						input: input.action[actionName],
						output: output,
					}

					this.#emitHistoryChange({
						type: 'step',
						stepIndex: step,
						reflection,
						action,
						usage: result.usage,
						rawResponse: result.rawResponse,
						rawRequest: result.rawRequest,
					})

					if (actionName === 'done') {
						const success = action.input?.success ?? false
						const data = action.input?.text || 'no text provided'
						console.log(chalk.green.bold('Task completed'), success, data)
						taskResult = { success, data, history: this.history }
						this.#lastResult = taskResult
						finalStatus = 'completed'
						break
					}
				} catch (error: unknown) {
					// catch block must not throw error. otherwise the error may be overridden if finally block also throws error.

					const isAbortError = (error as any)?.name === 'AbortError'
					if (!isAbortError) console.error('Task failed', error)
					const message = isAbortError ? 'Task aborted' : String(error)
					this.#emitActivity({ type: 'error', message: message })
					this.#emitHistoryChange({ type: 'error', message: message, rawResponse: error })
					taskResult = { success: false, data: message, history: this.history }
					this.#lastResult = taskResult
					finalStatus = isAbortError ? 'stopped' : 'error'
					break
				} finally {
					// finally block runs before the break above.

					console.groupEnd()
					// @note hook may throw error.
					// which will override the `break` above and be handled as an external error.
					// as expected.
					await onAfterStep?.(this, this.history)
				}

				step++
				if (step > maxSteps) {
					const message = 'Step count exceeded maximum limit'
					console.error(message)
					this.#emitActivity({ type: 'error', message: message })
					this.#emitHistoryChange({ type: 'error', message: message })
					taskResult = { success: false, data: message, history: this.history }
					this.#lastResult = taskResult
					finalStatus = 'error'
					break
				}
			} // while

			await onAfterTask?.(this, taskResult)

			return taskResult
		} catch (error) {
			this.#emitActivity({ type: 'error', message: String(error) })
			finalStatus = 'error'
			throw error
		} finally {
			await suppress(() => this.pageController.cleanUpHighlights())
			await suppress(() => this.pageController.hideMask())
			this.#abortController.abort()
			resolveRunning()
			this.#setStatus(finalStatus)
		}
	}

	/**
	 * Merge all runtime actions into the canonical AgentOutput macro tool.
	 * Reflection strings are optional; `action` is required and must contain
	 * exactly one entry selected from `this.tools`.
	 */
	#packMacroTool(): Tool<MacroToolInput, MacroToolResult> {
		const tools = this.tools
		const macroToolSchema = buildAgentOutputSchema(tools)

		return {
			description: 'You MUST call this tool every step!',
			inputSchema: macroToolSchema as z.ZodType<MacroToolInput>,
			execute: async (input: MacroToolInput): Promise<MacroToolResult> => {
				const signal = this.#abortController.signal
				signal.throwIfAborted()

				console.log(chalk.blue.bold('MacroTool input'), input)
				const action = input.action

				const toolName = Object.keys(action)[0]
				const toolInput = action[toolName]

				// Build reflection text, only include non-empty fields
				const reflectionLines: string[] = []
				if (input.evaluation_previous_goal)
					reflectionLines.push(`✅: ${input.evaluation_previous_goal}`)
				if (input.memory) reflectionLines.push(`💾: ${input.memory}`)
				if (input.next_goal) reflectionLines.push(`🎯: ${input.next_goal}`)

				const reflectionText = reflectionLines.length > 0 ? reflectionLines.join('\n') : ''

				if (reflectionText) {
					console.log(reflectionText)
				}

				// Find the corresponding tool
				const tool = tools.get(toolName)
				assert(tool, `Tool ${toolName} not found`)

				console.log(chalk.blue.bold(`Executing tool: ${toolName}`), toolInput)

				// Emit executing activity
				this.#emitActivity({ type: 'executing', tool: toolName, input: toolInput })

				const startTime = Date.now()

				const result = await tool.execute.bind(this)(toolInput, { signal })
				// Enforce abort even if the tool ignored the signal and resolved normally.
				signal.throwIfAborted()

				const duration = Date.now() - startTime
				console.log(chalk.green.bold(`Tool (${toolName}) executed for ${duration}ms`), result)

				// Emit executed activity
				this.#emitActivity({
					type: 'executed',
					tool: toolName,
					input: toolInput,
					output: result,
					duration,
				})

				// counting wait time
				if (toolName === 'wait') {
					this.#states.totalWaitTime += toolInput?.seconds || 0
				} else {
					this.#states.totalWaitTime = 0
				}

				// Return structured result
				return {
					input,
					output: result,
				}
			},
		}
	}

	/**
	 * Get system prompt, dynamically replace language settings based on configured language.
	 *
	 * In `system_prompt` tool-calling mode, the canonical AgentOutput input schema
	 * is injected dynamically. The schema is built by the same method used to
	 * validate the native AgentOutput tool, so prompt and parser cannot drift.
	 *
	 * In other modes, only the macro-tool output-format documentation is appended;
	 * the actual tool schemas are delivered to the LLM via the native function-calling API.
	 */
	#getSystemPrompt(): string {
		const usesSystemPromptTools =
			this.config.toolCallingMode === 'system_prompt' &&
			SYSTEM_PROMPT_PROVIDERS.has(this.config.provider ?? '')
		const outputContract = usesSystemPromptTools
			? this.#buildSystemPromptOutputContract()
			: this.#buildNativeToolOutputContract()
		const quotationExample = usesSystemPromptTools ? this.#buildQuotationExample() : ''

		if (this.config.customSystemPrompt) {
			// Native API mode already carries the AgentOutput schema in the tools request.
			// System-prompt mode must append the quotation example and canonical schema
			// even for custom prompts. Keep the output contract last so no later prose
			// weakens the JSON format requirements.
			return usesSystemPromptTools
				? `${this.config.customSystemPrompt}\n\n${quotationExample}\n\n${outputContract}`
				: this.config.customSystemPrompt
		}

		const targetLanguage = this.config.language === 'zh-CN' ? '中文' : 'English'
		const systemPrompt = SYSTEM_PROMPT.replace(
			/Default working language: \*\*.*?\*\*/,
			`Default working language: **${targetLanguage}**`
		)
		const macroToolPrompt = SYSTEM_PROMPT_TOOLS.replace(
			'<!-- quotation-example -->',
			quotationExample
		)
		return `${systemPrompt}\n\n${macroToolPrompt}\n\n${outputContract}`
	}

	/** Build a parseable example that distinguishes JSON delimiters from quotations in reflection text. */
	#buildQuotationExample(): string {
		return `<quotation_example>
The following object is a valid JSON example for quotation handling only. For real steps, always select an
action and parameters from the current AgentOutput schema.
{"evaluation_previous_goal":"页面显示\\"父页面异步内容已加载\\"，判定：成功","memory":"已确认姓名为\\"张三\\"","next_goal":"等待\\"提交\\"按钮变为可用","action":{"wait":{"seconds":1}}}
JSON keys and string boundaries use ASCII double quotes. ASCII double quotes around page text, labels,
names, and other human-readable content inside reflection strings use the JSON escape sequence \\"...\\".
</quotation_example>`
	}

	/**
	 * Build the only wire contract advertised in system-prompt mode: one raw JSON
	 * object matching the exact AgentOutput input schema. Inner actions are part
	 * of that schema instead of being advertised as separate function calls.
	 */
	#buildSystemPromptOutputContract(): string {
		// Match the JSON Schema dialect used by zodToOpenAITool in @page-agent/llms.
		const schema = z.toJSONSchema(buildAgentOutputSchema(this.tools), { target: 'draft-7' })
		const deepSeekJsonGuidance =
			this.config.provider === 'ds'
				? `
<deepseek_json_output>
DeepSeek JSON Output mode is enabled. Emit one complete, valid JSON object and no surrounding text.
This example demonstrates the JSON envelope only; the current schema remains authoritative for the action:
{"evaluation_previous_goal":"...","memory":"...","next_goal":"...","action":{"done":{"text":"...","success":true}}}
</deepseek_json_output>
`
				: ''
		return `<output_contract mode="system_prompt">
Return exactly one raw JSON object matching the schema below. The object itself is the complete AgentOutput
input. Do not wrap it in AgentOutput, tool_call, function, name/arguments, XML, markdown, or explanatory
text. Do not call an inner action as a top-level tool.
Use valid JSON double quotes for every key and string boundary, and escape quotes and newlines inside
strings. Do not emit trailing commas, comments, single-quoted strings, NaN, markdown fences, XML, or
reasoning outside the canonical output.
In evaluation_previous_goal, memory, and next_goal, use JSON-escaped ASCII double quotes \\"...\\" when
quoting page text, labels, names, or other human-readable content. Never place an unescaped ASCII double
quote inside a JSON string. After JSON parsing, these escaped sequences become ordinary ASCII quotes in
the field value.
${deepSeekJsonGuidance}

<agent_output_schema>
${JSON.stringify(schema, null, 2)}
</agent_output_schema>
</output_contract>`
	}

	/** Build the transport instruction for native function-calling providers. */
	#buildNativeToolOutputContract(): string {
		return `<output_contract mode="native_tool_call">
Call the native AgentOutput tool exactly once. Its arguments are the canonical output object. Do not call
an inner action tool directly and do not place the AgentOutput object in assistant message content.
</output_contract>`
	}

	/**
	 * Get instructions from config
	 */
	async #getInstructions(): Promise<string> {
		const { instructions, experimentalLlmsTxt } = this.config

		const systemInstructions = instructions?.system?.trim()
		let pageInstructions: string | undefined

		const url = this.#states.browserState?.url || ''
		if (instructions?.getPageInstructions && url) {
			try {
				pageInstructions = instructions.getPageInstructions(url)?.trim()
			} catch (error) {
				console.error(
					chalk.red('[PageAgent] Failed to execute getPageInstructions callback:'),
					error
				)
			}
		}

		const llmsTxt = experimentalLlmsTxt && url ? await fetchLlmsTxt(url) : undefined

		if (!systemInstructions && !pageInstructions && !llmsTxt) return ''

		let result = '<instructions>\n'

		if (systemInstructions) {
			result += `<system_instructions>\n${systemInstructions}\n</system_instructions>\n`
		}

		if (pageInstructions) {
			result += `<page_instructions>\n${pageInstructions}\n</page_instructions>\n`
		}

		if (llmsTxt) {
			result += `<llms_txt>\n${llmsTxt}\n</llms_txt>\n`
		}

		result += '</instructions>\n\n'

		return result
	}

	/**
	 * Generate system observations before each step
	 * @todo loop detection
	 * @todo console error
	 */
	async #handleObservations(step: number, signal: AbortSignal): Promise<void> {
		// Accumulated wait time warning
		if (this.#states.totalWaitTime >= 3) {
			this.pushObservation(
				`You have waited ${this.#states.totalWaitTime} seconds accumulatively. ` +
					`DO NOT wait any longer unless you have a good reason.`
			)
		}

		// Detect URL change
		const currentURL = this.#states.browserState?.url || ''
		if (currentURL !== this.#states.lastURL) {
			this.pushObservation(`Page navigated to → ${currentURL}`)
			this.#states.lastURL = currentURL
			await waitFor(0.5, signal) // wait for page to stabilize
		}

		// Remaining steps warning
		const remaining = this.config.maxSteps - step
		if (remaining === 5) {
			this.pushObservation(
				`⚠️ Only ${remaining} steps remaining. ` +
					`Consider wrapping up or calling done with partial results.`
			)
		} else if (remaining === 2) {
			this.pushObservation(
				`⚠️ Critical: Only ${remaining} steps left! You must finish the task or call done immediately.`
			)
		}

		// Push observations to history and emit
		if (this.#observations.length > 0) {
			for (const content of this.#observations) {
				this.history.push({ type: 'observation', content })
				console.log(chalk.cyan('Observation:'), content)
			}
			this.#observations = []
			this.#emitHistoryChange()
		}
	}

	async #assembleUserPrompt(): Promise<string> {
		const browserState = this.#states.browserState!

		let prompt = ''

		// <instructions> (optional)

		prompt += await this.#getInstructions()

		// <agent_state>
		//  - <user_request>
		//  - <step_info>
		// <agent_state>

		const stepCount = this.history.filter((e) => e.type === 'step').length

		prompt += '<agent_state>\n'
		prompt += '<user_request>\n'
		prompt += `${this.task}\n`
		prompt += '</user_request>\n'
		prompt += '<step_info>\n'
		prompt += `Step ${stepCount + 1} of ${this.config.maxSteps} max possible steps\n`
		prompt += `Current time: ${new Date().toLocaleString()}\n`
		prompt += '</step_info>\n'
		prompt += '</agent_state>\n\n'

		// <agent_history>
		//  - <step_N> for steps
		//  - <sys> for observations and system messages

		prompt += '<agent_history>\n'

		let stepIndex = 0
		for (const event of this.history) {
			if (event.type === 'step') {
				stepIndex++
				prompt += `<step_${stepIndex}>\n`
				prompt += `Evaluation of Previous Step: ${event.reflection.evaluation_previous_goal}\n`
				prompt += `Memory: ${event.reflection.memory}\n`
				prompt += `Next Goal: ${event.reflection.next_goal}\n`
				prompt += `Action Results: ${event.action.output}\n`
				prompt += `</step_${stepIndex}>\n`
			} else if (event.type === 'observation') {
				prompt += `<sys>${event.content}</sys>\n`
			} else if (event.type === 'user_takeover') {
				prompt += `<sys>User took over control and made changes to the page</sys>\n`
			} else if (event.type === 'error') {
				// Error events are mainly for panel rendering, not included in LLM context
				// to avoid polluting the agent's reasoning with transient errors
			}
		}

		prompt += '</agent_history>\n\n'

		// <browser_state>

		let pageContent = browserState.content
		if (this.config.transformPageContent) {
			pageContent = await this.config.transformPageContent(pageContent)
		}

		prompt += '<browser_state>\n'
		prompt += browserState.header + '\n'
		prompt += pageContent + '\n'
		prompt += browserState.footer + '\n\n'
		prompt += '</browser_state>\n\n'

		return prompt
	}

	dispose() {
		console.log('Disposing PageAgent...')
		this.disposed = true
		this.pageController.dispose()
		// this.history = []
		this.#abortController.abort()

		// Emit dispose event for UI cleanup
		this.dispatchEvent(new Event('dispose'))

		this.config.onDispose?.(this)
	}
}
