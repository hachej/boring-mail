#!/usr/bin/env node
// bm-check-env-ci-yrt — fail fast with NAMED remediations when the environment
// cannot run boring-mail. Exits 0 silently when everything holds.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.CHECK_ENV_ROOT || process.cwd()
let failed = false

const fail = (msg) => { console.error(`✗ ${msg}`); failed = true }
const ok = (msg) => console.log(`✓ ${msg}`)

// 1. Node version gate: the storage layer needs node:sqlite unflagged.
const NODE_MIN = [22, 22]
const NODE_MAX = [23, 0]
function versionAtLeast([maj, min], v) {
  return v[0] > maj || (v[0] === maj && v[1] >= min)
}
const nodeVer = process.versions.node.split('.').map(Number)
if (versionAtLeast(NODE_MIN, nodeVer) && !versionAtLeast(NODE_MAX, nodeVer)) {
  ok(`node ${process.versions.node}`)
} else {
  fail(
    `node ${process.versions.node} outside supported range >=22.22 <23. ` +
    `Remediation: fnm install 22 && fnm use 22 (see .nvmrc / package.json engines).`
  )
}

// 2. node:sqlite must be importable unflagged (storage worker depends on it).
try {
  await import('node:sqlite')
  ok('node:sqlite importable')
} catch {
  fail(
    'node:sqlite is not available unflagged. Remediation: upgrade Node to >=22.22 ' +
    '(the SQLite builtin is version-gated); do NOT pass --experimental-sqlite.'
  )
}

// 3. The host package must be installed at the pinned exact version.
//    (@hachej/boring-workspace is ESM-only: exports expose no "require"
//    condition, so filesystem verification is more truthful than CJS resolve.)
const REMEDIATION_HOST =
  'REMEDIATION: @hachej/boring-workspace does not resolve. Run: pnpm install --frozen-lockfile'
const HOST_PIN = '0.1.103'
const hostPkgPath = join(ROOT, 'app', 'node_modules', '@hachej', 'boring-workspace', 'package.json')
try {
  const host = JSON.parse(readFileSync(hostPkgPath, 'utf8'))
  if (host.version !== HOST_PIN) {
    fail(
      `@hachej/boring-workspace ${host.version} installed, expected exact ${HOST_PIN}. ` +
      `Remediation: pnpm install --frozen-lockfile (lockfile pins ${HOST_PIN}; never widen the range).`
    )
  } else {
    ok(`@hachej/boring-workspace ${host.version} (exact pin)`)
  }
} catch (e) {
  if (e.code === 'ENOENT') fail(REMEDIATION_HOST)
  else fail(`@hachej/boring-workspace unreadable at ${hostPkgPath}: ${e.message}`)
}

// 4. No resurrected sibling-checkout references anywhere in tracked source.
//    docs/** is exempt: plans legitimately cite the retired path as history.
//    this file is exempt: it must contain the literal to grep for it.
try {
  const hits = execFileSync(
    'git',
    ['grep', '-l', 'boring-ui-v2-775-pr811-final', '--', ':/', ':!docs', ':!scripts/check-env.mjs'], {
    cwd: ROOT, encoding: 'utf8',
  }).trim()
  if (hits) {
    fail(
      `tracked file(s) still reference the retired sibling checkout:\n${hits}\n` +
      'Remediation: remove the ../boring-ui-v2-775-pr811-final reference(s).'
    )
  } else {
    ok('no sibling-checkout references in tracked sources')
  }
} catch (e) {
  if (e.status !== 1) throw e // git grep exits 1 on "no matches" = good
  ok('no sibling-checkout references in tracked sources')
}

process.exit(failed ? 1 : 0)
