# Boring Mail — Locked Decisions Registry

Modelled on `boring-ui-v2/docs/DECISIONS.md`. Four fields per entry:
**What / Why / Rationale / Re-evaluate when.**

> **Rule: any PR that changes a locked decision must update this document.**

These decisions are recorded here rather than only in
`docs/plans/boring-mail-real-gmail-multi-account-plan.md`, because that plan is
an explicitly non-steady-state document that has already been revised four times
and expects further revision. Decisions that must outlive the plan live here.

Status legend: **LOCKED** (decided) · **PROPOSED** (recommended, awaiting owner
gate) · **SUPERSEDED**.

---

## D1 — Plugin API surface: WorkspaceBridge operations, not Fastify routes — **PROPOSED**

**What.** State-changing API moves to `workspaceBridgeHandlers` as
`boring-mail.v1.*` operations. `WorkspaceServerPlugin.routes` is used **only**
for bulk streaming reads (`GET /attachments/:id/content`) and as a lifecycle
hook, exactly as `ask-user` does.

**Why.** The host registers plugin `routes` with **no authentication, no CSRF,
no origin check** (`createWorkspaceAgentServer.ts:2162-2164`), while the bridge
receives `browserAuthPolicy`, an origin allow-list, `x-csrf-token` proof,
caller-class separation (`browser`/`runtime`/`server`), capability checks, and an
idempotency store (`:2136`, `workspaceBridge/authPolicy.ts`). The plan specified
~30 routes on the unprotected surface — including `POST /accounts/connect/start`,
which carries the **OAuth client secret in a request body**.

**Rationale.** This deletes most of the plan's cross-cutting route chapter rather
than implementing it, and makes "agent tools never receive a browser session or a
send-approval capability" a *host guarantee* instead of a plugin convention. The
reference plugin registers zero HTTP routes and throws on the legacy path
(`askUserServerPlugin.ts:22-24`). Envelope constraints: op name
`^[a-z][a-z0-9-]*\.v[1-9][0-9]*\.[a-z][a-z0-9.-]*$`, default `timeoutMs` 5000,
default `maxInputBytes` 64 KB, **required** `maxOutputBytes`, JSON-serializable
responses, first-class `idempotencyPolicy` — which is why attachment streaming
must stay on `routes`, and which lets `idempotencyPolicy: "required"` replace
part of the hand-rolled outbox machinery.

**Re-evaluate when.** The host adds an auth wrapper for `routes`, or a streaming
need appears that the bridge envelope cannot carry.

---

## D2 — Plugin tier: Tier A internal app-package plugin with `trust: "internal"` — **PROPOSED**

**What.** Ship as an internal app-package plugin composed into the app shell,
not as a Tier C external plugin under `.pi/extensions`.

**Why.** `assertWorkspaceBridgeHandlersTrusted` (`app/server/pluginEntryResolver.ts`)
permits `workspaceBridgeHandlers` **only** for `trust: "internal"` entries.
Tier C (`runtimeBackend/`, loads only `source.kind === "external"`) gets hot
reload and a workspace-scoped gateway but permanently forecloses the bridge.

**Rationale.** It is what the repo already does — `app/src/server/dev.ts:52,54`
sets `externalPlugins: false` and passes boring-mail in `plugins: [...]`, i.e.
Tier A already, undeclared. It is the only tier where D1 is possible. Accepted
cost: server `routes` and `agentTools` are **boot-time only**
(`requiresRestart: ["routes","agentTools"]`), so every server change is a full
process restart — which is why D6's file-based unlock is required to make it
tolerable. This one decision fixes the API surface, the auth model, the
distribution shape, and the dev loop simultaneously.

**Re-evaluate when.** The host authenticates `routes`, or external plugins gain
bridge-handler capability.

---

## D3 — The send-approval capability is issued only by Boring Mail; `ask-user` is notification-only — **PROPOSED**

**What.** `ApprovalBanner` in-plugin is the **sole** capability issuer.
`ask-user` raises an item that says "N messages awaiting approval" and carries a
`boring-mail.thread` surface reference — **and no authority**.

**Why.** `ask-user`'s answer token is persisted **in plaintext in the
agent-writable workspace**: `app/.playground/.boring/ask-user.json` currently
contains a live `"answerToken": "U9HU5QRHvbcwBjZNJrmuQq8empCNDjymKaT775nOMN4"`
(`askUserServerPlugin.ts:70-73`), and the host serves
`GET /api/v1/files?path=` on the same origin.

