// Excluding a FSBO from the campaign BEFORE they are ever enrolled.
//
// John, 2026-10-12: "make that available even for those that did not get it yet like
// Deborah Emrich which is still DOM 3". A lead below the DOM threshold has no
// fsbo_followups row, so the old UPDATE-only pause/remove changed nothing and still
// returned ok — the lead auto-enrolled the day they crossed DOM 14.
//
// Every test here EXECUTES the real SQL against the real schema. A test that only reads
// source would have passed over the UPDATE-with-no-row bug, which is exactly how it shipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()

const f = await import('../server/fsbo-followup.js')

let seq = 0
function mkFsbo(fields = {}) {
  const tag = `${Date.now()}${++seq}`
  const cols = {
    first_name: 'Pre', last_name: 'Enrol' + tag.slice(-5),
    type: 'seller', status: 'watch',
    phone: `(319) 4${tag.slice(-2)}-${tag.slice(-4)}`,
    address: `${tag.slice(-3)} Elm St`,
    fsbo_status: 'Available',
    fsbo_dom: '3',                       // Deborah's case: well below the threshold
    fsbo_list_date: new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
    ...fields,
  }
  const keys = Object.keys(cols)
  const r = db.run(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]))
  return db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
}
const row = (cid) => db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [cid])

test('a DOM-3 FSBO starts with no campaign row and is only waiting', async () => {
  const c = mkFsbo()
  assert.ok(!row(c.id), 'no enrolment row before the threshold')
  const ev = await f.evaluateFsboCampaignEligibility(c.id)
  assert.equal(ev.decision, 'waiting')
})

test('Exclude before enrolment WRITES a decision row and reports it as pre-enrolment', async () => {
  const c = mkFsbo()
  const res = f.removeFromFsboCampaign(c.id, 'john@test', 'owner asked us not to')
  assert.equal(res.ok, true)
  assert.equal(res.pre_enrollment, true, 'must say the lead was never enrolled')
  const r = row(c.id)
  assert.ok(r, 'the row the old version failed to create')
  assert.equal(r.status, 'removed')
  assert.equal(r.removed_by, 'john@test')
  assert.match(r.stop_reason, /MANUAL_REMOVAL: owner asked us not to/)
  assert.equal(r.enrolled_at, null, 'enrolled_at stays null — this is how an undo tells the cases apart')
  assert.equal(r.next_send_at, null)
})

test('the exclusion makes the evaluator refuse, and still refuses once DOM passes the threshold', async () => {
  const c = mkFsbo()
  f.removeFromFsboCampaign(c.id, 'john@test')
  let ev = await f.evaluateFsboCampaignEligibility(c.id)
  assert.equal(ev.decision, 'excluded')
  assert.equal(ev.reason_code, 'MANUAL_REMOVAL')

  // The whole point: time passes, DOM crosses 14, the decision must still hold.
  db.run("UPDATE clients SET fsbo_dom='40', fsbo_list_date=? WHERE id=?",
    [new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10), c.id])
  ev = await f.evaluateFsboCampaignEligibility(c.id)
  assert.equal(ev.decision, 'excluded', 'an excluded lead must not become eligible at DOM 14')
  assert.equal(ev.reason_code, 'MANUAL_REMOVAL')
})

test('the auto-enroll sweep cannot pull an excluded pre-enrolment lead back in', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  f.removeFromFsboCampaign(c.id, 'john@test')
  // The sweep's own candidate query: no row at all, or an OFF_MARKET stop. Neither matches.
  const candidate = db.get(`SELECT c.id FROM clients c LEFT JOIN fsbo_followups fo ON fo.client_id=c.id
    WHERE c.id=? AND c.fsbo_status='Available' AND c.merged_into IS NULL
      AND (fo.client_id IS NULL OR (fo.status='stopped' AND fo.stop_reason LIKE 'FSBO_OFF_MARKET%'))`, [c.id])
  assert.ok(!candidate, 'a removed lead must never be an enrol candidate')
})

