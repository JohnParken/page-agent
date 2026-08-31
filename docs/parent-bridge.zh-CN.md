# 父页面控制器桥接

> English: [Parent-page controller bridge](./parent-bridge.md)

`parent-bridge` 与现有 `iframe-bridge` 方向相反：助手运行在直接子 iframe
中，由父页面内（与父页面 DOM 同源的）host 观察和操作一个明确限定的 DOM 根节点。
子页面不会拿到父页面 `document` 引用；所有访问都经过 `postMessage` 和专用
`MessageChannel`，并受 origin、source、nonce、协议版本和能力白名单保护。

这是一个双方主动接入的协作协议。父页面必须安装 host，助手 iframe 必须安装
adapter。未安装 adapter 的跨域 iframe 不能绕过浏览器同源策略操作父页面 DOM。

准备生产接入时，请先按[iframe PageAgent 生产部署手册：P / A / B 职责](./parent-bridge-production-deployment.zh-CN.md)
完成跨团队责任划分、生产缺口检查、部署顺序和验收矩阵。
V1 P0 的冻结默认值和风险接受见
[ADR-0001](./adr/0001-parent-bridge-auth-v1-p0-baseline.zh-CN.md)。

## 逻辑 A、浏览器实例与授权边界

本文的图和代码示例都只表示一个运行时切片。生产环境中每个环境只有一个逻辑 A 系统，即一个
登记的 AssistantApp 和一套助手产品能力；A 后端可以有多个 HA 副本。每个 P 页面嵌入的 A iframe
则是独立浏览器文档和运行时实例，因此多个 P、同一 P 的不同租户以及同一浏览器的多个标签页可以
同时使用这个逻辑 A，而不共享 bridge 连接。

每个 P Host/对应 A iframe 运行时必须拥有独立的 bridge 状态和一个独立的 integration-aware auth
client；A iframe 内的 Adapter 状态同样只属于当前文档。activation、binding、policy/context、
session 和 instance 标识只保存在该运行时内存中，不得放入共享 `localStorage`。同源 A iframe
可以按现有登录方案共享 A 登录 JWT，但 JWT 只证明登录态，不能标识 bridge 实例、租户、scope、
target 或 session。

生产配置中的几个标识承担不同职责：

-   `tenantId`（或 canonical subject 中的等价租户声明）来自 P/A 服务端 session，定义当前主体的
    租户边界；浏览器自报值不可信。租户默认不单独创建 Integration。
-   `scopeId` 是 `parentApp × assistantApp × environment × scope` Integration 和 Host 固定的 DOM
    委托边界；不同 scope 使用分别匹配的 Integration、Host 配置和 bridge 连接。
-   `targetId` 是 P BFF 从业务会话解析的本次业务目标，不是 B 的 frame ID。B 由已登记的
    ChildTarget ID 标识，并另外受精确 origin、capability 和 B ACL 约束。
-   一个 bridge session 只绑定一个 canonical subject/tenant、一个 Integration/`scopeId`、一个
    `targetId` 以及一组 session/frame/host instance 标识。单连接不能跨租户、scope、target 或
    iframe 实例；当前也没有跨 scope 原子操作 API。

一个 P/Integration 可以登记多个 B ChildTarget，P BFF 再按当前 tenant/target 和业务 ACL 选择
当前 Grant 的子集；一个 Grant 最多 8 个 B target。获准 B 之间的操作和模型多步都复用同一个
A↔P bridge session，不为每个 B 或每次模型调用另做握手。实际权限是以下交集：

```text
Integration maximum
∩ P BFF tenant/business ACL
∩ Grant subset
∩ B final ACL
```

登出、tenant/target 切换、scope 变化、A iframe reload 或新文档加载都会使旧 activation 不再可用：
先 deactivate/dispose 旧运行时，再由用户对新上下文显式连接。不能从登录 JWT、`localStorage` 或
兄弟 iframe 恢复旧 bridge context。

### V1 服务身份与 ActiveLease P0 合同

浏览器只能调用自身同源 BFF：P runtime→P BFF，A runtime→A BFF；两个 BFF 才能访问 Auth，
browser→Auth 必须被路由、CSP 和网络 ACL 阻断。当前受控内网 V1 的 BFF→Auth 没有 mTLS、
service JWT、caller authentication 或应用级 actor enforcement。代码合同中的 actor 是 P/A 与
Auth 双边固定、仅用于配置选择、路由和审计的逻辑元数据；Auth 不校验实际调用方或方向真伪，
不以 actor 作为身份、授权或请求拒绝依据，actor 也不得取自浏览器。任何能访问 Auth 的内部服务都可
使用已知配置冒充 P/A，这是本目标明确接受的剩余风险。