**Rationale.** Boring Mail moved its entire datastore out of the workspace on the
principle that *a security control stored inside the thing it is protecting
against is not a control*. Routing send approval through `ask-user` puts the
approval credential straight back there, silently reversing the rationale for the
project's largest structural change at its most consequential feature. Pair with
the host's `WorkspaceAttention` badges and
`WorkspaceShellCapabilities.openInboxItem`, which carry no authority by
construction.

**Re-evaluate when.** The host offers a capability store outside the workspace
filesystem.

---

## D4 — Read + send only; provider state is read-only and authoritative — **LOCKED**

**What.** `gmail.readonly` + `gmail.send`. No `gmail.modify`. Provider state
(unread, starred, mailbox) is a read-only mirror; Boring Mail's tags/triage/pin
are a **separate additive overlay**. The two are never merged into one field.
There is **no mark-as-read control and no star toggle** — absent, not disabled.

**Why.** Owner decision, 2026-08-21. In Gmail, unread and starred are labels; a
read-only grant cannot write them. Marking read locally would diverge silently
and the thread would pop back to bold on the next sync.

**Rationale.** Rather than fake write-back, give the user real local concepts
(triage, pin) with no Gmail counterpart, and say so plainly in the UI.

**Re-evaluate when.** The owner accepts `gmail.modify`'s scope and verification
consequences. The upgrade path is already shaped: `mail_thread_local_state` gains
`pending_provider_ops_json` and a reconciling queue; nothing is reshaped.

> This is the decision most likely to be "helpfully" reverted by a future
> contributor adding a star toggle. It carries a dedicated acceptance test for
> exactly that reason.

---

## D5 — Bring-your-own OAuth client; ship no client id and no client secret — **LOCKED**

**What.** Each user creates their own Google Cloud project and Desktop-app OAuth
client and pastes the credentials.

**Why.** `gmail.readonly` is a **Restricted** scope. A shipped client id makes
Boring Mail *the* app whose verification status gates every user's access, and
pools quota and abuse blast radius.

**Rationale.** BYO keeps each user in their own project, in Testing status, as
their own test user — under Google's development/testing and personal-use
(<100 users) verification exemption. Accepted cost: ~5 minutes of one-time setup,
paid visibly in the UX rather than hidden.

**Re-evaluate when.** The distribution model changes — at which point the
verification-posture question reopens. Note the agent path (mail transiting a
hosted model API) is arguably "restricted data through a third-party server", so
"just move to Production" is **not** a casual escape hatch.

---

## D6 — Token store: OS keyring primary, passphrase-**file** unlock as a first-class deployment shape — **PROPOSED**

**What.** `@napi-rs/keyring` where available; otherwise an AES-256-GCM file
unlocked by a passphrase read from a `0600` **file path** (never an env var
carrying the secret), refusing to start on wrong mode. CI generates an ephemeral
passphrase per run.

**Why.** Verified 2026-08-22: this machine has **no Secret Service** — no
`gnome-keyring-daemon`, no `secret-tool`, no `libsecret`, nothing on the user
D-Bus, `DISPLAY` unset. So the encrypted file is the *primary* here, not a
fallback. Compounding: the server boots inside Vite's `configureServer` with no
TTY, and D2 means every server change is a full restart — an interactive-only
passphrase re-locks the store every time.

**Rationale.** Preserves the real prohibitions (no compiled-in key, no
shell-history exposure, no plaintext fallback, **no documented test passphrase**)
while making the backend usable, and gives the fault-injection matrix's restart
assertions a seam to inject through.

**Re-evaluate when.** The deployment target gains a Secret Service, or the host
gains a credential store.

---

## D7 — OAuth topology: paste-the-code is primary; loopback is an auto-detected convenience — **PROPOSED**

**What.** Both flows exist; paste-code is the always-available primary. PKCE,
`state` (length check **then** `timingSafeEqual`), one-shot, 5-minute deadline on
both. The paste flow is **not** OOB (`urn:ietf:wg:oauth:2.0:oob`), which has been
hard-blocked since 2023-01-31; it keeps the loopback `redirect_uri` and has the
user copy `code`+`state` from the failed page's URL bar.

