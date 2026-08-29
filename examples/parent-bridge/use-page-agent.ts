/**
 * Example-only Vue 3 integration for an assistant that drives a parent page.
 *
 * Install Vue in the consuming application. This source is deliberately kept
 * outside the Page Agent packages so Vue is never a runtime dependency here.
 * Runtime bridge/Core modules are loaded from onMounted for SSR safety.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'

import type { AgentActivity, AgentStatus, ExecutionResult, HistoricalEvent } from '@page-agent/core'
import type {
	ParentControllerApprovalRequest,
	ParentControllerCapability,
} from '@page-agent/page-controller/parent-bridge'

type ParentAdapterConstructor =
	typeof import('@page-agent/page-controller/parent-bridge/adapter').ParentPageControllerAdapter
type ParentAdapter = InstanceType<ParentAdapterConstructor>
type PageAgentCore = import('@page-agent/core').PageAgentCore

export type ParentAdapterOptions = ConstructorParameters<ParentAdapterConstructor>[0]

export interface UsePageAgentOptions {
	adapterOptions: ParentAdapterOptions
	endpointAgent: string
	model: string
	onAskUser?: NonNullable<PageAgentCore['onAskUser']>
}

const REQUIRED_PAGE_AGENT_CAPABILITIES = [
	'observe',
	'cleanup',
] as const satisfies readonly ParentControllerCapability[]

function assertPageAgentCapabilities(options: ParentAdapterOptions): void {
	const missing = REQUIRED_PAGE_AGENT_CAPABILITIES.filter(
		(capability) => !options.requestedCapabilities.includes(capability)
	)
	if (missing.length > 0) {
		throw new TypeError(
			`PageAgent parent adapter requires capabilities: ${missing.join(', ')}. ` +
				'The parent host and verified policy must grant the same capabilities.'
		)
	}
}

/** Fields safe for a small history list; raw provider/page payloads are omitted. */
export type PresentationHistoryEvent =
	| { type: 'step'; stepIndex: number; action: string }
	| { type: 'observation' }
	| { type: 'user_takeover' }
	| { type: 'retry'; message: string; attempt: number; maxAttempts: number }
	| { type: 'error'; message: string }

/** Fields safe for transient activity indicators; tool input/output is omitted. */
export type PresentationActivity =
	| { type: 'thinking' }
	| { type: 'executing'; tool: string }
	| { type: 'executed'; tool: string; duration: number }
	| { type: 'retrying'; attempt: number; maxAttempts: number }
	| { type: 'error'; message: string }

