# Boring Mail v2 — Real Gmail, Multi-Account, Read + Send

> Planning method: `/skill:plan` → Jeffrey Emanuel Planning Workflow
> (`boring-ui-v2/.agents/skill-references/plan/jeffrey-emanuel-planning-workflow/SKILL.md`,
> pinned skill version 6).
> Supersedes the scope of `docs/plans/boring-mail-chief-of-staff-workbench-plan.md`
> from Slice 2 onward. Slice 1 of that plan is **done** and is the starting point here.

---

## 0. Status Block

| Field | Value |
| --- | --- |
| Plan state | `revised-draft` — round 3, adversarial review folded, owner gate **passed 2026-08-22** (6 gates ratified, 1 parked on BYOK, 1 rejected); **Amendment A (2026-08-23): msgvault adopted as sync backbone, see §25** |
| Draft round | 3 (draft 1 → Grok 4.6 → GPT-5.6-sol xhigh → folded) |
| Owner | Julien Hurault (`julien.hurault@sumeo.io`) |
| Target repo | `hachej/boring-mail` (this workspace) |
| Deployment target | **Local single-user desktop** (owner decision, 2026-08-21) |
| Gmail scope | **Read + send only** — no provider-side label/archive/delete mutation (owner decision, 2026-08-21) |
| Accounts | **Multiple Gmail accounts, unified** (owner decision, 2026-08-21) |
| Blocking gate | Phase 0 (build) then Phase 1 (contract gates). No implementation past Phase 1 until §22 decisions are answered. |

### What the owner decided, and what this plan therefore may not do

1. **Read + send only.** May implement `gmail.readonly` + `gmail.send`. May
   **not** implement `gmail.modify`, label writes, or any delete scope.
   Everything downstream follows from that — see §9.
2. **Local single-user desktop.** Installed-app loopback OAuth. Tokens in the OS
   keyring. SQLite is the source of truth. No multi-tenant isolation.
3. **Multi-account.** A first-class axis through schema, sync, UI, agent tool,
   and surface targets — designed in from the first migration, not retrofitted.

### Round-3 revision summary

Two independent adversarial reviews (§23) found **nine defects that would have
shipped**. The largest, in order of how much damage they would have done:

1. **The history-404 recovery path would have silently hidden most of the
   mailbox.** Recovery was specified as "bootstrap-shaped" (30 days / 2,000
   messages) followed by soft-deleting everything not seen. On a 50k mailbox
   that marks ~48,000 messages deleted. Both reviewers found this. Replaced with
   generation-based mark-and-sweep that never deletes before a *complete*
   enumeration commits (§11.4).
2. **The FTS5 schema could not have been created.** External-content FTS5
   requires the content table to have columns of the declared names;
   `mail_messages` had `from_json`/`to_json`/`body_text`, the index declared
   `from_text`/`to_text`/`body`. Fixed, plus a stable `INTEGER PRIMARY KEY`
   because implicit rowids are reused after delete and shift under `VACUUM`
   (§7.3).
3. **The per-thread `threads.get` fetch strategy rested on data Gmail does not
   return.** `messages.list` returns only `{id, threadId}` — there is no message
   count — and `threads.get` returns the *entire* thread, so one recent reply on
   a 200-message mailing-list thread would pull all 200 and blow the bootstrap
   bound. Removed (§11.3).
4. **Gmail labels are per-message; the schema treated them as per-thread.**
   Removing `UNREAD` from one message would have marked a whole thread read —
   in the one area (§9) the plan spends a page insisting must not lie. Thread
   state is now recomputed by aggregation (§11.4).
5. **The sandboxed iframe was internally impossible.** No `allow-same-origin`
   *and* parent-measured height *and* `'self'` image loading cannot all hold.
   Redesigned to a fixed-height, blob-URL, no-script frame (§14.3).
6. **`DatabaseSync` is synchronous and was to run on the Fastify event loop.**
   Ingest and FTS work would freeze every route and the agent tool. Moved to a
   dedicated storage worker thread (§5.2, §7.1).
7. **The prompt-injection containment claim was computed on the wrong process.**
   Tool-level limits do not contain an agent that also has shell and network.
   The trust boundary is now stated explicitly, and the datastore moves out of
   the agent-writable workspace (§7.2, §14.1, §14.4).
8. **Re-auth could bind a different Google account to an existing `acct_` row**,
   merging two mailboxes. ID-token validation and `sub` binding added (§10.3).
9. **Ambiguous sends could duplicate mail.** "Not found after the next sync
   cycle → safe to retry" is false; SENT visibility lags. Replaced with a
   terminal `unknown` state that never auto-retries (§13.5).

One reviewer finding was **rejected on evidence**: both reviewers asserted the
Gmail quota constants are wrong. They are not — see §2.2, where the dispute is
recorded with the verification that settles it. Their *process* recommendation
was accepted anyway.

---

## 1. How To Use This Plan

Written to the Jeffrey Emanuel self-containment bar: **a fresh agent who has
never seen this repository should be able to open this file, pick a phase, and
implement it without asking a human a question.**

If you are that agent:

- Read §2 (Grounding) first. It contains verified facts that contradict things
  you probably believe about the Gmail API — including things two strong
  reviewing models believed. Do not skip it.
- Read §3 (Current State).
- Then go to your phase in §18. Each names: what it delivers, what blocks it,
  the files it touches, the proof command, and acceptance criteria.
- §19 is the dependency DAG. If your blockers are not merged, stop.
- **Phases 2+ are blocked on the §22 owner-gate decisions.** If they are still
  open, stop and escalate rather than guessing.

If a decision here is wrong, say so and get the plan revised. Do not silently
deviate: a plan agents quietly diverge from stops being a coordination artifact
after the first divergence.

---

## 2. Grounding — Verified Facts

Verified **2026-08-21** against primary sources or by executing code in this
repository's environment. Claims that could not be verified are marked
`UNVERIFIED` and must be re-checked before the phase that depends on them.

### 2.1 Environment (executed locally, 2026-08-21)

| Fact | Value | How verified |
| --- | --- | --- |
| Node | `v22.22.1` | `node -v` |
| pnpm | `11.22.0` | `pnpm -v` |
| `node:sqlite` importable **without** a flag | yes (emits `ExperimentalWarning`) | `node -e "require('node:sqlite')"` |
| Bundled SQLite version | `3.51.2` | `select sqlite_version()` |
| FTS5 available | **yes** | `CREATE VIRTUAL TABLE t USING fts5(body)` + `MATCH` returned rows |
| JSON1 available | **yes** | `json('{"a":1}')` succeeded |
| `node:sqlite` exports | `DatabaseSync`, `StatementSync`, `constants`, `backup` | `Object.keys(require('node:sqlite'))` |

**Consequence:** `better-sqlite3` is not needed, removing a native build step.
**But** `DatabaseSync` is synchronous — see §7.1, which is now a decision about
*where the store runs*, not only which library it uses.

### 2.2 Gmail API — verified against developers.google.com, 2026-08-21

#### Scopes (`/workspace/gmail/api/auth/scopes`)

| Scope | Grants | Classification |
| --- | --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | View messages and settings | **Restricted** |
| `https://www.googleapis.com/auth/gmail.send` | Send mail on the user's behalf | **Sensitive** |
| `https://www.googleapis.com/auth/gmail.modify` | Read, compose, send; no permanent delete | Restricted |
| `https://www.googleapis.com/auth/gmail.metadata` | Labels and headers, **no body** | Restricted |
| `https://www.googleapis.com/auth/gmail.compose` | Manage drafts and send | Restricted |

Two consequences:

1. `gmail.readonly` is **Restricted**. There is no body-reading Gmail scope
   below that tier (`gmail.metadata` is also Restricted and cannot read bodies).
   A publicly distributed Boring Mail using it requires Google OAuth
   verification for restricted scopes.
2. `gmail.send` being merely *Sensitive* does not raise the tier further.

**Softened after review.** Draft 1 stated flatly that a published Boring Mail
"would need ... a CASA security assessment", presented as settled fact. Whether
an additional security assessment applies depends on app type, publishing
status, user type, and data-handling model, and Google's policy changes.
**Rule: re-check and record the current policy text and date before any public
distribution. This plan is not compliance advice.** What remains solid is the
engineering conclusion: the owner's *local, bring-your-own-OAuth-client*
deployment (§10.1) keeps each user in their own Cloud project and avoids the
question entirely for v2.

#### Refresh tokens in Testing status (`/identity/protocols/oauth2`)

> "A Google Cloud Platform project with an OAuth consent screen configured for
> an external user type and a publishing status of 'Testing' is issued a refresh
> token expiring in **7 days**, unless the only OAuth scopes requested are a
> subset of name, email address, and user profile."

Also verified: a maximum of **100 refresh tokens per Google Account per OAuth
client ID**; creating the 101st silently invalidates the oldest. Irrelevant at
single-user scale, but it forbids "re-run the OAuth flow every sync tick" as a
workaround for the 7-day expiry.

**Qualified after review.** Seven days applies to *External projects in
Testing*, which is the recommended deployment and therefore the common case —
but not the only one. Internal Workspace projects and Production projects
differ, and tokens can also die early from revocation, password/security events,
inactivity, or token limits. Therefore: **persist any provider-supplied expiry
metadata, key the warning off the grant's `obtained_at` rather than the
account's `connected_at`, and treat the 7-day nag as a deployment-specific
heuristic that self-disables once a refresh token has survived more than 8
days** (§10.5).

#### Sync semantics (`/workspace/gmail/api/guides/sync`)

- Full sync: `users.messages.list` + `users.messages.get`.
- Partial sync: `users.history.list` with `startHistoryId`.
- History records are "typically available for **at least one week** and often
  longer. However, the time period ... may be significantly less and records may
  sometimes be unavailable in rare cases."
- When `startHistoryId` is outside the available range the API returns
  **HTTP 404**, and the client **must perform a full sync**.

**The 404 path is a normal, expected transition, not a rare edge case** — a
closed laptop, a `needs_reauth` week (§10.5), or a long idle period all reach
it. It must be cheap **and** non-destructive. Draft 1 said that and then
specified a destructive algorithm; §11.4 now specifies a safe one.

Critically: **`messages.list` excludes spam and trash unless
`includeSpamTrash=true`. Absence from a default listing is not evidence of
deletion.** Any enumeration used to drive deletion must set that flag.

#### Quotas (`/workspace/gmail/api/reference/quota`)

| Method | Quota units |
| --- | --- |
| `users.labels.list` | 1 |
| `users.history.list` | 2 |
| `users.messages.list` | 5 |
| `users.messages.get` | **20** |
| `users.threads.get` | **40** |
| `users.messages.send` | 100 |

| Limit | Value |
| --- | --- |
| Per minute, per project | 1,200,000 units |
| Per minute, **per user**, per project | **6,000 units** |
| Per day per project (billing threshold) | 80,000,000 units |

##### Disputed and resolved — read this before "correcting" these numbers

Both round-2 and round-3 reviewers asserted these constants are wrong, giving
`messages.get = 5`, `threads.get = 10`, and a per-user limit of
**250 units/second (15,000/min)**. Those are the **historical** values. They
were checked again after review:

- Two independent live fetches of the official quota page returned 20 / 40 /
  6,000 / 1,200,000 / 80,000,000.
- An independent web search returned, verbatim: *"The current quota costs are:
  messages.get at 20 units, threads.get at 40 units, and messages.list at 5
  units per request"*, alongside *"Google documents 6,000 quota units per minute
  per user per project"* — and explicitly noted the older 250 units/user/second
  figure as a **prior** default that was raised.

**The plan keeps 20 / 40 / 6,000.** Two strong models recalling the older
numbers from training data is exactly why §2 exists.

**But their process point was correct and is adopted.** Constants that two
expert reviewers got wrong will drift again:

> **Requirement.** All quota constants live in exactly one module,
> `providers/gmail/gmailQuota.ts`, each annotated with the verbatim quoted
> source line and the verification date. A unit test asserts each constant
> against that quoted text. When Google changes the table, that test is the
> tripwire — not a comment in a plan.

##### Consequences, worked through

- The binding constraint is 6,000 units/min/user, not the project limit.
- Ceiling on `messages.get`: `6000 / 20 = 300 messages/min` = 18,000/hour.
- **Do not promise a fixed backfill duration.** Quota is a ceiling, not
  throughput: HTTP latency, response size, parsing, sanitisation, and storage
  writes may bind first. Report *measured* throughput and a dynamic ETA.
- **Do not burst the whole minute's budget in one tick.** Although no
  per-second limit is currently documented, one existed historically, Google
  applies undocumented smoothing, and 300 concurrent requests is a bad idea on
  its own merits. The governor therefore enforces a per-second smoothing clamp
  in addition to the per-minute budget (§11.5).
- **`threads.get` is not a bootstrap optimisation.** See §11.3 — the arithmetic
  was applied to a quantity Gmail does not return.

#### Push notifications

`users.watch` + Cloud Pub/Sub requires a GCP topic and an HTTPS endpoint
reachable from Google. A local desktop app has neither. **Out of scope**;
Boring Mail polls (§11.6).

#### `UNVERIFIED` — must be checked before the phase named

| Claim | Blocks | Why it matters |
| --- | --- | --- |
| Gmail per-API batch endpoint still supported | P9 | Optimisation only; nothing may depend on it. Batching does not reduce quota units, which are the binding constraint. |
| `users.messages.send` preserves a client-supplied `Message-ID` | **P8** | If Gmail rewrites it, `rfc822msgid:` reconciliation can never find the send (§13.5). Must be checked manually with a recorded artifact. |
| `users.settings.sendAs.list` authorisation under `gmail.readonly` | **P8** | Determines whether send-as aliases are supported or the primary address is forced (§13.3). Do not silently add a scope. |
| `@napi-rs/keyring` works without libsecret on headless Linux / WSL | **P3** | A README claim, not a verified fact. `probe()` on a machine without Secret Service is the real acceptance (§10.4). |
| `sanitize-html` current version and maintenance status | **P5** | §12.3. |

### 2.3 Boring UI contracts — verified by reading the checkout at
`/home/ubuntu/projects/boring-ui-v2` (`@hachej/boring-workspace@0.1.98`,
commit `d1b671bcc`), 2026-08-21

- `@hachej/boring-workspace/plugin` exports `definePlugin`, `captureFrontPlugin`,
  `createCapturingBoringFrontAPI`, and types `PaneProps`, `WorkspaceSourceProps`,
  `WorkspaceSourceOpenPanelConfig`, `BoringFrontSurfaceResolverRegistration`.
  `captureFrontPlugin` is the supported front-plugin test seam.
- `WorkspaceSourceProps` is exactly `{ params, className?, openPanel? }`
  (`packages/workspace/src/shared/types/panel.ts:50`). `openPanel` is
  **optional**; today `front.tsx` uses `props.openPanel?.(...)` and silently
  no-ops — a latent bug (§3.4).
- Panel placements: `left | center | right | bottom | shared-dockview |
  workspace-page | right-tab`. Public plugin placements are `workspace-page`
  and `shared-dockview`.
- `WorkspaceServerPlugin` (`.../defineServerPlugin.ts:42`) accepts `id`, `label`,
  `agentConfigContract`, `contentDigest`, `piPackages`, `extensionPaths`,
  `systemPrompt`, `skills`, `packageResources`, `agentTools`,
  `workspaceBridgeHandlers`, `provisioning`, `assets`, `routes`
  (a `FastifyPluginAsync`), `getAgentReloadBlock`, `preservedUiStateKeys`.
- **No scheduler** in `@hachej/boring-workspace` (`grep -rln "scheduler"
  packages/workspace/src/server` → nothing). Boring Mail owns its timer and
  shutdown (§11.6).
- **No secret/credential store.** Boring Mail owns token storage (§10.4).
- Plugin-owned durable state convention: `ask-user` persists to
  `<workspaceRoot>/.boring/ask-user.json`. **Boring Mail deliberately does not
  follow this for mail content** — see §7.2, changed after review.

**`agentConfigContract` is the hook that makes §14.4's constrained-agent
requirement implementable.** It was present in the contract and unused by draft 1.

#### Unresolved Boring UI contracts — these are gates, not details

| Need | Status | Gates |
| --- | --- | --- |
| A supported server-side `ask-user` API to raise a question and validate an answer capability | **UNKNOWN** — carried unanswered from the v1 plan | **P8** (send). Draft 1 wrongly deferred this to the last phase while making send depend on it. |
| The host's authenticated-session / CSRF / origin model for plugin routes | **UNKNOWN** | **P2 onward** (§15.4) |
| Whether the workspace agent has shell/filesystem/network tools | **UNKNOWN** | **Everything** (§14.1) |

Draft 1 asserted "No Boring UI changes are required by this plan." **That claim
is withdrawn.** It may turn out to be true; it is not established, and the
highest-consequence feature in the plan depends on it.

### 2.4 Ecosystem choices

| Need | Choice | Rationale | Status |
| --- | --- | --- | --- |
| OS keyring | `@napi-rs/keyring` | `keytar` unmaintained (7.9.0, Feb 2022). Rust `keyring-rs` binding, prebuilt, keytar-compatible. | Library verified; **libsecret-free claim UNVERIFIED**, see §2.2 |
| SQLite | `node:sqlite` **on a worker thread** | §2.1, §7.1 | Verified locally |
| HTML sanitisation | `sanitize-html` | Runs in Node without a DOM shim. Allow-list model. | `UNVERIFIED` — confirm before P5 |
| MIME **part-tree walk** | hand-rolled | Gmail returns a decoded tree, not raw bytes (§12.1) | Design decision |
| MIME **header/address/charset parsing** | maintained libraries | Changed after review. RFC 2047/2231 decoding, Content-Type parameter parsing, mailbox-list parsing, and charset conversion are not worth hand-rolling. | Select and pin in P4 |
| RFC 822 **generation** | `nodemailer`'s `MailComposer` | Header folding, encoding selection, attachment framing (§13.2) | Decide by spike in P8 |

---

## 3. Current State — What Actually Exists Today

Verified by reading every source file, 2026-08-21. **1,334 lines** across 23
TypeScript files.

### 3.1 What works

| Area | File | Lines | State |
| --- | --- | --- | --- |
| Front plugin registration | `boring-mail/src/boring-ui/front.tsx` | 126 | Real. 1 workspace source, 2 panels, 2 surface resolvers. |
| Server plugin | `boring-mail/src/boring-ui/server.ts` | 53 | Real but thin. One route, one agent tool, a system prompt. |
| Agent tool | `boring-mail/src/mail/server/mailAgentTool.ts` | 200 | Real for drafts, **mock for mail**. |
| Draft files | same | — | Real. Path traversal guarded, `.mail.md` suffix enforced. |
| Source pane / thread panel / draft editor | `boring-mail/src/mail/client/*` | 376 | Real React, mock data. |
| Filtering + search | `boring-mail/src/mail/client/mailLogic.ts` | 46 | Real, in-memory, client-side. |
| Tests | 2 files | 66 | Thin. |

### 3.2 What is a stub

| File | Lines | Content |
| --- | --- | --- |
| `src/storage/sqlite.ts` | 7 | `return { kind: 'not-implemented-yet' }` |
| `src/server/index.ts` | 11 | `return { status: 'mock-only', routes: [] }` |
| `src/server/routes.ts` | 1 | One string constant |
| `src/mail/mockData.ts` | 134 | **The entire data layer.** 6 hard-coded threads. |
| `src/plugin-host/definePlugin.ts` | 30 | A parallel, unused plugin abstraction (§3.4) |

### 3.3 Blocking defect — the repo does not install

`pnpm-workspace.yaml` declares ten workspace packages under
`../boring-ui-v2-775-pr811-final/`. **That directory does not exist.**

```
$ test -d /home/ubuntu/projects/boring-ui-v2-775-pr811-final && echo YES || echo NO
NO
$ ls -la app/node_modules/@hachej/
boring-agent     -> ../../../../boring-ui-v2-775-pr811-final/packages/agent      # dangling
boring-ask-user  -> ../../../../boring-ui-v2-775-pr811-final/plugins/ask-user    # dangling
boring-workspace -> ../../../../boring-ui-v2-775-pr811-final/packages/workspace  # dangling
boring-mail      -> ../../../boring-mail                                          # ok
```

`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm dev` cannot succeed.
**Every proof command in the predecessor plan is currently unrunnable.**

Candidates on this machine: `/home/ubuntu/projects/boring-ui-v2` (a live dev
checkout on a feature branch) and `/home/ubuntu/projects/boring-ui-v2-release.V5Ypk3`.

**Changed after review:** draft 1 proposed reading the path from a
`BORING_UI_PATH` env var. `pnpm-workspace.yaml` does not interpolate environment
variables, and a sibling checkout cannot be pinned by a lockfile in a clean
clone. Phase 0 uses published exact versions, or a pinned git dependency /
submodule. Local linking stays a developer-only override that must not affect
the committed lockfile.

### 3.4 Latent problems to fix while we are in here

1. **`plugin-host/definePlugin.ts` + `mail/plugin.ts` are dead code** — a second
   plugin abstraction nothing imports, while `front.tsx` re-implements the same
   registrations directly. **P1 deletes both.** The Boring contract is the
   contract; the indirection buys nothing and the standalone app it anticipated
   does not exist and is not in scope.
2. **`renderMarkdownInline` is an XSS vector** (`mailLogic.ts:39`) — escapes
   `&<>` then re-introduces raw HTML by regex. Fine on mock data; not on mail.
   **Deleted in P7** (single owner; draft 1 assigned it to two phases).
3. **`MailThreadPanel` renders `message.bodyHtml`** — attacker-controlled once
   real mail flows. P7 gates all HTML behind server sanitisation *and* a
   sandboxed frame (§14.3).
4. **`props.openPanel?.(...)` silently no-ops** when the host omits `openPanel`.
   Clicking a thread does nothing, with no error and no log. **P7.**
