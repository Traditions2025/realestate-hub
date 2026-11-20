// THREE-WAY CALLING (John, 2026-11-20).
//
// These run the REAL escalation against a recorder standing in for Twilio, because the
// dangerous part of this feature is not whether the TwiML parses, it is the ORDER of three
// irreversible actions on a live call a client is already on:
//
//   - if the room is not recorded as pending BEFORE the callee is redirected, the agent's
//     Dial action fires into nothing and hangs the agent up mid-sentence
//   - if a failed redirect leaves state behind, the NEXT call inherits a dead room
//   - if endConferenceOnExit is wrong, the client and a stranger are left on our bill
//
// None of those are visible by reading the TwiML. All of them are asserted here.
import { test, mock, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import db, { initDb } from '../server/database.js'

await initDb()

// The real helpers we want to keep, grabbed before the module is replaced.
const real = await import('../server/twilio.js')

const calls = { updates: [], created: [], removed: [] }
let failNextUpdate = null

mock.module('../server/twilio.js', {
  exports: {
    toE164: real.toE164,
    phoneKey: real.phoneKey,
    twilioConfig: () => ({ sid: 'ACtest', token: 'tok', from: '+13193431562', enabled: true }),
    updateCallTwiml: async (callSid, twiml) => {
      // Captured AT CALL TIME: this is the assertion that the pending room exists before
      // the callee is moved, which no after-the-fact inspection can make.
      const { pendingRoomFor } = await import('../server/conference.js')
      calls.updates.push({ callSid, twiml, pendingAtCallTime: pendingRoomFor('CAparent') })
      if (failNextUpdate) { const e = failNextUpdate; failNextUpdate = null; throw new Error(e) }
      return { sid: callSid }
    },
    createCall: async (args) => { calls.created.push(args); return { sid: 'CAadded' + calls.created.length } },
    removeConferenceParticipant: async (room, callSid) => { calls.removed.push({ room, callSid }); return { ok: true } },
  },
})

const CONF = await import('../server/conference.js')
const { vmDropChildMap } = await import('../server/voice-state.js')

const HUB = 'https://hub.example.com'
const reset = () => {
  CONF._reset(); vmDropChildMap.clear()
  calls.updates.length = 0; calls.created.length = 0; calls.removed.length = 0
  failNextUpdate = null
}
/** The state a live two-party call is in: the callee leg is known from child-status. */
const liveCall = () => { reset(); vmDropChildMap.set('CAparent', { childSid: 'CAcallee', at: Date.now() }) }

// ---- the ordering that keeps the agent on the call -------------------------------------

test('the room is pending BEFORE the callee is redirected', async () => {
  liveCall()
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '319-555-0144', name: 'City Water', hubBase: HUB })
  assert.equal(r.ok, true)
  assert.equal(calls.updates.length, 1, 'the callee leg must be redirected exactly once')
  assert.ok(calls.updates[0].pendingAtCallTime,
    'the pending room must be set before the redirect, or the agent Dial action hangs the agent up')
  assert.equal(calls.updates[0].pendingAtCallTime, r.room)
})

test('a failed redirect leaves nothing behind', async () => {
  liveCall()
  failNextUpdate = 'Twilio 500'
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  assert.equal(r.ok, false)
  assert.match(r.error, /conference/i)
  assert.equal(CONF.pendingRoomFor('CAparent'), null, 'a pending room must not survive a failed escalation')
  assert.equal(CONF.conferenceFor('CAparent'), null)
  assert.equal(calls.created.length, 0, 'nobody should be dialled when the escalation failed')
})

test('it refuses while the other party is still ringing', async () => {
  reset()   // no callee leg recorded yet
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  assert.equal(r.ok, false)
  assert.match(r.error, /not connected/i)
  assert.equal(calls.updates.length, 0)
})

test('a second number joins the existing room without moving the callee again', async () => {
  liveCall()
  await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', name: 'City Water', hubBase: HUB })
  const first = calls.updates.length
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550199', name: 'Inspector', hubBase: HUB })
  assert.equal(r.ok, true)
  assert.equal(calls.updates.length, first, 'the callee must not be redirected a second time')
  assert.equal(calls.created.length, 2)
  assert.equal(calls.created[0].url.includes(r.room), true)
  assert.equal(calls.created[1].url.includes(r.room), true, 'both additions must join the SAME room')
})

