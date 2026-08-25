import { Router } from 'express'
import db from '../database.js'
import { processLead, sierraGet, sierraPost, sierraPut, sierraDelete } from '../sierra-helper.js'

// Map hub status (lowercase_with_underscores) → Sierra status (PascalCase, no spaces)
const HUB_TO_SIERRA_STATUS = {
  prime: 'Prime',
  active: 'Active',
  new: 'New',
  qualify: 'Qualify',
  watch: 'Watch',
  pending: 'Pending',
  closed: 'Closed',
  archived: 'Archived',
  junk: 'Junk',
  donotcontact: 'DoNotContact',
  blocked: 'Blocked',
}

const router = Router()

// In-memory sync state
let syncState = {
  running: false,
  cancelRequested: false,
  startedAt: null,
  progress: { synced: 0, added: 0, updated: 0, currentStatus: null },
  lastResult: null,
  error: null,
}

async function runSyncBackground(statuses, statusParam) {
  syncState = {
    running: true,
    cancelRequested: false,
    startedAt: new Date().toISOString(),
    progress: { synced: 0, added: 0, updated: 0, currentStatus: null },
    lastResult: null,
    error: null,
  }

  try {
    for (const status of statuses) {
      if (syncState.cancelRequested) break
      syncState.progress.currentStatus = status
      let page = 1
      let hasMore = true

      while (hasMore) {
        if (syncState.cancelRequested) { hasMore = false; break }
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
      cancelled: syncState.cancelRequested,
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

// Manual trigger for the daily Watch-status sweep (also runs automatically at 6 AM CT).
router.post('/watch-sweep', async (_req, res) => {
  try {
    const { watchStatusSweep } = await import('../scheduler.js')
    const r = await watchStatusSweep()
    res.json({ success: true, ...r })
  } catch (e) { res.status(500).json({ success: false, error: e.message }) }
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
    cancelRequested: syncState.cancelRequested,
    startedAt: syncState.startedAt,
    progress: syncState.progress,
    lastResult: syncState.lastResult,
    error: syncState.error,
  })
})

// Cancel an in-progress full sync — the background loop checks this flag between pages.
router.post('/sync-cancel', (req, res) => {
  if (!syncState.running) return res.json({ success: true, running: false, message: 'No sync running.' })
  syncState.cancelRequested = true
  res.json({ success: true, cancelRequested: true, progress: syncState.progress })
})

// Batch refresh: pull a specific set of leads from Sierra (by client_id or sierra_lead_id)
// and update each one. Useful after filtering — refresh only the matched results
// without running a full 45K-lead sync.
let _batchState = {
  running: false,
  total: 0, done: 0, added: 0, updated: 0, errors: 0,
  startedAt: null, finishedAt: null, lastError: null,
}

router.post('/refresh-leads-batch', async (req, res) => {
  if (_batchState.running) {
    return res.json({ success: true, alreadyRunning: true, progress: _batchState })
  }
  const ids = Array.isArray(req.body?.client_ids) ? req.body.client_ids : []
  if (!ids.length) return res.status(400).json({ error: 'client_ids array required' })
  if (ids.length > 1000) return res.status(400).json({ error: 'Max 1000 per batch — use Sync All Sierra Leads for larger sets' })

  // Resolve to sierra_lead_id
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.all(`SELECT sierra_lead_id FROM clients WHERE id IN (${placeholders}) AND sierra_lead_id IS NOT NULL`, ids)
  const sierraIds = rows.map(r => r.sierra_lead_id)

  // Kick off async — don't block the response
  _batchState = {
    running: true, total: sierraIds.length, done: 0, added: 0, updated: 0, errors: 0,
    startedAt: new Date().toISOString(), finishedAt: null, lastError: null,
  }

  ;(async () => {
    for (const sid of sierraIds) {
      try {
        const result = await sierraGet(`/leads/get/${sid}`, {
          includeSavedSearches: 'true',
          includeTags: 'true',
        })
        const lead = result.data || result
        if (lead && lead.id) {
          const action = processLead(lead)
          if (action === 'added') _batchState.added++
          else if (action === 'updated') _batchState.updated++
        }
      } catch (err) {
        _batchState.errors++
        _batchState.lastError = err.message
      }
      _batchState.done++
    }
    _batchState.running = false
    _batchState.finishedAt = new Date().toISOString()
    db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
      ['batch_refresh', 'sierra', `Batch refresh: ${_batchState.done}/${_batchState.total} processed (${_batchState.added} new, ${_batchState.updated} updated, ${_batchState.errors} errors)`])
  })().catch(() => { _batchState.running = false })

  res.json({ success: true, started: true, total: sierraIds.length })
})

router.get('/refresh-leads-batch/status', (_req, res) => {
  res.json(_batchState)
})

// Single-lead refresh: pull one lead from Sierra and update the local row.
// Useful when the user changes a lead in Sierra and wants to see it instantly
// without waiting for the next 10-min incremental cycle.
router.post('/refresh-lead/:sierraId', async (req, res) => {
  const sierraId = req.params.sierraId
  try {
    const result = await sierraGet(`/leads/get/${sierraId}`, {
      includeSavedSearches: 'true',
      includeTags: 'true',
    })
    const lead = result.data || result
    if (!lead || !lead.id) {
      return res.status(404).json({ success: false, error: 'Lead not found in Sierra' })
    }
    const action = processLead(lead)
    db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
      ['refreshed', 'sierra', `Single-lead refresh: ${lead.firstName || ''} ${lead.lastName || ''} (${action})`])
    const client = db.get('SELECT * FROM clients WHERE sierra_lead_id = ?', [String(sierraId)])
    res.json({ success: true, action, client })
  } catch (err) {
    console.error('[refresh-lead] error:', err.message)
    res.status(500).json({ success: false, error: err.message })
  }
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

// Health summary: latest full sync, latest incremental, recent activity
router.get('/sync-health', (req, res) => {
  const lastFull = db.get(`SELECT * FROM sierra_sync_log
    WHERE sync_type NOT IN ('incremental','incremental_error','sync_error')
    ORDER BY synced_at DESC LIMIT 1`)
  const lastIncremental = db.get(`SELECT * FROM sierra_sync_log
    WHERE sync_type = 'incremental' ORDER BY synced_at DESC LIMIT 1`)
  const lastError = db.get(`SELECT * FROM sierra_sync_log
    WHERE errors IS NOT NULL AND errors != '' ORDER BY synced_at DESC LIMIT 1`)
  const incremental24h = db.get(`SELECT COUNT(*) as c FROM sierra_sync_log
    WHERE sync_type = 'incremental' AND synced_at >= datetime('now', '-1 day')`).c
  const updatesSinceFullSync = lastFull ? db.get(`
    SELECT COALESCE(SUM(leads_synced), 0) as c FROM sierra_sync_log
    WHERE sync_type = 'incremental' AND synced_at > ?`, [lastFull.synced_at]).c : 0
  res.json({
    last_full: lastFull,
    last_incremental: lastIncremental,
    last_error: lastError,
    incremental_runs_24h: incremental24h,
    updates_since_full_sync: updatesSinceFullSync,
    scheduler_expected_interval_min: 10,
  })
})

// Manual trigger: kicks off an incremental sync immediately (skips the 10-min wait)
router.post('/sync-incremental-now', async (req, res) => {
  try {
    const { runIncrementalNow } = await import('../scheduler.js')
    const result = await runIncrementalNow()
    res.json(result)
  } catch (err) {
    res.status(500).json({ success: false, error: err.message })
  }
})

// Date-scoped backfill: import every Sierra lead created OR updated since a given
// date, with FULL pagination (no 50-page cap). Recovers a new-lead import gap
// (e.g. leads created after the last successful add) WITHOUT a full 45k resync.
// A newly-created lead has updateDate == creationDate, so the updated pass alone
// captures the gap; the created pass is belt-and-suspenders. Body: { since: 'YYYY-MM-DD' }.
router.post('/sync-since', async (req, res) => {
  const sinceInput = String(req.body?.since || '').trim()
  if (!sinceInput) return res.status(400).json({ error: 'since (YYYY-MM-DD) required' })
  const d = new Date(sinceInput.includes('T') ? sinceInput : sinceInput + 'T00:00:00Z')
  if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid date' })
  const iso = d.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const mmddyyyy = `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`
  // updated pass = ISO 8601 ; created pass = MM/dd/yyyy (Sierra's per-filter formats)
  const passes = [
    { name: 'updated', filter: 'leadUpdateDateFrom', value: iso },
    { name: 'created', filter: 'leadCreationDateFrom', value: mmddyyyy },
  ]
  let added = 0, updated = 0
  const perPass = {}
  const seen = new Set()
  db.beginBulk?.()
  try {
    for (const pass of passes) {
      let page = 1, hasMore = true, passCount = 0
      while (hasMore) {
        const result = await sierraGet('/leads/find', {
          [pass.filter]: pass.value, includeSavedSearches: 'true', includeTags: 'true',
          pageSize: 100, pageNumber: page,
        })
        const rd = result.data || result
        const leads = rd.leads || []
        if (!leads.length) break
        for (const lead of leads) {
          const r = processLead(lead)
          if (r === 'added') added++
          else if (r === 'updated') updated++
          if (r) { seen.add(String(lead.id)); passCount++ }
        }
        const totalPages = rd.totalPages || 1
        if (page >= totalPages) hasMore = false
        else page++
        if (page > 500) break  // safety cap: 50k leads/pass
      }
      perPass[pass.name] = passCount
    }
  } finally { db.endBulk?.() }
  db.run('INSERT INTO sierra_sync_log (sync_type, leads_synced, leads_added, leads_updated) VALUES (?,?,?,?)',
    ['backfill_since', seen.size, added, updated])
  res.json({ success: true, since: sinceInput, added, updated, unique_leads: seen.size, perPass })
})

// =============================================================
// WRITE-BACK: push hub status change to Sierra. Status-only for now;
// always behind a confirm dialog in the UI. Body: { client_id, status }
// where status is the hub's lowercase_with_underscores form.
// Tries multiple Sierra endpoint shapes since the exact route name varies
// across Sierra Interactive API versions — surfaces the actual error.
// =============================================================
router.post('/update-lead-status', async (req, res) => {
  const { client_id, status } = req.body || {}
  if (!client_id || !status) return res.status(400).json({ error: 'client_id and status required' })

  const sierraStatus = HUB_TO_SIERRA_STATUS[String(status).toLowerCase()]
  if (!sierraStatus) return res.status(400).json({ error: `Unknown status: ${status}` })

  const client = db.get('SELECT id, sierra_lead_id, first_name, last_name, status FROM clients WHERE id = ?', [Number(client_id)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  if (!client.sierra_lead_id) return res.status(400).json({ error: 'Client has no sierra_lead_id (not a Sierra-sourced lead)' })

  const leadId = client.sierra_lead_id
  const attempts = [
    { method: 'POST', path: `/leads/edit/${leadId}`,  body: { leadStatus: sierraStatus } },
    { method: 'POST', path: `/leads/update/${leadId}`, body: { leadStatus: sierraStatus } },
    { method: 'POST', path: `/leads/${leadId}/status`, body: { status: sierraStatus } },
    { method: 'PUT',  path: `/leads/${leadId}`,        body: { leadStatus: sierraStatus } },
  ]

  const errors = []
  for (const a of attempts) {
    try {
      const result = a.method === 'PUT'
        ? await sierraPut(a.path, a.body)
        : await sierraPost(a.path, a.body)
      // Success — log to activity_log and return.
      db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
        ['sierra_status_pushed', 'client', client.id,
         `Pushed status to Sierra: ${client.first_name} ${client.last_name} → ${sierraStatus} (via ${a.method} ${a.path})`])
      return res.json({ success: true, endpoint_used: `${a.method} ${a.path}`, sierra_status: sierraStatus, sierra_response: result })
    } catch (err) {
      errors.push({ endpoint: `${a.method} ${a.path}`, error: err.message })
      // Only try the next endpoint if this looked like a route mismatch (404).
      // Anything else (401/403/400) is a real Sierra reply — stop and surface it.
      if (!/40[045]/.test(err.message)) break
    }
  }

  res.status(502).json({
    success: false,
    error: 'All Sierra update endpoint attempts failed',
    attempts: errors,
    hint: 'Send these error details so we can pin the right Sierra endpoint shape for your account.',
  })
})

// Add a note to a Sierra lead, trying the known endpoint/body shapes until one sticks.
// Returns { ok, via } or { ok:false, attempts }.
async function pushSierraNote(leadId, text) {
  const shapes = [
    { m: 'POST', path: `/leads/edit/${leadId}`, body: { note: text } },
    { m: 'POST', path: `/leads/edit/${leadId}`, body: { notes: text } },
    { m: 'POST', path: `/leads/${leadId}/notes`, body: { note: text } },
    { m: 'POST', path: `/leads/${leadId}/note`, body: { note: text } },
    { m: 'POST', path: `/notes/create`, body: { leadId, note: text } },
    { m: 'POST', path: `/notes/add`, body: { leadId, note: text } },
    { m: 'PUT', path: `/notes/${leadId}`, body: { note: text } },
  ]
  const attempts = []
  for (const s of shapes) {
    try {
      const r = s.m === 'PUT' ? await sierraPut(s.path, s.body) : await sierraPost(s.path, s.body)
      const ok = r && (r.success !== false)
      if (ok) return { ok: true, via: `${s.m} ${s.path}` }
      attempts.push({ endpoint: `${s.m} ${s.path}`, error: (r && r.errorMessage) || 'success:false' })
    } catch (e) { attempts.push({ endpoint: `${s.m} ${s.path}`, error: String(e.message).slice(0, 120) }) }
  }
  return { ok: false, attempts }
}

// Test/repair: push the FSBO note to a lead that's ALREADY in Sierra.
router.post('/add-fsbo-note', async (req, res) => {
  const client = db.get('SELECT * FROM clients WHERE id=?', [Number(req.body?.client_id)])
  if (!client) return res.status(404).json({ error: 'not found' })
  if (!client.sierra_lead_id) return res.status(400).json({ error: 'not in Sierra' })
  const noteText = [
    client.address ? `FSBO: ${client.address}, ${client.city || ''} ${client.zip || ''}`.trim() : 'FSBO',
    client.fsbo_status ? `Status: ${client.fsbo_status}` : '',
    client.fsbo_list_date ? `Listed: ${client.fsbo_list_date}` : '',
    client.fsbo_dom ? `Days on market: ${client.fsbo_dom}` : '',
    client.fsbo_link ? `Link: ${client.fsbo_link}` : '',
    client.fsbo_notes ? `\n${client.fsbo_notes}` : '',
  ].filter(Boolean).join('  ').trim()
  res.json(await pushSierraNote(client.sierra_lead_id, noteText))
})

// Create a Hub-native lead (e.g. a master-file FSBO with no sierra_lead_id) IN Sierra,
// then link it back by storing the returned sierra_lead_id on the Hub record. dryRun:true
// returns the payload without calling Sierra.
router.post('/create-lead', async (req, res) => {
  const client = db.get('SELECT * FROM clients WHERE id=?', [Number(req.body?.client_id)])
  if (!client) return res.status(404).json({ error: 'client not found' })
  if (client.sierra_lead_id) return res.status(400).json({ error: 'already in Sierra', sierra_lead_id: client.sierra_lead_id })

  let tags = []
  try { tags = JSON.parse(client.tags || '[]') } catch {}
  tags = tags.filter(t => !/^fsbo master$/i.test(String(t)))   // internal marker, do not push to Sierra
  const sierraStatus = HUB_TO_SIERRA_STATUS[String(client.status || 'watch').toLowerCase()] || 'Watch'
  // Sierra's POST /leads requires a password (each lead gets a portal account). The lead
  // never uses it; generate a strong random one.
  const password = 'Fsbo!' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase()
  // Sierra requires an email. FSBOs often have none, so use the team's non-routable
  // placeholder convention (notvalidemail.com never delivers, so no email is ever sent).
  const email = client.email || `noemail-${Math.random().toString(36).slice(2, 12)}@notvalidemail.com`
  const payload = {
    firstName: client.first_name || '', lastName: client.last_name || '(FSBO)',
    email, password,
    phone: client.phone || undefined,   // Sierra's field is `phone` (matches the update endpoint)
    leadStatus: sierraStatus,
    source: client.source || 'FSBO Master',
    streetAddress: client.address || undefined, city: client.city || undefined,
    state: client.state || 'IA', zipCode: client.zip || undefined,
    tags: tags.length ? tags : undefined,
  }
  // The note we'll attach after creation: FSBO listing context from the master file.
  const noteText = [
    client.address ? `FSBO: ${client.address}, ${client.city || ''} ${client.zip || ''}`.trim() : 'FSBO',
    client.fsbo_status ? `Status: ${client.fsbo_status}` : '',
    client.fsbo_list_date ? `Listed: ${client.fsbo_list_date}` : '',
    client.fsbo_dom ? `Days on market: ${client.fsbo_dom}` : '',
    client.fsbo_link ? `Link: ${client.fsbo_link}` : '',
    client.fsbo_notes ? `\n${client.fsbo_notes}` : '',
  ].filter(Boolean).join('  ').trim()
  if (req.body?.dryRun) return res.json({ dryRun: true, payload: { ...payload, password: '***' }, note: noteText })

  let created = null, noteResult = null
  try {
    const result = await sierraPost('/leads', payload)
    const data = result?.data || result
    const newId = data?.id || data?.leadId || data?.leadID
    if (!newId) return res.status(502).json({ success: false, error: 'created but no lead id returned', sierra_response: data })
    db.run('UPDATE clients SET sierra_lead_id=?, updated_at=? WHERE id=?', [String(newId), new Date().toISOString(), client.id])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['sierra_lead_created', 'client', client.id, `Created in Sierra (id ${newId})`])
    created = newId
    // Keep the Hub record's tags in sync with what we sent Sierra (no FSBO Master marker).
    db.run('UPDATE clients SET tags=? WHERE id=?', [JSON.stringify(tags), client.id])
    // Belt-and-suspenders: PUT the phone (some create paths ignore it) via the proven path.
    if (client.phone) { try { await sierraPut(`/leads/${newId}`, { phone: client.phone }) } catch {} }
    if (noteText) noteResult = await pushSierraNote(newId, noteText)
    return res.json({ success: true, sierra_lead_id: created, phone_sent: client.phone || null, note: noteResult })
  } catch (err) {
    return res.status(502).json({ success: false, error: err.message, payload: { ...payload, password: '***' } })
  }
})

// Push edited profile fields to Sierra so Hub edits STICK (otherwise the sync
// overwrites them back to Sierra's values). Uses the documented PUT /leads/{id}
// (partial update). Send only the fields you changed. Non-empty values only, so
// we never accidentally blank a Sierra field. Maps Hub column names → Sierra params.
const HUB_TO_SIERRA_FIELD = {
  first_name: 'firstName', last_name: 'lastName', email: 'email', phone: 'phone',
  address: 'streetAddress', city: 'city', state: 'state', zip: 'zip',
}
router.post('/update-lead-fields', async (req, res) => {
  const { client_id, fields } = req.body || {}
  if (!client_id) return res.status(400).json({ error: 'client_id required' })
  const client = db.get('SELECT id, sierra_lead_id FROM clients WHERE id = ?', [Number(client_id)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  if (!client.sierra_lead_id) return res.json({ success: true, skipped: 'not a Sierra lead (local only)' })
  const src = fields || db.get('SELECT * FROM clients WHERE id = ?', [Number(client_id)])
  const body = {}
  for (const [hk, sk] of Object.entries(HUB_TO_SIERRA_FIELD)) {
    const v = src[hk]
    if (v !== undefined && v !== null && String(v).trim() !== '') body[sk] = String(v).trim()
  }
  if (src.status) { const ss = HUB_TO_SIERRA_STATUS[String(src.status).toLowerCase()]; if (ss) body.leadStatus = ss }
  if (!Object.keys(body).length) return res.json({ success: true, skipped: 'no pushable fields' })
  try {
    const result = await sierraPut(`/leads/${client.sierra_lead_id}`, body)
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['sierra_fields_pushed', 'client', client.id, `Pushed to Sierra: ${Object.keys(body).join(', ')}`])
    res.json({ success: true, pushed: Object.keys(body), sierra_response: result })
  } catch (err) {
    res.status(502).json({ success: false, error: err.message })
  }
})

// =============================================================
// WRITE-BACK: push tag add/remove to Sierra. Local hub DB is updated
// first (always succeeds, so the change is never lost locally even if
// Sierra rejects). Then we try multiple Sierra endpoint shapes since
// the tag route name varies across Sierra Interactive API versions.
// Body: { client_id, tag, action: 'add' | 'remove' }
// =============================================================
function syncTagsLocal(clientId, tag, action) {
  const c = db.get('SELECT id, tags FROM clients WHERE id = ?', [Number(clientId)])
  if (!c) return null
  let list = []
  try { list = c.tags ? JSON.parse(c.tags) : [] } catch { list = [] }
  if (!Array.isArray(list)) list = []
  const trimmed = String(tag).trim()
  if (!trimmed) return list
  const idx = list.findIndex(t => String(t).toLowerCase() === trimmed.toLowerCase())
  if (action === 'add') {
    if (idx < 0) list.push(trimmed)
  } else if (action === 'remove') {
    if (idx >= 0) list.splice(idx, 1)
  }
  db.run("UPDATE clients SET tags = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(list), Number(clientId)])
  return list
}

router.post('/update-lead-tag', async (req, res) => {
  const { client_id, tag, action } = req.body || {}
  if (!client_id || !tag) return res.status(400).json({ error: 'client_id and tag required' })
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: "action must be 'add' or 'remove'" })

  const client = db.get('SELECT id, sierra_lead_id, first_name, last_name FROM clients WHERE id = ?', [Number(client_id)])
  if (!client) return res.status(404).json({ error: 'Client not found' })

  // Always update local first so the hub state is correct regardless of Sierra.
  const updatedTags = syncTagsLocal(client.id, tag, action)

  if (!client.sierra_lead_id) {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      [`tag_${action}_local`, 'client', client.id,
       `${action === 'add' ? 'Added' : 'Removed'} tag "${tag}" on ${client.first_name} ${client.last_name} (local only — not a Sierra lead)`])
    return res.json({ success: true, local_only: true, tags: updatedTags })
  }

  const leadId = client.sierra_lead_id
  // Per Sierra's documented "Update Existing Lead" endpoint (PUT /leads/{id}):
  //   tags       = array of tag NAME STRINGS to ASSIGN (additive — does NOT replace)
  //   removeTags = array of tag NAME STRINGS to remove
  // We send ONLY the single tag being changed, so existing tags are never touched
  // (no clobber). Strings only — object form returns 400. The older shapes are kept
  // as fallbacks but 404 on this account.
  const attempts = action === 'add'
    ? [
        { method: 'PUT',  path: `/leads/${leadId}`,      body: { tags: [tag] } },
        { method: 'POST', path: `/leads/${leadId}/tags`, body: { tag } },
        { method: 'POST', path: `/leads/edit/${leadId}`, body: { addTags: [tag] } },
      ]
    : [
        { method: 'PUT',    path: `/leads/${leadId}`,      body: { removeTags: [tag] } },
        { method: 'DELETE', path: `/leads/${leadId}/tags/${encodeURIComponent(tag)}`, body: null },
        { method: 'POST',   path: `/leads/edit/${leadId}`, body: { removeTags: [tag] } },
      ]

  const errors = []
  for (const a of attempts) {
    try {
      let result
      if (a.method === 'PUT') result = await sierraPut(a.path, a.body)
      else if (a.method === 'DELETE') result = await sierraDelete(a.path)
      else result = await sierraPost(a.path, a.body)
      db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
        [`tag_${action}_pushed`, 'client', client.id,
         `Pushed tag ${action} to Sierra: ${client.first_name} ${client.last_name} ${action === 'add' ? '+' : '-'} "${tag}" (via ${a.method} ${a.path})`])
      return res.json({ success: true, endpoint_used: `${a.method} ${a.path}`, tags: updatedTags, sierra_response: result })
    } catch (err) {
      errors.push({ endpoint: `${a.method} ${a.path}`, error: err.message })
      // Only try the next endpoint if route looks wrong (404/405). Other 4xx = real Sierra reply.
      if (!/40[045]/.test(err.message)) break
    }
  }

  // Sierra all failed but local is already updated. Return partial success.
  res.status(502).json({
    success: false,
    local_updated: true,
    tags: updatedTags,
    error: 'Local hub updated, but all Sierra tag endpoint attempts failed',
    attempts: errors,
    hint: 'Send these error details to pin the right Sierra tag endpoint shape.',
  })
})

