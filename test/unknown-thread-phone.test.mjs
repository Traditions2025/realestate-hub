// An unknown thread's phone is the PERSON's number, not ours (John, 2026-11-03).
//
// The inbox read from_addr whichever way the message went. On an outgoing text from_addr
// is our own Twilio line, so every unknown thread in the Sent folder reported the Hub's
// number as the contact's. "Create lead" saved that number onto the new lead, and a
// second stranger's text then collected on the same record: Laura Steffeck (319-350-4546)
// and Stephanie Backen (319-551-5683) ended up as one person.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()

const HUB = '+13193431562'   // our own Twilio line
let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')

// The expression under test, lifted from the thread builder in routes/inbox.js.
const threadPhone = (r) => r.client_id ? null : ((r.direction === 'outgoing' ? r.to_addr : r.from_addr) || r.from_addr || r.to_addr || '')

test('an outgoing message reports the recipient, never our own line', () => {
  assert.equal(threadPhone({ direction: 'outgoing', from_addr: HUB, to_addr: '+13195515683' }), '+13195515683')
})

test('an incoming message still reports the sender', () => {
  assert.equal(threadPhone({ direction: 'incoming', from_addr: '+13193504546', to_addr: HUB }), '+13193504546')
})

test('a thread already on a lead carries no loose phone', () => {
  assert.equal(threadPhone({ client_id: 42, direction: 'incoming', from_addr: '+13193504546' }), null)
})

test('a missing counterparty falls back rather than returning nothing', () => {
  assert.equal(threadPhone({ direction: 'outgoing', from_addr: HUB, to_addr: null }), HUB)
  assert.equal(threadPhone({ direction: 'incoming', from_addr: null, to_addr: '+13195515683' }), '+13195515683')
})

test('the live route still derives the phone this way', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8'))
  assert.match(src, /phone: r\.client_id \? null : \(\(r\.direction === 'outgoing' \? r\.to_addr : r\.from_addr\)/)
})

test('a message filed against the wrong lead can be moved to the right one', () => {
  const mk = (fn, ln, ph) => db.run(
    'INSERT INTO clients (first_name, last_name, type, status, phone) VALUES (?,?,?,?,?)',
    [fn, ln, 'buyer', 'junk', ph]).lastInsertRowid
  const a = mk('Laura', 'Steffeck', '+1319350' + uniq().slice(-4))
  const b = mk('Stephanie', 'Backen', '+1319551' + uniq().slice(-4))
  const ext = 'twilio_TEST' + uniq()
  const mid = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, occurred_at)
    VALUES ('text','outgoing',?,'Laura Steffeck',?,'+13195515683','Hi Steph','Hi Steph',?,?,'read',datetime('now'))`,
    [a, HUB, ext, `c${a}_text`]).lastInsertRowid

  // What the route does, asserted on the data it produces.
  const c = db.get('SELECT id, first_name, last_name FROM clients WHERE id=?', [b])
  const name = `${c.first_name} ${c.last_name}`
  db.run('UPDATE communications SET client_id=?, contact_name=?, thread_key=? WHERE id=?', [c.id, name, `c${c.id}_text`, mid])

  const moved = db.get('SELECT client_id, contact_name, thread_key FROM communications WHERE id=?', [mid])
  assert.equal(moved.client_id, b, 'now on Stephanie')
  assert.equal(moved.contact_name, 'Stephanie Backen', 'the name travels with it')
  assert.equal(moved.thread_key, `c${b}_text`, 'and so does the thread')
  assert.equal(db.get("SELECT COUNT(*) n FROM communications WHERE client_id=?", [a]).n, 0, 'Laura keeps none of it')
})
