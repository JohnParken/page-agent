/**
 * Core types for LLM integration
 */
import type * as z from 'zod/v4'

/**
 * Message format - OpenAI standard (industry standard)
 */
export interface Message {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content?: string | null
	tool_calls?: {
		id: string
		type: 'function'
		function: {
			name: string
			arguments: string // JSON string
		}
	}[]
	tool_call_id?: string
	name?: string
}

/**
 * Tool definition - uses Zod schema (LLM-agnostic)
 * Supports generics for type-safe parameters and return values
 */
export interface Tool<TParams = any, TResult = any> {
	// name: string
	description?: string
	inputSchema: z.ZodType<TParams>
	execute: (args: TParams) => Promise<TResult>
}

/**
 * Invoke options for LLM call
 */
export interface InvokeOptions {
	/**
	 * Force LLM to call a specific tool by name.
	 * If provided: tool_choice = { type: 'function', function: { name: toolChoiceName } }
	 * If not provided: tool_choice = 'required' (must call some tool, but model chooses which)
	 */
	toolChoiceName?: string
	/**
	 * Response normalization function.
	 * Called before parsing the response.
	 * Used to fix various response format errors from the model.
	 */
	normalizeResponse?: (response: any) => any
}

/**
 * LLM Client interface
 * Note: Does not use generics because each tool in the tools array has different types
 */
export interface LLMClient {
	invoke(
		messages: Message[],
		tools: Record<string, Tool>,
		abortSignal?: AbortSignal,
		options?: InvokeOptions
	): Promise<InvokeResult>
}

/**
 * Invoke result (strict typing, supports generics)
 */
export interface InvokeResult<TResult = unknown> {
	toolCall: {
		// id?: string // OpenAI's tool_call_id
		name: string
		args: any
	}
	toolResult: TResult // Supports generics, but defaults to unknown
	usage: {
		promptTokens: number
		completionTokens: number
		totalTokens: number
		cachedTokens?: number // Prompt cache hits
		reasoningTokens?: number // OpenAI o1 series reasoning tokens
	}
	rawResponse?: unknown // Raw response for debugging
	rawRequest?: unknown // Raw request for debugging
}

/**
 * LLM configuration
 */
export interface LLMConfig {
	/**
	 * Base URL for OpenAI-compatible endpoints.
	 * Required when using the built-in OpenAI client (default).
	 */
	baseURL?: string
	/**
	 * Model identifier. Required for all built-in clients.
	 */
	model?: string
	apiKey?: string

	/**
	 * @deprecated No longer a standard parameter; many models reject it outright.
	 * Use `transformRequestBody` to set it only for models you've verified.
	 */
	temperature?: number

	maxRetries?: number

	/**
	 * Transform the final request body before sending it to the provider.
	 * Use this to implement provider-specific request tweaks such as caching hints or custom flags.
	 *
	 * Return a new object, or mutate the input object and return undefined.
	 */
	transformRequestBody?: (
		requestBody: Record<string, unknown>
	) => Record<string, unknown> | undefined

	/**
	 * remove the tool_choice field from the request.
	 * @note fix "Invalid tool_choice type: 'object'" for some LLMs.
	 */
	disableNamedToolChoice?: boolean

	/**
	 * Custom fetch function for LLM API requests.
	 * Use this to customize headers, credentials, proxy, etc.
	 * The response should follow OpenAI API format.
	 */
	customFetch?: typeof globalThis.fetch

	/**
	 * Inject a custom LLM client. When provided, the LLM class will use it
	 * instead of the built-in OpenAI or Yiming client.
	 */
	client?: LLMClient

	/**
	 * Built-in provider selection.
	 * @default 'openai'
	 */
	provider?: 'openai' | 'yiming'

	/**
	 * Yiming AI specific: agent host, e.g. "api.example.com".
	 * Required when provider is 'yiming'.
	 */
	endpointAgent?: string

	/**
	 * Yiming AI specific: application ID.
	 */
	appId?: string

	/**
	 * Yiming AI specific: transaction code.
	 */
	trCode?: string

	/**
	 * Yiming AI specific: transaction version.
	 */
	trVersion?: string

	/**
	 * Yiming AI specific: tool calling mode, either 'api' or 'system_prompt'.
	 */
	toolCallingMode?: 'api' | 'system_prompt'
}

export interface ResolvedLLMConfig {
	baseURL: string
	model: string
	apiKey: string
	temperature?: number
	maxRetries: number
	transformRequestBody: (
		requestBody: Record<string, unknown>
	) => Record<string, unknown> | undefined
	disableNamedToolChoice: boolean
	customFetch: typeof globalThis.fetch
}
