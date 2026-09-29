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

// The submission poller had the same defect as the enrolment tick: it existed, it worked,
// and nothing ever called it. Nicole Morris submitted at 5 PM on 2026-09-29 and got no
// follow-up and no alert, because the only way to run the poller was a manual POST.
test('the submission poller is on an interval', () => {
  assert.match(src, /pollHomeValueSubmissions\(\{ sinceDays: 2, max: 25 \}\)/)
  assert.match(src, /\}, 10 \* 60 \* 1000\)/)
})

test('a poller failure cannot take the scheduler down with it', () => {
  const block = src.slice(src.indexOf('Home Value form submissions'), src.indexOf('Home Value form submissions') + 900)
  assert.match(block, /\.catch\(/, 'the promise chain must swallow its own errors')
})

// The alert exists because the Sierra notification only reaches mattsmithremax@gmail.com,
// so a submission could be received, matched and answered without John ever seeing it.
test('a submission alerts the team, and says when the name differs', async () => {
  const intake = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../server/home-value-intake.js', import.meta.url), 'utf8'))
  assert.match(intake, /sendSubmissionAlert/)
  assert.match(intake, /johnwithmattsmithteam@gmail\.com,mattsmithremax@gmail\.com/)
  assert.match(intake, /'home_value_alert'/)
  // "Nicole Morris" matching "Niki Morris" looks like a duplicate unless the alert explains it
  assert.match(intake, /matched the existing record for/)
  // one alert per submission, however many times the mailbox is re-read
  assert.match(intake, /hv_alert:\$\{client\.id\}:\$\{visitNo\}/)
})
