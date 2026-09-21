// Fix It or Skip It seller campaign (John, 2026-09-19) — the non-negotiables:
// both Meta campaign names map to ONE family while exact attribution survives;
// form answers become structured, normalized fields; the first text is
// CONTEXTUAL (never generic); hot statuses never re-enter automation; a prior
// buyer nurture pauses on seller intent; sequence cadence is Day 0/1/3/7;
// events fire under the spec names; intake is idempotent on email retries.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const m = await import('../server/seller-campaign.js')
m.initSellerCampaign()

const seeded = { clients: [] }
function mkClient(over = {}) {
  const cols = {
    first_name: over.first || 'Sella', last_name: 'Test' + Date.now() + Math.floor(Math.random() * 1e6),
    type: 'seller', status: over.status || 'new', phone: over.phone === null ? null : '(319) 555-' + String(Math.floor(Math.random() * 9000) + 1000),
    tags: '[]', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  const keys = Object.keys(cols)
  const r = db.run(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]))
  seeded.clients.push(r.lastInsertRowid)
  return r.lastInsertRowid
}

const RAW = `User provided phone number: +13195551234
What is your time frame to sell?: 3-6_months
What are you thinking about updating before selling?: Kitchen
When would generally be easiest for a quick 15-minute walkthrough?: Weekday afternoons
Property address: 123 Main St, Cedar Rapids
Form: SELLER | Fix It or Skip It`

test('both campaign names are the same family; matcher works', () => {
  assert.ok(m.isSellerFamily('SELLER | Fix It or Skip It'))
  assert.ok(m.isSellerFamily('Kitchen creative | Fix It or Skip It Walkthrough'))
  assert.ok(!m.isSellerFamily('510 Broadway Springville'))
})

test('answer mining normalizes to canonical values', () => {
  const a = m.mineSellerAnswers(RAW)
  assert.equal(a.timeframe, '3-6 months')
  assert.equal(a.improvement, 'Kitchen')
  assert.equal(a.availability, 'Weekday afternoons')
  assert.equal(a.property, '123 Main St, Cedar Rapids')
  assert.equal(m.mineSellerAnswers('time frame to sell?: within_3_months').timeframe, 'Within 3 months')
  assert.equal(m.mineSellerAnswers('updating before selling?: not_sure_yet').improvement, 'Not sure yet')
})

test('priority ranking follows the spec', () => {
  assert.equal(m.priorityForTimeframe('Within 3 months'), 'PRIORITY 1')
  assert.equal(m.priorityForTimeframe('3-6 months'), 'PRIORITY 2')
  assert.equal(m.priorityForTimeframe('6-12 months'), 'PRIORITY 3')
  assert.equal(m.priorityForTimeframe('More than a year'), 'NURTURE')
  assert.equal(m.priorityForTimeframe('Just exploring'), 'EARLY')
})

test("first text is contextual per improvement answer — John's 09-19 copy, never generic", () => {
  assert.equal(m.sellerOpener('Sarah', 'Kitchen'),
    "Hi Sarah, it's John with Matt Smith Team at RE/MAX. I saw your Fix It or Skip It request and that you're considering some kitchen updates. Are you already planning to do the work, or are you mainly trying to figure out whether it's worth doing before you sell?")
  assert.ok(m.sellerOpener('Pat', 'Bathrooms').includes('bathroom updates'))
  assert.ok(m.sellerOpener('Pat', 'Flooring').includes('Are you leaning toward replacing it'))
  assert.ok(m.sellerOpener('Pat', 'Paint').includes('repainting most of the home'))
  assert.ok(m.sellerOpener('Pat', 'Exterior / landscaping').includes('exterior or landscaping work'))
  assert.ok(m.sellerOpener('Pat', 'Several things').includes('started making a list'))
  assert.ok(m.sellerOpener('Pat', 'Not sure yet').includes('second opinion'))
  // MISSING answer gets its own copy (claims nothing, asks the fix-or-leave question)
  assert.ok(m.sellerOpener('Pat', null).includes('unsure whether you should fix or leave alone'))
  for (const imp of ['Kitchen', 'Bathrooms', 'Paint', 'Exterior / landscaping', 'Several things', 'Not sure yet', null]) {
    const t = m.sellerOpener('Pat', imp)
    assert.ok(t.startsWith("Hi Pat, it's John with Matt Smith Team at RE/MAX."))
    assert.ok(!/thanks for your interest/i.test(t) && !/—|–/.test(t))
  }
})

