// THE DASHBOARD SCOREBOARD (John, 2026-11-10)
//
// The board turns the counts into a judgement — "behind by 3" — and a judgement that is
// wrong is worse than no board at all, because the team acts on it. So the arithmetic is
// pinned here: what a target means, what "behind" means before any day has finished, and
// what the board says when nobody has set a target at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const S = await import('../server/scheduling.js')
S.initScheduling()

// Save and restore whatever the real targets are, so running the suite never changes them.
const SAVED = S.getApptTargets()
const restore = () => S.setApptTargets({ week: SAVED.week, month: SAVED.month })

test('with no target there is no deficit, only a count', () => {
  S.setApptTargets({ week: null, month: null })
  const b = S.appointmentScoreboard()
  assert.equal(b.week.target, null)
  assert.equal(b.week.remaining, null, 'remaining is null, not zero')
  assert.equal(b.week.behind, null, 'an unset target can never produce a deficit')
  assert.equal(b.week.pct, null)
  assert.equal(typeof b.week.set, 'number', 'the count itself is still reported')
  restore()
})

test('a target produces remaining and a percentage', () => {
  S.setApptTargets({ week: 10, month: 40 })
  const b = S.appointmentScoreboard()
  assert.equal(b.week.target, 10)
  assert.equal(b.week.remaining, Math.max(0, 10 - b.week.set))
  assert.equal(b.week.pct, Math.min(100, Math.round(b.week.set / 10 * 100)))
  assert.equal(b.month.target, 40)
  restore()
})

test('targets are rejected when they are not a sane number', () => {
  assert.throws(() => S.setApptTargets({ week: 5000 }), /between 1 and 1000/)
  assert.throws(() => S.setApptTargets({ week: 'ten' }), /between 1 and 1000/)
  restore()
})

test('zero or blank clears a target rather than setting a target of zero', () => {
  S.setApptTargets({ week: 12 })
  assert.equal(S.getApptTargets().week, 12)
  S.setApptTargets({ week: 0 })
  assert.equal(S.getApptTargets().week, null, 'a target of zero is no target')
  S.setApptTargets({ week: 12 })
  S.setApptTargets({ week: '' })
  assert.equal(S.getApptTargets().week, null)
  restore()
})

test('setting only one target leaves the other alone', () => {
  S.setApptTargets({ week: 8, month: 30 })
  S.setApptTargets({ week: 9 })               // month omitted entirely
  const t = S.getApptTargets()
  assert.equal(t.week, 9)
  assert.equal(t.month, 30, 'the month target was not touched')
  restore()
})

// ---- the pace rule -----------------------------------------------------------------

test('the week never opens by saying we are already behind', () => {
  // "Behind" is measured against days that have FINISHED. On Monday morning no day of the
  // week is over, so expected is zero and the board cannot open with a deficit. Getting
  // this wrong means every Monday starts with a red number nobody can act on yet.
  S.setApptTargets({ week: 10, month: 40 })
  const b = S.appointmentScoreboard()
  const w = b.week
  assert.ok(w.days_finished >= 0 && w.days_finished < 7, 'today is inside its own week')
  const expected = Math.round(w.target * w.days_finished / 7)
  assert.equal(w.expected_by_now, expected)
  assert.equal(w.behind, Math.max(0, expected - w.set))
  if (w.days_finished === 0) assert.equal(w.behind, 0, 'Monday opens at zero behind')
  restore()
})

test('behind and ahead are never both set', () => {
  S.setApptTargets({ week: 10, month: 40 })
  for (const p of [S.appointmentScoreboard().week, S.appointmentScoreboard().month]) {
    assert.ok(!(p.behind > 0 && p.ahead > 0), 'one of them is always zero')
  }
  restore()
})

test('per-day needed is what is left divided by the days still available', () => {
  S.setApptTargets({ week: 10, month: 40 })
  const w = S.appointmentScoreboard().week
  assert.equal(w.days_left, 7 - w.days_finished, 'today still counts as available')
  if (w.days_left > 0) assert.equal(w.per_day_needed, Math.ceil(w.remaining / w.days_left))
  restore()
})

// ---- the windows -------------------------------------------------------------------

