// Parsing the home value notification email. Everything downstream — the lead, the tag,
// the follow-up, the 90-day pause — depends on reading this one message correctly, so it
// is pinned against the real notification text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHomeValueEmail } from '../server/home-value-intake.js'

// verbatim shape of a real notification (2026-09-28)
const REAL = `
-------------------------------------------------------------------------------------------------------------------
 The following info was submitted from
cedarrapidsmetroareahomevalue.sierrasellersites.com at
 09/28/2026 03:19 PM.
 -------------------------------------------------------------------------------------------------------------------

*cedarrapidsmetroareahomevalue.sierrasellersites.com: Contact Request*

 *Request Type*: Seller CMA Request

 *Lead Type*: Buyer

 *Name*: Test Home Value

 *Email Address*: matt@mattsmithteam.com

 *Phone*: (319) 253-2937

 *Questions / Comments*: Address: 3720 Monarch Ave, Marion, IA 52302, USA
I am Planning to Move: 6-12 months
Beds: 4
Baths: 3
Zillow Valuation Estimate: $370,400
AVM Estimate: $369,900

 View Lead Details
<https://client5.sierrainteractivedev.com/lead-detail.aspx?id=2344780&sn=mattsmithteam.com>
`

test('the person is read correctly', () => {
  const s = parseHomeValueEmail(REAL)
  assert.equal(s.name, 'Test Home Value')
  assert.equal(s.first_name, 'Test')
  assert.equal(s.last_name, 'Home Value')
  assert.equal(s.email, 'matt@mattsmithteam.com')
  assert.equal(s.phone, '(319) 253-2937')
})

test('the address is split into its parts, and USA is dropped', () => {
  const s = parseHomeValueEmail(REAL)
  assert.equal(s.address, '3720 Monarch Ave')
  assert.equal(s.city, 'Marion')
  assert.equal(s.state, 'IA')
  assert.equal(s.zip, '52302')
  assert.equal(s.address_full, '3720 Monarch Ave, Marion, IA 52302, USA')
})

test('what they told the form is captured', () => {
  const s = parseHomeValueEmail(REAL)
  assert.equal(s.timeframe, '6-12 months')
  assert.equal(s.beds, '4')
  assert.equal(s.baths, '3')
  assert.equal(s.request_type, 'Seller CMA Request')
})

test('both estimates come through as numbers, not strings with symbols', () => {
  const s = parseHomeValueEmail(REAL)
  assert.equal(s.zillow_estimate, 370400)
  assert.equal(s.avm_estimate, 369900)
})

test('the Sierra lead id is picked up from the link', () => {
  assert.equal(parseHomeValueEmail(REAL).sierra_lead_id, '2344780')
})

test('a submission with no estimates still parses, with nulls not NaN', () => {
  const thin = REAL.replace(/Zillow Valuation Estimate.*\n/, '').replace(/AVM Estimate.*\n/, '')
  const s = parseHomeValueEmail(thin)
  assert.equal(s.zillow_estimate, null)
  assert.equal(s.avm_estimate, null)
  assert.equal(s.address, '3720 Monarch Ave')
})

test('junk in gives empty fields out, never a crash', () => {
  for (const bad of ['', null, undefined, 'hello', '<html></html>']) {
    const s = parseHomeValueEmail(bad)
    assert.equal(s.email, '')
    assert.equal(s.address, '')
  }
})

test('a one-word name does not produce a broken last name', () => {
  const s = parseHomeValueEmail(REAL.replace('*Name*: Test Home Value', '*Name*: Cher'))
  assert.equal(s.first_name, 'Cher')
  assert.equal(s.last_name, '')
})
