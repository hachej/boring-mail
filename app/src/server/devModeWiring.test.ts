// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('playground server mode wiring', () => {
  it('passes standalone deployment mode through to the Boring Mail server plugin', () => {
    const source = readFileSync(new URL('./dev.ts', import.meta.url), 'utf8')
    expect(source).toContain('mode: options.deployment.mode')
    expect(source).toContain('sync: options.deployment.sync')
    expect(source).toContain('mailRuntime: options.deployment.mailRuntime')
    expect(source).toContain("../../../boring-mail/src/boring-ui/server.ts")
    expect(source).not.toContain('openMailStore')
  })

  it('attaches Vite HTTP-server close to backend close', () => {
    const source = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
    expect(source).toContain("server.httpServer?.once('close'")
    expect(source).toContain('void backend.close()')
  })
})
