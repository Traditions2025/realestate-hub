// HUB communications -> FUB, without the sync ever feeding itself.
//
// John, 2026-10-08: "make sure HUB communication records are push to FUB".
//
// A two-way sync that re-imports its own writes is the one failure that grows without
// limit, so most of this file is about that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { initDb } from '../server/database.js'
await initDb()
const { noteBody, candidates, PUSH_MARKER, ensurePushTable } = await import('../server/fub-comm-push.js')

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const push = src('../server/fub-comm-push.js')
const sync = src('../server/fub-conversation-sync.js')

// ── the loop guards ──────────────────────────────────────────────────────────────────
test('only Hub-originated rows are eligible', () => {
  // anything imported FROM FUB keeps its fub_ id, and must never be pushed back
  const fn = push.slice(push.indexOf('export function candidates'))
  assert.match(fn, /external_id LIKE 'twilio_%' OR m\.external_id LIKE 'hub_%'/)
  assert.ok(!/external_id LIKE 'fub_/.test(fn), 'a fub_ row must not be selectable')
  assert.ok(!/gmail_/.test(fn), 'nor an imported gmail_ row')
})

test('a pushed row is recorded so a re-run cannot double-post', () => {
  const fn = push.slice(push.indexOf('export function candidates'))
  assert.match(fn, /m\.id NOT IN \(SELECT communication_id FROM fub_comm_pushed\)/)
  assert.match(push, /INSERT OR REPLACE INTO fub_comm_pushed/)
})

test('the note carries a marker and the importer skips it', () => {
  assert.equal(PUSH_MARKER, '[Hub]')
  assert.match(noteBody({ channel: 'text', direction: 'outgoing', body: 'hi' }), /^\[Hub\] /)
  // the second, independent guard on the way back in
  assert.match(sync, /ch\.kind === 'note' && String\(r\.body \|\| ''\)\.includes\(PUSH_MARKER\)/)
})

test('the systemName guard is still the primary defence', () => {
  assert.match(sync, /String\(r\.systemName \|\| ''\) === HUB_SYSTEM_NAME/)
  // and it is checked BEFORE the marker, since it is the cheaper and stronger test
  assert.ok(sync.indexOf('HUB_SYSTEM_NAME) { mine++') < sync.indexOf('includes(PUSH_MARKER)'))
})

test('the push writes with the X-System header that stamps systemName', () => {
  // without it FUB would not know the Hub wrote the note, and guard 1 would be blind
  const helper = src('../server/fub-helper.js')
  const fn = helper.slice(helper.indexOf('export async function fubPost'))
  assert.match(fn.slice(0, 400), /'X-System': 'MattSmithTeamHub'/)
})

// ── what the note actually says ──────────────────────────────────────────────────────
test('the note names the channel, the direction and the number', () => {
  const b = noteBody({ channel: 'text', direction: 'incoming', from_addr: '+15072514908',
    occurred_at: '2026-10-08T14:59:00Z', body: 'can you call me' })
  assert.match(b, /Text from \+15072514908/)
  assert.match(b, /can you call me/)
})

test('times are Central, not UTC', () => {
  // 01:30 UTC on the 9th is 20:30 on the 8th in Cedar Rapids
  const b = noteBody({ channel: 'call', direction: 'outgoing', occurred_at: '2026-10-09T01:30:00Z' })
  assert.match(b, /Oct 8, 2026/)
})

test('a failed send says so in the note', () => {
  const b = noteBody({ channel: 'text', direction: 'outgoing', delivery_status: 'undelivered',
    error_message: 'Carrier filtered as spam', body: 'x' })
  assert.match(b, /Status: undelivered/)
  assert.match(b, /Error: Carrier filtered as spam/)
})

test('an email subject is carried', () => {
  assert.match(noteBody({ channel: 'email', direction: 'outgoing', subject: 'Appraisal is in!', body: 'x' }),
    /Subject: Appraisal is in!/)
})

test('a very long body is truncated rather than filling FUB', () => {
  const b = noteBody({ channel: 'email', direction: 'outgoing', body: 'x'.repeat(9000) })
  assert.ok(b.length < 4300, 'length was ' + b.length)
  assert.match(b, /truncated; full copy in the Hub/)
})

test('a bodyless row still produces a readable note', () => {
  const b = noteBody({ channel: 'call', direction: 'incoming', occurred_at: '2026-10-08T15:00:00Z' })
  assert.match(b, /^\[Hub\] Call from lead/)
})

// ── the two things the first dry run exposed ─────────────────────────────────────────
test('an HTML email body is stripped to text', () => {
  // raw, a FUB note was a wall of <div style=...> with the sentence buried in it
  const b = noteBody({ channel: 'email', direction: 'outgoing', subject: 'TC Morning Update',
    body: '<!DOCTYPE html><html><body><div style="font-family:Arial">Hello Matt, 1 active transaction today.</div></body></html>' })
  assert.ok(!b.includes('<div'), 'HTML must not reach FUB')
  assert.ok(!b.includes('DOCTYPE'))
  assert.match(b, /Hello Matt, 1 active transaction today\./)
})

test('a plain-text body is left exactly as it is', () => {
  // the stripper only runs when the body actually looks like HTML
  const text = 'Good morning Tracey, it\'s John with Matt Smith Team. Did you get a chance to look?'
  assert.match(noteBody({ channel: 'text', direction: 'outgoing', body: text }), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('the team\'s own client records are excluded', () => {
  // TC morning updates and "X emailed you" notifications land on Matt's own client row;
  // pushing them would fill a FUB record with the Hub talking to itself
  const fn = push.slice(push.indexOf('export function candidates'))
  assert.match(fn, /NOT LIKE '%@mattsmithteam\.com'/)
  assert.match(fn, /mattsmithremax@gmail\.com/)
})

test('the remaining count uses the same scope as the batch', () => {
  // a different scope there would report work that will never be done
  const tail = push.slice(push.indexOf('const left ='))
  assert.match(tail, /NOT LIKE '%@mattsmithteam\.com'/)
  assert.match(tail, /mattsmithremax@gmail\.com/)
})

// ── the query runs, and is scoped ────────────────────────────────────────────────────
test('candidates runs against the real schema', () => {
  ensurePushTable()
  assert.doesNotThrow(() => candidates({ limit: 1 }))
  assert.doesNotThrow(() => candidates({ limit: 1, since: '2026-10-01T00:00:00' }))
  assert.doesNotThrow(() => candidates({ limit: 1, channels: ['text'] }))
})

test('only FUB-linked, unmerged leads are considered', () => {
  const fn = push.slice(push.indexOf('export function candidates'))
  assert.match(fn, /c\.fub_person_id IS NOT NULL/)
  assert.match(fn, /c\.merged_into IS NULL/)
})

test('the push is paced, including the error path', () => {
  // FUB rate-limits; pacing only the success path is how a retry storm starts
  const fn = push.slice(push.indexOf('export async function pushCommunications'))
  const loopEnd = fn.indexOf('const left =')
  const loop = fn.slice(0, loopEnd)
  assert.match(loop, /await new Promise\(s => setTimeout\(s, delayMs\)\)/)
  assert.ok(loop.lastIndexOf('await new Promise') > loop.lastIndexOf('catch'),
    'the pace must be outside the try/catch, so a failure waits too')
})

test('it is dry by default', () => {
  assert.match(push, /dryRun = true/)
  const route = src('../server/index.js')
  assert.match(route, /dryRun: req\.body\?\.dry !== false/)
})

// ── the purge must stay purged ───────────────────────────────────────────────────────
test('the importer will not re-add a text FUB gives no body for', () => {
  // 17,204 bodyless rows were deleted on 2026-10-08. Without this the next import
  // brings every one of them back, and the cleanup silently undoes itself.
  assert.match(sync, /ch\.kind === 'text' && \/hidden for privacy\/i\.test\(String\(row\.body \|\| ''\)\)/)
  assert.match(sync, /skipped_no_body: hidden/, 'and it reports how many it dropped')
})

test('the no-body skip applies to texts only', () => {
  // a NOTE containing that phrase is still a real note worth keeping
  const i = sync.indexOf("hidden for privacy")
  const line = sync.slice(sync.lastIndexOf('\n', i) + 1, sync.indexOf('\n', i))
  assert.match(line, /ch\.kind === 'text'/)
})

// ── imported mail is not ours to push back ───────────────────────────────────────────
test('a gmail_ row is NOT pushed to FUB', () => {
  // gmail_ rows are email the Hub IMPORTED from the team mailboxes. Pushing them sends
  // mail back toward the system it came from, and the Gmail sweep creates more of them
  // continuously — so the job would chase a target that keeps growing. Caught live: the
  // remaining count went 1397 -> 1429 -> 1409 while 20 a batch were being written.
  const fn = push.slice(push.indexOf('export function candidates'))
  assert.ok(!/gmail_/.test(fn), 'gmail_ must not be selectable')
  assert.match(fn, /external_id LIKE 'twilio_%' OR m\.external_id LIKE 'hub_%'/)
})

test('the remaining count honours `since` like the batch does', () => {
  // it did not, so the driver could never see done and the number only ever rose
  const tail = push.slice(push.indexOf('const left ='))
  assert.match(tail, /\$\{since \? ' AND m\.occurred_at >= \?' : ''\}/)
  assert.match(tail, /since \? \[out\.last_id, since\] : \[out\.last_id\]/)
})
