// The Home Value enrollment engine existed, had a daily limit and an on/off setting — and
// nothing ever called it. Switching enrollment "on" did nothing at all; the only way anyone
// got enrolled was a manual POST to /home-value/run. These pin the wiring that makes the
// setting mean something.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../server/scheduler.js', import.meta.url), 'utf8')

test('the enrollment tick is actually registered on an interval', () => {
  assert.match(src, /setInterval\(checkHomeValueEnrollTick, 60 \* 1000\)/,
    'without this, home_value_enroll_enabled is a setting nothing reads')
})

test('it calls the real engine', () => {
  assert.match(src, /import\('\.\/home-value-enroll\.js'\)/)
  assert.match(src, /homeValueEnrollTick\(\)/)
})

test('it runs in the morning, so a day’s batch spreads across the 9-5 window', () => {
  assert.match(src, /const HOME_VALUE_ENROLL_HOUR = 9/)
})

test('it claims the day before running, so a slow run cannot double-enroll', () => {
  const fn = src.slice(src.indexOf('async function checkHomeValueEnrollTick'),
    src.indexOf('// Fire the Watch sweep'))
  const claim = fn.indexOf("setSetting?.('last_home_value_enroll_date'")
  const call = fn.indexOf('homeValueEnrollTick()')
  assert.ok(claim > 0 && call > 0, 'both the claim and the call must be present')
  assert.ok(claim < call, 'the date must be claimed BEFORE the tick runs')
})

test('it skips weekends', () => {
  const fn = src.slice(src.indexOf('async function checkHomeValueEnrollTick'),
    src.indexOf('// Fire the Watch sweep'))
  assert.match(fn, /now\.weekday === 0 \|\| now\.weekday === 6/)
})

// The weekend check above is worthless if chicagoNow() never supplies a weekday — it read
// `undefined === 0`, which is false, so every Saturday would have enrolled.
test('chicagoNow actually returns a weekday', () => {
  assert.match(src, /weekday: new Date\(`\$\{date\}T12:00:00Z`\)\.getUTCDay\(\)/)
})

test('the weekday is derived from the Chicago date, not the UTC one', async () => {
  // 10 PM CT on a Friday is already Saturday in UTC. Reading the UTC day would skip a
  // Friday run and permit a Saturday one.
  const chicagoDateAt = (iso) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
  const fridayLate = '2026-10-03T03:30:00Z'          // Friday 10:30 PM CT
  const d = chicagoDateAt(fridayLate)
  assert.equal(d, '2026-10-02')
  assert.equal(new Date(`${d}T12:00:00Z`).getUTCDay(), 5, 'must read as Friday')
})
