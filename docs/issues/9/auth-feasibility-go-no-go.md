# Issue #9 Slice 0 — standalone host-auth feasibility evidence

Date: 2026-08-27  
Bead: `bm-qz3`  
Evidence classification: synthetic/redacted; no mailbox database, source, account, message, or credential was read.

## Candidate verdict

**GO candidate for independent review.** The spike demonstrates that the pinned Vite topology can authenticate the complete owner surface before asset middleware and the `/api/v1` proxy, and can wrap Vite's HMR upgrade listeners so an unauthenticated websocket cannot reach them. The final GO verdict remains with the parent after independent security and thermonuclear review.

A production mode was intentionally not enabled. `app/vite.config.ts`, the standalone backend, the Boring Mail server plugin, MailStore, and React mail components are unchanged.

## Demonstrated topology

The synthetic tests start an actual loopback Vite server and a separate loopback backend. The pre-plugin:

1. validates an explicit bind IP, matching HMR host and exact origin;
2. requires explicit trust for tailnet HTTP and an exact online current `Self.TailscaleIPs` match from bounded status JSON;
3. rejects non-regular paths before open, then descriptor-opens with `O_NOFOLLOW|O_NONBLOCK` and requires a canonical, current-euid, one-link, regular exact-`0600` token file with no special bits and at most 256 bytes;
4. requires one whitespace-free canonical base64url token decoding to at least 32 bytes;
5. compares decoded credentials with `timingSafeEqual`;
6. consumes `Authorization`/`Proxy-Authorization`, removes spoofable Boring Mail proof/principal headers, and injects a fresh trusted proof only after successful authentication;
7. supplies one authoritative Vite server object plus a detached immutable topology snapshot; splits pre-auth HTTP middleware from a verified-last `enforce:'post'` finalizer; and reasserts resolved host/port/origin/CORS/canonical-`server.ws`/proxy values at resolution, server configuration entry, and after every earlier returned configure callback, rejecting later-plugin drift, a separate HMR server, and Vite's pre-auth CORS responder;
8. rejects unauthenticated `OPTIONS`, assets, and proxy requests with 401 before they reach Vite/backend; and
9. captures Vite's registered upgrade listeners and delegates to them only after authentication, while early disposal remains fail-closed.

The Playwright scenario independently proves browser HTTP credentials can load the page and proxied API while establishing an authenticated Vite HMR client. Its unauthenticated browser reaches neither the proxy backend nor HMR.

## Automated verification

| Command | Result | Redacted result |
|---|---|---|
| `pnpm --filter @hachej/boring-mail-playground test` | PASS | 1 file, 14 tests; actual Vite OPTIONS/asset/proxy/raw-HMR matrix, disposal denial, descriptor/special-file, resolved-topology, and late-plugin-mutation refusals |
| `pnpm --filter @hachej/boring-mail-playground test:e2e` | PASS | 2 Playwright browser scenarios; authenticated page/proxy/HMR and unauthenticated rejection |
| `pnpm test` | PASS | plugin 14 files / 120 tests; app 1 file / 14 tests |
| `pnpm typecheck` | PASS | plugin and app TypeScript projects |
| `pnpm check-env` | PASS | supported Node/SQLite/flock and pinned host checks |
| `pnpm build` | PASS | emitted worker smoke and production playground build; existing chunk-size warning only |
| `pnpm smoke:msgvault-required` | PASS | exact installed v0.19.3 synthetic direct-worker outcomes; no daemon survived and redirect was refused |
| required-smoke Vitest disappearance/missing cases | PASS | required mode fails if absent or removed immediately after its single version attestation; optional mode alone may skip |
| `pnpm install --frozen-lockfile` | PASS | intended dependency graph only; unrelated provider snapshot edges preserved |

## Review disposition

The first independent Sol xhigh review found six material gaps: early-disposal fail-open, caller/actual-Vite config drift, blocking special-file open/special bits, pre-auth Vite CORS, weak Tailscale `Online` typing, and an optional race in the required msgvault wrapper plus unrelated lockfile peer churn. The next pass found a shared-object/canonical-`server.ws` drift bypass and a canonical proof-script naming mismatch. A third pass found that concurrent/later ordinary plugin hooks could mutate topology after the first assertion. A fourth pass found that a later returned configure callback could run after the pre-plugin's returned callback. All were fixed with a verified-last post finalizer and negative returned-callback/listener tests or an exact script alias before the final gates. No finding was waived.

## Artifact policy

Playwright config disables screenshots, traces, and video. Its output directory is outside the repository. No screenshot, trace, HAR, video, DOM snapshot, reporter HTML, credential, public host/IP, or live mail field is retained by this proof.

## Residual boundary

This is a feasibility spike, not production authentication. Slice 1 must integrate the approved mechanism into deployment configuration, prove the pinned host contract and exact configured owner origin, and retain the same fail-closed boot invariants. Any material review finding or inability to preserve the demonstrated ordering changes this verdict to NO-GO and leaves downstream Beads deferred.
