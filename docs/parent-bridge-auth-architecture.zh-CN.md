# P / A / B 与公共 Auth 权威架构

本文是 PageAgent 跨域助手部署中授权架构的权威说明。它冻结 P（Parent）、A（Assistant）、
B（Business）和公共 Auth 的职责、请求流、数据模型与安全不变量；生产接入的操作清单、响应头、
灰度和回滚步骤见[iframe PageAgent 生产部署手册：P / A / B 职责](./parent-bridge-production-deployment.zh-CN.md)。
尚未冻结的设计、生产缺口、责任人和验收证据统一维护在
[P / A / B / Auth 架构待决事项台账](./parent-bridge-architecture-open-issues.zh-CN.md)，不以正文中的
建议方案替代正式决策记录。
如果运行手册中的旧描述与本文冲突，以本文为准，并应在发布前修正运行手册。

V1 受控内网的 P0 决策已于 2026-08-31 冻结；稳定决策记录见
[ADR-0001：P / A / B / Auth V1 P0 基线](./adr/0001-parent-bridge-auth-v1-p0-baseline.zh-CN.md)。本文是该 ADR
在 P/A/B/Auth 拓扑、流程和运行时约束上的权威摘要，不把仓内参考实现描述为生产实现。

桥接 wire protocol 和 DOM 边界见[父页面控制器桥接](./parent-bridge.zh-CN.md)。当前协议增加了
不含身份、policy 或业务数据的 `handshake-request`/`deactivate` 控制消息；业务请求仍只在
`MessageChannel` 中传输，业务授权逻辑不搬进浏览器。

## 1. 冻结的拓扑与职责边界

每个 `environment` 恰好只有一个逻辑 A 系统：一个 `AssistantApp` 身份、一套 A BFF 和一套 A
`serviceActor` 配置归属。`serviceActor` 是逻辑配置、路由和审计元数据，不是技术调用方认证或安全边界。
A BFF 可以有后端副本，但副本不构成新的 A；生产和测试环境彼此独立。
这个逻辑 A 可以被多个 P 以各自的 iframe 实例嵌入；每个 P 可以服务多个 tenant，也可以为每个
`Integration` 注册多个 B。运行时只有一条可接受的操作路径：

```text
A（当前助手 iframe） → 当前 P（唯一父页代理） → 明确配置的 B（协作业务 iframe）
```

A 不直连 B，也不通过同级 iframe、URL、CORS 或任何浏览器 API 绕过 P。P 是父页 DOM 和 B 代理的
唯一汇合点；B 仍是自身业务后端的最终拒绝方。

上述是逻辑系统的基数，不是浏览器进程或 iframe 数量。每个 P 页面/标签页都嵌入自己的 A 浏览器
iframe runtime instance，并独立拥有 `frameInstanceId`、bridge session、`MessageChannel`、activation、
任务状态和每个 Host 的 auth client；A iframe reload 会创建新的 runtime instance。一个逻辑 A 不等于
一个 iframe，也不等于一个进程。

下图仅展示一个运行时切片：一个 P 页面/标签页、一个 tenant context、一个 A iframe runtime instance、
一个 bridge session 和一个当前 B target；它不表示系统只能有一个 P、tenant 或 B。

```mermaid
flowchart LR
    User["用户"] --> PWeb["P 前端<br/>Parent Host"]
    PWeb -->|"iframe + postMessage / MessageChannel"| AWeb["逻辑 A 的当前 iframe runtime<br/>PageAgent + Adapter"]
    PWeb -->|"P 控制的 child-frame bridge"| BWeb["当前 P 的一个明确配置 B target<br/>FrameBridgeHost"]
    PWeb --> PBFF["P BFF<br/>P Cookie/JWT"]
    AWeb --> ABFF["A BFF<br/>A Cookie/JWT"]
    BWeb --> BBFF["B BFF<br/>B Cookie/JWT"]
    PBFF -->|"P serviceActor 元数据 + canonical P subject"| Auth["公共 Auth<br/>跨系统授权控制面"]
    ABFF -->|"A serviceActor 元数据 + canonical A subject"| Auth
    PBFF -. "同源 issue" .-> PWeb
    ABFF -. "同源 exchange" .-> AWeb
    Auth -. "不接触浏览器 Cookie/JWT" .- PWeb
    Auth -. "不接触浏览器 Cookie/JWT" .- AWeb
```

四方的边界如下：

| 组件 | 必须负责                                                                                                      | 不负责、不能替代                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| P    | 当前页面用户/租户权限、root 边界、Host 配置、B target 清单、P 级 `actionPolicy`、将 A 的请求路由到当前 P 或 B | 不把 A 变成 B 的直接客户端；不把 P 的业务 ACL 交给 Auth 代判                          |
| A    | 可见“连接”入口、用户任务、Adapter、A 自己的会话、offer 核销请求、LLM 与一次性人工审批体验                     | 不读取 `parent.document`；不直连 B；不把浏览器 token 发送给 Auth                      |
| B    | `FrameBridgeHost`、B 的 root/能力、B BFF 的认证授权、业务状态、最终 deny                                      | V1 不调用 Auth；不信任 A origin；不因 bridge 请求而跳过业务后端 ACL                   |
| Auth | P↔A 跨系统一次性授权、配置最大值、主体匹配、精确绑定、TTL/重放和集中审计                                     | 不做 SSO 登录；不读取浏览器 Cookie/JWT；不检查 DOM、MessageChannel、LLM 或 B 业务对象 |

P、A、B 的前端分别只使用自己的浏览器会话访问自己的 BFF：P→P BFF、A→A BFF、B→B BFF。
每个 BFF 独立通过统一 SSO 验证自己的登录态，并标准化为同一形式的主体：

```ts
type CanonicalSubject = {
    issuer: string
    tenantId: string
    userId: string
}
```

Auth 比较的是 P BFF 和 A BFF 在各自验证浏览器会话后提交的标准化主体；比较时三个字段都必须相等。
主体标准化映射必须由统一 SSO/平台配置确定，不能由浏览器提交的 `tenantId` 或 `userId` 覆盖。
V1 的 BFF→Auth 调用不设置 mTLS、service JWT 或等价的技术调用方认证；Auth 只把
`serviceActor` 当作双方约定的配置选择、路由和审计元数据，不把 actor 的真伪或方向匹配作为
身份认证、授权通过或请求拒绝依据。任何能够到达 Auth 的内部服务都可能冒充 P/A serviceActor，
受控内网因此明确接受该残余风险。