5. **`new Date().toISOString().slice(0,19)` builds draft filenames** in two
   places (`front.tsx:31`, `mailAgentTool.ts:57`). Two drafts in the same second
   collide and the second silently overwrites the first. **P1** — it is a
   filename bug in those two files, not a storage concern.
6. **The `mail` tool's `search` scans every thread in memory** on every call.
   Fine for 6 mock threads; quadratic at 50,000. **P6.**

---

## 4. Problem Statement

### 4.1 What Boring Mail is

Not an email client with AI features. An agent-native Chief-of-Staff surface
over communication streams:

- Agents read the communication **first**.
- The human sees **curated attention points** in the existing Inbox / `ask-user`.
- The human can always **descend to the raw source** — every message is an
  artifact-like workbench target an agent or attention item can open.

### 4.2 What is missing today

The v1 plan built the shell against mock data and stopped. It looks right and is
worth nothing: **there is no mail in it.**

"Make it real" means four things, strictly ordered:

1. **Persistence** — a real store, surviving reload, searchable beyond `Array.filter`.
2. **Ingestion** — real Gmail, incremental, **multi-account**, resilient to the
   404 history path and the 7-day token expiry.
3. **Egress** — real sending, from the right identity, correctly threaded,
   human-approved.
4. **Safety** — real mail is hostile input: HTML, tracking pixels, attachments,
   spoofed display names, and prompt-injection payloads aimed at the agent that
   is about to read them.

### 4.3 Non-goals for v2

| Non-goal | Reason |
| --- | --- |
| Provider-side label/archive/delete mutation | Owner decision: no `gmail.modify`. §9. |
| IMAP / Outlook / other providers | The abstraction exists (§11.1) but only Gmail is implemented. |
| Push notifications (`users.watch` + Pub/Sub) | Needs GCP topic + public HTTPS endpoint. §11.6. |
| Hosted / multi-tenant | Owner decision; changes the verification posture (§2.2). |
| Rebuilding the Inbox / attention UI | `ask-user` owns it. |
| A permanent Gmail-style label sidebar | Boring already has app-left chrome. |
| Parquet/DuckDB analytics, msgvault | Derived caches, not a v2 source of truth. |
| Gmail's own drafts (`users.drafts`) | Needs `gmail.compose` (Restricted) and creates a second, conflicting draft store. §13.4. |
| Calendar / contacts / People | Separate scopes, separate consent, separate plan. |
| Sender-provided CSS styling | Removed in round 3 — see §12.3. Regex CSS filtering is not a CSS parser. |

---

## 5. Architecture

### 5.1 The shape

```txt
┌─────────────────────────── Boring UI workspace ──────────────────────────┐
│  app-left rail        workspace-left source        shared dockview        │
│  ┌───────┐            ┌─────────────────────┐      ┌──────────────────┐   │
│  │ Inbox │            │ MailSourcePane      │      │ MailThreadPanel  │   │
│  │(ask-  │            │  account switcher   │─────▶│  (1 tab / thread)│   │
│  │ user) │            │  search + views     │      └──────────────────┘   │
│  └───┬───┘            │  tag chips          │      ┌──────────────────┐   │
│      │ artifact ref   │  thread list        │      │ MailDraftFile    │   │
│      └────────────────┴──────────┬──────────┘      │  Panel (.mail.md)│   │
│                                  │                 └──────────────────┘   │
└──────────────────────────────────┼──────────────────────────────────────┘
                 authenticated, same-origin, CSRF-protected  (§15.4)
┌──────────────────────────────────▼──────────────────────────────────────┐
│                  boring-mail server plugin (Fastify routes)              │
│   routes/           agent tool `mail`         SyncSupervisor             │
│   ├ accounts        ├ list_accounts           ├ per-account SyncWorker   │
│   ├ threads         ├ search                  │   ├ bootstrap            │
│   ├ messages        ├ get_thread              │   ├ incremental          │
│   ├ search (POST)   ├ draft CRUD              │   ├ snapshot recovery    │
│   ├ attachments     ├ send → pending only     │   └ backfill             │
│   ├ oauth           └ sync_status             └ QuotaGovernor            │
│   └ sync                                                                 │
│                                                                          │
│   ┌──────────────┐  ┌───────────────┐  ┌──────────────┐  ┌────────────┐  │
│   │ GoogleOAuth  │  │ GmailClient   │  │ TokenStore   │  │ Sanitizer  │  │
│   │ Client       │  │               │  │ OS keyring   │  │            │  │
│   └──────┬───────┘  └───────┬───────┘  └──────┬───────┘  └────────────┘  │
│          └──── the ONLY two network transports ─┘                        │
│                                                                          │
│   ┌────────────────────── MailStore (async RPC facade) ───────────────┐  │
└───┼──────────────────────────────────────────────────────────────────┼──┘
    │                                                                  │
┌───▼──────────────── storage worker thread (§7.1) ────────────────────▼──┐
│  the ONLY execution context that owns a SQLite connection               │
│  single writer · migrations · FTS · blob GC · bounded cancellable jobs   │
└─────────────────────────────┬───────────────────────────────────────────┘
                              │
          <OS user data dir>/boring-mail/<profile>/     (§7.2)
          ├ mail.db  (+ -wal, -shm)
          ├ blobs/<sha256 fanout>
          └ quarantine/<sha256>          raw HTML, never served
```

### 5.2 Layering rules

These exist so the thing is testable without a Google account and does not
freeze under load.

1. **Provider network I/O is restricted to two injectable transports:**
   `GoogleOAuthClient` (authorization-code exchange, refresh, revocation, JWKS /
   ID-token verification) and `GmailClient` (Gmail API methods). No route, sync
   worker, store, or agent tool calls `fetch` directly.
   *Changed after review:* draft 1 said "`GmailClient` is the only module that
   performs network I/O" and then required OAuth token/revoke calls elsewhere —
   a rule its own Phase 4 acceptance test could not pass.
2. **A dedicated storage worker thread is the only execution context that owns
   SQLite connections.** `MailStore` is an **asynchronous RPC facade**. Fastify
   handlers, sync workers, and agent tools never execute `DatabaseSync` calls on
   the event loop. *Changed after review:* see §7.1.
3. **`TokenStore` is the only module that touches the OS keyring**, with a
   file-backed fallback selected at construction, not at call sites.
4. **The sync engine is pure with respect to time and randomness.** It takes
   `now(): number` and `jitter(): number`. No `Date.now()` / `Math.random()`
   inside sync logic. (Note: this buys determinism, not non-blocking — rule 2
   is what buys non-blocking.)
5. **The front-end never talks to Gmail.** It talks to `/api/boring-mail/*`.
   No OAuth token ever reaches the browser.
6. **Sanitisation happens in the storage/sanitizer layer, and its output is the
   only HTML any route returns.** Original HTML is quarantined, never served
   (§12.3).
7. **Local ids are identifiers, never bearer capabilities.** Possession of a
   `thr_` id authorises nothing (§15.4).

### 5.3 Package layout after v2

```txt
boring-mail/src/
  boring-ui/
    front.tsx                 # definePlugin registrations (the ONLY plugin decl)
    server.ts                 # defineServerPlugin: routes + agentTools + prompt
                              #   + agentConfigContract (§14.4)
  mail/
    client/
      MailSourcePane.tsx      AccountSwitcher.tsx      ThreadList.tsx
      MailThreadPanel.tsx     MessageBody.tsx          AttachmentList.tsx
      MailDraftEditor.tsx     MailDraftFilePanel.tsx   ConnectAccountPanel.tsx
      ApprovalBanner.tsx      # in-plugin send approval fallback (§13.6)
      mailLogic.ts            # pure view helpers; NO html generation
      useMailApi.ts           # typed client for /api/boring-mail/*
    server/
      mailAgentTool.ts
      routes/ index.ts accounts.ts threads.ts search.ts attachments.ts
              oauth.ts sync.ts send.ts
      approval/ ApprovalCapability.ts   # digest-bound, single-use (§13.6)
    sync/
      SyncSupervisor.ts  SyncWorker.ts  bootstrap.ts  incremental.ts
      snapshot.ts        backfill.ts    QuotaGovernor.ts
    providers/
      types.ts
      gmail/
        GmailClient.ts  GoogleOAuthClient.ts  gmailQuota.ts
        gmailNormalize.ts  gmailCompose.ts  gmailErrors.ts  gmailSendAs.ts
    shared/ constants.ts  ids.ts
  storage/
    MailStore.ts              # async RPC facade (main thread)
    worker/ storeWorker.ts  db.ts  migrations/  jobs/
    BlobStore.ts  TokenStore.ts  Sanitizer.ts
  shared/
    types.ts  api.ts
```

Deleted: `src/plugin-host/`, `src/mail/plugin.ts`, `src/server/index.ts`,
`src/server/routes.ts`. Moved: `src/mail/mockData.ts` → `test-fixtures/`.

---

## 6. Multi-Account Model

Multi-account is the requirement most likely to be quietly under-implemented,
because a single-account implementation *appears* to work until the second
account arrives and every id collides.

### 6.1 The five places account-awareness must exist

1. **Identity.** Every thread, message, attachment, address, and cursor is
   scoped to exactly one account. **Enforced by composite foreign keys**, not by
   application code (§7.3) — this is the most consequential multi-account
   invariant and application checks are not sufficient.
2. **Auth.** Each account holds its own grant, refresh token, expiry, and
   re-auth state. One account expiring must not stop the others.
3. **Sync.** Each account has an independent `SyncWorker` with its own history
   cursor, snapshot generation, backfill cursor, and backoff state, plus a
   per-account mutex so runs never overlap.
4. **UI.** Unified by default; per-account filter one click away. Chrome that
   names the account appears only when more than one is connected.
5. **Send.** The from-account is *derived*, never guessed; the send-as identity
   is *authorised*, never accepted from a request (§13.3).

### 6.2 Identity and id scheme

**Rule: no provider identifier, email address, or subject ever appears in a
surface target, panel id, route path, log line, or agent tool response id.**

| Concept | Format |
| --- | --- |
| Account id | `acct_` + 32 hex |
| Thread id | `thr_` + 32 hex |
| Message id | `msg_` + 32 hex |
| Attachment id | `att_` + 32 hex |
| Outbox id | `out_` + 32 hex |
| Blob id | `sha256:` + 64 hex |

*Changed after review:* 128-bit (32 hex), not 64-bit. These ids appear in
artifact refs handed to agents and rendered into Inbox items; 64 bits is
unnecessary collision and guessing risk for externally visible identifiers.
They remain identifiers, **never capabilities** (§15.4).

Ids are minted as **random** `crypto.randomBytes(16)`, never derived from
provider ids — a hash of a provider id is still a stable identifier for it.

Provider identity lives only in the database, behind unique constraints:

```sql
UNIQUE (account_id, provider, provider_thread_id)
UNIQUE (account_id, provider, provider_message_id)
```

That constraint *is* the idempotency mechanism for sync (§11.7).

### 6.3 Surface target format

Because thread ids are globally unique random values, a **bare thread id
remains sufficient** under multi-account; the account is resolved by lookup.

This is deliberate. The alternative — `acct_xxx/thr_yyy` — bakes the account
into every artifact reference ever emitted, so an account disconnect/reconnect
(routine under 7-day expiry) would invalidate every historical Inbox item that
referenced it. A bare stable thread id means attention items survive re-auth.

The resolver must handle three outcomes; the current code handles one:

| Outcome | Behaviour |
| --- | --- |
| Thread exists, account connected | Open/focus the thread tab. |
| Thread exists, account disconnected | Open **degraded**: cached content plus a reconnect affordance. Do not fail — cached mail is still mail. |
| Thread does not exist | Return `undefined` so the workspace falls through to another resolver. |

### 6.4 Account lifecycle

```txt
                  ┌──────────────┐
                  │ (no account) │
                  └──────┬───────┘
                         │ "Connect Gmail"
                  ┌──────▼───────┐  loopback OAuth + PKCE + OIDC (§10.2)
                  │  connecting  │
                  └──────┬───────┘
              success    │    cancel / deny / sub-mismatch
        ┌────────────────┴───────────────┐
        ▼                                ▼
  ┌───────────┐                    ┌──────────┐
  │ bootstrap │                    │ (deleted)│
  └─────┬─────┘                    └──────────┘
        │ historyId captured FIRST, recent window ingested, history drained
        ▼
  ┌───────────┐  ◀── history.list 404 ──▶ ┌────────────────┐
  │  active   │                           │  snapshotting  │ (§11.4)
  └─────┬─────┘  ◀────────────────────────└────────────────┘
        │ invalid_grant  (expected ~weekly in Testing, §10.5)
        ▼
  ┌────────────────┐  re-consent, SAME acct_ id, sub verified
  │ needs_reauth   │ ──────────────────────────────────────▶ active
  └───────┬────────┘
          │ "Disconnect"  → revoke THEN purge tokens (§14.7)
          ▼
  ┌────────────────┐
  │  disconnected  │  local mail RETAINED, readable, searchable
  └───────┬────────┘
          │ "Forget account and delete its mail"  → resumable state machine
          ▼
  ┌────────────────┐
  │   deleting     │ → (deleted)                             (§14.7)
  └────────────────┘
```

**`needs_reauth` must not lose data and must not lose the account row.**
Re-consent reattaches a token to the *same* `acct_` id — **only after the
returned `sub` is verified to match** (§10.3) — so thread ids, tags, triage, and
attention links survive. This is the single most important consequence of the
7-day expiry.

### 6.5 Unified inbox semantics

- Default view: all `active` and `needs_reauth` accounts, merged, newest first.
- `disconnected` accounts are excluded from the default view but reachable via
  the account filter and still searchable. Hiding history because a token
  expired is user-hostile.
- Sorting uses `last_message_at`, normalised to UTC epoch ms at ingest (§12.4).
  Never sort on a provider-formatted date string.
- Pagination uses a **keyset cursor** on `(last_message_at DESC, thread_id DESC)`,
  not `OFFSET`.

**Corrected after review.** Draft 1 claimed keyset pagination produces "no
duplicates, no skips when a sync lands mid-scroll". That is false: keyset is
stable only over an unchanged result set, and sync mutates `last_message_at`,
which is the sort key. The honest contract:

> Cursors embed a `listGeneration` (a fingerprint of the query plus a store
> mutation counter). When a relevant mutation invalidates the generation, the
> API returns `CURSOR_STALE` and the UI restarts the list from the top,
> preserving scroll position by thread id where possible. The API does not
> claim impossible no-skip semantics.

**Virtualisation.** Draft 1 required both a keyset cursor and a virtualised
50,000-row list with a proportional scrollbar. Windowed virtualisation with a
proportional scrollbar needs random access to row *i*, which keyset cannot
provide. **v2 ships windowed infinite scroll** — virtualised rendering over a
progressively loaded window, with a scrollbar that reflects loaded extent rather
than total. Jump-to-index is out of scope.

---

## 7. Storage

### 7.1 Decision record: `node:sqlite`, on a dedicated worker thread

**Decision:** `node:sqlite` (`DatabaseSync`), running in a `worker_threads`
worker that owns the only SQLite connection.

**Why `node:sqlite`.** Verified in §2.1: unflagged on Node 22.22.1, SQLite
3.51.2, FTS5 and JSON1 present. `better-sqlite3` is a native addon requiring
`node-gyp` or per-platform-per-ABI prebuilds; adding that to a plugin meant to be
installed into an arbitrary workspace is a recurring support cost.

**Why a worker thread — added in round 3, and this is the more important half.**
`DatabaseSync` is *synchronous*. Draft 1 put one `MailStore` on the Fastify
thread, shared by HTTP routes, both sync workers, and the agent tool, with
whole-thread ingest transactions including FTS delete+insert. Every reviewer
independently flagged it. A large ingest, a `MATCH` over a big mailbox, a
migration, a backup, a blob GC, or an FTS rebuild would block:

- every `/api/boring-mail/*` handler,
- OAuth callback and status polling,
- send approval callbacks,
- foreground thread opens,
- the other account's sync.

During backfill that is the steady state, not a spike. WAL does not make
synchronous JavaScript non-blocking, and `busy_timeout` addresses lock
contention, not event-loop stall. Note that the escape hatch below does **not**
solve this: `better-sqlite3` is synchronous too. The fix is *where the store
runs*, not which library it is.

**Shape.**

- One storage worker per data directory. A **single** `DatabaseSync` connection.
  All writes serialised on that thread's queue.
- `MailStore` on the main thread is a typed async RPC facade over
  `postMessage`, with request ids, timeouts, and backpressure.
- Long jobs (snapshot enumeration, FTS rebuild, backup, export, blob GC) are
  **bounded, cancellable, and progress-reporting** — never one unbroken
  synchronous call.
- A second read-only connection may be added later **if measured**, not before.

**Single-writer lock.** An OS-backed lock (an exclusive lock file with the pid
and start time) is acquired before migrations or supervisor start. A second
process either attaches to the existing local service, opens read-only, or fails
with `MAIL_STORE_ALREADY_ACTIVE`. Without it, two workspaces open on the same
machine each start a supervisor and each re-download the same mailbox.

**Escape hatch.** `MailStore`'s interface is library-agnostic; swapping to
`better-sqlite3` inside the worker is one file. Written down so a future agent
does not scatter raw SQL through the routes.

**Accepted cost.** `node:sqlite` prints an `ExperimentalWarning`; suppressed
narrowly in the worker, documented in the README.

### 7.2 On-disk layout — moved out of the workspace

```txt
<OS user data directory>/boring-mail/<profile-id>/
  mail.db  mail.db-wal  mail.db-shm
  blobs/e3/b0/e3b0c44298fc1c14...        # content-addressed, 2-level fanout
  quarantine/<sha256>                    # original HTML, NEVER served (§12.3)
  tokens.enc.json                        # only if the OS keyring is unavailable
  .lock                                  # single-writer lock (§7.1)

<workspaceRoot>/.boring/mail/
  workspace-overlay.db                   # attention links + workspace view state ONLY
```

**Changed after review, and this is a security change, not a tidiness one.**
Draft 1 put the mailbox in `<workspaceRoot>/.boring/mail/`, following the
`ask-user` convention. But §14.4 claims the `agent_readable` flag and the send
approval gate are meaningful controls — and an agent with filesystem access to
the workspace can read `mail.db` directly, bypassing `agent_readable`, and can
mutate `mail_outbox.status` to forge an approval. **A security control stored
inside the thing it is protecting against is not a control.**

Therefore: account rows, grants, message bodies, blobs, and the outbox live in
the OS user data directory. Only non-secret workspace projection state
(attention links, view preferences) stays workspace-local. This also fixes
per-workspace duplicate mailboxes.

- Directories are created `0700`, files `0600`. Verified by test (§14.6).
- Content-addressed blobs deduplicate the same attachment across threads and
  accounts.
- Two-level hex fanout keeps directory sizes reasonable.

### 7.3 Schema

`migrations/001_initial.sql`. Rationale follows the DDL.

