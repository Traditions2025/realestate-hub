// Resolving an address to its assessor parcel page.
//
// John, 2026-10-01: the Assessor button "doesn't get any result". Two URL-based attempts
// had already failed, because there is no URL that takes an address and lands on a parcel:
// the site gates on a SameSite=Lax cookie and searches by POST, which a browser cannot
// carry cross-site. A server can, so the lookup moved to the server.
//
// The parts that touch the live site are not unit-tested; the parsing and the safety rule
// are, because those are what decide whether the right property gets linked.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { initDb } from '../server/database.js'
await initDb()
const { assessorHost, assessorSearchUrl, streetOnly, normAddress, addressesAgree,
        formDefaults, shownAddress } = await import('../server/assessor-lookup.js')

const src = fs.readFileSync(new URL('../server/assessor-lookup.js', import.meta.url), 'utf8')

// ── which assessor ───────────────────────────────────────────────────────────────────
test('Cedar Rapids has its own city assessor, everywhere else is the county', () => {
  assert.equal(assessorHost('Cedar Rapids'), 'cedarrapids')
  assert.equal(assessorHost('  cedar   rapids  '), 'cedarrapids')
  for (const c of ['Marion', 'Hiawatha', 'Robins', 'Ely', '', null]) assert.equal(assessorHost(c), 'linn')
})

