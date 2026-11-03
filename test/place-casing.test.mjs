// City and street casing (John, 2026-11-03). A CSV import in May left 148 records
// shouting ("CEDAR RAPIDS"), and the Sierra sync kept making more: its backfill writes
// Sierra's own copy into any Hub field that is empty, which re-created one DURING the
// cleanup (#29902 "GRAND MOUND"). One casing rule now serves the address parser, the
// client PUT and the sync, so a street typed in and the same street arriving from
// Sierra come out alike.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { tidyPlace } = await import('../server/routes/email.js')
const { smartParseAddress } = await import('../server/routes/clients.js')
const { processLead } = await import('../server/sierra-helper.js')

let seq = 0
const sid = () => `case${Date.now()}${++seq}`

test('an ALL-CAPS city becomes a normal city', () => {
  assert.equal(tidyPlace('CEDAR RAPIDS'), 'Cedar Rapids')
  assert.equal(tidyPlace('WEST DES MOINES'), 'West Des Moines')
  assert.equal(tidyPlace('ELY'), 'Ely')
})

test('an all-lowercase city is raised too', () => {
  assert.equal(tidyPlace('cedar rapids'), 'Cedar Rapids')
  assert.equal(tidyPlace('marion'), 'Marion')
})

test('a city someone shaped deliberately is left exactly alone', () => {
  // The whole point of the one-case test: mixed case means a human chose it.
  assert.equal(tidyPlace('Cedar Rapids'), 'Cedar Rapids')
  assert.equal(tidyPlace('McGregor'), 'McGregor')
  assert.equal(tidyPlace('LeClaire'), 'LeClaire')
})

test('directionals keep shouting, ordinals stay lowercase', () => {
  assert.equal(tidyPlace('4905 WINDY MEADOW CIR NE'), '4905 Windy Meadow Cir NE')
  assert.equal(tidyPlace('5101 1ST AVE SW'), '5101 1st Ave SW')
  assert.equal(tidyPlace('1625 RANMAR DR'), '1625 Ranmar Dr')
  assert.equal(tidyPlace('7010 WALDEN ROAD NORTHEAST'), '7010 Walden Road Northeast')
})

test('an address that is already correct is not disturbed', () => {
  // These exist in the file as lowercase ordinals with no street type. Correct as-is.
  assert.equal(tidyPlace('1100 18th'), '1100 18th')
  assert.equal(tidyPlace('3314 35th'), '3314 35th')
})

test('empty and missing values survive the trip', () => {
  assert.equal(tidyPlace(null), null)
  assert.equal(tidyPlace(''), '')
  assert.equal(tidyPlace('   '), '   ')
})

test('the address parser still cases through the same rule', () => {
  const r = smartParseAddress('3191 SILVER OAK TRL, MARION, IA 52302')
  assert.equal(r.address, '3191 Silver Oak Trl')
  assert.equal(r.city, 'Marion')
  assert.equal(r.state, 'IA')
})

test('the Sierra sync no longer backfills a SHOUTING city into an empty field', () => {
  const s = sid()
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, sierra_lead_id, address, city)
                    VALUES ('Emma','Dolde','buyer','new',?,NULL,NULL)`, [String(s)])
  processLead({
    id: s, firstName: 'Emma', lastName: 'Dolde', leadStatus: 'Active',
    streetAddress: '702 SMITH ST', city: 'GRAND MOUND', state: 'IA', zip: '52751', tags: [],
  })
  const c = db.get('SELECT address, city FROM clients WHERE id=?', [r.lastInsertRowid])
  assert.equal(c.city, 'Grand Mound', 'backfilled city is cased on the way in')
  assert.equal(c.address, '702 Smith St')
})

test('a NEW Sierra lead is inserted already cased', () => {
  const s = sid()
  processLead({
    id: s, firstName: 'Carrie', lastName: 'Freund', leadStatus: 'New',
    streetAddress: '4905 WINDY MEADOW CIR NE', city: 'CEDAR RAPIDS', state: 'IA', zip: '52411', tags: [],
  })
  const c = db.get('SELECT address, city FROM clients WHERE sierra_lead_id=?', [String(s)])
  assert.ok(c, 'created')
  assert.equal(c.city, 'Cedar Rapids')
  assert.equal(c.address, '4905 Windy Meadow Cir NE')
})

test('a Hub city already set is still never overwritten by the sync', () => {
  // Casing on the way in must not turn the backfill into a general overwrite.
  const s = sid()
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, sierra_lead_id, city)
                    VALUES ('Hub','Owned','buyer','new',?,'Marion')`, [String(s)])
  processLead({ id: s, firstName: 'Hub', lastName: 'Owned', leadStatus: 'Active', city: 'CEDAR RAPIDS', tags: [] })
  assert.equal(db.get('SELECT city FROM clients WHERE id=?', [r.lastInsertRowid]).city, 'Marion')
})
