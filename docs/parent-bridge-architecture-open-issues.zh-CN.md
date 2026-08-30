# P / A / B / Auth 架构待决事项台账

本台账用于记录跨域助手进入独立生产实现前仍需作出的架构、接口、运维和验收决策。它不替代
[P / A / B 与公共 Auth 权威架构](./parent-bridge-auth-architecture.zh-CN.md)、
[iframe PageAgent 生产部署手册](./parent-bridge-production-deployment.zh-CN.md) 或
[父页面控制器桥接协议](./parent-bridge.zh-CN.md)；协议细节只在这些权威文档中维护。

“建议默认值”是待 ADR 批准的提案，不表示已经实现或已经获得安全批准。仓内代码是合同、领域
引擎和测试参考实现；生产 Auth、真实 SSO、服务身份、共享 Store、HA 和运维能力属于独立服务
及部署系统。

## 1. 冻结基线

以下事实视为本台账的输入，不在待决事项中重新讨论：

-   拓扑基数冻结为：每个 `environment` 恰好一个逻辑 A（一个 `AssistantApp`、A BFF 和 service
    identity 归属；后端副本仍是同一个逻辑 A，生产/测试环境分开），多个逻辑 P，以及每个
    P/Integration 可注册多个 B `ChildTarget`。浏览器操作路径固定为 `A → P → B`，P 是唯一父页
    代理，B 保留最终业务拒绝权。
-   每个 P 页面/标签页都嵌入自己的 A iframe runtime instance，并独立拥有 `frameInstanceId`、bridge
    session、`MessageChannel`、activation、任务状态和 per-Host auth client；A reload 创建新实例。
    一个逻辑 A 不等于一个 iframe 或一个进程。
-   每个 P 可服务多个 tenant；tenant 是运行时 canonical subject/session context，默认不是
    `ParentApp`/`Integration` 注册键。`Integration` 的语义键为
    `parentAppId × assistantAppId × environment × scopeId`；一个 P 的多个 scope 对应多个 Integration。
-   P、A、B 分别通过自己的 BFF 和统一 SSO 验证会话；浏览器不直接调用 Auth，也不把浏览器
    Cookie/JWT 交给 Auth。P/A 的 canonical subject 由各自 BFF 产生。
-   P BFF 负责 issue，A BFF 负责 exchange；Auth 比较受信的 service actor、P/A subject、
    Integration、origin、scope、能力、bridge binding、TTL 和一次性消费状态。每个 bridge session
    只绑定一个 `environment`、`assistantAppId`、`issuer`、`tenantId`、`userId`、`parentAppId`、
    `integrationId`、`scopeId`、`targetId`、`bridgeSessionId`、`hostInstanceId` 和 `frameInstanceId`；
    tenant、scope、target 或 iframe instance 切换会使旧 activation/session 失效并要求显式重新连接。
-   首次握手必须由 A 的可见用户操作触发；自动重连只在 activation 和安全上下文仍然有效时允许。
    一个连接只属于一个 Integration、scope、target 和 bridge session。
-   `packages/page-controller/src/parent-bridge/integration-auth*` 提供合同、领域引擎和测试参考；
    `InMemory*` 实现不能作为生产共享 Registry/Store。旧 `managed-auth` 只作迁移兼容层。
-   每个 Integration 的 `childTargets` 是 B 的全局最大清单，P BFF 按 tenant/target 业务 ACL 选择
    请求子集；一个 Grant 最多包含 8 个 B target，一次握手可以授权多个 B，不按模型调用或 B
    单独握手。有效 B 授权为 `Integration maximum ∩ P-BFF tenant/business ACL ∩ requested Grant subset ∩ B final ACL`。
-   精确 origin、最小 capability、B 的显式 ChildTarget、P/A source 校验和 B 后端最终 ACL
    是既定不变量；`tenantId`、`scopeId`、`targetId` 和 B 的 `childId` 是不同维度。bridge/session/integration/
    scope/target/activation/task context 不得写入共享 `localStorage`；A 登录凭据可以按 origin
    共享，但不得作为 runtime instance 或 Grant 标识。受控内网 HTTP 仍是风险接受项，不是默认安全模式。

## 2. 状态与优先级

每项分别记录一个**决策状态**和零到多个**落地标签**，避免把“已经决定”误写成“已经上线”。
稳定编号只用于引用，不表示优先级；事项升降级时不得改号。

| 决策状态 | 含义                                                               |
| -------- | ------------------------------------------------------------------ |
| `未冻结` | 尚未由责任方作出可引用的决定，不能作为实现合同。                   |
| `已冻结` | 已有批准的 ADR、责任人和生效范围；不表示代码、部署和测试已经完成。 |

| 落地标签     | 含义                                                       |
| ------------ | ---------------------------------------------------------- |
| `仅文档`     | 文档已有原则或清单，但缺少可执行合同、配置或验收证据。     |
| `参考实现`   | 仓内有单元测试或领域实现，只证明行为样例，不证明生产能力。 |
| `需对齐`     | 代码、文档、schema 或命名之间存在需要正式决策的差异。      |
| `缺实现`     | 约定的仓内库、SDK 或应用接线尚未完成。                     |
| `缺生产实现` | 需要在独立服务、基础设施或 BFF 中落地，仓内尚未承载。      |
| `缺测试`     | 需要真实浏览器、跨实例、故障注入或安全验收，现有单测不足。 |
| `已验证`     | 当前生效版本的实现、部署和验收证据均已附到台账。           |

