# 模型接入与待验证项

Qwen 模型为用户指定的 `qwen3.8-flash`。DeepSeek 精确 ID、服务商及 endpoint 通过服务端配置确定；缺少真实账号不阻止 fake provider 测试。

## 请求基线

-   model、messages、stream 由已验证 TL 请求和服务端配置生成，base URL 正确保留路径前缀并只追加一次 /chat/completions。
-   不发送 response_format，不强制 json_object/json_schema，不因提示词包含 JSON 就自动更改 API 参数。
-   不发送 tools、tool_choice、functions、function_call、parallel_tool_calls。组织内部未开放原生 tool_calls，必须通过提示词及普通正文测试工具语义。
-   stream:true（含缺省）实时处理 delta.content；stream:false 返回 message.content。输出正文可以是任意提示词约定的文本格式。
-   请求使用 Content-Type:application/json 及服务端 Bearer key；此 JSON 是 API 外层，不是对模型正文的限制。
-   provider 不支持流式或配置参数时明确失败，不静默改为非流式、换模型或再生成。
-   不把 reasoning_content、usage 或原生 tool_calls 混入可见正文。默认 debug 会记录实际上游事件；日志不代表这些字段可在 TL 响应中使用。

## Qwen

使用 OpenAI 兼容 HTTP API、qwen3.8-flash 和用户账号对应的地域/工作空间 endpoint。官方接口列出了相关模型和思考字段，但账号可用性仍需真实联调。[官方 Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)

base URL 与 key 的地域要匹配，使用控制台给出的实际 endpoint；旧开发代理的公共地址和 Origin:http://localhost 不是目标测试环境的固有要求。[官方兼容接口说明](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)

思考参数按精确模型显式配置，默认 provider-default。REST 顶层参数与 SDK extra_body 的包装不同，不能误把 SDK 包装直接发给 HTTP API。不因希望输出工具样式文本就启用原生 tools。以后若加 assistant 历史，再验证 preserve_thinking 等历史规则；当前只发送 system + user。

## DeepSeek

使用服务端配置的模型，通过 /chat/completions 调用；官方 API base 可以是 https://api.deepseek.com，第三方托管则采用其明确契约。模型参数需按精确 ID 验证，不能把 Qwen 的 enable_thinking 原样套用。[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)

旧 DsProxy 的 JSON 提示注入、name 选模型和角色文本解析不作为统一门面的默认行为。即使 provider 支持 JSON Output/原生工具，这个模拟器也不默认启用；输出格式靠提示词，工具含义由客户端处理。

## 联调记录

记录 provider、model、endpoint 地域/工作空间、日期、思考设置、输出上限、实时结果和使用的合成提示词；不记录 key 的真实值。公开资料核对日期为 2026-09-13，不代表用户账号联调通过。

至少测试四种提示词：普通文字回答、Markdown 列表、XML 文本、JSON 文本；再测试把工具操作描述为普通正文的提示词。确认请求没有 response_format 或原生工具控制字段、正文不被改写、首增量早于上游完成、默认四向 debug 报文可追踪。

真实 API 测试放 test:live，默认 npm test 使用 fake upstream。若经共享测试入口，重复首增量时序验证。报文日志中的可见模型内容与工具样式文本用于检查，不由代理执行。
