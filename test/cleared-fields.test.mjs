// Emptying a contact field is a decision the sync must respect (John, 2026-11-04).
//
// The Sierra backfill fills any blank contact field from Sierra's copy. It could not tell
// "we never had one" from "John deleted it this morning", so a deleted address came
// straight back: Amy Oberfoell #118 cleared hers at 11:26 and the 11:57 sync pass put it
// back. clients.cleared_fields records the deliberate deletions; the backfill skips them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { processLead, BACKFILLED_FIELDS } = await import('../server/sierra-helper.js')

let seq = 0
const sid = () => `clr${Date.now()}${++seq}`
const lead = (id, over = {}) => ({
  id, firstName: 'Amy', lastName: 'Oberfoell', leadStatus: 'Active',
  streetAddress: '4600 Deer View Rd', city: 'Cedar Rapids', state: 'IA', zip: '52403',
  email: 'amy@example.com', phone: '(319) 555-7788', tags: [], ...over,
})
const mk = (sierraId, fields = {}) => db.run(
  `INSERT INTO clients (first_name, last_name, type, status, sierra_lead_id, address, city, state, zip, email, phone, cleared_fields)
   VALUES ('Amy','Oberfoell','buyer','closed',?,?,?,?,?,?,?,?)`,
  [String(sierraId), fields.address ?? null, fields.city ?? null, fields.state ?? null,
    fields.zip ?? null, fields.email ?? null, fields.phone ?? null, fields.cleared_fields ?? null]).lastInsertRowid

test('a blank field with no deletion on record is still backfilled', () => {
  const s = sid()
  const id = mk(s)
  processLead(lead(s))
  const c = db.get('SELECT address, city, zip FROM clients WHERE id=?', [id])
  assert.equal(c.address, '4600 Deer View Rd', 'a genuine gap still fills from Sierra')
  assert.equal(c.city, 'Cedar Rapids')
  assert.equal(c.zip, '52403')
})

test('a field emptied on purpose STAYS empty through a sync', () => {
  const s = sid()
  const id = mk(s, { cleared_fields: JSON.stringify(['address', 'city', 'state', 'zip']) })
  processLead(lead(s))
  const c = db.get('SELECT address, city, state, zip FROM clients WHERE id=?', [id])
  assert.equal(c.address, null, 'the deleted address is not resurrected')
  assert.equal(c.city, null)
  assert.equal(c.state, null)
  assert.equal(c.zip, null)
})

test('clearing one field does not freeze the others', () => {
  const s = sid()
  const id = mk(s, { cleared_fields: JSON.stringify(['address']) })
  processLead(lead(s))
  const c = db.get('SELECT address, city, email, phone FROM clients WHERE id=?', [id])
  assert.equal(c.address, null, 'only the address was deleted')
  assert.equal(c.city, 'Cedar Rapids', 'city was simply missing, so it fills')
  assert.equal(c.email, 'amy@example.com')
  assert.equal(c.phone, '(319) 555-7788')
})

test('a cleared email still refuses the notvalidemail placeholder', () => {
  // The two guards are independent: neither should disable the other.
  const s = sid()
  const id = mk(s, { cleared_fields: JSON.stringify(['email']) })
  processLead(lead(s, { email: 'x@notvalidemail.com' }))
  assert.equal(db.get('SELECT email FROM clients WHERE id=?', [id]).email, null)
})

test('a value still on the record is untouched either way', () => {
  const s = sid()
  const id = mk(s, { address: '10 Hub St', cleared_fields: JSON.stringify(['address']) })
  processLead(lead(s))
  assert.equal(db.get('SELECT address FROM clients WHERE id=?', [id]).address, '10 Hub St')
})

test('the field list the PUT writes is the field list the sync reads', () => {
  assert.deepEqual(BACKFILLED_FIELDS, ['phone', 'email', 'address', 'city', 'state', 'zip'])
})

test('the PUT records a deletion and forgets it once a real value is typed in', async () => {
  // Mirrors the bookkeeping in routes/clients.js against the data it produces.
  const s = sid()
  const id = mk(s, { address: '4600 Deer View Rd' })
  const apply = (fields) => {
    const before = db.get('SELECT address, city, cleared_fields FROM clients WHERE id=?', [id])
    const was = new Set(JSON.parse(before.cleared_fields || '[]'))
    for (const f of BACKFILLED_FIELDS) {
      if (!(f in fields)) continue
      const now = String(fields[f] ?? '').trim()
      if (!now && String(before[f] ?? '').trim()) was.add(f)
      else if (now) was.delete(f)
    }
    const sets = Object.keys(fields).map(k => `${k}=?`).join(', ')
    db.run(`UPDATE clients SET ${sets}, cleared_fields=? WHERE id=?`,
      [...Object.values(fields), was.size ? JSON.stringify([...was]) : null, id])
  }
  apply({ address: '' })
  assert.deepEqual(JSON.parse(db.get('SELECT cleared_fields c FROM clients WHERE id=?', [id]).c), ['address'])
  processLead(lead(s))
  assert.equal(db.get('SELECT address FROM clients WHERE id=?', [id]).address, '', 'stays cleared')

  apply({ address: '900 New St' })
  assert.equal(db.get('SELECT cleared_fields c FROM clients WHERE id=?', [id]).c, null, 'no longer a deletion')
})
