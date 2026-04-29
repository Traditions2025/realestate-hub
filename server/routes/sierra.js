import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

const SIERRA_API_KEY = process.env.SIERRA_API_KEY || 'b97e3302-1985-46a4-9032-cb92e5cb3dd8'
const SIERRA_API_URL = 'https://api.sierrainteractivedev.com'

// Keep Sierra's exact status names (lowercased, with underscores for spaces)
function mapStatus(sierraStatus) {
  if (!sierraStatus) return 'active'
  return sierraStatus.toLowerCase().replace(/\s+/g, '_')
}

async function sierraGet(endpoint, params = {}) {
  const url = new URL(`${SIERRA_API_URL}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))

  const resp = await fetch(url.toString(), {
    headers: {
      'Content-Type': 'application/json',
      'Sierra-ApiKey': SIERRA_API_KEY,
    }
  })
  if (!resp.ok) throw new Error(`Sierra API error: ${resp.status} ${resp.statusText}`)
  return resp.json()
}

// Extract Realist score - prefer specific number from shortSummary, fall back to tag range
function extractRealistScore(lead) {
  // 1. shortSummary has the specific number: "Realist Score: 541 | ..."
  const summary = lead.shortSummary || ''
  const m1 = summary.match(/realist\s*score\s*[:=]?\s*(\d{1,4})/i)
  if (m1) return m1[1]

  // 2. Fall back to tag range like "Realist score 800+"
  const tags = lead.tags || []
  for (const t of tags) {
    const tagStr = typeof t === 'string' ? t : (t.name || t.tag || '')
    const m = tagStr.match(/realist\s*score\s*(.+)/i)
    if (m) return m[1].trim()
  }
  return null
}

// Grade based on numeric score (0-1000) or text range
function gradeFromRealistScore(scoreStr) {
  if (!scoreStr) return null
  // Numeric
  const n = parseInt(scoreStr, 10)
  if (!isNaN(n)) {
    if (n >= 800) return 'A+'
    if (n >= 700) return 'A'
    if (n >= 650) return 'B'
    if (n >= 600) return 'C'
    if (n >= 500) return 'D'
    return 'F'
  }
  // Text range
  if (scoreStr.includes('800')) return 'A+'
  if (scoreStr.includes('700')) return 'A'
  if (scoreStr.includes('650')) return 'B'
  if (scoreStr.includes('600')) return 'C'
  if (scoreStr.includes('500')) return 'D'
  return 'F'
}

function processLead(lead, sierraStatus) {
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
  const leadScore = extractRealistScore(lead)
  const leadGrade = gradeFromRealistScore(leadScore)
  const visits = Number(lead.visits) || 0
  const emailStatus = n(lead.emailStatus)
  const phoneStatus = n(lead.phoneStatus)
  const sierraUpdateDate = n(lead.updateDate)
  const sierraCreationDate = n(lead.creationDate)
  const pondId = lead.pondId || null
  const meOptOut = lead.marketingEmailOptOut ? 1 : 0
  const textOptOut = lead.textOptOut ? 1 : 0
  const ealertOptOut = lead.eAlertOptOut ? 1 : 0
  const shortSummary = n(lead.shortSummary)

  // Use leadStatus from the lead itself if available, otherwise use the queried status
  const actualStatus = lead.leadStatus || sierraStatus
  const clientStatus = mapStatus(actualStatus)

  // Determine type from leadType
  let type = 'buyer'
  const leadType = (lead.leadType || '').toLowerCase()
  if (leadType === 'seller') type = 'seller'
  else if (leadType === 'both' || leadType === 'buyer/seller') type = 'both'

  // Agent assigned
  let agentAssigned = null
  if (lead.assignedTo && lead.assignedTo.agentUserFirstName) {
    agentAssigned = `${lead.assignedTo.agentUserFirstName} ${lead.assignedTo.agentUserLastName}`.trim()
  }

  // Budget from saved searches
  let budgetMin = null, budgetMax = null
  const searches = lead.savedSearchesModel?.savedSearches || lead.savedSearches || []
  if (searches.length > 0) {
    const search = searches[0]
    if (search.price) {
      budgetMin = search.price.min || null
      budgetMax = search.price.max || null
    } else {
      budgetMin = search.minPrice || search.priceMin || null
      budgetMax = search.maxPrice || search.priceMax || null
    }
  }

  // Check if already exists by sierra_lead_id
  const existing = db.get('SELECT id FROM clients WHERE sierra_lead_id = ?', [sierraId])

  if (existing) {
    db.run(`UPDATE clients SET first_name=?, last_name=?, email=?, phone=?,
      source=?, address=?, city=?, state=?, zip=?, type=?,
      budget_min=?, budget_max=?, agent_assigned=?, lead_score=?, lead_grade=?,
      status=?, visits=?, email_status=?, phone_status=?,
      sierra_update_date=?, sierra_creation_date=?, pond_id=?,
      marketing_email_opt_out=?, text_opt_out=?, ealert_opt_out=?, short_summary=?,
      updated_at=datetime('now') WHERE id=?`,
      [firstName, lastName, email, phone, source, address, city, state, zip,
        type, budgetMin, budgetMax, agentAssigned, leadScore, leadGrade, clientStatus,
        visits, emailStatus, phoneStatus, sierraUpdateDate, sierraCreationDate, pondId,
        meOptOut, textOptOut, ealertOptOut, shortSummary, existing.id])
    return 'updated'
  } else {
    db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
      source, agent_assigned, address, city, state, zip, budget_min, budget_max,
      sierra_lead_id, lead_score, lead_grade, visits, email_status, phone_status,
      sierra_update_date, sierra_creation_date, pond_id,
      marketing_email_opt_out, text_opt_out, ealert_opt_out, short_summary)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firstName, lastName, email, phone, type, clientStatus, source,
        agentAssigned, address, city, state, zip, budgetMin, budgetMax,
        sierraId, leadScore, leadGrade, visits, emailStatus, phoneStatus,
        sierraUpdateDate, sierraCreationDate, pondId,
        meOptOut, textOptOut, ealertOptOut, shortSummary])
    return 'added'
  }
}

// In-memory sync state so frontend can poll progress
let syncState = {
  running: false,
  startedAt: null,
  progress: { synced: 0, added: 0, updated: 0, currentStatus: null },
  lastResult: null,
  error: null,
}

async function runSyncBackground(statuses, statusParam) {
  syncState = {
    running: true,
    startedAt: new Date().toISOString(),
    progress: { synced: 0, added: 0, updated: 0, currentStatus: null },
    lastResult: null,
    error: null,
  }

  try {
    for (const status of statuses) {
      syncState.progress.currentStatus = status
      let page = 1
      let hasMore = true

      while (hasMore) {
        const result = await sierraGet('/leads/find', {
          leadStatus: status,
          includeSavedSearches: 'true',
          includeTags: 'true',
          pageSize: 100,
          pageNumber: page,
        })

        const responseData = result.data || result
        const leads = responseData.leads || responseData.data || []
        if (!leads.length) { hasMore = false; break }

        for (const lead of leads) {
          const r = processLead(lead, status)
          if (r === 'added') syncState.progress.added++
          else if (r === 'updated') syncState.progress.updated++
          if (r) syncState.progress.synced++
        }

        const totalPages = responseData.totalPages || 1
        if (page >= totalPages) hasMore = false
        else page++
      }
    }

    db.run('INSERT INTO sierra_sync_log (sync_type, leads_synced, leads_added, leads_updated) VALUES (?,?,?,?)',
      [statusParam, syncState.progress.synced, syncState.progress.added, syncState.progress.updated])

    db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
      ['synced', 'sierra', `Sierra sync (${statusParam}): ${syncState.progress.synced} leads (${syncState.progress.added} new, ${syncState.progress.updated} updated)`])

    syncState.lastResult = {
      success: true,
      total_synced: syncState.progress.synced,
      added: syncState.progress.added,
      updated: syncState.progress.updated,
      finishedAt: new Date().toISOString(),
    }
  } catch (err) {
    syncState.error = err.message
    db.run('INSERT INTO sierra_sync_log (sync_type, errors) VALUES (?,?)',
      ['sync_error', err.message])
  } finally {
    syncState.running = false
  }
}

// Start sync in background, respond immediately
router.post('/sync', (req, res) => {
  if (syncState.running) {
    return res.json({ success: true, alreadyRunning: true, progress: syncState.progress })
  }

  const statusParam = req.query.statuses || 'all'
  let statuses
  if (statusParam === 'all') {
    // Skip 'Blocked' - Sierra's API returns bogus 45K instead of the real ~1 record
    statuses = ['Prime', 'Active', 'New', 'Qualify', 'Watch', 'Pending', 'Archived', 'Closed', 'Junk', 'DoNotContact']
  } else {
    statuses = statusParam.split(',').map(s => s.trim())
  }

  // Fire and forget — runs in background
  runSyncBackground(statuses, statusParam).catch(() => {})

  res.json({ success: true, started: true, statuses })
})

// Poll sync status
router.get('/sync-status', (req, res) => {
  res.json({
    running: syncState.running,
    startedAt: syncState.startedAt,
    progress: syncState.progress,
    lastResult: syncState.lastResult,
    error: syncState.error,
  })
})

// Get counts per status from local DB (fast - no Sierra API calls)
router.get('/counts', async (req, res) => {
  try {
    const total = db.get('SELECT COUNT(*) as c FROM clients').c
    const counts = { total }
    const rows = db.all(`SELECT status, COUNT(*) as count FROM clients
      WHERE status IS NOT NULL AND status != '' GROUP BY status`)
    // Map our internal status back to Sierra naming for the UI
    const reverseMap = { prime: 'Prime', active: 'Active', new: 'New', qualify: 'Qualify',
      watch: 'Watch', pending: 'Pending', closed: 'Closed', archived: 'Archived',
      junk: 'Junk', donotcontact: 'DoNotContact', blocked: 'Blocked' }
    for (const r of rows) {
      counts[reverseMap[r.status] || r.status] = r.count
    }
    res.json(counts)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Pull Sierra notes (activity log) for a specific lead
router.get('/lead-notes/:sierraId', async (req, res) => {
  try {
    const data = await sierraGet(`/notes/${req.params.sierraId}`, { pageSize: 50, pageNumber: 1 })
    const records = data.data?.records || []
    // Strip HTML tags from content for cleaner display
    const cleaned = records.map(n => ({
      id: n.id,
      date: n.dateCreated,
      contents: (n.contents || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500),
      isSystem: n.isSystemItem,
      author: n.byUser?.name || 'Unknown',
    }))
    res.json(cleaned)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Get sync history
router.get('/sync-log', (req, res) => {
  const logs = db.all('SELECT * FROM sierra_sync_log ORDER BY synced_at DESC LIMIT 20')
  res.json(logs)
})

// Test Sierra connection
router.get('/test', async (req, res) => {
  try {
    const data = await sierraGet('/leads/find', { pageSize: 1, leadStatus: 'Active' })
    const responseData = data.data || data
    const total = responseData.totalRecords || 0
    res.json({ connected: true, active_leads: total })
  } catch (err) {
    res.json({ connected: false, error: err.message })
  }
})

export default router
