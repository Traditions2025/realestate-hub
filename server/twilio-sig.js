// Pure Twilio signature validation (no app/db imports, so it's unit-testable).
// Algorithm: concat the full request URL with the POST params sorted by key
// (key+value), HMAC-SHA1 with the account Auth Token, base64, constant-time compare.
import crypto from 'crypto'

export function twilioSignatureValid(url, params, signature, token) {
  if (!token || !signature) return false
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join('')
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))) } catch { return false }
}

// Last-10-digits phone key used to match a caller/texter to a CRM contact
// regardless of formatting: (319) 555-1212 / 319-555-1212 / +13195551212 all equal.
export function phoneKey10(p) {
  const d = String(p || '').replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : null
}

// STOP / START compliance keyword detection.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out'])
const START_WORDS = new Set(['start', 'yes', 'unstop', 'optin', 'opt-in'])
export function optKeyword(body) {
  const w = String(body || '').trim().toLowerCase().replace(/[^a-z-]/g, '')
  if (STOP_WORDS.has(w)) return 'stop'
  if (START_WORDS.has(w)) return 'start'
  return null
}
