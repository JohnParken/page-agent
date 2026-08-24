# iframe bridge 经典 script / IIFE 部署接入指南

Page Agent 除 npm/ESM 次级入口外，还提供两个彼此独立、自包含的浏览器 IIFE 产物。它们适合无法使用 Vite、Webpack 或 ESM import 的已有页面，可以通过普通 `<script>` 部署，不需要 `type="module"` 或 import map。

本文不仅说明如何构建 IIFE，还覆盖一套可实际运行的完整接入：主页面如何提供并初始化 PageAgent、如何连接 LLM、如何把跨 frame controller 注入 Agent，以及主页面和跨域 iframe 子页面分别必须完成哪些改造。

> **当前 iframe 支持边界：** 普通 `PageController` 会把所有 iframe 的子文档视为不透明叶节点（opaque leaf），不会读取或操作同源 iframe 的内部内容，同源 iframe 也不会进入本协作 bridge。跨域 iframe 只有在子页面主动接入并运行兼容的 host IIFE 时才支持读取和操作。这个限制针对 iframe 子文档遍历；独立的 parent bridge（由 iframe 内的 Page Agent 操作父页面中明确授权的 root）不受影响。

> **协议兼容性：** 当前 IIFE 使用 iframe bridge v2。变更动作先执行只含脱敏摘要的
> prepare，再用短时、一次性 token commit；原始输入不会在子侧策略通过前发送。父、子 IIFE
> 必须来自相同协议主版本，v1 与 v2 不能混用。

## 1. 先理解两个 IIFE 的职责

| 页面         | 文件                                  | 浏览器全局对象                | 职责                                                                                            |
| ------------ | ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------- |
| 接入方主页面 | `page-agent-frame-bridge.iife.min.js` | `window.PageAgentFrameBridge` | 创建父页面本地 `PageController`，发现指定的直接子 iframe，并把父子页面状态合并为一个 controller |
| 跨域子页面   | `page-agent-frame-host.iife.min.js`   | `window.PageAgentFrameHost`   | 在子页面内创建 `PageController`，校验父页面 Origin，并仅向父页面开放显式授权的能力              |

父侧 bridge IIFE **不包含 PageAgent、LLM client 或模型配置，也不会自动创建 Agent**。主页面仍需使用自己已有的 PageAgent bundle，并把 `createFrameAwareController()` 返回的 `controller` 注入 PageAgent。

子侧 host IIFE 不需要也不应加载 PageAgent、LLM package、模型 API key 或父页面业务代码。子页面只负责本页面 DOM 的观察和被授权操作。

整体关系如下：

```text
接入方主页面
├── 接入方已有的 PageAgent bundle
├── page-agent-frame-bridge.iife.min.js
├── FrameAwarePageController
│   ├── 主页面 PageController
│   └── MessageChannel ───────────────┐
└── <iframe src="跨域子页面">         │
                                      │
跨域子页面                            │
├── page-agent-frame-host.iife.min.js │
├── FrameBridgeHost ◀─────────────────┘
└── 子页面 PageController
```

bridge 只支持父页面中由 `frameSelector` 选中的**跨域直接子 iframe**。普通 `PageController` 不会读取或操作同源 iframe 的子文档；同源 iframe 是 opaque leaf，也不会进入 cooperative bridge。bridge 不会递归发现孙 iframe，也不会让父页面绕过同源策略读取未接入 host 的第三方页面。

## 2. 部署前准备

假设生产环境使用以下地址：

```text
主页面：https://app.example.com/orders
子页面：https://widgets.example.com/embedded/order
静态资源：https://cdn.example.com/sdk/page-agent/1.12.2/
LLM gateway：https://llm-gateway.example.com/
```

双方配置中使用的是 Origin，而不是完整 URL：

```text
主页面 Origin：https://app.example.com
子页面 Origin：https://widgets.example.com
```

Origin 只包含 scheme、host 和可选端口。不要把 `/orders`、`/embedded/order`、query 或 hash 写进 allow-list。

部署前应确认：

-   父、子页面均使用 HTTPS，避免 mixed content。
-   子页面愿意接入并能够修改自己的 HTML/JavaScript 和响应头。
-   iframe 是主页面的直接子节点，且可以通过稳定、明确的 selector 选中。
-   父、子双方事先约定精确 Origin 和开放能力。
-   父、子 IIFE 使用相同版本，或者至少使用兼容的 bridge protocol 版本。
-   目标浏览器支持 ES2020、`MessageChannel`、`AbortController`、`EventTarget` 和 `CustomEvent`。

## 3. 构建与发布静态文件

在仓库根目录运行：

```bash
npm run build:iife
```

生成：

```text
packages/page-agent/dist/iife/
├── page-agent-frame-bridge.iife.min.js
└── page-agent-frame-bridge.iife.min.js.map

packages/page-controller/dist/iife/
├── page-agent-frame-host.iife.min.js
└── page-agent-frame-host.iife.min.js.map
```

推荐把两份文件发布到同一个固定版本目录：

```text
/sdk/page-agent/1.12.2/
├── page-agent-frame-bridge.iife.min.js
├── page-agent-frame-bridge.iife.min.js.map
├── page-agent-frame-host.iife.min.js
└── page-agent-frame-host.iife.min.js.map
```

静态服务器建议返回：

