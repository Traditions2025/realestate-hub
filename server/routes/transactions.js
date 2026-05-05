import express, { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

// Allow large PDF base64 uploads
router.use(express.json({ limit: '25mb' }))

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
let _client = null
function getClient() {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) return null
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

// All fields matching Google Sheet "Transaction 2026" tab + new fields
const FIELDS = [
  'property_address', 'mls_number', 'type', 'source', 'buyer_name', 'buyers_agent_name',
  'seller_name', 'sellers_agent_name', 'agency_type', 'property_status', 'list_price',
  'purchase_price', 'contract_date', 'closing_date', 'mortgage_contingency_date',
  'appraisal_contingency_date', 'appraisal_contingency_status', 'inspection_contingency_date',
  'financing_release', 'final_walkthrough', 'inspection_release', 'final_inspection_waiver',
  'type_of_finance',
  'earnest_money_due_date', 'ipi_due_date', 'lender_name', 'lender_company', 'lender_email', 'dotloop_status',
  'remove_listing_alerts', 'email_contract_closing', 'ayse_added_to_loop',
  'ayse_contracts_signed', 'earnest_money_deposit', 'home_inspection', 'home_inspector',
  'inspection_date', 'whole_property_inspection', 'radon_test', 'wdi_inspection',
  'septic_inspection', 'well_inspection', 'sewer_inspection', 'seller_acknowledgment',
  'abstract', 'title_commitment', 'mortgage_payoff', 'alta_statement', 'deed_package',
  'utilities_set', 'sales_worksheet_added', 'submit_loop_review', 'approved_commission',
  'closing_complete', 'testimonial_request', 'client_id', 'tc_assigned', 'notes'
]

router.get('/', (req, res) => {
  const { type, property_status, search } = req.query
  let sql = `SELECT t.*, c.first_name || ' ' || c.last_name as client_name
    FROM transactions t LEFT JOIN clients c ON t.client_id = c.id WHERE 1=1`
  const params = []

  if (type) { sql += ' AND t.type = ?'; params.push(type) }
  if (property_status) { sql += ' AND t.property_status = ?'; params.push(property_status) }
  if (search) { sql += ' AND (t.property_address LIKE ? OR t.mls_number LIKE ? OR t.buyer_name LIKE ? OR t.seller_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`) }

  sql += ' ORDER BY t.updated_at DESC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get(`SELECT t.*, c.first_name || ' ' || c.last_name as client_name
    FROM transactions t LEFT JOIN clients c ON t.client_id = c.id WHERE t.id = ?`, [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const placeholders = FIELDS.map(() => '?').join(',')
  const values = FIELDS.map(f => n(b[f]))

  const result = db.run(`INSERT INTO transactions (${FIELDS.join(',')}) VALUES (${placeholders})`, values)
  logActivity('created', 'transaction', result.lastInsertRowid, `New ${b.type}: ${b.property_address}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE transactions SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'transaction', Number(req.params.id), 'Updated transaction')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM transactions WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'transaction', Number(req.params.id), 'Deleted transaction')
  res.json({ success: true })
})

// Wipe all transactions (lets user re-sync clean from Google Sheet)
router.post('/clear-all', (req, res) => {
  db.run('DELETE FROM transactions')
  logActivity('cleared', 'transaction', null, 'All transactions cleared')
  res.json({ success: true })
})

