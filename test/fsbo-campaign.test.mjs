// FSBO AUTOMATIC TEXT CAMPAIGN — the spec's non-negotiables: DOM-14 threshold on
// LIVE listing DOM (imported-above-threshold qualifies immediately), hard exclusions
// (Off Market / prior response / STOP / landline), deferrals (recent human), manual
// pause/remove always wins, response stops automation first, dry run writes nothing,
// weekend/window rolling, angle rotation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const f = await import('../server/fsbo-followup.js')

const nowIso = () => new Date().toISOString()
let seq = 0
function mkFsbo(fields = {}) {
  const tag = `${Date.now()}${++seq}`
  const cols = {
    first_name: 'Fsbo', last_name: 'Seller' + tag.replace(/\d/g, d => 'abcdefghij'[Number(d)]),
    type: 'seller', status: 'watch',
    phone: fields.phone === null ? null : (fields.phone || `(319) 5${tag.slice(-2)}-${tag.slice(-4)}`),
    address: fields.address || `${tag.slice(-3)} Oak St`,
    fsbo_status: fields.fsbo_status === null ? null : (fields.fsbo_status ?? 'Available'),
    fsbo_dom: fields.fsbo_dom ?? '20',
    ...Object.fromEntries(Object.entries(fields).filter(([k]) => !['phone', 'address', 'fsbo_status', 'fsbo_dom'].includes(k))),
  }
  const keys = Object.keys(cols)
  const r = db.run(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]))
  return db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
}
function addInbound(cid, body, daysAgo = 30) {
  db.run(`INSERT INTO communications (channel, direction, client_id, body, preview, thread_key, status, occurred_at)
          VALUES ('text','incoming',?,?,?,?, 'read', ?)`, [cid, body, body.slice(0, 100), `c${cid}_text`, new Date(Date.now() - daysAgo * 86400000).toISOString()])
}
function addHumanOut(cid, hoursAgo = 2) {
  db.run(`INSERT INTO communications (channel, direction, client_id, body, preview, thread_key, status, sent_by_type, occurred_at)
          VALUES ('text','outgoing',?,?,?,?, 'read', 'human', ?)`, [cid, 'hey', 'hey', `c${cid}_text`, new Date(Date.now() - hoursAgo * 3600000).toISOString()])
}
function enrollActive(cid, extra = {}) {
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, attempt_count, next_send_at, updated_at)
          VALUES (?, 'active', ?, ?, ?, ?)`, [cid, extra.enrolled_at || nowIso(), extra.attempt_count ?? 1, extra.next_send_at || nowIso(), nowIso()])
}
const evalIt = (id) => f.evaluateFsboCampaignEligibility(id)
db.setSetting('fsbo_followup_enabled', '0')
db.setSetting('fsbo_campaign_migrated', '1')   // legacy rows are production's concern, not this suite's

// ---- DOM threshold (Scenarios 1-3) ----
test('S1: DOM 13 is WAITING, never sending', async () => {
  const ev = await evalIt(mkFsbo({ fsbo_dom: '13' }).id)
  assert.equal(ev.decision, 'waiting')
  assert.equal(ev.reason_code, 'WAITING_FOR_DOM')
  assert.equal(ev.days_until, 1)
})
test('S2: DOM 14, Available, valid mobile, no blockers → eligible', async () => {
  const ev = await evalIt(mkFsbo({ fsbo_dom: '14' }).id)
  assert.equal(ev.decision, 'eligible', ev.reason_code)
})
test('S3: imported already at DOM 27 → eligible immediately (live listing DOM, not hub age)', async () => {
  const c = mkFsbo({ fsbo_dom: '27' })
  const ev = await evalIt(c.id)
  assert.equal(ev.decision, 'eligible', ev.reason_code)
  assert.equal(ev.dom, 27)
})

// ---- hard exclusions (Scenarios 4-7) ----
test('S4: Off Market is excluded', async () => {
  const ev = await evalIt(mkFsbo({ fsbo_status: 'Off Market', fsbo_dom: '30' }).id)
  assert.equal(ev.reason_code, 'FSBO_OFF_MARKET')
})
test('S5: prior meaningful seller response blocks cold auto-enrollment', async () => {
  const sold = mkFsbo({}); addInbound(sold.id, 'we already sold it thanks')
  assert.match((await evalIt(sold.id)).reason_code, /^PRIOR_SOLD/)
  const agent = mkFsbo({}); addInbound(agent.id, 'we listed with an agent last week')
  assert.match((await evalIt(agent.id)).reason_code, /^PRIOR_LISTED_WITH_AGENT/)
  const any = mkFsbo({}); addInbound(any.id, 'who is this?')
  assert.equal((await evalIt(any.id)).reason_code, 'PRIOR_RESPONSE')
})
test('S6: STOP is hard excluded', async () => {
  assert.equal((await evalIt(mkFsbo({ hub_text_opt_out: 1 }).id)).reason_code, 'STOP')
})
test('S7: landline / undeliverable is excluded from the SMS campaign', async () => {
  assert.equal((await evalIt(mkFsbo({ sms_undeliverable: 1 }).id)).reason_code, 'LANDLINE')
})
test('conflicting automation excluded: CX campaign + AI-managed leads', async () => {
  const cx = mkFsbo({})
  db.run("INSERT INTO cx_campaign (client_id, status, enrolled_at) VALUES (?, 'active', datetime('now'))", [cx.id])
  assert.equal((await evalIt(cx.id)).reason_code, 'CONFLICTING_CAMPAIGN')
  const aim = mkFsbo({})
  db.run('INSERT OR IGNORE INTO ai_lead_state (client_id, ai_managed) VALUES (?, 1)', [aim.id])
  assert.equal((await evalIt(aim.id)).reason_code, 'AI_MANAGED')
})

test('LLC / corporate owners are excluded; trusts and estates are not entities', async () => {
  assert.equal((await evalIt(mkFsbo({ first_name: 'Father Filtered', last_name: 'LLC' }).id)).reason_code, 'ENTITY_OWNER')
  assert.equal((await evalIt(mkFsbo({ first_name: 'Acme', last_name: 'Properties' }).id)).reason_code, 'ENTITY_OWNER')
  assert.equal((await evalIt(mkFsbo({ first_name: 'Mary Smith', last_name: 'Trust' }).id)).decision, 'eligible', 'trusts stay eligible')
})

// ---- deferrals (Scenario 8) ----
test('S8: recent human text defers, never talked over', async () => {
  const c = mkFsbo({}); addHumanOut(c.id, 2)
  const ev = await evalIt(c.id)
  assert.equal(ev.decision, 'deferred')
  assert.equal(ev.reason_code, 'RECENT_HUMAN_ACTIVITY')
})

// ---- manual controls (Scenarios 9, 20, 21) ----
test('S9: manual removal is durable — evaluator refuses forever', async () => {
  const c = mkFsbo({})
  enrollActive(c.id)
  f.removeFromFsboCampaign(c.id, 'tester', 'not a fit')
  assert.equal((await evalIt(c.id)).reason_code, 'MANUAL_REMOVAL')
})
test('S20: manual pause holds; sweeps cannot resume it', async () => {
  const c = mkFsbo({})
  enrollActive(c.id)
  f.pauseFsboCampaign(c.id, 'tester')
  assert.equal((await evalIt(c.id)).reason_code, 'MANUAL_PAUSE')
  const row = db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [c.id])
  assert.equal(row.status, 'paused'); assert.equal(row.next_send_at, null)
})
test('S21: resume re-checks eligibility — refused when the listing left Available', async () => {
  const c = mkFsbo({})
  enrollActive(c.id)
  f.pauseFsboCampaign(c.id, 'tester')
  db.run("UPDATE clients SET fsbo_status='Off Market' WHERE id=?", [c.id])
  const r = await f.resumeFsboCampaign(c.id, 'tester')
  assert.equal(r.ok, false)
  assert.match(r.reason, /FSBO_OFF_MARKET/)
  assert.equal(db.get('SELECT status FROM fsbo_followups WHERE client_id=?', [c.id]).status, 'paused')
  db.run("UPDATE clients SET fsbo_status='Available' WHERE id=?", [c.id])
  const r2 = await f.resumeFsboCampaign(c.id, 'tester')
  assert.equal(r2.ok, true)
  assert.equal(db.get('SELECT status FROM fsbo_followups WHERE client_id=?', [c.id]).status, 'active')
})

// ---- response stops automation FIRST (Scenario 10) ----
test('S10: inbound reply stops the campaign first, sets responded, creates the task', async () => {
  const c = mkFsbo({})
  enrollActive(c.id, { attempt_count: 1 })
  const handled = await f.handleFsboReply(c.id, 'Yes it is still available')
  assert.equal(handled, true)
  const row = db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [c.id])
  assert.equal(row.status, 'responded')
  assert.equal(row.next_send_at, null, 'no future automated send survives a reply')
  assert.ok(row.responded_at)
  assert.ok(db.get("SELECT id FROM fsbo_campaign_log WHERE client_id=? AND event='response'", [c.id]))
  assert.ok(db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'FSBO Response%'", [c.id]))
  // and the evaluator never re-enrolls a responder
  assert.equal((await evalIt(c.id)).reason_code, 'RESPONSE_RECEIVED')
  // a second message does not create a duplicate task
  await f.handleFsboReply(c.id, 'hello?')
  assert.equal(db.all("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'FSBO Response%'", [c.id]).length, 1)
})

// ---- property status changes (Scenario 11) ----
test('S11: active campaign stops when the listing goes Off Market (daily maintenance path)', async () => {
  const c = mkFsbo({})
  enrollActive(c.id)
  db.run("UPDATE clients SET fsbo_status='Off Market' WHERE id=?", [c.id])
  await f.fsboDailyMaintenance()   // sheet fetch fails offline; the stop loop still runs
  const row = db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [c.id])
  assert.equal(row.status, 'stopped')
  assert.match(row.stop_reason, /FSBO_OFF_MARKET/)
  assert.equal(row.next_send_at, null)
})

// ---- duplicate phone (Scenario 13) ----
test('S13: same number on two records → only one campaign', async () => {
  const phone = `(319) 777-${String(Date.now()).slice(-4)}`
  const a = mkFsbo({ phone })
  enrollActive(a.id)
  const b = mkFsbo({ phone })
  assert.equal((await evalIt(b.id)).reason_code, 'DUPLICATE_PHONE')
})

// ---- window math (Scenarios 15, 16) ----
test('S15: Saturday/after-hours threshold rolls to a valid weekday window', () => {
  // 2026-09-19 is a Saturday; 15:00 UTC = 10AM CT
  const sat = f.nextValidSlot(new Date('2026-09-19T15:00:00Z'))
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(sat)
  assert.equal(wd, 'Mon')
  // Wednesday 23:00 UTC = 6PM CT → Thursday morning
  const evening = f.nextValidSlot(new Date('2026-09-16T23:00:00Z'))
  assert.equal(f.inProactiveWindow(evening), true)
  const wd2 = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(evening)
  assert.equal(wd2, 'Thu')
})
test('weekly cadence lands on weekdays with 6-8 day jitter after attempt 3', () => {
  for (let i = 0; i < 25; i++) {
    const d = f.scheduleNextFsbo(3 + (i % 4), new Date('2026-09-16T15:00:00Z'))
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d)
    assert.ok(!['Sat', 'Sun'].includes(wd), 'never a weekend: ' + wd)
    const gap = (d - new Date('2026-09-16T15:00:00Z')) / 86400000
    assert.ok(gap >= 5 && gap <= 10, 'gap stays roughly weekly: ' + gap.toFixed(1))
  }
})

// ---- rotation (Scenario 17) ----
test('S17: angle rotation avoids the last 3 and respects DOM gates', () => {
  const c = mkFsbo({ fsbo_dom: '20' })
  for (const a of ['AVAILABILITY_RECHECK', 'STILL_FOR_SALE', 'CONTACT_PREFERENCE']) {
    db.run("INSERT INTO fsbo_campaign_log (client_id, event, angle) VALUES (?, 'sent', ?)", [c.id, a])
  }
  for (let i = 0; i < 20; i++) {
    const pick = f.pickFsboAngle(c.id, 20)
    assert.ok(!['AVAILABILITY_RECHECK', 'STILL_FOR_SALE', 'CONTACT_PREFERENCE'].includes(pick), 'no repeat within last 3: ' + pick)
    assert.notEqual(pick, 'LONG_HAUL', 'LONG_HAUL never speaks at DOM 20')
    assert.notEqual(pick, 'TIMING', 'TIMING gated to DOM 21+')
  }
})

// ---- identity safety ----
test('cold rotation texts say "the home at {address}", never "your home", no first names', () => {
  for (const [k, a] of Object.entries(f.FSBO_ANGLES)) {
    const t = a.text('123 Oak St')
    assert.ok(/the home at 123 Oak St/i.test(t), k + ' references the address')
    assert.ok(!/your home/i.test(t), k + ' never assumes ownership')
    assert.ok(!/\{|\}/.test(t), k + ' has no unrendered merge fields')
  }
})

// ---- dry run (Scenario 18) ----
test('S18: preview is a pure dry run — zero writes', async () => {
  const c = mkFsbo({ fsbo_dom: '25' })
  const before = db.get('SELECT COUNT(*) n FROM fsbo_followups').n
  const logBefore = db.get('SELECT COUNT(*) n FROM fsbo_campaign_log WHERE client_id=?', [c.id]).n
  const p = await f.previewFsboCampaign()
  assert.equal(p.dry_run, true)
  const mine = p.table.find(t => t.client_id === c.id)
  assert.ok(mine, 'new FSBO appears in the preview')
  assert.equal(mine.decision, 'eligible')
  assert.equal(db.get('SELECT COUNT(*) n FROM fsbo_followups').n, before, 'no enrollment rows written')
  assert.equal(db.get('SELECT COUNT(*) n FROM fsbo_campaign_log WHERE client_id=?', [c.id]).n, logBefore, 'no log rows written')
  assert.ok(!db.get('SELECT client_id FROM fsbo_followups WHERE client_id=?', [c.id]))
})

// ---- sweep enrollment idempotency (Scenario 19) ----
test('S19: the sweep auto-enrolls once; a second run never duplicates', async () => {
  const c = mkFsbo({ fsbo_dom: '30' })
  db.setSetting('fsbo_followup_enabled', '1')
  try {
    await f.runFsboFollowups()
    const row1 = db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [c.id])
    assert.ok(row1, 'enrolled by the sweep')
    assert.equal(row1.status === 'active' || row1.status === 'stopped', true)
    const enrolledLogs = () => db.all("SELECT id FROM fsbo_campaign_log WHERE client_id=? AND event='enrolled'", [c.id]).length
    assert.equal(enrolledLogs(), 1)
    await f.runFsboFollowups()
    assert.equal(enrolledLogs(), 1, 'second sweep does not re-enroll')
  } finally { db.setSetting('fsbo_followup_enabled', '0') }
})

test('master switch OFF = sweep is a no-op', async () => {
  db.setSetting('fsbo_followup_enabled', '0')
  assert.equal((await f.runFsboFollowups()).skipped, 'disabled')
})
