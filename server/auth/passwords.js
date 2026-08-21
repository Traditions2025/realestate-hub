// Password hashing with scrypt (node:crypto — no native deps, works alongside
// better-sqlite3). Format stored in users.password_hash:  scrypt$<saltHex>$<hashHex>
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto'

const KEYLEN = 64

export function hashPassword(plain) {
  const pw = String(plain || '')
  if (pw.length < 8) throw new Error('Password must be at least 8 characters.')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(pw, salt, KEYLEN).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, salt, hash] = String(stored || '').split('$')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const expected = Buffer.from(hash, 'hex')
    const got = scryptSync(String(plain || ''), salt, expected.length)
    return expected.length === got.length && timingSafeEqual(expected, got)
  } catch { return false }
}
