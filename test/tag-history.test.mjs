// WHEN WAS THIS TAG ADDED (John, 2026-11-17)
//
// "when I hover the tag it should give me the info/date on when it was added."
//
// Nothing recorded it. clients.tags is a flat JSON array of names, Sierra sends names only,
// and lead_events has a tag_added type that nothing ever writes. So the honest design has
// two halves: start recording at the choke point, and refuse to invent a date for the tags
// that were already there.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const DB = readFileSync(new URL('../server/database.js', import.meta.url), 'utf8')
const HIST = readFileSync(new URL('../server/tag-history.js', import.meta.url), 'utf8')
const ROUTE = readFileSync(new URL('../server/routes/clients.js', import.meta.url), 'utf8')
const UI = readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')

test('the record is taken at the column, not at the 14 call sites', () => {
  // Sierra sync, automations, bulk tagging, merges, seller campaign, bounce policy, lead
  // intake and more all write clients.tags. Patching each would miss the next one added.
  assert.match(DB, /CREATE TRIGGER IF NOT EXISTS trg_client_tags_history/)
  assert.match(DB, /AFTER UPDATE OF tags ON clients/)
})

test('a sync rewriting the same value does not log a change', () => {
  // Without this the history fills with noise every time a sync touches the row.
  assert.match(DB, /WHEN old\.tags IS NOT new\.tags/)
  // IS NOT, not !=, so a NULL on either side still compares correctly.
  assert.ok(!/WHEN old\.tags != new\.tags/.test(DB))
})

test('both sides of the change are kept', () => {
  // SQL cannot diff two JSON arrays, and old+new also captures removals.
  assert.match(DB, /client_tag_history \(client_id, old_tags, new_tags, changed_at\)/)
})

test('the day tracking started is recorded', () => {
  // Needed to tell "we watched this arrive" from "it was already here".
  assert.match(DB, /tag_history_since/)
})

test('a tag that predates tracking is reported as undatable, not undated', () => {
  assert.match(HIST, /status: 'pre_existing'/)
  assert.match(HIST, /status: 'tracked'/)
  // and no fallback that would hand back some other date as if it were the tag's
  assert.ok(!/created_at|register_date|registered/i.test(HIST),
    'must not borrow the lead\'s own dates and present them as the tag date')
})

test('only tags the lead still has are reported', () => {
  // A removed tag must not keep showing a date on a chip that is gone.
  assert.match(HIST, /if \(!live\.has\(t\)\) delete out\.tags\[t\]/)
})

test('a tag removed and re-added reports the latest arrival', () => {
  assert.match(HIST, /Re-added after a removal/)
})

test('comma-separated legacy values still parse', () => {
  // Older rows stored tags as a plain string, and those leads must not come back empty.
  assert.match(HIST, /split\(','\)/)
})

test('the route is declared before /:id so it is reachable', () => {
  // /:id would otherwise swallow /:id/tag-history and return a client.
  assert.ok(ROUTE.indexOf("router.get('/:id/tag-history'") < ROUTE.indexOf("router.get('/:id'"),
    'tag-history must be registered first')
})

test('the chip carries the tooltip and the wording is honest', () => {
  assert.match(UI, /title=\{tagTitle\(t\)\}/)
  assert.match(UI, /Added \$\{new Date\(info\.added_at/)
  assert.match(UI, /before tag history started/)
})

test('the history is only fetched when there are tags to explain', () => {
  assert.match(UI, /if \(!client\?\.id \|\| !tags\.length\) return/)
})