-   **P0**：安全边界或生产上线的前置条件；未关闭时不得放量。
-   **P1**：会阻塞独立实现、跨团队集成或回归验收，但可以在 P0 结论后并行。
-   **P2**：迁移、成熟度或长期运维事项；不能用来掩盖未关闭的 P0/P1。

当前 21 项都会阻塞生产合同、集成或验收，因此本版没有把已知事项降为 P2；后续新增的长期优化
可以使用 P2。

每项的“建议默认值”都必须经过对应 owner 的 ADR 批准后，才能把决策状态改为 `已冻结`；只有
同时清除适用的 `缺实现`、`缺生产实现`、`缺测试`、`需对齐` 并附上证据，才能标记 `已验证`。

## 3. 优先级待决事项

### P0：上线前必须冻结

#### AUTH-001 — 生产 Auth HTTP API 与 service identity

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺生产实现`
-   **当前证据/缺口**：`ManagedAuthExecutionContext` 只是一组普通的 actor/subject 字段（`packages/page-controller/src/parent-bridge/integration-auth-contracts.ts:22-33`）；领域引擎直接接收该 context（`integration-auth-authority.ts:573-587,682-700`）。权威架构明确真实 Auth、SSO、mTLS 尚未建设（`docs/parent-bridge-auth-architecture.zh-CN.md:332-345`），但尚未冻结 Auth endpoint、请求签名、actor 注入、HTTP 状态和响应头合同。
-   **要记录的决策**：Auth endpoint 的路径/版本、P/A 调用方向、mTLS 或短期 service token、actor 与 app/environment 的绑定、密钥轮换、超时和安全错误映射。
-   **建议默认值（待 ADR）**：Auth 只接受后端服务调用；由 mTLS 身份或短期签名 service JWT 映射 actor，拒绝请求 JSON 自报 actor；浏览器不得直连 Auth。
-   **责任人**：`<Auth 平台>`、`<服务身份/安全>`
-   **验收证据**：公开的 HTTP/OpenAPI 合同；伪造 actor/app/environment 的拒绝测试；密钥轮换演练；浏览器直连和匿名调用均失败的网关证据。

#### AUTH-002 — canonical subject 与 issuer 映射

-   **决策状态**：`未冻结`；**落地标签**：`参考实现`
-   **当前证据/缺口**：代码只按 `issuer + tenantId + userId` 做字符串全等（`integration-auth-authority.ts:183-210,249-253`）；文档仍把 issuer canonicalization、跨 issuer 映射和维护方列为待决（`docs/parent-bridge-auth-architecture.zh-CN.md:49-61,397-403`）。`authenticatedAt`/`credentialExpiresAt` 的比较、规范化和审计含义也未冻结。
-   **要记录的决策**：统一 SSO 的 issuer canonicalization、大小写/Unicode/租户命名规范、跨 issuer 是否允许映射、映射版本和主体全等规则。
-   **建议默认值（待 ADR）**：每个 Integration 使用一个明确的 canonical issuer；默认严格比较三元组；跨 issuer 只能经版本化、受信的映射表，不接受浏览器提供的别名。
-   **责任人**：`<SSO/身份平台>`、`<Auth 平台>`
-   **验收证据**：同用户/异 issuer、异租户、异 user、大小写和过期凭据的矩阵测试；映射变更和审计样例。

#### AUTH-004 — active session binding、logout 与 revoke

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺生产实现`
-   **当前证据/缺口**：`parentSessionBinding` 在 issue request 中是可选字段（`integration-auth-contracts.ts:99-110`），领域引擎只存储它（`integration-auth-authority.ts:656-660`）；exchange 的 expectation 没有当前 P 会话或该 binding，`revoke` 只是裸 selector 调用（`integration-auth-authority.ts:707-761,789-790`）。内存 Store 的 `revoke` 还只处理 `ISSUED` 记录，不会终止已经 `CONSUMED` 的活动 bridge session（`integration-auth-authority.ts:494-502`）。文档要求登出、用户切换和撤销清除 activation，但未指定触发方、活动连接执行机制和最长延迟（`docs/parent-bridge-auth-architecture.zh-CN.md:146-151,397-405`）。
-   **要记录的决策**：binding 的来源和摘要算法、logout/租户切换/权限撤销/kill switch 的事件、谁调用 revoke、活动 session 是通过可撤销 lease、P/A 推送 deactivate、周期性 revalidation 还是短 TTL 终止，以及传播 SLA 和失败策略。
-   **建议默认值（待 ADR）**：binding 必须是不可逆的 P 会话引用；P 事件先阻止新 issue/exchange，并撤销未消费 grant；Auth 记录可撤销的 active-session lease，P/A 在事件或 revalidation 时清除 activation 和连接。短 TTL 只作为失效上界，不能代替登出事件；超过撤销 SLA 必须失败关闭。
-   **责任人**：`<P BFF>`、`<Auth 平台>`、`<安全响应>`
-   **验收证据**：issue 前后 logout、exchange 后 logout、跨节点撤销、切租户/target、配置禁用和 kill switch 测试；活动连接在 SLA 内关闭且后续操作失败；撤销事件含原因、时间和关联 ID。

#### AUTH-005 — scope / target / context binding 边界

