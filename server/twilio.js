// Twilio SMS integration for the Hub. Credentials live in app_settings (entered in
// Settings, never in code). No SDK — we call Twilio's REST API directly.
import db from './database.js'

export function twilioConfig() {
  return {
    sid: (db.getSetting('twilio_account_sid', '') || '').trim(),
    token: (db.getSetting('twilio_auth_token', '') || '').trim(),
    from: (db.getSetting('twilio_from_number', '') || '').trim(),
    messagingServiceSid: (db.getSetting('twilio_messaging_service_sid', '') || '').trim(),
    enabled: db.getSetting('twilio_enabled', '0') === '1',
  }
}

// Ready to send = enabled, has account creds, and has a sender (a From number or a Messaging Service).
export function twilioConfigured() {
  const c = twilioConfig()
  return !!(c.enabled && c.sid && c.token && (c.from || c.messagingServiceSid))
}

export function phoneKey(p) {
  if (!p) return null
  const d = String(p).replace(/\D/g, '')
  return d.length >= 10 ? d.slice(-10) : null
}

// Normalize a US phone to E.164 (+1XXXXXXXXXX) for Twilio.
export function toE164(p) {
  const raw = String(p || '').trim()
  if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '')
  const d = raw.replace(/\D/g, '')
  if (d.length === 10) return '+1' + d
  if (d.length === 11 && d[0] === '1') return '+' + d
  return d ? '+' + d : ''
}

// STOP / START keyword handling (CTIA compliance). Returns 'stop' | 'start' | null.
const STOP_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out'])
const START_WORDS = new Set(['start', 'yes', 'unstop', 'optin', 'opt-in'])
export function optKeyword(body) {
  const w = String(body || '').trim().toLowerCase().replace(/[^a-z-]/g, '')
  if (STOP_WORDS.has(w)) return 'stop'
  if (START_WORDS.has(w)) return 'start'
  return null
}

// Send an SMS. Throws on failure with a readable message. `statusCallback` is the
// public URL Twilio pings with delivery updates (optional).
export async function sendSms(toPhone, body, opts = {}) {
  const c = twilioConfig()
  if (!c.enabled) throw new Error('Texting is turned off in Settings.')
  if (!c.sid || !c.token) throw new Error('Twilio is not connected — add your Account SID and Auth Token in Settings.')
  if (!c.from && !c.messagingServiceSid) throw new Error('No Twilio sending number or Messaging Service set in Settings.')
  const to = toE164(toPhone)
  if (!to || to.replace(/\D/g, '').length < 11) throw new Error('Invalid recipient phone number.')
  const params = new URLSearchParams()
  params.set('To', to)
  if (c.messagingServiceSid) params.set('MessagingServiceSid', c.messagingServiceSid)
  else params.set('From', c.from)
  params.set('Body', String(body == null ? '' : body))
  if (opts.statusCallback) params.set('StatusCallback', opts.statusCallback)
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const hint = data.code === 20003 ? ' (auth failed — check the Auth Token, or the account may be suspended/unfunded)' : ''
    throw new Error((data.message || `Twilio error ${resp.status}`) + hint)
  }
  return { sid: data.sid, status: data.status, to }
}

// Read-only credential check — used by Settings "Test connection".
export async function twilioVerify() {
  const c = twilioConfig()
  if (!c.sid || !c.token) return { ok: false, error: 'Add your Account SID and Auth Token first.' }
  try {
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}.json`, {
      headers: { 'Authorization': 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') },
    })
    const data = await resp.json().catch(() => ({}))
    if (resp.ok && data.status) return { ok: true, status: data.status, name: data.friendly_name, from: c.from || c.messagingServiceSid }
    const suspended = data.code === 20003
    return { ok: false, code: data.code, error: (data.message || `HTTP ${resp.status}`) + (suspended ? ' — the token is wrong OR the account is suspended (add funds to reactivate).' : '') }
  } catch (e) { return { ok: false, error: e.message } }
}
