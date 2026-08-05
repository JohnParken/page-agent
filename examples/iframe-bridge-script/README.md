# iframe bridge 经典 script 示例

这个示例不使用打包器、`type="module"`、ESM import 或 import map。父、子页面分别从普通 `<script>` 加载独立 IIFE，并使用不同端口模拟跨 Origin。

先在仓库根目录构建：

```bash
npm run build:iife
```

再分别启动两个静态服务器：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
python3 -m http.server 4174 --bind 127.0.0.1
```

打开：

```text
http://127.0.0.1:4173/examples/iframe-bridge-script/parent.html
```

生产环境应使用 HTTPS、固定版本的 CDN URL、精确 Origin，以及与部署域名匹配的 CSP。不要把模型/API 密钥放入 HTML、URL、IIFE bundle 或 bridge 消息。
