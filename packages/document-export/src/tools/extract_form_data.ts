/**
 * `extract_form_data` tool — extracts structured form field data from the
 * current page and returns it as a JSON description for the LLM to read,
 * analyse, and memorise.
 */
import { type PageAgentCore, tool } from '@page-agent/core'
import * as z from 'zod/v4'

export const extractFormDataTool = tool({
	description:
		'Extract all form fields (inputs, selects, textareas) from the current page as ' +
		'structured data. Fields marked with data-page-agent-no-export are excluded. ' +
		'Use the result to analyse form content, then call append_to_report to save findings.',
	inputSchema: z.object({}),
	execute: async function (this: PageAgentCore, _input, { signal }) {
		signal.throwIfAborted()

		const fields = await this.pageController.extractFormData({ signal })
		signal.throwIfAborted()

		if (fields.length === 0) {
			return '⚠️ No exportable form fields found on the current page.'
		}

		const summary = fields
			.map((f) => {
				const parts = [`[${f.index}] <${f.tagName}`]
				if (f.type) parts.push(` type=${f.type}`)
				if (f.name) parts.push(` name="${f.name}"`)
				parts.push('>')
				if (f.label) parts.push(` label="${f.label}"`)
				if (f.value !== undefined && f.value !== '') parts.push(` value="${f.value}"`)
				if (f.placeholder) parts.push(` placeholder="${f.placeholder}"`)
				if (f.checked !== undefined) parts.push(` checked=${f.checked}`)
				if (f.options && f.options.length > 0) parts.push(` options=[${f.options.join(', ')}]`)
				return parts.join('')
			})
			.join('\n')

		return `✅ Extracted ${fields.length} form field(s):\n${summary}`
	},
})