P/A BFF 分别从自身受保护 session 生成并严格匹配 canonical subject
`{ issuer, tenant, user }`；P BFF 还负责推导 `targetId`、`scopeId`、Integration 和业务 ACL。
环境内 app、Integration、ChildTarget 等 ID 必须唯一，Registry/config 语义固定且以
configVersion 版本化。B 不调用 Auth，V1 也不把 canonical subject 传入 B；B 后端仍以自身登录态
执行最终 ACL。

生产 P0 要求 exchange 在共享原子 store 中原子消费一次性 Grant 并创建 `ACTIVE` lease：policy
TTL 为 120 秒、硬上限 300 秒；lease 固定 900 秒且不续期，lease/context 最大 3600 秒并且不超过
上游凭据剩余寿命；时钟偏差预算为 5 秒。P 和 A runtime 分别只经自己的同源 BFF，每 30 秒 ±20%
（24–36 秒）查询一次；BFF 再查 Auth。

`REVOKED` 或 `EXPIRED` 必须立即失败关闭；连续 90 秒没有得到明确、肯定的 `ACTIVE`（包括超时、
网络错误或 unknown）也必须失败关闭。两种路径都要清除 activation/连接，安全 abort 或 settle
pending request、审批和模型任务，并禁止自动 reconnect。恢复只能由 A 用户显式 `connect()`，
重新 issue/exchange 并创建新 lease。logout、user/tenant/target/scope 变化、权限/config disable、
Integration 禁用和 kill switch 都要求 BFF/Auth revoke；`deactivate()` 只是清理信号，不能替代
权威撤销。

**实现状态：** 当前 `parent-bridge/integration-auth` 只实现一次性 Grant 的
issue/consume/revoke，没有 ActiveLease、固定 900 秒状态、P/A BFF status endpoint 或 runtime
polling。上述合同是生产接入待实现的 P0 release gate；本指南不会虚构尚不存在的 library 选项或
调用方法。

## 运行本地 reverse parent-bridge Demo

仓库在 `packages/e2e/fixtures` 中提供了 reverse parent-bridge fixture。根命令会先构建
page-controller 库和 PageAgent Demo IIFE，再启动共享的 fixture server：

```bash
npm run demo:parent-bridge
```

如果已经完成构建，只需启动 workspace server，可以执行
`npm run demo:parent-bridge --workspace=@page-agent/e2e`。该命令启动现有的
`packages/e2e/server.mjs`：父页面 origin 为 `127.0.0.1:4173` 和 `127.0.0.1:4175`，
共享的助手 iframe origin 为 `127.0.0.1:4174`，另有独立的协作业务 iframe origin
`127.0.0.1:4176`。在浏览器中打开任一父页面：

