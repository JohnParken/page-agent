# DsProxyServer - DeepSeek 开发代理

`DsProxyServer` 是仅用于开发和测试的本地代理。它接收 `DsAiClient` 的
`chatbbc` 请求，再转换为 DeepSeek 原生的 OpenAI-compatible
`/chat/completions` 请求，并把 JSON Output 转回 DsClient 可以解析的响应。

## 快速开始

在 `packages/llms` 目录启动代理：

```bash
DEEPSEEK_API_KEY=sk-... npm run start:ds-proxy
```

默认监听 `http://127.0.0.1:8090`，使用 `deepseek-chat` 和
`https://api.deepseek.com`。也可以显式配置：

```bash
DS_PROXY_PORT=8090 \
DS_PROXY_HOST=127.0.0.1 \
DEEPSEEK_BASE_URL=https://api.deepseek.com \
DEEPSEEK_MODEL=deepseek-chat \
DEEPSEEK_MAX_TOKENS=4096 \
DEEPSEEK_API_KEY=sk-... \
npm run start:ds-proxy
```

在另一个终端运行本地 smoke test：

```bash
npm run test:ds-proxy
```

测试脚本只访问本地代理；API key 留在代理进程中，不需要也不应该放入
浏览器的 `DsAiClient` 配置。使用其他地址时设置 `DS_PROXY_URL`：

```bash
DS_PROXY_URL=http://127.0.0.1:8091 npm run test:ds-proxy
```

## DsAiClient 配置

使用本地代理时，浏览器端只需要配置代理地址和模型名，不携带 DeepSeek
密钥：

```typescript
const client = new DsAiClient({
    endpointAgent: '127.0.0.1:8090',
    model: 'deepseek-chat',
    toolCallingMode: 'system_prompt',
})
```

如果服务端代码直接调用 DeepSeek 原生 API，可以使用 API 模式；该模式的
`apiKey` 只能留在受信任的服务端，不能放入浏览器 bundle：

```typescript
const client = new DsAiClient({
    baseURL: 'https://api.deepseek.com',
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat',
    toolCallingMode: 'system_prompt',
})
```

## 协议转换

```text
DsAiClient
    │ POST /chatbbc/init_session
    │ POST /chatbbc/chat (data.txt, stream)
    ▼
DsProxyServer (127.0.0.1:8090)
    │ POST /chat/completions
    │ Authorization: Bearer <DEEPSEEK_API_KEY>
    │ response_format: { type: "json_object" }
    ▼
DeepSeek API
```

代理为每个 `init_session` 请求生成一个本地 session ID，并保存该请求
`data.prompt_variables` 中 `name: "name"` 的模型值；同一 session 的 chat
会优先使用这个模型，未找到模型时才回退到 `DEEPSEEK_MODEL`。`chatbbc` 文本中的
`system:`, `user:`, `assistant:` 和 `tool:` 行首标记会转换为原生消息。
上游请求固定使用 `stream: false`，以便代理在收到完整 JSON 后根据客户端的
`stream` 字段返回：

-   `stream: true`：`event: chunk` 数据帧，最后是 `event: done`；
-   `stream: false`：`{ code: 0, data: { txt: "..." } }`。

## DeepSeek JSON Output

代理始终发送：

```json
{
    "response_format": { "type": "json_object" },
    "stream": false,
    "max_tokens": 4096
}
```

DeepSeek 要求 system 或 user prompt 中包含 `json` 字样，并提供期望格式的
示例。DsClient 的 system prompt 通常已经满足此条件；若代理收到的请求完全
没有 JSON 指令，代理会向 system message 补充一个最小 JSON 示例。DeepSeek
也提示 JSON Output 可能返回空 `content`，此时代理会返回错误而不是生成一个
不可解析的成功响应。

## 环境变量

| 变量                  | 默认值                     | 说明                                               |
| --------------------- | -------------------------- | -------------------------------------------------- |
| `DS_PROXY_PORT`       | `8090`                     | 代理监听端口；测试可用 `0`（代码 API）选择随机端口 |
| `DS_PROXY_HOST`       | `127.0.0.1`                | 绑定地址；默认只暴露本机                           |
| `DEEPSEEK_BASE_URL`   | `https://api.deepseek.com` | DeepSeek-compatible API 根地址                     |
| `DEEPSEEK_MODEL`      | `deepseek-chat`            | 上游模型名称                                       |
| `DEEPSEEK_MAX_TOKENS` | `4096`                     | 上游 `max_tokens`                                  |
| `DEEPSEEK_API_KEY`    | 空                         | 代理进程使用的 Bearer key；不要放到前端            |
| `DS_PROXY_LOG_LEVEL`  | `info`                     | `debug` / `info` / `warn` / `error`                |
| `DS_PROXY_LOG_SILENT` | `0`                        | 设置为 `1` 时只写日志文件，不输出控制台            |
| `DS_PROXY_URL`        | `http://127.0.0.1:8090`    | smoke test 使用的代理地址                          |

## 日志与安全

日志复用 `FileLogger`，默认写入：

```text
packages/llms/logs/dsproxy/dsproxy-YYYY-MM-DD.log
```

代理只适合本地开发验证，不能替代生产网关。不要把
`DEEPSEEK_API_KEY` 写入提交内容、`.env`（若会被打包）或页面脚本；如需让
浏览器访问远程服务，应在受信任的后端部署具备认证和限流的网关。
