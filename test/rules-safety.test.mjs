// STRESS TEST for the tunable rules registry (John, 2026-10-16: "stress test everything
// first and make sure we do it safely that nothing fires unintentionally for any lead
// communication").
//
// These rules decide when real people get texted and emailed, so the test is adversarial
// rather than illustrative. It fuzzes every rule with every bad value it can think of and
// asserts the same two things each time:
//
//   1. the value in force is always inside the hard bounds declared in code
//   2. no input makes a rule MORE permissive than its ceiling
//
// Plus the one that matters most on the day this ships: every default equals the behaviour
// that was already live, so introducing the registry changes nothing by itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubrules_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const { RULES, rule, setRule, resetRule, allRules } = await import('../server/rules.js')

const KEYS = Object.keys(RULES)

/* ---------- the values that were live before any of this existed ---------- */

test('every default equals the behaviour that was already live', () => {
  const LIVE_ON_2026_10_16 = {
    max_emails_per_week: 2,
    max_emails_per_day: 1,
    max_emails_per_fortnight_past_client: 1,
    drip_hold_days_after_email_reply: 30,
    proactive_start_hour: 9,
    proactive_end_hour: 17,
    text_dedupe_minutes: 60,
    human_conversation_hours: 12,
    ai_reactivation_daily_limit: 70,
    ai_enroll_defer_human_hours: 24,
    ai_fresh_window_days: 7,
    watch_no_text_months: 6,
    home_value_daily_limit: 300,
    home_value_recent_lookup_days: 30,
    home_value_defer_days_after_use: 90,
    fsbo_campaign_dom_threshold: 14,
    fsbo_availability_days: 30,
    // NOT previously live. Added 2026-10-19 as a new rule: a cancelled listing waits 48
    // hours before the first text. Recorded here so the next change to it is still caught.
    cx_cancelled_hold_hours: 48,
    cx_cancelled_hold_max_dom: 90,
  }
  // Both directions: no rule is missing from the list, and no live value has drifted.
  assert.deepEqual(KEYS.slice().sort(), Object.keys(LIVE_ON_2026_10_16).sort(),
    'a rule was added or removed without recording what it was before')
  for (const [k, v] of Object.entries(LIVE_ON_2026_10_16)) {
    assert.equal(RULES[k].def, v, `${k} default moved — this would change live sending`)
  }
})

test('with nothing stored, every rule reports its default', () => {
  for (const k of KEYS) assert.equal(rule(k), RULES[k].def, k)
})

/* ---------- fuzzing: nothing gets outside the hard bounds ---------- */

const GARBAGE = [
  '', ' ', '   ', 'abc', 'null', 'undefined', 'NaN', 'Infinity', '-Infinity',
  '1e309', '0', '-0', '-1', '-999999', '999999999', '1.0e12',
  '0.5', '2.7', '  7  ', '7px', '7,000', '1/0', 'true', 'false',
  '[]', '{}', 'null\u0000', '٣', '%', '--5', '+8', '0x10', '1_000',
]

test('no stored value, however broken, escapes the hard bounds', () => {
  for (const k of KEYS) {
    const spec = RULES[k]
    for (const g of GARBAGE) {
      db.setSetting(k, g)
      const v = rule(k)
      assert.ok(Number.isFinite(v), `${k} returned a non-number for ${JSON.stringify(g)}`)
      assert.ok(v >= spec.min && v <= spec.max,
        `${k} = ${v} for input ${JSON.stringify(g)}, outside ${spec.min}..${spec.max}`)
    }
    db.setSetting(k, '')
  }
})

test('a huge number is clamped to the ceiling, never allowed through', () => {
  for (const k of KEYS) {
    db.setSetting(k, '100000000')
    assert.equal(rule(k), RULES[k].max, `${k} must stop at its maximum`)
    db.setSetting(k, '')
  }
})

test('zero and negatives never turn a limit into "no limit"', () => {
  for (const k of KEYS) {
    for (const bad of ['0', '-1', '-100']) {
      db.setSetting(k, bad)
      const v = rule(k)
      assert.ok(v >= RULES[k].min && v > 0, `${k} became ${v} for ${bad}`)
    }
    db.setSetting(k, '')
  }
})

/* ---------- the specific ways this could hurt somebody ---------- */

test('the texting window can never open before 8am or run past 7pm', () => {
  // The dangerous direction for a window is OUTWARD. Whatever is stored, a lead cannot be
  // texted at 6am or 10pm by moving a dial.
  for (const bad of GARBAGE.concat(['3', '23', '0', '-5', '99'])) {
    db.setSetting('proactive_start_hour', bad)
    db.setSetting('proactive_end_hour', bad)
    const s = rule('proactive_start_hour'), e = rule('proactive_end_hour')
    assert.ok(s >= 8, `texting could start at ${s}:00 (input ${JSON.stringify(bad)})`)
    assert.ok(e <= 19, `texting could run to ${e}:00 (input ${JSON.stringify(bad)})`)
  }
  db.setSetting('proactive_start_hour', ''); db.setSetting('proactive_end_hour', '')
})

