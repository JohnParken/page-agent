---
name: integrate-tl-client
description: 'Integrate, configure, or troubleshoot the internal Tl Client (chatbbc protocol) LLM provider. Use when connecting projects to the internal Tl AI gateway, configuring provider: "tl", implementing a Tl-compatible LLM client, or running the local Tl proxy server.'
---

# Integrate Tl Client (chatbbc Protocol)

`TlClient` is an internal enterprise LLM integration method based on the **chatbbc protocol** (analogous to `OpenAIClient`, but with distinct session initialization and variable binding semantics).

Detailed protocol specifications and code references:
- Detailed API schemas: [references/protocol.md](./references/protocol.md)
- Reusable TypeScript client: [examples/standalone-client.ts](./examples/standalone-client.ts)
- Dev proxy documentation: [packages/llms/src/dev-tools/TlProxy_README.md](../../packages/llms/src/dev-tools/TlProxy_README.md)

---

## 1. Core Mental Model: Tl Client vs OpenAI Client

| Aspect | OpenAI / openclient | Tl Client (`chatbbc`) |
| :--- | :--- | :--- |
| **Call Pattern** | 1-step stateless: `POST /v1/chat/completions` | 2-step stateful: `init_session` -> `chat` |
| **System Prompt** | Passed in `messages: [{ role: "system", content }]` | Injected into `init_session.data.prompt_variables` |
| **Dynamic Payload** | Passed in `messages: [{ role: "user", content }]` | Sent in `chat.data.txt` with `session_id` |
| **Streaming Wire Format** | `data: {"choices":[{"delta":...}]}` | `event: chunk\ndata: {"content": "..."}\n\n` |
| **Tool Calling** | Native function calling or prompt-guided | Prompt-guided (`system_prompt` mode, recommended) or API mode |
| **Credentials** | API Key (`Bearer ...`) in client request headers | Handled by enterprise gateway / cookies (`appId`, `trCode`) |

---

## 2. Configuration Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `endpointAgent` | string | *(Required)* | Gateway URL, e.g. `http://localhost:8089` or `https://tl.example.com` |
| `model` | string | *(Required)* | Model identifier (used by agent interface / gateway routing) |
| `appId` | string | `""` | Enterprise application identifier |
| `trCode` | string | `""` | Transaction code |
| `trVersion` | string | `""` | Transaction version |
| `tlSystemPromptVariableName` | string | `"system_prompt"` | Variable name for system prompt in `init_session` |
| `toolCallingMode` | `'system_prompt' \| 'api'` | `'system_prompt'` | Tool calling strategy |
| `customFetch` | `fetch` | `globalThis.fetch` | Custom fetch wrapper (e.g. for Node.js or proxies) |

---

## 3. Usage Workflows

### Workflow A: Using Tl in PageAgent

Configure `provider: 'tl'` in `PageAgentConfig`:

```typescript
import { PageAgent } from 'page-agent'

const agent = new PageAgent({
  provider: 'tl',
  endpointAgent: process.env.LLM_ENDPOINT_AGENT || 'http://localhost:8089',
  model: process.env.LLM_MODEL_NAME || 'qwen3.5-plus',
  appId: process.env.LLM_APP_ID,
  trCode: process.env.LLM_TR_CODE,
  trVersion: process.env.LLM_TR_VERSION,
  tlSystemPromptVariableName: 'system_prompt',
  toolCallingMode: 'system_prompt',
})
```

For production bookmarklet builds, environment variables are baked into `.env.production` and built with `npm run build:bookmarklet -w page-agent`.

---

### Workflow B: Integrating Tl Client into New / Other Projects

When connecting another internal project or standalone service to the Tl gateway without dragging in full `PageAgent` dependencies:

1. Copy the reference implementation from [examples/standalone-client.ts](./examples/standalone-client.ts).
2. Instantiate `StandaloneTlClient`:
   ```typescript
   import { StandaloneTlClient } from './standalone-client'

   const client = new StandaloneTlClient({
     endpointAgent: 'https://tl-gateway.example.com',
     model: 'my-model',
     appId: 'my-app',
     tlSystemPromptVariableName: 'system_prompt',
   })

   // Single-turn invocation
   const response = await client.invoke(
     'You are a helpful assistant.',
     'Hello! What can you do?'
   )
   ```
3. Or stream chunks directly:
   ```typescript
   const sessionId = await client.initSession(systemPrompt)
   for await (const chunk of client.chatStream(sessionId, userMessage)) {
     process.stdout.write(chunk)
   }
   ```

---

### Workflow C: Local Development with `TlProxyServer`

To test TlClient integrations locally without connecting to production enterprise gateways:

1. Start the local proxy:
   ```bash
   cd packages/llms
   npm run start:tl-proxy
   ```
2. The proxy binds to `http://localhost:8089` by default, translates `chatbbc` calls to Qwen/OpenAI format, and emits compliant `event: chunk` SSE responses.
3. Configure your project with `endpointAgent: "http://localhost:8089"`.

---

## 4. Key Implementation Rules & Error Recovery

1. **Prompt Variable Binding**:
   - The system prompt **must** be sent via `init_session` under `prompt_variables: [{ name: tlSystemPromptVariableName, value }]`.
   - The user payload is sent in `chat.data.txt`.
2. **Single-Turn JSON Self-Correction**:
   - If the model returns malformed JSON under `toolCallingMode: 'system_prompt'`, `TlClient` triggers **one** structured correction request using a new session.
   - If the correction also fails, the error is strictly raised (`INVALID_RESPONSE`). Never retry infinitely.
3. **CORS & Mixed Content**:
   - If called from browser environments (bookmarklet / web app), the gateway must return appropriate CORS headers (`Access-Control-Allow-Origin: *` or allowed origins).
   - An HTTPS web page will block HTTP gateway endpoints as mixed content. Use HTTPS in production.
4. **No Secrets in Frontend Bundles**:
   - Never place secret tokens or long-lived keys in client-side bundles or `appId` fields. Authentication must be handled server-side or by gateway session tickets.
