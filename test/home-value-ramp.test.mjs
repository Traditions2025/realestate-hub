// Warm-up ramp for the Home Value campaign.
//
// 200 cold emails a day from one sending domain is a real step up, and mailbox providers
// judge a sender on how suddenly the volume appears. The ramp spends five enrolment days at
// 50 and five at 100 before reaching the ceiling.
//
// The part that matters: it counts DAYS THAT ACTUALLY ENROLLED, not calendar days, so a
// weekend, a holiday or an outage cannot quietly spend a step of the ramp while sending
// nothing.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { effectiveDailyLimit } = await import('../server/home-value-enroll.js')

const DRIP = 20
const CEILING = { enabled: true, daily_limit: 200, ramp: true }

function seedEnrollmentDays(dates) {
  db.run("DELETE FROM drip_enrollments WHERE drip_id = ? AND source = 'home_value_auto'", [DRIP])
  for (let i = 0; i < dates.length; i++) {
    db.run(`INSERT INTO drip_enrollments (drip_id, client_id, status, current_step, source, entered_at)
            VALUES (?,?,?,?,?,?)`, [DRIP, 900000 + i, 'active', 0, 'home_value_auto', dates[i] + ' 09:01:00'])
  }
}
const daysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10)
}

beforeEach(() => { seedEnrollmentDays([]) })

test('the first five enrolment days run at 50', () => {
  for (let prior = 0; prior < 5; prior++) {
    seedEnrollmentDays(Array.from({ length: prior }, (_, i) => daysAgo(prior - i)))
    assert.equal(effectiveDailyLimit(CEILING, DRIP), 50, `day ${prior + 1} should still be 50`)
  }
})

test('the next five run at 100', () => {
  for (let prior = 5; prior < 10; prior++) {
    seedEnrollmentDays(Array.from({ length: prior }, (_, i) => daysAgo(prior - i)))
    assert.equal(effectiveDailyLimit(CEILING, DRIP), 100, `day ${prior + 1} should be 100`)
  }
})

test('after ten days it reaches the configured ceiling', () => {
  seedEnrollmentDays(Array.from({ length: 10 }, (_, i) => daysAgo(10 - i)))
  assert.equal(effectiveDailyLimit(CEILING, DRIP), 200)
  seedEnrollmentDays(Array.from({ length: 40 }, (_, i) => daysAgo(40 - i)))
  assert.equal(effectiveDailyLimit(CEILING, DRIP), 200)
})

test('a gap in the calendar does not advance the ramp', () => {
  // three enrolment days, but spread over a month of weekends and an outage
  seedEnrollmentDays([daysAgo(30), daysAgo(20), daysAgo(3)])
  assert.equal(effectiveDailyLimit(CEILING, DRIP), 50,
    'only three days have actually enrolled, so the ramp is still on its first step')
})

test('today does not count itself', () => {
  // enrolling this morning must not raise this afternoon's own limit
  seedEnrollmentDays([daysAgo(2), daysAgo(1), new Date().toISOString().slice(0, 10)])
  assert.equal(effectiveDailyLimit(CEILING, DRIP), 50, 'two prior days -> still step one')
})

test('the ramp never exceeds the configured ceiling', () => {
  seedEnrollmentDays(Array.from({ length: 6 }, (_, i) => daysAgo(6 - i)))   // ramp wants 100
  assert.equal(effectiveDailyLimit({ ...CEILING, daily_limit: 75 }, DRIP), 75,
    'a lower ceiling wins over the ramp step')
})

test('switching the ramp off goes straight to the ceiling', () => {
  seedEnrollmentDays([])
  assert.equal(effectiveDailyLimit({ ...CEILING, ramp: false }, DRIP), 200)
})

test('only this campaign’s automatic enrolments count', () => {
  seedEnrollmentDays([daysAgo(3), daysAgo(2), daysAgo(1)])
  // a hand-enrolled lead, and another campaign's rows, must not move the ramp
  db.run(`INSERT INTO drip_enrollments (drip_id, client_id, status, current_step, source, entered_at)
          VALUES (?,?,?,?,?,?)`, [DRIP, 999001, 'active', 0, 'manual', daysAgo(9) + ' 10:00:00'])
  db.run(`INSERT INTO drip_enrollments (drip_id, client_id, status, current_step, source, entered_at)
          VALUES (?,?,?,?,?,?)`, [5, 999002, 'active', 0, 'home_value_auto', daysAgo(8) + ' 10:00:00'])
  assert.equal(effectiveDailyLimit(CEILING, DRIP), 50)
})
