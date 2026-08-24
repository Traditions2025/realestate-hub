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
