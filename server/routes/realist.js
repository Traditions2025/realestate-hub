import express, { Router } from 'express'
import db from '../database.js'

const router = Router()
router.use(express.json({ limit: '50mb' })) // Realist CSVs can be large
router.use(express.text({ limit: '50mb', type: ['text/csv', 'text/plain'] }))

const n = (v) => v === undefined || v === '' ? null : v

// =============================================
// CSV PARSER (handles Realist's Excel quirks)
// =============================================
// Realist CSVs prefix some cells with =" to preserve leading zeros (e.g. ZIP `="52302"`)
// and use $ + commas for currency. We strip both.
function cleanCell(s) {
  if (s == null) return ''
  let v = String(s).trim()
  // ="52302" → 52302
  if (v.startsWith('="') && v.endsWith('"')) v = v.slice(2, -1)
  return v
}
function parseCurrency(s) {
  if (!s) return null
  const cleaned = String(s).replace(/[$,\s]/g, '').trim()
  if (!cleaned || cleaned === '-') return null
  const n = Number(cleaned)
  return isNaN(n) ? null : n
}
function parseInt2(s) {
  if (s == null || s === '') return null
  const m = String(s).match(/-?\d+/)
  if (!m) return null
  const n = parseInt(m[0], 10)
  return isNaN(n) ? null : n
}
// "Tax: 4 MLS: 3" → take MLS value if present, else Tax. Returns int.
function parseTaxOrMls(s) {
  if (!s) return null
  const str = String(s)
  const mls = str.match(/MLS\s*:\s*(\d+)/i)
  if (mls) return parseInt(mls[1], 10)
  const tax = str.match(/(?:Tax\s*:\s*)?(\d+)/i)
  return tax ? parseInt(tax[1], 10) : null
}

// CSV line → array of cells (handles quoted fields with embedded commas)
function parseCsvLine(line) {
  const cells = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }
        else inQuotes = false
      } else cur += c
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { cells.push(cur); cur = '' }
      else cur += c
    }
  }
  cells.push(cur)
  return cells
}

function parseCsv(text) {
  // Split into rows respecting quoted newlines
  const rows = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') inQuotes = !inQuotes
    if ((c === '\n' || c === '\r') && !inQuotes) {
      if (cur) rows.push(cur)
      cur = ''
      if (c === '\r' && text[i + 1] === '\n') i++
    } else {
      cur += c
    }
  }
  if (cur) rows.push(cur)
  return rows.map(parseCsvLine).map(row => row.map(cleanCell))
}

