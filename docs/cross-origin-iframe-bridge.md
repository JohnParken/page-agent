# Cooperative cross-origin iframe bridge

> 中文版：[跨域 iframe 协作桥接指南](./cross-origin-iframe-bridge.zh-CN.md)

The optional iframe bridge lets a Page Agent on a parent page observe and operate a
cooperative, direct child iframe served from another HTTP(S) origin. The parent still
owns the agent and the local page controller; the child only exposes the controller
operations that it explicitly opts into.

## Install and import

The bridge keeps its NPM/ESM secondary entry points and also ships separate, self-contained
parent and child IIFE files. Use the ESM imports below for bundled applications; classic-script
pages should follow the [Chinese IIFE integration guide](./cross-origin-iframe-bridge-script.zh-CN.md).
Do not load an ESM secondary entry directly through a classic `<script>` tag or use an IIFE as
the Node/ESM default entry.

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

While an authorized click or input request is running, the host also relays visual pointer
movement and click feedback over that authenticated port. Each pointer message is bound to
the active request ID. The parent translates child-viewport coordinates through the iframe's
top-level viewport rectangle before updating its `SimulatorMask`.

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
only an indexed element and the requested text, option, or scroll values. Click and input
actions may additionally send request-bound child-viewport pointer coordinates and click
feedback for the parent visual mask. This is not a data-filtering boundary: any text or
attributes that the child controller includes in its browser state are visible to the
parent, so do not expose sensitive content to an untrusted parent origin.

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

## Deploy an existing test application across two HTTPS origins

Use this procedure when you already have a parent application and a separately deployed
child application. It is framework-agnostic: keep using each application's existing build
and release commands, and replace the placeholder origins below with the final values.

The example uses these test-environment origins:

-   Parent application: `https://parent.test.example`
-   Direct child iframe: `https://child.test.example`
-   LLM gateway: `https://llm-gateway.test.example`

All three are placeholders. An origin is only the scheme, host, and optional port; paths
such as `/embedded` belong in the iframe `src`, not in an allow-list. The parent and child
must be served over HTTPS in an HTTPS test environment. An HTTP child is mixed content and
does not provide the same security properties as the deployed configuration.

### Build the parent and child separately

1.  In the parent application, install `page-agent` and
    `@page-agent/page-controller`. Bundle the parent with the application's normal
    production build and retain the public ESM exports (`page-agent` and
    `page-agent/iframe-bridge`). The parent bundle owns `PageAgent`, the LLM configuration,
    and the local controller.
2.  In the child application, install `@page-agent/page-controller`. Bundle
    `@page-agent/page-controller/iframe-bridge` with the application's normal production
    build. The child bundle must create a `FrameBridgeHost`; it must not create a
    `PageAgent`, call an LLM, or contain an LLM key. Keep the parent and child package
    versions compatible.
3.  If the child application cannot be changed to install and start `FrameBridgeHost`,
    this bridge cannot observe or operate it. CORS headers do not make an uncooperative
    child bridgeable; use a supported integration or leave that iframe outside the
    bridge.

The repository's `npm run test:e2e` and `npm run demo:iframe-bridge` commands build and
serve repository fixtures for local verification only. They are not deployment commands;
do not publish the repository demo server or expose its `/api/env-config` endpoint. That
endpoint is a browser-facing test helper and must never be used to deliver real secrets.

### Configure runtime origins and controllers

Set the same exact origin pair in both applications. The parent allow-list names the child;
the child allow-list names the parent. Supply these values through each application's
trusted test-environment configuration; do not accept an arbitrary browser query parameter
as an origin allow-list entry:

```ts
// Parent application, served from https://parent.test.example
import { PageAgent } from 'page-agent'
import { FrameAwarePageController, PageController } from 'page-agent/iframe-bridge'

const childOrigin = 'https://child.test.example'
const pageController = new FrameAwarePageController({
    localController: new PageController(),
    frameSelector: 'iframe[data-page-agent-bridge]',
    allowedChildOrigins: [childOrigin],
})

const agent = new PageAgent({
    pageController,
    provider: 'tl',
    endpointAgent: 'https://llm-gateway.test.example',
    model: 'test-model',
})
```