服务身份和用户主体是两个不同维度：

-   P BFF、A BFF 各自有独立的 `serviceActor` 元数据；它用于双方约定的配置选择、路由和审计，
    不证明“哪个后端在调用”，也不等于当前用户。Auth 不以 actor 不匹配作身份或授权拒绝；内部可达
    服务的冒充风险由受控内网风险接受记录覆盖。
-   P/A 浏览器的 Cookie/JWT 只发给对应 BFF。Auth 不接收、解析或刷新这些浏览器凭据。
-   A 的 JWT `aud` 应是 `A-BFF`。A BFF 不得把 A JWT 盲转给 Auth；它应先验证自己的会话，
    再提交规范化的 A subject 和逻辑 `serviceActor` 元数据。
-   `issuer + tenantId + userId`、授权结果和会话绑定可以进入 Auth 的服务端记录与审计，但不应
    通过 bridge `postMessage` 传用户身份。A 若需要显示用户信息，应从自己的会话/业务 API 获得。

## 2. 公共 Auth 的精确定位

Auth 是跨系统授权控制面，作用是让一个已通过自身登录和业务检查的 P，在限定时间、限定会话和
限定能力内把当前任务委托给 A。Auth 的最大授权不是最终业务权限。

### Auth 必须做

1. 根据 `Integration` 配置确认 P/A 应用关系、环境和最大能力/目标边界；记录双方约定的
   `serviceActor`，但只将其用于配置选择、路由和审计，不作为身份认证、授权通过或拒绝条件。
2. 接收 P BFF 的一次性、短期 issue 请求，生成高熵 opaque policy，服务端只保存其摘要和
   claims/过期时间。
3. 在 A BFF exchange 前比较 P/A 的 canonical subject，并校验 integration、精确 P/A origin、协议
   版本、能力子集、B 子集、完整会话绑定和 TTL；`serviceActor` 仅随请求记录和审计，不参与上述
   授权判定。
4. 对每个 opaque Grant 做原子状态迁移：有效核销只能让 `ISSUED → CONSUMED` 一次；`exp` 到期后
   `ISSUED` Grant 不可核销并可清理；注销、kill switch 或安全事件可让尚未核销的
   `ISSUED → REVOKED`。成功 exchange 必须在同一原子操作中创建绑定完整上下文的 `ActiveLease`，
   初始状态为 `ACTIVE`。`Grant` 的一次性状态与 `ActiveLease` 的运行时状态不得混用。
5. 管理 `ActiveLease` 的 `ACTIVE → REVOKED | EXPIRED` 状态、撤销查询和轮询响应；ActiveLease
   有效期固定 900 秒、不可 renewal。返回不含浏览器凭据的短期服务端授权上下文（含 lease 引用/过期信息），
   并记录不含原始 opaque policy 的审计事件、指标和限流结果。

### Auth 明确不做

-   不替代统一 SSO，也不向 P/A/B 浏览器发 Cookie、JWT 或长期 Bearer。
-   不替代 P 的用户/租户/业务 ACL，不替代 B 对业务对象、CSRF、幂等和状态机的最终检查。
-   不解析 P/A DOM，不控制 iframe 的 sandbox、CSP、origin/source、`MessageChannel` 或
    `FrameBridgeHost`；这些属于浏览器桥接层。
-   不执行 LLM、任务编排或人工审批；审批仍由 P 的 `actionPolicy`、B 的业务策略和 A 的 UI
    按一次请求处理。
-   V1 不要求 B 调用 Auth。B 使用自己的 BFF 和业务会话完成最终认证授权。

## 3. 请求流：从 A 显式连接到 P issue / A exchange

首次握手必须从 A 的可见用户操作开始。P Host 的 `start()` 默认只注册监听器，在点击发生前不调用
P BFF、不向 Auth issue，也不向 A 主动发送 offer。所有“同源”均指对应应用自己的 BFF；没有任何
浏览器步骤直连 Auth。

```mermaid
sequenceDiagram
	participant U as 用户
    participant P as P 前端 / Host
    participant PB as P BFF
    participant A as A 前端 / Adapter
    participant AB as A BFF
    participant X as 公共 Auth
    participant B as B / FrameBridgeHost
    participant BB as B BFF

    Note over P,A: Host 已启动但保持被动；此时没有 policy/offer/Auth 请求
    U->>A: 点击“连接”
    A->>P: handshake-request（requestId + user reason；无身份/policy）
    P->>PB: POST /api/parent-bridge/embed-policy（P Cookie/JWT）
    PB->>PB: 验证 P 会话、SSO subject、P ACL、当前 target
    PB->>X: issue（P serviceActor 元数据 + P subject + integration + 精确边界）
    X-->>PB: { policy, claims }（opaque、一次性、短 TTL）
    PB-->>P: 同源 no-store { policy, claims }
    P->>A: offer（回显 handshakeRequestId + policy/binding/capabilities）
    A->>AB: POST /api/parent-bridge/authorize-offer（A Cookie/JWT + offer）
    AB->>AB: 验证 A 会话和 SSO subject，准备逻辑 serviceActor 元数据
    AB->>X: exchange（A serviceActor 元数据 + A subject + policy + offer）
    X->>X: 比较主体/绑定，校验 TTL、origin、能力/B 子集，原子 consume Grant + 创建 ACTIVE lease（900s）
    X-->>AB: authorizationContext + lease 引用/过期信息（不含浏览器凭据）
    AB-->>A: 同源 context（不把用户身份放入 bridge 消息）
    A->>P: accept（仅协议绑定字段和 capabilities）
    P->>A: connect + MessageChannel
    Note over P,A: 首次成功后建立仅内存 activation；模型调用复用当前通道
    loop 每 30s ±20%（24–36s）
        P->>PB: 同源 lease poll（P 自己的 BFF）
        PB->>X: 查询 P 侧 ActiveLease
        X-->>PB: ACTIVE / REVOKED / EXPIRED
        PB-->>P: lease 状态
        A->>AB: 同源 lease poll（A 自己的 BFF）
        AB->>X: 查询 A 侧 ActiveLease
        X-->>AB: ACTIVE / REVOKED / EXPIRED
        AB-->>A: lease 状态
    end
    P->>B: P 控制的 child-frame prepare/commit
    B->>BB: B Cookie/JWT + B 业务 ACL
    BB-->>B: 最终业务允许/拒绝
```

