# 跨域 iframe 协作桥接指南

> English: [Cooperative cross-origin iframe bridge](./cross-origin-iframe-bridge.md)

Page Agent 的可选 iframe bridge 允许父页面上的 Page Agent 观察并操作一个**愿意协作、且是父页面直接子节点**的跨域 iframe。桥接采用浏览器 `postMessage` 和专用 `MessageChannel`，并且要求父、子双方分别配置精确的 HTTP(S) origin 白名单。

这不是跨域 DOM 访问的绕过方案，也不是把任意 JavaScript 暴露给另一方的 RPC。父页面仍然拥有 Agent、LLM 和本地 controller；子页面只提供自己明确允许的 PageController 能力。

## 1. 双方职责与消息流程

| 参与方                 | 负责什么                                                                                                                                                                           | 不负责什么                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 父页面 / SDK 接入方    | 安装 `page-agent`；创建本地 `PageController`；用 `FrameAwarePageController` 包装它；选择 iframe；配置 `allowedChildOrigins`；创建 `PageAgent` 并保存 LLM 凭据；设置父页面 CSP      | 不读取子页面 DOM；不把 `*` 当作 origin；不假设子页面支持所有 action               |
| 跨域 iframe 页面提供方 | 安装 `@page-agent/page-controller`；创建子页面自己的 `PageController`；用 `FrameBridgeHost` 配置 `allowedParentOrigins` 和能力；在页面加载时调用 `start()`，卸载时调用 `dispose()` | 不创建 `PageAgent`；不调用 LLM；不需要 API key；不接收或执行父页面任意 JavaScript |
| 浏览器 / 部署配置      | 允许 iframe 加载、允许脚本执行，并让 CSP 与 frame 嵌入策略相互匹配                                                                                                                 | CORS 响应头不能替代 origin 校验，也不能授权跨域 DOM                               |

一次连接大致经历以下流程：

1. 父页面只选择 `frameSelector` 匹配的直接子 iframe，并根据 `src` 得到子页面 origin。
2. 父页面向子 iframe 发送带目标 origin 的 discover 消息。
3. 子页面同时检查 `event.source === window.parent` 和 `event.origin`，再回报自己的 bridge 能力。
4. 父页面再次检查消息来源和 origin，建立一条专用 `MessageChannel`；后续请求只走这个端口。
5. 父页面先获取带索引的浏览器状态，再用最新索引路由 click、input、select 或 scroll。

## 2. 安装与 ESM import

Bridge 是 NPM/ESM-only 的次级入口。生产应用应使用打包器和 ESM import，不要把这些入口当作 script tag、UMD 或 IIFE 文件使用。

父页面（SDK 接入方）安装：

```bash
npm install page-agent @page-agent/page-controller
```

子页面只需要提供 host 时安装：

```bash
npm install @page-agent/page-controller
```

父页面从主入口 `page-agent` 导入 `PageAgent`，从次级入口 `page-agent/iframe-bridge` 导入 `FrameAwarePageController`、`PageController` 和其他 bridge 导出；子页面从 `@page-agent/page-controller/iframe-bridge` 导入 host：

```ts
// parent.ts
import { PageAgent } from 'page-agent'
import { FrameAwarePageController, PageController } from 'page-agent/iframe-bridge'

// child.ts
import { FrameBridgeHost, PageController } from '@page-agent/page-controller/iframe-bridge'
```

也可以从 `@page-agent/page-controller/iframe-bridge` 导入 `FrameBridgeClient`，在需要自己管理单个连接的高级场景使用。大多数父页面只需要 `FrameAwarePageController`。

父、子应使用兼容的 Page Agent 版本，并在发布构建后保留这两个次级 export；不要深度导入 `src/` 文件。

## 3. 父页面配置（SDK 接入方）

父页面创建一个本地 controller，再把它交给 `FrameAwarePageController`。`frameSelector` 必须显式指定，建议使用专用 data 属性；这样页面中的其他 iframe 不会意外加入桥接。

