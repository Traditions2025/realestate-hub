// Raise the Hub's inline font sizes one step.
//
// The type tokens in app.css turned out to control very little: 1,228 inline `fontSize`
// declarations across the JSX beat any stylesheet rule, and the app's dominant size is
// 12px (661 uses), not the 14px token. That is why the Hub reads smaller than FUB even
// after the tokens were matched to it.
//
// One step up, not a redesign:
//     11 -> 12      12 -> 13      12.5 -> 13      13 -> 14      13.5 -> 14
// Anything already 14px or larger is left exactly as it is, because those are headings and
// deliberate emphasis and moving them would change the hierarchy rather than the legibility.
//
//   node scripts/bump-inline-type.mjs [--apply]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLY = process.argv.includes('--apply')
// fileURLToPath, not URL().pathname: the workspace path contains spaces and pathname
// leaves them percent-encoded, which points at a directory that does not exist.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

const MAP = { '11': '12', '12': '13', '12.5': '13', '13': '14', '13.5': '14' }

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(jsx|js)$/.test(e.name)) out.push(p)
  }
  return out
}

let files = 0, changes = 0
const byValue = {}

for (const file of walk(ROOT)) {
  const src = fs.readFileSync(file, 'utf8')
  // Only a numeric fontSize inside a style object. A string value ('0.9em', '1rem') is
  // left alone: those are relative already and scale on their own.
  const next = src.replace(/(\bfontSize:\s*)(\d+(?:\.\d+)?)(\s*[,}\n])/g, (m, head, num, tail) => {
    const to = MAP[num]
    if (!to) return m
    byValue[num] = (byValue[num] || 0) + 1
    changes++
    return head + to + tail
  })
  if (next !== src) {
    files++
    if (APPLY) fs.writeFileSync(file, next)
  }
}

console.log(`${changes} inline sizes across ${files} files`)
for (const [from, n] of Object.entries(byValue).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(n).padStart(4)}  ${from}px -> ${MAP[from]}px`)
console.log(APPLY ? '\napplied' : '\nno --apply: nothing written')