**Why.** Loopback cannot complete in the only configured topology: `vite --host
0.0.0.0`, `hmr.host` defaulting to a **Tailscale address** (the browser is on a
different machine), Fastify on `127.0.0.1`. The browser's redirect to
`127.0.0.1` lands on the *viewer's* machine.

**Rationale.** Loopback itself is confirmed alive and Google-recommended
(deprecation was mobile-only). This is a topology decision, not a deprecation
one. Building paste-code second guarantees it becomes the less-tested of the two
while being the one this deployment actually needs.

**Re-evaluate when.** The primary deployment becomes same-machine desktop.

---

## D8 — Storage: `node:sqlite` in one lock-owning storage process; `MailStore` is a driver-agnostic async RPC facade — **LOCKED, amended during bm-8ae review**

**What.** One storage process per canonical data directory, one `DatabaseSync`
connection, all writes serialised. `MailStore` on the host thread is a typed
async RPC facade. The process inherits and exclusively locks both the canonical
data-directory inode and product-database inode before opening SQLite. IPC uses
Node's advanced V8 serialization so omitted optional arguments remain
`undefined` rather than becoming JSON `null`.

**Why.** `DatabaseSync` is synchronous; on the Fastify thread a large ingest, an
FTS `MATCH`, a migration, or a rebuild freezes every route, both syncs, and the
agent tool. `better-sqlite3` does **not** fix this — it is synchronous too. The
fix is *where* the store runs.

**Rationale.** `node:sqlite` avoids a native build step in a plugin meant to be
`npm install`-able. Verified: unflagged on Node 22.22.1, SQLite 3.51.2, FTS5 and
JSON1 present. The original worker-thread topology was replaced after review
proved that an external lock helper could lose its kernel lock while a
non-interruptible synchronous SQLite call continued. Executing SQLite in the
same process that retains the inherited flock descriptors makes owner death and
lock release one OS lifetime. Request deadlines therefore fail-stop that whole
process rather than pretending to cancel one statement.

**Known limits.** Process IPC still deserialises results on the receiving thread;
large result sets must remain bounded. There is no `sqlite3_interrupt` in
`node:sqlite`, so a single long statement cannot be cancelled in place;
`'rebuild'`, `VACUUM`, `PRAGMA optimize`, and snapshot sweeps need explicit
maintenance mode or chunking where available.

**Re-evaluate when.** `node:sqlite` stabilises, or a **measured** need for a
second read-only connection appears.

---

## D9 — Mail datastore lives in the OS user data directory, not the workspace — **LOCKED, with a corrected rationale**

**What.** `<OS user data dir>/boring-mail/<profile>/` holds `mail.db`, blobs,
quarantine, and the token file. `<workspaceRoot>/.boring/mail/` holds only
non-secret workspace projection state.

**Why.** An agent with workspace filesystem access could otherwise read `mail.db`
directly (bypassing `agent_readable`) and write `mail_outbox.status` (forging an
approval). It also stops per-workspace duplicate mailboxes.

**Rationale — corrected in round 4.** This removes the **workspace-scoped**
agent's access. It does **not** constrain an agent with general same-user
filesystem access: `0600` under the same UID is not a boundary, and both operands
of the approval digest check live in that same writable row. The datastore
location is **defence in depth, not the control**. The control is that the
plaintext capability never touches disk (D3).

**Re-evaluate when.** The agent boundary becomes OS- or process-enforced.

---

## D10 — `agent_readable` defaults to **0 (off)** — **PROPOSED**

**What.** New accounts do not expose bodies to any agent until the user makes an
explicit per-account choice.

**Why.** Consent to *connect an account* is not consent to *pipe it into an
agent* — which, per D11, may hold shell and network tools.

**Rationale.** Reverses draft 1, which defaulted to on so the product would work
out of the box. Two independent reviewers rejected that, and they are right:
shipping the agent surface before the boundary is known means shipping a control
you cannot describe honestly. Genuinely hard to reverse once users are onboarded.

**Re-evaluate when.** D11 resolves to a real isolation mechanism.

---

## D11 — Prompt-injection containment is bounded, not solved, and `agentConfigContract` is **not** the mechanism — **LOCKED (correction)**

