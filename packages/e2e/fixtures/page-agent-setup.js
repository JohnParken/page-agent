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
 * Parse a maxRetries value without accepting partial numeric strings.
 *
 * @param {unknown} value - Candidate value from a query parameter or config source
 * @param {string} source - Human-readable source name for validation errors
 * @returns {number|undefined} A validated non-negative integer, or undefined when absent
 */
function parseMaxRetries(value, source) {
	if (value === undefined || value === null) return undefined

	if (typeof value !== 'string' && typeof value !== 'number') {
		throw new Error(
			`[PageAgent] maxRetries from ${source} must be a non-negative integer (for example, 0 or 1); received ${JSON.stringify(
				value
			)}.`
		)
	}

	if (typeof value === 'string') {
		if (value.length === 0 || !/^\d+$/.test(value)) {
			throw new Error(
				`[PageAgent] maxRetries from ${source} must be a non-negative integer (for example, 0 or 1); received ${JSON.stringify(
					value
				)}.`
			)
		}
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
 *
 * @param {URLSearchParams} params - Current page query parameters
 * @param {object} envConfig - Values fetched from /api/env-config
 * @param {object} buildConfig - Values embedded in the demo bundle
 * @returns {number} A validated maxRetries value
 */
function resolveMaxRetries(params, envConfig, buildConfig) {
	const queryValue = params.get('maxRetries')
	if (queryValue !== null) return parseMaxRetries(queryValue, 'query parameter maxRetries') ?? 0

	const envValue = envConfig.LLM_MAX_RETRIES
	if (envValue !== undefined && envValue !== null && envValue !== '') {
		return parseMaxRetries(envValue, 'LLM_MAX_RETRIES') ?? 0
	}

	const buildValue = buildConfig.maxRetries
	if (buildValue !== undefined && buildValue !== null && buildValue !== '') {
		return parseMaxRetries(buildValue, 'build config maxRetries') ?? 0
	}

	return 0
}

/**
 * Parse one public provider identifier without accepting legacy client class names.
 *
 * @param {unknown} value - Candidate provider value
 * @param {string} source - Human-readable configuration source
 * @returns {'openai'|'tl'|'ds'|undefined} A validated provider, or undefined when absent
 */
function parseProvider(value, source) {
	if (value === undefined || value === null || value === '') return undefined
	if (value === 'openai' || value === 'tl' || value === 'ds') return value

	throw new Error(
		`[PageAgent] provider from ${source} must be "openai", "tl", or "ds"; received ${JSON.stringify(
			value
		)}.`
	)
}

/**
 * Resolve provider in descending priority order.
 *
 * @param {URLSearchParams} params - Current page query parameters
 * @param {object} envConfig - Values fetched from /api/env-config
 * @param {object} buildConfig - Values embedded in the demo bundle
 * @returns {'openai'|'tl'|'ds'} The selected provider
 */
function resolveProvider(params, envConfig, buildConfig) {
	return (
		parseProvider(params.get('provider'), 'query parameter provider') ||
		parseProvider(envConfig.LLM_PROVIDER, 'LLM_PROVIDER') ||
		parseProvider(buildConfig.provider, 'build config provider') ||
		'tl'
	)
}

/**
 * Build LLM configuration from .env config and URL query parameters.
 *
 * Priority (highest to lowest):
 *   1. URL query parameters (provider, model, baseURL, apiKey, endpointAgent, etc.)
 *   2. .env file values (fetched from /api/env-config)
 *   3. Build-time values from `window.pageAgentDemoConfig`
 *   4. Built-in defaults
 *
 * `maxRetries` follows the same order and defaults to 0. It is always passed
 * to PageAgent as a validated number.
 *
 * Supported providers: `tl`, `ds`, and `openai`.
 *
 * The Tl system prompt variable name is resolved independently from the provider
 * connection. URL query parameters (`tlSystemPromptVariableName`) take
 * precedence over values exposed by `/api/env-config`, then the build-time
 * `pageAgentDemoConfig`, and finally the default `system_prompt` name.
 *
 * @param {object} envConfig - The env config object from /api/env-config
 * @returns {object} PageAgent configuration object
 */
export function queryConfig(envConfig = {}) {
	const params = new URLSearchParams(window.location.search)
	const buildConfig = window.pageAgentDemoConfig || {}
	const {
		tlSystemPromptVariableName: buildTlSystemPromptVariableName,
		...buildConfigWithoutSystemPromptVariable
	} = buildConfig

	// Determine provider: URL param > .env > build-time config > built-in default.
	const provider = resolveProvider(params, envConfig, buildConfig)

	const config = {
		...buildConfigWithoutSystemPromptVariable,
		model: params.get('model') || envConfig.LLM_MODEL_NAME || buildConfig.model || 'qwen3.5-plus',
		maxRetries: resolveMaxRetries(params, envConfig, buildConfig),
		language: 'zh-CN',
		experimentalScriptExecutionTool: true,
	}

	if (provider === 'openai') {
		config.provider = 'openai'
		config.baseURL =
			params.get('baseURL') ||
			envConfig.LLM_BASE_URL ||
			buildConfig.baseURL ||
			'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
		config.apiKey = params.get('apiKey') || envConfig.LLM_API_KEY || buildConfig.apiKey || 'NA'
		config.toolCallingMode = undefined // not needed for OpenAI client
	} else if (provider === 'tl') {
		config.provider = 'tl'
		config.endpointAgent =
			params.get('endpointAgent') ||
			envConfig.LLM_ENDPOINT_AGENT ||
			buildConfig.endpointAgent ||
			'http://127.0.0.1:8089'
		config.appId = params.get('appId') || envConfig.LLM_APP_ID || buildConfig.appId || undefined
		config.trCode = params.get('trCode') || envConfig.LLM_TR_CODE || buildConfig.trCode || undefined
		config.trVersion =
			params.get('trVersion') || envConfig.LLM_TR_VERSION || buildConfig.trVersion || undefined
		config.toolCallingMode =
			params.get('toolCallingMode') ||
			envConfig.LLM_TOOL_CALLING_MODE ||
			buildConfig.toolCallingMode ||
			'system_prompt'
		config.tlSystemPromptVariableName =
			params.get('tlSystemPromptVariableName') ||
			envConfig.TL_SYSTEM_PROMPT_VARIABLE_NAME ||
			buildTlSystemPromptVariableName ||
			'system_prompt'
	} else {
		config.provider = 'ds'
		config.baseURL = params.get('baseURL') || envConfig.LLM_BASE_URL || buildConfig.baseURL || ''
		config.apiKey = params.get('apiKey') || envConfig.LLM_API_KEY || buildConfig.apiKey || ''
		config.endpointAgent =
			params.get('endpointAgent') ||
			envConfig.LLM_ENDPOINT_AGENT ||
			buildConfig.endpointAgent ||
			undefined
		config.appId = params.get('appId') || envConfig.LLM_APP_ID || buildConfig.appId || undefined
		config.trCode = params.get('trCode') || envConfig.LLM_TR_CODE || buildConfig.trCode || undefined
		config.trVersion =
			params.get('trVersion') || envConfig.LLM_TR_VERSION || buildConfig.trVersion || undefined
		config.toolCallingMode =
			params.get('toolCallingMode') ||
			envConfig.LLM_TOOL_CALLING_MODE ||
			buildConfig.toolCallingMode ||
			'system_prompt'
		config.dsMode = params.get('dsMode') || envConfig.LLM_DS_MODE || buildConfig.dsMode || undefined
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
			'[PageAgent] OpenAI provider requires LLM_BASE_URL. ' +
				'Set it in .env or pass via ?baseURL=... query parameter.'
		)
	}
	if (config.provider === 'tl' && !config.endpointAgent) {
		throw new Error(
			'[PageAgent] TL provider requires LLM_ENDPOINT_AGENT. ' +
				'Set it in .env or pass via ?endpointAgent=... query parameter.'
		)
	}
	if (config.provider === 'ds' && !config.endpointAgent && !config.baseURL) {
		throw new Error(
			'[PageAgent] DS client requires LLM_ENDPOINT_AGENT or LLM_BASE_URL. ' +
				'Set one in .env or pass endpointAgent/baseURL via query parameters.'
		)
	}

	console.info(
		`[PageAgent] Initializing with provider: ${config.provider}` +
			(config.provider === 'tl'
				? `, model: ${config.model}, endpointAgent: ${config.endpointAgent}`
				: `, model: ${config.model}, baseURL: ${config.baseURL}`)
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
