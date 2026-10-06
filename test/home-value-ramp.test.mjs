// The warm-up ramp climbs to the ceiling instead of jumping to it.
//
// John, 2026-10-06: "Please increase to 300 a day we need to bump this up and level up
// our game". The ramp's fixed steps end at 100 and then handed straight over to the
// configured ceiling. That was a step of 100 while the ceiling was 200; with 300 it would
// have been a 3x overnight spike, which is the exact shape the ramp exists to avoid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { initDb } from '../server/database.js'
await initDb()
const { effectiveDailyLimit, rampSchedule, rampDayIndex } = await import('../server/home-value-enroll.js')

// effectiveDailyLimit reads the ramp day from the DB, so drive the maths through
// rampSchedule, which takes the index it is given.
// rampSchedule(cfg, dripId) starts at the live index; with no drip the index is 0, so the
// schedule it returns IS the curve from the beginning.
const curve = (daily_limit, days = 15) =>
  rampSchedule({ ramp: true, daily_limit }, null, days).map(r => r.limit)

test('the first five enrolling days stay at 50', () => {
  assert.deepEqual(curve(300).slice(0, 5), [50, 50, 50, 50, 50])
})

test('the next five sit at 100', () => {
  assert.deepEqual(curve(300).slice(5, 10), [100, 100, 100, 100, 100])
})

test('past the fixed steps it climbs, it does not jump', () => {
  const c = curve(300)
  assert.equal(c[10], 200, 'day 10 doubles to 200, it does not leap to the ceiling')
  assert.equal(c[11], 300, 'day 11 reaches it')
  assert.equal(c[12], 300, 'and stays there')
})

test('no single day more than doubles the one before it', () => {
  // the rule the ramp is really enforcing
  const c = curve(300)
  for (let i = 1; i < c.length; i++) {
    assert.ok(c[i] <= c[i - 1] * 2, `day ${i}: ${c[i - 1]} -> ${c[i]} is more than double`)
  }
})

test('the ceiling is never exceeded', () => {
  for (const ceiling of [50, 120, 200, 300, 1000]) {
    for (const v of curve(ceiling, 20)) assert.ok(v <= ceiling, `${v} > ceiling ${ceiling}`)
  }
})

test('a ceiling below a ramp step is respected, not raised by the ramp', () => {
  // someone lowering the ceiling mid-ramp must get the lower number
  assert.deepEqual(curve(25).slice(0, 3), [25, 25, 25])
  assert.equal(curve(75)[6], 75, 'the 100 step must not override a 75 ceiling')
})

test('the ceiling is eventually reached, however high', () => {
  const c = curve(1000, 40)
  assert.equal(c[c.length - 1], 1000, 'the ramp has to finish')
})

test('turning the ramp off gives the full ceiling immediately', () => {
  assert.deepEqual(rampSchedule({ ramp: false, daily_limit: 300 }, null, 3).map(r => r.limit),
    [300, 300, 300])
})

test('the ramp counts enrolling days, not calendar days', () => {
  // a weekend, a holiday or an outage must not spend a step
  const s = fs.readFileSync(new URL('../server/home-value-enroll.js', import.meta.url), 'utf8')
  const fn = s.slice(s.indexOf('export function rampDayIndex'), s.indexOf('export function effectiveDailyLimit'))
  assert.match(fn, /COUNT\(DISTINCT date\(entered_at\)\)/)
  assert.match(fn, /source = 'home_value_auto'/, 'a manual enrolment must not spend a ramp step')
  assert.match(fn, /date\(entered_at\) < date\('now','localtime'\)/, 'today does not count itself')
})

test('rampDayIndex is safe with no campaign', () => {
  assert.equal(rampDayIndex(null), 0)
})

test('the settings response says what the ramp will allow next', () => {
  // raising the ceiling while the ramp is still climbing looks like nothing happened
  const r = fs.readFileSync(new URL('../server/routes/drips.js', import.meta.url), 'utf8')
  assert.match(r, /ramp_schedule: d \? rampSchedule\(cfg, d\.id\) : \[\]/)
  assert.match(r, /rampSchedule, homeValueDrip \} = await import/)
})