// Normalize an address for matching:
// - lowercase, trim, strip punctuation, collapse whitespace
// - normalize common abbreviations
const STREET_ABBR = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct',
  place: 'pl', boulevard: 'blvd', circle: 'cir', trail: 'trl', terrace: 'ter',
  parkway: 'pkwy', highway: 'hwy', way: 'way',
}
function normalizeAddress(addr) {
  if (!addr) return ''
  let s = String(addr).toLowerCase().trim()
  s = s.replace(/[.,]/g, ' ').replace(/\s+/g, ' ')
  for (const [full, abbr] of Object.entries(STREET_ABBR)) {
    s = s.replace(new RegExp(`\\b${full}\\b`, 'g'), abbr)
  }
  // Drop trailing apartment / unit info for matching purposes
  s = s.replace(/\s+(apt|unit|ste|#)\s*\S+/g, '')
  return s.trim()
}

// =============================================
// IMPORT ENDPOINT
// =============================================
router.post('/import', async (req, res) => {
  // Accept either CSV text body or { csv: "..." } JSON
  let csvText = ''
  if (typeof req.body === 'string') csvText = req.body
  else if (req.body && typeof req.body.csv === 'string') csvText = req.body.csv
  if (!csvText) return res.status(400).json({ error: 'No CSV data provided' })

  let rows
  try { rows = parseCsv(csvText) } catch (e) { return res.status(400).json({ error: 'CSV parse failed: ' + e.message }) }
  if (rows.length < 2) return res.status(400).json({ error: 'CSV is empty or has no data rows' })

  const header = rows[0].map(h => h.trim())
  // Find column indices — the header has duplicate "Market Value" cols, take the first occurrence
  const findCol = (name) => {
    const idx = header.findIndex(h => h.toLowerCase() === name.toLowerCase())
    return idx === -1 ? null : idx
  }
  const cols = {
    owner_first: findCol('Owner First Name'),
    owner_last: findCol('Owner Last Name'),
    owner_name_2: findCol('Owner Name 2'),
    owner_occupied: findCol('Owner Occupied'),
    state: findCol('State'),
    zip: findCol('Zip Code'),
    city: findCol('Property City'),
    property_address: findCol('Property Address'),
    total_assmnt: findCol('Total Assmnt'),
    market_value: findCol('Market Value'), // first occurrence
    assessed_value: findCol('Assd Value'),
    building_type: findCol('Building Type'),
    total_baths: findCol('Total Baths (TAX|MLS)'),
    full_baths: findCol('Full Baths (TAX|MLS)'),
    yr_built: findCol('Yr Built (TAX|MLS)'),
    bedrooms: findCol('Bedrooms (TAX|MLS)'),
    sell_score: findCol('Sell Score'),
    sale_date: findCol('Sale Date (TAX|MLS)'),
    last_sale_price: findCol('Last Mkt Sale Price'),
    last_price_per_sqft: findCol('Last Mkt Price Per Sq Ft'),
    mls_status: findCol('MLS Status'),
    style: findCol('Style'),
    county: findCol('County'),
    school_district: findCol('School District'),
    subdivision: findCol('Subdivision'),
    township: findCol('Township'),
    zoning: findCol('Zoning'),
  }

  if (cols.property_address == null) {
    return res.status(400).json({ error: 'CSV missing required "Property Address" column' })
  }

  let inserted = 0, skipped = 0, errors = 0
  let matchedClients = 0

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]
    if (!row || row.length < 3) continue
    const addr = (row[cols.property_address] || '').trim()
    if (!addr) { skipped++; continue }
    try {
      const norm = normalizeAddress(addr)
      const data = {
        property_address: addr,
        address_normalized: norm,
        city: cols.city != null ? row[cols.city] || null : null,
        state: cols.state != null ? row[cols.state] || null : null,
        zip: cols.zip != null ? row[cols.zip] || null : null,
        county: cols.county != null ? row[cols.county] || null : null,
        owner_first_name: cols.owner_first != null ? row[cols.owner_first] || null : null,
        owner_last_name: cols.owner_last != null ? row[cols.owner_last] || null : null,
        owner_name_2: cols.owner_name_2 != null ? row[cols.owner_name_2] || null : null,
        owner_occupied: cols.owner_occupied != null && /^y/i.test(row[cols.owner_occupied] || '') ? 1 : 0,
        market_value: cols.market_value != null ? parseCurrency(row[cols.market_value]) : null,
        assessed_value: cols.assessed_value != null ? parseCurrency(row[cols.assessed_value]) : null,
        total_assessment: cols.total_assmnt != null ? parseCurrency(row[cols.total_assmnt]) : null,
        last_sale_price: cols.last_sale_price != null ? parseCurrency(row[cols.last_sale_price]) : null,
        last_sale_date: cols.sale_date != null ? row[cols.sale_date] || null : null,
        last_price_per_sqft: cols.last_price_per_sqft != null ? parseCurrency(row[cols.last_price_per_sqft]) : null,
        building_type: cols.building_type != null ? row[cols.building_type] || null : null,
        style: cols.style != null ? row[cols.style] || null : null,
        year_built: cols.yr_built != null ? parseTaxOrMls(row[cols.yr_built]) : null,
        bedrooms: cols.bedrooms != null ? parseTaxOrMls(row[cols.bedrooms]) : null,
        bathrooms_full: cols.full_baths != null ? parseTaxOrMls(row[cols.full_baths]) : null,
        bathrooms_total: cols.total_baths != null ? row[cols.total_baths] || null : null,
        sell_score: cols.sell_score != null ? parseInt2(row[cols.sell_score]) : null,
        mls_status: cols.mls_status != null ? row[cols.mls_status] || null : null,
        subdivision: cols.subdivision != null ? row[cols.subdivision] || null : null,
        school_district: cols.school_district != null ? row[cols.school_district] || null : null,
        township: cols.township != null ? row[cols.township] || null : null,
        zoning: cols.zoning != null ? row[cols.zoning] || null : null,
      }

      // Upsert by normalized address
      const existing = db.get('SELECT id FROM realist_properties WHERE address_normalized = ? LIMIT 1', [norm])
      let propId
      if (existing) {
        const keys = Object.keys(data)
        const sets = keys.map(k => `${k} = ?`).join(', ')
        db.run(`UPDATE realist_properties SET ${sets}, imported_at = datetime('now') WHERE id = ?`,
          [...keys.map(k => n(data[k])), existing.id])
        propId = existing.id
      } else {
        const keys = Object.keys(data)
        const placeholders = keys.map(() => '?').join(',')
        const result = db.run(`INSERT INTO realist_properties (${keys.join(',')}) VALUES (${placeholders})`,
          keys.map(k => n(data[k])))
        propId = result.lastInsertRowid
      }
      inserted++

      // Match to clients with the same normalized address (any with that address get enriched)
      const clientMatches = db.all(`SELECT id FROM clients WHERE address IS NOT NULL AND LOWER(REPLACE(REPLACE(address, '.', ''), ',', '')) LIKE ?`,
        [`%${norm}%`])
      for (const c of clientMatches) {
        db.run(`UPDATE clients SET
          realist_property_id = ?,
          realist_market_value = ?,
          realist_assessed_value = ?,
          realist_year_built = ?,
          realist_bedrooms = ?,
          realist_bathrooms_full = ?,
          realist_owner_occupied = ?,
          realist_sell_score = ?,
          realist_last_sale_price = ?,
          realist_last_sale_date = ?,
          realist_matched_at = datetime('now')
          WHERE id = ?`,
          [propId, data.market_value, data.assessed_value, data.year_built, data.bedrooms,
            data.bathrooms_full, data.owner_occupied, data.sell_score,
            data.last_sale_price, data.last_sale_date, c.id])
        matchedClients++
      }
    } catch (e) {
      errors++
      if (errors <= 5) console.error('[realist] row error:', e.message)
    }
  }

  db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
    ['imported', 'realist', `Realist CSV: ${inserted} properties imported/updated, ${matchedClients} client matches enriched, ${skipped} skipped, ${errors} errors`])

  res.json({
    success: true,
    rows_processed: rows.length - 1,
    properties_imported: inserted,
    client_matches_enriched: matchedClients,
    skipped,
    errors,
  })
})

