const C0_EXCEPT_TAB_LF = /[\x00-\x08\x0B-\x1F\x7F]/gu
const PRINTABLE_SINGLE_LINE = /^[^\s\x00-\x1F\x7F]+$/u

export interface Utf8TruncationResult {
  value: string
  truncated: boolean
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function truncateUtf8(value: string, maxBytes: number): Utf8TruncationResult {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('maxBytes must be a non-negative safe integer')
  if (utf8ByteLength(value) <= maxBytes) return { value, truncated: false }
  let used = 0
  let output = ''
  for (const char of value) {
    const size = utf8ByteLength(char)
    if (used + size > maxBytes) return { value: output, truncated: true }
    output += char
    used += size
  }
  return { value: output, truncated: false }
}

export function normalizeProviderText(value: string): string {
  return value.normalize('NFC').replace(C0_EXCEPT_TAB_LF, '')
}

export function normalizeAndTruncateProviderText(value: string, maxBytes: number): Utf8TruncationResult {
  return truncateUtf8(normalizeProviderText(value), maxBytes)
}

export function normalizeAndTruncateProviderEmail(value: string | null, maxBytes = 320): { value: string | null; truncated: boolean } {
  if (value === null) return { value: null, truncated: false }
  const normalized = value.normalize('NFC')
  if (!PRINTABLE_SINGLE_LINE.test(normalized)) return { value: null, truncated: false }
  return truncateUtf8(normalized, maxBytes)
}