```http
Content-Type: application/javascript; charset=utf-8
Cache-Control: public, max-age=31536000, immutable
```

生产页面必须引用固定版本，不要引用 `latest`。建议同时发布文件 hash manifest，并在 HTML 中使用 SRI：

```html
<script
    src="https://cdn.example.com/sdk/page-agent/1.12.2/page-agent-frame-bridge.iife.min.js"
    integrity="sha384-REPLACE_WITH_BUILD_HASH"
    crossorigin="anonymous"
></script>
```

跨域 CDN 配合 SRI 时，CDN 需要返回适当的 CORS 响应头。sourcemap 是否部署取决于源码披露策略，不部署 `.map` 不影响 bridge 运行。

## 4. 完整接入中的 PageAgent

### 4.1 生产环境实际需要三类产物

两个 bridge IIFE 只解决跨域 iframe 的观察和操作通道，不包含 Agent 的推理循环。要通过经典 `<script>` 运行完整能力，生产页面实际需要：

| 产物                                  | 所在页面 | 作用                                           | 本仓库本次构建是否生成           |
| ------------------------------------- | -------- | ---------------------------------------------- | -------------------------------- |
| 接入方 PageAgent 主 bundle            | 主页面   | 提供 `PageAgent`、LLM client、工具编排和 Panel | 否，由接入方现有应用 bundle 提供 |
| `page-agent-frame-bridge.iife.min.js` | 主页面   | 聚合主页面与已授权子 iframe 的 controller      | 是                               |
| `page-agent-frame-host.iife.min.js`   | 子页面   | 在子页面执行观察和已授权动作                   | 是                               |

因此，`npm run build:iife` 生成的是后两项。它不会生成一个可直接替代 `page-agent` npm/ESM 入口的生产 Agent SDK。

接入方可以继续使用原有 ESM 应用入口：

```js
import { PageAgent } from 'page-agent'

// Only needed when later initialization is written as a classic script.
window.PageAgent = PageAgent
```

再由接入方自己的 Vite、Webpack、Rollup 等构建流程输出浏览器 bundle。也可以完全在同一个 ESM 模块中 import PageAgent 和 bridge ESM 入口；本文后续使用 `window.PageAgent`，只是为了演示无法使用 ESM 的经典 script 页面如何衔接现有应用 bundle。

仓库中的 `page-agent.demo.js` 是带内置 demo 配置和自动初始化逻辑的测试入口。添加 `?autoInit=false` 只会跳过 Agent 实例的自动创建；脚本仍会挂载 `window.PageAgent` 和包含内置模型、endpoint 等默认值的 `window.pageAgentDemoConfig`。它只适合本地联调，不应作为通用生产 SDK 发布。源码中的 `declare global` 只是 TypeScript 类型声明，不会让普通 ESM 入口自动写入 `window.PageAgent`；生产 bundle 必须像上面的入口一样显式挂载，或在同一个模块内直接使用 import 得到的 `PageAgent`。

### 4.2 Agent、bridge 与 host 的运行边界

完整链路中只有主页面运行 Agent 和调用 LLM：

```text
用户任务
  → 主页面 PageAgent
  → 主页面 LLM gateway
  → PageAgent 工具
  → FrameAwarePageController
      ├── 主页面 PageController
      └── 跨域子页面 FrameBridgeHost → 子页面 PageController
```

这意味着：

-   子页面不需要加载 PageAgent，也不需要知道模型、任务或 LLM gateway 配置。
-   父子 bridge 消息只承载页面状态、索引、动作请求/结果，以及与当前 click/input 请求绑定的模拟光标反馈，不承载模型密钥。
-   `FrameAwarePageController` 是 PageAgent 与父子页面之间唯一的 controller adapter。若不注入它，Agent 只能看到主页面默认 controller。
-   PageAgent 的 Panel、任务输入、`ask_user` 交互和执行状态都留在主页面。

### 4.3 配置主页面的 LLM

使用内置 client 时，`model` 始终必填。其他必填项取决于 `provider`：

| `provider`      | 最少需要                                   | 说明                                                               |
| --------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| 省略或 `openai` | `model`、`baseURL`                         | `baseURL` 指向 OpenAI-compatible API；按 gateway 要求提供 `apiKey` |
| `tl`            | `model`、`endpointAgent`                   | 可按网关协议增加 `appId`、`trCode`、`trVersion` 等字段             |
| `ds`            | `model`，以及 `endpointAgent` 或 `baseURL` | 分别对应 gateway 或 API 模式，也可显式设置 `dsMode`                |

内置 provider 只接受 `openai`、`tl` 和 `ds`。OpenAI 模式使用原生 tool calling；`tl` 默认使用 `system_prompt`，也支持按服务能力选择 `api`；`ds` 只支持 `system_prompt`。当 `dsMode` 省略时，配置 `endpointAgent` 会选择 gateway 模式，只有 `baseURL` 时选择 API 模式。

OpenAI-compatible gateway 示例：

```js
var agentConfig = {
    provider: 'openai',
    model: 'your-model',
    baseURL: 'https://llm-gateway.example.com/v1',
    apiKey: 'SHORT_LIVED_BROWSER_TOKEN_IF_REQUIRED',
    maxRetries: 1,
    maxSteps: 40,
    language: 'zh-CN',
}
```

