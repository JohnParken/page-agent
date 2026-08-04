/**
 * Fetch LLM configuration from the server's /api/env-config endpoint.
 * Returns an empty object on failure (e.g. server not yet ready).
 */
async function fetchEnvConfig() {
	try {
		const response = await fetch('/api/env-config')
		if (!response.ok) {
			console.warn(`[PageAgent] /api/env-config returned ${response.status}, using defaults`)
			return {}
		}
		return await response.json()
	} catch (error) {
		console.warn('[PageAgent] Failed to fetch env config, using defaults:', error)
		return {}
	}
}

/**
 * Build LLM configuration from .env config and URL query parameters.
 *
 * Priority (highest to lowest):
 *   1. URL query parameters (provider, model, baseURL, apiKey, endpointAgent, etc.)
 *   2. .env file values (fetched from /api/env-config)
 *   3. Built-in defaults
 *
 * Supported providers:
 *   - tlclient      → provider: 'tl' (Tl AI / chatbbc client)
 *   - openaiclient  → provider: 'openai' (OpenAI-compatible client, default)
 *
 * @param {object} envConfig - The env config object from /api/env-config
 * @returns {object} PageAgent configuration object
 */
function queryConfig(envConfig = {}) {
	const params = new URLSearchParams(window.location.search)
	const buildConfig = window.pageAgentDemoConfig || {}

	// Determine provider: URL param > .env > built-in default
	const provider = params.get('provider') || envConfig.LLM_PROVIDER || 'tlclient'

	const config = {
		...buildConfig,
		model: params.get('model') || envConfig.LLM_MODEL_NAME || buildConfig.model || 'qwen3.5-plus',
		language: 'zh-CN',
		experimentalScriptExecutionTool: true,
	}

	if (provider === 'openaiclient') {
		config.provider = 'openai'
		config.baseURL =
			params.get('baseURL') ||
			envConfig.OPENAI_BASE_URL ||
			buildConfig.baseURL ||
			'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
		config.apiKey = params.get('apiKey') || envConfig.OPENAI_API_KEY || 'NA'
		config.toolCallingMode = undefined // not needed for OpenAI client
	} else {
		// Default: tlclient
		config.provider = 'tl'
		config.endpointAgent =
			params.get('endpointAgent') || envConfig.TL_ENDPOINT_AGENT || 'http://127.0.0.1:8089'
		config.appId = params.get('appId') || envConfig.TL_APP_ID || undefined
		config.trCode = params.get('trCode') || envConfig.TL_TR_CODE || undefined
		config.trVersion = params.get('trVersion') || envConfig.TL_TR_VERSION || undefined
		config.toolCallingMode = envConfig.TL_TOOL_CALLING_MODE || 'system_prompt'
	}

	return config
}

/**
 * Install a PageAgent instance for the local iframe-bridge demo.
 * Reads LLM config from .env (via /api/env-config) and URL query parameters.
 *
 * Query parameters can override any .env setting when testing with a different endpoint.
 *
 * @param {object} options
 * @param {object} options.pageController - The FrameAwarePageController instance
 * @param {string} options.pageName - Display name for the page
 * @param {string} options.instructions - Additional system instructions
 * @returns {Promise<object>} The installed PageAgent instance
 */
export async function installDemoPageAgent({ pageController, pageName, instructions }) {
	if (!window.PageAgent) throw new Error('PageAgent 演示脚本尚未加载')
	if (window.pageAgent) window.pageAgent.dispose()

	// Fetch env config from server
	const envConfig = await fetchEnvConfig()
	const config = queryConfig(envConfig)

	// Validate configuration for the selected provider
	if (config.provider === 'openai' && !config.baseURL) {
		throw new Error(
			'[PageAgent] OpenAI client requires OPENAI_BASE_URL. ' +
				'Set it in .env or pass via ?baseURL=... query parameter.'
		)
	}
	if (config.provider === 'tl' && !config.endpointAgent) {
		throw new Error(
			'[PageAgent] TL client requires TL_ENDPOINT_AGENT. ' +
				'Set it in .env or pass via ?endpointAgent=... query parameter.'
		)
	}

	console.info(
		`[PageAgent] Initializing with provider: ${config.provider}` +
			(config.provider === 'openai'
				? `, model: ${config.model}, baseURL: ${config.baseURL}`
				: `, model: ${config.model}, endpointAgent: ${config.endpointAgent}`)
	)

	const agent = new window.PageAgent({
		...config,
		pageController,
		language: 'zh-CN',
		experimentalScriptExecutionTool: true,
		instructions: {
			system: `你正在操作"${pageName}"中文测试页。请严格按用户要求操作；完成后简洁报告每项结果。${instructions}`,
		},
	})

	agent.onAskUser = async (question, { signal } = {}) => {
		if (signal?.aborted) throw signal.reason
		const answer = window.prompt(`PageAgent 想确认：\n${question}`)
		if (signal?.aborted) throw signal.reason
		return answer ?? '用户取消了回答'
	}

	window.pageAgent = agent
	agent.panel.show()
	return agent
}

/** Wire the page's quick-run controls to the installed PageAgent instance. */
export function bindAgentRunner(agent, { taskInput, runButton, stopButton, statusOutput }) {
	const renderStatus = (message, tone = 'info') => {
		statusOutput.textContent = message
		statusOutput.dataset.tone = tone
	}

	agent.addEventListener('statuschange', () => {
		const running = agent.status === 'running'
		runButton.disabled = running
		stopButton.disabled = !running
		renderStatus(
			running ? 'PageAgent 正在执行任务…' : `PageAgent 当前状态：${agent.status}`,
			agent.status === 'error' ? 'error' : agent.status === 'completed' ? 'success' : 'info'
		)
	})

	runButton.addEventListener('click', async () => {
		const task = taskInput.value.trim()
		if (!task) {
			renderStatus('请先输入测试任务。', 'error')
			return
		}
		try {
			const result = await agent.execute(task)
			renderStatus(
				result.success ? `任务完成：${result.data}` : `任务未完成：${result.data}`,
				result.success ? 'success' : 'error'
			)
		} catch (error) {
			renderStatus(`执行失败：${error instanceof Error ? error.message : String(error)}`, 'error')
		}
	})

	stopButton.addEventListener('click', () => {
		void agent.stop()
	})

	stopButton.disabled = true
	renderStatus('PageAgent 已就绪，可直接运行下方任务。', 'success')
}
