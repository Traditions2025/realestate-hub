// Twilio webhook security. Validates the X-Twilio-Signature header so forged
// requests to our public webhook URLs are rejected. Algorithm (per Twilio docs):
// concat the full request URL with the POST params sorted by key (key+value),
// HMAC-SHA1 with the account Auth Token, base64-encode, constant-time compare.
import { getSetting, setSetting } from './database.js'
import { twilioConfig } from './twilio.js'
import { twilioSignatureValid } from './twilio-sig.js'
export { twilioSignatureValid }

// Lightweight telemetry so we can PROVE real Twilio webhooks validate (through
// Render's proxy) before flipping the mode from 'monitor' to 'enforce'. Counts
// live in app_settings; the Settings diagnostics panel reads them back.
function recordSig(ok, path) {
  try {
    const now = new Date().toISOString()
    if (ok) {
      setSetting('twilio_sig_valid_count', String(Number(getSetting('twilio_sig_valid_count', '0')) + 1))
      setSetting('twilio_sig_last_valid_at', now)
    } else {
      setSetting('twilio_sig_invalid_count', String(Number(getSetting('twilio_sig_invalid_count', '0')) + 1))
      setSetting('twilio_sig_last_invalid_at', now)
      setSetting('twilio_sig_last_invalid_path', String(path || ''))
    }
  } catch {}
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
  const ok = twilioSignatureValid(url, req.body, req.get('X-Twilio-Signature'), twilioConfig().token)
  recordSig(ok, req.originalUrl)
  if (!ok) {
    console.warn(`[twilio-webhook] INVALID signature on ${req.originalUrl} (mode=${mode})`)
    if (mode === 'enforce') return res.status(403).type('text/plain').send('Invalid Twilio signature')
  }
  next()
}