**What.** `agentConfigContract` is `{ keys: readonly string[] }` — a config-**key**
allow-list, fail-closed on omission. It does **not** constrain an agent's tools.

**Why this is recorded.** Draft 3 asserted it was "the hook that makes the
constrained-agent requirement implementable" and built the *first and strongest*
of nine injection mitigations on it. **Three independent review lanes confirmed
this is false** (`defineServerPlugin.ts:46-56`, validator `:326-335`, sole
consumer `fleetCompiler.ts` `validateConfigBinding:48-70`,
`PLUGIN_SYSTEM.md:245-252`).

**Rationale.** What the host *does* offer is weaker and adjacent: binding a
configured agent to a narrow `plugins:[...]` list scopes which **plugin-contributed**
tools it receives. Host/pi built-ins (shell, filesystem, network) are composed
globally via `baseExtraTools`/`basePi` and are not removable per-agent by any
exported mechanism. So the remaining eight mitigations are all data-shaping and
blast-radius reduction; **none is isolation**.

**Re-evaluate when.** The host exposes a per-agent tool allow-list.

---

## D12 — Exactly-once send is impossible; ambiguity terminates in `unknown` — **LOCKED**

**What.** One automatic provider attempt per approval. An ambiguous failure sets
`unknown` and **never** auto-retries; a retry requires a **fresh** approval on a
**new** outbox row.

**Why.** `messages.send` has no idempotency key, and SENT visibility lags, so
absence from a search is **not** evidence of non-delivery.

**Rationale — strengthened in round 4.** Reconciliation must **not** depend on
`rfc822msgid:`. Google publishes no guarantee that `messages.send` preserves a
client `Message-ID`, and production reports say Gmail substitutes its own and
demotes the original to `X-Google-Original-Message-ID`, which `rfc822msgid:` does
not match. That would convert a *successful* send into a confident duplicate.
Reconcile via `history.list` from a `pre_dispatch_history_id` captured in the
same committed transaction that enters `sending`.

**Re-evaluate when.** Google documents Message-ID preservation.

---

## D13 — Sender CSS is dropped entirely in v2 — **LOCKED**

**What.** All sender-provided `style` attributes are removed. No regex CSS
filtering.

**Why.** Regex checks for `url(` are not a CSS parser and miss escapes, comments,
and obfuscation.

**Rationale.** The fixed-height sandboxed opaque-origin frame already contains
layout attacks — a hostile `<table width=99999>` cannot overlay app chrome.
Accepted cost, named honestly: **hidden preheader text will now render**, so most
newsletters open with a duplicated out-of-context sentence. The sanitiser must
therefore still honour `display:none` / `visibility:hidden` / zero-size as a
**removal** signal before discarding the attribute.

**Re-evaluate when.** A real CSS sanitiser is selected and browser-level tests
exist.

---

## D14 — Message rendering: dedicated render origin, `'self'` images, no `allow-same-origin`, script-nonce auto-height — **PROPOSED (round-4 replacement)**

**What.** Serve the render document from a **dedicated loopback render origin**
at `/render/<token>`. `sandbox="allow-scripts allow-popups
allow-popups-to-escape-sandbox"` — **never `allow-same-origin`**. CSP as a real
**response header** (not `<meta>`): `default-src 'none'; script-src
'nonce-<per-render>'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors
<app origin>; sandbox ...; base-uri 'none'; form-action 'none'`. `cid:` images
become `/render/<token>/inline/<n>` on the render origin, authenticated by the
single-use token in the path (**not** cookies — an opaque-origin frame is
cross-site for `SameSite`, and localhost cookies ignore port).

**Why the previous design is dead.** Round 3 used `srcdoc` + parent-created
`blob:` URLs + `img-src blob:`. Blob URLs are partitioned by storage key; an
opaque origin is never same-origin with the parent's tuple origin, so
"obtain a blob object" fails and **every `cid:` image dies**. Chromium shipped
blob-URL partitioning targeting M132 explicitly to block this.

**Rationale.** The constraint that forced the `srcdoc` design was **false**: CSP
resolves `'self'` against the *policy's* self-origin (the response URL), not the
document's origin. A URL-loaded sandboxed frame has an opaque origin **and**
`'self'` still matches. `allow-scripts` is safe precisely *because*
`allow-same-origin` is absent, and a per-render nonce admits only our own
height-reporting script — recovering auto-height at no security cost, and
eliminating the `srcdoc` attribute-injection surface entirely.

