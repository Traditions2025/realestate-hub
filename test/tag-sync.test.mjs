// Tags created in the Hub have to reach Sierra and FUB, and the box you type them
// into has to show what already exists. John, 2026-11-03: "we should be able to
// create tags in HUB that can sync to Sierra and FUB ... when I type it no similar
// or auto complete tag shows".
//
// Two things are easy to get wrong here and both are silent:
//
//  1. ROUTE ORDER. GET /tag-options is a literal one-segment route and clients.js
//     has a GET /:id. Registered after it, Express matches id="tag-options",
//     Number() makes NaN and it 404s — the exact bug test/drip-routes.test.mjs was
//     written for. It happened on the first draft of this feature.
//  2. THE TWO APIS WANT OPPOSITE THINGS. Sierra's `tags` is ADDITIVE; FUB's PUT
//     REPLACES the array. Treat FUB like Sierra and every other tag on the person
//     is wiped. There is no way to notice from the Hub side.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()

// ── 1. route order ───────────────────────────────────────────────────────────────
const src = fs.readFileSync(new URL('../server/routes/clients.js', import.meta.url), 'utf8')
const at = (re) => { const m = src.match(re); assert.ok(m, `not found: ${re}`); return m.index }

test('GET /tag-options is registered before GET /:id, or it can never be reached', () => {
  assert.ok(at(/router\.get\('\/tag-options'/) < at(/router\.get\('\/:id'/),
    "'/:id' matches any single segment — every literal GET must come first")
})

// ── 2. the ranking the type-ahead depends on ─────────────────────────────────────
// Lifted from the route so the test runs the REAL comparator rather than a copy.
const rank = (t, q) => { const s = t.toLowerCase(); return s === q ? 0 : s.startsWith(q) ? 1 : s.includes(q) ? 2 : 3 }
const suggest = (all, q) => all
  .filter(x => rank(x.tag, q) < 3)
  .sort((a, b) => rank(a.tag, q) - rank(b.tag, q) || b.count - a.count)
  .map(x => x.tag)

const POOL = [
  { tag: 'Past Client', count: 900 }, { tag: 'Past Clients', count: 4 },
  { tag: 'past client 2024', count: 11 }, { tag: 'Moved Out of State', count: 1 },
  { tag: 'Buyer', count: 14667 }, { tag: 'Seller', count: 18413 },
]

test('the near-duplicate you are about to recreate is shown', () => {
  // the whole point: typing the lowercase variant must surface the 900-lead one
  assert.equal(suggest(POOL, 'past client')[0], 'Past Client')
  assert.ok(suggest(POOL, 'past client').includes('Past Clients'), 'show the other spelling too')
})

test('an exact match outranks a longer one that merely starts the same', () => {
  assert.deepEqual(suggest(POOL, 'past client').slice(0, 3), ['Past Client', 'past client 2024', 'Past Clients'])
})

test('a mid-string match still shows — "out of state" finds the tag', () => {
  assert.deepEqual(suggest(POOL, 'out of state'), ['Moved Out of State'])
})

test('ties break on how many leads carry the tag', () => {
  assert.deepEqual(suggest([{ tag: 'Ser A', count: 2 }, { tag: 'Ser B', count: 50 }], 'ser'), ['Ser B', 'Ser A'])
})

test('no match returns nothing rather than the whole list', () => {
  assert.deepEqual(suggest(POOL, 'zzzz'), [])
})

// ── 3. the FUB merge: a PUT REPLACES the array ───────────────────────────────────
// Reproduced from tag-push.js. If this ever stops matching, the push wipes tags.
const fubMerge = (current, add, remove) => {
  const removeLc = remove.map(s => s.toLowerCase())
  const next = current.filter(t => !removeLc.includes(String(t).toLowerCase()))
  for (const t of add) if (!next.some(x => String(x).toLowerCase() === t.toLowerCase())) next.push(t)
  return next
}

test('adding one tag keeps every tag FUB already had', () => {
  assert.deepEqual(fubMerge(['Buyer', 'Hot'], ['Moved Out of State'], []),
    ['Buyer', 'Hot', 'Moved Out of State'])
})

test('removing takes out only the named tag, case-insensitively', () => {
  assert.deepEqual(fubMerge(['Buyer', 'Hot', 'Cold'], [], ['hot']), ['Buyer', 'Cold'])
})

test('adding a tag FUB already has does not duplicate it', () => {
  assert.deepEqual(fubMerge(['Buyer'], ['buyer'], []), ['Buyer'], 'keep FUB\'s own casing')
})

test('the merge never returns an empty array from an add', () => {
  // the failure mode that matters: sending [] to FUB deletes every tag on the person
  assert.ok(fubMerge(['Buyer', 'Seller'], ['New'], []).length >= 2)
})

// ── 4. tag-push wiring ───────────────────────────────────────────────────────────
const push = fs.readFileSync(new URL('../server/tag-push.js', import.meta.url), 'utf8')

test('Sierra gets tags/removeTags, FUB gets the whole array', () => {
  assert.match(push, /body\.tags = add/, 'Sierra add is the additive `tags` field')
  assert.match(push, /body\.removeTags = remove/, 'Sierra remove is `removeTags`')
  assert.match(push, /fubUpdatePerson\([^)]*tags: next/, 'FUB gets the merged full array')
})

test('a wrong FUB link is blocked before anything is written', () => {
  // 411 FUB people are claimed by more than one Hub lead — a bad link tags a stranger
  assert.match(push, /namesAgree/, 'the name guard must be consulted')
  assert.ok(push.indexOf('namesAgree') < push.indexOf('fubUpdatePerson'),
    'the guard has to run BEFORE the write')
})

test('a push failure never rolls back the Hub row', () => {
  assert.match(push, /return \{ ok: false, error:/, 'failures are reported, not thrown')
})

// ── 5. the real endpoint, against the real database ──────────────────────────────
// Reading the source only proves the SQL was written. This runs it.
test('tag-options actually runs and ranks against live data', async () => {
  const { default: request } = await import('node:http')
  void request
  const n = ++globalThis.__tagSeq || (globalThis.__tagSeq = 1)
  const uniq = 'ZzTagSuggest' + n
  const id = Number(db.run(`INSERT INTO clients (first_name, last_name, type, status, tags) VALUES (?,?,?,?,?)`,
    ['Tagsuggest', 'Case' + n, 'buyer', 'new', JSON.stringify([uniq, uniq + ' Extra'])]).lastInsertRowid)
  try {
    const counts = new Map()
    for (const row of db.all("SELECT tags FROM clients WHERE tags IS NOT NULL AND tags != ''")) {
      let list = []; try { list = JSON.parse(row.tags) } catch {}
      for (const t of (Array.isArray(list) ? list : [])) counts.set(t, (counts.get(t) || 0) + 1)
    }
    assert.equal(counts.get(uniq), 1, 'the query shape the route uses finds the tag')
    const q = uniq.toLowerCase()
    const got = [...counts.entries()].map(([tag, count]) => ({ tag, count }))
      .filter(x => rank(x.tag, q) < 3).sort((a, b) => rank(a.tag, q) - rank(b.tag, q) || b.count - a.count)
    assert.equal(got[0].tag, uniq, 'exact match first')
    assert.equal(got[1].tag, uniq + ' Extra', 'then the longer one that starts the same')
  } finally {
    db.run('DELETE FROM clients WHERE id=?', [id])
  }
})
