// Parsing the home value notification email. Everything downstream — the lead, the tag,
// the follow-up, the 90-day pause — depends on reading this one message correctly, so it
// is pinned against the real notification text.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
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

// ── the native /home-value/ form, pinned 2026-10-29 ──────────────────────────────────
//
// The page drives Sierra's own /contact/ form, so the identity fields are Sierra's
// (First_Name / Last_Name / Email / Phone) and share NO names with the seller site's
// (*Name* / *Email Address*). Parsed against the wrong scheme the email comes out empty,
// handleHomeValueSubmission skips, and the requester gets nothing at all - silently.
// That is what /sellers/free-market-analysis/ has always done.
//
// Sierra wraps labels in asterisks in the notification mail and writes them bare in the
// stored note, and nobody has sampled a notification from this page yet, so BOTH wrappers
// are pinned here. Format spec: Home Value Site/home-value-form/SUBMISSION-FORMAT.md
const NATIVE = [
  'The following info was submitted from MattSmithTeam.com at 10/29/2026 09:26 AM.',
  '',
  'First_Name: Jane',
  'Last_Name: Doe',
  'Email: jane.doe@example.com',
  'Phone: (319) 555-0142',
  'HV_Submission_ID: HV-20261029-SNTN',
  'HV_Source: mattsmithteam.com/home-value',
  'HV_Address: 1625 RANMAR DR, ELY, IA, 52227',
  'HV_Condition: 7',
  'HV_Timeline: Just curious',
  'HV_Would_Buy: unsure',
  'Questions: HOME VALUE REQUEST',
].join('\n')

const starred = (s) => s.replace(/^([A-Za-z_]+):/gm, '*$1*:')

test('the native form parses, with or without asterisk wrappers', () => {
  for (const [label, body] of [['bare', NATIVE], ['asterisk', starred(NATIVE)]]) {
    const s = parseHomeValueEmail(body)
    assert.equal(s.email, 'jane.doe@example.com', label + ': email is what the skip hinges on')
    assert.equal(s.first_name, 'Jane', label)
    assert.equal(s.last_name, 'Doe', label)
    assert.equal(s.phone, '(319) 555-0142', label)
    assert.equal(s.address, '1625 RANMAR DR', label)
    assert.equal(s.city, 'ELY', label)
    assert.equal(s.state, 'IA', label)
    assert.equal(s.zip, '52227', label + ': state and zip are separate comma parts here')
    assert.equal(s.condition, '7', label)
    assert.equal(s.submission_id, 'HV-20261029-SNTN', label)
  }
})

test('HV_Source is what identifies this form, not the page URL', () => {
  // Sierra overwrites Sent_From from its own page context, so the record says /contact/
  // whatever we post. HV_Source is emitted by nothing else.
  const s = parseHomeValueEmail(NATIVE)
  assert.equal(s.source_line, 'mattsmithteam.com/home-value')
  assert.equal(s.request_type, 'Home Value Request', 'the block names itself on its first line')
})

test('the submission id is the dedupe key, so asking twice is two submissions', () => {
  // Sierra merges on email: without this, a second request months later is
  // indistinguishable from the first and would be swallowed as "already processed".
  const first = parseHomeValueEmail(NATIVE)
  const again = parseHomeValueEmail(NATIVE.replace('HV-20261029-SNTN', 'HV-20270415-TRKW'))
  assert.notEqual(first.submission_id, again.submission_id)
  assert.equal(again.email, first.email, 'same person, different submission')
})

test('First_Name is not read as Name, nor Email as Email Address', () => {
  // 'Name' matching inside 'First_Name' would take the wrong half of the label
  const s = parseHomeValueEmail(NATIVE)
  assert.equal(s.name, 'Jane Doe')
  assert.ok(!/first/i.test(s.first_name))
})

test('the seller-site format is untouched by the native-form support', () => {
  const s = parseHomeValueEmail(REAL)
  assert.equal(s.email, 'matt@mattsmithteam.com')
  assert.equal(s.address, '3720 Monarch Ave')
  assert.equal(s.submission_id, '', 'the old format carries no reference')
})

// ── which door they came through, and whether the tag survives ───────────────────────
//
// John, 2026-10-29: "make sure we get a tagging for those who request their home value on
// the NEW link." Two separate problems sat behind that.
//
// FIRST, the canonical tag was being silently stripped. Tags are Sierra-owned in
// sierra-helper.js and only a short whitelist of Hub-native tags survives a sync pass. The
// home value tag was not on it, so: James Osullivan was tagged by the intake at 20:35 on
// 2026-10-27 and a sync at 22:02 removed it, and the three submissions from the new page
// came back with tags=[] for the same reason. A home value requester therefore looked like
// any other lead, which is exactly what John was asking about. The Home Value Requested
// smart list survived only because it ORs in the home_value_submission activity row.
//
// SECOND, the canonical tag cannot answer "which door" - its name is the RETIRED seller
// site and it is deliberately left that way, because the smart list matches it and
// renaming it would orphan every historic requester. So the source is tagged separately.
import { sourceTagFor, HOME_VALUE_TAG } from '../server/home-value-intake.js'