**Re-evaluate when.** Never revert to `srcdoc`+blob without re-reading the File
API storage-key rules.

**Not contained by this layer, and must be said:** CSP has **no directive
governing a document navigating itself** (`navigate-to` was removed). A
`<meta http-equiv="refresh">` in a body beacons out regardless. The *only*
control is the sanitiser stripping `<meta>`, `<base>`, `<link>` — so the "two
independent layers" claim is **false for outbound navigation**, and the sanitiser
rule must never be relaxed on the grounds that the frame covers it.

---

## D15 — Cross-account correlation: keep per-account rows, add a **global** `rfc822_message_id` index — **PROPOSED**

**What.** Per-account rows and composite foreign keys stay exactly as designed.
Add one global (not account-scoped) index on `rfc822_message_id` plus a
`coalesced` flag in the unified list projection.

**Why.** Per-account isolation *guarantees* duplication: one message to two
connected accounts, or a list both are on, yields two `thr_` ids, two FTS
entries, two attention items — and the from-account rule makes reply identity
depend on which duplicate the user opened. `idx_messages_rfc822` is
`(account_id, rfc822_message_id)`, so the twin is not even findable.

**Rationale.** At three accounts this is the normal state of an inbox on day one.
One index and one query change now, versus a migration over 150k rows later.

**Re-evaluate when.** Single-account ships instead (see the v2 scope cut).

---

## D8 — Gmail sync backbone: adopt msgvault, do not build §11 — **RATIFIED 2026-08-23**

**What.** `wesm/msgvault` (MIT, Go single binary) is the Gmail→local sync
engine: OAuth API sync, History-API incrementals, resumable checkpoints,
SQLite system of record, SHA-256 content-addressed attachment store. Plan
§7/§11 are superseded pending spike `bm-a3l`; §12/§8 reduced to product-layer
projections.

**Why.** Owner call ("I trust the creator"). Deletes the largest
undifferentiated heavy lifting; architecture matches what §11 designed anyway
(historyId cursor + SQLite). Author: Wes McKinney (pandas/Arrow), dogfooded on
~2M emails.

**Rationale.** Send pipeline, drafts, approval workflow, cross-account
coalescing, and attention projection remain boring-mail code — that is the
product. `MailProvider` survives as the adapter seam (`MsgvaultProvider`).

**Re-evaluate when.** Spike report (`bm-a3l`) contradicts assumptions; msgvault
storage format churn breaks the adapter twice; or a provider appears that
msgvault does not speak.

**Companion owner decisions recorded on beads 2026-08-22:** paste-code OAuth
primary · agent = general agent + mail tool (no sandbox) · ask-user approves
sends with draft-as-artifact (plaintext-token risk accepted, upstream ask due)
· bridge-primary API surface · global rfc822 coalescing index · host-contract
tripwire yes · quota tripwire rejected.

---

## D9 — Send scope: separate `gmail.send` consent grant — **RATIFIED 2026-08-24**

**What.** Sending uses its own OAuth consent flow (boring-mail's paste-code
client), stored separately (Vault `boring-mail/send/<account>`). msgvault's
token stays read-scoped (`gmail.readonly`+`gmail.modify`); the two grants are
never shared.

**Why.** Least-privilege split: an archive/sync token compromise cannot send;
a send-token compromise cannot delete-stage. Owner ratified alongside spike
`bm-a3l` adoption.

**Re-evaluate when.** boring-ui BYOK lands a unified token surface, or Google
changes desktop-app verification requirements.

## Spike `bm-a3l` outcome — **ADOPT (SQLite-direct seam)**

Report: `docs/spikes/msgvault-adoption.md`. Verified v0.19.3 live: paste-code
OAuth; 2 000-msg/147 MB full sync at 19.8 msgs/s; SIGKILL resume-from-checkpoint
clean; 0.68 s incremental tick; `rfc822_message_id` on 100% of rows; SHA-256
attachment dedup. Plan §7/§11 superseded by msgvault; §12/§8 reduced to
projections. Follow-up beads cut: ADAPTER → PRODUCT-DB → COALESCE chain plus
SEND and SUPERVISOR lanes.
