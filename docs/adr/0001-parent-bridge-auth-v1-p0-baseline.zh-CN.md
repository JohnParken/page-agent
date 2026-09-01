# ADR-0001：P / A / B / Auth V1 P0 基线

-   **状态**：`accepted`
-   **生效范围**：V1 controlled-intranet deployment
-   **生效日期**：2026-08-31（UTC）
-   **责任人/批准人**：项目负责人
-   **关联台账项**：AUTH-001、AUTH-002、AUTH-003、AUTH-004、AUTH-005、AUTH-006、AUTH-007、AUTH-008、AUTH-014、AUTH-020

## 背景与不变量

本 ADR 冻结 P（Parent）、A（Assistant）、B（Business）和公共 Auth 在 V1
受控内网部署中的 P0 合同。它引用以下权威文档中的拓扑、A → P → B 路由、
精确 origin、最小 capability、P/A/B 职责边界、B 最终业务拒绝权、P/A
canonical subject、Integration/ChildTarget 基数以及一次性 opaque policy
模型：

-   [P / A / B 与公共 Auth 权威架构](../parent-bridge-auth-architecture.zh-CN.md)
-   [iframe PageAgent 生产部署手册](../parent-bridge-production-deployment.zh-CN.md)
-   [父页面控制器桥接协议](../parent-bridge.zh-CN.md)

本 ADR 只冻结决策，不把仓内合同、领域引擎、内存实现或测试误写成生产
实现。当前仓库已提供 ActiveLease 领域状态机、InMemory Store 合同实现和 P/A runtime polling
参考实现；仓内已有的 actor 校验
是领域参考实现中的配置/错配保护，不是冻结的生产调用方认证、授权或拒绝
门禁。生产 Auth、真实 SSO、共享 Store、HA、网络控制和运行手册仍须由对应
角色团队完成并提供证据。

## 决策

### AUTH-001：生产 Auth HTTP API 与 service identity

在本 ADR 的受控内网范围内，P BFF 和 A BFF 到 Auth 的 `serviceActor` 仅是
双方约定的配置、路由和审计元数据。Auth 不实施 mTLS、service JWT 或其他
服务 token 校验，不做 caller authentication，也不做 application-layer
service-actor enforcement。任何能够到达 Auth 网络的内部调用方都可能冒充 P
或 A；该残余风险在本 ADR 范围内被明确接受。

浏览器仍不得调用 Auth。浏览器只访问各自 BFF，P/A BFF 按约定的 endpoint
和请求合同调用 Auth。`serviceActor` 可以用于配置选择、路由和审计，但不得
校验为实际调用方或方向证明，不得作为身份、授权通过或请求拒绝依据，也不得
据此声称已实现生产身份认证。

### AUTH-002：canonical subject 与 issuer

每个 `Integration` 使用一个明确的 canonical issuer。P/A subject 必须按
`issuer + tenantId + userId` 三元组严格全等比较。跨 issuer 只有在版本化、
受信且可审计的映射表中明确配置时才允许；浏览器提供的别名、user、tenant
或 issuer 字段不能覆盖服务端产生的 canonical subject。

### AUTH-003：Registry schema 与 configVersion

Registry 沿用当前合同字段，包括 `environment`、精确 origins、
`serviceActorIds`、`scopeId`、`childTargets`、`configVersion` 和状态字段。
配置版本不可变、单调递增并原子发布；exchange 只接受当前启用的版本，配置
版本变化后旧 grant 必须被拒绝。每个 environment 只允许一个启用的
`AssistantApp`；HA 副本不构成新的逻辑 A。tenant 是运行时 subject/session
context，默认复用同一 Integration，不创建 tenant-specific Registry 记录。

### AUTH-004：active session lease、logout 与 revoke

每次有效 exchange 必须原子创建一个 `ACTIVE` lease。lease 绑定完整的
`environment`、`assistantAppId`、`parentAppId`、`issuer`、`tenantId`、
`userId`、`integrationId`、`scopeId`、`targetId`、`parentSessionBinding`、
`bridgeSessionId`、`hostInstanceId`、`frameInstanceId` 和 `configVersion` 上下文。