```sql
-- VERIFIED: this exact DDL was executed against node:sqlite / SQLite 3.51.2 on
-- 2026-08-22 and runs clean inside a transaction. Round-4 corrections are marked.
-- migration bookkeeping (referenced by 7.4, absent from the 7.3 DDL)
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

-- ─── accounts ────────────────────────────────────────────────────────────
CREATE TABLE mail_accounts (
  id                   TEXT PRIMARY KEY,           -- acct_<32hex>
  provider             TEXT NOT NULL CHECK (provider IN ('gmail')),
  provider_issuer      TEXT NOT NULL,              -- OIDC iss; identity is (iss, sub)
  provider_account_key TEXT NOT NULL,              -- OIDC sub. NOT the email.
  email                TEXT NOT NULL,              -- display only
  display_name         TEXT,
  status               TEXT NOT NULL CHECK (status IN
                         ('connecting','bootstrap','active','snapshotting',
                          'needs_reauth','disconnected','deleting')),
  status_detail        TEXT,
  scopes_granted       TEXT NOT NULL CHECK (json_type(scopes_granted) = 'array'),
  agent_readable       INTEGER NOT NULL DEFAULT 0 CHECK (agent_readable IN (0,1)),
  send_as_json         TEXT NOT NULL DEFAULT '[]' CHECK (json_type(send_as_json) = 'array'),
  connected_at         INTEGER NOT NULL,
  grant_obtained_at    INTEGER,                    -- drives the expiry warning (§10.5)
  grant_expires_at     INTEGER,                    -- if the provider supplies it
  last_ok_sync_at      INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (provider_issuer, provider_account_key)
);

-- ─── sync cursors ────────────────────────────────────────────────────────
CREATE TABLE mail_sync_state (
  account_id                TEXT PRIMARY KEY REFERENCES mail_accounts(id) ON DELETE CASCADE,
  history_id                TEXT,                  -- uint64: TEXT, compared as BigInt
  history_id_at             INTEGER,
  -- snapshot (full-enumeration) recovery, §11.4
  snapshot_generation       INTEGER NOT NULL DEFAULT 0,
  snapshot_status           TEXT NOT NULL DEFAULT 'idle'
                              CHECK (snapshot_status IN
                                ('idle','listing','draining_history','failed')),
  snapshot_start_history_id TEXT,
  snapshot_page_token       TEXT,
  snapshot_started_at       INTEGER,
  -- backfill
  backfill_before_date      TEXT,                  -- 'YYYY/MM/DD'; durable, unlike a page token
  backfill_page_token       TEXT,                  -- hint only; may expire
  backfill_done             INTEGER NOT NULL DEFAULT 0,
  backfill_oldest_at        INTEGER,
  -- health
  last_attempt_at           INTEGER,
  last_error_code           TEXT,
  last_error_at             INTEGER,
  consecutive_failures      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at           INTEGER
);

-- ─── threads ─────────────────────────────────────────────────────────────
CREATE TABLE mail_threads (
  id                   TEXT NOT NULL,              -- thr_<32hex>
  account_id           TEXT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL,
  provider_thread_id   TEXT NOT NULL,
  subject              TEXT NOT NULL DEFAULT '',
  snippet              TEXT NOT NULL DEFAULT '',
  known_message_count  INTEGER NOT NULL DEFAULT 0, -- LOCALLY KNOWN, not provider total
  last_message_at      INTEGER NOT NULL,
  first_message_at     INTEGER NOT NULL,
  participants_json    TEXT NOT NULL DEFAULT '[]' CHECK (json_type(participants_json) = 'array'),
  -- all of the following are AGGREGATES over live messages (§11.4), never
  -- written from a single history record
  is_unread            INTEGER NOT NULL DEFAULT 0 CHECK (is_unread IN (0,1)),
  is_starred           INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0,1)),
  in_inbox             INTEGER NOT NULL DEFAULT 0 CHECK (in_inbox IN (0,1)),
  in_sent              INTEGER NOT NULL DEFAULT 0 CHECK (in_sent IN (0,1)),
  in_trash             INTEGER NOT NULL DEFAULT 0 CHECK (in_trash IN (0,1)),
  in_spam              INTEGER NOT NULL DEFAULT 0 CHECK (in_spam IN (0,1)),
  deleted_at           INTEGER,                    -- derived: all messages gone
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (id),
  UNIQUE (id, account_id),                         -- enables composite FKs below
  UNIQUE (account_id, provider, provider_thread_id)
);
CREATE INDEX idx_threads_recent ON mail_threads(last_message_at DESC, id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_threads_account_recent
  ON mail_threads(account_id, last_message_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_threads_inbox ON mail_threads(last_message_at DESC, id DESC)
  WHERE in_inbox = 1 AND deleted_at IS NULL;

-- ─── messages ────────────────────────────────────────────────────────────
CREATE TABLE mail_messages (
  row_id               INTEGER PRIMARY KEY AUTOINCREMENT,  -- STABLE FTS key. AUTOINCREMENT is
                                                       -- what makes "never reused" true.
  id                   TEXT NOT NULL UNIQUE,       -- msg_<32hex>
  thread_id            TEXT NOT NULL,
  account_id           TEXT NOT NULL,
  provider             TEXT NOT NULL,
  provider_message_id  TEXT NOT NULL,
  rfc822_message_id    TEXT,                       -- Message-ID header; threading on send
  in_reply_to          TEXT,
  references_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_type(references_json) = 'array'),
  direction            TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_json            TEXT NOT NULL CHECK (json_type(from_json) = 'object'),
  to_json              TEXT NOT NULL DEFAULT '[]' CHECK (json_type(to_json) = 'array'),
  cc_json              TEXT NOT NULL DEFAULT '[]' CHECK (json_type(cc_json) = 'array'),
  bcc_json             TEXT NOT NULL DEFAULT '[]' CHECK (json_type(bcc_json) = 'array'),
  reply_to_json        TEXT NOT NULL DEFAULT '[]' CHECK (json_type(reply_to_json) = 'array'),
  -- flattened "Name <addr>" strings; these are the FTS content columns
  search_from          TEXT NOT NULL DEFAULT '',
  search_to            TEXT NOT NULL DEFAULT '',
  subject              TEXT NOT NULL DEFAULT '',
  snippet              TEXT NOT NULL DEFAULT '',
  body_text            TEXT,                       -- canonical text; what agents see
  body_html_sanitized  TEXT,                       -- the ONLY HTML any route returns
  body_html_quarantine_blob TEXT,                  -- original HTML; NEVER served (§12.3)
  sanitizer_version    INTEGER NOT NULL DEFAULT 0,
  body_blocked_remote  INTEGER NOT NULL DEFAULT 0 CHECK (body_blocked_remote IN (0,1)),
  has_attachments      INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0,1)),
  size_estimate        INTEGER,
  sent_at              INTEGER NOT NULL,
  internal_date        INTEGER NOT NULL,           -- Gmail internalDate, authoritative
  provider_labels_json TEXT NOT NULL DEFAULT '[]' CHECK (json_type(provider_labels_json) = 'array'),
  body_fetched         INTEGER NOT NULL DEFAULT 0 CHECK (body_fetched IN (0,1)),
  deleted_at           INTEGER,                    -- per MESSAGE, not per thread
  last_seen_generation INTEGER NOT NULL DEFAULT 0, -- snapshot mark-and-sweep (§11.4)
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  UNIQUE (id, account_id),
  UNIQUE (account_id, provider, provider_message_id),
  FOREIGN KEY (thread_id, account_id)
    REFERENCES mail_threads(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_messages_thread ON mail_messages(thread_id, sent_at ASC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_messages_rfc822 ON mail_messages(account_id, rfc822_message_id);
CREATE INDEX idx_messages_sweep  ON mail_messages(account_id, last_seen_generation);

-- ─── exact address filters (§8.2) ────────────────────────────────────────
CREATE TABLE mail_message_addresses (
  message_id         TEXT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('from','to','cc','bcc','reply-to')),
  ordinal            INTEGER NOT NULL,
  display_name       TEXT,
  address            TEXT,
  address_normalized TEXT,                         -- lowercased; Gmail dots/plus NOT stripped
  PRIMARY KEY (message_id, kind, ordinal)
);
CREATE INDEX idx_addresses_lookup
  ON mail_message_addresses(kind, address_normalized, message_id);

-- ─── blobs (§14.5) ───────────────────────────────────────────────────────
CREATE TABLE mail_blobs (
  id             TEXT PRIMARY KEY,                 -- sha256:<hex>
  byte_size      INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  last_access_at INTEGER NOT NULL,
  verified_at    INTEGER,
  state          TEXT NOT NULL CHECK (state IN ('ready','missing','evicted'))
);

CREATE TABLE mail_attachments (
  id                     TEXT PRIMARY KEY,         -- att_<32hex>
  message_id             TEXT NOT NULL,
  account_id             TEXT NOT NULL,
  filename               TEXT NOT NULL DEFAULT '',
  media_type             TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size              INTEGER NOT NULL DEFAULT 0,   -- DECLARED; not trusted (§14.5)
  content_id             TEXT,
  is_inline              INTEGER NOT NULL DEFAULT 0 CHECK (is_inline IN (0,1)),
  provider_attachment_id TEXT,                     -- NULL when bytes came inline
  blob_id                TEXT REFERENCES mail_blobs(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL,
  FOREIGN KEY (message_id, account_id)
    REFERENCES mail_messages(id, account_id) ON DELETE CASCADE
);
CREATE INDEX idx_attachments_message ON mail_attachments(message_id, account_id);
CREATE INDEX idx_attachments_blob    ON mail_attachments(blob_id);
CREATE INDEX idx_blobs_gc ON mail_blobs(state, last_access_at);

-- ─── local overlay state (§9) ────────────────────────────────────────────
CREATE TABLE mail_tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE mail_thread_tags (
  thread_id TEXT NOT NULL REFERENCES mail_threads(id) ON DELETE CASCADE,
  tag_id    TEXT NOT NULL REFERENCES mail_tags(id)    ON DELETE CASCADE,
  source    TEXT NOT NULL CHECK (source IN ('user','agent')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, tag_id)
);
CREATE TABLE mail_thread_local_state (
  thread_id     TEXT PRIMARY KEY REFERENCES mail_threads(id) ON DELETE CASCADE,
  triage        TEXT CHECK (triage IN ('needs_reply','waiting','done','ignored')),
  triage_source TEXT CHECK (triage_source IN ('user','agent')),
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  snoozed_until INTEGER,
  agent_note    TEXT,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE mail_saved_views (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
  sort_json   TEXT NOT NULL DEFAULT '{}' CHECK (json_type(sort_json) = 'object'),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- ─── outbox (§13.5, §13.6) ───────────────────────────────────────────────
CREATE TABLE mail_outbox (
  id                  TEXT PRIMARY KEY,            -- out_<32hex>
  account_id          TEXT NOT NULL,
  send_as_address     TEXT NOT NULL,               -- authorised identity (§13.3)
  idempotency_key     TEXT NOT NULL,               -- client-minted Message-ID
  reply_to_thread_id  TEXT,
  reply_to_account_id TEXT,                        -- NULLABLE mirror of account_id, so the
                                                   -- composite FK can SET NULL without
                                                   -- violating account_id NOT NULL
  draft_path          TEXT,
  envelope_json       TEXT NOT NULL CHECK (json_type(envelope_json) = 'object'),
  body_markdown       TEXT NOT NULL,
  revision            INTEGER NOT NULL DEFAULT 1,
  content_digest      TEXT NOT NULL,               -- canonical digest of ALL covered fields
  approved_digest     TEXT,                        -- digest at approval time
  approval_cap_hash   TEXT,                        -- hash of the single-use capability
  approval_expires_at INTEGER,
  approved_at         INTEGER,
  approval_ref        TEXT,                        -- ask-user questionId, audit only
  send_lease_until    INTEGER,                     -- claim lease; prevents double workers
  status              TEXT NOT NULL CHECK (status IN
                        ('pending_approval','approved','sending','sent',
                         'unknown','failed','cancelled')),
  provider_message_id TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (account_id, idempotency_key),
  FOREIGN KEY (account_id) REFERENCES mail_accounts(id) ON DELETE CASCADE,
  CHECK (reply_to_account_id IS NULL OR reply_to_account_id = account_id),
  CHECK ((reply_to_thread_id IS NULL) = (reply_to_account_id IS NULL)),
  FOREIGN KEY (reply_to_thread_id, reply_to_account_id)
    REFERENCES mail_threads(id, account_id) ON DELETE SET NULL
);

CREATE INDEX idx_outbox_claim ON mail_outbox(status, send_lease_until);
CREATE INDEX idx_outbox_reply_thread ON mail_outbox(reply_to_thread_id, reply_to_account_id);

CREATE TABLE mail_outbox_attachments (
  outbox_id  TEXT NOT NULL REFERENCES mail_outbox(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  blob_id    TEXT NOT NULL REFERENCES mail_blobs(id),
  filename   TEXT NOT NULL,
  media_type TEXT NOT NULL,
  byte_size  INTEGER NOT NULL,
  PRIMARY KEY (outbox_id, ordinal)
);

-- ─── full-text search (§8) ───────────────────────────────────────────────
-- Column names MUST match mail_messages columns exactly: external-content
-- FTS5 resolves them against the content table.
CREATE VIRTUAL TABLE mail_messages_fts USING fts5(
  subject,
  search_from,
  search_to,
  body_text,
  content = 'mail_messages',
  content_rowid = 'row_id',
  tokenize = "unicode61 remove_diacritics 2"
);
```

`mail_attention_links` lives in the **workspace overlay** database, not here
(§7.2), and gains a `workspace_id` (§18 P9).

#### Why these choices

- **`row_id INTEGER PRIMARY KEY` plus `id TEXT UNIQUE`.** *Fixed in round 3.*
  External-content FTS5 is keyed by rowid. An implicit rowid on a `TEXT PRIMARY
  KEY` table is reused after `DELETE` and can shift under `VACUUM`, so a deleted
  message's FTS entry would later alias a *different* message and search would
  return the wrong bodies. That surfaces only after delete-and-reingest — the
  lifecycle the 7-day expiry makes routine.
- **FTS column names match content columns.** *Fixed in round 3.* The declared
  `from_text`/`to_text`/`body` did not exist on `mail_messages`, so `snippet()`,
  content lookups, and `'rebuild'` — the documented corruption recovery — would
  all have failed with missing-column errors, while a "the FTS table exists"
  test still passed.
- **Composite foreign keys `(thread_id, account_id)` and `(message_id,
  account_id)`.** *Added in round 3.* Without them a message can reference a
  thread from account A while claiming account B, an attachment can cross
  accounts, and an outbox row can reply into another account's thread. This is
  the most consequential multi-account invariant; application checks are not
  enough. The `UNIQUE (id, account_id)` rows exist solely to make these FKs
  legal.
- **`deleted_at` and `last_seen_generation` on `mail_messages`.** *Added in
  round 3.* Gmail's `messagesDeleted` is per-message; draft 1 had `deleted_at`
  only on threads, so a single deleted message was unrepresentable and the FTS
  exclusion had nothing correct to join on.
- **Thread `is_*` / `in_*` are aggregates.** Gmail labels are per-message
  (§11.4). Thread state is recomputed, never written from one delta.
- **`known_message_count`, not `message_count`.** During backfill the local
  count is not the provider's count; naming it honestly stops the UI presenting
  a false number.
- **`history_id` is `TEXT`.** Gmail's `historyId` is uint64; JS numbers lose
  precision above 2^53 and SQLite INTEGER is signed 64-bit. Compared as `BigInt`.
- **All timestamps are epoch-ms UTC integers.** No ISO strings; sorting a merged
  multi-account list on formatted strings is a bug generator.
- **`backfill_before_date`, not just a page token.** *Fixed in round 3.*
  `messages.list` page tokens expire, and a `needs_reauth` week guarantees a
  stale one. Resume is driven by a durable `before:YYYY/MM/DD` query; the page
  token is a hint. Otherwise every weekly re-auth restarts a 50k backfill.
- **`mail_thread_local_state` is a separate table.** It is what a snapshot
  recovery must never touch. Physical separation makes that a greppable,
  testable invariant rather than a comment.
- **`CHECK` constraints on every enum, boolean, and JSON column.** The database
  is the last line of defence against a bug in the one module allowed to write.

### 7.4 Connection settings and migrations

**PRAGMAs are per-connection and are NOT persisted by putting them in a
migration file.** *Fixed in round 3* — draft 1 had `PRAGMA foreign_keys = ON` at
the top of `001_initial.sql`, which would have left every composite foreign key
above unenforced. `journal_mode = WAL` does persist, but is set explicitly
anyway.

Every connection, in `storeWorker` open, **before** any migration transaction:

```js
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA synchronous = NORMAL')
db.exec('PRAGMA busy_timeout = 5000')
```

A test opens the database file directly, *without* going through
`storeWorker.open()`, and asserts `foreign_keys` is OFF — documenting the trap
so nobody "simplifies" the open path later.

Migrations:

- Numbered `.sql` files applied in order, recorded in
  `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)`.
- One transaction per file. `foreign_keys` is set before the transaction opens.
- **Forward-only.** `node:sqlite` exports `backup` (§2.1), so `open()` takes a
  backup to `mail.db.bak-<version>` before any version-bumping migration —
  turning an unrecoverable class of bug into a recoverable one. Backup failure
  or insufficient disk **aborts the migration**; it does not proceed hopefully.
- Migration SQL is **embedded as string constants**, not read from disk.

---

## 8. Search

### 8.1 Two layers

1. **Structured filters** — account, view, tags, triage, date range, has
   attachment, participant. Ordinary indexed SQL predicates.
2. **Full-text** — free text over subject, participants, and body. FTS5 `MATCH`.

A query with only structured filters must **never** touch FTS5.

**Exact address filters do not go through FTS.** *Changed in round 3.* Draft 1
routed `from:alice@example.com` through FTS token matching, which is not an
exact address filter — it matches tokens, so `alice@example.com` and
`notalice@example.com.evil.test` can both hit. Address operators query
`mail_message_addresses.address_normalized` (§7.3).

`to:me` expands to the account's verified primary and send-as identities
(§13.3). It cannot match groups or unknown aliases; §21 records this.

### 8.2 Operator syntax

```txt
from:alice@example.com   to:me      subject:invoice
has:attachment           is:unread  is:starred
in:inbox | in:sent | in:trash | in:spam
account:work             tag:needs-reply     triage:waiting
after:2026-01-01         before:2026-06-30
"exact phrase"           -term
```

Parsing rules:

- Hand-written tokenizer, ~120 lines, fully unit-tested. No parser combinator
  library for a dozen operators.
- Unknown `foo:bar` tokens are **free text**, not errors. Users type `re:` and
  `http://` into search boxes.
- User input is **never** interpolated into an FTS5 `MATCH` string raw. FTS5 has
  its own syntax (`NEAR`, `*`, `^`, `AND`/`OR`/`NOT`, column filters); a stray
  `"` is a syntax error and a stray `*` is an expensive prefix scan. Free-text
  terms are individually quoted and escaped (`"` → `""`), then joined with `AND`.
- **Negation is not `NOT "term"`.** *Fixed in round 3.* FTS5 `NOT` is a **binary**
  operator, so a query consisting only of exclusions (`-spam`) produces invalid
  syntax. Positive terms form the `MATCH` expression; exclusions are applied as
  a separate anti-join against an FTS subquery. A query with only exclusions
  remains valid and returns the structured-filter set minus the excluded.
- **Input limits are enforced and produce a stable error**, not best-effort
  execution: max query length, token count, phrase length, and prefix-wildcard
  count → `SEARCH_QUERY_TOO_LARGE`. *Changed in round 3:* draft 1's acceptance
  test ("a 10 KB term neither errors nor hangs") could pass with broken escaping
  that silently returns zero rows. The correct behaviour is fast rejection, and
  the test asserts the exact generated `MATCH` string.

This is a correctness **and** denial-of-service boundary and gets its own test file.

### 8.3 Ranking and result contract

- `bm25(mail_messages_fts, 10.0, 4.0, 1.0, 1.0)` weighting
  `subject, search_from, search_to, body_text`. Subject and sender matter far
  more than a body mention.
- **`bm25()` in SQLite returns negative values where lower is better**, so
  ordering is `ORDER BY bm25(...) ASC`. Stated explicitly because getting this
  backwards yields a plausible-looking, exactly-wrong result list.
- Thread score = best score among its messages; a thread is returned once.
- Default sort is recency; relevance only when a free-text term is present. A
  mail app that reorders the inbox by relevance when the user typed a tag filter
  has broken the inbox.
- Relevance paging uses a `(bm25, thread_id)` cursor — a different cursor from
  the recency list (§6.5). Both are specified; neither is faked.
- **Every search response carries `coverage: 'complete' | 'headers-only' |
  'backfilling'`.** *Added in round 3.* While backfill is incomplete, body
  search is genuinely incomplete, and a UI that renders "no results" for
  "nothing indexed yet" is lying to the user.
- **Highlights are returned as text spans (offsets), never HTML.**

### 8.4 Index maintenance

- `MailStore.upsertMessage()` writes `mail_messages`, `mail_message_addresses`,
  and the FTS rows in **one transaction** in the storage worker.
- External-content FTS5 requires an explicit `'delete'` command carrying the
  **old** column values before re-inserting on update, and on hard delete.
  `ON DELETE CASCADE` does **not** maintain an external-content index — cascade
  alone leaves it corrupt. Hard deletes therefore go through
  `MailStore.hardDeleteMessages()`, which issues the FTS `'delete'` and the row
  delete in one transaction. No caller deletes message rows directly.
- Body indexed is `body_text`, derived at ingest. **Never index raw HTML** — the
  index fills with `div`, `td`, `style`, and base64 image data.
- Soft-deleted messages may remain physically indexed; **every** search query
  joins `mail_messages.deleted_at IS NULL`.
- `PRAGMA optimize` on clean shutdown. `'rebuild'` is an admin route for
  corruption recovery, run as a bounded cancellable job, never automatically.

---

## 9. The Read-Only Consequence — Provider State vs Local State

**Most likely section to be skimmed; most likely to cause a bug users experience
as "this app is lying to me".**

### 9.1 The problem

Read + send means `gmail.readonly` + `gmail.send`. Neither writes labels. In
Gmail, **unread and starred are labels** (`UNREAD`, `STARRED`). So:

> Boring Mail can *read* whether a thread is unread or starred.
> Boring Mail **cannot make a thread read** in Gmail.

A naive implementation renders an unread badge, marks it read locally on click,
and diverges permanently and silently. Next sync, Gmail says `UNREAD`, the
thread goes bold again, and the user concludes the app is broken. They are right.

### 9.2 The rule

**Provider state is read-only and authoritative. Local state is a separate,
clearly-labelled, additive overlay. They are never merged into one field.**

| Concept | Owner | Writable | Column |
| --- | --- | --- | --- |
| Unread | Gmail | ❌ | `mail_threads.is_unread` (aggregate) |
| Starred | Gmail | ❌ | `mail_threads.is_starred` (aggregate) |
| Inbox / Sent / Trash / Spam | Gmail | ❌ | `mail_threads.in_*` (aggregates) |
| Gmail labels | Gmail | ❌ | `mail_messages.provider_labels_json` |
| Boring tags | Boring Mail | ✅ | `mail_thread_tags` |
| Triage | Boring Mail | ✅ | `mail_thread_local_state.triage` |
| Pinned | Boring Mail | ✅ | `mail_thread_local_state.pinned` |
| Snooze | Boring Mail | ✅ | `mail_thread_local_state.snoozed_until` |
| Agent note | Boring Mail | ✅ | `mail_thread_local_state.agent_note` |

### 9.3 What the UI must do

- **No "mark as read" control. No star toggle.** Not disabled-with-a-tooltip —
  absent. A disabled star is an invitation to file a bug.
- Unread and starred render as **read-only indicators**, visually distinct from
  controls: no hover affordance, no cursor change.
- Account settings state plainly: *"Boring Mail has read-only access to this
  Gmail account. Marking mail read, starring, archiving, and deleting must be
  done in Gmail. Boring Mail's tags and triage states are local and do not
  affect Gmail."*
- The concepts that let a user clear their queue are **triage** and **pin** —
  local, with no Gmail counterpart, so there is nothing to diverge from. Rather
  than fake write-back, give the user a real local workflow and say so.

### 9.4 The upgrade path

If `gmail.modify` is wanted later, the shape is already right:
`mail_thread_local_state` gains `pending_provider_ops_json` and a
`ProviderOpQueue` reconciles local intent to Gmail. Nothing is reshaped. **This
is why local state is a separate table.**

---

## 10. OAuth and Token Storage

### 10.1 Bring-your-own OAuth client

Boring Mail ships **no** Google client id and **no** client secret, extending
the repo's existing "no credentials" rule.

