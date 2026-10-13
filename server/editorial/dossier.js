// Property dossier: what the team's own files say about a property.
//
// Given an address, find every folder/file in the team's working folders whose name matches
// it (house number + street name, typo-tolerant: "Acadia" finds "Acacia"), then:
//   - SKIP anything private without opening it: offers, CMAs and comps, pricing/Profit-Driven
//     strategy, seller reports, briefs, contracts, disclosures, inspections, staging guides,
//     listing/sales history. Seller-private context must never reach public copy.
//   - READ the documents that describe the house: MLS printouts and remarks, assessor/Beacon
//     parcel PDFs, feature/spec sheets, Sierra pages, META-INFO notes.
//   - LOOK at a sample of listing photos (never "before", AI-edited or declutter sets).
// The model returns physical property facts only, each with its source file; anything that
// still smells private is dropped by the same patterns the checker uses.
//
// Local-first: the PDF and image libraries live in the project's top-level node_modules, so
// they are imported lazily and the Hub server still boots without them.
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, relative, basename, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { callJson } from './model.js'
import { SELLER_PRIVATE, PROHIBITED_CLAIMS } from './rules.js'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const PROJECT_ROOT = process.env.EDITORIAL_FILES_ROOT || join(HUB, '..')

// Where listing material lives. Root-level files are scanned too (depth 0).
const SEARCH_DIRS = ['Listings', 'seller-reports', 'Social Media Post/00-READY-TO-POST', 'Videos/03 Listing Videos', 'blog-posts', 'emails', 'Yard Sign']
const IGNORE_DIRS = /^(node_modules|\.git|dist|backups|tmp|Claude Skills|motion-lab|motion-kit|remotion-videos|broll-library|SFX Library|assets|realestate-hub|atlas-.*|video-studio|lead-scoring-system|contacts-export)$/i

const DOC_EXT = new Set(['.pdf', '.txt', '.md', '.html', '.htm'])
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp'])

// Never opened. Matched against the path relative to the project root.
export const PRIVATE_PATH = /(^|[\\/ _-])(offers?|escalat\w*|net[ _-]?sheet|cma|comps?|comparables?|pricing|strategy|profit[ _-]?driven|presentation|seller[ _-]?(report|activity|roadmap|guide)|brief|for[ _-]claude|reverse[ _-]prospect\w*|agreement|contract|addend\w*|disclosure|inspection|appraisal|invoice|commission|showing[ _-]report|feedback|staging|declutter|sales[ _-]history|listing[ _-]?history|redacted|do[ _-]not[ _-]paste|to be sent|transformation|insight[ _-]report|activity[ _-]report)([\\/ _.-]|$)/i
const USEFUL_DOC = /(mls|remarks|description|wording|feature[ _-]?sheet|spec[ _-]?sheet|sierra[ _-]?page|assessor|parcel|beacon|meta[ _-]?info|walk[ _-]?through|property[ _-]?notes|flyer|brochure|blog[ _-]post|caption|(^|[ _-])site([ _.-]|$))/i
const PARCEL_PDF = /^\d{12,15}\.pdf$/i
const BAD_PHOTO = /(^|[\\/ _.()-])(before|ai|edited|declutter\w*|staging|staged|virtual|mock\w*|logo|screenshot|comps?|map|chart|graph|slide|cover|end[ _-]?card|headshot|matt|team|sign|yard[ _-]?sign|qr|board|collage|carousel|post|story|reel)([\\/ _.()-]|\d|$)/i

// ---------------------------------------------------------------------------
// Address matching
// ---------------------------------------------------------------------------
function lev(a, b) {
  const m = a.length, n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 1; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[m][n]
}
const SUFFIX = /^(st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|cir|circle|blvd|boulevard|pl|place|way|ter|terrace|trl|trail|pkwy|hwy|ne|nw|se|sw|n|s|e|w|unit|apt)$/i

