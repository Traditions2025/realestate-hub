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
  const proxy10 = String(proxy).replace(/\D/g, '').slice(-10)
  // Never add our own Hub number as a participant (a number can't text itself) — e.g. a
  // team-directory entry that points at the Hub line.
  const clean = (recipients || []).map(r => ({ phone: toE164(r.phone), name: r.name || null, client_id: r.client_id || null }))
    .filter(r => r.phone && String(r.phone).replace(/\D/g, '').slice(-10) !== proxy10)
  if (clean.length < 2) throw new Error('A group text needs at least 2 recipients (our own Hub number is skipped automatically)')
  const sid = await ensureConversationsService()
  const conv = await tw('POST', `/Services/${sid}/Conversations`, { FriendlyName: 'Group text ' + new Date().toISOString() })
  const convSid = conv.sid
  const participants = [], skipped = []
  // Twilio binds a phone + our proxy to ONE conversation. When someone is stuck in
  // an OLD group (e.g. Dave in a superseded thread), pull them out of that
  // conversation and retry — the new group wins. The old thread keeps its history;
  // it simply stops including this participant.
  const addParticipant = (phone) => tw('POST', `/Services/${sid}/Conversations/${convSid}/Participants`, {
    'MessagingBinding.Address': phone,
    'MessagingBinding.ProxyAddress': proxy,
  })
  const removeFromConversation = async (oldConvSid, phone) => {
    const j = await tw('GET', `/Services/${sid}/Conversations/${oldConvSid}/Participants?PageSize=50`)
    const p = (j.participants || []).find(x => (x.messaging_binding?.address || '') === phone)
    if (!p) return false
    await tw('DELETE', `/Services/${sid}/Conversations/${oldConvSid}/Participants/${p.sid}`)
    return true
  }
  for (const rp of clean) {
    try {
      await addParticipant(rp.phone)
      participants.push(rp)
    } catch (e) {
      const m = String(e.message || '').match(/already exists in Conversation (CH[a-f0-9]{32})/i)
      if (m) {
        try {
          const moved = await removeFromConversation(m[1], rp.phone)
          if (moved) { await addParticipant(rp.phone); participants.push({ ...rp, migrated_from: m[1] }); continue }
        } catch (e2) { skipped.push({ ...rp, error: e2.message }); continue }
      }
      skipped.push({ ...rp, error: e.message })
    }
  }
  if (!participants.length) { try { await tw('DELETE', `/Services/${sid}/Conversations/${convSid}`) } catch {}; throw new Error('Could not add any participants: ' + (skipped[0]?.error || 'unknown')) }
  const msg = await tw('POST', `/Services/${sid}/Conversations/${convSid}/Messages`, { Author: author, Body: body })
  return { conversationSid: convSid, serviceSid: sid, participants, skipped, messageSid: msg.sid }
}

// Send a message INTO an existing group conversation (agent replying to the group).
export async function sendConversationMessage(convSid, body, author = 'Matt Smith Team') {
  const sid = await ensureConversationsService()
  // Twilio accepts a message into a conversation that has no participants left: it stores
  // it, returns a message SID, and delivers it to nobody. Every caller treated that SID as
  // proof the group got the text.
  //
  // Conversations DO empty out on their own. Twilio allows one binding per phone + proxy
  // pair, so adding a phone to a NEWER group unbinds it from the older one (see
  // createGroupText's migration). A group that worked last month can be empty today while
  // the Hub's group_meta still lists everyone.
  //
  // 2026-10-06: the Deutsch congratulations text was posted into exactly such a conversation
  // - three names in the snapshot, zero participants in Twilio - and reached nobody. Matt
  // noticing he had no text is the only reason anyone found out.
  const p = await tw('GET', `/Services/${sid}/Conversations/${convSid}/Participants?PageSize=50`)
  const reachable = (p.participants || []).map(x => x.messaging_binding?.address).filter(Boolean)
  if (!reachable.length) {
    const e = new Error('This group conversation has no participants left in Twilio, so the message would have reached nobody. Send it as a new group text to rebuild the group.')
    e.code = 'CONVERSATION_EMPTY'
    throw e
  }
  const msg = await tw('POST', `/Services/${sid}/Conversations/${convSid}/Messages`, { Author: author, Body: body })
  return { messageSid: msg.sid, deliveredTo: reachable }
}