Rationale beyond hygiene: a shipped client id makes Boring Mail *the* app whose
verification status gates every user's access, and pools quota and abuse blast
radius across all users. BYO keeps each user in their own Cloud project, in
Testing status, as their own test user.

**The cost is real and is paid in the UX, not hidden.** First run requires
creating a Cloud project, enabling the Gmail API, creating an OAuth client of
type **Desktop app**, and pasting a client id and secret. P3 ships an in-app
walkthrough and `docs/gmail-setup.md`. ~5 minutes, once. Pretending otherwise
would become a support burden.

### 10.2 The flow

Installed-app loopback with PKCE **and OIDC nonce**:

```txt
1. User supplies client_id + client_secret in ConnectAccountPanel.
2. Server binds an ephemeral loopback listener on 127.0.0.1:0.
   - 127.0.0.1 literal, never "localhost" (may resolve to ::1; the redirect
     URI must match exactly).
3. Server mints, per flow:
     flow_id        = base64url(randomBytes(16))   -- 128-bit; see below
     code_verifier  = base64url(randomBytes(64))
     code_challenge = base64url(sha256(code_verifier))          method S256
     state          = base64url(randomBytes(32))
     nonce          = base64url(randomBytes(32))
4. Consent URL:
     https://accounts.google.com/o/oauth2/v2/auth
       ?client_id=...&redirect_uri=http://127.0.0.1:<port>/oauth2callback
       &response_type=code
       &scope=<gmail.readonly gmail.send openid email profile>
       &code_challenge=<...>&code_challenge_method=S256
       &state=<...>&nonce=<...>
       &access_type=offline
       &prompt=<see below>
       &login_hint=<stored email, RE-AUTH ONLY>
5. Client opens it in the system browser.
6. Google redirects to the loopback with ?code=&state=.
7. Validate state LENGTH first, then crypto.timingSafeEqual. Atomically
   consume the flow record before exchanging the code.
8. Exchange code + code_verifier at https://oauth2.googleapis.com/token.
9. FULLY VALIDATE the id_token (§10.3) before trusting anything in it.
10. Upsert by (iss, sub); store tokens; status -> bootstrap; start sync.
11. Loopback returns a small self-contained page. It echoes NO query
    parameter, loads NO external resource, and sets Referrer-Policy:
    no-referrer so the code cannot leak via Referer.
```

`prompt` values, which are not interchangeable:

- **New connect:** `prompt=select_account consent`. `consent` is required or a
  re-grant of already-granted scopes returns **no refresh token**, and the
  account becomes unrecoverable an hour later.
- **Re-auth:** `prompt=consent` **plus `login_hint`**, and **never**
  `select_account` — see §10.3.

Hardening requirements, each a real attack or bug:

- The listener has a **five-minute**, configurable deadline and accepts exactly
  one successful callback, then closes. *Changed in round 3:* draft 1's 90
  seconds is shorter than an ordinary MFA-plus-consent login and would have made
  the common path flaky. Five minutes is still bounded.
- Any local process can hit the loopback; `state` is the only thing preventing
  authorization-code injection. Not optional.
- `flow_id` is 128-bit random. The connect-status polling route is otherwise a
  local oracle another process can race.
- Only one connect flow at a time, per account and globally.
- **`scope` in the token response is compared against what was requested.** A
  user can uncheck scopes on the consent screen. If `gmail.send` was declined,
  the account still connects, send is disabled, and the UI says why. Assuming
  granted == requested produces a 403 at the worst moment — when the user hits
  Send.

**Non-local UI origin.** *Added in round 3.* The loopback flow assumes the
browser and the server are on the same host. Boring UI is a web app; if it is
reached at `http://<lan-ip>:port`, or runs in WSL2, a container, or Codespaces,
the browser's redirect to `127.0.0.1` never reaches the server. Therefore:

- The connect route **detects a non-local UI origin and refuses with a specific,
  actionable error** rather than hanging.
- A **paste-the-code fallback** is provided for remote and headless
  environments — still PKCE-verified, still state-checked, still one-shot,
  still deadline-bounded.
- `docs/gmail-setup.md` documents the WSL port-forward.
- This is probed in P3, not discovered when a Codespaces user files "connect
  does nothing".

### 10.3 Account identity — full ID-token validation, and `sub` binding

`mail_accounts` is keyed on **`(provider_issuer, provider_account_key)`** =
`(iss, sub)`, not on the email address. Email addresses change (workspace
renames, alias promotion); keying on them would, on a rename, create a duplicate
account and re-download the whole mailbox.

**The ID token must be fully validated before any claim in it is trusted.**
*Added in round 3* — draft 1 read `sub` out of the token without verifying it,
which trusts an unauthenticated blob to decide which mailbox a grant attaches to:

1. Signature against Google's published JWKS.
2. `iss` is the expected Google issuer.
3. `aud` equals the configured client id.
4. `exp` / `iat` within tolerance.
5. `nonce` equals the nonce minted for this flow.
6. `sub` present.

**Re-auth must fail closed on account mismatch.** *Added in round 3.* Draft 1
said re-consent "reattaches a token to the same `acct_` id" with nothing
enforcing that the human picked the same Google account. Weekly re-auth is the
steady state, so a mis-click is a matter of time — and the result would be two
mailboxes merged into one `acct_`, one FTS index, and one send identity.

```
if (isReauth && idToken.sub !== account.provider_account_key) {
    // do NOT write tokens; status stays needs_reauth
    // status_detail names BOTH addresses
    throw new MailError('REAUTH_ACCOUNT_MISMATCH')
}
```

New connects upsert **by `(iss, sub)`**, never by a caller-supplied account id.

**Corrected in round 3:** draft 1 claimed `sub` is "stable per Google account
per OAuth client" and concluded that rotating the BYO client id re-identifies
every account. Google's `sub` is the stable Google Account identifier; do not
assume client rotation changes it. Client rotation requires re-consent and
replacement of stored client credentials, and the returned `sub` should re-link
to the same account. §21 is updated accordingly.

### 10.4 `TokenStore`

**Primary — OS keyring via `@napi-rs/keyring`.** Service `boring-mail`, account
key `<accountId>`, value `{refresh_token, client_id, client_secret, scopes,
obtained_at}`. **Access tokens are never persisted** — in memory only, re-minted
from the refresh token. An hour-long token on disk is pure downside.

**Fallback — encrypted file** `tokens.enc.json` in the data directory (§7.2),
for headless Linux without a Secret Service, CI, and containers. AES-256-GCM,
key derived with scrypt from a user-supplied passphrase. There is **no**
hard-coded-key mode; that is obfuscation labelled as encryption. If neither
backend is available, connection **fails loudly**. It never falls back to
plaintext.

**Passphrase lifecycle is specified, not implied.** *Added in round 3.* Who
supplies it (the user, at first connect and at process start), where it lives
(memory only, never on disk, never in an env var written to a shell history),
what happens on hot reload (re-prompt; the store reports `LOCKED` and sync
pauses rather than erroring in a loop), and what CI uses (an ephemeral generated
passphrase per run). **A documented "test passphrase" must not exist**, because
it will become a production default.

```ts
interface TokenStore {
  readonly backend: 'keyring' | 'encrypted-file'
  probe(): Promise<{ ok: boolean; reason?: string }>
  get(accountId: string): Promise<StoredGrant | undefined>
  put(accountId: string, grant: StoredGrant): Promise<void>
  delete(accountId: string): Promise<void>
  listAccountIds(): Promise<string[]>   // required for wipe (§14.7)
}
```

`probe()` runs at plugin start and its result is shown in the account panel.
Discovering the keyring is unavailable *after* a consent flow completes is a bad
time to discover it. The keyring can also become locked **after** startup; that
is a distinct state and pauses sync rather than moving accounts to
`needs_reauth`.

### 10.5 Refresh-token expiry — designing for the expected case

From §2.2: External projects in Testing get 7-day refresh tokens. That is the
recommended deployment, so **re-consent roughly weekly is the steady state, not
an error.**

1. **Detect precisely.** HTTP 400 `{"error":"invalid_grant"}` on refresh means
   the refresh token is dead. Distinguish from `invalid_client` (rotated client
   credentials) and from transient 5xx/network failures. Only `invalid_grant`
   and `invalid_client` move an account to `needs_reauth`. Conflating them
   produces spurious consent prompts, which train the user to click through
   consent screens without reading them.
   A refresh response that omits a new refresh token is **not** an error; keep
   the existing one.
2. **Degrade, do not break.** `needs_reauth` keeps all local mail readable and
   searchable. Only new sync and send stop.
3. **Warn from the grant, not the account.** Key the day-6 nag off
   `grant_obtained_at`, use `grant_expires_at` when the provider supplies it,
   and **self-disable the heuristic once a refresh token has survived more than
   8 days** — otherwise a user on a Production or Internal project is nagged
   weekly by a warning that does not apply to them.
4. **One click to fix**, reusing stored client credentials and the same `acct_`
   id (§10.3), with `login_hint`.
5. **Surface it in the Inbox**, where this workspace already puts things needing
   a human — not only as a badge on a pane that may not be open.
6. **Never auto-retry consent.** Re-auth needs a browser and a human; an
   automatic loop burns quota and achieves nothing.
7. **Document the escape honestly.** Moving the Cloud project to Production
   removes the 7-day expiry and changes the verification posture. `docs/` states
   the tradeoff and **requires the user to check current Google policy** rather
   than presenting a casual "just switch to Production" (§2.2).

---

## 11. Sync Engine

### 11.1 Provider abstraction

```ts
interface MailProvider {
  readonly id: 'gmail'
  bootstrap(ctx: SyncCtx): Promise<BootstrapResult>
  incremental(ctx: SyncCtx, cursor: string): Promise<IncrementalResult>
  snapshotPage(ctx: SyncCtx, gen: number, pageToken?: string): Promise<SnapshotPage>
  backfillPage(ctx: SyncCtx, before: string, pageToken?: string): Promise<BackfillPage>
  fetchAttachment(ctx: SyncCtx, ref: AttachmentRef): Promise<Uint8Array>
  send(ctx: SyncCtx, message: OutboundMessage): Promise<SendResult>
}
```

One implementation. The interface costs ~40 lines and forces the supervisor to
be written against capabilities rather than Gmail JSON, which is what makes it
unit-testable with a fake. It does not exist because IMAP is coming (§4.3).

### 11.2 Four sync modes

| Mode | Trigger | Method | Bound |
| --- | --- | --- | --- |
| **Bootstrap** | Account connected | `getProfile` → historyId, then a bounded `messages.list` window | Bounded (§11.3) |
| **Incremental** | Poll timer, resume, manual | `history.list(startHistoryId)` | 2 units + fetches |
| **Snapshot** | `history.list` 404 | Complete enumeration + mark-and-sweep | Full mailbox, resumable |
| **Backfill** | Background, low priority | `messages.list` backwards by date | Unbounded, resumable |

**Bootstrap, snapshot, and backfill are three different things.** *Changed in
round 3:* draft 1 conflated bootstrap and recovery, which is what made the 404
path destructive.

### 11.3 Bootstrap

```txt
1. users.getProfile -> historyId, messagesTotal                     [1 unit]
   Persist historyId IMMEDIATELY, before ingesting anything.
   If ingestion crashes, incremental resumes from here and backfill covers
   the gap. Capturing it AFTER ingest loses every message that arrived
   during ingest, silently. Order matters.
2. users.messages.list(q='newer_than:30d', maxResults=500)       [5 units/page]
   -> pages of {id, threadId}
3. Deduplicate provider message ids, then fetch EXACTLY those ids with
   users.messages.get(format=full).                            [20 units each]
4. Normalize (§12), upsert (§11.7), index (§8.4).
5. Drain history from the captured historyId (§11.4) so the gap during
   ingest is closed BEFORE the account is published as 'active'.
6. Account -> 'active'. Enqueue backfill.
```

Window: 30 days **or** 2,000 messages, whichever is hit first — a date window
alone is not a bound on a mailing-list-heavy account. Everything older is
backfill's problem.

#### Why `threads.get` is not used for ingest — corrected in round 3

Draft 1 grouped listed ids by `threadId` and used `threads.get` when a thread had
more than one message, citing the 40-vs-20 unit break-even. **Both reviewers
independently found this rests on data Gmail does not return.**

- `users.messages.list` returns only `{id, threadId}`. There is **no message
  count**. Grouping one page tells you how many *matching ids happened to appear
  in that page*, not how many messages the thread has.
- A thread spans multiple result pages, so even the page-local count is wrong.
- **`users.threads.get` returns the entire thread**, not the listed ids. A
  200-message mailing-list thread with one reply in the last 30 days would pull
  all 200 — blowing the 2,000-message cap, writing pre-window mail into the store
  and FTS, and making first-run time a function of the user's worst thread rather
  than of the cap.
- On incremental `messagesAdded`, it would re-download an entire thread to pick
  up one message.

So the break-even arithmetic, while numerically right, was applied to the wrong
quantity. **Ingest uses `messages.get` on exactly the discovered ids.**

`threads.get` is reserved for **on-demand thread hydration**: the user or an
agent opened a thread that still contains `body_fetched = 0` stubs, and pulling
the rest is the explicit intent. Even there it is bounded by response size.

A `threads.get` ingest optimisation may be reconsidered in P9 only if complete
discovery proves ≥3 not-yet-fetched messages in one thread **and** response size
is capped — measured against quota, wall-clock, bytes, peak memory, and
accidentally expanded scope.

### 11.4 Incremental sync, and the 404 snapshot path

```txt
history.list(startHistoryId=cursor, maxResults=500)               [2 units/page]
  ├─ 200 -> apply records; page through nextPageToken to the END
  ├─ 404 -> HISTORY EXPIRED. Not an error. Run snapshot recovery.
  └─ 429/403 rateLimitExceeded -> backoff (§11.5); do NOT advance the cursor
```

**Cursor advance is after the last page, not per page.** *Fixed in round 3.*
The response `historyId` is the mailbox high-water mark **for the request**, not
the end of the current page. Persisting it mid-pagination means a crash skips
every record in the remaining pages — invisibly, with no 404 — and those adds
and deletes are lost until the next 404, which would then (in draft 1) have
mass-hidden mail.

**Label records are per-message and must be aggregated.** *Fixed in round 3.*

Gmail's `UNREAD`, `INBOX`, `STARRED` live on **messages**. Draft 1 said label
deltas "update `provider_labels_json` and the derived `in_*` / `is_*` columns"
as if one record were authoritative for the thread. It is not: a two-message
thread where both are unread, then one is read, is **still unread**. So:

```txt
apply(record):
  messagesAdded   -> messages.get(id) [bodies are NOT in the history record]
  messagesDeleted -> mail_messages.deleted_at = now  (per message)
  labelsAdded     -> rewrite that message's provider_labels_json
  labelsRemoved   -> rewrite that message's provider_labels_json

then, once per affected thread, recompute from LIVE messages only:
  is_unread  = EXISTS(msg has 'UNREAD')
  is_starred = EXISTS(msg has 'STARRED')
  in_inbox / in_sent / in_trash / in_spam  = EXISTS(msg has that label)
  known_message_count = COUNT(live locally known messages)
  thread.deleted_at   = (no live messages) ? now : NULL
```

`messagesAdded` records carry `id`, `threadId`, `labelIds` — **not bodies**.
A `messagesDeleted` record for an id never ingested is a **no-op**, not an error;
treating it as a failure would increment `consecutive_failures` and back the
account off for no reason.

#### Snapshot recovery — generation-based mark and sweep

**This is the highest-risk code in the plan: rare, destructive if written
naively, and not exercised in normal development.** Draft 1's version would have
soft-deleted most of a 50k mailbox. This replaces it.

```txt
 1. H0 = users.getProfile.historyId               -- capture FIRST
 2. gen = ++snapshot_generation
    snapshot_status = 'listing'
    snapshot_start_history_id = H0
    -- deleted_at is NOT touched anywhere in steps 1-6
 3. Enumerate the COMPLETE account:
       users.messages.list(includeSpamTrash=true)   -- NO date filter
    page through to the FINAL page.
    includeSpamTrash matters: absence from a default listing is not
    evidence of deletion (§2.2).
 4. For every discovered id: upsert and stamp last_seen_generation = gen.
    Fetch bodies only for ids not already present.
 5. Durable resume key is (gen, backfill_before_date-style date bound);
    snapshot_page_token is a hint that may expire.
 6. ONLY when the final page has committed:
       snapshot_status = 'draining_history'
       UPDATE mail_messages SET deleted_at = now
         WHERE account_id = ? AND last_seen_generation < gen
                             AND deleted_at IS NULL;
       recompute thread aggregates and thread deleted_at
 7. Drain history.list(startHistoryId = H0) to completion, THEN publish
    the new active cursor and set snapshot_status = 'idle'.
 8. On page-token rejection, H0 expiry, crash, or storage failure:
    ABANDON the generation. Sweep nothing. Restart with a new generation.
```

Invariants, each of which is a test:

1. **Nothing is deleted before a complete enumeration commits.** A crash at any
   page boundary sweeps nothing.
2. Snapshot **must not write** `mail_thread_local_state`, `mail_thread_tags`, or
   the workspace overlay. Enforced by test, not comment.
3. Soft delete only. Hard deletion is a separate, explicit, audited compaction
   (§14.7).
4. Repeated 404s in a short window mean the poll interval exceeds the account's
   history retention. The fix is a shorter interval, not more snapshots; the
   account panel surfaces the count.

### 11.5 Quota governor and backoff

- **Two limiters, not one.** A per-minute budget from `gmailQuota.ts` (§2.2)
  **and** a per-second smoothing clamp. *Added in round 3:* a token bucket with
  a 6,000-unit capacity legally spends the entire minute in one tick — 300
  concurrent `messages.get` — which is a bad idea regardless of whether a
  per-second limit is currently documented, since one existed historically and
  Google applies undocumented smoothing.
- Foreground work (a user opening a thread, a body fetch behind a search) draws
  from a **reserved 30%** of both windows. Backfill and snapshot use the rest.
  Without a reservation, a running backfill makes the UI feel broken exactly
  when the user is most engaged.
- **Concurrency is adaptive**, starting at 4 in flight globally and adjusting on
  observed latency and 429s, with a global CPU/storage ceiling. A fixed cap of 4
  can under-use the budget; an unbounded one produces a 429 storm.
- **`Retry-After` is honoured** wherever supplied, in preference to computed
  backoff.
- Retry classification (`gmailErrors.ts`) — Google's semantics are not
  inferable from status code alone:

| Signal | Meaning | Action |
| --- | --- | --- |
| 429, or 403 + `rateLimitExceeded` / `userRateLimitExceeded` | Rate limited | Full-jitter backoff, base 1 s, cap 64 s, max 6 attempts |
| 403 + `dailyLimitExceeded` | Daily quota gone | Stop this account until the next UTC day |
| 403 + `insufficientPermissions` | Scope not granted | `needs_reauth`, no retry |
| 401 | Access token expired | Refresh once, retry once; a second 401 → `needs_reauth` |
| 404 on `history.list` | History expired | §11.4 snapshot |
| 404 on `messages.get` | Deleted between list and get | Skip; not an error |
| 400 `invalid_grant` on refresh | Refresh token dead (weekly, §10.5) | `needs_reauth` |
| 400/403 send quota (daily send limit) | 500/day consumer, 2,000/day Workspace | Outbox → `failed` with a **specific** code, surfaced to the human |
| 5xx, `ECONNRESET`, `ETIMEDOUT` | Transient | Backoff + retry — **except on send** (§13.5) |

Full jitter (`sleep = random(0, min(cap, base * 2^n))`), not equal jitter: with
multiple accounts backing off after a shared limit, correlated retries are the
failure being avoided.

### 11.6 Polling

- Active cadence **120 s** per account, ±20% jitter. Idle backoff to **300–600 s**
  after consecutive empty results, resetting on any change.
- Cost per idle tick: `history.list` = 2 units. At 30 ticks/hour that is 60
  units/hour against a 360,000 units/hour budget. Polling is free; the interval
  is chosen for latency and battery.
- **Do NOT pause on HTTP idle.** *Fixed in round 3.* Draft 1 paused sync when no
  client had polled `/api/boring-mail/*` for 15 minutes. That contradicts the
  product: agents read first (§4.1), and an agent calling the `mail` **tool**
  never touches those HTTP routes. Closing the pane would have stopped sync, so
  attention projection — the actual product — would never see new mail. Worse, a
  long pause pushes the history cursor past retention and forces a full snapshot
  (§11.4). Sync runs while the process runs, backing off when idle. An explicit
  user pause is available, with a warning that long pauses may force a snapshot.
- **Detect suspend/resume** and run an immediate coalesced sync on resume.
- **Self-scheduling `setTimeout` after each completed run, never `setInterval`**,
  with a per-account mutex so timer, manual, and resume triggers coalesce rather
  than overlap.
- The supervisor is a **singleton**: a process-level guard plus the OS
  single-writer lock (§7.1). Registering `routes()` twice under hot reload must
  not produce two pollers. An orphaned timer holding a database handle produces
  `SQLITE_BUSY` that looks like corruption. Shutdown clears the timer, drains
  in-flight work, and closes the worker.
- **No `users.watch` / Pub/Sub** (§4.3).

### 11.7 Idempotency

```sql
INSERT INTO mail_messages (id, account_id, provider, provider_message_id, ...)
VALUES (?, ?, 'gmail', ?, ...)
ON CONFLICT (account_id, provider, provider_message_id) DO UPDATE SET
  provider_labels_json = excluded.provider_labels_json,
  last_seen_generation = excluded.last_seen_generation,
  updated_at           = excluded.updated_at
RETURNING id;
```

`RETURNING id` yields the **existing** local id on conflict, so a re-sync never
mints a new `msg_`/`thr_` id for known mail. That is what keeps surface targets
and attention links stable across snapshots (§6.3), and it is the mechanical
reason recovery is safe.

