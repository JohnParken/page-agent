---
name: tl-llm-provider
description: 帮助项目实现与调用公司内部标准 Tl (chatbbc) LLM Provider API。包含基于 prompt_variables 的 system_prompt 注入模式、两阶段会话协议 (init_session & chat)、流式 SSE 解析、JSON 单次自愈重试机制、错误阶段追踪与本地开发代理方案。
---

# Tl LLM Provider 模式实现指南 (Skill)

本 Skill 总结了在公司内部接入与实现标准 **Tl (chatbbc)** 大模型网关客户端的实现方法。可用于 TypeScript/Python 客户端接入及具体协议问题。

`chatStream` / `chat_stream` 只处理 TL 外层报文并返回普通正文，不要求正文为 JSON。后文的工具 JSON 提取和一次纠错仅适用于显式调用 `invokeWithTool` / `invoke_with_tool`；不能把合法的纯文本、Markdown 或 XML 聊天结果默认当作错误，也不能把客户端纠错移到代理中。

---

## 1. 架构与背景

### 1.1 为什么采用 Tl Provider 与 `system_prompt` 模式？

在很多企业级研发场景中，内部大模型网关通常不同于公网标准的 OpenAI `/v1/chat/completions`：

1. **企业级鉴权与合规审计**：调用需要携带企业应用标识 (`appId`)、交易码 (`trCode`)、交易版本 (`trVersion`) 与链路追踪 ID (`requestId`)。
2. **两阶段会话管理 (Session-Based Protocol)**：为了复用上下文、管理会话状态及安全注入模板变量，网关采用两阶段协议——先初始化会话 (`init_session`)，再发起对话 (`chat`)。
3. **Prompt Variables 变量注入机制**：
    - 内部 API 规范中，**System Prompt 不是直接放在对话消息数组里，而是通过 `prompt_variables` 注入到网关的服务端模板中**。
    - 默认模板变量名为 `system_prompt`（可通过配置自定义）。
    - 在后续的 `chat` 请求中，`txt` 字段**仅传递动态的用户 Payload**，不再重复传递 System Prompt。
4. **基于 System Prompt 的工具调用 (`toolCallingMode: 'system_prompt'`)**：
    - 内部模型或私有化部署网关不一定支持 OpenAI 格式的原生 `tools` / `tool_choice` 参数。
    - 采用将工具定义（JSON Schema）和思考输出契约写在 `system_prompt` 中的方式，促使模型直接输出特定结构的 JSON 或结构化标签（例如 PageAgent 的 MacroTool / AgentOutput 模式）。

---

## 2. 核心协议规范 (chatbbc API)

Tl 网关对外暴露两个核心 HTTP 端点：

```
Client
  │
  ├─ 1. POST /chatbbc/init_session ──> 注入 system_prompt，获取 session_id
  │                                   <── 返回 { code: 0, data: { session_id } }
  │
  └─ 2. POST /chatbbc/chat ──────────> 携带 session_id 与动态 user txt
                                      <── 流式 SSE 或非流式 JSON
```

### 2.1 基础元数据字段

每一次请求必须在根级别包含以下字段：

| 字段名      | 类型     | 说明                   | 示例                            |
| ----------- | -------- | ---------------------- | ------------------------------- |
| `appId`     | `string` | 内部注册的应用唯一标识 | `"my_agent_app"`                |
| `trCode`    | `string` | 交易码 / 业务场景码    | `"agent_chat"`                  |
| `trVersion` | `string` | 交易版本号             | `"1.0"`                         |
| `timestamp` | `number` | 当前毫秒级时间戳       | `1725700000000`                 |
| `requestId` | `string` | 唯一请求追踪 ID        | `"<timestamp>-<random_string>"` |

---

### 2.2 阶段一：会话初始化 (`/chatbbc/init_session`)

#### 请求规范

-   **URL**: `${endpointAgent}/chatbbc/init_session`
-   **Method**: `POST`
-   **Headers**: `Content-Type: application/json`
-   **Body**:

