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

// Point a Twilio phone number's inbound SMS webhook (and delivery status callback)
// at the Hub, so incoming texts land in the Hub inbox. Repoints away from whatever
// it was wired to before (e.g. GoHighLevel/LeadConnector). Returns before/after so
// the caller can see what changed. NOTE: if the number is attached to a Messaging
// Service, inbound routing follows the Messaging Service's webhook, not the number's
// SmsUrl — we surface that in the result so it can be handled.
export async function wireNumberToHub(numberE164, smsUrl, statusUrl) {
  const c = twilioConfig()
  if (!c.sid || !c.token) throw new Error('Twilio is not connected — add your Account SID and Auth Token in Settings.')
  const auth = 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
  const target = toE164(numberE164)
  if (!target) throw new Error('No number given to wire.')
  const listUrl = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(target)}`
  const lr = await fetch(listUrl, { headers: { Authorization: auth } })
  const ld = await lr.json().catch(() => ({}))
  if (!lr.ok) throw new Error(ld.message || `Twilio list error ${lr.status}`)
  const num = (ld.incoming_phone_numbers || [])[0]
  if (!num) throw new Error(`Number ${target} was not found on this Twilio account.`)
  const before = { sms_url: num.sms_url || '', sms_method: num.sms_method || '', status_callback: num.status_callback || '' }
  const params = new URLSearchParams()
  params.set('SmsUrl', smsUrl)
  params.set('SmsMethod', 'POST')
  if (statusUrl) { params.set('StatusCallback', statusUrl); params.set('StatusCallbackMethod', 'POST') }
  const upUrl = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers/${num.sid}.json`
  const ur = await fetch(upUrl, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() })
  const ud = await ur.json().catch(() => ({}))
  if (!ur.ok) throw new Error(ud.message || `Twilio update error ${ur.status}`)
  return {
    number: target, sid: num.sid,
    before,
    after: { sms_url: ud.sms_url || '', sms_method: ud.sms_method || '', status_callback: ud.status_callback || '' },
  }
}

// Admin health check for the whole communications stack. Returns a list of checks
// with status: 'ok' | 'attention' | 'missing'. Never returns secret values.
export async function commsHealth() {
  const c = twilioConfig()
  const base = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  const checks = []
  const add = (name, status, detail) => checks.push({ name, status, detail })
  if (!c.sid || !c.token) { add('Twilio account', 'missing', 'Account SID / Auth Token not set in Settings'); return { ok: false, checks } }
  const auth = 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
  const get = async (u) => { try { const r = await fetch(u, { headers: { Authorization: auth } }); return { ok: r.ok, j: await r.json().catch(() => ({})) } } catch (e) { return { ok: false, j: {}, err: e.message } } }
  // account
  const acct = await get(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}.json`)
  add('Twilio account', acct.ok && acct.j.status === 'active' ? 'ok' : 'attention', acct.ok ? `${acct.j.friendly_name} (${acct.j.status})` : 'Cannot reach Twilio — check the Auth Token')
  add('Texting enabled', c.enabled ? 'ok' : 'attention', c.enabled ? 'On' : 'Turn on in Settings')
  add('Sending number', c.from ? 'ok' : 'missing', c.from || 'No From number set')
  // number capabilities + webhooks
  if (c.from) {
    const pn = await get(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(toE164(c.from))}`)
    const n = (pn.j.incoming_phone_numbers || [])[0]
    if (n) {
      const cap = n.capabilities || {}
      add('SMS / MMS capability', cap.sms ? 'ok' : 'attention', `SMS ${cap.sms ? 'yes' : 'no'} · MMS ${cap.mms ? 'yes' : 'no'}`)
      add('Voice capability', cap.voice ? 'ok' : 'attention', cap.voice ? 'yes' : 'no')
      const vOk = /\/api\/voice\/inbound/.test(n.voice_url || '')
      add('Voice webhook', vOk ? 'ok' : 'attention', vOk ? 'Points at the Hub' : `Currently: ${n.voice_url || '(none)'}`)
    } else add('Phone number', 'attention', 'Number not found on this Twilio account')
  }
  // A2P
  try { const a = await a2pStatus(c.from); const camp = a.services?.find(s => s.has_our_number)?.us_a2p?.[0]?.campaign_status; add('A2P 10DLC registration', camp === 'VERIFIED' ? 'ok' : (a.number_in_any_service ? 'attention' : 'missing'), camp ? `Campaign ${camp}` : 'Number not linked to a verified campaign') } catch { add('A2P 10DLC registration', 'attention', 'Could not read A2P status') }
  // voice infra + settings
  const voiceReady = !!(db.getSetting('twilio_api_key_sid', '') && db.getSetting('twilio_twiml_app_sid', ''))
  const sigMode = db.getSetting('twilio_signature_mode', 'monitor')
  const recOn = db.getSetting('twilio_record_calls', '0') === '1'
  add('Browser calling', voiceReady ? 'ok' : 'missing', voiceReady ? 'API key + TwiML app configured' : 'Run voice setup')
  add('Webhook signature check', sigMode === 'enforce' ? 'ok' : 'attention', `Mode: ${sigMode} (flip to enforce once monitored)`)
  add('Call recording', recOn ? 'ok' : 'attention', recOn ? 'Enabled' : 'Off (opt-in)')
  const ok = checks.every(x => x.status !== 'missing')
  return { ok, checks }
}