test('send windows: first touch 7 days a week, follow-ups weekdays; 9AM-7PM CT', () => {
  const satNoon = new Date('2027-06-19T17:00:00Z')   // Sat 12:00 CT
  assert.ok(m.inSellerWindow(satNoon, { firstTouch: true }))
  assert.ok(!m.inSellerWindow(satNoon))              // follow-ups: weekend blocked
  const monEvening = new Date('2027-06-21T23:30:00Z')  // Mon 6:30 PM CT: inside 9-7
  assert.ok(m.inSellerWindow(monEvening))
  const monNight = new Date('2027-06-22T00:30:00Z')    // Mon 7:30 PM CT: after hours
  assert.ok(!m.inSellerWindow(monNight, { firstTouch: true }))
  // Sat follow-up slot rolls PAST the weekend to Monday
  const rolled = m.nextSellerSlot(satNoon)
  const wd = rolled.toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short' })
  assert.equal(wd, 'Mon')
  // Sat FIRST TOUCH stays Saturday
  assert.equal(m.nextSellerSlot(satNoon, { firstTouch: true }).toISOString(), satNoon.toISOString())
})

test('new lead: fields stored, attribution exact, task + events, sequence enrolled', () => {
  const cid = mkClient()
  const r = m.handleSellerLead({ client_id: cid, campaign_raw: 'Kitchen creative | Fix It or Skip It Walkthrough', raw_text: RAW, isExisting: false })
  assert.equal(r.priority, 'PRIORITY 2')
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  assert.equal(c.seller_timeframe, '3-6 months')
  assert.equal(c.seller_improvement, 'Kitchen')
  assert.ok(c.tags.includes('Fix It or Skip It') && c.tags.includes('Meta Lead'))
  const sub = db.get('SELECT * FROM meta_seller_leads WHERE client_id=?', [cid])
  assert.equal(sub.campaign_raw, 'Kitchen creative | Fix It or Skip It Walkthrough')   // exact, not the family
  assert.equal(sub.family, 'Fix It or Skip It')
  assert.ok(db.get("SELECT id FROM automation_events WHERE event_type='meta_seller_lead.received' AND client_id=?", [cid]))
  assert.ok(db.get("SELECT id FROM tasks WHERE related_id=? AND title LIKE 'Review Fix It or Skip It%'", [cid]))
  const seq = db.get('SELECT * FROM fb_seller_followups WHERE client_id=?', [cid])
  assert.equal(seq.status, 'active')
  assert.equal(seq.next_step, 0)
  // idempotent on email retry: same campaign same day = one submission row
  m.handleSellerLead({ client_id: cid, campaign_raw: 'Kitchen creative | Fix It or Skip It Walkthrough', raw_text: RAW, isExisting: false })
  assert.equal(db.get('SELECT COUNT(*) c FROM meta_seller_leads WHERE client_id=?', [cid]).c, 1)
})

test('hot statuses (active/prime/pending/closed) get NO automation, task instead', () => {
  for (const status of ['active', 'prime', 'pending', 'closed']) {
    const cid = mkClient({ status })
    const r = m.handleSellerLead({ client_id: cid, campaign_raw: 'SELLER | Fix It or Skip It', raw_text: RAW, isExisting: true })
    assert.equal(r.automated, false)
    assert.equal(db.get('SELECT COUNT(*) c FROM fb_seller_followups WHERE client_id=?', [cid]).c, 0)
    assert.equal(db.get('SELECT status FROM clients WHERE id=?', [cid]).status, status)   // status untouched
    assert.ok(db.get("SELECT id FROM tasks WHERE related_id=? AND title LIKE 'Seller intent%'", [cid]))
  }
})

