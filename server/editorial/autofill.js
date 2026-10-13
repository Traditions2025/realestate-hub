// "Work on this address": turn one typed address into a filled listing.
//
//   1. Normalise the address (Nominatim, Iowa only) so street, city and zip are right.
//   2. In parallel:
//        - the assessor parcel page (Cedar Rapids or Linn County, both tried): public record
//          for beds, baths, finished sq ft, year built, lot, garage, basement, extras
//        - public listing sites (realtor.com, zillow.com, redfin.com): features and any
//          remarks, which may be from an EARLIER sale, so they are labelled that way
//   3. Fill only EMPTY fields (anything the agent typed is never overwritten) and report
//      which source supplied which field.
import db from '../database.js'
import { resolveParcel } from '../assessor-lookup.js'
import { searchForListingUrl, fetchAndExtract, getClient } from '../routes/listings.js'
import { callJson } from './model.js'
import { buildDossier } from './dossier.js'

const UA = 'MattSmithTeamHub/1.0 (matt@mattsmithteam.com)'

export function splitTyped(input) {
  const raw = String(input || '').replace(/\s+/g, ' ').trim()
  const zip = raw.match(/\b(5\d{4})(?:-\d{4})?\b/)?.[1] || ''
  const parts = raw.replace(/\b5\d{4}(-\d{4})?\b/, '').split(',').map(s => s.trim()).filter(Boolean)
  const street = parts[0] || ''
  let city = (parts[1] || '').replace(/\b(IA|Iowa)\b\.?/i, '').trim()
  if (!city && parts.length === 1) {
    // "123 Main St Marion IA" with no commas: peel a known metro town off the end
    const m = street.match(/\s(Cedar Rapids|Marion|Hiawatha|Robins|Palo|Swisher|Springville|Ely|Fairfax|Center Point|Mount Vernon|Mt\.? Vernon|Lisbon|Solon|Walford|Shellsburg|Alburnett|Toddville|Atkins|Central City|Coggon|Prairieburg|Urbana|Walker|Vinton|Anamosa|North Liberty|Iowa City|Cedar Falls|Waterloo)(\s+(IA|Iowa))?$/i)
    if (m) return { street: street.slice(0, m.index).trim(), city: m[1], zip }
  }
  return { street, city, zip }
}

async function geocode(q) {
  try {
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({ q, countrycodes: 'us', format: 'jsonv2', addressdetails: '1', limit: '5' })
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) })
    if (!r.ok) return null
    const rows = (await r.json()).filter(x => /iowa/i.test(x.address?.state || '') || x.address?.['ISO3166-2-lvl4'] === 'US-IA')
    const a = rows.find(x => x.address?.house_number)?.address
    if (!a) return null
    return {
      street: [a.house_number, a.road].filter(Boolean).join(' '),
      city: a.city || a.town || a.village || a.hamlet || a.municipality || '',
      zip: a.postcode || '',
    }
  } catch { return null }
}

export async function normaliseAddress(input) {
  const typed = splitTyped(input)
  if (!/^\d+\s+\S+/.test(typed.street)) throw Object.assign(new Error('Type a street address with a house number, e.g. "960 Fixture Dr, Marion".'), { status: 400 })
  const geo = await geocode([typed.street, typed.city || 'Linn County', 'IA', typed.zip].filter(Boolean).join(', '))
  // Keep the agent's own street spelling (directionals like NE matter for the assessor);
  // take city/zip from the geocoder only when the agent left them out.
  return {
    street: typed.street,
    city: typed.city || geo?.city || '',
    zip: typed.zip || geo?.zip || '',
    state: 'IA',
  }
}

// ---------------------------------------------------------------------------
// Assessor parcel -> fields
// ---------------------------------------------------------------------------
const PARCEL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['property_type', 'bedrooms', 'bathrooms_full', 'bathrooms_half', 'square_feet', 'lot_size', 'year_built', 'garage_spaces', 'stories', 'basement', 'heating', 'cooling', 'features'],
  properties: {
    property_type: { type: 'string', description: 'e.g. "Single Family / Ranch", "Single Family / Two Story", "Townhouse", "Condo", "Duplex". Empty if not shown.' },
    bedrooms: { type: 'string', description: 'number as text, empty if not shown' },
    bathrooms_full: { type: 'string' },
    bathrooms_half: { type: 'string' },
    square_feet: { type: 'string', description: 'ABOVE-GRADE finished living area, number as text' },
    lot_size: { type: 'string', description: 'e.g. "0.26 acres" or "11,250 sq ft"' },
    year_built: { type: 'string' },
    garage_spaces: { type: 'string', description: 'number of car spaces if stated or clearly derivable (e.g. "2 car attached"), else empty' },
    stories: { type: 'string' },
    basement: { type: 'string', description: 'e.g. "Full, 850 sq ft finished" or "Crawl space", empty if not shown' },
    heating: { type: 'string' },
    cooling: { type: 'string' },
    features: { type: 'array', items: { type: 'string' }, description: 'Physical extras the record lists: deck (with size), porch, patio, fireplace, shed, pool, outbuildings. No values, no assessments, no owner info.' },
  },
}