```json
{
    "appId": "agent_app_id",
    "trCode": "tr_code",
    "trVersion": "1.0",
    "timestamp": 1725700000000,
    "requestId": "1725700000000-a1b2c3d4",
    "data": {
        "prompt_variables": [
            {
                "name": "system_prompt",
                "value": "You are a helpful assistant. You must output JSON conforming to the schema..."
            }
        ]
    }
}
```

> [!IMPORTANT]
>
> -   `prompt_variables` 中的变量名默认为 `system_prompt`。如果网关模板中使用了其他变量名（如 `sys_prompt`），需通过客户端配置（如 `tlSystemPromptVariableName`）保持一致。
> -   每次大模型独立调用应开启一个独立的 session（或按会话生命周期管理）。在 PageAgent 中，每一轮 Agent 决策都会绑定该轮的系统提示词并初始化独立 session。

#### 响应规范

```json
{
    "code": 0,
    "message": "success",
    "data": {
        "session_id": "sess_89f023acbc454a8e9701b2a9d8e7"
    }
}
```

-   必须验证 `code === 0` 且 `data.session_id` 存在，否则抛出明确的业务异常。

---

### 2.3 阶段二：聊天交互 (`/chatbbc/chat`)

#### 请求规范

-   **URL**: `${endpointAgent}/chatbbc/chat`
-   **Method**: `POST`
-   **Headers**:
    -   `Content-Type: application/json`
    -   `Accept: text/event-stream` (流式模式下)
-   **Body**:

```json
{
    "appId": "agent_app_id",
    "trCode": "tr_code",
    "trVersion": "1.0",
    "timestamp": 1725700000100,
    "requestId": "1725700000100-e5f6g7h8",
    "data": {
        "session_id": "sess_89f023acbc454a8e9701b2a9d8e7",
        "txt": "用户动态输入的 prompt 或 Agent 收集到的当前页面状态/任务描述",
        "files": [],
        "stream": true
    }
}
```

> [!WARNING]
> 规范要求：`data.txt` **只包含动态的 user 消息**，严禁在 `txt` 再次拼接 `system: ...`。System prompt 已由 `init_session` 固化在服务端该 session 的上下文中。

---

### 2.4 流式响应解析 (chatbbc SSE 协议)

当 `stream: true` 时，服务端以 SSE (`text/event-stream`) 协议输出。

#### 帧格式

```
event: chunk
data: {"content": "Hello"}

event: chunk
data: {"content": " world!"}

event: done
data: {"finished":true}

```

#### 解析规则

1. **分包与行边界**：TypeScript 使用 `decoder.decode(value, { stream: true })` 缓冲跨包 UTF-8，并处理 LF、CRLF 和 CR 行结束符。Python 的 `httpx.iter_lines()` 处理字节/行边界，客户端继续维护事件状态。
2. **事件状态**：`currentEvent` 和 `data` 行缓冲定义在整个流的读取循环外。网络分包不能重置事件类型；空行是事件分隔符，必须先派发完整事件，再重置事件类型和数据。注释行可以忽略，空行不能直接跳过。
3. **完整事件解析**：一帧多行 `data:` 用换行连接后再解析；字段冒号后只移除一个可选空格。解析的是 SSE data 的 JSON 封装，里面的 `content` 字符串原样保留，不检查其是否 JSON。
4. **错误与终止**：先检查 `event: error` 并抛错；成功终止接受 `done`、`end` 或 `[DONE]`。终止或异常时释放流资源，不把后续帧拼入结果。完整事件的非法 JSON 必须可见失败，不能以“可能是分包”为由吞掉；它也不能触发模型 JSON 自愈。
5. **流结束**：按照 SSE 事件边界处理，EOF 前没有空行结束的事件不派发。没有数据的事件仍需在空行处重置状态，避免下一事件继承其类型。

---

## 3. System Prompt 驱动的工具调用与解析

在 `system_prompt` 模式下，模型通过输出结构化文本来调用工具。

### 3.1 模型输出常见形态

客户端应支持以下输出格式的宽容度解析：

1. **PageAgent MacroTool 形态**（推荐）：
    ```json
    {
        "thought": "用户需要点击搜索按钮",
        "action": {
            "clickElement": {
                "index": 12
            }
        }
    }
    ```