test('an active buyer listing campaign pauses on seller intent (conflict rule)', () => {
  const cid = mkClient()
  db.run("INSERT INTO fb_listing_campaigns (client_id, listing_label, status, day0_at, next_step, next_send_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [cid, 'X', 'active', new Date().toISOString(), 0, new Date().toISOString(), new Date().toISOString()])
  m.handleSellerLead({ client_id: cid, campaign_raw: 'SELLER | Fix It or Skip It', raw_text: RAW, isExisting: true })
  assert.equal(db.get('SELECT status FROM fb_listing_campaigns WHERE client_id=?', [cid]).status, 'paused')
})

test('cleanup', () => {
  for (const id of seeded.clients) {
    db.run('DELETE FROM clients WHERE id=?', [id])
    db.run('DELETE FROM meta_seller_leads WHERE client_id=?', [id])
    db.run('DELETE FROM fb_seller_followups WHERE client_id=?', [id])
    db.run('DELETE FROM fb_listing_campaigns WHERE client_id=?', [id])
    db.run('DELETE FROM automation_events WHERE client_id=?', [id])
    db.run('DELETE FROM tasks WHERE related_id=? AND related_type=?', [id, 'client'])
    db.run("DELETE FROM activity_log WHERE entity_type='client' AND entity_id=?", [id])
  }
})

test('general buyer AI can never enroll a seller-campaign lead', async () => {
  const eng = await import('../server/ai-enrollment.js')
  const cid = mkClient()
  db.run('UPDATE clients SET first_name=?, last_name=?, source=? WHERE id=?', ['Luis', 'Guardtest' + Date.now(), 'Facebook Listing Ad', cid])
  db.run('INSERT INTO fb_seller_followups (client_id, status, day0_at, next_step, updated_at) VALUES (?,?,?,?,?)', [cid, 'active', new Date().toISOString(), 0, new Date().toISOString()])
  const ev = eng.evaluateAiEnrollmentEligibility(cid)
  assert.equal(ev.decision, 'excluded')
  assert.equal(ev.reason_code, 'SELLER_CAMPAIGN')
  // tag alone (hot-status existing contact with no sequence row) also excludes
  const cid2 = mkClient()
  db.run(`UPDATE clients SET first_name='Ana', last_name=?, source='Facebook Listing Ad', tags=? WHERE id=?`, ['Guardtag' + Date.now(), JSON.stringify(['FB Seller Ad: SELLER | Fix It or Skip It']), cid2])
  const ev2 = eng.evaluateAiEnrollmentEligibility(cid2)
  assert.equal(ev2.reason_code, 'SELLER_CAMPAIGN')
})

test('ALL FB-ad leads are excluded from general AI (dedicated campaigns own them)', async () => {
  const eng = await import('../server/ai-enrollment.js')
  const cid = mkClient()
  db.run(`UPDATE clients SET first_name='Rich', last_name=?, source='Facebook Listing Ad', tags=? WHERE id=?`,
    ['Fbguard' + Date.now(), JSON.stringify(['FB Ad: 510 Broadway Springville']), cid])
  const ev = eng.evaluateAiEnrollmentEligibility(cid)
  assert.equal(ev.reason_code, 'FB_CAMPAIGN')
  // the FB intake itself may still use the rails for the Day-0 opener
  const ev2 = eng.evaluateAiEnrollmentEligibility(cid, { fbIntake: true })
  assert.notEqual(ev2.reason_code, 'FB_CAMPAIGN')
  // release sweep: managed FB lead with no pending opener/email gets let go
  db.run(`INSERT INTO ai_lead_state (client_id, ai_enabled, ai_managed, ai_state) VALUES (?,?,?,?)
          ON CONFLICT (client_id) DO UPDATE SET ai_enabled=1, ai_managed=1, ai_state='AI_WAITING_FOR_REPLY'`, [cid, 1, 1, 'AI_WAITING_FOR_REPLY'])
  const rel = eng.releaseFbAdLeadsFromGeneralAi()
  assert.ok(rel.ids.includes(cid))
  const st = db.get('SELECT ai_managed, ai_enabled, ai_state FROM ai_lead_state WHERE client_id=?', [cid])
  assert.equal(st.ai_managed, 0)
  assert.equal(st.ai_state, 'AI_DISABLED')
  db.run('DELETE FROM ai_lead_state WHERE client_id=?', [cid])
})

// ---- 2026-09-21 regression: the Luis loop. The post-send UPDATE had 5 placeholders
// and 4 params, threw AFTER the SMS went out, and the Day-0 opener re-sent every 3
// hours for 3 days. advanceSellerStep must advance cleanly, and the sweep must treat
// an already-sent identical body as sent (advance, never re-text).
test('advanceSellerStep advances the step and records last_sent_at (param-count regression)', () => {
  const cid = mkClient()
  db.run(`UPDATE clients SET seller_timeframe='Within 3 months', seller_improvement='Several things' WHERE id=?`, [cid])
  const day0 = new Date(Date.now() - 60000).toISOString()
  db.run(`INSERT INTO fb_seller_followups (client_id, status, day0_at, next_step, next_send_at, updated_at)
          VALUES (?,?,?,?,?,?)`, [cid, 'active', day0, 0, day0, day0])
  const row = db.get('SELECT * FROM fb_seller_followups WHERE client_id=?', [cid])
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const r = m.advanceSellerStep(row, c)
  assert.equal(r, 'advanced')
  const after = db.get('SELECT * FROM fb_seller_followups WHERE client_id=?', [cid])
  assert.equal(after.next_step, 1, 'step advanced')
  assert.ok(after.last_sent_at, 'last_sent_at recorded')
  assert.ok(after.next_send_at, 'day-1 slot scheduled')
  // final step -> nurture, never loops
  db.run('UPDATE fb_seller_followups SET next_step=3 WHERE client_id=?', [cid])
  const row3 = db.get('SELECT * FROM fb_seller_followups WHERE client_id=?', [cid])
  assert.equal(m.advanceSellerStep(row3, c), 'nurtured')
  assert.equal(db.get('SELECT status FROM fb_seller_followups WHERE client_id=?', [cid]).status, 'nurture')
})

test('sweep self-heal: an already-sent identical body advances the step without re-sending', async () => {
  const cid = mkClient()
  db.run(`UPDATE clients SET first_name='Luis', seller_timeframe='Within 3 months', seller_improvement='Several things' WHERE id=?`, [cid])
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const body = m.sellerOpener(c.first_name, c.seller_improvement)
  // the Day-0 text already exists on the thread (sent by a tick that then crashed)
  db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, to_addr, preview, body, thread_key, status, occurred_at)
          VALUES ('text','outgoing',?,?,?,?,?,?, 'read', ?)`, [cid, 'Luis', c.phone, body.slice(0, 160), body, `c${cid}_text`, new Date().toISOString()])
  const day0 = new Date(Date.now() - 3600000).toISOString()
  db.run(`INSERT INTO fb_seller_followups (client_id, status, day0_at, next_step, next_send_at, updated_at)
          VALUES (?,?,?,?,?,?)`, [cid, 'active', day0, 0, day0, day0])
  const before = db.get('SELECT COUNT(*) n FROM communications WHERE client_id=?', [cid]).n
  await m.runSellerFollowups()
  const after = db.get('SELECT * FROM fb_seller_followups WHERE client_id=?', [cid])
  const comms = db.get('SELECT COUNT(*) n FROM communications WHERE client_id=?', [cid]).n
  assert.equal(comms, before, 'NO duplicate text sent')
  if (m.inSellerWindow(new Date(), { firstTouch: true })) {
    assert.equal(after.next_step, 1, 'step advanced as if sent')
  } else {
    // Outside the 9AM-7PM CT window the sweep defers before reaching the self-heal;
    // the no-duplicate-send assertion above is the invariant that must always hold.
    assert.equal(after.next_step, 0)
  }
  db.run('DELETE FROM fb_seller_followups WHERE client_id=?', [cid])
})

// ---- Fix It or Skip It 12-month EMAIL drip (John, 2026-09-21) ----
test('{{intro}} merge token rotates Hi / Hello / time-of-day', async () => {
  const em = await import('../server/routes/email.js')
  db.setSetting('email_intro_rot', '0')
  const cid = mkClient()
  db.run("UPDATE clients SET email='intro@example.com' WHERE id=?", [cid])
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const out = []
  for (let i = 0; i < 3; i++) out.push(em.previewSequenceEmail(c, { subject: 's', body: '{{intro}} {{first_name}},' }).body)
  assert.ok(out[0].startsWith('Hi '), 'first is Hi: ' + out[0])
  assert.ok(out[1].startsWith('Hello '), 'second is Hello: ' + out[1])
  assert.ok(out[2].startsWith('Good '), 'third is time-of-day: ' + out[2])
})

test('pause_on_reply drip: an inbound message pauses before the send and creates a task', async () => {
  const drips = await import('../server/routes/drips.js')
  const dr = db.run("INSERT INTO drip_campaigns (name, steps, pause_on_reply) VALUES ('PauseTest Drip', ?, 1)",
    [JSON.stringify([{ subject: 'T', body: 'B {{first_name}}', delay_days: 0, send_time: '00:00', send_time_end: '23:59' }])])
  const cid = mkClient()
  db.run("UPDATE clients SET email='pausetest@example.com', first_name='Pau' WHERE id=?", [cid])
  const eid = drips.enrollInDrip(dr.lastInsertRowid, cid, { source: 'test' })
  assert.ok(eid, 'enrolled')
  // they reply AFTER enrolling…
  db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, preview, body, thread_key, status, occurred_at)
          VALUES ('text','incoming',?,?,?,?,?, 'read', ?)`, [cid, 'Pau', 'not selling', 'not selling', `c${cid}_text`, new Date(Date.now() + 1500).toISOString()])
  db.run("UPDATE drip_enrollments SET next_run_at=? WHERE id=?", [new Date(Date.now() - 1000).toISOString(), eid])
  await drips.dripTick()
  const enr = db.get('SELECT * FROM drip_enrollments WHERE id=?', [eid])
  assert.equal(enr.status, 'paused', 'drip paused on reply')
  assert.equal(db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND direction='outgoing' AND channel='email'", [cid]).n, 0, 'no email sent')
  assert.ok(db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'Replied during%'", [cid]), 'human follow-up task created')
  db.run('DELETE FROM drip_campaigns WHERE id=?', [dr.lastInsertRowid])
  db.run('DELETE FROM drip_enrollments WHERE id=?', [eid])
})

test('Fix It or Skip It intake auto-enrolls the 12-month email drip (prompt first email)', async () => {
  const dr = db.run("INSERT INTO drip_campaigns (name, steps, pause_on_reply) VALUES ('Fix It or Skip It (TEST) Seller Email', ?, 1)",
    [JSON.stringify([{ subject: 'E1', body: 'B', delay_days: 0, send_time: '08:00', send_time_end: '20:00' }, { subject: 'E2', body: 'B2', delay_days: 2, send_time: '09:00', send_time_end: '11:30' }])])
  const cid = mkClient()
  db.run("UPDATE clients SET email='fixitdrip@example.com' WHERE id=?", [cid])
  m.handleSellerLead({ client_id: cid, campaign_raw: 'SELLER | Fix It or Skip It', raw_text: RAW })
  await new Promise(r => setTimeout(r, 300))   // enrollment goes through a dynamic import
  const enr = db.get("SELECT * FROM drip_enrollments WHERE client_id=? AND drip_id=?", [cid, dr.lastInsertRowid])
  assert.ok(enr, 'enrolled into the email drip')
  assert.equal(enr.source, 'fix_it_or_skip_it')
  assert.ok(new Date(enr.next_run_at).getTime() - Date.now() < 6 * 60000, 'first email scheduled promptly (~5 min)')
  db.run('DELETE FROM drip_campaigns WHERE id=?', [dr.lastInsertRowid])
  db.run('DELETE FROM drip_enrollments WHERE id=?', [enr.id])
})
