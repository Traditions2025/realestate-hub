// KEYWORD SEARCH ACROSS EVERY MESSAGE (John, 2026-11-16)
//
// "a word in text that I can search and it shows all the results of messages for that word,
// for ex, woodland".
//
// What was there before only filtered the latest 1000 rows of ONE folder, in JavaScript,
// over contact_name + subject + preview. preview is the first 160 characters. Proof it was
// not enough: searching the sent folder for "walkthrough" returned nothing while the email
// with that exact word in its subject was on screen.
//
// The trap this design exists to avoid: communications is 368MB, nearly all of it base64
// images inlined into email bodies. `body LIKE '%woodland%'` reads all of it per keystroke.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { searchableText, snippetAround } from '../server/comm-search.js'

const SRC = readFileSync(new URL('../server/comm-search.js', import.meta.url), 'utf8')
const API = readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
const UI = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8')
const DB = readFileSync(new URL('../server/database.js', import.meta.url), 'utf8')

// ---- what gets indexed ---------------------------------------------------------------

test('an inlined image is thrown away, not indexed', () => {
  // This is the entire reason the column exists. One pasted screenshot is megabytes of
  // base64 that matches nothing a person would ever type.
  const big = 'data:image/png;base64,' + 'A'.repeat(50000)
  const out = searchableText({ body: `<p>Hi about 350 Woodland</p><img src="${big}">` })
  assert.ok(out.includes('Woodland'), 'the words survive')
  assert.ok(!out.includes('AAAA'), 'the base64 does not')
  assert.ok(out.length < 200, `expected a short string, got ${out.length}`)
})

test('markup is stripped so the words are searchable', () => {
  const out = searchableText({ subject: 'Showing', body: '<div><b>350</b>&nbsp;Woodland&amp;Dr</div>' })
  assert.ok(!out.includes('<'), 'no tags')
  assert.match(out, /350 Woodland&Dr/)
  assert.match(out, /Showing/, 'the subject is searchable too')
})

test('a style or script block never becomes search text', () => {
  const out = searchableText({ body: '<style>.x{color:red}</style><p>Woodland</p><script>var a=1</script>' })
  assert.ok(!/color:red|var a/.test(out))
  assert.match(out, /Woodland/)
})

test('call transcripts and summaries are searchable', () => {
  // A word said on a call is as findable as one typed in a text.
  const out = searchableText({ transcript: 'talked about Woodland Drive', call_summary: 'seller is ready' })
  assert.match(out, /Woodland Drive/)
  assert.match(out, /seller is ready/)
})

test('the stored text is capped, so the column cannot become the next disk problem', () => {
  const out = searchableText({ body: 'word '.repeat(5000) })
  assert.ok(out.length <= 1200, `cap is 1200, got ${out.length}`)
})

test('an empty message yields an empty string, not null', () => {
  // NULL means "not indexed yet", so a genuinely empty message must not look like work
  // that still needs doing, or the sweep picks it up forever.
  assert.equal(searchableText({}), '')
})

// ---- the snippet -----------------------------------------------------------------------

test('the snippet is a window around the match, so the row shows WHY it matched', () => {
  const text = 'a '.repeat(200) + 'Woodland Drive' + ' b'.repeat(200)
  const sn = snippetAround(text, 'woodland')
  assert.match(sn, /Woodland Drive/)
  assert.ok(sn.length < 220, 'and it stays short')
  assert.ok(sn.startsWith('…'), 'with an ellipsis when it starts mid-message')
})

test('a snippet still comes back when the term is only in the name or subject', () => {
  assert.equal(snippetAround('', 'x'), '')
  assert.match(snippetAround('short message', 'nothere'), /short message/)
})

// ---- the query --------------------------------------------------------------------------

test('it searches the stripped column, never the body', () => {
  const fn = SRC.slice(SRC.indexOf('export function searchMessages'))
  assert.match(fn, /search_text LIKE \?/)
  assert.ok(!/body LIKE/.test(fn), 'a LIKE on body reads 368MB per search')
  assert.ok(!/\bbody\b/.test(fn.slice(fn.indexOf('const where'), fn.indexOf('ORDER BY'))),
    'body must not appear anywhere in the query or its columns')
})

test('wildcards a person types are escaped, not executed', () => {
  // Searching for "100%" must not turn into "match everything".
  assert.match(SRC, /replace\(\/\[\\\\%_\]\/g/)
  assert.match(SRC, /ESCAPE '\\\\'/)
})

test('results never carry a message body', () => {
  // Returning bodies from a list endpoint is what cost 3.3GB of bandwidth in a month.
  const ret = SRC.slice(SRC.indexOf('results: rows.map'))
  assert.ok(!/\bbody\b/.test(ret), 'no body field in the payload')
  assert.match(ret, /snippet: snippetAround/)
})

test('search is not scoped to a folder or a direction', () => {
  // A word John said is as findable as a word he was sent. Checked against the WHERE
  // clause, not the whole function: `direction` is legitimately SELECTed and returned.
  const fn = SRC.slice(SRC.indexOf('export function searchMessages'))
  const clause = fn.slice(fn.indexOf('const where'), fn.indexOf('const rows'))
  assert.ok(!/direction/.test(clause), 'no direction filter in the WHERE clause')
  assert.ok(!/folder|status =/.test(clause), 'no folder filter in the WHERE clause')
  // Only the three narrowings the caller can ask for.
  assert.match(clause, /channel = \?/)
  assert.match(clause, /client_id = \?/)
})

test('a one-character query is refused rather than returning everything', () => {
  assert.match(SRC, /term\.length < 2/)
})

// ---- index plumbing ----------------------------------------------------------------------

test('the column exists and the sweep can find unindexed rows cheaply', () => {
  assert.match(DB, /ALTER TABLE communications ADD COLUMN search_text TEXT/)
  assert.match(DB, /idx_comm_search_pending ON communications\(id\) WHERE search_text IS NULL/)
})

test('the backfill is resumable', () => {
  // It selects on search_text IS NULL, so stopping and restarting costs nothing.
  assert.match(SRC, /WHERE search_text IS NULL ORDER BY id LIMIT \?/)
})

test('the endpoints exist and the route module imports them', () => {
  assert.match(API, /from '\.\.\/comm-search\.js'/)
  assert.match(API, /router\.get\('\/search'/)
  assert.match(API, /router\.get\('\/search\/status'/)
  assert.match(API, /router\.post\('\/search\/reindex'/)
})

test('search tells the caller when the index is incomplete', () => {
  // Otherwise a short list reads as "it is not there" when it means "not indexed yet".
  assert.match(API, /index: \{ ready: st\.ready, pending: st\.pending/)
})

// ---- the UI -------------------------------------------------------------------------------

test('the Inbox has a way to reach it', () => {
  assert.match(UI, /api\/inbox\/search\?q=/)
  assert.match(UI, /function DeepResults/)
  assert.match(UI, /All messages/)
})

test('typing is debounced, so a word is one request and not eight', () => {
  assert.match(UI, /setTimeout\(\(\) => \{[\s\S]{0,400}api\/inbox\/search/)
})

test('results say how many matched and when the list is capped', () => {
  assert.match(UI, /info\?\.truncated \? ' \(showing the newest 200\)' : ''/)
  assert.match(UI, /still indexing/)
})
