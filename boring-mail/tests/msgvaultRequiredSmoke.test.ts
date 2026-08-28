// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const requiredScript = resolve(import.meta.dirname, '../scripts/smoke-msgvault-required.mjs')
const optionalScript = resolve(import.meta.dirname, '../scripts/smoke-msgvault-direct.mjs')

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'boring-mail-required-msgvault-'))
  roots.push(root)
  return root
}

function run(script: string, executable: string) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', script], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, MSGVAULT_EXECUTABLE: executable },
  })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('required msgvault smoke wrapper', () => {
  it('fails when the executable is missing while the optional smoke still skips', () => {
    const missing = join(temporaryRoot(), 'missing-msgvault')
    const optional = run(optionalScript, missing)
    expect(optional.status).toBe(0)
    expect(optional.stdout).toContain('smoke skipped: executable unavailable')

    const required = run(requiredScript, missing)
    expect(required.status).not.toBe(0)
    expect(`${required.stdout}\n${required.stderr}`).toContain(
      'required msgvault smoke needs exact installed msgvault v0.19.3; executable was unavailable',
    )
  })

  it('fails if an exact-version executable disappears immediately after its single attestation', () => {
    const executable = join(temporaryRoot(), 'msgvault')
    writeFileSync(executable, '#!/bin/sh\nrm -- "$0"\nprintf "msgvault v0.19.3\\n"\n', 'utf8')
    chmodSync(executable, 0o700)

    const result = run(requiredScript, executable)
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}\n${result.stderr}`).not.toContain('smoke skipped')
  })
})
