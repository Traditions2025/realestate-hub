// Follow-Up Coverage — the fall-through scenarios from the spec, run against
// real fixtures in the local DB (created + cleaned up here). The critical one
// is task completion: the moment the last future task closes, the lead must
// become UNPROTECTED, never silently vanish.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { evaluateFollowUpCoverage, recalcCoverage, timeframeMonths, coverageConfig } = await import('../server/followup-coverage.js')

const iso = (d) => d.toISOString()
const daysFromNow = (n) => iso(new Date(Date.now() + n * 86400000))
const daysAgo = (n) => iso(new Date(Date.now() - n * 86400000))

const made = { clients: [], tasks: [], comms: [], drips: [], tx: [], sched: [] }
function mkClient(over = {}) {
  const r = db.run(`INSERT INTO clients (first_name, last_name, phone, email, status, type) VALUES (?,?,?,?,?,?)`,
    [over.first_name || 'Covtest', over.last_name || 'Fixture' + Math.floor(Math.random() * 1e6), over.phone ?? '(319) 555-0142', over.email ?? 'covtest@example.com', over.status || 'watch', over.type || 'seller'])
  const id = r.lastInsertRowid
  for (const [k, v] of Object.entries(over)) if (!['first_name', 'last_name', 'phone', 'email', 'status', 'type'].includes(k)) db.run(`UPDATE clients SET ${k}=? WHERE id=?`, [v, id])
  made.clients.push(id)
  return id
}
function connect(cid, agoDays = 10) {
  // meaningful two-way: our human text, then their reply
  const a = db.run(`INSERT INTO communications (channel, direction, client_id, body, sent_by_type, occurred_at) VALUES ('text','outgoing',?,?,'human',?)`, [cid, 'Hi, it is John with Matt Smith Team', daysAgo(agoDays + 1)])
  const b = db.run(`INSERT INTO communications (channel, direction, client_id, body, occurred_at) VALUES ('text','incoming',?,?,?)`, [cid, 'Yes we are thinking of selling next year', daysAgo(agoDays)])
  made.comms.push(a.lastInsertRowid, b.lastInsertRowid)
}
after(() => {
  for (const t of made.tasks) db.run('DELETE FROM tasks WHERE id=?', [t])
  for (const c of made.comms) db.run('DELETE FROM communications WHERE id=?', [c])
  for (const d of made.drips) db.run('DELETE FROM drip_enrollments WHERE id=?', [d])
  for (const t of made.tx) db.run('DELETE FROM transactions WHERE id=?', [t])
  for (const s of made.sched) db.run('DELETE FROM scheduled_texts WHERE id=?', [s])
  for (const id of made.clients) {
    db.run('DELETE FROM followup_coverage WHERE client_id=?', [id])
    db.run('DELETE FROM followup_coverage_events WHERE client_id=?', [id])
    db.run('DELETE FROM clients WHERE id=?', [id])
  }
})

test('S5: connected seller with nothing scheduled is UNPROTECTED with a seller flag', () => {
  const cid = mkClient({ type: 'seller' }); connect(cid, 20)
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.relationship_level === 'never_connected', false)
  assert.equal(ev.coverage_status, 'unprotected')
  assert.ok(ev.risk_flags.includes('connected_seller_no_next_action'))
  assert.ok(ev.recommended_action)
})

test('S2: a future human task protects the lead', () => {
  const cid = mkClient({}); connect(cid, 5)
  const t = db.run(`INSERT INTO tasks (title, status, due_date, related_type, related_id) VALUES ('Call seller','todo',?, 'client', ?)`, [daysFromNow(6).slice(0, 10), cid])
  made.tasks.push(t.lastInsertRowid)
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'protected')
  assert.equal(ev.coverage_type, 'human_task')
  assert.equal(ev.next_action_type, 'human_task')
})

test('S17/S59 CRITICAL: completing the last task flips the lead to UNPROTECTED on recalc', () => {
  const cid = mkClient({}); connect(cid, 5)
  const t = db.run(`INSERT INTO tasks (title, status, due_date, related_type, related_id) VALUES ('Follow up','todo',?, 'client', ?)`, [daysFromNow(1).slice(0, 10), cid])
  made.tasks.push(t.lastInsertRowid)
  assert.equal(recalcCoverage(cid).coverage_status, 'protected')
  db.run("UPDATE tasks SET status='done', completed_at=? WHERE id=?", [iso(new Date()), t.lastInsertRowid])
  const ev = recalcCoverage(cid)
  assert.equal(ev.coverage_status, 'unprotected')
  const evs = db.all('SELECT * FROM followup_coverage_events WHERE client_id=? ORDER BY id', [cid])
  assert.ok(evs.some(e => e.new_status === 'unprotected'), 'transition event recorded')
})

