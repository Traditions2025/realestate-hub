import { Router } from 'express'
import db from '../database.js'
import { processLead, sierraGet, sierraPost, sierraDelete } from '../sierra-helper.js'

const router = Router()

// In-memory sync state
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

router.post('/sync', (req, res) => {
  if (syncState.running) {
    return res.json({ success: true, alreadyRunning: true, progress: syncState.progress })
  }

  const statusParam = req.query.statuses || 'all'
  let statuses
  if (statusParam === 'all') {
    statuses = ['Prime', 'Active', 'New', 'Qualify', 'Watch', 'Pending', 'Archived', 'Closed', 'Junk', 'DoNotContact']
  } else {
    statuses = statusParam.split(',').map(s => s.trim())
  }

  runSyncBackground(statuses, statusParam).catch(() => {})

  res.json({ success: true, started: true, statuses })
})

// Local DB counts (fast)
router.get('/counts', async (req, res) => {
  try {
    const total = db.get('SELECT COUNT(*) as c FROM clients').c
    const counts = { total }
    const rows = db.all(`SELECT status, COUNT(*) as count FROM clients
      WHERE status IS NOT NULL AND status != '' GROUP BY status`)
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

router.get('/sync-status', (req, res) => {
  res.json({
    running: syncState.running,
    startedAt: syncState.startedAt,
    progress: syncState.progress,
    lastResult: syncState.lastResult,
    error: syncState.error,
  })
})

router.get('/lead-notes/:sierraId', async (req, res) => {
  try {
    const data = await sierraGet(`/notes/${req.params.sierraId}`, { pageSize: 50, pageNumber: 1 })
    const records = data.data?.records || []
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

// Pull listing interest data: saved searches + listing-mentioned notes + saved listings (if accessible)
router.get('/lead-listings/:sierraId', async (req, res) => {
  const sierraId = req.params.sierraId
  const result = { saved_searches: [], saved_listings: [], listing_activity: [], errors: [] }

  // 1. Get the lead with saved searches
  try {
    const leadData = await sierraGet(`/leads/get/${sierraId}`, {
      includeSavedSearches: 'true',
      includeTags: 'true',
    })
    const lead = leadData.data || leadData
    const searches = lead.savedSearchesModel?.savedSearches || lead.savedSearches || []
    result.saved_searches = searches.map(s => ({
      name: s.searchName,
      regions: s.mlsRegions,
      price_min: s.price?.min,
      price_max: s.price?.max,
      bedrooms_min: s.bedrooms?.min,
      bathrooms_min: s.bathrooms?.min,
      sqft_min: s.squareFeet?.min,
      property_types: s.propertyTypes ? Object.entries(s.propertyTypes).filter(([k, v]) => v === 'On').map(([k]) => k) : [],
      email_alerts: s.sendEmailAlert === 'On',
      property_status: s.propertyStatus ? Object.entries(s.propertyStatus).filter(([k, v]) => v === 'On').map(([k]) => k) : [],
    }))
    result.visits = lead.visits
    result.last_activity = lead.updateDate
  } catch (e) {
    result.errors.push(`saved_searches: ${e.message}`)
  }

  // 2. Try saved listings endpoint
  try {
    const listingsData = await sierraGet(`/savedlistings/get/${sierraId}`)
    const listings = listingsData.data || []
    if (Array.isArray(listings) && listings.length > 0) {
      result.saved_listings = listings.map(l => ({
        mls: l.mlsNumber || l.mlsId,
        address: l.address || l.streetAddress,
        city: l.city,
        price: l.listPrice,
        status: l.status,
        bedrooms: l.bedrooms,
        bathrooms: l.bathrooms,
      }))
    }
  } catch (e) {
    // 403 is normal - most leads' saved listings are private
    if (!e.message.includes('403')) result.errors.push(`saved_listings: ${e.message}`)
  }

  // 3. Parse notes for listing-related activity
  try {
    const notesData = await sierraGet(`/notes/${sierraId}`, { pageSize: 50, pageNumber: 1 })
    const records = notesData.data?.records || []

    // Patterns to find listing mentions
    const addrPattern = /(\d{2,5}\s+[A-Z][^,<\n]{4,80}(?:\s+(?:St|Ave|Rd|Dr|Ln|Ct|Way|Pl|Blvd|Cir|Trl|Ter|Pkwy|Hwy|Lane|Drive|Court|Avenue|Road|Place|Boulevard)))/gi
    const mlsPattern = /MLS\s*#?\s*(\d{6,9})/gi

    for (const note of records) {
      const cleaned = (note.contents || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      const lower = cleaned.toLowerCase()
      // Only include notes that mention listings/properties
      if (!/listing|property|view|saw|searched|browsing|saved|favorite|showing|inquir/.test(lower)) continue

      const addresses = [...new Set([...cleaned.matchAll(addrPattern)].map(m => m[1].trim()))]
      const mlsNumbers = [...new Set([...cleaned.matchAll(mlsPattern)].map(m => m[1]))]

      result.listing_activity.push({
        id: note.id,
        date: note.dateCreated,
        author: note.byUser?.name || 'Unknown',
        is_system: note.isSystemItem,
        excerpt: cleaned.substring(0, 250),
        addresses,
        mls_numbers: mlsNumbers,
      })
    }
  } catch (e) {
    if (!e.message.includes('403')) result.errors.push(`notes: ${e.message}`)
  }

  res.json(result)
})

router.get('/sync-log', (req, res) => {
  const logs = db.all('SELECT * FROM sierra_sync_log ORDER BY synced_at DESC LIMIT 20')
  res.json(logs)
})

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

// =============================================================
// REAL-TIME WEBHOOKS
// =============================================================

// List currently registered webhooks
router.get('/webhooks', async (req, res) => {
  try {
    const data = await sierraGet('/webhooks')
    res.json(data.data || data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Register webhooks for real-time lead updates
// Call once on initial setup or whenever the URL changes
router.post('/register-webhooks', async (req, res) => {
  try {
    const baseUrl = req.body.baseUrl || `https://${req.headers.host}`
    const webhookUrl = `${baseUrl}/api/sierra/webhook`

    const events = ['LeadCreated', 'LeadUpdated', 'LeadAgentChanged', 'LeadStatusChanged']
    const registered = []
    const errors = []

    // First, try to delete any existing webhooks pointing to old URLs
    try {
      const existing = await sierraGet('/webhooks')
      const existingHooks = existing.data || existing || []
      for (const hook of existingHooks) {
        if (hook.id && hook.url && hook.url.includes('/api/sierra/webhook')) {
          try { await sierraDelete(`/webhooks/${hook.id}`) } catch {}
        }
      }
    } catch {}

    for (const event of events) {
      try {
        await sierraPost('/webhooks', { url: webhookUrl, eventType: event })
        registered.push(event)
      } catch (e) {
        errors.push({ event, error: e.message })
      }
    }

    res.json({ success: true, webhookUrl, registered, errors })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Webhook receiver - Sierra POSTs here when leads change
// PUBLIC endpoint (no auth required) - Sierra hits this directly
router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body || {}
    // Sierra payload typically has eventType and lead data
    const eventType = payload.eventType || payload.event || 'unknown'
    const leadId = payload.leadId || payload.id || payload.lead?.id

    if (!leadId) {
      return res.status(400).json({ error: 'No leadId in payload' })
    }

    // Fetch the latest lead data from Sierra (payload may be partial)
    const result = await sierraGet(`/leads/get/${leadId}`, {
      includeSavedSearches: 'true',
      includeTags: 'true',
    })
    const lead = result.data || result
    const action = processLead(lead)

    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['webhook', 'sierra', null, `${eventType}: ${lead.firstName} ${lead.lastName} (${action})`])

    res.json({ success: true, action })
  } catch (err) {
    console.error('[webhook] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
