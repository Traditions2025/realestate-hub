// Cancelled/Expired Connection Campaign — the protections the spec demands:
// history suppression, off-market age language, weekend shifting, manual-contact
// suppression, MLS stops, response-stops-everything, AI-never-replies, angle rotation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const cx = await import('../server/cx-connect.js')

const nowIso = () => new Date().toISOString()
let seq = 0
function mkClient(fields = {}) {
  const tag = `${Date.now()}${++seq}`
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, phone, address, city, state, zip, status, mls_status, off_market_date)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [fields.first_name || 'Test', fields.last_name || 'CxSeller' + tag, 'seller', fields.phone === null ? null : (fields.phone || '(319) 555-' + tag.slice(-4)),
      fields.address || '123 Elm St', 'Cedar Rapids', 'IA', '52403', fields.status || 'new', fields.mls_status ?? 'Expired', fields.off_market_date ?? '2026-08-01'])
  return db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
}
function addInbound(cid, body, daysAgo = 10) {
  const at = new Date(Date.now() - daysAgo * 86400000).toISOString()
  db.run(`INSERT INTO communications (channel, direction, client_id, body, preview, thread_key, status, occurred_at)
          VALUES ('text','incoming',?,?,?,?, 'read', ?)`, [cid, body, body.slice(0, 100), `c${cid}_text`, at])
}
function addOutbound(cid, sentBy, daysAgo = 1) {
  const at = new Date(Date.now() - daysAgo * 86400000).toISOString()
  db.run(`INSERT INTO communications (channel, direction, client_id, body, preview, thread_key, status, sent_by_type, occurred_at)
          VALUES ('text','outgoing',?,?,?,?, 'read', ?, ?)`, [cid, 'hello', 'hello', `c${cid}_text`, sentBy, at])
}

// ---- off-market age / language ----
test('off-market date parses both formats and buckets correctly', () => {
  assert.ok(cx.parseOffMarket('2026-08-01'))
  assert.ok(cx.parseOffMarket('08/17/2026'))
  assert.equal(cx.parseOffMarket(''), null)
  assert.equal(cx.ageBucket(10), 'recent')
  assert.equal(cx.ageBucket(45), 'mid')
  assert.equal(cx.ageBucket(200), 'old')
  assert.equal(cx.ageBucket(500), 'ancient')
  assert.equal(cx.ageBucket(null), 'old', 'unknown date gets old-listing language, never recent')
})

test('old listings never get "recently came off the market" language', () => {
  for (const bucket of ['old', 'ancient']) {
    assert.ok(!/recently/i.test(cx.INITIAL[bucket]('1 Elm St', 'Hi :)')), `INITIAL ${bucket}`)
    assert.ok(!/recently/i.test(cx.SECOND[bucket]('1 Elm St')), `SECOND ${bucket}`)
    for (const [key, a] of Object.entries(cx.ANGLES)) {
      if (!a.buckets.includes(bucket)) continue
      assert.ok(!/recently came off/i.test(a.text('1 Elm St', bucket)), `${key} ${bucket}`)
    }
  }
})

test('no template assumes ownership or asks about activity', () => {
  const all = []
  for (const b of ['recent', 'mid', 'old', 'ancient']) { all.push(cx.INITIAL[b]('1 Elm St', 'Hi :)')); all.push(cx.SECOND[b]('1 Elm St')) }
  for (const a of Object.values(cx.ANGLES)) for (const b of a.buckets) all.push(a.text('1 Elm St', b))
  for (const t of all) {
    assert.ok(!/your (home|property|listing)/i.test(t), 'no ownership assumption: ' + t)
    assert.ok(!/activity|showings|interest did/i.test(t), 'no activity questions: ' + t)
  }
})

// ---- weekend scheduling ----
test('weekend sends shift to a weekday', () => {
  // A Saturday noon UTC (Sat morning Central): 2026-09-12 is a Saturday.
  const sat = new Date('2026-09-12T18:00:00Z')
  const shifted = cx.toWeekday(sat)
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(shifted)
  assert.ok(!['Sat', 'Sun'].includes(w), 'landed on ' + w)
  const wed = new Date('2026-09-09T18:00:00Z')
  assert.equal(cx.toWeekday(wed).getTime(), wed.getTime(), 'weekday stays put')
})

// ---- historical conversation suppression ----
test('prior "for rent" reply blocks enrollment', async () => {
  const c = mkClient({})
  addInbound(c.id, "It's for rent now.")
  const r = await cx.enrollClient(c.id)
  assert.equal(r.ok, false)
  assert.match(r.reason, /RENTED/)
})

test('prior "maybe next spring" stops the generic campaign as future timeframe', async () => {
  const c = mkClient({})
  addInbound(c.id, 'Maybe next spring, not right now')
  const r = await cx.enrollClient(c.id)
  assert.equal(r.ok, false)
  assert.match(r.reason, /FUTURE_TIMEFRAME/)
})

test('any meaningful prior reply blocks enrollment (human owns it)', async () => {
  const c = mkClient({})
  addInbound(c.id, 'Thanks for reaching out, who is this?')
  const r = await cx.enrollClient(c.id)
  assert.equal(r.ok, false)
  assert.match(r.reason, /PRIOR_RESPONSE|NEEDS_HUMAN|WANTS/)
})

test('clean history enrolls', async () => {
  const c = mkClient({})
  const r = await cx.enrollClient(c.id)
  assert.equal(r.ok, true)
  const en = db.get('SELECT * FROM cx_campaign WHERE client_id=?', [c.id])
  assert.equal(en.status, 'active')
  assert.ok(en.next_send_at)
})

