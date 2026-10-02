/**
 * Copyright (C) 2025 Alibaba Group Holding Limited
 * All rights reserved.
 */
import { type AgentConfig, PageAgentCore } from '@page-agent/core'
import {
	createDocumentExportTools,
	DOCUMENT_EXPORT_PROMPT,
	type DocumentExportConfig,
} from '@page-agent/document-export'
import {
	PageController,
	type PageControllerAdapter,
	type PageControllerConfig,
} from '@page-agent/page-controller'
import { Panel, type PanelConfig } from '@page-agent/ui'

export * from '@page-agent/core'
export { DsAiClient, TlAiClient } from '@page-agent/llms'
export type { DsAiConfig, LLMProvider, TlAiConfig } from '@page-agent/llms'
export type { DocumentExportConfig } from '@page-agent/document-export'

export type PageAgentConfig<TController extends PageControllerAdapter = PageController> =
	AgentConfig &
		PageControllerConfig &
		Omit<PanelConfig, 'language'> & {
			/** Use a custom controller implementation instead of the local PageController. */
			pageController?: TController

			/**
			 * Enable form observation, analysis, and document export tools.
			 * Registers `extract_form_data`, `append_to_report`, and
			 * `generate_document` tools and injects the supplementary system prompt.
			 *
			 * @experimental
			 * @example
			 * ```ts
			 * const agent = new PageAgent({
			 *   experimentalDocumentExport: {
			 *     onConvertDocument: (markdown, format, signal) => {
			 *       myMd2DocxConverter(markdown)
			 *     },
			 *   },
			 * })
			 * ```
			 */
			experimentalDocumentExport?: DocumentExportConfig
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

		// Merge document-export tools and prompt when enabled
		let mergedConfig = { ...config, pageController }
		if (config.experimentalDocumentExport) {
			const exportTools = createDocumentExportTools(config.experimentalDocumentExport)
			mergedConfig = {
				...mergedConfig,
				customTools: {
					...exportTools,
					...config.customTools, // user-supplied tools take precedence
				},
				instructions: {
					...config.instructions,
					system: [config.instructions?.system, DOCUMENT_EXPORT_PROMPT]
						.filter(Boolean)
						.join('\n\n'),
				},
			}
		}

		super(mergedConfig)

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
