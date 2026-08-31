# P / A / B / Auth 架构待决事项台账

本台账用于记录跨域助手进入独立生产实现前仍需作出的架构、接口、运维和验收决策。它不替代
[P / A / B 与公共 Auth 权威架构](./parent-bridge-auth-architecture.zh-CN.md)、
[iframe PageAgent 生产部署手册](./parent-bridge-production-deployment.zh-CN.md) 或
[父页面控制器桥接协议](./parent-bridge.zh-CN.md)；协议细节只在这些权威文档中维护。

本台账中的历史“建议默认值”已由 [ADR-0001](./adr/0001-parent-bridge-auth-v1-p0-baseline.zh-CN.md)
在 V1 controlled-intranet deployment 范围内冻结；冻结只表示合同已决定，不表示已经实现或已经
获得生产验收。仓内代码是合同、领域引擎和测试参考实现；生产 Auth、真实 SSO、logical actor
配置、共享 Store、HA 和运维能力属于独立服务及部署系统。

## 1. 冻结基线

以下事实视为本台账的输入，不在待决事项中重新讨论：

-   拓扑基数冻结为：每个 `environment` 恰好一个逻辑 A（一个 `AssistantApp`、A BFF 和
    `serviceActor` 配置归属；后端副本仍是同一个逻辑 A，生产/测试环境分开），多个逻辑 P，以及每个
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
-   P BFF 负责 issue，A BFF 负责 exchange；在本 ADR 的受控内网范围内，`serviceActor` 是配置、
    路由和审计元数据，不是经过 caller authentication 的可信证明；Auth 仍按合同检查 P/A subject、
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

P0 决策已由 ADR-0001 在指定范围内批准，因此适用事项的决策状态可以标为 `已冻结`；这不改变
落地标签。只有同时清除适用的 `缺实现`、`缺生产实现`、`缺测试`、`需对齐` 并附上证据，才能
标记 `已验证`。P1 仍须各自完成自己的 ADR，不因本 ADR 自动冻结。

## 3. 优先级待决事项

### P0：决策已冻结，落地证据仍为上线门禁

#### AUTH-001 — 生产 Auth HTTP API 与 service identity

-   **决策状态**：`已冻结`；**落地标签**：`仅文档` · `缺生产实现`
-   **当前证据/缺口**：`ManagedAuthExecutionContext` 仍只是一组普通的 actor/subject 字段（`packages/page-controller/src/parent-bridge/integration-auth-contracts.ts:22-33`）；领域引擎中的 actor 检查只能作为参考实现的配置/错配保护，不是生产 caller authentication。生产 Auth、endpoint、网络边界和 HTTP 合同尚未建设；在本 ADR 的受控内网范围内，任何能够到达 Auth 网络的内部调用方都可能冒充 P/A，该残余风险已明确接受但仍需部署记录和监控。
-   **仍需落地的合同**：Auth endpoint 的路径/版本、P/A 调用方向、serviceActor 的配置/路由/审计字段、HTTP 状态和响应头、超时、错误映射、网络可达性和浏览器无直连网关证据；不得把 mTLS、service JWT 或 caller authentication 写回本范围决策。
-   **冻结决策（ADR-0001）**：受控内网中 BFF→Auth 的 `serviceActor` 仅是双方约定的配置、路由和审计元数据；不实施 mTLS、service JWT、caller authentication 或 application-layer service-actor enforcement。浏览器仍不得直连 Auth；可到达 Auth 网络的内部调用方可冒充 P/A 的残余风险已接受。
-   **责任人**：`<Auth 平台>`、`<服务身份/安全>`
-   **验收证据**：公开的 HTTP/OpenAPI 合同；受控内网网络可达性、浏览器无直连和匿名浏览器路径的网关证据；serviceActor 配置/路由/审计一致性以及残余冒充风险的监控与演练记录。不得用伪造 actor 拒绝或密钥轮换证明本范围内的 caller authentication。

#### AUTH-002 — canonical subject 与 issuer 映射

