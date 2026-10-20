// FSBO AUTOMATIC TEXT CAMPAIGN — the spec's non-negotiables: DOM-14 threshold on
// LIVE listing DOM (imported-above-threshold qualifies immediately), hard exclusions
// (Off Market / prior response / STOP / landline), deferrals (recent human), manual
// pause/remove always wins, response stops automation first, dry run writes nothing,
// weekend/window rolling, angle rotation.
import { test , beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()

// The Tasks tab is the team's own (John, 2026-10-05): automations only write a task when
// automation_tasks_enabled is on. Set per test, because suites share one database and
// others toggle this same setting.
beforeEach(() => db.setSetting('automation_tasks_enabled', '1'))

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
  // Changed 2026-10-20: an ORDINARY prior reply no longer blocks enrollment. Only the
  // disqualifying verdicts above do. John: "even when we get a response the campaign
  // should still be on... only turned off if it was manually done."
  const any = mkFsbo({}); addInbound(any.id, 'who is this?')
  assert.notEqual((await evalIt(any.id)).reason_code, 'PRIOR_RESPONSE',
    'a seller asking who we are is engagement, not a disqualification')
})
test('S6: STOP is hard excluded', async () => {
  assert.equal((await evalIt(mkFsbo({ hub_text_opt_out: 1 }).id)).reason_code, 'STOP')
})
test('S7: landline / undeliverable is excluded from the SMS campaign', async () => {
  assert.equal((await evalIt(mkFsbo({ sms_undeliverable: 1 }).id)).reason_code, 'LANDLINE')
})
test('conflicting automation excluded: CX campaign + AI-managed leads', async () => {
  const cx = mkFsbo({})
  db.run("INSERT INTO cx_campaign (client_id, status, enrolled_at, next_send_at) VALUES (?, 'active', datetime('now'), '2099-01-01T00:00:00.000Z')", [cx.id])
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
// REWRITTEN 2026-10-20. This used to assert that a reply STOPPED the campaign. John
// reversed that rule: "even when we get a response the campaign should still be on...
// only turned off if it was manually done." What survives is everything else - the reply
// is recorded, logged, and a person is told to answer it.
test('S10: an inbound reply is recorded and tasked, and the campaign keeps running', async () => {
  const c = mkFsbo({})
  enrollActive(c.id, { attempt_count: 1 })
  const before = db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at
  const handled = await f.handleFsboReply(c.id, 'Yes it is still available')
  assert.equal(handled, true)
  const row = db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [c.id])
  assert.equal(row.status, 'active', 'the campaign continues')
  assert.equal(row.next_send_at, before, 'the schedule is untouched')
  assert.equal(row.replied, 1)
  assert.ok(row.responded_at)
  assert.ok(db.get("SELECT id FROM fsbo_campaign_log WHERE client_id=? AND event='response'", [c.id]))
  assert.ok(db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'FSBO Response%'", [c.id]))
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
// John, 2026-10-20: Text 2 moves to DOM 30, the analysis pair is gone, and the two touches
// after Text 2 are 15 days apart before the 30-day rhythm takes over.
const FROM = new Date('2026-09-16T15:00:00Z')
const gapOf = (d) => (d - FROM) / 86400000

test('Text 2 lands on DOM 30 for a seller who enrolled at the threshold', () => {
  // DOM 14 at Text 1 -> 16 days later is DOM 30.
  const gap = gapOf(f.scheduleNextFsbo(1, FROM, 14))
  assert.ok(gap >= 15 && gap <= 18, 'about 16 days: ' + gap.toFixed(1))
})

test('Text 2 is closer when the seller enrolled later in the listing', () => {
  // DOM 20 at Text 1 -> DOM 30 is 10 days out, but the 15-day floor applies.
  const gap = gapOf(f.scheduleNextFsbo(1, FROM, 20))
  assert.ok(gap >= 14 && gap <= 17, 'floored at 15 days: ' + gap.toFixed(1))
})

test('a seller already PAST DOM 30 never gets Text 2 back-to-back with Text 1', () => {
  // This is the case that matters: on the day the rule changed, 26 of 40 eligible sellers
  // were past DOM 30 and several were past DOM 300. Taken literally their Text 2 was due
  // in the PAST, which would have sent it in the same sweep as Text 1.
  for (const dom of [30, 31, 58, 189, 843]) {
    const gap = gapOf(f.scheduleNextFsbo(1, FROM, dom))
    // 14 rather than 15: a slot landing on a Saturday can roll back a day.
    assert.ok(gap >= 14, `DOM ${dom} must still wait about 15 days, got ` + gap.toFixed(1))
  }
})

test('an unknown DOM falls back to the threshold assumption, never to zero', () => {
  for (const bad of [null, undefined, '', 0, NaN, 'abc']) {
    const gap = gapOf(f.scheduleNextFsbo(1, FROM, bad))
    assert.ok(gap >= 15, `DOM ${JSON.stringify(bad)} gave ` + gap.toFixed(1))
  }
})

test('the two touches after Text 2 are 15 days apart', () => {
  for (const attempt of [2, 3]) {
    const gap = gapOf(f.scheduleNextFsbo(attempt, FROM))
    assert.ok(gap >= 14 && gap <= 17, `attempt ${attempt} gap ~15d: ` + gap.toFixed(1))
  }
})

test('cadence: from attempt 4 onward it is ~30 days, always on weekdays', () => {
  for (let i = 0; i < 25; i++) {
    const d = f.scheduleNextFsbo(4 + (i % 4), new Date('2026-09-16T15:00:00Z'))
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d)
    assert.ok(!['Sat', 'Sun'].includes(wd), 'never a weekend: ' + wd)
    const gap = (d - new Date('2026-09-16T15:00:00Z')) / 86400000
    // 30 to 33 days, plus up to 2 for a weekend roll (John, 2026-10-15: "after 30 days
    // should reach out to ask if it's still available"). Was 40-47.
    assert.ok(gap >= 28 && gap <= 36, 'long-term gap is about 30 days: ' + gap.toFixed(1))
  }
})

// ---- rotation (Scenario 17) ----
test('S17: angle rotation avoids the last 3; bank is availability-only', () => {
  const c = mkFsbo({ fsbo_dom: '20' })
  for (const a of ['AVAILABILITY_RECHECK', 'STILL_FOR_SALE', 'CONTACT_PREFERENCE']) {
    db.run("INSERT INTO fsbo_campaign_log (client_id, event, angle) VALUES (?, 'sent', ?)", [c.id, a])
  }
  for (let i = 0; i < 20; i++) {
    const pick = f.pickFsboAngle(c.id, 20)
    assert.equal(pick, 'GENERAL_CHECKIN', 'only unused angle remains: ' + pick)
  }
  assert.deepEqual(Object.keys(f.FSBO_ANGLES).sort(), ['AVAILABILITY_RECHECK', 'CONTACT_PREFERENCE', 'GENERAL_CHECKIN', 'STILL_FOR_SALE'], 'availability-focused bank only')
})

test('NO AUTO REPLY: an inbound response sends nothing back automatically', async () => {
  db.setSetting('fsbo_followup_enabled', '1')   // even with the campaign ON
  try {
    const c = mkFsbo({})
    enrollActive(c.id, { attempt_count: 1 })
    const before = db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND direction='outgoing'", [c.id]).n
    await f.handleFsboReply(c.id, 'Yes still available, are you interested?')
    assert.equal(db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND direction='outgoing'", [c.id]).n, before, 'zero automated outgoing messages')
    // the campaign keeps running (2026-10-20) - what matters here is that nothing was SENT
    assert.equal(db.get('SELECT status FROM fsbo_followups WHERE client_id=?', [c.id]).status, 'active')
  } finally { db.setSetting('fsbo_followup_enabled', '0') }
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

// ── retired copy ─────────────────────────────────────────────────────────────────────
// John, 2026-10-05: remove the "we've sold over 2,000 homes... 35+ years... the first 2
// weeks on the market are usually the most critical" credibility pitch from Text 3. Git
// shows it was never removed before, only reworded (bf27950, "14 days" -> "2 weeks").
test('the 2,000-homes credibility pitch can never be sent again', () => {
  const src = fs.readFileSync(new URL('../server/fsbo-followup.js', import.meta.url), 'utf8')
  assert.ok(!/sold over 2,000 homes/.test(src), 'the retired line is gone')
  assert.ok(!/first 2 weeks on the market/.test(src))
  assert.ok(!/35\+ years/.test(src), 'no reworded survivor either')
})

test('the market-analysis pair is gone, and nothing still tries to send it', () => {
  // John, 2026-10-20: "remove the 2 part text 3". Its opening credibility block went on
  // 2026-10-05, which left the survivor starting "At this point," - a reference to weeks
  // that no longer appeared anywhere. The whole step is removed rather than reworded.
  const src = fs.readFileSync(new URL('../server/fsbo-followup.js', import.meta.url), 'utf8')
  assert.ok(!/const MSG_ANALYSIS = \[/.test(src), 'the message pair is gone')
  assert.ok(!/attempt === 3/.test(src), 'no step 3 branch remains')
  assert.ok(!/At this point, you might be thinking/.test(src), 'the dangling opener is gone')
  assert.ok(!/put together an analysis of your home/.test(src))
  assert.ok(!/sendFsboSeq\s*\(/.test(src), 'the two-text sender went with it')
})

test('attempt 3 now draws from the plain availability rotation', () => {
  const src = fs.readFileSync(new URL('../server/fsbo-followup.js', import.meta.url), 'utf8')
  // attempt 1 and 2 are the two named messages; everything after falls to pickFsboAngle.
  assert.match(src, /else if \(attempt === 2\)[\s\S]{0,200}else \{ angle = pickFsboAngle/)
})

/* ---------- re-dating rows left on an old cadence (John, 2026-10-20) ---------- */

// scheduleNextFsbo only sets the gap AFTER a text sends, so changing the cadence leaves
// every waiting row on the old clock. Three real sellers had Text 2 booked on the old +7
// rule and would have been texted at DOM 20 instead of DOM 30.
function enrolledWithSchedule(domValue, attempts, lastSentDaysAgo, nextInDays) {
  const c = mkFsbo({ fsbo_dom: String(domValue) })
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, attempt_count, last_sent_at, next_send_at, updated_at)
          VALUES (?, 'active', ?, ?, ?, ?, ?)`,
    [c.id, nowIso(), attempts,
      new Date(Date.now() - lastSentDaysAgo * 86400000).toISOString(),
      new Date(Date.now() + nextInDays * 86400000).toISOString(), nowIso()])
  return c
}

test('re-sync is DRY by default and writes nothing', async () => {
  const c = enrolledWithSchedule(18, 1, 5, 2)        // Text 2 booked 2 days out, old +7 rule
  const before = db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at
  const r = await f.resyncFsboSchedule({ clientIds: [c.id] })
  assert.equal(r.dry, true)
  const after = db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at
  assert.equal(after, before, 'a dry run must not move the date')
})

test('it pushes Text 2 out to DOM 30 instead of the old +7', async () => {
  const c = enrolledWithSchedule(18, 1, 5, 2)
  const r = await f.resyncFsboSchedule({ clientIds: [c.id], dry: false })
  assert.equal(r.rescheduled, 1, JSON.stringify(r.rows))
  const row = r.rows[0]
  assert.ok(row.delta_days > 0, 'moved later, not earlier: ' + row.delta_days)
  const after = db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at
  assert.equal(after, row.proposed)
})

test('it refuses to pull a text EARLIER unless told to', async () => {
  // attempt 3 under the old rule was given ~30 days; the new rule says 15. Shortening a
  // gap means texting a real seller sooner than promised, so it needs saying out loud.
  const c = enrolledWithSchedule(60, 3, 1, 30)
  const dryR = await f.resyncFsboSchedule({ clientIds: [c.id] })
  assert.equal(dryR.skipped_earlier, 1, JSON.stringify(dryR.rows))
  assert.equal(dryR.rescheduled, 0)
  const before = db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at
  await f.resyncFsboSchedule({ clientIds: [c.id], dry: false })
  assert.equal(db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at, before,
    'still untouched without allow_earlier')
  const r2 = await f.resyncFsboSchedule({ clientIds: [c.id], dry: false, allowEarlier: true })
  assert.equal(r2.rescheduled, 1)
  assert.ok(r2.rows[0].delta_days < 0)
})

test('it only touches the leads it was given', async () => {
  const mine = enrolledWithSchedule(18, 1, 5, 2)
  const other = enrolledWithSchedule(18, 1, 5, 2)
  const untouched = db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [other.id]).next_send_at
  await f.resyncFsboSchedule({ clientIds: [mine.id], dry: false })
  assert.equal(db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [other.id]).next_send_at, untouched)
})

test('it measures from the last text sent, not from today', async () => {
  // Same lead, same DOM, but the last text went out 10 days ago rather than 1. The new
  // date must hang off that text, or a re-sync silently restarts everyone's clock.
  const recent = enrolledWithSchedule(18, 2, 1, 40)
  const older = enrolledWithSchedule(18, 2, 10, 40)
  const a = await f.resyncFsboSchedule({ clientIds: [recent.id], allowEarlier: true })
  const b = await f.resyncFsboSchedule({ clientIds: [older.id], allowEarlier: true })
  assert.ok(new Date(a.rows[0].proposed) > new Date(b.rows[0].proposed),
    'the lead texted longer ago is due sooner')
})

test('a paused or removed lead is never re-dated back into the queue', async () => {
  const c = enrolledWithSchedule(18, 1, 5, 2)
  db.run("UPDATE fsbo_followups SET status='removed' WHERE client_id=?", [c.id])
  const r = await f.resyncFsboSchedule({ clientIds: [c.id], dry: false, allowEarlier: true })
  assert.equal(r.considered, 0, 'only active rows are considered')
  assert.equal(db.get('SELECT status FROM fsbo_followups WHERE client_id=?', [c.id]).status, 'removed')
})

test('a lead still waiting on Text 1 is never re-dated', async () => {
  // The first dry run against production caught this: seven sellers with attempt_count 0
  // were due Text 1 the next morning, and the re-sync wanted to push them out a fortnight,
  // because scheduleNextFsbo(0) falls through to the 15-day branch. The cadence governs the
  // gap BETWEEN texts; enrolment dates the first one.
  const c = mkFsbo({ fsbo_dom: '57' })
  const tomorrow = new Date(Date.now() + 86400000).toISOString()
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, attempt_count, next_send_at, updated_at)
          VALUES (?, 'active', ?, 0, ?, ?)`, [c.id, nowIso(), tomorrow, nowIso()])
  const r = await f.resyncFsboSchedule({ clientIds: [c.id], dry: false, allowEarlier: true })
  assert.equal(r.skipped_not_yet_texted, 1, JSON.stringify(r.rows))
  assert.equal(r.rescheduled, 0)
  assert.equal(db.get('SELECT next_send_at FROM fsbo_followups WHERE client_id=?', [c.id]).next_send_at, tomorrow,
    'Text 1 must stay exactly where enrolment put it')
})
