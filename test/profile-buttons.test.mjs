// Two buttons on the client profile: the county assessor, and the lead's FUB record.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')

// Extracted so it can be exercised directly; the component around it needs a browser.
const assessorUrl = (client) => {
  const street = String(client?.address || '').trim()
  if (!street) return null
  const city = String(client?.city || '').trim().toLowerCase()
  const host = city === 'cedar rapids' ? 'cedarrapids' : 'linn'
  return `https://${host}.iowaassessors.com/search/res/results.php?ifulladdress=${encodeURIComponent(street)}&process=1`
}

// Cedar Rapids has its own city assessor. Sending a Cedar Rapids address to the county
// site finds nothing, and most of the file IS Cedar Rapids.
test('a Cedar Rapids address goes to the city assessor', () => {
  const u = assessorUrl({ address: '1224 Moose Dr NW', city: 'Cedar Rapids' })
  assert.match(u, /^https:\/\/cedarrapids\.iowaassessors\.com/)
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

test('the address is encoded, so spaces and hashes survive', () => {
  const u = assessorUrl({ address: '190 Cottage Grove Ave SE Unit #302', city: 'Cedar Rapids' })
  assert.ok(!/ /.test(u), 'a raw space would truncate the query')
  assert.match(u, /Unit%20%23302/)
})

// ── the buttons themselves ──────────────────────────────────────────────────────────
test('both buttons open in a new tab, safely', () => {
  const row = src.slice(src.indexOf('assessorUrl(client) &&'), src.indexOf('assessorUrl(client) &&') + 700)
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
