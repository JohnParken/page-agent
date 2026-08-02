# Cooperative cross-origin iframe bridge

> 中文版：[跨域 iframe 协作桥接指南](./cross-origin-iframe-bridge.zh-CN.md)

The optional iframe bridge lets a Page Agent on a parent page observe and operate a
cooperative, direct child iframe served from another HTTP(S) origin. The parent still
owns the agent and the local page controller; the child only exposes the controller
operations that it explicitly opts into.

## Install and import

Version 1 is NPM/ESM-only. Use the secondary entry points rather than a script tag or a
UMD bundle:

```bash
npm install page-agent @page-agent/page-controller
```

The parent needs `page-agent`; a standalone child that only installs a host needs
`@page-agent/page-controller` and does not need an LLM package or API credentials. CORS
response headers do not grant cross-origin DOM access and are not required for this
`postMessage` bridge. Embedding policies (CSP and `frame-ancestors`) still apply.

The bridge classes are available from either package subpath:

```ts
import { FrameAwarePageController, FrameBridgeClient } from 'page-agent/iframe-bridge'
import { FrameBridgeHost, PageController } from '@page-agent/page-controller/iframe-bridge'
```

`FrameAwarePageController` creates and manages one `FrameBridgeClient` per matching
iframe. `FrameBridgeClient` is also exported for advanced integrations that need to own a
single direct-frame connection themselves.

## Parent page

Create a local controller, wrap it with `FrameAwarePageController`, and pass the wrapper
to `PageAgent`. The selector is deliberately explicit: only matching direct child
iframes are considered.

```ts
import { PageAgent } from 'page-agent'
import { FrameAwarePageController } from 'page-agent/iframe-bridge'
import { PageController } from '@page-agent/page-controller/iframe-bridge'

const pageController = new FrameAwarePageController({
    localController: new PageController(),
    frameSelector: 'iframe[data-page-agent-bridge]',
    allowedChildOrigins: ['https://widgets.example.com'],
})

const agent = new PageAgent({
    pageController,
    model: 'your-model',
    baseURL: 'https://your-llm-gateway.example.com/v1',
    apiKey: 'YOUR_API_KEY',
})
```

`allowedChildOrigins` must contain exact HTTP(S) origins (scheme, host, and port only),
and each iframe `src` is checked against that list. The bridge also checks the
`postMessage` `event.source` and `event.origin`; `*`, `null`, paths, and query strings
are rejected. Keep the list as small as possible.

## Child page

The child installs a `FrameBridgeHost` with its own controller and an exact allow-list of
parent origins. It does not create a `PageAgent`, call an LLM, or need an API key.

```ts
import { FrameBridgeHost, PageController } from '@page-agent/page-controller/iframe-bridge'

const bridgeHost = new FrameBridgeHost({
    controller: new PageController(),
    allowedParentOrigins: ['https://app.example.com'],
})
bridgeHost.start()

// On page teardown or replacement:
// bridgeHost.dispose()
```

The host uses a dedicated `MessageChannel` after the origin-checked handshake. A new
host instance should be created for a new document/navigation.

## Browser and embedding requirements

-   The parent must allow the child in CSP `frame-src` (or `child-src`), and the child
    must allow the parent in CSP `frame-ancestors`.
-   `X-Frame-Options: DENY` or a conflicting `SAMEORIGIN` policy prevents embedding before
    the bridge can run.
-   A sandboxed iframe needs `allow-scripts` for the host code and `allow-same-origin` to
    retain its configured HTTP(S) origin. Without `allow-same-origin`, the frame has an
    opaque `null` origin and the exact-origin handshake is rejected.
-   The iframe must be a direct child of the parent document and its `src` must resolve to
    one of the configured child origins.

## Exposed surface and limits

The host advertises capabilities independently. Version 1 supports `observe`, `click`,
`input`, `select`, `scroll`, `scrollHorizontally`, and `cleanup`; a parent request for a
capability not advertised by the child is denied. `executeJavascript` is intentionally
not a bridge method and is never forwarded to the child. Arbitrary `postMessage` payloads
are not an extension mechanism.

Observation sends the child controller's browser state (URL, title, scroll hints,
simplified indexed content, and tree revision/index metadata) to the parent. Actions send
only an indexed element and the requested text, option, or scroll values. This is not a
data-filtering boundary: any text or attributes that the child controller includes in its
browser state are visible to the parent, so do not expose sensitive content to an
untrusted parent origin.

The bridge handles direct, cooperative child frames only. Same-origin frames remain with
the local DOM controller, nested frames are not recursively discovered, and a child that
does not install a host (or is blocked by embedding policy) is reported as unavailable.
One unavailable frame does not prevent usable cooperative frames from being observed or
acted on.

## Lifecycle and degraded operation

The parent client invalidates a connection on iframe `load`/navigation and reconnects on
the next observation. Dynamically added matching frames are discovered; removed frames
are disposed. Refresh the browser state before using new indices, because element indices
and tree revisions are scoped to the latest observation. If a frame navigates, times out,
or loses its host, its section is marked unavailable while local and other cooperative
frames continue to work. Dispose both the parent controller and child host when the page
or application is torn down.