生产环境建议由同源后端或受信任 gateway 持有模型供应商的长期凭证，并只向浏览器发放短期、低权限 token。不要把长期密钥写入 HTML、公开 bundle、iframe URL、DOM 属性或 bridge 配置。父页面 CSP 的 `connect-src` 必须允许实际 gateway；bridge 自身不需要 CORS，但浏览器访问跨 Origin gateway 时需要 gateway 返回合适的 CORS 响应头。

`maxSteps` 默认是 `40`。`experimentalScriptExecutionTool` 默认关闭；启用后，`execute_javascript` 仍只在父页面本地 controller 执行，不会通过 bridge 发送到跨域子页面。

PageAgent 的构造配置由 Agent、controller 和 Panel 三部分组合。生产接入常用字段如下：

| 配置层     | 常用字段                                                                                        | 用途                                                    |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Agent 执行 | `maxSteps`、`stepDelay`、`instructions`                                                         | 控制最大步数、步骤间隔和全局/按页面动态指令             |
| 内容与工具 | `transformPageContent`、`customTools`、`experimentalLlmsTxt`、`experimentalScriptExecutionTool` | 脱敏或改写发给 LLM 的页面内容，以及增删工具和实验能力   |
| 生命周期   | `onBeforeTask`、`onAfterTask`、`onBeforeStep`、`onAfterStep`、`onDispose`                       | 接入埋点、审计或业务状态同步；这些 API 当前是实验性接口 |
| Panel      | `language`、`promptForNextTask`                                                                 | 设置中英文 UI，以及任务结束后是否提示下一项任务         |
| controller | `enableMask`、`viewportExpansion`、`includeAttributes`、交互黑白名单等                          | 控制 DOM 提取、可操作范围和视觉遮罩                     |

使用 frame-aware controller 时，最后一行 controller 配置必须放到 `localControllerOptions`，只作用于父页面。子页面使用自己的 `controllerOptions` 独立配置。`onAskUser` 不是构造配置字段，而是 Agent 实例属性，具体接法见 4.6。

### 4.4 创建 Agent 时必须注入 bridge controller

先创建 bridge controller，再创建唯一的 Agent 实例：

```js
var frameBridge = window.PageAgentFrameBridge.createFrameAwareController({
    frameSelector: 'iframe[data-page-agent-bridge]',
    allowedChildOrigins: ['https://widgets.example.com'],
})

var agent

try {
    agent = new window.PageAgent({
        ...agentConfig,
        pageController: frameBridge.controller,
    })
} catch (error) {
    frameBridge.dispose()
    throw error
}

window.pageAgentFrameBridge = frameBridge
window.pageAgent = agent
```

`PageAgent` 在没有 `pageController` 时会自行创建一个只负责当前文档的本地 `PageController`。传入 `frameBridge.controller` 后，它会原样使用该实例，不再读取 Agent 配置中的 `enableMask`、`includeAttributes` 等字段来重新配置 controller；这些字段必须在 bridge 的 `localControllerOptions` 中设置。

不要先自动创建默认 Agent，再另外创建 bridge Agent。并存实例会重复监听和操作页面，而且旧实例仍看不到跨域 iframe。

### 4.5 Agent 工具如何路由

PageAgent 不需要知道某个元素来自父页面还是子页面。每次观察产生聚合索引，后续 controller 根据该索引路由动作：

| 能力                             | 执行位置                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `getBrowserState()` 页面内容     | 父页面状态中嵌入所有已连接、允许 `observe` 的直接子 iframe 内容                       |
| 顶层标题、URL 和当前页面信息     | 仍代表父页面；子页面的标题、URL、滚动信息位于聚合内容的 `<cross-origin-frame>` 区块中 |
| `click`、`input`、`select`       | 根据最新聚合元素索引在父页面本地执行，或发送到开放对应 capability 的子页面            |
| `scroll`、`scrollHorizontally`   | 带远端元素或 frame 文档索引时路由到对应子页面；不带索引的整页滚动留在父页面           |
| `cleanUpHighlights`              | 同时清理父页面和已连接子页面的高亮                                                    |
| `execute_javascript`             | 仅父页面本地；远端明确拒绝                                                            |
| `ask_user`、Panel 展示、任务状态 | 主页面 PageAgent/Panel                                                                |
| LLM 请求与重试                   | 主页面 PageAgent/LLM client                                                           |

frame 文档索引用于把整页滚动路由到子页面，不是普通可交互元素；不能拿它执行 click、input 或 select。所有索引都不是可长期保存的业务 ID。Agent 每一步都会重新观察；接入方直接调用 controller API 时，也应在 iframe reload、DOM 重建或收到 `invalidate` 后重新获取浏览器状态。

### 4.6 启动任务、停止任务和 Panel

创建成功后，可以由 PageAgent 自带 Panel 接收任务，也可以绑定接入方自己的 UI：

```js
var runButton = document.querySelector('#run-page-agent')
var stopButton = document.querySelector('#stop-page-agent')
var taskInput = document.querySelector('#page-agent-task')

agent.panel.show()

runButton.addEventListener('click', async function () {
    runButton.disabled = true

    try {
        var result = await agent.execute(taskInput.value)
        console.info('PageAgent task settled', result.success, result.data)
    } catch (error) {
        // Configuration, pre-check and lifecycle-hook errors reject execute().
        console.error('PageAgent task failed before normal settlement', error)
    } finally {
        runButton.disabled = false
    }
})

stopButton.addEventListener('click', async function () {
    await agent.stop()
})
```