```html
<!-- Parent application -->
<iframe
    data-page-agent-bridge
    src="https://child.test.example/embedded"
    title="Test widget"
    sandbox="allow-scripts allow-same-origin"
></iframe>
```

```ts
// Child application, served from https://child.test.example
import { FrameBridgeHost, PageController } from '@page-agent/page-controller/iframe-bridge'

const bridgeHost = new FrameBridgeHost({
    controller: new PageController(),
    allowedParentOrigins: ['https://parent.test.example'],
    capabilities: [
        'observe',
        'click',
        'input',
        'select',
        'scroll',
        'scrollHorizontally',
        'cleanup',
    ],
})
bridgeHost.start()
```

Do not use `*`, `null`, a path, or a query string in either allow-list. Verify the final
scheme, host, and port after any proxy or redirect; a changed origin must be released as a
coordinated parent-and-child configuration change. The bridge supports direct child frames
only, and it never forwards `executeJavascript`; that operation remains local to the
parent controller.

### Configure HTTPS, CSP, and the LLM gateway

-   On the parent response, set CSP `frame-src https://child.test.example` (or the
    equivalent `child-src` policy). On the child response, set CSP
    `frame-ancestors https://parent.test.example`.
-   Do not send `X-Frame-Options: DENY`. `SAMEORIGIN` also blocks this cross-origin
    embedding; remove it or replace it with a policy compatible with the intended parent.
-   If using `sandbox`, retain `allow-scripts` so the host can run and `allow-same-origin`
    so the child keeps its configured HTTPS origin. Without the latter, the browser uses an
    opaque `null` origin and the exact-origin handshake is rejected.
-   The bridge uses `postMessage` and `MessageChannel`; it does **not** require CORS
    headers between the parent and child. Configure CORS only for APIs that actually use
    `fetch`/XHR. If the parent calls the LLM gateway directly, the gateway must use HTTPS
    and allow only the exact parent origin (and the required methods/headers).
-   Keep long-lived LLM/API credentials on a trusted server or gateway. Never put them in
    the child bundle, iframe URL, bridge messages, or a repository demo endpoint. A
    browser-facing token, if unavoidable, must be short-lived and scoped to the test
    environment.

### Deploy, accept, and roll back

Deploy in this order:

1.  Deploy or enable the HTTPS LLM gateway and its exact-parent-origin CORS policy. Keep
    gateway credentials out of both bundles and verify that redirects do not change the
    browser-visible origin.
2.  Build and deploy the child application. Start `FrameBridgeHost`, set its final
    `allowedParentOrigins`, and apply the child `frame-ancestors`/X-Frame-Options policy.
3.  Build and deploy the parent application with the final `allowedChildOrigins`, iframe
    `src`, `frameSelector`, parent `frame-src` policy, and LLM gateway endpoint.

Accept the deployment only after all of the following are true:

-   The parent page loads the direct child over HTTPS without mixed-content, CSP, or
    X-Frame-Options errors, and the child host completes the origin-checked handshake.
-   The parent controller observes local content and the child section, then successfully
    routes the supported click, input, select, and scroll operations. Refresh observation
    after child navigation before using new indices.
-   A remote `executeJavascript` request is rejected, and an unavailable child does not
    stop local parent operations.
-   Browser Network/Console checks show LLM requests only to the configured HTTPS gateway,
    CORS limited to the parent origin, and no key in HTML, JavaScript, URLs, or messages.

If the child release is unhealthy, first roll the parent back to the last version that did
not select or bridge that iframe (or remove `data-page-agent-bridge` and leave the
cross-origin iframe outside Page Agent automation). The parent local controller continues
to operate the parent document, but cannot read the cross-origin child. Then disable or roll
back the child host. Do not widen an allow-list to recover from a deployment error. Re-run
the acceptance checks before re-enabling the bridge.
