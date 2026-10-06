// Profile notes: every one carries a date, and editing one is safe.
//
// John, 2026-10-05: "notes in clients profile should have an edit button also make sure
// all notes logged in HUB have a date log and moving forward".
//
// clients.notes is one text field, newest first, one note per line. Four code paths wrote
// into it with four different stamps, and the profile rendered a date only when a line
// happened to match its one pattern.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  STAMP, stampFor, splitNotes, formatNote, ensureStamped, prependNote,
  replaceNote, removeNote, undatedCount,
} from '../server/client-notes.js'

// ── every note carries a date ────────────────────────────────────────────────────────
test('a new note is stamped', () => {
  const n = formatNote('called, left a voicemail')
  assert.match(n, STAMP)
  assert.match(n, /called, left a voicemail$/)
})

test('the stamp is Central, not whatever zone the server runs in', () => {
  // 01:30 UTC on Oct 6 is 20:30 on Oct 5 in Cedar Rapids. A UTC stamp would put this
  // note on the wrong DAY, which is the only thing the stamp is for.
  const s = stampFor(new Date('2026-10-06T01:30:00Z'))
  assert.match(s, /Oct 5, 2026/)
  assert.match(s, /8:30/)
})

test('an undated line gets a date', () => {
  const out = ensureStamped('typed straight into the field')
  assert.match(out, STAMP)
  assert.equal(undatedCount(out), 0)
})

test('a line that already has a date KEEPS it', () => {
  // re-stamping would overwrite the real date with today's, which is worse than none
  const original = '[Mar 2, 2024, 9:15 AM] met at the open house'
  assert.equal(ensureStamped(original), original)
})

test('all four historical stamp formats are recognised as dated', () => {
  const field = [
    '[Oct 5, 2026, 3:04 PM] from the profile',
    '[10/5/2026] from the master file sync',
    '[Oct 5, 2026 · automation] from an automation',
    '[2026-10-05] from lead intake',
  ].join('\n')
  assert.equal(undatedCount(field), 0, 'no old note should be treated as undated')
  assert.equal(ensureStamped(field), field, 'and none of them should be rewritten')
})

// ── a pasted block is ONE note, not one note plus orphans ───────────────────────────
// The live audit found 85 "undated notes" across 28 leads. Nearly all were the tail of a
// pasted Zillow price history: the old save stamped the first line and left the rest
// adrift. They belong to the note above them and already have its real date.
test('an unstamped line after a note is part of that note', () => {
  const field = '[10/5/2026] 8/17/2026 Price change\n$339,999\n-2.9%\n$106/sqft'
  const notes = splitNotes(field)
  assert.equal(notes.length, 1, 'a pasted block is one note')
  assert.equal(notes[0].stamp, '10/5/2026')
  assert.match(notes[0].text, /\$106\/sqft$/, 'the whole block is its text')
  assert.equal(undatedCount(field), 0, 'nothing in it is undated')
})

test('a continuation line is never stamped', () => {
  // stamping it would split one note in two and put today's date on half of it
  const field = '[10/5/2026] Price change\n$339,999\n[2026-10-05] a later note'
  assert.equal(ensureStamped(field), field)
})

test('a note that STARTS undated is stamped, but only its first line', () => {
  const field = 'pasted with no stamp\n$339,999\n-2.9%'
  const out = ensureStamped(field).split('\n')
  assert.match(out[0], STAMP)
  assert.equal(out[1], '$339,999', 'the rest of the block is left as its continuation')
  assert.equal(out[2], '-2.9%')
  assert.equal(splitNotes(out.join('\n')).length, 1, 'and it is still one note')
})

test('the continuation rule does not swallow the next dated note', () => {
  const field = '[a] one\nits tail\n[b] two'
  const notes = splitNotes(field)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].text, 'one\nits tail')
  assert.equal(notes[1].text, 'two')
})

test('blank lines are left alone rather than stamped into notes', () => {
  const out = ensureStamped('[10/5/2026] real\n\n')
  assert.equal(splitNotes(out).length, 1, 'a blank line is not a note')
})

test('an empty field stays empty', () => {
  assert.equal(ensureStamped(''), '')
  assert.equal(ensureStamped(null), '')
})