-   **决策状态**：`未冻结`；**落地标签**：`参考实现`
-   **当前证据/缺口**：权威架构已冻结 tenant、scope、target 的维度和一次 Grant 的绑定粒度：P BFF 从受信会话与 ACL 派生业务 `targetId` 和最多 8 个 B 的 `childFrames` 子集；一个 session 只绑定一个 subject/tenant、Integration、scope、target 和 bridge binding。Auth issue 合同已有这些字段（`integration-auth-contracts.ts:99-110`），但 P 浏览器 client 只提交 integration、origin、scope、capability 和 bridge binding（`integration-auth-client.ts:446-463`），因此生产 P BFF 的字段来源、root/target 解析和 `parentSessionBinding` 合同仍未冻结。
-   **要记录的决策**：scope 与 root 的精确映射、`targetId` 的格式和服务端 resolver、`parentSessionBinding` 是否强制、P BFF 如何从 tenant/target ACL 选择 B 子集，以及浏览器请求 schema 的允许字段。
-   **建议默认值（待 ADR）**：浏览器只提交 bridge binding 和固定 Integration 选择；P BFF 独立派生 subject、target、root、capability 和 B 子集，Auth/Host 逐层收窄。不得把 `tenantId`、`targetId` 或 B 清单改成浏览器自报的授权依据。
-   **责任人**：`<P 业务/BFF>`、`<Auth 平台>`
-   **验收证据**：服务端请求 schema 与字段来源表；错误 tenant/target/root、同一用户跨 target、B 子集缺失/扩大/超过 8、scope 与 binding 错配的 issue/exchange 测试；tenant/target 切换后旧连接失效。

#### AUTH-007 — trusted HTTP 与浏览器会话安全合同

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：文档要求 Auth 风险门、Integration `transportMode` 和 P client 三方显式启用 HTTP，并要求单独验证 cookie、CSP、网络边界（`docs/parent-bridge-auth-architecture.zh-CN.md:283-306`；`docs/parent-bridge-production-deployment.zh-CN.md:37-89`），但风险接受记录没有机器可读格式或 owner。P client 使用 same-origin cookie POST、没有 CSRF 字段（`integration-auth-client.ts:446-465`）；P/A BFF 的 CSRF、CORS、Cookie/JWT、policy 存储和 CSP 组合未冻结。
-   **要记录的决策**：HTTP 网络范围/责任人/到期日、Secure/SameSite/分区 cookie 方案、CSRF token 与 Origin 校验、CORS allow-list、CSP `frame-src`/`frame-ancestors`/`connect-src`、policy/短 token 的存储位置。
-   **建议默认值（待 ADR）**：生产默认 HTTPS；HTTP 仅接受有到期日的风险批准和私网证明；浏览器 BFF 使用显式 CSRF header + Origin 检查，禁止 wildcard CORS；原始 policy 只在短时内存中存在。
-   **责任人**：`<安全/网络>`、`<P/A 平台>`、`<浏览器兼容性>`
-   **验收证据**：真实内网域名/IP 和目标浏览器的 cookie/CSP/mixed-content/CSRF/CORS 矩阵；响应头扫描；HTTP 风险记录与到期提醒；浏览器不能调用 Auth 的网络日志。

#### AUTH-008 — credential/session TTL、clock skew 与刷新

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺测试`
-   **当前证据/缺口**：Authority 默认 policy/bridge TTL 为 120 秒/15 分钟，且有硬上限（`integration-auth-authority.ts:42-45,611-629`）；Integration 的最大 TTL 字段可选且 resolve 阶段没有统一边界校验（`integration-auth-contracts.ts:70-72`；`integration-auth-authority.ts:804-835`）。Client 与服务端对时钟偏差和过期窗口的合同也不同（`integration-auth-client.ts:251-275,344-359`）。文档仍要求决定 A JWT 短 token、刷新、存储、时钟和审计保留期（`docs/parent-bridge-auth-architecture.zh-CN.md:397-409`）。
-   **要记录的决策**：P/A/B 会话、policy-offer、bridge session、authorization context 和短 token 的 TTL；clock skew；是否允许刷新；stop/deactivate/logout 后的失效时间。
-   **建议默认值（待 ADR）**：服务端统一计算严格过期时间并在 Registry 加载时拒绝非法 TTL；policy 不刷新、不复用，bridge TTL 独立且不超过用户凭据；节点时钟同步，偏差只用于明确的 nbf 容忍窗口。
-   **责任人**：`<Auth 平台>`、`<SSO/A 平台>`、`<SRE>`
-   **验收证据**：边界秒数、节点时钟偏差、凭据临近过期、刷新/登出/stop 的测试；非法配置启动失败；TTL 指标与保留期证明。

#### AUTH-014 — cross-scope / cross-integration boundary

-   **决策状态**：`未冻结`；**落地标签**：`参考实现`
-   **当前证据/缺口**：权威架构已冻结 `Integration = parentApp × assistantApp × environment × scope`、一个 P 的多个 scope 使用多个 Integration、一个 bridge session 只属于一个 scope，且跨 scope 动作分别授权、分别执行，不具备原子事务语义。Authority 已按 integration/app/environment/scope 校验（`integration-auth-authority.ts:699-720`）。仍未冻结的是 ID 的全局/环境内唯一格式、跨 region 的命名空间和例外审批流程。
-   **要记录的决策**：`integrationId`/`scopeId` 的规范格式与唯一性范围、跨 region/环境 Registry 的隔离方式，以及确需例外时的新 Integration 版本与审批流程。
-   **建议默认值（待 ADR）**：ID 在 environment Registry 内唯一且带稳定的 parent/scope 语义；生产、测试 Registry 物理或逻辑隔离。任何跨 scope/环境例外都创建新的版本化 Integration，不复用现有 grant/context。
-   **责任人**：`<Auth 平台>`、`<P/A 产品>`、`<多租户安全>`
-   **验收证据**：同一逻辑 A 下多 P、同一 P 多 scope/tenant、不同环境和不同 B 的交叉交换测试；跨 scope 任务使用独立授权且部分成功不会扩大权限；context cache/日志键包含冻结的复合隔离键。

#### AUTH-020 — 多实例隔离、HA、SLO 与故障矩阵

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺生产实现` · `缺测试`
-   **当前证据/缺口**：仓内 Store 是单进程实现，生产合同要求跨副本原子 consume/revoke 和保留状态（`integration-auth-authority.ts:443-510`；`integration-auth-contracts.ts:156-173`）。架构已冻结一个逻辑 A 可有多个 HA 后端副本并同时服务多个 P/tenant/A iframe runtime instance，但共享 Registry/Store、容量、灾备、kill switch 和完整基数矩阵仍未生产验证。
-   **要记录的决策**：共享 Store 技术与一致性级别、compare-and-delete 语义、跨 AZ/RPO/RTO、限流和容量、Auth/LLM/握手超时、告警阈值、故障时降级与值班责任。
-   **建议默认值（待 ADR）**：生产禁用 `InMemory*`；使用共享原子 TTL Store 和 fail-closed；跨副本用条件更新保证一次消费，先按单区域强一致达标再扩展跨区域。
-   **责任人**：`<Auth/SRE>`、`<平台运维>`、`<P/A/B 值班>`
-   **验收证据**：并发双 exchange、跨节点 revoke、Store/SSO/Auth/LLM/Host/B 超时与恢复、容量压测、RPO/RTO 和真实浏览器 cookie/CSP/HTTP 报告；至少两个 P、同一 P 两个 tenant、多个并发 A iframe、多个 B 以及单 Grant 8/9 B 边界矩阵；签署的 SLO/故障报告。

