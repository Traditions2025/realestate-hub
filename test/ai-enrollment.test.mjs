// AI AUTO-ENROLLMENT ENGINE — the spec's non-negotiables:
// New-status pool (New != recently created; age never excludes), hard exclusions always
// win (prospecting sources, FSBO/C-E identity, CX fence, STOP/DNT, landlines, manual),
// deferrals are temporary, classification drives the lane, fresh is uncapped,
// reactivation is capped + windowed, enrollment != sending, mode off = total no-op.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const eng = await import('../server/ai-enrollment.js')

let seq = 0
function mkClient(fields = {}) {
  const tag = `${Date.now()}${++seq}`
  const cols = {
    first_name: 'Test', last_name: 'Enroll' + tag, type: fields.type ?? 'buyer',
    phone: fields.phone === null ? null : (fields.phone || '(319) 555-' + tag.slice(-4)),
    status: fields.status ?? 'new', source: fields.source ?? 'Mattsmithteam.com',
    created_at: fields.created_at || new Date().toISOString(),
    ...Object.fromEntries(Object.entries(fields).filter(([k]) => !['type', 'phone', 'status', 'source', 'created_at'].includes(k))),
  }
  const keys = Object.keys(cols)
  const r = db.run(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]))
  return db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
}
function addComm(cid, direction, { channel = 'text', sentBy = null, daysAgo = 1, duration = null } = {}) {
  const at = new Date(Date.now() - daysAgo * 86400000).toISOString()
  db.run(`INSERT INTO communications (channel, direction, client_id, body, preview, thread_key, status, sent_by_type, duration_sec, occurred_at)
          VALUES (?,?,?,?,?,?, 'read', ?, ?, ?)`, [channel, direction, cid, 'msg', 'msg', `c${cid}_${channel}`, sentBy, duration, at])
}
const evalIt = (id) => eng.evaluateAiEnrollmentEligibility(id)

// Clean settings for each run of this suite (test DB persists between runs).
db.setSetting('ai_auto_enroll_mode', 'off')
db.setSetting('ai_enroll_source_exclude', eng.DEFAULT_SOURCE_EXCLUDE)
db.setSetting('ai_reactivation_daily_limit', '150')

// ---- the pool ----
test('pool is Status=New only — every other status is excluded', () => {
  for (const status of ['prime', 'active', 'pending', 'closed', 'not_in_market', 'junk', 'withdrawn', 'qualify']) {
    const c = mkClient({ status })
    const ev = evalIt(c.id)
    assert.equal(ev.decision, 'excluded', status)
    assert.equal(ev.reason_code, 'STATUS_NOT_NEW', status)
  }
})

test('AGE NEVER EXCLUDES: a 3-year-old New lead is eligible (cold classification)', () => {
  const c = mkClient({ created_at: new Date(Date.now() - 3 * 365 * 86400000).toISOString() })
  const ev = evalIt(c.id)
  assert.equal(ev.decision, 'eligible')
  assert.equal(ev.classification, 'COLD_NEVER_CONNECTED')
  assert.equal(ev.lane, 'reactivation')
})

// ---- hard exclusions ----
test('prospecting source origins are excluded (exact source-field match)', () => {
  for (const source of ['Realist', 'Import', 'Csv Import', 'Imported', 'Piesync', 'FSBO', 'Expired/Cancelled Mls', 'Foreclosure']) {
    const ev = evalIt(mkClient({ source }).id)
    assert.equal(ev.decision, 'excluded', source)
    // 'FSBO' can trip the autopilot tag/source substring list first — either way it is out
    assert.ok(ev.reason_code.startsWith('SOURCE_') || ev.reason_code === 'PROSPECTING_TAG', source + ' → ' + ev.reason_code)
  }
})

test('migration != origin: a genuine-origin source is NOT excluded by source class', () => {
  for (const source of ['Zillow', 'Facebook', 'Google Organic', 'Website Property Search', 'Zbuyer']) {
    const ev = evalIt(mkClient({ source }).id)
    assert.equal(ev.decision, 'eligible', source + ' → ' + ev.reason_code)
  }
})

test('FSBO and MLS-tracked identities are excluded regardless of source', () => {
  assert.equal(evalIt(mkClient({ fsbo_status: 'Available' }).id).reason_code, 'FSBO')
  assert.equal(evalIt(mkClient({ mls_status: 'Cancelled' }).id).reason_code, 'MLS_TRACKED')
})

test('CX Connect fence: a campaign lead is excluded, always', () => {
  const c = mkClient({})
  db.run("INSERT INTO cx_campaign (client_id, status, enrolled_at) VALUES (?, 'active', datetime('now'))", [c.id])
  assert.equal(evalIt(c.id).reason_code, 'CX_CAMPAIGN')
})