test('Hold before enrolment writes a paused row and excludes', async () => {
  const c = mkFsbo()
  const res = f.pauseFsboCampaign(c.id, 'john@test')
  assert.equal(res.pre_enrollment, true)
  assert.equal(row(c.id).status, 'paused')
  assert.equal(row(c.id).enrolled_at, null)
  const ev = await f.evaluateFsboCampaignEligibility(c.id)
  assert.equal(ev.decision, 'excluded')
  assert.equal(ev.reason_code, 'MANUAL_PAUSE')
})

test('Allow back in DELETES a pre-enrolment decision, returning them to normal waiting', async () => {
  const c = mkFsbo()
  f.removeFromFsboCampaign(c.id, 'john@test')
  const res = await f.resumeFsboCampaign(c.id, 'john@test')
  assert.equal(res.ok, true, 'resume must not demand eligibility for a DOM-3 lead')
  assert.equal(res.pre_enrollment, true)
  assert.ok(!row(c.id), 'the decision row is removed, not reactivated')
  const ev = await f.evaluateFsboCampaignEligibility(c.id)
  assert.equal(ev.decision, 'waiting', 'back to waiting for DOM, not force-enrolled')
})

test('an undo never force-starts a campaign: the lead is not active and has no next send', async () => {
  const c = mkFsbo()
  f.pauseFsboCampaign(c.id, 'john@test')
  await f.resumeFsboCampaign(c.id, 'john@test')
  const r = row(c.id)
  assert.ok(!r)
  // and at DOM 3 the evaluator still will not send
  const ev = await f.evaluateFsboCampaignEligibility(c.id)
  assert.equal(ev.eligible, false)
})

test('a lead that DID enrol keeps the old Resume behaviour, re-checking eligibility', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, started_dom, attempt_count, updated_at)
          VALUES (?,?,?,?,?,?)`, [c.id, 'active', new Date().toISOString(), 40, 1, new Date().toISOString()])
  f.pauseFsboCampaign(c.id, 'john@test')
  assert.equal(row(c.id).status, 'paused')
  assert.ok(row(c.id).enrolled_at, 'pause must not wipe the enrolment history')

  const res = await f.resumeFsboCampaign(c.id, 'john@test')
  assert.equal(res.ok, true)
  assert.notEqual(res.pre_enrollment, true, 'an enrolled lead goes down the resume path, not the delete path')
  assert.equal(row(c.id).status, 'active', 'row is reactivated, never deleted')
  assert.equal(row(c.id).attempt_count, 1, 'attempt history survives')
})

test('allowBackIntoFsboCampaign refuses to delete an enrolled row', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, attempt_count, updated_at)
          VALUES (?,?,?,?,?)`, [c.id, 'removed', new Date().toISOString(), 3, new Date().toISOString()])
  const res = f.allowBackIntoFsboCampaign(c.id, 'john@test')
  assert.equal(res.ok, false)
  assert.equal(res.needs_resume, true)
  assert.ok(row(c.id), 'the enrolled row with 3 attempts must still be there')
  assert.equal(row(c.id).attempt_count, 3)
})

test('excluding twice is idempotent and does not duplicate the row', async () => {
  const c = mkFsbo()
  f.removeFromFsboCampaign(c.id, 'john@test')
  f.removeFromFsboCampaign(c.id, 'john@test', 'again')
  const n = db.get('SELECT COUNT(*) n FROM fsbo_followups WHERE client_id=?', [c.id]).n
  assert.equal(n, 1)
  assert.match(row(c.id).stop_reason, /again/)
})

test('the decision is written to the audit log either way', async () => {
  const c = mkFsbo()
  f.removeFromFsboCampaign(c.id, 'john@test', 'seller said no')
  const log = db.all('SELECT * FROM fsbo_campaign_log WHERE client_id=? ORDER BY id', [c.id])
  assert.ok(log.length >= 1)
  const rm = log.find(l => l.event === 'removed')
  assert.ok(rm, 'a removal must be logged')
  assert.match(String(rm.reason), /seller said no/)
  assert.match(String(rm.reason), /before enrolment/, 'the log says it happened pre-enrolment')
})
