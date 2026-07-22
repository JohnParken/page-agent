# YmProxyServer - Yiming AI 代理服务器

这个代理服务器模拟 Yiming AI 的 chatabc API，实际后端调用免费的 qwen3.5-plus API，用于测试和验证 YimingAiClient。

## 功能特性

- ✅ 模拟 `/chatabc/init_session` 端点初始化会话
- ✅ 模拟 `/chatabc/chat` 端点处理聊天请求
- ✅ 将 YmClient 的请求转发给 qwen3.5-plus API
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
tsx src/YmProxyServer.ts
```

或者使用环境变量配置：

```bash
PROXY_PORT=8089 \
QWEN_BASE_URL=https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run \
QWEN_MODEL=qwen3.5-plus \
tsx src/YmProxyServer.ts
```

### 3. 在 YimingAiClient 中使用代理

将 `endpointAgent` 设置为代理服务器地址：

```typescript
import { YimingAiClient } from '@page-agent/llms'

const client = new YimingAiClient({
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

1. 将 Provider 设置为 "Yiming AI"
2. 将 Endpoint Agent 设置为 `localhost:8089`
3. 保存配置

## 架构说明

```
YmClient → YmProxyServer (localhost:8089) → qwen3.5-plus API
              ↓
        模拟 chatabc 协议
              ↓
        转换为 OpenAI 格式
              ↓
        调用 qwen API
              ↓
        转换回 chatabc 格式
```

## 环境变量

| 变量            | 默认值                                                   | 说明               |
| --------------- | -------------------------------------------------------- | ------------------ |
| `PROXY_PORT`    | 8089                                                     | 代理服务器监听端口 |
| `QWEN_BASE_URL` | https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run | 后端 qwen API 地址 |
| `QWEN_MODEL`    | qwen3.5-plus                                             | 使用的模型名称     |

## 调试

代理服务器会在控制台输出详细的日志，包括：

- 会话创建
- 请求内容
- API 响应
- 错误信息

## 注意事项

⚠️ 此代理仅用于开发和测试目的，不要用于生产环境。

⚠️ 免费 qwen API 有速率限制，请合理使用。