// ---- MLS / status stops ----
test('sold, pending, relisted-active MLS statuses are terminal', async () => {
  for (const [mls, code] of [['Sold', 'SOLD'], ['Pending', 'PENDING'], ['Active', 'RELISTED']]) {
    const c = mkClient({ mls_status: mls })
    const v = await cx.evaluateEligibility(c)
    assert.equal(v.ok, false); assert.equal(v.terminal, true); assert.equal(v.code, code)
  }
})

test('STOP opt-out and undeliverable numbers are terminal', async () => {
  const c1 = mkClient({})
  db.run('UPDATE clients SET hub_text_opt_out=1 WHERE id=?', [c1.id])
  const v1 = await cx.evaluateEligibility(db.get('SELECT * FROM clients WHERE id=?', [c1.id]))
  assert.equal(v1.code, 'DNC')
  const c2 = mkClient({})
  db.run('UPDATE clients SET sms_undeliverable=1 WHERE id=?', [c2.id])
  const v2 = await cx.evaluateEligibility(db.get('SELECT * FROM clients WHERE id=?', [c2.id]))
  assert.equal(v2.code, 'WRONG_NUMBER')
})

// ---- manual-communication suppression ----
test('recent manual human text defers (not stops) the campaign send', async () => {
  const c = mkClient({})
  addOutbound(c.id, null, 1)   // human text yesterday (sent_by_type null = human)
  const v = await cx.evaluateEligibility(c)
  assert.equal(v.ok, false)
  assert.equal(v.terminal, false)
  assert.equal(v.code, 'RECENT_MANUAL_CONTACT')
})

// ---- inbound response: stop first ----
test('inbound response stops the campaign immediately and creates human follow-up', async () => {
  const c = mkClient({})
  assert.equal((await cx.enrollClient(c.id)).ok, true)
  const blocked = cx.handleCxInbound(c.id, 'Still available, who is asking?', null)
  assert.equal(blocked, true, 'campaign lead → AI must be blocked')
  const en = db.get('SELECT * FROM cx_campaign WHERE client_id=?', [c.id])
  assert.equal(en.status, 'response_received')
  assert.equal(en.next_send_at, null, 'pending sends cancelled')
  assert.equal(en.response_class, 'STILL_AVAILABLE')
  const task = db.get("SELECT * FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'CX Response%'", [c.id])
  assert.ok(task, 'human follow-up task created')
  // A second inbound doesn't restart anything, still blocks the AI.
  assert.equal(cx.handleCxInbound(c.id, 'hello?', null), true)
  assert.equal(db.get('SELECT status FROM cx_campaign WHERE client_id=?', [c.id]).status, 'response_received')
})

test('re-enrollment after a response requires explicit human action', async () => {
  const c = mkClient({})
  await cx.enrollClient(c.id)
  cx.handleCxInbound(c.id, 'yes', null)
  const r = await cx.enrollClient(c.id)
  assert.equal(r.ok, false)
  assert.match(r.reason, /human/i)
})

// ---- AI never replies ----
test('AI orchestrator refuses campaign leads, even forced', async () => {
  const c = mkClient({})
  await cx.enrollClient(c.id)
  const { handleInboundText } = await import('../server/ai-followup/orchestrator.js')
  for (const force of [false, true]) {
    const r = await handleInboundText(c.id, 'tell me more', { force })
    assert.equal(r.ok, false)
    assert.match(r.reason, /never replies/i)
  }
})

// ---- classification ----
test('inbound classification covers the delicate cases', () => {
  assert.equal(cx.classifyInbound('Wrong number'), 'WRONG_NUMBER')
  assert.equal(cx.classifyInbound('We already sold it'), 'SOLD')
  assert.equal(cx.classifyInbound('We listed with another agent'), 'LISTED_WITH_AGENT')
  assert.equal(cx.classifyInbound('We decided to keep it'), 'HOLDING_PROPERTY')
  assert.equal(cx.classifyInbound('Not interested'), 'NOT_INTERESTED')
  assert.equal(cx.classifyInbound('Maybe next year'), 'FUTURE_TIMEFRAME')
  assert.equal(cx.classifyInbound('Call me'), 'WANTS_CALL')
  assert.equal(cx.classifyInbound('ok'), 'NEEDS_HUMAN_REVIEW')
})

// ---- angle rotation ----
test('angle rotation never repeats an angle within the last 3 sends', () => {
  const c = mkClient({})
  const used = []
  for (let i = 0; i < 8; i++) {
    const angle = cx.pickAngle(c.id, 'mid')
    const last3 = used.slice(-3)
    assert.ok(!last3.includes(angle), `angle ${angle} repeated within last 3 (${last3.join(',')})`)
    used.push(angle)
    db.run("INSERT INTO cx_campaign_log (client_id, event, angle, created_at) VALUES (?,?,?,?)", [c.id, 'sent', angle, nowIso()])
  }
  assert.ok(new Set(used.slice(0, 5)).size >= 4, 'healthy variety in the first sends')
})

test('angles respect the age bucket', () => {
  const c = mkClient({})
  db.run("INSERT INTO cx_campaign_log (client_id, event, angle, created_at) VALUES (?,?,?,?)", [c.id, 'sent', 'DID_IT_SELL', nowIso()])
  for (let i = 0; i < 12; i++) {
    const angle = cx.pickAngle(c.id, 'recent')
    assert.ok(cx.ANGLES[angle].buckets.includes('recent'), `${angle} not allowed for recent`)
    db.run("INSERT INTO cx_campaign_log (client_id, event, angle, created_at) VALUES (?,?,?,?)", [c.id, 'sent', angle, nowIso()])
  }
})
