// Paging the client list needs a UNIQUE sort key. The default, sierra_update_date DESC,
// ties across thousands of rows (many are NULL), and SQLite orders ties arbitrarily — so
// walking 46k records 5,000 at a time silently skipped some and returned others twice.
// A whole-file audit run that way looked complete and was not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const src = fs.readFileSync(new URL('../server/routes/clients.js', import.meta.url), 'utf8')

test('a unique-key sort exists for paging the whole file', () => {
  assert.match(src, /id_asc:\s*'id ASC'/, 'id_asc must stay available for bulk audits')
})

test('the default sort is still recent_activity, so the UI is unchanged', () => {
  assert.match(src, /const sortKey = req\.query\.sort \|\| 'recent_activity'/)
})

test('every sort option is a bare column expression, never interpolated input', () => {
  // orderBy is spliced straight into the SQL, so it must only ever come from this map
  assert.match(src, /const orderBy = SORT_OPTIONS\[sortKey\] \|\| SORT_OPTIONS\.recent_activity/)
})
