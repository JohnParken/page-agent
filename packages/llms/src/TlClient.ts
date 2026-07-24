/**
 * Tl AI Client
 * Supports session initialization and streaming chat for the chatbbc API.
 */
import * as z from 'zod'

import { InvokeError, InvokeErrorTypes } from './errors'
import type { InvokeOptions, InvokeResult, LLMClient, Message, Tool } from './types'

/**
 * Tool calling mode for Tl AI.
 */
export type ToolCallingMode = 'api' | 'system_prompt'

/**
 * Configuration for Tl AI (chatbbc) endpoint.
 */
export interface TlAiConfig {
	/** Agent host, e.g. "api.example.com". The client calls http://${endpointAgent}/chatbbc/... */
	endpointAgent: string
	/** Model / prompt name used during session initialization. */
	model: string
	appId?: string
	trCode?: string
	trVersion?: string
	/** Tool calling mode, default 'api'. */
	toolCallingMode?: ToolCallingMode
	/** Optional custom fetch implementation. */
	customFetch?: typeof globalThis.fetch
}

interface InitSessionRequest {
	appId: string
	trCode: string
	trVersion: string
	timestamp: number
	requestId: string
	data: {
		prompt_variables: { name: string; value: string }[]
	}
}

interface ChatRequest {
	appId: string
	trCode: string
	trVersion: string
	timestamp: number
	requestId: string
	data: {
		session_id: string
		txt: string
		files: { file_id: string; url: string; content_type: string }[]
		stream: boolean
	}
}

/**
 * Client for Tl AI chatbbc API.
 */
export class TlAiClient implements LLMClient {
	config: Required<Omit<TlAiConfig, 'customFetch'>> & Pick<TlAiConfig, 'customFetch'>
	private fetch: typeof globalThis.fetch
	private sessionId: string | null = null

	constructor(config: TlAiConfig) {
		if (!config.endpointAgent || !config.model) {
			throw new InvokeError(
				InvokeErrorTypes.CONFIG_ERROR,
				'TlAiClient requires endpointAgent and model'
			)
		}

		this.config = {
			endpointAgent: config.endpointAgent,
			model: config.model,
			appId: config.appId ?? '',
			trCode: config.trCode ?? '',
			trVersion: config.trVersion ?? '',
			toolCallingMode: config.toolCallingMode ?? 'api',
			customFetch: config.customFetch,
		}
		this.fetch = config.customFetch ?? fetch.bind(globalThis)
	}

	/**
	 * Initialize a session via the init_session endpoint.
	 */
	async initSession(): Promise<string> {
		const url = `http://${this.config.endpointAgent}/chatbbc/init_session`

		const requestBody: InitSessionRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: 1,
			requestId: '',
			data: {
				prompt_variables: [
					{
						name: 'name',
						value: this.config.model,
					},
				],
			},
		}

