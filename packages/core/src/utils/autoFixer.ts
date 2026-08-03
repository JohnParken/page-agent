import { InvokeError, InvokeErrorTypes } from '@page-agent/llms'
import * as z from 'zod/v4'

import type { PageAgentTool } from '../tools'
import type { MacroToolInput } from '../types'

type JsonObject = Record<string, unknown>

/** Build the single AgentOutput schema shared by prompt generation and parsing. */
export function buildAgentOutputSchema(
	tools: Map<string, PageAgentTool>
): z.ZodType<MacroToolInput> {
	const actionSchemas = Array.from(tools.entries()).map(([toolName, tool]) =>
		z
			.object({ [toolName]: tool.inputSchema })
			.strict()
			.describe(tool.description)
	)
	const actionSchema = z.union(actionSchemas as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])

	return z
		.object({
			evaluation_previous_goal: z.string().optional(),
			memory: z.string().optional(),
			next_goal: z.string().optional(),
			action: actionSchema,
		})
		.strict() as z.ZodType<MacroToolInput>
}

/**
 * Normalize provider responses into the one canonical PageAgent contract:
 * the argument object of the AgentOutput macro tool.
 *
 * The prompt advertises only that canonical object. A small set of historical
 * wrappers remains accepted here as ingress compatibility, but every accepted
 * shape is converted before schema validation and execution.
 */
export function normalizeResponse(response: any, tools: Map<string, PageAgentTool>): any {
	if (!isJsonObject(response) || !Array.isArray(response.choices)) {
		throw invalidResponse('Response must contain a choices array', response)
	}
	const choice = response.choices[0] as Choice | undefined
	if (!isJsonObject(choice)) throw invalidResponse('No valid choice in response', response)

	const message = choice.message
	if (!isJsonObject(message)) throw invalidResponse('No valid message in choice', response)

	if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) {
		throw invalidResponse('message.tool_calls must be an array', message.tool_calls)
	}
	const toolCalls = (message.tool_calls ?? []) as ResponseToolCall[]
	if (toolCalls.length > 1) {
		throw invalidResponse('Expected exactly one tool call, but received multiple', response)
	}

	let canonicalOutput: JsonObject
	const toolCall = toolCalls[0]
	if (toolCall) {
		canonicalOutput = canonicalizeNativeToolCall(toolCall, tools)
	} else if (typeof message.content === 'string' && message.content.trim()) {
		const parsedContent = extractSingleJsonObject(message.content)
		canonicalOutput = canonicalizeObject(parsedContent, tools)
	} else {
		throw invalidResponse('No tool call or non-empty message content is present', response)
	}

	canonicalOutput.action = validateAction(canonicalOutput.action, tools)
	const validation = buildAgentOutputSchema(tools).safeParse(canonicalOutput)
	if (!validation.success) {
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			`AgentOutput does not match the canonical schema: ${z.prettifyError(validation.error)}`
		)
	}
	canonicalOutput = validation.data as unknown as JsonObject

	return {
		...response,
		choices: [
			{
				...choice,
				message: {
					...message,
					tool_calls: [
						{
							...(toolCall || {}),
							function: {
								...(toolCall?.function || {}),
								name: 'AgentOutput',
								arguments: JSON.stringify(canonicalOutput),
							},
						},
					],
				},
			},
		],
	}
}

/** Convert a native macro or inner-action tool call to canonical AgentOutput input. */
function canonicalizeNativeToolCall(
	toolCall: ResponseToolCall,
	tools: Map<string, PageAgentTool>
): JsonObject {
	if (!isJsonObject(toolCall) || !isJsonObject(toolCall.function)) {
		throw invalidResponse('Tool call is missing a valid function object', toolCall)
	}
	const name = toolCall.function.name
	if (typeof name !== 'string' || !name) {
		throw invalidResponse('Tool call is missing function.name', toolCall)
	}
	if (toolCall.function.arguments === undefined) {
		throw invalidResponse(`Tool call "${name}" is missing function.arguments`, toolCall)
	}

	const args =
		name === 'AgentOutput'
			? parseJsonArgument(toolCall.function.arguments, `arguments for tool "${name}"`)
			: parseCompatibleActionInput(toolCall.function.arguments)
	if (name === 'AgentOutput') return canonicalizeObject(args, tools)

	// Compatibility for providers that call an inner action directly.
	return { action: { [name]: args } }
}