// Read-only A2P 10DLC status check for a number: the account's brand registration,
// and each Messaging Service's US A2P campaign status + whether this number is in it.
export async function a2pStatus(numberE164) {
  const c = twilioConfig()
  if (!c.sid || !c.token) return { ok: false, error: 'Twilio not connected.' }
  const auth = 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
  const target = toE164(numberE164 || c.from)
  const get = async (url) => { try { const r = await fetch(url, { headers: { Authorization: auth } }); const j = await r.json().catch(() => ({})); return { ok: r.ok, status: r.status, j } } catch (e) { return { ok: false, error: e.message, j: {} } } }
  const out = { number: target, brands: [], services: [] }
  // 1) A2P Brand registrations (account-level)
  const br = await get('https://messaging.twilio.com/v1/a2p/BrandRegistrations?PageSize=20')
  for (const b of (br.j.data || [])) out.brands.push({ sid: b.sid, status: b.status, identity_status: b.identity_status, brand_type: b.brand_type, failure_reason: b.failure_reason || null })
  // 2) Messaging Services: is our number in it, and what's the US A2P campaign status
  const svc = await get('https://messaging.twilio.com/v1/Services?PageSize=50')
  for (const s of (svc.j.services || [])) {
    const pn = await get(`https://messaging.twilio.com/v1/Services/${s.sid}/PhoneNumbers?PageSize=200`)
    const hasNum = (pn.j.phone_numbers || pn.j.data || []).some(n => n.phone_number === target)
    const usa2p = await get(`https://messaging.twilio.com/v1/Services/${s.sid}/Compliance/Usa2p`)
    const camps = (usa2p.j.compliance || (usa2p.j.sid ? [usa2p.j] : [])).map(x => ({
      campaign_status: x.campaign_status, brand_registration_sid: x.brand_registration_sid,
      us_app_to_person_usecase: x.us_app_to_person_usecase, message_samples: (x.message_samples || []).length,
    }))
    if (hasNum || camps.length) out.services.push({
      sid: s.sid, name: s.friendly_name, has_our_number: hasNum, us_a2p: camps,
      // Inbound routing for this service: if use_inbound_webhook_on_number is true,
      // Twilio uses each number's own SmsUrl; else it uses the service's URL below.
      inbound_request_url: s.inbound_request_url || '', inbound_method: s.inbound_method || '',
      use_inbound_webhook_on_number: s.use_inbound_webhook_on_number,
    })
  }
  out.number_in_any_service = out.services.some(s => s.has_our_number)
  return { ok: true, ...out }
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
