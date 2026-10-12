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

// ---------------------------------------------------------------------------
// "make sure nothing gets them enrolled again unless done manually" (John, 2026-10-12).
// One test per path that can write an fsbo_followups row. Every one of these executes
// the real statement; none of them read source.
// ---------------------------------------------------------------------------

test('the sweep upsert itself refuses to reactivate a removed row, even if it is handed one', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  f.removeFromFsboCampaign(c.id, 'john@test')
  // Run the sweep's exact INSERT..ON CONFLICT against this lead, bypassing the candidate
  // query entirely — this is the statement that used to be the single point of failure.
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, started_dom, attempt_count, next_send_at, listing_address, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT (client_id) DO UPDATE SET status='active', enrolled_at=excluded.enrolled_at, started_dom=excluded.started_dom,
            next_send_at=excluded.next_send_at, listing_address=excluded.listing_address, stop_reason=NULL, updated_at=excluded.updated_at
          WHERE fsbo_followups.status NOT IN ('removed','paused')`,
    [c.id, 'active', new Date().toISOString(), 40, 0, new Date().toISOString(), '1 Test St', new Date().toISOString()])
  assert.equal(row(c.id).status, 'removed', 'the upsert must not flip a removal to active')
  assert.equal(row(c.id).next_send_at, null, 'and must not schedule a send')
})

test('the same upsert still revives an OFF_MARKET stop — the intended re-entry path', () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  db.run(`INSERT INTO fsbo_followups (client_id, status, stop_reason, updated_at) VALUES (?,?,?,?)`,
    [c.id, 'stopped', 'FSBO_OFF_MARKET: listing is Sold', new Date().toISOString()])
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, started_dom, attempt_count, next_send_at, listing_address, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT (client_id) DO UPDATE SET status='active', enrolled_at=excluded.enrolled_at, started_dom=excluded.started_dom,
            next_send_at=excluded.next_send_at, listing_address=excluded.listing_address, stop_reason=NULL, updated_at=excluded.updated_at
          WHERE fsbo_followups.status NOT IN ('removed','paused')`,
    [c.id, 'active', new Date().toISOString(), 40, 0, new Date().toISOString(), '1 Test St', new Date().toISOString()])
  assert.equal(row(c.id).status, 'active', 'a relisted FSBO must still be able to come back')
})

test('fsboManualDecision is the single rule, and reports which decision is on file', () => {
  const a = mkFsbo(); const b = mkFsbo(); const none = mkFsbo()
  f.removeFromFsboCampaign(a.id, 'john@test')
  f.pauseFsboCampaign(b.id, 'john@test')
  assert.equal(f.fsboManualDecision(a.id).status, 'removed')
  assert.equal(f.fsboManualDecision(b.id).status, 'paused')
  assert.equal(f.fsboManualDecision(none.id), null)
  // an active or stopped row is NOT a manual decision — those stay automatic
  db.run("INSERT INTO fsbo_followups (client_id, status, updated_at) VALUES (?,'active',?)", [none.id, new Date().toISOString()])
  assert.equal(f.fsboManualDecision(none.id), null)
})

test('a blanket done-row reactivation cannot pick up a removed lead', () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  f.removeFromFsboCampaign(c.id, 'john@test')
  // the real statement from the migration path
  db.run("UPDATE fsbo_followups SET status='active', next_send_at=? WHERE status='done' AND replied=0", [new Date().toISOString()])
  assert.equal(row(c.id).status, 'removed')
})

test('MERGE carries an exclusion onto the surviving record', () => {
  const dup = mkFsbo({ fsbo_dom: '40' })                      // the excluded FSBO record
  const survivor = mkFsbo({ fsbo_status: null, fsbo_dom: null })  // plain lead, no FSBO identity
  f.removeFromFsboCampaign(dup.id, 'john@test', 'seller asked us not to')
  const carried = f.carryFsboDecisionToSurvivor(survivor.id, dup.id, 'merge')
  assert.ok(carried, 'the decision must travel')
  assert.equal(carried.carried, 'removed')
  assert.equal(row(survivor.id).status, 'removed')
  assert.match(row(survivor.id).stop_reason, new RegExp(`carried from merged record ${dup.id}`))
  assert.ok(f.fsboManualDecision(survivor.id), 'the survivor is now excluded too')
})

