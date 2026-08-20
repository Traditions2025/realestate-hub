// Communications tests. Run: npm test  (Node built-in runner, no Twilio calls).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'crypto'
import { twilioSignatureValid, phoneKey10, optKeyword } from '../server/twilio-sig.js'

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

test('unresolved merge fields are stripped (customer never sees {{...}})', () => {
  // mirrors the send-path guard in routes/inbox.js
  const strip = (s) => s.replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim()
  assert.equal(strip('Hi {{first_name}}, welcome!'), 'Hi , welcome!'.replace(/[ \t]{2,}/g, ' ').trim())
  assert.ok(!/\{\{/.test(strip('Call {{agent}} at {{agent_phone}}')))
})