lease 固定为 **900 秒（15 分钟）**，不得续租。P 和 A runtime 只能轮询各自
的同源 BFF；BFF 再查询 Auth，浏览器不得直接轮询 Auth。轮询周期为 **30 秒**，
使用 **±20% 抖动（24–36 秒）**。从最近一次确认 `ACTIVE` 起，连续 **90 秒**
不能重新确认时必须失败关闭。Auth 返回 `REVOKED` 或 `EXPIRED` 时立即失败
关闭。

在原 lease 仍为 `ACTIVE` 时允许的 bridge/transport reconnect 不得推进原
`expiresAt`，也不得通过创建滚动 900 秒 lease 规避“不续租”；具体的
rebind、退避和竞态 API 留给 AUTH-010 的 P1 决策。

logout、用户/tenant/target/scope 切换、权限或配置禁用以及 kill switch 都是
revoke 触发器。revoke 后，P/A 必须清除 activation/connection，abort 尚未
完成的安全工作，禁止 automatic reconnect；新连接必须由 A 用户显式操作，
并重新完成 issue、exchange 和创建新 lease。

`deactivate` 只是清理通知，不是 lease 撤销或有效性证明。短 TTL 不能替代
lease polling；lease 轮询不可用或超过 90 秒未确认时必须 fail closed。

### AUTH-005：scope / target / context binding

浏览器只提交 bridge binding 和固定的 Integration 选择。P BFF 从自身已验证
的 session/SSO 与业务 ACL 独立派生 canonical subject、`targetId`、root、
capabilities 和本次 `childFrames` B 子集；Auth 与 Host 只能进一步收窄。
浏览器自报的 `tenantId`、`targetId`、root、capability 或 B 清单永远不能成为
授权依据。一个 session 只绑定一个 subject/tenant、Integration、scope、
target、bridge/session/host/frame instance 和 config context；单个 Grant 的
B 上限仍为 8。

### AUTH-006：B subject consistency 与 V1 边界（启用 B 时）

V1 Auth 只比较 P/A canonical subject，不比较 B subject。B 的每个业务请求
始终独立校验 B 自己的 session、tenant/object ACL、CSRF、幂等和业务状态，B
保留最终 deny；P/A allow 或人工审批不能覆盖 B deny。

默认不要求 B 与 P/A 是同一主体。确需三方同主体的业务，必须使用受信的
P BFF → B BFF subject-binding，或在新版本 Integration 中让 B 参与 Auth；
浏览器传入的 user-id 不构成证明。

### AUTH-007：trusted HTTP 与浏览器会话安全

生产默认使用 HTTPS。V1 受控内网可以使用 HTTP，但必须使用精确的 P/A/B
origin，并有明确、可到期的风险批准、私网可达性证明和迁移计划。P/A/BFF
的浏览器会话使用显式 CSRF header 与 Origin 校验；禁止 wildcard CORS。
原始 opaque policy 只在短时受控内存中存在，不写入 URL、Cookie、
`localStorage`、普通日志或埋点。

AUTH-001 的 service identity 约定不改变上述 HTTP、origin、CSRF、CORS、
Cookie、CSP、sandbox、storage 或浏览器不能直连 Auth 的合同；这些边界由
网络、BFF、浏览器和部署配置分别承担，不能声称由 service-actor 校验提供。

### AUTH-008：credential/session TTL、clock skew 与刷新

服务端统一计算严格过期时间，并在 Registry 加载时拒绝非法 TTL。policy
默认 TTL 为 **120 秒**，最大 **300 秒**；active lease/bridge context
默认 TTL 为 **900 秒**，最大 **3600 秒**，且不得超过用户凭据有效期。
`clock skew` 容忍窗口固定为 **5 秒**，仅用于明确的 `nbf` 容忍，不延长
`exp` 或 lease 有效期。

policy 不刷新、不复用；lease 不续租。bridge TTL 与 policy TTL 分离。用户
凭据、P/A/B session、authorization context 和短 token 的其他具体生命周期
必须服从“不超过凭据有效期”和严格过期原则，并由实现配置明确记录；停止、
deactivate、logout 或 lease revoke 后不得继续使用旧授权上下文。

### AUTH-014：cross-scope / cross-integration boundary