-   [http://127.0.0.1:4173/reverse-parent.html](http://127.0.0.1:4173/reverse-parent.html)
-   [http://127.0.0.1:4175/reverse-parent.html](http://127.0.0.1:4175/reverse-parent.html)

两个父页面会使用同一个助手 origin。父页面展示为完整的运营工作台，助手以右侧悬浮框形式
固定显示，桌面端宽度约占视口 25%、高度约占 80%。先在 A 中点击 **Connect to parent**；
只有这个显式操作会启动首次 P↔A 授权握手。连接成功后点击 **Run PageAgent**，即可执行固定
任务：点击父页面按钮，在 **Parent value** 输入 `PageAgent
Demo`，把 **Parent plan** 选择为 `Pro`，再点击获授权业务 iframe 的 **Release shipment**
并经一次性审批填写 **Approval note**。iframe 仍保留观察、点击、输入、选择、滚动和
JavaScript 拒绝等低层手动控件，可直接练习 bridge。观察状态还会包含明确授权的业务
iframe，因此可以完整验证助手（A）→ 父页代理（P）→ 业务 iframe（B）的路由，但 A 不会
获得直接访问 B 的权限。

助手中的 PageAgent IIFE 调用同源地址 `http://127.0.0.1:4174/api/tl`。fixture server
把 `/api/tl/chatbbc/init_session` 和 `/api/tl/chatbbc/chat` 反向代理到
`TL_ENDPOINT_AGENT`，默认值为 `http://localhost:8089`。运行 Demo 前请先启动该 TL 代理；
也可以显式覆盖上游，例如
`TL_ENDPOINT_AGENT=http://localhost:9089 npm run demo:parent-bridge`。浏览器只访问 `4174`，
继续使用原生 `fetch`，不设置 `customFetch`，也不需要 CORS。

Demo 的 bridge 授权使用 PageAgent 托管的一次性 opaque token、P 同源签发接口和 A 同源在线
核销接口；静态 demo 身份及内存 token store 只用于单进程验证，不能直接用于生产。自动化测试会
设置 `PARENT_BRIDGE_DEMO_MOCK_TL=1`，用确定性的点击、输入、选择响应代替真实
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
import { createIntegrationAwareManagedEmbedAuthClient } from '@page-agent/page-controller/parent-bridge/integration-auth'
import '@page-agent/page-controller/parent-bridge/host.css'
```

根入口 `parent-bridge` 只包含协议常量、校验函数和类型；需要运行时类时再导入
`/host` 或 `/adapter`。`page-agent` 提供同形 JavaScript facade；host CSS 仍按上例从
`@page-agent/page-controller` 导入。这样普通页面不会因为导入协议而拉入 DOM host、
Agent、LLM 或 UI。

## 父页面 host

父页面拥有 DOM controller，应只开放助手所需的根节点和能力。`root` 可以是元素，
也可以是页面替换根节点时会失败关闭的 resolver。

下面的 `managedAuth` 与 `host` 只服务这一个 iframe 运行时。页面中存在多个 A iframe 时，应为
每个 iframe 分别创建这一对对象；不要复用 `managedAuth` 当前 Grant 或 Host session。

```ts
import { PageController } from '@page-agent/page-controller'
import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'

const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-page-agent-parent-bridge]')
if (!iframe) throw new Error('找不到 parent bridge iframe')

const managedAuth = createIntegrationAwareManagedEmbedAuthClient({
    endpoint: '/api/parent-bridge/embed-policy',
    expectedIntegrationId: 'checkout-p__shared-assistant',
    expectedParentAppId: 'checkout-p',
    expectedAssistantAppId: 'shared-assistant',
    expectedParentOrigin: window.location.origin,
    expectedAssistantOrigin: 'https://assistant.example.com',
    expectedScopeId: 'checkout',
    expectedIssuer: 'page-agent-auth',
    allowedCapabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup', 'visual'],
})

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
    getEmbedPolicy: (context) => managedAuth.getEmbedPolicy(context),
    verifyEmbedPolicy: (policy, context) => managedAuth.verifyEmbedPolicy(policy, context),
})

host.start()
// SPA 销毁或页面替换时：host.dispose()
```

`host.start()` 默认是被动的：它只安装 P 侧监听器，不申请 policy，也不主动发送 offer。只有已绑定
A iframe 调用 `adapter.connect()` 发出 bootstrap 请求后，P 才首次 issue policy。
`handshakeMode: 'parent-initiated'` 仅保留一个版本用于旧接入迁移，新接入不得使用它恢复自动握手。

`visualFeedback: 'non-blocking'` 会同时启用父页面状态条和固定定位的模拟光标。光标监听
PageController 已有的 `PageAgent::MovePointerTo` 与 `PageAgent::ClickPointer` 事件，只在
事件坐标命中受信 Root 时显示，并始终使用 `pointer-events: none`；点击时播放短暂的 ripple
动画。父页面导航、iframe reload、Root 替换或移除以及 `host.dispose()` 都会隐藏或移除
光标。如父页面不允许增加任何反馈 DOM，请使用 `visualFeedback: 'none'`。

使用 `PageAgentCore` 时，必须让 `observe` 和 `cleanup` 通过每一道能力门禁：Host 配置、
已验证 Policy claims、子 Adapter 请求，以及 `authorizeOffer` 返回的能力集合。`cleanup` 不会
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

integration-aware client 默认只接受同源 HTTPS 接口返回的精确 `{ policy, claims }` 配对，检查
Integration/app/configVersion、时效、完整 bridge binding、父子 origin、`scopeId`、协议版本和
能力，并确保 `verifyEmbedPolicy` 收到的仍是同一个 token 及浏览器上下文。Host 会在签发前把新建
的 binding 传给 `getEmbedPolicy(context)`；真正的用户和业务权限由 P 后端完成，A 后端还必须
在线核销。浏览器请求不携带 user、tenant、issuer 或 service actor。
不要接受 URL 查询参数中的任意 origin。如果改用 ES256/JWKS，则把这两个回调替换为业务验签
实现。父页面也可以加载独立 IIFE：

受控内网需要 HTTP 时，Auth 全局风险门、对应 Integration 的 `transportMode` 和 P 的
`createIntegrationAwareManagedEmbedAuthClient` 必须同时显式启用；默认拒绝 HTTP。
这只允许精确 `http:` origin，不提供传输加密，也不防御内网中间人。完整约束参见
[生产部署手册的内网 HTTP 配置](./parent-bridge-production-deployment.zh-CN.md#受控内网-http-配置)。

```html
<script src="/assets/page-agent-parent-host.iife.min.js"></script>
<script type="module">
    import { createIntegrationAwareManagedEmbedAuthClient } from '/assets/parent-bridge/integration-auth.js'
    const managedAuth = createIntegrationAwareManagedEmbedAuthClient({
        endpoint: '/api/parent-bridge/embed-policy',
        expectedIntegrationId: 'checkout-p__shared-assistant',
        expectedParentAppId: 'checkout-p',
        expectedAssistantAppId: 'shared-assistant',
        expectedParentOrigin: window.location.origin,
        expectedAssistantOrigin: 'https://assistant.example.com',
        expectedScopeId: 'checkout',
        expectedIssuer: 'page-agent-auth',
        allowedCapabilities: ['observe', 'click', 'input', 'cleanup'],
    })
    const iframe = document.querySelector('iframe[data-page-agent-parent-bridge]')
    const host = new PageAgentParentHost.ParentPageControllerHost({
        iframe,
        assistantOrigin: 'https://assistant.example.com',
        root: () => document.querySelector('#checkout-root'),
        scopeId: 'checkout',
        capabilities: ['observe', 'click', 'input', 'cleanup'],
        getEmbedPolicy: (context) => managedAuth.getEmbedPolicy(context),
        verifyEmbedPolicy: (policy, context) => managedAuth.verifyEmbedPolicy(policy, context),
    })
    host.start()
