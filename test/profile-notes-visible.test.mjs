// A note typed on a lead's profile has to be VISIBLE, on the tab you typed it from, at the
// top where the newest thing belongs.
//
// John, 2026-10-13: "notes that we adding are not saving on leads profile... I've tried to
// add note on her twice and it's not adding." Then: "notes should show from top to bottom
// newest to oldest."
//
// Nothing was failing to save. Patricia Stuckenschneider (#1055) had BOTH notes in the
// field, stamped 1:22 PM and 1:23 PM Central, and the profile endpoint returned them. Two
// rendering faults hid them:
//   1. The All tab counted notes in its badge and rendered only the communications rows.
//   2. The Notes tab grouped by SOURCE - imported FUB notes, then Sierra's, then the
//      profile's own - so recency did not decide position at all.
// She had 3 communications rows, so nothing even looked empty.
//
// The ordering itself is tested for real in test/timeline-order.test.mjs. This file checks
// the page is wired to it and that no source-grouped rendering has crept back.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')
const comms = src.slice(src.indexOf('function Communications({ client'), src.indexOf('function EmailEngagement'))

// ── one list, ordered by date ─────────────────────────────────────────────────────────
test('the page sorts through the shared helper rather than its own comparator', () => {
  assert.match(src, /import \{ centralKey, stampKey, newestFirst \} from '\.\.\/lib\/timeline-order\.js'/)
  assert.match(comms, /const timeline = newestFirst\(entries\)/)
})

test('notes, communications and Sierra notes all go into the SAME list', () => {
  assert.match(comms, /kind: 'comm', key: centralKey\(m\.occurred_at\)/)
  assert.match(comms, /kind: 'note', key: stampKey\(nt\.stamp\)/)
  assert.match(comms, /kind: 'sierra', key: centralKey\(a2\.date\)/)
})

test('one slice and one Load more, so no list can hide behind another', () => {
  assert.match(comms, /const shownTimeline = timeline\.slice\(0, limit\)/)
  assert.equal((comms.match(/Load more/g) || []).length, 1,
    'separate per-source Load more buttons are what let notes sit below a collapsed list')
})

test('nothing renders from a per-source array any more', () => {
  // these were the source-grouped renders; their return would re-break the ordering
  assert.ok(!/shownNotes\.map/.test(comms), 'notes must come from the merged timeline')
  assert.ok(!/notesHere\.map/.test(comms), 'ditto - that was the first, partial fix')
  assert.ok(!/sierraNotes\s*\n?\s*\.slice\(\)\.sort/.test(comms), 'Sierra notes are merged, not sorted apart')
})

// ── which tabs carry notes ────────────────────────────────────────────────────────────
test('the All tab carries the profile notes it counts', () => {
  assert.match(comms, /\(filter === 'all' \|\| filter === 'note'\)[\s\S]{0,120}stampKey\(nt\.stamp\)/)
  assert.match(comms, /\['all', label\('All', \(rows \|\| \[\]\)\.length \+ noteLines\.length\)\]/,
    'the badge counts notes, so the list must contain them')
})

test('Texts, Calls and Emails do not show notes', () => {
  // the note spread is gated on all/note, and Sierra's on note alone
  assert.match(comms, /filter === 'note'\s*\n?\s*\? sierra\.map/)
})

test('notes stay editable wherever they appear', () => {
  assert.match(comms, /<NoteRow key=\{e\.id\} note=\{e\.nt\} clientId=\{cid\} onChanged=\{onNotesChanged\}/,
    'the same row and the same handler, so the raw line index still travels with the note')
})

// ── the empty state ───────────────────────────────────────────────────────────────────
test('empty means the merged list is empty, not just one part of it', () => {
  assert.match(comms, /shownTimeline\.length === 0/)
  assert.match(comms, /filter === 'note' \? 'No notes yet\.' : 'Nothing here yet\.'/)
})

// ── the save path was never at fault; keep it that way ────────────────────────────────
test('saving a note keeps the server copy of the field', () => {
  const fn = src.slice(src.indexOf('const saveNote = async'), src.indexOf('const saveNote = async') + 900)
  assert.match(fn, /setClient\(c => \(\{ \.\.\.c, notes: d\.notes \}\)\)/,
    'the server stamps the note, so the server copy is the one to keep')
  assert.ok(!/new Date\(\)\.toLocaleString/.test(fn),
    'the stamp comes from the server in Central, never the browser clock')
})

test('search filters every source, so a hit cannot be dropped silently', () => {
  assert.match(comms, /items = items\.filter/)
  assert.match(comms, /notes = notes\.filter/)
  assert.match(comms, /sierra = sierra\.filter/)
})
