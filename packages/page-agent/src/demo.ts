/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing
 */
import {
	type LLMProvider,
	PageAgent,
	type PageAgentConfig,
	type TlPromptTransport,
} from './PageAgent'

declare global {
	interface Window {
		pageAgentDemoConfig?: PageAgentConfig
	}
}

const currentScript = document.currentScript as HTMLScriptElement | null
const currentScriptURL = currentScript?.src ? new URL(currentScript.src) : null
const autoInit = currentScriptURL?.searchParams.get('autoInit') !== 'false'

// Clean up existing instances to prevent multiple injections from bookmarklet
if (autoInit && window.pageAgent) {
	window.pageAgent.dispose()
}

// Mount to global window object
window.PageAgent = PageAgent

console.log('🚀 page-agent.js loaded!')

const DEMO_MODEL = 'qwen3.5-plus'
const DEMO_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEMO_API_KEY = 'NA'
const DEMO_TL_ENDPOINT_AGENT = 'http://127.0.0.1:8089'
const DEMO_TL_PROMPT_TRANSPORT: TlPromptTransport = 'legacy_txt'
const DEMO_TL_SYSTEM_PROMPT_VARIABLE_NAME = 'system_prompt'

/** Parse one public provider identifier without accepting legacy client class names. */
function parseProvider(value: unknown, source: string): LLMProvider | undefined {
	if (value === undefined || value === null || value === '') return undefined
	if (value === 'openai' || value === 'tl' || value === 'ds') return value

	throw new Error(
		`[PageAgent] provider from ${source} must be "openai", "tl", or "ds"; received ${JSON.stringify(
			value
		)}.`
	)
}

/** Resolve provider in descending priority order. */
function resolveProvider(
	queryValue: string | null,
	envValue: unknown,
	buildValue?: unknown
): LLMProvider {
	return (
		parseProvider(queryValue, 'query parameter provider') ??
		parseProvider(envValue, 'LLM_PROVIDER') ??
		parseProvider(buildValue, 'build config provider') ??
		'tl'
	)
}

/**
 * Parse a maxRetries value without accepting partial numeric strings.
 */
function parseMaxRetries(value: unknown, source: string): number | undefined {
	if (value === undefined || value === null) return undefined

	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new Error(
			`[PageAgent] maxRetries from ${source} must be a non-negative integer (for example, 0 or 1); received ${JSON.stringify(
				value
			)}.`
		)
	}

	if (typeof value === 'string' && (value.length === 0 || !/^\d+$/.test(value))) {
		throw new Error(
			`[PageAgent] maxRetries from ${source} must be a non-negative integer (for example, 0 or 1); received ${JSON.stringify(
				value
			)}.`
		)
	}

	const parsed = typeof value === 'number' ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		throw new Error(
			`[PageAgent] maxRetries from ${source} must be a non-negative integer (for example, 0 or 1); received ${JSON.stringify(
				value
			)}.`
		)
	}
	return parsed
}

/**
 * Resolve maxRetries in descending priority order.
 */
function resolveMaxRetries(
	queryValue: string | null,
	envValue: unknown,
	buildValue?: unknown
): number {
	if (queryValue !== null) return parseMaxRetries(queryValue, 'query parameter maxRetries') ?? 0

	const parsedEnv = parseMaxRetries(envValue, 'LLM_MAX_RETRIES')
	if (parsedEnv !== undefined) return parsedEnv

	const parsedBuild = parseMaxRetries(buildValue, 'build config maxRetries')
	return parsedBuild ?? 0
}

const initialMaxRetries = resolveMaxRetries(
	currentScriptURL?.searchParams.get('maxRetries') ?? null,
	import.meta.env.LLM_MAX_RETRIES
)
const initialProvider = resolveProvider(
	currentScriptURL?.searchParams.get('provider') ?? null,
	import.meta.env.LLM_PROVIDER
)

window.pageAgentDemoConfig = {
	provider: initialProvider,
	model: import.meta.env.LLM_MODEL_NAME || DEMO_MODEL,
	maxRetries: initialMaxRetries,
	baseURL: import.meta.env.LLM_BASE_URL || DEMO_BASE_URL,
	apiKey: import.meta.env.LLM_API_KEY || DEMO_API_KEY,
	endpointAgent: import.meta.env.LLM_ENDPOINT_AGENT || DEMO_TL_ENDPOINT_AGENT,
	appId: import.meta.env.LLM_APP_ID || undefined,
	trCode: import.meta.env.LLM_TR_CODE || undefined,
	trVersion: import.meta.env.LLM_TR_VERSION || undefined,
	toolCallingMode: 'system_prompt',
	tlPromptTransport:
		(import.meta.env.TL_PROMPT_TRANSPORT as TlPromptTransport | undefined) ||
		DEMO_TL_PROMPT_TRANSPORT,
	tlSystemPromptVariableName:
		import.meta.env.TL_SYSTEM_PROMPT_VARIABLE_NAME || DEMO_TL_SYSTEM_PROMPT_VARIABLE_NAME,
}