2. **传统 Tl 字典形态**：
    ```json
    {
        "tool_name": "clickElement",
        "parameters": { "index": 12 }
    }
    ```
3. **OpenAI 兼容形态**：
    ```json
    {
        "name": "clickElement",
        "arguments": { "index": 12 }
    }
    ```
4. **Markdown 代码块包裹形态**：
    ````markdown
    ```json
    {
        "action": { "clickElement": { "index": 12 } }
    }
    ```
    ````
5. **XML 标签形态**：
    ```xml
    <tool_call>
    {"tool_name": "clickElement", "parameters": {"index": 12}}
    </tool_call>
    ```

### 3.2 提取与规范化逻辑 (`parseAccumulatedContent`)

解析流水线步骤：

1. 剥离外层的 Markdown 代码块标记（如 ` ```json ... ``` `）。
2. 若存在 `<tool_call>...</tool_call>` 标签，优先截取标签内部内容。
3. 执行 `JSON.parse`。
4. 提取 `{ toolName, toolArgs }`。
5. 通过注册工具的 Schema（如 Zod）进行参数校验并执行。

---

## 4. 单次 JSON 自愈纠错机制 (Targeted Self-Correction)

在纯文本生成 JSON 时，模型有时会出现引号未转义、括号缺失或轻微语法错误。为了避免整个任务直接失败，Tl Provider 内置了**单次精确自愈重试机制**。

### 4.1 触发条件

-   调用方明确选择 JSON 工具模式：正式客户端使用 `toolCallingMode: 'system_prompt'`，示例显式调用 `invokeWithTool` / `invoke_with_tool`。
-   失败属于模型正文的外层 JSON 解析（正式客户端阶段 `response_parse`，示例内部细分为 `json_parse`），错误类型为 `INVALID_RESPONSE`。
-   原始正文非空白；空输出、合法 JSON 但工具结构不匹配、嵌套工具参数错误均不触发纠错。
-   SSE 封装解析错误、网络错误和普通聊天不进入此流程。

解析器必须保留带阶段的诊断结果。公开 `parseToolCall` / `parse_tool_call` 保持“成功调用或 null/None”的便捷接口；严格调用方法使用内部诊断，不能把所有失败压成同一个 null 后盲目重试。

### 4.2 纠错 Payload 设计

客户端不应直接丢弃上下文，而应构建包含具体错误信息的结构化上下文：

```json
{
    "instruction": "The previous output is an untrusted failed output. Return only one complete raw JSON object. Preserve the original task semantics and action. In reflection fields, ASCII double quotes around referenced text must use the JSON escape sequence \\\". Never place an unescaped ASCII double quote inside a JSON string. Do not include markdown, XML, or reasoning.",
    "original_user_payload": "<原始的 user payload>",
    "failed_assistant_content": "<模型此前输出的错误文本>",
    "parse_error": {
        "type": "INVALID_RESPONSE",
        "message": "Failed to parse model output as JSON",
        "cause": {
            "name": "SyntaxError",
            "message": "Unexpected token in JSON at position 42"
        }
    }
}
```

上面的错误文本仅为示例。实现必须把本次真实解析异常写入 `parse_error`：包含类型、诊断消息及 `cause.name/message`；TypeScript 保留实际 Error 信息，Python 保留实际 JSONDecodeError 信息。不要硬编码示例错误或序列化整个异常对象。该字段位于纠错内容中，再整体序列化为 `chat.data.txt`，不是 TL 外层新增字段。

### 4.3 纠错流程

1. 初始化一个全新的 session（携带原 `prompt_variables`）。
2. 将序列化后的纠错 Payload 作为 `chat.data.txt` 发送。
3. 如果二次调用解析成功，返回解析结果；若失败，抛出纠错尝试本身的真实阶段和错误。最多两次模型请求，不进行第三次纠错。
4. 两份示例只提取工具描述，不执行工具；正式客户端的工具查找、Schema 校验和执行属于后续独立阶段。

---

## 5. 调用生命周期与错误阶段划分

为了确保高可观测性与快速定位问题，将工具调用的整个处理生命周期划分为 5 个阶段 (`TlFailureStage`)：