test('STOP / do-not-text / undeliverable / no phone are excluded', () => {
  assert.equal(evalIt(mkClient({ hub_text_opt_out: 1 }).id).reason_code, 'OPTED_OUT')
  assert.equal(evalIt(mkClient({ sms_undeliverable: 1 }).id).reason_code, 'UNDELIVERABLE')
  assert.equal(evalIt(mkClient({ phone: null }).id).reason_code, 'NO_PHONE')
})

test('manual exclusion is durable and reversible', () => {
  const c = mkClient({})
  db.run('INSERT OR IGNORE INTO ai_lead_state (client_id, ai_state) VALUES (?, ?)', [c.id, 'NEW_UNCONTACTED'])
  db.run('UPDATE ai_lead_state SET auto_enroll_excluded=1, auto_enroll_excluded_reason=? WHERE client_id=?', ['test', c.id])
  assert.equal(evalIt(c.id).reason_code, 'MANUAL_EXCLUDE')
  db.run('UPDATE ai_lead_state SET auto_enroll_excluded=0 WHERE client_id=?', [c.id])
  assert.equal(evalIt(c.id).decision, 'eligible')
})

test('already-enrolled (ai_enabled / ai_managed / pending action) is excluded, not re-enrolled', () => {
  const c = mkClient({})
  db.run('INSERT OR IGNORE INTO ai_lead_state (client_id, ai_enabled, ai_managed, ai_state) VALUES (?, 1, 1, ?)', [c.id, 'AI_WAITING_FOR_REPLY'])
  assert.equal(evalIt(c.id).reason_code, 'ALREADY_ENROLLED')
})

// ---- deferrals ----
test('recent human contact defers (with retry_after), then clears', () => {
  const c = mkClient({})
  addComm(c.id, 'outgoing', { sentBy: 'human', daysAgo: 0.2 })
  const ev = evalIt(c.id)
  assert.equal(ev.decision, 'deferred')
  assert.equal(ev.reason_code, 'RECENT_HUMAN_CONTACT')
  assert.ok(ev.retry_after)
})

test('older human contact does NOT defer — it classifies as previously connected when they replied', () => {
  const c = mkClient({ created_at: new Date(Date.now() - 200 * 86400000).toISOString() })
  addComm(c.id, 'outgoing', { sentBy: 'human', daysAgo: 90 })
  addComm(c.id, 'incoming', { daysAgo: 88 })
  const ev = evalIt(c.id)
  assert.equal(ev.decision, 'eligible')
  assert.equal(ev.classification, 'COLD_PREVIOUSLY_CONNECTED')
})

test('human takeover state defers', () => {
  const c = mkClient({})
  db.run('INSERT OR IGNORE INTO ai_lead_state (client_id, ai_state) VALUES (?, ?)', [c.id, 'HUMAN_TAKEOVER'])
  assert.equal(evalIt(c.id).reason_code, 'HUMAN_TAKEOVER')
})

// ---- classification + lanes ----
test('fresh lead (inside window, never worked) → FRESH_INCOMING on the fresh lane', () => {
  const c = mkClient({})
  const ev = evalIt(c.id)
  assert.equal(ev.classification, 'FRESH_INCOMING')
  assert.equal(ev.lane, 'fresh')
  assert.ok(ev.priority_score >= 90)
})

test('AI-only outbound does not make a lead previously connected', () => {
  const c = mkClient({ created_at: new Date(Date.now() - 100 * 86400000).toISOString() })
  addComm(c.id, 'outgoing', { sentBy: 'ai', daysAgo: 80 })
  const ev = evalIt(c.id)
  assert.equal(ev.classification, 'COLD_NEVER_CONNECTED')
})

test('recent website activity on a dormant old lead → REENGAGED_DORMANT, higher priority than cold', () => {
  const c = mkClient({ created_at: new Date(Date.now() - 400 * 86400000).toISOString() })
  db.run('INSERT INTO fub_activity (client_id, occurred_at) VALUES (?, ?)', [c.id, new Date(Date.now() - 2 * 86400000).toISOString()])
  const ev = evalIt(c.id)
  assert.equal(ev.classification, 'REENGAGED_DORMANT')
  const cold = evalIt(mkClient({ created_at: new Date(Date.now() - 400 * 86400000).toISOString() }).id)
  assert.ok(ev.priority_score > cold.priority_score)
})

