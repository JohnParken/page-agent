/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing
 */
import { PageAgent, type PageAgentConfig } from './PageAgent'

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

window.pageAgentDemoConfig = {
	provider: (import.meta.env.LLM_PROVIDER as 'openai' | 'tl' | 'ds') || 'tl',
	model: import.meta.env.LLM_MODEL_NAME || DEMO_MODEL,
	baseURL: import.meta.env.LLM_BASE_URL || DEMO_BASE_URL,
	apiKey: import.meta.env.LLM_API_KEY || DEMO_API_KEY,
	endpointAgent: import.meta.env.LLM_ENDPOINT_AGENT || DEMO_TL_ENDPOINT_AGENT,
	appId: import.meta.env.LLM_APP_ID || undefined,
	trCode: import.meta.env.LLM_TR_CODE || undefined,
	trVersion: import.meta.env.LLM_TR_VERSION || undefined,
	toolCallingMode: 'system_prompt',
}

// in case document.x is not ready yet
if (autoInit) {
	setTimeout(() => {
		let config: PageAgentConfig
		let showPanel = true

		if (currentScriptURL) {
			const url = currentScriptURL
			const provider =
				(url.searchParams.get('provider') as 'openai' | 'tl' | 'ds') ||
				(import.meta.env.LLM_PROVIDER as 'openai' | 'tl' | 'ds') ||
				'tl'
			const model = url.searchParams.get('model') || import.meta.env.LLM_MODEL_NAME || DEMO_MODEL
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
			const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
			showPanel = ((url.searchParams.get('showPanel') as 'true' | 'false') || 'true') === 'true'
			const experimentalScriptExecutionTool =
				(url.searchParams.get('experimentalScriptExecutionTool') as 'true' | 'false' | null) ||
				(import.meta.env.EXPERIMENTAL_SCRIPT_EXECUTION_TOOL as 'true' | 'false' | undefined) ||
				'true'
			config = {
				provider,
				model,
				baseURL,
				apiKey,
				endpointAgent,
				appId,
				trCode,
				trVersion,
				toolCallingMode,
				language,
				experimentalScriptExecutionTool: experimentalScriptExecutionTool === 'true',
			}
		} else {
			console.log('🚀 page-agent.js no current script detected, using default demo config')
			config = {
				provider: (import.meta.env.LLM_PROVIDER as 'openai' | 'tl' | 'ds') || 'tl',
				model: import.meta.env.LLM_MODEL_NAME ? import.meta.env.LLM_MODEL_NAME : DEMO_MODEL,
				baseURL: import.meta.env.LLM_BASE_URL ? import.meta.env.LLM_BASE_URL : DEMO_BASE_URL,
				apiKey: import.meta.env.LLM_API_KEY ? import.meta.env.LLM_API_KEY : DEMO_API_KEY,
				endpointAgent: import.meta.env.LLM_ENDPOINT_AGENT || DEMO_TL_ENDPOINT_AGENT,
				appId: import.meta.env.LLM_APP_ID || undefined,
				trCode: import.meta.env.LLM_TR_CODE || undefined,
				trVersion: import.meta.env.LLM_TR_VERSION || undefined,
				toolCallingMode: 'system_prompt',
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
