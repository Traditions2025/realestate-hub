// An inbound text from a number that is not in the CRM has to be answerable.
//
// John, 2026-11-03: "for inbox even if number is not added we should be able to still
// reply and send text". A real message was sitting unanswerable — "Thanks John. I sent
// this on to Katie, Liberty's manager. She will be reaching out to you soon." — because
// the UNKNOWN pane offered only "+ Create lead" and "Link to existing".
//
// Nothing on the server ever required a lead: POST /api/inbox/send has taken raw
// `phones: [{phone}]` recipients since 2026-10-21 and files them under the SAME
// u_<phone10> thread_key the inbound arrived on. Only the pane insisted.
//
// Two things must hold, and both are easy to break:
//   - the outgoing row's thread_key matches what /unknown-thread reads back, or the
//     reply vanishes from the conversation it belongs to
//   - typing a number by hand is NOT a way around an opt-out: /send resolves the number
//     against the CRM first and honours STOP / undeliverable on any record it finds
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const inboxSrv = fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
const inboxUi = fs.readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8')
const pane = inboxUi.slice(inboxUi.indexOf('function UnknownPane'))
const paneBody = pane.slice(0, pane.indexOf('\nfunction '))

// ── the key both halves must agree on ────────────────────────────────────────────
test('the unknown thread key is u_<phone10> on both the read and the write', () => {
  assert.match(inboxSrv, /const unknownKey = \(phone\) => \{ const k = phoneKey\(phone\); return k \? 'u_' \+ k : null \}/)
  const send = inboxSrv.slice(inboxSrv.indexOf("for (const rp of rawPhones)"))
  assert.match(send.slice(0, 2500), /known \? `c\$\{known\.id\}_text` : `u_\$\{p10\}`/,
    'an unmatched raw-phone send must file under the same u_<phone10> thread')
})

test('/unknown-thread reads exactly those rows', () => {
  const r = inboxSrv.slice(inboxSrv.indexOf("router.get('/unknown-thread'"))
  assert.match(r.slice(0, 400), /thread_key = \? AND client_id IS NULL/,
    'and the raw-phone send writes client_id NULL when nothing matched, so it shows up')
})

// ── the compliance gate survives ─────────────────────────────────────────────────
test('a hand-typed number is still resolved against the CRM before sending', () => {
  const send = inboxSrv.slice(inboxSrv.indexOf("for (const rp of rawPhones)"), inboxSrv.indexOf('// ---- EMAIL'))
  assert.match(send, /const known = p10/, 'look the number up first')
  assert.ok(send.indexOf('known?.hub_text_opt_out') < send.indexOf('await sendSms'),
    'STOP is checked BEFORE the send, or typing a number by hand bypasses an opt-out')
  assert.ok(send.indexOf('known?.sms_undeliverable') < send.indexOf('await sendSms'),
    'and so is the undeliverable verdict')
})

// ── the pane ─────────────────────────────────────────────────────────────────────
test('the UNKNOWN pane has a reply box that does not require a lead', () => {
  assert.match(paneBody, /const sendReply = async \(\)/, 'there is a send path')
  assert.match(paneBody, /phones: \[\{ phone: sel\.phone \}\]/, 'it sends to the raw number')
  assert.match(paneBody, /placeholder=\{`Reply to /, 'and there is somewhere to type')
})

test('Enter sends, Shift+Enter is a new line, like every other pane', () => {
  const s = paneBody.slice(paneBody.indexOf('const sendReply'))
  assert.match(s, /e\.key === 'Enter' && !e\.shiftKey/)
})

test('creating or linking is still offered, just not as a toll gate', () => {
  assert.match(paneBody, /\+ Create lead/)
  assert.match(paneBody, /Link to existing/)
  assert.doesNotMatch(paneBody, /Add them to reply and start a normal conversation/,
    'that copy told people replying was impossible')
})

test('a failed send surfaces the server reason, not a generic error', () => {
  const s = paneBody.slice(paneBody.indexOf('const sendReply'))
  assert.match(s, /d\.results\?\.\[0\]\?\.error/,
    'the STOP / undeliverable explanation is per-recipient and is the useful part')
})

test('the reply is cleared and the thread reloaded only on success', () => {
  const s = paneBody.slice(paneBody.indexOf('const sendReply'))
  assert.match(s, /if \(d\.sent\) \{ setReply\(''\); load\(\) \}/)
})
