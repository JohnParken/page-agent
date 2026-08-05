# Page Agent

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://page-agent.github.io/assets/readme/banner-dark.png">
  <img alt="Page Agent Banner" src="https://page-agent.github.io/assets/readme/banner-light.png">
</picture>

[![CI](https://img.shields.io/github/actions/workflow/status/alibaba/page-agent/main-ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/alibaba/page-agent/actions/workflows/main-ci.yml)
[![npm](https://img.shields.io/npm/v/page-agent?style=flat-square&label=npm)](https://www.npmjs.com/package/page-agent)
[![downloads](https://img.shields.io/npm/dt/page-agent?style=flat-square)](https://www.npmjs.com/package/page-agent)
[![size](https://img.shields.io/bundlephobia/minzip/page-agent?style=flat-square&label=size)](https://bundlephobia.com/package/page-agent)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](https://opensource.org/licenses/MIT)
[![typescript](https://img.shields.io/badge/%3C%2F%3E-typescript-blue?style=flat-square)](http://www.typescriptlang.org/)
[![GitHub stars](https://img.shields.io/github/stars/alibaba/page-agent.svg)](https://github.com/alibaba/page-agent)

The GUI Agent Living in Your Webpage. One script gives any web page its own AI agent.

<a href="https://trendshift.io/repositories/22551?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-22551" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/22551" alt="alibaba%2Fpage-agent | Trendshift" width="180"/></a>

🌐 **English** | [中文](./docs/README-zh.md)

<a href="https://alibaba.github.io/page-agent/" target="_blank"><b>🚀 Demo</b></a> | <a href="https://alibaba.github.io/page-agent/docs/introduction/overview" target="_blank"><b>📖 Docs</b></a> | <a href="https://news.ycombinator.com/item?id=47264138" target="_blank"><b>📢 HN Discussion</b></a> | <a href="https://x.com/simonluvramen" target="_blank"><b>𝕏 Follow on X</b></a>

<!-- demo video -->

[![Watch the demo](https://page-agent.github.io/assets/readme/poster.jpg)](https://github.com/user-attachments/assets/a1f2eae2-13fb-4aae-98cf-a3fc1620a6c2)

---

## ✨ Features

-   **🎯 Easy integration**
    -   No need for `browser extension` / `python` / `headless browser`.
    -   Just in-page javascript. Everything happens in your web page.
-   **📖 Text-based DOM manipulation**
    -   No screenshots. No multi-modal LLMs or special permissions needed.
-   **🧠 Bring your own LLMs**
    -   Works with most mainstream models, including locally deployed ones. See [supported models](https://alibaba.github.io/page-agent/docs/features/models).

## 💡 Use Cases

-   **SaaS AI Copilot** — Ship an AI copilot in your product in lines of code. No backend rewrite.
-   **Smart Form Filling** — Turn 20-click workflows into one sentence. Perfect for ERP, CRM, and admin systems.
-   **Accessibility** — Make any web app accessible through natural language. Voice commands, screen readers, zero barrier.

## 🚀 Quick Start

### One-line integration

Fastest way to try PageAgent with our free Demo LLM:

```html
<script
    src="https://cdn.jsdelivr.net/npm/page-agent@1.12.2/dist/iife/page-agent.demo.js"
    crossorigin="anonymous"
></script>

<!-- China CDN mirror if you can't access jsDelivr -->
<!-- https://registry.npmmirror.com/page-agent/1.12.2/files/dist/iife/page-agent.demo.js -->
```

> **⚠️ For technical evaluation only.** This demo CDN uses our free [testing LLM API](https://alibaba.github.io/page-agent/docs/features/models#free-testing-api). By using it, you agree to its [terms](https://github.com/alibaba/page-agent/blob/main/docs/terms-and-privacy.md).
>
> Add `?autoInit=false` to load the script without creating the demo agent automatically. You can then instantiate it with `new window.PageAgent(...)` and your own LLMs.

### NPM Installation

```bash
npm install page-agent
```

```javascript
import { PageAgent } from 'page-agent'

const agent = new PageAgent({
    model: 'qwen3.5-plus',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: 'YOUR_API_KEY',
    language: 'en-US',
})

await agent.execute('Click the login button')
```

For more programmatic usage, see [📖 Documentations](https://alibaba.github.io/page-agent/docs/introduction/overview).

For cooperative cross-origin iframe support, see the [iframe bridge integration guide](docs/cross-origin-iframe-bridge.md). A standalone classic-script/IIFE integration is also available in the [Chinese IIFE guide](docs/cross-origin-iframe-bridge-script.zh-CN.md).

### Cross-origin iframe in an existing test application

The bridge can let a Page Agent in an existing parent app observe and operate a cooperative,
direct child iframe from a different HTTPS origin. The parent and child must both integrate
their controllers and use paired, exact `allowedChildOrigins` / `allowedParentOrigins` values;
if the child cannot be modified to start `FrameBridgeHost`, it cannot be bridged. The bridge
uses `postMessage`, so it does not need CORS between the two pages. CORS is only for APIs such
as an LLM gateway, which must use HTTPS, allow the exact parent origin, and keep long-lived
credentials on a trusted server. See the [two-origin deployment chapter](docs/cross-origin-iframe-bridge.md#deploy-an-existing-test-application-across-two-https-origins)
for CSP, sandbox, acceptance, and rollback guidance.

For repository-only fixture verification, run:

```bash
npm run test:e2e
npm run demo:iframe-bridge
```

These commands use local HTTP fixtures and are not production deployment commands. Do not
publish the repository demo server or expose its `/api/env-config` test endpoint, and never
put real API keys in that endpoint or any child bundle.

## 🧪 Test Page Agent Tools Locally

The repository includes a local test page that covers text input, checkboxes, radio buttons, dropdowns, form submission, clicks, dialogs, asynchronous DOM updates, scrolling, and JavaScript execution.

Start the demo server:

```bash
npm run dev:demo
```

Then open [http://localhost:5174/test-page.html](http://localhost:5174/test-page.html) and give Page Agent the following task:

```text
请完成这个测试页的全部测试：

1. 姓名填写“张三”，邮箱填写“zhangsan@example.com”，备注填写“Page Agent 测试备注”。
2. 部门选择“研发部”。
3. 勾选“邮件”和“站内信”，优先级选择“紧急”。
4. 在可编辑内容中输入“Contenteditable 输入成功”。
5. 提交表单并确认页面显示提交成功。
6. 点击计数器两次。
7. 打开确认弹窗并点击确认。
8. 加载动态内容，等待加载完成后点击动态按钮。
9. 滚动纵向容器并点击纵向终点。
10. 横向滚动容器并点击横向终点。
11. 使用 JavaScript 将 #javascript-target 的 data-agent-value 设置为 verified，并将文字改成“JavaScript 执行成功”。
12. 滚动到页面最底部并点击页面终点。
13. 检查事件日志，然后报告每一项是否成功。
```

### Tl AI configuration: local test and production

The local test page currently uses Tl AI through the development proxy. The defaults come from the
repository-root [`.env`](.env), not from `test-page.html`:

```dotenv
LLM_PROVIDER=tl
LLM_ENDPOINT_AGENT=localhost:8089
LLM_MODEL_NAME=qwen3.5-plus
LLM_TOOL_CALLING_MODE=system_prompt
```

Only `LLM_PROVIDER`, `LLM_ENDPOINT_AGENT`, and `LLM_MODEL_NAME` are required by PageAgent. Whether
`LLM_APP_ID`, `LLM_TR_CODE`, and `LLM_TR_VERSION` must contain values depends on the target Tl service.
`LLM_BASE_URL` and `LLM_API_KEY` are OpenAI-provider settings and are not used by the built-in `TlAiClient`.

`packages/page-agent/vite.iife.config.js` loads this file and injects these values into the demo bundle at
**build time**. Restart `npm run dev:demo` after changing `.env`. These values are bundled into browser
JavaScript, so never put secrets in them.

Start the local proxy separately:

```bash
npm run start:tl-proxy -w @page-agent/llms
```

The demo resolves Tl configuration in this order, from highest to lowest priority:

1. Query parameters on `page-agent.demo.js`
2. Build-time `LLM_*` environment variables loaded from the root `.env`
3. Demo defaults (`provider=tl`, `toolCallingMode=system_prompt`, `model=qwen3.5-plus`, `endpointAgent=http://127.0.0.1:8089`); override the endpoint with `LLM_ENDPOINT_AGENT` at build time or `endpointAgent` in the script query

All supported demo configuration values are:

| PageAgent option  | Build variable          | Script query parameter | Required for Tl | Notes                                     |
| ----------------- | ----------------------- | ---------------------- | --------------- | ----------------------------------------- |
| `provider`        | `LLM_PROVIDER`          | `provider`             | Yes             | Set to `tl`                               |
| `endpointAgent`   | `LLM_ENDPOINT_AGENT`    | `endpointAgent`        | Yes             | Host or full HTTP(S) URL                  |
| `model`           | `LLM_MODEL_NAME`        | `model`                | Yes             | Tl prompt/model name                      |
| `appId`           | `LLM_APP_ID`            | `appId`                | No              | Defaults to an empty string               |
| `trCode`          | `LLM_TR_CODE`           | `trCode`               | No              | Defaults to an empty string               |
| `trVersion`       | `LLM_TR_VERSION`        | `trVersion`            | No              | Defaults to an empty string               |
| `toolCallingMode` | `LLM_TOOL_CALLING_MODE` | `toolCallingMode`      | No              | `system_prompt` (default for Tl) or `api` |

For example, a demo script can override the build-time settings without editing `.env`:

```html
<script src="/page-agent.demo.js?provider=tl&endpointAgent=https%3A%2F%2Ftl.example.com&model=my-model&toolCallingMode=system_prompt"></script>
```

For an npm production deployment, configure `PageAgent` at runtime. This is preferred because it does not
depend on demo-only build variables:

```javascript
import { PageAgent } from 'page-agent'

const agent = new PageAgent({
    provider: 'tl',
    endpointAgent: 'https://tl.example.com',
    model: 'my-production-model',
    appId: 'my-app',
    trCode: 'my-transaction',
    trVersion: '1.0',
    toolCallingMode: 'system_prompt',
})
```

If production uses a prebuilt IIFE bundle, provide `LLM_*` variables while building it:

```bash
LLM_PROVIDER=tl \
LLM_ENDPOINT_AGENT=https://tl.example.com \
LLM_MODEL_NAME=my-production-model \
LLM_APP_ID=my-app \
LLM_TR_CODE=my-transaction \
LLM_TR_VERSION=1.0 \
LLM_TOOL_CALLING_MODE=system_prompt \
npm run build:demo -w page-agent
```

The browser calls `${endpointAgent}/chatbbc/init_session` and `${endpointAgent}/chatbbc/chat` directly.
The production endpoint therefore needs HTTPS when the page uses HTTPS and must allow the page origin via
CORS. Do not expose credentials in PageAgent options, query parameters, or build variables. If authentication
requires a secret, keep it on a trusted server and expose a suitable authenticated gateway to the browser.

`TlProxyServer` is a development simulator and should not be deployed as the production Tl service. Its
configuration is independent from the browser configuration:

See [TlProxy_README.md](packages/llms/src/dev-tools/TlProxy_README.md) for proxy behavior and diagnostics.

## 🤝 Contributing

We welcome contributions from the community! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and [docs/developer-guide.md](docs/developer-guide.md) for local development workflows.

Built something cool with PageAgent? Share it in [Show and Tell](https://github.com/alibaba/page-agent/discussions/categories/show-and-tell). 🙌

Please read the [maintainer's note](https://github.com/alibaba/page-agent/issues/349) on principles and current state.

Contributions generated entirely by **bots or AI** without substantial human involvement will **not be accepted**.

## ⚖️ License

[MIT License](LICENSE)

## 👏 Acknowledgments

This project builds upon the excellent work of **[`browser-use`](https://github.com/browser-use/browser-use)**.

`PageAgent` is designed for **client-side web enhancement**, not server-side automation.

```
DOM processing components and prompt are derived from browser-use:

Browser Use <https://github.com/browser-use/browser-use>
Copyright (c) 2024 Gregor Zunic
Licensed under the MIT License

We gratefully acknowledge the browser-use project and its contributors for their
excellent work on web automation and DOM interaction patterns that helped make
this project possible.
```

**⭐ Star this repo if you find PageAgent helpful!**