const stripHtml = (h) => String(h || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

async function fromAssessor(addr) {
  const p = await resolveParcel(addr.street, addr.city, { withHtml: true })
  if (p.error || !p.html) return { ok: false, source: 'Assessor', note: p.error || 'no parcel page' }
  const text = stripHtml(p.html).slice(0, 60000)
  const { data } = await callJson({
    system: [{ type: 'text', text: 'You read Iowa county assessor parcel pages and extract the physical description of the residential building. Only what the page states. Never include owner names, sale prices, assessed values or taxes.' }],
    prompt: `Parcel page text:\n${text}\n\nExtract the building's physical details as JSON. Use empty strings for anything not shown.`,
    schema: PARCEL_SCHEMA, effort: 'low', maxTokens: 4000,
  })
  return { ok: true, source: p.host === 'linn' ? 'Linn County Assessor' : 'Cedar Rapids Assessor', url: p.url, data }
}

// ---------------------------------------------------------------------------
// Public listing sites -> features / remarks
// ---------------------------------------------------------------------------
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))])

async function fromListingSites(addr) {
  const client = getClient()
  if (!client) return { ok: false, source: 'Listing sites', note: 'no API key' }
  const q = [addr.street, addr.city, 'IA', addr.zip].filter(Boolean).join(' ')
  const domains = ['realtor.com', 'zillow.com', 'redfin.com']
  const found = await Promise.all(domains.map(d => withTimeout(searchForListingUrl(q, d), 15000)))
  const urls = found.map((u, i) => (u ? { domain: domains[i], url: u } : null)).filter(Boolean)
  if (!urls.length) return { ok: false, source: 'Listing sites', note: 'not found on realtor.com, zillow.com or redfin.com' }
  const results = await Promise.all(urls.map(async u => {
    try { return { ...u, data: await withTimeout(fetchAndExtract(client, u.url), 40000) } } catch (e) { return { ...u, error: e.message } }
  }))
  // The page must be this house: its street number has to appear in what came back.
  const num = addr.street.match(/^\d+/)[0]
  const good = results.find(r => r.data && (r.data.bedrooms || r.data.square_feet || r.data.description) &&
    (!r.data.property_address || String(r.data.property_address).includes(num)))
  if (!good) return { ok: false, source: 'Listing sites', note: results.map(r => `${r.domain}: ${r.error || 'nothing usable'}`).join('; ') }
  return { ok: true, source: good.domain, url: good.url, data: good.data }
}

// ---------------------------------------------------------------------------
// Merge into the listing (fill empty fields only)
// ---------------------------------------------------------------------------
const NUMERIC = new Set(['bedrooms', 'bathrooms_full', 'bathrooms_half', 'square_feet', 'year_built', 'garage_spaces', 'stories'])
const toNum = (v) => { const n = Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null }
// A value outside these is a misread (e.g. a garage's 321 sq ft read as 321 car spaces).
const RANGE = { bedrooms: [0, 20], bathrooms_full: [0, 15], bathrooms_half: [0, 10], square_feet: [200, 25000], year_built: [1800, 2035], garage_spaces: [0, 12], stories: [1, 4], hoa_fee: [1, 5000] }
const inRange = (k, n) => n === null || !RANGE[k] || (n >= RANGE[k][0] && n <= RANGE[k][1])

export function findListingByStreet(street) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const want = norm(street)
  // Stored addresses sometimes carry ", City, IA zip" too, so match on the street part.
  return db.all('SELECT id, property_address FROM listings ORDER BY id DESC')
    .find(r => norm(String(r.property_address || '').split(',')[0]) === want) || null
}

/**
 * Address in, filled listing out. onStep(key, status, detail) reports progress for:
 *   address -> record (assessor) -> files (team folders + photos) -> web (listing sites)
 */
