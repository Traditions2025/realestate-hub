// Twilio Voice for the Hub — browser softphone (make + receive calls with accept/
// reject). Uses the same account creds as SMS (twilio.js). No SDK: we mint the
// Voice access token as a signed JWT ourselves and call Twilio's REST API directly.
import crypto from 'crypto'
import db, { getSetting, setSetting } from './database.js'
import { twilioConfig, toE164 } from './twilio.js'

const VOICE_IDENTITY = 'hub'   // single shared browser client for the team
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function creds() {
  const c = twilioConfig()
  return { sid: c.sid, token: c.token, from: c.from, auth: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') }
}

// One-time infra: an API Key (for signing tokens) + a TwiML App (routes outbound
// calls from the browser) + the number's Voice webhook. Idempotent — stores SIDs
// in app_settings and reuses them. Returns a status object.
export async function ensureVoiceInfra(baseUrl) {
  const c = creds()
  if (!c.sid || !c.token) throw new Error('Twilio is not connected (add Account SID + Auth Token in Settings).')
  const H = { Authorization: c.auth, 'Content-Type': 'application/x-www-form-urlencoded' }
  const out = { created: [] }

  // 1) API Key + Secret (secret is only returned once, at creation)
  let keySid = getSetting('twilio_api_key_sid', '')
  let keySecret = getSetting('twilio_api_key_secret', '')
  if (!keySid || !keySecret) {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Keys.json`, { method: 'POST', headers: H, body: 'FriendlyName=Hub+Voice' })
    const j = await r.json()
    if (!r.ok) throw new Error('Could not create API Key: ' + (j.message || r.status))
    keySid = j.sid; keySecret = j.secret
    setSetting('twilio_api_key_sid', keySid); setSetting('twilio_api_key_secret', keySecret)
    out.created.push('api_key')
  }

  // 2) TwiML App (its VoiceUrl handles outbound calls placed from the browser)
  let appSid = getSetting('twilio_twiml_app_sid', '')
  const outboundUrl = `${baseUrl}/api/voice/outbound`
  if (!appSid) {
    const body = new URLSearchParams({ FriendlyName: 'Hub Voice', VoiceUrl: outboundUrl, VoiceMethod: 'POST' })
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Applications.json`, { method: 'POST', headers: H, body: body.toString() })
    const j = await r.json()
    if (!r.ok) throw new Error('Could not create TwiML App: ' + (j.message || r.status))
    appSid = j.sid; setSetting('twilio_twiml_app_sid', appSid); out.created.push('twiml_app')
  } else {
    // keep the app's VoiceUrl current (in case the base URL changed)
    const body = new URLSearchParams({ VoiceUrl: outboundUrl, VoiceMethod: 'POST' })
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Applications/${appSid}.json`, { method: 'POST', headers: H, body: body.toString() }).catch(() => {})
  }

  // 3) Point the Hub number's Voice webhook at the inbound handler
  const number = c.from
  let numberWired = false
  if (number) {
    const listR = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(toE164(number))}`, { headers: { Authorization: c.auth } })
    const listJ = await listR.json().catch(() => ({}))
    const pn = (listJ.incoming_phone_numbers || [])[0]
    if (pn) {
      const body = new URLSearchParams({ VoiceUrl: `${baseUrl}/api/voice/inbound`, VoiceMethod: 'POST', StatusCallback: `${baseUrl}/api/voice/status`, StatusCallbackMethod: 'POST' })
      const upR = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers/${pn.sid}.json`, { method: 'POST', headers: H, body: body.toString() })
      numberWired = upR.ok
    }
  }

  return { ok: true, api_key_sid: keySid, twiml_app_sid: appSid, number, number_wired: numberWired, ...out }
}

// Build a Twilio Voice access token (JWT) for the browser Device.
export function voiceToken(identity = VOICE_IDENTITY) {
  const c = creds()
  const keySid = getSetting('twilio_api_key_sid', '')
  const keySecret = getSetting('twilio_api_key_secret', '')
  const appSid = getSetting('twilio_twiml_app_sid', '')
  if (!c.sid || !keySid || !keySecret || !appSid) return { ok: false, error: 'Voice not set up yet — run setup first.' }
  const now = Math.floor(Date.now() / 1000)
  const header = { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' }
  const payload = {
    jti: `${keySid}-${now}`, iss: keySid, sub: c.sid, iat: now, nbf: now, exp: now + 3600,
    grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } } },
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = b64url(crypto.createHmac('sha256', keySecret).update(signingInput).digest())
  return { ok: true, token: `${signingInput}.${sig}`, identity, ttl: 3600 }
}

export const VOICE = { identity: VOICE_IDENTITY }
export function voiceConfigured() {
  return !!(getSetting('twilio_api_key_sid', '') && getSetting('twilio_twiml_app_sid', '') && twilioConfig().enabled)
}
