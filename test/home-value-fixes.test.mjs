// Three faults found on 2026-10-27 chasing one home value request (James Osullivan).
// None of them threw, none of them logged, and all three were invisible in the Hub:
//   1. the client timeline returned an error for EVERY client in the database
//   2. a canceled condition-question blocked the real one forever
//   3. a different phone number on the form was silently discarded
import test from 'node:test'
import assert from 'node:assert'
import db, { initDb } from '../server/database.js'

await initDb()
const HV = await import('../server/home-value-intake.js')

const BASE = 994300
let seq = 0
const nowIso = () => new Date().toISOString()

function mkLead({ phone = '(319) 431-4988', alt = null, labels = null } = {}) {
  const id = BASE + (++seq)
  db.run('DELETE FROM scheduled_texts WHERE client_id=?', [id])
  db.run('DELETE FROM activity_log WHERE entity_type=? AND entity_id=?', ['client', id])
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, email, phone, alt_phones, alt_phone_labels, type, status, source, tags, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,'buyer','new','Realist','[]',?,?)`,
  [id, 'Hv', 'Case' + seq, `hv${id}@example.com`, phone, alt, labels, nowIso(), nowIso()])
  return id
}
const condText = (id, status) =>
  db.run("INSERT INTO scheduled_texts (client_id, phone, body, send_at, status, created_by, created_at) VALUES (?,?,?,?,?,?,?)",
    [id, '(319) 431-4988', 'On a scale of 1 to 10, how would you rate your home’s overall condition?', nowIso(), status, 'test', nowIso()])

// ---- 1. the timeline must not be taken down by one bad column --------------------

test('the client timeline builds for a lead with a transaction and a showing', () => {
  const id = mkLead()
  db.run("INSERT INTO transactions (client_id, property_address, property_status) VALUES (?,?,?)",
    [id, '1226 Wolf Dr NW', 'Under Contract'])
  db.run("INSERT INTO showings (client_id, address, showing_date, interest_level) VALUES (?,?,?,?)",
    [id, '1226 Wolf Dr NW', nowIso(), 'High'])
  // The exact queries the timeline route runs. Either one throwing used to return
  // {"error":"no such column: status"} for every client in the Hub.
  assert.doesNotThrow(() => {
    db.all("SELECT showing_date, interest_level, address FROM showings WHERE client_id=? ORDER BY showing_date DESC LIMIT 40", [id])
    db.all("SELECT id, property_status, property_address, updated_at, created_at FROM transactions WHERE client_id=? ORDER BY updated_at DESC LIMIT 20", [id])
  })
  const t = db.get("SELECT property_status, property_address FROM transactions WHERE client_id=?", [id])
  assert.equal(t.property_status, 'Under Contract')
  assert.equal(t.property_address, '1226 Wolf Dr NW')
})

test('showings carry interest_level, not status — selecting status still throws', () => {
  // Proves the check bites: if someone reintroduces `status` here, this fails.
  assert.throws(() => db.all("SELECT status FROM showings LIMIT 1"), /no such column/)
})

// ---- 2. only a question they actually got may block the next one -----------------

test('a question that was SENT blocks a second one', () => {
  const id = mkLead()
  condText(id, 'sent')
  const c = db.get('SELECT * FROM clients WHERE id=?', [id])
  const r = HV.scheduleConditionQuestion(c)
  assert.equal(r.ok, false)
  assert.match(r.reason, /already asked/)
})

test('a question still SCHEDULED blocks a second one', () => {
  const id = mkLead()
  condText(id, 'scheduled')
  const r = HV.scheduleConditionQuestion(db.get('SELECT * FROM clients WHERE id=?', [id]))
  assert.equal(r.ok, false)
})

test('a CANCELED question does not block — they never received it', () => {
  const id = mkLead()
  condText(id, 'canceled')
  const r = HV.scheduleConditionQuestion(db.get('SELECT * FROM clients WHERE id=?', [id]))
  assert.equal(r.ok, true, r.reason)
})

test('a FAILED question does not block either', () => {
  const id = mkLead()
  condText(id, 'failed')
  const r = HV.scheduleConditionQuestion(db.get('SELECT * FROM clients WHERE id=?', [id]))
  assert.equal(r.ok, true, r.reason)
})

// ---- 3. a different number on the form is kept, not discarded --------------------

test('a new number from the form is kept as an alt, and never overwrites the known one', async () => {
  const id = mkLead({ phone: '(319) 431-4988' })
  const c = db.get('SELECT * FROM clients WHERE id=?', [id])
  await HV.handleHomeValueSubmission({
    email: c.email, first_name: 'Hv', last_name: 'Case', phone: '(319) 321-0659',
    address: '1226 Wolf Dr NW', city: 'Cedar Rapids', state: 'IA', zip: '52405',
    submitted_label: '10/27/2026 03:25 PM', request_type: 'Seller CMA Request',
  }, { submittedAt: nowIso(), recordOnly: true })
  const after = db.get('SELECT phone, alt_phones, alt_phone_labels FROM clients WHERE id=?', [id])
  assert.equal(after.phone, '(319) 431-4988', 'the known number must survive')
  assert.match(String(after.alt_phones || ''), /\(319\) 321-0659/, 'the submitted number must be kept')
  assert.match(String(after.alt_phone_labels || ''), /Home value form/)
})

test('the same number submitted again is not duplicated into alts', async () => {
  const id = mkLead({ phone: '(319) 431-4988' })
  const c = db.get('SELECT * FROM clients WHERE id=?', [id])
  await HV.handleHomeValueSubmission({
    email: c.email, first_name: 'Hv', last_name: 'Case', phone: '319-431-4988',
    submitted_label: '10/27/2026 04:00 PM',
  }, { submittedAt: nowIso(), recordOnly: true })
  const after = db.get('SELECT alt_phones FROM clients WHERE id=?', [id])
  assert.ok(!String(after.alt_phones || '').trim(), 'same number in a different format is not an alt')
})

// ---- 4. asking what your home is worth is seller intent (John, 2026-10-28) ----
//
// A lead created BY the intake was always typed seller; an existing one kept whatever it
// arrived as. That is how ten homeowners sat on the Home Value list typed `buyer`, mostly
// Realist imports where the type records where the record came from, not what the person
// wants. `type` drives campaign routing and the FUB stage mapping, so it is not cosmetic.

const submit = (id, label) => HV.handleHomeValueSubmission({
  email: db.get('SELECT email FROM clients WHERE id=?', [id]).email,
  first_name: 'Hv', last_name: 'Case', submitted_label: label,
  address: '1 Test St', city: 'Cedar Rapids', state: 'IA', zip: '52402',
}, { submittedAt: nowIso(), recordOnly: true })

const typeOf = (id) => String(db.get('SELECT type FROM clients WHERE id=?', [id]).type || '').toLowerCase()

test('a buyer who requests a home value becomes a seller', async () => {
  const id = mkLead()
  db.run("UPDATE clients SET type='buyer' WHERE id=?", [id])
  await submit(id, '10/28/2026 09:00 AM')
  assert.equal(typeOf(id), 'seller')
})

test('"both" is left alone — flipping it would throw the buyer half away', async () => {
  const id = mkLead()
  db.run("UPDATE clients SET type='both' WHERE id=?", [id])
  await submit(id, '10/28/2026 09:05 AM')
  assert.equal(typeOf(id), 'both')
})

test('a seller stays a seller, and no pointless write is logged', async () => {
  const id = mkLead()
  db.run("UPDATE clients SET type='seller' WHERE id=?", [id])
  await submit(id, '10/28/2026 09:10 AM')
  assert.equal(typeOf(id), 'seller')
  const logged = db.get("SELECT COUNT(*) c FROM activity_log WHERE entity_id=? AND action='type_changed'", [id]).c
  assert.equal(logged, 0)
})

test('the switch is recorded, so it is visible on the timeline', async () => {
  const id = mkLead()
  db.run("UPDATE clients SET type='buyer' WHERE id=?", [id])
  await submit(id, '10/28/2026 09:15 AM')
  const row = db.get("SELECT details FROM activity_log WHERE entity_id=? AND action='type_changed'", [id])
  assert.ok(row, 'a type change must leave a trail')
  assert.match(row.details, /buyer -> seller/)
})