`execute(task)` 返回 `{ success, data, history }`。Agent 内部执行错误通常会转换为 `success: false`；配置、前置检查和生命周期 hook 错误可能直接 reject。一个实例同一时间只能运行一个任务，运行期间再次调用 `execute()` 会抛错。

`stop()` 会中止当前 LLM 请求和工具链，并等待当前任务及生命周期 hook 完整收敛。不要在生命周期 hook 内 `await agent.stop()`。`agent.status` 可用于读取 `idle`、`running`、`completed`、`error` 或 `stopped` 状态，也可监听：

```js
agent.addEventListener('statuschange', function () {
    console.info('PageAgent status:', agent.status)
})
```

每个 `PageAgent` 构造时都会创建 Panel，Panel 初始隐藏，使用 `agent.panel.show()` 和 `agent.panel.hide()` 控制显示。Panel 构造时会自动接管 `agent.onAskUser`；如果接入方要使用自定义交互，应在 `new PageAgent(...)` 之后重新赋值一个支持取消信号的异步函数：

```js
agent.onAskUser = async function (question, options) {
    if (options && options.signal.aborted) {
        throw options.signal.reason
    }

    return window.prompt(question) || ''
}
```

未设置 `onAskUser` 时，`ask_user` 工具会在任务开始时被禁用。页面卸载或 SPA 模块销毁时调用 `agent.dispose()`；它会同步 dispose 注入的 frame-aware controller、发出中止信号，并触发 Panel 清理。dispose 后不能复用该 Agent，必须创建新实例。如果业务流程需要确认运行任务及异步生命周期 hook 已完全结束，应先 `await agent.stop()`，再调用 `agent.dispose()`。

## 5. 接入方主页面需要进行的改造

### 5.1 给目标 iframe 增加明确标记

不要用宽泛的 `iframe` selector 自动连接页面中的所有 frame。建议为明确授权的 iframe 增加专用属性：

```html
<iframe
    id="order-widget"
    data-page-agent-bridge
    src="https://widgets.example.com/embedded/order"
    title="订单组件"
    sandbox="allow-scripts allow-same-origin"
></iframe>
```

要求：

-   目标必须是当前主文档的直接子 iframe。
-   `src` 的 Origin 必须在 `allowedChildOrigins` 中。
-   如果 `src` 会重定向到另一个 Origin，声明 Origin 和最终 Origin 都必须受信任并加入 allow-list；更推荐避免跨 Origin 重定向。
-   同源 iframe 的子文档暂不支持读取或操作：普通 `PageController` 将其视为 opaque leaf，也不会通过 bridge 处理。
-   未匹配 selector 的 iframe 不参与 bridge。

### 5.2 调整主页面响应头

父页面 CSP 至少需要允许：

-   `frame-src` 加载子页面 Origin；
-   `script-src` 加载 IIFE 所在 CDN；
-   `connect-src` 访问实际使用的 LLM gateway。

示例响应头：

```http
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com 'nonce-REPLACE_WITH_REQUEST_NONCE'; frame-src https://widgets.example.com; connect-src 'self' https://llm-gateway.example.com; object-src 'none'; base-uri 'self'
```

如果使用 nonce，内联初始化脚本也必须带同一个请求级 nonce。不要为了接入 bridge 直接放宽为 `script-src *` 或长期启用 `'unsafe-inline'`。

### 5.3 加载父侧 bridge IIFE

把 bridge IIFE 放在初始化代码之前，并检查全局对象是否存在：

```html
<script
    src="https://cdn.example.com/sdk/page-agent/1.12.2/page-agent-frame-bridge.iife.min.js"
    integrity="sha384-REPLACE_WITH_BUILD_HASH"
    crossorigin="anonymous"
></script>
```

父侧全局对象只公开以下 API：

| API                                                        | 用途                                    |
| ---------------------------------------------------------- | --------------------------------------- |
| `PageAgentFrameBridge.createFrameAwareController(options)` | 推荐的经典 script 初始化方法            |
| `PageAgentFrameBridge.FrameAwarePageController`            | 高级接入方自行组装 controller           |
| `PageAgentFrameBridge.PageController`                      | 高级接入方自行创建父页面本地 controller |

### 5.4 创建父侧 controller

```html
<script nonce="REPLACE_WITH_REQUEST_NONCE">
    if (!window.PageAgentFrameBridge) {
        throw new Error('PageAgentFrameBridge is unavailable')
    }

    var frameBridge = window.PageAgentFrameBridge.createFrameAwareController({
        frameSelector: 'iframe[data-page-agent-bridge]',
        allowedChildOrigins: ['https://widgets.example.com'],
        handshakeTimeoutMs: 1000,
        requestTimeoutMs: 5000,
        localControllerOptions: {
            viewportExpansion: -1,
            includeAttributes: ['id', 'name', 'aria-label'],
            enableMask: true,
        },
    })

    window.pageAgentFrameBridge = frameBridge
</script>
```

配置说明：

