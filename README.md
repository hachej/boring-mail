# Boring Mail

Boring Mail is an agent-native mail workbench for Boring UI. It is split into two packages:

- `boring-mail/` — the reusable Boring UI plugin package (`@hachej/boring-mail`).
- `app/` — a standalone playground app that installs the plugin and runs a local Boring workspace agent server.

The playground installs the Boring UI host packages (`@hachej/boring-workspace`, `@hachej/boring-agent`, `@hachej/boring-ask-user`) from npm, pinned to exact `0.1.103`.

## What is included

- Mail source pane with mock Gmail-like threads, search, views, and tag filters.
- Thread panels opened as Boring UI Dockview tabs.
- `.mail.md` draft files that automatically open with the mail draft editor.
- Compose/reply UI using Boring UI's Markdown editor with editable To/Cc/Subject headers.
- One agent tool named `mail` with actions for search, thread lookup, draft create/read/update/delete/move, and mock send.
- Existing `@hachej/boring-ask-user` Inbox plugin installed in the playground.

## Repository layout

```txt
.
├── app/                  # Standalone playground app
│   ├── src/client/       # WorkspaceAgentFront playground UI
│   ├── src/server/dev.ts # Local Boring workspace agent server
│   └── .playground/      # Runtime workspace files, gitignored
├── boring-mail/          # Reusable Boring Mail plugin package
│   └── src/
│       ├── boring-ui/    # Front/server plugin adapters
│       ├── mail/         # Mail UI, mock data, agent tool
│       └── shared/       # Shared domain types
└── docs/                 # Planning docs
```

## Getting started

Prerequisites:

- Linux (current supported runtime)
- Node.js 22+
- pnpm
- `/bin/sh` and util-linux `flock` with `-E` support
- msgvault 0.19.x on `PATH` for real Gmail sync (not needed for mock-only mode)
- No sibling checkouts required — host packages come from npm at pinned versions
- Pi/Boring host model provider config already available in your normal environment

### LLM provider setup

This repo intentionally does **not** register or store any LLM provider credentials. The playground uses the default Pi/Boring host configuration from the machine running it.

If chat works in your normal Pi/Boring setup, it should work here too. Configure providers outside this repo using your standard Pi host setup, for example environment variables or your existing Pi config files. Do not add API keys to this repository.

Useful sanity check after starting the playground:

```sh
curl http://localhost:5190/api/v1/agents/default/models
```

If that endpoint returns models, the playground can see the host provider config. If it is empty or errors, fix the host Pi provider setup first, then restart `pnpm dev`.

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Run the playground:

```sh
pnpm dev
```

Default URLs:

- Vite playground: `http://localhost:5190/`
- Agent backend: `http://127.0.0.1:5290/`

The playground workspace is created at:

```txt
app/.playground/
```

That folder is intentionally gitignored. Drafts created by Compose or the `mail` tool appear under `app/.playground/drafts/`.

## Validation

```sh
pnpm typecheck
pnpm test
pnpm build
```

## Plugin integration notes

Front plugin:

```ts
import { boringMailBoringUiPlugin } from '@hachej/boring-mail/front'
```

Server plugin:

```ts
import createBoringMailServerPlugin from '@hachej/boring-mail/server'
```

The server plugin contributes a single agent tool named `mail`. It deliberately does not register any LLM/model provider. The playground uses the default Pi host configuration supplied by the environment.

When `~/.msgvault/msgvault.db` exists, the server plugin supervises `msgvault sync` for every Gmail source in that archive. Polling starts immediately, runs every 120 seconds with ±20% jitter, and backs off to 5–10 minutes after three empty runs. It continues while the server is running even when no browser is open. Set `MSGVAULT_HOME` for a non-default msgvault home. `MSGVAULT_DB_PATH` is also accepted only when it names the CLI-supported `<home>/msgvault.db` layout; it derives that home, and any conflicting `MSGVAULT_HOME` fails closed. Pass `sync: false` to `createBoringMailServerPlugin` for fixture/mock-only hosts. One Boring Mail process owns a canonical archive at a time through kernel locks. The Fastify close lifecycle drains an in-flight sync before releasing ownership.

Product storage consumers import the compiled worker-backed entry:

```ts
import { openMailStore } from '@hachej/boring-mail/mail-store'
```

Do not import `src/mail/store/productDb.ts` from application code. It is compile input; the package export keeps the emitted `mailStoreWorker.js` adjacent to the RPC facade. The storage process inherits `O_NOFOLLOW` descriptors for both the canonical data-directory inode and product-database inode, locks both with util-linux `flock`, then `exec`s Node while retaining them. The only synchronous SQLite owner and both OS locks therefore have the same lifetime; the owner JSON sidecar is informational only.

## Security / repo hygiene

- No credentials are required or stored by this repo.
- Runtime workspace state lives in `app/.playground/` and is ignored.
- Build outputs and dependency folders are ignored.
- Mock mail data is synthetic demo data only.