这里的“显式用户操作”是产品交互约束：A 必须提供清楚可见的按钮或等价操作，并从该处理器调用
`adapter.connect()`。浏览器协议本身不能把一次 JavaScript 方法调用证明成可信的 user gesture；
因此 P BFF 仍必须独立执行 P 登录态、CSRF、target 和业务 ACL，不能仅凭
`handshake-request.reason === 'user'` 授权。

一次成功握手对应一个 bridge session 和一个 `ActiveLease`，不对应一次模型调用。连接存续期间，
观察、模型步骤和动作都复用同一 `MessageChannel`。成功 exchange 后 P/A 各自持有仅内存 activation，
但 activation 不是 lease 有效性的证明；P、A runtime 必须分别每 30 秒轮询各自同源 BFF（±20%，即
24–36 秒），由 BFF 查询 Auth。只有收到 `ACTIVE` 才能更新“最近一次正向确认”时间。Auth 返回
`REVOKED` 或 `EXPIRED` 时必须立即失败关闭；距离最近一次正向 `ACTIVE` 已超过 90 秒仍未重新确认时，
也必须失败关闭。失败关闭必须清除 activation 和 connection，安全地 settle/abort pending work，并禁止
automatic reconnect。登出、切换用户/租户/target/scope、权限或配置禁用以及 kill switch 都必须触发
相应 BFF/Auth revoke。显式断开若要求立即撤销，也必须先调用同源 BFF 的 revoke endpoint；
`adapter.deactivate()`/`host.deactivate()` 只负责传播和清理本地浏览器状态，既不等于 Auth revoke，也
不能证明 lease 已撤销或仍然有效。恢复必须由 A 用户显式点击连接，并完成全新的
issue/exchange/ActiveLease；不得 renewal 或复用已消费的 Grant。新的 A 文档加载也必须清除
activation，租户切换必须显式重新连接。

只要现有 lease 仍获得肯定 `ACTIVE`，产品可以保留 P 或 A 发起的 bridge/transport reconnect；但
reconnect 不得推进原 lease 的 `expiresAt`，也不得通过滚动创建新的 900 秒 lease 变相续租。如何让
新的 bridge binding 重新绑定到未过期 lease、如何退避和解决 P/A 竞态属于 AUTH-010 的 P1 合同；在
该合同冻结前，不得把当前 library 的 automatic reconnect 直接视为生产 ActiveLease reconnect。
`handshakeMode: 'parent-initiated'` 只用于一个版本的旧接入迁移，不应成为新部署默认值。

### 3.1 P BFF 的 issue

P Host 只在收到来自已绑定 iframe 的合法 `handshake-request` 后，以自己的会话调用同源、仅
POST 的 issue 路由。lease 失效、撤销或超过 90 秒未正向确认后不得自动重连；恢复只能从 A 用户
显式连接开始。P BFF 必须：

1. 从自己的 Cookie/JWT 和统一 SSO 会话得到 P subject；忽略浏览器请求中同名的用户、租户、
   订单或 target 字段。
2. 解析当前 P 的 `parentAppId`、环境、`integrationId` 和本次真实 target；执行 P 业务 ACL，
   判断用户是否能启用 A、访问该 root、请求这些能力以及操作这些 B。
3. 从受保护的 P session、当前 Integration/配置和 Host 预绑定上下文推导
   `parentAppId`、environment、`integrationId`、`configVersion`、scope、真实 target、
   `parentSessionBinding`、bridge/session、host/frame context；忽略浏览器请求中试图覆盖这些字段的值。
4. 以 P `serviceActor` 元数据调用 Auth `issue`，提交 P subject、`integrationId`、精确 P/A origin、
   scope、短 TTL、P 本次允许的 capabilities、明确的 B child subset 和上述服务端绑定。Auth 的
   integration maximum 不能被请求体扩大。
5. 只向 P 前端返回当前 Grant 所需的 `{ policy, claims }`，并使用 `Cache-Control: no-store`。
   原始 policy 不得写入 URL、Cookie、localStorage、埋点或普通日志。

issue 只完成“P 已批准发放一个尚未核销的委托”；它不等于 A 已登录，也不等于 B 已允许任何业务
mutation。

### 3.2 P Host 与 A Adapter 的 offer/accept

P Host 把 opaque `policy` 和协议绑定字段放入 offer。首次 offer 还必须回显 A 的
`handshakeRequestId`，使 A 只接受当前连接尝试的响应。offer 可以包含 `policyId`、
`sessionId`、`challenge`、`hostInstanceId`、`frameInstanceId`、精确 origins、capabilities
和受限 `frameContext`；不得增加 `issuer`、`tenantId`、`userId`、Cookie、JWT 或业务凭据。

A Adapter 先比较浏览器实际观察到的 P origin，再把 policy、完整 offer 和该 origin 发送到 A
BFF 的同源 exchange 路由。A 前端不能凭 HTTP 200 直接 accept；它必须逐字段重新核对返回 context
与 offer 的 `policyId`、origin、session、challenge、host/frame instance 和 capability 子集。
失败时应关闭 bridge 并降级为 A 本地助手。

A BFF 在自己的会话中获取 A subject，以双方约定的 A `serviceActor` 元数据调 Auth exchange。它不得
接受浏览器提交的 A subject，也不得使用“P 已 issue”作为 A 用户认证的替代。V1 不要求或验证技术
调用方凭据；Auth 记录 actor 元数据，但只对主体和授权上下文执行强制检查。

### 3.3 Auth exchange 与原子核销

Auth 在核销前必须完成以下检查。`serviceActor` 不属于这些强制检查项；它只作为双方约定的配置选择、
路由和审计元数据被记录：

| 检查         | 要求                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| integration  | `parentAppId`、`assistantAppId`、环境和 integration 状态一致；不能把一个 P 的 grant 用在另一个 P                              |
| subject      | P issue 记录的 canonical P subject 与 A exchange 提供的 canonical A subject 完全一致（`issuer`、`tenantId`、`userId`）        |
| origins      | P origin、A origin 和所有 B origin 都是配置中的完整 `scheme://host[:port]`；禁止 wildcard、`null`、路径和查询串               |
| capabilities | offer/A request 是 grant 与 integration maximum 的子集；B grant 是相应 P target、integration maximum 和 B maximum 的子集      |
| session      | Grant 的 server-side session binding 与当前 offer 的 bridge/session binding、host/frame instance 相符；注销或切换用户不得复用 |
| TTL/replay   | `nbf`/`exp`、时钟偏差和最大 TTL 有效；Grant 处于 `ISSUED` 且只能被一次有效 exchange 原子消费                                  |
| lease        | 成功 exchange 同一原子操作创建绑定完整上下文的 `ActiveLease(ACTIVE)`；有效期固定 900 秒、不可 renewal                         |

