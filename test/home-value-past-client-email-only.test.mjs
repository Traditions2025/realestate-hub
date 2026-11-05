// Past clients get the home value by EMAIL, never by text (John, 2026-11-05).
//
// They already know us and sit on the long-term Home Value nurture by email. A text
// asking them to rate their own house reads as cold prospecting from the one team that
// should know better.
//
// Two places could text them, so both are gated on one definition: the Day 0 condition
// question (scheduled the moment the request lands) and the seven SMS steps of the 45-day
// sequence. The SMS steps SKIP rather than refuse, so the email half still runs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const HVA = await import('../server/home-value-answers.js')
const HVI = await import('../server/home-value-intake.js')
const { resolveStep } = await import('../server/home-value-steps.js')
HVA.initHvAnswers()

let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')

const mk = (over = {}) => {
  const id = db.run(
    'INSERT INTO clients (first_name, last_name, type, status, phone, email, address, tags) VALUES (?,?,?,?,?,?,?,?)',
    ['Barney', 'Foley', 'seller', over.status || 'new', '+1319555' + uniq().slice(-4),
      `pc${uniq()}@example.com`, '5661 Meadow Grass Cir SE', over.tags || null],
  ).lastInsertRowid
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}

const smsStep = { key: 'day3_improvements', channel: 'sms', day: 3 }
const emailStep = { key: 'day1_email', channel: 'email', day: 1 }
const f = { first_name: 'Barney', street: '5661 Meadow Grass Cir SE' }

// ---- what counts as a past client -------------------------------------------------

test('closed is a past client; so is the tag', () => {
  assert.equal(HVA.isPastClient({ status: 'closed' }), true)
  assert.equal(HVA.isPastClient({ status: 'Closed' }), true, 'case does not matter')
  assert.equal(HVA.isPastClient({ status: 'new', tags: '["FUB Stage: Past Client"]' }), true)
  assert.equal(HVA.isPastClient({ status: 'new', tags: '["Past Clients"]' }), true)
})

test('an ordinary lead is not, and neither is nothing at all', () => {
  assert.equal(HVA.isPastClient({ status: 'new', tags: '["Seller","52403"]' }), false)
  assert.equal(HVA.isPastClient({ status: 'active' }), false)
  assert.equal(HVA.isPastClient(null), false)
  assert.equal(HVA.isPastClient({}), false)
})

// ---- the Day 0 text -----------------------------------------------------------------

test('a past client is never queued for the Day 0 text', () => {
  const c = mk({ status: 'closed' })
  const r = HVI.scheduleConditionQuestion(c)
  assert.equal(r.ok, false)
  assert.match(r.reason, /past client - home value goes by email only/)
})

test('the tag alone is enough, even on an open lead', () => {
  const c = mk({ status: 'new', tags: '["Fello","FUB Stage: Past Client"]' })
  assert.equal(HVI.scheduleConditionQuestion(c).ok, false)
})

test('an ordinary lead is still queued as before', () => {
  const c = mk({ status: 'new' })
  const r = HVI.scheduleConditionQuestion(c)
  assert.equal(r.ok, true, 'this is the normal path and must not be broken')
  assert.ok(r.send_at)
})

// ---- the 45-day sequence --------------------------------------------------------------

test('every SMS step is skipped for a past client', () => {
  const c = mk({ status: 'closed' })
  for (const key of ['day3_improvements', 'day8_buyer_notice', 'day15_intent',
    'day23_where', 'day32_expectation', 'day45_sms_close']) {
    const p = resolveStep(c, { key, channel: 'sms', day: 3 }, f)
    assert.equal(p.action, 'skip', `${key} must not text a past client`)
    assert.match(p.reason, /email only/)
  }
})

test('skipped, not refused - the EMAIL half still runs', () => {
  // A refusal would stall the enrollment on that step. A skip advances past it, which is
  // the difference between "no texts" and "no sequence".
  const c = mk({ status: 'closed' })
  const p = resolveStep(c, emailStep, f)
  assert.notEqual(p.action, 'skip', 'the email is still sent')
  assert.equal(p.action, 'send')
})

test('a normal lead still gets the texts', () => {
  const c = mk({ status: 'new' })
  const p = resolveStep(c, smsStep, f)
  assert.equal(p.action, 'send')
})

test('the past-client rule is checked before the seller-intent handoff', () => {
  // A past client who says 1-3 months must still not be texted. The handoff stops the
  // sequence either way, but the ordering is what guarantees no text goes out first.
  const c = mk({ status: 'closed' })
  HVA.saveAnswers(c.id, {
    submission_id: 'HV-' + uniq(), condition: '9',
    HV_Data: 'cond=9;time=1-3 months;buy=yes', timeframe: '1-3 months', would_buy: 'yes',
  }, { submittedAt: new Date().toISOString() })
  const p = resolveStep(db.get('SELECT * FROM clients WHERE id=?', [c.id]), smsStep, f)
  assert.equal(p.action, 'skip')
  assert.match(p.reason, /email only/)
})

// ---- anything already queued ----------------------------------------------------------

test('a queued home value text to a past client is cancelled at send time', async () => {
  // The rule is applied when the text is queued, but a lead can become a past client in
  // between, and anything queued before the rule existed is still sitting there.
  const c = mk({ status: 'closed' })
  const { sendScheduledRow } = await import('../server/scheduled-texts.js')
  const id = db.run(`INSERT INTO scheduled_texts (client_id, phone, body, send_at, status, created_by, created_at)
                     VALUES (?,?,?,?,'scheduled','home_value_intake',?)`,
    [c.id, c.phone, 'rate your home 1-10', new Date().toISOString(), new Date().toISOString()]).lastInsertRowid
  const r = await sendScheduledRow(db.get('SELECT * FROM scheduled_texts WHERE id=?', [id]))
  assert.equal(r.ok, false)
  assert.match(String(r.skipped), /past client/)
  const row = db.get('SELECT status, error FROM scheduled_texts WHERE id=?', [id])
  assert.equal(row.status, 'canceled')
  assert.match(row.error, /email only/)
})

test('the guard is scoped to home value, not to texting past clients at all', async () => {
  // A past client can still be texted by a person or another campaign. Only the home
  // value question is email-only.
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../server/scheduled-texts.js', import.meta.url), 'utf8'))
  assert.match(src, /s\.created_by === 'home_value_intake'/, 'scoped by who queued it')
})
