// FSBO master file: CSV parsing must survive quoted multi-line fields with embedded
// commas and newlines (the master sheet's Notes column is a Zillow blob).
import { test } from 'node:test'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { parseCsv } from '../server/fsbo-master.js'

test('parseCsv handles quoted fields with commas and newlines', () => {
  const csv = 'Name,Phone 1,Notes,FSBO Status\n' +
    'Paul Lovisa,(319) 531-0905,"$170,000\n1235 14th St, Marion, IA\n3 beds",Available\n' +
    'Beau Barnes,(515) 422-8571,"simple note",Off Market\n'
  const rows = parseCsv(csv)
  assert.equal(rows.length, 3)                 // header + 2 data rows
  assert.deepEqual(rows[0], ['Name', 'Phone 1', 'Notes', 'FSBO Status'])
  assert.equal(rows[1][0], 'Paul Lovisa')
  assert.equal(rows[1][1], '(319) 531-0905')
  assert.ok(rows[1][2].includes('$170,000'))   // comma preserved inside quotes
  assert.ok(rows[1][2].includes('Marion, IA')) // embedded newline+comma preserved
  assert.equal(rows[1][3], 'Available')
  assert.equal(rows[2][3], 'Off Market')
})

test('parseCsv handles escaped double-quotes', () => {
  const rows = parseCsv('A,B\n"say ""hi""",x\n')
  assert.equal(rows[1][0], 'say "hi"')
  assert.equal(rows[1][1], 'x')
})

// ── which FSBO Status values end the lead (John, 2026-10-01) ──────────────────────────
// The sheet carries five values. Sold and Disregard used to fall through to null, and a
// null status makes the sync SKIP the row — which is not the same as removing it. Four of
// the seven Disregard rows were still live on the Hub's FSBO list, frozen at the
// "Off Market" they had held before the sheet was changed.
import { normStatus, JUNK_FSBO_STATUS, JUNK_FSBO_LABEL } from '../server/fsbo-master.js'

test('every status the sheet actually uses is recognised', () => {
  // these five are the real values counted in the live master file
  assert.equal(normStatus('Available'), 'Available')
  assert.equal(normStatus('Pending'), 'Pending')
  assert.equal(normStatus('Sold'), 'Sold')
  assert.equal(normStatus('Disregard'), 'Disregard')
  assert.equal(normStatus('Off Market'), 'Off Market')
})

test('Sold and Disregard no longer fall through to null', () => {
  // null is what caused the row to be skipped and the stale value to survive
  for (const v of ['Sold', 'sold', 'SOLD', 'Disregard', 'disregard', 'Disregarded'])
    assert.ok(normStatus(v), `"${v}" must not be skipped`)
})

test('case and surrounding space do not matter', () => {
  assert.equal(normStatus('  sold  '), 'Sold')
  assert.equal(normStatus('DISREGARD'), 'Disregard')
  assert.equal(normStatus('under contract'), 'Pending')
  assert.equal(normStatus('Withdrawn'), 'Off Market')
  assert.equal(normStatus('Expired'), 'Off Market')
})

test('an empty or unknown status is still skipped', () => {
  for (const v of ['', null, undefined, '   ', 'maybe?'])
    assert.equal(normStatus(v), null)
})

test('Pending, Sold and Disregard end the lead; Off Market and Available do not', () => {
  assert.deepEqual(Object.keys(JUNK_FSBO_STATUS).sort(), ['Disregard', 'Pending', 'Sold'])
  assert.ok(!('Off Market' in JUNK_FSBO_STATUS), 'Off Market sellers stay on the list')
  assert.ok(!('Available' in JUNK_FSBO_STATUS))
})

test('each ending says WHY on the record', () => {
  // Disregard means they listed with an agent - that is the point of keeping the reason
  assert.match(JUNK_FSBO_STATUS.Disregard, /listed with an agent/i)
  assert.match(JUNK_FSBO_STATUS.Sold, /sold/i)
  assert.match(JUNK_FSBO_STATUS.Pending, /under contract/i)
  assert.equal(JUNK_FSBO_LABEL.Disregard, 'Listed with an Agent')
  for (const k of Object.keys(JUNK_FSBO_STATUS)) assert.ok(JUNK_FSBO_LABEL[k], `${k} needs a label`)
})

