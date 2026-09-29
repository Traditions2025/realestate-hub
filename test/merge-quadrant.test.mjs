// Two things the all-one-case tidier could not see, both caught in a live preview of the
// first five home-value enrollments.
//
// 1. "3025 Towne House Dr Ne" was already mixed case, so it was left alone and reached a
//    subject line as "What could 3025 Towne House Dr Ne be worth today?". 10,479 records
//    in the file carry a quadrant written that way.
// 2. 782 rows had the street's quadrant sitting alone in the city column ("600 Nilsen Rd"
//    with city "Ne"), which would have greeted someone as living in "Ne".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usableStreet, usableCity } from '../server/routes/email.js'

test('a quadrant is uppercased even when the rest of the address is fine', () => {
  assert.equal(usableStreet('3025 Towne House Dr Ne'), '3025 Towne House Dr NE')
  assert.equal(usableStreet('2025 Larry Dr Ne'), '2025 Larry Dr NE')
  assert.equal(usableStreet('54 Fleetwood Rd Nw'), '54 Fleetwood Rd NW')
  assert.equal(usableStreet('900 2nd St Se Apt 403'), '900 2nd St SE Apt 403')
  assert.equal(usableStreet('6346 Quail Ridge Dr Sw'), '6346 Quail Ridge Dr SW')
})

test('an already-correct quadrant is unchanged', () => {
  assert.equal(usableStreet('7101 Lindsey Grove Rd NE'), '7101 Lindsey Grove Rd NE')
  assert.equal(usableStreet('440 Norwick Rd SW'), '440 Norwick Rd SW')
})

test('an all-caps address still gets title-cased, quadrant included', () => {
  assert.equal(usableStreet('1117 DEER RUN DRIVE NORTHEAST'), '1117 Deer Run Drive Northeast')
  assert.equal(usableStreet('7101 LINDSEY GROVE RD NE'), '7101 Lindsey Grove Rd NE')
  assert.equal(usableStreet('3060 MCGOWAN BOULEVARD'), '3060 McGowan Boulevard')
})

test('a bare quadrant in the city column is not a town', () => {
  for (const q of ['Ne', 'NE', 'ne', 'Sw', 'se', 'nw'])
    assert.equal(usableCity(q), '', JSON.stringify(q) + ' is a street suffix, not a place')
})

test('a real town that merely contains a quadrant tail is kept', () => {
  assert.equal(usableCity('Cedar Rapids'), 'Cedar Rapids')
  assert.equal(usableCity('Newhall'), 'Newhall')     // starts with "Ne" but is a word
  assert.equal(usableCity('Swisher'), 'Swisher')     // starts with "Sw"
  assert.equal(usableCity('CEDAR RAPIDS'), 'Cedar Rapids')
})

test('a quadrant that is part of a longer city value is uppercased, not dropped', () => {
  assert.equal(usableCity('Nw Cedar Rapids'), 'NW Cedar Rapids')
})
