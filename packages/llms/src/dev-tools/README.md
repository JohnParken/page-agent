# Dev Tools - 开发和测试工具

此目录包含用于开发和测试的辅助工具，不会包含在生产构建中。

## 📁 包含内容

-   **TlProxyServer.ts** - Tl AI 代理服务器，用于测试 TlClient
-   **test-tl-proxy.ts** - 代理服务器的简单测试脚本
-   **TlProxy_README.md** - 代理服务器的详细使用文档
-   **DsProxyServer.ts** - DeepSeek 代理服务器，用于测试 DsAiClient
-   **test-ds-proxy.ts** - DeepSeek 代理的本地 smoke test
-   **DsProxy_README.md** - DeepSeek 代理服务器的详细使用文档

## 🚀 使用方法

### 启动 TlProxyServer

```bash
npm run start:tl-proxy
```

### 测试代理

```bash
npm run test:tl-proxy
```

### 启动 DsProxyServer

```bash
npm run start:ds-proxy
```

默认监听 `127.0.0.1:8090`，并将 DsClient 的 chatbbc 请求转发到
`https://api.deepseek.com/chat/completions`。DeepSeek API key 只从启动进程的
`DEEPSEEK_API_KEY` 环境变量读取，不会从浏览器请求读取。

### 测试 Ds 代理

```bash
npm run test:ds-proxy
```

可通过 `DS_PROXY_URL` 覆盖 smoke test 的代理地址，例如
`DS_PROXY_URL=http://127.0.0.1:8091 npm run test:ds-proxy`。

## 📝 注意事项

-   这些工具只用于开发和测试
-   不会被打包到 npm 发布包中
-   不会影响生产环境的代码
