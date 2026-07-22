/**
 * IIFE demo entry - auto-initializes with built-in demo API for testing
 */
import { PageAgent, type PageAgentConfig } from './PageAgent'

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

// in case document.x is not ready yet
if (autoInit) {
	setTimeout(() => {
		let config: PageAgentConfig
		let showPanel = true

		if (currentScriptURL) {
			const url = currentScriptURL
			const provider = (url.searchParams.get('provider') as 'openai' | 'yiming') || 'openai'
			const model = url.searchParams.get('model') || DEMO_MODEL
			const baseURL = url.searchParams.get('baseURL') || DEMO_BASE_URL
			const apiKey = url.searchParams.get('apiKey') || DEMO_API_KEY
			const endpointAgent = url.searchParams.get('endpointAgent') || undefined
			const appId = url.searchParams.get('appId') || undefined
			const trCode = url.searchParams.get('trCode') || undefined
			const trVersion = url.searchParams.get('trVersion') || undefined
			const toolCallingMode =
				(url.searchParams.get('toolCallingMode') as 'api' | 'system_prompt') || undefined
			const language = (url.searchParams.get('lang') as 'zh-CN' | 'en-US') || 'zh-CN'
			showPanel = ((url.searchParams.get('showPanel') as 'true' | 'false') || 'true') === 'true'
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
			}
		} else {
			console.log('🚀 page-agent.js no current script detected, using default demo config')
			config = {
				provider: (import.meta.env.LLM_PROVIDER as 'openai' | 'yiming') || 'openai',
				model: import.meta.env.LLM_MODEL_NAME ? import.meta.env.LLM_MODEL_NAME : DEMO_MODEL,
				baseURL: import.meta.env.LLM_BASE_URL ? import.meta.env.LLM_BASE_URL : DEMO_BASE_URL,
				apiKey: import.meta.env.LLM_API_KEY ? import.meta.env.LLM_API_KEY : DEMO_API_KEY,
				endpointAgent: import.meta.env.LLM_ENDPOINT_AGENT || undefined,
				appId: import.meta.env.LLM_APP_ID || undefined,
				trCode: import.meta.env.LLM_TR_CODE || undefined,
				trVersion: import.meta.env.LLM_TR_VERSION || undefined,
				toolCallingMode:
					(import.meta.env.LLM_TOOL_CALLING_MODE as 'api' | 'system_prompt') || undefined,
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
