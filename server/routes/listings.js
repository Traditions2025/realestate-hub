import express, { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

// Bigger JSON limit so PDFs (base64) and HTML payloads can pass through
router.use(express.json({ limit: '25mb' }))

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
let _client = null
function getClient() {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) return null
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

const TEAM_SIGNATURE = `Matt Smith Team — RE/MAX Concepts
(319) 431-5859 | matt@mattsmithteam.com | https://www.mattsmithteam.com
5235 Buffalo Rdg Dr NE, Cedar Rapids, IA 52411`

const TEAM_VOICE = `You are writing for the Matt Smith Team — a Cedar Rapids / Marion, Iowa real estate team at RE/MAX Concepts. Matt has 35+ years of experience and 2,000+ homes sold. Voice is local, warm, knowledgeable, never salesy or generic. Always reference Cedar Rapids / Linn County context where natural. Never invent features or numbers — only use what's provided.`

function logActivity(action, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, 'listing', entityId, details])
}

function getListing(id) {
  const row = db.get('SELECT * FROM listings WHERE id = ?', [Number(id)])
  if (!row) return null
  for (const k of ['features', 'photos']) {
    if (row[k]) { try { row[k] = JSON.parse(row[k]) } catch { row[k] = [] } }
    else row[k] = []
  }
  if (row.marketing_tasks) { try { row.marketing_tasks = JSON.parse(row.marketing_tasks) } catch { row.marketing_tasks = {} } }
  else row.marketing_tasks = {}
  return row
}

function summarizeListing(l) {
  const parts = []
  if (l.property_address) parts.push(`Address: ${l.property_address}${l.city ? ', ' + l.city : ''}${l.state ? ', ' + l.state : ''} ${l.zip || ''}`.trim())
  if (l.list_price) parts.push(`Price: $${Number(l.list_price).toLocaleString()}`)
  if (l.bedrooms) parts.push(`${l.bedrooms} bed`)
  const baths = (Number(l.bathrooms_full) || 0) + 0.5 * (Number(l.bathrooms_half) || 0)
  if (baths) parts.push(`${baths} bath`)
  if (l.square_feet) parts.push(`${Number(l.square_feet).toLocaleString()} sqft`)
  if (l.lot_size) parts.push(`${l.lot_size} lot`)
  if (l.year_built) parts.push(`built ${l.year_built}`)
  if (l.property_type) parts.push(l.property_type)
  if (l.garage_spaces) parts.push(`${l.garage_spaces}-car garage`)
  if (l.basement) parts.push(`${l.basement} basement`)
  if (l.heating) parts.push(`heat: ${l.heating}`)
  if (l.cooling) parts.push(`cooling: ${l.cooling}`)
  if (l.flooring) parts.push(`flooring: ${l.flooring}`)
  if (l.schools) parts.push(`schools: ${l.schools}`)
  if (l.taxes) parts.push(`taxes: $${Number(l.taxes).toLocaleString()}/yr`)
  if (l.hoa_fee) parts.push(`HOA $${l.hoa_fee}/${l.hoa_frequency || 'mo'}`)
  if (Array.isArray(l.features) && l.features.length) parts.push(`Features: ${l.features.join(', ')}`)
  if (l.description) parts.push(`Notes: ${l.description}`)
  return parts.join('\n')
}