// in case document.x is not ready yet
if (autoInit) {
	setTimeout(() => {
		let config: PageAgentConfig
		let showPanel = true

		if (currentScriptURL) {
			const url = currentScriptURL
			const provider = resolveProvider(
				url.searchParams.get('provider'),
				import.meta.env.LLM_PROVIDER,
				window.pageAgentDemoConfig?.provider
			)
			const model = url.searchParams.get('model') || import.meta.env.LLM_MODEL_NAME || DEMO_MODEL
			const maxRetries = resolveMaxRetries(
				url.searchParams.get('maxRetries'),
				import.meta.env.LLM_MAX_RETRIES,
				window.pageAgentDemoConfig?.maxRetries
			)
			const baseURL =
				url.searchParams.get('baseURL') || import.meta.env.LLM_BASE_URL || DEMO_BASE_URL
			const apiKey = url.searchParams.get('apiKey') || import.meta.env.LLM_API_KEY || DEMO_API_KEY
			const endpointAgent =
				url.searchParams.get('endpointAgent') ||
				import.meta.env.LLM_ENDPOINT_AGENT ||
				DEMO_TL_ENDPOINT_AGENT
			const appId = url.searchParams.get('appId') || import.meta.env.LLM_APP_ID || undefined
			const trCode = url.searchParams.get('trCode') || import.meta.env.LLM_TR_CODE || undefined
			const trVersion =
				url.searchParams.get('trVersion') || import.meta.env.LLM_TR_VERSION || undefined
			const toolCallingMode =
				(url.searchParams.get('toolCallingMode') as 'api' | 'system_prompt') ||
				(import.meta.env.LLM_TOOL_CALLING_MODE as 'api' | 'system_prompt') ||
				'system_prompt'
			const tlPromptTransport =
				(url.searchParams.get('tlPromptTransport') as TlPromptTransport | null) ??
				(import.meta.env.TL_PROMPT_TRANSPORT as TlPromptTransport | undefined) ??
				DEMO_TL_PROMPT_TRANSPORT
			const tlSystemPromptVariableName =
				url.searchParams.get('tlSystemPromptVariableName') ??
				import.meta.env.TL_SYSTEM_PROMPT_VARIABLE_NAME ??
				DEMO_TL_SYSTEM_PROMPT_VARIABLE_NAME
			const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
			showPanel = ((url.searchParams.get('showPanel') as 'true' | 'false') || 'true') === 'true'
			const experimentalScriptExecutionTool =
				(url.searchParams.get('experimentalScriptExecutionTool') as 'true' | 'false' | null) ||
				(import.meta.env.EXPERIMENTAL_SCRIPT_EXECUTION_TOOL as 'true' | 'false' | undefined) ||
				'true'
			config = {
				provider,
				model,
				maxRetries,
				baseURL,
				apiKey,
				endpointAgent,
				appId,
				trCode,
				trVersion,
				toolCallingMode,
				tlPromptTransport,
				tlSystemPromptVariableName,
				language,
				experimentalScriptExecutionTool: experimentalScriptExecutionTool === 'true',
			}
		} else {
			console.log('🚀 page-agent.js no current script detected, using default demo config')
			config = {
				provider: initialProvider,
				model: import.meta.env.LLM_MODEL_NAME ? import.meta.env.LLM_MODEL_NAME : DEMO_MODEL,
				maxRetries: initialMaxRetries,
				baseURL: import.meta.env.LLM_BASE_URL ? import.meta.env.LLM_BASE_URL : DEMO_BASE_URL,
				apiKey: import.meta.env.LLM_API_KEY ? import.meta.env.LLM_API_KEY : DEMO_API_KEY,
				endpointAgent: import.meta.env.LLM_ENDPOINT_AGENT || DEMO_TL_ENDPOINT_AGENT,
				appId: import.meta.env.LLM_APP_ID || undefined,
				trCode: import.meta.env.LLM_TR_CODE || undefined,
				trVersion: import.meta.env.LLM_TR_VERSION || undefined,
				toolCallingMode: 'system_prompt',
				tlPromptTransport:
					(import.meta.env.TL_PROMPT_TRANSPORT as TlPromptTransport | undefined) ||
					DEMO_TL_PROMPT_TRANSPORT,
				tlSystemPromptVariableName:
					import.meta.env.TL_SYSTEM_PROMPT_VARIABLE_NAME || DEMO_TL_SYSTEM_PROMPT_VARIABLE_NAME,
				experimentalScriptExecutionTool:
					((import.meta.env.EXPERIMENTAL_SCRIPT_EXECUTION_TOOL as 'true' | 'false' | undefined) ??
						'true') === 'true',
			}
		}

		// Create agent
		window.pageAgent = new PageAgent(config)
		if (showPanel) {
			window.pageAgent.panel.show()
		}

		console.log('🚀 page-agent.js initialized with config:', window.pageAgent.config)
	})
}
