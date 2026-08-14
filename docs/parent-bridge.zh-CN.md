# 父页面控制器桥接

> English: [Parent-page controller bridge](./parent-bridge.md)

`parent-bridge` 与现有 `iframe-bridge` 方向相反：助手运行在直接子 iframe
中，由父页面内（与父页面 DOM 同源的）host 观察和操作一个明确限定的 DOM 根节点。
子页面不会拿到父页面 `document` 引用；所有访问都经过 `postMessage` 和专用
`MessageChannel`，并受 origin、source、nonce、协议版本和能力白名单保护。

这是一个双方主动接入的协作协议。父页面必须安装 host，助手 iframe 必须安装
adapter。未安装 adapter 的跨域 iframe 不能绕过浏览器同源策略操作父页面 DOM。

## 运行本地 reverse parent-bridge Demo

仓库在 `packages/e2e/fixtures` 中提供了 reverse parent-bridge fixture。根命令会先构建
page-controller 库和 PageAgent Demo IIFE，再启动共享的 fixture server：

```bash
npm run demo:parent-bridge
```

如果已经完成构建，只需启动 workspace server，可以执行
`npm run demo:parent-bridge --workspace=@page-agent/e2e`。该命令启动现有的
`packages/e2e/server.mjs`：父页面 origin 为 `127.0.0.1:4173` 和 `127.0.0.1:4175`，
共享的助手 iframe origin 为 `127.0.0.1:4174`。在浏览器中打开任一父页面：

