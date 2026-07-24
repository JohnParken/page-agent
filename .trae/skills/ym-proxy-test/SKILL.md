---
name: tl-proxy-test
description: 验证 TlProxyServer 代理服务器的 init_session 和 chat 接口是否正常工作。当需要测试 Tl Provider 代理功能、排查代理服务器问题、或验证 Qwen API 集成时调用此 skill。
---

# TlProxyServer 验证 Skill

## 概述

此 skill 用于验证 TlProxyServer 代理服务器的两个核心接口：

- `init_session`：创建会话
- `chat`：发送聊天请求（需要使用完整的官方 system prompt）

## 前置条件

1. 代理服务器已启动（默认端口 8089）
2. 网络可以访问 Qwen API

## 验证步骤

### 1. 启动代理服务器

```bash
cd packages/llms
npm run start:tl-proxy
```

等待看到输出：

```
🚀 TlProxyServer 已启动!
📍 代理地址: http://localhost:8089
```

### 2. 验证 init_session 接口

```bash
curl -X POST http://localhost:8089/chatbbc/init_session \
  -H "Content-Type: application/json" \
  -d '{
    "appId": "test",
    "trCode": "test",
    "trVersion": "1.0",
    "timestamp": 1234567890,
    "requestId": "test-123",
    "data": {
      "prompt_variables": [
        {"name": "test", "value": "test"}
      ]
    }
  }' | jq .
```

**期望响应**：

```json
{
    "code": 0,
    "message": "success",
    "data": {
        "session_id": "session_xxx"
    }
}
```

### 3. 验证 chat 接口

**重要**：chat 接口需要使用完整的官方 system prompt，否则 Qwen API 会返回 403 错误。

#### 方法一：使用测试脚本（推荐）

项目根目录提供了 `test_proxy.js` 测试脚本：

```bash
cd /Users/yangxuezhen/git/page-agent
node test_proxy.js
```

脚本会自动：

1. 读取完整的 system prompt
2. 调用 init_session 获取 session_id
3. 使用完整的 system prompt 调用 chat 接口
4. 输出详细的响应信息

#### 方法二：手动构造请求

```bash
# 1. 读取 system prompt
SYSTEM_PROMPT=$(cat packages/core/src/prompts/system_prompt.md)

# 2. 使用 Node.js 构造 JSON（避免转义问题）
node -e "
const fs = require('fs');
const systemPrompt = fs.readFileSync('packages/core/src/prompts/system_prompt.md', 'utf-8');
const request = {
  appId: 'test',
  trCode: 'test',
  trVersion: '1.0',
  timestamp: 1234567890,
  requestId: 'test-123',
  data: {
    session_id: 'session_xxx',
    txt: 'system: ' + systemPrompt + '\n\nuser: Hello',
    files: [],
    stream: false
  }
};
fs.writeFileSync('request.json', JSON.stringify(request, null, 2));
"

# 3. 发送请求
curl -X POST http://localhost:8089/chatbbc/chat \
  -H "Content-Type: application/json" \
  -d @request.json | jq .
```

**期望响应**：

```json
{
    "code": 0,
    "message": "success",
    "data": {
        "txt": "AI 响应内容..."
    }
}
```

## 常见问题排查

### 问题 1：init_session 返回 404

**原因**：代理服务器未启动或端口错误

**解决**：

```bash
# 检查端口占用
lsof -i :8089

# 重启代理服务器
cd packages/llms
npm run start:tl-proxy
```

### 问题 2：chat 返回 403 "System prompt must match"

**原因**：system prompt 不完整或与官方版本不匹配

**解决**：

- 确保使用 `packages/core/src/prompts/system_prompt.md` 的完整内容
- 检查是否有转义问题（使用 Node.js 构造 JSON）
- 查看代理服务器日志确认发送的内容

### 问题 3：chat 返回 500 "Internal server error"

**原因**：Qwen API 调用失败或响应解析错误

**解决**：

- 查看代理服务器日志中的详细错误信息
- 检查网络连接
- 验证 Qwen API 是否可访问

### 问题 4：端口 3001 被占用

**解决**：

```bash
# 查找占用进程
lsof -i :3001

# 终止进程
kill -9 <PID>

# 或使用其他端口启动
PROXY_PORT=8089 npm run start:tl-proxy
```

## 代理服务器日志

代理服务器会输出详细的日志，包括：

- 📥 请求内容（init_session / chat）
- 📤 响应内容
- 解析后的 messages 数组
- 发送给 Qwen API 的请求
- Qwen API 的响应

利用这些日志可以快速定位问题。

## 相关配置

在扩展中使用 Tl Provider 时，配置如下：

```json
{
    "provider": "tl",
    "endpointAgent": "localhost:3001",
    "model": "qwen3.5-plus",
    "toolCallingMode": "system_prompt"
}
```

**注意**：

- `endpointAgent` 不要加 `http://` 前缀
- `toolCallingMode` 推荐使用 `system_prompt`
