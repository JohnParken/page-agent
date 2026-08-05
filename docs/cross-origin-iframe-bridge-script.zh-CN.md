# iframe bridge 经典 script / IIFE 接入指南

Page Agent 除原有 npm/ESM 次级入口外，还提供两个彼此独立、自包含的浏览器 IIFE 产物。经典 `<script>` 接入不需要打包器、`type="module"`、import map，也不会改变现有 bridge 协议。

| 页面          | 构建产物                                                                  | 浏览器全局对象                |
| ------------- | ------------------------------------------------------------------------- | ----------------------------- |
| 父页面        | `page-agent/dist/iife/page-agent-frame-bridge.iife.min.js`                | `window.PageAgentFrameBridge` |
| iframe 子页面 | `@page-agent/page-controller/dist/iife/page-agent-frame-host.iife.min.js` | `window.PageAgentFrameHost`   |

npm/ESM 适合 Vite、Webpack 等构建应用，仍使用 `page-agent/iframe-bridge` 与 `@page-agent/page-controller/iframe-bridge`。IIFE 适合无法运行模块构建的已有页面或固定版本 CDN 部署；不要把 IIFE 配置为 Node/ESM 默认入口。

## 父页面

```html
<iframe
    data-page-agent-bridge
    src="https://widgets.example.com/embedded"
    title="订单组件"
    sandbox="allow-scripts allow-same-origin"
></iframe>

<script src="https://cdn.example.com/sdk/page-agent/1.12.2/page-agent-frame-bridge.iife.min.js"></script>
<script>
    var bridge = window.PageAgentFrameBridge.createFrameAwareController({
        frameSelector: 'iframe[data-page-agent-bridge]',
        allowedChildOrigins: ['https://widgets.example.com'],
        handshakeTimeoutMs: 1000,
        requestTimeoutMs: 5000,
        localControllerOptions: {
            viewportExpansion: -1,
            includeAttributes: ['id', 'aria-label'],
        },
    })

    window.addEventListener('pagehide', function () {
        bridge.dispose()
    })
</script>
```

`createFrameAwareController()` 返回 `{ controller, dispose }`。父页面全局对象还公开底层 `FrameAwarePageController` 和 `PageController`，高级接入方可以自行构造控制器。

## iframe 子页面

```html
<script src="https://cdn.example.com/sdk/page-agent/1.12.2/page-agent-frame-host.iife.min.js"></script>
<script>
    var bridge = window.PageAgentFrameHost.startFrameBridge({
        allowedParentOrigins: ['https://app.example.com'],
        capabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup'],
        controllerOptions: {
            viewportExpansion: -1,
            includeAttributes: ['id', 'aria-label'],
        },
    })

    window.addEventListener('pagehide', function () {
        bridge.dispose()
    })
</script>
```

`startFrameBridge()` 返回 `{ host, controller, dispose }`，全局对象还公开底层 `FrameBridgeHost` 与 `PageController`。为避免经典 script 的便捷 API 意外授予写权限，未传 `capabilities` 时只开放 `['observe']`；底层 `FrameBridgeHost` 的既有 ESM 行为保持不变。

两个 `dispose()` 都可以重复调用。iframe reload 后旧连接和元素索引失效，父页面下一次观察会重新握手；必须重新取得浏览器状态，不能复用 reload 前的索引。

## Origin 与浏览器安全策略

-   `allowedChildOrigins` 与 `allowedParentOrigins` 都必须显式传入非空数组，只接受精确 HTTP(S) Origin（scheme、host、可选 port）。禁止 `*`、`null`、用户名密码、path、query 和 hash；不要从未校验的 URL 参数生成 allow-list。
-   父页面 CSP 的 `frame-src`（或旧 `child-src`）必须允许子页面；子页面 CSP 的 `frame-ancestors` 必须允许父页面。冲突的 `X-Frame-Options` 会在 bridge 运行前阻止嵌入。
-   使用 iframe `sandbox` 时至少保留 `allow-scripts allow-same-origin`。没有 `allow-scripts` 时 host 不运行；没有 `allow-same-origin` 时 Origin 变成不被接受的 `null`。
-   bridge 使用 `postMessage`/`MessageChannel`，父子通信不依赖 CORS。LLM/API 密钥只能保存在受信任的父侧服务或 gateway，不得写入 bundle、URL 或 bridge 消息。
-   `OUTCOME_UNKNOWN` 表示变更请求可能已经执行，不能盲目重试；应重新观察页面并按业务状态决定下一步。

## 构建、发布与版本

在仓库根目录运行：

```bash
npm run build:iife
```

该命令生成两份 minified JS 与 sourcemap，并校验没有额外 chunk、裸 `@page-agent/*`、CommonJS、动态 import 或 Node 内置模块。发布 npm 包前可用 `npm pack --dry-run --workspace=page-agent` 和 `npm pack --dry-run --workspace=@page-agent/page-controller` 检查 `dist/iife` 是否入包。

生产 HTML 必须引用固定版本路径，例如 `/sdk/page-agent/1.12.2/`，不要引用 `latest`。父、子 IIFE 应使用相同或协议兼容的版本；版本化文件可以设置 `Cache-Control: public, max-age=31536000, immutable`，并建议发布 SHA-256 manifest 与 SRI。是否公开 `.map` 应按源代码披露策略决定。

仓库内可直接运行的双端口纯 HTML 示例位于 [`examples/iframe-bridge-script`](../examples/iframe-bridge-script/README.md)。完整的 ESM API、能力模型、CSP、生命周期和 `OUTCOME_UNKNOWN` 说明见[跨域 iframe 协作桥接指南](./cross-origin-iframe-bridge.zh-CN.md)。
