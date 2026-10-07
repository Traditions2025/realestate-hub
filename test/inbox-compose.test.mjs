// The group reply box has to show the whole message before it is sent.
//
// John, 2026-10-07: "the group text in Inbox see the message box it does not expand like
// the normal text box in 1 on 1 message therefore I can't view the message in full to
// review it can you fix the height of that".
//
// It was a single-line <input>, so a long message — an under-contract note, an inspection
// time — scrolled out of sight and could not be read back. A group text goes to several
// people at once, which is the worst place to send something unreviewed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8')
// the group pane's compose bar
const bar = src.slice(src.indexOf('Reply to the group') - 1600, src.indexOf('Reply to the group') + 900)

test('the group reply is a textarea, not a one-line input', () => {
  assert.match(bar, /<textarea/, 'a single-line input cannot show a long message')
  assert.ok(!/<input value=\{reply\}/.test(src), 'the old input must be gone')
})

test('it opens at the same height as the 1-to-1 box', () => {
  assert.match(bar, /rows=\{3\}/)
  // the 1-to-1 box: slice the whole element, since rows= sits before the placeholder
  const at = src.indexOf("placeholder={replyChannel === 'text' ? 'Write your text")
  const one = src.slice(src.lastIndexOf('<textarea', at), at)
  assert.match(one, /rows=\{replyChannel === 'text' \? 3 : 5\}/,
    'the 1-to-1 text box is 3 rows; the group box should not open smaller')
})

test('it grows with the message', () => {
  assert.match(bar, /el\.style\.height = 'auto'/, 'reset before measuring, or it can only ever grow')
  assert.match(bar, /el\.scrollHeight/)
})

test('it stops growing before it eats the window', () => {
  assert.match(bar, /Math\.min\(el\.scrollHeight, window\.innerHeight \* 0\.4\)/)
  assert.match(bar, /overflowY: 'auto'/, 'past the cap it has to scroll, not clip')
})

test('the drag handle is off, because the box sizes itself', () => {
  // a manual drag would be undone by the next keystroke
  assert.match(bar, /resize: 'none'/)
})

test('Enter still sends, so the existing shortcut keeps working', () => {
  assert.match(bar, /e\.key === 'Enter' && !e\.shiftKey/)
  assert.match(bar, /e\.preventDefault\(\); send\(\)/,
    'without preventDefault the newline is inserted as well as sending')
})

test('Shift+Enter makes a new line instead of sending', () => {
  assert.match(bar, /!e\.shiftKey/)
  assert.match(bar, /Shift\+Enter/, 'and the placeholder says so')
})

test('Send is still disabled on an empty or blank message', () => {
  assert.match(bar, /disabled=\{sending \|\| !reply\.trim\(\)\}/)
})

test('the bar bottom-aligns so the button stays beside the last line', () => {
  // with a growing textarea a stretched button would tower next to it
  assert.match(bar, /alignItems: 'flex-end'/)
})

test('the textarea inherits the app font', () => {
  // a bare textarea falls back to the browser's monospace-ish default, so the draft
  // would not look like the message that gets sent
  assert.match(bar, /fontFamily: 'inherit'/)
})