#### AUTH-003 — Registry schema 与 configVersion 治理

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺生产实现`
-   **当前证据/缺口**：权威架构与 TypeScript 合同已经对齐 `environment`、`origins`、
    `serviceActorIds`、`scopeId`、`childTargets` 和 `configVersion`，并冻结每个 environment 一个逻辑
    `AssistantApp`、多个 `ParentApp`、`Integration = P × A × environment × scope`、tenant 作为运行时
    context、每个 Integration 多个 B 的基数。仓内 Registry 仍只是参考实现；生产 schema、ID 与环境
    命名空间、`configVersion` 的单调发布/回滚/禁用语义、actor 生命周期和配置分发机制尚未冻结。
-   **要记录的决策**：Registry 的规范持久化 schema、ID/环境格式、每环境单一 A 的约束方式、actor
    生命周期、`configVersion` 发布/回滚/禁用语义和向后兼容策略。
-   **建议默认值（待 ADR）**：沿用当前合同字段；配置采用不可变版本和原子发布，版本单调递增，旧
    grant 在 exchange 时因版本变化拒绝；每个 environment 只允许一个启用的 `AssistantApp`；tenant
    默认复用同一 Integration，由 P BFF 在运行时收窄，不创建 tenant-specific Registry 记录。
-   **责任人**：`<Auth 配置平台>`、`<平台架构>`
-   **验收证据**：版本化 schema/迁移脚本；同环境第二个逻辑 A、非法/重复 actor、origin、child ID 和
    跨环境配置的拒绝测试；多 P、同一 P 多 scope/tenant 复用和多 B 注册测试；配置切换时旧 grant
    拒绝且新 grant 可用。

#### AUTH-006 — B subject consistency 与 V1 边界

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：权威架构已冻结每个 Integration 可注册多个 B、P BFF 按 tenant/target ACL
    选择本次子集，以及四层有效权限交集。V1 的 B 不调用 Auth；Authority 只比较 P/A subject，B BFF
    仍独立验证自己的 session、tenant/object ACL、CSRF 并保留最终 deny。尚未冻结的是：具体业务是否
    必须证明 B 与 P/A 为同一主体、P BFF→B BFF 的服务端绑定证明格式，以及 V2 让 B 进入 Auth 时的迁移边界。
-   **要记录的决策**：V1 “不由 Auth 比较 B subject”的适用范围；B 自己的 session 与 P grant/业务
    target 的服务端关联字段；需要三方同主体时的 P→B 证明；V2 B→Auth 的新 actor/integration 版本和跨租户规则。
-   **建议默认值（待 ADR）**：B 每个业务请求始终独立认证授权；不要求三方同主体的业务沿用 V1。
    如果业务必须证明三方是同一主体，则增加受信的 P BFF→B BFF subject-binding，或让 B 以新版本
    Integration 进入 Auth。不得把浏览器传入的 user-id 当作证明。
-   **责任人**：`<B 业务>`、`<Auth 平台>`、`<多租户安全>`
-   **验收证据**：同一 P 的两个 tenant、多个 B、P/A 与 B 不同用户、跨租户 B session 的矩阵；B
    session/tenant/object deny 不能被 P/A allow 覆盖；需要同主体的业务具有服务端绑定证明；V1/V2
    边界文档、审计字段和升级回滚测试。

### P1：合同与集成前必须冻结

#### AUTH-009 — navigation/root/reload invalidation

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：文档要求导航、root 替换、A/B reload、登录切换使旧 session/index/tree/action token 失效（`docs/parent-bridge-auth-architecture.zh-CN.md:235-236`；`docs/parent-bridge.zh-CN.md:129-130,259-263,347-352`），但未冻结事件顺序、跨窗口通知和正在进行的 issue/exchange 如何终止。当前 Host 对 iframe 新文档 load 会清除 activation，而部分 navigation 路径会保留 activation 并自动重连（`host.ts:356-385`），尚无统一的安全上下文变化判定键。
-   **要记录的决策**：哪些导航/路由/root/iframe 事件清除 activation、policy client、prepared action 和 context；deactivate、abort、dispose 的先后与幂等行为。
-   **建议默认值（待 ADR）**：任何安全上下文变化先 abort 并 deactivate，再 dispose；新文档/new root 必须新 bridge binding、新 policy 和重新 observe；旧 action 不自动重试。
-   **责任人**：`<P Host>`、`<A Adapter>`、`<B FrameBridgeHost>`
-   **验收证据**：SPA 路由、root 替换、A/B reload、iframe 卸载和登录切换的事件时序测试；旧 index/token/context 全部拒绝。

#### AUTH-010 — reconnect backoff、limits 与 activation

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：文档规定只有首次成功后才允许自动重连，且每次使用新 policy（`docs/parent-bridge-auth-architecture.zh-CN.md:146-151`；`docs/parent-bridge-production-deployment.zh-CN.md:132-145`）。当前公开配置只有 `autoReconnect` 布尔值（`types.ts:241-289`），没有最大尝试数、时间窗、退避、抖动、并发锁、限流或用户恢复入口。
-   **要记录的决策**：哪些断开可自动重连、最大尝试/总时长、退避和抖动、P/A 竞态、连续拒绝后的 circuit breaker、与 Auth 限流的关系。
-   **建议默认值（待 ADR）**：有界指数退避 + 抖动；每个 activation 只有一个重连协调器；达到次数/时间窗后停止并要求 A 用户重新点击；安全上下文变化永不自动重连。
-   **责任人**：`<A Adapter>`、`<P Host>`、`<Auth/SRE>`
-   **验收证据**：断网/Auth 429/Host 重启/新 A 文档/显式 deactivate 的重连测试；无无限循环、无重复 issue 洪峰、退避指标可见。

#### AUTH-011 — 多实例隔离与 one auth-client-per-Host

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺测试`
-   **当前证据/缺口**：权威架构已冻结每个 P 页面/标签页中的 A iframe runtime instance 独立拥有
    `frameInstanceId`、bridge session、channel、activation、任务状态和 per-Host auth client；服务端与
    仅内存状态使用完整复合隔离键。当前 P client 只保存一个 `currentGrant`，符合“一 client 服务一个
    Host”的预期，但公共 API 尚未强制所有权与串行化，也未验证产品层不会把 client 或授权状态放入
    全局缓存/`localStorage`。