-   **决策状态**：`已冻结`；**落地标签**：`参考实现`
-   **当前证据/缺口**：代码仍按 `issuer + tenantId + userId` 做字符串全等（`integration-auth-authority.ts:183-210,249-253`），但生产 SSO canonicalization、跨 issuer 映射和维护责任尚未接线；`authenticatedAt`/`credentialExpiresAt` 的比较、规范化和审计含义仍需实现和验证。
-   **仍需落地的合同**：统一 SSO 的 issuer canonicalization、大小写/Unicode/租户命名规范、映射表 owner/version/审计、凭据时间字段和迁移矩阵。
-   **冻结决策（ADR-0001）**：每个 Integration 使用明确的 canonical issuer；P/A subject 严格比较 `issuer + tenantId + userId` 三元组。跨 issuer 仅允许版本化、受信且可审计的映射；浏览器别名或自报身份无效。
-   **责任人**：`<SSO/身份平台>`、`<Auth 平台>`
-   **验收证据**：同用户/异 issuer、异租户、异 user、大小写和过期凭据的矩阵测试；映射变更和审计样例。

#### AUTH-004 — active session binding、logout 与 revoke

-   **决策状态**：`已冻结`；**落地标签**：`参考实现` · `缺生产实现`
-   **当前证据/缺口**：`parentSessionBinding` 在 issue request 中仍可选，领域引擎只存储它；当前 exchange/revoke 合同和内存 Store 没有 active lease，也不会终止已 `CONSUMED` 的活动 bridge session。仓内尚未实现 lease 创建、轮询、revoke 传播、abort 或禁止自动重连；这些是实现缺口，不是决策缺口。
-   **仍需落地的合同**：lease API/state schema、binding 摘要/来源、P/A BFF polling endpoint、revoke 事件审计、跨副本状态传播和 15m/30s/90s 参数的监控与告警。
-   **冻结决策（ADR-0001）**：有效 exchange 原子创建绑定完整 environment/assistantApp/parentApp/subject/integration/scope/target/bridge/host/frame/config context 的 `ACTIVE` lease；lease 固定 900s、永不续租。P/A runtime 仅轮询各自同源 BFF，BFF 查询 Auth，周期 30s、±20% 抖动（24–36s）；从最近一次 `ACTIVE` 起 90s 无法确认即 fail closed，`REVOKED`/`EXPIRED` 立即 fail closed。revoke 由 logout、用户/tenant/target/scope 切换、权限/配置禁用和 kill switch 触发；清除连接、abort 安全工作、禁止自动重连，新连接必须由 A 用户显式操作并重新 issue/exchange/建 lease。`deactivate` 仅为清理通知，不是撤销证明。
-   **责任人**：`<P BFF>`、`<Auth 平台>`、`<安全响应>`
-   **验收证据**：issue 前后 logout、exchange 后 logout、跨节点撤销、切租户/target、配置禁用和 kill switch 测试；活动连接在 SLA 内关闭且后续操作失败；撤销事件含原因、时间和关联 ID。

#### AUTH-005 — scope / target / context binding 边界

-   **决策状态**：`已冻结`；**落地标签**：`参考实现`
-   **当前证据/缺口**：权威架构和 issue 合同已有 tenant/scope/target、bridge binding 与最多 8 个 B 的模型，但生产 P BFF 的字段来源、root/target resolver、binding 强制性和请求 schema 尚未接线；P 浏览器 client 仍只提交 integration、origin、scope、capability 和 bridge binding（`integration-auth-client.ts:446-463`）。
-   **仍需落地的合同**：scope↔root 映射、`targetId` 格式/resolver、`parentSessionBinding` 强制性与摘要、浏览器允许字段、child subset resolver 和切换失效测试。
-   **冻结决策（ADR-0001）**：浏览器只提交 bridge binding 和固定 Integration 选择；P BFF 独立派生 canonical subject、target、root、capability 和 B 子集，Auth/Host 只能收窄。浏览器自报 `tenantId`、`targetId`、root、capability 或 B 清单不得成为授权依据；一个 session 只能绑定一个完整上下文，Grant 的 B 子集最多 8 项。
-   **责任人**：`<P 业务/BFF>`、`<Auth 平台>`
-   **验收证据**：服务端请求 schema 与字段来源表；错误 tenant/target/root、同一用户跨 target、B 子集缺失/扩大/超过 8、scope 与 binding 错配的 issue/exchange 测试；tenant/target 切换后旧连接失效。

