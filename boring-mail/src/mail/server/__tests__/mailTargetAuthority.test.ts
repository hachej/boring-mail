import { describe, expect, it } from 'vitest'
import { createMailThreadTargetAuthority } from '../mailTargetAuthority.ts'

const key = Buffer.alloc(32, 7)

describe('mail thread target authority', () => {
  it('mints exact bm1 decimal targets with full unpadded HMAC-SHA256 tags', () => {
    const authority = createMailThreadTargetAuthority(key)
    const target = authority.mint(123)
    expect(target).toMatch(/^bm1\.123\.[A-Za-z0-9_-]{43}$/u)
    expect(authority.verify(target)).toBe(123)
  })

  it('rejects malformed, tampered, old-process, and non-canonical safe-integer targets as not found', () => {
    const authority = createMailThreadTargetAuthority(key)
    const target = authority.mint(Number.MAX_SAFE_INTEGER)
    expect(authority.verify(target)).toBe(Number.MAX_SAFE_INTEGER)
    expect(authority.verify(target.replace('bm1.', 'bm2.'))).toBeNull()
    expect(authority.verify(target.replace(/.$/u, 'A'))).toBeNull()
    expect(authority.verify(`bm1.01.${target.split('.')[2]}`)).toBeNull()
    expect(authority.verify(`bm1.${Number.MAX_SAFE_INTEGER + 1}.${target.split('.')[2]}`)).toBeNull()
    expect(createMailThreadTargetAuthority(Buffer.alloc(32, 8)).verify(target)).toBeNull()
  })

  it('requires positive safe integer message ids when minting', () => {
    const authority = createMailThreadTargetAuthority(key)
    expect(() => authority.mint(0)).toThrow(/positive safe integer/)
    expect(() => authority.mint(Number.MAX_SAFE_INTEGER + 1)).toThrow(/positive safe integer/)
  })
})