// =============================================
// CRUD
// =============================================
router.get('/', (req, res) => {
  const { stage, status, search } = req.query
  let sql = 'SELECT * FROM listings WHERE 1=1'
  const params = []
  if (stage) { sql += ' AND stage = ?'; params.push(stage) }
  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (search) { sql += ' AND (property_address LIKE ? OR city LIKE ? OR mls_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`) }
  sql += ' ORDER BY updated_at DESC'
  const rows = db.all(sql, params)
  for (const r of rows) {
    for (const k of ['features', 'photos']) {
      if (r[k]) { try { r[k] = JSON.parse(r[k]) } catch { r[k] = [] } }
      else r[k] = []
    }
    if (r.marketing_tasks) { try { r.marketing_tasks = JSON.parse(r.marketing_tasks) } catch { r.marketing_tasks = {} } }
    else r.marketing_tasks = {}
  }
  res.json(rows)
})

router.get('/:id', (req, res) => {
  const row = getListing(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

const ALLOWED_FIELDS = [
  'property_address','city','state','zip','mls_number','stage','status',
  'list_price','original_list_price','bedrooms','bathrooms_full','bathrooms_half',
  'square_feet','lot_size','year_built','property_type','garage_spaces','stories',
  'basement','heating','cooling','flooring','schools','hoa_fee','hoa_frequency','taxes',
  'features','photos','hero_photo','virtual_tour_url','mls_link','description',
  'seller_name','seller_phone','seller_email',
  'list_date','under_contract_date','closing_date','open_house_date','open_house_time',
  'marketing_blog_post','marketing_social_instagram','marketing_social_facebook',
  'marketing_coming_soon','marketing_just_listed','marketing_open_house',
  'marketing_email_blast','marketing_price_reduction','marketing_listing_description',
  'marketing_tasks',
  'client_id','pre_listing_id','transaction_id','notes',
]

function normalizeBody(b) {
  const out = {}
  for (const f of ALLOWED_FIELDS) {
    if (!(f in b)) continue
    let v = b[f]
    if (f === 'features' || f === 'photos') {
      if (Array.isArray(v)) v = JSON.stringify(v)
      else if (typeof v === 'string') v = JSON.stringify(v.split(',').map(s => s.trim()).filter(Boolean))
    }
    if (f === 'marketing_tasks' && typeof v === 'object' && v !== null) {
      v = JSON.stringify(v)
    }
    out[f] = v === '' ? null : v
  }
  return out
}

router.post('/', (req, res) => {
  const data = normalizeBody(req.body)
  if (!data.property_address) return res.status(400).json({ error: 'property_address required' })
  if (!data.stage) data.stage = 'pre_listing'
  if (!data.status) data.status = 'New'
  const keys = Object.keys(data)
  const placeholders = keys.map(() => '?').join(',')
  const values = keys.map(k => n(data[k]))
  const result = db.run(`INSERT INTO listings (${keys.join(',')}) VALUES (${placeholders})`, values)
  logActivity('created', result.lastInsertRowid, `New listing: ${data.property_address}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const data = normalizeBody(req.body)
  data.updated_at = new Date().toISOString()
  const keys = Object.keys(data)
  if (!keys.length) return res.json({ success: true })
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(data[k])), Number(req.params.id)]
  db.run(`UPDATE listings SET ${sets} WHERE id = ?`, values)
  logActivity('updated', Number(req.params.id), 'Updated listing')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM listings WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', Number(req.params.id), 'Deleted listing')
  res.json({ success: true })
})

// =============================================
// IMPORT FROM PRE-LISTING / TRANSACTION (one-click)
// =============================================
router.post('/import-pre-listing/:preId', (req, res) => {
  const pre = db.get('SELECT * FROM pre_listings WHERE id = ?', [Number(req.params.preId)])
  if (!pre) return res.status(404).json({ error: 'pre-listing not found' })
  const existing = db.get('SELECT id FROM listings WHERE pre_listing_id = ?', [pre.id])
  if (existing) return res.json({ id: existing.id, alreadyExists: true })
  const result = db.run(
    `INSERT INTO listings (property_address, seller_name, stage, status, pre_listing_id, client_id, notes)
     VALUES (?, ?, 'pre_listing', ?, ?, ?, ?)`,
    [pre.property_address, pre.owner_name, pre.status || 'New', pre.id, pre.client_id, pre.notes]
  )
  logActivity('created', result.lastInsertRowid, `Imported from pre-listing: ${pre.property_address}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.post('/import-transaction/:txId', (req, res) => {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [Number(req.params.txId)])
  if (!tx) return res.status(404).json({ error: 'transaction not found' })
  const existing = db.get('SELECT id FROM listings WHERE transaction_id = ?', [tx.id])
  if (existing) return res.json({ id: existing.id, alreadyExists: true })
  const stage = tx.property_status === 'Active' ? 'active' : (tx.property_status === 'Closed' ? 'closed' : 'under_contract')
  const result = db.run(
    `INSERT INTO listings (property_address, mls_number, list_price, stage, status, seller_name, transaction_id, client_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [tx.property_address, tx.mls_number, tx.list_price, stage, tx.property_status || 'Active', tx.seller_name, tx.id, tx.client_id]
  )
  logActivity('created', result.lastInsertRowid, `Imported from transaction: ${tx.property_address}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

// =============================================
// AI EXTRACTION (PDF / URL)
// =============================================
const EXTRACT_SCHEMA_PROMPT = `Extract real estate listing data from the document and return ONLY a single JSON object with these keys (omit any keys you can't find — never invent values):
{
  "property_address": string (street only, no city),
  "city": string,
  "state": string (2-letter),
  "zip": string,
  "mls_number": string,
  "list_price": number,
  "bedrooms": number,
  "bathrooms_full": number,
  "bathrooms_half": number,
  "square_feet": number,
  "lot_size": string (e.g. "0.25 acres" or "10,890 sqft"),
  "year_built": number,
  "property_type": string (e.g. "Single Family", "Condo", "Townhouse"),
  "garage_spaces": number,
  "stories": number,
  "basement": string,
  "heating": string,
  "cooling": string,
  "flooring": string,
  "schools": string,
  "hoa_fee": number,
  "hoa_frequency": string ("monthly" / "annually"),
  "taxes": number (annual),
  "features": string[] (notable features/amenities),
  "description": string (the marketing remarks / public remarks),
  "virtual_tour_url": string,
  "mls_link": string
}
Return ONLY the JSON, no markdown fences, no commentary.`

function parseJsonFromText(text) {
  let t = (text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last === -1) throw new Error('No JSON object found in model output')
  return JSON.parse(t.slice(first, last + 1))
}

router.post('/:id/extract-pdf', async (req, res) => {
  const client = getClient()
  if (!client) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  const id = Number(req.params.id)
  const { pdf_base64, filename } = req.body || {}
  if (!pdf_base64) return res.status(400).json({ error: 'pdf_base64 required' })
  try {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf_base64 } },
          { type: 'text', text: EXTRACT_SCHEMA_PROMPT },
        ],
      }],
    })
    const text = msg.content?.[0]?.text || ''
    const data = parseJsonFromText(text)
    const normalized = normalizeBody(data)
    if (Object.keys(normalized).length) {
      normalized.updated_at = new Date().toISOString()
      const keys = Object.keys(normalized)
      const sets = keys.map(k => `${k} = ?`).join(', ')
      const values = [...keys.map(k => n(normalized[k])), id]
      db.run(`UPDATE listings SET ${sets} WHERE id = ?`, values)
      logActivity('extracted_pdf', id, `Extracted listing data from PDF${filename ? ': ' + filename : ''}`)
    }
    res.json({ success: true, extracted: data })
  } catch (e) {
    console.error('[listings] extract-pdf failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Shared: fetch a URL, strip noise, ask Claude to extract listing fields
async function fetchAndExtract(client, url) {
  const fetchRes = await fetchWithTimeout(url, 20000)
  if (!fetchRes.ok) {
    const err = new Error(`HTTP ${fetchRes.status}`)
    err.status = fetchRes.status
    throw err
  }
  let html = await fetchRes.text()
  // Detect anti-bot / captcha pages
  const lower = html.toLowerCase()
  const isShort = html.length < 80000
  if (isShort && (
    (lower.includes('captcha') && lower.includes('verify')) ||
    (lower.includes('press &amp; hold') || lower.includes('press & hold')) ||
    lower.includes('access to this page has been denied') ||
    lower.includes('checking your browser')
  )) {
    throw new Error('blocked by anti-bot page')
  }
  html = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  if (html.length > 120000) html = html.slice(0, 120000)

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `${EXTRACT_SCHEMA_PROMPT}\n\nSource URL: ${url}\n\nPage HTML:\n${html}`,
    }],
  })
  const text = msg.content?.[0]?.text || ''
  return parseJsonFromText(text)
}

function applyExtractedToListing(id, data, sourceUrl) {
  if (!data || typeof data !== 'object') return
  if (sourceUrl && !data.mls_link) data.mls_link = sourceUrl
  const normalized = normalizeBody(data)
  if (!Object.keys(normalized).length) return
  normalized.updated_at = new Date().toISOString()
  const keys = Object.keys(normalized)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(normalized[k])), id]
  db.run(`UPDATE listings SET ${sets} WHERE id = ?`, values)
}

