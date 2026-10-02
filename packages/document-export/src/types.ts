/**
 * Types for the document-export package.
 *
 * Re-exports `FormField` from page-controller for convenience and defines the
 * report buffer, configuration, and converter callback contracts.
 */

export type { FormField } from '@page-agent/page-controller'

/**
 * A single report section accumulated by the `append_to_report` tool.
 * Each section is a Markdown fragment that will be concatenated into the
 * final document.
 */
export interface ReportSection {
	/** Section heading */
	title: string
	/** Markdown content for this section */
	content: string
	/** Timestamp when this section was appended */
	appendedAt: number
}

/**
 * In-memory buffer that accumulates report sections across agent steps.
 * Attached to the agent instance so it persists across the task lifecycle
 * but is intentionally **not** written into agent history to avoid
 * polluting the LLM context with large data payloads.
 */
export interface ReportBuffer {
	sections: ReportSection[]
}

/**
 * Callback invoked by the `generate_document` tool to hand the assembled
 * Markdown to the integrator's converter (e.g. MD→DOCX / MD→XLSX).
 *
 * @param markdown - The complete Markdown report string
 * @param format   - The requested output format
 * @param signal   - AbortSignal forwarded from the agent's task cancellation.
 *                   Converters that perform async work (network requests, heavy
 *                   computation) should honour this signal so that stopping the
 *                   agent task also cancels the conversion and its side-effects
 *                   (e.g. a triggered download).
 * @returns May return a status message or void; errors should be thrown.
 */
export type DocumentConverter = (
	markdown: string,
	format: 'docx' | 'xlsx',
	signal: AbortSignal
) => unknown

/**
 * Configuration accepted by `createDocumentExportTools()`.
 */
export interface DocumentExportConfig {
	/**
	 * The integrator's Markdown-to-document converter.
	 * Called by the `generate_document` tool with the assembled Markdown and
	 * the requested format. The converter is responsible for triggering the
	 * browser download or any other side effect.
	 */
	onConvertDocument: DocumentConverter
}