#### AUTH-007 — trusted HTTP 与浏览器会话安全合同

-   **决策状态**：`已冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：文档已有 Auth 风险门、Integration `transportMode` 和 P client 三方显式启用 HTTP 的参考配置，但真实风险批准、网络控制、cookie/CSP/CSRF/CORS 组合和目标浏览器仍未验收。P client 使用 same-origin cookie POST、没有 CSRF 字段（`integration-auth-client.ts:446-465`）；这些是实现缺口，不改变本 ADR 已冻结的受控内网范围。
-   **仍需落地的合同**：HTTP 网络范围/责任人/到期日、Secure/SameSite/分区 cookie、CSRF token/header、CORS allow-list、CSP 指令、policy/短 token 存储位置及浏览器矩阵。
-   **冻结决策（ADR-0001）**：生产默认 HTTPS；V1 受控内网 HTTP 仅接受有到期日的风险批准、私网证明和精确 origins；浏览器 BFF 使用显式 CSRF header + Origin 检查，禁止 wildcard CORS；原始 policy 只在短时内存存在。AUTH-001 的 bilateral logical-actor convention 不替代这些边界。
-   **责任人**：`<安全/网络>`、`<P/A 平台>`、`<浏览器兼容性>`
-   **验收证据**：真实内网域名/IP 和目标浏览器的 cookie/CSP/mixed-content/CSRF/CORS 矩阵；响应头扫描；HTTP 风险记录与到期提醒；浏览器不能调用 Auth 的网络日志。

#### AUTH-008 — credential/session TTL、clock skew 与刷新

-   **决策状态**：`已冻结`；**落地标签**：`参考实现` · `缺测试`
-   **当前证据/缺口**：Authority 仍只有参考实现的 policy/bridge TTL 默认值（`integration-auth-authority.ts:42-45,611-629`）；active lease、统一 TTL 边界、5 秒 skew 和生产凭据生命周期尚未实现或验证。Client 与服务端的过期窗口合同仍需对齐（`integration-auth-client.ts:251-275,344-359`）。
-   **仍需落地的合同**：P/A/B session、policy-offer、bridge、authorization context 和短 token 的具体生命周期；凭据刷新/存储；stop/deactivate/logout 失效证明和 TTL 指标。
-   **冻结决策（ADR-0001）**：服务端统一计算严格过期并拒绝非法 TTL；policy 默认 120s、最大 300s；active lease/bridge context 默认 900s、最大 3600s 且不超过用户凭据；clock skew 固定 5s，仅用于 `nbf` 容忍；policy 不刷新/复用，lease 不续租。
-   **责任人**：`<Auth 平台>`、`<SSO/A 平台>`、`<SRE>`
-   **验收证据**：边界秒数、节点时钟偏差、凭据临近过期、刷新/登出/stop 的测试；非法配置启动失败；TTL 指标与保留期证明。

#### AUTH-014 — cross-scope / cross-integration boundary

-   **决策状态**：`已冻结`；**落地标签**：`参考实现`
-   **当前证据/缺口**：权威架构和 Authority 已按 integration/app/environment/scope 做参考校验，但生产 ID namespace、跨 region Registry 隔离和例外审批流程尚未实现或验证；不同 scope 仍需分别授权、分别执行。
-   **仍需落地的合同**：ID 规范格式、跨 region 命名/复制、例外审批与版本化流程，以及 context cache/log key 的生产约束。
-   **冻结决策（ADR-0001）**：`integrationId`/`scopeId` 在 environment Registry 内唯一并带稳定 parent/scope 语义；生产/测试 Registry 物理或逻辑隔离；跨 scope/environment 例外必须新建版本化 Integration，不复用既有 grant/context，且无跨 scope 原子事务语义。
-   **责任人**：`<Auth 平台>`、`<P/A 产品>`、`<多租户安全>`
-   **验收证据**：同一逻辑 A 下多 P、同一 P 多 scope/tenant、不同环境和不同 B 的交叉交换测试；跨 scope 任务使用独立授权且部分成功不会扩大权限；context cache/日志键包含冻结的复合隔离键。

#### AUTH-020 — 多实例隔离、HA、SLO 与故障矩阵

-   **决策状态**：`已冻结`；**落地标签**：`仅文档` · `缺生产实现` · `缺测试`
-   **当前证据/缺口**：仓内 Store 仍是单进程实现，生产尚无共享 Registry/Store、HA、kill switch、容量、灾备和完整基数矩阵证据（`integration-auth-authority.ts:443-510`；`integration-auth-contracts.ts:156-173`）。一个逻辑 A 多 HA 副本及多 P/tenant/A iframe 的拓扑已冻结，但尚未生产验证。
-   **仍需落地的合同**：Store 技术/一致性、compare-and-delete 实现、跨 AZ/RPO/RTO、限流容量、Auth/LLM/握手超时、告警、故障降级和 on-call；这些不改变 ADR 的 fail-closed/单区域强一致门槛。
-   **冻结决策（ADR-0001）**：生产禁用 `InMemory*`；使用共享原子 TTL Store 并 fail closed；跨副本用条件更新/compare-and-delete 保证一次消费；先达到单区域强一致，再评估跨区域扩展。HA 副本不构成新的逻辑 A 或运行时身份。
-   **责任人**：`<Auth/SRE>`、`<平台运维>`、`<P/A/B 值班>`
-   **验收证据**：并发双 exchange、跨节点 revoke、Store/SSO/Auth/LLM/Host/B 超时与恢复、容量压测、RPO/RTO 和真实浏览器 cookie/CSP/HTTP 报告；至少两个 P、同一 P 两个 tenant、多个并发 A iframe、多个 B 以及单 Grant 8/9 B 边界矩阵；签署的 SLO/故障报告。

#### AUTH-003 — Registry schema 与 configVersion 治理

-   **决策状态**：`已冻结`；**落地标签**：`参考实现` · `缺生产实现`
-   **当前证据/缺口**：权威架构与 TypeScript 合同已对齐 `environment`、`origins`、`serviceActorIds`、`scopeId`、`childTargets` 和 `configVersion`，但仓内 Registry 仍是参考实现；生产 schema、环境 namespace、版本发布/回滚/禁用、actor 生命周期和配置分发尚未实现。`serviceActorIds` 在本 ADR 范围内是配置/路由/审计元数据，不是 caller authentication。
-   **仍需落地的合同**：Registry 持久化 schema/迁移、ID/环境格式、单一 A 约束、configVersion 兼容语义、配置分发以及 metadata 的审计字段。
-   **冻结决策（ADR-0001）**：沿用当前合同字段；configVersion 不可变、单调递增并原子发布，版本变化后旧 grant 在 exchange 时拒绝；每个 environment 仅一个启用 AssistantApp；tenant 复用同一 Integration，不创建 tenant-specific Registry 记录。
-   **责任人**：`<Auth 配置平台>`、`<平台架构>`
-   **验收证据**：版本化 schema/迁移脚本；同环境第二个逻辑 A、非法/重复 actor、origin、child ID 和
    跨环境配置的拒绝测试；多 P、同一 P 多 scope/tenant 复用和多 B 注册测试；配置切换时旧 grant
    拒绝且新 grant 可用。

#### AUTH-006 — B subject consistency 与 V1 边界

-   **决策状态**：`已冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：权威架构已有多 B、P tenant/target ACL、四层权限交集和 V1 B 不调用 Auth 的参考合同；生产 B session/tenant/object 关联、CSRF/幂等矩阵及 V2 边界尚未完成或验证。
-   **仍需落地的合同**：各业务流是否需要同主体证明、P BFF→B BFF binding schema/审计、跨租户规则和 V2 actor/Integration 迁移。
-   **冻结决策（ADR-0001）**：V1 Auth 只比较 P/A subject，不比较 B subject；B 每个业务请求独立认证授权并保留最终 deny。默认不要求三方同主体；需要时使用受信 P BFF→B BFF binding 或新版本 Integration；浏览器 user-id 不构成证明。
-   **责任人**：`<B 业务>`、`<Auth 平台>`、`<多租户安全>`
-   **验收证据**：同一 P 的两个 tenant、多个 B、P/A 与 B 不同用户、跨租户 B session 的矩阵；B
    session/tenant/object deny 不能被 P/A allow 覆盖；需要同主体的业务具有服务端绑定证明；V1/V2
    边界文档、审计字段和升级回滚测试。