// Sync from Google Sheet
router.post('/sync-sheet', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1628DMNtqi5_hcS4e62RTjtHjwp5i8qk4wIloFO15dug/gviz/tq?tqx=out:csv&sheet=Transaction%202026'
    const response = await fetch(sheetUrl)
    const csv = await response.text()

    const rows = parseCSV(csv)
    if (rows.length < 2) return res.json({ synced: 0 })

    let synced = 0
    let errors = []
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i]
      if (!cols[0]) continue // skip empty rows

      try {

      const existing = db.get('SELECT id FROM transactions WHERE property_address = ?', [cols[0]])
      if (existing) {
        // Update key status fields without overwriting manual changes
        db.run(`UPDATE transactions SET property_status=?, purchase_price=?, list_price=?,
          contract_date=?, closing_date=?, updated_at=datetime('now') WHERE id=?`,
          [n(cols[9]) || 'Active',
            cols[11] ? parseFloat(cols[11].replace(/[$,]/g, '')) : null,
            cols[10] ? parseFloat(cols[10].replace(/[$,]/g, '')) : null,
            n(cols[12]), n(cols[13]), existing.id])
        synced++
        continue
      }

      const boolVal = (v) => v === 'TRUE' ? 1 : 0

      // Determine type from Agency Type column: Listing Agent = listing, otherwise purchase
      const agencyType = cols[8] || ''
      const txType = agencyType.includes('Listing') ? 'listing' : 'purchase'

      db.run(`INSERT INTO transactions (property_address, mls_number, type, source, buyer_name,
        buyers_agent_name, seller_name, sellers_agent_name, agency_type, property_status,
        list_price, purchase_price, contract_date, closing_date, mortgage_contingency_date,
        appraisal_contingency_date, appraisal_contingency_status, inspection_contingency_date,
        financing_release, final_walkthrough, inspection_release, final_inspection_waiver,
        type_of_finance, remove_listing_alerts, email_contract_closing, ayse_added_to_loop,
        ayse_contracts_signed, earnest_money_deposit, home_inspection, home_inspector,
        inspection_date, whole_property_inspection, radon_test, wdi_inspection,
        septic_inspection, well_inspection, sewer_inspection, seller_acknowledgment,
        abstract, title_commitment, mortgage_payoff, alta_statement, deed_package,
        utilities_set, sales_worksheet_added, submit_loop_review, approved_commission,
        closing_complete, testimonial_request, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          cols[0], n(cols[1]), txType, n(cols[3]), n(cols[4]),
          n(cols[5]), n(cols[6]), n(cols[7]), n(cols[8]), n(cols[9]) || 'Active',
          cols[10] ? parseFloat(cols[10].replace(/[$,]/g, '')) : null,
          cols[11] ? parseFloat(cols[11].replace(/[$,]/g, '')) : null,
          n(cols[12]), n(cols[13]), n(cols[14]),
          n(cols[15]), n(cols[16]), n(cols[17]),
          n(cols[18]), n(cols[19]), n(cols[20]), n(cols[21]),
          n(cols[22]),
          boolVal(cols[23]), boolVal(cols[24]), boolVal(cols[25]),
          boolVal(cols[26]), n(cols[27]), n(cols[28]), n(cols[29]),
          n(cols[30]), boolVal(cols[31]), boolVal(cols[32]), boolVal(cols[33]),
          boolVal(cols[34]), boolVal(cols[35]), boolVal(cols[36]), boolVal(cols[37]),
          n(cols[38]), n(cols[39]), n(cols[40]), n(cols[41]), n(cols[42]),
          boolVal(cols[43]), boolVal(cols[44]), boolVal(cols[45]), boolVal(cols[46]),
          boolVal(cols[47]), boolVal(cols[48]), n(cols[49])
        ])
      synced++
      } catch (rowErr) {
        errors.push({ row: i, address: cols[0], error: rowErr.message })
        console.error(`[sync] Row ${i} failed (${cols[0]}):`, rowErr.message)
      }
    }

    logActivity('synced', 'transaction', null, `Synced ${synced} transactions from Google Sheet${errors.length ? ` (${errors.length} errors)` : ''}`)
    res.json({ synced, errors })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Proper CSV parser that handles quoted fields with embedded commas AND newlines
function parseCSV(csv) {
  const rows = []
  let row = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (inQuotes) {
      if (c === '"') {
        if (csv[i + 1] === '"') { cell += '"'; i++ }
        else inQuotes = false
      } else {
        cell += c
      }
    } else {
      if (c === '"') inQuotes = true
      else if (c === ',') { row.push(cell.trim()); cell = '' }
      else if (c === '\n' || c === '\r') {
        if (cell || row.length) {
          row.push(cell.trim())
          if (row.some(v => v !== '')) rows.push(row)
          row = []
          cell = ''
        }
        if (c === '\r' && csv[i + 1] === '\n') i++
      } else {
        cell += c
      }
    }
  }
  if (cell || row.length) {
    row.push(cell.trim())
    if (row.some(v => v !== '')) rows.push(row)
  }
  return rows
}

// =============================================
// PURCHASE AGREEMENT PDF EXTRACTION
// =============================================
const PURCHASE_AGREEMENT_PROMPT = `You are reading an Iowa real estate Purchase Agreement / Listing Agreement / contract document.

Extract the following fields and return ONLY a single JSON object — omit any keys you cannot find with high confidence (do not invent values):

{
  "property_address": string (street + city, e.g. "2416 C St SW, Cedar Rapids, IA 52404"),
  "mls_number": string,
  "type": string ("purchase" if this is a buyer/purchase agreement, "listing" if this is a listing agreement),
  "source": string (referral source, lead source, brokerage name),
  "buyer_name": string (full names of all buyers, comma-separated if multiple, e.g. "John & Jane Smith"),
  "buyers_agent_name": string (the buyer's agent name),
  "seller_name": string (full names of all sellers, comma-separated if multiple),
  "sellers_agent_name": string (the listing/seller's agent name),
  "agency_type": string (one of: "Listing Agent", "Buyers Agent", "Dual Agency", "Designated Agency"),
  "list_price": number (no commas or dollar signs),
  "purchase_price": number (no commas or dollar signs — the agreed-upon price),
  "contract_date": string (YYYY-MM-DD — the date the contract was signed/accepted),
  "closing_date": string (YYYY-MM-DD),
  "mortgage_contingency_date": string (YYYY-MM-DD — financing contingency deadline),
  "appraisal_contingency_date": string (YYYY-MM-DD),
  "inspection_contingency_date": string (YYYY-MM-DD — inspection deadline),
  "type_of_finance": string (one of: "Conventional", "FHA", "VA", "USDA", "Cash", "Other"),
  "earnest_money_deposit": string (just the dollar amount as a string, e.g. "$2,500", or "Not Started" if not yet collected),
  "whole_property_inspection": number (1 if mentioned, 0 if not),
  "radon_test": number (1 if radon test is mentioned/required, 0 if not),
  "wdi_inspection": number (1 if Wood Destroying Insect / termite inspection mentioned, 0 if not),
  "septic_inspection": number (1 if septic inspection mentioned, 0 if not),
  "well_inspection": number (1 if well inspection mentioned, 0 if not),
  "sewer_inspection": number (1 if sewer/lateral inspection mentioned, 0 if not),
  "notes": string (any unusual terms, contingencies, or seller concessions worth flagging)
}

Rules:
- For dates, if you only see a date like "5/15/2026" convert to "2026-05-15"
- For prices and earnest money, look in the financial sections of the agreement
- For inspection checkboxes, set to 1 ONLY if the document explicitly indicates the inspection is being performed/required
- If the document is a Listing Agreement (not Purchase), set type=listing and skip buyer fields
- Return ONLY the JSON object — no markdown fences, no commentary.`

function parseJsonFromText(text) {
  let t = (text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last === -1) throw new Error('No JSON object found in model output')
  return JSON.parse(t.slice(first, last + 1))
}

function applyExtractedToTransaction(id, data) {
  if (!data || typeof data !== 'object') return 0
  const allowed = FIELDS.filter(f => f in data && data[f] !== null && data[f] !== '')
  if (!allowed.length) return 0
  const sets = allowed.map(f => `${f} = ?`).join(', ')
  const values = [...allowed.map(f => n(data[f])), id]
  db.run(`UPDATE transactions SET ${sets}, updated_at = datetime('now') WHERE id = ?`, values)
  return allowed.length
}

router.post('/:id/extract-pdf', async (req, res) => {
  const client = getClient()
  if (!client) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })
  const id = Number(req.params.id)
  const exists = db.get('SELECT id FROM transactions WHERE id = ?', [id])
  if (!exists) return res.status(404).json({ error: 'Transaction not found' })
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
          { type: 'text', text: PURCHASE_AGREEMENT_PROMPT },
        ],
      }],
    })
    const text = msg.content?.[0]?.text || ''
    const data = parseJsonFromText(text)
    const updatedCount = applyExtractedToTransaction(id, data)
    logActivity('extracted_pdf', 'transaction', id, `Extracted ${updatedCount} fields from purchase agreement${filename ? ': ' + filename : ''}`)
    res.json({ success: true, extracted: data, updated_fields: updatedCount })
  } catch (e) {
    console.error('[transactions] extract-pdf failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/_meta/ai-status', (_req, res) => {
  res.json({ configured: !!process.env.ANTHROPIC_API_KEY, model: MODEL })
})

export default router