</script>
```

该 Host IIFE 只包含 `ParentPageControllerHost`、helper 和 `PageController`，不包含
PageAgent Core、LLM 或 UI；integration-aware Auth helper 仍使用独立、可固定版本的 ESM 入口。

## 代理明确授权的同级业务 iframe

父页 host 可以选择把助手 iframe（A）的操作代理到一个主动协作的跨域业务 iframe（B）。
父页面（P）始终是唯一代理：A 不能直接寻址同级 iframe，B 也不信任 A 的 origin。每个 B
都必须显式配置，并要求应用自己的策略校验器返回完全匹配的已验证授权：

```ts
const host = new ParentPageControllerHost({
    // ...常规 iframe、origin、root、capability 和策略配置...
    childFrames: {
        targets: [
            {
                id: 'fulfilment-app',
                iframe: () => document.querySelector<HTMLIFrameElement>('#fulfilment-frame'),
                origin: 'https://fulfilment.example.com',
                capabilities: ['observe', 'click', 'input', 'cleanup'],
            },
        ],
    },
    // 校验器必须原样返回授权服务覆盖的 claims，其中包括 childFrames；
    // 禁止在验证完成后追加授权。
    verifyEmbedPolicy: (policy, context) => managedAuth.verifyEmbedPolicy(policy, context),
    actionPolicy: ({ target, targetContext }) => {
        if (targetContext.kind === 'child-frame') {
            return targetContext.frameId === 'fulfilment-app'
                ? { decision: 'approval_required', reason: '操作履约应用' }
                : { decision: 'deny' }
        }
        return target?.matches('[data-permission-change]')
            ? { decision: 'approval_required' }
            : { decision: 'allow' }
    },
})
```

对于上述配置，授权服务返回的 claims 应在执行 `verifyEmbedPolicy` 前就包含以下授权：

```json
{
    "childFrames": [
        {
            "id": "fulfilment-app",
            "origin": "https://fulfilment.example.com",
            "cap": ["observe", "click", "input", "cleanup"]
        }
    ]
}
```

B 必须运行兼容的 iframe bridge v2 `FrameBridgeHost`，只允许 P 的精确 origin，并仅声明
它愿意接受的 capability。配置目标只有在 ID、精确 origin 和 capability 同时匹配已验证的
`childFrames` claim、parent host capability 与 B 声明的 capability 时才可用。验证后再追加或
修改 grant 会绕过业务授权，审查时必须拒绝。已验证 claim
未包含 `childFrames` 时会明确降级为仅操作父页本地 root。已配置但未获授权的 B 内容
不会暴露；已授权但暂时不可连接的 B 只显示 unavailable 标记；未配置的 iframe 永不发现。

同一 P/Integration 可以配置多个这样的 ChildTarget；P BFF 只为当前 canonical tenant/target
选择 Grant 子集，单个 Grant 上限为 8。第 9 个 target 必须使签发失败，不能被静默截断或在验证
后由前端追加。Grant 内多个 B 共用当前 A↔P bridge session，但每个 B 仍保留自己的最终 ACL。

B 不接触 opaque policy 或 ActiveLease，也不直接调用 Auth。V1 bridge 不把 P/A canonical subject
传给 B；B 必须用自己的用户 session、tenant、对象权限、CSRF 和业务状态执行最终 ACL，不能把
P 的代理动作当作已认证主体。

操作 B 前，P 先用脱敏摘要请求 B prepare。B 的策略、父页元素策略与父页自定义
`actionPolicy` 按 `deny` > `approval_required` > `allow` 合并；助手只为合并后的结果展示至多
一次审批，然后 P commit B 的一次性 action token。A 和 P 都不能覆盖 B 的 deny，B 的
prepare 策略通过前也不会收到原始输入。B reload 或替换后，连接、tree revision 与旧全局
索引都会失效，必须重新观察后再操作。

该代理只支持 trusted root 内明确配置的直接跨域 iframe；不会读取同源 iframe 子文档，不会
递归发现任意 nested frame，也不会把助手变成通用 frame router。父页 CSP 的 `frame-src`
需要同时允许 A 与 B；A、B 分别在 `frame-ancestors` 中允许 P。

## 子页面 adapter

子页面声明请求的能力，并只接受预期父 origin 的 offer：

```ts
import { ParentPageControllerAdapter } from '@page-agent/page-controller/parent-bridge/adapter'

