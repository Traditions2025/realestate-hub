// An address merge field can land in a SUBJECT LINE, so a bad record reads as nonsense
// rather than as a blank. These pin the rules that keep every such record sending a
// sentence that still makes sense, using the real broken values found in the Hub.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableStreet, usableCity } from '../server/routes/email.js'

test('a real street line is returned untouched', () => {
  for (const a of ['1428 Oakwood Dr', '190 Cottage Grove Ave SE Unit#302',
    '3495 McGowan Blvd', '10000 W Cemetary Rd'])
    assert.equal(usableStreet(a), a)
  // the one exception: a lower-case quadrant is corrected, never passed through
  assert.equal(usableStreet('632 Olive Dr Nw'), '632 Olive Dr NW')
})

test('a street named after a state is not mistaken for a jammed address', () => {
  // the exact false alarms the audit turned up
  for (const a of ['3300 Iowa Ave SE', '647 S Wisconsin St',
    '301 W Illinois St', '947 Iowa Ave'])
    assert.equal(usableStreet(a), a, a + ' is a real address and must survive')
  // survives the trim, and the quadrant is corrected on the way through
  assert.equal(usableStreet('2449 Wisconsin St Sw'), '2449 Wisconsin St SW')
})

test('a jammed city/state/zip is trimmed back to the street', () => {
  assert.equal(usableStreet('180 Rosedale Road Marion IA 52302'), '180 Rosedale Road')
  assert.equal(usableStreet('440 Norwick Rd Sw Cedar Rapids IA 52404'), '440 Norwick Rd SW')
  assert.equal(usableStreet('10000 W Cemetary Rd Fairfax, IA 52228'), '10000 W Cemetary Rd')
  assert.equal(usableStreet('1607 21st Street, Cedar Rapids, IA 52405'), '1607 21st Street')
  assert.equal(usableStreet('295 circle dr\nWalford, Iowa'), '295 circle dr')
})

test('anything that is not a street line gives nothing, so the copy falls back', () => {
  for (const a of ['Po Box 165', 'PO BOX 3346', 'None', 'n/a', 'unknown', '', null, undefined,
    '3226', '  ', 'Kurt', 'someone@example.com'])
    assert.equal(usableStreet(a), '', JSON.stringify(a) + ' must not reach a subject line')
})

test('a real town is returned, tidied', () => {
  assert.equal(usableCity('Marion'), 'Marion')
  assert.equal(usableCity('Cedar Rapids,'), 'Cedar Rapids')
  assert.equal(usableCity('Cedar Rapids,IA'), 'Cedar Rapids')
  assert.equal(usableCity(' Hiawatha '), 'Hiawatha')
})

test('a saved-search area list collapses to their own town', () => {
  assert.equal(usableCity('Cedar Rapids,|Center Point,IA|Fairfax,IA|Marion,IA'), 'Cedar Rapids')
  assert.equal(usableCity('|Hiawatha'), 'Hiawatha')
})

test('a street or a state in the city column gives nothing', () => {
  for (const c of ['500 1st', '1701 C Ave', '2870 Winchester', 'IA', 'Iowa', '', null, 'none'])
    assert.equal(usableCity(c), '', JSON.stringify(c) + ' is not a town')
})

test('the fallbacks read as sentences, which is the whole point', () => {
  const subject = (addr) => 'What could ' + (usableStreet(addr) || 'your home') + ' be worth today?'
  assert.equal(subject('1428 Oakwood Dr'), 'What could 1428 Oakwood Dr be worth today?')
  assert.equal(subject('Po Box 165'), 'What could your home be worth today?')
  assert.equal(subject('None'), 'What could your home be worth today?')
  const line = (city) => 'buyer demand around ' + (usableCity(city) || 'your area') + ' can all influence'
  assert.equal(line('Marion'), 'buyer demand around Marion can all influence')
  assert.equal(line('500 1st'), 'buyer demand around your area can all influence')
})