// ── aggregating a seller's listings ──────────────────────────────────────────────────
// The per-seller aggregate is what actually writes fsbo_status. It read
// "Available, else Pending, else Off Market", which collapsed every other value into
// Off Market - so Disregard and Sold reached the Hub as Off Market, stayed on the list
// and were never junked. normStatus had them right; this line discarded the answer.
const aggregate = (statuses) => {
  const grp = statuses.map(s => ({ status: s }))
  const ENDINGS = ['Pending', 'Sold', 'Disregard']
  return grp.some(r => r.status === 'Available') ? 'Available'
    : (ENDINGS.find(e => grp.some(r => r.status === e)) || 'Off Market')
}

test('an ending survives aggregation instead of becoming Off Market', () => {
  assert.equal(aggregate(['Disregard']), 'Disregard')
  assert.equal(aggregate(['Sold']), 'Sold')
  assert.equal(aggregate(['Pending']), 'Pending')
  assert.equal(aggregate(['Off Market']), 'Off Market')
})

test('still-for-sale beats every ending', () => {
  // one listing sold, another still on the market -> the seller is still a live FSBO
  assert.equal(aggregate(['Sold', 'Available']), 'Available')
  assert.equal(aggregate(['Disregard', 'Available']), 'Available')
  assert.equal(aggregate(['Available', 'Pending', 'Off Market']), 'Available')
})

test('the aggregate in the source matches this precedence', () => {
  const src = fs.readFileSync(new URL('../server/fsbo-master.js', import.meta.url), 'utf8')
  assert.match(src, /const ENDINGS = \['Pending', 'Sold', 'Disregard'\]/)
  assert.ok(!/: grp\.some\(r => r\.status === 'Pending'\) \? 'Pending' : 'Off Market'/.test(src),
    'the old collapse-everything-to-Off-Market line must be gone')
})

// ── names from the master sheet ──────────────────────────────────────────────────────
// John, 2026-10-05: the scraper could not get the owner names on the first run and got them
// on the second, but the Hub never received them - first_name/last_name were only ever
// written on INSERT, never on a matched lead.
const { isPlaceholderName } = await import('../server/fsbo-master.js')

test('a placeholder name may be replaced from the sheet', () => {
  // "(Owner - name unknown)" is what fsbo-write-names.js writes when the lookup fails
  assert.ok(isPlaceholderName('(Owner', '- name unknown)'))
  assert.ok(isPlaceholderName('', ''))
  assert.ok(isPlaceholderName(null, null))
  assert.ok(isPlaceholderName('Owner', ''))
  assert.ok(isPlaceholderName('Unknown', ''))
  assert.ok(isPlaceholderName('FSBO', ''))
})

test('a REAL name is never overwritten by the sheet', () => {
  // 8 Hub names disagree with the sheet and most are not corrections: a spouse
  // ("Sara" vs "Darren Sholes"), a different owner entirely, and one that would replace a
  // person with "Renofixation LLC". Those need a human, not a sync.
  for (const [f, l] of [['Kenneth', 'Leahy'], ['Tammy', 'Facion'], ['Renofixation', 'LLC'],
                        ['Sara', 'Sholes'], ['Laurel and Paul', 'Langholz']])
    assert.ok(!isPlaceholderName(f, l), `${f} ${l} must be kept`)
})

test('the sync fills the name only when it is a placeholder', () => {
  const src = fs.readFileSync(new URL('../server/fsbo-master.js', import.meta.url), 'utf8')
  assert.match(src, /first_name = CASE WHEN \? != '' THEN \? ELSE first_name END/)
  assert.match(src, /const canFill = sheetName && isPlaceholderName\(match\.first_name, match\.last_name\)/)
})