所有检查都通过后，Auth 才能把 Grant 从 `ISSUED` 原子迁移为 `CONSUMED`，并在同一原子操作中
创建 `ActiveLease(ACTIVE)`，再返回短期 `authorizationContext` 和 lease 引用/过期信息。ActiveLease
绑定 canonical subject 三元组、environment、P/A app、Integration/config、scope、target、
`parentSessionBinding`、bridge/session、host/frame context；不能通过 renewal 延长。上下文可以供
A BFF 进行后续服务端关联和审计，但不应把 canonical subject 复制进 A→P 的 bridge message。任何
检查或 lease poll 失败都应失败关闭，不通过放宽 origin、能力、主体或租约状态检查来“恢复可用性”。

P runtime 和 A runtime 只能分别轮询自己的同源 BFF；P BFF、A BFF 再查询 Auth 的 ActiveLease。
浏览器不得直接访问 Auth。轮询间隔固定为 30 秒并带 ±20% jitter（24–36 秒）；`ACTIVE` 是唯一
正向确认，`REVOKED`/`EXPIRED` 必须立即失败关闭，超过 90 秒没有新的正向 `ACTIVE` 也必须失败关闭。

## 4. 权限计算与安全不变量

最终能力必须是交集，不是任一层的并集。对 P 页面操作，定义：

```text
E_P = Auth 最大值
    ∩ P 业务 ACL
    ∩ P 本次目标
    ∩ Host 配置
    ∩ A 请求
```

对 B 业务操作，最终有效授权交集冻结为：

```text
E_B = Integration maximum
    ∩ P BFF tenant/business ACL
    ∩ requested Grant subset（含 ChildTarget）
    ∩ B final ACL
```

P Host/A request、精确 origin、source、bridge binding 和 `FrameBridgeHost` 声明是额外的协议门禁，
只能进一步收窄 `E_B`，不能扩大它。

因此：

-   P `deny` 和 B `deny` 都不能被 A 的人工 `allow` 覆盖；一次审批只对应一个当前 request。
-   P 的 `ChildTarget` 必须按稳定 `childId`、精确 origin 和最大 capabilities 显式配置；
    不扫描全部 iframe，不把 A origin 当作 B origin。
-   B V1 的最终决策来自 B BFF 的用户 session、tenant/object ACL、CSRF、幂等和业务状态，
    即使前端 bridge 已经 prepare 或 P/A 已经批准，B 仍可拒绝。
-   P、A、B 的登录切换、root/target 替换、导航或 reload 都会使旧 session、index、tree
    revision 和一次性 action token 失效；必须重新 observe 和重新授权。
-   每个 P 页面/标签页中的 A iframe runtime instance 都独立拥有 `frameInstanceId`、bridge session、
    `MessageChannel`、activation、任务状态和 per-Host auth client；不得把一个逻辑 A 的多个实例合并为
    一个全局运行时。A reload 会创建新实例并使旧 activation/session 失效。
-   服务端授权记录和 A 的仅内存运行时上下文按以下复合键隔离，不得只用全局 `userId` 或全局
    `integrationId`：

    ```text
    environment + assistantAppId + issuer + tenantId + userId + parentAppId
      + integrationId + scopeId + targetId + bridgeSessionId + hostInstanceId + frameInstanceId
    ```

-   `serviceActor` 不是服务端安全边界或调用方证明。V1 明确接受“任何能到达 Auth 的内部服务可冒充
    P/A serviceActor”的残余风险；因此网络可达性、BFF 自身会话校验、严格 canonical subject 三元组、
    Integration/context 校验、TTL、一次性 Grant、ActiveLease 轮询和失败关闭必须全部保持，不能用
    serviceActor 自报来放宽这些检查，也不能把 actor 匹配当成已经完成的调用方认证。

-   `postMessage`/`MessageChannel` 只传协议绑定字段、脱敏状态和动作摘要，不传用户身份、
    Cookie、JWT、policy 原文以外的业务凭据或 LLM secret。opaque policy 本身也只作为短期 bearer，
    不得写入 URL、日志或共享 `localStorage`；共享的 A 登录凭据不得作为 runtime instance 或 Grant 的
    标识。

## 5. 配置与数据模型

配置实体和运行时 grant 必须区分。下列字段是最小模型；具体存储 schema、ID 格式和版本由平台
实现冻结，但不能省略其语义。

