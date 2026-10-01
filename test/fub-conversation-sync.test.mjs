// Pulling FUB conversations into the Hub's timeline.
//
// Started on status='active' (John, 2026-10-01): 42 leads, the ones the team is actually
// working. Everything lands in `communications`, which already feeds the Inbox and the
// profile, and external_id is UNIQUE so a re-run adds nothing twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const m = await import('../server/fub-conversation-sync.js')
const src = fs.readFileSync(new URL('../server/fub-conversation-sync.js', import.meta.url), 'utf8')

// ── stripping the HTML ───────────────────────────────────────────────────────────────
// Measured at 2.4 KB of HTML per note across 264k notes. Stripping is what makes the
// import affordable: 10 retained backups multiply every megabyte of growth by ten.
test('a Sierra email note becomes readable text', () => {
  const html = '<div style="padding:12px">Wednesday<br />From: Sierra &lt;system@sierra&gt;' +
    '<style>p{color:red}</style><p>Price is $250,000 &amp; rising</p></div>'
  const out = m.htmlToText(html)
  // not "no < at all": &lt; decodes to a real <, which is correct — "Sierra <system@sierra>"
  // is the actual text of the email. What must not survive is a TAG.
  for (const tag of ['<div', '<p>', '<style', '<br', '</']) assert.ok(!out.includes(tag), `${tag} survived`)
  assert.ok(!out.includes('color:red'), 'style CONTENTS are not text')
  assert.ok(out.includes('Price is $250,000 & rising'), 'entities decoded')
  assert.ok(out.length < html.length / 2, 'it should be much smaller — that is the point')
})

test('htmlToText copes with nothing', () => {
  for (const v of ['', null, undefined]) assert.equal(m.htmlToText(v), '')
})

// ── the loop breaker ─────────────────────────────────────────────────────────────────
// FUB stamps systemName from the X-System header and fub-helper sends MattSmithTeamHub,
// so the Hub's own writes must be skipped on the way back in or a two-way sync ping-pongs.
test('rows the Hub itself wrote into FUB are skipped', () => {
  assert.equal(m.HUB_SYSTEM_NAME, 'MattSmithTeamHub')
  assert.ok(src.includes('=== HUB_SYSTEM_NAME'), 'the import must compare against it')
  const fn = src.slice(src.indexOf('export async function importOne'))
  assert.ok(fn.includes('mine++'), 'and count what it skipped')
})

// ── mapping ──────────────────────────────────────────────────────────────────────────
const who = { id: 7, name: 'Teresa Bochkarev' }

test('a note maps to an internal timeline row', () => {
  const r = m.mapNote({ id: 1, personId: 9, created: '2026-07-15T22:19:54Z', subject: 'Sierra Email',
    body: '<p>Hello</p>', createdBy: 'Matt Smith', systemName: 'SierraInteractive' }, who)
  assert.equal(r.channel, 'note')
  assert.equal(r.direction, 'internal', 'a note is not sent to anyone')
  assert.equal(r.external_id, 'fub_note_1')
  assert.equal(r.client_id, 7)
  assert.equal(r.body, 'Hello')
  assert.equal(r.agent, 'Matt Smith')
  assert.equal(r.status, 'read', 'history must not arrive as unread Inbox items')
})

test('a call keeps outcome, duration and the recording', () => {
  const r = m.mapCall({ id: 2, personId: 9, created: '2026-07-15T22:19:54Z', isIncoming: true,
    duration: 93, outcome: 'Talked', note: 'left a message', userName: 'Hunter',
    recordingUrl: 'https://x/rec.mp3', fromNumber: '+13195551234' }, who)
  assert.equal(r.channel, 'call')
  assert.equal(r.direction, 'incoming')
  assert.equal(r.duration_sec, 93)
  assert.equal(r.recording_url, 'https://x/rec.mp3')
  assert.equal(r.disposition, 'Talked')
  assert.equal(r.external_id, 'fub_call_2')
})

test('a text keeps the message and its direction', () => {
  const out = m.mapText({ id: 3, personId: 9, created: '2026-07-15T22:19:54Z', isIncoming: false,
    message: 'Thanks!', toNumber: '+13195551234', deliveryStatus: 'delivered' }, who)
  assert.equal(out.channel, 'text')
  assert.equal(out.direction, 'outgoing')
  assert.equal(out.body, 'Thanks!')
  assert.equal(out.delivery_status, 'delivered')
  assert.equal(out.external_id, 'fub_text_3')
})

test('every external_id is namespaced per channel, so ids cannot collide', () => {
  const n = m.mapNote({ id: 5, created: '2026-01-01T00:00:00Z' }, who)
  const c = m.mapCall({ id: 5, created: '2026-01-01T00:00:00Z' }, who)
  const t = m.mapText({ id: 5, created: '2026-01-01T00:00:00Z' }, who)
  assert.equal(new Set([n.external_id, c.external_id, t.external_id]).size, 3)
})

