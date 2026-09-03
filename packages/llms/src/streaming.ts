/**
 * Shared streaming / response-parsing utilities for LLM clients.
 *
 * Both TlAiClient (chatbbc gateway) and DsAiClient (gateway + official API)
 * accumulate the raw streaming content, then canonicalize it into a tool call.
 * Keeping that pipeline here gives every client the same tolerant parsing and
 * prevents autoFixer-related fixes from drifting across copies.
 */
import { InvokeError, InvokeErrorTypes } from './errors'

import type { Message, Tool } from './types'

/**
 * Extract `{ toolName, toolArgs }` from a parsed response object.
 *
 * Recognized shapes (checked in order):
 * 1. `{ tool_name: "...", parameters|args: {...} }`          — legacy Tl shape
 * 2. `{ name: "...", arguments: {...} }`                       — OpenAI tool_call shape
 * 3. `{ action: { "<tool>": {...} }, ...reflection fields }`   — PageAgent MacroTool shape
 * 4. `{ action: "<tool>", parameters|args: {...} }`            — legacy string-action shape
 *
 * For shape 3, if the inner tool name is not registered but an `AgentOutput`
 * macro tool exists, the entire object is returned as `AgentOutput`'s args
 * so PageAgentCore can still drive the macro-tool execution path.
 *
 * Returns `null` when no recognizable tool call is present.
 */
export function extractToolCall(
	obj: any,
	tools: Record<string, Tool>
): { toolName: string; toolArgs: unknown } | null {
	if (!obj || typeof obj !== 'object') return null

	// 1) { tool_name, parameters|args }
	if (typeof obj.tool_name === 'string') {
		return { toolName: obj.tool_name, toolArgs: obj.parameters ?? obj.args ?? {} }
	}

	// 2) { name, arguments }
	if (typeof obj.name === 'string') {
		return { toolName: obj.name, toolArgs: obj.arguments ?? {} }
	}

	// 3) { action: { <tool>: {...} } }
	if (obj.action && typeof obj.action === 'object') {
		const actionKeys = Object.keys(obj.action)
		if (actionKeys.length !== 1) return null
		const extractedToolName = actionKeys[0]
		const extractedToolArgs = obj.action[extractedToolName]

		if (tools[extractedToolName]) {
			return { toolName: extractedToolName, toolArgs: extractedToolArgs }
		}
		if (tools.AgentOutput) {
			// Macro tool case: hand the whole reflection+action object to AgentOutput
			return { toolName: 'AgentOutput', toolArgs: obj }
		}
		// Fallback: surface the unknown name so the caller emits a clear error
		return { toolName: extractedToolName, toolArgs: extractedToolArgs }
	}

	// 4) { action: "<tool>", parameters|args }
	if (typeof obj.action === 'string') {
		return { toolName: obj.action, toolArgs: obj.parameters ?? obj.args ?? {} }
	}

	return null
}

/**
 * Normalize an agent host / base URL string into an HTTP(S) URL without a
 * trailing slash. Hosts without a scheme are prefixed with `http://`.
 */
