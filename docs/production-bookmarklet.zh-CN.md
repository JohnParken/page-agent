# Page Agent 生产收藏夹脚本部署（TlClient）

这个入口用于把 Page Agent 作为收藏夹脚本加载到当前网页。它是独立、压缩、内嵌样式的 IIFE，
配置在构建时固化，不使用 demo 默认值，也不接受脚本 URL 查询参数覆盖。

## 1. 构建

配置建议放在仓库根目录的 `.env.production`。这是 Vite 的 production 模式配置文件，示例：

```dotenv
LLM_ENDPOINT_AGENT=https://tl.example.com
LLM_MODEL_NAME=my-production-model
LLM_MAX_RETRIES=1
LLM_APP_ID=my-app
LLM_TR_CODE=my-transaction
LLM_TR_VERSION=1.0
LLM_TOOL_CALLING_MODE=system_prompt
TL_SYSTEM_PROMPT_VARIABLE_NAME=system_prompt
PAGE_AGENT_LANGUAGE=zh-CN
PAGE_AGENT_MAX_STEPS=20
```

然后在仓库根目录执行单条构建命令：

```bash
npm run build:bookmarklet -w page-agent
```

必填项只有 `LLM_ENDPOINT_AGENT` 和 `LLM_MODEL_NAME`；下表列出的其余变量均为可选。生产入口
固定使用 `provider=tl` 和 TlClient，无需设置 `LLM_PROVIDER`。端点必须是完整的 `http://` 或
`https://` URL；允许内网 HTTP，但不允许 URL 用户名、密码、查询字符串或片段。Shell 或 CI
中显式设置的环境变量会覆盖 `.env.production` 中的同名值。仓库的 `.gitignore` 已忽略
`.env.*`，请勿提交配置文件。

| 环境变量                         | 默认值          | 说明                      |
| -------------------------------- | --------------- | ------------------------- |
| `LLM_MAX_RETRIES`                | `0`             | 非负整数                  |
| `LLM_APP_ID`                     | 空              | Tl 应用标识，不得放置密钥 |
| `LLM_TR_CODE`                    | 空              | Tl 交易代码               |
| `LLM_TR_VERSION`                 | 空              | Tl 交易版本               |
| `LLM_TOOL_CALLING_MODE`          | `system_prompt` | `api` 或 `system_prompt`  |
| `TL_SYSTEM_PROMPT_VARIABLE_NAME` | `system_prompt` | 必须与 Tl 模板变量一致    |
| `PAGE_AGENT_LANGUAGE`            | `zh-CN`         | `zh-CN` 或 `en-US`        |
| `PAGE_AGENT_MAX_STEPS`           | `20`            | 大于零的整数              |

产物路径：

```text
packages/page-agent/dist/iife/install.html
packages/page-agent/dist/iife/page-agent.bookmarklet.iife.min.js
```

生产入口固定使用 TlClient，关闭 `experimentalScriptExecutionTool` 和 `experimentalLlmsTxt`，
并删除生产包中的 `console`、`debugger` 和 source map。构建配置值会直接进入 IIFE，浏览器可以
查看构建产物；严禁放入 API key、Cookie、Bearer Token 或其他长期凭证。

## 2. 发布到 Nginx

建议使用不可变的版本路径，例如：

```text
/srv/page-agent/1.12.2/install.html
/srv/page-agent/1.12.2/page-agent.bookmarklet.iife.min.js
```

两个文件必须部署在同一版本目录中；`install.html` 会根据自身 URL 自动推导同目录的 IIFE
文件，不需要在页面中硬编码域名。

对应的 Nginx location 可以写成：

```nginx
location = /page-agent/1.12.2/install.html {
    alias /srv/page-agent/1.12.2/install.html;
    default_type text/html;

    add_header Cache-Control "no-cache" always;
    add_header X-Content-Type-Options "nosniff" always;
}

location = /page-agent/1.12.2/page-agent.bookmarklet.iife.min.js {
    alias /srv/page-agent/1.12.2/page-agent.bookmarklet.iife.min.js;
    default_type application/javascript;

    add_header Cache-Control "public, max-age=31536000, immutable" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Access-Control-Allow-Origin "*" always;
}
```

`Access-Control-Allow-Origin: *` 允许未来给加载器增加 `crossorigin` 或 SRI；它只作用于静态
JavaScript 文件，不会替 Tl API 配置 CORS。部署后先检查配置和响应：

```bash
sudo nginx -t
sudo nginx -s reload
curl -fsSI https://static.example.com/page-agent/1.12.2/page-agent.bookmarklet.iife.min.js
curl -fsSI https://static.example.com/page-agent/1.12.2/install.html
```

两个 URL 的响应都应为 `200`；`install.html` 应为 `text/html`、包含 `no-cache` 和
`nosniff`，IIFE 应为 JavaScript、包含上面的 immutable 缓存和 `nosniff` 响应头。
内网可以使用 HTTP；如果目标网页本身使用 HTTPS，浏览器通常会阻止它调用 HTTP Tl 服务。

## 3. 创建收藏夹

首选安装流程：打开 `https://static.example.com/page-agent/1.12.2/install.html`，显示浏览器
书签栏，然后将页面上的安装按钮拖拽到书签栏；在目标网页点击刚创建的书签即可运行。

手工兜底：新建书签，把下面这一整行作为书签地址，并替换静态文件 URL：

```text
javascript:(()=>{const s=document.createElement('script');s.src='https://static.example.com/page-agent/1.12.2/page-agent.bookmarklet.iife.min.js';s.referrerPolicy='no-referrer';s.onload=()=>s.remove();s.onerror=()=>{s.remove();alert('Page Agent failed to load')};(document.head||document.documentElement).appendChild(s)})()
```

每次点击都会重新加载入口；如果页面中已有 `window.pageAgent`，入口会先销毁旧实例及面板，再
创建新实例。

## 4. Tl 服务要求

浏览器会直接请求：

```text
${LLM_ENDPOINT_AGENT}/chatbbc/init_session
${LLM_ENDPOINT_AGENT}/chatbbc/chat
```

Tl 网关必须处理目标网页的 `Origin` 和预检请求。若要在任意网站运行，允许的 Origin 范围
会很宽；CORS 不是身份认证，不能据此保护公开网关。需要鉴权、配额或审计时，应在可信服务端
完成。

## 5. 上线检查与回滚

- 在测试域名验证面板加载、会话初始化、流式返回和点击/输入/滚动动作。
- 在浏览器 Network 面板确认没有向非预期域名发送请求，Console 中没有页面内容、提示词、
  响应正文或凭证。
- 通过版本目录发布新文件，不覆盖旧版本；修改收藏夹 URL 或服务器端受控跳转进行灰度。
- 保留上一版本文件。回滚时恢复收藏夹中的上一版本 URL，不需要清除一年缓存。
- 监控 Tl 网关的状态码、耗时、限流和失败率；日志只记录必要元数据，不记录页面正文或模型原文。

## 6. 浏览器限制

收藏夹脚本不能保证在所有网页运行。目标页的 CSP 可能同时阻止外部脚本和 IIFE 注入的内联
样式，浏览器内部页面、扩展商店页面和部分沙箱 iframe 也不允许注入。需要覆盖这些场景时，
应改用权限最小化、由用户点击触发的浏览器扩展，而不是在收藏夹里加入绕过代码。
