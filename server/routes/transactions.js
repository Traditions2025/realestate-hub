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
  'has_insurance_contingency', 'has_home_warranty',
  'remove_listing_alerts', 'email_contract_closing', 'ayse_added_to_loop',
  'ayse_contracts_signed', 'earnest_money_deposit', 'home_inspection', 'home_inspector',
  'inspection_date', 'whole_property_inspection', 'radon_test', 'wdi_inspection',
  'septic_inspection', 'well_inspection', 'sewer_inspection', 'seller_acknowledgment',
  'abstract', 'title_commitment', 'mortgage_payoff', 'alta_statement', 'deed_package',
  'utilities_set', 'sales_worksheet_added', 'submit_loop_review', 'approved_commission',
  'closing_complete', 'testimonial_request', 'client_id', 'tc_assigned', 'notes',
  // Expanded under-contract checklist
  'closing_time', 'closing_location',
  'closing_time_confirmed', 'closing_location_confirmed', 'closing_attendees_notified',
  'closing_disclosure_reviewed', 'wire_instructions_sent', 'seller_signed_deed',
  'mls_pending_marked', 'mls_sold_marked',
  'sellers_disclosure_received', 'hoa_docs_provided',
  'keys_remotes_collected', 'sign_lockbox_removed',
  'commission_received', 'referral_followup_30day',
  'buyer_payment_method', 'financing_release_followup',
  'closing_invite_signature', 'closing_invite_sent_at',
  'final_walkthrough_time', 'final_walkthrough_location',
  'final_walkthrough_invite_signature', 'final_walkthrough_invite_sent_at',
  'final_walkthrough_confirmed',
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

// Map transaction property_status → listing stage
const STATUS_TO_STAGE = {
  'Active': 'active',
  'Coming Soon': 'coming_soon',
  'Pre-Listing': 'pre_listing',
  'Under Contract': 'under_contract',
  'Pending': 'under_contract',
  'Clear to Close': 'under_contract',
  'Closed': 'closed',
  'Withdrawn': 'closed',
  'Expired': 'closed',
  'Cancelled': 'closed',
}
const LIVE_STATUSES = new Set(['Active', 'Coming Soon', 'Under Contract', 'Pending', 'Clear to Close', 'Closed'])

