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
