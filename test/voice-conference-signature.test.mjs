// THE CONFERENCE WEBHOOKS UNDER ENFORCED SIGNATURE VALIDATION (2026-11-20).
//
// Production runs twilio_signature_mode = enforce: a webhook whose signature does not
// validate is answered 403, and Twilio plays an error tone to whoever is on the line.
// Every existing voice webhook is a bare path, but `conference-join` carries the room in a
// QUERY STRING, and Twilio signs the full URL including that query. If the guard rebuilt
// the URL without it, three-way calling would fail in production and nowhere else, and
// `outbound-dial-complete` is on the end of EVERY outbound call, so a 403 there would put
// an error tone on the end of every call the team makes.
//
// These sign requests the way Twilio does and drive them through the real router with
// enforcement on, so the thing that only happens in production is proven here instead.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import express from 'express'
import { initDb } from '../server/database.js'
import { twilioSignatureValid } from '../server/twilio-sig.js'

await initDb()

const TOKEN = 'test_auth_token_not_a_real_secret'
const BASE = 'https://hub.example.com'
process.env.HUB_BASE_URL = BASE

// Sign exactly as Twilio does: full URL (query included) + POST params sorted by key.
const sign = (url, params = {}) => {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('')
  return crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64')
}

let base = ''
let app
// These tests must change real Twilio settings to drive enforcement, so the originals are
// saved and put back. Leaving a test token behind in the local database would silently
// break every later comms test on this machine, and the next person would be debugging
// Twilio rather than their own change.
const KEYS = ['twilio_signature_mode', 'twilio_account_sid', 'twilio_auth_token']
const saved = {}
after(async () => {
  const { setSetting } = await import('../server/database.js')
  for (const k of KEYS) setSetting(k, saved[k] ?? '')
})
before(async () => {
  const { setSetting, getSetting } = await import('../server/database.js')
  for (const k of KEYS) saved[k] = getSetting(k, '')
  setSetting('twilio_signature_mode', 'enforce')
  setSetting('twilio_account_sid', 'ACtest')
  setSetting('twilio_auth_token', TOKEN)
  const { twimlRouter } = await import('../server/routes/conference.js')
  app = express()
  app.use(express.urlencoded({ extended: false }))
  app.use('/api/voice', twimlRouter)
  await new Promise(r => { const srv = app.listen(0, () => { base = 'http://127.0.0.1:' + srv.address().port; r() }); srv.unref() })
})

/** Post to `path`, signing against the PUBLIC url Twilio would have called. */
const post = (path, params = {}, { badSignature = false } = {}) => fetch(base + path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'X-Twilio-Signature': badSignature ? 'bm90LWEtcmVhbC1zaWduYXR1cmU=' : sign(BASE + path, params),
  },
  body: new URLSearchParams(params).toString(),
})

test('the signing helper here matches the validator the server uses', () => {
  // Otherwise every test below could pass against a shared mistake.
  const url = BASE + '/api/voice/conference-join?room=hub-X'
  assert.equal(twilioSignatureValid(url, { CallSid: 'CA1' }, sign(url, { CallSid: 'CA1' }), TOKEN), true)
  assert.equal(twilioSignatureValid(url, { CallSid: 'CA1' }, sign(url, { CallSid: 'CA2' }), TOKEN), false)
})

test('a signed join WITH a query string is accepted under enforcement', async () => {
  const r = await post('/api/voice/conference-join?room=hub-ABC&label=City%20Water', { CallSid: 'CAx', AccountSid: 'ACtest' })
  const body = await r.text()
  assert.equal(r.status, 200, 'a correctly signed query-string webhook must not be rejected')
  assert.match(body, /<Conference /)
  assert.ok(body.includes('hub-ABC'))
})

test('an unsigned join is rejected, so the URL is not an open door', async () => {
  const r = await fetch(base + '/api/voice/conference-join?room=hub-ABC', { method: 'POST' })
  assert.equal(r.status, 403)
})

test('a tampered room is rejected', async () => {
  // Sign one room, then ask for another: the query is part of what is signed, so this
  // must fail. If it passed, anyone could redirect a leg into a room of their choosing.
  const good = sign(BASE + '/api/voice/conference-join?room=hub-MINE', {})
  const r = await fetch(base + '/api/voice/conference-join?room=hub-THEIRS', {
    method: 'POST', headers: { 'X-Twilio-Signature': good, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '',
  })
  assert.equal(r.status, 403)
})

test('the action on EVERY outbound call is accepted when signed', async () => {
  // This endpoint now terminates every outbound Dial. A 403 here would put a Twilio error
  // tone on the end of every call the team makes, three-way or not.
  const params = { CallSid: 'CAnothing', DialCallStatus: 'completed', AccountSid: 'ACtest' }
  const r = await post('/api/voice/outbound-dial-complete', params)
  assert.equal(r.status, 200)
  assert.match(await r.text(), /<Hangup\/>/)
})

test('the status and recording callbacks are accepted when signed', async () => {
  const a = await post('/api/voice/conference-status', { FriendlyName: 'hub-NONE', StatusCallbackEvent: 'conference-end' })
  assert.equal(a.status, 204)
  const b = await post('/api/voice/conference-recording', { FriendlyName: 'hub-NONE', RecordingUrl: '', RecordingDuration: '0' })
  assert.equal(b.status, 204)
})

test('a bad signature is refused on every conference endpoint', async () => {
  for (const p of ['/api/voice/outbound-dial-complete', '/api/voice/conference-join?room=hub-X', '/api/voice/conference-status', '/api/voice/conference-recording']) {
    const r = await post(p, { CallSid: 'CAx' }, { badSignature: true })
    assert.equal(r.status, 403, p + ' accepted a forged signature')
  }
})
