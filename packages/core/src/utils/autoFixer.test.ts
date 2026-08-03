import { InvokeErrorTypes } from '@page-agent/llms'
import { describe, expect, it } from 'vitest'

import { tools as builtInTools } from '../tools'

import { normalizeResponse } from './autoFixer'

const testTools = new Map(
	['wait', 'click_element_by_index', 'execute_javascript'].map((name) => [
		name,
		builtInTools.get(name)!,
	])
)

function contentResponse(content: string): any {
	return { choices: [{ message: { role: 'assistant', content } }] }
}

function toolCallResponse(name: string, args: unknown): any {
	return {
		choices: [
			{
				message: {
					role: 'assistant',
					tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
				},
			},
		],
	}
}

function normalizedArgs(response: any): any {
	return JSON.parse(response.choices[0].message.tool_calls[0].function.arguments)
}

function expectInvokeError(run: () => unknown, type: string, message: RegExp): void {
	try {
		run()
		throw new Error('Expected normalizeResponse to throw')
	} catch (error) {
		expect(error).toMatchObject({ type })
		expect((error as Error).message).toMatch(message)
	}
}

describe('normalizeResponse', () => {
	it('preserves one canonical AgentOutput object from content', () => {
		const canonical = {
			evaluation_previous_goal: 'The page loaded. Verdict: Success',
			memory: 'The page is ready.',
			next_goal: 'Wait for the next update.',
			action: { wait: { seconds: 2 } },
		}

		const normalized = normalizeResponse(
			contentResponse(`<think>done</think>\n\`\`\`json\n${JSON.stringify(canonical)}\n\`\`\``),
			testTools
		)

		expect(normalizedArgs(normalized)).toEqual(canonical)
	})

	it('keeps AgentOutput wrappers as compatibility input but emits canonical arguments', () => {
		const canonical = { action: { wait: { seconds: 1 } } }
		const wrapped = {
			id: 'compat-call',
			type: 'function',
			function: {
				name: 'AgentOutput',
				arguments: JSON.stringify(JSON.stringify(canonical)),
			},
		}

		const normalized = normalizeResponse(contentResponse(JSON.stringify(wrapped)), testTools)

		expect(normalizedArgs(normalized)).toEqual(canonical)
	})

	it.each([
		['legacy Tl wrapper', { tool_name: 'wait', parameters: { seconds: 2 } }],
		['OpenAI call body', { name: 'wait', arguments: { seconds: 2 } }],
		['legacy string action', { action: 'wait', args: { seconds: 2 } }],
		['action-only object', { wait: { seconds: 2 } }],
	])('canonicalizes %s', (_label, value) => {
		const normalized = normalizeResponse(contentResponse(JSON.stringify(value)), testTools)

		expect(normalizedArgs(normalized)).toEqual({ action: { wait: { seconds: 2 } } })
	})

	it('preserves the function name when a provider calls an inner action natively', () => {
		const normalized = normalizeResponse(
			toolCallResponse('click_element_by_index', { index: 7 }),
			testTools
		)

		expect(normalized.choices[0].message.tool_calls[0].function.name).toBe('AgentOutput')
		expect(normalizedArgs(normalized)).toEqual({
			action: { click_element_by_index: { index: 7 } },
		})
	})

	it('coerces a historical primitive input only for a single-field action', () => {
		const normalized = normalizeResponse(
			contentResponse(JSON.stringify({ action: { click_element_by_index: 7 } })),
			testTools
		)

		expect(normalizedArgs(normalized)).toEqual({
			action: { click_element_by_index: { index: 7 } },
		})
	})

	it('preserves raw string primitives before single-field action coercion', () => {
		const normalized = normalizeResponse(
			contentResponse(JSON.stringify({ action: { execute_javascript: 'return document.title' } })),
			testTools
		)

		expect(normalizedArgs(normalized)).toEqual({
			action: { execute_javascript: { script: 'return document.title' } },
		})
	})

	it('preserves raw string arguments from a direct native inner-action call', () => {
		const response = toolCallResponse('execute_javascript', {})
		response.choices[0].message.tool_calls[0].function.arguments = 'return document.title'

		const normalized = normalizeResponse(response, testTools)

		expect(normalizedArgs(normalized)).toEqual({
			action: { execute_javascript: { script: 'return document.title' } },
		})
	})

	it('rejects multiple JSON objects instead of guessing which is authoritative', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					contentResponse('{"note":"draft"}\n{"action":{"wait":{"seconds":1}}}'),
					testTools
				),
			InvokeErrorTypes.INVALID_RESPONSE,
			/contains 2 JSON objects/
		)
	})

	it('rejects multiple actions instead of executing the first key', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					contentResponse(
						JSON.stringify({
							action: {
								wait: { seconds: 1 },
								click_element_by_index: { index: 7 },
							},
						})
					),
					testTools
				),
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			/exactly one action; received 2/
		)
	})

	it('rejects missing actions instead of silently inserting wait', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					contentResponse(JSON.stringify({ memory: 'No action was selected.' })),
					testTools
				),
			InvokeErrorTypes.INVALID_RESPONSE,
			/does not contain a recognizable AgentOutput action/
		)
	})

	it('rejects canonical objects that violate the shared outer schema', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					contentResponse(
						JSON.stringify({
							memory: 123,
							unexpected: true,
							action: { wait: { seconds: 1 } },
						})
					),
					testTools
				),
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			/does not match the canonical schema/
		)
	})

	it('rejects conflicting compatibility wrappers', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					contentResponse(
						JSON.stringify({
							tool_name: 'wait',
							action: 'click_element_by_index',
							parameters: { seconds: 1 },
						})
					),
					testTools
				),
			InvokeErrorTypes.INVALID_RESPONSE,
			/conflicting wrapper formats/
		)
	})

	it('rejects malformed top-level response envelopes consistently', () => {
		expectInvokeError(
			() => normalizeResponse(null, testTools),
			InvokeErrorTypes.INVALID_RESPONSE,
			/must contain a choices array/
		)
	})

	it('rejects malformed native tool calls consistently', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					{ choices: [{ message: { tool_calls: [{ type: 'function' }] } }] },
					testTools
				),
			InvokeErrorTypes.INVALID_RESPONSE,
			/missing a valid function object/
		)
	})

	it('rejects malformed JSON instead of mutating string values', () => {
		const malformed = '{"memory":"Search for "widgets" next.","action":{"wait":{"seconds":1}}}'

		expectInvokeError(
			() => normalizeResponse(contentResponse(malformed), testTools),
			InvokeErrorTypes.INVALID_RESPONSE,
			/(incomplete JSON|not valid JSON)/
		)
	})

	it('rejects unknown actions with the available action list', () => {
		expectInvokeError(
			() =>
				normalizeResponse(
					contentResponse(JSON.stringify({ action: { imaginary: {} } })),
					testTools
				),
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			/Unknown action "imaginary"/
		)
	})
})
