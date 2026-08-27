#!/usr/bin/env node
import { spawnSync } from 'node:child_process'

const executable = process.env.MSGVAULT_EXECUTABLE?.trim() || 'msgvault'
const version = spawnSync(executable, ['version'], {
  encoding: 'utf8',
  timeout: 5_000,
  maxBuffer: 16 * 1024,
})
if (version.error?.code === 'ENOENT') {
  throw new Error('required msgvault smoke needs exact installed msgvault v0.19.3; executable was unavailable')
}
if (version.error) throw version.error
if (version.status !== 0 || version.signal ||
    !/(?:^|\n)msgvault v0\.19\.3(?:\r?\n|$)/.test(`${version.stdout}\n${version.stderr}`)) {
  throw new Error('required msgvault smoke needs exact installed msgvault v0.19.3')
}
await import('./smoke-msgvault-direct.mjs')
