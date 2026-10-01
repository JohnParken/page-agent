---
name: tl-proxy-standalone
description: 使用 TypeScript 和 Node.js 规划、实现或维护独立 TL 报文测试代理，模拟组织内部 chatbbc init_session/chat 接口，接入 DeepSeek 或 qwen3.8-flash，实时转发正文并默认打印双向 debug 报文。用于缺少原生 tool_calls 接口的提示词驱动集成测试。
---

# TL 报文测试代理

目标：构建独立的 TypeScript/Node.js 测试模拟器，让开发者通过组织内部现行 TL 两阶段报文调用 DeepSeek 或 `qwen3.8-flash`。代理的主要价值是提供可测试的内部接口环境：组织内部尚未开放原生 `tool_calls` 字段，工具使用须通过提示词和普通模型正文约定。代理不是工具执行器。

数据方向为测试客户端 → TL 代理 → 模型服务，响应反向转换。本技能包是实现指南与验收依据，不包含已实现或部署的代理服务器。

## 使用流程

1. 读取 [接口契约](references/tl-contract.md)，保持 TL 路径、字段和成功出参；用户提供组织实际报文时优先对比，不将仓库观察结果当作组织完整规范。
2. 了解原代理时读取 [现状与差异](references/current-state.md)。其中的缓冲 SSE、强制 JSON 与工具兜底是旧行为，新模拟器遵循本技能当前要求。
3. 按 [实现方案](references/implementation-plan.md) 生成独立 TypeScript 源码，使用 Node.js 运行编译后的 JavaScript；这是已选定技术栈。
4. 按 [模型接入](references/providers.md) 配置上游。Qwen 使用用户指定的 qwen3.8-flash；DeepSeek 精确模型及服务商 endpoint 尚待配置。
5. 以 [验收矩阵](references/acceptance.md) 验证任意正文格式、实时性、报文日志和工具字段隔离，分别报告离线检查和真实 provider 联调。

## 必须遵守的行为

-   保持 `POST /chatbbc/init_session` 和 `POST /chatbbc/chat`。init 的 prompt_variables 绑定系统提示词，chat.txt 原样作为本轮 user 正文；原生变量路径不解析正文里的 system: 等角色标记。
-   保持 `data.session_id`、字符串 `data.txt`、`event: chunk` 的 `{"content":"..."}` 和 `event: done` 的 `{"finished":true}`。外层 JSON/SSE 是协议封装，不要求 content/txt 内的模型正文是 JSON。
-   输出格式完全由提示词决定。默认不发送 response_format，不注入 JSON 要求、不检查 JSON 关键词、不校验/修复/剥离正文格式。纯文本、Markdown、XML、JSON 等都原样转发。
-   不发送原生 tools、tool_choice、functions、function_call、parallel_tool_calls，不在 TL 响应中增加 tool_calls。提示词中描述工具、正文中出现工具名称或工具调用样式文本是允许的；代理不解析、转换或执行这些文本。
-   意外的非空原生 tool_calls/function_call 响应或增量是协议不匹配：明确报错，不转成正文或静默吞掉。不复制旧代理的工具响应兜底。
-   首版实时转发：stream:true（含缺省）请求上游流式输出，收到 delta.content 就写 TL chunk；不等待完整正文，不凑批回放。stream:false 保留完整 data.txt 响应。
-   默认 LOG_LEVEL=debug，打印四个方向的请求/响应报文，包括完整提示词、用户输入、模型正文和逐事件 SSE；仅对凭证做定向掩码。日志不得为等待完整流而延迟转发。
-   会话绑定提示词，不自动累积历史。保持 files:[] 和空文件占位兼容；真实附件不下载、不假装已支持。
-   默认是 loopback 测试环境，无需组织 SSO 即可启动；共享测试环境可配置独立访问凭证。appId 等业务字段不是身份凭证，上游 key 只由服务端配置。
-   流中失败发 error 后关闭，不发成功 done，不重试已输出请求，不执行工具，不推断 PageAgent action。

## 交付要求

请求实际实现时，交付独立源码、锁文件、build/start 入口、.env.example、测试、制品和测试启动说明；Dockerfile 可用于共享测试部署。不得依赖 PageAgent 工作区别名、UI、DOM 或仓库外源文件。

当前方案已包含主要决定，可直接完成离线实现和检查。模型账号、endpoint 和共享环境配置缺失不阻止本地模拟测试；真实调用和部署按当次用户授权执行。清楚区分 skill 完成、服务实现完成和真实联调通过。
