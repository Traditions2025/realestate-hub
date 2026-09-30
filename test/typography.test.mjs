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

// FUB's own sizes were the starting point, then John asked for 10% on top (2026-09-30).
// So these are deliberately LARGER than FUB, and the tokens sit on half-pixels because
// rounding 13px to a whole 14 drifts to 8.3% rather than the 10 that was asked for.
test('table text is above FUB’s 14px, and well clear of the old 13px', () => {
  const m = css.match(/--text-table: ([\d.]+)px/)
  assert.ok(m, '--text-table must be defined')
  assert.ok(Number(m[1]) >= 15, `table text should be 15px or more, got ${m[1]}px`)
})

test('body and section carry the same 10% as everything else', () => {
  const body = Number(css.match(/--text-body: ([\d.]+)px/)[1])
  const section = Number(css.match(/--text-section: ([\d.]+)px/)[1])
  assert.ok(body >= 15, `body should be 15px or more, got ${body}px`)
  assert.ok(section > body, 'a section heading must still outrank body text')
})

test('the hierarchy survived the scale', () => {
  // '\\d' inside a template literal collapses to a plain 'd', so the class has to be
  // escaped for the RegExp constructor rather than written as if it were a literal.
  const t = (name) => Number(css.match(new RegExp('--text-' + name + ': ([\\d.]+)px'))[1])
  const order = ['caption', 'meta', 'body', 'section', 'page-title'].map(t)
  for (let i = 1; i < order.length; i++)
    assert.ok(order[i] >= order[i - 1], `type scale went backwards at step ${i}: ${order.join(' < ')}`)
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

// Client Details came out visibly smaller than Communications on the client profile:
// Communications is styled with inline fontSize and got scaled, Client Details is styled
// by .cp-* rules in app.css and did not. Two type systems, one of which moved.
test('the stylesheet is not left behind when type is scaled', () => {
  const sizes = [...css.matchAll(/font-size:\s*([\d.]+)px/g)].map(m => Number(m[1]))
  assert.ok(sizes.length > 100, 'app.css should still carry its hardcoded sizes')
  // 12px and 13px were the two most common, 125 and 57 uses. If either survives, the
  // stylesheet has fallen behind the JSX again.
  const stale = sizes.filter(n => n >= 11 && n <= 13.5)
  assert.equal(stale.length, 0,
    `${stale.length} rules are still at pre-scale sizes (${[...new Set(stale)].join(', ')}px)`)
})

test('the scaler covers CSS as well as JSX, so they cannot drift apart', async () => {
  const fs2 = await import('node:fs')
  const scaler = fs2.readFileSync(new URL('../scripts/scale-type.mjs', import.meta.url), 'utf8')
  assert.ok(scaler.includes('font-size:'), 'the scaler must rewrite hardcoded font-size too')
  assert.ok(scaler.includes('--text-'), 'and the tokens')
  // both replacements have to run against the stylesheet, not just one
  assert.equal((scaler.match(/next = next\.replace|let next = css\.replace/g) || []).length, 2)
})

test('Client Details and Communications end up on the same scale', () => {
  // .cp-kv rows are Client Details; they were 13px while comms body was inline-scaled
  const kv = css.match(/\.cp-kv > div \{[^}]*font-size:\s*([\d.]+)px/)
  assert.ok(kv, '.cp-kv should still set a size')
  assert.ok(Number(kv[1]) >= 15, `Client Details rows should be 15px+, got ${kv[1]}px`)
})
