// CAN ONE TWILIO NUMBER HOLD THE SAME PERSON IN TWO GROUP MMS CONVERSATIONS?
//
// This is the single fact the whole group-texting rebuild rests on, and Twilio does not
// document it. What IS documented points two ways:
//
//   50416 "Participant and proxy address pair is already in use" - the conflict is with any
//         "active conversation", i.e. ACROSS conversations. This is the rule we hit today,
//         because createGroupText binds people with MessagingBinding.ProxyAddress.
//
//   50437 "Group Participant already exists" - every cause is scoped "in this conversation",
//         including "A native GMMS Participant with the same Address exists in this
//         conversation". No cross-conversation rule is documented for Group MMS at all.
//
// So the evidence favours Group MMS allowing overlap, by the absence of a rule rather than
// the presence of one. That is not good enough to rebuild on, hence this.
//
// WHAT IT DOES NOT DO:
//   - sends no messages, to anyone. The binding conflict fires when a participant is ADDED,
//     which is why this can be settled without texting a single person.
//   - never writes to the production Conversations Service. It creates its own throwaway
//     Service, and deletes it at the end.
//   - buys nothing.
//
// It DOES read the production conversation that currently holds Matt, before and after, so
// that if a Group MMS add disturbs his existing proxy binding we find out here rather than
// in front of a client.
import { twilioConfig, toE164 } from './twilio.js'

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

// A native Group MMS participant: real address + the Twilio number as the PROJECTED
// address. This is the binding type we are testing, and the one our code does not use.
const addGmms = (svc, conv, address, projected) =>
  tw('POST', `/Services/${svc}/Conversations/${conv}/Participants`, {
    'MessagingBinding.Address': address,
    'MessagingBinding.ProjectedAddress': projected,
  })

const listParticipants = async (svc, conv) => {
  const r = await tw('GET', `/Services/${svc}/Conversations/${conv}/Participants?PageSize=50`)
  return (r.body?.participants || []).map(p => ({
    address: p.messaging_binding?.address || null,
    projected: p.messaging_binding?.projected_address || null,
    proxy: p.messaging_binding?.proxy_address || null,
  }))
}

export async function runGmmsBindingTest({ matt, john, prodConversationSid } = {}) {
  const c = twilioConfig()
  const projected = toE164(c.from)
  const A = toE164(matt), B = toE164(john)
  const log = []
  const step = (name, detail) => { log.push({ name, ...detail }); return detail }
  let svc = null

  try {
    if (!c.sid || !c.token) throw new Error('Twilio not configured')

    // ---- 0. snapshot the live conversation that currently holds Matt ----
    let beforeProd = null
    if (prodConversationSid) {
      // the production service sid is cached in settings; read it without mutating anything
      const svcSid = (await import('./database.js')).default.getSetting('twilio_conversations_service_sid', '')
      beforeProd = svcSid ? await listParticipants(svcSid, prodConversationSid) : null
      step('snapshot production conversation', { conversation: prodConversationSid, participants: beforeProd })
    }

    // ---- 1. throwaway service, so production is untouched ----
    const made = await tw('POST', '/Services', { FriendlyName: 'GMMS BINDING TEST ' + new Date().toISOString() })
    if (!made.ok) throw new Error('could not create test service: ' + made.message)
    svc = made.body.sid
    step('created isolated test service', { service: svc })

    // ---- 2. conversation A: Matt + John, both native Group MMS ----
    const convA = (await tw('POST', `/Services/${svc}/Conversations`, { FriendlyName: 'GMMS test A' })).body.sid
    const a1 = await addGmms(svc, convA, A, projected)
    const a2 = await addGmms(svc, convA, B, projected)
    step('conversation A', {
      conversation: convA,
      matt_added: { ok: a1.ok, status: a1.status, code: a1.code, message: a1.message },
      john_added: { ok: a2.ok, status: a2.status, code: a2.code, message: a2.message },
      participants: await listParticipants(svc, convA),
    })

    // ---- 3. the Hub's own number as a participant (John asked; expected to fail) ----
    const selfAdd = await addGmms(svc, convA, projected, projected)
    step('hub number as a participant', {
      attempted: projected,
      ok: selfAdd.ok, status: selfAdd.status, code: selfAdd.code, message: selfAdd.message,
      verdict: selfAdd.ok ? 'accepted (unexpected)' : 'rejected, as expected - the sending number cannot also be a member',
    })

    // ---- 4. THE TEST: a SECOND conversation with the SAME people, same number ----
    const convB = (await tw('POST', `/Services/${svc}/Conversations`, { FriendlyName: 'GMMS test B' })).body.sid
    const b1 = await addGmms(svc, convB, A, projected)
    const b2 = await addGmms(svc, convB, B, projected)
    step('conversation B (the actual question)', {
      conversation: convB,
      matt_added_again: { ok: b1.ok, status: b1.status, code: b1.code, message: b1.message },
      john_added_again: { ok: b2.ok, status: b2.status, code: b2.code, message: b2.message },
      participants: await listParticipants(svc, convB),
    })

    // ---- 5. did adding them to B knock them out of A? ----
    const aAfter = await listParticipants(svc, convA)
    const stillInA = aAfter.some(p => String(p.address).replace(/\D/g, '').slice(-10) === String(A).replace(/\D/g, '').slice(-10))
    step('conversation A re-checked', { participants: aAfter, matt_still_in_A: stillInA })

    // ---- 6. did any of this disturb the live production conversation? ----
    let afterProd = null
    if (prodConversationSid) {
      const svcSid = (await import('./database.js')).default.getSetting('twilio_conversations_service_sid', '')
      afterProd = svcSid ? await listParticipants(svcSid, prodConversationSid) : null
      step('production conversation re-checked', {
        conversation: prodConversationSid,
        participants: afterProd,
        unchanged: JSON.stringify(beforeProd) === JSON.stringify(afterProd),
      })
    }

    const verdict = b1.ok && stillInA
      ? 'YES - one Twilio number can hold the same person in two Group MMS conversations at once'
      : (!b1.ok
        ? `NO - the second add was rejected (${b1.code || b1.status}: ${b1.message})`
        : 'NO - the second add succeeded but evicted them from the first, same as proxy mode')

    return { verdict, projected_address: projected, matt: A, john: B, steps: log }
  } finally {
    // ---- always clean up, even on an error ----
    if (svc) {
      const del = await tw('DELETE', `/Services/${svc}`)
      log.push({ name: 'deleted test service', service: svc, ok: del.ok, status: del.status })
    }
  }
}
