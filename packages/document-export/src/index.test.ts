/**
 * Tests for createDocumentExportTools factory.
 */
import { describe, expect, it, vi } from 'vitest'

import { appendSection } from './reportBuffer'

import { createDocumentExportTools, DOCUMENT_EXPORT_PROMPT } from './index'

describe('createDocumentExportTools', () => {
	it('returns three tools with correct names', () => {
		const tools = createDocumentExportTools({
			onConvertDocument: vi.fn(),
		})

		expect(Object.keys(tools)).toEqual(
			expect.arrayContaining(['extract_form_data', 'append_to_report', 'generate_document'])
		)
		expect(Object.keys(tools)).toHaveLength(3)
	})

	it('each tool has description, inputSchema, and execute', () => {
		const tools = createDocumentExportTools({
			onConvertDocument: vi.fn(),
		})

		for (const [name, tool] of Object.entries(tools)) {
			expect(tool.description, `${name} should have description`).toBeTruthy()
			expect(tool.inputSchema, `${name} should have inputSchema`).toBeDefined()
			expect(typeof tool.execute, `${name} should have execute`).toBe('function')
		}
	})

	it('generate_document forwards the AbortSignal to the converter callback', async () => {
		// P2-4 regression: converter must receive the signal so it can cancel
		// async work (e.g. a network request) when the agent task is stopped.
		const receivedSignals: AbortSignal[] = []
		const tools = createDocumentExportTools({
			onConvertDocument: async (_md, _fmt, signal) => {
				receivedSignals.push(signal)
			},
		})

		const fakeAgent: any = { taskId: 'task-signal-test' }
		appendSection(fakeAgent, 'Section', 'content')

		const ac = new AbortController()
		await tools.generate_document.execute.call(fakeAgent, { format: 'docx' }, { signal: ac.signal })

		expect(receivedSignals).toHaveLength(1)
		expect(receivedSignals[0]).toBe(ac.signal)
	})

	it('generate_document re-throws AbortError instead of swallowing it', async () => {
		// P2-4 regression: if the task is stopped during conversion, the
		// AbortError must propagate so the agent loop can handle it correctly.
		const tools = createDocumentExportTools({
			onConvertDocument: async (_md, _fmt, signal) => {
				// Use signal.aborted instead of throwIfAborted for jsdom compat
				if (signal.aborted) {
					throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
				}
			},
		})

		const abort = new AbortController()
		abort.abort()

		const fakeAgent: any = { taskId: 'task-abort-test' }
		appendSection(fakeAgent, 'Section', 'content')

		await expect(
			tools.generate_document.execute.call(fakeAgent, { format: 'docx' }, { signal: abort.signal })
		).rejects.toMatchObject({ name: 'AbortError' })
	})

	it('extract_form_data formats required, disabled, and readOnly flags in output', async () => {
		const tools = createDocumentExportTools({
			onConvertDocument: vi.fn(),
		})

		const fakeAgent: any = {
			pageController: {
				extractFormData: vi.fn().mockResolvedValue([
					{
						index: 1,
						tagName: 'input',
						type: 'text',
						name: 'phone',
						label: 'Phone Number',
						required: true,
					},
					{
						index: 2,
						tagName: 'input',
						type: 'text',
						name: 'order_id',
						value: 'ORD-999',
						readOnly: true,
					},
					{
						index: 3,
						tagName: 'select',
						name: 'status',
						disabled: true,
						options: ['Active', 'Archived'],
					},
				]),
			},
		}

		const ac = new AbortController()
		const result = await tools.extract_form_data.execute.call(fakeAgent, {}, { signal: ac.signal })

		expect(result).toContain('required')
		expect(result).toContain('readOnly')
		expect(result).toContain('disabled')
		expect(result).toContain('[1] <input type=text name="phone"> label="Phone Number" required')
		expect(result).toContain('[2] <input type=text name="order_id"> value="ORD-999" readOnly')
		expect(result).toContain('[3] <select name="status"> disabled options=[Active, Archived]')
	})
})

describe('DOCUMENT_EXPORT_PROMPT', () => {
	it('contains instructions for all three tools', () => {
		expect(DOCUMENT_EXPORT_PROMPT).toContain('extract_form_data')
		expect(DOCUMENT_EXPORT_PROMPT).toContain('append_to_report')
		expect(DOCUMENT_EXPORT_PROMPT).toContain('generate_document')
	})

	it('contains workflow guidance', () => {
		expect(DOCUMENT_EXPORT_PROMPT).toContain('<workflow>')
		expect(DOCUMENT_EXPORT_PROMPT).toContain('</workflow>')
	})

	it('mentions data-page-agent-no-export', () => {
		expect(DOCUMENT_EXPORT_PROMPT).toContain('data-page-agent-no-export')
	})
})
