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

// --- Round 2: the classes a wider audit turned up after the quadrant pass -------------
// Same principle as the quadrant: these are wrong in any casing, so the all-one-case
// test cannot be the thing that decides whether to fix them.

test('Mc and O names are capitalised whatever the surrounding case', () => {
  assert.equal(usableStreet('1445 Mcgowan Blvd'), '1445 McGowan Blvd')
  assert.equal(usableStreet('2435 Mccarthy Rd SE'), '2435 McCarthy Rd SE')
  assert.equal(usableStreet('409 Mcnamara Rd'), '409 McNamara Rd')
  assert.equal(usableCity('Mckinney'), 'McKinney')
  assert.equal(usableStreet("1624 O'connor Rd"), "1624 O'Connor Rd")
})

test('Mac names are NOT touched, because that is how they are spelled', () => {
  for (const a of ['1600 Mackenzie Dr', '1740 Mackinaw Dr', '3938 Macbride Pl NE'])
    assert.equal(usableStreet(a), a, a + ' is spelled that way and must survive')
})

test('a trailing period or comma is not part of the street', () => {
  assert.equal(usableStreet('955 Oak St.'), '955 Oak St')
  assert.equal(usableStreet('1656 Rolling Glen Dr.'), '1656 Rolling Glen Dr')
  assert.equal(usableStreet('649 40th Street, '), '649 40th Street')
  // John's canonical form for this one: "5328 N Alburnett Rd, Central City, IA 52214".
  // No period after the directional, which is how the rest of the file writes it.
  assert.equal(usableStreet('5328 N. Alburnett Rd.'), '5328 N Alburnett Rd')
  assert.equal(usableStreet('1229 E. Bertram Rd'), '1229 E Bertram Rd')
  assert.equal(usableCity('Cedar Rapids,'), 'Cedar Rapids')
  assert.equal(usableCity('Cedar Rapids.'), 'Cedar Rapids')
  assert.equal(usableCity(' Center Point'), 'Center Point')
})

test('a unit number is separated from its label', () => {
  assert.equal(usableStreet('2131 1st Ave NE Unit#310'), '2131 1st Ave NE Unit 310')
  assert.equal(usableStreet('664 J Ave NE Unit#A'), '664 J Ave NE Unit A')
  assert.equal(usableStreet('450 1st St SW Unit# 503'), '450 1st St SW Unit 503')
  // one that was already right stays right
  assert.equal(usableStreet('1650 Koehler Dr NW Unit 248'), '1650 Koehler Dr NW Unit 248')
})

test('a city column holding a street line or a bare state is still not a town', () => {
  for (const c of ['500 1st', '1701 C Ave', '16 36th Ave', 'IA', 'Iowa'])
    assert.equal(usableCity(c), '', JSON.stringify(c) + ' is not a town')
})

// A street named after a town was being eaten: TOWN_TAIL let the zip be zero digits long
// and, under /i, "Rd" satisfied the two-letter state slot, so " Alburnett Rd." looked like
// a city tail and "5328 N. Alburnett Rd." came back as "5328 N". A city tail now has to be
// marked as one — by a zip, by the state, or by a comma right before the town.
test('a street named after a town keeps its name', () => {
  assert.equal(usableStreet('5328 N Alburnett Rd'), '5328 N Alburnett Rd')
  assert.equal(usableStreet('1200 Marion Blvd'), '1200 Marion Blvd')
  assert.equal(usableStreet('4400 Solon Rd NE'), '4400 Solon Rd NE')
  assert.equal(usableStreet('820 Vinton St SW'), '820 Vinton St SW')
  assert.equal(usableStreet('310 Amana Colony Dr'), '310 Amana Colony Dr')
})

test('a real city tail is still trimmed, because it is marked as one', () => {
  assert.equal(usableStreet('5328 N Alburnett Rd, Central City, IA 52214'), '5328 N Alburnett Rd')
  assert.equal(usableStreet('180 Rosedale Road Marion IA 52302'), '180 Rosedale Road')
  assert.equal(usableStreet('1607 21st Street, Cedar Rapids, IA 52405'), '1607 21st Street')
  assert.equal(usableStreet('295 circle dr\nWalford, Iowa'), '295 circle dr')
  assert.equal(usableStreet('10000 W Cemetary Rd Fairfax, IA 52228'), '10000 W Cemetary Rd')
})
