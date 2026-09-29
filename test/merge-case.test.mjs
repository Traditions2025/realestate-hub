// An imported ALL-CAPS address would SHOUT from a subject line — "What could 1117 DEER RUN
// DRIVE NORTHEAST be worth today?" — which reads as spam. 3,441 addresses and 3,841 cities
// in the file are stored that way, so roughly one recipient in eight was affected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableStreet, usableCity } from '../server/routes/email.js'

test('an all-caps address is calmed down', () => {
  assert.equal(usableStreet('1117 DEER RUN DRIVE NORTHEAST'), '1117 Deer Run Drive Northeast')
  assert.equal(usableStreet('2844 HAWKS RIDGE LANE'), '2844 Hawks Ridge Lane')
  assert.equal(usableStreet('2375 OLD LINCOLN HWY'), '2375 Old Lincoln Hwy')
})

test('quadrants stay capitals, because NE is not a word', () => {
  assert.equal(usableStreet('7101 LINDSEY GROVE RD NE'), '7101 Lindsey Grove Rd NE')
  assert.equal(usableStreet('440 NORWICK RD SW'), '440 Norwick Rd SW')
})

test('Mc and O names keep their inner capital', () => {
  assert.equal(usableStreet('3060 MCGOWAN BOULEVARD'), '3060 McGowan Boulevard')
  assert.equal(usableStreet("1200 O'BRIEN ST"), "1200 O'Brien St")
})

test('an address a person typed properly is never touched', () => {
  // '2025 Larry Dr Ne' used to sit in this list. It does not belong here: the quadrant
  // was wrong, and see merge-quadrant.test.mjs for what it should be.
  for (const a of ['1195 Y Dr', '5935 Cedar Ridge Dr',
    '190 Cottage Grove Ave SE Unit#302', '3495 McGowan Blvd'])
    assert.equal(usableStreet(a), a, a + ' was already fine and must be left alone')
})

test('cities get the same treatment', () => {
  assert.equal(usableCity('CEDAR RAPIDS'), 'Cedar Rapids')
  assert.equal(usableCity('MARION'), 'Marion')
  assert.equal(usableCity('Marion'), 'Marion')
  assert.equal(usableCity('Amana'), 'Amana')
})

test('the fallbacks still work, so this did not break the earlier rules', () => {
  assert.equal(usableStreet('PO BOX 3346'), '')
  assert.equal(usableStreet('None'), '')
  assert.equal(usableCity('500 1st'), '')
  assert.equal(usableStreet('180 ROSEDALE ROAD MARION IA 52302'), '180 Rosedale Road')
})
