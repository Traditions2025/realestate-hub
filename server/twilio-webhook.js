// Twilio webhook security. Validates the X-Twilio-Signature header so forged
// requests to our public webhook URLs are rejected. Algorithm (per Twilio docs):
// concat the full request URL with the POST params sorted by key (key+value),
// HMAC-SHA1 with the account Auth Token, base64-encode, constant-time compare.
import crypto from 'crypto'
import { getSetting } from './database.js'
import { twilioConfig } from './twilio.js'

export function twilioSignatureValid(url, params, signature) {
  const token = twilioConfig().token
  if (!token || !signature) return false
  const data = url + Object.keys(params || {}).sort().map(k => k + params[k]).join('')
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64')
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature))) } catch { return false }
}

// Express middleware for Twilio webhooks. Mode comes from the `twilio_signature_mode`
// setting: 'enforce' (reject bad signatures 403), 'monitor' (validate + log, but allow),
// or 'off'. Default 'monitor' so turning security on can't brick live comms if the URL
// or proxy setup is slightly off — watch the logs, then flip to 'enforce'.
export function twilioWebhookGuard(req, res, next) {
  const mode = getSetting('twilio_signature_mode', 'monitor')
  if (mode === 'off') return next()
  const base = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  const url = base + req.originalUrl
  const ok = twilioSignatureValid(url, req.body, req.get('X-Twilio-Signature'))
  if (!ok) {
    console.warn(`[twilio-webhook] INVALID signature on ${req.originalUrl} (mode=${mode})`)
    if (mode === 'enforce') return res.status(403).type('text/plain').send('Invalid Twilio signature')
  }
  next()
}
