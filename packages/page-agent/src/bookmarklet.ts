/**
 * Production bookmarklet entry.
 *
 * Configuration is injected at build time by vite.bookmarklet.config.js. Keeping
 * it out of the script URL prevents runtime query parameters from changing the
 * trusted Tl endpoint or model.
 */
import { PageAgent, type PageAgentConfig } from './PageAgent'

interface BookmarkletBuildConfig {
	endpointAgent: string
	model: string
	maxRetries: number
	appId?: string
	trCode?: string
	trVersion?: string
	toolCallingMode: 'api' | 'system_prompt'
	tlSystemPromptVariableName: string
	language: 'en-US' | 'zh-CN'
	maxSteps: number
}

declare const __PAGE_AGENT_BOOKMARKLET_CONFIG__: Readonly<BookmarkletBuildConfig>

const buildConfig = __PAGE_AGENT_BOOKMARKLET_CONFIG__
const config: PageAgentConfig = {
	provider: 'tl',
	endpointAgent: buildConfig.endpointAgent,
	model: buildConfig.model,
	maxRetries: buildConfig.maxRetries,
	appId: buildConfig.appId,
	trCode: buildConfig.trCode,
	trVersion: buildConfig.trVersion,
	toolCallingMode: buildConfig.toolCallingMode,
	tlSystemPromptVariableName: buildConfig.tlSystemPromptVariableName,
	language: buildConfig.language,
	maxSteps: buildConfig.maxSteps,
	experimentalScriptExecutionTool: false,
	experimentalLlmsTxt: false,
}

// Re-running the bookmarklet replaces the previous instance and its panel.
window.pageAgent?.dispose()
delete window.pageAgent

const pageAgent = new PageAgent(config)
window.pageAgent = pageAgent
pageAgent.panel.show()