// =============================================================
// BULK TAG FROM SHEET: pull a Google Sheet CSV, filter rows by a column
// value, match each row to a hub client by phone, then add a tag to all
// matched clients (local + push to Sierra). Returns a per-row report.
// Body: { sheet_id, filter_column, filter_value, tag, dry_run? }
// =============================================================
function parseCsv(csv) {
  const rows = []
  let cell = '', row = [], inQ = false
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i]
    if (inQ) {
      if (c === '"') { if (csv[i+1] === '"') { cell += '"'; i++ } else inQ = false }
      else cell += c
    } else {
      if (c === '"') inQ = true
      else if (c === ',') { row.push(cell); cell = '' }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = '' }
      else if (c !== '\r') cell += c
    }
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

// Last-10-digits phone match — strips formatting and gives a stable key.
function phoneKey(p) {
  if (!p) return null
  const digits = String(p).replace(/\D/g, '')
  if (digits.length < 10) return null
  return digits.slice(-10)
}

// DISABLED 2026-08-06. The hub is the master file and no longer connects to ANY
// Google Sheet. This endpoint used to fetch a shared sheet's CSV and bulk-tag hub
// clients from it. Short-circuited so no request ever reaches docs.google.com.
router.post('/bulk-tag-from-sheet', async (req, res) => {
  return res.status(410).json({
    error: 'Google Sheet import is disabled. The hub is the master file and no longer connects to any sheet.',
    disabled_at: '2026-08-06',
  })
  /* eslint-disable no-unreachable -- legacy body retained (unreachable) in case this is ever intentionally revived */
  const { sheet_id, filter_column, filter_value, tag, dry_run } = req.body || {}
  if (!sheet_id || !filter_column || !filter_value || !tag) {
    return res.status(400).json({ error: 'sheet_id, filter_column, filter_value, and tag are required' })
  }

  try {
    // Try the direct export URL first (more reliable, single hop), then fall
    // back to gviz if it fails. Both work for "anyone with the link can view"
    // sheets without an API key. Surfaces the actual fetch error so we don't
    // get the generic "fetch failed" black box.
    const urls = [
      `https://docs.google.com/spreadsheets/d/${sheet_id}/export?format=csv`,
      `https://docs.google.com/spreadsheets/d/${sheet_id}/gviz/tq?tqx=out:csv`,
    ]
    let csv = null
    const errors = []
    for (const url of urls) {
      try {
        const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'realestate-hub/1.0' } })
        if (!r.ok) { errors.push(`${url} → HTTP ${r.status}`); continue }
        csv = await r.text()
        if (csv && csv.trim().length > 0 && !csv.includes('<HTML>') && !csv.includes('<!DOCTYPE html>')) break
        errors.push(`${url} → got HTML/empty (sheet may not be public)`)
        csv = null
      } catch (fetchErr) {
        errors.push(`${url} → ${fetchErr.message}${fetchErr.cause ? ` (cause: ${fetchErr.cause.message || fetchErr.cause.code || JSON.stringify(fetchErr.cause)})` : ''}`)
      }
    }
    if (!csv) {
      return res.status(502).json({
        error: 'Could not fetch sheet CSV. Make sure the sheet is shared as "Anyone with the link can view".',
        attempts: errors,
      })
    }
    const rows = parseCsv(csv)
    if (rows.length < 2) return res.json({ matched: 0, skipped: 0, report: [], error: 'Sheet has no data rows' })

    const header = rows[0]
    const filterIdx = header.indexOf(filter_column)
    if (filterIdx < 0) return res.status(400).json({ error: `Column "${filter_column}" not found. Available: ${header.join(', ')}` })
    const nameIdx = header.indexOf('Name')
    const phoneIdx = header.findIndex(h => /phone/i.test(h))
    const addrIdx = header.findIndex(h => /street.?address|^address$/i.test(h))

    // Filter rows. Match is case-insensitive trim-tolerant.
    const target = String(filter_value).trim().toLowerCase()
    const filtered = rows.slice(1).filter(r => (r[filterIdx] || '').trim().toLowerCase() === target)

    // Pre-load all hub clients keyed by phoneKey for O(1) lookup.
    const clients = db.all('SELECT id, sierra_lead_id, first_name, last_name, phone, address, tags FROM clients')
    const byPhone = new Map()
    for (const c of clients) {
      const k = phoneKey(c.phone)
      if (k) byPhone.set(k, c)
    }

    const report = []
    let matched = 0, alreadyTagged = 0, pushed = 0, sierraFailed = 0

    for (const r of filtered) {
      const sheetName = r[nameIdx] || '(unnamed)'
      const sheetPhone = r[phoneIdx] || ''
      const sheetAddr = r[addrIdx] || ''
      const k = phoneKey(sheetPhone)
      const client = k ? byPhone.get(k) : null
      if (!client) {
        report.push({ sheet_name: sheetName, sheet_phone: sheetPhone, sheet_address: sheetAddr, matched: false, reason: k ? 'no hub client with this phone' : 'no usable phone in sheet' })
        continue
      }
      matched++

      // Check if already tagged
      let existing = []
      try { existing = client.tags ? JSON.parse(client.tags) : [] } catch {}
      if (!Array.isArray(existing)) existing = []
      const hasTag = existing.some(t => String(t).toLowerCase() === tag.toLowerCase())
      if (hasTag) {
        alreadyTagged++
        report.push({ sheet_name: sheetName, hub_client_id: client.id, hub_name: `${client.first_name} ${client.last_name}`, matched: true, action: 'skip', reason: 'already has tag' })
        continue
      }

      if (dry_run) {
        report.push({ sheet_name: sheetName, hub_client_id: client.id, hub_name: `${client.first_name} ${client.last_name}`, matched: true, action: 'would-tag', sierra: !!client.sierra_lead_id })
        continue
      }

      // Apply locally
      const updated = [...existing, tag]
      db.run("UPDATE clients SET tags = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(updated), client.id])
      let sierraResult = 'local_only'
      if (client.sierra_lead_id) {
        // Try the same set of Sierra tag endpoints used by /update-lead-tag
        const attempts = [
          { method: 'POST', path: `/leads/${client.sierra_lead_id}/tags`, body: { tag } },
          { method: 'POST', path: `/leads/${client.sierra_lead_id}/tag`,  body: { name: tag } },
          { method: 'POST', path: `/leads/edit/${client.sierra_lead_id}`, body: { addTags: [tag] } },
          { method: 'PUT',  path: `/leads/${client.sierra_lead_id}/tags/${encodeURIComponent(tag)}`, body: {} },
          { method: 'POST', path: `/leads/edit/${client.sierra_lead_id}`, body: { tags: updated } },
        ]
        let ok = false
        let lastErr = ''
        for (const a of attempts) {
          try {
            if (a.method === 'PUT') await sierraPut(a.path, a.body)
            else await sierraPost(a.path, a.body)
            ok = true
            sierraResult = `pushed (${a.method} ${a.path})`
            break
          } catch (err) {
            lastErr = err.message
            if (!/40[045]/.test(err.message)) break
          }
        }
        if (ok) pushed++
        else { sierraFailed++; sierraResult = `sierra_failed: ${lastErr}` }
      }

      db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
        ['bulk_tag_added', 'client', client.id, `Bulk-tagged "${tag}" from sheet (${sheetName})`])

      report.push({
        sheet_name: sheetName,
        hub_client_id: client.id,
        hub_name: `${client.first_name} ${client.last_name}`,
        matched: true,
        action: 'tagged',
        sierra: sierraResult,
      })
    }

    res.json({
      total_filtered: filtered.length,
      matched,
      already_tagged: alreadyTagged,
      pushed_to_sierra: pushed,
      sierra_failed: sierraFailed,
      no_match: filtered.length - matched,
      dry_run: !!dry_run,
      report,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Search Sierra by name/email/phone — useful when a lead "should be there but isn't"
// to confirm whether the lead exists in Sierra at all. Returns a compact result.
router.get('/find-lead', async (req, res) => {
  const q = (req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'q parameter required (name/email/phone)' })
  try {
    // Sierra supports nameLikeFilter / emailFilter / phoneFilter on /leads/find
    const isEmail = /@/.test(q)
    const isPhone = /^[\d\-\+\(\)\s]+$/.test(q)
    const params = { pageSize: 20, pageNumber: 1 }
    if (isEmail) params.emailFilter = q
    else if (isPhone) params.phoneFilter = q.replace(/\D/g, '')
    else params.nameLikeFilter = q
    const data = await sierraGet('/leads/find', params)
    const responseData = data.data || data
    const leads = responseData.leads || []
    const localBySierraId = {}
    if (leads.length) {
      const ids = leads.map(l => String(l.id))
      const placeholders = ids.map(() => '?').join(',')
      const rows = db.all(`SELECT id, sierra_lead_id, first_name, last_name, status FROM clients WHERE sierra_lead_id IN (${placeholders})`, ids)
      for (const r of rows) localBySierraId[r.sierra_lead_id] = r
    }
    const results = leads.map(l => ({
      sierra_id: l.id,
      name: `${l.firstName || ''} ${l.lastName || ''}`.trim(),
      email: l.email,
      phone: l.phone,
      status: l.leadStatus,
      creation_date: l.creationDate,
      update_date: l.updateDate,
      in_hub: !!localBySierraId[String(l.id)],
      hub_status: localBySierraId[String(l.id)]?.status,
      hub_client_id: localBySierraId[String(l.id)]?.id,
    }))
    res.json({ query: q, count: results.length, results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
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
