// CAN ONE TWILIO NUMBER HOLD THE SAME PERSON IN TWO GROUP CONVERSATIONS?
//
// This is the single fact the group-texting rebuild rests on, and Twilio does not state it.
// What IS documented, verbatim:
//
//   Participant resource: "The same person (i.e., a single personal phone number) can be
//   part of any number of conversations concurrently, as long as the address they are in
//   contact with (the ProxyAddress) is unique."
//        -> unlimited groups, but ONE PER SENDING NUMBER. That is exactly our ceiling, and
//           with one number it means one group per person.
//
//   Group Texting guide: "You only have to specify the SMS participant's own personal phone
//   number in MessagingBinding.Address. When using group texting, you won't need to specify
//   proxy addresses."
//        -> a native Group MMS participant is added with NO proxy at all. If there is no
//           proxy, the quoted uniqueness rule cannot bite, which is the whole hope here.
//
// FIRST ATTEMPT (2026-10-21) sent MessagingBinding.ProjectedAddress with a real mobile and
// got 50407 on every add. That was my error: ProjectedAddress is the mask for a CHAT
// participant with an Identity ("a projected address represents a non-native (such as Chat)
// Participant"), not a way to add a phone number. This version probes the documented forms
// instead of assuming one.
//
// Sends NO messages. Works in a throwaway Service it deletes in a finally block. Reads the
// live conversation holding Matt before and after so we learn here, not in front of a client.
import { twilioConfig, toE164 } from './twilio.js'
import db from './database.js'

const BASE = 'https://conversations.twilio.com/v1'
const authHeader = () => { const c = twilioConfig(); return 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') }

async function tw(method, path, form) {
  const opts = { method, headers: { Authorization: authHeader() } }
  if (form) { opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString() }
  const r = await fetch(path.startsWith('http') ? path : BASE + path, opts)
  const text = await r.text()
  let j = {}; try { j = text ? JSON.parse(text) : {} } catch {}
  return { ok: r.ok, status: r.status, code: j.code, message: j.message, body: j }
}
const slim = (r) => ({ ok: r.ok, status: r.status, code: r.code, message: r.message })

const participantsOf = async (svc, conv) => {
  const r = await tw('GET', `/Services/${svc}/Conversations/${conv}/Participants?PageSize=50`)
  return (r.body?.participants || []).map(p => ({
    address: p.messaging_binding?.address || null,
    proxy: p.messaging_binding?.proxy_address || null,
    projected: p.messaging_binding?.projected_address || null,
  }))
}
const has = (list, phone) => list.some(p => String(p.address || '').replace(/\D/g, '').slice(-10) === String(phone).replace(/\D/g, '').slice(-10))

export async function runGmmsBindingTest({ matt, john, prodConversationSid } = {}) {
  const c = twilioConfig()
  const proxy = toE164(c.from)
  const A = toE164(matt), B = toE164(john)
  const steps = []
  const step = (name, detail) => { steps.push({ name, ...detail }); return detail }
  let svc = null

  try {
    if (!c.sid || !c.token) throw new Error('Twilio not configured')

    const prodSvc = db.getSetting('twilio_conversations_service_sid', '')
    const before = prodConversationSid && prodSvc ? await participantsOf(prodSvc, prodConversationSid) : null
    step('live conversation before', { service: prodSvc, conversation: prodConversationSid, participants: before })

    svc = (await tw('POST', '/Services', { FriendlyName: 'GMMS BINDING TEST ' + new Date().toISOString() })).body.sid
    if (!svc) throw new Error('could not create an isolated test service')
    step('isolated test service', { service: svc })

    const newConv = async (name) => (await tw('POST', `/Services/${svc}/Conversations`, { FriendlyName: name })).body.sid

    // ---- which add format does Twilio actually accept for a phone number? ----
    const c1 = await newConv('format probe')
    const addrOnly = await tw('POST', `/Services/${svc}/Conversations/${c1}/Participants`, { 'MessagingBinding.Address': A })
    const withProxy = addrOnly.ok ? null
      : await tw('POST', `/Services/${svc}/Conversations/${c1}/Participants`, { 'MessagingBinding.Address': A, 'MessagingBinding.ProxyAddress': proxy })
    const form = addrOnly.ok ? 'address_only' : (withProxy?.ok ? 'address_plus_proxy' : 'neither')
    step('which add format works', {
      address_only: slim(addrOnly),
      address_plus_proxy: withProxy ? slim(withProxy) : 'not tried - address-only already worked',
      winner: form,
      participants: await participantsOf(svc, c1),
    })
    if (form === 'neither') {
      return { verdict: 'INCONCLUSIVE - Twilio rejected both documented add formats in a fresh Service; the number is probably tied to the production Service', steps }
    }

    const add = (conv) => form === 'address_only'
      ? tw('POST', `/Services/${svc}/Conversations/${conv}/Participants`, { 'MessagingBinding.Address': A })
      : tw('POST', `/Services/${svc}/Conversations/${conv}/Participants`, { 'MessagingBinding.Address': A, 'MessagingBinding.ProxyAddress': proxy })

    // ---- group 1: Matt + John together ----
    const g1 = await newConv('group one')
    const g1a = await add(g1)
    const g1b = form === 'address_only'
      ? await tw('POST', `/Services/${svc}/Conversations/${g1}/Participants`, { 'MessagingBinding.Address': B })
      : await tw('POST', `/Services/${svc}/Conversations/${g1}/Participants`, { 'MessagingBinding.Address': B, 'MessagingBinding.ProxyAddress': proxy })
    step('group one: Matt + John', { conversation: g1, matt: slim(g1a), john: slim(g1b), participants: await participantsOf(svc, g1) })

    // ---- the Hub's own number as a member (John asked; expected to be refused) ----
    const self = form === 'address_only'
      ? await tw('POST', `/Services/${svc}/Conversations/${g1}/Participants`, { 'MessagingBinding.Address': proxy })
      : await tw('POST', `/Services/${svc}/Conversations/${g1}/Participants`, { 'MessagingBinding.Address': proxy, 'MessagingBinding.ProxyAddress': proxy })
    step('hub number as a member', { attempted: proxy, ...slim(self), verdict: self.ok ? 'accepted (unexpected)' : 'refused - the sending number cannot also be a member' })

    // ---- THE QUESTION: a SECOND group with Matt in it, same Twilio number ----
    const g2 = await newConv('group two')
    const g2a = await add(g2)
    step('group two: Matt again, same number', { conversation: g2, matt: slim(g2a), participants: await participantsOf(svc, g2) })

    // ---- was he knocked out of group one? ----
    const g1After = await participantsOf(svc, g1)
    const stillInOne = has(g1After, A)
    step('group one re-checked', { participants: g1After, matt_still_in_group_one: stillInOne })

    const after = prodConversationSid && prodSvc ? await participantsOf(prodSvc, prodConversationSid) : null
    step('live conversation after', {
      conversation: prodConversationSid, participants: after,
      unchanged: JSON.stringify(before) === JSON.stringify(after),
    })

    const verdict = !g2a.ok
      ? `NO - the second group refused him (${g2a.code || g2a.status}: ${g2a.message})`
      : stillInOne
        ? 'YES - one Twilio number held the same person in two groups at once, and the first group kept him'
        : 'NO - the second group accepted him but silently removed him from the first, exactly as proxy mode does'

    return { verdict, add_format: form, sending_number: proxy, matt: A, john: B, steps }
  } finally {
    if (svc) {
      const del = await tw('DELETE', `/Services/${svc}`)
      steps.push({ name: 'test service deleted', service: svc, ok: del.ok, status: del.status })
    }
  }
}
