const DEFAULT_MODEL = 'qwen3.5-plus'
const DEFAULT_BASE_URL = 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run'
const DEFAULT_TL_ENDPOINT_AGENT = 'http://127.0.0.1:8089'

function queryConfig() {
	const params = new URLSearchParams(window.location.search)
	const buildConfig = window.pageAgentDemoConfig || {}
	return {
		...buildConfig,
		provider: params.get('provider') || 'tl',
		model: params.get('model') || buildConfig.model || DEFAULT_MODEL,
		baseURL: params.get('baseURL') || buildConfig.baseURL || DEFAULT_BASE_URL,
		apiKey: params.get('apiKey') || buildConfig.apiKey || 'NA',
		endpointAgent:
			params.get('endpointAgent') || buildConfig.endpointAgent || DEFAULT_TL_ENDPOINT_AGENT,
		appId: params.get('appId') || buildConfig.appId,
		trCode: params.get('trCode') || buildConfig.trCode,
		trVersion: params.get('trVersion') || buildConfig.trVersion,
		toolCallingMode: 'system_prompt',
	}
}

/**
 * Install a Chinese PageAgent instance for the local iframe-bridge demo.
 * Query parameters can override the demo LLM settings when testing another endpoint.
 */
export function installDemoPageAgent({ pageController, pageName, instructions }) {
	if (!window.PageAgent) throw new Error('PageAgent 演示脚本尚未加载')
	if (window.pageAgent) window.pageAgent.dispose()

	const agent = new window.PageAgent({
		...queryConfig(),
		pageController,
		language: 'zh-CN',
		experimentalScriptExecutionTool: true,
		instructions: {
			system: `你正在操作“${pageName}”中文测试页。请严格按用户要求操作；完成后简洁报告每项结果。${instructions}`,
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