export function normalizeEndpointAgent(endpointAgent: string, label: string): string {
	const value = endpointAgent.trim()
	const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`

	let url: URL
	try {
		url = new URL(candidate)
	} catch (error) {
		throw new InvokeError(
			InvokeErrorTypes.CONFIG_ERROR,
			`Invalid ${label} endpointAgent "${endpointAgent}". Use a host such as "localhost:8089" or a full HTTP(S) URL.`,
			error
		)
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new InvokeError(
			InvokeErrorTypes.CONFIG_ERROR,
			`Unsupported ${label} endpointAgent protocol "${url.protocol}". Use HTTP or HTTPS.`
		)
	}

	url.search = ''
	url.hash = ''
	return url.toString().replace(/\/$/, '')
}

/** Describe an error including its `cause` chain, for actionable failure messages. */
export function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error)

	const cause = (error as Error & { cause?: unknown }).cause
	if (!cause || cause === error) return error.message

	let causeMessage: string
	if (cause instanceof Error) {
		causeMessage = cause.message
	} else if (typeof cause === 'string') {
		causeMessage = cause
	} else {
		try {
			causeMessage = JSON.stringify(cause) ?? Object.prototype.toString.call(cause)
		} catch {
			causeMessage = Object.prototype.toString.call(cause)
		}
	}
	return causeMessage && causeMessage !== error.message
		? `${error.message}: ${causeMessage}`
		: error.message
}

/** Heuristic: does this raw body look like an SSE stream? */
export function isSse(rawContent: string, contentType: string): boolean {
	const looksLikeSse = /^(?:\uFEFF)?(?:id|event|data|retry):/m.test(rawContent)
	return contentType.includes('text/event-stream') || looksLikeSse
}

/** Result of parsing a streamed SSE response. */
export interface SseParseResult {
	content: string
	usage?: unknown
}

/** Split SSE frames from a raw body into `{ eventType, data }` entries. */
function splitSseFrames(rawContent: string): { eventType: string; data: string }[] {
	const normalized = rawContent.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
	const frames: { eventType: string; data: string }[] = []

	for (const block of normalized.split('\n\n')) {
		if (!block.trim()) continue

		let eventType = 'message'
		const dataLines: string[] = []
		for (const line of block.split('\n')) {
			if (!line || line.startsWith(':')) continue
			const separator = line.indexOf(':')
			const field = separator === -1 ? line : line.slice(0, separator)
			let value = separator === -1 ? '' : line.slice(separator + 1)
			if (value.startsWith(' ')) value = value.slice(1)

			if (field === 'event') eventType = value
			if (field === 'data') dataLines.push(value)
		}
		if (dataLines.length > 0) frames.push({ eventType, data: dataLines.join('\n') })
	}
	return frames
}

/**
 * Parse the chatbbc (Tl-style) SSE format: `event: chunk` frames whose data is
 * `{"content": "..."}`. Stops on `[DONE]` / `done` / `end`.
 */
export function parseChatbbcSseContent(
	rawContent: string,
	debugLabel = 'TlAiClient'
): SseParseResult {
	let accumulatedContent = ''

	for (const { eventType, data } of splitSseFrames(rawContent)) {
		if (data === '[DONE]' || eventType === 'done' || eventType === 'end') break
		if (eventType === 'message') continue
		if (eventType === 'error') {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`${debugLabel} streaming response reported an error: ${data}`,
				undefined,
				{ event: eventType, data }
			)
		}

		let payload: unknown
		try {
			payload = JSON.parse(data)
		} catch (error: unknown) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`${debugLabel} SSE ${eventType} event contains invalid JSON`,
				error,
				{ event: eventType, data }
			)
		}

		const content = (payload as { content?: unknown })?.content
		if (typeof content === 'string') accumulatedContent += content
	}

	return { content: accumulatedContent }
}

/**
 * Parse the OpenAI-standard SSE format: `data:` frames whose payload is
 * `{"choices":[{"delta":{"content": "..."}}]}`. Stops on `data: [DONE]`.
 * The final frame carries `usage` and an empty `choices` array.
 */
export function parseOpenAISseContent(
	rawContent: string,
	debugLabel = 'DsAiClient'
): SseParseResult {
	let accumulatedContent = ''
	let usage: unknown

	for (const { eventType, data } of splitSseFrames(rawContent)) {
		if (eventType === 'error') {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`${debugLabel} streaming response reported an error: ${data}`,
				undefined,
				{ event: eventType, data }
			)
		}

		if (data === '[DONE]') break

		let payload: any
		try {
			payload = JSON.parse(data)
		} catch (error: unknown) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`${debugLabel} SSE event contains invalid JSON`,
				error,
				{ event: eventType, data }
			)
		}

		const deltaContent = payload?.choices?.[0]?.delta?.content
		if (typeof deltaContent === 'string') accumulatedContent += deltaContent
		if (payload?.usage) usage = payload.usage
	}

	return { content: accumulatedContent, usage }
}

/**
 * Read a response body without assuming network chunks align with SSE
 * boundaries. SSE responses are decoded into the accumulated content; legacy
 * plain-text responses are returned unchanged.
 */
export async function readStreamResponse(
	response: Response,
	abortSignal?: AbortSignal
): Promise<string> {
	const reader = response.body?.getReader()
	if (!reader) {
		throw new InvokeError(InvokeErrorTypes.UNKNOWN, 'No response body')
	}

	const decoder = new TextDecoder()
	let rawContent = ''

	try {
		while (true) {
			abortSignal?.throwIfAborted()
			const { done, value } = await reader.read()
			if (done) break

			rawContent += decoder.decode(value, { stream: true })
		}
		rawContent += decoder.decode()
	} finally {
		reader.releaseLock()
	}

	const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
	if (!isSse(rawContent, contentType)) {
		return rawContent
	}

	return rawContent
}

/**
 * Canonicalize accumulated streaming content into a tool call.
 *
 * Callers are expected to have already decoded the response body and extracted
 * the plain-text `content` (e.g. via `readStreamResponse` + an SSE parser for
 * their transport format).
 *
 * When `normalizeResponse` is provided (e.g. PageAgentCore's autoFixer), the
 * content is wrapped into an OpenAI-style response as `message.content` and
 * passed to it. PageAgentCore then canonicalizes recognized wrappers, rejects
 * ambiguous output, and validates the result as AgentOutput input.
 *
 * Without a normalizer, falls back to direct `extractToolCall` parsing.
 *
 * On unrecoverable parse failures, throws `InvokeError(INVALID_RESPONSE)` with
 * the raw content attached — never returns empty args.
 */
export function parseAccumulatedContent(
	accumulatedContent: string,
	tools: Record<string, Tool>,
	normalizeResponse?: (response: any) => any
): { toolName: string; toolArgs: unknown } {
	// 1) Normalizer path: canonicalize the complete accumulated content.
	if (normalizeResponse) {
		const openaiFormat = {
			choices: [
				{
					index: 0,
					message: {
						role: 'assistant' as const,
						content: accumulatedContent,
					},
				},
			],
		}

		let normalized: any
		try {
			normalized = normalizeResponse(openaiFormat)
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			if (error instanceof InvokeError) throw error
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				`normalizeResponse failed: ${(error as Error)?.message}`,
				error,
				{ content: accumulatedContent }
			)
		}

		const fn = normalized?.choices?.[0]?.message?.tool_calls?.[0]?.function
		if (!fn || typeof fn.name !== 'string' || typeof fn.arguments !== 'string') {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'normalizeResponse did not return a valid tool call',
				undefined,
				{ content: accumulatedContent, normalized }
			)
		}
		// Keep arguments as a JSON string; the caller (invoke) handles JSON.parse
		// and schema validation uniformly for both string and object toolArgs.
		return { toolName: fn.name, toolArgs: fn.arguments }
	}

	// 2) Fallback path: direct extraction without a normalizer.
	try {
		let cleaned = accumulatedContent.trim()
		// Strip markdown code fences if present (e.g. ```json ... ```)
		cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

		// Prefer <tool_call>...</tool_call> payload when present.
		const toolCallRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i
		const toolCallMatch = toolCallRe.exec(cleaned)
		if (toolCallMatch) {
			const inner = toolCallMatch[1].trim()
			const innerObj: any = JSON.parse(inner)
			const parsed = extractToolCall(innerObj, tools)
			if (parsed) return parsed
		}

		// Fall back to plain JSON (with or without surrounding text).
		const responseObj: any = JSON.parse(cleaned)
		const parsed = extractToolCall(responseObj, tools)
		if (parsed) return parsed

		throw new InvokeError(
			InvokeErrorTypes.INVALID_RESPONSE,
			'Response JSON did not contain a recognizable tool call',
			undefined,
			{ content: accumulatedContent }
		)
	} catch (error: unknown) {
		if ((error as any)?.name === 'AbortError') throw error
		if (error instanceof InvokeError) throw error
		throw new InvokeError(
			InvokeErrorTypes.INVALID_RESPONSE,
			`Failed to parse streaming response as JSON: ${(error as Error)?.message}`,
			error,
			{ content: accumulatedContent }
		)
	}
}

/** Re-exported type kept for callers that reference it. */
export type { Message }