One thread's ingestion — thread row, messages, addresses, attachment metadata,
FTS rows — is one transaction in the storage worker. A partially-ingested thread
is never visible.

### 11.8 Deletion semantics

| Event | Effect |
| --- | --- |
| `messagesDeleted` history record | **Message** `deleted_at` set; thread aggregates recomputed |
| Message unseen after a **complete** snapshot generation | Message `deleted_at` set (§11.4) |
| Message unseen after an **incomplete** snapshot | **Nothing.** Generation abandoned. |
| Thread with no live messages | Thread `deleted_at` derived |
| Disconnect account | Revoke then purge tokens. **Mail retained**, readable |
| Forget account | Resumable delete state machine (§14.7) |

Soft-deleted messages are hidden from all views except an explicit trash filter
and are excluded from every search by `deleted_at IS NULL`. Hard deletion — and
only hard deletion — removes the FTS row, via `MailStore.hardDeleteMessages()`
(§8.4).

---

## 12. Normalisation — Gmail JSON to Domain Types

### 12.1 Walk the tree by hand; parse headers with libraries

`users.messages.get(format=full)` returns an already-parsed MIME *tree*:
`payload.mimeType`, `payload.headers[]`, `payload.body.{data,size,attachmentId}`,
`payload.parts[]` recursively, bodies base64url.

- **Walking that tree** is hand-rolled: ~200 lines, testable against fixtures, no
  dependency. A raw-MIME library would need `format=raw`, which costs the same
  quota, returns larger payloads, re-parses what Gmail parsed, **and defeats
  lazy attachment fetching by pulling attachment bytes inline**.
- **Header, parameter, address, and charset parsing use maintained libraries.**
  *Changed in round 3.* Draft 1 hand-rolled the address parser "with a test
  table". RFC 2047 MIME-word decoding, RFC 2231 continuations, Content-Type /
  Content-Disposition parameter parsing, mailbox-list grammar, and charset
  conversion are well-solved, heavily edge-cased problems. The part-tree walk is
  the part worth owning; the RFC grammar is not. Libraries are pinned and
  wrapped behind a narrow adapter so they are swappable and so adversarial input
  tests target our surface.

### 12.2 Part selection

```txt
walk(part):
  multipart/alternative -> prefer text/html child; keep text/plain as fallback
  multipart/related     -> honour the `start=` parameter to pick the root part;
                           other parts are inline (cid:) resources
  multipart/mixed       -> first body-ish part is the body; the rest attach
  multipart/signed      -> recurse into the first part; the signature attaches
  multipart/report      -> last text/* is the body; the rest attach   (bounces)
  message/rfc822        -> an ATTACHMENT, not a walk root
  text/plain            -> body_text candidate
  text/html             -> body_html candidate
  text/calendar         -> attachment
  filename or Content-Disposition: attachment -> attachment
  Content-ID + image type -> inline attachment
```

Cases that must be in the fixture corpus, because each has broken a real client:

- `multipart/related` inside `multipart/alternative` (Outlook)
- Nested `multipart/mixed` more than 3 levels deep
- Parts with **no** `mimeType`
- Attachments with no `filename` (derive from `Content-Type; name=`, then
  `attachment-<n>.<ext>`)
- RFC 2047 (`=?UTF-8?B?...?=`) and RFC 2231 (`filename*=UTF-8''...`) filenames
- **Non-UTF-8 charsets** — `iso-8859-1`, `windows-1252`, Shift-JIS. Decode via
  the declared charset with a bounded fallback; never assume UTF-8.
- Duplicate headers
- Zero-part messages where `payload.body.data` holds the whole body
- `payload.body.size > 0` with no `data` and no `attachmentId` (Gmail truncated):
  mark `body_fetched = 0` and offer "view in Gmail" rather than an empty body
  that looks like a real empty message
- **Bounces** (`multipart/report`) and **Gmail drafts** (`label:DRAFT`) — the
  latter are excluded from ingest, or they appear as inbound mail
- **Inline parts that already carry `data`** — these are persisted to a blob **at
  ingest**, because there is no `attachmentId` to fetch them with later. Lazy
  fetching (§14.5) applies only when `provider_attachment_id` is present.
  *Added in round 3:* draft 1's blanket lazy-fetch rule would have discarded
  those bytes permanently.

**Do not double-decode.** *Fixed in round 3.* `MessagePartBody.data` is
API-level base64url. Draft 1 proposed re-applying quoted-printable decoding when
a `Content-Transfer-Encoding` header remained, which **corrupts content Gmail
has already decoded**. Base64url-decode exactly once. Any genuine exception must
have a captured fixture and isolated, narrowly-scoped logic — not a heuristic.

**Bounds are enforced, and malformed input yields a safe partial message rather
than unbounded work:** maximum MIME depth, part count, header count, header
bytes, address count, decoded body bytes, and total decoded bytes.

### 12.3 HTML sanitisation, quarantine, and versioning

Sanitisation happens server-side at ingest. **Storage keeps three
representations, with a hard access rule** — *changed in round 3*:

| Column / file | Purpose | Who may read it |
| --- | --- | --- |
| `body_text` | Canonical text; indexed; what agents see | Anything |
| `body_html_sanitized` | The only HTML any route returns | Routes, UI |
| `quarantine/<sha256>` (`body_html_quarantine_blob`) | The original HTML | **`Sanitizer.reprocess()` only** |
| `sanitizer_version` | Policy version this cache was produced under | — |

Draft 1 stored only sanitised HTML, reasoning that keeping the raw column would
tempt someone to read it. But that makes a sanitiser bypass **unpatchable**:
after a `sanitize-html` CVE, every already-ingested message stays poisoned and
cannot be regenerated — and for a disconnected account it can never be refetched
at all. A 50k re-download is not a remediation plan.

So: quarantine the original in a non-servable namespace (`0600`, outside the
workspace, §7.2). No HTTP route, agent tool, search result, or export includes
it by default. When `sanitizer_version < CURRENT`, `MailStore` re-sanitises from
quarantine on read, writes back, and serves — and if regeneration is impossible,
renders plain text. **Sanitiser policy bumps are treated as data migrations**,
and dependency updates are monitored.

Allow-list (`sanitize-html`):

- Tags: block/inline text, lists, tables, `a`, `img`, `blockquote`, `pre`,
  `code`, `hr`, `br`. Never `script`, `style`, `iframe`, `object`, `embed`,
  `form`, `input`, `link`, `meta`, `base`, `svg`, `math`.
- Attributes: `href` (`http`/`https`/`mailto` only), `src` (img only), `alt`,
  `title`, `width`, `height`, `colspan`, `rowspan`.
- **All sender-provided `style` attributes are dropped in v2.** *Changed in
  round 3.* Draft 1 filtered `style` to a property allow-list and stripped
  `url(`, `expression(`, `@import`. Regex checks are **not a CSS parser** and
  miss escapes, comments, and obfuscation — and a second sanitiser language is
  not worth carrying in v2. Marketing mail renders plainer. Styling can return
  once a real CSS sanitiser is selected and browser-level tests exist (§21).
- All `on*` handlers dropped by construction.
- `javascript:`, `data:`, `vbscript:` dropped everywhere **including after
  entity-decoding** — `&#106;avascript:` is the classic bypass and gets a test.
- Every surviving `<a href>` gets `target="_blank" rel="noopener noreferrer"`.
- **Every remote-fetch surface is stripped or rewritten**, not just `src`:
  `srcset`, legacy `background`, `poster`, SVG references, CSS URLs, and unknown
  URL-bearing attributes.

**Remote content blocking (tracking pixels).** Default-on:

- Off-origin `img` references are replaced with a placeholder, the original
  stashed in `data-blocked-src`, and `body_blocked_remote` set.
- Inline `cid:` images are resolved by the **parent** into blob URLs (§14.3) and
  are not blocked — they arrived with the message.
- A per-message "Show remote images" bar renders a **separate** document with a
  distinct CSP (§14.3). The choice is per-message and non-persistent; a
  per-sender allow-list is deferred (§21).
- **Agent-initiated reads must never fetch remote content, under any user
  setting.** A tracking pixel tells a sender that a specific human read a
  specific message at a specific time; an agent reading in the background would
  emit read receipts for mail the human never saw. Hard rule, not a default.

### 12.4 Headers, addresses, dates

- **Use Gmail's `internalDate`** (epoch ms, server-authoritative) for `sent_at`
  ordering. The `Date:` header is unreliable (clock skew, forgery) and is kept
  only for display when it differs materially.
- Address parsing (via the pinned library, §12.1) handles `Name <a@b>`,
  `"Quoted, Name" <a@b>`, bare `a@b`, group syntax
  (`undisclosed-recipients:;`), RFC 2047 display names, and comma-in-quoted-string.
  Results populate `mail_message_addresses` (§7.3).
- **Display names are attacker-controlled.** `From: "security@yourbank.com"
  <attacker@evil.test>` is a valid header. The UI always renders the address
  beside the display name for the message being read, never the name alone.
  Agent tool output always includes both (§17.4).
- `Message-ID`, `In-Reply-To`, `References` are captured — required to thread a
  reply on send (§13.2).

---

## 13. Sending

The highest-consequence feature in the plan. A bug here is not a rendering
glitch; it is mail sent from the owner's real identity.

### 13.1 The pipeline

```txt
.mail.md draft ─▶ outbox row (pending_approval, content_digest)
                        │
                        ▼
              single-use approval capability, bound to the digest   (§13.6)
                        │
                        ▼
       claim lease ─▶ compose RFC 822 ─▶ messages.send ─▶ sent
                                              │
                                    ambiguous │
                                              ▼
                                          unknown  ──▶ human decision (§13.5)
```

### 13.2 Composition

`gmailCompose.ts` produces a base64url RFC 822 message.

- Headers: `From`, `To`, `Cc`, `Bcc`, `Subject`, `Date`, `Message-ID`,
  `MIME-Version`, plus `In-Reply-To` and `References` for replies.
- `Message-ID` is **client-minted before send** and is the idempotency key
  (§13.5): `<out-<32hex>@boring-mail.invalid>`. `.invalid` is reserved by
  RFC 2606 and cannot collide with a real domain.
  **`UNVERIFIED` (§2.2): whether Gmail preserves it.** P8 must check manually
  and record the artifact; if Gmail rewrites it, §13.5's reconciliation needs
  the documented fallback.
- Body is `multipart/alternative`: `text/plain` (the markdown, lightly
  de-formatted) plus `text/html` (rendered markdown). HTML-only is user-hostile;
  text-only loses the editor's formatting.
- Non-ASCII headers RFC 2047 encoded; non-ASCII bodies UTF-8 + base64; lines
  folded at 78.
- The final payload is **base64url** (`-`/`_`, no padding), not standard base64
  — the mistake that produces an unhelpful Gmail 400.

**Decision required in P8:** `MailComposer` vs hand-rolled. Recommendation is
**`MailComposer`** — folding, RFC 2047, encoding selection, and attachment
framing are exactly where hand-rolling is wrong in ways that only show up in
*some* recipients' clients. If used: set `disableFileAccess` and
`disableUrlAccess`, supply attachment **bytes** directly (never paths or URLs),
and **verify Bcc handling against the Gmail API rather than assuming SMTP
defaults apply**. The interface (`compose(msg): string`) is identical either
way, so the decision is reversible.

### 13.3 Reply threading, from-account, and send-as identity

For Gmail to thread a reply correctly, **all** of these must hold:

1. `threadId` in the `messages.send` request body.
2. `In-Reply-To` = the replied-to message's `Message-ID`.
3. `References` = that message's `References` + its `Message-ID`.
4. `Subject` matches the thread's subject (optionally `Re: ` prefixed).

Gmail needs 1 and a matching subject; other clients in the thread need 2 and 3.
Doing only 1 produces a thread that looks right in Gmail and fragments elsewhere.

**The from-account rule.** For a reply, the sending account is
`mail_threads.account_id`. Never inferred from `To:`, never taken from a
client-supplied field, never defaulted to "the first connected account". With
multiple accounts, replying to a work thread from a personal address is a
privacy incident, not a UI annoyance; deriving it from immutable server state
removes the possibility. For a new compose the account is explicit in the UI,
defaults to last-used, and is shown prominently — never silently chosen.

**Send-as identity.** *Added in round 3.* Account is necessary but not
sufficient: a Gmail account can have several authorised send-as identities, and
replying from the primary address when the original targeted a work alias
discloses the primary address.

1. The account is always the thread's account.
2. The `send_as_address` must be one of the **provider-authorised** identities
   for that account (`mail_accounts.send_as_json`).
3. Prefer the identity matching the original envelope/recipient headers.
4. If enumeration is unavailable under the granted scopes
   (`users.settings.sendAs.list`, **`UNVERIFIED`**, §2.2), **force the primary
   Gmail profile address** and show that exact address at approval.
5. **Never accept an arbitrary `From` from a draft or request.**

A `.mail.md` draft carries `account:` and `from:` front matter written by the
server. A draft naming a disconnected, unknown, or unauthorised identity is
refused at approval time with a clear message — never silently redirected.

### 13.4 Not using Gmail drafts

`users.drafts` requires `gmail.compose` (Restricted) and would create a second
draft store conflicting with `.mail.md`, the existing agent-legible mechanism.
Drafts stay local (§4.3).

### 13.5 Idempotency, and the `unknown` state

`users.messages.send` has **no** idempotency key. The outbox is how duplicates
are prevented.

1. Before any network call, insert `mail_outbox` with a fresh
   `idempotency_key` (the minted `Message-ID`). `UNIQUE (account_id,
   idempotency_key)` makes a double-submit a database error, not a duplicate
   email.
2. A worker **claims** the row with a `send_lease_until` lease, so two workers
   cannot both send it.
3. **At most one automatic provider send attempt is permitted per approval.**
4. Success → record `provider_message_id`, status `sent`.
5. **Ambiguous failure → status `unknown`.** Timeout, connection reset, 5xx
   after upload, or a crash after dispatch. Draft 1 said: search SENT for the
   `Message-ID`; "not found after the next sync cycle → safe to retry."
   **That is false and would duplicate mail.** SENT visibility and Gmail search
   indexing lag, so absence is *not* evidence of non-delivery.
6. Reconcile repeatedly with bounded backoff via
   `messages.list(q='rfc822msgid:<...>')`. Finding it → `sent`.
7. After the reconciliation deadline, **ask the human**:
   *Keep waiting* · *Mark as sent* · *Retry (this may send a duplicate)*.
   Retry requires a **new** approval (§13.6).
8. Never auto-retry an `unknown` send. Exactly-once delivery is impossible here;
   the plan says so rather than implying otherwise.

Client-minting the `Message-ID` is what makes reconciliation possible at all: a
server-assigned id cannot be searched for after a timeout, because we never
learned it.

### 13.6 The approval gate

**No send executes without a single-use capability bound to the exact content
being sent.** *Substantially strengthened in round 3.*

Draft 1 had two holes. First, human sends were approved by "the click", so
anything able to call the local HTTP endpoint — a malicious web page, an agent
with shell or HTTP tools, another local process — could send by calling
`/outbox/:id/send`. Second, approval was bound to a **body hash**, so changing
`to`, `cc`, `bcc`, the account, or attachments after approval would not
invalidate it. And `mail_outbox.status` lived in an agent-writable workspace
(§7.2), so approval could be forged by editing the database.

**The capability.**

- Issued only to an **authenticated host UI session** (§15.4). Agent tools can
  create `pending_approval` rows; they **cannot obtain or invoke a capability**.
- Bound to a canonical `content_digest` covering **everything**: account id,
  `send_as_address`, reply target, To/Cc/Bcc, subject, body bytes, attachment
  order/names/types/content hashes, and every generated header.
- Short-lived (`approval_expires_at`), stored **only as a hash**
  (`approval_cap_hash`), and **consumed in the same transaction** that moves the
  row `pending_approval → approved`.
- The sender worker **recomputes the digest before claiming**. A mismatch fails
  closed.
- Editing any covered field creates a **new revision** and invalidates approval.
- **Bcc is rendered explicitly and in full** at approval. A hidden recipient the
  approver did not see is the exact failure this gate exists to prevent.
- **At most 5 `pending_approval` rows per account.** Further `mail.send` calls
  return `status: 'approval_backlog'` rather than creating a sixth question, so
  a confused or injected agent cannot flood the Inbox.

**Two approval surfaces, because one of them may not exist.** The `ask-user`
server contract is **UNKNOWN** (§2.3), and draft 1 made send depend on it while
deferring the question to the last phase. Therefore:

- **P1 spikes it**: raise an `ask-user` question from a server plugin with a
  surface target, receive and validate the answer capability, confirm single
  use. If that needs a Boring UI PR, this plan is blocked on it and the "no
  Boring UI changes" claim is withdrawn (it already is, §2.3).
- **An in-plugin fallback ships regardless**: `pending_approval` rows render a
  persistent source-pane banner and a thread-panel Approve/Reject
  (`ApprovalBanner.tsx`) performing the identical digest check against the same
  authenticated session. `ask-user` is an *additional surface*, not the only
  capability issuer.

The agent's `mail.send` returns `{status: 'pending_approval', outboxId}` —
never language implying the mail was sent. An agent that reads "ok" will tell
the user their email went out.

---

## 14. Security and Privacy

### 14.1 Threat model — and the trust boundary

*Rewritten in round 3.* Draft 1 listed "the user's own agent, over-permissioned"
as a threat mitigated by the approval gate. Both reviewers pointed out that this
computes containment on the wrong process.

| Adversary | Capability | Status |
| --- | --- | --- |
| Malicious email sender | Arbitrary HTML, CSS, attachments, headers | Mitigated: §12.3, §14.3, §14.5 |
| Malicious sender targeting the **agent** | Prompt injection in body, subject, filename | Bounded, not solved: §14.4 |
| Tracking sender | Remote images, link decoration | Mitigated: §12.3 |
| Another local process | Loopback OAuth interception; reading `mail.db` | Partially: §10.2, §14.6 file modes. **A same-user process is not excluded.** |
| Malicious web page targeting localhost | CSRF against destructive routes | Mitigated: §15.4 |
| A leaky log or Inbox item | PII in ids, targets, paths | Mitigated: §6.2, §14.6 |
| **Agent restricted to the documented `mail` tool contract** | Tool actions only | Mitigated: tool capability limits + §13.6 |
| **Agent with arbitrary same-user shell / filesystem / network access** | Anything the user can do | **OUTSIDE THE IN-PROCESS SECURITY BOUNDARY.** Requires OS/process isolation. Tool-level checks do not protect against it. |

That last row is the honest statement draft 1 lacked. It drives two structural
decisions: the datastore moves out of the agent-writable workspace (§7.2), and
whether the workspace agent *has* those tools becomes an **owner-gate question**
(§22), because the answer determines whether `agent_readable` and the approval
gate are security controls or merely UX guardrails.

### 14.2 Scopes requested

Exactly `gmail.readonly`, `gmail.send`, `openid`, `email`, `profile`. Adding a
scope requires a plan revision: it changes the consent the user gave and, for
restricted scopes, the verification posture (§2.2).

### 14.3 Rendering hostile HTML

*Redesigned in round 3 — draft 1's specification was internally impossible.*

It required simultaneously: no `allow-scripts`, no `allow-same-origin`, and
parent-measured height, with `img-src <self>`. Those cannot all hold:

| Goal | Requires |
| --- | --- |
| Parent reads `scrollHeight` | `allow-same-origin`, **or** a script inside the frame |
| `'self'` matches the attachment route | frame origin = parent origin ⇒ `allow-same-origin` (a sandboxed `srcdoc` frame has an opaque `null` origin, so **every `cid:` image dies**) |
| `target="_blank"` works | `allow-popups` (+ `allow-popups-to-escape-sandbox`) |
| Hostile script cannot run | **omit `allow-scripts`** |

Draft 1 also wrote `<self>`, which is not the CSP keyword (`'self'` is).

**The v2 design — security over auto-height:**

- `sandbox="allow-popups allow-popups-to-escape-sandbox"`. **No `allow-scripts`.
  No `allow-same-origin`.**
- **Fixed / min-max height with internal scrolling. The frame is not
  auto-measured.** This is the requirement that gets dropped, deliberately: it
  is the only one whose absence is a cosmetic cost rather than a security or
  correctness cost.