下面是一个完整的父页面示例。示例中的 LLM 只在父页面使用，`pageController` 同时负责本地 DOM 和允许协作的跨域直接子 iframe：

```ts
import { PageAgent } from 'page-agent'
import { FrameAwarePageController, PageController } from 'page-agent/iframe-bridge'

const pageController = new FrameAwarePageController({
    localController: new PageController({
        viewportExpansion: -1,
        includeAttributes: ['id', 'aria-label'],
    }),
    frameSelector: 'iframe[data-page-agent-bridge]',
    allowedChildOrigins: ['https://widgets.example.com'],
    handshakeTimeoutMs: 1000,
    requestTimeoutMs: 5000,
})

const agent = new PageAgent({
    pageController,
    model: 'your-model',
    baseURL: 'https://your-llm-gateway.example.com/v1',
    apiKey: 'YOUR_API_KEY',
    language: 'zh-CN',
})

await agent.execute('填写订单信息')

// 应用退出或替换页面时：
// pageController.dispose()
```

`allowedChildOrigins` 的每一项必须是精确的 HTTP(S) origin，只包含 scheme、host 和 port，例如 `https://widgets.example.com` 或 `https://widgets.example.com:8443`。不要写路径、查询串、用户名密码、`*` 或 `null`。末尾 `/` 会被规范化，但建议配置时省略它。父页面会同时校验 iframe 当前 `src` 的 origin、`postMessage` 的 `event.origin` 以及 `event.source`，只要有一项不匹配，握手就会失败。

一个页面可以配置多个允许的子 origin，但应尽量缩小列表；每个 iframe 仍然必须匹配 `frameSelector`，且是父页面的直接子 iframe。

## 4. 子页面配置（iframe 页面提供方）

子页面提供方创建自己的 controller 和 `FrameBridgeHost`。host 不会创建 PageAgent，也不需要 LLM package、模型、`baseURL` 或 API key：它只在本 iframe 中提取状态并执行被授权的 controller action。

```ts
import { FrameBridgeHost, PageController } from '@page-agent/page-controller/iframe-bridge'

const bridgeHost = new FrameBridgeHost({
    controller: new PageController({
        viewportExpansion: -1,
        includeAttributes: ['id', 'aria-label'],
    }),
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
})

bridgeHost.start()

// 页面卸载、SPA 文档替换或 host 不再需要时：
// bridgeHost.dispose()
```

`allowedParentOrigins` 是**子页面允许连接它的父页面 origin**；同样只接受精确的 HTTP(S) origin，拒绝通配符和路径。`allowedChildOrigins` 则是**父页面允许被它连接的子页面 origin**。两者不是同一个配置项的别名：对于 `https://app.example.com` 嵌入 `https://widgets.example.com`，父页面写 `allowedChildOrigins: ['https://widgets.example.com']`，子页面写 `allowedParentOrigins: ['https://app.example.com']`。

`capabilities` 可选；省略时默认为全部安全 bridge 能力。建议按最小权限原则只公开实际需要的能力，例如只读组件可以配置 `['observe']`。父页面请求未被子页面广告的能力会收到 `CAPABILITY_DENIED`。

## 5. CORS、LLM Key 与浏览器嵌入策略

### 不需要 CORS，也不要把 LLM key 放到子页面

这个 bridge 使用 `window.postMessage`，每一条消息都带目标 origin，并在两端检查来源。跨域 DOM 访问限制仍然存在；CORS 响应头只影响 `fetch`/XHR，不会授予读取 iframe DOM 的权限，因此**不需要为 bridge 添加 CORS 头**。如果子页面本身还提供 API，是否需要 CORS 要按那个 API 的调用方式单独配置。

LLM 请求由父页面的 PageAgent 发起。子页面 host 不创建 Agent、不发送模型请求，也不需要 `apiKey`；不要因为 bridge 而把 LLM key 注入 iframe、URL、HTML 或 `postMessage` 数据。

