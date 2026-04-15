import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

// All fields matching Google Sheet "Transaction 2026" tab
const FIELDS = [
  'property_address', 'mls_number', 'type', 'source', 'buyer_name', 'buyers_agent_name',
  'seller_name', 'sellers_agent_name', 'agency_type', 'property_status', 'list_price',
  'purchase_price', 'contract_date', 'closing_date', 'mortgage_contingency_date',
  'appraisal_contingency_date', 'appraisal_contingency_status', 'inspection_contingency_date',
  'financing_release', 'final_walkthrough', 'inspection_release', 'final_inspection_waiver',
  'type_of_finance', 'remove_listing_alerts', 'email_contract_closing', 'ayse_added_to_loop',
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

// Sync from Google Sheet
router.post('/sync-sheet', async (req, res) => {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1628DMNtqi5_hcS4e62RTjtHjwp5i8qk4wIloFO15dug/gviz/tq?tqx=out:csv&sheet=Transaction%202026'
    const response = await fetch(sheetUrl)
    const csv = await response.text()

    const lines = csv.split('\n').filter(l => l.trim())
    if (lines.length < 2) return res.json({ synced: 0 })

    let synced = 0
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i])
      if (!cols[0]) continue // skip empty rows

      const existing = db.get('SELECT id FROM transactions WHERE property_address = ? AND mls_number = ?',
        [cols[0], n(cols[1])])

      if (existing) continue // don't overwrite existing

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
    }

    logActivity('synced', 'transaction', null, `Synced ${synced} transactions from Google Sheet`)
    res.json({ synced })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
      else { inQuotes = !inQuotes }
    } else if (c === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += c
    }
  }
  result.push(current.trim())
  return result
}

export default router