| 字段                     | 是否必需 | 行为                                                                                 |
| ------------------------ | -------- | ------------------------------------------------------------------------------------ |
| `frameSelector`          | 是       | 非空且合法的 CSS selector；每次观察时重新查询，因此也支持之后动态插入的直接子 iframe |
| `allowedChildOrigins`    | 是       | 非空的精确 HTTP(S) Origin 数组；拒绝 `*`、`null`、path、query、hash 和用户名密码     |
| `handshakeTimeoutMs`     | 否       | 握手超时，默认 `1000` 毫秒；必须是正的有限数值                                       |
| `requestTimeoutMs`       | 否       | 单次远端请求超时，默认 `5000` 毫秒；必须是正的有限数值                               |
| `localControllerOptions` | 否       | 仅配置父页面本地 `PageController`，不会传给子页面                                    |

`createFrameAwareController()` 返回：

```js
{
    controller: FrameAwarePageController,
    dispose: Function,
}
```

因为这里注入的是已经创建好的 controller，之后传给 PageAgent 的 `enableMask`、`includeAttributes` 等同名字段不会重新配置它。父页面 controller 选项应统一放在 `localControllerOptions` 中。特别是 helper 直接创建的 `PageController` 默认不会因为 PageAgent 的默认行为自动开启 mask；需要视觉遮罩时应显式写 `enableMask: true`。

### 5.5 把 controller 注入已有 PageAgent

这是主页面最重要的改造。bridge IIFE 本身不会创建 PageAgent；接入方必须保证 PageAgent 使用 `frameBridge.controller`，否则 Agent 仍然只使用默认本地 controller，看不到跨域子页面。

以下 `/assets/your-page-agent-entry.iife.js` 代表接入方已有、能够暴露 `window.PageAgent` 的应用 bundle，不是本任务生成的 bridge 文件：

```html
<script src="/assets/your-page-agent-entry.iife.js"></script>
<script nonce="REPLACE_WITH_REQUEST_NONCE">
    if (!window.PageAgent) {
        throw new Error('The host application must expose window.PageAgent')
    }

    var frameBridge = window.pageAgentFrameBridge
    var agent

    try {
        agent = new window.PageAgent({
            provider: 'openai',
            model: 'your-model',
            baseURL: 'https://llm-gateway.example.com/v1',
            apiKey: 'SHORT_LIVED_BROWSER_TOKEN_IF_REQUIRED',
            language: 'zh-CN',
            pageController: frameBridge.controller,
        })
    } catch (error) {
        frameBridge.dispose()
        throw error
    }

    window.pageAgent = agent
</script>
```

如果接入方没有能够暴露 `window.PageAgent` 的现有 bundle，仅部署父、子两份 bridge IIFE 并不能运行 Agent。此时应继续采用原有 npm/ESM PageAgent 接入，或者由接入方把自己的 PageAgent 主入口构建为浏览器 bundle；不要误把 `page-agent-frame-bridge.iife.min.js` 当成完整 PageAgent SDK。

生产环境应让 `baseURL` 指向受信任的后端 gateway，并优先使用服务端凭证或短期、低权限浏览器 token。不要把长期模型/API 密钥写入 HTML、IIFE 文件、iframe URL 或 bridge 消息。

如果接入方现有 PageAgent bundle 会自动初始化，必须关闭 auto-init，或者先 dispose 旧实例，再使用 bridge controller 创建新实例。否则页面会同时存在两个 controller，旧 Agent 仍无法观察跨域 iframe。

仓库中的 `page-agent.demo.js?autoInit=false` 只用于本地 demo 验证，不应被当作通用生产 SDK 部署。demo 默认值还会开启实验性的脚本执行工具；生产入口应根据风险显式配置，通常保持 `experimentalScriptExecutionTool: false`。

如果主页面不使用 PageAgent，也可以把 `frameBridge.controller` 交给其他实现了相同 controller adapter 调用方式的编排层，或者直接调用：

```js
var browserState = await frameBridge.controller.getBrowserState()
```

### 5.6 等待子页面就绪后再开始任务

创建父侧 controller 时不会立即握手。首次调用 `getBrowserState()`、`updateTree()`，或 PageAgent 开始观察页面时才会连接子页面。

如果用户可能在 iframe 尚未加载完成时立即启动任务，建议在 iframe 的 `load` 事件后启用运行按钮：

```js
var iframe = document.querySelector('iframe[data-page-agent-bridge]')
var runButton = document.querySelector('#run-page-agent')

runButton.disabled = true
iframe.addEventListener('load', function () {
    runButton.disabled = false
})
```

即使第一次握手超时，下一次观察仍会重新尝试；但生产体验上应避免在 host 脚本尚未启动时发起第一项任务。

### 5.7 监听连接错误和 iframe 失效

某个子 iframe 连接失败不会让整个父页面观察失败。该 frame 会在浏览器状态中显示为 `unavailable`，本地页面和其他可用 frame 仍可继续工作，同时 controller 派发 `bridgeerror`：

```js
frameBridge.controller.addEventListener('bridgeerror', function (event) {
    var detail = event.detail || {}
    var code = detail.error && detail.error.code

    console.error('Iframe bridge unavailable', {
        code: code || 'UNKNOWN',
        message: detail.message,
        src: detail.iframe && detail.iframe.src,
    })
})

frameBridge.controller.addEventListener('invalidate', function (event) {
    console.info('Iframe bridge connection invalidated', event.detail)
})
```