test('bodies are capped, so one runaway note cannot bloat the table', () => {
  const r = m.mapNote({ id: 6, created: '2026-01-01T00:00:00Z', body: 'x'.repeat(50000) }, who)
  assert.ok(r.body.length <= 4001, `body was ${r.body.length}`)
  assert.ok(r.preview.length <= 181)
})

// ── storing ──────────────────────────────────────────────────────────────────────────
test('a re-run stores nothing twice', () => {
  const id = 'fub_note_test_' + Math.random().toString(36).slice(2)
  const row = { channel: 'note', direction: 'internal', client_id: null, subject: 's',
    preview: 'p', body: 'b', external_id: id, status: 'read', occurred_at: new Date().toISOString() }
  assert.equal(m.storeRow(row), 1, 'first insert lands')
  assert.equal(m.storeRow(row), 0, 'external_id is UNIQUE, so the second is ignored')
})

// ── scope ────────────────────────────────────────────────────────────────────────────
test('only linked leads of the asked-for status are considered', () => {
  const now = new Date().toISOString()
  const mk = (status, fub) => db.run(
    `INSERT INTO clients (first_name, last_name, email, type, status, fub_person_id, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Conv', 'T' + Math.random().toString(36).slice(2, 7), `c${Date.now()}${Math.random()}@x.com`,
     'buyer', status, fub, '[]', now, now]).lastInsertRowid
  const activeLinked = mk('active', '880001')
  const activeNoFub = mk('active', null)
  const newLinked = mk('new', '880002')
  const ids = m.importCandidates({ status: 'active', limit: 5000 }).map(c => c.id)
  assert.ok(ids.includes(activeLinked))
  assert.ok(!ids.includes(activeNoFub), 'no FUB id means nothing to fetch')
  assert.ok(!ids.includes(newLinked), 'a different status must not be swept in')
})

test('the cursor pages forward without repeating', () => {
  const all = m.importCandidates({ status: 'active', limit: 5000 })
  if (all.length < 2) return
  const after = m.importCandidates({ status: 'active', limit: 5000, afterId: all[0].id })
  assert.ok(!after.some(c => c.id === all[0].id), 'afterId must exclude what was already done')
  assert.equal(after.length, all.length - 1)
})

// ── the guards ───────────────────────────────────────────────────────────────────────
test('the disk is checked DURING the run, not only at the start', () => {
  assert.ok(src.includes('MIN_FREE_GB'))
  const loop = src.slice(src.indexOf('for (const c of rows)'), src.indexOf('out.free_gb_after'))
  assert.ok(loop.includes('const free = freeGb()'), 'a long import must watch its own footprint')
  assert.ok(loop.includes('out.stopped ='))
})

test('every FUB call is paced, because FUB rate-limits', () => {
  assert.ok(src.includes('delayMs = 260'))
  const fn = src.slice(src.indexOf('export async function importOne'),
                       src.indexOf('export async function importConversations'))
  assert.equal((fn.match(/setTimeout\(s, delayMs\)/g) || []).length, 2, 'paced on the error path too')
})

test('a dry run writes nothing', () => {
  const fn = src.slice(src.indexOf('export async function importOne'))
  assert.ok(fn.includes('if (!dryRun) added += storeRow(row)'))
})

test('undated rows are dropped rather than sorted to the top of the timeline', () => {
  assert.ok(src.includes('if (!row.occurred_at) continue'))
})

// ── the UI has to show them ──────────────────────────────────────────────────────────
// The import is pointless if nothing renders it. The profile explicitly filtered
// channel='note' OUT of the list, and the Notes tab showed the free-text notes field
// instead — so 1,001 imported notes were invisible until this changed.
const profile = fs.readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')
const clients = fs.readFileSync(new URL('../src/pages/Clients.jsx', import.meta.url), 'utf8')

test('notes are no longer filtered out of the timeline', () => {
  assert.ok(!profile.includes(".filter(m => m.channel !== 'note')"),
    'that exclusion is what hid every imported note')
})

test('the note channel has its own icon and label', () => {
  assert.ok(clients.includes("note: { icon: '📝', label: 'Note'"),
    'without this a note renders as a bullet and the raw word "note"')
})

test('an internal note shows its author, not a direction', () => {
  // a note is written ABOUT the lead, never sent to them, so "inbound" would be wrong
  assert.ok(profile.includes("m.direction === 'internal'"))
  assert.ok(profile.includes('· by {m.agent}'))
})

test('the Notes tab renders imported notes as well as typed ones', () => {
  const tab = profile.slice(profile.indexOf("{filter === 'note' ? ("))
  assert.ok(tab.includes('shown.map(m => <CommItem'), 'the imported rows must appear')
  assert.ok(tab.includes('Load more notes'))
})

test('a note does not repeat its source when the system is the author', () => {
  // rendered as "Note · by Follow Up Boss · Follow Up Boss" before this
  assert.ok(profile.includes('m.disposition !== m.agent'))
})