// 3 of the 9 addresses that resolved only did so on the OTHER host: a Cedar Rapids postal
// address can sit outside the city limits and belong to the county assessor.
test('both hosts are tried, because the city line does not decide it', () => {
  // both at once now: sequentially a miss on the first host cost a full round trip before
  // the second started, which is where the 27s worst case came from
  assert.match(src, /\[first, second\]/, 'both hosts are attempted')
  assert.match(src, /await Promise\.all\(attempts\.map/, 'and they go at once')
  assert.match(src, /outside the city limits/i)
  // the city's own assessor must still win when both answer
  assert.match(src, /for \(const out of tried\)/)
})

test('the search page is a real page, with no query string', () => {
  const u = assessorSearchUrl('Cedar Rapids')
  assert.equal(u, 'https://cedarrapids.iowaassessors.com/search/res/')
  assert.ok(!u.includes('?'))
})

// ── what gets searched ───────────────────────────────────────────────────────────────
test('only the street line is searched', () => {
  // the form matches on the street; a city/state/zip tail finds nothing
  assert.equal(streetOnly('1370 Wiley Blvd NW, Cedar Rapids, IA 52405'), '1370 Wiley Blvd NW')
  assert.equal(streetOnly('  6528   Medford Ln NE  '), '6528 Medford Ln NE')
  assert.equal(streetOnly('190 Cottage Grove Ave SE Unit #302'), '190 Cottage Grove Ave SE')
  assert.equal(streetOnly('410 1st Ave Apt 3B'), '410 1st Ave')
  assert.equal(streetOnly(''), '')
  assert.equal(streetOnly(null), '')
})

// ── the safety rule ──────────────────────────────────────────────────────────────────
// Linking a stranger's property is worse than linking nothing. This is the same principle
// as the Forewarn address check.
test('the site spelling it out in full still counts as the same address', () => {
  // searched "1101 30th St Dr SE", the parcel page shows "1101 30TH STREET DR SE"
  assert.ok(addressesAgree('1101 30th St Dr SE', '1101 30TH STREET DR SE CEDAR RAPIDS, IA 52403-1507'))
  assert.ok(addressesAgree('5010 Silver Oak Ct', '5010 SILVER OAK CT MARION, IA 52302-9195'))
  assert.ok(addressesAgree('1370 Wiley Blvd NW', '1370 WILEY BLVD NW CEDAR RAPIDS, IA 52405-0000'))
  assert.ok(addressesAgree('3330 Aster Rd', '3330 ASTER ROAD CEDAR RAPIDS, IA 52411-4718'))
})

test('a different property is refused', () => {
  // the exact failure that burned the last attempt: one parcel answering every address
  assert.ok(!addressesAgree('1370 Wiley Blvd NW', '6528 MEDFORD LN NE CEDAR RAPIDS, IA'))
  assert.ok(!addressesAgree('108 Sunflower Dr', '6528 MEDFORD LN NE CEDAR RAPIDS, IA'))
  assert.ok(!addressesAgree('100 Main St', '200 MAIN STREET CEDAR RAPIDS, IA'), 'a different number is a different house')
})

test('nothing to compare means no match, never a guess', () => {
  assert.ok(!addressesAgree('100 Main St', ''))
  assert.ok(!addressesAgree('', '100 MAIN STREET'))
  assert.ok(!addressesAgree(null, null))
})

test('the guard actually gates the result', () => {
  assert.match(src, /if \(!addressesAgree\(street, out\.shown\)\) continue/)
})

test('abbreviations normalise both ways', () => {
  assert.equal(normAddress('1 Oak Ave'), normAddress('1 OAK AVENUE'))
  assert.equal(normAddress('2 Elm Ct.'), normAddress('2 ELM COURT'))
  assert.equal(normAddress('3 Pine Blvd'), normAddress('3 PINE BOULEVARD'))
})

// ── replaying their form ─────────────────────────────────────────────────────────────
// Sending ifulladdress alone bounces straight back to the search page; the form's hidden
// fields (process, search_page, search_group, search_type, manual_search...) are required.
test('every field of the form is carried over, with its own value', () => {
  const html = `<form id="form_search" method="post" action="/search/res/results/">
    <input type="hidden" name="process" value="1" />
    <input type="hidden" name="search_page" value="1" />
    <input type="hidden" name="search_group" value="res" />
    <input type="text" name="ifulladdress" value="" />
    <input type="checkbox" name="iphoto" value="1" />
    <input type="checkbox" name="opRestrict" value="yes" checked />
    <input type="submit" name="i_search" value="Search" />
    <select name="sort"><option value="a">A</option><option value="b" selected>B</option></select>
  </form>`
  const d = formDefaults(html)
  assert.equal(d.process, '1')
  assert.equal(d.search_group, 'res')
  assert.equal(d.ifulladdress, '')
  assert.equal(d.opRestrict, 'yes', 'a checked box is submitted')
  assert.ok(!('iphoto' in d), 'an unchecked box is not')
  assert.ok(!('i_search' in d), 'the submit button is not a field')
  assert.equal(d.sort, 'b', 'the selected option wins')
})

test('the disclaimer is accepted the way the page does it', () => {
  // the page's FIRST form is a hidden Login form, so the fields are named explicitly
  assert.match(src, /search_disclaimer: '1', i_agree: 'Yes, I Agree'/)
})

test('the search form is found by its own field, never by position', () => {
  assert.match(src, /name=\["'\]ifulladdress\["'\]/)
})

// ── reading the parcel page ──────────────────────────────────────────────────────────
test('the address is read off the parcel page', () => {
  const html = `<div>Parcel Number: 13242-77007-00000 Deed Holder: BEER JUNE A
    <b>Property Address:</b> 1370 WILEY BLVD NW CEDAR RAPIDS, IA 52405-0000
    <b>Mailing Address:</b> 2120 29TH AVE SW CEDAR RAPIDS, IA 52404-3328 USA</div>`
  assert.equal(shownAddress(html), '1370 WILEY BLVD NW CEDAR RAPIDS, IA 52405-0000')
})

test('the Linn pages end the address differently and still parse', () => {
  const html = `<span>Property Address:</span> 5010 SILVER OAK CT MARION, IA 52302-9195 <a>Map This Address</a>`
  assert.equal(shownAddress(html), '5010 SILVER OAK CT MARION, IA 52302-9195')
})

test('a page with no address yields null rather than nonsense', () => {
  assert.equal(shownAddress('<p>Search | Cedar Rapids City Assessor</p>'), null)
})

// ── a list of results ────────────────────────────────────────────────────────────────
test('a multi-result list is only followed when there is exactly one property', () => {
  assert.match(src, /if \(links\.length !== 1\) return \{ error: links\.length \? `\$\{links\.length\} results` : 'no match' \}/)
  // estimate/sketch/map links live on the parcel page itself and are not properties
  assert.match(src, /estimate\|sketch\|map\|photos\|report/)
})

// ── caching ──────────────────────────────────────────────────────────────────────────
test('a hit is kept, a miss is retried later', () => {
  assert.match(src, /const MISS_RETRY_DAYS = 7/)
  assert.match(src, /assessor_url/)
  assert.match(src, /assessor_checked_at/)
})

test('the lookup never writes anything but the cache', () => {
  assert.ok(!/INSERT INTO clients/i.test(src), 'it must not create leads')
  assert.ok(!/DELETE FROM/i.test(src))
  const writes = [...src.matchAll(/UPDATE\s+(\w+)\s+SET\s+([^']*?)WHERE/gis)].map(m => m[1] + ': ' + m[2].trim())
  assert.equal(writes.length, 1, 'exactly one write')
  assert.match(writes[0], /^clients: assessor_url = \?, assessor_checked_at = \?/)
})

// ── the two real misses, 2026-10-01 ──────────────────────────────────────────────────
const { abbreviateStreet } = await import('../server/assessor-lookup.js')

// "7114 E Park Ct NE" DID resolve - the guard threw the correct parcel away, because the
// site prints the directional in full and only the street suffix was being expanded.
test('a directional written in full is the same address', () => {
  assert.ok(addressesAgree('7114 E Park Ct NE', '7114 EAST PARK CT NE CEDAR RAPIDS, IA 52402-0000'))
  assert.ok(addressesAgree('100 N Oak St', '100 NORTH OAK STREET MARION, IA'))
  assert.ok(addressesAgree('100 W 3rd Ave', '100 WEST 3RD AVENUE MARION, IA'))
})

test('opposite directions are still different addresses', () => {
  assert.ok(!addressesAgree('100 Oak St N', '100 OAK STREET SOUTH CEDAR RAPIDS, IA'))
  assert.ok(!addressesAgree('100 E Oak St', '100 WEST OAK ST CEDAR RAPIDS, IA'))
})

// "3731 Tanager Drive North" finds nothing; "3731 Tanager Dr N" lands on the parcel.
test('a spelled-out street is also tried abbreviated', () => {
  assert.equal(abbreviateStreet('3731 Tanager Drive Northeast'), '3731 Tanager Dr NE')
  assert.equal(abbreviateStreet('3731 Tanager Drive North'), '3731 Tanager Dr N')
  assert.equal(abbreviateStreet('12 Sunset Boulevard'), '12 Sunset Blvd')
  assert.equal(abbreviateStreet('9 Elm Court South'), '9 Elm Ct S')
})

test('an address that is already abbreviated adds no extra request', () => {
  for (const a of ['146 38th St NE', '609 Green Valley Ter SE', '1370 Wiley Blvd NW'])
    assert.equal(abbreviateStreet(a), '', `${a} should produce no variant`)
})

test('both spellings and both hosts go at once', () => {
  assert.match(src, /const spellings = \[street, abbreviateStreet\(street\)\]\.filter\(Boolean\)/)
  assert.match(src, /for \(const host of \[first, second\]\) for \(const term of spellings\)/)
  assert.match(src, /await Promise\.all\(attempts\.map/)
})

// Cedar Rapids addresses are mostly quadrants, and "Drive Northeast" spelled out finds
// nothing at all on the site.
test('compound quadrants abbreviate, and stay uppercase', () => {
  assert.equal(abbreviateStreet('1 Elm Street Northwest'), '1 Elm St NW')
  assert.equal(abbreviateStreet('2 Oak Lane Southeast'), '2 Oak Ln SE')
  assert.equal(abbreviateStreet('3 Ash Road Southwest'), '3 Ash Rd SW')
  for (const a of ['1 Elm Street Northwest', '2 Oak Lane Southeast'])
    assert.ok(!/ N[ewsto]+$/.test(abbreviateStreet(a)), 'a directional must not be title-cased')
})

test('a quadrant written in full is the same address, but a different one is not', () => {
  assert.ok(addressesAgree('3731 Tanager Dr NE', '3731 TANAGER DR NORTHEAST CEDAR RAPIDS, IA'))
  assert.ok(!addressesAgree('100 Oak St NE', '100 OAK STREET SE CEDAR RAPIDS, IA'))
  assert.ok(!addressesAgree('100 Oak St NE', '100 OAK STREET NW CEDAR RAPIDS, IA'))
})