test('a bad number is refused before anything happens to the live call', async () => {
  liveCall()
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: 'not a phone', hubBase: HUB })
  assert.equal(r.ok, false)
  assert.equal(calls.updates.length, 0, 'the live call must not be touched to validate a number')
})

// ---- what each leg is actually told ----------------------------------------------------

test('only the agent ends the conference for everyone', () => {
  const agent = CONF.conferenceTwiml({ room: 'r', hubBase: HUB, isAgent: true })
  const other = CONF.conferenceTwiml({ room: 'r', hubBase: HUB })
  assert.match(agent, /endConferenceOnExit="true"/)
  assert.match(other, /endConferenceOnExit="false"/)
})

test('recording rides on the first leg in, so the opening is not lost', () => {
  const first = CONF.conferenceTwiml({ room: 'r', hubBase: HUB, isFirst: true, record: true })
  const later = CONF.conferenceTwiml({ room: 'r', hubBase: HUB, isFirst: false, record: true })
  assert.match(first, /record="record-from-start"/)
  assert.ok(!/record="/.test(later), 'a later joiner must not start a second recording')
  assert.match(first, /conference-recording/)
})

test('recording obeys the same switch as every other call', () => {
  const before = db.getSetting('twilio_record_calls', '1')
  try {
    db.setSetting('twilio_record_calls', '0')
    assert.ok(!/record="/.test(CONF.conferenceTwiml({ room: 'r', hubBase: HUB, isFirst: true })),
      'turning call recording off must turn conference recording off too')
    db.setSetting('twilio_record_calls', '1')
    assert.match(CONF.conferenceTwiml({ room: 'r', hubBase: HUB, isFirst: true }), /record="record-from-start"/)
  } finally { db.setSetting('twilio_record_calls', before) }
})

test('everyone hears a tone when a line joins', () => {
  // Not decoration: it is how the person already on the call learns somebody else is there.
  assert.match(CONF.conferenceTwiml({ room: 'r', hubBase: HUB }), /beep="onEnter"/)
})

// ---- the live roster -------------------------------------------------------------------

test('join and leave events move people on and off the roster', async () => {
  liveCall()
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', name: 'City Water', hubBase: HUB })
  CONF.noteConferenceEvent({ FriendlyName: r.room, StatusCallbackEvent: 'participant-join', CallSid: 'CAcallee' })
  CONF.noteConferenceEvent({ FriendlyName: r.room, StatusCallbackEvent: 'participant-join', CallSid: r.call_sid })
  let s = CONF.stateFor('CAparent')
  assert.equal(s.conference, true)
  assert.equal(s.participants.length, 2)
  assert.ok(s.participants.every(p => p.on), 'both legs should read as connected')
  assert.equal(s.participants.find(p => p.call_sid === r.call_sid).name, 'City Water')

  CONF.noteConferenceEvent({ FriendlyName: r.room, StatusCallbackEvent: 'participant-leave', CallSid: r.call_sid })
  s = CONF.stateFor('CAparent')
  assert.equal(s.participants.length, 1, 'a line that left must disappear from the roster')
})

test('the end of the conference clears the state', async () => {
  liveCall()
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  CONF.noteConferenceEvent({ FriendlyName: r.room, StatusCallbackEvent: 'conference-end' })
  assert.equal(CONF.stateFor('CAparent').conference, false)
  assert.equal(CONF.pendingRoomFor('CAparent'), null)
})

test('an ordinary two-party call reports no conference at all', () => {
  reset()
  assert.deepEqual(CONF.stateFor('CAnope'), { conference: false, participants: [] })
})

test('the agent cannot be dropped as if they were a participant', async () => {
  liveCall()
  await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  const r = await CONF.dropLeg({ parentSid: 'CAparent', callSid: 'CAparent' })
  assert.equal(r.ok, false)
  assert.match(r.error, /hang up/i)
  assert.equal(calls.removed.length, 0)
})

test('dropping one line removes only that line', async () => {
  liveCall()
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  const d = await CONF.dropLeg({ parentSid: 'CAparent', callSid: r.call_sid })
  assert.equal(d.ok, true)
  assert.deepEqual(calls.removed, [{ room: r.room, callSid: r.call_sid }])
  assert.ok(!CONF.stateFor('CAparent').participants.find(p => p.call_sid === r.call_sid))
})

// ---- recordings: the conference audio must not erase the two-party audio ---------------

test('the conference recording never overwrites the recording already on the call', async () => {
  liveCall()
  const ext = 'twiliocall_CAparent'
  db.run('DELETE FROM communications WHERE external_id=? OR external_id LIKE ?', [ext, 'twiliconf_TESTREC%'])
  db.run(`INSERT INTO communications (channel, direction, contact_name, to_addr, preview, body, external_id, thread_key, status, occurred_at, recording_url)
          VALUES ('call','outgoing','Test Account','3195550100','Outgoing call','',?,'t_conf_test','read',?,?)`,
    [ext, new Date().toISOString(), 'https://api.twilio.com/FIRST-HALF.mp3'])
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })

  const out = CONF.attachConferenceRecording({ FriendlyName: r.room, RecordingUrl: 'https://api.twilio.com/SECOND-HALF.mp3', RecordingSid: 'RETESTREC1', RecordingDuration: '95' })
  assert.equal(out.ok, true)
  assert.equal(out.mode, 'own_row', 'it must not land on a row that already holds audio')
  const orig = db.get('SELECT recording_url FROM communications WHERE external_id=?', [ext])
  assert.equal(orig.recording_url, 'https://api.twilio.com/FIRST-HALF.mp3', 'the first half must still be playable')
  const conf = db.get('SELECT recording_url, disposition FROM communications WHERE id=?', [out.attached_to])
  assert.equal(conf.recording_url, 'https://api.twilio.com/SECOND-HALF.mp3')
  assert.match(conf.disposition, /3-way|Conference/i)
  db.run('DELETE FROM communications WHERE external_id=? OR id=?', [ext, out.attached_to])
})

