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
2. requires explicit trust for tailnet HTTP and an exact current `Self.TailscaleIPs` match from bounded status JSON;
3. descriptor-opens a canonical, current-euid, one-link, regular `0600` token file of at most 256 bytes;
4. requires one whitespace-free canonical base64url token decoding to at least 32 bytes;
5. compares decoded credentials with `timingSafeEqual`;
6. consumes `Authorization`/`Proxy-Authorization`, removes spoofable Boring Mail proof/principal headers, and injects a fresh trusted proof only after successful authentication;
7. rejects unauthenticated assets and proxy requests with 401 before they reach Vite/backend; and
8. captures Vite's registered upgrade listeners and delegates to them only after authentication.

The Playwright scenario independently proves browser HTTP credentials can load the page and proxied API while establishing an authenticated Vite HMR client. Its unauthenticated browser reaches neither the proxy backend nor HMR.

## Automated verification

| Command | Result | Redacted result |
|---|---|---|
| `pnpm --filter @hachej/boring-mail-playground test` | PASS | 1 file, 11 tests; actual Vite asset/proxy/raw-HMR matrix plus descriptor/topology refusals |
| `pnpm --filter @hachej/boring-mail-playground test:e2e` | PASS | 2 Playwright browser scenarios; authenticated page/proxy/HMR and unauthenticated rejection |
| `pnpm test` | PASS | plugin 13 files / 118 tests; app 1 file / 11 tests |
| `pnpm typecheck` | PASS | plugin and app TypeScript projects |
| `pnpm check-env` | PASS | supported Node/SQLite/flock and pinned host checks |
| `pnpm build` | PASS | emitted worker smoke and production playground build; existing chunk-size warning only |
| `pnpm smoke:msgvault-required` | PASS | exact installed v0.19.3 synthetic direct-worker outcomes; no daemon survived and redirect was refused |
| `MSGVAULT_EXECUTABLE=/definitely/missing/msgvault pnpm smoke:msgvault-required` | EXPECTED FAIL | exit 1 with bounded missing-executable remediation, proving the required wrapper does not skip |

## Artifact policy

Playwright config disables screenshots, traces, and video. Its output directory is outside the repository. No screenshot, trace, HAR, video, DOM snapshot, reporter HTML, credential, public host/IP, or live mail field is retained by this proof.

## Residual boundary

This is a feasibility spike, not production authentication. Slice 1 must integrate the approved mechanism into deployment configuration, prove the pinned host contract and exact configured owner origin, and retain the same fail-closed boot invariants. Any material review finding or inability to preserve the demonstrated ordering changes this verdict to NO-GO and leaves downstream Beads deferred.