### P1：合同与集成前必须冻结

#### AUTH-009 — navigation/root/reload invalidation

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：文档要求导航、root 替换、A/B reload、登录切换使旧 session/index/tree/action token 失效（`docs/parent-bridge-auth-architecture.zh-CN.md:235-236`；`docs/parent-bridge.zh-CN.md:129-130,259-263,347-352`），但未冻结事件顺序、跨窗口通知和正在进行的 issue/exchange 如何终止。当前 Host 对 iframe 新文档 load 会清除 activation，而部分 navigation 路径会保留 activation 并自动重连（`host.ts:356-385`），尚无统一的安全上下文变化判定键；AUTH-004 的 lease REVOKED/EXPIRED 或 90s 无法确认属于安全上下文失效，必须先于任何重连判断。
-   **要记录的决策**：哪些导航/路由/root/iframe 事件清除 activation、policy client、prepared action 和 context；deactivate、abort、dispose 的先后与幂等行为。
-   **建议默认值（待 ADR）**：任何安全上下文变化先 abort 并 deactivate，再 dispose；新文档/new root 必须新 bridge binding、新 policy 和重新 observe；旧 action 不自动重试。lease 失效或无法在 AUTH-004 的 90s 窗口内确认时不得自动重连。
-   **责任人**：`<P Host>`、`<A Adapter>`、`<B FrameBridgeHost>`
-   **验收证据**：SPA 路由、root 替换、A/B reload、iframe 卸载和登录切换的事件时序测试；旧 index/token/context 全部拒绝。

