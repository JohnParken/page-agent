/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */
import { type AgentConfig, PageAgentCore } from '@page-agent/core'
import {
	PageController,
	type PageControllerAdapter,
	type PageControllerConfig,
} from '@page-agent/page-controller'
import { Panel, type PanelConfig } from '@page-agent/ui'

export * from '@page-agent/core'
export { DsAiClient, TlAiClient } from '@page-agent/llms'
export type { DsAiConfig, LLMProvider, TlAiConfig } from '@page-agent/llms'

export type PageAgentConfig<TController extends PageControllerAdapter = PageController> =
	AgentConfig &
		PageControllerConfig &
		Omit<PanelConfig, 'language'> & {
			/** Use a custom controller implementation instead of the local PageController. */
			pageController?: TController
		}

export class PageAgent<
	TController extends PageControllerAdapter = PageController,
> extends PageAgentCore<TController> {
	panel: Panel

	constructor(config: PageAgentConfig<TController>) {
		const pageController =
			config.pageController ??
			(new PageController({
				...config,
				enableMask: config.enableMask ?? true,
			}) as unknown as TController)

		super({ ...config, pageController })

		this.panel = new Panel(this, {
			language: config.language,
			promptForNextTask: config.promptForNextTask,
		})
	}
}

declare global {
	interface Window {
		pageAgent?: PageAgent
		PageAgent: typeof PageAgent
	}
}