test('MERGE does not overwrite a decision the survivor already made', () => {
  const dup = mkFsbo(); const survivor = mkFsbo()
  f.removeFromFsboCampaign(dup.id, 'someone@test')
  f.pauseFsboCampaign(survivor.id, 'john@test')               // survivor is only HELD
  const carried = f.carryFsboDecisionToSurvivor(survivor.id, dup.id, 'merge')
  assert.equal(carried, null, 'leave the survivor decision alone')
  assert.equal(row(survivor.id).status, 'paused')
  assert.equal(row(survivor.id).paused_by, 'john@test')
})

test('MERGE keeps the survivor attempt history while applying the carried exclusion', () => {
  const dup = mkFsbo(); const survivor = mkFsbo({ fsbo_dom: '40' })
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, attempt_count, last_angle, updated_at)
          VALUES (?,?,?,?,?,?)`, [survivor.id, 'active', new Date().toISOString(), 2, 'PRICE_CHECK', new Date().toISOString()])
  f.removeFromFsboCampaign(dup.id, 'john@test')
  f.carryFsboDecisionToSurvivor(survivor.id, dup.id, 'merge')
  const r = row(survivor.id)
  assert.equal(r.status, 'removed', 'an exclusion stops an active campaign on the same person')
  assert.equal(r.attempt_count, 2, 'history survives')
  assert.equal(r.last_angle, 'PRICE_CHECK')
  assert.ok(r.enrolled_at, 'enrolled_at survives, so Allow-back-in routes to Resume not delete')
})

test('MERGE with nothing to carry is a no-op', () => {
  const dup = mkFsbo(); const survivor = mkFsbo()
  assert.equal(f.carryFsboDecisionToSurvivor(survivor.id, dup.id, 'merge'), null)
  assert.ok(!row(survivor.id))
})

test('only a manual action clears the decision: removed survives every automatic write', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  f.removeFromFsboCampaign(c.id, 'john@test')
  // every automatic statement that touches this table, fired in sequence
  db.run("UPDATE fsbo_followups SET status='responded', responded_at=COALESCE(responded_at, updated_at) WHERE replied=1 AND status IN ('active','done')")
  db.run("UPDATE fsbo_followups SET status='active', next_send_at=? WHERE status='done' AND replied=0", [new Date().toISOString()])
  assert.equal(row(c.id).status, 'removed')
  assert.equal((await f.evaluateFsboCampaignEligibility(c.id)).decision, 'excluded')
  // and the manual action DOES clear it
  await f.resumeFsboCampaign(c.id, 'john@test')
  assert.ok(!row(c.id))
})

test('the dry-run preview never lists an excluded lead as would-enroll', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  let p = await f.previewFsboCampaign()
  const before = p.table.find(t => t.client_id === c.id)
  assert.equal(before.decision, 'eligible', 'baseline: a DOM-40 FSBO is eligible')

  f.removeFromFsboCampaign(c.id, 'john@test')
  p = await f.previewFsboCampaign()
  const after = p.table.find(t => t.client_id === c.id)
  assert.equal(after.decision, 'excluded')
  assert.equal(after.reason, 'MANUAL_REMOVAL')
  assert.equal(after.campaign_state, 'removed')
  assert.equal(after.next_proposed_send, null, 'no send is ever proposed for them')
})

test('a held (paused) pre-enrolment lead is also never proposed for a send', async () => {
  const c = mkFsbo({ fsbo_dom: '40' })
  f.pauseFsboCampaign(c.id, 'john@test')
  const p = await f.previewFsboCampaign()
  const t = p.table.find(x => x.client_id === c.id)
  assert.equal(t.decision, 'excluded')
  assert.equal(t.reason, 'MANUAL_PAUSE')
  assert.equal(t.next_proposed_send, null)
})
