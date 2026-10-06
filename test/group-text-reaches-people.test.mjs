// A group text must not report success when it reached nobody.
//
// Matt, 2026-10-06: he did not get the congratulations text sent to Dave and Liz Deutsch.
// The live Twilio roster for that conversation (CH574f9de...) held ZERO participants, so
// the message reached none of the three - the clients included. The Hub showed it as sent.
//
// Two things combined:
//   1. group_meta, the participant list the Hub matches against when deciding to reuse a
//      conversation, is a snapshot written at creation and never re-read.
//   2. Twilio allows one binding per phone + proxy pair, so adding any of those phones to
//      a newer group UNBINDS it from the older conversation. The snapshot still lists
//      everyone; Twilio no longer reaches anyone.
// And Twilio accepts a message into an empty conversation, returning a real message SID.
// The SID was treated as proof of delivery.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const conv = fs.readFileSync(new URL('../server/twilio-conversations.js', import.meta.url), 'utf8')
const inbox = fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')

// ── the guard every send path goes through ───────────────────────────────────────────
// sendConversationMessage is used by BOTH the group-text reuse path and group-reply, so
// putting the check here covers replies too, and anything written later.
const send = conv.slice(conv.indexOf('export async function sendConversationMessage'),
                        conv.indexOf('export async function sendConversationMessage') + 2200)

test('it reads the participant list before posting a message', () => {
  assert.match(send, /Participants\?PageSize=50/)
})

test('it refuses to post into a conversation that would reach nobody', () => {
  assert.match(send, /CONVERSATION_EMPTY/)
  assert.match(send, /reach(ed)? nobody/i)
})

test('the refusal happens BEFORE the message is created', () => {
  assert.ok(send.indexOf('CONVERSATION_EMPTY') < send.indexOf("/Messages`"),
    'checking after the POST would still have sent the Deutsch text into the void')
})

test('it reports who it actually reached, not just a message SID', () => {
  assert.match(send, /deliveredTo: reachable/,
    'a bare message SID is what made this look successful')
})

test('only participants with a real SMS binding count as reachable', () => {
  assert.match(send, /messaging_binding\?\.address/)
})

// ── the reuse decision must consult Twilio, not the snapshot ─────────────────────────
const gt = inbox.slice(inbox.indexOf("router.post('/group-text'"), inbox.indexOf("router.post('/group-text'") + 4200)

test('group-text checks the LIVE roster before reusing a conversation', () => {
  assert.match(gt, /conversationRoster\(reuseSid\)/)
  assert.match(gt, /live_participants/)
})

test('a drifted group is rebuilt rather than reused', () => {
  assert.match(gt, /reuseSid = null/)
  // and the check must come before anything is sent into the reused conversation
  assert.ok(gt.indexOf('conversationRoster(reuseSid)') < gt.indexOf('sendConversationMessage(reuseSid'),
    'the roster check has to run before the send')
})

test('every wanted participant must still be bound, not just some of them', () => {
  // a partial match is the Matt case exactly: two of three present, one silently missing
  assert.match(gt, /liveKeys\.size === wantKeys\.size/)
  assert.match(gt, /every\(k => liveKeys\.has\(k\)\)/)
})

test('a roster check that fails does not silently fall back to reusing', () => {
  // liveKeys stays empty on error, so `intact` is false and the group is rebuilt
  const seg = gt.slice(gt.indexOf('let liveKeys'), gt.indexOf('if (reuseSid) {', gt.indexOf('let liveKeys')))
  assert.match(seg, /catch/)
  assert.ok(!/reuseSid = reuseSid/.test(seg))
})

// ── the diagnostic that found it ──────────────────────────────────────────────────────
test('the roster diagnostic is read-only', () => {
  const r = conv.slice(conv.indexOf('export async function conversationRoster'))
  assert.ok(!/tw\('POST'/.test(r) && !/tw\('DELETE'/.test(r),
    'a diagnostic used while investigating must not be able to send or delete anything')
})

test('it surfaces the snapshot-vs-Twilio difference, which is the actual fault', () => {
  assert.match(conv, /missing_from_twilio/)
  assert.match(inbox, /router\.get\('\/group-roster\/:convSid'/)
})