日志应记录错误码、frame 地址和必要的诊断信息，不要记录完整页面内容、输入值、token 或用户敏感数据。

### 5.8 释放父侧资源

如果 controller 已注入 PageAgent，`agent.dispose()` 会一并 dispose controller。helper 的 `dispose()` 和底层 controller dispose 都是幂等的，因此重复调用不会产生额外副作用：

```js
window.addEventListener('pagehide', function () {
    if (window.pageAgent) {
        window.pageAgent.dispose()
    } else if (window.pageAgentFrameBridge) {
        window.pageAgentFrameBridge.dispose()
    }
})
```

SPA 在路由卸载、替换 Agent 或移除 bridge iframe 时，也应执行相同清理。不要在每次按钮点击时创建新的 controller 或 Agent。

## 6. 跨域子页面需要进行的改造

### 6.1 调整子页面嵌入策略

子页面服务器必须允许被指定主页面嵌入：

```http
Content-Security-Policy: default-src 'self'; script-src 'self' https://cdn.example.com 'nonce-REPLACE_WITH_REQUEST_NONCE'; frame-ancestors https://app.example.com; object-src 'none'; base-uri 'self'
```

注意：

-   `frame-ancestors` 必须通过 HTTP 响应头发送，不能依赖 `<meta http-equiv>`。
-   `X-Frame-Options: DENY` 会阻止所有嵌入。
-   跨 Origin 场景下，`X-Frame-Options: SAMEORIGIN` 也会阻止主页面嵌入。
-   如果父页面 iframe 使用 sandbox，至少需要 `allow-scripts allow-same-origin`。缺少 `allow-scripts` 时 host 不运行；缺少 `allow-same-origin` 时子页面变成不受信任的 `null` Origin，握手必然被拒绝。

### 6.2 加载子侧 host IIFE

把脚本放在子页面 DOM 之后、`</body>` 之前，或者使用能够保证 DOM 初始化顺序的加载方式：

```html
<script
    src="https://cdn.example.com/sdk/page-agent/1.12.2/page-agent-frame-host.iife.min.js"
    integrity="sha384-REPLACE_WITH_BUILD_HASH"
    crossorigin="anonymous"
></script>
```

子侧全局对象只公开：

| API                                            | 用途                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `PageAgentFrameHost.startFrameBridge(options)` | 推荐的经典 script 初始化方法；会自动创建 controller 并调用 `host.start()` |
| `PageAgentFrameHost.FrameBridgeHost`           | 高级接入方自行创建 host                                                   |
| `PageAgentFrameHost.PageController`            | 高级接入方自行创建子页面 controller                                       |

### 6.3 启动 host 并显式授权能力

```html
<script nonce="REPLACE_WITH_REQUEST_NONCE">
    if (!window.PageAgentFrameHost) {
        throw new Error('PageAgentFrameHost is unavailable')
    }

    var frameHost = window.PageAgentFrameHost.startFrameBridge({
        allowedParentOrigins: ['https://app.example.com'],
        capabilities: [
            'observe',
            'click',
            'input',
            'select',
            'scroll',
            'scrollHorizontally',
            'cleanup',
        ],
        controllerOptions: {
            viewportExpansion: -1,
            includeAttributes: ['id', 'name', 'aria-label'],
        },
    })

    window.pageAgentFrameHost = frameHost
</script>
```

`startFrameBridge()` 返回：

```js
{
    host: FrameBridgeHost,
    controller: PageController,
    dispose: Function,
}
```

它会自动调用 `host.start()`，无需再次调用。不要在同一个子文档中重复创建多个 host，否则多个全局 message listener 可能同时响应握手。

配置说明：

| 字段                   | 是否必需 | 行为                                                                           |
| ---------------------- | -------- | ------------------------------------------------------------------------------ |
| `allowedParentOrigins` | 是       | 非空的精确 HTTP(S) Origin 数组；host 还会检查 `event.source === window.parent` |
| `capabilities`         | 否       | 未传时经典 script helper 只开放 `['observe']`；需要写操作时必须显式列出        |
| `controllerOptions`    | 否       | 仅配置当前子页面的 `PageController`                                            |

### 6.4 按最小权限选择 capabilities

| capability           | 允许的行为                                                     |
| -------------------- | -------------------------------------------------------------- |
| `observe`            | 获取子页面标题、URL、滚动信息、脱水内容、索引和 `treeRevision` |
| `click`              | 点击最新观察结果中的指定索引                                   |
| `input`              | 向指定输入控件写入文本                                         |
| `select`             | 选择下拉选项                                                   |
| `scroll`             | 纵向滚动子页面文档或元素                                       |
| `scrollHorizontally` | 横向滚动子页面文档或元素                                       |
| `cleanup`            | 清理 controller 高亮                                           |

只读组件建议省略 `capabilities` 或明确使用：

```js
capabilities: ['observe']
```

如果父页面请求未授权能力，返回 `CAPABILITY_DENIED`。`executeJavascript` 永远不属于 bridge 能力，也不会被发送到子页面；父侧 PageAgent 的脚本执行工具只能作用于父页面本地 controller。

### 6.5 控制子页面暴露的数据