const expectedParentOrigin = 'https://app.example.com'
const adapter = new ParentPageControllerAdapter({
    requestedCapabilities: ['observe', 'click', 'input', 'cleanup', 'visual'],
    authorizeOffer: async (offer, actualParentOrigin, signal) => {
        if (signal.aborted || actualParentOrigin !== expectedParentOrigin) return undefined
        const response = await fetch('/api/parent-bridge/authorize-offer', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                policy: offer.policy,
                actualParentOrigin,
                offer: {
                    policyId: offer.policyId,
                    sessionId: offer.sessionId,
                    challenge: offer.challenge,
                    frameInstanceId: offer.frameInstanceId,
                    hostInstanceId: offer.hostInstanceId,
                    capabilities: offer.capabilities,
                },
            }),
        })
        if (!response.ok) return undefined
        const { authorizationContext } = await response.json()
        if (
            authorizationContext.policyId !== offer.policyId ||
            authorizationContext.parentOrigin !== actualParentOrigin ||
            authorizationContext.assistantOrigin !== window.location.origin ||
            authorizationContext.sessionId !== offer.sessionId ||
            authorizationContext.challenge !== offer.challenge ||
            authorizationContext.frameInstanceId !== offer.frameInstanceId ||
            authorizationContext.hostInstanceId !== offer.hostInstanceId ||
            authorizationContext.capabilities.length !== offer.capabilities.length ||
            authorizationContext.capabilities.some(
                (capability: string, index: number) => capability !== offer.capabilities[index]
            )
        )
            return undefined
        return {
            parentOrigin: actualParentOrigin,
            policyId: offer.policyId,
            capabilities: offer.capabilities,
            authorizationContext,
        }
    },
    onApprovalRequired: async (request) => await confirm(`允许 ${request.method}？`),
})

const connectButton = document.querySelector<HTMLButtonElement>('#connect-parent')
if (!connectButton) throw new Error('缺少连接控件')
connectButton.addEventListener('click', async () => {
    connectButton.disabled = true
    try {
        await adapter.connect()
        document.querySelector<HTMLButtonElement>('#run-agent')!.disabled = false
    } catch (error) {
        connectButton.disabled = false
        connectButton.dataset.state = 'error'
    }
})

