/**
 * @page-agent/document-export
 *
 * Form observation, analysis, and document export tools for page-agent.
 *
 * This package provides three agent tools that enable form data extraction,
 * cross-page report accumulation, and Markdown-based document generation.
 * The integrator supplies a Markdown-to-document converter callback; this
 * package does not bundle any heavy Office libraries.
 *
 * @example
 * ```ts
 * import { createDocumentExportTools } from '@page-agent/document-export'
 *
 * const agent = new PageAgentCore({
 *   customTools: createDocumentExportTools({
 *     onConvertDocument: (markdown, format, signal) => {
 *       myMd2DocxConverter(markdown) // triggers browser download
 *     },
 *   }),
 *   instructions: {
 *     system: DOCUMENT_EXPORT_PROMPT, // optional: import from this package
 *   },
 * })
 * ```
 */

import { appendToReportTool } from './tools/append_to_report'
import { extractFormDataTool } from './tools/extract_form_data'
import { createGenerateDocumentTool } from './tools/generate_document'

import type { DocumentExportConfig } from './types'
import type { PageAgentTool } from '@page-agent/core'

export type { DocumentConverter, DocumentExportConfig, ReportBuffer, ReportSection } from './types'
export type { FormField } from '@page-agent/page-controller'
export { getBuffer, appendSection, assembleMarkdown, clearBuffer } from './reportBuffer'

/**
 * Create the document-export tool set to be injected via `customTools`.
 *
 * Returns a plain object mapping tool names to tool definitions, matching
 * the `customTools` config shape expected by `PageAgentCore`.
 *
 * @example
 * ```ts
 * const agent = new PageAgentCore({
 *   customTools: createDocumentExportTools({
 *     onConvertDocument: (md, fmt) => myConverter(md, fmt),
 *   }),
 * })
 * ```
 */
export function createDocumentExportTools(
	config: DocumentExportConfig
): Record<string, PageAgentTool> {
	return {
		extract_form_data: extractFormDataTool,
		append_to_report: appendToReportTool,
		generate_document: createGenerateDocumentTool(config.onConvertDocument),
	}
}

/**
 * Supplementary system prompt that instructs the LLM how to use the
 * document-export tools. Integrators can inject this via
 * `instructions.system` in the agent config.
 *
 * @example
 * ```ts
 * const agent = new PageAgent({
 *   instructions: { system: DOCUMENT_EXPORT_PROMPT },
 * })
 * ```
 */
export const DOCUMENT_EXPORT_PROMPT = `<document_export_capability>
You have three additional tools for form analysis and document generation:

1. **extract_form_data** — Extracts all form fields (inputs, selects, textareas) from the
   current page as structured data. Fields marked with \`data-page-agent-no-export\` are excluded.
   Use this to observe and understand form content.

2. **append_to_report** — Appends a titled Markdown section to an in-memory report buffer.
   Use this to accumulate analysis results across multiple pages or steps. Write clear,
   well-structured Markdown with tables, lists, and sub-headings as appropriate.

3. **generate_document** — Assembles all buffered sections into a complete Markdown document and
   converts it to the requested format (docx or xlsx). The report buffer is cleared after
   generation.

<workflow>
Follow this workflow when the user asks to analyse forms or generate a report:

1. Navigate to the target page(s).
2. Call \`extract_form_data\` on each page to gather structured field data.
3. Analyse the extracted data. Store your findings by calling \`append_to_report\` with a
   meaningful section title and Markdown content.
4. Repeat steps 1-3 for additional pages if the task involves multiple forms.
5. Before generating the document, consider calling \`ask_user\` to confirm the report content
   and format with the user.
6. Call \`generate_document\` with the desired format (docx or xlsx) and an optional title.
7. Call \`done\` to finish the task.
</workflow>

<report_guidelines>
- Use Markdown tables for tabular field data (field name, value, type, notes).
- Use bullet lists for observations and analysis points.
- For xlsx format, structure data primarily as Markdown tables — the converter handles the rest.
- Keep section headings descriptive (e.g. "User Registration Form — Field Summary").
- Do NOT include fields that were excluded by data-page-agent-no-export.
- When analysing, note any validation issues, missing required fields, or unusual values.
</report_guidelines>
</document_export_capability>`
