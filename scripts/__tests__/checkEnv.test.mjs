// bm-check-env-ci-yrt — check-env must fail LOUD and pass CLEAN.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { strict as assert } from 'node:assert'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-env.mjs')
const REMEDIATION_HOST =
  'REMEDIATION: @hachej/boring-workspace does not resolve. Run: pnpm install --frozen-lockfile'

function run(env = {}) {
  try {
    const out = execFileSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status, out: e.stdout + e.stderr }
  }
}

test('check-env exits 0 in the real repo', () => {
  const { code, out } = run()
  assert.equal(code, 0, `expected exit 0, got ${code}:\n${out}`)
})

test('check-env names the remediation when @hachej/boring-workspace does not resolve', () => {
  const root = mkdtempSync(join(tmpdir(), 'checkenv-'))
  // minimal repo skeleton with NO node_modules: resolution must fail
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(join(root, 'app', 'package.json'), '{"name":"x","dependencies":{"@hachej/boring-workspace":"0.1.103"}}')
  // git grep needs a repo; give it one with no matches
  execFileSync('git', ['init', '-q'], { cwd: root })
  writeFileSync(join(root, '.gitignore'), '')

  const { code, out } = run({ CHECK_ENV_ROOT: root })
  assert.equal(code, 1)
  assert.ok(out.includes(REMEDIATION_HOST), `missing remediation string:\n${out}`)
})

test('tripwire positive path: tracked sibling-checkout reference fails with hits listed', () => {
  const root = mkdtempSync(join(tmpdir(), 'checkenv-trip-'))
  mkdirSync(join(root, 'app'), { recursive: true })
  writeFileSync(
    join(root, 'app', 'package.json'),
    JSON.stringify({ name: 'x', dependencies: { '@hachej/boring-workspace': '0.1.103' } })
  )
  writeFileSync(join(root, 'stray.ts'), `import x from '../boring-ui-v2-775-pr811-final/packages/ui'`)
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['add', 'stray.ts'], { cwd: root }) // git grep sees the index/worktree
  writeFileSync(join(root, '.gitignore'), '')

  const { code, out } = run({ CHECK_ENV_ROOT: root })
  assert.equal(code, 1)
  assert.ok(out.includes('retired sibling checkout'), out)
  assert.ok(out.includes('stray.ts'), out)
})
