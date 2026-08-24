# Spike Report — msgvault adoption (`bm-a3l`)

**Date:** 2026-08-24 · **Executor:** DustyEagle (pi-coding-agent / ox-alpha)
**Verdict:** ✅ **ADOPT** — msgvault as Gmail→local sync backbone, SQLite-direct seam.
Owner decision recorded 2026-08-23 ("I trust the creator → use it").

## 1. What was tested

| Item | Result |
| --- | --- |
| Install | `msgvault v0.19.3` (e90bcdc5, built 2026-08-09, go1.26.5, linux/amd64) via official installer |
| OAuth | Desktop client (seneca GCP project), paste-code flow — matches ratified topology D-record; refresh token stored in Vault `secret/admin/seneca/gmail` |
| Scopes | `gmail.readonly` + `gmail.modify`. **No `gmail.send`** — msgvault cannot send; only write-back is staged deletions |
| Bounded full sync | 100 msgs: 9.6 s wall incl. analytics fan-out · 2 000 msgs / 147 MB: **19.8 msgs/s**, 1 m 39 s |
| Crash resume | SIGKILL mid-full-sync (exit 137) → rerun printed `(Resumed from checkpoint)`, skipped 100 already-ingested, added exactly the remaining 1 900. Zero duplicates, zero loss. |
| Incremental | History-API based; idle tick **0.68 s**, cursor (`Last history ID`) persisted in DB |
| Search | FTS5 virtual table (`messages_fts`: subject/body/from_addr, Gmail-style operators), plus optional sqlite-vec embeddings |

## 2. Schema survey (37 tables, SQLite system of record)

Key structures relevant to boring-mail:

- `messages` — includes **`rfc822_message_id` (present on 100/100 rows)** →
  the exact key our ratified cross-account coalescing decision needs, natively
  indexed material. Also soft-delete columns, per-row CAS watermark, embed_gen.
- `conversations` (+ `conversation_participants`, aggregates) — thread layer.
- `attachments` — **content-addressed by SHA-256** (`content_hash`), packed immutable stores.
- `participants` / `persons` / `person_attribute_values` — identity graph.
- `messages_fts` — FTS5.
- `sync_checkpoints` / `sources` — resumable sync state per account.
- Analytics cache (Parquet+DuckDB) rebuilt per sync run (~0.7 s at this size).

## 3. Chosen integration seam

**SQLite-direct (read-only) + separate product DB.**

- boring-mail opens `~/.msgvault/msgvault.db` **read-only** as the mail store.
- Product state lives in boring-mail's own SQLite: `.mail.md` drafts, outbox /
  approval state machine, coalescing projections, attention items — joined to
  msgvault rows by `rfc822_message_id` (+ `source_id`).
- We do **not** write into msgvault's DB (alpha format churn stays contained);
  adapter pins msgvault releases.
- `msgvault serve` daemon/OpenAPI/MCP remains available later for remote
  deployments — not needed locally.

## 4. Risks & deviations recorded

| Risk | Disposition |
| --- | --- |
| Alpha format churn | Pin `v0.19.x`; adapter isolates; re-verify schema on upgrade |
| `gmail.modify` scope ≠ plan's read+send-only | Accepted for spike. Plan scope rule stands: boring-mail never invokes delete-staged write-back. Revisit scope minimisation with owner before production accounts. |
| One run reported `Errors: 400` during 2 000-msg full sync | Not reproducible on rerun (0 errors); likely transient fetch/rate-limit retries. Monitor in adapter. |
| Primary account used (not throwaway) | Owner explicitly designated `julien.hurault@gmail.com`; read-only operations only performed |
| Token storage | Refresh token currently in Vault `secret/admin/seneca/gmail` — still parked on BYOK decision (D-parked); Vault path hardened? **Not yet — listener still `0.0.0.0:8200` TLS-off. Flagged.** |

## 5. Restructure proposal (plan §7/§11/§12)

- **§7 Storage** → replaced: msgvault IS the store. Delete planned pack/dedup work.
- **§11 Sync engine** → replaced: `msgvault sync` (cron/timer cadence from our §11.6
  carries over: 120s ± jitter, backoff, no pause-on-idle). Supervisor becomes a thin
  scheduler + health check around the binary.
- **§12 Normalisation** → reduced: projection mapping from msgvault rows to domain
  views (attention, unified inbox), not Gmail JSON parsing.
- **§13 Sending** — unchanged, fully ours (drafts → approval → `messages.send` via
  Google token obtained separately; note msgvault's token has no send scope, so
  sending requires its own consent grant — see open question below).

### Proposed follow-up beads (to be cut after owner ack)

1. `MsgvaultProvider` read adapter over msgvault.db (MailProvider interface, read side)
2. Product DB schema: drafts/outbox/approval/coalescing joined by rfc822_message_id
3. Unified-inbox coalescing view (global rfc822 correlation, ratified)
4. Send-side OAuth grant (`gmail.send`) + pipeline wiring (plan §13 as written)
5. Sync supervisor (timer/jitter/backoff around `msgvault sync`, singleton guard)

### Open questions for owner

1. Send-scope consent: OK for boring-mail to request `gmail.send` separately
   (its own flow), keeping msgvault tokens read-scoped?
2. Proceed cutting beads 1–5 now?