/** Convert recognized legacy wrappers to the canonical AgentOutput object. */
function canonicalizeObject(
	input: unknown,
	tools: Map<string, PageAgentTool>,
	depth = 0
): JsonObject {
	if (depth > 4) throw invalidResponse('AgentOutput wrappers are nested too deeply', input)

	const value = parseJsonArgument(input, 'AgentOutput payload')
	if (!isJsonObject(value)) {
		throw invalidResponse('AgentOutput payload must be a JSON object', value)
	}

	if ('action' in value && isJsonObject(value.action)) return value

	const wrapperKinds = [
		isJsonObject(value.function),
		typeof value.name === 'string' && 'arguments' in value,
		typeof value.tool_name === 'string',
		typeof value.action === 'string',
	].filter(Boolean).length
	if (wrapperKinds > 1) {
		throw invalidResponse('AgentOutput payload contains conflicting wrapper formats', value)
	}

	// OpenAI-style function wrapper: { type, function: { name, arguments } }
	if (isJsonObject(value.function)) {
		assertOnlyKeys(value, ['id', 'type', 'function'], 'function wrapper')
		if ('type' in value && value.type !== 'function') {
			throw invalidResponse('function wrapper type must be "function"', value)
		}
		return canonicalizeNamedWrapper(value.function.name, value.function.arguments, tools, depth + 1)
	}

	// OpenAI-style call body: { name, arguments }
	if (typeof value.name === 'string' && 'arguments' in value) {
		assertOnlyKeys(value, ['name', 'arguments'], 'name/arguments wrapper')
		return canonicalizeNamedWrapper(value.name, value.arguments, tools, depth + 1)
	}

	// Legacy Tl body: { tool_name, parameters|args }
	if (typeof value.tool_name === 'string') {
		assertSingleArgumentField(value, 'Tl wrapper')
		assertOnlyKeys(value, ['tool_name', 'parameters', 'args'], 'Tl wrapper')
		return canonicalizeNamedWrapper(
			value.tool_name,
			value.parameters ?? value.args ?? {},
			tools,
			depth + 1
		)
	}

	// Legacy string action: { action: "tool", parameters|args }
	if (typeof value.action === 'string') {
		const actionName = value.action
		assertSingleArgumentField(value, 'string-action wrapper')
		assertOnlyKeys(value, ['action', 'parameters', 'args'], 'string-action wrapper')
		return {
			action: {
				[actionName]: parseCompatibleActionInput(value.parameters ?? value.args ?? {}),
			},
		}
	}

	// Compatibility for an action-only object, e.g. { wait: { seconds: 1 } }.
	const keys = Object.keys(value)
	const canonicalFields = new Set(['evaluation_previous_goal', 'memory', 'next_goal', 'action'])
	if (keys.some((key) => tools.has(key)) || (keys.length === 1 && !canonicalFields.has(keys[0]!))) {
		return { action: value }
	}

	throw invalidResponse('JSON object does not contain a recognizable AgentOutput action', value)
}

function canonicalizeNamedWrapper(
	name: unknown,
	args: unknown,
	tools: Map<string, PageAgentTool>,
	depth: number
): JsonObject {
	if (typeof name !== 'string' || !name) {
		throw invalidResponse('Function wrapper is missing a valid name', { name, args })
	}

	const parsedArgs =
		name === 'AgentOutput'
			? parseJsonArgument(args, `arguments for tool "${name}"`)
			: parseCompatibleActionInput(args)
	if (name === 'AgentOutput') return canonicalizeObject(parsedArgs, tools, depth)
	return { action: { [name]: parsedArgs } }
}

function assertSingleArgumentField(value: JsonObject, label: string): void {
	if ('parameters' in value && 'args' in value) {
		throw invalidResponse(`${label} contains both parameters and args`, value)
	}
}

function assertOnlyKeys(value: JsonObject, allowed: string[], label: string): void {
	const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
	if (unexpected.length > 0) {
		throw invalidResponse(`${label} contains unexpected fields: ${unexpected.join(', ')}`, value)
	}
}

