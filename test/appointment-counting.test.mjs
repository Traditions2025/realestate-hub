// WHAT COUNTS AS AN APPOINTMENT (John, 2026-11-10) — Appointment Command Center, phase 1.
//
// The Hub booked five real appointments between September and November and reported zero,
// every day, because the booking route wrote a calendar row and never an appointment
// status. The dashboard said "appointments today: 0" while appointments were being made
// through it.
//
// So these tests are about the counting rules rather than the plumbing, because the
// plumbing was never the thing that was wrong. Two of them are the traps the spec calls
// out by name: a rescheduled appointment must count ONCE, and an internal calendar entry
// must never count at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const S = await import('../server/scheduling.js')
S.initScheduling()

let seq = 0
const uniq = () => `${Date.now()}-${++seq}`

// A date far enough out that no other suite's fixtures share the window.
const DAY = '2031-04-15'
const PRIOR = '2031-04-10'

function mkAppt(o = {}) {
  const id = db.run(
    `INSERT INTO calendar_events (title, event_type, event_date, start_time, related_type, related_id,
       appt_status, is_sales_appointment, booked_at, appt_outcome, team_member)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [o.title || `Appt ${uniq()}`, o.event_type || 'showing', o.event_date || DAY, o.start_time || '10:00',
      o.related_id ? 'client' : null, o.related_id || null,
      o.appt_status === undefined ? 'scheduled' : o.appt_status,
      o.is_sales_appointment === undefined ? 1 : o.is_sales_appointment,
      o.booked_at === undefined ? S.ctToUtc(PRIOR, '09:00').toISOString() : o.booked_at,
      o.appt_outcome || null, o.team_member || 'Matt Smith'],
  ).lastInsertRowid
  return id
}

// ---- eligibility -----------------------------------------------------------------

test('a calendar entry is not an appointment until something says it is', () => {
  // 175 of the 198 rows in production came from Matt's Google feed: alarm notifications,
  // CEU classes, an AAA hearing reminder. Being on a calendar is not being an appointment.
  const before = S.appointmentCounts(PRIOR, PRIOR).set
  mkAppt({ title: 'HYBRID Hard Money Lending (1 CEU)', is_sales_appointment: 0, appt_status: null })
  mkAppt({ title: 'Alarm notification', is_sales_appointment: 0, appt_status: null })
  assert.equal(S.appointmentCounts(PRIOR, PRIOR).set, before, 'neither one counts')
})

test('a booking made through the Hub does count', () => {
  const before = S.appointmentCounts(PRIOR, PRIOR).set
  mkAppt({})
  assert.equal(S.appointmentCounts(PRIOR, PRIOR).set, before + 1)
})

// ---- the reschedule trap ---------------------------------------------------------

test('rescheduling twice still counts as ONE appointment set', () => {
  const booked = S.ctToUtc(PRIOR, '09:00').toISOString()
  const before = S.appointmentCounts(PRIOR, PRIOR).set
  const id = mkAppt({ booked_at: booked })

  // Reschedule the way the real route does: move the day, leave booked_at alone.
  db.run("UPDATE calendar_events SET event_date=?, rescheduled_from=? WHERE id=?", ['2031-04-18', `${DAY} 10:00`, id])
  db.run("UPDATE calendar_events SET event_date=?, rescheduled_from=? WHERE id=?", ['2031-04-22', '2031-04-18 10:00', id])

  assert.equal(S.appointmentCounts(PRIOR, PRIOR).set, before + 1, 'still one')
  const row = db.get('SELECT booked_at, rescheduled_from FROM calendar_events WHERE id=?', [id])
  assert.equal(row.booked_at, booked, 'the day it was booked never moves')
  assert.ok(row.rescheduled_from, 'and the history survives')
})

test('set is counted on the day it was BOOKED, not the day it happens', () => {
  const before = S.appointmentCounts(PRIOR, PRIOR).set
  const beforeDay = S.appointmentCounts(DAY, DAY).set
  mkAppt({ booked_at: S.ctToUtc(PRIOR, '14:00').toISOString(), event_date: DAY })
  assert.equal(S.appointmentCounts(PRIOR, PRIOR).set, before + 1, 'counts on the booking day')
  assert.equal(S.appointmentCounts(DAY, DAY).set, beforeDay, 'not on the meeting day')
})

// ---- outcome is separate from status ---------------------------------------------

test('a cancelled appointment is never held', () => {
  const b = S.appointmentCounts(DAY, DAY)
  mkAppt({ appt_status: 'cancelled', event_date: DAY })
  const a = S.appointmentCounts(DAY, DAY)
  assert.equal(a.held, b.held, 'held does not move')
  assert.equal(a.cancelled, b.cancelled + 1)
})

test('completed is not the same as held — only a recorded outcome is', () => {
  // The spec is explicit that a completed appointment does not mean an agreement, and the
  // same gap applies one step earlier: a status of completed is a booking state, not a
  // statement that the meeting happened.
  const b = S.appointmentCounts(DAY, DAY)
  mkAppt({ appt_status: 'completed', appt_outcome: null, event_date: DAY })
  assert.equal(S.appointmentCounts(DAY, DAY).held, b.held, 'status alone never fills held')
})

test('a past appointment with no outcome is unrecorded, not held and not missed', () => {
  const past = '2024-03-04'
  const b = S.appointmentCounts(past, past)
  mkAppt({ event_date: past, appt_outcome: null, appt_status: 'scheduled' })
  const a = S.appointmentCounts(past, past)
  assert.equal(a.held, b.held, 'not counted as held')
  assert.equal(a.no_show, b.no_show, 'and not counted against us either')
  assert.equal(a.unrecorded, b.unrecorded + 1, 'it is reported as needing an answer')
})

// ---- recording an outcome --------------------------------------------------------

test('an outcome needs a person, and lands in held', () => {
  const past = '2024-03-05'
  const b = S.appointmentCounts(past, past)
  const id = mkAppt({ event_date: past })
  assert.throws(() => S.recordOutcome(id, 'held', {}), /person/, 'nobody recorded it = refused')
  assert.throws(() => S.recordOutcome(id, 'went well', { by: 'John' }), /bad outcome/)
  S.recordOutcome(id, 'held', { by: 'John Solamo' })
  const a = S.appointmentCounts(past, past)
  assert.equal(a.held, b.held + 1)
  assert.equal(a.unrecorded, b.unrecorded, 'and it stops asking')
  assert.equal(db.get('SELECT outcome_recorded_by o FROM calendar_events WHERE id=?', [id]).o, 'John Solamo')
})

test('an outcome cannot be put on something that is not a sales appointment', () => {
  const id = mkAppt({ is_sales_appointment: 0, appt_status: null })
  assert.throws(() => S.recordOutcome(id, 'held', { by: 'John' }), /not a sales appointment/)
})

// ---- Central time ----------------------------------------------------------------

test('the day boundary is Central, not UTC', () => {
  // 7pm Central on the 10th is 1am UTC on the 11th. Counting in UTC moves that booking to
  // the wrong day and quietly shifts a whole evening's work into tomorrow.
  const evening = S.ctToUtc(PRIOR, '19:00').toISOString()
  assert.ok(evening.slice(0, 10) > PRIOR, 'the raw instant really is the next UTC day')
  const before = S.appointmentCounts(PRIOR, PRIOR).set
  mkAppt({ booked_at: evening })
  assert.equal(S.appointmentCounts(PRIOR, PRIOR).set, before + 1, 'still counted on the Central day')
})

test('a window covers both of its end days', () => {
  const b = S.appointmentCounts(PRIOR, DAY).set
  mkAppt({ booked_at: S.ctToUtc(PRIOR, '00:30').toISOString() })
  mkAppt({ booked_at: S.ctToUtc(DAY, '23:30').toISOString() })
  assert.equal(S.appointmentCounts(PRIOR, DAY).set, b + 2, 'first minute and last minute both count')
})

// ---- confirmation queue ----------------------------------------------------------

test('only unconfirmed future appointments ask to be confirmed', () => {
  const today = S.ctParts().date
  const id = mkAppt({ event_date: today, appt_status: 'scheduled' })
  const confirmed = mkAppt({ event_date: today, appt_status: 'confirmed' })
  const ids = S.needsConfirming(2).map(r => r.id)
  assert.ok(ids.includes(id), 'the unconfirmed one is asked about')
  assert.ok(!ids.includes(confirmed), 'the confirmed one is left alone')
})