### CSP 与 X-Frame-Options

-   父页面 CSP 必须在 `frame-src`（或旧策略 `child-src`）中允许子页面 origin。
-   子页面 CSP 必须在 `frame-ancestors` 中允许父页面 origin。
-   `X-Frame-Options: DENY` 会禁止所有嵌入；`SAMEORIGIN` 在父子跨域时也会阻止嵌入。即使 bridge 代码正确，浏览器在 iframe 加载前阻止它时也不会有握手。
-   如果使用 `<iframe sandbox>`，至少需要 `allow-scripts` 让 host 代码运行，并需要 `allow-same-origin` 保留配置的 HTTP(S) origin。缺少 `allow-same-origin` 会产生不透明的 `null` origin，而精确 origin 握手会拒绝它。sandbox 仍应按实际业务继续限制表单、弹窗、下载等能力。

推荐的嵌入骨架如下（属性名和 CSP 仍需按部署域名替换）：

```html
<iframe
    data-page-agent-bridge
    src="https://widgets.example.com/embedded"
    title="订单组件"
    sandbox="allow-scripts allow-same-origin"
></iframe>
```

## 6. 能力、数据边界与明确限制

### 可公开的能力

Version 1 的 bridge 能力名称为：

-   `observe`：获取子页面浏览器状态；
-   `click`、`input`、`select`：按当前观察中的索引操作元素；
-   `scroll`、`scrollHorizontally`：滚动文档或可滚动元素；
-   `cleanup`：清理 controller 的高亮。

父页面看到的观察状态包含 URL、标题、页面信息/滚动提示、简化且带索引的内容，以及 `treeRevision`/索引元数据。动作请求只携带索引和相应的文本、选项或滚动参数；bridge 不提供任意 `postMessage` payload 扩展点。

### 数据不是过滤边界

bridge 的 origin 校验和能力白名单解决的是“谁能连接、能做哪些 controller action”，不是内容脱敏边界。子页面 controller 放入浏览器状态的任何文本、属性、URL 或标题都会被发送给允许的父 origin。因此只有在信任父页面时才开启 host，不要把密码、token、个人健康/支付数据等敏感内容暴露给不受信任的嵌入方；必要时应在子页面 controller 配置或页面结构中先做数据隔离。

### `executeJavascript` 永远不会转发

`executeJavascript` 不属于 bridge method union，也不在 host 的分发器中。父页面本地 controller 仍可使用它，但对 `FrameBridgeClient` 调用会以 `CAPABILITY_DENIED` 拒绝；任意脚本不会被发送到子页面。不要尝试用自定义 `postMessage` 绕过这一限制。

### 只支持 direct frame，不递归 nested frame

-   只处理父文档中 `frameSelector` 匹配的**直接子 iframe**。
-   同源 iframe 留给本地 DOM controller，不会通过 bridge 重复发现。
-   子 iframe 内嵌的孙 iframe（nested frame）不会被递归发现或自动聚合；如果业务确实需要，必须由各层分别设计并明确授权连接。
-   iframe 文档节点在父页面的聚合状态中是 scroll-only 目标；click、input、select 必须指向子页面观察中具体元素的索引。

## 7. 生命周期、索引和降级行为

