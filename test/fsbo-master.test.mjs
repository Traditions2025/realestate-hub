// FSBO master file: CSV parsing must survive quoted multi-line fields with embedded
// commas and newlines (the master sheet's Notes column is a Zillow blob).
import { test } from 'node:test'
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