// Auto-sync a listing-type transaction into the listings table.
// - Updates the linked listing if one exists (transaction_id match)
// - Creates a new listing if none exists AND the transaction is in a "live" status
// - No-op for purchase transactions
function syncListingFromTransaction(txId) {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
  if (!tx || tx.type !== 'listing') return null

  const status = tx.property_status || 'Active'
  const stage = STATUS_TO_STAGE[status] || 'active'

  const existing = db.get('SELECT id FROM listings WHERE transaction_id = ?', [tx.id])
  if (existing) {
    db.run(`UPDATE listings SET
      property_address = ?, mls_number = ?, list_price = ?,
      stage = ?, status = ?, seller_name = ?, client_id = ?,
      updated_at = datetime('now')
      WHERE id = ?`,
      [tx.property_address, tx.mls_number, tx.list_price, stage, status,
        tx.seller_name, tx.client_id || null, existing.id])
    logActivity('synced', 'listing', existing.id, `Auto-synced from transaction → ${status}`)
    return existing.id
  }

  // Only create if status indicates the listing is live
  if (LIVE_STATUSES.has(status)) {
    const result = db.run(`INSERT INTO listings (
      property_address, mls_number, list_price, stage, status,
      seller_name, transaction_id, client_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [tx.property_address, tx.mls_number, tx.list_price, stage, status,
        tx.seller_name, tx.id, tx.client_id || null])
    logActivity('created', 'listing', result.lastInsertRowid, `Auto-created from transaction (${status}): ${tx.property_address}`)
    return result.lastInsertRowid
  }
  return null
}

// Auto-sync a transaction's closing into the hub's calendar. Creates a
// 'Closing' event when closing_date is set; updates when fields change;
// deletes when the transaction is closed/cancelled or the date is cleared.
// Linked via related_type='transaction', related_id=tx.id.
function syncClosingToCalendar(txId) {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
  if (!tx) return null

  const existing = db.get(
    "SELECT id FROM calendar_events WHERE related_type = 'transaction' AND related_id = ? AND event_type = 'Closing'",
    [tx.id])

  // Removal conditions: terminal status or no date → drop the calendar event
  const terminalStatuses = ['Closed', 'Cancelled', 'Withdrawn', 'Expired', 'Terminated Sale Contract']
  const isTerminal = terminalStatuses.includes(tx.property_status)
  if (!tx.closing_date || isTerminal) {
    if (existing) {
      db.run('DELETE FROM calendar_events WHERE id = ?', [existing.id])
      logActivity('removed', 'calendar_event', existing.id, `Closing event removed (${tx.property_address})`)
    }
    return null
  }

  // Normalize date to YYYY-MM-DD if it came in as M/D/YYYY (legacy)
  let event_date = tx.closing_date
  const m = String(tx.closing_date).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) event_date = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`

  const title = `Closing — ${tx.property_address || 'Property'}`
  const location = tx.closing_location || null
  const start_time = tx.closing_time || null
  const partiesLine = [tx.buyer_name && `Buyer: ${tx.buyer_name}`, tx.seller_name && `Seller: ${tx.seller_name}`]
    .filter(Boolean).join(' · ')
  const lenderLine = [tx.lender_name, tx.lender_company].filter(Boolean).join(' / ')
  const description = [
    partiesLine,
    lenderLine ? `Lender: ${lenderLine}` : '',
    tx.purchase_price ? `Price: $${Number(tx.purchase_price).toLocaleString()}` : '',
  ].filter(Boolean).join('\n')

  if (existing) {
    db.run(`UPDATE calendar_events SET
      title=?, event_date=?, start_time=?, location=?, description=?,
      updated_at=datetime('now')
      WHERE id=?`,
      [title, event_date, start_time, location, description, existing.id])
    return existing.id
  } else {
    const result = db.run(`INSERT INTO calendar_events (
      title, event_type, event_date, start_time, location, description,
      related_type, related_id, color
    ) VALUES (?, 'Closing', ?, ?, ?, ?, 'transaction', ?, 'green')`,
      [title, event_date, start_time, location, description, tx.id])
    logActivity('created', 'calendar_event', result.lastInsertRowid,
      `Closing event auto-added: ${tx.property_address} ${event_date}${start_time ? ' '+start_time : ''}`)
    return result.lastInsertRowid
  }
}

// Auto-sync a transaction's FINAL WALKTHROUGH into the hub's calendar.
// Same pattern as syncClosingToCalendar — separate event_type='Walkthrough'.
function syncWalkthroughToCalendar(txId) {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
  if (!tx) return null

  const existing = db.get(
    "SELECT id FROM calendar_events WHERE related_type = 'transaction' AND related_id = ? AND event_type = 'Walkthrough'",
    [tx.id])

  const terminalStatuses = ['Closed', 'Cancelled', 'Withdrawn', 'Expired', 'Terminated Sale Contract']
  const isTerminal = terminalStatuses.includes(tx.property_status)
  if (!tx.final_walkthrough || isTerminal) {
    if (existing) {
      db.run('DELETE FROM calendar_events WHERE id = ?', [existing.id])
      logActivity('removed', 'calendar_event', existing.id, `Walkthrough event removed (${tx.property_address})`)
    }
    return null
  }

  // Normalize M/D/YYYY → ISO
  let event_date = tx.final_walkthrough
  const m = String(tx.final_walkthrough).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) event_date = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`

  const title = `Final Walkthrough — ${tx.property_address || 'Property'}`
  const location = tx.final_walkthrough_location || null
  const start_time = tx.final_walkthrough_time || null
  const partiesLine = [tx.buyer_name && `Buyer: ${tx.buyer_name}`, tx.seller_name && `Seller: ${tx.seller_name}`]
    .filter(Boolean).join(' · ')
  const description = [
    partiesLine,
    tx.closing_date ? `Closing: ${tx.closing_date}${tx.closing_time ? ' at ' + tx.closing_time : ''}` : '',
  ].filter(Boolean).join('\n')

  if (existing) {
    db.run(`UPDATE calendar_events SET
      title=?, event_date=?, start_time=?, location=?, description=?,
      updated_at=datetime('now') WHERE id=?`,
      [title, event_date, start_time, location, description, existing.id])
    return existing.id
  } else {
    const result = db.run(`INSERT INTO calendar_events (
      title, event_type, event_date, start_time, location, description,
      related_type, related_id, color
    ) VALUES (?, 'Walkthrough', ?, ?, ?, ?, 'transaction', ?, 'purple')`,
      [title, event_date, start_time, location, description, tx.id])
    logActivity('created', 'calendar_event', result.lastInsertRowid,
      `Walkthrough event auto-added: ${tx.property_address} ${event_date}${start_time ? ' '+start_time : ''}`)
    return result.lastInsertRowid
  }
}

router.post('/', (req, res) => {
  const b = req.body
  const placeholders = FIELDS.map(() => '?').join(',')
  const values = FIELDS.map(f => n(b[f]))

  const result = db.run(`INSERT INTO transactions (${FIELDS.join(',')}) VALUES (${placeholders})`, values)
  const txId = result.lastInsertRowid
  logActivity('created', 'transaction', txId, `New ${b.type}: ${b.property_address}`)
  // Auto-sync into Listings tab if this is a listing-type transaction
  syncListingFromTransaction(txId)
  // Auto-sync closing into the hub calendar
  syncClosingToCalendar(txId)
  syncWalkthroughToCalendar(txId)
  // Auto-send closing invite to TEAM when date + time + location all set (idempotent via signature)
  // Fire-and-forget so the HTTP response isn't blocked on SendGrid latency
  maybeSendTeamClosingInvite(txId).catch(err => console.error('[closing-invite] async error:', err.message))
  maybeSendTeamWalkthroughInvite(txId).catch(err => console.error('[walkthrough-invite] async error:', err.message))
  res.status(201).json({ id: txId })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE transactions SET ${sets} WHERE id = ?`, values)
  const txId = Number(req.params.id)
  logActivity('updated', 'transaction', txId, 'Updated transaction')
  // Mirror the change into Listings tab (creates or updates the linked listing)
  syncListingFromTransaction(txId)
  // Sync/update closing event in calendar (handles add, update, AND removal on terminal status)
  syncClosingToCalendar(txId)
  syncWalkthroughToCalendar(txId)
  // Auto-fire team invite if closing time/location just got filled in (or changed)
  maybeSendTeamClosingInvite(txId).catch(err => console.error('[closing-invite] async error:', err.message))
  maybeSendTeamWalkthroughInvite(txId).catch(err => console.error('[walkthrough-invite] async error:', err.message))
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

    // Bulk mode: batch all the INSERTs/UPDATEs and saveDb ONCE at the end
    // instead of N times (writing 24 MB on every row). ~10-20× speedup.
    db.beginBulk?.()

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

    db.endBulk?.()  // flush all the writes as one disk save
    logActivity('synced', 'transaction', null, `Synced ${synced} transactions from Google Sheet${errors.length ? ` (${errors.length} errors)` : ''}`)
    res.json({ synced, errors })
  } catch (err) {
    db.endBulk?.()  // make sure we don't leave bulk mode on after an error
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

// =====================================================================
// Date normalization — converts legacy M/D/YYYY date strings (from the
// original Google Sheet sync) into ISO YYYY-MM-DD across every date
// column. Idempotent: rows already in ISO are skipped. Status-text values
// like "Completed and Sent" / "Pending" stay as-is.
// =====================================================================
router.post('/normalize-dates', (req, res) => {
  const dateColumns = [
    'contract_date', 'closing_date',
    'mortgage_contingency_date', 'appraisal_contingency_date', 'inspection_contingency_date',
    'financing_release', 'final_walkthrough', 'inspection_release', 'final_inspection_waiver',
    'earnest_money_due_date', 'ipi_due_date', 'inspection_date',
  ]
  const slashRe = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/

  const txs = db.all('SELECT * FROM transactions')
  let rowsTouched = 0
  let cellsConverted = 0
  const sample = []

  // Bulk mode: 17 transactions × 24 MB per save = 408 MB written without bulk.
  // With bulk, one write at the end.
  db.beginBulk?.()
  try {
    for (const tx of txs) {
      const updates = {}
      for (const col of dateColumns) {
        const v = tx[col]
        if (!v) continue
        const m = String(v).trim().match(slashRe)
        if (!m) continue  // already ISO or status-text — leave alone
        const iso = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`
        updates[col] = iso
        cellsConverted++
      }
      if (Object.keys(updates).length) {
        const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ')
        const vals = [...Object.values(updates), tx.id]
        db.run(`UPDATE transactions SET ${sets}, updated_at = datetime('now') WHERE id = ?`, vals)
        rowsTouched++
        if (sample.length < 5) sample.push({ id: tx.id, address: tx.property_address, changes: updates })
      }
    }
  } finally {
    db.endBulk?.()
  }

  logActivity('normalize_dates', 'transaction', 0,
    `Converted ${cellsConverted} cells across ${rowsTouched} transactions to ISO format`)

  res.json({ rowsTouched, cellsConverted, sample, totalScanned: txs.length })
})

// =====================================================================
// Closing invite — emails an iCalendar (.ics) attachment to chosen
// recipients. They can add it to Google / Outlook / Apple calendar.
// Body: { recipients: ['email1', 'email2', ...], message?: 'optional note' }
// Returns 400 if the transaction lacks date/time/location.
// =====================================================================

function escapeIcs(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n')
}

function buildIcs({ uid, title, dtStartUtc, dtEndUtc, location, description, organizerEmail, organizerName, attendees }) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Matt Smith Team//Hub Closing Invite//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z`,
    `DTSTART:${dtStartUtc}`,
    `DTEND:${dtEndUtc}`,
    `SUMMARY:${escapeIcs(title)}`,
    `LOCATION:${escapeIcs(location)}`,
    `DESCRIPTION:${escapeIcs(description)}`,
    `ORGANIZER;CN=${escapeIcs(organizerName)}:mailto:${organizerEmail}`,
    ...(attendees || []).map(a =>
      `ATTENDEE;RSVP=TRUE;CN=${escapeIcs(a)};PARTSTAT=NEEDS-ACTION:mailto:${a}`),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n')
}

// Convert "10:00 AM CDT" / "10:00 AM" / "14:00" + a YYYY-MM-DD date into a UTC ICS timestamp.
// Defaults to 10:00 AM America/Chicago if no time is parseable.
function buildClosingTimes(eventDate, timeStr) {
  // Parse the date as local Chicago date; default to 10am if no time
  const dateM = String(eventDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!dateM) return null
  const [, y, mo, d] = dateM
  let hour = 10
  let minute = 0
  const tm = String(timeStr || '').match(/(\d{1,2})\s*:?\s*(\d{2})?\s*(am|pm)?/i)
  if (tm) {
    hour = Number(tm[1])
    minute = Number(tm[2] || 0)
    const ampm = (tm[3] || '').toLowerCase()
    if (ampm === 'pm' && hour < 12) hour += 12
    if (ampm === 'am' && hour === 12) hour = 0
  }
  // Build a Date as if "America/Chicago" — DST-aware via formatToParts inverse trick
  // Simpler: assume CDT (UTC-5) Mar-Nov, CST (UTC-6) Nov-Mar. Determine which by checking
  // what en-US "America/Chicago" reports for the given date's tz offset.
  const probe = new Date(Date.UTC(Number(y), Number(mo)-1, Number(d), 12, 0, 0))
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' })
  const tzShort = fmt.formatToParts(probe).find(p => p.type === 'timeZoneName')?.value || 'CDT'
  const offsetHours = tzShort === 'CST' ? 6 : 5  // hours behind UTC
  // Start in UTC
  const startUtc = new Date(Date.UTC(Number(y), Number(mo)-1, Number(d), hour + offsetHours, minute, 0))
  const endUtc = new Date(startUtc.getTime() + 60 * 60 * 1000)  // 1-hour block
  const toIcs = (dt) => dt.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z'
  return { dtStartUtc: toIcs(startUtc), dtEndUtc: toIcs(endUtc) }
}

// Hard-coded team recipients (override via TEAM_CLOSING_INVITE_RECIPIENTS env var, comma-separated)
const TEAM_CLOSING_RECIPIENTS = (process.env.TEAM_CLOSING_INVITE_RECIPIENTS ||
  'johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean)

// Build + send a closing invite. Reusable from both the HTTP endpoint and
// the auto-send trigger. Throws on failure (caller decides logging).
async function sendClosingInvite(tx, recipients, opts = {}) {
  if (!tx.closing_date) throw new Error('Closing Date required')
  if (!recipients.length) throw new Error('recipients required')
  const { sendViaSendGrid } = await import('./email.js')

  // Normalize date if M/D/YYYY
  let eventDate = tx.closing_date
  const m = String(eventDate).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) eventDate = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`

  const times = buildClosingTimes(eventDate, tx.closing_time)
  if (!times) throw new Error('invalid closing_date format')

  const title = `Closing — ${tx.property_address || 'Property'}`
  const location = tx.closing_location || 'TBD'
  const parties = [tx.buyer_name && `Buyer: ${tx.buyer_name}`, tx.seller_name && `Seller: ${tx.seller_name}`]
    .filter(Boolean).join('\n')
  const lender = [tx.lender_name, tx.lender_company].filter(Boolean).join(' / ')
  const description = [
    parties,
    lender ? `Lender: ${lender}` : '',
    tx.purchase_price ? `Price: $${Number(tx.purchase_price).toLocaleString()}` : '',
    opts.message ? `\nNote: ${opts.message}` : '',
  ].filter(Boolean).join('\n')

  const organizerEmail = process.env.SENDGRID_FROM_EMAIL || 'matt@mattsmithteam.com'
  const ics = buildIcs({
    uid: `closing-${tx.id}-${Date.now()}@mattsmithteam`,
    title,
    dtStartUtc: times.dtStartUtc,
    dtEndUtc: times.dtEndUtc,
    location,
    description,
    organizerEmail,
    organizerName: 'Matt Smith Team',
    attendees: recipients,
  })

  const audienceLabel = opts.audience ? ` (${opts.audience})` : ''
  const subject = `📅 Closing — ${tx.property_address || 'Property'} (${eventDate}${tx.closing_time ? ' '+tx.closing_time : ''})${audienceLabel}`
  const htmlBody = `
<p>${opts.audience === 'team' ? `<strong>Team auto-notification:</strong> closing time + location have been set for <strong>${tx.property_address || 'a property'}</strong>.` : `You're invited to the closing of <strong>${tx.property_address || 'a property'}</strong>.`}</p>
<ul>
  <li><strong>Date:</strong> ${eventDate}</li>
  ${tx.closing_time ? `<li><strong>Time:</strong> ${tx.closing_time}</li>` : ''}
  <li><strong>Location:</strong> ${location}</li>
  ${parties ? `<li><strong>Parties:</strong> ${parties.replace(/\n/g, ' · ')}</li>` : ''}
  ${lender ? `<li><strong>Lender:</strong> ${lender}</li>` : ''}
</ul>
${opts.message ? `<p>${String(opts.message).replace(/</g,'&lt;')}</p>` : ''}
<p>The attached <code>.ics</code> file will add this to your calendar automatically.</p>
<p>— Matt Smith Team</p>`

  await sendViaSendGrid(
    recipients,
    '',
    subject,
    htmlBody,
    undefined,
    [],
    [{
      filename: 'closing.ics',
      content: Buffer.from(ics, 'utf-8').toString('base64'),
      type: 'text/calendar; method=REQUEST',
    }]
  )

  return { recipients, eventDate, time: tx.closing_time, location }
}

// Auto-fire the team closing invite when closing_date + closing_time +
// closing_location are all set, but only when those fields CHANGE since
// the last send (tracked via closing_invite_signature). Won't spam.
async function maybeSendTeamClosingInvite(txId) {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
  if (!tx) return null
  if (!tx.closing_date || !tx.closing_time || !tx.closing_location) return null

  const sig = `${tx.closing_date}|${tx.closing_time}|${tx.closing_location}`
  if (tx.closing_invite_signature === sig) return null  // unchanged, skip

  try {
    const result = await sendClosingInvite(tx, TEAM_CLOSING_RECIPIENTS, { audience: 'team' })
    const sentAt = new Date().toISOString()
    db.run(`UPDATE transactions SET closing_invite_signature = ?, closing_invite_sent_at = ?, updated_at = datetime('now') WHERE id = ?`,
      [sig, sentAt, tx.id])
    logActivity('team_invite', 'transaction', tx.id,
      `Team auto-invite sent to ${result.recipients.length} (${tx.property_address})`)
    return { sent: true, ...result, sentAt }
  } catch (err) {
    console.error('[closing-invite] team auto-send failed:', err.message)
    logActivity('team_invite_failed', 'transaction', tx.id, `Team auto-invite FAILED: ${err.message}`)
    return { sent: false, error: err.message }
  }
}

// =====================================================================
// FINAL WALKTHROUGH invite — parallel to closing invite. Builds .ics
// from final_walkthrough date/time + final_walkthrough_location and
// emails it to chosen recipients (team auto / Buyer / Seller / Other).
// =====================================================================

async function sendWalkthroughInvite(tx, recipients, opts = {}) {
  if (!tx.final_walkthrough) throw new Error('Final Walkthrough date required')
  if (!recipients.length) throw new Error('recipients required')
  const { sendViaSendGrid } = await import('./email.js')

  let eventDate = tx.final_walkthrough
  const m = String(eventDate).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) eventDate = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`

  const times = buildClosingTimes(eventDate, tx.final_walkthrough_time)
  if (!times) throw new Error('invalid final_walkthrough date format')

  const title = `Final Walkthrough — ${tx.property_address || 'Property'}`
  const location = tx.final_walkthrough_location || tx.property_address || 'TBD'
  const parties = [tx.buyer_name && `Buyer: ${tx.buyer_name}`, tx.seller_name && `Seller: ${tx.seller_name}`]
    .filter(Boolean).join('\n')
  const description = [
    parties,
    tx.closing_date ? `Closing scheduled: ${tx.closing_date}${tx.closing_time ? ' at ' + tx.closing_time : ''}` : '',
    opts.message ? `\nNote: ${opts.message}` : '',
  ].filter(Boolean).join('\n')

  const organizerEmail = process.env.SENDGRID_FROM_EMAIL || 'matt@mattsmithteam.com'
  const ics = buildIcs({
    uid: `walkthrough-${tx.id}-${Date.now()}@mattsmithteam`,
    title,
    dtStartUtc: times.dtStartUtc,
    dtEndUtc: times.dtEndUtc,
    location,
    description,
    organizerEmail,
    organizerName: 'Matt Smith Team',
    attendees: recipients,
  })

  const audienceLabel = opts.audience ? ` (${opts.audience})` : ''
  const subject = `🚶 Final Walkthrough — ${tx.property_address || 'Property'} (${eventDate}${tx.final_walkthrough_time ? ' '+tx.final_walkthrough_time : ''})${audienceLabel}`
  const htmlBody = `
<p>${opts.audience === 'team' ? `<strong>Team auto-notification:</strong> final walkthrough scheduled for <strong>${tx.property_address || 'a property'}</strong>.` : `You're invited to the final walkthrough of <strong>${tx.property_address || 'a property'}</strong>.`}</p>
<ul>
  <li><strong>Date:</strong> ${eventDate}</li>
  ${tx.final_walkthrough_time ? `<li><strong>Time:</strong> ${tx.final_walkthrough_time}</li>` : ''}
  <li><strong>Location:</strong> ${location}</li>
  ${parties ? `<li><strong>Parties:</strong> ${parties.replace(/\n/g, ' · ')}</li>` : ''}
  ${tx.closing_date ? `<li><strong>Closing follows:</strong> ${tx.closing_date}${tx.closing_time ? ' at ' + tx.closing_time : ''}</li>` : ''}
</ul>
${opts.message ? `<p>${String(opts.message).replace(/</g,'&lt;')}</p>` : ''}
<p>The attached <code>.ics</code> file will add this to your calendar automatically.</p>
<p>— Matt Smith Team</p>`

  await sendViaSendGrid(
    recipients, '', subject, htmlBody, undefined, [],
    [{ filename: 'walkthrough.ics', content: Buffer.from(ics, 'utf-8').toString('base64'), type: 'text/calendar; method=REQUEST' }]
  )

  return { recipients, eventDate, time: tx.final_walkthrough_time, location }
}

async function maybeSendTeamWalkthroughInvite(txId) {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
  if (!tx) return null
  if (!tx.final_walkthrough || !tx.final_walkthrough_time || !tx.final_walkthrough_location) return null
  const sig = `${tx.final_walkthrough}|${tx.final_walkthrough_time}|${tx.final_walkthrough_location}`
  if (tx.final_walkthrough_invite_signature === sig) return null

  try {
    const result = await sendWalkthroughInvite(tx, TEAM_CLOSING_RECIPIENTS, { audience: 'team' })
    const sentAt = new Date().toISOString()
    db.run(`UPDATE transactions SET final_walkthrough_invite_signature = ?, final_walkthrough_invite_sent_at = ?, updated_at = datetime('now') WHERE id = ?`,
      [sig, sentAt, tx.id])
    logActivity('team_walkthrough_invite', 'transaction', tx.id,
      `Team walkthrough auto-invite sent to ${result.recipients.length} (${tx.property_address})`)
    return { sent: true, ...result, sentAt }
  } catch (err) {
    console.error('[walkthrough-invite] team auto-send failed:', err.message)
    logActivity('team_walkthrough_invite_failed', 'transaction', tx.id, `Team walkthrough auto-invite FAILED: ${err.message}`)
    return { sent: false, error: err.message }
  }
}

router.post('/:id/send-walkthrough-invite', async (req, res) => {
  const id = Number(req.params.id)
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [id])
  if (!tx) return res.status(404).json({ error: 'transaction not found' })
  if (!tx.final_walkthrough) return res.status(400).json({ error: 'Set Final Walkthrough date before sending invite' })

  const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients
    : String(req.body?.recipients || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
  if (!recipients.length) return res.status(400).json({ error: 'recipients required' })

  try {
    const audience = req.body?.audience || 'recipients'
    const result = await sendWalkthroughInvite(tx, recipients, { audience, message: req.body?.message })
    logActivity('walkthrough_invite_sent', 'transaction', tx.id,
      `Walkthrough invite sent to ${audience}: ${recipients.join(', ')}`)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/:id/send-closing-invite', async (req, res) => {
  const id = Number(req.params.id)
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [id])
  if (!tx) return res.status(404).json({ error: 'transaction not found' })

  if (!tx.closing_date) {
    return res.status(400).json({ error: 'Set Closing Date before sending invite' })
  }

  const recipients = Array.isArray(req.body?.recipients) ? req.body.recipients
    : String(req.body?.recipients || '').split(/[,;\n]+/).map(s => s.trim()).filter(Boolean)
  if (!recipients.length) return res.status(400).json({ error: 'recipients required' })

  try {
    const audience = req.body?.audience || 'recipients'
    const result = await sendClosingInvite(tx, recipients, {
      audience,
      message: req.body?.message,
    })
    logActivity('invite_sent', 'transaction', tx.id,
      `Closing invite sent to ${audience}: ${recipients.join(', ')}`)
    res.json({ success: true, ...result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
