# Issue #9 Slice 1 — standalone host-auth round-trip artifact

Date: 2026-08-28

Bead: `bm-h5y`

Evidence classification: synthetic/redacted. No live mailbox, live identity, token value, account identifier, subject, sender, snippet, body, recipient, attachment metadata, trace, HAR, video, screenshot, or DOM snapshot is recorded here.

## Implemented round trip

1. App-owned deployment configuration requires explicit `BORING_MAIL_DEPLOYMENT_MODE=live|fixture`, exact owner origin, exact bind IP, exact HMR host, an explicit owner token file, and backend pinned to `127.0.0.1`.
2. Live mode rejects fixture roots and requires explicit trusted tailnet HTTP with a bounded exact local Tailscale self-IP probe. HTTPS remains fail-closed/unmodeled.
3. Fixture mode requires an explicit existing system-temporary `BORING_MAIL_FIXTURE_ROOT`, loopback Vite/backend/HMR/origin, no Tailscale trust, and no `MSGVAULT_HOME`/`MSGVAULT_DB_PATH`/live archive path ambiguity. The fixture root becomes the workspace root and Boring Mail sync is passed as `false`.
4. The owner token is descriptor-opened from a canonical parent with no-follow semantics and refused unless it is present, current-euid, single-link, regular, exact-`0600`, <=256-byte, whitespace-free canonical base64url/UTF-8, and decodes to at least 32 bytes.
5. Vite installs the Boring Mail Basic-auth middleware as the first `configureServer` hook and the topology/HMR finalizer as the last hook; the finalizer freezes and reasserts the resolved plugin graph and server topology before wrapping HMR upgrades. The canonical app dev script is `vite`; a resolved `--host 0.0.0.0` override is refused.
6. Unauthenticated HTTP, proxy, and HMR upgrade requests receive `401` before Vite assets or the backend are reachable.
7. Authenticated requests have `Authorization`, `Proxy-Authorization`, and spoofable Boring Mail proof/principal headers stripped before proxying; only then does the middleware inject an in-process proof and owner principal for the loopback backend.
8. The WorkspaceBridge browser policy accepts only browser calls that carry the injected proof, exact owner origin, non-empty CSRF header, owner workspace `default`, and the app-preserved browser capabilities: `boring-mail:inbox:read`, `ask-user:answer`, `ask-user:cancel`, and `ask-user:pending`. It does not preserve `ask-user:request` or `ask-user:transcript.read`.
9. `dispose()` or Vite HTTP close deactivates browser bridge auth before secret buffers are cleared, so an all-zero proof cannot authenticate after shutdown.
10. The React app presents `workspaceId="default"`; product labels remain Boring Mail.

## Redacted verification summary

- Production auth/config tests cover explicit live/fixture discrimination, synthetic/live path ambiguity, descriptor token refusal cases including missing/oversized/malformed/noncanonical/invalid-UTF8/wrong-UID inputs, tailnet/HTTPS/backend/HMR/origin refusal, old `--host 0.0.0.0` override refusal, and exact proof/origin/CSRF/workspace/capability bridge policy behavior.
- A synthetic WorkspaceBridge HTTP integration test registers trusted handlers, proves an allowed Ask User browser capability round-trips through `POST /api/v1/workspace-bridge/call`, and proves an unpreserved Ask User transcript capability is denied.
- The Slice 0 spike tests are retained as compatibility coverage over real Vite HTTP/HMR/proxy ordering through the extracted production mechanism.
- Host-contract tests tripwire pinned `@hachej/boring-workspace@0.1.103` bridge route/auth helper shapes, pinned `@hachej/boring-ask-user@0.1.103` capability names, browser plugin provider props, and the safe app dev script.

## Artifact exclusions

No live app was started against a real mailbox. No owner token text, public host, Tailscale address, route body, response body containing mail data, or provider field is stored. This artifact is intentionally a redacted contract/evidence round-trip only.