#### AUTH-010 — reconnect backoff、limits 与 activation

-   **决策状态**：`未冻结`；**落地标签**：`仅文档` · `缺测试`
-   **当前证据/缺口**：P0 已冻结“允许的 reconnect 不得推进原 ActiveLease 的 `expiresAt`”，但新的 bridge binding 如何 rebind 到原 lease 尚未冻结。当前文档规定只有首次成功后才允许自动重连，且每次使用新 policy（`docs/parent-bridge-auth-architecture.zh-CN.md:146-151`；`docs/parent-bridge-production-deployment.zh-CN.md:132-145`）。当前公开配置只有 `autoReconnect` 布尔值（`types.ts:241-289`），没有 lease-aware rebind、最大尝试数、时间窗、退避、抖动、并发锁、限流或用户恢复入口。
-   **要记录的决策**：哪些断开可自动重连、最大尝试/总时长、退避和抖动、P/A 竞态、连续拒绝后的 circuit breaker、与 Auth 限流的关系。
-   **建议默认值（待 ADR）**：仅在当前 lease 肯定 `ACTIVE` 时 rebind，并保持原 `expiresAt`；有界指数退避 + 抖动；每个 activation 只有一个重连协调器；达到次数/时间窗后停止并要求 A 用户重新点击；安全上下文变化以及 AUTH-004 lease REVOKED/EXPIRED 或 90s 无法确认后永不自动重连，必须由 A 用户重新 issue/exchange/建 lease。
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
-   **建议默认值（待 ADR）**：不可变版本 + 原子发布；issue 使用已发布版本，exchange 只接受当前启用版本；禁用先阻止新 issue，再在 SLA 内撤销 ISSUED grant，并触发 AUTH-004 active lease 撤销与 BFF-mediated polling fail-closed；lease 失效后不得自动重连。
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
| 生产 Auth HTTP API / service identity               | AUTH-001 | P0               | 已冻结   |
| canonical subject / issuer                          | AUTH-002 | P0               | 已冻结   |
| Registry / configVersion 治理                       | AUTH-003 | P0               | 已冻结   |
| active-session revoke / logout                      | AUTH-004 | P0               | 已冻结   |
| scope / target / context binding                    | AUTH-005 | P0               | 已冻结   |
| B subject consistency                               | AUTH-006 | P0（启用 B 时）  | 已冻结   |
| trusted HTTP、Cookie/JWT、CSRF、CORS、CSP、storage  | AUTH-007 | P0               | 已冻结   |
| credential/session TTL                              | AUTH-008 | P0               | 已冻结   |
| navigation invalidation                             | AUTH-009 | P1               | 未冻结   |
| reconnect backoff / limits                          | AUTH-010 | P1               | 未冻结   |
| multi-instance isolation / one auth-client-per-Host | AUTH-011 | P1               | 未冻结   |
| A-side exchange helper                              | AUTH-012 | P1               | 未冻结   |
| approval ownership                                  | AUTH-013 | P1               | 未冻结   |
| cross-scope boundary                                | AUTH-014 | P0               | 已冻结   |
| protocol migration / event / error taxonomy         | AUTH-015 | P1               | 未冻结   |
| observability / correlation                         | AUTH-016 | P1               | 未冻结   |
| outcome-unknown / idempotency                       | AUTH-017 | P1               | 未冻结   |
| data minimization                                   | AUTH-018 | P1               | 未冻结   |
| config propagation                                  | AUTH-019 | P1               | 未冻结   |
| SLO / HA / browser / fault matrix                   | AUTH-020 | P0               | 已冻结   |
| RACI / ADR / test matrix                            | AUTH-021 | P1（发布前必需） | 未冻结   |

