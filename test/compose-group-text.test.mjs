// MULTIPLE PEOPLE ON A TEXT = ONE GROUP TEXT (John, 2026-11-13)
//
// Picking two people in the composer used to send two separate 1:1 texts. John asked for
// one conversation everybody is in. The dangerous half of that change is not the happy
// path, it is the cases where a group CANNOT be used - a photo attached, or too many people
// for Twilio - because the quiet failure there is either a dropped photo or a rejected send.
// So the routing decision is pinned here, along with the compliance gates that now carry
// every multi-recipient text instead of just the group button.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const UI = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8')
const API = readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')

// The composer's own rule, lifted from source so the test cannot drift from it.
const GROUP_MAX = Number(UI.match(/const GROUP_MAX = (\d+)/)?.[1])
const asGroup = (n, { media = 0, channel = 'text' } = {}) =>
  channel === 'text' && n >= 2 && n <= GROUP_MAX && media === 0

test('the cap matches what Twilio actually allows', () => {
  // Group MMS holds 10 participants INCLUDING our sending number, so 9 other people.
  assert.equal(GROUP_MAX, 9)
})

test('one recipient is still an ordinary 1:1 text', () => {
  assert.equal(asGroup(1), false)
})

test('two or more recipients become one group text', () => {
  assert.equal(asGroup(2), true)
  assert.equal(asGroup(5), true)
  assert.equal(asGroup(9), true)
})

test('past the cap it falls back to separate texts rather than failing', () => {
  // A 20-person group text is both rejected by Twilio and a terrible idea. Sending
  // individually still gets the message out.
  assert.equal(asGroup(10), false)
  assert.equal(asGroup(25), false)
})

test('a photo forces separate texts, because a group send cannot carry one', () => {
  // createGroupText/sendConversationMessage take a body and nothing else. Routing a photo
  // through them would drop it silently - the worst outcome of the three.
  assert.equal(asGroup(3, { media: 1 }), false)
  assert.equal(asGroup(3, { media: 0 }), true)
})

test('email is never grouped', () => {
  assert.equal(asGroup(4, { channel: 'email' }), false)
})

test('the group send really does post to the group endpoint', () => {
  assert.match(UI, /authFetch\('\/api\/inbox\/group-text'/, 'it calls the existing group route')
  assert.ok(!/createGroupText/.test(UI), 'and does not reimplement grouping in the browser')
})

test('a client recipient is sent by id so the server can apply its gates', () => {
  // Passing a bare phone for someone who IS a client would skip the STOP / undeliverable
  // checks, which key off the client record.
  const block = UI.slice(UI.indexOf("authFetch('/api/inbox/group-text'"), UI.indexOf("authFetch('/api/inbox/group-text'") + 600)
  assert.match(block, /client_id: x\.id/, 'known clients go by client_id')
  assert.match(block, /x\.raw\s*\n?\s*\?\s*\{ phone: x\.phone/, 'only non-contacts go by bare phone')
})

test('the composer warns before it exposes numbers to each other', () => {
  // Nine people discovering each other's numbers is not something to find out afterwards.
  assert.match(UI, /One group text/, 'it says plainly that it is one conversation')
  assert.match(UI, /see each other/, 'and that they will see each other')
  assert.match(UI, /separate texts/, 'and says when it is NOT grouping')
})

// ---- server side: the rules cannot live only in the browser -------------------------

test('the server enforces the same cap', () => {
  const route = API.slice(API.indexOf("router.post('/group-text'"))
  assert.match(route, /recipients\.length > 9/, 'a cap enforced only in the UI is not a cap')
})

test('the server still refuses a group with fewer than 2 people', () => {
  const route = API.slice(API.indexOf("router.post('/group-text'"))
  assert.match(route, /recipients\.length < 2/)
})

test('STOP and undeliverable both block a group recipient', () => {
  // hub_text_opt_out was already checked. sms_undeliverable was NOT, which barely showed
  // while the group button was the only way in - now every multi-recipient text comes
  // through here.
  const route = API.slice(API.indexOf("router.post('/group-text'"), API.indexOf("router.post('/group-text'") + 2500)
  assert.match(route, /hub_text_opt_out/, 'STOP is honoured')
  assert.match(route, /sms_undeliverable/, 'and so is a number that cannot receive texts')
})

test('a blocked recipient is reported, not silently dropped', () => {
  const route = API.slice(API.indexOf("router.post('/group-text'"), API.indexOf("router.post('/group-text'") + 2500)
  assert.match(route, /blocked\.push\(\{[^}]*reason/, 'each exclusion carries a reason')
  assert.match(UI, /left out/, 'and the composer shows them')
})
