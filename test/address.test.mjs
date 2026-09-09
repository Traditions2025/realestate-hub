// Paste-a-full-address parsing on the lead profile: split + case fixing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { smartParseAddress } = await import('../server/routes/clients.js')

test('ALL CAPS full address splits and re-cases', () => {
  const r = smartParseAddress('3191 SILVER OAK TRL, MARION, IA 52302')
  assert.deepEqual(r, { address: '3191 Silver Oak Trl', city: 'Marion', state: 'IA', zip: '52302' })
})

test('directionals and ordinals survive casing', () => {
  const r = smartParseAddress('5101 1ST AVE SW, CEDAR RAPIDS, IOWA 52404')
  assert.equal(r.address, '5101 1st Ave SW')
  assert.equal(r.city, 'Cedar Rapids')
  assert.equal(r.state, 'IA')
  assert.equal(r.zip, '52404')
})

test('two-part form "street, City ST zip"', () => {
  const r = smartParseAddress('600 Carlton Rd SE, Cedar Rapids IA 52403')
  assert.deepEqual(r, { address: '600 Carlton Rd SE', city: 'Cedar Rapids', state: 'IA', zip: '52403' })
})

test('four-part form with separate state and zip', () => {
  const r = smartParseAddress('1040 2ND AVE, MARION, IA, 52302')
  assert.deepEqual(r, { address: '1040 2nd Ave', city: 'Marion', state: 'IA', zip: '52302' })
})

test('plain street stays street; all-lowercase is re-cased; mixed case is respected', () => {
  assert.deepEqual(smartParseAddress('190 cottage grove ave se unit#302'), { address: '190 Cottage Grove Ave SE Unit#302' })
  const mixed = smartParseAddress('123 McAllister Ln')
  assert.equal(mixed.address, '123 McAllister Ln')
  assert.equal(mixed.city, undefined)
})

test('zip+4 keeps the 5-digit zip', () => {
  const r = smartParseAddress('77 Oak St, Marion, IA 52302-1234')
  assert.equal(r.zip, '52302')
})