-   `FrameBridgeHost.start()` 注册全局握手监听；同一 host 重复调用是幂等的。页面卸载、文档替换或应用销毁时调用 `dispose()`，以关闭端口、取消请求、移除监听器并（默认）释放传入的 controller。
-   每次 iframe 导航都会使父侧 client 的连接和待处理请求失效；下一次观察时会重新握手。新文档应创建新的 `FrameBridgeHost` 实例，不要复用旧文档的 host 状态。
-   `FrameAwarePageController` 会发现后来动态加入且匹配 selector 的 iframe；被移除的 iframe 会被 dispose。导航到同源文档的 iframe 会退出 bridge，交给本地 controller 处理。
-   元素索引和 `treeRevision` 只对最近一次观察有效。调用 `getBrowserState()`/`updateTree()` 刷新状态后，再把最新索引交给 Agent 或 action；不要缓存跨导航的索引。
-   某个子 frame 未安装 host、被 CSP/X-Frame-Options 阻止、origin 不在白名单、握手/请求超时或端口断开时，该 frame 会标记为 unavailable；本地页面和其他可用协作 frame 仍可继续工作。
-   如果应用需要区分降级原因，可监听 `bridgeerror`/`invalidate` 事件或检查稳定的 `FrameBridgeError.code`（如 `TIMEOUT`、`CONNECTION_CLOSED`、`STALE_TREE`、`CAPABILITY_DENIED`），记录错误码而不是把敏感状态写入日志。

## 8. 自动测试与手动可视 Demo

### 自动测试

在仓库根目录运行：

```bash
npm run test:e2e
```

该命令先构建 `@page-agent/page-controller` 和父页面 PageAgent Demo，再运行 Playwright 的跨域 bridge 测试。测试 fixture 使用两个本地 HTTP origin：父页面 `http://127.0.0.1:4173/host.html`，子页面 `http://127.0.0.1:4174/child.html`。测试覆盖本地与远程观察聚合、click/input/select/纵横向 scroll 路由，以及远程 `executeJavascript` 被拒绝；测试不会真正调用 LLM。

### 手动可视 Demo

在仓库根目录运行：

```bash
npm run demo:iframe-bridge
```

命令启动父、子两个本地 demo server 后，在浏览器打开父页面：

-   父页面（SDK 接入方）：`http://127.0.0.1:4173/host.html`
-   子页面（iframe 页面提供方）：`http://127.0.0.1:4174/child.html`

页面用蓝色标记父页面区域、橙色粗边框标记子 iframe。父页面和子页面均提供点击、文本输入、下拉选择及纵横向滚动目标，便于通过父页面 PageAgent 测试本地与桥接操作。可在 DevTools 的 Console/Network 中查看 iframe 的实际 origin、CSP 和加载错误；不要把 Demo 的本地 allow-list 直接复制到生产环境。

该中文 Demo 只在父页面安装 PageAgent，子页面仅安装 `PageController + FrameBridgeHost`，不会创建 Agent 或调用 LLM。父页面 PageAgent 默认使用内置 `TlAiClient` 的 `system_prompt` 模式，默认 endpoint 为 `http://127.0.0.1:8089`；使用本地 Tl 代理时，需另开终端运行 `npm run start:tl-proxy -w @page-agent/llms`。也可在仓库根目录 `.env` 中用 `LLM_ENDPOINT_AGENT` 和 `LLM_MODEL_NAME` 覆盖默认配置。`execute_javascript` 只在父页面本地执行，父页面不能通过 bridge 在子页面执行脚本。

## 9. 常见错误排查

