// The 48 hour hold after a listing is CANCELLED (John, 2026-10-19).
//
// Expired is deliberately exempt: its term simply ran out on a date set months earlier,
// so there is no fresh decision to intrude on.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubcx_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const CX = await import('../server/cx-connect.js')
const { rule, setRule, resetRule } = await import('../server/rules.js')

const HOUR = 3600000
let seq = 0
function mkClient({ mls = 'Cancelled', off = null, phone = '3195551212', address = '1 Main St' } = {}) {
  const id = 930000 + (++seq)
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, phone, address, city, status, type, mls_status, off_market_date)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, 'Cx', 'Test' + seq, phone, address, 'Marion', 'new', 'seller', mls, off])
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}
const ago = (h) => new Date(Date.now() - h * HOUR).toISOString().slice(0, 10)
const agoExact = (h) => new Date(Date.now() - h * HOUR).toISOString()

test('the hold is 48 hours by default', () => {
  assert.equal(rule('cx_cancelled_hold_hours'), 48)
})

test('a listing cancelled an hour ago is held, not refused permanently', async () => {
  const c = mkClient({ mls: 'Cancelled', off: agoExact(1) })
  const r = await CX.evaluateEligibility(c, { atEnroll: true })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'TOO_SOON_AFTER_CANCEL')
  assert.equal(r.terminal, false, 'must stay enrolled and retry, never be dropped for being early')
  assert.match(r.detail, /holding 48h/)
})

test('John’s example: cancelled today, clear on the 21st', async () => {
  // 10/19 -> the hold clears 10/21, which is what the detail line must say.
  const c = mkClient({ mls: 'Cancelled', off: agoExact(2) })
  const r = await CX.evaluateEligibility(c, { atEnroll: true })
  const clears = new Date(Date.now() - 2 * HOUR + 48 * HOUR)
  assert.match(r.detail, new RegExp(clears.toISOString().slice(0, 10)))
})

// off_market_date is a DATE, not a timestamp: the sheet carries "2026-10-19" with no time.
// So the hold is measured from MIDNIGHT of the day it came off market, which is what makes
// John's example land exactly: cancelled on the 19th, clear any time on the 21st.
const daysAgo = (n) => new Date(Date.now() - n * 24 * HOUR).toISOString().slice(0, 10)

test('cancelled TODAY is held', async () => {
  const c = mkClient({ mls: 'Cancelled', off: daysAgo(0) })
  assert.equal((await CX.evaluateEligibility(c, { atEnroll: true })).code, 'TOO_SOON_AFTER_CANCEL')
})

test('cancelled YESTERDAY is still held', async () => {
  const c = mkClient({ mls: 'Cancelled', off: daysAgo(1) })
  assert.equal((await CX.evaluateEligibility(c, { atEnroll: true })).code, 'TOO_SOON_AFTER_CANCEL')
})

test('cancelled TWO DAYS ago is clear, which is John’s 19th to 21st', async () => {
  const c = mkClient({ mls: 'Cancelled', off: daysAgo(2) })
  const r = await CX.evaluateEligibility(c, { atEnroll: true })
  assert.equal(r.ok, true, r.detail || '')
})

test('EXPIRED is exempt and goes straight through, even minutes old', async () => {
  const c = mkClient({ mls: 'Expired', off: agoExact(0.2) })
  const r = await CX.evaluateEligibility(c, { atEnroll: true })
  assert.equal(r.ok, true, 'an expired term needs no cooling off: ' + (r.detail || ''))
})

test('a cancelled listing with no off-market date is not stalled for ever', async () => {
  // 71 of the 139 MLS leads carry no off_market_date. Holding on a date we do not have
  // would block them permanently, so absent evidence of recency they are allowed.
  const c = mkClient({ mls: 'Cancelled', off: null })
  const r = await CX.evaluateEligibility(c, { atEnroll: true })
  assert.equal(r.ok, true, r.detail || '')
})

test('both date formats in the sheet are understood', async () => {
  // The master file carries ISO ("2025-11-19") and US ("10/02/2026") in the same column.
  const d = new Date(Date.now() - 1 * HOUR)
  const us = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
  const iso = d.toISOString().slice(0, 10)
  for (const fmt of [us, iso]) {
    const c = mkClient({ mls: 'Cancelled', off: fmt })
    const r = await CX.evaluateEligibility(c, { atEnroll: true })
    // Same calendar day either way: a date-only value is midnight, so a listing cancelled
    // "today" is inside the window whichever format it arrived in.
    assert.equal(r.code, 'TOO_SOON_AFTER_CANCEL', `format ${fmt} was not recognised`)
  }
})

test('the hold length is a dial and takes effect immediately', async () => {
  const c = mkClient({ mls: 'Cancelled', off: agoExact(10) })
  assert.equal((await CX.evaluateEligibility(c, { atEnroll: true })).code, 'TOO_SOON_AFTER_CANCEL')
  setRule('cx_cancelled_hold_hours', 6, 'test')
  assert.equal((await CX.evaluateEligibility(c, { atEnroll: true })).ok, true, '10h old clears a 6h hold')
  resetRule('cx_cancelled_hold_hours', 'test')
  assert.equal((await CX.evaluateEligibility(c, { atEnroll: true })).code, 'TOO_SOON_AFTER_CANCEL')
})

test('the hold cannot be stretched past two weeks', () => {
  setRule('cx_cancelled_hold_hours', 99999, 'test')
  assert.equal(rule('cx_cancelled_hold_hours'), 336)
  resetRule('cx_cancelled_hold_hours', 'test')
})

test('the hold never overrides a terminal refusal', async () => {
  // A relisted or sold property must still be refused outright, not merely held.
  for (const [mls, code] of [['Active', 'RELISTED'], ['Sold', 'SOLD'], ['Pending', 'PENDING']]) {
    const c = mkClient({ mls, off: agoExact(1) })
    const r = await CX.evaluateEligibility(c, { atEnroll: true })
    assert.equal(r.code, code, `${mls} must stay terminal`)
    assert.equal(r.terminal, true)
  }
})

test('a cancelled lead with no phone is still refused for the phone, not the hold', async () => {
  const c = mkClient({ mls: 'Cancelled', off: agoExact(1), phone: '' })
  const r = await CX.evaluateEligibility(c, { atEnroll: true })
  assert.equal(r.code, 'WRONG_NUMBER', 'the harder refusal wins')
})

/* ---------- blocking somebody who is not enrolled yet ---------- */

test('removing a lead who was never enrolled still blocks them', async () => {
  const c = mkClient({ mls: 'Cancelled', off: daysAgo(5) })
  assert.equal((await CX.evaluateEligibility(c, { atEnroll: true })).ok, true, 'eligible to start with')
  const r = CX.removeFromCampaign(c.id)
  assert.equal(r.ok, true)
  assert.equal(r.pre_enrolment, true, 'a row is written even though they were never enrolled')
  // the next auto-enrol tick must refuse them
  const en = await CX.enrollClient(c.id, 'bulk')
  assert.equal(en.ok, false)
  assert.match(en.reason, /removed by a human/)
})

test('removing an already-enrolled lead still works as before', async () => {
  const c = mkClient({ mls: 'Expired', off: daysAgo(5) })
  const first = await CX.enrollClient(c.id, 'bulk')
  assert.equal(first.ok, true, first.reason || '')
  const r = CX.removeFromCampaign(c.id)
  assert.equal(r.was_enrolled, true)
  const again = await CX.enrollClient(c.id, 'bulk')
  assert.equal(again.ok, false)
  assert.match(again.reason, /removed by a human/)
})
