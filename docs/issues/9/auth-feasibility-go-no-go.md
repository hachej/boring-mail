# Issue #9 Slice 0 — standalone host-auth feasibility evidence

Date: 2026-08-27

Bead: `bm-qz3`

Evidence classification: synthetic/redacted; no mailbox database, source, account, message, or credential was read.

## Verdict

**GO.** The spike demonstrates that the pinned Vite topology can authenticate the complete owner surface before asset middleware and the `/api/v1` proxy, and can wrap Vite's HMR upgrade listeners so an unauthenticated websocket cannot reach them. Independent final correctness and Sol xhigh thermonuclear reviews returned CLEAN after every material finding was fixed. The parent recorded GO after all final gates passed at implementation head `f0c25106d22aef19b87241ffefa44674db88e060`.

A production mode was intentionally not enabled. `app/vite.config.ts`, the standalone backend, the Boring Mail server plugin, MailStore, and React mail components are unchanged.

## Demonstrated topology

The synthetic tests start an actual loopback Vite server and a separate loopback backend. The pre-plugin:

1. validates an explicit bind IP, matching HMR host and exact origin;
2. requires explicit trust for tailnet HTTP and an exact online current `Self.TailscaleIPs` match from bounded status JSON;
3. rejects non-regular paths before open, then descriptor-opens with `O_NOFOLLOW|O_NONBLOCK` and requires a canonical, current-euid, one-link, regular exact-`0600` token file with no special bits and at most 256 bytes;
4. requires one whitespace-free canonical base64url token decoding to at least 32 bytes;
5. compares decoded credentials with `timingSafeEqual`;
6. consumes `Authorization`/`Proxy-Authorization`, removes spoofable Boring Mail proof/principal headers, and injects a fresh trusted proof only after successful authentication;
7. supplies one authoritative Vite server object plus a detached immutable topology snapshot; proves the pre-auth plugin is the first configure hook and the finalizer is last across function/object hook orders; freezes the exact resolved plugin array against concurrent append/remove/reorder; and reasserts that array plus host/port/origin/CORS/disabled-HTTPS/canonical-`server.ws`/proxy values at server configuration entry and after every earlier returned configure callback, rejecting late resolver drift, a separate HMR server, and Vite's pre-auth CORS responder;
8. rejects unauthenticated `OPTIONS`, assets, and proxy requests with 401 before they reach Vite/backend; and
9. captures Vite's registered upgrade listeners and delegates to them only after authentication, while early disposal remains fail-closed.

The Playwright scenario independently proves browser HTTP credentials can load the page and proxied API while establishing an authenticated Vite HMR client. Its unauthenticated browser reaches neither the proxy backend nor HMR.

## Automated verification

| Command | Result | Redacted result |
|---|---|---|
| `pnpm --filter @hachej/boring-mail-playground test` | PASS | 1 file, 15 tests; actual Vite OPTIONS/asset/proxy/raw-HMR matrix, disposal denial, descriptor/special-file, HTTPS, resolved-topology, and function/object late-hook refusals |
| `pnpm --filter @hachej/boring-mail-playground test:e2e` | PASS | 2 Playwright browser scenarios; authenticated page/proxy/HMR and unauthenticated rejection |
| `pnpm test` | PASS | plugin 14 files / 120 tests; app 1 file / 15 tests |
| `pnpm typecheck` | PASS | plugin and app TypeScript projects |
| `pnpm check-env` | PASS | supported Node/SQLite/flock and pinned host checks |
| `pnpm build` | PASS | emitted worker smoke and production playground build; existing chunk-size warning only |
| `pnpm smoke:msgvault-required` | PASS | exact installed v0.19.3 synthetic direct-worker outcomes; no daemon survived and redirect was refused |
| required-smoke Vitest disappearance/missing cases | PASS | required mode fails if absent or removed immediately after its single version attestation; optional mode alone may skip |
| `pnpm install --frozen-lockfile` | PASS | intended dependency graph only; unrelated provider snapshot edges preserved |

## Review disposition

The first independent Sol xhigh review found six material gaps: early-disposal fail-open, caller/actual-Vite config drift, blocking special-file open/special bits, pre-auth Vite CORS, weak Tailscale `Online` typing, and an optional race in the required msgvault wrapper plus unrelated lockfile peer churn. Later passes found shared-object/canonical-`server.ws` drift, script naming, concurrent ordinary/returned/object-hook ordering, unmodeled/resolved HTTPS, and mutable plugin-list append issues. A seventh pass found finalizer removal and object `order:'pre'` insertion. All were fixed with first/last hook assertions, a frozen exact plugin array, repeated topology/order checks, explicit HTTPS rejection, negative returned-callback/listener/late-resolver append/remove/pre-hook tests, or an exact script alias before the final gates. No finding was waived.

## Artifact policy

Playwright config disables screenshots, traces, and video. Its output directory is outside the repository. No screenshot, trace, HAR, video, DOM snapshot, reporter HTML, credential, public host/IP, or live mail field is retained by this proof.

## Residual boundary

This is a tailnet-HTTP feasibility spike, not production authentication. It rejects HTTPS because TLS configuration is not yet modeled; Slice 1 must either integrate the approved tailnet mechanism into deployment configuration or separately model and attest TLS, prove the pinned host contract and exact configured owner origin, and retain the same fail-closed boot invariants. Any material review finding or inability to preserve the demonstrated ordering changes this verdict to NO-GO and leaves downstream Beads deferred.
