# Dev Tools - 开发和测试工具

此目录包含用于开发和测试的辅助工具，不会包含在生产构建中。

## 📁 包含内容

- **YmProxyServer.ts** - Yiming AI 代理服务器，用于测试 YmClient
- **test-ym-proxy.ts** - 代理服务器的简单测试脚本
- **YmProxy_README.md** - 代理服务器的详细使用文档

## 🚀 使用方法

### 启动 YmProxyServer

```bash
npm run start:ym-proxy
```

### 测试代理

```bash
npm run test:ym-proxy
```

## 📝 注意事项

- 这些工具只用于开发和测试
- 不会被打包到 npm 发布包中
- 不会影响生产环境的代码
