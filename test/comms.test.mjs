// Communications tests. Run: npm test  (Node built-in runner, no Twilio calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { twilioSignatureValid, phoneKey10, optKeyword } from '../server/twilio-sig.js'
import { isStopStatus, STOP_STATUSES } from '../server/lead-sequences.js'
import { businessOpen, toMinutes, bulkExcluded } from '../server/comms-logic.js'

const TOKEN = 'test_auth_token_ABC123'
const URL = 'https://realestate-hub-1rzu.onrender.com/api/inbox/twilio-inbound'
const PARAMS = { From: '+13195551212', To: '+13193431562', Body: 'Hi there', MessageSid: 'SM123' }
const sign = (url, params, token) => crypto.createHmac('sha1', token).update(Buffer.from(url + Object.keys(params).sort().map(k => k + params[k]).join(''), 'utf-8')).digest('base64')

test('signature: a genuine Twilio signature validates', () => {
  assert.equal(twilioSignatureValid(URL, PARAMS, sign(URL, PARAMS, TOKEN), TOKEN), true)
})
test('signature: a tampered body is rejected', () => {
  const sig = sign(URL, PARAMS, TOKEN)
  assert.equal(twilioSignatureValid(URL, { ...PARAMS, Body: 'evil' }, sig, TOKEN), false)
})
test('signature: wrong auth token is rejected', () => {
  assert.equal(twilioSignatureValid(URL, PARAMS, sign(URL, PARAMS, TOKEN), 'wrong_token'), false)
})
test('signature: a forged/mismatched-length signature is rejected (no crash)', () => {
  assert.equal(twilioSignatureValid(URL, PARAMS, 'not-a-real-signature', TOKEN), false)
})
test('signature: missing signature or token is rejected', () => {
  assert.equal(twilioSignatureValid(URL, PARAMS, '', TOKEN), false)
  assert.equal(twilioSignatureValid(URL, PARAMS, sign(URL, PARAMS, TOKEN), ''), false)
})

test('phone matching: all formats collapse to the same last-10 key', () => {
  const k = '3195551212'
  for (const p of ['3195551212', '319-555-1212', '(319) 555-1212', '+13195551212', '1 (319) 555-1212']) assert.equal(phoneKey10(p), k)
  assert.equal(phoneKey10('12345'), null)
})

test('opt-out keywords: STOP/START variants detected, normal text ignored', () => {
  for (const w of ['STOP', 'stop', 'Unsubscribe', 'CANCEL', 'quit']) assert.equal(optKeyword(w), 'stop')
  for (const w of ['START', 'yes', 'UNSTOP']) assert.equal(optKeyword(w), 'start')
  assert.equal(optKeyword('Hi, is the house still available?'), null)
})

test('compliance: Do Not Contact + Junk are stop statuses (remove campaigns)', () => {
  for (const s of ['donotcontact', 'DoNotContact', 'DONOTCONTACT', 'junk', 'Junk']) assert.equal(isStopStatus(s), true)
  for (const s of ['active', 'lead', 'nurture', '', null, undefined]) assert.equal(isStopStatus(s), false)
  assert.ok(STOP_STATUSES.has('donotcontact'))
})

test('business hours: open/closed by time and day (close is exclusive)', () => {
  const cfg = { enabled: true, open: '08:00', close: '18:00', days: [1, 2, 3, 4, 5] } // Mon-Fri
  assert.equal(businessOpen({ day: 3, minutes: toMinutes('09:30') }, cfg), true)   // Wed 9:30am
  assert.equal(businessOpen({ day: 3, minutes: toMinutes('07:59') }, cfg), false)  // before open
  assert.equal(businessOpen({ day: 3, minutes: toMinutes('18:00') }, cfg), false)  // close is exclusive
  assert.equal(businessOpen({ day: 3, minutes: toMinutes('08:00') }, cfg), true)   // open is inclusive
  assert.equal(businessOpen({ day: 0, minutes: toMinutes('12:00') }, cfg), false)  // Sunday, not a work day
  assert.equal(businessOpen({ day: 0, minutes: 0 }, { enabled: false }), true)     // hours off → always open
})

test('bulk exclusion: STOP opt-out or Do Not Contact / Junk status is excluded', () => {
  assert.equal(bulkExcluded({ hub_text_opt_out: 1, status: 'active' }), true)
  assert.equal(bulkExcluded({ status: 'donotcontact' }), true)
  assert.equal(bulkExcluded({ status: 'Junk' }), true)
  assert.equal(bulkExcluded({ status: 'active' }), false)
  assert.equal(bulkExcluded({}), false)
})

test('unresolved merge fields are stripped (customer never sees {{...}})', () => {
  // mirrors the send-path guard in routes/inbox.js
  const strip = (s) => s.replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim()
  assert.equal(strip('Hi {{first_name}}, welcome!'), 'Hi , welcome!'.replace(/[ \t]{2,}/g, ' ').trim())
  assert.ok(!/\{\{/.test(strip('Call {{agent}} at {{agent_phone}}')))
})
