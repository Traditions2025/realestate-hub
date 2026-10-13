// Seed the reference library with the team's own past MLS remarks.
//
//   node tools/editorial-lab/import-wordings.mjs <wordings.json> [--db-dir <dir>]
//
// <wordings.json> is the remarks pulled from "Listings/Listing wordings from Matt Smith
// Team.pdf" (CRAAR Matrix printouts). Each one is graded by the checker: copy with no
// errors becomes "acceptable" (used as a style reference), copy with errors becomes
// "needs_improvement" (kept for the record, never imitated). Re-running skips duplicates.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const file = args[0]
const di = args.indexOf('--db-dir')
process.env.DB_DIR = di > -1 ? args[di + 1] : join(HUB, 'tmp', 'editorial-lab')

const { default: db, initDb } = await import('../../server/database.js')
await initDb()
const { lintCopy } = await import('../../server/editorial/lint.js')
const store = await import('../../server/editorial/store.js')

const rows = JSON.parse(readFileSync(file, 'utf8'))
const existing = new Set(store.listLibrary({ channel: 'mls' }).map(r => r.approved_text))
let added = 0, clean = 0
for (const r of rows) {
  const text = String(r.remarks || '').replace(/�/g, '½').replace(/\s*Realtors?,? there is additional information online\.?\s*$/i, '').trim()
  if (text.length < 200 || existing.has(text)) continue
  const lint = lintCopy(text, { channel: 'mls' })
  const label = lint.clean ? 'acceptable' : 'needs_improvement'
  if (lint.clean) clean++
  store.addLibraryEntry({
    channel: 'mls',
    property_type: [r.style, r.subtype].filter(Boolean).join(' / ') || null,
    price_positioning: r.price ? `$${r.price}` : null,
    key_characteristics: [r.address, r.city, r.year ? `built ${r.year}` : null].filter(Boolean).join(', '),
    approved_text: text,
    edit_reasons: `Imported from the team's CRAAR printouts (${r.status || 'past'} listing, page ${r.page}). ${lint.clean ? 'Passed the checker.' : 'Checker flagged: ' + [...new Set(lint.findings.filter(f => f.severity === 'error').map(f => f.category))].join(', ') + '.'}`,
    label,
    approved_by: 'import',
  })
  added++
}
console.log(`Imported ${added} remarks (${clean} acceptable as style references, ${added - clean} needs improvement).`)
process.exit(0)