## 5. ADR 实现依赖与顺序

P0 决策已由 ADR-0001 冻结；以下顺序描述生产实现与验收依赖。P1 仍需各自完成 ADR，
不能从本表推断为已冻结：

| 阶段                  | 先冻结/交付                                                                    | 依赖与停止条件                                                                                       |
| --------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 0. 信任根             | AUTH-001、AUTH-002、AUTH-003                                                   | ADR-0001 已冻结；仍须交付 Auth 网络/HTTP 合同、SSO 映射和 Registry schema 后才能实现生产 endpoint。  |
| 1. 授权边界           | AUTH-004、AUTH-005、AUTH-008、AUTH-014、AUTH-019                               | ADR-0001 已冻结 P0；先实现 session/lease/scope/target/configVersion 绑定和撤销，再实现 Store/HA。    |
| 2. 浏览器与跨方合同   | AUTH-006、AUTH-007、AUTH-009、AUTH-010、AUTH-011、AUTH-012、AUTH-013、AUTH-018 | AUTH-006/007 的 P0 决策已冻结；P1 仍须固定 HTTP/session/lifecycle/context 语义后再做应用接线和降级。 |
| 3. 服务实现与可观测性 | AUTH-015、AUTH-016、AUTH-017                                                   | endpoint、错误、事件、幂等和 trace 合同冻结后，接入真实 SSO、共享 Store、限流和告警。                |
| 4. 生产验收治理       | AUTH-020、AUTH-021                                                             | AUTH-020 决策已冻结；真实域名/浏览器/多副本/故障矩阵完成并签署后，才允许内部租户灰度。               |

