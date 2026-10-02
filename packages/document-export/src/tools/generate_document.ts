/**
 * `generate_document` tool — assembles the buffered report sections into a
 * complete Markdown document and hands it to the integrator's converter
 * callback for file generation (e.g. MD → DOCX / XLSX download).
 */

import { type PageAgentCore, tool } from '@page-agent/core'
import * as z from 'zod/v4'

import { assembleMarkdown, clearBuffer, getBuffer } from '../reportBuffer'

import type { DocumentConverter } from '../types'
import type { ToolContext } from '@page-agent/core'

/**
 * Throw if `signal` is already aborted, using a compatible polyfill for
 * environments where `AbortSignal.throwIfAborted` may not exist (e.g. jsdom).
 */
function throwIfAborted(signal: AbortSignal): void {
	if (typeof signal.throwIfAborted === 'function') {
		signal.throwIfAborted()
		return
	}
	if (signal.aborted) {
		throw (
			signal.reason ??
			(typeof DOMException === 'function'
				? new DOMException('The operation was aborted.', 'AbortError')
				: Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))
		)
	}
}

/**
 * The converter is injected at tool-creation time via the config closure
 * (see `createDocumentExportTools`).  This factory receives the converter
 * and returns the tool definition.
 */
export function createGenerateDocumentTool(onConvertDocument: DocumentConverter) {
	return tool({
		description:
			'Generate the final document from all appended report sections. ' +
			'The report buffer is assembled into Markdown and converted to the ' +
			'requested format (docx or xlsx). The buffer is cleared after generation. ' +
			'Before calling this tool, consider asking the user to confirm the report content.',
		inputSchema: z.object({
			/** Output format */
			format: z.enum(['docx', 'xlsx']).describe('Target document format'),
			/** Optional document title */
			title: z
				.string()
				.optional()
				.describe('Optional document title placed as the top-level heading'),
		}),
		execute: async function (
			this: PageAgentCore,
			input: { format: 'docx' | 'xlsx'; title?: string },
			{ signal }: ToolContext
		) {
			throwIfAborted(signal)

			const buffer = getBuffer(this)

			if (buffer.sections.length === 0) {
				return (
					'⚠️ Report buffer is empty. Use extract_form_data and append_to_report ' +
					'to gather data before generating a document.'
				)
			}

			const markdown = assembleMarkdown(this, input.title)

			try {
				// Forward the task-cancellation signal to the converter so that
				// async operations inside it (network requests, heavy computation,
				// triggered downloads) can be aborted when the agent task is stopped.
				const result = await onConvertDocument(markdown, input.format, signal)
				throwIfAborted(signal)
				clearBuffer(this)

				const message = typeof result === 'string' && result ? result : 'Download triggered'
				return `✅ Document generated (${input.format}). ${message}`
			} catch (error) {
				// Re-throw AbortError so the agent loop can handle task cancellation
				// correctly instead of swallowing it as a document-generation failure.
				if ((error as any)?.name === 'AbortError') throw error
				return `❌ Document generation failed: ${String(error)}`
			}
		},
	})
}
