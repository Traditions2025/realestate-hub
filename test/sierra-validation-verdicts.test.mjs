// Sierra's emailStatus / phoneStatus describe SIERRA'S copy of the address and number.
// The Hub is master for both fields, so once a Hub edit makes them differ, Sierra is
// grading a contact point the lead no longer uses — and the sync was writing it anyway,
// on every pass, unconditionally.
//
// That is how Doug Riniker #26281 (John, 2026-11-03) ended up permanently un-drippable:
// email_status='WrongAddress' came from Sierra, emailHardBlock refuses the lead, and
// clearing it on a Hub email edit would have been undone by the very next sync pass.
// We had never emailed him — zero email messages on his timeline, no bounce note, no
// bounce tag. The verdict was never ours.
//
// Same rule the clients.js PUT already follows for the phone: a verdict belongs to the
// contact point it was made about.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { processLead } = await import('../server/sierra-helper.js')

let seq = 0
const sid = () => `vv${Date.now()}${++seq}`
const lead = (id, over = {}) => ({
  id, firstName: 'Verdict', lastName: 'Case' + id, leadStatus: 'New',
  email: `sierra${id}@example.com`, phone: '(319) 555-0101',
  emailStatus: 'WrongAddress', phoneStatus: 'Invalid', ...over,
})
function mk(id, { email, phone, email_status = null, phone_status = null }) {
  return Number(db.run(
    `INSERT INTO clients (first_name, last_name, type, status, sierra_lead_id, email, phone, email_status, phone_status)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Verdict', 'Case' + id, 'buyer', 'new', String(id), email, phone, email_status, phone_status],
  ).lastInsertRowid)
}
const row = (id) => db.get('SELECT email, phone, email_status, phone_status FROM clients WHERE id=?', [id])
const ids = []
const track = (i) => { ids.push(i); return i }

// ── the Doug case ────────────────────────────────────────────────────────────────
test('a Hub-corrected email does NOT take back Sierra\'s verdict on the old one', () => {
  const s = sid()
  const id = track(mk(s, { email: 'doug.fixed@gmail.com', phone: '(319) 555-0101', email_status: null }))
  processLead(lead(s, { email: 'doug.riniker@linncounty.org', emailStatus: 'WrongAddress' }))
  assert.equal(row(id).email, 'doug.fixed@gmail.com', 'Hub stays master for the address itself')
  assert.equal(row(id).email_status, null,
    "Sierra graded linncounty.org — that says nothing about the corrected address")
})

test('a Hub-corrected phone does NOT take back Sierra\'s verdict on the old number', () => {
  const s = sid()
  const id = track(mk(s, { email: 'sierra' + s + '@example.com', phone: '(563) 880-0738', phone_status: null }))
  processLead(lead(s, { email: 'sierra' + s + '@example.com', phone: '(319) 721-4755', phoneStatus: 'Invalid' }))
  assert.equal(row(id).phone_status, null, 'that verdict was about 319-721-4755')
})

// ── the verdict still applies when it is about the SAME contact point ────────────
test('matching email: Sierra\'s verdict is written, exactly as before', () => {
  const s = sid()
  const id = track(mk(s, { email: 'same' + s + '@example.com', phone: '(319) 555-0101' }))
  processLead(lead(s, { email: 'same' + s + '@example.com', emailStatus: 'WrongAddress' }))
  assert.equal(row(id).email_status, 'WrongAddress', 'a real bounce on the address we use must stick')
})

test('case and spacing do not count as a different address', () => {
  const s = sid()
  const id = track(mk(s, { email: '  Same' + s + '@Example.com ', phone: '(319) 555-0101' }))
  processLead(lead(s, { email: 'same' + s + '@example.com', emailStatus: 'ReportedAsSpam' }))
  assert.equal(row(id).email_status, 'ReportedAsSpam')
})

test('phone formatting does not count as a different number', () => {
  const s = sid()
  const id = track(mk(s, { email: 'p' + s + '@example.com', phone: '3195550101' }))
  processLead(lead(s, { email: 'p' + s + '@example.com', phone: '(319) 555-0101', phoneStatus: 'Valid' }))
  assert.equal(row(id).phone_status, 'Valid', 'same ten digits, same number')
})

test('an EMPTY Hub field adopts both the value and its verdict', () => {
  // the UPDATE backfills an empty contact field from Sierra in the same statement,
  // so the verdict IS about the address the Hub is taking on
  const s = sid()
  const id = track(mk(s, { email: null, phone: null }))
  processLead(lead(s, { email: 'fresh' + s + '@example.com', emailStatus: 'WrongAddress', phoneStatus: 'Invalid' }))
  assert.equal(row(id).email, 'fresh' + s + '@example.com')
  assert.equal(row(id).email_status, 'WrongAddress')
  assert.equal(row(id).phone_status, 'Invalid')
})

test('a good verdict is withheld too — the rule is about relevance, not severity', () => {
  const s = sid()
  const id = track(mk(s, { email: 'mine' + s + '@example.com', phone: '(319) 555-0101', email_status: 'WrongAddress' }))
  processLead(lead(s, { email: 'theirs' + s + '@example.com', emailStatus: 'Valid' }))
  assert.equal(row(id).email_status, 'WrongAddress',
    "Sierra's 'Valid' was about a different address and must not clear ours either")
})

test.after(() => { for (const i of ids) db.run('DELETE FROM clients WHERE id=?', [i]) })
