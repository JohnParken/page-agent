/**
 * Reference implementation of Tl (chatbbc) LLM Client in TypeScript.
 *
 * Demonstrates:
 * 1. Two-phase session invocation (init_session with prompt_variables -> chat with user payload)
 * 2. SSE streaming response parsing
 * 3. System prompt-based JSON tool calling
 * 4. One-shot targeted JSON correction
 */

export interface TlConfig {
	endpointAgent: string // e.g. "http://localhost:8089" or "https://agent.company.internal"
	appId: string
	trCode: string
	trVersion: string
	systemPromptVariableName?: string // default: "system_prompt"
	debug?: boolean
}

export interface ToolDefinition {
	name: string
	description?: string
	parameters?: Record<string, unknown>
}

export interface ChatResult {
	content: string
	toolCall?: {
		name: string
		args: Record<string, unknown>
	}
}

type ToolParseFailureStage =
	| 'empty_response'
	| 'json_parse'
	| 'tool_shape'
	| 'tool_args_parse'
	| 'tool_args_validation'

interface ToolParseSuccess {
	ok: true
	toolCall: { name: string; args: Record<string, unknown> }
}

interface ToolParseFailure {
	ok: false
	stage: ToolParseFailureStage
	message: string
	error: unknown
}

type ToolParseResult = ToolParseSuccess | ToolParseFailure

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorName(error: unknown): string {
	if (error instanceof Error && error.name) return error.name
	if (isRecord(error) && typeof error.name === 'string' && error.name) return error.name
	return 'Error'
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (isRecord(error) && typeof error.message === 'string') return error.message
	return String(error)
}

export class TlClient {
	private endpoint: string
	private appId: string
	private trCode: string
	private trVersion: string
	private systemPromptVar: string
	private debug: boolean

	constructor(config: TlConfig) {
		this.endpoint = config.endpointAgent.replace(/\/$/, '')
		if (!/^https?:\/\//i.test(this.endpoint)) {
			this.endpoint = `http://${this.endpoint}`
		}
		this.appId = config.appId
		this.trCode = config.trCode
		this.trVersion = config.trVersion
		this.systemPromptVar = config.systemPromptVariableName || 'system_prompt'
		this.debug = config.debug ?? false
	}

