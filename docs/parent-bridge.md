# Parent-page controller bridge

> 中文版：[父页面控制器桥接](./parent-bridge.zh-CN.md)

The parent bridge is the reverse of the existing `iframe-bridge`: an assistant
running in a direct child iframe asks a host in the parent page (same-origin with
the parent DOM) to observe and operate a deliberately scoped DOM root. The child
never receives a parent `document` reference. All access is an authenticated,
capability-limited protocol over `postMessage` and a dedicated `MessageChannel`.

This is a cooperative integration. The parent application must opt in by
installing the host, and the assistant iframe must install the adapter. A
cross-origin child that has not installed the adapter cannot operate the parent
DOM under the browser same-origin policy.

## Run the local reverse parent-bridge demo

The repository includes a reverse parent-bridge fixture in
`packages/e2e/fixtures`. The root command builds the page-controller library and
the PageAgent demo IIFE, then starts the shared fixture server:

```bash
npm run demo:parent-bridge
```

To start only the workspace server after an existing build, run
`npm run demo:parent-bridge --workspace=@page-agent/e2e`. The server uses the
existing `packages/e2e/server.mjs`, which listens on the parent origins
`127.0.0.1:4173` and `127.0.0.1:4175`, the shared assistant iframe origin
`127.0.0.1:4174`, and a separate cooperative business iframe origin
`127.0.0.1:4176`. Open either parent deployment in a browser:

-   [http://127.0.0.1:4173/reverse-parent.html](http://127.0.0.1:4173/reverse-parent.html)
-   [http://127.0.0.1:4175/reverse-parent.html](http://127.0.0.1:4175/reverse-parent.html)

The two parent URLs exercise the same child assistant origin with different
parent origins. The fixture presents a realistic operations dashboard, with the
assistant fixed on the right as a floating panel approximately 25% of the
viewport wide and 80% high. After the iframe connects, click **Run PageAgent**
to execute the fixed task: click the parent button, enter `PageAgent Demo` in
**Parent value**, select `Pro` for **Parent plan**, then click **Release
shipment** in the authorized business iframe and fill **Approval note** after a
one-use approval. The assistant also keeps
the manual low-level observe, click, input, select, scroll, and
JavaScript-denied controls for exercising the bridge directly. The observed
state also includes the explicitly authorized business iframe, so the demo can
exercise the complete assistant (A) → parent broker (P) → business iframe (B)
route without granting A direct access to B.

The assistant's PageAgent IIFE calls the same-origin endpoint
`http://127.0.0.1:4174/api/tl`. The fixture server reverse-proxies
`/api/tl/chatbbc/init_session` and `/api/tl/chatbbc/chat` to
`TL_ENDPOINT_AGENT`, which defaults to `http://localhost:8089`. Start that TL
proxy before running the demo, or override the upstream explicitly, for example
`TL_ENDPOINT_AGENT=http://localhost:9089 npm run demo:parent-bridge`. The browser
uses native `fetch`, leaves `customFetch` unset, and needs no CORS because it
never contacts the upstream directly.

The fixture's bridge authorization uses a PageAgent-managed one-time opaque
token, a same-origin P issuance route, and a same-origin A online-redemption
route. Its static demo identity and in-memory token store are single-process
test substitutes, not production storage. Automated tests set
`PARENT_BRIDGE_DEMO_MOCK_TL=1` to replace the live upstream
with deterministic click/input/select responses. The same flag can be used for
an offline bridge-only demonstration, but it is test behavior rather than a
model integration. Stop the server with `Ctrl-C` when finished, and do not
deploy the demo server or reuse its test policy in production.

## Install and entry points

```bash
npm install page-agent @page-agent/page-controller @page-agent/core @page-agent/llms
```

Use the narrow runtime entries in bundled applications:

```ts
import { PageController } from '@page-agent/page-controller'
import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'
import { ParentPageControllerAdapter } from '@page-agent/page-controller/parent-bridge/adapter'
import { createManagedEmbedAuthClient } from '@page-agent/page-controller/parent-bridge/managed-auth'
import '@page-agent/page-controller/parent-bridge/host.css'
```

The root `parent-bridge` entry contains protocol constants, guards, and types
only. Import `/host` or `/adapter` when runtime code is needed. The `page-agent`
package exposes equivalent JavaScript facades; import the host CSS from
`@page-agent/page-controller` as shown above.

## Parent host

The host owns the DOM controller and should expose the smallest root and
capability set that the assistant needs. `root` may be an element or a resolver
that fails closed when the application replaces the mounted root.

```ts
import { PageController } from '@page-agent/page-controller'
import { ParentPageControllerHost } from '@page-agent/page-controller/parent-bridge/host'

const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-page-agent-parent-bridge]')
if (!iframe) throw new Error('Parent bridge iframe was not found')

const managedAuth = createManagedEmbedAuthClient({
    endpoint: '/api/parent-bridge/embed-policy',
    expectedParentOrigin: window.location.origin,
    expectedAssistantOrigin: 'https://assistant.example.com',
    expectedScopeId: 'checkout',
    allowedCapabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup', 'visual'],
})

const host = new ParentPageControllerHost({
    iframe,
    assistantOrigin: 'https://assistant.example.com',
    root: () => document.querySelector('#checkout-root'),
    scopeId: 'checkout',
    capabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup', 'visual'],
    controllerOptions: { enableMask: false },
    visualFeedback: 'non-blocking',
    actionPolicy: ({ target }) =>
        target?.matches('[data-checkout-payment], [data-permission-change]')
            ? { decision: 'approval_required', reason: 'Sensitive business action' }
            : { decision: 'allow' },
    getEmbedPolicy: () => managedAuth.getEmbedPolicy(),
    verifyEmbedPolicy: (policy, context) => managedAuth.verifyEmbedPolicy(policy, context),
})

host.start()

// On SPA teardown or page replacement:
// host.dispose()
```

`visualFeedback: 'non-blocking'` enables both the parent status badge and a
fixed visual cursor. The cursor listens for the PageController's existing
`PageAgent::MovePointerTo` and `PageAgent::ClickPointer` events, renders only
when the reported point belongs to the trusted root, and uses
`pointer-events: none`. A click produces a short ripple animation. Navigation,
iframe reload, root replacement/removal, and `host.dispose()` hide or remove
the cursor. Use `visualFeedback: 'none'` when the parent must add no feedback
DOM.

`PageAgentCore` integrations must preserve `observe` and `cleanup` through every
capability gate: the Host options, the verified Policy claims, the child Adapter
request, and the capabilities returned by `authorizeOffer`. `cleanup` is
separate from `observe`; without it, the Core's final cleanup request is denied
and index highlights remain on the parent page. Add `visual` when using
`visualFeedback: 'non-blocking'`.

The default cursor mirrors the cursor on `main`: a 75px white PageAgent arrow
with a cyan-to-purple border, the same northwest orientation and a 300ms cyan
click ripple. Target systems can brand it without changing runtime code:

```css
:root {
    --page-agent-parent-cursor-width: 75px;
    --page-agent-parent-cursor-height: 75px;
    --page-agent-parent-cursor-fill: #fff;
    --page-agent-parent-cursor-gradient-start: rgb(57, 182, 255);
    --page-agent-parent-cursor-gradient-end: rgb(189, 69, 251);
    --page-agent-parent-cursor-ripple-color: rgb(57, 182, 255);
    --page-agent-parent-cursor-ripple-width: 4px;
    --page-agent-parent-cursor-move-duration: 90ms;
    --page-agent-parent-cursor-click-duration: 300ms;
}
```

The arrow tip and ripple center both use the exact action coordinate. Avoid
positive cursor offsets unless a custom shape has a different hotspot.

By default, the managed-auth client accepts only the exact `{ policy, claims }`
pair returned by its same-origin HTTPS endpoint, validates lifetime, parent/assistant origins,
scope, protocol, and capabilities, and requires `verifyEmbedPolicy` to receive
the same token and browser context. P's backend still performs user/business
authorization at that endpoint, and A's backend must redeem the token online.
For ES256/JWKS, replace these callbacks with the application signature verifier.
The bridge's origin/source/nonce checks do not replace application authorization.

For a controlled private-network HTTP deployment, both the Auth-side
`OpaqueEmbedAuthorizationService` and the P-side `createManagedEmbedAuthClient`
must explicitly set `allowInsecureHttp: true`; the default is `false`. This
allows exact `http:` origins but does not encrypt transport or protect against
an on-path attacker.

The host may also be started from the standalone browser bundle. The bundle is
intentionally limited to `ParentPageControllerHost`, the helper, and
`PageController`; it does not contain PageAgent Core, an LLM client, or UI. The
managed-auth helper remains a separate version-pinned ESM entry:

```html
<script src="/assets/page-agent-parent-host.iife.min.js"></script>
<script type="module">
    import { createManagedEmbedAuthClient } from '/assets/parent-bridge/managed-auth.js'
    const managedAuth = createManagedEmbedAuthClient({
        endpoint: '/api/parent-bridge/embed-policy',
        expectedParentOrigin: window.location.origin,
        expectedAssistantOrigin: 'https://assistant.example.com',
        expectedScopeId: 'checkout',
        allowedCapabilities: ['observe', 'click', 'input', 'cleanup'],
    })
    const iframe = document.querySelector('iframe[data-page-agent-parent-bridge]')
    const host = new PageAgentParentHost.ParentPageControllerHost({
        iframe,
        assistantOrigin: 'https://assistant.example.com',
        root: () => document.querySelector('#checkout-root'),
        scopeId: 'checkout',
        capabilities: ['observe', 'click', 'input', 'cleanup'],
        getEmbedPolicy: () => managedAuth.getEmbedPolicy(),
        verifyEmbedPolicy: (policy, context) => managedAuth.verifyEmbedPolicy(policy, context),
    })
    host.start()
</script>
```

## Broker an explicitly authorized sibling iframe

The parent host can optionally broker operations from the assistant iframe (A)
to a cooperative cross-origin business iframe (B). The parent page (P) remains
the only broker: A cannot address a sibling iframe directly, and B never trusts
A's origin. Configure each B iframe explicitly and require the application-owned
policy verifier to return an exact verified grant:

```ts
const host = new ParentPageControllerHost({
    // ...the regular iframe, origin, root, capability, and policy options...
    childFrames: {
        targets: [
            {
                id: 'fulfilment-app',
                iframe: () => document.querySelector<HTMLIFrameElement>('#fulfilment-frame'),
                origin: 'https://fulfilment.example.com',
                capabilities: ['observe', 'click', 'input', 'cleanup'],
            },
        ],
    },
    // This verifier must return the exact claims covered by the authorization,
    // including childFrames. Never append grants after verification.
    verifyEmbedPolicy: (policy, context) => managedAuth.verifyEmbedPolicy(policy, context),
    actionPolicy: ({ target, targetContext }) => {
        if (targetContext.kind === 'child-frame') {
            return targetContext.frameId === 'fulfilment-app'
                ? { decision: 'approval_required', reason: 'Operate fulfilment application' }
                : { decision: 'deny' }
        }
        return target?.matches('[data-permission-change]')
            ? { decision: 'approval_required' }
            : { decision: 'allow' }
    },
})
```

For this configuration, the authorization service's verified claims include this
grant before `verifyEmbedPolicy` runs:

```json
{
    "childFrames": [
        {
            "id": "fulfilment-app",
            "origin": "https://fulfilment.example.com",
            "cap": ["observe", "click", "input", "cleanup"]
        }
    ]
}
```

B must run a compatible iframe bridge v2 `FrameBridgeHost`, allow P's exact
origin, and advertise only the capabilities it accepts. A configured target is
usable only when its ID, exact origin, and capabilities also match the verified
`childFrames` claim, the parent host capabilities, and B's advertised
capabilities. Appending or modifying grants after policy verification would
bypass business authorization and must fail review. Omitting `childFrames` from verified claims is deliberately
local-only. Configured-but-unauthorized B content is hidden; an authorized but
temporarily unavailable B appears only as an unavailable marker. Unconfigured
iframes are never discovered.

Before a B mutation, P asks B to prepare the action with a sanitized summary.
B's policy, the parent element policy, and the parent's `actionPolicy` are
combined in the order `deny` > `approval_required` > `allow`. The assistant
shows at most one approval for the combined decision, then P commits B's
single-use action token. Neither A nor P can override B's deny, and raw input is
not sent to B during its prepare policy evaluation. Reloading or replacing B
invalidates its connection, tree revision, and old global indices; observe
again before retrying.

This proxy supports only explicitly configured direct cross-origin iframes
inside the trusted root. It does not read same-origin iframe documents, recurse
through arbitrary nested frames, or turn the assistant into a general-purpose
frame router. The parent CSP must allow both A and B in `frame-src`; A and B
must independently allow P in `frame-ancestors`.

## Child adapter

The child chooses the capabilities it requests and authorizes each offer from
the expected parent origin. Keep this callback tied to your deployment/config
rather than accepting an origin supplied by the page URL.

```ts
import { ParentPageControllerAdapter } from '@page-agent/page-controller/parent-bridge/adapter'

const expectedParentOrigin = 'https://app.example.com'
const adapter = new ParentPageControllerAdapter({
    requestedCapabilities: ['observe', 'click', 'input', 'cleanup', 'visual'],
    authorizeOffer: async (offer, actualParentOrigin, signal) => {
        if (signal.aborted || actualParentOrigin !== expectedParentOrigin) return undefined
        const response = await fetch('/api/parent-bridge/authorize-offer', {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                policy: offer.policy,
                actualParentOrigin,
                offer: {
                    policyId: offer.policyId,
                    sessionId: offer.sessionId,
                    challenge: offer.challenge,
                    frameInstanceId: offer.frameInstanceId,
                    hostInstanceId: offer.hostInstanceId,
                    capabilities: offer.capabilities,
                },
            }),
        })
        if (!response.ok) return undefined
        const { authorizationContext } = await response.json()
        if (
            authorizationContext.policyId !== offer.policyId ||
            authorizationContext.parentOrigin !== actualParentOrigin ||
            authorizationContext.assistantOrigin !== window.location.origin ||
            authorizationContext.sessionId !== offer.sessionId ||
            authorizationContext.challenge !== offer.challenge ||
            authorizationContext.frameInstanceId !== offer.frameInstanceId ||
            authorizationContext.hostInstanceId !== offer.hostInstanceId ||
            authorizationContext.capabilities.length !== offer.capabilities.length ||
            authorizationContext.capabilities.some(
                (capability: string, index: number) => capability !== offer.capabilities[index]
            )
        )
            return undefined
        return {
            parentOrigin: actualParentOrigin,
            policyId: offer.policyId,
            capabilities: offer.capabilities,
            authorizationContext,
        }
    },
    onApprovalRequired: async (request) => {
        // Show an assistant-side confirmation UI for mutating actions.
        return await confirm(`Allow ${request.method}?`)
    },
})

await adapter.connect()
try {
    const state = await adapter.getBrowserState()
    await adapter.clickElement(state.indices[0])
} finally {
    // Direct Adapter usage does not have PageAgentCore's task-finally cleanup.
    try {
        await Promise.allSettled([adapter.cleanUpHighlights(), adapter.hideMask()])
    } finally {
        adapter.dispose()
    }
}
```

`ParentPageControllerAdapter` implements the same controller-shaped methods as
the local controller. `executeJavascript` remains available for structural
compatibility but always resolves a deterministic `CAPABILITY_DENIED` result;
the parent bridge never evaluates child-supplied JavaScript. The adapter
reconnects after navigation only when the offer, policy, origin, frame
instance, and challenge are valid.

### Policy, rules, and one-use approvals

Treat `verifyEmbedPolicy` and the verified policy as the authority. An optional
`data-page-agent-policy="deny|confirm|allow"` attribute is a local business-risk
marker: map `confirm` to `approval_required`, and apply `deny > confirm >
allow`. It must never carry a `policyId`, origin, bearer token, or capability
grant. The policy's `jti` is a separate replay-control value. Configure
delete/payment/permission-changing targets explicitly with selectors and
`actionPolicy`; never infer risk from a button's visible label.

Apply checks in this order for every request: authenticated session and exact
origin/source; protocol/session/frame/challenge and policy freshness; verified
capabilities and the requested method; root containment and current tree
revision; then the host `actionPolicy`. The policy may only narrow access:
`deny` wins over `approval_required`, which wins over `allow`; a child approval
can never add a capability or override a host denial.

For `approval_required`, show a user-facing prompt containing a sanitized
method/capability/target summary. Bind it to the single `approvalId` and
`requestId`, mark it consumed before awaiting the UI, expire it on timeout or
navigation, and deny on dismissal. Never auto-approve a batch or replay an
approval response.

## Vue 3 composable (optional integration code)

Vue is not a dependency of Page Agent. The following composable is application
code; keep it in the assistant application and install Vue there.
For a fuller Core + Tl wiring example with approval/degraded state, see
[`examples/parent-bridge/use-page-agent.ts`](../examples/parent-bridge/use-page-agent.ts).

```ts
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import type { ParentControllerAdapterOptions } from '@page-agent/page-controller/parent-bridge/adapter'

type ParentAdapter = InstanceType<
    typeof import('@page-agent/page-controller/parent-bridge/adapter').ParentPageControllerAdapter
>

export function useParentPageController(options: ParentControllerAdapterOptions) {
    const adapter = shallowRef<ParentAdapter | null>(null)
    const connected = ref(false)
    const error = ref<unknown>(null)
    let disposed = false

    const connect = async () => {
        if (disposed) return false
        error.value = null
        try {
            const { ParentPageControllerAdapter } = await import(
                '@page-agent/page-controller/parent-bridge/adapter'
            )
            if (disposed) return false
            const instance = new ParentPageControllerAdapter(options)
            adapter.value = instance
            await instance.connect()
            if (disposed) {
                instance.dispose()
                return false
            }
            connected.value = true
            return true
        } catch (cause) {
            connected.value = false
            error.value = cause
            throw cause
        }
    }

    onMounted(() => {
        void connect()
    })
    onBeforeUnmount(() => {
        disposed = true
        adapter.value?.dispose()
        adapter.value = null
        connected.value = false
    })

    return { adapter, connected, error, connect }
}
```

Use an `AbortController` in the composable if a route change should cancel an
in-flight `connect()` or action. Never keep an adapter alive after its iframe is
removed.

Keep the assistant's history presentation-safe. The default configuration is
appropriate for production; if the assistant creates its own `AgentConfig`,
leave both sensitive-data opt-ins disabled and map only fields intended for the
Vue view:

```ts
const agentConfig = {
    debug: false,
    includeRawHistory: false,
}
```

Do not bind raw request/response objects, page-derived text, or authorization
metadata directly to a reactive history component.

When the assistant also owns a `PageAgentCore`, keep the controller and agent
lifecycle ordered. Stop first so in-flight work settles, then dispose the
agent (which disposes its controller):

The default deployment keeps the Vue assistant iframe and its Tl backend on the
exact same origin. Tl therefore uses the browser's native `fetch`; leave
`customFetch` unset. Keep `endpointAgent` as an absolute same-origin URL so a
deployment cannot accidentally redirect requests to another origin:

```ts
import { PageAgentCore } from '@page-agent/core'

const parentController = adapter.value
if (!parentController) throw new Error('Parent controller is not connected')

const agent = new PageAgentCore({
    pageController: parentController,
    provider: 'tl',
    endpointAgent: new URL('/api/tl', window.location.origin).toString(),
    model: 'assistant-model',
    toolCallingMode: 'system_prompt',
    tlSystemPromptVariableName: 'system_prompt',
    experimentalScriptExecutionTool: false,
    experimentalLlmsTxt: false,
    debug: false,
    includeRawHistory: false,
})

onBeforeUnmount(async () => {
    await agent.stop()
    agent.dispose()
})
```

`agent.dispose()` owns `adapter.dispose()` through the controller contract, so
do not keep using either object after this teardown.

## Optional authenticated Tl gateway fetch

The default same-origin Tl integration above uses native `fetch` and does not
need a custom fetch implementation. Use the framework-agnostic helper in
[`examples/parent-bridge/authenticated-tl-fetch.ts`](../examples/parent-bridge/authenticated-tl-fetch.ts)
only when an otherwise same-origin API explicitly requires bearer,
tenant/target/session headers, token refresh, or other request customization. It
is an example-only, test-injectable `customFetch` implementation:

```ts
import { TlAiClient } from '@page-agent/llms'
import { createAuthenticatedFetch } from '../examples/parent-bridge/authenticated-tl-fetch'

const customFetch = createAuthenticatedFetch({
    token: ({ signal }) => authStore.getAccessToken({ signal }),
    refreshToken: async ({ signal, reason }) => authStore.refreshAccessToken({ signal, reason }),
    refreshSkewMs: 30_000,
    headers: () => ({
        'X-Tenant-Id': tenantId,
        'X-Target-Id': targetId,
        'X-Page-Agent-Session': sessionId,
    }),
})

const client = new TlAiClient({
    endpointAgent: new URL('/api/tl', window.location.origin).toString(),
    model: 'assistant-model',
    customFetch,
})
```

The helper returns responses unchanged: callers can use `response.json()` for
JSON endpoints or consume `response.body` as an SSE stream. A token provider
may return `{ value, expiresAt }`; a token inside `refreshSkewMs` (30 seconds by
default) is refreshed before the first request, while a 401 still triggers at
most one replay. It propagates the caller `AbortSignal`, injects only a Bearer
header, and accepts injectable tenant/target/session headers. Inject a fake
`fetchImpl` in tests; do not put browser tokens in the parent-host IIFE or in
iframe URLs. The helper is optional and does not change the requirement that
`endpointAgent` be an absolute same-origin URL in this deployment.

## Deployment and security checklist

-   Use HTTPS on public or untrusted networks. Controlled private-network HTTP
    requires the explicit `allowInsecureHttp` opt-in. Use exact scheme/host/port
    origins; reject `*`, `null`, paths, query strings, and credentials in allow-lists.
-   The parent host validates `event.origin`, `event.source`, protocol version,
    session/frame IDs, challenge/nonce, payload schema, and capability before
    every request. The child performs the symmetric checks.
-   Set the child response's CSP `frame-ancestors` to the allowed parent
    origin(s). Set the parent CSP `frame-src` to the assistant origin and every
    explicitly authorized business iframe origin. A
    conflicting `X-Frame-Options` header blocks the bridge before JavaScript
    runs.
-   The host requires a cross-origin assistant iframe to carry a `sandbox`
    attribute with `allow-scripts allow-same-origin`; an unsandboxed iframe is
    rejected, and any additional sandbox capability is rejected. Do not treat
    that token pair as an isolation boundary for a same-origin iframe.
-   The parent host is a privileged DOM boundary. Scope it with `root`, keep a
    least-privilege capability list, and redact sensitive text/attributes
    before sending state to an assistant or LLM.
-   Scoped extraction removes `value`/`defaultValue`, password, one-time-code,
    token-named, and `data-page-agent-sensitive` content by default. Use
    `transformState` to redact any additional business text, labels, URLs, or
    identifiers before they cross the frame boundary.
-   A scoped root includes descendants only. The root itself is a synthetic
    boundary, nested iframe documents remain separate (especially when
    cross-origin), and portal/popover nodes rendered elsewhere in `document`
    are excluded. Mount a deliberate application root for controls that must
    be reachable; never silently widen to the whole document.
-   Host installation is optional. If no host is present, the adapter should
    time out or receive `EMBED_POLICY_DENIED`; degrade to assistant-local
    behavior and disable parent actions. Never fall back to direct DOM access
    or assume that same-origin access exists.
-   Treat bridge errors as state transitions, not retry hints: `ROOT_UNAVAILABLE`
    requires a fresh root or teardown, `STALE_TREE` requires re-observing before
    using an index, and `OUTCOME_UNKNOWN` means a mutating request may have
    happened—do not replay it. Reconnect only after a fresh offer/session and
    policy validation.
-   Do not enable `AgentConfig.debug`/`LLMConfig.debug` or
    `AgentConfig.includeRawHistory` in production. Debug logs and raw history
    may include request/response/SSE payloads, page-derived text, user input,
    and authorization metadata. A custom `failureLogger` also receives
    sensitive raw entries and must redact or protect them.
-   On iframe navigation, origin/policy change, root replacement, or unload,
    dispose the old host/adapter and reject old sessions. Never retry a
    mutating action after `OUTCOME_UNKNOWN` without re-observing the page.

### Recommended: PageAgent-managed one-time opaque tokens

When P (the parent), A (the PageAgent assistant), and B (a cooperative business
iframe) belong to one company or security domain, prefer a PageAgent-managed
authorization service that issues a one-use opaque token and redeems it online
from A's backend. The token is an unstructured high-entropy random value, not a
JWT. The service stores only its SHA-256 digest, short-lived claims, and expiry.
The full token reaches P through a same-origin HTTPS endpoint and is carried in
the existing bridge offer as `policy`. Never place it in an iframe URL, log,
localStorage, analytics event, or error message.

The responsibility split is deliberate:

-   P's backend authenticates its user and applies tenant/business ACLs before
    asking the PageAgent authorization service for `{ policy, claims }`.
    PageAgent cannot decide P's order, workflow, or user permissions.
-   P's frontend only calls that same-origin endpoint and wires the managed-auth
    helper's `getEmbedPolicy` and `verifyEmbedPolicy` into the Host. It does not
    hold a private key, implement JOSE, or maintain JWKS.
-   The authorization service generates at least 256 random bits, persists only
    the digest, and records `jti`, exact parent/assistant origins, scope,
    capabilities, protocol range, `nbf`/`exp`, tenant, user, target, and any
    approved `childFrames` grants.
-   A's `authorizeOffer` sends the token, the browser-observed parent origin,
    and the complete offer to A's same-origin backend. That backend atomically
    consumes the token, checks claims against `policyId`, origin, and
    capabilities, and binds `sessionId`, `challenge`, `frameInstanceId`, and
    `hostInstanceId` into a short-lived authorization context. Replay, expiry,
    tampering, and capability escalation fail closed.
-   B never sees the token. P brokers only the B targets present in verified
    claims and continues enforcing B's origin, capability, action-policy, and
    approval gates.

The PageAgent authorization service can use the reusable issuer/exchange entry
directly. The in-memory store below demonstrates the API only:

```ts
import {
    InMemoryOpaqueEmbedAuthorizationStore,
    OpaqueEmbedAuthorizationService,
} from '@page-agent/page-controller/parent-bridge/managed-auth'

const authority = new OpaqueEmbedAuthorizationService({
    store: new InMemoryOpaqueEmbedAuthorizationStore(), // replace in production
    assistantOrigin: 'https://assistant.example.com',
    allowedParentOrigins: ['https://p.example.com'],
    scopeId: 'checkout',
    allowedCapabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup'],
    ttlSeconds: 120,
})

// P's same-origin POST route: authenticate and apply P's ACL first.
const grant = await authority.issue({
    tenant: currentTenant.id,
    user: currentUser.id,
    targetId: checkout.id,
    scopeId: 'checkout',
    parentOrigin: 'https://p.example.com',
    assistantOrigin: 'https://assistant.example.com',
    capabilities: ['observe', 'click', 'input', 'select', 'scroll', 'cleanup'],
})
// Return JSON `{ policy, claims }` with Cache-Control: no-store.

// A's same-origin POST route receives the browser-observed origin and full offer.
const authorizationContext = await authority.exchange({ policy, actualParentOrigin, offer })
```

A's `authorizeOffer` frontend maps only the returned context into
`AuthorizedParent` and rechecks exact policy ID, parent/assistant origins,
session, challenge, frame/host instances, and capabilities. HTTP 200 alone is
not sufficient binding.

P therefore needs only a small same-origin backend route and frontend wiring.
Production token storage must use Redis, a transactional database, or an
equivalent shared store with atomic get-and-delete/compare-and-delete semantics.
The library's in-memory store is for single-process development/tests only and
does not prevent replay across replicas. Return `Cache-Control: no-store`, use
HTTPS plus controlled CORS/CSRF, cap request sizes, and do not expose raw
authorization context to the LLM or UI.

This scheme authorizes a temporary, precisely scoped delegation from P to A and
limits replay after token theft. It does not replace P login, business ACLs, XSS
defenses, CSP/sandbox, bridge origin/source validation, or approval for
sensitive actions. Script execution already trusted by P remains inside the
trust boundary, so Host roots, capabilities, and `actionPolicy` must still be
minimal.

### Comparison with ES256/JWKS and upgrade path

| Dimension      | One-time opaque token (current recommendation)             | ES256/JWKS (cross-system upgrade)                                         |
| -------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| Trust model    | P/A/B share a company and online authorization service     | P/A belong to independent systems or organizations                        |
| P integration  | Same-origin route + managed-auth helper; no cryptography   | JWT/JWS verification, issuer/audience, JWKS cache/rotation                |
| A verification | Online redemption with atomic consume per handshake        | Local signature verification; shared `jti` store still recommended        |
| Revocation     | Server record can be rejected immediately                  | Issued tokens usually survive until expiry; use short TTL/revocation      |
| Availability   | Depends on the service and shared store                    | Can verify offline with cached JWKS; scales across regions                |
| Key operations | No asymmetric distribution; protect store/service identity | Protect private keys, publish JWKS, constrain algorithms and rotate `kid` |
| Token contents | Opaque; still a bearer secret if leaked                    | Claims are readable and signed; still a bearer secret if leaked           |
| Audit          | Issue and redemption naturally pass through one service    | Correlate issuer and verifier logs by `jti`                               |

An ES256/JWKS migration keeps the Host/Adapter protocol, claims schema, exact
origin/capability checks, and `authorizeOffer` contract. Replace only the issuer
and verifier: P's backend issues a short-lived ES256 JWS, and P/A verify a pinned
issuer/audience through HTTPS JWKS. Reject `alg=none`, algorithm confusion,
unknown `kid`, and oversized key sets. If strict one-use authorization remains a
requirement, atomically consume `jti` in Redis/a database after signature
verification: a signature does not prevent replay. During migration, route by
an explicit version or issuer rather than accepting an ambiguous arbitrary
token, and set an observable retirement date for the opaque path.

### Versioned IIFE deployment and CSS

Pin a concrete package/version or content-addressed asset. Do not deploy
`latest`. The parent host IIFE intentionally imports the external
`page-agent-parent-host.css`; load both assets from the same pinned release and
protect them with SRI (replace placeholders with release-generated hashes):

```html
<link
    rel="stylesheet"
    href="/assets/page-agent-parent-host/1.12.2/page-agent-parent-host.css"
    integrity="sha384-RELEASE_GENERATED_CSS_HASH"
    crossorigin="anonymous"
/>
<script
    src="/assets/page-agent-parent-host/1.12.2/page-agent-parent-host.iife.min.js"
    integrity="sha384-RELEASE_GENERATED_JS_HASH"
    crossorigin="anonymous"
></script>
```

The status and cursor elements are presentation-only and always use
`pointer-events: none`; do not replace them with a blocking overlay or inject
style tags from JavaScript. The external host stylesheet is required for both
the badge and cursor.

For browser background, see the [same-origin policy](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Same-origin_policy),
[`postMessage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage),
[`sandbox`](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox),
and CSP [`frame-ancestors`](https://www.w3.org/TR/CSP/#directive-frame-ancestors)
references. For release asset pinning, see MDN's
[Subresource Integrity](https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity)
guide.