-   **要记录的决策**：client 的正式所有权和生命周期、同一 Host 的 issue/verify 串行化、并发请求
    冲突行为、A 登录 JWT 与 runtime context 的存储边界，以及服务端 cache/audit key 的落地格式。
-   **建议默认值（待 ADR）**：每个 Host/iframe instance 独占一个 auth client；issue/verify 串行化且
    不共享全局 grant；完整隔离键由
    `environment + assistantAppId + issuer + tenantId + userId + parentAppId` 与
    `integrationId + scopeId + targetId + bridgeSessionId + hostInstanceId + frameInstanceId` 共同组成。
    bridge context 只留内存；A 登录 JWT 即使按 origin 共享，也不得恢复或标识该 context。
-   **责任人**：`<P Host/A Adapter>`、`<A 运行时>`、`<Auth 平台>`
-   **验收证据**：两个 P、同一 P 两个 tenant、多个并发 A iframe、同一逻辑 A 的多个 target 的交叉
    grant/replay 测试；旧 policy/context 不可跨 tenant/instance/scope/target 使用；内存和服务端缓存
    没有跨 key 命中；`localStorage` 中不存在 bridge/session/activation/task context。

#### AUTH-012 — A-side exchange helper 与返回 context

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺实现` · `缺测试`
-   **当前证据/缺口**：文档有 A BFF exchange 的流程和手写示例（`docs/parent-bridge-auth-architecture.zh-CN.md:173-186`；`docs/parent-bridge.zh-CN.md:269-321`），仓内却只提供 P 侧 `IntegrationAwareManagedEmbedAuthClient`，没有 A BFF 的官方 helper、request schema、context mapping 或逐字段 revalidation 工具。
-   **要记录的决策**：A BFF helper 是否进入公共包、其输入/输出和 actual origin 来源、`authorizationContext` 的最小字段、错误/取消/超时处理、如何保证不把 subject/policy 回显 bridge。
-   **建议默认值（待 ADR）**：提供框架无关的 A-side schema/validator；A BFF 自己认证 session/subject 后调用 Auth，浏览器只得到无身份最小 context，并逐字段比较 policyId、origin、binding、instance 和 capability。
-   **责任人**：`<A 平台>`、`<Auth 平台>`
-   **验收证据**：helper 单测覆盖篡改、错 origin、错 binding、capability 扩大、过期、重复 exchange；返回 JSON/bridge 日志脱敏扫描。

#### AUTH-013 — approval ownership 与 deny 优先级

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：文档给出 `deny > approval_required > allow` 和一次性审批原则（`docs/parent-bridge-auth-architecture.zh-CN.md:207-245`；`docs/parent-bridge.zh-CN.md:259-263,354-369`），但没有 P actionPolicy、A approval UI、B FrameBridgeHost/BFF 之间的 RACI、审批原因规范和跨系统审计 owner。
-   **要记录的决策**：谁能发起/批准/拒绝、P/B deny 的不可覆盖边界、一次 approval 对应的 request/approval ID、超时/取消/断开行为和审计保留方。
-   **建议默认值（待 ADR）**：P/B 只能收紧，B 后端是业务最终 deny；A 只能对当前 request 做 Allow once/Deny；审批超时、导航和失联一律拒绝。
-   **责任人**：`<P 业务>`、`<A 产品/安全>`、`<B 业务>`
-   **验收证据**：P deny/B deny/A allow 组合矩阵；重复、跨 request、超时、取消、导航和重连审批测试；审计可定位责任方。

#### AUTH-015 — protocol migration、event 与 error taxonomy

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺生产实现`
-   **当前证据/缺口**：代码有若干内部错误码但没有 HTTP 映射（`integration-auth-authority.ts:50-62,993-997`）；旧 `managed-auth` 仍导出并标记 deprecated（`managed-auth.ts:733-741,1086-1089,1221-1226`）。文档要求旧 API 只保留一个兼容版本、ES256/JWKS 迁移按可区分 issuer/version 分流，但没有具体版本、下线日期、事件名、外部状态码和可重试分类（`docs/parent-bridge-auth-architecture.zh-CN.md:362-374,390-415`；`docs/parent-bridge.zh-CN.md:643-648`）。
-   **要记录的决策**：opaque/JWKS token type 与 issuer/audience、protocol/config version 兼容矩阵、旧 API sunset release、内部事件名、公开错误码/HTTP status、重试与降级语义。
-   **建议默认值（待 ADR）**：显式 version/issuer 分流，拒绝无法区分的 token；外部错误使用不泄漏 token 存在性的统一分类，内部保留细粒度原因；旧 API 在一个明确 release 后移除。
-   **责任人**：`<平台架构>`、`<Auth API>`、`<发布管理>`
-   **验收证据**：版本迁移/回滚矩阵；错误码到 HTTP/SLO/客户端行为表；旧路径下线指标；未知 alg/kid/version 的拒绝测试。

