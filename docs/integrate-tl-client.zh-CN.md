# Tl Client (chatbbc 协议) 大模型提供商集成指南

`TlClient` 是内部基于 **chatbbc 协议** 的大模型专属对接方式（类似于 `OpenAIClient` / `openclient`，但具备两阶段会话初始化与提示词变量注入特性）。

本文档整合了 `integrate-tl-client` Skill 的全部指引、协议规范与代码实现，便于后续项目快速接入 Tl Client 作为 LLM Provider。

---

## 1. 核心设计与心智模型对比

| 维度 | OpenAI Client (`/v1/chat/completions`) | Tl Client (`chatbbc` 协议) |
| :--- | :--- | :--- |
| **请求模式** | 单步无状态请求 | 两阶段有状态握手：`init_session` $\to$ `chat` |
| **System 提示词** | 放在 `messages: [{ role: "system", content }]` | 绑定在 `init_session.data.prompt_variables`（默认变量名为 `system_prompt`） |
| **动态 User 输入** | 放在 `messages: [{ role: "user", content }]` | 通过 `chat.data.txt` 携带 `session_id` 发送 |
| **流式返回格式 (SSE)** | `data: {"choices":[{"delta":{"content":...}}]}` | `event: chunk\ndata: {"content": "..."}\n\n`，以 `[DONE]` 结束 |
| **工具调用 (Tool Calling)** | 原生 Function Calling 或提示词引导 | 推荐 `system_prompt` 模式（输出严格结构化 JSON）或 `api` 模式 |
| **鉴权方式** | 请求头 `Authorization: Bearer <token>` | 企业网关透传鉴权 / Cookie / `appId` 与 `trCode` |

---

## 2. 协议规范 (chatbbc Protocol)

### (1) 端点总览

| 接口 | 方法 | 路径 | 作用 |
| :--- | :--- | :--- | :--- |
| **会话初始化** | `POST` | `${endpointAgent}/chatbbc/init_session` | 创建执行会话，绑定 system prompt 等变量 |
| **聊天与执行** | `POST` | `${endpointAgent}/chatbbc/chat` | 传入用户动态输入与 `session_id`，以 SSE 格式流式输出 |

### (2) 会话初始化 (`/chatbbc/init_session`)

#### 请求体示例

```json
{
  "appId": "my-app",
  "trCode": "my-transaction",
  "trVersion": "1.0",
  "timestamp": 1725700000000,
  "requestId": "1725700000000-k8f2a1b9",
  "data": {
    "prompt_variables": [
      {
        "name": "system_prompt",
        "value": "You are a helpful AI assistant. Return your actions as JSON: {\"action\": {...}}"
      }
    ]
  }
}
```

#### 响应体示例

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "session_id": "sess_89a0e41b3c9f2d"
  }
}
```

*注意：若 `code !== 0` 或 `data.session_id` 缺失，客户端应抛出解析/结构异常。*

### (3) 流式调用 (`/chatbbc/chat`)

#### 请求体示例

```json
{
  "appId": "my-app",
  "trCode": "my-transaction",
  "trVersion": "1.0",
  "timestamp": 1725700005000,
  "requestId": "1725700005000-m3x9z4q1",
  "data": {
    "session_id": "sess_89a0e41b3c9f2d",
    "txt": "{\"userTask\": \"Click button 1\"}",
    "files": [
      {
        "file_id": "",
        "url": "",
        "content_type": ""
      }
    ],
    "stream": true
  }
}
```

请求头需包含：
- `Content-Type: application/json`
- `Accept: text/event-stream`

#### SSE 流响应格式

服务器使用自定义事件块（每个块由双换行 `\n\n` 分隔）：

```text
event: chunk
data: {"content": "{\"thought\": "}

event: chunk
data: {"content": "\"Clicking submit\", \"action\": {\"click\": {\"index\": 2}}}"}

event: done
data: [DONE]
```

- 数据帧：`event: chunk`，数据为 `data: {"content": "<内容字符串>"}`。
- 结束帧：`data: [DONE]`、`event: done` 或 `event: end`。
- 异常帧：`event: error`。

---

## 3. 配置参数说明

| 配置项 | 类型 | 必填 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `endpointAgent` | string | 是 | - | Tl 网关地址，如 `http://localhost:8089` 或 `https://tl.example.com` |
| `model` | string | 是 | - | 模型标识符（供上层消费接口/网关路由使用） |
| `appId` | string | 否 | `""` | 业务应用标识 |
| `trCode` | string | 否 | `""` | 交易代码 |
| `trVersion` | string | 否 | `""` | 交易版本 |
| `tlSystemPromptVariableName` | string | 否 | `"system_prompt"` | `init_session` 中携带系统提示词的变量名 |
| `toolCallingMode` | `'system_prompt' \| 'api'` | 否 | `'system_prompt'` | 工具调用模式 |
| `customFetch` | `fetch` | 否 | `globalThis.fetch` | 自定义 fetch 实现 |

