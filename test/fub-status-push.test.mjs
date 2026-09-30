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
const { STATUS_TO_STAGE, PUSH_TAG, candidates } = await import('../server/fub-status-push.js')

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
  assert.match(src, /delayMs = 220/)
  assert.match(src, /setTimeout\(s, delayMs\)/)
})