window.addEventListener('pagehide', () => adapter.dispose(), { once: true })
```

adapter 提供完整的 indexed controller 形状方法。为保持结构兼容，仍有
`executeJavascript` 方法，但始终返回确定性的 `CAPABILITY_DENIED` 结果；parent bridge
永远不会执行 child 提供的 JavaScript。不要在模块初始化或 `onMounted` 中调用 `connect()`；首次
调用必须来自 A 中清楚可见的用户操作。这个产品操作不是浏览器可验证的密码学 user gesture，
P Host/P BFF 仍必须独立校验登录态、CSRF、target 和业务 ACL。

一次成功握手建立一个仅内存 activation 和一个 bridge session，不是一次模型调用。模型的多个
步骤复用当前 `MessageChannel`。只有 production ActiveLease 持续获得肯定 `ACTIVE`、且未触发
fail-close 时，既有 `host.reconnect()`/`adapter.reconnect()` 路径才可重新申请 policy 并完整校验；
生产 rebind 不得推进原 lease 的 `expiresAt`，也不得滚动创建新的 900 秒 lease 变相续租。具体
rebind/退避/竞态 API 仍由 AUTH-010 P1 冻结。
一旦收到 `REVOKED`/`EXPIRED` 或 90 秒无肯定 `ACTIVE`，两端必须清连接并禁止自动 reconnect；
恢复只能由 A 用户显式 `connect()` 创建新 lease。`adapter.deactivate()` 与 `host.deactivate()`
会通知对端并清除浏览器 activation，但只是清理信号，不代表 Auth lease 已 revoke。登出、切换
用户/租户/scope/target 或显式断开时还必须由 BFF/Auth revoke；新的 A 文档必须再次由用户点击。

### 策略、规则和一次性审批

`verifyEmbedPolicy` 与已验证策略才是授权依据。可选的
`data-page-agent-policy="deny|confirm|allow"` 属性是本地业务风险标记：`confirm` 映射
为 `approval_required`，优先级为 `deny > confirm > allow`。它绝不能承载 `policyId`、
origin、Bearer token 或 capability 授权；策略的 `jti` 是独立的防重放值。删除/支付/
权限变更目标应通过 selector 与 `actionPolicy` 显式配置，不能根据按钮可见文案推断风险。

每个请求按以下顺序检查：认证 session 与精确 origin/source；协议/session/frame/challenge
及策略时效；已验证的 capability 与方法；root 包含关系和当前 tree revision；最后才是
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
import { onBeforeUnmount, ref, shallowRef } from 'vue'
import type { ParentControllerAdapterOptions } from '@page-agent/page-controller/parent-bridge/adapter'

type ParentAdapter = InstanceType<
    typeof import('@page-agent/page-controller/parent-bridge/adapter').ParentPageControllerAdapter
>

export function useParentPageController(options: ParentControllerAdapterOptions) {
    const adapter = shallowRef<ParentAdapter | null>(null)
    const connected = ref(false)
    const connecting = ref(false)
    const error = ref<unknown>(null)
    let disposed = false

    const connect = async () => {
        if (disposed) return false
        connecting.value = true
        error.value = null
        try {
            const { ParentPageControllerAdapter } = await import(
                '@page-agent/page-controller/parent-bridge/adapter'
            )
            if (disposed) return false
            const instance = adapter.value ?? new ParentPageControllerAdapter(options)
            if (!adapter.value) adapter.value = instance
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
        } finally {
            connecting.value = false
        }
    }
    onBeforeUnmount(() => {
        disposed = true
        adapter.value?.dispose()
        adapter.value = null
        connected.value = false
    })
    return { adapter, connected, connecting, error, connect }
}
```

在 A 页面把 `connect` 绑定到可见按钮，例如
`<button :disabled="connected || connecting" @click="connect">连接父页面</button>`；在
`connected` 为 `true` 前禁用模型执行和所有父页操作。

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

-   公网默认使用 HTTPS；受控内网 HTTP 必须显式启用 `allowInsecureHttp`。allow-list 只写精确
    scheme/host/port，拒绝 `*`、`null`、路径、查询串和凭证。
-   本目标 V1 已接受 P/A BFF→Auth 受控内网 HTTP 且没有 mTLS、service JWT 或 caller
    authentication；logical actor 只作配置/路由/审计参考。最小化 Auth 网络可达面，并明确记录
    “任一可达内部服务都能冒充 P/A”的剩余风险；浏览器始终只能访问自己的同源 BFF。
-   双方校验 `event.origin`、`event.source`、协议版本、session/frame ID、challenge/
    nonce、payload schema 和 capability。
-   子页面响应设置 CSP `frame-ancestors`，父页面 CSP `frame-src` 只允许助手 origin 与每个
    明确授权的业务 iframe origin；
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
-   用至少两个 P、同一 P 的两个 canonical tenant 和多个并发 A iframe 验证：各实例可以独立
    连接，但跨 tenant、跨 iframe/标签页重放 policy/session/context 必须失败；共享 A 登录 JWT
    不能改变该结果。
-   用一个含 8 个 B target 的 Grant 验证多 B 共用 session 且逐个应用 B 最终 ACL；含第 9 个
    target 的签发必须失败，未进当前 Grant 的已登记 B 不可见、不可操作。
-   tenant/target 切换、scope 变化和 A reload 后旧 activation/session 必须失效，并要求显式重新
    连接；不同 scope 分别连接，不能把分别完成的动作当作一个原子跨 scope 事务。