Origin 和 capability 控制“谁可以连接、可以做什么”，不负责内容脱敏。子页面 controller 放入浏览器状态的标题、URL、文本和属性会发送给允许的父页面。

应注意：

-   `includeAttributes` 只添加 Agent 确实需要的属性，不要加入 token、账号标识或敏感业务字段。
-   不要把长期凭证写入 DOM、iframe URL、data 属性或隐藏输入框。
-   可以通过 `interactiveBlacklist` 排除不应操作的区域，通过页面结构减少敏感内容进入可观察状态。
-   host 不会把 DOM 节点本身传给父页面，只传脱水文本、索引和页面状态。
-   只有在信任父页面时才把它加入 `allowedParentOrigins`。

### 6.6 处理子页面生命周期

```js
window.addEventListener('pagehide', function () {
    if (window.pageAgentFrameHost) {
        window.pageAgentFrameHost.dispose()
    }
})
```

`dispose()` 会关闭端口、取消请求、移除 listener，并默认 dispose 子页面 controller；重复调用安全。

iframe reload 或导航后，旧文档和旧 host 会被销毁。新文档必须重新加载 host IIFE 并调用 `startFrameBridge()`，从而生成新的 `frameInstanceId`。SPA 如果不发生完整文档导航，则应在应用卸载旧页面 controller 时主动 dispose，再创建新 host。

## 7. 一套完整的生产初始化顺序

推荐按以下顺序部署和初始化：

1.  子页面先部署 host IIFE 引用、`allowedParentOrigins`、最小 capability、CSP `frame-ancestors` 和兼容的 X-Frame-Options。
2.  确认子页面可以被主页面 Origin 正常嵌入，并且控制台没有 CSP、sandbox 或 mixed-content 错误。
3.  主页面部署自有 PageAgent bundle，确认它只暴露构造器而未提前用默认 controller 自动初始化。
4.  主页面部署 bridge IIFE，在目标 iframe 上增加专用 selector 标记，并配置 `allowedChildOrigins`。
5.  主页面创建 `FrameAwarePageController`。
6.  主页面准备 LLM provider、`model`、gateway 地址和短期凭证，用该 controller 创建唯一的 PageAgent 实例。
7.  根据产品形态显示 `agent.panel`，或把接入方自己的任务、停止和状态 UI 绑定到 `execute()`、`stop()` 和 `statuschange`。
8.  iframe `load` 后再允许用户启动任务。
9.  PageAgent 首次观察触发 discover/available/connect 握手，随后通过专用 `MessageChannel` 通信。
10. 页面卸载、SPA 路由替换或 Agent 重建时，双方分别 dispose；需要等待任务完全收敛时先 await `agent.stop()`。

父子之间使用 `postMessage` 和 `MessageChannel`，不需要为 bridge 本身配置 CORS。只有以下场景需要单独考虑 CORS：

-   主页面调用跨 Origin LLM gateway；
-   子页面自身调用业务 API；
-   跨域 CDN 脚本使用 SRI 和 `crossorigin="anonymous"`。

## 8. iframe 重载、索引与错误处理

父页面每次观察都会生成当前有效的聚合索引。子页面 reload、DOM 重建或重新观察后，旧索引可能失效：

-   收到 `invalidate` 后，不要继续使用之前保存的索引。
-   iframe reload 后，等待新文档 host 启动，再重新调用 `getBrowserState()` 或让 PageAgent 重新观察。
-   `STALE_TREE` 表示索引或 tree revision 已过期，应重新观察。
-   `CONNECTION_CLOSED`、`FRAME_MISMATCH` 通常表示 iframe 导航或连接已经替换，应重新观察。
-   `OUTCOME_UNKNOWN` 表示变更请求可能已经到达子页面并执行，但结果在导航、超时或取消过程中丢失。不要自动重试 click、input、select 等操作，应先重新观察并根据实际业务状态判断。

FrameAware controller 的 click/input/select/scroll 路由失败通常返回：

```js
{
    success: false,
    message: '包含稳定错误码的说明',
}
```

接入方直接调用 controller API 时既要处理 Promise 异常，也要检查 `success`。PageAgent 会通过 controller adapter 使用相同结果。

## 9. 常见故障排查

