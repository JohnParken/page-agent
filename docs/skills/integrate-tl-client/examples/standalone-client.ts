/**
 * Standalone reference implementation of TlClient (chatbbc protocol).
 *
 * Can be copied into other projects needing to integrate with the internal Tl AI gateway.
 */

export interface TlClientConfig {
  /** Gateway base URL, e.g. "http://localhost:8089" or "https://tl-gateway.example.com" */
  endpointAgent: string
  /** Model identifier */
  model: string
  /** Application ID */
  appId?: string
  /** Transaction code */
  trCode?: string
  /** Transaction version */
  trVersion?: string
  /** Prompt variable name used for system prompt (default: 'system_prompt') */
  tlSystemPromptVariableName?: string
  /** Custom fetch implementation (optional) */
  customFetch?: typeof fetch
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class StandaloneTlClient {
  private endpoint: string
  private config: TlClientConfig
  private fetchFn: typeof fetch

  constructor(config: TlClientConfig) {
    if (!config.endpointAgent) {
      throw new Error('[TlClient] endpointAgent is required')
    }
    this.config = {
      tlSystemPromptVariableName: 'system_prompt',
      ...config,
    }
    // Normalize endpoint (strip trailing slashes, ensure protocol)
    const raw = config.endpointAgent.trim()
    const withProto = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
    this.endpoint = withProto.replace(/\/$/, '')
    this.fetchFn = config.customFetch ?? globalThis.fetch.bind(globalThis)
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 12)}`
  }

  /**
   * Step 1: Initialize a session with prompt variables (e.g. system prompt).
   */
  async initSession(systemPrompt: string, signal?: AbortSignal): Promise<string> {
    const url = `${this.endpoint}/chatbbc/init_session`
    const body = {
      appId: this.config.appId ?? '',
      trCode: this.config.trCode ?? '',
      trVersion: this.config.trVersion ?? '',
      timestamp: Date.now(),
      requestId: this.generateRequestId(),
      data: {
        prompt_variables: [
          {
            name: this.config.tlSystemPromptVariableName ?? 'system_prompt',
            value: systemPrompt,
          },
        ],
      },
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`[TlClient] Session init failed (HTTP ${res.status}): ${errText}`)
    }

    const data = await res.json()
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`[TlClient] Session init rejected: ${data.message || `code ${data.code}`}`)
    }

    const sessionId = data?.data?.session_id
    if (!sessionId) {
      throw new Error('[TlClient] Session init response missing data.session_id')
    }

    return sessionId
  }

  /**
   * Step 2: Stream chat response for the given session ID.
   */
  async *chatStream(
    sessionId: string,
    userText: string,
    signal?: AbortSignal
  ): AsyncGenerator<string, void, unknown> {
    const url = `${this.endpoint}/chatbbc/chat`
    const body = {
      appId: this.config.appId ?? '',
      trCode: this.config.trCode ?? '',
      trVersion: this.config.trVersion ?? '',
      timestamp: Date.now(),
      requestId: this.generateRequestId(),
      data: {
        session_id: sessionId,
        txt: userText,
        files: [{ file_id: '', url: '', content_type: '' }],
        stream: true,
      },
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`[TlClient] Chat request failed (HTTP ${res.status}): ${errText}`)
    }

    const reader = res.body?.getReader()
    if (!reader) {
      throw new Error('[TlClient] Response body is not readable')
    }

    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
        // Keep unfinished block in buffer
        buffer = blocks.pop() ?? ''

        for (const block of blocks) {
          if (!block.trim()) continue

          let eventType = 'message'
          const dataLines: string[] = []

          for (const line of block.split('\n')) {
            if (!line || line.startsWith(':')) continue
            const sep = line.indexOf(':')
            const field = sep === -1 ? line : line.slice(0, sep)
            let val = sep === -1 ? '' : line.slice(sep + 1)
            if (val.startsWith(' ')) val = val.slice(1)

            if (field === 'event') eventType = val
            if (field === 'data') dataLines.push(val)
          }

          const joinedData = dataLines.join('\n')
          if (joinedData === '[DONE]' || eventType === 'done' || eventType === 'end') {
            return
          }
          if (eventType === 'error') {
            throw new Error(`[TlClient] Stream error event: ${joinedData}`)
          }

          if (dataLines.length > 0) {
            try {
              const payload = JSON.parse(joinedData)
              if (typeof payload.content === 'string') {
                yield payload.content
              }
            } catch {
              // Ignore non-JSON comments or keep reading
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * High-level invocation: Combines initSession and chatStream to return the full response.
   */
  async invoke(
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal
  ): Promise<string> {
    const sessionId = await this.initSession(systemPrompt, signal)
    let fullText = ''
    for await (const chunk of this.chatStream(sessionId, userPrompt, signal)) {
      fullText += chunk
    }
    return fullText
  }
}
