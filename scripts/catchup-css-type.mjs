// One-off: bring app.css's hardcoded font sizes level with the JSX.
//
// Two passes of scaling were applied to the inline `fontSize` declarations in the JSX and
// to the --text-* tokens, but NOT to the 274 hardcoded `font-size: Npx` rules in app.css.
// That is why Client Details (styled by .cp-* rules) came out visibly smaller than
// Communications (styled inline) on the client profile.
//
// The fix is to replay both passes in order rather than guess a single multiplier, so the
// stylesheet lands on exactly the values the JSX already has:
//
//     pass 1   11->12  12->13  12.5->13  13->14  13.5->14
//     pass 2   x1.10, rounded to the nearest half pixel
//
//     12px -> 13 -> 14.5      13px -> 14 -> 15.5      16px -> 16 -> 17.5
//
// After this, scripts/scale-type.mjs covers CSS too, so the two can no longer drift apart.
//
//   node scripts/catchup-css-type.mjs [--apply]
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APPLY = process.argv.includes('--apply')
const CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'app.css')

const PASS1 = { '11': 12, '12': 13, '12.5': 13, '13': 14, '13.5': 14 }
const FLOOR = 9          // below this it is an icon-adjacent label; scaling hurts
const SCALE = 1.1
const half = (n) => Math.round(n * 2) / 2

const src = fs.readFileSync(CSS, 'utf8')
const moves = new Map()

const next = src.replace(/(font-size:\s*)(\d+(?:\.\d+)?)(px)/g, (m, head, num, unit) => {
  const from = Number(num)
  if (from < FLOOR) return m
  const stepped = PASS1[num] ?? from            // pass 1
  const to = half(stepped * SCALE)              // pass 2
  if (to === from) return m
  const k = `${from} -> ${to}`
  moves.set(k, (moves.get(k) || 0) + 1)
  return head + to + unit
})

const total = [...moves.values()].reduce((a, b) => a + b, 0)
console.log(`${total} hardcoded font sizes in app.css\n`)
for (const [k, n] of [...moves.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14))
  console.log(`  ${String(n).padStart(4)}  ${k}px`)

// prove the stylesheet now agrees with the JSX on the sizes that matter
const CHECK = { 12: 14.5, 13: 15.5, 14: 15.5, 16: 17.5 }
console.log('\nmatching the JSX:')
for (const [from, want] of Object.entries(CHECK)) {
  const got = half((PASS1[from] ?? Number(from)) * SCALE)
  console.log(`  ${String(from).padStart(2)}px -> ${got}px  ${got === want ? 'ok' : '*** expected ' + want}`)
}

if (!APPLY) { console.log('\nno --apply: nothing written'); process.exit(0) }
fs.writeFileSync(CSS, next)
console.log('\napplied')