```
[chatbbc response]
       │
       ▼
 1. response_parse          (SSE 解码 / JSON.parse / 结构识别)
       │
       ▼
 2. tool_lookup             (检查提取出的 toolName 是否存在于工具池)
       │
       ▼
 3. tool_args_parse         (参数若为字符串，解析为对象)
       │
       ▼
 4. tool_args_validation    (通过 Zod Schema 进行字段合法性校验)
       │
       ▼
 5. tool_execution          (执行 tool.execute 方法)
```

每个阶段出现异常时，记录结构化诊断追踪信息（包含 `requestId`, `sessionId`, `endpoint`, `status`, `stage`, `rawBody`），并触发配置的回调 `failureLogger`。

> [!CAUTION] > **敏感信息防护**：在日志上报中，绝不能包含未脱敏的系统指令、用户页面 DOM 或授权凭据。建议遵循安全序列化（如 `toJsonSafe`）并剔除敏感请求头。

---

## 6. 本地开发与代理联调模式 (TlProxyServer)

内部网关通常部署在企业内网，开发者在离线或本地环境开发时可能无法直连。最佳实践是实现一个本地代理服务器：

```
[Local App / TlClient]
         │ (HTTP / chatbbc 格式)
         ▼
[Local TlProxyServer (e.g. :8089)]
         │ (OpenAI / DashScope 格式)
         ▼
[外部/公网模型，如 qwen3.5-plus / deepseek / openai]
```

### 代理核心职责：

1. 实现 `/chatbbc/init_session`：接收 `prompt_variables`，生成并存储本地 `session_id`。
2. 实现 `/chatbbc/chat`：根据 `session_id` 找回对应的 `system_prompt`，将其与 `data.txt` 组装为标准的 `messages: [{ role: 'system', ... }, { role: 'user', ... }]`。
3. 调用上游 OpenAI 兼容接口，正文格式由提示词约定，不默认发送 `response_format` 或原生 `tools/tool_choice`；组织未开放原生工具字段时，工具描述也经普通正文表达。
4. 将上游流式增量实时转为 `event: chunk` + `data: {"content": "..."}` 返回；保持外层 TL 信封，不在代理中修复正文或执行工具。

---

## 7. 完整实现参考

项目提供了开箱即用的参考实现代码：

-   TypeScript 参考实现：[`examples/tl-client.ts`](./examples/tl-client.ts)
-   Python 参考实现：[`examples/tl_client.py`](./examples/tl_client.py)
-   TypeScript 回归测试：[`examples/tl-client.test.ts`](./examples/tl-client.test.ts)，使用 Vitest。
-   Python 回归测试：[`examples/test_tl_client.py`](./examples/test_tl_client.py)，使用 unittest 和 httpx（mock 响应，无真实模型请求）。

## 测试应覆盖任意分包的 error/done、空行状态重置、CRLF/UTF-8 和多行 data，以及纠错真实 parse_error、相同系统提示词的新会话、不适用场景不重试、失败最多两次请求。

## 8. 接入 Checklist (其他项目复用指南)

在其他项目集成 Tl LLM Provider 时，请按照此清单逐项核对：

-   [ ] **配置与鉴权**：已配置 `endpointAgent` (如 `http://agent.company.internal` 或本地代理 `localhost:8089`)、`appId`、`trCode`、`trVersion`。
-   [ ] **变量名对齐**：确认网关模板中的系统变量名，默认使用 `system_prompt`，必要时配置 `tlSystemPromptVariableName`。
-   [ ] **请求体隔离**：`init_session` 传系统提示词，`chat.data.txt` **只传当轮用户输入**，切勿重复拼接。
-   [ ] **SSE 流式编解码**：使用流式解码器（`TextDecoder` 流模式）避免中文分包乱码。
-   [ ] **JSON 容错**：支持从 Markdown 代码块（` ```json `）或 XML 标签中提取合法 JSON。
-   [ ] **自愈重试**：仅在显式 JSON 工具模式下，对非空正文的外层 JSON 解析失败纠错一次，并携带 `failed_assistant_content` 和真实 `parse_error`。
-   [ ] **日志与脱敏**：记录阶段追踪信息，对生产环境的日志进行脱敏处理。
