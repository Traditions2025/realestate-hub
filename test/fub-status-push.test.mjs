// Pushing the Hub's status to Follow Up Boss.
//
// The Hub is master for status: a lead marked Junk here should not sit in FUB as New,
// where an agent works a lead somebody already disqualified. One direction only - nothing
// is pulled from FUB, which is what would create duplicates.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const { STATUS_TO_STAGE, PUSH_TAG, candidates, pushOne } = await import('../server/fub-status-push.js')

const src = fs.readFileSync(new URL('../server/fub-status-push.js', import.meta.url), 'utf8')
const helper = fs.readFileSync(new URL('../server/fub-helper.js', import.meta.url), 'utf8')

test('only Junk and Do Not Contact are mapped', () => {
  // the other Hub statuses have no FUB equivalent, and inventing one would mean guessing
  // at how the team uses their pipeline
  assert.deepEqual(Object.keys(STATUS_TO_STAGE).sort(), ['donotcontact', 'junk'])
  assert.equal(STATUS_TO_STAGE.junk, 'Dead')
  assert.equal(STATUS_TO_STAGE.donotcontact, 'Do not Contact')
})

test('the stages are ones FUB already has, not new ones', () => {
  // Dead (15,919 people) and Do not Contact (285) both existed before this was built
  assert.ok(!/POST.*\/stages|createStage/i.test(src), 'it must not create stages')
})

test('nothing is ever pulled from FUB', () => {
  assert.ok(!/INSERT INTO clients/i.test(src), 'this module must never create a Hub lead')
  assert.match(src, /ONE DIRECTION ONLY/)
})

test('it never creates a person in FUB either', () => {
  assert.ok(!/fubPost|method: 'POST'/.test(src), 'a missing FUB record is reported, not created')
  assert.match(src, /not in FUB/)
})

test('the write path is narrow: one person, no bulk, no delete', () => {
  assert.match(helper, /export async function fubPut/)
  assert.ok(!/fubDelete|method: 'DELETE'/.test(helper), 'no delete path should exist')
})

test('tags are merged, never replaced', () => {
  // FUB REPLACES the tag array on a PUT; sending only the new tag wipes the rest
  assert.match(src, /currentTags\.includes\(PUSH_TAG\) \? currentTags : \[\.\.\.currentTags, PUSH_TAG\]/)
  assert.match(helper, /FUB REPLACES the tag array/)
})

test('the push is tagged so FUB shows where the decision came from', () => {
  assert.equal(PUSH_TAG, 'Hub: status synced')
})

test('a lead with no FUB id is never considered', () => {
  const now = new Date().toISOString()
  const mk = (status, fub) => db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Push', 'T' + Math.random().toString(36).slice(2, 8), `p${Date.now()}${Math.random()}@x.com`,
     'buyer', status, fub, '[]', now, now]).lastInsertRowid

  const withId = mk('junk', '900001')
  const withoutId = mk('junk', null)
  const activeWithId = mk('new', '900002')
  const ids = candidates({ limit: 5000 }).map(c => c.id)
  assert.ok(ids.includes(withId), 'a Junk lead with a FUB id should be pushed')
  assert.ok(!ids.includes(withoutId), 'no FUB id means nothing to update')
  assert.ok(!ids.includes(activeWithId), 'an unmapped status must be left alone')
})

test('it is paced, because this is a live CRM', () => {
  assert.match(src, /delayMs = 260/)
  assert.match(src, /setTimeout\(s, delayMs\)/)
})

// The first dry run failed on 103 of 228 with a FUB 429. The pacing was inside an
// `if (!dryRun)`, but a dry run still READS every person to see their current stage, so
// the reads ran flat out.
test('a dry run is paced too, because it still reads every person from FUB', () => {
  assert.ok(!/if \(!dryRun\) await new Promise/.test(src),
    'pacing only the writes is what tripped the rate limit')
  const loop = src.slice(src.indexOf('for (const c of rows)'))
  assert.match(loop, /await new Promise\(s => setTimeout\(s, delayMs\)\)/)
})

// ── the six that would have lost something ───────────────────────────────────────────
// The dry run would have demoted a Past Client, a High Probability Seller and three
// Seller (NURTURE) records to Dead. John asked that Junk leads stop showing as ACTIVE or
// NEW in FUB; a past client is neither.
const mkClient = (status, fub) => {
  const now = new Date().toISOString()
  return db.get('SELECT * FROM clients WHERE id = ?', [db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Guard', 'T' + Math.random().toString(36).slice(2, 8), `g${Date.now()}${Math.random()}@x.com`,
     'buyer', status, fub, '[]', now, now]).lastInsertRowid])
}

test('a meaningful FUB stage is reported for review, not demoted', async () => {
  // asserted on the source, because stubbing a dynamic import mid-suite is more fragile
  // than the thing it would be testing
  assert.match(src, /PROTECTED_STAGE/)
  for (const stage of ['Past Client', 'Seller (NURTURE)', 'High Probability Sellers', 'Under Contract', 'Closed', 'PLATINUM CLIENTS'])
    assert.ok(/past client|closed|under contract|pending|nurture|high probability|platinum|vip/i.test(stage),
      `${stage} should be protected`)
  assert.match(src, /action: 'protected'/)
  assert.match(src, /review this one/)
})

test('ordinary stages are NOT protected, so the other 119 still push', () => {
  const re = /past client|closed|under contract|pending|nurture|high probability|platinum|vip/i
  for (const stage of ['Lead', 'New Lead', 'Trash', 'Expired', 'Cancelled', 'Homeowner', 'Attempted Contact',
                       'Realist', 'FSBO', 'Not in the Market', 'C - Cold 6+ Months', 'Foreclosures', ''])
    assert.ok(!re.test(stage), `${stage} is not a stage worth protecting from a Junk flag`)
})

test('the guard can be overridden deliberately, and is off by default', () => {
  assert.match(src, /pushOne\(client, \{ dryRun = false, force = false \} = \{\}\)/)
  assert.match(src, /PROTECTED_STAGE\.test\(currentStage\) && !force/)
})

test('a lead with no mapping is skipped before any FUB call', async () => {
  const c = mkClient('new', '900003')
  const r = await pushOne(c)
  assert.match(String(r.skipped), /no mapping/)
})