| 现象                                  | 常见原因                                                                              | 处理方式                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `PageAgent is unavailable`            | 自有 Agent bundle 未加载、未显式挂载全局对象或被 CSP 拒绝                             | 检查 script 顺序和 CSP；不要期待 bridge IIFE 提供 PageAgent                                                            |
| Agent 构造时报 LLM 配置缺失           | 缺少 `model`，或当前 provider 缺少 `baseURL`/`endpointAgent`                          | 按 4.3 的 provider 表补齐配置并核对 gateway                                                                            |
| `PageAgentFrameBridge is unavailable` | 父 IIFE 路径错误、CSP 拒绝、MIME 错误或版本目录不存在                                 | 检查 Network、`script-src`、SRI 和 `Content-Type`                                                                      |
| `PageAgentFrameHost is unavailable`   | 子 IIFE 未部署或被子页面 CSP 拒绝                                                     | 检查子页面 Network/Console 和 `script-src`                                                                             |
| PageAgent 能操作父页面但看不到子页面  | 创建 Agent 时没有传 `pageController: frameBridge.controller`，或旧 Agent 已自动初始化 | 关闭 auto-init，dispose 旧实例并用 bridge controller 重建                                                              |
| PageAgent 看不到同源 iframe 内部内容  | 当前版本普通 `PageController` 将同源 iframe 子文档视为 opaque leaf                    | 这是预期限制；如需支持子页面，请将其部署为跨域 direct child 并接入 host IIFE，或使用不依赖 iframe 子文档读取的页面流程 |
| Agent 一启动就报已有任务正在运行      | 在同一实例上并发调用了 `execute()`                                                    | 禁用重复提交，等待前一次 execute 收敛或先调用 `stop()`                                                                 |
| `CAPABILITY_DENIED` 出现在握手前      | iframe `src` Origin 不在 `allowedChildOrigins`                                        | 核对 scheme、host、port 和重定向后的 Origin                                                                            |
| `CAPABILITY_DENIED` 出现在动作时      | 子 host 没有开放对应 capability                                                       | 按最小权限补充所需 capability                                                                                          |
| `TIMEOUT`                             | 子 host 未启动、父 Origin 不在 allow-list、协议版本不兼容、CSP/sandbox 阻止脚本       | 逐项检查子脚本、`allowedParentOrigins`、父子版本和浏览器控制台                                                         |
| Origin 为 `null`                      | iframe sandbox 缺少 `allow-same-origin`，或使用 `data:`/`file:` 等 opaque URL         | 使用 HTTP(S) URL，并配置 `allow-scripts allow-same-origin`                                                             |
| iframe 直接加载成功但嵌入失败         | 子页面 `frame-ancestors` 或 X-Frame-Options 拒绝父页面                                | 修改子页面响应头，而不是添加 CORS                                                                                      |
| reload 后动作报 `STALE_TREE`          | 复用了旧索引                                                                          | 重新观察并使用新索引                                                                                                   |
| 远端 `executeJavascript` 被拒绝       | 该方法明确不属于 bridge                                                               | 只在父页面本地执行脚本，不要尝试扩展 postMessage 绕过                                                                  |

## 10. 上线验收清单

### 静态资源

-   [ ] 两份 IIFE 使用固定且一致的版本 URL。
-   [ ] 主页面自有 PageAgent bundle 已固定版本，且不会依赖 demo 默认配置。
-   [ ] JS 返回正确 MIME、缓存头和 SRI/CORS 配置。
-   [ ] 页面不依赖 `latest`、import map 或 `type="module"`。

### Agent

-   [ ] `window.PageAgent` 来自接入方自己的生产 bundle，而不是 bridge IIFE 或 demo 自动初始化。
-   [ ] provider 所需的 `model`、`baseURL`/`endpointAgent` 和 gateway CORS 已验证。
-   [ ] 长期模型凭证只保存在服务端，浏览器最多持有短期、低权限 token。
-   [ ] 页面只存在一个 PageAgent 实例，重复提交任务已被阻止。
-   [ ] 任务 UI 已正确处理 `execute()` 的返回值和 reject，并支持 `stop()`。
-   [ ] Panel 或自定义 `onAskUser`、状态监听和 dispose 生命周期已验证。
-   [ ] `experimentalScriptExecutionTool` 已按安全策略显式决定，且不依赖它操作子 iframe。

### 主页面

-   [ ] 只给明确授权的直接子 iframe 增加 selector 标记。
-   [ ] `allowedChildOrigins` 与 iframe 实际 Origin 完全一致。
-   [ ] 父 CSP `frame-src`、`script-src`、`connect-src` 已配置。
-   [ ] PageAgent 使用 `pageController: frameBridge.controller`，不存在旧的自动初始化 Agent。
-   [ ] `bridgeerror`、`invalidate` 和 dispose 已接入。

### 子页面

-   [ ] 子 CSP `frame-ancestors` 允许主页面，X-Frame-Options 不冲突。
-   [ ] sandbox 至少允许 scripts 和保留非 opaque Origin。
-   [ ] `allowedParentOrigins` 只包含受信任主页面。
-   [ ] capabilities 按最小权限配置，省略时确认确实只需 observe。
-   [ ] 子 bundle、DOM、URL 和 bridge 消息中没有模型密钥或长期凭证。
-   [ ] pagehide/SPA 卸载时 dispose，完整 reload 后新文档会重新启动 host。

### 功能验证

-   [ ] 正确 Origin 可以完成首次观察。
-   [ ] 错误父/子 Origin 无法握手。
-   [ ] observe 以及明确授权的 click/input/select/scroll 能力正常。
-   [ ] 未授权能力返回 `CAPABILITY_DENIED`。
-   [ ] iframe reload 后重新观察可以恢复连接。
-   [ ] `OUTCOME_UNKNOWN` 不会触发盲目自动重试。

## 11. 本地示例和进一步阅读

仓库内的双端口纯 HTML 示例位于 [`examples/iframe-bridge-script`](../examples/iframe-bridge-script/README.md)。运行：

```bash
npm run build:iife
```

然后按示例 README 分别在 `127.0.0.1:4173` 和 `127.0.0.1:4174` 启动静态服务器。

完整 ESM API、能力模型、消息安全、生命周期和错误语义见[跨域 iframe 协作桥接指南](./cross-origin-iframe-bridge.zh-CN.md)。