export function addressKey(street) {
  const t = String(street || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
  const num = t.find(x => /^\d+[a-z]?$/.test(x))
  const words = t.filter(x => x !== num && !SUFFIX.test(x))
  return { num, word: words[0] || '', unit: (String(street).match(/\b(?:unit|apt|#)\s*([a-z0-9]+)\b/i) || [])[1] || null }
}

export function nameMatches(name, key) {
  if (!key.num || !key.word) return false
  const t = String(name).toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter(Boolean)
  const i = t.indexOf(key.num)
  // also catch "3495-mcgowan" style where number and word are adjacent
  const near = i === -1 ? [] : t.slice(i + 1, i + 4)
  const close = (w) => w === key.word || (key.word.length >= 5 && w.length >= 4 && lev(w, key.word) <= 1)
  if (near.some(close)) return true
  // folder named by street only ("Willowridge A") with the number further in the path is handled by the caller
  return false
}

function walk(dir, depth, out, max = 4000) {
  if (out.length >= max) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (out.length >= max) return
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORE_DIRS.test(e.name)) continue
      out.push({ path: p, dir: true })
      if (depth > 0) walk(p, depth - 1, out, max)
    } else out.push({ path: p, dir: false })
  }
}

/** All files that belong to this address, with no reading yet. */
export function findPropertyFiles(street, root = PROJECT_ROOT) {
  const key = addressKey(street)
  if (!key.num || !key.word) return []
  const candidates = []
  // root-level files only
  try { for (const e of readdirSync(root, { withFileTypes: true })) if (!e.isDirectory()) candidates.push({ path: join(root, e.name), dir: false }) } catch {}
  for (const d of SEARCH_DIRS) walk(join(root, d), 3, candidates)
  const files = new Map()
  const addFile = (p) => { if (!files.has(p)) files.set(p, true) }
  for (const c of candidates) {
    if (!nameMatches(basename(c.path), key)) continue
    if (c.dir) { const inner = []; walk(c.path, 4, inner, 1500); inner.filter(x => !x.dir).forEach(x => addFile(x.path)) } else addFile(c.path)
  }
  return [...files.keys()]
}

export function classify(path, root = PROJECT_ROOT) {
  const rel = relative(root, path)
  const name = basename(path)
  const ext = extname(name).toLowerCase()
  if (PRIVATE_PATH.test(rel)) return 'private'
  if (IMG_EXT.has(ext)) return BAD_PHOTO.test(rel) ? 'photo-skipped' : 'photo'
  if (!DOC_EXT.has(ext)) return 'other'
  if (PARCEL_PDF.test(name)) return 'assessor'
  if (USEFUL_DOC.test(name)) return /assessor|parcel|beacon/i.test(name) ? 'assessor' : /mls|remarks|description|wording/i.test(name) ? 'mls' : 'doc'
  return 'unrecognised'
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
const stripHtml = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()

async function readDoc(path) {
  const ext = extname(path).toLowerCase()
  if (ext === '.pdf') {
    const { PDFParse } = await import('pdf-parse')
    const p = new PDFParse({ data: readFileSync(path) })
    try { return (await p.getText()).text } finally { await p.destroy?.() }
  }
  const raw = readFileSync(path, 'utf8')
  return ext === '.html' || ext === '.htm' ? stripHtml(raw) : raw
}

const FACTS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['fields', 'facts', 'remarks_on_file', 'conflicts'],
  properties: {
    fields: {
      type: 'object', additionalProperties: false,
      description: 'Best current value for each listing field from the documents (prefer the newest source). Empty string when not stated.',
      required: ['property_type', 'bedrooms', 'bathrooms_full', 'bathrooms_half', 'square_feet', 'lot_size', 'year_built', 'garage_spaces', 'stories', 'basement', 'heating', 'cooling', 'flooring', 'schools', 'hoa_fee', 'hoa_frequency'],
      properties: Object.fromEntries(['property_type', 'bedrooms', 'bathrooms_full', 'bathrooms_half', 'square_feet', 'lot_size', 'year_built', 'garage_spaces', 'stories', 'basement', 'heating', 'cooling', 'flooring', 'schools', 'hoa_fee', 'hoa_frequency'].map(k => [k, { type: 'string' }])),
    },
    facts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['fact', 'category', 'source', 'possibly_outdated'],
        properties: {
          fact: { type: 'string', description: 'One physical, verifiable fact about the property, written plainly, e.g. "Kitchen remodeled 2023 with quartz counters and an island"' },
          category: { type: 'string', enum: ['structure', 'layout', 'update', 'feature', 'systems', 'exterior', 'lot-setting', 'association', 'location'] },
          source: { type: 'string', description: 'File name it came from' },
          possibly_outdated: { type: 'boolean', description: 'True if it comes from an older listing or record and may no longer be true' },
        },
      },
    },
    remarks_on_file: {
      type: 'array', description: 'Public MLS remarks found in the documents, verbatim, with source',
      items: { type: 'object', additionalProperties: false, required: ['text', 'source'], properties: { text: { type: 'string' }, source: { type: 'string' } } },
    },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Facts where sources disagree, e.g. square footage 1,557 vs 1,737' },
  },
}

