// Appointment scheduling engine (John, 2026-09-18) — the critical behaviors:
// slots come only from real availability; busy events, buffers, notice, horizon
// and exceptions all block correctly; booking is atomic (the same slot can never
// be taken twice); cancel frees the slot; reschedule frees old + reserves new;
// CT<->UTC conversion is DST-correct; lead dedupe never merges on name; reminder
// rows dedupe; manage tokens are unguessable.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const m = await import('../server/scheduling.js')
m.initScheduling()

const seeded = { events: [], clients: [], types: [], avail: [], exc: [] }
const MEMBER = 'TestSched Member'

// Deterministic future weekdays (Tue/Wed, no DST edge): June 2027.
const TUE = '2027-06-15', WED = '2027-06-16'

function mkType(over = {}) {
  const slug = 'test-sched-' + Date.now() + Math.floor(Math.random() * 1e5)
  const r = db.run(`INSERT INTO appointment_types (name, public_title, slug, duration_min, team_members, min_notice_hours, max_days_ahead, buffer_before_min, buffer_after_min, windows_json, active)
    VALUES (?,?,?,?,?,?,?,?,?,?,1)`,
    [over.name || 'Test Type', 'Test', slug, over.duration_min ?? 30, JSON.stringify([MEMBER]),
     over.min_notice_hours ?? 0, over.max_days_ahead ?? 400, over.buffer_before_min ?? 0, over.buffer_after_min ?? 0,
     over.windows_json !== undefined ? over.windows_json : null])
  seeded.types.push(r.lastInsertRowid)
  return db.get('SELECT * FROM appointment_types WHERE id=?', [r.lastInsertRowid])
}
function mkClient() {
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, phone, email, created_at, updated_at)
    VALUES ('Sched','Test${Date.now()}${Math.floor(Math.random() * 1e6)}','seller','new',?,?,?,?)`,
    ['(319) 555-' + String(Math.floor(Math.random() * 9000) + 1000), `sched${Date.now()}${Math.floor(Math.random() * 1e5)}@test.local`, new Date().toISOString(), new Date().toISOString()])
  seeded.clients.push(r.lastInsertRowid)
  return r.lastInsertRowid
}
// Member availability: Tue+Wed 9:00-12:00 only (isolated member, no cross-talk).
for (const wd of [2, 3]) {
  const r = db.run('INSERT INTO team_availability (team_member, weekday, start_min, end_min) VALUES (?,?,?,?)', [MEMBER, wd, 540, 720])
  seeded.avail.push(r.lastInsertRowid)
}

test('open slots appear inside the working window only', () => {
  const t = mkType()
  const slots = m.slotsForDate(t, TUE).map(s => s.time)
  assert.ok(slots.includes('09:00'))
  assert.ok(slots.includes('11:30'))
  assert.ok(!slots.includes('12:00'))   // 12:00 + 30min exceeds the 12:00 end
  assert.ok(!slots.includes('08:30'))
})

test('weekend/no-window days have no slots; horizon caps the future', () => {
  const t = mkType()
  assert.equal(m.slotsForDate(t, '2027-06-19').length, 0)      // Saturday
  const short = mkType({ max_days_ahead: 5 })
  assert.equal(m.slotsForDate(short, TUE).length, 0)           // far beyond 5-day horizon
})

test('an existing appointment blocks the overlapping slot; buffers block adjacent times', () => {
  const t = mkType({ buffer_after_min: 30, buffer_before_min: 0 })
  const cid = mkClient()
  const r = m.bookAppointment({ type: t, dateStr: TUE, time: '10:00', client_id: cid })
  seeded.events.push(r.id)
  const slots = m.slotsForDate(t, TUE).map(s => s.time)
  assert.ok(!slots.includes('10:00'))   // taken
  assert.ok(!slots.includes('10:30'))   // 30-min after-buffer
  assert.ok(slots.includes('09:00'))    // earlier still open (no before-buffer)
  assert.ok(slots.includes('11:00'))    // clear of the buffer
})

test('double booking the same slot is impossible', () => {
  const t = mkType()
  const c1 = mkClient(), c2 = mkClient()
  const r = m.bookAppointment({ type: t, dateStr: WED, time: '09:30', client_id: c1 })
  seeded.events.push(r.id)
  assert.throws(() => m.bookAppointment({ type: t, dateStr: WED, time: '09:30', client_id: c2 }), /just taken/i)
})

test('cancelling frees the slot; rescheduling frees old and reserves new', () => {
  const t = mkType()
  const cid = mkClient()
  const r = m.bookAppointment({ type: t, dateStr: TUE, time: '11:00', client_id: cid })
  seeded.events.push(r.id)
  assert.ok(!m.slotsForDate(t, TUE).some(s => s.time === '11:00'))
  m.rescheduleAppointment(r.id, WED, '10:00')
  assert.ok(m.slotsForDate(t, TUE).some(s => s.time === '11:00'))    // old slot free
  assert.ok(!m.slotsForDate(t, WED).some(s => s.time === '10:00'))   // new slot held
  m.cancelAppointment(r.id, { by: 'test' })
  assert.ok(m.slotsForDate(t, WED).some(s => s.time === '10:00'))    // freed again
  assert.equal(db.get('SELECT appt_status FROM calendar_events WHERE id=?', [r.id]).appt_status, 'cancelled')
})

test('minimum notice hides near-term slots', () => {
  const t = mkType({ min_notice_hours: 24 * 365 * 2 })   // 2 years notice: nothing within horizon qualifies
  assert.equal(m.slotsForDate(t, TUE).length, 0)
})

test('blocked exception removes availability', () => {
  const t = mkType()
  const r = db.run('INSERT INTO availability_exceptions (team_member, date, start_min, end_min, reason) VALUES (?,?,NULL,NULL,?)', [MEMBER, WED, 'vacation'])
  seeded.exc.push(r.lastInsertRowid)
  assert.equal(m.slotsForDate(t, WED).length, 0)
  db.run('DELETE FROM availability_exceptions WHERE id=?', [r.lastInsertRowid])
  assert.ok(m.slotsForDate(t, WED).length > 0)
})

test('type-specific windows intersect member hours', () => {
  // Isolated member (other tests book against MEMBER on these dates).
  const M2 = MEMBER + ' Two'
  const av = db.run('INSERT INTO team_availability (team_member, weekday, start_min, end_min) VALUES (?,?,?,?)', [M2, 2, 540, 720])
  seeded.avail.push(av.lastInsertRowid)
  const t = mkType({ windows_json: JSON.stringify({ 2: [[600, 660]] }) })
  db.run('UPDATE appointment_types SET team_members=? WHERE id=?', [JSON.stringify([M2]), t.id])
  const slots = m.slotsForDate(db.get('SELECT * FROM appointment_types WHERE id=?', [t.id]), TUE).map(s => s.time)
  assert.deepEqual(slots, ['10:00', '10:30'])
})

test('CT->UTC conversion is DST-correct (CST -6 winter, CDT -5 summer)', () => {
  assert.equal(m.ctToUtc('2027-01-15', '09:00').toISOString(), '2027-01-15T15:00:00.000Z')
  assert.equal(m.ctToUtc('2027-07-15', '09:00').toISOString(), '2027-07-15T14:00:00.000Z')
})

test('lead dedupe: id > phone > email; never a name merge; else created', () => {
  const cid = mkClient()
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  assert.deepEqual(m.findOrCreateLead({ lead_id: cid }), { client_id: cid, matched: 'id' })
  assert.equal(m.findOrCreateLead({ phone: c.phone }).matched, 'phone')
  assert.equal(m.findOrCreateLead({ email: c.email.toUpperCase() }).matched, 'email')
  const created = m.findOrCreateLead({ first: c.first_name, last: c.last_name, phone: '(319) 555-0199x' + Date.now() % 1000 })
  seeded.clients.push(created.client_id)
  assert.equal(created.matched, 'created')   // same NAME alone never matches
})

test('reminders dedupe and cancel with the appointment', () => {
  const t = mkType()
  const cid = mkClient()
  const r = m.bookAppointment({ type: t, dateStr: TUE, time: '09:00', client_id: cid })
  seeded.events.push(r.id)
  const count = () => db.get("SELECT COUNT(*) c FROM appointment_reminders WHERE event_id=? AND state='pending'", [r.id]).c
  assert.equal(count(), 4)   // 24h + 2h, sms + email each
  m.createReminders(r.id, t, TUE, '09:00')   // re-run: UNIQUE dedupes
  assert.equal(count(), 4)
  m.cancelAppointment(r.id, { by: 'test' })
  assert.equal(count(), 0)
})

test('manage tokens: unguessable, short/garbage tokens rejected', () => {
  const t = mkType()
  const cid = mkClient()
  const r = m.bookAppointment({ type: t, dateStr: WED, time: '11:00', client_id: cid })
  seeded.events.push(r.id)
  assert.ok(r.token.length >= 30)
  assert.equal(m.getByToken('short'), null)
  assert.equal(m.getByToken('x'.repeat(32)), null)
  assert.equal(m.getByToken(r.token)?.id, r.id)
})

test('booking emits automation events', () => {
  const t = mkType()
  const cid = mkClient()
  const r = m.bookAppointment({ type: t, dateStr: WED, time: '09:00', client_id: cid })
  seeded.events.push(r.id)
  const ev = db.get("SELECT * FROM automation_events WHERE event_type='appointment.booked' AND client_id=? ORDER BY id DESC LIMIT 1", [cid])
  assert.ok(ev, 'appointment.booked event recorded')
})

test('cleanup seeded rows', () => {
  for (const id of seeded.events) { db.run('DELETE FROM calendar_events WHERE id=?', [id]); db.run('DELETE FROM appointment_reminders WHERE event_id=?', [id]) }
  for (const id of seeded.clients) { db.run('DELETE FROM clients WHERE id=?', [id]); db.run("DELETE FROM automation_events WHERE client_id=?", [id]); db.run("DELETE FROM activity_log WHERE entity_type='client' AND entity_id=?", [id]) }
  for (const id of seeded.types) db.run('DELETE FROM appointment_types WHERE id=?', [id])
  for (const id of seeded.avail) db.run('DELETE FROM team_availability WHERE id=?', [id])
  db.run('DELETE FROM availability_exceptions WHERE team_member=?', [MEMBER])
})
