// True group texting via the Twilio Conversations API (group MMS). All recipients sit
// in ONE conversation bound to our MMS-capable number; a message fans out to everyone
// and replies come back into the same conversation (via the onMessageAdded webhook), so
// the Hub can show one grouped thread instead of N individual threads.
//
// NOTE: real reply-all group MMS requires the sending number to be MMS-capable and the
// carrier to support group messaging. conversationsStatus() checks readiness first.
import db from './database.js'
import { twilioConfig, toE164 } from './twilio.js'

const BASE = 'https://conversations.twilio.com/v1'
const SERVICE_NAME = 'MST Hub Group Texts'

function authHeader() { const c = twilioConfig(); return 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') }
async function tw(method, path, form) {
  const url = path.startsWith('http') ? path : BASE + path
  const opts = { method, headers: { Authorization: authHeader() } }
  if (form) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString() }
  const r = await fetch(url, opts)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(j.message || `Twilio ${r.status}`); e.code = j.code; e.status = r.status; throw e }
  return j
}

// Get (or create) the dedicated Conversations Service; SID cached in settings.
export async function ensureConversationsService() {
  let sid = db.getSetting('twilio_conversations_service_sid', '')
  if (sid) { try { await tw('GET', `/Services/${sid}`); return sid } catch { sid = '' } }
  const list = await tw('GET', '/Services?PageSize=50')
  const found = (list.services || []).find(s => s.friendly_name === SERVICE_NAME)
  sid = found ? found.sid : (await tw('POST', '/Services', { FriendlyName: SERVICE_NAME })).sid
  db.setSetting('twilio_conversations_service_sid', sid)
  return sid
}

// Point the service's onMessageAdded webhook at the Hub so inbound group replies land here.
export async function ensureConversationsWebhook(hubBase) {
  const sid = await ensureConversationsService()
  await tw('POST', `/Services/${sid}/Configuration/Webhooks`, {
    Filters: 'onMessageAdded',
    PostWebhookUrl: hubBase.replace(/\/+$/, '') + '/api/inbox/conversations-webhook',
    Method: 'POST',
  })
  return sid
}

// Readiness check: Conversations reachable, service provisions, number MMS-capable.
export async function conversationsStatus() {
  const c = twilioConfig()
  const out = { number: c.from, enabled: false, service_sid: null, mms_capable: null, ready: false, checks: [] }
  const add = (name, ok, detail) => out.checks.push({ name, ok, detail })
  if (!c.sid || !c.token) { add('Twilio account', false, 'not connected'); return out }
  try { const sid = await ensureConversationsService(); out.service_sid = sid; out.enabled = true; add('Conversations service', true, sid) }
  catch (e) { add('Conversations service', false, e.message); return out }
  // number MMS capability
  try {
    const pn = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(toE164(c.from))}`, { headers: { Authorization: authHeader() } })
    const pj = await pn.json().catch(() => ({}))
    const num = (pj.incoming_phone_numbers || [])[0]
    out.mms_capable = !!(num && num.capabilities && num.capabilities.mms)
    add('MMS capability', out.mms_capable, out.mms_capable ? 'yes' : 'number is not MMS-capable — group MMS will not work')
  } catch (e) { add('MMS capability', false, e.message) }
  out.ready = out.enabled && out.mms_capable === true
  return out
}

// Create a group conversation, add each recipient (bound to our number), and send `body`.
// Returns { conversationSid, participants:[{phone,name}], messageSid, skipped:[...] }.
export async function createGroupText({ recipients, body, author = 'Matt Smith Team' }) {
  const c = twilioConfig()
  const proxy = toE164(c.from)
  if (!proxy) throw new Error('No sending number configured')
  const clean = (recipients || []).map(r => ({ phone: toE164(r.phone), name: r.name || null })).filter(r => r.phone)
  if (clean.length < 2) throw new Error('A group text needs at least 2 recipients')
  const sid = await ensureConversationsService()
  const conv = await tw('POST', `/Services/${sid}/Conversations`, { FriendlyName: 'Group text ' + new Date().toISOString() })
  const convSid = conv.sid
  const participants = [], skipped = []
  for (const rp of clean) {
    try {
      await tw('POST', `/Services/${sid}/Conversations/${convSid}/Participants`, {
        'MessagingBinding.Address': rp.phone,
        'MessagingBinding.ProxyAddress': proxy,
      })
      participants.push(rp)
    } catch (e) { skipped.push({ ...rp, error: e.message }) }
  }
  if (!participants.length) { try { await tw('DELETE', `/Services/${sid}/Conversations/${convSid}`) } catch {}; throw new Error('Could not add any participants: ' + (skipped[0]?.error || 'unknown')) }
  const msg = await tw('POST', `/Services/${sid}/Conversations/${convSid}/Messages`, { Author: author, Body: body })
  return { conversationSid: convSid, serviceSid: sid, participants, skipped, messageSid: msg.sid }
}

// Fetch a conversation's participant addresses (for labeling inbound replies).
export async function conversationParticipants(serviceSid, convSid) {
  try {
    const j = await tw('GET', `/Services/${serviceSid}/Conversations/${convSid}/Participants?PageSize=50`)
    return (j.participants || []).map(p => p.messaging_binding?.address).filter(Boolean)
  } catch { return [] }
}
