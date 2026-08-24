# Parent bridge minimal example

This directory contains example-only integration code. It is not a package and
does not add Vue or an authentication dependency to the repository.

-   `parent-host.ts` and `child-adapter.ts` are tiny ESM bootstraps that keep
    lifecycle/error handling in application code while deriving option types
    from the installed runtime.
-   `use-parent-controller.ts` is an optional Vue 3 composable; Vue remains an
    application dependency and is not added to Page Agent.
-   `use-page-agent.ts` is a fuller Vue 3 example: it wires `PageAgentCore` to
    the parent adapter, the assistant origin's same-origin Tl endpoint via
    native `fetch`, status/history/activity state, `ask_user` and one-use
    approval state, and an explicit host-unavailable degraded mode. Runtime
    modules are loaded from `onMounted` for SSR safety; its teardown awaits
    `agent.stop()` before `agent.dispose()`. It fails fast unless the child
    requests both `observe` and `cleanup`; the Host, signed Policy, and
    `authorizeOffer` result must preserve the same capabilities so final DOM
    highlights can be removed.
-   `authenticated-tl-fetch.ts` is an optional, framework-agnostic
    `TlAiClient.customFetch` helper for deployments that require explicit
    bearer/tenant/target/session headers, token refresh, or other request
    customization. The default same-origin integration does not use it; the
    helper has injectable `fetchImpl`, one 401 retry, and abort propagation, and
    returns JSON and SSE responses unchanged.
-   Run `npm run test:parent-bridge-example` for the helper's JSON, SSE, auth,
    refresh, and abort tests. `npm run typecheck:parent-bridge-example` checks
    the non-Vue example sources without adding Vue to this repository.
-   To run the reverse parent-bridge fixture, use `npm run demo:parent-bridge`
    from the repository root. The command builds the PageAgent IIFE and starts
    the two parent origins (`127.0.0.1:4173` and `127.0.0.1:4175`), the shared
    assistant iframe origin (`127.0.0.1:4174`), and the cooperative business
    iframe origin (`127.0.0.1:4176`). After an existing build,
    run the server-only workspace command:

        npm run demo:parent-bridge --workspace=@page-agent/e2e

    Open either URL while the server is running:

    -   `http://127.0.0.1:4173/reverse-parent.html`
    -   `http://127.0.0.1:4175/reverse-parent.html`

    The parent is a realistic operations dashboard, while the assistant is a
    fixed right-side panel approximately `25vw × 80vh`. In the assistant iframe,
    **Run PageAgent** submits the fixed task (click the parent button, enter
    `PageAgent Demo`, and select `Pro`); the low-level
    observe/click/input/select/scroll/JavaScript controls remain available. The
    state includes an explicitly signed business iframe so the fixture also
    demonstrates assistant → parent broker → business iframe observation,
    actions, approval, denial, and reload invalidation. An unconfigured sibling
    iframe is never exposed. The
    parent shows a root-bounded, non-blocking cursor with click ripple while
    actions run; it never covers the assistant iframe. Its `main`-compatible
    PageAgent arrow can be branded through the `--page-agent-parent-cursor-*`
    variables documented in `docs/parent-bridge.md`. The browser calls
    `127.0.0.1:4174/api/tl` with native `fetch`, no `customFetch`, and no CORS.
    The fixture server reverse-proxies that path to
    `TL_ENDPOINT_AGENT`, defaulting to `http://localhost:8089`. Set
    `PARENT_BRIDGE_DEMO_MOCK_TL=1` only for the deterministic offline/test
    response sequence.

-   See [`docs/parent-bridge.md`](../../docs/parent-bridge.md) for the parent
    host, child adapter, Vue 3 composable, CSP, sandbox, and policy examples.
