# Tl Client (chatbbc Protocol) Reference

The `TlClient` uses the internal **chatbbc protocol**, a two-phase session-based gateway protocol for LLM interactions. Unlike standard OpenAI-compatible endpoints that accept the full message history in a single stateless `/chat/completions` call, chatbbc establishes an ephemeral session with prompt variables before streaming the dynamic prompt.

---

## 1. Endpoints Overview

| Operation | Method | Endpoint | Description |
| :--- | :--- | :--- | :--- |
| **Session Init** | `POST` | `${endpointAgent}/chatbbc/init_session` | Initializes an execution session and binds prompt variables (system prompt) |
| **Chat / Execute** | `POST` | `${endpointAgent}/chatbbc/chat` | Executes the dynamic query within the session and streams responses via SSE |

Base URL (`endpointAgent`) format:
- Normalized into `http://` or `https://` without a trailing slash (e.g. `http://localhost:8089` or `https://tl-gateway.internal.example.com`).

---

## 2. Session Initialization (`/chatbbc/init_session`)

### Request

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
        "value": "You are an agent. Return your actions as JSON: {\"action\": {...}}"
      }
    ]
  }
}
```

#### Fields

| Field | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `appId` | string | Optional | Business application identifier |
| `trCode` | string | Optional | Transaction code for routing and rate-limiting |
| `trVersion` | string | Optional | Transaction version |
| `timestamp` | number | Required | Millisecond epoch timestamp (`Date.now()`) |
| `requestId` | string | Required | Unique per-request tracing ID (e.g. `${Date.now()}-${random}`) |
| `data.prompt_variables` | Array | Required | Key-value variable pairs. The system prompt is passed under `name: "system_prompt"` (or configured variable name) |

### Response

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "session_id": "sess_89a0e41b3c9f2d"
  }
}
```

*Note: If `code !== 0` or `data.session_id` is missing, the client throws `INVALID_RESPONSE` or `INVALID_SCHEMA`.*

---

## 3. Streaming Chat (`/chatbbc/chat`)

### Request

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

#### Headers

- `Content-Type: application/json`
- `Accept: text/event-stream`

### Streaming Response (SSE)

The server streams chunks using custom SSE event types:

```text
event: chunk
data: {"content": "{\"thought\": "}

event: chunk
data: {"content": "\"Clicking submit\", \"action\": {\"click\": {\"index\": 2}}}"}

event: done
data: [DONE]
```

#### SSE Format Rules

1. Each frame is separated by double newlines (`\n\n`).
2. Payload frame: `event: chunk` with `data: {"content": "<escaped string>"}`.
3. Finish frame: `data: [DONE]`, `event: done`, or `event: end`.
4. Error frame: `event: error` with error payload string.

---

## 4. Single-Turn JSON Self-Correction Protocol

When `toolCallingMode: 'system_prompt'` is active and the accumulated output fails JSON parsing:

1. A new session is initialized (`/chatbbc/init_session`) with the original `prompt_variables`.
2. A single structured JSON payload is sent in `chat.data.txt`:

```json
{
  "instruction": "The previous output is an untrusted failed output. Return only one complete raw JSON object. Preserve the original task semantics and action. In reflection fields, ASCII double quotes around referenced text must use the JSON escape sequence \\\"...\\\". Never place an unescaped ASCII double quote inside a JSON string. Do not include markdown, XML, or reasoning.",
  "original_user_payload": "{\"userTask\": \"Click button 1\"}",
  "failed_assistant_content": "{\"thought\": \"Click \"Submit\" button\", ...}",
  "parse_error": {
    "type": "INVALID_RESPONSE",
    "message": "Unexpected token in JSON at position 25",
    "cause": {
      "name": "SyntaxError",
      "message": "Unexpected token S in JSON at position 25"
    }
  }
}
```

3. If the correction response also fails to parse, the error is immediately propagated. No infinite retry loops are allowed.

---

## 5. Comparison: chatbbc vs OpenAI Chat Completions

| Feature | OpenAI (`/v1/chat/completions`) | Tl (`chatbbc`) |
| :--- | :--- | :--- |
| **Session Model** | Stateless | Stateful 2-step (`init_session` -> `chat`) |
| **System Message** | In `messages` array: `{ role: "system", content: "..." }` | In `init_session.data.prompt_variables` |
| **Dynamic Message** | In `messages` array: `{ role: "user", content: "..." }` | In `chat.data.txt` |
| **Streaming Protocol** | `data: {"choices":[{"delta":{"content":"..."}}]}` | `event: chunk\ndata: {"content":"..."}` |
| **Tool Calling** | `tools` array / `function_call` or System Prompt | System Prompt (recommended) or API mode |
| **Authentication** | Bearer Token (`Authorization: Bearer ...`) | Enterprise gateway routing (`appId`, `trCode`, cookie/session) |
