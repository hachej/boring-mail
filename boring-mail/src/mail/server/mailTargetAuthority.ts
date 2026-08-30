import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ProductStoreError } from '../store/product/types.ts'

const TARGET_PREFIX = 'bm1'
const TARGET_DOMAIN = 'boring-mail.thread-target.v1\0'
const TARGET_PATTERN = /^bm1\.([1-9][0-9]*)\.([A-Za-z0-9_-]+)$/u
const HMAC_BYTES = 32

export interface MailThreadTargetAuthority {
  mint(messageId: number): string
  verify(target: string): number | null
}

function canonicalPositiveSafeInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProductStoreError('corrupt_data', 'message id must be a positive safe integer')
  }
  return String(value)
}

function hmacTag(key: Buffer, decimal: string): string {
  return createHmac('sha256', key)
    .update(TARGET_DOMAIN, 'utf8')
    .update(decimal, 'utf8')
    .digest('base64url')
}

function decodeCanonicalBase64Url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.byteLength !== HMAC_BYTES || decoded.toString('base64url') !== value) return null
    return decoded
  } catch {
    return null
  }
}

export function createMailThreadTargetAuthority(key: Buffer = randomBytes(32)): MailThreadTargetAuthority {
  if (!Buffer.isBuffer(key) || key.byteLength !== 32) {
    throw new Error('mail target authority key must be exactly 32 bytes')
  }
  const secret = Buffer.from(key)
  return Object.freeze({
    mint(messageId: number): string {
      const decimal = canonicalPositiveSafeInteger(messageId)
      return `${TARGET_PREFIX}.${decimal}.${hmacTag(secret, decimal)}`
    },
    verify(target: string): number | null {
      const match = TARGET_PATTERN.exec(target)
      if (!match) return null
      const decimal = match[1]
      const tag = decodeCanonicalBase64Url(match[2])
      if (!tag) return null

      let parsed: bigint
      try { parsed = BigInt(decimal) } catch { return null }
      if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed.toString(10) !== decimal) return null

      const expected = Buffer.from(hmacTag(secret, decimal), 'base64url')
      const ok = tag.byteLength === expected.byteLength && timingSafeEqual(tag, expected)
      tag.fill(0)
      expected.fill(0)
      if (!ok) return null
      return Number(parsed)
    },
  })
}