#### AUTH-016 — observability、correlation 与审计保留

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺生产实现`
-   **当前证据/缺口**：合同没有 correlation/request/event ID 或审计接口；部署手册只列出应记录的 policyId、origin、scope、结果、耗时和错误码，以及禁止的敏感字段（`docs/parent-bridge-production-deployment.zh-CN.md:489-508`）。Auth 的集中审计、指标命名、采样和保留期未冻结。
-   **要记录的决策**：一次 handshake→issue→exchange→bridge→B 请求的关联键、policy/session 的哈希方式、事件 schema、指标/告警、审计保留期、访问权限和脱敏责任。
-   **建议默认值（待 ADR）**：每次连接尝试一个不可预测 correlation ID；policy/session 只记录不可逆散列或 jti；原始 token、Cookie、JWT、DOM、prompt 和审批敏感载荷永不落日志。
-   **责任人**：`<Auth/SRE>`、`<P/A/B 可观测性>`、`<隐私/安全>`
-   **验收证据**：跨 P/A/Auth/B 的可关联 trace；日志 schema/retention 配置；原始 token 和身份泄漏扫描；告警触发与值班演练。

#### AUTH-017 — outcome-unknown、幂等与 retry

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺测试`
-   **当前证据/缺口**：issue/exchange 合同没有 request ID 或 idempotency key（`integration-auth-contracts.ts:99-122`）；issue 每次调用生成新 policy（`integration-auth-authority.ts:661-679`），exchange 成功后一次性消费（`integration-auth-authority.ts:747-761`）。部署文档禁止对业务 `OUTCOME_UNKNOWN` 自动重放，但没有 Auth 请求超时后的恢复接口或 retry contract（`docs/parent-bridge-production-deployment.zh-CN.md:367-373,543-556`）。
-   **要记录的决策**：P issue 是否幂等、A exchange 的 exactly-once/状态查询、网络超时后的 caller 行为、限流和重复请求审计。
-   **建议默认值（待 ADR）**：issue 使用绑定 P session/handshake 的幂等键；exchange 保持一次性消费并提供按 request/policyId 的安全状态查询；未知结果不自动重放业务 mutation。
-   **责任人**：`<Auth API>`、`<P/A BFF>`
-   **验收证据**：重复并发 issue、exchange、丢响应、重试、跨节点和客户端取消测试；无重复 grant 洪峰；业务 `OUTCOME_UNKNOWN` 有人工核对路径。

#### AUTH-018 — data minimization 与 browser redaction

-   **决策状态**：`未冻结`；**落地标签**：`需对齐` · `参考实现` · `缺测试`
-   **当前证据/缺口**：Authority 用 `server-verified` 填充 legacy `tenant/user` placeholder（`integration-auth-authority.ts:631-636`），但 client 只验证它们是 identifier，并可把响应中的任意值放入 claims（`integration-auth-client.ts:374-396`）。合同注释和文档要求浏览器不接触 canonical subject（`integration-auth-contracts.ts:81-91`；`docs/parent-bridge-auth-architecture.zh-CN.md:60-71,327-328`）。浏览器 context 还应明确哪些 target/frame/authorization 字段可以进入 UI/LLM。
-   **要记录的决策**：browser claims 是删除身份字段还是强制固定 sentinel、A/P UI 与 LLM 的字段白名单、policy/context 的内存和错误处理存储、日志脱敏责任。
-   **建议默认值（待 ADR）**：新 schema 删除 canonical identity；若为旧形状保留字段，client 必须接受唯一固定 sentinel 并拒绝真实身份；policy 只留内存，不写 URL/localStorage/log/telemetry。
-   **责任人**：`<Auth 平台>`、`<A/P 产品隐私>`
-   **验收证据**：响应/bridge/UI/LLM/log 的身份与 token redaction 测试；恶意 P BFF 返回真实 tenant/user 时 client 失败关闭；数据分类清单。

#### AUTH-019 — Registry/config propagation 与撤销延迟