test('the week runs Monday to Sunday, in Central time', () => {
  const b = S.appointmentScoreboard()
  const dow = (d) => new Date(`${d}T12:00:00Z`).getUTCDay()
  assert.equal(dow(b.week.from), 1, 'starts on a Monday')
  assert.equal(dow(b.week.to), 0, 'ends on a Sunday')
  assert.equal(b.week.days, 7)
  assert.ok(b.week.from <= b.today && b.today <= b.week.to, 'today is inside it')
})

test('the month window is the real calendar month, not thirty days', () => {
  const b = S.appointmentScoreboard()
  assert.equal(b.month.from, b.today.slice(0, 8) + '01')
  assert.equal(b.month.to.slice(0, 7), b.today.slice(0, 7))
  const lastDay = new Date(Date.UTC(Number(b.today.slice(0, 4)), Number(b.today.slice(5, 7)), 0)).getUTCDate()
  assert.equal(b.month.to, `${b.today.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`)
  assert.equal(b.month.days, lastDay, 'February is 28 or 29 days, never 30')
})

test('the comparison numbers come from the PREVIOUS period, not this one', () => {
  // Seeded in last week and last month so a wrong window shows up as a wrong number.
  const b0 = S.appointmentScoreboard()
  const back = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() - n); return t.toISOString().slice(0, 10) }
  const lastWeekDay = back(b0.week.from, 3)          // comfortably inside the previous week
  const lastMonthDay = back(b0.month.from, 5)        // comfortably inside the previous month
  const mk = (bookedDay) => db.run(
    `INSERT INTO calendar_events (title, event_type, event_date, start_time, appt_status, is_sales_appointment, booked_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['Scoreboard fixture', 'showing', bookedDay, '10:00', 'scheduled', 1, S.ctToUtc(bookedDay, '09:00').toISOString()])
  mk(lastWeekDay)
  mk(lastMonthDay)
  const b1 = S.appointmentScoreboard()
  assert.equal(b1.prev_week_set, b0.prev_week_set + 1, 'last week moved by one')
  assert.equal(b1.prev_month_set, b0.prev_month_set + 1, 'last month moved by one')
  assert.equal(b1.week.set, b0.week.set, 'this week did not move')
})

// ---- what the board reports alongside the target ------------------------------------

test('the board carries the outcome counts and the unrecorded queue', () => {
  const b = S.appointmentScoreboard()
  for (const k of ['set', 'held', 'no_show', 'cancelled', 'unrecorded']) {
    assert.equal(typeof b.month[k], 'number', `month.${k} is reported`)
  }
  assert.ok(Array.isArray(b.awaiting_outcome), 'the unrecorded list rides along so the board can prompt')
  assert.equal(typeof b.upcoming, 'number')
  assert.equal(typeof b.needs_confirming, 'number')
})

test('upcoming counts only live sales appointments', () => {
  const b0 = S.appointmentScoreboard()
  const future = (() => { const t = new Date(); t.setUTCDate(t.getUTCDate() + 20); return t.toISOString().slice(0, 10) })()
  const mk = (flag, status) => db.run(
    `INSERT INTO calendar_events (title, event_type, event_date, start_time, appt_status, is_sales_appointment, booked_at)
     VALUES (?,?,?,?,?,?,?)`,
    ['Upcoming fixture', 'showing', future, '10:00', status, flag, S.ctToUtc(future, '09:00').toISOString()])
  mk(0, null)             // a Google calendar entry
  mk(1, 'cancelled')      // cancelled, so not upcoming
  mk(1, 'completed')      // already happened
  assert.equal(S.appointmentScoreboard().upcoming, b0.upcoming, 'none of those are upcoming work')
  mk(1, 'scheduled')
  assert.equal(S.appointmentScoreboard().upcoming, b0.upcoming + 1, 'a live one is')
})

test('the board agrees with appointmentCounts for the same window', () => {
  // The whole point of one definition: if these ever disagree, two screens are lying.
  const b = S.appointmentScoreboard()
  const direct = S.appointmentCounts(b.week.from, b.week.to)
  for (const k of ['set', 'held', 'no_show', 'cancelled', 'unrecorded']) {
    assert.equal(b.week[k], direct[k], `week.${k} matches the counting function`)
  }
  restore()
})