test('with no earlier recording it attaches to the call itself', async () => {
  liveCall()
  const ext = 'twiliocall_CAparent'
  db.run('DELETE FROM communications WHERE external_id=?', [ext])
  db.run(`INSERT INTO communications (channel, direction, contact_name, to_addr, preview, body, external_id, thread_key, status, occurred_at)
          VALUES ('call','outgoing','Test Account','3195550100','Outgoing call','',?,'t_conf_test','read',?)`,
    [ext, new Date().toISOString()])
  const r = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  const out = CONF.attachConferenceRecording({ FriendlyName: r.room, RecordingUrl: 'https://api.twilio.com/ONLY.mp3', RecordingSid: 'RETESTREC2', RecordingDuration: '60' })
  assert.equal(out.mode, 'original_row')
  assert.equal(db.get('SELECT recording_url FROM communications WHERE external_id=?', [ext]).recording_url, 'https://api.twilio.com/ONLY.mp3')
  db.run('DELETE FROM communications WHERE external_id=?', [ext])
})

// ---- the endpoints, over real HTTP -----------------------------------------------------
//
// Source assertions proved the handlers were written. These prove they ANSWER: that the
// routes are reachable, that a POST sees its query string, and above all that a normal
// call still gets <Hangup/> from the action URL that was added to every outbound Dial.
// That last one is the regression that would break ordinary calling for everybody.

const INDEX = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const AUTH = readFileSync(new URL('../server/routes/auth.js', import.meta.url), 'utf8')

const express = (await import('express')).default
const { twimlRouter, controlRouter } = await import('../server/routes/conference.js')

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use('/api/voice', twimlRouter)
app.use('/api/conference', controlRouter)

let base = ''
before(async () => {
  await new Promise(r => { const srv = app.listen(0, () => { base = 'http://127.0.0.1:' + srv.address().port; r() }); srv.unref() })
})

const form = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
})
const json = (path, body) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

test('an ordinary call still hangs up when its Dial ends', async () => {
  reset()
  const r = await form('/api/voice/outbound-dial-complete', { CallSid: 'CAnothingpending', DialCallStatus: 'completed' })
  const body = await r.text()
  assert.equal(r.status, 200)
  assert.match(body, /<Hangup\/>/)
  assert.ok(!/Conference/.test(body), 'a call with no escalation must never be sent to a room')
})

test('an escalating call is sent into its room instead of hung up', async () => {
  liveCall()
  const added = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  const r = await form('/api/voice/outbound-dial-complete', { CallSid: 'CAparent', DialCallStatus: 'completed' })
  const body = await r.text()
  assert.match(body, /<Conference /)
  assert.ok(body.includes(added.room), 'the agent must join the SAME room the callee went to')
  assert.match(body, /endConferenceOnExit="true"/, 'the agent hanging up must release everybody')
  assert.ok(!/<Hangup/.test(body))
  // One-shot: a replayed webhook must not re-send a finished call into a dead room.
  const again = await (await form('/api/voice/outbound-dial-complete', { CallSid: 'CAparent' })).text()
  assert.match(again, /<Hangup\/>/)
})

