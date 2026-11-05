// The response sequence must stop asking what the questionnaire already answered.
//
// John's spec, 2026-10-29, names twelve cases. They are the tests, in his order, because
// the whole point of the refactor is behavioural: the old sequence sent day 3's question
// on day 3 because it was day 3, and a homeowner who had just filled in nine screens was
// asked to fill them in again by text.
//
// These exercise the RESOLVER, which is the thing that decides. The send path is thin on
// purpose - it asks the resolver, then sends, skips or hands off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
import { initHvSms, HV_STEPS } from '../server/home-value-sms.js'
import { initHvAnswers, saveAnswers, rememberFact } from '../server/home-value-answers.js'
import { resolveStep } from '../server/home-value-steps.js'
import { day0TextFor } from '../server/home-value-intake.js'

await initDb()
initHvSms()
initHvAnswers()

const nowIso = () => new Date().toISOString()
const FULL = 'id=HV-X;cond=7;beds=3;bathsf=2;bathsh=0;upd=Roof:3-5,Furnace:6-10;'
  + 'lvlk=full;lvlb=cosmetic;lvlbs=partial;bsmt=full|part;gar=2|attached;zip=52227'

let seq = 0
function lead(answers = null, learned = {}) {
  seq += 1
  const now = nowIso()
  const id = db.run(`INSERT INTO clients (first_name,last_name,phone,email,address,type,status,created_at,updated_at)
                     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Dana', 'Reyes' + seq, '(319) 555-' + String(3000 + seq).slice(-4),
     `cond${seq}-${Date.now()}@example.com`, '14 Oak St', 'seller', 'new', now, now]).lastInsertRowid
  db.run(`INSERT OR REPLACE INTO home_value_sms (client_id,status,next_step,requested_at,updated_at)
          VALUES (?,?,?,?,?)`, [id, 'active', 0, now, now])
  if (answers) saveAnswers(id, { submission_id: 'S' + seq, ...answers })
  for (const [k, v] of Object.entries(learned)) rememberFact(id, k, v)
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}
const step = (key) => HV_STEPS.find((s) => s.key === key)
const F = { first_name: 'Dana', street: '14 Oak St' }
const plan = (c, key) => resolveStep(c, step(key), F)

// ── 1. nothing but address and contact ───────────────────────────────────────────────
test('TEST 1: an empty questionnaire still gets the condition question', () => {
  const c = lead()
  assert.match(day0TextFor(c), /scale of 1 to 10/i)
  assert.equal(plan(c, 'day1_email').action, 'send')
  assert.equal(plan(c, 'day3_improvements').action, 'send')
})

// ── 2. condition only ────────────────────────────────────────────────────────────────
test('TEST 2: condition 7 given, gap missing - ask the gap, never the rating again', () => {
  const c = lead({ condition: '7' })
  const t = day0TextFor(c)
  assert.ok(!/scale of 1 to 10/i.test(t), 'must not re-ask the rating')
  assert.match(t, /a 7 out of 10/)
  assert.match(t, /keeping it from being a 10/)
})

// ── 3. condition + gap ───────────────────────────────────────────────────────────────
test('TEST 3: both condition answers given - ask neither again', () => {
  const c = lead({ condition: '8', condition_gap: 'the kitchen is original' })
  const t = day0TextFor(c)
  assert.ok(!/scale of 1 to 10/i.test(t))
  assert.ok(!/keeping it from being a 10/i.test(t))
  // day 1 acknowledges the rating rather than asking for a number
  const p = plan(c, 'day1_email')
  assert.equal(p.action, 'send')
  assert.match(p.paras.join(' '), /rated the overall condition an? 8 out of 10/)
  assert.ok(!/just reply with a number/i.test(p.paras.join(' ')))
})

// ── 4 and 5. updates ─────────────────────────────────────────────────────────────────
test('TEST 4: all updates and ages given - day 3 does not ask whether they made updates', () => {
  const c = lead({ condition: '8', condition_gap: 'kitchen', HV_Data: FULL })
  const p = plan(c, 'day3_improvements')
  assert.ok(p.action !== 'send' || !/Have you made any major updates/i.test(p.text || ''),
    'the blanket updates question must not send')
})

test('TEST 5: updates given but depth missing - ask the depth', () => {
  const c = lead({ condition: '8', condition_gap: 'kitchen',
                   HV_Data: 'cond=8;upd=Roof:3-5,Kitchen:0-2' })
  const p = plan(c, 'day3_improvements')
  assert.equal(p.action, 'send')
  assert.match(p.text, /how extensive/i)
  assert.match(p.text, /roof|kitchen/i, 'it names what they actually told us')
})

test('TEST 5b: an update with no age is asked about by name', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: 'upd=Roof:unsure,Kitchen:0-2' })
  const p = plan(c, 'day3_improvements')
  assert.equal(p.action, 'send')
  assert.match(p.text, /roughly when/i)
  assert.match(p.text, /roof/i)
})

// ── 6. almost everything ─────────────────────────────────────────────────────────────
test('TEST 6: a near-complete questionnaire turns the early steps into acknowledgement', () => {
  const c = lead({ condition: '8', condition_gap: 'kitchen', HV_Data: FULL,
                   timeframe: 'Not right now, just curious', would_buy: 'No' })
  const d1 = plan(c, 'day1_email')
  assert.match(d1.paras.join(' '), /rated the overall condition/)
  const d5 = plan(c, 'day5_email')
  assert.match(d5.paras.join(' '), /You told us about the roof and the furnace/i)
  // day 3 has nothing left to ask
  const d3 = plan(c, 'day3_improvements')
  assert.ok(d3.action === 'skip' || /best feature/i.test(d3.text || ''), `got ${JSON.stringify(d3).slice(0, 90)}`)
})

// ── 7, 8, 9, 10. intent ──────────────────────────────────────────────────────────────
test('TEST 7: just curious - no seller-intent questioning, ever', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: FULL,
                   timeframe: 'Not right now, just curious' })
  const d15 = plan(c, 'day15_intent')
  assert.equal(d15.action, 'send')
  assert.ok(!/move|moving|sell/i.test(d15.text), `must not ask about moving: ${d15.text}`)
  assert.equal(plan(c, 'day23_where').action, 'skip')
  const d19 = plan(c, 'day19_email')
  assert.match(d19.subject, /worth knowing/i)
})

test('TEST 8: 6-12 months - may ask about the next home', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: FULL,
                   timeframe: 'Within 6-12 months' })
  const d15 = plan(c, 'day15_intent')
  assert.equal(d15.action, 'send')
  assert.match(d15.text, /where you would want to go next/i)
  assert.match(plan(c, 'day19_email').subject, /planning ahead/i)
})

test('TEST 9: 1-3 months - hand off, do not text', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: FULL,
                   timeframe: 'Within 1-3 months' })
  for (const k of ['day3_improvements', 'day8_buyer_notice', 'day15_intent', 'day23_where']) {
    assert.equal(plan(c, k).action, 'handoff', `${k} should hand off, not text`)
  }
})

test('TEST 9b: 3-6 months is flagged at day 15 rather than drifting on', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: FULL,
                   timeframe: 'Within 3-6 months' })
  assert.equal(plan(c, 'day15_intent').action, 'handoff')
})

test('TEST 10: would-need-to-buy answered - never asked again, destination still open', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: FULL,
                   timeframe: 'Within 6-12 months', would_buy: 'Yes' })
  assert.equal(plan(c, 'day23_where').action, 'send')
  rememberFact(c.id, 'move_destination', 'somewhere smaller in Marion')
  assert.equal(plan(c, 'day23_where').action, 'skip', 'and not once they have told us')
})

// ── 11. a reply still stops everything ───────────────────────────────────────────────
test('TEST 11: a reply stops both channels, under the existing rule', async () => {
  const { handleHvSmsInbound } = await import('../server/home-value-sms.js')
  const c = lead({ condition: '8' })
  handleHvSmsInbound(c.id, 'about a 7 I would say')
  const row = db.get('SELECT status, next_send_at FROM home_value_sms WHERE client_id=?', [c.id])
  assert.equal(row.status, 'replied')
  assert.equal(row.next_send_at, null)
})

// ── 12. the estimate reaction ────────────────────────────────────────────────────────
test('TEST 12: reaction given by text - day 37 acknowledges instead of re-asking', () => {
  const c = lead({ condition: '8', condition_gap: 'x', HV_Data: FULL })
  assert.equal(plan(c, 'day32_expectation').action, 'send', 'asked while unknown')
  rememberFact(c.id, 'valuation_reaction', 'Lower')
  assert.equal(plan(c, 'day32_expectation').action, 'skip', 'not asked twice')
  const d37 = plan(c, 'day37_email')
  assert.match(d37.paras.join(' '), /felt lower than you expected/i)
  assert.ok(!/higher.*about right.*lower/i.test(d37.paras.join(' ')), 'must not re-offer the three options')
})

// ── the rule underneath all of it ────────────────────────────────────────────────────
test('a question is never invented to fill a slot', () => {
  const c = lead({ condition: '8', condition_gap: 'kitchen', HV_Data: FULL,
                   timeframe: 'Not right now, just curious', would_buy: 'No' })
  rememberFact(c.id, 'home_best_feature', 'the backyard')
  rememberFact(c.id, 'valuation_reaction', 'About right')
  const d0 = day0TextFor(c)
  assert.ok(!/\?/.test(d0), `nothing left to ask, so no question mark: ${d0}`)
  assert.equal(plan(c, 'day3_improvements').action, 'skip')
  assert.equal(plan(c, 'day8_buyer_notice').action, 'skip')
  assert.equal(plan(c, 'day32_expectation').action, 'skip')
})

test('the resolver never silences the campaign when it faults', async () => {
  const { stepPlan } = await import('../server/home-value-steps.js')
  // a client shape the resolver cannot read must still send the written copy
  const p = stepPlan(null, step('day1_email'), F)
  assert.equal(p.action, 'send')
})

test('every Day 0 variant uses merge tokens, so the junk-name guard still applies', () => {
  // CONDITION_QUESTION has always used {{first_name}} and the sender fills it, which is
  // where "Test" and "unknown" become "there". A branch that interpolated the name here
  // would quietly bypass that and text a real person "Hi Test,".
  const shapes = [
    null,
    { condition: '8' },
    { condition: '8', condition_gap: 'kitchen', HV_Data: 'upd=Roof:unsure' },
    { condition: '8', condition_gap: 'kitchen', HV_Data: FULL },
  ]
  for (const s of shapes) {
    const c = lead(s)
    const t = day0TextFor(c)
    assert.ok(t.includes('{{first_name}}'), `no name token in: ${t.slice(0, 70)}`)
    assert.ok(!/Hi Dana/.test(t), 'the name must not be baked in')
    if (/\b14 Oak St\b/.test(t)) assert.fail('the address must be a token too')
  }
})