- CSP via `<meta http-equiv>` **inside** the `srcdoc` (the `iframe[csp]`
  attribute is not portable and is not the control):
  `default-src 'none'; img-src blob:; style-src 'unsafe-inline'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
- **The parent resolves `cid:` images** through the authenticated API, converts
  them to **blob URLs**, and substitutes them before assigning `srcdoc`. This is
  what makes `img-src blob:` sufficient and keeps attachment URLs out of an
  opaque-origin frame.
- **Remote images use a separate, explicitly user-enabled render document** with
  its own `img-src https:` policy — not a relaxation of the default one.
- `style-src 'unsafe-inline'` covers our own injected reset styles; sender
  `style` attributes are already stripped at ingest (§12.3).

Two independent layers remain, and neither may be removed because the other
exists: server-side sanitisation (§12.3) and this frame.

`renderMarkdownInline` (§3.4) is deleted; draft rendering uses Boring UI's
existing Markdown editor.

**Testing.** *Changed in round 3.* jsdom does not implement iframe sandboxing,
CSP, popup navigation, or script execution, so draft 1's "jsdom + a sandbox
assertion" was a test that could not fail. **P7 uses Playwright/Chromium** and
asserts: no script execution, no unexpected network request, no top navigation,
links open only on a user gesture, `cid:` images resolve without exposing
unauthenticated attachment URLs, remote resources stay blocked until explicit
action, and a large newsletter falls back rather than producing an empty
`srcdoc`.

### 14.4 Prompt injection — the agent-native problem

Boring Mail exists so agents read mail. Mail is written by strangers. **Every
message body is untrusted input placed into an agent's context**, and some of it
is engineered to look like instructions.

**The containment claim, stated correctly.** Draft 1 asserted the `mail` tool
"grants the agent no capability that a compromised agent could use to cause
irreversible harm on its own". That is true of the *tool* and false of the
*agent*: injection does not need `mail.send`, it needs `mail.search` plus
`bash`. The claim now holds **only** when the agent cannot reach the mail
database, keyring, local route server, or arbitrary network except through the
brokered `mail` tool.

Mitigations, in order of how much they actually help:

1. **Tool isolation, not just tool design.** *Added in round 3.* v2 ships a
   **constrained mail-triage agent configuration** via `agentConfigContract`
   (§2.3) whose tool allow-list is `{mail, ask-user}` — no shell, no generic
   HTTP, no workspace write outside the mail draft directory. The general
   workspace agent may call `mail` only when the account is `agent_readable`
   **and** an explicit "allow mail in the general agent" setting is on
   (**default off**).
2. **Data outside the agent-writable workspace** (§7.2), so `agent_readable` and
   the outbox are not bypassable by reading and writing files.
3. **Capability containment for the tool surface**: cannot send without a
   capability it cannot obtain (§13.6), cannot delete provider mail (no scope),
   cannot read outside the mail store, cannot make arbitrary requests.
4. **Typed, escaped, labelled content.** *Changed in round 3.* Draft 1 wrapped
   bodies in `<untrusted-email-content>` markers — which an email body can simply
   contain, closing the delimiter. Content is returned as a **JSON string field**
   with canonical escaping, alongside `trust: "untrusted-third-party"` and a
   content length and hash. The plugin `systemPrompt` states the rule.
5. **Truncation with explicit continuation** — default 8 KB per message, 32 KB
   per tool result, with `truncated: true` and the id needed to fetch more. This
   bounds both context cost and injection payload size.
6. **Per-thread message pagination**, not only per-body truncation: a
   200-message thread exceeds the tool budget after four messages.
7. **Never render agent-supplied strings as HTML** anywhere in the UI.
8. **Attacker-controlled filenames and display names are labelled as such**
   (§12.4).
9. **No remote fetch on agent-initiated reads** (§12.3), so an injected payload
   cannot exfiltrate through an image URL.

**Not claimed: that this prevents prompt injection.** It does not. It bounds the
blast radius, and only under the trust boundary in §14.1. Any future feature
letting an agent act irreversibly on mail content without a human must revisit
this section first.

### 14.5 Attachments

- Never executed, never auto-opened.
- Content-addressed by SHA-256 (§7.2), so the stored name cannot be
  attacker-influenced. Display filenames are sanitised for rendering: path
  separators, control characters, and leading dots stripped.
- Served with `Content-Disposition: attachment` **always** —
  never `inline`, except `is_inline` images restricted to a media-type
  allow-list (`image/png|jpeg|gif|webp`) — plus
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- **Declared `media_type` and `byte_size` are not trusted.** Inline-render
  decisions use a sniffed magic number, and **limits are enforced against bytes
  actually received**, not against MIME metadata.
- **Blob writes are atomic**: private temp file, streaming SHA-256, fsync,
  atomic rename, then the database reference in a transaction. Both crash
  orderings (blob without row, row without blob) are tested (§20.4).
- **Concurrent attachment decodes are bounded** — Gmail returns attachments
  base64-encoded inside JSON, which can cost several times the attachment size
  in memory.
- Per-attachment cap (default 25 MB) and a **global physical byte cap** with LRU
  eviction of blob *content*; metadata is retained so the UI can offer
  re-download. *Changed in round 3:* eviction is **global, not per-account** — a
  content-addressed blob can be referenced by several accounts, so per-account
  LRU can evict content another account still needs. Only blobs with no pinned,
  open, export, or outbox reference are evictable.
- **Lazy fetch applies only when `provider_attachment_id` is present.** Parts
  that arrived with inline `data` are persisted at ingest (§12.2).

### 14.6 PII and filesystem discipline

- No email address, subject, or provider id in panel ids, surface targets, route
  paths, query strings, or log lines (§6.2). A P2 lint test greps the built
  route table for `@`.
- **Search moves to `POST`** so query text — which contains names and addresses
  — stays out of URLs, access logs, and browser history (§15.2).
- Logs use `acct_`/`thr_`/`msg_` ids only. A log line needing a subject to be
  useful should be a database query.
- **Log redaction is tested**: authorization codes, client credentials, access
  and refresh tokens, recipient lists, search text, and message content must
  never reach access or error logs. `GmailClient` retry logging is the likely
  leak and gets a dedicated redaction test.
- Error messages returned to clients never echo message content.
- **Directories `0700`, files `0600`**, asserted by a umask test (§7.2).

### 14.7 Deletion, revocation, and export

- **Export** is `POST /export` with an explicit confirm (*changed in round 3*: a
  `GET` that dumps an entire mailbox is cacheable, prefetchable, loggable, and
  CSRF-reachable). Produces a zip of JSON plus attachment blobs. Required for a
  tool holding a copy of someone's mail. Handles insufficient disk space.
- **Forget account is a resumable state machine**, in this order — *fixed in
  round 3*, because draft 1 said "purges + revokes", and revocation needs the
  token that purging destroys:

```txt
1. status = 'deleting'
2. revoke the grant at https://oauth2.googleapis.com/revoke  (token still present)
3. record the revocation result
4. delete the keyring / encrypted-file grant
5. delete rows; collect unreferenced blobs; hard-delete FTS rows (§8.4)
6. record completion in a non-secret audit log
```

  If offline, the user chooses: cancel and retry revocation later, or delete
  locally now **with a clear warning that the remote grant may remain**.
  Revocation matters: deleting a local token silently leaves a live grant on the
  user's Google account forever.
- **Wipe all** enumerates and deletes **every keyring item first**
  (`TokenStore.listAccountIds()`), then closes the worker and database handles,
  then removes the data directory. *Fixed in round 3:* deleting the directory
  first destroys the account ids needed to find the keyring entries, orphaning
  them permanently.
- Each operation is confirmed and reports what it deleted.

### 14.8 Agent read policy

Draft 1 defaulted `agent_readable` to **true**, reasoning that the premise of
Boring Mail is agents reading mail first, so defaulting to off would make the
product not work out of the box.

**Both reviewers rejected that, and on reflection they are right.** "Connect
Gmail" would immediately expose an entire mailbox to whatever agent the
workspace already has — which, under §14.1, may hold shell and network tools.
Consent to *connect an account* is not consent to *pipe it into an agent*.

**Revised default: `agent_readable = 0`.** Onboarding obtains an explicit
per-account choice before any body is returned to an agent. The product may
recommend enabling it and explain why; it must not silently enable it. General
workspace-agent access is a second, separate switch, also default off (§14.4).

This is a **product decision**, so it is also §22 Q7 — the plan states its
recommendation and the reasoning, and the owner decides.

The `mail` tool filters on the flag and **says so when results are filtered**:
silently returning fewer results is worse than reporting "2 accounts excluded by
policy".

---

## 15. HTTP API

All under `/api/boring-mail`, registered via `WorkspaceServerPlugin.routes`
(§2.3). Request/response types live in `src/shared/api.ts` and are imported by
both `useMailApi.ts` and the handlers, so contract drift is a typecheck error.

### 15.1 Accounts

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/accounts` | id, email, displayName, status, statusDetail, scopes, sendAs, agentReadable, lastOkSyncAt, syncProgress |
| `POST` | `/accounts/connect/start` | `{clientId, clientSecret}` → `{authUrl, flowId}`; binds the loopback (§10.2) |
| `GET` | `/accounts/connect/:flowId/status` | `pending \| completed \| failed \| expired` |
| `POST` | `/accounts/connect/:flowId/code` | Paste-the-code fallback for remote/headless (§10.2) |
| `POST` | `/accounts/:id/reauth/start` | Re-consent; `login_hint`; `sub` bound (§10.3) |
| `PATCH` | `/accounts/:id` | `{displayName?, agentReadable?}` |
| `POST` | `/accounts/:id/disconnect` | Revoke **then** purge tokens; retain mail |
| `POST` | `/accounts/:id/forget` | Resumable delete state machine (§14.7) |

### 15.2 Mail

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/threads` | `?accounts=&view=&tags=&triage=&limit=&cursor=` — keyset + `listGeneration` (§6.5) |
| `GET` | `/threads/:id` | Thread + messages + attachment metadata |
| `GET` | `/messages/:id/body` | Returns a cached body, or `BODY_NOT_CACHED` |
| `POST` | `/messages/:id/fetch` | Enqueues an authenticated provider fetch |
| `GET` | `/attachments/:id/content` | Streams an **already cached** blob |
| `POST` | `/attachments/:id/fetch` | Enqueues an authenticated provider fetch |
| `POST` | `/search` | Body is JSON — keeps names and addresses out of URLs and logs (§14.6) |
| `POST`/`DELETE` | `/threads/:id/tags[/:tagId]` | Local tags |
| `PATCH` | `/threads/:id/local-state` | `{triage?, pinned?, snoozedUntil?}` |
| `GET`/`POST`/`PATCH`/`DELETE` | `/views` | Saved views |

*Changed in round 3:* draft 1 had `GET` routes that **triggered** provider
fetches. A `GET` with side effects is prefetchable, cacheable, and reachable by
cross-site navigation. Reads and fetch-triggers are now separate verbs.

### 15.3 Sync and send

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/sync/status` | Per account: mode, cursor age, snapshot state, backfill progress, failures, next attempt, quota headroom, measured throughput/ETA |
| `POST` | `/sync/:accountId/run` | Manual sync; rate-limited 1 per 10 s per account |
| `POST` | `/sync/:accountId/snapshot` | Force a full snapshot (§11.4); explicit confirm flag |
| `POST` | `/drafts` | Existing route, extended with `account` and `from` |
| `POST` | `/outbox` | Create from a draft → `{outboxId, status, contentDigest}` |
| `POST` | `/outbox/:id/approve` | **Issues and consumes** a single-use capability (§13.6) |
| `POST` | `/outbox/:id/decide` | Resolve an `unknown` send: wait / mark sent / retry (§13.5) |
| `GET` | `/outbox` | List with status |
| `DELETE` | `/outbox/:id` | Cancel while `pending_approval` |
| `POST` | `/export` | §14.7 |

### 15.4 Cross-cutting route rules — authentication and CSRF

*Added in round 3.* Draft 1 had no authentication or CSRF model at all, while
exposing send, disconnect, revoke, forget, export, resync, and OAuth
client-secret submission on local HTTP. Opaque ids are **not** authorisation, and
a malicious web page can target localhost; CORS alone does not prevent
navigations, form submissions, or DNS rebinding.

- **Never expose Boring Mail routes on an unauthenticated `0.0.0.0` listener.**
  Bind per the host's authenticated local-session model.
- **Require the host's authenticated UI session on every route.** Which
  mechanism that is, is §22 Q3 — a gate, not a detail.
- **Origin/Host validation and CSRF protection on every state-changing
  request.** DNS-rebinding defence via strict `Host` checking.
- **No permissive CORS.**
- **Agent tools call service methods directly.** They never receive a browser
  session and never receive a send-approval capability (§13.6).
- Request-body, query, response-size, concurrency, and rate limits configured.
- Every handler validates input with an explicit Fastify JSON schema — not
  hand-written `typeof` chains, which is what the current single route does and
  what must not be scaled up.
- **Every id path parameter is validated against its prefix pattern**
  (`^acct_[0-9a-f]{32}$`) before reaching the store.
- Errors return `{error: {code, message}}` with a stable machine-readable
  `code`; the front-end switches on `code`, never on message text.
- No route returns raw provider ids or unsanitised HTML. Ever.
- Long operations (connect, snapshot, export) are **started** by a POST
  returning a handle; progress is polled. No long-held connections, which a
  hot-reloading dev server breaks constantly.

---

## 16. Front-End UX

### 16.1 Source pane

```txt
┌────────────────────────────────────────┐
│ [All accounts ▾]              [+ New]  │  switcher hidden when n=1
├────────────────────────────────────────┤
│ 🔍 from:alice has:attachment           │  operator-aware (§8.2)
├────────────────────────────────────────┤
│ [Inbox ▾]  #needs-reply  #invoices  +  │  view dropdown + LOCAL tag chips
├────────────────────────────────────────┤
│ ● Utility Billing        14:41  📎     │  ● unread — READ-ONLY (§9.3)
│   Solar production invoice — June      │
│   work ▪ #invoices                     │  account label only when n>1
├────────────────────────────────────────┤
│   Property Scout         15:19         │
│   Two new saved-search matches         │
│   personal ▪ #real-estate              │
├────────────────────────────────────────┤
│ ⚠ 1 message awaiting your approval  →  │  in-plugin approval (§13.6)
│ ⟳ work: 1,204 msgs · ~14/min · ~40 min │  measured, not promised (§2.2)
└────────────────────────────────────────┘
```

- Account switcher and per-row account label appear only with >1 account.
  Chrome carrying no information is noise.
- `needs_reauth` shows an inline banner with Reconnect, above the list — not a
  modal. Modal-blocking a mail app because one of three accounts needs a token
  refresh is disproportionate.
- **Windowed infinite scroll**, not proportional-scrollbar virtualisation
  (§6.5). Handles a 50,000-thread account; jump-to-index is out of scope.
- `CURSOR_STALE` restarts the list from the top, preserving scroll position by
  thread id where possible.
- Empty states are **distinct**, each saying what to do: *no accounts
  connected*, *account syncing (headers only so far)*, *no results for this
  filter*, *account disconnected*. A single generic "No mail" for four
  situations is how a working app looks broken.
- Search results show `coverage` (§8.3) when it is not `complete`.

### 16.2 Thread panel

- One tab per thread; re-opening focuses rather than duplicating.
- Header: subject, participants (name **and** address, §12.4), account badge,
  local tags, triage control.
- Messages collapsed except the most recent; quoted chains behind a "show
  trimmed content" toggle.
- Body rendered per §14.3 in a fixed-height sandboxed frame.
- Remote-content bar when `body_blocked_remote`.
- Attachments listed with name, type, size, and an explicit download action.
  Never auto-downloaded.
- Reply / Reply-all / Forward create a `.mail.md` draft pre-filled with the
  correct `account` and `from` front matter (§13.3).
- Degraded mode when the account is disconnected: cached content, a banner,
  reply disabled with a reason (§6.3).

### 16.3 Connect / account panel

A `workspace-page` panel: connected accounts with status and last sync; the
Connect flow with the BYO-client walkthrough (§10.1); per-account settings
(display name, `agent_readable`, sync window, send-as identities); danger zone
(disconnect, forget, export).

The walkthrough is numbered, links directly to the right Cloud Console pages,
states the OAuth client type (**Desktop app**), and shows the exact scopes to be
requested. A vague "set up OAuth" step is where this product loses users.

### 16.4 First-run

1. Mail source opens with a single "Connect a Gmail account" call to action.
2. Walkthrough → consent → bootstrap.
3. **Render the first useful page of recent mail as soon as it is available**,
   with sync visibly continuing. *Changed in round 3:* draft 1 promised
   "browsable in < 60 s", which is not defensible when it depends on fetching up
   to 2,000 full messages at an adaptive concurrency against a shared quota.
   Measure p50/p95 against a seeded integration account and report a dynamic
   ETA; do not block usability on completion.
4. A one-time note states three things a user needs before trusting the tool
   with their mail: read-only access (§9.3), the reconnect cadence (§10.5), and
   that agent access is **off** until they turn it on (§14.8). Buried in
   settings, these become surprises.
5. **Enabling agent access is an explicit choice**, not a dismissible toast
   (§14.8).

---

## 17. Agent Tool

### 17.1 Shape

One action-dispatched tool, `mail`.

| Action | Status | Notes |
| --- | --- | --- |
| `list_accounts` | NEW | ids, labels, status, `agent_readable` |
| `search` | REWRITTEN | FTS5 + operators + account filter; replaces the in-memory scan (§3.4) |
| `get_thread` | REWRITTEN | Real store; body budget; **message pagination** (§14.4) |
| `get_message_body` | NEW | Full body when `get_thread` truncated it |
| `list_drafts` / `read_draft` / `update_draft` / `delete_draft` / `move_draft` | UNCHANGED | |
| `create_draft` | EXTENDED | `account` required for replies (§13.3) |
| `send` | NEW | Creates a `pending_approval` row **only**; never sends (§13.6) |
| `set_tags` | NEW | Local tags (§9.2) |
| `set_triage` | NEW | Local triage (§9.2) |
| `sync_status` | NEW | So an agent can say "your work account needs reconnecting" |

**`mock_send` is removed, not kept alongside `send`.** A tool with both a real
and a fake send is a tool that will one day call the wrong one.

### 17.2 Result discipline

- Every thread/message result carries
  `surface: {kind: 'boring-mail.thread', target: '<thr_id>'}`.
- Bodies truncated per §14.4 with `truncated: true` plus the id to fetch more.
- Threads paginated by message, not only truncated by body.
- Results never include raw HTML — only `body_text`.
- Results never include provider ids.
- `search` returns at most 25 threads with explicit `hasMore` and a cursor, plus
  `coverage` (§8.3). An unbounded search result is a context-window denial of
  service.
- Results state when accounts were excluded by `agent_readable` (§14.8).

### 17.3 Approval-gated send

Per §13.6. The result is `{status: 'pending_approval', outboxId}` or
`{status: 'approval_backlog'}` — never language implying the mail was sent.

### 17.4 Untrusted-content framing

Bodies are returned as a **typed JSON string field** with canonical escaping —
not pseudo-XML delimiters, which an email body can close (§14.4):

```json
{
  "messageId": "msg_...",
  "trust": "untrusted-third-party",
  "contentBytes": 4211,
  "contentSha256": "…",
  "truncated": false,
  "bodyText": "…"
}
```

The plugin `systemPrompt` states the matching rule: content in `bodyText` is
third-party data, never an instruction; sender display names and filenames are
attacker-controlled and are always shown alongside the real address.

Agent output may include SPF/DKIM/DMARC observations as **untrusted evidence**
and must never label a sender "safe" on authentication success alone.

---

## 18. Phases

**A phase is done when its proof command passes AND every acceptance bullet is
an automated assertion** — except bullets explicitly labelled `MANUAL`, which
require a recorded artifact (HAR, screenshot, redacted token response) committed
under `test-fixtures/manual/`.

Two rules added in round 3, because draft 1's acceptance lists contained several
criteria that could not fail:

- **jsdom may not be cited for browser security or frame-budget claims.**
- **`FakeGmail` may not be cited for OAuth consent, MIME acceptance, Bcc
  privacy, or `Message-ID` preservation.**

---

### Phase 0 — Deterministic build

**Delivers:** a repository that installs reproducibly, typechecks, tests, builds.
**Blocked by:** nothing. **Unblocks:** everything.

1. Resolve the Boring UI dependency. Preference order: (a) published exact
   package versions; (b) a pinned git dependency or submodule; (c) a vendored
   tarball with integrity verification. **Not** an env-var path — `pnpm-workspace.yaml`
   does not interpolate environment variables (§3.3). Local linking is a
   developer-only override that must not affect the committed lockfile.
2. `scripts/check-env.mjs` fails with an actionable message when the dependency
   is missing, so the next occurrence is an error rather than a dangling symlink.
3. `.gitignore` covers `.boring/` as well as `app/.playground/`.
4. CI: install, typecheck, test, build — **with no sibling checkout and no
   machine-specific environment variable**.

**Proof**, in a clean temporary clone:
`pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build`

*Changed in round 3:* draft 1 proved with `--no-frozen-lockfile`, which proves
the opposite of reproducibility — it permits the lockfile to be rewritten to fit
whatever is present.

**Acceptance:** a fresh clone on a machine without the sibling checkout either
works or fails naming exactly what to do.

---

### Phase 1 — Contract gates and plugin seam

**Delivers:** every unresolved external contract answered, plus the plugin
cleanup. **Blocked by:** 0. **Unblocks:** everything else.

*Added in round 3.* Draft 1 spread these questions across the plan and deferred
the most important to Phase 8 while making Phase 7 depend on it. **No
implementation proceeds while these are open.**

1. **`ask-user` server contract spike** (§13.6): raise a question from a server
   plugin with a surface target, receive and validate the answer capability,
   confirm single use. If it needs a Boring UI PR, say so now.
2. **Host session / CSRF / origin contract** (§15.4, §22 Q3).
3. **Agent capability boundary** (§14.1, §22 Q1): does the workspace agent have
   shell/filesystem/network tools? Determines whether `agent_readable` and the
   approval gate are security controls or UX guardrails.
4. **Data root decision** (§7.2, §22 Q2) and the OS user-data-dir resolution
   per platform.
5. **`TokenStore.probe()` reality check** on a headless Linux box without a
   Secret Service (§2.2 UNVERIFIED).
6. **`gmailQuota.ts`** with cited constants and the tripwire test (§2.2).
7. Delete `src/plugin-host/` and `src/mail/plugin.ts`; delete the
   `src/server/*` stubs; move `mockData.ts` to `test-fixtures/`.
8. Add `src/shared/api.ts` and `src/shared/ids.ts` (32-hex, §6.2).
9. Fix the draft-filename collision in `front.tsx` and `mailAgentTool.ts` (§3.4).
10. Front-plugin capture test with `captureFrontPlugin` asserting **2 panels**
    (thread, draft-file) and 2 surface resolvers. *Fixed in round 3:* draft 1
    asserted 3 panels, but `ConnectAccountPanel` does not exist until P3.

**Proof:** `pnpm test -- --run boring-mail-plugin boring-mail-quota`
**Acceptance:** `grep -rn "mockData" boring-mail/src/` returns nothing; the
capture test passes; every §22 gate question has a recorded written answer.

---

### Phase 2 — Storage service

**Delivers:** the storage worker, schema, migrations, FTS, blobs.
**Blocked by:** 1. **Unblocks:** 3A, 3B, 4.