test('S3: a pending AI action protects a textable lead; S14: not one who texted STOP', () => {
  const cid = mkClient({}); connect(cid, 3)
  db.run(`INSERT INTO ai_scheduled_actions (client_id, action_type, execute_at, state, dedup_key) VALUES (?,?,?,?,?)`,
    [cid, 'AI_FOLLOWUP', daysFromNow(2), 'pending', 'covtest_' + cid])
  let ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'protected')
  assert.equal(ev.coverage_type, 'ai')
  db.run('UPDATE clients SET hub_text_opt_out=1 WHERE id=?', [cid])
  ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'unprotected', 'SMS coverage does not count for an opted-out lead')
  db.run('DELETE FROM ai_scheduled_actions WHERE client_id=?', [cid])
})

test('S13: opted-out of SMS but a future CALL task still protects', () => {
  const cid = mkClient({ hub_text_opt_out: 1 }); connect(cid, 3)
  const t = db.run(`INSERT INTO tasks (title, status, due_date, related_type, related_id) VALUES ('Call them','todo',?, 'client', ?)`, [daysFromNow(3).slice(0, 10), cid])
  made.tasks.push(t.lastInsertRowid)
  assert.equal(evaluateFollowUpCoverage(cid).coverage_status, 'protected')
})

test('S4/S10: an active drip with a future run protects; a removed one does not', () => {
  const cid = mkClient({}); connect(cid, 3)
  const d = db.run(`INSERT INTO drip_enrollments (drip_id, client_id, status, next_run_at) VALUES (4, ?, 'active', ?)`, [cid, daysFromNow(9)])
  made.drips.push(d.lastInsertRowid)
  assert.equal(evaluateFollowUpCoverage(cid).coverage_type, 'drip')
  db.run("UPDATE drip_enrollments SET status='removed' WHERE id=?", [d.lastInsertRowid])
  assert.equal(evaluateFollowUpCoverage(cid).coverage_status, 'unprotected')
})

test('S11: an Under Contract transaction protects and makes the lead a CLIENT', () => {
  const cid = mkClient({}); connect(cid, 3)
  const t = db.run(`INSERT INTO transactions (property_address, property_status, client_id, closing_date) VALUES ('123 Test St','Under Contract',?,?)`, [cid, daysFromNow(20).slice(0, 10)])
  made.tx.push(t.lastInsertRowid)
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'protected')
  assert.equal(ev.coverage_type, 'transaction')
  assert.equal(ev.relationship_level, 'client')
})

test('S6/S7: future snooze = SNOOZED; past snooze does not count', () => {
  const cid = mkClient({ snooze_until: daysFromNow(30), snooze_reason: 'reconnect after Christmas' }); connect(cid, 3)
  assert.equal(evaluateFollowUpCoverage(cid).coverage_status, 'snoozed')
  db.run('UPDATE clients SET snooze_until=? WHERE id=?', [daysAgo(1), cid])
  assert.equal(evaluateFollowUpCoverage(cid).coverage_status, 'unprotected', 'expired snooze is not coverage')
})

test('S15: silence past the window makes covered leads AT RISK, and going-cold flags fire', () => {
  const cid = mkClient({ type: 'seller', status: 'new' }); connect(cid, 45) // connected-seller window default 30 (watch status would get 60)
  const d = db.run(`INSERT INTO drip_enrollments (drip_id, client_id, status, next_run_at) VALUES (5, ?, 'active', ?)`, [cid, daysFromNow(10)])
  made.drips.push(d.lastInsertRowid)
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'at_risk')
  assert.ok(ev.risk_flags.includes('seller_going_cold'))
})

test('exclusion documents itself and wins over everything', () => {
  const cid = mkClient({ exclude_reason: 'Represented by another agent' }); connect(cid, 3)
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'excluded')
  assert.match(ev.reason, /Represented/)
})

test('never-connected lead is lower urgency (no meaningful flags)', () => {
  const cid = mkClient({})
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.relationship_level, 'never_connected')
  assert.equal(ev.coverage_status, 'unprotected')
  assert.ok(!ev.risk_flags.length)
})

test('timeframeMonths parses real phrasing and never invents values', () => {
  assert.equal(timeframeMonths('3-6 months'), 3)
  assert.equal(timeframeMonths('about 90 days'), 3)
  assert.equal(timeframeMonths('ASAP'), 1)
  assert.equal(timeframeMonths('1 year'), 12)
  assert.equal(timeframeMonths('whenever the right one shows up'), null)
  assert.equal(timeframeMonths(''), null)
})

test('coverageConfig merges saved values over defaults', () => {
  const cfg = coverageConfig()
  assert.ok(cfg.connected_seller >= 1)
  assert.ok(cfg.at_risk_fraction > 0 && cfg.at_risk_fraction <= 1)
})
