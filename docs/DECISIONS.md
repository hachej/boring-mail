
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