// ── newest first, consistently ───────────────────────────────────────────────────────
test('a new note goes on top', () => {
  const out = prependNote('[Jan 1, 2024, 9:00 AM] older', 'newer')
  const [first, second] = out.split('\n')
  assert.match(first, /newer$/)
  assert.equal(second, '[Jan 1, 2024, 9:00 AM] older')
})

test('the first note on an empty profile leaves no stray blank line', () => {
  assert.equal(prependNote('', 'first').split('\n').length, 1)
  assert.equal(prependNote(null, 'first').split('\n').length, 1)
})

test('who wrote it rides in the stamp, not in the text', () => {
  // so a search for "automation" does not match every automated note's body
  const n = formatNote('price reduced', { by: 'automation' })
  const [parsed] = splitNotes(n)
  assert.match(parsed.stamp, /automation/)
  assert.equal(parsed.text, 'price reduced')
})

// ── the index is the line in the FILE, never the position on screen ──────────────────
test('each note knows its own line in the raw field', () => {
  const field = '[a] one\n[b] two\n[c] three'
  assert.deepEqual(splitNotes(field).map(n => n.index), [0, 1, 2])
})

test('blank lines do not shift the indexes of the notes after them', () => {
  // this is the bug a naive .split().filter(Boolean) introduces: the third NOTE is the
  // fourth LINE, and editing it by its displayed position rewrites the wrong one
  const field = '[a] one\n[b] two\n\n[c] three'
  const notes = splitNotes(field)
  assert.equal(notes.length, 3)
  assert.equal(notes[2].index, 3, 'the third note is on line 3, not line 2')
  const out = replaceNote(field, notes[2].index, 'edited')
  assert.match(out.split('\n')[3], /edited$/)
  assert.match(out.split('\n')[1], /two$/, 'the untouched note must be untouched')
})

test('editing the note a search matched hits the right line', () => {
  const field = '[a] apples\n[b] bananas\n[c] apples again'
  const hits = splitNotes(field).filter(n => n.text.includes('apples'))
  assert.deepEqual(hits.map(h => h.index), [0, 2])
  const out = replaceNote(field, hits[1].index, 'pears')      // the SECOND search hit
  assert.match(out.split('\n')[2], /pears$/)
  assert.match(out.split('\n')[1], /bananas$/, 'the note between them is untouched')
})

