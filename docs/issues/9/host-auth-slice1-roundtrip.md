# Issue #9 Slice 1 — standalone host-auth round-trip artifact

Date: 2026-08-28

Bead: `bm-h5y`

Evidence classification: synthetic/redacted. No live mailbox, live identity, token value, account identifier, subject, sender, snippet, body, recipient, attachment metadata, trace, HAR, video, screenshot, or DOM snapshot is recorded here.

## Implemented round trip

1. App-owned deployment configuration requires explicit `BORING_MAIL_DEPLOYMENT_MODE=live|fixture`, exact owner origin, exact bind IP, exact HMR host, an explicit owner token file, and loopback backend origin.
2. The owner token is descriptor-opened from a canonical parent with no-follow semantics and refused unless it is a current-euid, single-link, regular, exact-`0600`, <=256-byte, whitespace-free canonical base64url value decoding to at least 32 bytes.
3. Vite installs the Boring Mail Basic-auth middleware as the first `configureServer` hook and the topology/HMR finalizer as the last hook; the finalizer freezes and reasserts the resolved plugin graph and server topology before wrapping HMR upgrades.
4. Unauthenticated HTTP, proxy, and HMR upgrade requests receive `401` before Vite assets or the backend are reachable.
5. Authenticated requests have `Authorization`, `Proxy-Authorization`, and spoofable Boring Mail proof/principal headers stripped before proxying; only then does the middleware inject an in-process proof and owner principal for the loopback backend.
6. The WorkspaceBridge browser policy accepts only browser calls that carry the injected proof, exact owner origin, non-empty CSRF header, owner workspace `default`, and the `boring-mail:inbox:read` capability.
7. The React app presents `workspaceId="default"`; product labels remain Boring Mail.

## Redacted verification summary

- Production auth/config tests cover explicit mode, synthetic/live path ambiguity, descriptor token refusal cases, tailnet/HTTPS/backend/HMR/origin refusal, and exact proof/origin/CSRF/workspace/capability bridge policy behavior.
- The Slice 0 spike tests are retained as compatibility coverage over real Vite HTTP/HMR/proxy ordering through the extracted production mechanism.
- Host-contract tests tripwire pinned `@hachej/boring-workspace@0.1.103` bridge route/auth helper shapes and browser plugin provider props.

## Artifact exclusions

No live app was started against a real mailbox. No owner token text or Tailscale address is stored. This artifact is intentionally a redacted contract/evidence round-trip only.
