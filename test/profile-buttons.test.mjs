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

// ── the fallback link ───────────────────────────────────────────────────────
// assessorUrl is now only the FALLBACK. The button prefers the parcel page resolved by
// the server (/api/clients/:id/assessor), which is a real deep link to the property.
//
// Two URLs have already failed here, and neither may come back:
//   results.php?ifulladdress=...  is not a page on either site - empty search, no results
//   /search/res/results/?...      replays the session's LAST POST, so four different
//                                 addresses once returned one parcel
test('the fallback is a page that actually exists', () => {
  const u = assessorUrl({ address: '6528 Medford Ln NE', city: 'Cedar Rapids' })
  assert.equal(u, 'https://cedarrapids.iowaassessors.com/search/res/')
})

test('the fallback never carries search parameters', () => {
  // a query string here is the shape of both previous failures
  const u = assessorUrl({ address: '190 Cottage Grove Ave SE Unit #302', city: 'Cedar Rapids' })
  assert.ok(!u.includes('?'), 'a GET query is ignored by the site and reads as a working link')
  assert.ok(!/results\.php/.test(u), 'results.php is not a page on these sites')
  assert.ok(!/ifulladdress/.test(u), 'the address is POSTed by the server, never put in the URL')
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

// ── the buttons themselves ───────────────────────────────────────────────────────────
test('both buttons open in a new tab, safely', () => {
  const row = src.slice(src.indexOf('assessorUrl(client) &&'), src.indexOf('assessorUrl(client) &&') + 900)
  assert.equal((row.match(/target="_blank"/g) || []).length, 2)
  // without noopener the opened page can reach back into the Hub tab
  assert.equal((row.match(/rel="noopener noreferrer"/g) || []).length, 2)
})

test('the FUB button uses this account and hides when there is no id', () => {
  assert.match(src, /client\.fub_person_id && <a/, '31% of leads have no FUB record')
  assert.match(src, /mattsmithremax\.followupboss\.com\/2\/people\/view\/\$\{client\.fub_person_id\}/)
})

test('the assessor button hides when there is no address', () => {
  assert.match(src, /\{assessorUrl\(client\) && <a/)
})

// ── the header row (John, 2026-10-01) ────────────────────────────────────────────────
// The chips under the name repeated Type, Status, Agent and Source straight off the
// Client Details card. Realist Score and Intent were the only two that were NOT on it, so
// those moved there and the row went, letting the actions sit beside the name.
const css = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')

test('the duplicate chip row is gone', () => {
  assert.ok(!/<div className="cp-badges">/.test(src), 'the row duplicated Client Details')
})

test('the Realist Score chip lives on the details card, still editable', () => {
  const crm = src.slice(src.indexOf("<div className=\"cp-sub\">CRM</div>"))
  const card = crm.slice(0, crm.indexOf('Social'))
  assert.match(card, /<strong>Realist Score:<\/strong>\s*<RealistScoreBadge/, 'still click-to-edit')
})

// Intent moved here when the chip row went, then came straight back out: the AI
// Intelligence panel already shows the same number and level (John, 2026-10-01).
test('Intent is not repeated on the details card', () => {
  const crm = src.slice(src.indexOf("<div className=\"cp-sub\">CRM</div>"))
  const card = crm.slice(0, crm.indexOf('Social'))
  assert.ok(!/<strong>Intent:<\/strong>/.test(card), 'the AI panel is the one place for it')
  assert.ok(!/intentLevel/.test(src), 'the prop it needed should not linger unused')
})

// The badge shows lead_score with its grade (902 A+); the composite line showed
// realist_sell_score, the same 902. One number, one place.
test('Sell Score is not repeated under the badge', () => {
  assert.ok(!/Sell Score \$\{client\.realist_sell_score\}/.test(src))
  // and it must not gate the row either, or a lead with only a sell score shows an empty one
  const row = src.slice(src.indexOf('<strong>Realist:</strong>') - 400, src.indexOf('<strong>Realist:</strong>'))
  assert.ok(!/realist_sell_score/.test(row), 'dropped from the visibility test too')
})

test('Type, Status and Agent stay editable where they already were', () => {
  const crm = src.slice(src.indexOf("<div className=\"cp-sub\">CRM</div>"))
  const card = crm.slice(0, crm.indexOf('Social'))
  for (const pill of ['TypePill', 'StatusPill', 'AgentPill'])
    assert.match(card, new RegExp(`<${pill} client=\{client\} onSaved=\{onSaved\}`), `${pill} must remain`)
})

test('the actions sit on the name line', () => {
  const id = src.slice(src.indexOf('<div className="cp-identity">'))
  const block = id.slice(0, id.indexOf('{apptOpen &&'))
  assert.ok(block.indexOf('cp-name') < block.indexOf('cp-actions'), 'name first, then the buttons')
  assert.match(css, /\.cp-identity \.cp-actions \{ margin-top: 0/, 'no leftover gap above them')
  assert.match(css, /\.cp-identity \{ display: flex; align-items: center/, 'buttons centre, not baseline')
})

// The full-row rule first went into @media (min-width: 901px) - the DESKTOP block, not a
// phone one - which forced the buttons onto their own row at exactly the widths where they
// were supposed to sit beside the name. Computed style gave it away: flex 1 1 100% at
// 1500px wide.
test('the full-row rule is in a NARROW query, not a desktop one', () => {
  const rule = '.cp-identity .cp-actions { margin-top: 6px; flex-basis: 100%; }'
  const at = css.indexOf(rule)
  assert.ok(at > 0, 'the narrow-screen rule should exist')
  const query = css.lastIndexOf('@media', at)
  const which = css.slice(query, css.indexOf('{', query))
  assert.match(which, /max-width/, `it sits under "${which.trim()}" - a min-width query would hit desktop`)
  // and it must not have come back in the desktop block
  const desk = css.slice(css.indexOf('@media (min-width: 901px)'))
  const deskBlock = desk.slice(0, desk.indexOf(String.fromCharCode(10) + '}'))
  assert.ok(!deskBlock.includes('flex-basis: 100%'),
    'the desktop block must not force the buttons onto their own row')
})

// ── the resolved parcel ───────────────────────────────────────────────────────────────
// The real fix for "I don't get any result": the server resolves the address to a parcel
// page and the button points at THAT. See server/assessor-lookup.js for why only a server
// can do it (the disclaimer cookie is SameSite=Lax and the search is a POST).
test('the button prefers the resolved parcel over the fallback', () => {
  assert.match(src, /href=\{assessor\?\.parcel \|\| assessorUrl\(client\)\}/)
})

test('the parcel is resolved when the profile opens, not when the button is clicked', () => {
  // opening a tab after an await is what popup blockers stop, and the lookup is not instant
  assert.match(src, /\/api\/clients\/\$\{client\.id\}\/assessor/)
  const at = src.indexOf('setAssessor(null)')
  assert.ok(at > 0, 'the prefetch effect should exist')
  const eff = src.slice(at, at + 700)
  assert.match(eff, /\[client\?\.id, client\?\.address\]/, 're-resolve if the address changes')
})

test('a lead with no address is never looked up', () => {
  assert.match(src, /if \(!String\(client\.address \|\| ''\)\.trim\(\)\) return/)
})

test('the button says what it will open', () => {
  assert.match(src, /title=\{assessor\?\.parcel/)
  assert.match(src, /Looking up the parcel/)
})

// ── clicking before the lookup finishes ──────────────────────────────────────────────
// John, 2026-10-01: clicking still landed on an empty search box. A cold lookup takes a
// few seconds, and the href is only the fallback until it resolves.
test('the tab is opened inside the click, not after the await', () => {
  // window.open after an await is what popup blockers stop
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  const open = fn.indexOf('window.open(')
  const fetchAt = fn.indexOf('authFetch(')
  assert.ok(open > 0 && fetchAt > 0, 'both should be present')
  assert.ok(open < fetchAt, 'the tab must be opened before the lookup starts')
})

// THE BUG John hit: opening Melena Urbanowski showed "2222 1st Ave NE #508" in the
// assessor's search box. That page replays whatever the BROWSER searched last, so it looks
// like a filled-in address and belongs to someone else. A wrong address that looks right is
// worse than a blank one.
test('the waiting tab never shows the assessor own search page', () => {
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  assert.match(fn, /window\.open\(''/, 'the tab starts on our own page, not theirs')
  assert.ok(!/window\.open\(assessorUrl\(client\)/.test(fn), 'their search page shows the PREVIOUS search')
  assert.match(fn, /searched last|SEARCHED LAST/i, 'the reason should be written down')
})

test('the waiting page names the address being looked up', () => {
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  assert.match(fn, /Looking up/)
  assert.match(fn, /escapeHtml\(street\)/, 'and escapes it')
})

test('a miss says so, instead of dumping him on a stranger search', () => {
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  assert.match(fn, /No assessor record found for/)
  assert.match(fn, /search box may still show someone else/i, 'warn about the stale box')
  assert.match(fn, /href="\$\{assessorUrl\(client\)\}"/, 'but still offer the search')
})

test('the tab is only navigated to a parcel we matched', () => {
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  assert.match(fn, /if \(parcel\) \{/)
  assert.match(fn, /tab\.location\.replace\(parcel\)/)
  assert.match(fn, /tab\.opener = null/, 'drop the opener once we leave our own page')
})

test('noopener is NOT used, or the tab could never be steered', () => {
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  // window.open(..., 'noopener') returns null, so the jump silently never happened
  assert.ok(!/window\.open\('', '_blank', 'noopener'\)/.test(fn))
  assert.match(fn, /window\.open\('', '_blank'\)/)
})

test('a second click while one is running is ignored', () => {
  assert.match(src, /if \(assessorBusyRef\.current\) \{ e\.preventDefault\(\); return \}/)
})


test('a blocked popup falls through to the link instead of doing nothing', () => {
  // window.open returns null when blocked; preventing the default first meant the click
  // produced no tab, no navigation and no message at all
  const fn = src.slice(src.indexOf('const openAssessor = (e) =>'), src.indexOf('const openAssessor = (e) =>') + 4600)
  const open = fn.indexOf('window.open(')
  const prevent = fn.indexOf('e.preventDefault()', open)
  assert.ok(open > 0 && prevent > open, 'the tab must be opened BEFORE the default is prevented')
  assert.match(fn, /if \(!tab\) return/)
})

test('the tooltip names the assessor the parcel actually lives on', () => {
  // a cached reply carries only the url, so `host` is undefined and every parcel read
  // "Linn County" - including cedarrapids ones
  assert.match(src, /cedarrapids\\./.source ? /test\(assessor\.parcel\)/ : /x/)
  assert.ok(!/assessor\.host === 'cedarrapids'/.test(src), 'host is absent on a cached reply')
})