1. `storage/worker/` — dedicated `worker_threads` worker, one `DatabaseSync`
   connection, serialised writes, bounded cancellable jobs (§7.1).
2. `MailStore` async RPC facade with request ids, timeouts, backpressure.
3. OS single-writer lock; `MAIL_STORE_ALREADY_ACTIVE` (§7.1).
4. `001_initial.sql` (§7.3): composite FKs, `row_id`, `deleted_at` on messages,
   `last_seen_generation`, `mail_blobs`, `mail_message_addresses`,
   `mail_outbox(+_attachments)`, snapshot columns, CHECK constraints.
5. PRAGMAs on every connection **before** migrations; pre-migration backup that
   aborts on failure (§7.4).
6. `BlobStore` — atomic put, get, has, global LRU GC (§14.5).
7. Upserts with `ON CONFLICT ... RETURNING id` (§11.7).
8. Keyset pagination with `listGeneration` / `CURSOR_STALE` (§6.5).
9. FTS write path incl. explicit `'delete'` on update and hard delete (§8.4);
   operator parser and query builder (§8.2).
10. `0700`/`0600` file modes (§14.6).

**Proof:** `pnpm test -- --run boring-mail-storage`

**Acceptance:**
- Migration test asserts every table, index, CHECK, composite FK, and the FTS table.
- **FK enforcement test**: inserting a message whose `(thread_id, account_id)`
  crosses accounts is rejected **by the database**.
- **PRAGMA trap test**: opening the file directly, bypassing `open()`, shows
  `foreign_keys` OFF (§7.4).
- Idempotency: ingest the same fixture thread 3× → 1 thread, N messages, local
  ids unchanged.
- **FTS lifecycle**: insert, update, soft delete, restore, hard delete,
  `'rebuild'`, `integrity-check`, reopen, and `VACUUM` — all leave `MATCH`
  results correct. `snippet()` over a known fixture returns the expected
  fragment. Delete a message and insert a new one: new `row_id`, no leaked hits.
- FTS input: over-limit queries rejected fast with `SEARCH_QUERY_TOO_LARGE`; the
  generated `MATCH` string is asserted exactly; an exclusion-only query is valid.
- Keyset pagination: stable over an immutable generation; mutation produces
  `CURSOR_STALE`.
- Upsert helpers **never** write `mail_thread_local_state` or `mail_thread_tags`
  (a static check — the resync-preservation behaviour itself is a P5 test).
- **Event loop**: while a 5,000-message ingest transaction runs, a health route
  on the main thread stays under 50 ms and a `GET /threads` issued after it is
  accepted and completes.
- Two accounts ingesting concurrently never open a second writer.
- `0700`/`0600` verified under a permissive umask.

---

### Phase 3A — OAuth and grants

**Delivers:** connecting a real Gmail account and holding the grant safely.
**Blocked by:** 1, 2. **Unblocks:** 4. **Parallel with 3B.**

1. `TokenStore`, both backends, `probe()`, passphrase lifecycle, `listAccountIds()` (§10.4).
2. `GoogleOAuthClient` — loopback + PKCE + nonce + state, five-minute one-shot
   deadline, 128-bit `flowId` (§10.2).
3. **Full ID-token validation**: JWKS signature, `iss`, `aud`, `exp`/`iat`,
   `nonce`, `sub` (§10.3).
4. Re-auth: `login_hint`, `prompt=consent`, **fail closed on `sub` mismatch**.
5. Granted-scope verification against requested (§10.2).
6. Refresh error classification; `invalid_grant` → `needs_reauth`; a response
   without a new refresh token is not an error (§10.5).
7. Non-local origin detection + paste-the-code fallback (§10.2).
8. Account routes incl. **revoke-then-purge** ordering (§14.7).
9. `ConnectAccountPanel` + `docs/gmail-setup.md`.

**Proof:** `pnpm test -- --run boring-mail-oauth`

**Acceptance:**
- Against a fake authorization server: happy path; `state` mismatch rejected;
  **`state` length mismatch does not throw** (`timingSafeEqual` throws on
  unequal lengths — check length first); deadline closes the listener; a second
  callback is rejected; the callback page echoes no query parameter.
- ID token: bad signature, wrong `iss`, wrong `aud`, expired, and **wrong
  `nonce`** each rejected.
- **Re-auth with a different `sub` writes no tokens, keeps the same `acct_` id,
  ingests nothing, and names both addresses in `status_detail`.**
- Declined `gmail.send` connects the account with send disabled and an explanation.
- `TokenStore` round-trips in both backends; `probe()` reports accurately when
  the keyring is unavailable; a keyring locked *after* startup pauses sync
  rather than moving accounts to `needs_reauth`.
- Non-local UI origin refused with a specific error; the paste-code path works.
- Log redaction: no code, secret, or token in any log (§14.6).
- **`MANUAL`:** connect a real Gmail account end to end; commit the redacted
  token-response artifact. *Changed in round 3:* draft 1 left this outside the
  proof command, so the phase could merge having never obtained a refresh token
  — the exact thing the 7-day risk depends on.

---

### Phase 3B — Gmail transport and normalisation

**Delivers:** the Gmail network module and Gmail JSON → domain types. No sync loop.
**Blocked by:** 1, 2. **Unblocks:** 4. **Parallel with 3A.**

1. `GmailClient`: `getProfile`, `messages.list/get`, `threads.get`,
   `history.list`, `messages.attachments.get`, `messages.send`. Injectable
   transport with timeout, response-size limits, abort, and log redaction.
   **No batch** (§2.2 UNVERIFIED).
2. `gmailErrors.ts`: the full §11.5 table, full jitter, `Retry-After`.
3. `gmailNormalize.ts`: part-tree walk (§12.2) with pinned libraries for
   header/address/charset (§12.1); **single** base64url decode; MIME bounds;
   `internalDate`; per-message label capture.
4. `Sanitizer`: allow-list, quarantine, `sanitizer_version`, remote blocking (§12.3).
5. `gmailSendAs.ts`: enumerate authorised identities, or record that the scope
   does not permit it (§13.3, §2.2 UNVERIFIED).
6. A **fixture corpus** of ≥30 captured, redacted payloads covering every §12.2
   case — including bounces, `message/rfc822`, non-UTF-8 charsets, calendar
   invites, and Gmail drafts.

**Proof:** `pnpm test -- --run boring-mail-gmail`

**Acceptance:**
- Every §12.2 case has a fixture and a passing assertion.
- **No double-decode**: a part whose decoded bytes still contain a
  `Content-Transfer-Encoding` header is not re-decoded.
- XSS corpus neutralised: `javascript:`, `&#106;avascript:`, `<svg onload>`,
  `<style>@import`, `<base href>`, `srcset`, `poster`, CSS URLs.
- Sanitiser versioning: bump `CURRENT`, serve a fixture stored under `vN-1`,
  assert the new policy applied **without calling Gmail**.
- Remote images blocked by default; `cid:` preserved for parent blob resolution.
- MIME bounds: a depth bomb, a 10,000-recipient header, and a part-count bomb
  each produce a safe partial message, not unbounded work.
- One test per error-classification row.
- **Zero direct network calls outside `GmailClient.ts` and
  `GoogleOAuthClient.ts`** (§5.2 rule 1). *Fixed in round 3:* draft 1's
  "zero fetch outside GmailClient" contradicted OAuth.

---

### Phase 4 — Bounded read vertical slice

**Delivers:** connect one account, ingest a recent window, browse and search it.
**Blocked by:** 2, 3A, 3B. **Unblocks:** 5, 6.

*Added in round 3.* Draft 1 went from `GmailClient` straight to a complete sync
engine, so nothing was demonstrably working until a very large phase landed.
This is the first end-to-end proof.

1. `SyncSupervisor` / `SyncWorker` skeleton, per-account mutex, self-scheduling
   timeout, singleton guard, clean shutdown (§11.6).
2. `bootstrap.ts` — historyId **first**, `messages.get` on discovered ids only,
   history drained before `active` (§11.3).
3. `QuotaGovernor` — per-minute + per-second, 30% foreground reserve, adaptive
   concurrency (§11.5).
4. Minimal read routes and a minimal source pane against real data.

**Proof:** `pnpm test -- --run boring-mail-bootstrap`

**Acceptance:**
- Against `FakeGmail`: connect → bootstrap → threads listed → FTS search hits.
- historyId is persisted **before** ingestion; a crash mid-ingest loses no
  subsequent messages.
- The bootstrap cap is respected on a fixture mailbox with a 200-message thread
  containing one recent reply — **the case draft 1's `threads.get` strategy
  would have blown**.
- Governor: a saturating ingest still lets a foreground thread-open complete
  within one budget window; no single tick exceeds the per-second clamp.
- Supervisor shutdown clears the timer and closes the worker; **two `routes()`
  registrations produce exactly one poller**.
- Sync logic contains no `Date.now()` / `Math.random()` (grep).

---

### Phase 5 — Complete sync

**Delivers:** incremental, snapshot recovery, backfill, multi-account, crash and
suspend recovery. **Blocked by:** 4. **Unblocks:** 9.

1. `incremental.ts` — all four record types, **cursor advanced only after the
   final page**, per-message labels with **thread aggregation** (§11.4).
2. `snapshot.ts` — generation-based mark and sweep, `includeSpamTrash=true`,
   sweep only after a complete enumeration commits (§11.4).
3. `backfill.ts` — durable `before:` date cursor, page token as hint only,
   yields to foreground (§11.5).
4. Sync routes and status incl. measured throughput and ETA (§15.3).
5. Rewrite the `mail` tool's `search` / `get_thread` onto the store (§17.1).

**Proof:** `pnpm test -- --run boring-mail-sync`

**Acceptance:**
- **Snapshot safety, the headline test.** Fixture: 5,000 messages over 2 years;
  bootstrap cap 200. Inject a `history.list` 404 after 200 are ingested. Assert:
  (a) **zero** rows gain `deleted_at` before the enumeration completes;
  (b) crashing the enumeration at page 2/N and restarting still sweeps nothing;
  (c) after a complete enumeration, **only** ids the fake provider actually
  removed are soft-deleted and the other ~4,800 remain visible;
  (d) spam and trash messages are not mistaken for deleted.
- Snapshot writes nothing to `mail_thread_local_state`, `mail_thread_tags`, or
  the workspace overlay.
- **Label aggregation:** a 2-message thread with both unread; remove `UNREAD`
  from one; the thread is **still unread**. Same for starred and each mailbox flag.
- History pagination: a crash mid-page-set does not advance the cursor and loses
  no records.
- Backfill resumes from the durable date cursor after a simulated crash **and
  after an invalidated page token**.
- A `messagesDeleted` record for a never-ingested id is a no-op and does not
  increment `consecutive_failures`.
- Two accounts sync independently; one in `needs_reauth` does not stall the other.
- Suspend/resume triggers an immediate coalesced sync; triggers never overlap.

---

### Phase 6 — Read API surface and agent tool

**Delivers:** the full read API, search, attachments, agent tool.
**Blocked by:** 4. **Unblocks:** 7, 8. **Parallel with 5.**

1. All §15.1–15.2 routes with §15.4 auth, CSRF, origin, and limits.
2. `POST /search` with the operator parser, address-table filters, `coverage`,
   both cursors (§8).
3. Lazy attachment fetch split into read vs fetch verbs (§15.2); atomic blob
   writes; global LRU (§14.5).
4. Agent tool: typed untrusted framing, truncation, message pagination,
   `agent_readable` filtering with disclosure (§17).

**Proof:** `pnpm test -- --run boring-mail-api boring-mail-agent-tool`

**Acceptance:**
- Every state-changing route rejects a missing/invalid CSRF token and a
  cross-origin `Origin`; a `Host` not matching the bound origin is rejected.
- Every id parameter pattern-validated; a malformed id never reaches the store.
- Agent tool results contain no raw HTML, no provider ids, and correct
  `truncated`/`coverage` flags.
- An email body containing `</untrusted-email-content>` cannot break framing
  (§17.4).
- Attachment: declared size smaller than actual bytes is rejected against the
  **received** byte count.
- Blob crash orderings: blob-without-row and row-without-blob both recover.

---

### Phase 7 — Browser UI, security and scale

**Delivers:** the workbench on real data, browser-tested.
**Blocked by:** 6. **Unblocks:** 8.

1. `useMailApi.ts`; `MailSourcePane` rewrite — server-backed, windowed infinite
   scroll, account switcher, operator search (§16.1).
2. `MessageBody.tsx` — the §14.3 frame, parent-resolved `cid:` blob URLs, fixed
   height, separate remote-image document.
3. Delete `renderMarkdownInline` (§3.4).
4. `AttachmentList`, remote-content bar, degraded mode, reply pre-fill.
5. Fix the silent `openPanel?.()` no-op (§3.4).
6. Four distinct empty states; `CURSOR_STALE` handling; `coverage` display.

**Proof:** `pnpm test -- --run boring-mail-ui` **plus** a Playwright suite.

**Acceptance (Playwright/Chromium, not jsdom):**
- XSS corpus: no script execution, no unexpected network request, no top
  navigation, links open only on a user gesture.
- `cid:` images render from blob URLs without exposing unauthenticated
  attachment URLs; remote images stay blocked until explicit action.
- A 1.5 MB newsletter falls back rather than producing an empty `srcdoc`.
- A 50,000-thread account scrolls without a frame-budget violation.
- **No star or mark-read control exists anywhere** (§9.3) — asserted, because
  this is exactly what a well-meaning future contributor adds back.
- Each empty state renders its own copy; switcher/labels appear only with >1
  account.

---

### Phase 8 — Approval-gated send

**Delivers:** real outbound mail. **Blocked by:** 1 (ask-user gate), 3A, 5, 6, 7.

*Re-blocked in round 3:* draft 1 listed only "3, 6", omitting P5 even though its
reconciliation depends on sync, and omitting the ask-user gate entirely.

1. Spike and decide `MailComposer` vs hand-rolled; record the decision here.
2. `gmailCompose.ts` → base64url RFC 822.
3. Reply threading: all four signals (§13.3).
4. Send-as resolution and authorisation (§13.3).
5. Outbox: digest, single-use capability, lease, `unknown` state, bounded
   reconciliation, human decision route (§13.5, §13.6).
6. `ApprovalBanner.tsx` in-plugin approval surface; `ask-user` if P1 proved it.
7. `mail.send` tool action; **remove `mock_send`**.

**Proof:** `pnpm test -- --run boring-mail-send`

**Acceptance:**
- Composed output byte-compared against golden RFC 822 fixtures: ASCII, UTF-8
  subject, UTF-8 body, attachment, reply-with-references.
- Reply sets all four threading signals.
- **From-account for a reply is always the thread's account**; a request
  attempting to override it fails closed. An unauthorised `send_as_address`
  fails closed.
- Direct `POST /outbox/:id/approve` without a capability fails. Replayed,
  expired, wrong-session, wrong-outbox, and stale-digest capabilities all fail.
- Changing **any** covered field (to/cc/**bcc**/subject/body/attachments/account/
  send-as) after approval invalidates it.
- Concurrent workers claim an approved row **once**.
- Double-submit of one idempotency key produces exactly one send.
- **Crash injected immediately after the fake provider accepts but before the
  local success commit: restart reconciles and does NOT resend.**
- An ambiguous failure yields `unknown` and **never** auto-retries.
- Agent-initiated send never reaches `messages.send` — asserted at the
  `GmailClient` boundary.
- A 6th `mail.send` returns `approval_backlog`.
- `grep -rn "mock_send" boring-mail/src/` returns nothing.
- **`MANUAL`, against a dedicated integration Gmail account:** Gmail accepts the
  MIME; **`Message-ID` preservation confirmed or the fallback documented**
  (§2.2); Bcc privacy verified; reply lands in the right thread;
  `rfc822msgid:` search finds the sent message. Artifacts committed.

---

### Phase 9 — Lifecycle and attention projection

**Delivers:** the Chief-of-Staff layer and operational completeness.
**Blocked by:** 5, 7, 8.

*Promoted in round 3.* Draft 1 buried attention projection at the end of a
grab-bag phase behind export, LRU, and an optional batch optimisation — so v2
could have shipped as a read-only Gmail viewer and been called done. **Attention
projection is the differentiating feature; it is not "hardening".**

1. **Attention projection.** Curated threads → `ask-user` items carrying a
   `boring-mail.thread` artifact ref. It accepts **proposals, not arbitrary
   final Inbox items**, and enforces: per-account and global rate limits;
   idempotency by (thread, message, rule revision, workspace); provenance
   (rule, agent, model, timestamp); dismissal suppression; **no raw HTML**;
   sender address shown with display name; untrusted content visually separated
   from workspace instructions; and **no send-approval wording or controls in
   ordinary attention items** (§13.6 owns those). `mail_attention_links`
   includes `workspace_id`, so projecting into one workspace does not suppress
   it in another.
2. Constrained mail-triage agent config via `agentConfigContract` (§14.4).
3. Export / disconnect / forget / wipe state machines (§14.7).
4. Blob GC and global LRU (§14.5).
5. Metrics and a sync health panel.
6. Re-verify the Gmail batch endpoint (§2.2); adopt only if it reduces
   wall-clock without changing quota cost.
7. Optional: per-sender remote-image allow-list; a real CSS sanitiser to restore
   sender styling (§12.3).

**Proof:** `pnpm test -- --run boring-mail-attention boring-mail-lifecycle`

**Acceptance:** projection is idempotent across repeated runs and across
workspaces; a prompt-injected body cannot produce an attention item that mimics
a send approval; export round-trips and handles a full disk; forget leaves no
orphan blobs, revokes the grant, and resumes correctly after an interrupted
delete; wipe removes keyring entries **before** the data directory.

---

## 19. Dependency Graph

```txt
                    ┌──────────────────────┐
                    │ P0  deterministic    │
                    │     build            │
                    └──────────┬───────────┘
                               ▼
                    ┌──────────────────────┐
                    │ P1  CONTRACT GATES   │  ask-user · host session ·
                    │     + plugin seam    │  agent boundary · data root ·
                    └──────────┬───────────┘  keyring · quota constants
                               ▼
                    ┌──────────────────────┐
                    │ P2  storage service  │
                    └──────────┬───────────┘
                    ┌──────────┴───────────┐
                    ▼                      ▼
          ┌──────────────────┐   ┌──────────────────────┐
          │ P3A OAuth+grants │   │ P3B Gmail transport  │
          └─────────┬────────┘   │     + normalisation  │
                    │            └──────────┬───────────┘
                    └──────────┬────────────┘
                               ▼
                    ┌──────────────────────┐
                    │ P4  bounded read     │  ← first end-to-end proof
                    │     vertical slice   │
                    └──────────┬───────────┘
                    ┌──────────┴───────────┐
                    ▼                      ▼
          ┌──────────────────┐   ┌──────────────────────┐
          │ P5 complete sync │   │ P6 read API + agent  │
          └─────────┬────────┘   └──────────┬───────────┘
                    │                       ▼
                    │            ┌──────────────────────┐
                    │            │ P7 browser UI        │
                    │            └──────────┬───────────┘
                    │                       ▼
                    │            ┌──────────────────────┐
                    │            │ P8 approval-gated    │
                    │            │    send  (also ← P1, │
                    │            │    P3A, P5)          │
                    └────────────┴──────────┬───────────┘
                                            ▼
                                 ┌──────────────────────┐
                                 │ P9 lifecycle +       │
                                 │    ATTENTION         │
                                 └──────────────────────┘
```

The chain is deep and largely serial — honestly so: you cannot test a sync
engine without a store, or build a store without knowing what normalisation
produces. Round 3 added the two parallel opportunities that do exist (3A ∥ 3B,
5 ∥ 6) and inserted P4 so something works end to end early.

Parallelisable work *inside* phases:

- P2: schema/migrations ∥ operator parser ∥ blob store ∥ worker RPC.
- P3B: fixture corpus ∥ sanitiser ∥ error table.
- P5: incremental ∥ snapshot ∥ backfill, once `SyncWorker`'s interface is fixed.
- P7: every component, once `useMailApi` exists.

If materialised as beads (`docs/procedures/bead-ready.md`), the graph above is
the edge set and the splits above are the parallel work items. **P2, P5, P7, and
P8 are each larger than one session and must be split further at bead time.**

---

## 20. Testing Strategy

### 20.1 What gets tested where

| Layer | Approach | No network |
| --- | --- | --- |
| Operator parser, normalisation, compose | Pure unit, table-driven | ✅ |
| `MailStore` / storage worker | Real SQLite, temp dir | ✅ |
| `GmailClient` | Injected transport returning fixtures | ✅ |
| `GoogleOAuthClient` | Fake authorization server + fake JWKS | ✅ |
| Sync engine | `FakeGmail` implementing `MailProvider` | ✅ |
| Routes | Fastify `inject()` incl. CSRF/origin | ✅ |
| **Browser security, frame budget** | **Playwright / Chromium** | ✅ |
| Component logic | `@testing-library/react` + jsdom | ✅ |
| Real Gmail | `MANUAL`, per phase, artifact committed | ❌ |

**The entire automated suite runs with no network and no Google account.** A
suite needing credentials is a suite that stops being run. The `MANUAL` bullets
are the deliberate, bounded exception, and each requires a committed artifact.

**Two prohibitions** (§18): jsdom may not be cited for browser security or frame
budget; `FakeGmail` may not be cited for OAuth consent, MIME acceptance, Bcc
privacy, or `Message-ID` preservation.

### 20.2 `FakeGmail`

A deterministic in-memory Gmail: threads, messages, per-message labels, a
monotonic `historyId`, paginated `history.list` and `messages.list`, and
**injectable failures** — rate limits, `Retry-After`, 404 on `history.list`,
expired page tokens, `invalid_grant`, timeouts, truncated bodies, and
accept-then-crash on send. The §11.5 and §13.5 paths are the most likely to be
wrong and least likely to be exercised by hand; making them trivially
reproducible is what makes them testable at all.

