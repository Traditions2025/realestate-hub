// A note typed on a lead's profile has to be VISIBLE on the tab you typed it from.
//
// John, 2026-10-13: "notes that we adding are not saving on leads profile... I've tried to
// add note on her twice and it's not adding."
//
// Nothing was failing to save. Patricia Stuckenschneider (#1055) had BOTH notes in the
// field, stamped 1:22 PM and 1:23 PM Central, and the profile endpoint returned them. The
// All tab counted them in its badge and then rendered only `shown` — the communications
// rows — so the notes were invisible from the tab the Add Note button sits on. She had 3
// communications rows, so the tab did not even look empty: it looked like the note had
// vanished into a list of emails.
//
// That is the shape to guard: a count that includes something the view does not render.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')

// The non-note branch of the Communications section: filter is all / text / call / email.
const elseBranch = src.slice(src.indexOf("placeholder={filter === 'note' ? 'Search notes…'"))
const tail = elseBranch.slice(elseBranch.indexOf('      ) : ('), elseBranch.indexOf('    </Section>'))

test('notes render on the All tab, not only under the Notes filter', () => {
  assert.match(tail, /notesHere\.map\(nt => <NoteRow/,
    'the All tab must render the notes it counts')
})

test('they are editable there, through the same NoteRow and the same handler', () => {
  // a read-only copy would drift from the Notes tab; NoteRow carries the raw line index
  assert.match(tail, /note=\{nt\} clientId=\{cid\} onChanged=\{onNotesChanged\}/)
})

test('notes do NOT leak onto the Texts, Calls or Emails tabs', () => {
  assert.match(src, /const notesHere = filter === 'all' \? shownNotes : \[\]/,
    'a note is not a text or a call; only All and Notes show them')
})

test('the empty state accounts for notes', () => {
  // "Nothing here yet." next to a badge reading (2) is how this stayed hidden
  assert.match(tail, /shown\.length === 0 && notesHere\.length === 0/)
})

test('the All badge still counts notes, so count and content now agree', () => {
  assert.match(src, /\['all', label\('All', \(rows \|\| \[\]\)\.length \+ noteLines\.length\)\]/)
})

test('a long note list is still reachable on the All tab', () => {
  assert.match(tail, /Load more notes \(\{notes\.length - notesHere\.length\}\)/)
})

// The save path was never at fault — keep it that way.
test('saving a note stores the server copy of the field', () => {
  const fn = src.slice(src.indexOf('const saveNote = async'), src.indexOf('const saveNote = async') + 900)
  assert.match(fn, /setClient\(c => \(\{ \.\.\.c, notes: d\.notes \}\)\)/,
    'the server stamps the note, so the server copy is the one to keep')
  assert.ok(!/new Date\(\)\.toLocaleString/.test(fn),
    'the stamp comes from the server in Central, never the browser clock')
})