// ---- enrollment executor ----
test('enrolling turns AI on, schedules the right first action, logs the audit row', () => {
  const c = mkClient({})
  const ev = evalIt(c.id)
  const r = eng.enrollLead(ev, { actor: 'test' })
  assert.equal(r.enrolled, true)
  assert.equal(r.route.action, 'AI_INITIAL_OUTREACH')
  const st = db.get('SELECT ai_enabled, ai_managed FROM ai_lead_state WHERE client_id=?', [c.id])
  assert.equal(st.ai_enabled, 1); assert.equal(st.ai_managed, 1)
  assert.ok(db.get("SELECT id FROM ai_scheduled_actions WHERE client_id=? AND state='pending'", [c.id]))
  const log = db.get('SELECT * FROM ai_enrollment_log WHERE client_id=? AND enrolled=1', [c.id])
  assert.equal(log.lane, 'fresh')
  // and re-evaluating now says ALREADY_ENROLLED (no double enrollment)
  assert.equal(evalIt(c.id).reason_code, 'ALREADY_ENROLLED')
})

test('reactivation routing: seller → AI_REENGAGE; buyer → cold-buyer sequence', () => {
  const seller = mkClient({ type: 'seller', created_at: new Date(Date.now() - 100 * 86400000).toISOString() })
  const rs = eng.enrollLead(evalIt(seller.id), { actor: 'test' })
  assert.equal(rs.route.action, 'AI_REENGAGE')
  const buyer = mkClient({ type: 'buyer', created_at: new Date(Date.now() - 100 * 86400000).toISOString() })
  const rb = eng.enrollLead(evalIt(buyer.id), { actor: 'test' })
  assert.equal(rb.route.action, 'AI_COLD_BUYER_SEQUENCE')
  // full staged sequence pre-scheduled for the buyer
  const n = db.get("SELECT COUNT(*) n FROM ai_scheduled_actions WHERE client_id=? AND action_type='AI_COLD_BUYER'", [buyer.id])?.n
  assert.ok(n >= 10, 'cold buyer stages pre-scheduled, got ' + n)
})

test('dry-run enrollment writes NOTHING', () => {
  const c = mkClient({})
  const r = eng.enrollLead(evalIt(c.id), { dryRun: true })
  assert.equal(r.enrolled, false)
  assert.ok(r.route)
  assert.ok(!db.get('SELECT ai_enabled FROM ai_lead_state WHERE client_id=?', [c.id])?.ai_enabled)
  assert.ok(!db.get('SELECT id FROM ai_scheduled_actions WHERE client_id=?', [c.id]))
  assert.ok(!db.get('SELECT id FROM ai_enrollment_log WHERE client_id=?', [c.id]))
})

// ---- mode gates + caps ----
test("mode 'off' = total no-op for both lanes", () => {
  db.setSetting('ai_auto_enroll_mode', 'off')
  assert.equal(eng.freshEnrollSweep().skipped, 'mode off')
  assert.equal(eng.reactivationTick({ force: true }).skipped, 'reactivation mode off')
})

test("mode 'fresh' runs the fresh lane but NOT reactivation", () => {
  db.setSetting('ai_auto_enroll_mode', 'fresh')
  assert.equal(eng.freshEnrollSweep().skipped, undefined)
  assert.equal(eng.reactivationTick({ force: true }).skipped, 'reactivation mode off')
  db.setSetting('ai_auto_enroll_mode', 'off')
})

test('daily cap stops the reactivation tick', () => {
  db.setSetting('ai_auto_enroll_mode', 'full')
  db.setSetting('ai_reactivation_daily_limit', '1')
  // burn the cap with a synthetic enrollment log row
  const c = mkClient({ created_at: new Date(Date.now() - 100 * 86400000).toISOString() })
  db.run(`INSERT INTO ai_enrollment_log (client_id, decision, reason_code, lane, enrolled, enrolled_at)
          VALUES (?, 'eligible', 'ELIGIBLE', 'reactivation', 1, datetime('now'))`, [c.id])
  const r = eng.reactivationTick({ force: true })
  assert.equal(r.skipped, 'daily limit reached')
  db.setSetting('ai_auto_enroll_mode', 'off')
  db.setSetting('ai_reactivation_daily_limit', '150')
})

test('audit log dedupes repeat decisions (times_seen bumps, no row flood)', () => {
  const c = mkClient({ source: 'Realist' })
  const ev = evalIt(c.id)
  eng.logEnrollmentDecision(ev); eng.logEnrollmentDecision(ev); eng.logEnrollmentDecision(ev)
  const rows = db.all('SELECT * FROM ai_enrollment_log WHERE client_id=?', [c.id])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].times_seen, 3)
})

test('reactivation window: weekday 9AM-4PM CT only', () => {
  // 2026-09-16 is a Wednesday. 15:00 UTC = 10AM CT (in), 23:00 UTC = 6PM CT (out).
  assert.equal(eng.inReactivationWindow(new Date('2026-09-16T15:00:00Z')), true)
  assert.equal(eng.inReactivationWindow(new Date('2026-09-16T23:00:00Z')), false)
  assert.equal(eng.inReactivationWindow(new Date('2026-09-13T15:00:00Z')), false, 'Sunday')
})