### 20.3 Fixture corpora

`test-fixtures/gmail/` — redacted real payloads. Redaction: real addresses →
`*@example.test`, real names → generated, bodies → synthetic text of the same
shape, attachment bytes → zeroes of the same length. **Structure is preserved
exactly**, because structure is what is under test.

**A committed fixture containing a real email address is a privacy incident** —
CI greps fixtures for non-`example.test` domains.

`test-fixtures/hostile/` — XSS payloads, prompt-injection payloads (including a
body that closes a delimiter, §17.4), path-traversal and RFC 2047 filename
bombs, zip bombs, oversized attachments, 10,000-recipient headers, deeply nested
MIME, and malformed charsets. Every one asserts a **specific safe behaviour**,
not merely "does not throw".

`test-fixtures/manual/` — committed artifacts backing every `MANUAL` acceptance
bullet.

### 20.4 Fault-injection matrix

*Added in round 3.* Every durable workflow defines crash points and asserts
restart behaviour:

| Workflow | Required fault points |
| --- | --- |
| OAuth | before token exchange · after exchange · before keyring write · after keyring write |
| Bootstrap | before historyId persist · after historyId, before ingest · mid-ingest |
| Incremental | mid-page-set · after apply, before cursor advance |
| Snapshot | every page boundary · immediately before the sweep · during the sweep |
| Backfill | mid-page · after page, before cursor · with an invalidated page token |
| Blob | before temp write · mid-stream · after rename, before DB row · after DB row, before rename |
| Send | before claim · after claim · **after provider accept, before local commit** · during reconciliation |
| Forget | before revoke · after revoke · before token delete · during row/blob deletion |

Also injected: `SQLITE_FULL`, read-only filesystem, corrupt database, failed WAL
checkpoint, migration-backup failure, insufficient disk for backup or export,
keyring locked after startup, OAuth port unavailable, browser never launched,
MFA exceeding the deadline, OS suspend during refresh or send, and concurrent
supervisor startup.

**The governing invariant: no cursor, approval, or deletion marker advances
unless the data it represents is durably committed.**

---

## 21. Accepted Limitations

Recorded so nobody rediscovers them as bugs.

1. **Weekly reconnect** per account in the default Testing-status deployment
   (§10.5) — documented, warned, one click. Not universal: Internal and
   Production projects differ (§2.2).
2. **No write-back to Gmail** (§9): no mark-read, star, archive, or delete.
3. **BYO OAuth client** — a real ~5-minute first-run cost (§10.1).
4. **Client-id rotation** requires explicit re-consent and re-validation; it
   must **not** silently create duplicate accounts (§10.3). *Corrected in round
   3* — draft 1 wrongly claimed rotation re-identifies every account.
5. **Polling latency** up to ~120 s (§11.6). No push without GCP infrastructure.
6. **Backfill is bounded by quota, not fast**, and its duration is **measured
   and reported, never promised** (§2.2).
7. **Gmail only.**
8. **Attachments are lazily fetched** when the provider supplies an
   `attachmentId`, so first open is slow and offline access is partial (§14.5).
9. **Sender CSS is dropped in v2** (§12.3). Marketing mail renders plainer.
   Restoring it needs a real CSS sanitiser and browser tests.
10. **Remote-image choice is per-message, not per-sender.** Deferred to P9.
11. **Prompt injection is bounded, not solved**, and only under the §14.1 trust
    boundary.
12. **`node:sqlite` is experimental** (§7.1), with an escape hatch.
13. **Send-as aliases** may be unavailable if `users.settings.sendAs.list` is not
    permitted under the granted scopes; the primary address is then forced and
    disclosed (§13.3).
14. **`to:me` matches the account's known identities only** — not groups or
    unknown aliases (§8.1).
15. **Body search is incomplete while backfill runs**; results carry `coverage`
    (§8.3).
16. **No jump-to-index in the thread list** — windowed infinite scroll only
    (§6.5).
17. **Exactly-once send is impossible.** An ambiguous send becomes `unknown` and
    requires a human decision (§13.5).
18. **A same-user process with shell access is outside the security boundary**
    (§14.1).

---

## 22. Open Questions — the owner gate

**Questions 1–5 block Phase 2.** Phase 1 exists to answer them. Draft 1 claimed
every phase was implementable without questions while carrying blocking unknowns;
that claim is withdrawn.

| # | Question | Blocks | Recommendation |
| --- | --- | --- | --- |
| 1 | **Does the Boring UI workspace agent have shell / filesystem / generic HTTP tools?** If yes, `agent_readable` and the send approval gate are UX guardrails, not security controls, and §14.1's boundary must be stated in the product copy. | **P1/P2** | Assume yes until proven otherwise; ship the constrained triage agent (§14.4) and move data out of the workspace (§7.2) regardless. |
| 2 | **Where does the mailbox live** — OS user data dir (recommended) vs workspace-local? Affects multi-workspace duplication and the agent boundary. | **P1/P2** | OS user data dir, per §7.2. |
| 3 | **Which host session / CSRF / origin mechanism protects plugin routes?** | **P1/P2** | Must be answered by the host; no plugin-local invention. |
| 4 | **What supported server-side `ask-user` API validates an answer capability?** Carried unanswered from the v1 plan. | **P1, P8** | Spike in P1. Ship the in-plugin approval surface regardless (§13.6). |
| 5 | **Is `@hachej/boring-workspace` published, and at what version?** | **P0** | Determines Phase 0's dependency strategy. |
| 6 | **`MailComposer` or hand-rolled MIME generation?** | P8 | `MailComposer`; decide by spike. |
| 7 | **Should `agent_readable` default to false?** The plan now recommends **false**, reversing draft 1, because connecting an account is not consent to pipe it into an agent (§14.8). **This is a product call and belongs to the owner.** | P3A | Default false, with a prominent, explained opt-in. |
| 8 | **Bootstrap window** — 30 days / 2,000 messages? | P4 | As stated; configurable; revisit after real use. |
| 9 | **Is there a dedicated Gmail account for integration testing**, and safe recipient addresses for send tests? | P8 | Required — `MANUAL` send acceptance cannot run without one. |
| 10 | Is the Gmail per-API batch endpoint still supported? | P9 only | Re-verify; build nothing on it before then. |

---

## 23. Review Log

| Round | Reviewer | Date | Outcome |
| --- | --- | --- | --- |
| 1 | Claude Opus 5 (author) | 2026-08-21 | Draft. Grounded against live Gmail docs, the Boring UI checkout, and executed local probes. 2,441 lines. |
| 2 | `xai/grok-4.6` via pi | 2026-08-21 | 18 findings. Adversarial, highly specific. |
| 3 | `openai-codex/gpt-5.6-sol:xhigh` via pi | 2026-08-21 | 26 findings, severity-ranked. Verdict: "Owner gate should reject this draft." |
| 4 | `anthropic/claude-fable-5` | 2026-08-21 | **Not run.** pi's Anthropic OAuth refresh token expired (`invalid_grant`); OpenRouter returned HTTP 402 (no credits); Vault unreachable. Recorded rather than silently substituted. |
| — | Fold + re-verification | 2026-08-21 | This document. |

### What I agree with wholeheartedly

Everything in §0's revision summary. The nine structural defects were real, and
seven of them would have produced a plausible-looking implementation that failed
only on a real mailbox: the snapshot deletion path, the FTS schema, the
`threads.get` strategy, per-message labels, the iframe, the blocking store, and
the approval gate. Both reviewers found the first six **independently**, which is
the strongest available signal that they are not stylistic disagreements.

The two findings I would single out as the most valuable are the ones I could
not have found by re-reading my own work: that **`threads.get` returns the whole
thread and list APIs carry no message count** (so a numerically correct
break-even was applied to a quantity that does not exist), and that
**capability containment was computed on the wrong process** (the tool cannot
send, but the agent holding the tool can also hold `bash`).

### What I agree with partly

- **Quota constants.** Both reviewers asserted 5 / 10 / 15,000 and both are
  wrong: two live fetches and an independent search confirm 20 / 40 / 6,000
  (§2.2). Constants **rejected**; the process fix — one cited module with a
  tripwire test — **adopted**, precisely because two strong reviewers got this
  wrong from memory. Their instinct against bursting a whole minute's budget in
  one tick is also adopted as a per-second clamp, on its own merits.
- **`agent_readable` default.** Adopted as the plan's recommendation, but
  flagged as an owner decision (§22 Q7) rather than changed unilaterally — it
  trades away the out-of-the-box premise of the product.
- **Phase restructuring.** Adopted in substance, not verbatim: contract gates
  promoted to P1, 3A ∥ 3B split, a P4 vertical slice inserted, attention
  projection promoted to its own phase. I did not adopt every sub-split; P2, P5,
  P7, P8 are instead flagged as requiring further splitting at bead time.

### What I disagree with

- **Sol's "do not hand-roll the part-tree walk" framing.** The *header, address,
  parameter, and charset* parsing goes to libraries — that is adopted. But
  walking Gmail's already-decoded part tree is ~200 lines against a stable JSON
  shape, and the alternative (`format=raw`) costs the same quota, returns more
  bytes, re-parses what Gmail parsed, and defeats lazy attachment fetching.
  Split accordingly in §12.1.
- **Grok's "`prompt=select_account consent` for new connects, always".** Adopted
  for new connects, but *not* for re-auth, where `select_account` is exactly what
  makes the wrong-account mis-click easy. §10.2 splits the two cases.

### Steady-state assessment

Per the Jeffrey workflow, steady state is reached when a round produces marginal
rather than structural revisions. **Round 3 produced structural revisions** —
the schema, the recovery algorithm, the storage execution model, the approval
model, and the phase graph all changed. **This plan is therefore not at steady
state**, and the honest expectation is that a fourth round finds more.

Round 4 should target, in order: the snapshot recovery algorithm (§11.4) as
newly written; the approval capability model (§13.6); the storage worker RPC and
its failure modes (§7.1, §20.4); and whether P4's vertical slice is genuinely
achievable in one phase.

### Next action

1. Run round 4 (Fable, once credentials are restored, or another model).
2. Take §22 questions 1–5 to the owner. **They are gates, not details.**
3. Only then `/skill:exec P0`.

This plan has **not** passed the owner gate and is not `ready-for-agent`.

---

## 24. Round 4 — Eight-Lane Opus Falsification

Run 2026-08-22 per `boring-ui-v2/.agents/skills/plan/SKILL.md`: `fresh-eyes`
(tier 1), `grill-for-unknowns`, and six T1 falsification lanes against the
sections §23 nominated. All Opus (owner directive), all read-only on the repo,
several executing code.

**Verdict: not steady state. Round 4 produced more structural revisions than
round 3.** The plan's §23 nominated snapshot recovery, the approval capability
model, the storage-worker RPC, and P4 feasibility as round-4 targets. Those are
the *best*-specified parts of the document and largely survived. **Every
surviving defect is at a seam the plan marked "verified".**

Decisions extracted to `docs/DECISIONS.md` (D1–D15) so they outlive this plan.
Epic 0 + Epic 1 materialised as beads `bm-*` (`br ready`).

### 24.1 Round-3 fixes that were themselves wrong

| # | Round-3 claim | Round-4 finding | Lanes |
| --- | --- | --- | --- |
| 1 | `row_id INTEGER PRIMARY KEY` — "STABLE FTS key. Never reused." | **False.** Without `AUTOINCREMENT` SQLite assigns `max(rowid)+1` and reuses ids. Reproduced end to end: delete two messages, re-ingest, `MATCH 'severance'` returns a **different, live** message — verbatim the aliasing bug the fix was written for. (`VACUUM` shifting rowids did *not* reproduce; that half of the rationale is wrong too.) | storage |
| 2 | `agentConfigContract` is "the hook that makes §14.4's constrained-agent requirement implementable" | **False.** It is `{keys: readonly string[]}` — a config-**key** allow-list. Its only consumer is `validateConfigBinding`. §14.4's first and strongest mitigation cannot be built on it. | fresh-eyes, grill, phases |
| 3 | §14.3 `img-src blob:` with parent-created blob URLs | **Cannot work.** Blob URLs are storage-key partitioned; an opaque origin is never same-origin with the parent, so every `cid:` image dies. And the premise forcing the design — that `'self'` needs `allow-same-origin` — is itself false. | MIME/render |
| 4 | §7.4 "draft 1's `PRAGMA foreign_keys` in the migration would have left every FK unenforced" | **False for this driver.** `node:sqlite` defaults `enableForeignKeyConstraints` to **true**. The P2 "trap test" asserting `foreign_keys` is OFF **cannot pass**. | fresh-eyes, storage |
| 5 | "MANUAL bullets need a committed artifact" | **Announced, not implemented.** P3A's proof command never looks at `test-fixtures/manual/`, so it can still merge having never obtained a refresh token. | phases |
| 6 | All ten phase proof commands | **Match no files.** `pnpm test -- --run boring-mail-storage` is a vitest *filename* filter; nothing in §5.3 is named `boring-mail-*`. Ten vacuously-green gates. | fresh-eyes |
| 7 | `sub` is stable, not pairwise (round-3 correction) | **Confirmed definitively** — `subject_types_supported: ["public"]` in Google's live discovery document. Round 3 was right. | oauth |

### 24.2 Critical findings by area

**Sync (§11).** `last_seen_generation` is stamped only by the snapshot, while
bootstrap/incremental/backfill/hydration share an upsert that defaults it to 0 —
so a multi-hour snapshot **sweeps everything ingested during it**. Nothing ever
clears `deleted_at`, so a false delete is permanent and an untrash in Gmail
leaves the message hidden forever. The snapshot fetches bodies inline, making
H0 expiry structural and the recovery a **livelock**; the NOT NULL columns on
`mail_messages` make an id-only stub uninsertable, which forces it. Fix: a
separate `mail_snapshot_seen` mark table (which deletes the whole `last_seen_generation`
failure class), `deleted_at = NULL` on every observed-present path, and split
`markSeen` from `ingestMessage` — because §11.7's single upsert would otherwise
**wipe every label in the mailbox** by writing `provider_labels_json` from a
`messages.list` result that contains no `labelIds`. Thread aggregate recompute
also omits `last_message_at`, the sort key for the unified inbox and three of
four indexes.

**Send (§13).** `POST /outbox/:id/approve` both *issues and consumes* the
capability — a capability minted and burned by the same caller is a boolean the
server computes for itself, i.e. round-3 rebuilt "the click is the approval" with
SHA-256 on top. A lease-expired `sending` row is re-claimable, which is the
duplicate send. The digest covers `body_markdown` while the recipient receives
HTML rendered *after* approval. `MailComposer` **strips `Bcc:` by default**, and
`messages.send` has no envelope — so the approval screen shows a Bcc recipient
who then never receives the mail. §13.3's threading gloss is factually wrong
(Google lists `References`/`In-Reply-To` as criterion **2 for Gmail itself**), and
a reply failing the criteria is still **sent**, just unthreaded, with no error.

**OAuth (§10).** Loopback survives (deprecation was mobile-only) — but `iss` is
in the account primary key while Google emits **two** valid spellings, so the
same account under the other spelling creates a second `acct_` row. `client_secret`
is missing from the token exchange. A password change revokes **all** accounts at
once (Gmail-scoped refresh tokens), and the 8-day heuristic latch permanently
suppresses the explanation. `REAUTH_ACCOUNT_MISMATCH` refuses the tokens but
leaves a **live grant** on the wrong Google account with no handle to revoke it.

**Storage (§7).** The DDL *does* execute — but `mail_outbox`'s `ON DELETE SET
NULL` composite FK makes hard-deleting any thread **impossible** (`SET NULL` nulls
`account_id NOT NULL`); `schema_migrations` is **absent** from the DDL its own
runner records into; `json_valid` accepts bare scalars; `integrity-check` needs
`rank=1` or it passes on a corrupt index; §14.7 step 5 orders FTS maintenance
**after** deleting the content rows it needs to read; and `ON DELETE CASCADE`
bypasses `hardDeleteMessages` entirely. §7.3's DDL has been **replaced** with the
executed, verified version.

**Host seams (§2.3, §15).** Plugin `routes` are registered bare — no auth, no
CSRF, no origin check — while everything protective lives on the bridge, which
the plan mentions once. A server-side `ask-user` API **does** exist
(`ask-user.v1.request`), so that gate collapses to wiring — but its answer token
is plaintext in the agent-writable workspace, which reverses §7.2's own rationale.
The verification basis is an unmerged branch at `0.1.98`; npm ships `0.1.103`.

**Environment.** Loopback OAuth **cannot complete** in the only configured
topology (`vite --host 0.0.0.0`, `hmr.host` a Tailscale address — the browser is
on another machine). This box has **no Secret Service**, so the encrypted-file
backend is primary, not a fallback. Node/pnpm are unpinned and `pnpm -v` returned
two different versions on this machine minutes apart.

### 24.3 Scope

The phases lane put the honest size at **~52 beads**, not 10 phases, and found
**every** claimed parallel edge false (P5∥P6 collide on `mailAgentTool.ts`; P3A∥P3B
because the fixture corpus needs a connected account; P6's `coverage` derives
from P5's backfill). The corrected graph is **fully serial**.

Recommended cut to ~30 beads without weakening any security property:
single-account (**keeping `account_id` in every table and FK**), no backfill, no
blob store, no operator parser, **and defer the agent tool** until D11's boundary
is answered. Do not cut: the storage worker, snapshot safety, the sanitiser +
frame, the approval capability, revoke-then-purge, `TokenStore`.

### 24.4 Rejected

Both round-2/3 reviewers claimed the Gmail quota constants were wrong (5/10/15,000).
Re-verified 2026-08-22 by two live fetches and an independent search: **20/40/6,000
stands**; those are the superseded values. Their *process* fix — one cited module
with a tripwire that can actually fail — is adopted (`bm-gate-quota-constants-1bu`).

### 24.5 Next action

`br ready` → `bm-repoint-deps-z13` (sole articulation point, unblocks 6 of 12).
Then the six gates. **Not `ready-for-agent` beyond Epic 0–1** until the owner gate
answers D1, D2, D3, D6, D7, D10.

---

## 25. Amendment A — msgvault as sync backbone (2026-08-23)

**Owner decision:** "yes I trust the creator -> use it." Boring Mail adopts
[`wesm/msgvault`](https://github.com/wesm/msgvault) (MIT, Go single binary) as
the Gmail→local sync engine instead of building §11 ourselves.

### 25.1 What this supersedes (pending spike confirmation — bead `bm-a3l`)

| Plan section | Fate |
| --- | --- |
| §7 Storage — attachment dedup/packing, content-addressed store | **Replaced** by msgvault's SHA-256 content-addressed attachment store + immutable packs |
| §11 Sync engine — bootstrap/backfill/incremental/history-404 recovery | **Replaced** by `msgvault sync-full` / `msgvault sync` (History-API incrementals, resumable checkpoints). Our §11.4 semantics were designed to match this mechanism; the design review effort transfers to verification, not construction. |
| §12 Normalisation | **Reduced.** msgvault archives raw MIME + labels in SQLite; we still normalise into domain projections for the product layer. |
| §8 Search | **Reduced.** FTS5 ships with msgvault; our agent-tuned views/projections layer on top. |

### 25.2 What stays ours (the actual product)

- **Send pipeline (§13)** — msgvault is read/archive-only (its only write-back is
  staged deletions). Draft → approval → RFC 822 compose → `messages.send`
  remains boring-mail code, including the from-account rule and send-as safety.
- **Draft surfaces** — `.mail.md` format v2, parse-merge-write (`bm-p1-draft-format-bsj`).
- **Approval workflow** — ask-user + draft-as-artifact (owner-ratified 2026-08-22).
- **Cross-account coalescing** — global rfc822 correlation + coalesced flag
  (owner-ratified 2026-08-22); msgvault stores per-account rows and does not
  coalesce threads across accounts.
- **Attention projection, agent mail tool, unified UX** (§16–17).

### 25.3 Integration seam

Two candidate seams, decided by the spike:

1. **SQLite-direct**: boring-mail reads msgvault's SQLite as the system of
   record and adds its own tables (drafts, outbox/approval state machine,
   coalescing) joined by `rfc822_message_id`.
2. **Daemon API**: consume `msgvault serve` (OpenAPI/MCP) and keep a separate
   product DB keyed by provider ids.

Either way the plan's `MailProvider` interface survives as the seam: its first
real implementation becomes a `MsgvaultProvider`, keeping the door open for
IMAP/Graph providers that msgvault also speaks.

### 25.4 Risks accepted

- **Alpha storage format** ("may change without notice"): pin releases; adapter
  isolates churn; spike documents observed schema before any product table
  references it.
- **Token storage**: unchanged — still parked on boring-ui BYOK (decision 2).
  Spike uses a throwaway account only.
- **Second runtime** (Go sidecar alongside the vite plugin server): supervised,
  singleton, same pattern as the storage worker.

### 25.5 Bead graph impact

- New P0: `bm-a3l` spike (evaluate → restructure proposal → committed report).
- Future sync/storage beads (P2+) are **withheld** until the spike report lands;
  they will be cut against the chosen seam, not against §11 as written.
- Unaffected: Epic 0 (deps/CI), draft-format v2, mock-coexist seam, host
  contract tripwire, all ratified gate decisions.
### 25.6 Spike outcome (2026-08-24) — ADOPT, seam chosen

Spike executed against live Gmail (`docs/spikes/msgvault-adoption.md`, PR #3).
All assumptions confirmed; SQLite-direct seam selected. Owner additionally
ratified (2026-08-24): separate `gmail.send` consent grant for the send
pipeline (D9). Follow-up beads cut: ADAPTER (`bm-zf6`) → PRODUCT-DB (`bm-8ae`)
→ COALESCE (`bm-eii`), plus SEND (`bm-iqd`) and SUPERVISOR (`bm-h79`) lanes.
Sections 7/11/12/8 above are superseded as described in 25.1 and are retained
only as design rationale.