// Stats — quick check
router.get('/stats', (_req, res) => {
  const total = db.get('SELECT COUNT(*) as c FROM realist_properties').c
  const matchedClients = db.get('SELECT COUNT(*) as c FROM clients WHERE realist_property_id IS NOT NULL').c
  const lastImport = db.get("SELECT MAX(imported_at) as t FROM realist_properties").t
  res.json({ total_properties: total, enriched_clients: matchedClients, last_import: lastImport })
})

// Get the realist record for a client (lookup by address if not directly linked)
router.get('/for-client/:id', (req, res) => {
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(req.params.id)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  let prop = null
  if (client.realist_property_id) {
    prop = db.get('SELECT * FROM realist_properties WHERE id = ?', [client.realist_property_id])
  }
  if (!prop && client.address) {
    const norm = normalizeAddress(client.address)
    if (norm) prop = db.get('SELECT * FROM realist_properties WHERE address_normalized = ? LIMIT 1', [norm])
  }
  res.json(prop || null)
})

// Re-run matching against existing realist_properties — useful after the table is populated and new clients sync from Sierra
router.post('/rematch', (_req, res) => {
  const properties = db.all('SELECT * FROM realist_properties')
  let updated = 0
  for (const p of properties) {
    const norm = p.address_normalized || normalizeAddress(p.property_address)
    if (!norm) continue
    const matches = db.all(`SELECT id FROM clients WHERE address IS NOT NULL AND LOWER(REPLACE(REPLACE(address, '.', ''), ',', '')) LIKE ?`, [`%${norm}%`])
    for (const c of matches) {
      db.run(`UPDATE clients SET
        realist_property_id = ?, realist_market_value = ?, realist_assessed_value = ?,
        realist_year_built = ?, realist_bedrooms = ?, realist_bathrooms_full = ?,
        realist_owner_occupied = ?, realist_sell_score = ?,
        realist_last_sale_price = ?, realist_last_sale_date = ?,
        realist_matched_at = datetime('now')
        WHERE id = ?`,
        [p.id, p.market_value, p.assessed_value, p.year_built, p.bedrooms,
          p.bathrooms_full, p.owner_occupied, p.sell_score,
          p.last_sale_price, p.last_sale_date, c.id])
      updated++
    }
  }
  res.json({ success: true, properties_scanned: properties.length, client_matches_updated: updated })
})

export default router