test('a new-link requester gets a source tag, and nobody else does', () => {
  const NEW = 'Home Value: mattsmithteam.com/home-value'
  assert.equal(sourceTagFor({ source_line: 'mattsmithteam.com/home-value' }), NEW)
  // the form writes it bare, but tolerate scheme, www and a trailing slash
  assert.equal(sourceTagFor({ source_line: 'https://www.mattsmithteam.com/home-value/' }), NEW)
  // the retiring seller site emits no HV_Source at all
  assert.equal(sourceTagFor({ source_line: '' }), null)
  assert.equal(sourceTagFor({}), null)
  // and the Free Market Analysis page must not be mistaken for it
  assert.equal(sourceTagFor({ source_line: 'https://www.mattsmithteam.com/sellers/free-market-analysis/' }), null)
})

test('the source tag is read from HV_Source, never from the page URL', () => {
  // the form posts through a hidden iframe on /contact/ and Sierra overwrites Sent_From
  // from its own page context, so every submission's URL says /contact/
  const s = parseHomeValueEmail(NATIVE)
  assert.equal(s.source_line, 'mattsmithteam.com/home-value')
  assert.ok(sourceTagFor(s), 'a parsed native submission must earn the source tag')
  const src = fs.readFileSync(new URL('../server/home-value-intake.js', import.meta.url), 'utf8')
  assert.ok(!/sourceTagFor[\s\S]{0,400}Sent_From/.test(src), 'Sent_From must not drive the source tag')
})

test('the canonical tag keeps its old name on purpose', () => {
  // renaming it would orphan every historic requester and the smart list that matches it
  assert.equal(HOME_VALUE_TAG, 'cedarrapidsmetroareahomevalue.sierrasellersites.com')
})

test('a Sierra sync pass cannot strip the home value tags', () => {
  // this is the bug: without it the intake tags a lead and the next sync removes it
  const helper = fs.readFileSync(new URL('../server/sierra-helper.js', import.meta.url), 'utf8')
  const m = helper.match(/const HUB_NATIVE_TAG = \(t\) =>([\s\S]*?)\n\s*let hubTags/)
  assert.ok(m, 'the Hub-native tag predicate should be findable')
  const pred = m[1]
  assert.match(pred, /Home Value:/, 'the source tag must survive a sync')
  assert.match(pred, /sierrasellersites/, 'the canonical tag must survive a sync')
  // and the predicate must actually be applied to what gets written back
  assert.match(helper, /const keepTags = hubTags\.filter\(HUB_NATIVE_TAG\)/)
  assert.match(helper, /mergedTags = \[\.\.\.new Set\(\[\.\.\.tags, \.\.\.keepTags\]\)\]/)
})

// ── the whitelist is the only thing standing between a Hub tag and oblivion ──────────
//
// Measured 2026-10-29 across all 45,950 clients. Tags are Sierra-owned, and the sync
// unions back only what this predicate matches, so a tag Sierra never sets and nothing
// re-applies is lost the next time Sierra reports THAT lead. Not a sweep - a half-life,
// which is why it goes unnoticed.
//
// Why the big tag counts are not evidence against this: Import is on 42,984 clients and
// Realist on 15,600 because SIERRA supplies them every pass. They never needed protecting.
// Only Hub-invented tags are exposed.
//
// Read this the right way round: it preserves a tag that is ON THE HUB RECORD, it does not
// resurrect one. Removing a tag in the Hub makes it stay removed - the Hub is master. What
// it blocks is a Sierra-side removal reaching back and deleting Hub-owned information.
test('the sync whitelist covers every Hub-invented tag, and nothing else', () => {
  const helper = fs.readFileSync(new URL('../server/sierra-helper.js', import.meta.url), 'utf8')
  const m = helper.match(/const HUB_NATIVE_TAG = \(t\) =>([\s\S]*?)\n\s*let hubTags/)
  assert.ok(m, 'the predicate should be findable')
  // eslint-disable-next-line no-new-func
  const pred = new Function('t', 'return (' + m[1].trim().replace(/\n/g, ' ') + ')')

  for (const t of [
    'FB Ad',                                        // bare, no property - used to slip past /^FB Ad:/
    'FB Ad: 1625 Ranmar Dr',
    'FB Seller Ad',
    'Meta Lead', 'Fix It or Skip It', 'Seller',
    'Home Value: mattsmithteam.com/home-value',
    'cedarrapidsmetroareahomevalue.sierrasellersites.com',
    'Address Confirmed 2026', 'Address Confirmed 2026-10', 'Address Needs Update',
  ]) assert.equal(!!pred(t), true, `${t} is Hub-written and must survive a sync`)

  for (const t of [
    'Import', 'Realist', 'Bounced', 'Buyer', 'Y_DNC_REGISTRY_TRUE',   // Sierra resupplies these
    'FB Adjacent',    // must not be caught by the FB Ad prefix
    'Address', 'Addresses',   // must not be caught by the Address prefixes
  ]) assert.equal(!!pred(t), false, `${t} is Sierra-owned and must not be force-kept`)
})