-   **决策状态**：`未冻结`；**落地标签**：`参考实现` · `缺生产实现`
-   **当前证据/缺口**：Authority 在 exchange 时检查当前 `configVersion`，配置变化会拒绝旧 grant（`integration-auth-authority.ts:699-706`）；Registry/Store 生产实现、发布顺序、跨副本传播和 kill switch 尚未建设（`docs/parent-bridge-auth-architecture.zh-CN.md:332-345,378-388`）。没有定义 issue 与 exchange 并发遇到配置发布时的线性化点。
-   **要记录的决策**：配置 source of truth、版本发布/回滚/禁用、传播延迟、旧 grant 的处理、Registry 与 Store 的一致性和 kill switch 优先级。
-   **建议默认值（待 ADR）**：不可变版本 + 原子发布；issue 使用已发布版本，exchange 只接受当前启用版本；禁用先阻止新 issue，再在 SLA 内撤销 ISSUED grant。
-   **责任人**：`<Auth 配置平台>`、`<P/A 发布平台>`、`<SRE>`
-   **验收证据**：跨副本配置传播和回滚测试；发布中 issue/exchange 线性化报告；禁用/kill switch 到生效的实测延迟。

#### AUTH-021 — RACI、ADR 与测试矩阵

-   **决策状态**：`未冻结`；**落地标签**：`仅文档`
-   **当前证据/缺口**：权威架构列出仍需记录的 schema、主体、binding、Store/HA、HTTP 风险、release
    gate 和值班信息；部署手册已给出 P/A/B/Auth 交付物，以及多 P、同一 P 多 tenant、多个并发 A
    iframe、多 B 和单 Grant 8/9 边界的验收矩阵，但尚无具体 accountable/backup owner、ADR 编号、
    执行环境、报告链接和证据编号。
-   **要记录的决策**：每个待决事项的 accountable/consulted/informed、ADR 编号和 reviewer、单测/集成/E2E/浏览器/故障证据的 owner、接受风险和回滚授权人。
-   **建议默认值（待 ADR）**：每个 P0/P1 只有一个 accountable owner 和一个 backup；没有 ADR、验收证据和回滚 owner 的事项不能标记已冻结或进入灰度。
-   **责任人**：`<项目负责人>`、`<安全评审>`、`<发布管理>`
-   **验收证据**：签署的 RACI；ADR 索引；测试矩阵把每个决策和上述拓扑基数场景映射到命令、
    环境、结果和报告链接。

## 4. 事项总览

| 主题                                                | 台账项   | 优先级           | 决策状态 |
| --------------------------------------------------- | -------- | ---------------- | -------- |
| 生产 Auth HTTP API / service identity               | AUTH-001 | P0               | 未冻结   |
| canonical subject / issuer                          | AUTH-002 | P0               | 未冻结   |
| Registry / configVersion 治理                       | AUTH-003 | P0               | 未冻结   |
| active-session revoke / logout                      | AUTH-004 | P0               | 未冻结   |
| scope / target / context binding                    | AUTH-005 | P0               | 未冻结   |
| B subject consistency                               | AUTH-006 | P0（启用 B 时）  | 未冻结   |
| trusted HTTP、Cookie/JWT、CSRF、CORS、CSP、storage  | AUTH-007 | P0               | 未冻结   |
| credential/session TTL                              | AUTH-008 | P0               | 未冻结   |
| navigation invalidation                             | AUTH-009 | P1               | 未冻结   |
| reconnect backoff / limits                          | AUTH-010 | P1               | 未冻结   |
| multi-instance isolation / one auth-client-per-Host | AUTH-011 | P1               | 未冻结   |
| A-side exchange helper                              | AUTH-012 | P1               | 未冻结   |
| approval ownership                                  | AUTH-013 | P1               | 未冻结   |
| cross-scope boundary                                | AUTH-014 | P0               | 未冻结   |
| protocol migration / event / error taxonomy         | AUTH-015 | P1               | 未冻结   |
| observability / correlation                         | AUTH-016 | P1               | 未冻结   |
| outcome-unknown / idempotency                       | AUTH-017 | P1               | 未冻结   |
| data minimization                                   | AUTH-018 | P1               | 未冻结   |
| config propagation                                  | AUTH-019 | P1               | 未冻结   |
| SLO / HA / browser / fault matrix                   | AUTH-020 | P0               | 未冻结   |
| RACI / ADR / test matrix                            | AUTH-021 | P1（发布前必需） | 未冻结   |

## 5. 推荐 ADR 顺序与实现依赖

推荐按依赖顺序推进；同一阶段内可在文件和服务 owner 明确后并行：

| 阶段                  | 先冻结/交付                                                                    | 依赖与停止条件                                                                                          |
| --------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| 0. 信任根             | AUTH-001、AUTH-002、AUTH-003                                                   | 未确定服务身份、主体映射和 Registry schema，不得实现生产 endpoint。                                     |
| 1. 授权边界           | AUTH-004、AUTH-005、AUTH-008、AUTH-014、AUTH-019                               | 先固定 session/scope/target/configVersion 的绑定和撤销，再实现 Store/HA。                               |
| 2. 浏览器与跨方合同   | AUTH-006、AUTH-007、AUTH-009、AUTH-010、AUTH-011、AUTH-012、AUTH-013、AUTH-018 | 先固定 HTTP/session/lifecycle/context 语义，再做 P/A/B 接线和 UI 降级；不得用浏览器行为猜测 Auth 授权。 |
| 3. 服务实现与可观测性 | AUTH-015、AUTH-016、AUTH-017                                                   | endpoint、错误、事件、幂等和 trace 合同冻结后，接入真实 SSO、共享 Store、限流和告警。                   |
| 4. 生产验收治理       | AUTH-020、AUTH-021                                                             | 真实域名/浏览器/多副本/故障矩阵完成并签署后，才允许内部租户灰度。                                       |

