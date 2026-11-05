// Nobody holds two rows on one campaign (John, 2026-11-04).
//
// Asked to confirm no past client had the Home Value drip twice. The data was clean, but
// the guard only matched status='active', so a PAUSED lead could be enrolled again and
// resuming the first row left two live enrollments sending every step twice.
// home-value-sms.js already tested active-or-paused before its own insert; this is the
// other door into the same table.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { enrollInDrip, dripBlockReason } = await import('../server/routes/drips.js')

let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')

function mkDrip(name, { concurrent = 0 } = {}) {
  const steps = JSON.stringify([{ id: 's1', template_id: 1, delay_days: 0, send_time: '09:00' },
    { id: 's2', template_id: 2, delay_days: 30, send_time: '09:00' }])
  return db.run('INSERT INTO drip_campaigns (name, steps, allow_concurrent) VALUES (?,?,?)',
    [`${name} ${uniq()}`, steps, concurrent]).lastInsertRowid
}
const mkClient = () => db.run(
  'INSERT INTO clients (first_name, last_name, type, status, email) VALUES (?,?,?,?,?)',
  ['Past', 'Client', 'buyer', 'closed', `dup${uniq()}@example.com`]).lastInsertRowid

const rows = (cid, did) => db.all(
  "SELECT id, status FROM drip_enrollments WHERE client_id=? AND drip_id=?", [cid, did])

test('enrolling twice gives back the first enrollment, not a second row', () => {
  const d = mkDrip('Home Value Dup'), c = mkClient()
  const first = enrollInDrip(d, c, { source: 'manual' })
  const again = enrollInDrip(d, c, { source: 'manual' })
  assert.equal(again, first, 'the same enrollment comes back')
  assert.equal(rows(c, d).length, 1, 'exactly one row exists')
})

test('a PAUSED enrollment still counts as being on the campaign', () => {
  const d = mkDrip('Home Value Paused'), c = mkClient()
  const first = enrollInDrip(d, c, { source: 'manual' })
  db.run("UPDATE drip_enrollments SET status='paused' WHERE id=?", [first])
  const again = enrollInDrip(d, c, { source: 'manual' })
  assert.equal(again, first, 'no new row — the paused one is theirs')
  assert.equal(rows(c, d).length, 1)
  // ...and resuming it cannot now produce two live rows.
  db.run("UPDATE drip_enrollments SET status='active' WHERE id=?", [first])
  assert.equal(rows(c, d).filter(r => r.status === 'active').length, 1)
})

test('a concurrent campaign is no exception — once is still once', () => {
  // allow_concurrent lifts the one-drip-per-lead rule ACROSS campaigns, never within one.
  const d = mkDrip('Home Value Concurrent', { concurrent: 1 }), c = mkClient()
  const first = enrollInDrip(d, c, { source: 'home_value_auto', allowConcurrent: true })
  const again = enrollInDrip(d, c, { source: 'home_value_auto', allowConcurrent: true })
  assert.equal(again, first)
  assert.equal(rows(c, d).length, 1)
})

test('a removed enrollment CAN be re-enrolled — that is a fresh start, not a double', () => {
  const d = mkDrip('Home Value Removed'), c = mkClient()
  const first = enrollInDrip(d, c, { source: 'manual' })
  db.run("UPDATE drip_enrollments SET status='removed' WHERE id=?", [first])
  const again = enrollInDrip(d, c, { source: 'manual' })
  assert.notEqual(again, first, 'a new enrollment is created')
  assert.equal(rows(c, d).filter(r => r.status === 'active').length, 1, 'still only one LIVE row')
})

test('the block reason reports the existing enrollment rather than a refusal', () => {
  const d = mkDrip('Home Value Reason'), c = mkClient()
  const first = enrollInDrip(d, c, { source: 'manual' })
  db.run("UPDATE drip_enrollments SET status='paused' WHERE id=?", [first])
  const b = dripBlockReason(d, c, { source: 'manual' })
  assert.equal(b.enrolledId, first)
  assert.equal(b.reason, undefined, 'not phrased as a failure — they are already on it')
})