test('a joining leg is given the room from the query string', async () => {
  const r = await form('/api/voice/conference-join?room=hub-XYZ&label=City%20Water', {})
  const body = await r.text()
  assert.match(body, /<Conference /)
  assert.ok(body.includes('hub-XYZ'))
  assert.match(body, /participantLabel="City Water"/)
  assert.match(body, /endConferenceOnExit="false"/, 'only the agent may end the conference')
})

test('a join with no room fails politely instead of throwing', async () => {
  const r = await form('/api/voice/conference-join', {})
  const body = await r.text()
  assert.equal(r.status, 200)
  assert.match(body, /<Hangup\/>/)
  assert.ok(!/<Conference/.test(body))
})

test('the status and recording callbacks answer Twilio', async () => {
  liveCall()
  const added = await CONF.addToCall({ parentSid: 'CAparent', number: '3195550144', hubBase: HUB })
  const s1 = await form('/api/voice/conference-status', { FriendlyName: added.room, StatusCallbackEvent: 'participant-join', CallSid: 'CAcallee' })
  assert.equal(s1.status, 204)
  assert.equal(CONF.stateFor('CAparent').participants.find(p => p.call_sid === 'CAcallee').on, true)
  const s2 = await form('/api/voice/conference-recording', { FriendlyName: added.room, RecordingUrl: '', RecordingDuration: '0' })
  assert.equal(s2.status, 204, 'a malformed recording callback must not 500 at Twilio')
})

test('add refuses, with a reason, when there is no live call', async () => {
  reset()
  const r = await json('/api/conference/add', { parent_sid: 'CAnope', number: '3195550144' })
  assert.equal(r.status, 400)
  const d = await r.json()
  assert.equal(d.ok, false)
  assert.ok(d.error)
})

test('add, roster and drop work end to end over HTTP', async () => {
  liveCall()
  const a = await (await json('/api/conference/add', { parent_sid: 'CAparent', number: '(319) 555-0144', name: 'City Water' })).json()
  assert.equal(a.ok, true)
  assert.equal(a.to, '+13195550144', 'a typed number must be normalised before it is dialled')

  const st = await (await fetch(base + '/api/conference/state/CAparent')).json()
  assert.equal(st.conference, true)
  assert.equal(st.participants.length, 2)

  const d = await (await json('/api/conference/drop', { parent_sid: 'CAparent', call_sid: a.call_sid })).json()
  assert.equal(d.ok, true)
  const after = await (await fetch(base + '/api/conference/state/CAparent')).json()
  assert.equal(after.participants.length, 1)
})

test('state for a plain two-party call is empty, not an error', async () => {
  reset()
  const r = await fetch(base + '/api/conference/state/CAplain')
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { conference: false, participants: [] })
})

// ---- the wiring the endpoints cannot assert about themselves ---------------------------

test('the outbound Dial has the action URL the escalation depends on', () => {
  const out = INDEX.slice(INDEX.indexOf("app.post('/api/voice/outbound'"))
  const body = out.slice(0, out.indexOf('app.post(\'/api/voice/child-status\''))
  assert.match(body, /action="\$\{HUB_BASE\}\/api\/voice\/outbound-dial-complete"/,
    'without an action the agent is hung up the moment the callee is redirected')
})

test('the browser controls are authenticated, the Twilio webhooks are not', () => {
  // requireAuth exempts the whole /api/voice/ prefix for signature-validated webhooks, so
  // a control endpoint placed there would be callable by anyone who found the URL.
  assert.ok(!/\/api\/conference/.test(AUTH), 'nothing under /api/conference may be exempted from auth')
  assert.match(INDEX, /app\.use\('\/api\/conference', confControlRouter\)/)
})

test('the Twilio-facing router guards its own signatures', async () => {
  const SRC = readFileSync(new URL('../server/routes/conference.js', import.meta.url), 'utf8')
  assert.match(SRC, /twimlRouter\.use\(twilioWebhookGuard\)/)
  // and it is NOT applied to the control router, which authenticates people instead
  const ctrl = SRC.slice(SRC.indexOf('export const controlRouter'))
  assert.ok(!/twilioWebhookGuard/.test(ctrl))
})
