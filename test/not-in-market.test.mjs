// NOT IN MARKET transition: cleanup, idempotency, annual loop, exit behavior.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { executeNotInMarketTransition, exitNotInMarket, ANNUAL_TASK_TITLE } = await import('../server/not-in-market.js')

const made = { clients: [], tasks: [], texts: [], ai: [], drips: [] }
const iso = (d) => d.toISOString()
function mkClient(over = {}) {
  const r = db.run(`INSERT INTO clients (first_name, last_name, phone, email, status, type, agent_assigned) VALUES (?,?,?,?,?,?,?)`,
    ['Nim', 'Fixture' + Math.floor(Math.random() * 1e6), '(319) 555-0177', 'nim@example.com', over.status || 'watch', over.type || 'buyer', over.agent || 'Hunter Caves'])
  made.clients.push(r.lastInsertRowid)
  return r.lastInsertRowid
}
after(() => {
  for (const id of made.clients) {
    db.run("DELETE FROM tasks WHERE related_type='client' AND related_id=?", [id])
    db.run('DELETE FROM scheduled_texts WHERE client_id=?', [id])
    db.run('DELETE FROM ai_scheduled_actions WHERE client_id=?', [id])
    db.run('DELETE FROM ai_lead_state WHERE client_id=?', [id])
    db.run('DELETE FROM drip_enrollments WHERE client_id=?', [id])
    db.run('DELETE FROM followup_coverage WHERE client_id=?', [id])
    db.run('DELETE FROM followup_coverage_events WHERE client_id=?', [id])
    db.run("DELETE FROM activity_log WHERE entity_type='client' AND entity_id=?", [id])
    db.run('DELETE FROM clients WHERE id=?', [id])
  }
})

test('S1: full cleanup — drip, AI, scheduled text and sales task all stop; annual recheck created', () => {
  const cid = mkClient({})
  db.run("INSERT INTO drip_enrollments (drip_id, client_id, status, next_run_at) VALUES (2,?, 'active', ?)", [cid, iso(new Date(Date.now() + 86400000))])
  db.run("INSERT INTO ai_lead_state (client_id, ai_enabled, ai_state) VALUES (?,1,'AI_NURTURE')", [cid])
  db.run("INSERT INTO ai_scheduled_actions (client_id, action_type, execute_at, state, dedup_key) VALUES (?,?,?,?,?)", [cid, 'AI_FOLLOWUP', iso(new Date(Date.now() + 86400000)), 'pending', 'nimtest_' + cid])
  db.run("INSERT INTO scheduled_texts (client_id, phone, body, send_at, status) VALUES (?,?,?,?, 'scheduled')", [cid, '(319) 555-0177', 'hi', iso(new Date(Date.now() + 86400000))])
  db.run("INSERT INTO tasks (title, status, due_date, related_type, related_id) VALUES ('Call buyer about touring homes','todo',?, 'client', ?)", [iso(new Date(Date.now() + 3 * 86400000)).slice(0, 10), cid])
  db.run("UPDATE clients SET status='not_in_market' WHERE id=?", [cid])

  const s = executeNotInMarketTransition(cid, { actor: 'test' })
  assert.equal(s.drips, 1)
  assert.equal(s.texts_cancelled, 1)
  assert.equal(s.ai_actions_cancelled, 1)
  assert.equal(s.tasks_closed, 1)
  assert.equal(s.tx_conflict, false)
  assert.equal(s.annual_task.reused, false)
  const st = db.get('SELECT ai_enabled, ai_state FROM ai_lead_state WHERE client_id=?', [cid])
  assert.equal(st.ai_enabled, 0)
  const annual = db.get("SELECT * FROM tasks WHERE related_type='client' AND related_id=? AND title=?", [cid, ANNUAL_TASK_TITLE])
  assert.ok(annual)
  assert.equal(annual.assigned_to, 'Hunter Caves')
  const yr = new Date(); yr.setFullYear(yr.getFullYear() + 1)
  assert.equal(annual.due_date, yr.toISOString().slice(0, 10))
})

test('S3: running the transition twice never duplicates the annual task', () => {
  const cid = mkClient({})
  db.run("UPDATE clients SET status='not_in_market' WHERE id=?", [cid])
  const first = executeNotInMarketTransition(cid, {})
  const second = executeNotInMarketTransition(cid, {})
  assert.equal(first.annual_task.reused, false)
  assert.equal(second.annual_task.reused, true)
  const n = db.get("SELECT COUNT(*) n FROM tasks WHERE related_type='client' AND related_id=? AND title=? AND status NOT IN ('done','cancelled')", [cid, ANNUAL_TASK_TITLE]).n
  assert.equal(n, 1)
})

test('S4: leaving Not in Market closes the annual recheck', () => {
  const cid = mkClient({})
  db.run("UPDATE clients SET status='not_in_market' WHERE id=?", [cid])
  executeNotInMarketTransition(cid, {})
  db.run("UPDATE clients SET status='active' WHERE id=?", [cid])
  const r = exitNotInMarket(cid, 'active')
  assert.equal(r.annual_closed, 1)
  const open = db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title=? AND status NOT IN ('done','cancelled')", [cid, ANNUAL_TASK_TITLE])
  assert.ok(!open)
})

test('S9: active transaction — flagged, sales task cleanup skipped, transaction preserved', () => {
  const cid = mkClient({})
  const tx = db.run("INSERT INTO transactions (property_address, property_status, client_id) VALUES ('99 Test Ct','Under Contract',?)", [cid])
  db.run("INSERT INTO tasks (title, status, due_date, related_type, related_id) VALUES ('Follow up on financing','todo',?, 'client', ?)", [new Date().toISOString().slice(0, 10), cid])
  db.run("UPDATE clients SET status='not_in_market' WHERE id=?", [cid])
  const s = executeNotInMarketTransition(cid, {})
  assert.equal(s.tx_conflict, true)
  assert.equal(s.tasks_closed, 0)  // nothing touched while a transaction is live
  const t = db.get("SELECT status FROM tasks WHERE related_type='client' AND related_id=? AND title='Follow up on financing'", [cid])
  assert.equal(t.status, 'todo')
  db.run('DELETE FROM transactions WHERE id=?', [tx.lastInsertRowid])
})

test('coverage: Not in Market with the annual task evaluates PROTECTED by human task', async () => {
  const { evaluateFollowUpCoverage } = await import('../server/followup-coverage.js')
  const cid = mkClient({})
  db.run("UPDATE clients SET status='not_in_market' WHERE id=?", [cid])
  executeNotInMarketTransition(cid, {})
  const ev = evaluateFollowUpCoverage(cid)
  assert.equal(ev.coverage_status, 'protected')
  assert.equal(ev.coverage_type, 'human_task')
  assert.equal(ev.max_allowed_silence_days, null)  // no silence standard for this status
})