const FACTS_SYSTEM = `You extract property facts for real estate marketing from a team's internal files.
Return ONLY physical, verifiable facts about the property and its setting: structure, rooms and layout, sizes, materials, updates with years, systems, exterior, lot, outbuildings, HOA coverage, school district as listed.
NEVER return: owner, deed holder or mailing names; anything about the seller's reasons, timeline, finances, health, family, flexibility or negotiating position; prices, valuations, taxes as a selling point, offers, commissions, pricing strategy; buyer names; anything about other agents.
Mark facts from an older MLS listing or older record as possibly_outdated.`

const PRIVATE_FACT = /\b(deed holder|owner|mailing|seller|buyer|offer|commission|net proceeds|motivat|divorc|estate|relocat|passed away|deceased|health|price|valuation|assessed value|appraised|equity)\b/i

function cleanFacts(facts) {
  return (facts || []).filter(f => {
    const t = `${f.fact}`
    if (PRIVATE_FACT.test(t)) return false
    if (SELLER_PRIVATE.some(([re]) => re.test(t))) return false
    if (PROHIBITED_CLAIMS.some(([re]) => re.test(t))) return false
    return t.trim().length > 3
  })
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------
function pickPhotos(paths, max = 12) {
  const withSize = paths.map(p => { let s = 0; try { s = statSync(p).size } catch {} return { p, s } }).filter(x => x.s > 25_000)
  if (withSize.length <= max) return withSize.map(x => x.p)
  // spread across the set (shoots are usually in room order), largest-first within each slice
  const sorted = withSize.sort((a, b) => a.p.localeCompare(b.p))
  const step = sorted.length / max
  const out = []
  for (let i = 0; i < max; i++) {
    const slice = sorted.slice(Math.floor(i * step), Math.floor((i + 1) * step))
    out.push(slice.sort((a, b) => b.s - a.s)[0].p)
  }
  return out
}

const PHOTO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['features', 'photo_led'],
  properties: {
    features: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['feature', 'confidence', 'photos'],
        properties: {
          feature: { type: 'string', description: 'A physical feature clearly visible, e.g. "Vaulted ceiling in the living room", "Stone fireplace", "Fenced backyard"' },
          confidence: { type: 'string', enum: ['clear', 'likely'] },
          photos: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    photo_led: { type: 'array', items: { type: 'string' }, description: 'Qualities better shown in photos than described in words' },
  },
}

async function reviewPhotos(paths) {
  if (!paths.length) return { features: [], photo_led: [], used: [] }
  const { default: sharp } = await import('sharp')
  const content = []
  const used = []
  for (const p of paths) {
    try {
      const buf = await sharp(p).rotate().resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer()
      content.push({ type: 'text', text: `Photo ${used.length + 1}` })
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } })
      used.push(p)
    } catch { /* unreadable image: skip */ }
  }
  if (!used.length) return { features: [], photo_led: [], used: [] }
  content.push({ type: 'text', text: 'These are listing photos of one property. List the physical features that are visible. Mark "clear" only when the feature is unmistakable in the photo; name a material (quartz, granite, hardwood, LVP, tile) only if it is unmistakable, otherwise describe it generically ("light stone-look counters"). Do not describe furniture, decor, people or anything that conveys with the seller. Do not guess room sizes.' })
  const { data } = await callJson({
    system: [{ type: 'text', text: 'You review real estate listing photos and report only what is visibly true about the property itself.' }],
    prompt: content, schema: PHOTO_SCHEMA, effort: 'low', maxTokens: 6000,
  })
  return { ...data, used }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------