---

## 4. 接入方式与实战代码

### 场景 A：在 PageAgent 项目中直接接入

```typescript
import { PageAgent } from 'page-agent'

const agent = new PageAgent({
  provider: 'tl',
  endpointAgent: 'https://tl-gateway.example.com',
  model: 'my-production-model',
  appId: 'my-app',
  trCode: 'my-tr-code',
  tlSystemPromptVariableName: 'system_prompt',
  toolCallingMode: 'system_prompt',
})

await agent.execute('帮我查询近一个月的订单')
```

### 场景 B：在其它新项目中独立接入 (零外部依赖实现)

若新项目不需要引入整个 PageAgent，可以直接使用以下纯原生 TypeScript 封装：

```typescript
export interface TlClientConfig {
  endpointAgent: string
  model: string
  appId?: string
  trCode?: string
  trVersion?: string
  tlSystemPromptVariableName?: string
  customFetch?: typeof fetch
}

export class StandaloneTlClient {
  private endpoint: string
  private config: TlClientConfig
  private fetchFn: typeof fetch

  constructor(config: TlClientConfig) {
    if (!config.endpointAgent) throw new Error('[TlClient] endpointAgent is required')
    this.config = { tlSystemPromptVariableName: 'system_prompt', ...config }
    const raw = config.endpointAgent.trim()
    const withProto = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`
    this.endpoint = withProto.replace(/\/$/, '')
    this.fetchFn = config.customFetch ?? globalThis.fetch.bind(globalThis)
  }

  private generateRequestId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 12)}`
  }

  /** 初始化会话并注入 prompt_variables */
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
    if (!sessionId) throw new Error('[TlClient] Session init missing session_id')
    return sessionId
  }

  /** 发起聊天请求并流式迭代内容 */
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
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`[TlClient] Chat request failed (HTTP ${res.status}): ${errText}`)
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('[TlClient] Response body is not readable')
    const decoder = new TextDecoder()
    let buffer = ''

    try {
      while (true) {
        signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split('\n\n')
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
          if (joinedData === '[DONE]' || eventType === 'done' || eventType === 'end') return
          if (eventType === 'error') throw new Error(`[TlClient] Stream error: ${joinedData}`)

          if (dataLines.length > 0) {
            try {
              const payload = JSON.parse(joinedData)
              if (typeof payload.content === 'string') yield payload.content
            } catch {
              // 忽略非 JSON 帧
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** 一键完整调用 */
  async invoke(systemPrompt: string, userPrompt: string, signal?: AbortSignal): Promise<string> {
    const sessionId = await this.initSession(systemPrompt, signal)
    let fullText = ''
    for await (const chunk of this.chatStream(sessionId, userPrompt, signal)) {
      fullText += chunk
    }
    return fullText
  }
}
```

---

## 5. 本地联调：TlProxyServer

在没有真实 Tl 网关环境时，可以使用仓库内置的 `TlProxyServer` 进行开发与测试：

```bash
cd packages/llms
npm run start:tl-proxy
```

- 代理默认监听在 `http://localhost:8089`。
- 它接收标准 `chatbbc` 请求，自动转成 OpenAI/Qwen 格式请求后端模型，再转换为标准 `event: chunk` SSE 格式输出。
- 测试时直接将 `endpointAgent` 设置为 `http://localhost:8089` 即可。

---

## 6. 容错机制：单轮反馈式 JSON 纠错

当处于 `toolCallingMode: 'system_prompt'` 模式且模型输出的 JSON 解析失败时：
1. 客户端自动开启一个**全新的 session**（保证上下文纯净）。
2. 在 `chat.data.txt` 中发送结构化的纠错信息：
   ```json
   {
     "instruction": "The previous output is an untrusted failed output. Return only one complete raw JSON object...",
     "original_user_payload": "...",
     "failed_assistant_content": "...",
     "parse_error": { ... }
   }
   ```
3. 若纠错仍失败，则严格抛出异常，杜绝无限重试循环。

---

## 7. 安全与跨域规范

1. **CORS 配置**：若通过前端（如 Bookmarklet / Web 应用）直接请求 Tl 网关，网关必须支持目标 Origin 并在预检请求（OPTIONS）中返回允许的 Header。
2. **混合内容（Mixed Content）**：在 HTTPS 网页上使用时，`endpointAgent` 必须是 HTTPS，否则会被浏览器直接拦截。
3. **禁止前端暴露敏感凭据**：严禁在前端包或 `appId` 中硬编码长期密钥；权限校验与配额控制应放在受信任的网关服务端。