`integrationId` 和 `scopeId` 在 environment Registry 内唯一，并带稳定的
parent/scope 语义。生产与测试 Registry 必须物理或逻辑隔离。跨 scope 或
跨 environment 的例外必须创建新的版本化 Integration，不得复用已有 grant、
authorization context 或 bridge session；不同 scope 分别授权、分别执行，
不提供跨 scope 原子事务语义。

### AUTH-020：多实例隔离、HA、SLO 与故障矩阵

生产禁用所有 `InMemory*` Registry/Store。生产 Auth 使用共享原子 TTL Store，
并在异常、依赖不可用或一致性不明时 fail closed。跨副本的 consume/revoke
使用条件更新/compare-and-delete，保证一个有效 grant 只能被一次消费；先以
单区域强一致达到发布门槛，再评估跨区域扩展。一个逻辑 A 可以有多个 HA
副本并服务多个 P、tenant 和 A iframe runtime instance，但副本不产生新的
逻辑身份或运行时上下文。

## 取舍与明确不采用

1. 不采用把 mTLS、service JWT 或其他 service token 校验作为本 ADR 受控内网
   的 caller-authentication 机制；代价是任何可达 Auth 网络的内部调用方均可
   冒充 P/A，该残余风险必须在部署记录中可见。
2. 不采用仅靠短 policy/bridge TTL 替代 active-session revoke；活动连接的
   正确性依赖 BFF-mediated lease polling。
3. 不采用跨 scope 共用 grant/context，也不采用把 tenant 写成 Registry 主键
   来替代 canonical subject/session 隔离。
4. 不采用生产内存 Store、静默截断第 9 个 B、浏览器直连 Auth 或把 B 的最终
   业务 ACL 移入 V1 Auth。

## 依赖、迁移与未完成实现

-   Auth endpoint、OpenAPI/HTTP 状态与错误合同、网络 ACL、bilateral actor
    约定、真实 SSO、Registry、共享 Store、HA、kill switch、限流、审计、告警
    和 on-call 仍由生产服务与部署系统实现。
-   lease API、`ACTIVE`/`REVOKED`/`EXPIRED` 状态、900s TTL、30s ±20% polling、
    90s fail-closed、abort 与 reconnect 禁止语义以及同源 status API 在仓内已有
    参考实现；现有代码仍不能作为生产 Auth/BFF/共享 Store/HA 的生产行为证据。
-   现有 domain actor 校验只能防止参考实现中的配置/参数错配；它不是冻结的
    生产身份、授权或拒绝门禁，在 AUTH-001 约定下也不能证明实际网络调用方
    身份。生产残余风险不得通过把该校验描述为 mTLS、service JWT 或 caller
    authentication 来隐藏。
-   旧 `managed-auth` 仅保留一个兼容版本。任何 token、schema、错误分类、
    endpoint 或 lease 状态变更必须新增 ADR/迁移记录，不能在实现中隐式兼容。

## 验收证据与状态边界

本 ADR 的状态是 `accepted`，对应台账决策状态 `已冻结`。这只表示 P0 合同
已经确定，不表示已部署或已验证。必须另行补充并挂接以下证据，才能清除台账
中的落地标签并进入灰度：

-   生产 Auth endpoint、配置 schema、HTTP/OpenAPI、network reachability、
    serviceActor 约定和浏览器无直连证据；
-   canonical subject/issuer、configVersion、scope/target/B subset、8/9 B、
    跨 tenant/instance/scope/environment 拒绝矩阵；
-   lease exchange 原子创建、900s 不续租、30s ±20% polling、90s fail-closed、
    immediate REVOKED/EXPIRED、abort/cleanup/no-reconnect 和新用户连接矩阵；
-   共享 Store 跨副本原子 consume/revoke、TTL、故障失败关闭、容量、SLO、
    RPO/RTO、kill switch、真实浏览器 cookie/CSP/CSRF/CORS/HTTP 验收。

在上述证据完成前，所有适用的 `仅文档`、`参考实现`、`缺实现`、`缺生产实现`
和 `缺测试` 标签必须保留；本 ADR 不得被引用为 `已验证` 或生产上线证明。
