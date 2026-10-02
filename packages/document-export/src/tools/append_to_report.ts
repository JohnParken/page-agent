/**
 * `append_to_report` tool — appends a Markdown section to the in-memory
 * report buffer.  The LLM calls this after analysing form data to
 * accumulate sections across multiple pages / steps.
 *
 * Buffer content is intentionally NOT written into agent history so it
 * does not inflate the LLM context with large data payloads.
 */
import { type PageAgentCore, tool } from '@page-agent/core'
import * as z from 'zod/v4'

import { appendSection, getBuffer } from '../reportBuffer'

export const appendToReportTool = tool({
	description:
		'Append a Markdown section to the report buffer. Use this to accumulate analysis ' +
		'results across pages/steps. Each call adds one titled section. ' +
		'When all data is gathered, call generate_document to produce the final file.',
	inputSchema: z.object({
		/** Section heading (e.g. "User Profile Form Analysis") */
		section_title: z.string().describe('Section heading for the report'),
		/** Markdown content for this section */
		content: z
			.string()
			.describe(
				'Markdown content for this section. Use tables, lists, and headings as appropriate.'
			),
	}),
	execute: async function (this: PageAgentCore, input: { section_title: string; content: string }) {
		appendSection(this, input.section_title, input.content)
		const buffer = getBuffer(this)
		return (
			`✅ Section "${input.section_title}" appended to report. ` +
			`Report now has ${buffer.sections.length} section(s).`
		)
	},
})
