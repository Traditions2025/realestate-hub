// Two buttons on the client profile: the county assessor, and the lead's FUB record.
//
// These tests used to hold their own COPY of assessorUrl, which is precisely why they
// stayed green while the real button was broken: the live URL pointed at
// /search/res/results.php?ifulladdress=…&process=1, a page that does not exist on these
// sites. It landed on an empty Residential Building Search and "View Results" returned
// nothing (John, 2026-10-01). A copied implementation cannot catch a wrong URL, so the
// real function is now lifted out of the source and exercised directly.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')

/** Lift a top-level function out of the .jsx so the test runs the SHIPPING code. */
function lift(name) {
  const start = src.indexOf(`export function ${name}(`)
  assert.ok(start >= 0, `${name} should exist in ClientProfile.jsx`)
  let i = src.indexOf('{', start), depth = 0, end = -1
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  assert.ok(end > 0, `could not find the end of ${name}`)
  const body = src.slice(start, end).replace(/^export\s+/, '')
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return ${name}`)()
}
const assessorUrl = lift('assessorUrl')
const assessorSearchTerm = lift('assessorSearchTerm')

// ── the URL that actually works ──────────────────────────────────────────────────────
test('it points at the Real Estate Search page that exists', () => {
  const u = assessorUrl({ address: '6528 Medford Ln NE', city: 'Cedar Rapids' })
  assert.equal(u, 'https://cedarrapids.iowaassessors.com/search/res/')
})

// The specific breakage: this path 404s into an empty Residential Building Search.
test('the dead results.php path is gone', () => {
  const u = assessorUrl({ address: '6528 Medford Ln NE', city: 'Cedar Rapids' })
  assert.ok(!/results\.php/.test(u), 'results.php does not exist on these sites')
  assert.ok(!/ifulladdress|process=1/.test(u), 'these parameters are ignored')
  // scoped to the code, not the file: the comment above it names the dead path on purpose,
  // so nobody reintroduces it
  const body = src.slice(src.indexOf('export function assessorUrl'))
    .slice(0, src.slice(src.indexOf('export function assessorUrl')).indexOf('\n}') + 2)
  assert.ok(!/results\.php/.test(body), 'the dead path must not survive in the function')
})

// Every query parameter is discarded, because the search form sits behind a disclaimer
// the site makes you accept first. Verified against both live hosts.
test('no query string is attached, because the site ignores it', () => {
  for (const c of [{ address: '6528 Medford Ln NE', city: 'Cedar Rapids' },
                   { address: '190 Cottage Grove Ave SE Unit #302', city: 'Marion' }])
    assert.ok(!assessorUrl(c).includes('?'), 'a query string would only be misleading')
})

// ── which county ─────────────────────────────────────────────────────────────────────
// Cedar Rapids has its own city assessor, and most of the file IS Cedar Rapids.
test('a Cedar Rapids address goes to the city assessor', () => {
  assert.match(assessorUrl({ address: '1224 Moose Dr NW', city: 'Cedar Rapids' }),
    /^https:\/\/cedarrapids\.iowaassessors\.com/)
})

test('everywhere else in the county goes to Linn', () => {
  for (const city of ['Marion', 'Hiawatha', 'Robins', 'Ely', 'Center Point'])
    assert.match(assessorUrl({ address: '100 Main St', city }), /^https:\/\/linn\.iowaassessors\.com/)
})

test('an unknown or blank city falls back to the county, not to nothing', () => {
  for (const city of ['', null, undefined, 'Somewhere Else'])
    assert.match(assessorUrl({ address: '100 Main St', city }), /^https:\/\/linn\./)
})

test('the city match is case and space insensitive', () => {
  for (const city of ['cedar rapids', 'CEDAR RAPIDS', '  Cedar Rapids  '])
    assert.match(assessorUrl({ address: '1 A St', city }), /cedarrapids/)
})

test('no address means no button', () => {
  for (const c of [{ address: '' }, { address: '   ' }, {}, null])
    assert.equal(assessorUrl(c), null)
})

// ── what gets pasted ─────────────────────────────────────────────────────────────────
// John: "just by searching 6528 Medford Ln NE that would get a result" — the street on
// its own, no city, state or zip appended.
test('the copied term is the street address alone', () => {
  assert.equal(assessorSearchTerm({ address: '6528 Medford Ln NE', city: 'Cedar Rapids', state: 'IA', zip: '52402' }),
    '6528 Medford Ln NE')
  assert.equal(assessorSearchTerm({ address: '  190 Cottage Grove Ave SE  ' }), '190 Cottage Grove Ave SE')
  assert.equal(assessorSearchTerm({}), '')
})

test('copying never blocks opening the page', () => {
  const fn = src.slice(src.indexOf('export function copyAssessorAddress'))
  assert.match(fn, /try \{/, 'clipboard access throws in an insecure context')
  assert.match(fn, /\.catch\(\(\) => \{\}\)/, 'a refused permission must not surface as an error')
  assert.ok(!/preventDefault/.test(fn), 'the navigation is the point')
})

// ── the buttons themselves ───────────────────────────────────────────────────────────
test('both buttons open in a new tab, safely', () => {
  const row = src.slice(src.indexOf('assessorUrl(client) &&'), src.indexOf('assessorUrl(client) &&') + 900)
  assert.equal((row.match(/target="_blank"/g) || []).length, 2)
  // without noopener the opened page can reach back into the Hub tab
  assert.equal((row.match(/rel="noopener noreferrer"/g) || []).length, 2)
})

test('the assessor button copies the address as it opens', () => {
  const row = src.slice(src.indexOf('assessorUrl(client) &&'), src.indexOf('assessorUrl(client) &&') + 500)
  assert.match(row, /onClick=\{\(\) => copyAssessorAddress\(client\)\}/)
  assert.match(row, /title=/, 'the button should say what it will do')
})

test('the FUB button uses this account and hides when there is no id', () => {
  assert.match(src, /client\.fub_person_id && <a/, '31% of leads have no FUB record')
  assert.match(src, /mattsmithremax\.followupboss\.com\/2\/people\/view\/\$\{client\.fub_person_id\}/)
})

test('the assessor button hides when there is no address', () => {
  assert.match(src, /\{assessorUrl\(client\) && <a/)
})

// ── the stale search box ─────────────────────────────────────────────────────────────
// The assessor's own field comes back holding whatever was searched LAST. John noticed it
// as a convenience on desktop ("we just need to enter"), but pressing enter without
// replacing it re-runs the PREVIOUS client's property. Verified against the live site:
// search an address, return to /search/res/, and the box still contains it.
test('the user is told the search box holds the last address', () => {
  const fn = src.slice(src.indexOf('export function copyAssessorAddress'))
  assert.match(fn, /holds your last search/, 'the toast has to warn about the stale value')
  const row = src.slice(src.indexOf('assessorUrl(client) &&'), src.indexOf('assessorUrl(client) &&') + 600)
  assert.match(row, /holds the last address you searched/, 'and so should the hover text')
})

test('the warning does not drown out the address itself', () => {
  const fn = src.slice(src.indexOf('export function copyAssessorAddress'))
  // the copied value leads; the caution follows
  assert.ok(fn.indexOf('Copied') < fn.indexOf('Clear the search box'))
})
