// Typography matched to Follow Up Boss (John, 2026-09-30).
//
// FUB sets proxima-nova, which is licensed through Adobe Fonts and cannot be self-hosted
// or served from Google Fonts. Figtree is the closest free face. The point of these tests
// is that the SIZES, WEIGHTS and COLOURS are the thing being matched, and they stay
// matched whether or not the licensed face is ever bought.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const css = fs.readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('the typeface is set in exactly one place', () => {
  assert.match(css, /--font-sans:/)
  assert.match(css, /body \{[\s\S]{0,200}font-family: var\(--font-sans\)/)
})

test('swapping to licensed Proxima Nova is a one-line change', () => {
  // the stack already names it, so a Typekit kit is all that is missing
  assert.match(css, /--font-sans:[\s\S]{0,120}'Proxima Nova'/)
})

test('the webfont is actually loaded', () => {
  assert.match(html, /fonts\.googleapis\.com\/css2\?family=Figtree/)
  assert.match(html, /preconnect[\s\S]{0,200}fonts\.gstatic\.com/)
})

test('table text is 14px, matching FUB, not the old 13px', () => {
  assert.match(css, /--text-table: 14px/)
  assert.ok(!/--text-table: 13px/.test(css), '13px was the main thing making dense screens hard to read')
})

test('body and section sizes match FUB', () => {
  assert.match(css, /--text-body: 14px/)
  assert.match(css, /--text-section: 16px/)
})

test('FUB\u2019s softer text colours are used, not near-black', () => {
  assert.match(css, /--text-primary: #364650/)   // rgb(54,70,80)
  assert.match(css, /--text-muted: #93a5b2/)     // rgb(147,165,178)
})

// The one deliberate departure. FUB sets 14px text on a 14px line, which is fine for a
// single-line cell and hard work the moment anything wraps. The ask was readability.
test('line height is generous where text wraps, tight only where it cannot', () => {
  assert.match(css, /--leading-tight: 1\.15/)
  assert.match(css, /--leading-normal: 1\.55/)
  assert.match(css, /table td[^{]*\{[^}]*line-height: var\(--leading-normal\)/)
  assert.match(css, /\.cell-single \{ line-height: var\(--leading-tight\)/)
})

test('figures line up in columns, but not inside sentences', () => {
  assert.match(css, /font-variant-numeric: tabular-nums/)
  assert.match(css, /p, \.comm-body, \.note-content \{ font-variant-numeric: normal/)
})

test('form controls inherit the typeface rather than falling back to the browser default', () => {
  assert.match(css, /input, select, textarea, button \{ font-family: var\(--font-sans\)/)
})