| 实体           | 关键字段                                                                                                                                                                                                                                                                                                 | 作用与约束                                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AssistantApp` | `assistantAppId`, `environment`, `origins`, `serviceActorIds`, `status`                                                                                                                                                                                                                                  | 每个 environment 恰好一个逻辑 A 的注册信息；后端副本和 iframe runtime instance 不增加 A 数量。`serviceActorIds` 是逻辑配置/路由/审计元数据，不是技术认证。生产、测试环境分开注册，origin 按环境精确列出              |
| `ParentApp`    | `parentAppId`, `environment`, `origins`, `serviceActorIds`, `status`                                                                                                                                                                                                                                     | 多个逻辑 P 的注册信息。每个 P 可服务多个 tenant；tenant 是运行时 subject/session context，默认不是 ParentApp/Integration 注册键。不同 P 的 origin、BFF actor 和 ACL 不得混用；`serviceActorIds` 不构成安全边界       |
| `Integration`  | `integrationId`, `parentAppId`, `assistantAppId`, `environment`, `scopeId`, `parentOrigins`, `assistantOrigins`, `maxCapabilities`, `childTargets`, `configVersion`, `status`                                                                                                                            | 语义键为 `parentApp × assistantApp × environment × scope`；`scopeId` 为单数。一个 P 的多个 scope 对应多个 Integration；tenant 默认不改变该注册键                                                                     |
| `ChildTarget`  | `childId`, `origin`, `maxCapabilities`, `status`                                                                                                                                                                                                                                                         | 当前 Integration 可代理的一个 B 清单项；一个 Integration 可注册多个 B，`childId` 在 Integration 内稳定且唯一。`childTargets` 是全局最大值；V1 B 不必注册 Auth service actor                                          |
| `Grant`        | `grantId/jti`, `policyDigest`, `environment`, `parentAppId`, `assistantAppId`, `integrationId`, `configVersion`, `scopeId`, `targetId`, `parentSubject`, `origins`, `capabilities`, `childFrames`, `parentSessionBinding`, `bridgeSessionId`, `hostInstanceId`, `frameInstanceId`, `nbf`, `exp`, `state` | 不透明、一次性、短期委托；状态为 `ISSUED / CONSUMED / REVOKED`，一个 Grant 最多包含 8 个 B target。`childFrames` 是本次 B 子集，原始 policy 只在受控窗口短暂存在，Auth store 只存摘要；它不是运行时 lease 存活证明   |
| `ActiveLease`  | `leaseId`, `grantId/jti`, `state`, `subject`, `environment`, `parentAppId`, `assistantAppId`, `integrationId`, `configVersion`, `scopeId`, `targetId`, `parentSessionBinding`, `bridgeSessionId`, `hostInstanceId`, `frameInstanceId`, `capabilities`, `childFrames`, `issuedAt`, `expiresAt`            | 仅由成功 exchange 与 Grant 消费在同一原子操作中创建；状态为 `ACTIVE / REVOKED / EXPIRED`。绑定完整主体/环境/app/Integration/config/scope/target/session/bridge/host/frame 上下文；V1 有效期固定 900 秒、不可 renewal |

`Grant` 的 `parentSubject` 来源必须是 P BFF 自己验证的 SSO 会话；A exchange 时提供的 A subject
只允许来自 A BFF 自己验证的会话。不要用浏览器字段填充任一主体。

`Grant` 和 `ActiveLease` 是两个不同的状态机：opaque Grant 只负责一次 exchange 防重放，`exp`
到期后 `ISSUED` Grant 不可核销并可清理；成功 exchange 后 Grant 变为 `CONSUMED`，并同时创建
`ActiveLease(ACTIVE)`。撤销、过期和轮询只改变 ActiveLease，不会把已消费 Grant 重新变为可用。
ActiveLease 的 `expiresAt` 固定为创建后 900 秒（不 renewal）；其有效期不得超过源凭据/已批准上限，
任何不确定或无法查询状态都按失败关闭处理。

基数和上下文约束（冻结）如下：

-   每个 P 页面/标签页的 A iframe runtime instance 独立生成 `frameInstanceId`、bridge session、
    `MessageChannel`、activation、任务状态和 per-Host auth client；reload 创建新实例，不复用旧 activation/session。
-   每个 bridge session 只绑定一个 `environment`、`assistantAppId`、`issuer`、`tenantId`、`userId`、
    `parentAppId`、`integrationId`、`scopeId`、`targetId`、`bridgeSessionId`、`hostInstanceId` 和
    `frameInstanceId`。tenant、scope、target 或 iframe instance 切换使旧 activation/session 失效，
    必须显式重新连接。
-   每个 ActiveLease 必须绑定完整 canonical subject 三元组（`issuer`、`tenantId`、`userId`）、
    `environment`、`parentAppId`、`assistantAppId`、`integrationId`、不可变单调的 `configVersion`、
    `scopeId`、`targetId`、`parentSessionBinding`、`bridgeSessionId`、`hostInstanceId` 和
    `frameInstanceId`，以及该 Grant 的 capabilities/`childFrames`；不得只绑定全局 userId 或 Grant ID。
-   每个 P/Integration 可有多个 B `ChildTarget`。P BFF 根据当前 tenant/target 业务 ACL 从 Integration
    的全局 `childTargets` 中选择请求子集；一次握手可授权多个 B，但不为每次模型调用或每个 B 单独握手，且一个 Grant 最多 8 个 B target。
-   对 B 业务操作，有效授权是 `Integration maximum ∩ P-BFF tenant/business ACL ∩ requested Grant subset ∩ B final ACL`。
    P Host/A request、精确 origin、source、bridge binding 和 `FrameBridgeHost` 是额外的协议门禁，只能进一步收窄，不能扩大授权。
-   `tenantId`、`scopeId`、`targetId` 和 B 的 `childId` 是不同维度：tenant 来自各自验证会话的 BFF 的 canonical
    subject/session，scope 是 Integration 内的能力边界，target 是 P BFF 解析的本次业务对象或业务上下文，
    `childId` 才标识具体 B；四者不得互相替代。
-   bridge/session/integration/scope/target/activation/task context 不得写入共享 `localStorage`。A 登录凭据
    可以按浏览器 origin 共享，但不得用来标识 runtime instance 或 Grant。

推荐的配置关系是：

```text
AssistantApp（每个 environment 恰好一个逻辑 A） 1 ──── * Integration * ──── 1 ParentApp
                           │
                           └──── * ChildTarget