// ── an edit never silently rewrites history ──────────────────────────────────────────
test('editing keeps the original date and records the edit', () => {
  const out = replaceNote('[Mar 2, 2024, 9:15 AM] wrong number', 0, 'right number')
  assert.match(out, /^\[Mar 2, 2024, 9:15 AM \(edited /, 'the original date survives')
  assert.match(out, /right number$/)
})

test('editing twice does not stack "(edited)" forever', () => {
  let out = replaceNote('[Mar 2, 2024, 9:15 AM] v1', 0, 'v2')
  out = replaceNote(out, 0, 'v3')
  assert.equal((out.match(/\(edited/g) || []).length, 1)
  assert.match(out, /^\[Mar 2, 2024, 9:15 AM \(edited /)
  assert.match(out, /v3$/)
})

test('an edit records who made it', () => {
  const out = replaceNote('[Mar 2, 2024] x', 0, 'y', { by: 'John' })
  assert.match(out, /by John\)/)
})

test('an undated note being edited gets a date', () => {
  const out = replaceNote('no stamp at all', 0, 'now it has one')
  assert.match(out, STAMP)
  assert.equal(undatedCount(out), 0)
})

test('a note cannot be turned into an empty line', () => {
  // an emptied note would render as nothing and silently shift nothing — delete is the
  // honest operation, and it logs the text
  assert.throws(() => replaceNote('[a] x', 0, '   '), /cannot be emptied/)
})

test('a multi-line note round-trips as one note', () => {
  const out = replaceNote('[a] x', 0, 'line one\nline two')
  const notes = splitNotes(out)
  assert.equal(notes.length, 1, 'the tail must not become a second, undated note')
  assert.equal(notes[0].text, 'line one\nline two')
  assert.equal(undatedCount(out), 0)
})

test('editing a pasted block replaces the whole block', () => {
  // editing just the stamped line would leave its tail orphaned below the new text
  const field = '[10/5/2026] Price change\n$339,999\n-2.9%\n[b] a later note'
  const out = replaceNote(field, 0, 'price corrected to $339,999')
  const notes = splitNotes(out)
  assert.equal(notes.length, 2)
  assert.equal(notes[0].text, 'price corrected to $339,999')
  assert.equal(notes[1].text, 'a later note', 'the note below is untouched')
  assert.ok(!out.includes('-2.9%'), 'no fragment of the old block is left behind')
})

test('deleting a pasted block removes all of it', () => {
  const field = '[10/5/2026] Price change\n$339,999\n-2.9%\n[b] a later note'
  const out = removeNote(field, 0)
  assert.deepEqual(splitNotes(out).map(n => n.text), ['a later note'])
  assert.ok(!out.includes('$339,999'))
})

test('editing a line that does not exist is refused', () => {
  assert.throws(() => replaceNote('[a] x', 5, 'y'), /not found/)
  assert.throws(() => replaceNote('[a] x', -1, 'y'), /not found/)
  assert.throws(() => replaceNote('[a] x', 'abc', 'y'), /not found/)
})

// ── delete ───────────────────────────────────────────────────────────────────────────
test('deleting removes only that note', () => {
  const out = removeNote('[a] one\n[b] two\n[c] three', 1)
  assert.deepEqual(splitNotes(out).map(n => n.text), ['one', 'three'])
})

test('deleting the last note leaves an empty field, not whitespace', () => {
  assert.equal(removeNote('[a] only', 0), '')
})

test('deleting a line that does not exist is refused', () => {
  assert.throws(() => removeNote('[a] x', 9), /not found/)
})

// ── wired in: no writer can produce an undated note ──────────────────────────────────
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')

test('the clients PUT route stamps whatever it is handed', () => {
  // the UI is not the only writer, and a note that arrives undated is undated forever
  const s = read('../server/routes/clients.js')
  assert.match(s, /if \(typeof fields\.notes === 'string'\) fields\.notes = ensureStamped\(fields\.notes\)/)
})

test('every server writer uses the shared format', () => {
  for (const [file, fn] of [
    ['../server/master-file-log.js', 'prependNote'],
    ['../server/routes/automations.js', 'prependNote'],
    ['../server/lead-intake.js', 'prependClientNote'],
  ]) {
    const s = read(file)
    assert.match(s, new RegExp(fn + '\\('), file + ' must use the shared helper')
    assert.ok(!/toLocaleDateString\('en-US'[^)]*\)\s*\n\s*const (note|line) = `\[/.test(s),
      file + ' must not build its own stamp')
  }
})

test('lead intake prepends like everything else', () => {
  const s = read('../server/lead-intake.js')
  assert.ok(!s.includes("notes=COALESCE(notes,'') || ?"), 'appending put a new lead\'s note at the bottom')
})

test('the profile sends note text and lets the server stamp it', () => {
  const s = read('../src/pages/ClientProfile.jsx')
  assert.match(s, /\/notes`, \{ method: 'POST'/)
  assert.ok(!s.includes('const combined = client.notes ?'), 'the browser must not build the stamp')
})

test('an edit is sent with the note it believed it was editing', () => {
  // without `expect`, two people editing at once silently clobber each other
  const s = read('../src/pages/ClientProfile.jsx')
  assert.match(s, /expect: note\.raw/)
  const route = read('../server/routes/clients.js')
  // and the comparison is against the WHOLE note, since one note can span lines
  assert.match(route, /req\.body\.expect !== note\.raw/)
  assert.match(route, /409/)
})

test('the profile groups continuation lines exactly as the server does', () => {
  // if the two disagreed, an edit would target a different line than the one on screen
  const s = read('../src/pages/ClientProfile.jsx')
  const fn = s.slice(s.indexOf('function parseNotes'), s.indexOf('function NoteRow'))
  assert.match(fn, /if \(out\.length\) \{/, 'must fold an unstamped line into the note above')
  assert.match(fn, /prev\.text \+= /)
  // the stamp is checked BEFORE the blank-line skip, as on the server
  assert.ok(fn.indexOf('raw.match(NOTE_STAMP)') < fn.indexOf('if (!raw.trim()) continue'),
    'checking the stamp after the skip would renumber notes around blank lines')
})

test('the profile renders an honest label when a note has no date', () => {
  const s = read('../src/pages/ClientProfile.jsx')
  assert.match(s, /date not recorded/, 'inventing a date would be worse than saying none')
})

test('a deleted note is recoverable from the activity log', () => {
  const s = read('../server/routes/clients.js')
  assert.match(s, /'Note deleted: ' \+ note\.raw/)
})
