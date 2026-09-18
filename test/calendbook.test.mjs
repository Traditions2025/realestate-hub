// Calendbook webhook intake: raw payloads always logged; the miner finds
// contact + time across plausible payload shapes; booking creates a Hub
// appointment tied to the deduped lead; cancellation matches by external id;
// no Hub confirmations/reminders are sent (Calendbook owns those).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const cb = await import('../server/calendbook.js')
cb.initCalendbook()

const seeded = { events: [], clients: [], logs: [] }
const uniq = Date.now() + '' + Math.floor(Math.random() * 1e5)

test('miner handles a Calendly-like nested payload', () => {
  const m = cb.mineCalendbookPayload({
    event: { uid: 'bk_1', start_time: '2027-06-15T15:00:00Z', end_time: '2027-06-15T15:15:00Z', title: 'Seller Consultation' },
    invitee: { name: 'Pat Example', email: 'pat@example.com', phone_number: '(319) 555-1234' },
  })
  assert.equal(m.email, 'pat@example.com')
  assert.equal(m.first, 'Pat'); assert.equal(m.last, 'Example')
  assert.ok(m.start.startsWith('2027-06-15T15:00'))
  assert.equal(m.type_name, 'Seller Consultation')
  assert.equal(m.external_id, 'bk_1')
})

test('miner handles a flat payload', () => {
  const m = cb.mineCalendbookPayload({ name: 'Sam Q', email: 'sam@x.io', phone: '3195559876', start: '2027-06-16T14:30:00-05:00', title: 'Walkthrough' })
  assert.equal(m.phone, '3195559876')
  assert.ok(m.start)
})

test('booking webhook creates lead + appointment + automation event; cancellation matches by id', async () => {
  const email = `cbtest${uniq}@test.local`
  const r = await cb.handleCalendbookWebhook('booking', {
    event: { uid: 'cbid_' + uniq, start_time: '2027-06-15T15:00:00Z', title: 'CB Test Type' },
    invitee: { name: 'Calendbook Tester', email },
  })
  assert.ok(r.event_id)
  seeded.events.push(r.event_id); seeded.clients.push(r.client_id)
  const e = db.get('SELECT * FROM calendar_events WHERE id=?', [r.event_id])
  assert.equal(e.appt_status, 'scheduled')
  assert.equal(e.source, 'Calendbook')
  assert.equal(e.event_date, '2027-06-15')
  assert.equal(e.start_time, '10:00')   // 15:00Z = 10:00 CDT
  assert.equal(db.get('SELECT COUNT(*) c FROM appointment_reminders WHERE event_id=?', [r.event_id]).c, 0)  // Calendbook owns reminders
  assert.ok(db.get("SELECT id FROM automation_events WHERE event_type='appointment.booked' AND client_id=?", [r.client_id]))
  // duplicate contact: same email books again -> same client
  const r2 = await cb.handleCalendbookWebhook('booking', { event: { uid: 'cbid2_' + uniq, start_time: '2027-06-16T15:00:00Z', title: 'CB Test Type' }, invitee: { name: 'Calendbook Tester', email } })
  seeded.events.push(r2.event_id)
  assert.equal(r2.client_id, r.client_id)
  assert.equal(r2.matched, 'email')
  // cancellation by external id
  const rc = await cb.handleCalendbookWebhook('cancellation', { event: { uid: 'cbid_' + uniq }, reason: 'changed plans' })
  assert.equal(rc.cancelled, r.event_id)
  assert.equal(db.get('SELECT appt_status FROM calendar_events WHERE id=?', [r.event_id]).appt_status, 'cancelled')
})

test('raw payloads are always logged, even unparseable ones', async () => {
  const before = db.get('SELECT COUNT(*) c FROM calendbook_webhook_log').c
  await cb.handleCalendbookWebhook('booking', { junk: true })
  assert.equal(db.get('SELECT COUNT(*) c FROM calendbook_webhook_log').c, before + 1)
})

test('cleanup', () => {
  for (const id of seeded.events) db.run('DELETE FROM calendar_events WHERE id=?', [id])
  for (const id of seeded.clients) { db.run('DELETE FROM clients WHERE id=?', [id]); db.run('DELETE FROM automation_events WHERE client_id=?', [id]); db.run("DELETE FROM activity_log WHERE entity_type='client' AND entity_id=?", [id]) }
  db.run("DELETE FROM calendbook_webhook_log WHERE payload LIKE ?", ['%' + uniq + '%'])
  db.run("DELETE FROM calendbook_webhook_log WHERE payload = '{\"junk\":true}'")
})