每次 P issue 生成一个 `Grant(ISSUED)`；Grant 只属于一个 Integration、一个 subject、一个 scope、一个
target/session，并可携带不超过 8 个 B target 子集。每次成功 A exchange 原子地将 Grant 变为
`CONSUMED` 并创建一个 `ActiveLease(ACTIVE)`；撤销/过期只作用于该 lease。
```

### 5.1 B 子集的双重约束

每个 Integration 的 `childTargets` 是全局最大清单，至少包括 `childId`、精确 `origin`、最大
capabilities 和启用状态。P BFF 在 issue 时从当前 tenant/target 的业务 ACL 解析允许的子集，把本次
实际允许的子集写入 `childFrames` grant；P 前端 Host 再用同一份已验证 claims 与本地 `ChildTarget`
精确比对。单个 Grant 的 B 子集最多 8 项。

Auth 只确认 grant 不超过 integration 的最大清单；P 的业务 ACL 和本次目标仍可进一步缩小。B
自身的 `FrameBridgeHost`/BFF 是最后一层，不能因为 Auth grant 中出现 B 就自动允许任何业务
对象或 mutation。

## 6. 受控内网 HTTP：明确的风险接受

当前部署模式允许 `trusted-intranet-http` 作为已明确接受风险的兼容模式，而不是安全等价替代。
公网、访客网、第三方专线或任何不可控网络必须使用 HTTPS。

HTTP 模式的硬规则：

1. 浏览器可以加载 HTTP 的 P/A/B，但仍只能使用精确 HTTP origin；`allowInsecureHttp` 必须由
   Auth 全局风险门和相应 integration-aware client 显式开启，对应 Integration 还必须登记
   `transportMode: 'trusted-intranet-http'`。三者默认关闭，不得把它做成全局宽松开关。
2. 浏览器使用 HTTP **不会降低 Auth 对授权上下文的服务端检查**：integration、P/A subject、exact
   origins、能力/B 子集、session binding、TTL/replay、ActiveLease 状态和原子状态迁移仍全部执行。
   `serviceActor` 只记录为配置/路由/审计元数据，不参与身份或授权拒绝；任何内部可达服务可冒充它的
   残余风险已被 V1 明确接受。
3. V1 目标允许 P BFF→Auth、A BFF→Auth 走受控内网 HTTP；HTTPS 仍是公网和一般生产部署的默认值，
   且可随时作为传输保护升级路径。Auth 不是浏览器 endpoint；不能以“浏览器是 HTTP”为理由增加
   browser→Auth 的网络直达路径或允许浏览器绕过自己的 BFF。
4. 网络必须由私有 DNS、VPN/零信任、设备准入、防火墙和 ACL 限定。HTTP 不提供传输保密性或
   完整性，能够监听/篡改内网流量的攻击者可能窃取或替换短期 bearer policy。
5. 继续使用一次性 Grant、固定 900 秒且不可 renewal 的 ActiveLease、30 秒 ±20% 轮询、90 秒
   无正向确认即失败关闭、审计和 kill switch；这些措施缩小暴露窗口，但不能把明文链路变成加密链路。
6. 单独验证 cookie 规则和浏览器行为：HTTP 不能使用 `Secure` cookie，跨站 iframe 常见的
   `SameSite=None` cookie 也要求 `Secure`；HTTPS 页面加载 HTTP iframe 会触发 mixed content。
   `localhost` 的特殊浏览器待遇不能代表普通内网域名/IP。

风险接受记录至少应标明网络范围、责任人、到期日期、可达性控制、cookie/session 方案和迁移到
HTTPS 的计划。没有该记录时，生产默认拒绝 HTTP。

## 7. 当前代码匹配与缺口

### 已落地、可以复用的部分

-   `parent-bridge` 协议已实现 P Host、A Adapter、精确 origin/source、协议版本、challenge、
    session、host/frame instance 和 capability 校验；P 是 B 代理的唯一路径。
-   `childFrames`/`ChildTarget` 的显式 grant、B 的 `FrameBridgeHost` 和 prepare/commit 约束
    已有协议与运行时基础；B 不需要安装 PageAgent 或调用 LLM。
-   `parent-bridge/integration-auth` 已提供独立 Auth 服务可复用的合同和领域引擎：包含
    `AssistantApp`、`ParentApp`、`Integration`、`ChildTarget`、canonical subject、P/A `serviceActor`
    元数据、issue/exchange、原子 Grant Store 和撤销接口。内存 Registry/Store 仅用于合同测试和 demo，
    不包含生产 ActiveLease Store 或 lease poll API。
-   integration-aware Authority 已按 `integrationId` 隔离多 P/多 scope 配置，比较 P/A subject，限制每个
    Integration 的 origin、capability 和 `childTargets` maximum，并在所有校验成功后一次性核销 Grant；
    当前领域参考实现还包含 actor 配置错配检查，但该检查不是冻结的生产身份/授权门禁，且当前没有与
    核销同原子创建 ActiveLease 的实现。
-   P Host 会在 issue 前生成 `sessionId`、`challenge`、`hostInstanceId`、`frameInstanceId`，通过
    `getEmbedPolicy(context)` 交给 P BFF/Auth 做真实预绑定；policy offer TTL 与 bridge session
    TTL 分离。
-   P Host 默认被动启动；A 的 `connect()` 发送无身份的 `handshake-request`，首次 offer 与该
    request ID 关联。当前 Host 在连接本地 expiry 后可能在 activation 仍为真时自动重连；这与
    lease 撤销/过期/90 秒无正向确认后必须清除 activation、失败关闭且禁止自动重连的生产契约不一致，
    适配仍待完成。显式 deactivate 和安全上下文变化会清除 activation。示例和 E2E 已提供可见“连接”
    按钮及点击前零 issue/exchange 的回归。
-   integration-aware browser client 只接收不含 canonical subject、serviceActor 和服务端会话
    引用的安全上下文。旧 `parent-bridge/managed-auth` API 保留一个版本并已标记 deprecated。
-   审批 timeout/cancel 的空引用和队列阻断已修复，并有 cancel、timeout、后续请求继续执行的
    回归测试；共享逻辑 A/多 P/不同 B、主体错配、当前参考实现的 actor 配置错配、B 子集和 Grant
    重放已进入单测/E2E。actor 错配测试不构成冻结的生产调用方认证要求；当前也没有 ActiveLease
    轮询、撤销传播或 fail-close 回归。这些是仓内参考覆盖，不等于生产环境已完成多租户并发、跨副本
    或完整基数矩阵验收。

当前实现的边界必须明确：`integration-auth-contracts.ts` 的 `ManagedAuthGrantState` 只有
`ISSUED | CONSUMED | REVOKED`；`integration-auth-authority.ts` 的 InMemory Store `revoke()` 只
处理尚未核销的 `ISSUED` Grant，`sweep()` 清理过期记录但没有 `EXPIRED` ActiveLease 状态。
`exchange()` 只完成 Grant consume，既不与 ActiveLease 创建同原子，也没有 lease status/poll API。
`host.ts` 的 `scheduleConnectionExpiry()` 在 activation 仍为真时可发布 automatic reconnect；当前
reconnect 还会生成新的 bridge binding/policy，而仓内没有把它重新绑定到原 ActiveLease 且保持原
`expiresAt` 的接口。因此生产所需的 ActiveLease、30 秒 ±20% 轮询、90 秒 stale fail-close、撤销后的
activation/connection 清理、禁止 automatic reconnect 和不延长 lease 的 rebind 尚未由仓内代码实现。

### 尚未达到生产公共 Auth 的部分

本仓库已经落地协议合同、领域引擎、浏览器接线和测试实现，但不承载生产 Auth 进程。实际 SSO、
Redis/数据库、HA 和运维能力必须在独立服务仓库实现并部署；V1 不把 BFF→Auth 技术调用方认证
（例如 mTLS 或 service JWT）列为前置条件，而必须记录并接受受控内网中的 serviceActor 冒充残余风险。
以下差距必须在生产 gate 前关闭：

| 优先级 | 缺口                                           | 影响与完成条件                                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0     | 独立生产 Auth 服务尚未建设                     | 在独立服务仓库接入真实 P/A BFF endpoint、SSO subject 解析、逻辑 `serviceActor` 配置/审计、秘密管理、ActiveLease poll/revoke API；浏览器只能访问自己的 BFF，不得直连 Auth                                                                                                                                                                            |
| P0     | 生产 Registry、Store、HA 和 kill switch 未落地 | 用配置数据库和生产共享原子 TTL store 实现合同接口，验证 Grant 原子核销与 ActiveLease 创建、ActiveLease 状态/TTL/撤销/过期、轮询、限流、指标、审计、容量、灾备和故障失败关闭；禁止 `InMemory*`，首版采用单区域强一致                                                                                                                                 |
| P0     | 真实 SSO/subject 规范化尚未接线                | P/A BFF 必须忽略浏览器身份字段，各自验证登录态并产生严格 canonical subject 三元组；`serviceActor` 来自双方固定环境配置，仅作配置选择/路由/审计，不得依赖请求自报或 actor 匹配来证明技术调用方                                                                                                                                                       |
| P0     | ActiveLease 运行时适配尚未完成                 | P/A runtime 分别以 30 秒 ±20%（24–36 秒）轮询自己的同源 BFF；`REVOKED`/`EXPIRED` 或 90 秒无正向 `ACTIVE` 必须立即失败关闭，清除 activation/connection、settle/abort pending work，并禁止 automatic reconnect；恢复须 A 用户显式连接并 fresh issue/exchange/lease                                                                                    |
| P1     | 应用运行时上下文隔离仍由 A 产品实现            | 每个 P 页面/标签页的 A iframe runtime instance 独立拥有 session、channel、activation、任务和 per-Host auth client；服务端/仅内存上下文按 `environment + assistantAppId + issuer + tenantId + userId + parentAppId + integrationId + scopeId + targetId + bridgeSessionId + hostInstanceId + frameInstanceId` 隔离；浏览器只获得最小无身份授权上下文 |
| P1     | A JWT audience、短 token、刷新和存储策略待定   | 固定 `aud=A-BFF`，不转发浏览器 JWT；在发布前决定短 TTL、刷新、内存/会话存储和登出失效行为                                                                                                                                                                                                                                                           |
| P1     | 生产级故障与浏览器矩阵尚未验证                 | 在真实域名覆盖注销/reload、跨节点并发核销、ActiveLease 撤销/过期与 poll 延迟、Redis/SSO/Auth 故障、cookie/CSP/sandbox、HTTP 风险模式、限流与 kill switch；仓内 E2E 不能替代生产环境验收                                                                                                                                                             |

上述缺口不是通过放宽浏览器校验或把 B 直接接入 A 来规避的；必须在服务端补齐。

## 8. V1 / V2 边界与分级落地路线

### V1：P↔A 公共 Auth，B 保持自有认证

V1 的目标是一个公共 Auth 控制面服务多个 P↔A `Integration`：

-   每个 environment 恰好一个逻辑 A（一个 `AssistantApp`、A BFF 和 `serviceActor` 元数据归属），多个 P 各自
    在页面/标签页中嵌入独立 A iframe runtime instance；每个 P 可服务多个 tenant。
-   每个 `Integration` 的 `childTargets` 是 B 全局 maximum，P BFF 按 tenant/target ACL 选择子集；一次
    handshake 可授权多个 B，单个 Grant 最多 8 个 B target，不为每个模型调用或每个 B 单独握手。
-   P BFF issue、A BFF exchange；双方提交逻辑 `serviceActor` 元数据，Auth 比较严格相等的 P/A
    canonical subject 三元组；V1 不要求技术调用方认证，并明确接受可达内部服务冒充该元数据的残余风险。
-   Auth 使用一次性 opaque Grant、共享原子 TTL Store、成功 exchange 原子创建固定 900 秒且不可
    renewal 的 `ActiveLease`、30 秒 ±20% poll、审计、限流、指标和 kill switch。lease 有效期间允许的
    transport reconnect 不能推进原 `expiresAt`；具体 rebind/退避/竞态接口留在 AUTH-010 P1。
-   浏览器只访问各自 BFF；A→当前 P→B；B V1 不调用 Auth，B BFF 做最终授权。Auth 不在 V1 维护
    tenant-specific 业务授权 overlay。
-   `trusted-intranet-http` 只有在单独风险接受记录和网络控制齐备时启用；HTTPS 仍是公网和一般生产
    部署的默认值，浏览器和 Auth 的 backend-only 边界不变。
-   P/A runtime 只能轮询自己的同源 BFF，由 BFF 查询 Auth；`REVOKED`/`EXPIRED` 或 90 秒无正向
    `ACTIVE` 必须失败关闭并禁止 automatic reconnect，恢复须 A 用户显式连接并 fresh issue/exchange/lease。

V1 不包括：B→Auth 的统一业务授权、A 直连 B、浏览器直连 Auth、把身份放进 bridge message、
长期 bearer、跨 P 的全局 grant 或用 Auth 代替 B 业务 ACL。

### V2：按需要扩展，不得提前混入 V1

只有在跨组织、B 需要统一授权、或离线验签等需求明确后，才评估 V2，例如：

-   为 B 注册独立 integration/service actor，让 B BFF 参与 Auth；
-   采用版本化 ES256/JWKS 或联邦验证，并继续使用 `jti` 原子防重放；
-   细化跨租户委托、集中撤销和跨区域一致性。

V2 仍不能改变 A→P→B 的浏览器路由和 B 最终业务拒绝权。迁移期间按明确版本/issuer 分流，
不能同时接受无法区分类型的任意 token。

### 分级落地

1. **已完成的仓内基线**：integration-aware 合同、Registry/Authority/Store 接口、主体与逻辑
   `serviceActor` 元数据合同、每个 Integration 的 B maximum、A 显式首次握手、Host 预绑定、旧 API
   兼容层、审批阻断修复和仓内多 P/主体/replay 测试；当前 actor 配置错配检查只是参考实现，
   ActiveLease/poll/fail-close 尚未实现。
2. **P0 生产基础设施**：在独立服务仓库部署公共 Auth、生产共享原子 TTL Store、单区域强一致优先、HA、
   ActiveLease poll/revoke、审计、限流、指标、告警和 kill switch；失败关闭，禁止 demo server、静态身份
   和 `InMemory*` store 进入生产。V1 不把 mTLS、service JWT 或其他技术调用方认证列为部署前置条件。
3. **P1 集成与隔离**：将每个 P 的策略解析、ChildTarget、B 子集和复合上下文隔离接入；固定
   A `aud=A-BFF`、短 token/刷新/存储策略；验证 B V1 自有 BFF ACL。
4. **P1 受控灰度**：先在 HTTPS 预生产验证协议、cookie、CSP、sandbox、真实 LLM 和失败关闭；
   如启用 trusted-intranet-http，先完成风险接受和真实内网域名验证，再按内部租户逐步放量。
5. **P2 运行成熟**：完成多实例原子性、容量/故障演练、subject/integration 错配告警、撤销和
   回滚演练。V2 需求另行评审，不把未定方案写入 V1 合同。

## 9. 已冻结选择与剩余生产决策

以下 V1 受控内网 P0 选择已冻结（2026-08-31）；完整决策记录见
[ADR-0001：P / A / B / Auth V1 P0 基线](./adr/0001-parent-bridge-auth-v1-p0-baseline.zh-CN.md)：

-   生产 Auth 位于独立服务仓库；本仓库只提供合同、领域引擎和测试实现。新接入使用 integration-aware
    API，旧 API 兼容一个版本；首次握手必须由 A 的显式用户操作触发，Host 默认被动等待。
-   拓扑基数为每个 environment 恰好一个逻辑 A、多个 P；每个 P 可服务多个 tenant，并可按
    `parentApp × assistantApp × environment × scope` 注册多个 Integration；每个 Integration 可注册多个 B，
    单个 Grant 的 B 子集最多 8 个。tenant 是运行时 subject/session context，不是默认的 Integration 注册键；
    每个 P 页面/标签页中的 A iframe runtime instance 必须独立持有 bridge、activation、任务和授权状态。
-   使用当前 `AssistantApp`/`ParentApp`/`Integration`/`ChildTarget` Registry 字段；每个 environment 的
    标识唯一，生产和测试隔离。`configVersion` 不可变且单调递增，配置更新必须原子发布。
-   P BFF 从受保护 session、当前配置和 Host 预绑定上下文推导完整 context；浏览器只能访问自己的 BFF，
    不得直连 Auth。P BFF issue、A BFF exchange，B V1 保持自有 BFF 和最终 ACL，不调用 Auth。
-   `serviceActor` 仅是双方约定的配置选择、路由和审计元数据；不校验实际调用方或方向真伪，也不作为
    身份、授权或请求拒绝依据。V1 不要求 mTLS、service JWT 或等价技术调用方认证；任何内部可达服务
    冒充 P/A `serviceActor` 的残余风险已被明确接受。
-   canonical subject 必须严格比较 `issuer + tenantId + userId` 三元组；浏览器提交的主体字段一律不可信。
-   policy TTL 默认 120 秒、最大 300 秒；clock skew 为 5 秒。成功 exchange 必须原子消费一次性 opaque
    Grant 并创建 `ActiveLease(ACTIVE)`；V1 lease/context 固定 900 秒、不可 renewal，schema 上限为 3600 秒，
    且不得超过源 credential。policy 不 refresh、不 reuse；任何允许的 reconnect 都不得推进原 lease
    `expiresAt`，具体 rebind 合同仍是 P1。
-   ActiveLease 绑定完整 subject/environment/apps/Integration/config/scope/target/
    `parentSessionBinding`/bridge/host/frame context，状态为 `ACTIVE | REVOKED | EXPIRED`。logout、用户或
    tenant/target/scope 改变、权限或配置禁用、kill switch 都可触发撤销；`deactivate` 只做传播/清理，不是
    lease proof。
-   P/A runtime 各自每 30 秒轮询自己的同源 BFF，jitter 为 ±20%（24–36 秒），由 BFF 查询 Auth；
    `REVOKED`/`EXPIRED` 必须立即失败关闭，距离最近一次正向 `ACTIVE` 超过 90 秒未重新确认也必须失败关闭。
    失败关闭清除 activation/connection，安全 settle/abort pending work，并禁止 automatic reconnect；恢复须 A
    用户显式连接并 fresh issue/exchange/lease。
-   `trusted-intranet-http` 只在受控网络和单独风险接受记录齐备时允许；HTTPS 仍是一般生产默认值。
    生产使用共享原子 TTL store、fail-closed，首版以单区域强一致为优先，禁止 `InMemory*` store。

以下内容是高层摘要。每个问题的稳定编号、状态、责任边界、推荐默认值、验收证据和更新历史见
[架构待决事项台账](./parent-bridge-architecture-open-issues.zh-CN.md)。

生产发布前仍必须记录：

-   `AssistantApp`/`ParentApp`/`Integration` 的 schema 版本、环境命名、origin 注册和逻辑 `serviceActor`
    元数据生命周期由谁维护；如何保证 `configVersion` 不可变、单调和原子发布？
-   统一 SSO 的 `issuer` canonicalization 和必要映射由哪个平台配置维护；实现如何持续保证主体比较严格
    要求 `issuer + tenantId + userId` 三元组全等？
-   每个 P 的 policy strategy、ChildTarget/B maximum 清单、targetId 解析如何落入已冻结的 scope/target
    绑定；权限/配置禁用和 kill switch 的撤销事件由谁产生、审计什么？
-   P BFF 应把哪个不透明的服务端 P 会话引用写入 `parentSessionBinding`；登录切换、登出、SPA 导航、
    A/B reload 时由谁调用 revoke，如何观测并满足最长 90 秒正向确认窗口？
-   在已冻结“生产共享原子 TTL store、fail-closed、单区域强一致优先”前提下，Store/HA 的具体技术、
    compare-and-delete、审计保留期、容量、灾备和故障演练目标是什么？
-   A BFF 的短 token/会话刷新与存储策略是什么；如何确保已冻结的 `aud=A-BFF`、不会把 JWT 盲转 Auth，
    且 stop/cancel 后及时失效？
-   trusted-intranet-http 的风险接受人、网络边界、cookie 方案、到期日期和 HTTPS 迁移计划是
    什么？
-   生产 release gate、真实环境 E2E 矩阵、告警阈值、kill switch 操作人与回滚版本是什么？

在这些决策记录完成前，不能把仓内 integration-aware 参考实现描述为已经部署的生产公共 Auth，
也不能宣称 P/A/B 的完整跨系统授权已经上线。