建议的执行链为：

`身份/Registry → Auth transport/Store/撤销 → P/A BFF → A exchange helper → P/A/B 生命周期 → 观测与故障演练 → 灰度与迁移`。

任何阶段发现字段、公共 API、schema、token 类型或跨组件依赖改变，应退回对应 ADR，而不是在实现中
临时兼容。

## 6. Release gate checklist

-   [ ] AUTH-001、AUTH-002、AUTH-003、AUTH-004、AUTH-005、AUTH-007、AUTH-008、AUTH-014、AUTH-020、AUTH-021 均有已批准 ADR、owner、reviewer 和验收证据；启用 B 时还必须包含 AUTH-006。
-   [ ] 生产 Auth endpoint 只接受受信 P/A service identity；浏览器无直接 Auth 路径；真实 SSO subject 不由请求 JSON 自报。
-   [ ] Registry schema、环境、origin、capability、ChildTarget、configVersion 和发布/回滚/禁用语义已版本化；生产不用 `InMemory*`。
-   [ ] 每个 environment 只登记一个逻辑 `AssistantApp`；多个 P/Integration 能复用该 A；tenant 保持
        运行时 context，一个 P 的每个 scope 使用独立 Integration，不能用 tenant/scope/target/childId
        互相代替。
-   [ ] Store 在多副本并发 exchange、revoke、TTL 到期、配置切换和故障时满足原子性、保留期和 fail-closed 要求。
-   [ ] issue/exchange/revoke 的 scope、target、session、subject、origin、capability、B 子集和 configVersion 交叉拒绝矩阵通过。
-   [ ] logout、租户/target 切换、导航、A/B reload、root 替换、deactivate 和新文档加载均能使旧 grant/context/index/action 失效。
-   [ ] 至少两个 P、同一 P 两个 tenant、多个并发 A iframe 和多个 B 的组合矩阵通过；单 Grant 8 个
        B 成功、9 个被拒绝，policy/context 不可跨 tenant/instance/scope/target 使用。
-   [ ] P/A/B 的 cookie、JWT audience/刷新、CSRF、CORS、CSP、sandbox、storage、HTTP 风险接受和目标浏览器验证完成。
-   [ ] policy、Bearer、Cookie、JWT、canonical subject、DOM、prompt、审批敏感载荷均不进入 URL、普通日志、localStorage 或 LLM/UI 非必要字段。
-   [ ] `localStorage` 中没有 bridge/session/integration/scope/target/activation/task context；A 登录 JWT
        即使按 origin 共享，也不能恢复或标识 bridge runtime instance。
-   [ ] 超时、取消、Auth/SSO/Store/LLM/Host/B 故障、429、并发消费和 `OUTCOME_UNKNOWN` 有明确的降级、查询、人工恢复和告警路径。
-   [ ] SLO、容量、RPO/RTO、on-call、kill switch、回滚版本、旧 API sunset 和真实 LLM/browser smoke test 已签署。

## 7. ADR 与进度日志模板

### 7.1 决策记录模板

```text
ADR: ADR-<编号>
关联台账项: AUTH-<编号>
标题: <一句话>
状态: proposed | accepted | superseded | rejected
责任人/批准人: <姓名或团队>
生效版本/日期: <版本>/<UTC 日期>

背景与不变量:
<只引用权威架构和必要证据>

决策:
<明确的接口、schema、值、边界和失败行为>

候选方向与取舍:
1. <方向> — <安全/兼容/运维影响>
2. <方向> — <安全/兼容/运维影响>

依赖与迁移:
<依赖的 ADR、配置发布、旧版本和回滚方式>

验收证据:
<测试命令、环境、报告、日志/指标和 reviewer>

风险与到期复审:
<未接受风险、owner、复审日期>
```

### 7.2 台账进度变更模板

```text
日期（UTC）: YYYY-MM-DD
台账项: AUTH-<编号>
变更类型: status | decision | evidence | owner | dependency
变更前 → 变更后: <例如：未冻结 → 已冻结，或缺测试 → 已验证>
摘要: <本次只记录一个可核对变化>
证据/链接: <ADR、PR、测试报告、监控或风险接受记录>
影响项: <受影响的 AUTH-xxx>
记录人/审核人: <姓名或团队>
```

状态更新规则：

1. 只有 accountable owner 可以提交状态变化；状态变化必须带证据链接和日期。
2. `参考实现` 不得自动升级为 `已验证`；决策冻结后仍必须补生产合同、部署配置和对应验收。
3. `仅文档` 只有在代码/配置/运行手册与 ADR 一致后，才能改为 `已验证`。
4. 任一 schema、公共 API、token 类型、错误分类或安全边界改变，都要新增进度日志并重新评估依赖项。
5. 发现 P0 证据失效、撤销延迟超 SLA、跨实例原子性失败或敏感数据泄漏时，立即移除 `已验证` 并阻止放量；如果原决策本身不再成立，再把决策状态退回 `未冻结`。

## 8. 进度日志

| 日期（UTC） | 台账项   | 变更                                                                                               | 证据/ADR                     | 记录人                       |
| ----------- | -------- | -------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- |
| 2026-08-30  | 初始建立 | 建立 AUTH-001–AUTH-021 待决事项和 release gate                                                     | 本文件；权威架构/部署文档    | `<待指定>`                   |
| 2026-08-30  | 架构基数 | 冻结每环境一个逻辑 A、多 P/tenant/B、Integration 粒度、runtime instance 隔离和单 Grant 最多 8 个 B | 权威架构 §1/§5；生产部署手册 | 项目负责人确认；owner 待登记 |