-   生产实现完成后验证 exchange 原子创建固定 900 秒、不续期的 `ACTIVE` lease；policy TTL 为
    120 秒/最大 300 秒，lease/context 最大 3600 秒且不超过凭据寿命，skew 为 5 秒。
-   P/A 分别经自身 BFF 以 30 秒 ±20%（24–36 秒）轮询；`REVOKED`/`EXPIRED` 立即失败关闭，90 秒
    无肯定 `ACTIVE` 同样失败关闭，且都 settle pending work、禁止自动 reconnect。恢复必须是新的
    用户 `connect()`/issue/exchange/lease。
-   验证 logout、user/tenant/target/scope 变化、权限/config disable、Integration 禁用和 kill
    switch 都触发 Auth revoke；单独 `deactivate()` 不能作为撤销成功证据。
-   当前库缺少 ActiveLease/status polling，以上场景在独立 Auth、P/A BFF 和 runtime 接线及测试
    完成前必须保持 release-blocked，不能用现有 Grant E2E 代替。

### 推荐方案：PageAgent 托管的一次性 opaque token

P（父页面）、A（PageAgent 助手）和 B（业务 iframe）属于同一公司或同一安全域时，推荐让
PageAgent 授权服务签发一次性 opaque token，并由 A 的后端在线核销。token 是不可解释的高熵
随机值，不是 JWT；服务端只保存它的 SHA-256 摘要、短时 claims 和过期时间。完整 token 仅经
P 的同源 HTTPS 接口进入父页，再作为现有 bridge offer 的 `policy` 发送给 A。它不得放进 iframe
URL、日志、localStorage、埋点或错误信息。

职责边界如下：

-   P 后端先用自己的登录态和业务规则判断当前用户是否允许启用助手，再向 PageAgent 授权服务
    请求 `{ policy, claims }`。PageAgent 无法代替 P 判断租户、用户、订单或工作流权限。
-   P 前端只调用同源授权接口，并把 integration-aware helper 返回的 `getEmbedPolicy` 和
    `verifyEmbedPolicy` 交给 Host；无需保存私钥、实现 JOSE 或维护 JWKS。
-   PageAgent 授权服务生成至少 256 bit 的随机 token，只持久化摘要，并把 `jti`、精确
    `integrationId`、app IDs、configVersion、`parentOrigin`/`assistantOrigin`、`scopeId`、能力、
    协议版本、`nbf`/`exp`、完整 bridge binding、canonical subject、target 以及获准的
    `childFrames` 写入服务端记录；subject 不返回浏览器。
-   A 的 `authorizeOffer` 把 token、浏览器实际观察到的父 Origin 和完整 offer 发送给同源 A
    后端。A BFF 以双边固定的 logical actor 和自身 SSO subject 调 Auth；actor 不是调用方认证。
    Auth 比较 P/A canonical subject 三元组，并在原子核销前校验 claims 与 `policyId`、实际 Origin、
    能力集合和 issue 时已绑定的 session/challenge/instance 完全相符。任何第二次交换、过期、篡改
    或越权能力都失败关闭。
-   B 不接触 token。P 只为 claims 中明确列出的 B 建立代理，并继续执行 B 自己的 origin、
    capability、action policy 和审批规则。

独立的生产 Auth 可以复用窄入口中的合同和领域引擎。以下 `productionRegistry` 和
`productionAtomicStore` 必须由独立服务以配置数据库和共享原子 TTL 存储实现：

```ts
import {
    IntegrationAwareEmbedAuthorizationAuthority,
    toBrowserAuthorizationContext,
} from '@page-agent/page-controller/parent-bridge/integration-auth'

const authority = new IntegrationAwareEmbedAuthorizationAuthority({
    registry: productionRegistry,
    store: productionAtomicStore,
    issuer: 'page-agent-auth',
})

// P BFF：actor 来自与 Auth 双边固定的逻辑配置，仅作路由/审计元数据；不是调用方认证。
// subject 来自 P 自己验证的 SSO 会话。
const grant = await authority.issue(
    { actor: configuredPLogicalActor, subject: canonicalPSubject },
    {
        integrationId: 'checkout-p__shared-assistant',
        targetId: checkout.id,
        scopeId: 'checkout',
        parentOrigin: 'https://p.example.com',
        assistantOrigin: 'https://assistant.example.com',
        capabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup'],
        bridgeBinding,
        parentSessionBinding,
    }
)
// 返回 JSON：{ policy, claims }；响应必须 no-store。

// A BFF：使用双边固定的 logical actor 和自身 canonical subject；actor 不是调用方认证。
// 只把无身份的最小上下文返回 A 浏览器。
const decision = await authority.exchange(
    { actor: configuredALogicalActor, subject: canonicalASubject },
    { policy, actualParentOrigin, actualAssistantOrigin, offer }
)
const authorizationContext = toBrowserAuthorizationContext(decision)
```