-   [http://127.0.0.1:4173/reverse-parent.html](http://127.0.0.1:4173/reverse-parent.html)
-   [http://127.0.0.1:4175/reverse-parent.html](http://127.0.0.1:4175/reverse-parent.html)

两个父页面会使用同一个助手 origin。父页面展示为完整的运营工作台，助手以右侧悬浮框形式
固定显示，桌面端宽度约占视口 25%、高度约占 80%。iframe 连接成功后，点击 **Run
PageAgent**，即可执行固定任务：点击父页面按钮，在 **Parent value** 输入 `PageAgent
Demo`，并把 **Parent plan** 选择为 `Pro`。iframe 仍保留观察、点击、输入、选择、滚动和
JavaScript 拒绝等低层手动控件，可直接练习 bridge。

助手中的 PageAgent IIFE 调用同源地址 `http://127.0.0.1:4174/api/tl`。fixture server
把 `/api/tl/chatbbc/init_session` 和 `/api/tl/chatbbc/chat` 反向代理到
`TL_ENDPOINT_AGENT`，默认值为 `http://localhost:8089`。运行 Demo 前请先启动该 TL 代理；
也可以显式覆盖上游，例如
`TL_ENDPOINT_AGENT=http://localhost:9089 npm run demo:parent-bridge`。浏览器只访问 `4174`，
继续使用原生 `fetch`，不设置 `customFetch`，也不需要 CORS。

自动化测试会设置 `PARENT_BRIDGE_DEMO_MOCK_TL=1`，用确定性的点击、输入、选择响应代替真实
上游；离线演示 Bridge 时也可以使用该开关，但它只是测试行为，不代表真实模型接入。完成后
按 `Ctrl-C` 停止 server；不要部署 demo server，也不要在生产环境复用测试策略。

## 安装与入口

```bash
npm install page-agent @page-agent/page-controller @page-agent/core @page-agent/llms
```

运行时使用窄入口：

```ts
import { PageController } from '@page-agent/page-controller'
import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'
import { ParentPageControllerAdapter } from '@page-agent/page-controller/parent-bridge/adapter'
import '@page-agent/page-controller/parent-bridge/host.css'
```

根入口 `parent-bridge` 只包含协议常量、校验函数和类型；需要运行时类时再导入
`/host` 或 `/adapter`。`page-agent` 提供同形 JavaScript facade；host CSS 仍按上例从
`@page-agent/page-controller` 导入。这样普通页面不会因为导入协议而拉入 DOM host、
Agent、LLM 或 UI。

## 父页面 host

父页面拥有 DOM controller，应只开放助手所需的根节点和能力。`root` 可以是元素，
也可以是页面替换根节点时会失败关闭的 resolver。

```ts
import { PageController } from '@page-agent/page-controller'
import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'

const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-page-agent-parent-bridge]')
if (!iframe) throw new Error('找不到 parent bridge iframe')

const host = new ParentPageControllerHost({
    iframe,
    assistantOrigin: 'https://assistant.example.com',
    root: () => document.querySelector('#checkout-root'),
    scopeId: 'checkout',
    capabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup', 'visual'],
    controllerOptions: { enableMask: false },
    visualFeedback: 'non-blocking',
    actionPolicy: ({ target }) =>
        target?.matches('[data-checkout-payment], [data-permission-change]')
            ? { decision: 'approval_required', reason: '敏感业务操作' }
            : { decision: 'allow' },
    getEmbedPolicy: async () =>
        await fetch('/api/parent-bridge/embed-policy', { credentials: 'same-origin' }).then(
            (response) => {
                if (!response.ok) throw new Error(`策略请求失败（${response.status}）`)
                return response.text()
            }
        ),
    verifyEmbedPolicy: async (policy, context) => verifySignedPolicy(policy, context),
})

host.start()
// SPA 销毁或页面替换时：host.dispose()
```

`visualFeedback: 'non-blocking'` 会同时启用父页面状态条和固定定位的模拟光标。光标监听
PageController 已有的 `PageAgent::MovePointerTo` 与 `PageAgent::ClickPointer` 事件，只在
事件坐标命中受信 Root 时显示，并始终使用 `pointer-events: none`；点击时播放短暂的 ripple
动画。父页面导航、iframe reload、Root 替换或移除以及 `host.dispose()` 都会隐藏或移除
光标。如父页面不允许增加任何反馈 DOM，请使用 `visualFeedback: 'none'`。

使用 `PageAgentCore` 时，必须让 `observe` 和 `cleanup` 通过每一道能力门禁：Host 配置、
签名 Policy claims、子 Adapter 请求，以及 `authorizeOffer` 返回的能力集合。`cleanup` 不会
随 `observe` 自动授权；缺少它时，Core 的结束清理请求会被拒绝，父页面上的索引高亮将继续
保留。启用 `visualFeedback: 'non-blocking'` 时还应加入 `visual`。

默认光标与 `main` 分支保持一致：75px 白色 PageAgent 箭头、蓝紫渐变描边、相同的西北
朝向以及 300ms 蓝色点击 ripple。目标系统可以只覆盖 CSS 变量完成品牌配置，无需修改
运行时代码：

```css
:root {
    --page-agent-parent-cursor-width: 75px;
    --page-agent-parent-cursor-height: 75px;
    --page-agent-parent-cursor-fill: #fff;
    --page-agent-parent-cursor-gradient-start: rgb(57, 182, 255);
    --page-agent-parent-cursor-gradient-end: rgb(189, 69, 251);
    --page-agent-parent-cursor-ripple-color: rgb(57, 182, 255);
    --page-agent-parent-cursor-ripple-width: 4px;
    --page-agent-parent-cursor-move-duration: 90ms;
    --page-agent-parent-cursor-click-duration: 300ms;
}
```

箭头尖端与 ripple 圆心都使用实际动作坐标。除非自定义图形具有不同热点，否则不要设置
正数 cursor offset。

`verifySignedPolicy` 是业务代码，应验证短期策略的签名、audience、过期时间、父子
origin、`scopeId`、协议版本和能力。不要接受 URL 查询参数中的任意 origin。父页面
也可以加载独立 IIFE：

```html
<script src="/assets/page-agent-parent-host.iife.min.js"></script>
<script>
    const iframe = document.querySelector('iframe[data-page-agent-parent-bridge]')
    const host = new PageAgentParentHost.ParentPageControllerHost({
        iframe,
        assistantOrigin: 'https://assistant.example.com',
        root: () => document.querySelector('#checkout-root'),
        scopeId: 'checkout',
        capabilities: ['observe', 'click', 'input', 'cleanup'],
        getEmbedPolicy: async () => fetch('/api/parent-bridge/embed-policy').then((r) => r.text()),
        verifyEmbedPolicy: (policy, context) => verifySignedPolicy(policy, context),
    })
    host.start()
</script>
```

该 IIFE 只包含 `ParentPageControllerHost`、helper 和 `PageController`，不包含
PageAgent Core、LLM 或 UI。

## 子页面 adapter

子页面声明请求的能力，并只接受预期父 origin 的 offer：

```ts
import { ParentPageControllerAdapter } from '@page-agent/page-controller/parent-bridge/adapter'

const expectedParentOrigin = 'https://app.example.com'
const adapter = new ParentPageControllerAdapter({
    requestedCapabilities: ['observe', 'click', 'input', 'cleanup', 'visual'],
    authorizeOffer: async (offer, actualParentOrigin, signal) => {
        if (signal.aborted || actualParentOrigin !== expectedParentOrigin) return undefined
        return {
            parentOrigin: actualParentOrigin,
            policyId: offer.policyId,
            capabilities: offer.capabilities,
            authorizationContext: {
                // Tl 后端与助手使用同一 origin；保持 URL 绝对且显式。
                tlEndpoint: new URL('/api/tl', window.location.origin).toString(),
                model: 'assistant-model',
            },
        }
    },
    onApprovalRequired: async (request) => await confirm(`允许 ${request.method}？`),
})

await adapter.connect()
try {
    const state = await adapter.getBrowserState()
    await adapter.clickElement(state.indices[0])
} finally {
    // 直接使用 Adapter 时，没有 PageAgentCore 的任务级 finally 清理。
    try {
        await Promise.allSettled([adapter.cleanUpHighlights(), adapter.hideMask()])
    } finally {
        adapter.dispose()
    }
}
```

adapter 提供完整的 indexed controller 形状方法。为保持结构兼容，仍有
`executeJavascript` 方法，但始终返回确定性的 `CAPABILITY_DENIED` 结果；parent bridge
永远不会执行 child 提供的 JavaScript。导航后只有在 offer、策略、origin、frame instance
和 challenge 都重新通过校验时才会建立连接。

### 策略、规则和一次性审批

`verifyEmbedPolicy` 与签名策略才是授权依据。可选的
`data-page-agent-policy="deny|confirm|allow"` 属性是本地业务风险标记：`confirm` 映射
为 `approval_required`，优先级为 `deny > confirm > allow`。它绝不能承载 `policyId`、
origin、Bearer token 或 capability 授权；签名策略的 `jti` 是独立的防重放值。删除/支付/
权限变更目标应通过 selector 与 `actionPolicy` 显式配置，不能根据按钮可见文案推断风险。

每个请求按以下顺序检查：认证 session 与精确 origin/source；协议/session/frame/challenge
及策略时效；签名允许的 capability 与方法；root 包含关系和当前 tree revision；最后才是
host `actionPolicy`。策略只能收紧权限：`deny` 优先于 `approval_required`，后者优先于
`allow`；child 审批不能新增 capability，也不能覆盖 host 拒绝。

遇到 `approval_required` 时展示包含脱敏 method/capability/target 摘要的确认框。审批必须
绑定单个 `approvalId` 与 `requestId`，在等待 UI 前标记已消费；超时、导航或关闭都拒绝，
禁止批量自动同意或重放审批响应。

## Vue 3 composable（可选接入代码）

Vue 不属于 Page Agent 依赖。以下代码应放在助手应用中，由应用自行安装 Vue：
包含 Core + Tl、审批和降级状态的完整示例见
[`examples/parent-bridge/use-page-agent.ts`](../examples/parent-bridge/use-page-agent.ts)。

```ts
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { ParentControllerAdapterOptions } from '@page-agent/page-controller/parent-bridge/adapter'

type ParentAdapter = InstanceType<
    typeof import('@page-agent/page-controller/parent-bridge/adapter').ParentPageControllerAdapter
>

export function useParentPageController(options: ParentControllerAdapterOptions) {
    const adapter = shallowRef<ParentAdapter | null>(null)
    const connected = ref(false)
    const error = ref<unknown>(null)
    let disposed = false

    const connect = async () => {
        if (disposed) return false
        error.value = null
        try {
            const { ParentPageControllerAdapter } = await import(
                '@page-agent/page-controller/parent-bridge/adapter'
            )
            if (disposed) return false
            const instance = new ParentPageControllerAdapter(options)
            adapter.value = instance
            await instance.connect()
            if (disposed) {
                instance.dispose()
                return false
            }
            connected.value = true
            return true
        } catch (cause) {
            connected.value = false
            error.value = cause
            throw cause
        }
    }
    onMounted(() => void connect())
    onBeforeUnmount(() => {
        disposed = true
        adapter.value?.dispose()
        adapter.value = null
        connected.value = false
    })
    return { adapter, connected, error, connect }
}
```

路由切换时用 `AbortController` 取消正在进行的连接或动作，并在 iframe 移除后
释放 adapter。

助手的历史记录只应展示安全字段。若助手自行创建 `AgentConfig`，生产默认值应保持
两个敏感数据开关关闭，并只把需要展示的字段映射到 Vue：

```ts
const agentConfig = {
    debug: false,
    includeRawHistory: false,
}
```

不要把原始请求/响应对象、页面派生文本或授权元数据直接绑定到响应式历史组件。

如果助手还持有 `PageAgentCore`，必须按生命周期顺序清理：先停止使进行中的任务
settle，再 dispose agent（它会通过 controller contract dispose adapter）：

默认部署让 Vue 助手 iframe 与 Tl 后端使用完全相同的 origin。Tl 会直接使用浏览器
原生 `fetch`，因此不要设置 `customFetch`。`endpointAgent` 必须保持为绝对的同源 URL，
避免请求意外发往其他 origin：

```ts
import { PageAgentCore } from '@page-agent/core'

const parentController = adapter.value
if (!parentController) throw new Error('Parent controller 尚未连接')

const agent = new PageAgentCore({
    pageController: parentController,
    provider: 'tl',
    endpointAgent: new URL('/api/tl', window.location.origin).toString(),
    model: 'assistant-model',
    toolCallingMode: 'system_prompt',
    tlSystemPromptVariableName: 'system_prompt',
    experimentalScriptExecutionTool: false,
    experimentalLlmsTxt: false,
    debug: false,
    includeRawHistory: false,
})

onBeforeUnmount(async () => {
    await agent.stop()
    agent.dispose()
})
```

清理完成后不要再使用 `agent` 或 `adapter`。

## 可选的带认证 Tl 网关 fetch

上面的默认同源 Tl 接入使用原生 `fetch`，不需要自定义 fetch 实现。只有在同源 API
仍明确要求 Bearer、tenant/target/session header、token 刷新或其他请求定制时，才使用
示例目录中的
[`authenticated-tl-fetch.ts`](../examples/parent-bridge/authenticated-tl-fetch.ts)
这个框架无关、可注入 fake fetch 测试的 `customFetch` helper。长期凭证应保留在受信
服务端，浏览器只拿短期 token：

```ts
import { TlAiClient } from '@page-agent/llms'
import { createAuthenticatedFetch } from '../examples/parent-bridge/authenticated-tl-fetch'

const customFetch = createAuthenticatedFetch({
    token: ({ signal }) => authStore.getAccessToken({ signal }),
    refreshToken: async ({ signal, reason }) => authStore.refreshAccessToken({ signal, reason }),
    refreshSkewMs: 30_000,
    headers: () => ({
        'X-Tenant-Id': tenantId,
        'X-Target-Id': targetId,
        'X-Page-Agent-Session': sessionId,
    }),
})

const client = new TlAiClient({
    endpointAgent: new URL('/api/tl', window.location.origin).toString(),
    model: 'assistant-model',
    customFetch,
})
```

helper 原样返回 `Response`，JSON 可调用 `response.json()`，SSE 可消费
`response.body`。token provider 可返回 `{ value, expiresAt }`；距离过期不超过
`refreshSkewMs`（默认 30 秒）时会在首发前刷新，401 仍最多重放一次。它传播
`AbortSignal`，只注入 Bearer header，并支持 tenant/target/session headers provider。
生产环境不要在 parent-host IIFE 或 iframe URL 中放 token。该 helper 是可选方案，本部署
仍要求 `endpointAgent` 使用绝对的同源 URL。

## 部署与安全检查表

-   父子页面使用 HTTPS；allow-list 只写精确 scheme/host/port，拒绝 `*`、`null`、
    路径、查询串和凭证。
-   双方校验 `event.origin`、`event.source`、协议版本、session/frame ID、challenge/
    nonce、payload schema 和 capability。
-   子页面响应设置 CSP `frame-ancestors`，父页面 CSP `frame-src` 只允许助手 origin；
    冲突的 `X-Frame-Options` 会在脚本运行前阻止嵌入。
-   host 要求跨源助手 iframe 显式设置 `sandbox="allow-scripts allow-same-origin"`；
    未设置 sandbox 或增加其他 sandbox 权限都会被拒绝；同源 iframe 同时开启这两个 token
    也不能当作隔离边界。
-   用 `root` 限制 DOM，用最小 capability，并在送给助手/LLM 前脱敏文本和属性。
-   scoped 抽取默认移除 `value`/`defaultValue`、密码、一次性验证码、token 命名字段和
    `data-page-agent-sensitive` 内容；其余业务文本、label、URL 或标识符应在跨 iframe 前通过
    `transformState` 继续脱敏。
-   scoped root 只包含其后代；root 自身是 synthetic boundary，嵌套 iframe 文档仍是独立
    边界（跨源时更严格），渲染到 `document` 其他位置的 portal/popover 不会被包含。需要
    操作 portal 控件时应挂载明确的应用 root，不能默默扩大到整个 document。
-   host 是可选部署组件。没有 host 时 adapter 应超时或收到 `EMBED_POLICY_DENIED`；应
    降级为助手本地功能并禁用 parent action，绝不能回退到直接 DOM 或假定同源。
-   将错误视为状态变化而非自动重试提示：`ROOT_UNAVAILABLE` 需重新解析 root 或销毁，
    `STALE_TREE` 需重新 observe 后再使用 index，`OUTCOME_UNKNOWN` 表示变更请求可能已经
    执行，禁止重放。只有新 offer/session 和重新验证策略后才能重连。
-   生产环境不要开启 `AgentConfig.debug`/`LLMConfig.debug` 或
    `AgentConfig.includeRawHistory`。debug 日志和原始历史可能包含请求、响应、SSE、
    页面派生文本、用户输入和授权元数据；自定义 `failureLogger` 也会收到敏感原始条目，
    必须自行脱敏或保护。
-   iframe 导航、策略变化、root 替换或卸载时释放旧连接；`OUTCOME_UNKNOWN` 后先重新
    观察，不要盲目重试变更操作。

### 签名策略与后端一次性交换

父侧 `verifyEmbedPolicy` 至少应验证短期签名 token 的以下 claim：`jti`、精确的
`parentOrigin`、`assistantOrigin`、`scopeId`、允许的 `cap` 列表、
`protocolVersionMin`/`protocolVersionMax` 以及 `nbf`/`exp`。影响授权时再绑定 `tenant`、
`user`、`targetId`。子侧执行 `authorizeOffer` 时，应把完整且已验证的 offer 交给可信后端；
后端必须原子地一次性消费 `jti`，并把交换绑定到实际父 Origin 以及 offer 中的 `sessionId`、
`challenge` 和 `frameInstanceId`。重复使用、过期、audience/origin 不符都应拒绝。Bearer
凭证不要放进策略文本、iframe URL 或 postMessage payload，只把短期 authorization context
返回给应用回调。

### 版本化 IIFE 部署与 CSS

固定具体 package/version 或内容寻址资源，禁止部署 `latest`。parent host IIFE 会导入独立
的 `page-agent-parent-host.css`；两个资源应来自同一固定版本，并用 SRI 保护（占位 hash
需在发布时生成）：

```html
<link
    rel="stylesheet"
    href="/assets/page-agent-parent-host/1.12.2/page-agent-parent-host.css"
    integrity="sha384-RELEASE_GENERATED_CSS_HASH"
    crossorigin="anonymous"
/>
<script
    src="/assets/page-agent-parent-host/1.12.2/page-agent-parent-host.iife.min.js"
    integrity="sha384-RELEASE_GENERATED_JS_HASH"
    crossorigin="anonymous"
></script>
```

状态条和光标都仅用于展示并始终 `pointer-events: none`；不要换成阻塞式遮罩，也不要由
JavaScript 注入 style 标签。状态条和光标都依赖外部 Host 样式文件。
浏览器背景可参考 [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy)、
[`postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)、
[`sandbox`](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)、
CSP [`frame-ancestors`](https://www.w3.org/TR/CSP/#directive-frame-ancestors) 与 MDN 的
[Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)。