router.post('/:id/extract-url', async (req, res) => {
  const client = getClient()
  if (!client) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  const id = Number(req.params.id)
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ error: 'url required' })
  try {
    const data = await fetchAndExtract(client, url)
    applyExtractedToListing(id, data, url)
    logActivity('extracted_url', id, `Extracted listing data from URL: ${url}`)
    res.json({ success: true, extracted: data })
  } catch (e) {
    console.error('[listings] extract-url failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// =============================================
// ADDRESS SEARCH (Nominatim — free, no API key)
// =============================================
function slugifyAddr(s) {
  return (s || '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9-]/g, '')
}

router.get('/search-address', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (q.length < 3) return res.json([])
  try {
    // Nominatim — restrict to US, then filter to Iowa server-side
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      q,
      countrycodes: 'us',
      format: 'jsonv2',
      addressdetails: '1',
      limit: '8',
    })
    const r = await fetch(url, { headers: { 'User-Agent': 'MattSmithTeamHub/1.0 (matt@mattsmithteam.com)' } })
    if (!r.ok) return res.status(502).json({ error: `Nominatim ${r.status}` })
    const rows = await r.json()
    const filtered = rows
      .filter(row => {
        const st = row.address?.state || ''
        return /iowa/i.test(st) || row.address?.['ISO3166-2-lvl4'] === 'US-IA'
      })
      .map(row => {
        const a = row.address || {}
        const houseNumber = a.house_number || ''
        const street = a.road || a.pedestrian || ''
        const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || ''
        const state = 'IA'
        const zip = a.postcode || ''
        return {
          display: row.display_name,
          property_address: [houseNumber, street].filter(Boolean).join(' ').trim(),
          city,
          state,
          zip,
          lat: row.lat,
          lon: row.lon,
        }
      })
      .filter(x => x.property_address && x.city)
    res.json(filtered)
  } catch (e) {
    console.error('[listings] search-address failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// =============================================
// AUTO-POPULATE FROM ADDRESS
// Strategy: use DuckDuckGo HTML search to find the actual property URL on
// Zillow/Realtor/Redfin/Trulia/Homes.com, then fetch it server-side.
// Falls back to direct constructed URLs if search returns nothing.
// =============================================

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
}

async function fetchWithTimeout(url, ms = 15000, extraHeaders = {}) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), ms)
  try {
    const r = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...extraHeaders },
      redirect: 'follow',
      signal: controller.signal,
    })
    return r
  } finally {
    clearTimeout(t)
  }
}

