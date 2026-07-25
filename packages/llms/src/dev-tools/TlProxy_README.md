# TlProxyServer - Tl AI 代理服务器

这个代理服务器模拟 Tl AI 的 chatbbc API，实际后端调用免费的 qwen3.5-plus API，用于测试和验证 TlAiClient。

## 功能特性

- ✅ 模拟 `/chatbbc/init_session` 端点初始化会话
- ✅ 模拟 `/chatbbc/chat` 端点处理聊天请求
- ✅ 将 TlClient 的请求转发给 qwen3.5-plus API
- ✅ 支持流式和非流式响应
- ✅ 自动处理工具调用响应格式转换

## 快速开始

### 1. 安装 tsx（如果还没有）

```bash
npm install -g tsx
```

### 2. 启动代理服务器

```bash
cd packages/llms
tsx src/TlProxyServer.ts
```

或者使用环境变量配置：

```bash
PROXY_PORT=8089 \
QWEN_BASE_URL=https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run \
QWEN_MODEL=qwen3.5-plus \
tsx src/TlProxyServer.ts
```

### 3. 在 TlAiClient 中使用代理

将 `endpointAgent` 设置为代理服务器地址：

```typescript
import { TlAiClient } from '@page-agent/llms'

const client = new TlAiClient({
    endpointAgent: 'localhost:8089', // 使用代理
    model: 'test-model',
    appId: 'test-app',
    trCode: 'test-code',
    trVersion: '1.0',
    // ... 其他配置
})
```

### 4. 在浏览器扩展中使用

在 ConfigPanel 中：

1. 将 Provider 设置为 "Tl AI"
2. 将 Endpoint Agent 设置为 `localhost:8089`
3. 保存配置

## 架构说明

```
TlClient → TlProxyServer (localhost:8089) → qwen3.5-plus API
              ↓
        模拟 chatbbc 协议
              ↓
        转换为 OpenAI 格式
              ↓
        调用 qwen API
              ↓
        转换回 chatbbc 格式
```

## 环境变量

| 变量                  | 默认值                                                   | 说明                                          |
| --------------------- | -------------------------------------------------------- | --------------------------------------------- |
| `PROXY_PORT`          | 8089                                                     | 代理服务器监听端口                            |
| `QWEN_BASE_URL`       | https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run | 后端 qwen API 地址                            |
| `QWEN_MODEL`          | qwen3.5-plus                                             | 使用的模型名称                                |
| `TL_PROXY_LOG_LEVEL`  | `info`                                                   | 日志级别：`debug` / `info` / `warn` / `error` |
| `TL_PROXY_LOG_SILENT` | `0`                                                      | 设为 `1` 时只写文件、不打印到控制台           |

## 日志持久化

所有访问记录、错误信息、系统状态都会同步写入本地日志文件，应用重启后历史日志仍可查阅。

### 存储路径

```
<仓库根>/packages/llms/logs/tlproxy/
```

绝对路径示例（取决于本机仓库位置）：

```
/Users/yangxuezhen/git/page-agent/packages/llms/logs/tlproxy/
```

### 文件命名

- 活动日志：`tlproxy-YYYY-MM-DD.log`（按本地日期切分）
- 轮转归档：`tlproxy-YYYY-MM-DD-001.log`、`tlproxy-YYYY-MM-DD-002.log` …

### 轮转策略

- **按大小轮转**：单文件超过 **10 MB** 时自动重命名为 `-NNN.log` 并新建活动文件。
- **按天轮转**：跨过本地零点后再次写入时自动切到新一天的 `tlproxy-YYYY-MM-DD.log`。
- **保留上限**：每个日期下最多保留 **30** 个归档文件，超出后最旧的会被自动删除。

### 日志格式

```
2026-07-25T08:30:11.123Z [INFO] [TlProxy] 📥 CHAT Request {"sessionId":"session_...","stream":true,"textLength":1024}
2026-07-25T08:30:11.456Z [ERROR] [TlProxy] Qwen API error body {"error":"rate limit exceeded"}
```

每行包含：UTC ISO 时间戳、日志级别（`DEBUG/INFO/WARN/ERROR`）、模块名（`TlProxy`）和消息内容。多余参数会被 JSON 序列化追加在末尾。

### 关闭后仍持续记录

- 日志通过异步追加流写入，未刷盘的内容会沿 `writeChain` 排队，避免并发交错。
- 进程收到 `SIGINT` / `SIGTERM` 时会先 `await logger.close()` 再退出，保证最后几行不丢。
- 目录不存在时首次启动会自动创建，跨天/跨重启时仍写入对应日期的文件。

### 查看历史日志

```bash
# 查看今天的日志
tail -f packages/llms/logs/tlproxy/tlproxy-$(date +%F).log

# 列出所有日志
ls -lh packages/llms/logs/tlproxy/

# 仅看错误级别
grep '\[ERROR\]' packages/llms/logs/tlproxy/*.log
```

## 注意事项

⚠️ 此代理仅用于开发和测试目的，不要用于生产环境。

⚠️ 免费 qwen API 有速率限制，请合理使用。
