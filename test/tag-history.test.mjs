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

// ---- a date is only shown when somebody claimed the change -------------------------
//
// John, 2026-11-17: "do not put the sync date then since it's not accurate". Sierra and FUB
// both return tags as flat arrays of strings with no dates (verified against both APIs), so
// the day a sync pulls a tag is NOT the day it was applied. Dating it by the sync would be a
// confident wrong answer, which is worse than no answer.

test('an unclaimed change yields no date', () => {
  // The branch is chosen by the row's source, and the dateless side carries no date.
  assert.match(HIST, /r\.source\s*\n?\s*\?\s*\{ added_at: r\.changed_at, status: 'tracked'/)
  assert.match(HIST, /:\s*\{ added_at: null, status: 'undated_sync' \}/)
  // source has to be selected, or every row would look unclaimed
  assert.match(HIST, /SELECT old_tags, new_tags, changed_at, source FROM client_tag_history/)
})

test('only a deliberate action can claim a change', () => {
  assert.match(HIST, /export function attributeTagChange/)
  // and it only ever fills a row nobody has claimed yet
  assert.match(HIST, /WHERE client_id = \? AND source IS NULL/)
})

test('the + Tag button claims its change, so that date is real', () => {
  assert.match(ROUTE, /attributeTagChange\(id, 'hub'\)/)
})

test('the sync claims nothing', () => {
  // Nothing in the Sierra sync may call attributeTagChange, or the sync date comes back.
  const SYNC = readFileSync(new URL('../server/sierra-helper.js', import.meta.url), 'utf8')
  assert.ok(!/attributeTagChange/.test(SYNC), 'the sync must never claim a tag change')
})

test('failing to claim never breaks a tag edit', () => {
  const fn = HIST.slice(HIST.indexOf('export function attributeTagChange'))
  assert.match(fn.slice(0, 700), /catch \{/)
})

test('the tooltip does not dress a sync up as a date', () => {
  assert.match(UI, /undated_sync/)
  assert.match(UI, /do not send a date for a tag/)
})