const SENSITIVE_TEXT =
	/(Bearer\s+[A-Za-z0-9._~+/=-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gi

function presentationText(value: string): string {
	return value.replace(SENSITIVE_TEXT, '[REDACTED]').slice(0, 512)
}

function toPresentationHistory(event: HistoricalEvent): PresentationHistoryEvent {
	switch (event.type) {
		case 'step':
			return { type: 'step', stepIndex: event.stepIndex, action: event.action.name }
		case 'observation':
			return { type: 'observation' }
		case 'user_takeover':
			return { type: 'user_takeover' }
		case 'retry':
			return {
				type: 'retry',
				message: presentationText(event.message),
				attempt: event.attempt,
				maxAttempts: event.maxAttempts,
			}
		case 'error':
			return { type: 'error', message: presentationText(event.message) }
	}
}

function toPresentationActivity(activity: AgentActivity): PresentationActivity {
	switch (activity.type) {
		case 'thinking':
			return activity
		case 'executing':
			return { type: 'executing', tool: activity.tool }
		case 'executed':
			return { type: 'executed', tool: activity.tool, duration: activity.duration }
		case 'retrying':
			return activity
		case 'error':
			return { type: 'error', message: presentationText(activity.message) }
	}
}

/**
 * Create a Vue-bound PageAgentCore over the cooperative parent adapter.
 *
 * A missing parent host is a normal degraded state: the composable reports it
 * and refuses parent actions rather than attempting direct DOM access.
 */
export function usePageAgent(options: UsePageAgentOptions) {
	assertPageAgentCapabilities(options.adapterOptions)

	const adapter = shallowRef<ParentAdapter | null>(null)
	const agent = shallowRef<PageAgentCore | null>(null)
	const connected = ref(false)
	const parentUnavailable = ref(false)
	const degraded = ref(false)
	const status = ref<AgentStatus>('idle')
	const history = shallowRef<PresentationHistoryEvent[]>([])
	const activity = shallowRef<PresentationActivity | null>(null)
	const error = shallowRef<unknown>(null)
	const pendingQuestion = ref<string | null>(null)
	const approvalRequest = shallowRef<ParentControllerApprovalRequest | null>(null)

	let disposed = false
	let connectPromise: Promise<boolean> | null = null

	const bindAgentEvents = (instance: PageAgentCore): void => {
		const onStatusChange = () => {
			status.value = instance.status
		}
		const onHistoryChange = () => {
			history.value = instance.history.map(toPresentationHistory)
		}
		const onActivity = (event: Event) => {
			const detail = (event as CustomEvent<AgentActivity>).detail
			if (detail) activity.value = toPresentationActivity(detail)
		}
		instance.addEventListener('statuschange', onStatusChange)
		instance.addEventListener('historychange', onHistoryChange)
		instance.addEventListener('activity', onActivity)
		instance.addEventListener('dispose', () => {
			instance.removeEventListener('statuschange', onStatusChange)
			instance.removeEventListener('historychange', onHistoryChange)
			instance.removeEventListener('activity', onActivity)
		})
	}

	const createRuntime = async (): Promise<void> => {
		if (adapter.value && agent.value) return
		const [{ ParentPageControllerAdapter }, { PageAgentCore: PageAgentCoreClass }] =
			await Promise.all([
				import('@page-agent/page-controller/parent-bridge/adapter'),
				import('@page-agent/core'),
			])
		if (disposed) return

		const configuredApproval = options.adapterOptions.onApprovalRequired
		let adapterInstance = adapter.value
		if (!adapterInstance) {
			adapterInstance = new ParentPageControllerAdapter({
				...options.adapterOptions,
				onApprovalRequired: async (request) => {
					approvalRequest.value = request
					try {
						return await configuredApproval(request)
					} finally {
						if (approvalRequest.value?.approvalId === request.approvalId) {
							approvalRequest.value = null
						}
					}
				},
			})
			adapterInstance.addEventListener('invalidate', () => {
				connected.value = false
				degraded.value = true
			})
			adapterInstance.addEventListener('connected', () => {
				connected.value = true
				parentUnavailable.value = false
				degraded.value = false
				error.value = null
			})
			adapterInstance.addEventListener('connectionerror', (event) => {
				connected.value = false
				parentUnavailable.value = true
				degraded.value = true
				error.value = (event as CustomEvent<{ error?: unknown }>).detail?.error
			})
			adapter.value = adapterInstance
		}

		if (!agent.value) {
			const agentInstance = new PageAgentCoreClass({
				pageController: adapterInstance,
				provider: 'tl',
				endpointAgent: options.endpointAgent,
				model: options.model,
				toolCallingMode: 'system_prompt',
				tlSystemPromptVariableName: 'system_prompt',
				experimentalScriptExecutionTool: false,
				experimentalLlmsTxt: false,
				debug: false,
				includeRawHistory: false,
			})
			if (options.onAskUser) {
				agentInstance.onAskUser = async (question, context) => {
					pendingQuestion.value = question
					try {
						return await options.onAskUser!(question, context)
					} finally {
						pendingQuestion.value = null
					}
				}
			}
			bindAgentEvents(agentInstance)
			agent.value = agentInstance
		}
	}

	const connect = async (): Promise<boolean> => {
		if (disposed) return false
		if (connectPromise) return connectPromise
		connectPromise = (async () => {
			error.value = null
			try {
				await createRuntime()
				if (disposed || !adapter.value) return false
				await adapter.value.connect()
				if (disposed) return false
				connected.value = true
				parentUnavailable.value = false
				degraded.value = false
				return true
			} catch (cause) {
				connected.value = false
				parentUnavailable.value = true
				degraded.value = true
				error.value = cause
				return false
			} finally {
				connectPromise = null
			}
		})()
		return connectPromise
	}

	const execute = async (task: string): Promise<ExecutionResult> => {
		if (!connected.value || !agent.value) {
			const cause = new Error('Parent controller host is unavailable; parent actions are disabled')
			parentUnavailable.value = true
			degraded.value = true
			error.value = cause
			throw cause
		}
		error.value = null
		return agent.value.execute(task)
	}

	const dispose = async (): Promise<void> => {
		if (disposed) return
		disposed = true
		const agentInstance = agent.value
		if (agentInstance) {
			await agentInstance.stop()
			agentInstance.dispose()
		} else {
			adapter.value?.dispose()
		}
		connected.value = false
		pendingQuestion.value = null
		approvalRequest.value = null
		adapter.value = null
		agent.value = null
	}

	onMounted(() => {
		void connect()
	})
	onBeforeUnmount(() => {
		void dispose()
	})

	return {
		adapter,
		agent,
		connected,
		parentUnavailable,
		degraded,
		status,
		history,
		activity,
		error,
		pendingQuestion,
		approvalRequest,
		connect,
		execute,
		dispose,
	}
}