export async function startFromAddress(input, { onStep = () => {}, withFiles = true } = {}) {
  onStep('address', 'running')
  const addr = await normaliseAddress(input)
  let listing = findListingByStreet(addr.street)
  let created = false
  if (!listing) {
    const r = db.run("INSERT INTO listings (property_address, city, state, zip, stage, status) VALUES (?, ?, 'IA', ?, 'pre_listing', 'New')", [addr.street, addr.city || null, addr.zip || null])
    listing = { id: Number(r.lastInsertRowid) }
    created = true
  }
  const address = `${addr.street}${addr.city ? ', ' + addr.city : ''}`
  onStep('address', 'done', `${address} (${created ? 'new listing' : 'existing listing'})`, { listing_id: listing.id })
  const row = db.get('SELECT * FROM listings WHERE id = ?', [listing.id])

  onStep('record', 'running'); onStep('web', 'running')
  if (withFiles) onStep('files', 'running')
  const [assessor, sites, dossier] = await Promise.all([
    fromAssessor(addr).catch(e => ({ ok: false, source: 'Assessor', note: e.message }))
      .then(r => { onStep('record', r.ok ? 'done' : 'missed', r.ok ? `${r.source}` : r.note); return r }),
    fromListingSites(addr).catch(e => ({ ok: false, source: 'Listing sites', note: e.message }))
      .then(r => { onStep('web', r.ok ? 'done' : 'missed', r.ok ? r.source : r.note); return r }),
    withFiles
      ? buildDossier(addr.street, { onProgress: (p) => onStep('files', 'running', p.step === 'files' ? `${p.found} files found, reading ${p.reading}` : p.step === 'documents' ? `${p.facts} facts from documents, reviewing photos` : '') })
        .then(d => { onStep('files', d.summary.files_found ? 'done' : 'missed', d.summary.files_found ? `${d.summary.documents_read} documents read, ${d.summary.photos_reviewed} photos reviewed, ${d.summary.private_skipped} private files left alone` : 'no files with this address in the team folders'); return d })
        .catch(e => { onStep('files', 'missed', e.message); return null })
      : Promise.resolve(null),
  ])

  const updates = {}
  const filledBy = {}
  const fill = (field, value, source) => {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return
    if (typeof value === 'number' && !inRange(field, value)) return
    if (row[field] !== null && row[field] !== undefined && row[field] !== '' && row[field] !== '[]') return
    if (field in updates) return
    updates[field] = value
    filledBy[field] = source
  }
  if (!row.city && addr.city) fill('city', addr.city, 'address')
  if (!row.zip && addr.zip) fill('zip', addr.zip, 'address')

  // Order of trust: live public record, then the team's own documents, then listing sites.
  if (assessor.ok) {
    for (const [k, v] of Object.entries(assessor.data)) {
      if (k === 'features') continue
      fill(k, NUMERIC.has(k) ? toNum(v) : (String(v || '').trim() || null), assessor.source)
    }
  }
  if (dossier?.fields) {
    for (const [k, v] of Object.entries(dossier.fields)) fill(k, NUMERIC.has(k) || k === 'hoa_fee' ? toNum(v) : (String(v || '').trim() || null), 'Team files')
  }
  if (sites.ok) {
    const d = sites.data
    for (const k of ['property_type', 'bedrooms', 'bathrooms_full', 'bathrooms_half', 'square_feet', 'lot_size', 'year_built', 'garage_spaces', 'stories', 'basement', 'heating', 'cooling', 'flooring', 'schools', 'hoa_fee', 'hoa_frequency']) {
      fill(k, NUMERIC.has(k) || k === 'hoa_fee' ? toNum(d[k]) : (d[k] ? String(d[k]) : null), sites.source)
    }
    if (d.description) fill('description', `[From ${sites.source}; may describe an earlier sale, confirm before relying on it] ${d.description}`, sites.source)
  }
  const features = [...new Set([...(assessor.ok ? assessor.data.features || [] : []), ...(sites.ok && Array.isArray(sites.data.features) ? sites.data.features : [])].map(s => String(s).trim()).filter(Boolean))]
  if (features.length) fill('features', JSON.stringify(features), [assessor.ok && assessor.data.features?.length ? assessor.source : null, sites.ok && sites.data.features?.length ? sites.source : null].filter(Boolean).join(' + '))
  // The dossier is always refreshed: it is a snapshot of the files, not something the agent typed.
  if (dossier) updates.marketing_dossier = JSON.stringify(dossier)

  const keys = Object.keys(updates)
  if (keys.length) {
    db.run(`UPDATE listings SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map(k => updates[k]), new Date().toISOString(), listing.id])
  }
  const sourceList = [assessor, ...(dossier ? [{ ok: !!dossier.summary.files_found, source: 'Team files', note: dossier.summary.files_found ? null : 'none found' }] : []), sites]
  return {
    listing_id: listing.id,
    created,
    address,
    sources: sourceList.map(s => ({ name: s.source, ok: s.ok, url: s.url || null, note: s.note || null, fields: Object.entries(filledBy).filter(([, src]) => src.includes(s.source)).map(([f]) => f) })),
    filled: filledBy,
    dossier_summary: dossier?.summary || null,
  }
}
