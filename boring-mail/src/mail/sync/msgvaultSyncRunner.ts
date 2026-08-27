import { spawn } from 'node:child_process'

const MAX_CAPTURE_BYTES = 64 * 1024

export interface MsgvaultSyncRunnerOptions {
  executable?: string
  home?: string
  configPath?: string
  spawnProcess?: typeof spawn
}

export type MsgvaultOutputClassification = 'changed' | 'empty' | 'unknown'

/** Classify msgvault's human summary centrally; unknown output stays active. */
export function classifyMsgvaultSyncOutput(output: string): MsgvaultOutputClassification {
  const summary = /\bChanges:\s*(\d+)\s+processed,\s*(\d+)\s+added\b/i.exec(output)
  if (summary) return Number(summary[1]) > 0 || Number(summary[2]) > 0 ? 'changed' : 'empty'
  const counters = [...output.matchAll(
    /\b(?:new|added|created|imported|updated|changed|deleted|removed|synced)\s*(?:messages?)?\s*[:=]?\s*(\d+)\b/gi,
  )].map((match) => Number(match[1]))
  if (counters.some((count) => count > 0)) return 'changed'
  if (counters.length > 0) return 'empty'
  if (/\b(?:no changes|nothing to sync|up[ -]to[ -]date)\b/i.test(output)) return 'empty'
  return 'unknown'
}

function appendBounded(current: string, chunk: unknown): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current
  const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  return (current + text).slice(0, MAX_CAPTURE_BYTES)
}

/** Direct argv-only msgvault runner. Child output is never included in errors. */
export function createMsgvaultSyncRunner(options: MsgvaultSyncRunnerOptions = {}) {
  const executable = options.executable?.trim() || 'msgvault'
  const spawnProcess = options.spawnProcess ?? spawn
  return async (account: string): Promise<{ changed: boolean }> => {
    const args = [
      ...(options.home ? ['--home', options.home] : []),
      ...(options.configPath ? ['--config', options.configPath] : []),
      '--no-log-file',
      'sync',
      account,
    ]
    let stdout = ''
    let stderr = ''
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const child = spawnProcess(executable, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk) })
      child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk) })
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (settled) return
        settled = true
        if (error.code === 'ENOENT') {
          reject(new Error('REMEDIATION: msgvault executable was not found; install msgvault or configure its executable path'))
        } else {
          reject(new Error('msgvault sync process could not start'))
        }
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        if (code === 0) resolve()
        else reject(new Error(
          `REMEDIATION: msgvault sync failed (${signal ? 'terminated' : `exit ${code ?? 'unknown'}`}); inspect msgvault logs`,
        ))
      })
    })
    const classification = classifyMsgvaultSyncOutput(`${stdout}\n${stderr}`)
    return { changed: classification !== 'empty' }
  }
}
