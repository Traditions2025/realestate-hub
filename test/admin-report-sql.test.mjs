// A GROUP BY alias must not collide with a real column name.
//
// GET /api/admin/text-delivery reported every outgoing text in two buckets, both labelled
// "delivered" — 3,583 and 141. The SELECT aliased COALESCE(delivery_status, ...) AS
// `status`, and communications HAS a `status` column (unread | read | closed). SQLite
// binds GROUP BY to the real column before the output alias, so it grouped by read/unread
// and labelled each group with whatever the first row's COALESCE happened to be.
//
// It did not error. It produced a plausible, wrong answer, which is worse.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../server/routes/admin.js', import.meta.url), 'utf8')

const columnsOf = async (table) => {
  const { default: db, initDb } = await import('../server/database.js')
  await initDb()
  return new Set(db.all(`PRAGMA table_info(${table})`).map(r => String(r.name).toLowerCase()))
}

test('no GROUP BY in admin reports uses an alias that is also a column', async () => {
  const comm = await columnsOf('communications')
  const clients = await columnsOf('clients')
  const real = new Set([...comm, ...clients])
  // every "<expr> AS alias ... GROUP BY alias" pair in the file
  const groups = [...src.matchAll(/GROUP BY ([a-z_]+)/gi)].map(m => m[1].toLowerCase())
  assert.ok(groups.length >= 3, 'expected several grouped reports, found ' + groups.length)
  for (const g of groups) {
    // grouping by a genuine column is fine; the bug is grouping by an ALIAS that shadows one
    const aliased = new RegExp(`\\)\\s*${g}\\s*,\\s*COUNT\\(`, 'i').test(src)
      || new RegExp(`\\bAS\\s+${g}\\b`, 'i').test(src)
    if (aliased) {
      assert.ok(!real.has(g),
        `GROUP BY ${g} binds to the real column, not the alias — rename the alias`)
    }
  }
})

test('the text-delivery breakdown groups by its own alias', async () => {
  const comm = await columnsOf('communications')
  // scope to the text-delivery route first: another endpoint now also has a by_status
  // key, and a bare indexOf finds whichever appears first in the file
  const route = src.indexOf("router.get('/text-delivery'")
  assert.ok(route > -1, 'text-delivery route not found')
  const i = src.indexOf('by_status:', route)
  const q = src.slice(i, src.indexOf('\n', i + 200))
  const alias = (q.match(/\)\s*([a-z_]+), COUNT/) || [])[1]
  assert.ok(alias, 'could not find the alias')
  assert.ok(!comm.has(alias), `"${alias}" is a real communications column`)
  assert.match(q, new RegExp('GROUP BY ' + alias))
})

test('the buckets add up to the total', async () => {
  // the symptom that gave it away: two buckets summing to every text ever sent, with
  // the failures counted elsewhere far exceeding the non-delivered bucket
  const { default: db, initDb } = await import('../server/database.js')
  await initDb()
  const base = "FROM communications WHERE channel='text' AND direction='outgoing' AND external_id LIKE 'twilio_%'"
  const total = db.get(`SELECT COUNT(*) c ${base}`).c
  const rows = db.all(`SELECT COALESCE(NULLIF(delivery_status,''),'(no receipt)') delivery, COUNT(*) n ${base} GROUP BY delivery`)
  assert.equal(rows.reduce((a, b) => a + b.n, 0), total)
  const labels = rows.map(r => r.delivery)
  assert.equal(new Set(labels).size, labels.length, 'two buckets with the same label means the grouping is wrong')
})

// ── the property-interest search must run, not just parse ────────────────────────────
// It shipped joining realist_properties on r.mls_number — a column that does not exist;
// that table is keyed on the ADDRESS. Every source-reading check passed and the endpoint
// 500'd on its first real call. Same lesson as `active` on drip_campaigns, in a new file.
test('the property-interest query runs against the real schema', async () => {
  const { default: db, initDb } = await import('../server/database.js')
  await initDb()
  const i = src.indexOf('const rows = db.all(`')
  assert.ok(i > -1, 'property-interest query not found')
  const open = 'const rows = db.all(`'
  let q = src.slice(i + open.length, src.indexOf('`,', i)).replace(/\$\{[^}]*\}/g, '')
  const n = (q.match(/\?/g) || []).length
  assert.doesNotThrow(() => db.all(q, Array(n).fill('')),
    'the search query does not execute: ' + q.slice(0, 120))
})

test('it joins realist on the address, not on an MLS column it lacks', async () => {
  const { default: db, initDb } = await import('../server/database.js')
  await initDb()
  const cols = new Set(db.all('PRAGMA table_info(realist_properties)').map(r => String(r.name)))
  assert.ok(!cols.has('mls_number'), 'if realist gains an MLS column, revisit this join')
  assert.match(src, /lower\(r\.property_address\) = lower\(a\.prop_street\)/)
})