// Per-recipient delivery receipts for a group conversation's recent outbound
// messages — the only way to CONFIRM a group text reached each phone (the plain
// messaging status callbacks don't fire for Conversations sends).
export async function groupDeliveryReceipts(convSid, limit = 3) {
  const sid = await ensureConversationsService()
  const j = await tw('GET', `/Services/${sid}/Conversations/${convSid}/Messages?Order=desc&PageSize=${Math.min(Number(limit) || 3, 10)}`)
  const out = []
  for (const m of (j.messages || [])) {
    // Inbound group messages (author = a participant's phone): include them with their
    // author so "who actually sent this?" is answerable — the phones themselves show
    // every group message as coming from the Hub number with no name attached.
    if (!m.author || m.author.startsWith('+')) {
      out.push({ message_sid: m.sid, inbound: true, author: m.author || null, body: String(m.body || '').slice(0, 160), date_created: m.date_created })
      continue
    }
    let receipts = []
    try {
      const r = await tw('GET', `/Services/${sid}/Conversations/${convSid}/Messages/${m.sid}/Receipts?PageSize=50`)
      receipts = (r.delivery_receipts || []).map(x => ({ to: null, participant_sid: x.participant_sid, status: x.status, error: x.error_code || null }))
    } catch {}
    // resolve participant sids to phone numbers for a readable report
    try {
      const p = await tw('GET', `/Services/${sid}/Conversations/${convSid}/Participants?PageSize=50`)
      const byId = new Map((p.participants || []).map(x => [x.sid, x.messaging_binding?.address || null]))
      for (const rc of receipts) rc.to = byId.get(rc.participant_sid) || null
    } catch {}
    out.push({ message_sid: m.sid, body: String(m.body || '').slice(0, 120), date_created: m.date_created, delivery: m.delivery || null, receipts })
  }
  return { conversation: convSid, messages: out }
}

// Fetch a conversation's participant addresses (for labeling inbound replies).
export async function conversationParticipants(serviceSid, convSid) {
  try {
    const j = await tw('GET', `/Services/${serviceSid}/Conversations/${convSid}/Participants?PageSize=50`)
    return (j.participants || []).map(p => p.messaging_binding?.address).filter(Boolean)
  } catch { return [] }
}

// Read-only diagnostic: who is ACTUALLY in a conversation right now, with their SMS
// binding. The Hub's group_meta is a snapshot taken when the group was created; Twilio's
// live roster can differ, because createGroupText MOVES a participant out of an older
// conversation when their phone + our proxy is already bound elsewhere. A person missing
// here, or present with no messaging_binding.address, is in the thread's history but
// receives nothing. Never sends; GETs only.
export async function conversationRoster(convSid) {
  const sid = await ensureConversationsService()
  const conv = await tw('GET', `/Services/${sid}/Conversations/${convSid}`)
  const j = await tw('GET', `/Services/${sid}/Conversations/${convSid}/Participants?PageSize=50`)
  const live = (j.participants || []).map(p => ({
    participant_sid: p.sid,
    address: p.messaging_binding?.address || null,
    proxy_address: p.messaging_binding?.proxy_address || null,
    type: p.messaging_binding?.type || null,
    identity: p.identity || null,
    date_created: p.date_created,
  }))
  // What the Hub believed the group was, for comparison.
  let snapshot = []
  try {
    const row = db.get('SELECT group_meta FROM communications WHERE conversation_sid=? AND group_meta IS NOT NULL ORDER BY id DESC LIMIT 1', [convSid])
    if (row?.group_meta) snapshot = (JSON.parse(row.group_meta).participants || [])
  } catch {}
  const key = (p) => String(p || '').replace(/\D/g, '').slice(-10)
  const liveKeys = new Set(live.map(p => key(p.address)).filter(Boolean))
  return {
    conversation: convSid,
    state: conv.state || null,
    friendly_name: conv.friendly_name || null,
    live_participants: live,
    hub_snapshot: snapshot,
    // Anyone the Hub thinks is in the group who is not actually bound in Twilio: the
    // thread shows them, but a send to this conversation never reaches their phone.
    missing_from_twilio: snapshot.filter(s => !liveKeys.has(key(s.phone))),
    no_binding: live.filter(p => !p.address),
  }
}