| 现象 / 错误码                                            | 常见原因                                                                                                                         | 排查与修复                                                                                                                                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TIMEOUT`（握手超时）或 frame 显示 unavailable           | host 没有加载/没有 `start()`；iframe 被 CSP、`X-Frame-Options` 或 sandbox 阻止；端口/协议写错                                    | 先直接打开 `4174` 子页面确认脚本运行，再检查浏览器 Console、`frame-src`/`frame-ancestors`、X-Frame-Options、`allow-scripts` 和 `allow-same-origin`，并核对完整 origin（含端口） |
| `CAPABILITY_DENIED`                                      | child origin 不在 `allowedChildOrigins`；父 origin 不在 `allowedParentOrigins`；子 host 没广告该能力；调用了 `executeJavascript` | 两端分别核对对方 origin；移除路径/query/`*`/`null`；按最小权限补充明确的 capability。`executeJavascript` 对远程 frame 永远不可用                                                |
| `CONNECTION_CLOSED`、`FRAME_MISMATCH` 或导航后请求失败   | iframe 导航、被替换/移除，旧 `frameInstanceId` 或端口已失效                                                                      | 等待下一次观察自动重连；必要时销毁旧 host 并为新文档创建实例；不要复用旧 client                                                                                                 |
| `STALE_TREE`                                             | 使用了旧观察中的元素索引或 `treeRevision`                                                                                        | 先 `await pageController.getBrowserState()`（或让 Agent 更新树），再使用返回内容中的新索引                                                                                      |
| `INVALID_PAYLOAD`                                        | 索引不是非负整数；select/scroll 参数形状错误；把 frame document 索引用于 click/input/select                                      | 按 PageController API 传参；frame document 节点只用于 scroll，具体控件使用其子元素索引                                                                                          |
| 子页面没有出现在聚合内容中                               | iframe 不是直接子节点；未匹配 `frameSelector`；是同源 frame；实际嵌套在另一个 frame 中                                           | 给目标 iframe 加专用 data 属性，使用显式 selector；确认它是跨域 direct child。nested frame 不会自动递归                                                                         |
| origin 显示为 `null`                                     | sandbox 缺少 `allow-same-origin`，或使用了 data/file/其他 opaque URL                                                             | 使用稳定的 HTTP(S) URL，并在确有需要时同时设置 `allow-scripts allow-same-origin`；不要把 `null` 加入白名单                                                                      |
| “需要配置 CORS”或把 API key 放到 child                   | 把 postMessage bridge 与 fetch/CORS、LLM 配置混淆                                                                                | bridge 不需要 CORS；LLM 只在父页面配置。只有子页面自己发起跨域 API 请求时，才按该 API 的要求配置 CORS                                                                           |
| `ERR_MODULE_NOT_FOUND`、`exports` 或 script tag 加载失败 | 使用了非 ESM 入口、深度导入 `src/` 或包版本不匹配                                                                                | 使用 NPM 安装和文档中的次级 ESM import；父子依赖版本保持兼容，重新构建后再验证                                                                                                  |

## 10. 上线前检查清单

-   [ ] 父页面和子页面使用 HTTPS，并把端口、scheme、host 写成双方都确认过的精确 origin；没有 `*`、`null`、路径或 query。
-   [ ] `frameSelector` 足够具体（例如 `iframe[data-page-agent-bridge]`），只包含确实要接入的直接子 iframe。
-   [ ] 父页面的 `allowedChildOrigins` 与每个 child 的 `allowedParentOrigins` 成对配置，且已验证 `event.source`/`event.origin` 检查不会被代理或重定向破坏。
-   [ ] 父 CSP 的 `frame-src`/`child-src` 和子 CSP 的 `frame-ancestors` 都允许实际部署 origin；没有冲突的 `X-Frame-Options`。
-   [ ] 若使用 sandbox，已验证 `allow-scripts` 与 `allow-same-origin`，并保留其他所需限制；没有意外获得不必要的脚本、表单或弹窗能力。
-   [ ] child 只公开业务必需的 `capabilities`；已确认 `executeJavascript` 不会且不能跨 bridge 调用。
-   [ ] 已完成数据分类：父页面是受信方，子页面 controller 不会把 token、密码或其他敏感内容放进可观察状态；日志不会记录原始页面内容。
-   [ ] LLM/API key 只存在于父页面受控配置或后端代理；child bundle、iframe URL 和消息中都没有 key。
-   [ ] 已验证导航、SPA 替换、动态添加/移除 iframe、host 缺失和超时的降级路径；每次 action 前使用最新观察索引。
-   [ ] 页面或应用销毁时同时 dispose 父侧 `FrameAwarePageController` 与子侧 `FrameBridgeHost`，避免残留 listener、port 或 controller。
-   [ ] CI 已运行 `npm run test:e2e`；发布前在与生产 CSP、TLS、代理和端口一致的环境运行 `npm run demo:iframe-bridge` 做人工检查。