建议的执行链为：

`身份/Registry → Auth transport/Store/撤销 → P/A BFF → A exchange helper → P/A/B 生命周期 → 观测与故障演练 → 灰度与迁移`。

任何阶段发现字段、公共 API、schema、token 类型或跨组件依赖改变，应退回对应 ADR，而不是在实现中
临时兼容。

## 6. Release gate checklist

### 6.1 决策门

-   [x] AUTH-001、AUTH-002、AUTH-003、AUTH-004、AUTH-005、AUTH-007、AUTH-008、AUTH-014、AUTH-020 已由 [ADR-0001](./adr/0001-parent-bridge-auth-v1-p0-baseline.zh-CN.md) 在 `V1 controlled-intranet deployment` 范围内冻结；启用 B 时还包含 AUTH-006。责任人是项目负责人。
-   [ ] AUTH-021 仍是独立的 P1 治理事项，必须另行补齐 RACI、reviewer、测试矩阵、证据链接和回滚 owner，不因 ADR-0001 自动冻结。

### 6.2 证据门

-   [ ] 决策已冻结不等于已部署或已验证；所有适用的 `仅文档`、`参考实现`、`缺实现`、`缺生产实现` 和 `缺测试` 标签必须保留，直到生产合同、部署配置和验收证据齐备。
-   [ ] 生产 Auth endpoint 的网络可达性限制在受控内网范围；P/A `serviceActor` 仅为配置/路由/审计元数据，不是 caller authentication；浏览器无直接 Auth 路径；真实 SSO subject 不由请求 JSON 自报。
-   [ ] Registry schema、环境、origin、capability、ChildTarget、configVersion 和发布/回滚/禁用语义已版本化；生产不用 `InMemory*`。
-   [ ] 每个 environment 只登记一个逻辑 `AssistantApp`；多个 P/Integration 能复用该 A；tenant 保持
        运行时 context，一个 P 的每个 scope 使用独立 Integration，不能用 tenant/scope/target/childId
        互相代替。
-   [ ] Store 在多副本并发 exchange、revoke、TTL 到期、配置切换和故障时满足原子性、保留期和 fail-closed 要求；policy 为 120s（最大 300s），active lease/bridge context 为 900s（最大 3600s）且不续租，clock skew 为 5s，polling 为 30s ±20%，连续 90s 无法确认时 fail closed。
-   [ ] issue/exchange/revoke 的 scope、target、session、subject、origin、capability、B 子集和 configVersion 交叉拒绝矩阵通过。
-   [ ] logout、租户/target/scope 切换、导航、A/B reload、root 替换、deactivate 和新文档加载均能使旧 grant/context/index/action 失效；lease revoke/expiry 或 90s 无法确认后清除连接、abort 安全工作且禁止自动重连。
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

| 日期（UTC） | 台账项                                                                                             | 变更                                                                                                               | 证据/ADR                                                          | 记录人                       |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------- |
| 2026-08-30  | 初始建立                                                                                           | 建立 AUTH-001–AUTH-021 待决事项和 release gate                                                                     | 本文件；权威架构/部署文档                                         | `<待指定>`                   |
| 2026-08-30  | 架构基数                                                                                           | 冻结每环境一个逻辑 A、多 P/tenant/B、Integration 粒度、runtime instance 隔离和单 Grant 最多 8 个 B                 | 权威架构 §1/§5；生产部署手册                                      | 项目负责人确认；owner 待登记 |
| 2026-08-31  | AUTH-001、AUTH-002、AUTH-003、AUTH-004、AUTH-005、AUTH-006、AUTH-007、AUTH-008、AUTH-014、AUTH-020 | 在 V1 controlled-intranet deployment 范围内接受 ADR-0001，冻结 P0 合同；保留全部适用落地标签，决策不等于实现或验证 | [ADR-0001](./adr/0001-parent-bridge-auth-v1-p0-baseline.zh-CN.md) | 项目负责人                   |
