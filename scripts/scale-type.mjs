// Scale the Hub's type by a factor.
//
// This app's real design system is 1,200-odd inline `fontSize` declarations in the JSX,
// not the tokens in app.css, so a global change has to touch both. The CSS custom
// properties are scaled as well, for the minority of text that does read from them.
//
// NOT IDEMPOTENT. Running it twice compounds the scale. That is deliberate — it makes
// "one more step" a decision rather than something that happens by accident — but it means
// every run should be a separate commit you can revert.
//
// Sizes land on the nearest half-pixel. Rounding to whole pixels drifts a long way at
// small sizes (12 -> 13 is 8.3%, not 10), and half-pixels render cleanly.
//
//   node scripts/scale-type.mjs            # preview, writes nothing
//   node scripts/scale-type.mjs --apply
//   node scripts/scale-type.mjs --scale=1.15 --apply
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLY = process.argv.includes('--apply')
const scaleArg = process.argv.find(a => a.startsWith('--scale='))
const SCALE = scaleArg ? Number(scaleArg.split('=')[1]) : 1.1
if (!Number.isFinite(SCALE) || SCALE <= 0 || SCALE > 2) throw new Error(`implausible scale: ${SCALE}`)

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(HERE, '..', 'src')
const CSS = path.join(SRC, 'styles', 'app.css')

const round = (n) => Math.round(n * SCALE * 2) / 2

// Below this, text is an icon-adjacent label or a superscript and scaling it does more
// harm than good. Above it, everything moves together so the hierarchy is preserved.
const FLOOR = 9

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p)
  }
  return out
}

let files = 0, changes = 0
const moves = new Map()
const note = (from, to) => moves.set(`${from} -> ${to}`, (moves.get(`${from} -> ${to}`) || 0) + 1)

// ---- inline fontSize in the JSX ----------------------------------------------------
for (const file of walk(SRC)) {
  const src = fs.readFileSync(file, 'utf8')
  // A NUMERIC fontSize only. String values ('0.9em', '1rem', 'inherit') are relative
  // already and scale on their own.
  const next = src.replace(/(\bfontSize:\s*)(\d+(?:\.\d+)?)(\s*[,}\n])/g, (m, head, num, tail) => {
    const n = Number(num)
    if (n < FLOOR) return m
    const to = round(n)
    if (to === n) return m
    note(n, to); changes++
    return head + to + tail
  })
  if (next !== src) { files++; if (APPLY) fs.writeFileSync(file, next) }
}

// ---- the type tokens ----------------------------------------------------------------
let cssChanges = 0
if (fs.existsSync(CSS)) {
  const css = fs.readFileSync(CSS, 'utf8')
  // BOTH the tokens and every hardcoded font-size. app.css carries 274 hardcoded sizes,
  // and leaving them out is what made Client Details come out smaller than Communications
  // on the client profile: one was styled by CSS, the other inline, and only one moved.
  let next = css.replace(/(--text-[a-z-]+:\s*)(\d+(?:\.\d+)?)(px)/g, (m, head, num, unit) => {
    const to = round(Number(num))
    if (to === Number(num)) return m
    note(num + 'px token', to + 'px'); cssChanges++
    return head + to + unit
  })
  next = next.replace(/(font-size:\s*)(\d+(?:\.\d+)?)(px)/g, (m, head, num, unit) => {
    const from = Number(num)
    if (from < FLOOR) return m
    const to = round(from)
    if (to === from) return m
    note(num + 'px css', to + 'px'); cssChanges++
    return head + to + unit
  })
  if (next !== css && APPLY) fs.writeFileSync(CSS, next)
}

const pct = ((SCALE - 1) * 100).toFixed(0)
console.log(`scaling type by ${pct}%  (nearest half-pixel)\n`)
console.log(`${changes} inline sizes across ${files} files, plus ${cssChanges} tokens`)
for (const [k, n] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14))
  console.log(`  ${String(n).padStart(4)}  ${k}`)

// what the rounding actually achieved, rather than what was asked for
const real = [...moves.entries()].reduce((acc, [k, n]) => {
  const [f, t] = k.replace(/px token|px/g, '').split(' -> ').map(Number)
  return f ? { sum: acc.sum + (t / f) * n, n: acc.n + n } : acc
}, { sum: 0, n: 0 })
if (real.n) console.log(`\nactual average increase: ${(((real.sum / real.n) - 1) * 100).toFixed(1)}%`)
console.log(APPLY ? 'applied' : '\nno --apply: nothing written')
