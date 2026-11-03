// A campaign that SITS ALONGSIDE the others is a property of the CAMPAIGN, not of
// whoever happens to be enrolling.
//
// John, 2026-11-03: enrolling Alison Graham in "Home Value — Past Clients" by hand was
// refused with "already in an active drip (Lifelong Friends: Vintage …) — one drip per
// lead", while the automatic Home Value sweeper adds exactly those leads every day. The
// difference was not the lead. home-value-enroll.js passed allowConcurrent:true and the
// profile button did not.
//
// That rule was never meant to protect past clients from two campaigns — email-cap.js
// does that, at SEND time, capping a past client at ONE email per 14 days across EVERY
// campaign. It was written (2026-10-15) precisely BECAUSE a past client sits in several
// at once. Blocking enrollment was belt-and-braces that contradicted the design.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { dripBlockReason, enrollInDrip } = await import('../server/routes/drips.js')

let seq = 0
const STEP = JSON.stringify([{ subject: 'hi', body: 'x', delay_days: 0, send_time: '09:00' }])
const mkDrip = (name, concurrent = 0) => Number(db.run(
  'INSERT INTO drip_campaigns (name, steps, allow_concurrent) VALUES (?,?,?)',
  [`${name} ${++seq}`, STEP, concurrent]).lastInsertRowid)
const mkClient = () => Number(db.run(
  'INSERT INTO clients (first_name, last_name, type, status, email) VALUES (?,?,?,?,?)',
  ['Concur', 'Case' + (++seq), 'buyer', 'new', `concur${seq}@example.com`]).lastInsertRowid)
const enrol = (d, c) => db.run(
  "INSERT INTO drip_enrollments (drip_id, client_id, status, current_step) VALUES (?,?,'active',0)", [d, c])

const drips = [], clients = []
const D = (n, c = 0) => { const i = mkDrip(n, c); drips.push(i); return i }
const C = () => { const i = mkClient(); clients.push(i); return i }

// ── the Alison case ──────────────────────────────────────────────────────────────
test('a concurrent campaign accepts a lead who is already in a normal drip', () => {
  const nurture = D('Lifelong Friends Vintage'), homeValue = D('Home Value Past Clients', 1)
  const cid = C(); enrol(nurture, cid)
  assert.equal(dripBlockReason(homeValue, cid), null, 'this is the whole point')
  assert.ok(enrollInDrip(homeValue, cid, { source: 'manual' }), 'and the manual path enrols')
})

test('the manual path and the sweeper now agree', () => {
  const nurture = D('Lifelong Friends Vintage'), homeValue = D('Home Value Past Clients', 1)
  const a = C(), b = C()
  enrol(nurture, a); enrol(nurture, b)
  assert.ok(enrollInDrip(homeValue, a, { source: 'manual' }), 'by hand')
  assert.ok(enrollInDrip(homeValue, b, { source: 'home_value_auto', allowConcurrent: true }), 'by sweeper')
})

// ── symmetry: the exception must not just move the problem ───────────────────────
test('being in a concurrent campaign does not block a normal drip either', () => {
  const homeValue = D('Home Value Past Clients', 1), nurture = D('Lifelong Friends Vintage')
  const cid = C(); enrol(homeValue, cid)
  assert.equal(dripBlockReason(nurture, cid), null,
    'Home Value must not become "the one drip" that locks everything else out')
})

// ── the default is unchanged ─────────────────────────────────────────────────────
test('two ordinary campaigns still refuse to stack, and the reason names the other one', () => {
  const first = D('Seller Nurture'), second = D('Buyer Nurture')
  const cid = C(); enrol(first, cid)
  const r = dripBlockReason(second, cid)
  assert.match(r.reason, /already in an active drip/)
  assert.match(r.reason, /Seller Nurture/, 'say WHICH one')
  assert.equal(enrollInDrip(second, cid, { source: 'manual' }), null)
})

test('the opts flag still works on an ordinary campaign, for callers that know better', () => {
  const first = D('Seller Nurture'), second = D('Buyer Nurture')
  const cid = C(); enrol(first, cid)
  assert.equal(dripBlockReason(second, cid, { allowConcurrent: true }), null)
})

test('already active in THIS campaign is still a no-op, not a second enrollment', () => {
  const hv = D('Home Value Past Clients', 1)
  const cid = C(); enrol(hv, cid)
  const before = db.all("SELECT id FROM drip_enrollments WHERE client_id=? AND status='active'", [cid]).length
  assert.ok(dripBlockReason(hv, cid).enrolledId, 'returns the existing enrollment')
  enrollInDrip(hv, cid, { source: 'manual' })
  assert.equal(db.all("SELECT id FROM drip_enrollments WHERE client_id=? AND status='active'", [cid]).length, before,
    'a concurrent campaign must not stack on ITSELF')
})

// ── the real campaigns carry the flag ────────────────────────────────────────────
test('both Home Value campaigns are flagged concurrent by the migration', () => {
  for (const name of ['Home Value Weekly — 6 Month', 'Home Value — Past Clients']) {
    const row = db.get('SELECT allow_concurrent FROM drip_campaigns WHERE name = ?', [name])
    if (!row) continue   // not every environment has them seeded
    assert.equal(row.allow_concurrent, 1, `${name} is designed to sit alongside the others`)
  }
})

test.after(() => {
  for (const c of clients) db.run('DELETE FROM drip_enrollments WHERE client_id=?', [c])
  for (const c of clients) db.run('DELETE FROM clients WHERE id=?', [c])
  for (const d of drips) { db.run('DELETE FROM drip_enrollments WHERE drip_id=?', [d]); db.run('DELETE FROM drip_campaigns WHERE id=?', [d]) }
})
