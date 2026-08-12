import express, { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import db from '../database.js'
import { addBusinessDays } from '../business-days.js'

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
  'has_insurance_contingency', 'has_home_warranty', 'home_warranty_paid_by',
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
  'financing_status',
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

// Normalize address for fuzzy match against pre-listings (handles "Bever Ln SE"
// vs "bever lane se", missing commas, etc.)
function normalizeAddr(s) {
  if (!s) return ''
  return String(s)
    .toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ')
    .replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
    .replace(/\blane\b/g, 'ln').replace(/\bdrive\b/g, 'dr')
    .replace(/\bcourt\b/g, 'ct').replace(/\broad\b/g, 'rd')
    .replace(/\bboulevard\b/g, 'blvd').replace(/\bcircle\b/g, 'cir')
    .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
    .replace(/\bnortheast\b/g, 'ne').replace(/\bnorthwest\b/g, 'nw')
    .replace(/\bsoutheast\b/g, 'se').replace(/\bsouthwest\b/g, 'sw')
    .trim()
}

// When a transaction is created/updated to an active status, mark any
// pre-listing with a matching address as 'Listed' so it stops appearing in
// the Pre-Listings tab. Handles fuzzy address matches.
function markMatchingPreListingsAsListed(txId) {
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
  if (!tx || !tx.property_address) return
  if (!LIVE_STATUSES.has(tx.property_status)) return  // only "live" transactions trigger this
  const target = normalizeAddr(tx.property_address)
  const pls = db.all("SELECT id, property_address, status FROM pre_listings WHERE status NOT IN ('Listed','Withdrawn','Cancelled')")
  for (const pl of pls) {
    if (normalizeAddr(pl.property_address) === target) {
      db.run("UPDATE pre_listings SET status = 'Listed', updated_at = datetime('now') WHERE id = ?", [pl.id])
      logActivity('auto_listed', 'pre_listing', pl.id, `Auto-marked Listed (matching transaction ${tx.id})`)
    }
  }
}

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

// Auto-create/maintain tracking tasks for a transaction's key deadlines
// (Earnest, Home Inspection, Financing contingency, Final Walkthrough, Closing).
// Titled "<Deadline> — <address>", deduped by (related_type, related_id, category),
// due date kept in sync, auto-marked done when the matching status is terminal.
const DEADLINE_TASK_SPECS = [
  { label: 'Earnest Money',               dateField: 'earnest_money_due_date',      statusField: 'earnest_money_deposit', terminal: ['Completed'], windowDays: 3 },
  { label: 'Home Inspection',             dateField: 'inspection_contingency_date', statusField: 'home_inspection',       terminal: ['Completed', 'Waived', 'N/A', 'Not Applicable'], windowDays: 3 },
  { label: 'Financing Contingency Release', dateField: 'mortgage_contingency_date', statusField: 'financing_status',      terminal: ['Approved'], windowDays: 3 },
  { label: 'Closing',                     dateField: 'closing_date',                statusField: null,                    terminal: [], windowDays: 3 },
  // Walkthrough sign-off is a POST-walkthrough form — track it only day-of (not before)
  // Day-of walkthrough sign-off — appears ON the final walkthrough day
  { label: 'Final Walkthrough Signed',    dateField: 'final_walkthrough',           statusField: null,                    terminal: [], windowDays: 0,
    title: (addr) => `Final Walkthrough signed by buyers at ${addr}` },
]
export function syncTransactionDeadlineTasks(txId) {
  try {
    const tx = db.get('SELECT * FROM transactions WHERE id = ?', [txId])
    if (!tx || !tx.property_address) return
    const isActiveDeal = ['Under Contract', 'Pending', 'Clear to Close'].includes(tx.property_status)
    for (const spec of DEADLINE_TASK_SPECS) {
      const date = tx[spec.dateField]
      const existing = db.get(
        "SELECT id, status FROM tasks WHERE related_type = 'transaction_deadline' AND related_id = ? AND category = ?",
        [txId, spec.label])
      const isDone = spec.statusField && spec.terminal.includes(tx[spec.statusField])
      if (!isActiveDeal || !date) continue  // only track live deals with a date set
      const title = spec.title ? spec.title(tx.property_address) : `${spec.label} — ${tx.property_address}`
      if (existing) {
        const status = isDone ? 'done' : (existing.status === 'done' ? 'todo' : existing.status)
        db.run("UPDATE tasks SET title = ?, due_date = ?, status = ?, updated_at = datetime('now') WHERE id = ?",
          [title, date, status, existing.id])
        db.run(isDone
          ? "UPDATE tasks SET completed_at = COALESCE(completed_at, datetime('now')) WHERE id = ?"
          : "UPDATE tasks SET completed_at = NULL WHERE id = ?", [existing.id])
      } else if (!isDone) {
        // Only surface the task once the deadline is within its window (3 days
        // for most; 0 = day-of for the walkthrough sign-off). Keeps Tasks clean.
        const du = daysUntilDate(date)
        const windowDays = spec.windowDays ?? 3
        if (du !== null && du <= windowDays) {
          db.run("INSERT INTO tasks (title, priority, status, due_date, category, related_type, related_id) VALUES (?,?,?,?,?,?,?)",
            [title, 'high', 'todo', date, spec.label, 'transaction_deadline', txId])
        }
      }
    }
  } catch (e) {
    console.error('[transactions] syncTransactionDeadlineTasks failed:', e.message)
  }
}

// Whole-day count from today to a YYYY-MM-DD date (negative = past).
function daysUntilDate(dateStr) {
  if (!dateStr) return null
  const p = String(dateStr).slice(0, 10).split('-').map(Number)
  if (p.length !== 3 || p.some(isNaN)) return null
  const d = new Date(p[0], p[1] - 1, p[2])
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((d - today) / 86400000)
}

// Run the deadline-task sync across every active transaction. Called on a timer
// so a task appears the day its deadline enters the 3-day window, even without
// anyone editing the transaction. Idempotent (dedupes + updates).
export function syncAllActiveTransactionDeadlineTasks() {
  try {
    const rows = db.all("SELECT id FROM transactions WHERE property_status IN ('Under Contract','Pending','Clear to Close')")
    for (const r of rows) syncTransactionDeadlineTasks(r.id)
    return rows.length
  } catch (e) {
    console.error('[transactions] syncAllActiveTransactionDeadlineTasks failed:', e.message)
    return 0
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
  markMatchingPreListingsAsListed(txId)
  // Auto-sync closing into the hub calendar
  syncClosingToCalendar(txId)
  syncWalkthroughToCalendar(txId)
  syncTransactionDeadlineTasks(txId)
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
  // Once a listing reaches Under Contract (or beyond), the pre-listing/active
  // marketing push is done — clear its marketing checklist automatically,
  // unless the caller explicitly set marketing_tasks in this same update.
  if (fields.property_status &&
      ['Under Contract', 'Pending', 'Clear to Close', 'Closed'].includes(fields.property_status) &&
      !('marketing_tasks' in fields)) {
    db.run("UPDATE transactions SET marketing_tasks = '{}' WHERE id = ?", [txId])
  }
  logActivity('updated', 'transaction', txId, 'Updated transaction')
  // Mirror the change into Listings tab (creates or updates the linked listing)
  syncListingFromTransaction(txId)
  markMatchingPreListingsAsListed(txId)
  // Sync/update closing event in calendar (handles add, update, AND removal on terminal status)
  syncClosingToCalendar(txId)
  syncWalkthroughToCalendar(txId)
  syncTransactionDeadlineTasks(txId)
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
// DISABLED 2026-05-14. This was only used by 'Clear & Re-sync' (which is
// also disabled). Wiping all transactions is too destructive to keep
// reachable without a paired safe-restore flow.
router.post('/clear-all', (req, res) => {
  res.status(410).json({
    error: 'Endpoint disabled. Use the per-transaction Delete button to remove individual rows.',
    disabled_at: '2026-05-14',
  })
})

// DISABLED 2026-05-14. The hub is the master file for transactions; we do not
// pull from the Google Sheet anymore. Repeated re-imports were creating
// duplicates (the sheet has multiple address variants for the same property
// and the dedup couldn't match them all). Per user direction.
router.post('/sync-sheet', (req, res) => {
  res.status(410).json({
    error: 'Google Sheet sync is disabled. The hub is the master file for transactions.',
    disabled_at: '2026-05-14',
  })
})

// Keep the original implementation around behind a guard so we don't lose the
// code if the user ever wants to re-enable it.
// eslint-disable-next-line no-unused-vars
async function _disabled_syncTransactionsFromSheet(req, res) {
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
}  // end _disabled_syncTransactionsFromSheet

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
  "mortgage_contingency_date": string (YYYY-MM-DD — ONLY if the contract gives an explicit calendar date; otherwise leave blank and use financing_business_days),
  "appraisal_contingency_date": string (YYYY-MM-DD — ONLY if an explicit calendar date; otherwise leave blank and use appraisal_business_days),
  "inspection_contingency_date": string (YYYY-MM-DD — ONLY if an explicit calendar date; otherwise leave blank and use inspection_business_days),
  "inspection_business_days": number (the inspection contingency period in BUSINESS days as written, e.g. 10 — null if the contract instead gives an explicit date),
  "financing_business_days": number (the loan/financing contingency period in business days — null if not written as a period),
  "appraisal_business_days": number (the appraisal contingency period in business days — null if not written as a period),
  "type_of_finance": string (one of: "Conventional", "FHA", "VA", "USDA", "Cash", "Other"),
  "lender_name": string (the loan officer / lender contact PERSON's name),
  "lender_company": string (the mortgage/lending COMPANY name),
  "has_insurance_contingency": number (1 if the contract includes an insurance/hazard-insurance contingency, 0 if it is waived/none),
  "home_warranty_paid_by": string (one of: "seller", "buyer", "none" — who pays for the 1-year home warranty; "none" if no warranty is included),
  "earnest_money_deposit": string (just the dollar amount as a string, e.g. "$2,500", or "Not Started" if not yet collected),
  "whole_property_inspection": number (1 if mentioned, 0 if not),
  "radon_test": number (1 if radon test is mentioned/required, 0 if not),
  "wdi_inspection": number (1 if Wood Destroying Insect / termite inspection mentioned, 0 if not),
  "septic_inspection": number (1 if septic inspection mentioned, 0 if not),
  "well_inspection": number (1 if well inspection mentioned, 0 if not),
  "sewer_inspection": number (1 if sewer/lateral inspection mentioned, 0 if not),
  "notes": string (any unusual terms, contingencies, or seller concessions worth flagging)
}

This is MOST OFTEN a CRAAR (Cedar Rapids Area Association of Realtors) purchase agreement, whose lines are numbered. On a CRAAR form, use these anchors:
- Line 25: Lender / loan-officer name and the lending company -> lender_name (the person) and lender_company (the company).
- Line 53: the INSURANCE box/checkbox -> has_insurance_contingency (1 if an insurance contingency box is checked/applies, 0 if it is marked waived/none).
- Line 132: the HOME WARRANTY section with checkboxes for who pays -> home_warranty_paid_by = "seller", "buyer", or "none" (if the "no warranty" option is selected or none is checked).
If the document is NOT a CRAAR form (different layout, no matching line numbers), do NOT rely on line numbers — read the FULL document and find the insurance contingency, the home-warranty payer, and the lender/lender-company by meaning. If you cannot determine one of these with confidence, omit that key.

Rules:
- Contingency periods: when a contingency is written as a number of days from acceptance (e.g. "within 10 business days of acceptance"), put that NUMBER in the matching *_business_days field and leave the corresponding *_contingency_date blank. Do NOT compute the deadline date yourself — the system computes it (skipping weekends and federal holidays, not counting the acceptance date). Only fill a *_contingency_date when the contract states an explicit calendar date.
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
    // Compute contingency deadlines from the business-day periods the AI read
    // (deterministic here — skips weekends + federal holidays, acceptance date
    // not counted). Falls back to the transaction's existing contract date.
    const acceptance = data.contract_date || db.get('SELECT contract_date FROM transactions WHERE id = ?', [id])?.contract_date
    if (acceptance) {
      if (data.inspection_business_days) data.inspection_contingency_date = addBusinessDays(acceptance, data.inspection_business_days)
      if (data.financing_business_days) data.mortgage_contingency_date = addBusinessDays(acceptance, data.financing_business_days)
      if (data.appraisal_business_days) data.appraisal_contingency_date = addBusinessDays(acceptance, data.appraisal_business_days)
    }

    // Home warranty: the on/off flag is derived from who pays (line 132).
    if (data.home_warranty_paid_by) {
      data.home_warranty_paid_by = String(data.home_warranty_paid_by).toLowerCase()
      data.has_home_warranty = data.home_warranty_paid_by === 'none' ? 0 : 1
    }

    // Financing rules. Prefer the freshly-read finance type, else the existing row.
    const finance = (data.type_of_finance || db.get('SELECT type_of_finance FROM transactions WHERE id = ?', [id])?.type_of_finance || '').toLowerCase()
    if (finance === 'cash') {
      // Cash deal: no loan, so no mortgage/financing contingency and no appraisal.
      // Force-clear both (applyExtracted skips empty values, so clear directly below).
      data.mortgage_contingency_date = ''
      data.appraisal_contingency_date = ''
      db.run("UPDATE transactions SET mortgage_contingency_date = NULL, appraisal_contingency_date = NULL, updated_at = datetime('now') WHERE id = ?", [id])
    } else {
      // Default: appraisal contingency date mirrors the mortgage/financing
      // contingency date unless the contract stated an explicit appraisal date.
      const mortgage = data.mortgage_contingency_date
      if (mortgage && !data.appraisal_contingency_date) data.appraisal_contingency_date = mortgage
    }
    // A purchase agreement is uploaded for BOTH sides (we upload every PA just to
    // capture the contract details). The document does NOT tell us who we
    // represent — that's set by how the deal was created (an active listing that
    // goes under contract stays a listing / seller side). So never let the
    // extraction change `type` or `agency_type`; only fill the factual fields.
    delete data.type
    delete data.agency_type
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
// PEOPLE ON A TRANSACTION — multiple leads/clients per deal (e.g. two family
// members buying together). Additive; the transaction's primary client_id is
// untouched. Each person can be a linked CRM client or a free-text name.
// =====================================================================
const PERSON_ROLES = ['buyer', 'co-buyer', 'seller', 'co-seller', 'other']

router.get('/:id/people', (req, res) => {
  const id = Number(req.params.id)
  // Join clients so we can surface current email/phone even if the name changed.
  const rows = db.all(`SELECT tp.id, tp.transaction_id, tp.client_id, tp.role,
      COALESCE(tp.name, TRIM(c.first_name || ' ' || COALESCE(c.last_name, ''))) AS name,
      c.email, c.phone, c.lead_score
    FROM transaction_people tp
    LEFT JOIN clients c ON c.id = tp.client_id
    WHERE tp.transaction_id = ? ORDER BY tp.id ASC`, [id])
  res.json(rows)
})

router.post('/:id/people', (req, res) => {
  const id = Number(req.params.id)
  if (!db.get('SELECT id FROM transactions WHERE id = ?', [id])) return res.status(404).json({ error: 'Transaction not found' })
  const { client_id, name, role } = req.body || {}
  const r = (PERSON_ROLES.includes(role) ? role : 'buyer')
  let nm = name && String(name).trim()
  if (!nm && client_id) {
    const c = db.get('SELECT first_name, last_name FROM clients WHERE id = ?', [Number(client_id)])
    if (c) nm = `${c.first_name || ''} ${c.last_name || ''}`.trim()
  }
  if (!nm && !client_id) return res.status(400).json({ error: 'Provide a client or a name' })
  // Don't add the same client twice.
  if (client_id && db.get('SELECT id FROM transaction_people WHERE transaction_id = ? AND client_id = ?', [id, Number(client_id)])) {
    return res.status(200).json({ duplicate: true })
  }
  const result = db.run('INSERT INTO transaction_people (transaction_id, client_id, name, role) VALUES (?,?,?,?)',
    [id, client_id ? Number(client_id) : null, nm || null, r])
  logActivity('added_person', 'transaction', id, `Added ${nm || 'person'} (${r}) to transaction`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.delete('/:id/people/:pid', (req, res) => {
  db.run('DELETE FROM transaction_people WHERE id = ? AND transaction_id = ?', [Number(req.params.pid), Number(req.params.id)])
  res.json({ success: true })
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