示例中的 `configuredPLogicalActor`/`configuredALogicalActor` 是当前代码合同要求的逻辑元数据；
当前领域参考实现包含 actor 配置错配检查，但冻结的 V1 生产合同不把该检查作为身份、授权或请求拒绝
门禁。任何拥有 Auth 网络可达性的内部服务都能提交这些值并冒充 P/A。浏览器仍不得直接调用 Auth。
生产还必须在 exchange 的原子事务中创建固定 900 秒、不续期的 ActiveLease，并由 P/A BFF 提供
status/revoke；这些 ActiveLease 接口尚不在当前 library 中，上例没有假装展示它们。

A 前端在 `authorizeOffer` 中只把服务端返回的 context 映射成 `AuthorizedParent`，并再次精确比较
`policyId`、父/助手 origin、session、challenge、frame/host instance 和 capability；不要因接口
返回 HTTP 200 就跳过这些关联检查。

父页的最小改造因此只有一个同源后端路由和一段前端接线。旧 `parent-bridge/managed-auth` API
保留一个版本并已标记 deprecated；新接入不要继续使用。生产环境的 token store 必须使用
Redis、数据库事务或等价的共享存储，通过原子的 get-and-delete/compare-and-delete 完成核销；
库提供的内存 store 只适合单进程开发和测试，不能跨实例防重放。接口响应和所有失败响应都应
设置 `Cache-Control: no-store`，使用 HTTPS、受控 CORS/CSRF 和请求体大小限制。不要把服务端
返回的身份上下文直接展示给 LLM 或 UI。

生产 store 还要原子保存 ActiveLease/status/revoke，V1 优先单区域强一致；状态不确定或 store
不可用时失败关闭。policy TTL 为 120 秒（最大 300 秒），lease 固定 900 秒不续期，context/lease
最大 3600 秒且不超过上游凭据寿命，时钟偏差预算为 5 秒。

该方案解决的是“P 获准把某个精确范围临时委托给 A”以及 token 被窃取后的重放窗口问题；它不
替代 P 的登录认证、业务 ACL、XSS 防护、CSP/sandbox、bridge 的 origin/source 校验或敏感动作
审批。P 页面中已能执行脚本的攻击者仍处在受信边界内，因此 Host 的 root、capability 和
`actionPolicy` 仍必须最小化。

### 与 ES256/JWKS 的比较和升级路径

| 维度           | 一次性 opaque token（当前推荐）                                   | ES256/JWKS（跨系统升级方案）                     |
| -------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| 适用信任关系   | P/A/B 同公司，可调用统一在线授权服务                              | P/A 分属不同系统或组织，需要独立验证             |
| P 接入成本     | 同源路由 + integration-aware helper，无密码学实现                 | 校验 JWT/JWS、issuer/audience、JWKS 缓存与轮换   |
| A 校验方式     | 每次握手在线调用服务端并原子核销                                  | 本地验签；仍建议用共享 `jti` store 防重放        |
| 撤销与权限变化 | 服务端记录可立即拒绝，天然在线                                    | 已签发 token 通常到过期才失效，需短 TTL/撤销表   |
| 可用性         | 依赖授权服务在线和共享存储                                        | JWKS 缓存后可离线验证，跨区域更容易扩展          |
| 密钥运维       | 无公私钥分发；重点保护 token store、网络边界和 logical actor 配置 | 需保护私钥、发布 JWKS、处理 `kid`/轮换/算法约束  |
| token 可读性   | 不可读，泄漏仍必须按 bearer secret 处理                           | claims 可读但有签名，也必须按 bearer secret 处理 |
| 审计           | 授权与核销天然经过服务端，集中审计简单                            | 签发和各验证方日志需关联 `jti`                   |

升级到 ES256/JWKS 时保持 Host/Adapter 协议、claims schema、精确 origin/capability 检查和
`authorizeOffer` 接口不变，只替换签发器与校验器：P 后端签发短期 ES256 JWS，A/P 依据固定
issuer/audience 和 HTTPS JWKS 验签；拒绝 `alg=none`、算法降级、未知 `kid` 和过大的 key set。
若仍要求严格的一次性授权，验签后继续使用 Redis/数据库原子消费 `jti`，因为数字签名本身不
防重放。迁移期间不要同时接受“无法判断类型的任意 token”；应按版本或明确 issuer 分流，并为
旧 opaque 路径设定可观测的下线时间。

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
