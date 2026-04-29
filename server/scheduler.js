// Background scheduler - auto-syncs data without user clicks
import db from './database.js'

const SIERRA_API_KEY = process.env.SIERRA_API_KEY || 'b97e3302-1985-46a4-9032-cb92e5cb3dd8'
const SIERRA_API_URL = 'https://api.sierrainteractivedev.com'
const n = (v) => v === undefined || v === '' ? null : v

async function sierraGet(endpoint, params = {}) {
  const url = new URL(`${SIERRA_API_URL}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const resp = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json', 'Sierra-ApiKey': SIERRA_API_KEY }
  })
  if (!resp.ok) throw new Error(`Sierra API ${resp.status}`)
  return resp.json()
}

function mapStatus(sierraStatus) {
  if (!sierraStatus) return 'active'
  return sierraStatus.toLowerCase().replace(/\s+/g, '_')
}

// Extract Realist score - prefer specific number from shortSummary, fall back to tag range
function extractRealistScore(lead) {
  const summary = lead.shortSummary || ''
  const m1 = summary.match(/realist\s*score\s*[:=]?\s*(\d{1,4})/i)
  if (m1) return m1[1]
  const tags = lead.tags || []
  for (const t of tags) {
    const tagStr = typeof t === 'string' ? t : (t.name || t.tag || '')
    const m = tagStr.match(/realist\s*score\s*(.+)/i)
    if (m) return m[1].trim()
  }
  return null
}

function gradeFromRealistScore(scoreStr) {
  if (!scoreStr) return null
  const n = parseInt(scoreStr, 10)
  if (!isNaN(n)) {
    if (n >= 800) return 'A+'
    if (n >= 700) return 'A'
    if (n >= 650) return 'B'
    if (n >= 600) return 'C'
    if (n >= 500) return 'D'
    return 'F'
  }
  if (scoreStr.includes('800')) return 'A+'
  if (scoreStr.includes('700')) return 'A'
  if (scoreStr.includes('650')) return 'B'
  if (scoreStr.includes('600')) return 'C'
  if (scoreStr.includes('500')) return 'D'
  return 'F'
}

function processLead(lead) {
  const sierraId = String(lead.id)
  const firstName = lead.firstName || ''
  const lastName = lead.lastName || ''
  if (!firstName && !lastName) return null

  const email = n(lead.email)
  const phone = n(lead.phone)
  const source = n(lead.source)
  const address = n(lead.streetAddress || lead.address)
  const city = n(lead.city)
  const state = n(lead.state) || 'IA'
  const zip = n(lead.zip || lead.postalCode)
  const clientStatus = mapStatus(lead.leadStatus)

  let type = 'buyer'
  const leadType = (lead.leadType || '').toLowerCase()
  if (leadType === 'seller') type = 'seller'
  else if (leadType === 'both' || leadType === 'buyer/seller') type = 'both'

  let agentAssigned = null
  if (lead.assignedTo && lead.assignedTo.agentUserFirstName) {
    agentAssigned = `${lead.assignedTo.agentUserFirstName} ${lead.assignedTo.agentUserLastName}`.trim()
  }

  let budgetMin = null, budgetMax = null
  const searches = lead.savedSearchesModel?.savedSearches || lead.savedSearches || []
  if (searches.length > 0) {
    const search = searches[0]
    if (search.price) {
      budgetMin = search.price.min || null
      budgetMax = search.price.max || null
    }
  }

  const leadScore = extractRealistScore(lead)
  const leadGrade = gradeFromRealistScore(leadScore)

  const existing = db.get('SELECT id FROM clients WHERE sierra_lead_id = ?', [sierraId])
  if (existing) {
    db.run(`UPDATE clients SET first_name=?, last_name=?, email=?, phone=?,
      source=?, address=?, city=?, state=?, zip=?, type=?,
      budget_min=?, budget_max=?, agent_assigned=?, status=?,
      lead_score=?, lead_grade=?,
      updated_at=datetime('now') WHERE id=?`,
      [firstName, lastName, email, phone, source, address, city, state, zip,
        type, budgetMin, budgetMax, agentAssigned, clientStatus,
        leadScore, leadGrade, existing.id])
    return 'updated'
  } else {
    db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
      source, agent_assigned, address, city, state, zip, budget_min, budget_max,
      sierra_lead_id, lead_score, lead_grade)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firstName, lastName, email, phone, type, clientStatus, source,
        agentAssigned, address, city, state, zip, budgetMin, budgetMax,
        sierraId, leadScore, leadGrade])
    return 'added'
  }
}

// Incremental Sierra sync - only leads that changed since last sync
async function syncSierraIncremental() {
  try {
    // Get last sync time
    const last = db.get("SELECT synced_at FROM sierra_sync_log WHERE sync_type = 'incremental' ORDER BY synced_at DESC LIMIT 1")
    const since = last ? last.synced_at : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const sinceFormatted = since.replace(' ', 'T').split('.')[0]

    let added = 0, updated = 0, total = 0
    let page = 1
    let hasMore = true

    while (hasMore) {
      const result = await sierraGet('/leads/find', {
        leadUpdateDateFrom: sinceFormatted,
        includeSavedSearches: 'true',
        pageSize: 100,
        pageNumber: page,
      })

      const responseData = result.data || result
      const leads = responseData.leads || []
      if (!leads.length) break

      for (const lead of leads) {
        const r = processLead(lead)
        if (r === 'added') added++
        else if (r === 'updated') updated++
        if (r) total++
      }

      const totalPages = responseData.totalPages || 1
      if (page >= totalPages) hasMore = false
      else page++
      if (page > 50) break // safety: max 5000 leads per incremental sync
    }

    db.run('INSERT INTO sierra_sync_log (sync_type, leads_synced, leads_added, leads_updated) VALUES (?,?,?,?)',
      ['incremental', total, added, updated])

    if (total > 0) {
      console.log(`[scheduler] Sierra incremental: ${total} leads (${added} new, ${updated} updated)`)
    }
  } catch (err) {
    console.error('[scheduler] Sierra sync error:', err.message)
  }
}

// Auto-sync Google Sheet for transactions
async function syncGoogleSheet() {
  try {
    const sheetUrl = 'https://docs.google.com/spreadsheets/d/1628DMNtqi5_hcS4e62RTjtHjwp5i8qk4wIloFO15dug/gviz/tq?tqx=out:csv&sheet=Transaction%202026'
    const resp = await fetch(sheetUrl)
    const csv = await resp.text()
    const rows = parseCSV(csv)
    if (rows.length < 2) return

    let count = 0
    for (let i = 1; i < rows.length; i++) {
      const cols = rows[i]
      if (!cols[0]) continue
      const existing = db.get('SELECT id FROM transactions WHERE property_address = ?', [cols[0]])
      if (existing) {
        db.run(`UPDATE transactions SET property_status=?, purchase_price=?, list_price=?,
          contract_date=?, closing_date=?, updated_at=datetime('now') WHERE id=?`,
          [n(cols[9]) || 'Active',
            cols[11] ? parseFloat(cols[11].replace(/[$,]/g, '')) : null,
            cols[10] ? parseFloat(cols[10].replace(/[$,]/g, '')) : null,
            n(cols[12]), n(cols[13]), existing.id])
        count++
      }
    }
    if (count > 0) console.log(`[scheduler] Google Sheet: updated ${count} transactions`)
  } catch (err) {
    console.error('[scheduler] Sheet sync error:', err.message)
  }
}

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
      } else cell += c
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
      } else cell += c
    }
  }
  if (cell || row.length) {
    row.push(cell.trim())
    if (row.some(v => v !== '')) rows.push(row)
  }
  return rows
}

export function startScheduler() {
  console.log('[scheduler] Starting auto-sync schedule...')

  // Run all syncs once on boot (after a 30s delay so server is fully ready)
  setTimeout(() => {
    console.log('[scheduler] Initial boot sync...')
    syncSierraIncremental()
    syncGoogleSheet()
  }, 30000)

  // Sierra incremental: every 10 minutes (only pulls leads updated since last run)
  setInterval(syncSierraIncremental, 10 * 60 * 1000)

  // Google Sheet: every 5 minutes (it's small and fast)
  setInterval(syncGoogleSheet, 5 * 60 * 1000)
}