export async function buildDossier(street, { root = PROJECT_ROOT, onProgress = () => {} } = {}) {
  const files = findPropertyFiles(street, root)
  const entries = files.map(p => ({ path: relative(root, p), abs: p, kind: classify(p, root) }))
  const docs = entries.filter(e => ['assessor', 'mls', 'doc'].includes(e.kind))
  onProgress({ step: 'files', found: entries.length, reading: docs.length })

  // Read documents (cap the total so one huge folder cannot blow up the request)
  const texts = []
  let budget = 90_000
  for (const d of docs.sort((a, b) => (a.kind === 'mls' ? -1 : 0) - (b.kind === 'mls' ? -1 : 0))) {
    if (budget <= 0) { d.status = 'not read (size cap)'; continue }
    try {
      const t = (await readDoc(d.abs)).replace(/\s+\n/g, '\n').trim().slice(0, Math.min(20_000, budget))
      if (t.length < 40) { d.status = 'empty or image-only'; continue }
      texts.push(`=== FILE: ${basename(d.abs)} (${d.kind}) ===\n${t}`)
      budget -= t.length
      d.status = 'read'
    } catch (e) { d.status = `could not read (${e.message.slice(0, 60)})` }
  }

  let facts = [], remarks = [], conflicts = [], fields = {}
  if (texts.length) {
    const { data } = await callJson({
      system: [{ type: 'text', text: FACTS_SYSTEM }],
      prompt: `Property: ${street}\n\n${texts.join('\n\n')}\n\nExtract the facts as JSON.`,
      schema: FACTS_SCHEMA, effort: 'low', maxTokens: 12000,
    })
    facts = cleanFacts(data.facts)
    remarks = (data.remarks_on_file || []).filter(r => !SELLER_PRIVATE.some(([re]) => re.test(r.text)))
    conflicts = data.conflicts || []
    fields = data.fields || {}
  }
  onProgress({ step: 'documents', facts: facts.length })

  const photoPaths = pickPhotos(entries.filter(e => e.kind === 'photo').map(e => e.abs))
  let photos = { features: [], photo_led: [], used: [] }
  try { photos = await reviewPhotos(photoPaths) } catch (e) { photos.error = e.message }
  onProgress({ step: 'photos', reviewed: photos.used.length })

  const total = (k) => entries.filter(e => e.kind === k).length
  return {
    built_at: new Date().toISOString(),
    street,
    summary: {
      files_found: entries.length,
      documents_read: docs.filter(d => d.status === 'read').length,
      private_skipped: total('private'),
      photos_available: total('photo'),
      photos_reviewed: photos.used.length,
    },
    files: entries.map(e => ({ path: e.path, kind: e.kind, status: e.status || (e.kind === 'private' ? 'skipped: private' : e.kind === 'photo' ? (photos.used.includes(e.abs) ? 'reviewed' : 'not sampled') : e.kind === 'photo-skipped' ? 'skipped: before/edited/graphic' : e.kind === 'unrecognised' ? 'skipped: not a property description' : e.kind === 'other' ? 'ignored' : 'not read') })),
    facts: facts.map(f => ({ text: f.fact, category: f.category, source: f.source, outdated: !!f.possibly_outdated })),
    photo_features: (photos.features || []).filter(f => f.confidence === 'clear').map(f => ({ text: f.feature, photos: (f.photos || []).map(i => basename(photos.used[i - 1] || '')).filter(Boolean) })),
    photo_led: photos.photo_led || [],
    remarks_on_file: remarks,
    conflicts,
    fields,
    ...(photos.error ? { photo_error: photos.error } : {}),
  }
}