/** Validate that action has exactly one registered key and schema-valid input. */
function validateAction(action: unknown, tools: Map<string, PageAgentTool>): JsonObject {
	if (!isJsonObject(action)) {
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			'AgentOutput.action must be a JSON object with exactly one action'
		)
	}

	const actionNames = Object.keys(action)
	if (actionNames.length !== 1) {
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			`AgentOutput.action must contain exactly one action; received ${actionNames.length}`
		)
	}

	const toolName = actionNames[0]!
	const tool = tools.get(toolName)
	if (!tool) {
		const available = Array.from(tools.keys()).join(', ')
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			`Unknown action "${toolName}". Available: ${available}`
		)
	}

	let input = parseCompatibleActionInput(action[toolName])
	const schema = tool.inputSchema

	// Compatibility for historical primitive inputs to single-field actions.
	if (schema instanceof z.ZodObject && input !== null && typeof input !== 'object') {
		const requiredKeys = Object.keys(schema.shape).filter(
			(key) => !(schema.shape as Record<string, z.ZodType>)[key].safeParse(undefined).success
		)
		if (requiredKeys.length === 1) input = { [requiredKeys[0]!]: input }
	}

	const result = schema.safeParse(input)
	if (!result.success) {
		throw new InvokeError(
			InvokeErrorTypes.INVALID_TOOL_ARGS,
			`Invalid input for action "${toolName}": ${z.prettifyError(result.error)}`
		)
	}

	return { [toolName]: result.data }
}

/** Parse a provider argument that must contain JSON, including double encoding. */
function parseJsonArgument(input: unknown, label: string): unknown {
	let value = input
	for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) {
		try {
			value = JSON.parse(value.trim())
		} catch (error) {
			if (depth > 0) return value
			throw invalidResponse(`Failed to parse ${label} as JSON`, input, error)
		}
	}
	return value
}

/** Parse legacy JSON-encoded action input while preserving raw string primitives. */
function parseCompatibleActionInput(input: unknown): unknown {
	let value = input
	for (let depth = 0; depth < 4 && typeof value === 'string'; depth++) {
		try {
			value = JSON.parse(value.trim())
		} catch {
			return value
		}
	}
	return value
}

/**
 * Extract exactly one balanced JSON object from assistant content.
 * Surrounding prose, markdown fences, and known tags are tolerated, but two
 * top-level objects are rejected instead of guessing which one is authoritative.
 */
function extractSingleJsonObject(content: string): unknown {
	const trimmed = content.trim()
	try {
		return JSON.parse(trimmed)
	} catch {
		// Continue with string-aware balanced-object extraction.
	}

	const objects: string[] = []
	let start = -1
	let depth = 0
	let inString = false
	let escaped = false

	for (let index = 0; index < trimmed.length; index++) {
		const char = trimmed[index]
		if (inString) {
			if (escaped) {
				escaped = false
			} else if (char === '\\') {
				escaped = true
			} else if (char === '"') {
				inString = false
			}
			continue
		}

		if (char === '"' && depth > 0) {
			inString = true
		} else if (char === '{') {
			if (depth === 0) start = index
			depth++
		} else if (char === '}' && depth > 0) {
			depth--
			if (depth === 0 && start >= 0) {
				objects.push(trimmed.slice(start, index + 1))
				start = -1
			}
		}
	}

	if (depth !== 0 || inString) {
		throw invalidResponse('Assistant content contains incomplete JSON', content)
	}
	if (objects.length === 0) {
		throw invalidResponse('Assistant content does not contain a JSON object', content)
	}
	if (objects.length > 1) {
		throw invalidResponse(
			`Assistant content contains ${objects.length} JSON objects; expected exactly one`,
			content
		)
	}

	try {
		return JSON.parse(objects[0]!)
	} catch (error) {
		throw invalidResponse('Extracted AgentOutput object is not valid JSON', objects[0], error)
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(message: string, rawResponse: unknown, rawError?: unknown): InvokeError {
	return new InvokeError(InvokeErrorTypes.INVALID_RESPONSE, message, rawError, rawResponse)
}

interface ResponseToolCall {
	id?: string
	type?: 'function'
	function?: {
		name?: string
		arguments?: unknown
	}
}

interface Choice {
	message?: {
		role?: 'assistant'
		content?: string | null
		tool_calls?: ResponseToolCall[]
	}
	index?: number
	finish_reason?: string
}
