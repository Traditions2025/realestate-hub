// MLS Expired/Cancelled → Watch rule (John, 2026-09-18): a lead tagged
// "MLS: Expired" or "MLS: Cancelled" while sitting in New moves to Watch.
// Every other status (junk, qualify, closed, …) is a human's deliberate call
// and must never be touched. Recurring: runs after each master sync and on
// every scheduler tick.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { enforceWatchForMlsTagged } = await import('../server/expired-master.js')

const seeded = []
function mk(status, tags) {
  const r = db.run(
    `INSERT INTO clients (first_name, last_name, type, status, source, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    ['WatchRule', 'Test' + Date.now() + Math.floor(Math.random() * 1e6), 'seller', status,
     'Expired/Cancelled Mls', JSON.stringify(tags), new Date().toISOString(), new Date().toISOString()])
  seeded.push(r.lastInsertRowid)
  return r.lastInsertRowid
}
const statusOf = (id) => db.get('SELECT status FROM clients WHERE id=?', [id]).status

test('new + MLS: Expired moves to watch', async () => {
  const id = mk('new', ['MLS: Expired'])
  const res = await enforceWatchForMlsTagged()
  assert.ok(res.ids.includes(id))
  assert.equal(statusOf(id), 'watch')
})

test('new + MLS: Cancelled moves to watch', async () => {
  const id = mk('new', ['MLS: Cancelled', 'other-tag'])
  await enforceWatchForMlsTagged()
  assert.equal(statusOf(id), 'watch')
})

test('junk and qualify with MLS tags are never touched', async () => {
  const junk = mk('junk', ['MLS: Expired'])
  const qual = mk('qualify', ['MLS: Cancelled'])
  const closed = mk('closed', ['MLS: Expired'])
  await enforceWatchForMlsTagged()
  assert.equal(statusOf(junk), 'junk')
  assert.equal(statusOf(qual), 'qualify')
  assert.equal(statusOf(closed), 'closed')
})

test('new WITHOUT an MLS tag stays new', async () => {
  const id = mk('new', ['Realist', 'Sierra: Expired'])   // Sierra: tags are NOT part of the rule
  await enforceWatchForMlsTagged()
  assert.equal(statusOf(id), 'new')
})

test('cleanup seeded rows', () => {
  for (const id of seeded) db.run('DELETE FROM clients WHERE id=?', [id])
})

// ── Last market price (John, 2026-09-22) ────────────────────────────────────
// The master file has no price column; the daily MLS pull writes the list price
// into the Notes blob. The parser must take ONLY the two structured shapes and
// must never mistake a SALE/purchase price for the last list price.
test('parseMlsListPrice reads the list price from the two structured note shapes', async () => {
  const { parseMlsListPrice } = await import('../server/expired-master.js')
  // leading structured field
  assert.equal(parseMlsListPrice('Skipped, was back on market. $175,000; DOM 0; Recent: 07/24/2026 : CANCL : A->C'), 175000)
  assert.equal(parseMlsListPrice('$229,500; DOM 87; Recent: 08/25/2026 : EXPD : A->X; History: 2603483=Expired'), 229500)
  // export phrasing
  assert.equal(parseMlsListPrice('List Agent: Doug Junge; List Date 08/18/2026; DOM 34; Cancelled 09/21/2026 P->C (MLS 2605830) at $199,900; 1966 1.75 story'), 199900)
})

test('parseMlsListPrice NEVER returns a sale/purchase price or nonsense', async () => {
  const { parseMlsListPrice } = await import('../server/expired-master.js')
  // real notes from the sheet: these dollars are SALE prices, not list prices
  assert.equal(parseMlsListPrice('As of 2026-08-24: SOLD (2603825 Sold $125,000 on 06/30/2026). In Sierra before the daily runs began'), null)
  assert.equal(parseMlsListPrice('STILL OFF MARKET (not listed since; last MLS record is a sale on 04/08/2024 for $171,000, which is how the owner bought it)'), null)
  assert.equal(parseMlsListPrice(''), null)
  assert.equal(parseMlsListPrice(null), null)
  assert.equal(parseMlsListPrice('no dollars here; DOM 12'), null)
  assert.equal(parseMlsListPrice('$12; DOM 4'), null, 'implausibly small amount rejected')
})
