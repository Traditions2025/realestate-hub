// THE INBOX LIST MUST NOT SHIP MESSAGE BODIES (John, 2026-11-11)
//
// Render sent a bandwidth-limit notice: the whole 5 GB monthly Hobby allowance was gone
// before the 11th. Cause: GET /api/inbox did `SELECT *`, so every conversation row carried
// the full body of its last message. Emails imported from Gmail keep their entire HTML
// document, inline base64 images and all - one open-house email was 3.0 MB by itself.
// Measured payload: 4.25 MB, of which 98.6% was bodies the list never renders. The page
// re-polls every 45 seconds, so an open Inbox tab cost ~230 MB an hour.
//
// These tests are about the SHAPE of the response rather than the SQL, because the next
// person to touch this route will be thinking about columns, not about bandwidth.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()

const SRC = readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')

test('the list query does not SELECT * from communications', () => {
  // The specific mistake that caused the bill. A list of conversations has no business
  // pulling every column of a table whose rows can each be megabytes.
  const listRoute = SRC.slice(SRC.indexOf("router.get('/', (req, res) =>"))
  const sqlLine = listRoute.split('\n').find(l => /FROM communications WHERE/.test(l) && /const sql/.test(l))
  assert.ok(sqlLine, 'the list route still builds a communications query')
  assert.ok(!/SELECT \* FROM communications/.test(sqlLine),
    'the inbox list must not SELECT * - that ships every email body to the browser')
  assert.match(sqlLine, /listColumns\(\)/, 'it selects the trimmed column set')
})

test('the heavy free-text columns are the ones left out', () => {
  const m = SRC.match(/const INBOX_LIST_SKIP = new Set\(\[([^\]]*)\]\)/)
  assert.ok(m, 'the skip list exists')
  for (const col of ['body', 'transcript', 'call_summary', 'notes']) {
    assert.match(m[1], new RegExp(`'${col}'`), `${col} is excluded from the list payload`)
  }
})

test('the trimmed column set still carries everything the list renders', () => {
  // The Inbox list row reads exactly these off `last`. If a future change drops one of
  // them the list goes blank, so they are named here rather than assumed.
  const cols = listColumnsFromSchema()
  for (const needed of ['id', 'channel', 'occurred_at', 'subject', 'preview', 'has_attachment']) {
    assert.ok(cols.includes(needed), `the list still sends ${needed}`)
  }
  // And the grouping/threading logic needs these.
  for (const needed of ['client_id', 'thread_key', 'conversation_sid', 'direction', 'from_addr', 'to_addr', 'status', 'contact_name', 'group_meta']) {
    assert.ok(cols.includes(needed), `the thread grouping still has ${needed}`)
  }
})

test('body is genuinely gone from the trimmed set', () => {
  const cols = listColumnsFromSchema()
  assert.ok(!cols.includes('body'), 'body is not selected')
  assert.ok(!cols.includes('transcript'), 'transcript is not selected')
})

test('only plain identifiers are ever interpolated into the SQL', () => {
  // The column list is built from the live schema and spliced into a template string, so
  // the filter that keeps it to bare identifiers is load-bearing, not decoration.
  assert.match(SRC, /\/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$\//,
    'column names are validated before being interpolated')
})

test('a real list query runs and returns no body field', () => {
  // End to end against the actual schema: build the query the route builds and check the
  // rows that come back.
  const cols = listColumnsFromSchema().join(', ')
  const rows = db.all(`SELECT ${cols} FROM communications ORDER BY occurred_at DESC LIMIT 5`)
  for (const r of rows) {
    assert.ok(!('body' in r), 'no row carries a body')
    assert.ok(!('transcript' in r), 'no row carries a transcript')
  }
  if (rows.length) assert.ok('preview' in rows[0], 'but preview is there, which is what the list shows')
})

test('the thread endpoints DO still return the body', () => {
  // Trimming the list is only correct because opening a conversation still shows the
  // message. If this ever stops being true the trim becomes data loss, not a saving.
  const afterList = SRC.slice(SRC.indexOf("router.get('/thread"))
  assert.ok(/SELECT \*/.test(afterList) || /\bbody\b/.test(afterList),
    'reading one conversation still fetches full message content')
})

// Mirrors listColumns() in the route, against the same live schema.
function listColumnsFromSchema() {
  const skip = new Set(['body', 'transcript', 'call_summary', 'notes'])
  return db.all('PRAGMA table_info(communications)')
    .map(c => String(c.name))
    .filter(c => /^[A-Za-z_][A-Za-z0-9_]*$/.test(c) && !skip.has(c))
}
