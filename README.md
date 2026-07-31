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