		let response: Response
		try {
			response = await this.fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'Session initialization failed', error)
		}

		if (!response.ok) {
			let errorData: unknown
			try {
				errorData = await response.json()
			} catch {
				errorData = {}
			}
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Session initialization failed: ${response.statusText}`,
				errorData
			)
		}

		let data: any
		try {
			data = await response.json()
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.INVALID_RESPONSE,
				'Session initialization response is not valid JSON',
				error
			)
		}

		this.sessionId = data.data?.session_id ?? null
		if (!this.sessionId) {
			throw new InvokeError(
				InvokeErrorTypes.INVALID_SCHEMA,
				'No session_id in initialization response',
				undefined,
				data
			)
		}

		return this.sessionId
	}

	/**
	 * Generate a unique request ID.
	 */
	private generateRequestId(): string {
		return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
	}

	/**
	 * Convert Zod schema to JSON Schema for tool description.
	 */
	private zodToJsonSchema(schema: z.ZodTypeAny): any {
		try {
			// We'll create a simplified JSON Schema representation
			const result: any = {}

			// For simplicity, let's handle common Zod types
			// In a real implementation, you'd want to use a proper Zod to JSON Schema converter
			result.type = 'object'
			result.properties = {}
			result.required = []

			return result
		} catch (e) {
			return { type: 'object', properties: {} }
		}
	}

	/**
	 * Format tools into a system prompt for tool calling via system message.
	 * Note: In our system, tools are packed into a single "AgentOutput" macro tool.
	 */
	private formatToolsToSystemPrompt(tools: Record<string, Tool>): string {
		// In PageAgentCore, all tools are packed into a single "AgentOutput" macro tool
		// The system_prompt.md already contains instructions on how to output the JSON
		// So we don't need to add additional tool descriptions here, just make sure
		// the system prompt is properly included.

		// Return empty string because system_prompt.md already contains everything needed
		// including output format instructions.
		return ''
	}

	/**
	 * Parse a streaming response body and extract the tool call.
	 */
	private async parseStreamingResponse(
		response: Response,
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal
	): Promise<{ toolName: string; toolArgs: unknown }> {
		const reader = response.body?.getReader()
		if (!reader) {
			throw new InvokeError(InvokeErrorTypes.UNKNOWN, 'No response body')
		}

		const decoder = new TextDecoder()
		let accumulatedContent = ''

		try {
			while (true) {
				abortSignal?.throwIfAborted()
				const { done, value } = await reader.read()
				if (done) break

				const chunk = decoder.decode(value, { stream: true })
				const lines = chunk.split('\n')

				for (const line of lines) {
					const trimmedLine = line.trim()
					if (trimmedLine) {
						accumulatedContent += trimmedLine
						console.log(trimmedLine)
					}
				}
			}
		} finally {
			reader.releaseLock()
		}

		try {
			// Strip markdown code fences if present (e.g. ```json ... ```)
			let cleaned = accumulatedContent.trim()
			cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '')

			const responseObj: any = JSON.parse(cleaned)

			// Extract tool name from the action object.
			// qwen returns action as { "done": { success, text } } or { "click": { index } } etc.
			let toolName: string
			let toolArgs: unknown

			if (responseObj.tool_name && typeof responseObj.tool_name === 'string') {
				toolName = responseObj.tool_name
				toolArgs = responseObj.parameters || responseObj.args || {}
			} else if (responseObj.action && typeof responseObj.action === 'object') {
				const actionKeys = Object.keys(responseObj.action)
				toolName = actionKeys[0]
				toolArgs = responseObj.action[toolName]
			} else if (typeof responseObj.action === 'string') {
				toolName = responseObj.action
				toolArgs = responseObj.parameters || responseObj.args || {}
			} else {
				toolName = Object.keys(tools)[0]
				toolArgs = {}
			}

			return { toolName, toolArgs }
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error

			const firstToolName = Object.keys(tools)[0]
			if (!firstToolName) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_RESPONSE,
					'No tools available and response is not JSON',
					undefined,
					{ content: accumulatedContent }
				)
			}
			return { toolName: firstToolName, toolArgs: {} }
		}
	}

	async invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		_options?: InvokeOptions
	): Promise<InvokeResult> {
		abortSignal?.throwIfAborted()

		// 1. Initialize session if needed.
		if (!this.sessionId) {
			await this.initSession()
		}

		// 2. Build chat request text, considering tool calling mode.
		let chatText: string

		if (this.config.toolCallingMode === 'system_prompt') {
			// For system_prompt mode, include ALL messages (including system)
			// The system message already contains system_prompt.md which has all instructions
			const messageTexts = messages.map((m) => {
				return `${m.role}: ${m.content ?? ''}`
			})
			chatText = messageTexts.join('\n')
		} else {
			// For api mode (default), proceed as before
			chatText = messages
				.filter((m) => m.role !== 'system')
				.map((m) => `${m.role}: ${m.content ?? ''}`)
				.join('\n')
		}

		const requestBody: ChatRequest = {
			appId: this.config.appId,
			trCode: this.config.trCode,
			trVersion: this.config.trVersion,
			timestamp: Date.now(),
			requestId: this.generateRequestId(),
			data: {
				session_id: this.sessionId!,
				txt: chatText,
				files: [
					{
						file_id: '',
						url: '',
						content_type: '',
					},
				],
				stream: true,
			},
		}

		// 3. Call chat endpoint.
		const url = `http://${this.config.endpointAgent}/chatbbc/chat`

		let response: Response
		try {
			response = await this.fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(requestBody),
				signal: abortSignal,
			})
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			console.error(error)
			throw new InvokeError(InvokeErrorTypes.NETWORK_ERROR, 'Network request failed', error)
		}

		// 4. Handle HTTP errors.
		if (!response.ok) {
			let errorData: unknown
			try {
				errorData = await response.json()
			} catch {
				errorData = {}
			}
			const errorMessage = (errorData as any)?.message || response.statusText

			if (response.status === 401 || response.status === 403) {
				throw new InvokeError(
					InvokeErrorTypes.AUTH_ERROR,
					`Authentication failed: ${errorMessage}`,
					errorData
				)
			}
			if (response.status === 429) {
				throw new InvokeError(
					InvokeErrorTypes.RATE_LIMIT,
					`Rate limit exceeded: ${errorMessage}`,
					errorData
				)
			}
			if (response.status >= 500) {
				throw new InvokeError(
					InvokeErrorTypes.SERVER_ERROR,
					`Server error: ${errorMessage}`,
					errorData
				)
			}
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`HTTP ${response.status}: ${errorMessage}`,
				errorData
			)
		}

		// 5. Parse streaming response.
		const { toolName, toolArgs } = await this.parseStreamingResponse(response, tools, abortSignal)

		// 6. Validate tool exists.
		const tool = tools[toolName]
		if (!tool) {
			throw new InvokeError(
				InvokeErrorTypes.UNKNOWN,
				`Tool "${toolName}" not found in tools`,
				undefined,
				{ toolName, availableTools: Object.keys(tools) }
			)
		}

		// 7. Parse and validate tool arguments.
		let parsedArgs: unknown = toolArgs
		if (typeof toolArgs === 'string') {
			try {
				parsedArgs = JSON.parse(toolArgs)
			} catch (error: unknown) {
				throw new InvokeError(
					InvokeErrorTypes.INVALID_TOOL_ARGS,
					'Failed to parse tool arguments as JSON',
					error,
					{ rawArgs: toolArgs }
				)
			}
		}

		const validation = tool.inputSchema.safeParse(parsedArgs)
		if (!validation.success) {
			console.error(z.prettifyError(validation.error))
			throw new InvokeError(
				InvokeErrorTypes.INVALID_TOOL_ARGS,
				'Tool arguments validation failed',
				validation.error,
				{ rawArgs: parsedArgs }
			)
		}
		const toolInput = validation.data

		// 8. Execute tool.
		let toolResult: unknown
		try {
			toolResult = await tool.execute(toolInput)
		} catch (error: unknown) {
			if ((error as any)?.name === 'AbortError') throw error
			throw new InvokeError(
				InvokeErrorTypes.TOOL_EXECUTION_ERROR,
				`Tool execution failed: ${(error as Error)?.message}`,
				error,
				{ toolName, args: toolInput }
			)
		}

		// 9. Return result.
		return {
			toolCall: {
				name: toolName,
				args: toolInput,
			},
			toolResult,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
			},
			rawResponse: { toolName, toolArgs: toolInput },
			rawRequest: requestBody,
		}
	}
}