// Use DuckDuckGo HTML search to find the property page on a target domain
async function searchForListingUrl(addressQuery, domain) {
  const q = `${addressQuery} site:${domain}`
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`
  try {
    const r = await fetchWithTimeout(url, 12000, {
      'Accept': 'text/html',
      'Referer': 'https://duckduckgo.com/',
    })
    if (!r.ok) return null
    const html = await r.text()
    // DDG result links can be either direct or wrapped through /l/?uddg=...
    const candidates = []
    const directRe = new RegExp(`href="(https?://(?:www\\.)?${domain.replace('.', '\\.')}/[^"]+)"`, 'gi')
    let m
    while ((m = directRe.exec(html)) !== null) candidates.push(m[1])
    const wrapRe = /href="\/\/duckduckgo\.com\/l\/\?uddg=([^"&]+)/gi
    while ((m = wrapRe.exec(html)) !== null) {
      try {
        const decoded = decodeURIComponent(m[1])
        if (decoded.includes(domain)) candidates.push(decoded)
      } catch {}
    }
    // Pick the first that looks like a property detail (not a search results page)
    for (const c of candidates) {
      if (domain === 'zillow.com' && /\/homedetails\//.test(c)) return c
      if (domain === 'realtor.com' && /realestateandhomes-detail/.test(c)) return c
      if (domain === 'redfin.com' && /\/home\//.test(c)) return c
      if (domain === 'trulia.com' && /\/p\//.test(c)) return c
      if (domain === 'homes.com' && /\/property\//.test(c)) return c
    }
    return candidates[0] || null
  } catch {
    return null
  }
}

router.post('/:id/auto-populate', async (req, res) => {
  const client = getClient()
  if (!client) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  const id = Number(req.params.id)
  const { property_address, city, state = 'IA', zip } = req.body || {}
  if (!property_address || !city) return res.status(400).json({ error: 'property_address and city required' })

  const fullAddress = [property_address, city, state, zip].filter(Boolean).join(' ')
  const tried = []
  let extracted = null
  let sourceUrl = null

  const slug = [property_address, city, state, zip].filter(Boolean).map(slugifyAddr).join('-')

  // Step 1: Search-based discovery — find the actual property URL on each site
  const domains = ['zillow.com', 'realtor.com', 'redfin.com', 'trulia.com', 'homes.com']
  const discovered = []
  for (const d of domains) {
    const found = await searchForListingUrl(fullAddress, d)
    if (found) discovered.push({ source: d, url: found })
  }

  // Step 2: Add direct-pattern fallbacks if search didn't find that domain
  const directFallbacks = [
    { source: 'realtor.com (direct)', url: `https://www.realtor.com/realestateandhomes-detail/${slug}` },
    { source: 'zillow.com (direct)', url: `https://www.zillow.com/homes/${slug}_rb/` },
    { source: 'redfin.com (search)', url: `https://www.redfin.com/zipcode/${zip || ''}/filter/include=forsale+sold-1yr,viewport=${encodeURIComponent(fullAddress)}` },
  ]
  for (const f of directFallbacks) {
    const dom = f.source.split(' ')[0]
    if (!discovered.some(d => d.source === dom)) {
      discovered.push(f)
    }
  }

  // Step 3: Try each candidate
  for (const c of discovered) {
    try {
      const data = await fetchAndExtract(client, c.url)
      const useful = data && (data.bedrooms || data.square_feet || data.list_price || data.year_built)
      tried.push({ source: c.source, url: c.url, ok: !!useful })
      if (useful) {
        extracted = data
        sourceUrl = c.url
        break
      }
    } catch (e) {
      tried.push({ source: c.source, url: c.url, ok: false, error: e.message })
    }
  }

  if (!extracted) {
    return res.status(404).json({
      success: false,
      error: 'Could not find this property on any public listing site. It may not be listed for sale (or sites blocked us). Try uploading the MLS PDF instead.',
      tried,
    })
  }

  // Don't overwrite the user's address fields with the extracted ones
  delete extracted.property_address
  delete extracted.city
  delete extracted.state
  delete extracted.zip

  applyExtractedToListing(id, extracted, sourceUrl)
  logActivity('auto_populated', id, `Auto-populated from ${sourceUrl}`)
  res.json({ success: true, source: sourceUrl, extracted, tried })
})

// =============================================
// AI MARKETING GENERATION
// =============================================

const ASSET_PROMPTS = {
  description: {
    column: 'marketing_listing_description',
    label: 'MLS / Listing Description',
    prompt: (l, opts) => `Write a polished MLS listing description (250-350 words) for this property. Lead with what makes it special — location, key features, lifestyle. Cedar Rapids / Linn County, Iowa context. End with a clear, warm call-to-action to schedule a tour. No bullet points; flowing prose. Do NOT include the address as a header. ${opts?.tone ? 'Tone: ' + opts.tone + '.' : ''}\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  blog_post: {
    column: 'marketing_blog_post',
    label: 'Blog Post',
    prompt: (l, opts) => `Write a 700-900 word HTML blog post announcing this listing. Use <h2>, <h3>, <p>, <ul><li> tags only — NO <html>/<body>/<style>. Include: an engaging intro, 3-4 sections (location/neighborhood, the home itself, lifestyle/who it's for, why now), and a strong CTA at the bottom with this exact contact line: "Call or text Matt at (319) 431-5859 — RE/MAX Concepts, Cedar Rapids." Include 2-3 internal-link placeholders like <a href="https://www.mattsmithteam.com/cedar-rapids">Cedar Rapids homes</a>. Cedar Rapids/Marion/Linn County voice. ${opts?.angle ? 'Angle: ' + opts.angle + '.' : ''}\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  social_instagram: {
    column: 'marketing_social_instagram',
    label: 'Instagram Caption',
    prompt: (l) => `Write an Instagram caption for this just-listed property (140-220 words). Hook in the first line. Use line breaks between thoughts. End with 12-18 relevant hashtags split between local (Cedar Rapids/Marion/Iowa real estate) and broad (real estate, home buying). Include 2-4 emojis tastefully. Include a CTA: link in bio or DM for tour. Don't lead with the address.\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  social_facebook: {
    column: 'marketing_social_facebook',
    label: 'Facebook Post',
    prompt: (l) => `Write a Facebook post for this listing (180-280 words). Conversational, warm, neighbor-to-neighbor tone. Lead with a hook. Mention the address. End with a clear CTA: "Comment 'INFO' or call/text (319) 431-5859 to schedule a tour." No hashtags (Facebook doesn't use them well). 1-3 emojis max.\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  coming_soon: {
    column: 'marketing_coming_soon',
    label: 'Coming Soon Post',
    prompt: (l) => `Write a "Coming Soon" social media post (90-130 words) for this property. Build anticipation without giving away every detail — tease 2-3 standout features, hint at the neighborhood, no specific list date if not provided. End with: "DM or call (319) 431-5859 to be the first to tour it." Include 8-12 hashtags optimized for IG/FB.\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  just_listed: {
    column: 'marketing_just_listed',
    label: 'Just Listed Post',
    prompt: (l) => `Write a "JUST LISTED" social media post (110-160 words). Bold opening like "JUST LISTED!" or "NEW ON MARKET". Include address, beds/baths/sqft/price as a clean stat line. 2-3 sentences on what makes it special. CTA: "Call/text (319) 431-5859 to schedule your tour." End with 10-14 hashtags (mix local + national).\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  open_house: {
    column: 'marketing_open_house',
    label: 'Open House Post',
    prompt: (l, opts) => {
      const oh = (l.open_house_date && l.open_house_time) ? `${l.open_house_date} from ${l.open_house_time}` : (opts?.when || 'this weekend — date/time to be confirmed')
      return `Write an Open House announcement (110-160 words) for this listing. Lead with "OPEN HOUSE" + the date/time: ${oh}. Include the address, key stats (beds/baths/sqft/price), and 2-3 selling points. Friendly invite tone, no high-pressure language. CTA: "Stop by — or call/text (319) 431-5859 if you can't make it." 8-12 hashtags.\n\nPROPERTY:\n${summarizeListing(l)}`
    },
  },
  email_blast: {
    column: 'marketing_email_blast',
    label: 'Email Blast',
    prompt: (l) => `Write a marketing email blast for this new listing. Format:\n- Subject line (under 65 chars, no all-caps spam)\n- Preview text (under 100 chars)\n- HTML email body (use <h2>, <h3>, <p>, <ul><li> only — no inline styles, no <html>/<body>). Include a property summary, 3-4 highlights as a bulleted list, and a clear CTA button-style link: <a href="tel:3194315859">Call (319) 431-5859</a> | <a href="mailto:matt@mattsmithteam.com">Email Matt</a>\n\nReturn as JSON: {"subject": "...", "preview": "...", "html": "..."}\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
  price_reduction: {
    column: 'marketing_price_reduction',
    label: 'Price Reduction Post',
    prompt: (l) => `Write a "Price Improvement" / "Price Reduced" social post (100-140 words) for this listing. Avoid sounding desperate — frame as "newly improved price" or "fresh price". Include the new price, original (if known: $${l.original_list_price || 'N/A'}). Stat line: address, beds/baths/sqft. CTA to tour. 8-12 hashtags.\n\nPROPERTY:\n${summarizeListing(l)}`,
  },
}

router.post('/:id/generate/:asset', async (req, res) => {
  const client = getClient()
  if (!client) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  const id = Number(req.params.id)
  const asset = req.params.asset
  const def = ASSET_PROMPTS[asset]
  if (!def) return res.status(400).json({ error: `Unknown asset: ${asset}` })
  const listing = getListing(id)
  if (!listing) return res.status(404).json({ error: 'Listing not found' })

  try {
    const userPrompt = def.prompt(listing, req.body || {})
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: TEAM_VOICE,
      messages: [{ role: 'user', content: userPrompt }],
    })
    const out = (msg.content?.[0]?.text || '').trim()
    const stamp = new Date().toISOString()
    db.run(`UPDATE listings SET ${def.column} = ?, updated_at = ? WHERE id = ?`, [out, stamp, id])
    logActivity('generated', id, `Generated ${def.label}`)
    res.json({ success: true, asset, label: def.label, content: out })
  } catch (e) {
    console.error(`[listings] generate ${asset} failed:`, e.message)
    res.status(500).json({ error: e.message })
  }
})

// List of available marketing assets (for UI buttons)
router.get('/_meta/assets', (_req, res) => {
  res.json(Object.entries(ASSET_PROMPTS).map(([key, v]) => ({ key, label: v.label, column: v.column })))
})

router.get('/_meta/ai-status', (_req, res) => {
  res.json({ configured: !!process.env.ANTHROPIC_API_KEY, model: MODEL })
})

export default router