test('email caps can never exceed one a day / seven a week', () => {
  db.setSetting('max_emails_per_day', '50')
  db.setSetting('max_emails_per_week', '500')
  db.setSetting('max_emails_per_fortnight_past_client', '500')
  assert.ok(rule('max_emails_per_day') <= 3)
  assert.ok(rule('max_emails_per_week') <= 7)
  assert.ok(rule('max_emails_per_fortnight_past_client') <= 4)
  for (const k of ['max_emails_per_day', 'max_emails_per_week', 'max_emails_per_fortnight_past_client']) db.setSetting(k, '')
})

test('the AI daily limit cannot be opened to the whole database', () => {
  db.setSetting('ai_reactivation_daily_limit', '99999')
  assert.equal(rule('ai_reactivation_daily_limit'), 300)
  db.setSetting('ai_reactivation_daily_limit', '')
})

test('the gap between automated texts cannot drop below 15 minutes', () => {
  for (const bad of ['0', '1', '-5', 'abc']) {
    db.setSetting('text_dedupe_minutes', bad)
    assert.ok(rule('text_dedupe_minutes') >= 15, `became ${rule('text_dedupe_minutes')} for ${bad}`)
  }
  db.setSetting('text_dedupe_minutes', '')
})

/* ---------- setRule: what you asked for vs what you got ---------- */

test('setRule clamps and reports honestly rather than silently', () => {
  const r = setRule('max_emails_per_week', 999, 'test')
  assert.equal(r.ok, true)
  assert.equal(r.applied, 7)
  assert.equal(r.asked, 999)
  assert.equal(r.clamped, true, 'the caller must be able to tell it did not take the value')
  assert.equal(rule('max_emails_per_week'), 7)
  resetRule('max_emails_per_week', 'test')
  assert.equal(rule('max_emails_per_week'), 2)
})

test('setRule refuses nonsense instead of storing it', () => {
  const before = rule('proactive_end_hour')
  for (const bad of ['abc', '', null, undefined, NaN, {}, []]) {
    const r = setRule('proactive_end_hour', bad, 'test')
    if (r.ok) assert.ok(rule('proactive_end_hour') >= 12 && rule('proactive_end_hour') <= 19)
    else assert.equal(rule('proactive_end_hour'), before, 'a refused change must not alter the value')
  }
  resetRule('proactive_end_hour', 'test')
})

test('an unknown rule is refused, never created', () => {
  assert.equal(setRule('delete_everything', 1, 'test').ok, false)
  assert.equal(resetRule('nope', 'test').ok, false)
  assert.throws(() => rule('not_a_rule'))
})

test('every change is written to the activity log', () => {
  setRule('fsbo_availability_days', 45, 'tester@example.com')
  const row = db.get("SELECT details FROM activity_log WHERE action='rule_changed' ORDER BY id DESC LIMIT 1")
  assert.match(String(row?.details), /fsbo_availability_days/)
  assert.match(String(row?.details), /tester@example\.com/)
  resetRule('fsbo_availability_days', 'test')
})

/* ---------- the guards are not reachable from here ---------- */

test('no guard is tunable: the registry holds only dials', () => {
  const forbidden = /fsbo_status|forbidden|never_contact|hard_block|opt_out|stop|junk|wrongaddress|spam/i
  for (const k of KEYS) {
    assert.doesNotMatch(k, forbidden, `${k} looks like a guard — guards belong in code, not a settings screen`)
  }
})

test('every rule declares real bounds and a reason', () => {
  for (const k of KEYS) {
    const s = RULES[k]
    assert.ok(Number.isFinite(s.min) && Number.isFinite(s.max), `${k} has no hard bounds`)
    assert.ok(s.min < s.max, `${k} bounds are inverted`)
    assert.ok(s.def >= s.min && s.def <= s.max, `${k} default sits outside its own bounds`)
    assert.ok(s.why && s.why.length > 10, `${k} has no explanation for whoever edits it`)
    assert.ok(s.group && s.label, `${k} is not presentable`)
  }
})

test('allRules shows a clamped value as clamped rather than hiding it', () => {
  db.setSetting('home_value_daily_limit', '99999')
  const row = allRules().find(r => r.key === 'home_value_daily_limit')
  assert.equal(row.value, 1000)
  assert.equal(row.clamped, true, 'a nonsense stored value must be visible, not silently corrected')
  db.setSetting('home_value_daily_limit', '')
})

/* ---------- the database being broken must not open the taps ---------- */

test('if settings cannot be read at all, every rule falls back to its default', async () => {
  const realGet = db.getSetting
  db.getSetting = () => { throw new Error('database unavailable') }
  try {
    for (const k of KEYS) assert.equal(rule(k), RULES[k].def, `${k} did not fall back safely`)
  } finally { db.getSetting = realGet }
})