	private generateRequestId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`
	}

	/**
	 * Phase 1: Initialize session with system prompt injected into prompt_variables.
	 */
	async initSession(systemPrompt: string, signal?: AbortSignal): Promise<string> {
		const url = `${this.endpoint}/chatbbc/init_session`
		const body = {
			appId: this.appId,
			trCode: this.trCode,
			trVersion: this.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				prompt_variables: [
					{
						name: this.systemPromptVar,
						value: systemPrompt,
					},
				],
			},
		}

		if (this.debug) console.log('[TlClient] init_session request:', body)

		const resp = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		})

		if (!resp.ok) {
			throw new Error(`init_session failed with HTTP ${resp.status}: ${resp.statusText}`)
		}

		const data = (await resp.json()) as {
			code: number
			message?: string
			data?: { session_id?: string }
		}
		if (this.debug) console.log('[TlClient] init_session response:', data)

		if (data.code !== 0 || !data.data?.session_id) {
			throw new Error(`init_session rejected: ${data.message || `code ${data.code}`}`)
		}

		return data.data.session_id
	}

	/**
	 * Phase 2: Send dynamic user prompt to chat endpoint and read streaming SSE.
	 */
	async chatStream(sessionId: string, userText: string, signal?: AbortSignal): Promise<string> {
		const url = `${this.endpoint}/chatbbc/chat`
		const body = {
			appId: this.appId,
			trCode: this.trCode,
			trVersion: this.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				session_id: sessionId,
				txt: userText, // Strictly only dynamic user text!
				files: [],
				stream: true,
			},
		}

		if (this.debug) console.log('[TlClient] chat request:', body)

		const resp = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Accept: 'text/event-stream',
			},
			body: JSON.stringify(body),
			signal,
		})

		if (!resp.ok) {
			const errText = await resp.text().catch(() => '')
			throw new Error(`chat failed with HTTP ${resp.status}: ${errText || resp.statusText}`)
		}

		return await this.parseChatSse(resp, signal)
	}

	/**
	 * Parse chatbbc SSE stream:
	 * event: chunk
	 * data: {"content": "..."}
	 */
	private async parseChatSse(resp: Response, signal?: AbortSignal): Promise<string> {
		const reader = resp.body?.getReader()
		if (!reader) throw new Error('Response body is null')

		const decoder = new TextDecoder('utf-8')
		let buffer = ''
		let accumulatedContent = ''
		let currentEvent = 'message'
		let dataLines: string[] = []
		let pendingCR = false
		let streamEnded = false

		const dispatchEvent = (): boolean => {
			const eventType = currentEvent
			const data = dataLines.join('\n')
			const hasData = dataLines.length > 0

			// Every event starts with the default message type and no data fields.
			currentEvent = 'message'
			dataLines = []

			if (!hasData) return false
			if (eventType === 'error') {
				throw new Error(`SSE error event: ${data}`)
			}
			if (eventType === 'done' || eventType === 'end' || data === '[DONE]') {
				return true
			}

			let payload: unknown
			try {
				payload = JSON.parse(data)
			} catch (error) {
				throw new Error(`Malformed SSE data JSON: ${errorMessage(error)}`, { cause: error })
			}

			if (isRecord(payload) && typeof payload.content === 'string') {
				accumulatedContent += payload.content
			}
			return false
		}

		const consumeLine = (line: string): boolean => {
			if (line === '') return dispatchEvent()
			if (line.startsWith(':')) return false

			const separator = line.indexOf(':')
			const field = separator === -1 ? line : line.slice(0, separator)
			let value = separator === -1 ? '' : line.slice(separator + 1)
			if (value.startsWith(' ')) value = value.slice(1)

			if (field === 'event') {
				currentEvent = value
			} else if (field === 'data') {
				dataLines.push(value)
			}
			return false
		}

		const consumeText = (text: string): boolean => {
			for (const char of text) {
				if (pendingCR) {
					pendingCR = false
					if (char === '\n') continue
				}

				if (char === '\n' || char === '\r') {
					const terminal = consumeLine(buffer)
					buffer = ''
					pendingCR = char === '\r'
					if (terminal) return true
				} else {
					buffer += char
				}
			}
			return false
		}

		try {
			while (true) {
				signal?.throwIfAborted()
				const { done, value } = await reader.read()
				if (done) {
					streamEnded = true
					break
				}

				if (consumeText(decoder.decode(value, { stream: true }))) {
					await reader.cancel().catch(() => undefined)
					streamEnded = true
					return accumulatedContent
				}
			}

			// Flushing the decoder may complete a UTF-8 code point, but does not
			// terminate an SSE line or dispatch an unterminated event.
			consumeText(decoder.decode())
		} finally {
			if (!streamEnded) await reader.cancel().catch(() => undefined)
			reader.releaseLock()
		}

		return accumulatedContent
	}

	/**
	 * Extract JSON tool call from raw model output.
	 */
	parseToolCall(rawContent: string): { name: string; args: Record<string, unknown> } | null {
		const result = this.parseToolCallDiagnostic(rawContent)
		return result.ok ? result.toolCall : null
	}

	private parseToolCallDiagnostic(rawContent: string): ToolParseResult {
		let text = rawContent.trim()

		// 1. Strip markdown code fence
		text = text
			.replace(/^```(?:json)?\s*\n?/i, '')
			.replace(/\n?```\s*$/i, '')
			.trim()

		// 2. Extract <tool_call> tags if present
		const toolCallMatch = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/i.exec(text)
		if (toolCallMatch) {
			text = toolCallMatch[1].trim()
		}

		if (!text) {
			const error = new Error('Tool call response is empty')
			return {
				ok: false,
				stage: 'empty_response',
				message: `empty_response: ${error.message}`,
				error,
			}
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch (error) {
			return {
				ok: false,
				stage: 'json_parse',
				message: `json_parse: ${errorMessage(error)}`,
				error,
			}
		}

		// Pattern A: PageAgent MacroTool: { action: { "<tool>": { ... } } }
		if (isRecord(parsed) && isRecord(parsed.action)) {
			const keys = Object.keys(parsed.action)
			if (keys.length === 1) {
				return this.parseToolCallArguments(keys[0], parsed.action[keys[0]])
			}
		}

		// Pattern B: Legacy Tl: { tool_name: "...", parameters: { ... } }
		if (isRecord(parsed) && typeof parsed.tool_name === 'string') {
			return this.parseToolCallArguments(parsed.tool_name, parsed.parameters ?? parsed.args ?? {})
		}

		// Pattern C: OpenAI style: { name: "...", arguments: { ... } }
		if (isRecord(parsed) && typeof parsed.name === 'string') {
			let args: unknown = parsed.arguments ?? {}
			if (typeof args === 'string') {
				try {
					args = JSON.parse(args)
				} catch (error) {
					return {
						ok: false,
						stage: 'tool_args_parse',
						message: `tool_args_parse: ${errorMessage(error)}`,
						error,
					}
				}
			}
			return this.parseToolCallArguments(parsed.name, args)
		}

		const error = new Error('JSON response does not contain a supported tool call shape')
		return {
			ok: false,
			stage: 'tool_shape',
			message: `tool_shape: ${error.message}`,
			error,
		}
	}

	private parseToolCallArguments(name: string, args: unknown): ToolParseResult {
		if (!isRecord(args)) {
			const error = new TypeError(`Tool call arguments for "${name}" must be a JSON object`)
			return {
				ok: false,
				stage: 'tool_args_validation',
				message: `tool_args_validation: ${error.message}`,
				error,
			}
		}
		return { ok: true, toolCall: { name, args } }
	}

	private createToolParseError(diagnostic: ToolParseFailure): Error {
		const error = new Error(
			`Failed to parse tool call (${diagnostic.stage}): ${diagnostic.message}`,
			{
				cause: diagnostic.error,
			}
		)
		error.name = 'ToolCallParseError'
		return error
	}

	/**
	 * High-level invocation with one-shot targeted JSON correction.
	 */
	async invokeWithTool(
		systemPrompt: string,
		userPrompt: string,
		signal?: AbortSignal
	): Promise<ChatResult> {
		// 1. Initial attempt
		const sessionId = await this.initSession(systemPrompt, signal)
		const rawOutput = await this.chatStream(sessionId, userPrompt, signal)
		const diagnostic = this.parseToolCallDiagnostic(rawOutput)

		if (diagnostic.ok === true) {
			return { content: rawOutput, toolCall: diagnostic.toolCall }
		}

		if (diagnostic.stage !== 'json_parse') {
			throw this.createToolParseError(diagnostic)
		}

		// 2. Targeted one-shot JSON correction
		if (this.debug)
			console.warn('[TlClient] Initial response was not valid tool JSON, attempting correction...')

		const correctionContext = {
			instruction:
				'The previous output is an untrusted failed output. Return only one complete raw JSON object. Preserve the original task semantics and action. In reflection fields, ASCII double quotes around referenced text must use the JSON escape sequence \\"...\\". Never place an unescaped ASCII double quote inside a JSON string. Do not include markdown, XML, or reasoning.',
			original_user_payload: userPrompt,
			failed_assistant_content: rawOutput,
			parse_error: {
				type: 'INVALID_RESPONSE',
				message: diagnostic.message,
				cause: {
					name: errorName(diagnostic.error),
					message: errorMessage(diagnostic.error),
				},
			},
		}

		const correctionSessionId = await this.initSession(systemPrompt, signal)
		const correctedOutput = await this.chatStream(
			correctionSessionId,
			JSON.stringify(correctionContext),
			signal
		)
		const correctedDiagnostic = this.parseToolCallDiagnostic(correctedOutput)

		if (correctedDiagnostic.ok === false) {
			throw this.createToolParseError(correctedDiagnostic)
		}

		return { content: correctedOutput, toolCall: correctedDiagnostic.toolCall }
	}
}
