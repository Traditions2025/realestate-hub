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

// ── the deep link ────────────────────────────────────────────────────────────────────
// REVERTED 2026-10-01 at John's instruction. I had changed this to land on /search/res/
// and copy the address; he reported that it then pre-filled the PREVIOUS search
// (6528 Medford Ln NE showing on Adrien Voellinger) and that the original link was
// working for him. His earlier note about mobile was that pasting there gives the
// CORRECT address, not a complaint. Back to what shipped in 90b6d00.
test('the street address is deep-linked into the search', () => {
  const u = assessorUrl({ address: '6528 Medford Ln NE', city: 'Cedar Rapids' })
  assert.equal(u, 'https://cedarrapids.iowaassessors.com/search/res/results.php?ifulladdress=6528%20Medford%20Ln%20NE&process=1')
})

test('the address is encoded, so spaces and hashes survive', () => {
  const u = assessorUrl({ address: '190 Cottage Grove Ave SE Unit #302', city: 'Cedar Rapids' })
  assert.ok(!/ /.test(u), 'a raw space would truncate the query')
  assert.match(u, /Unit%20%23302/)
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

test('nothing was lost: the two unique chips are on the details card', () => {
  const crm = src.slice(src.indexOf("<div className=\"cp-sub\">CRM</div>"))
  const card = crm.slice(0, crm.indexOf('Social'))
  assert.match(card, /<strong>Realist Score:<\/strong>\s*<RealistScoreBadge/, 'still click-to-edit')
  assert.match(card, /<strong>Intent:<\/strong>/)
})

test('Type, Status and Agent stay editable where they already were', () => {
  const crm = src.slice(src.indexOf("<div className=\"cp-sub\">CRM</div>"))
  const card = crm.slice(0, crm.indexOf('Social'))
  for (const pill of ['TypePill', 'StatusPill', 'AgentPill'])
    assert.match(card, new RegExp(`<${pill} client=\{client\} onSaved=\{onSaved\}`), `${pill} must remain`)
})

test('intent reaches the details card from the parent', () => {
  assert.match(src, /function ClientDetails\(\{ client, onSaved, intent = null, intentLevel = null \}\)/)
  assert.match(src, /<ClientDetails client=\{client\} onSaved=\{load\} intent=\{intent\} intentLevel=\{ai\?\.intent\?\.level\}/)
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
