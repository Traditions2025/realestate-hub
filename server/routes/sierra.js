import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

const SIERRA_API_KEY = process.env.SIERRA_API_KEY || 'b97e3302-1985-46a4-9032-cb92e5cb3dd8'
const SIERRA_API_URL = 'https://api.sierrainteractivedev.com'

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

// Pull Active + Prime leads from Sierra and sync to clients table
router.post('/sync', async (req, res) => {
  try {
    let totalSynced = 0
    let totalAdded = 0
    let totalUpdated = 0

    // Pull Active and Prime leads
    for (const status of ['Active', 'Prime']) {
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
          const sierraId = String(lead.id)
          const firstName = lead.firstName || ''
          const lastName = lead.lastName || ''
          if (!firstName && !lastName) continue

          const email = n(lead.email)
          const phone = n(lead.phone)
          const source = n(lead.source)
          const address = n(lead.streetAddress || lead.address)
          const city = n(lead.city)
          const state = n(lead.state) || 'IA'
          const zip = n(lead.zip || lead.postalCode)
          const leadScore = n(lead.leadScore)
          const leadGrade = n(lead.leadGrade)

          // Map Sierra leadStatus to our client status
          const clientStatus = status === 'Prime' ? 'prime' : 'active'

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
              status=?, updated_at=datetime('now') WHERE id=?`,
              [firstName, lastName, email, phone, source, address, city, state, zip,
                type, budgetMin, budgetMax, agentAssigned, leadScore, leadGrade, clientStatus, existing.id])
            totalUpdated++
          } else {
            db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
              source, agent_assigned, address, city, state, zip, budget_min, budget_max,
              sierra_lead_id, lead_score, lead_grade)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [firstName, lastName, email, phone, type, clientStatus, source,
                agentAssigned, address, city, state, zip, budgetMin, budgetMax,
                sierraId, leadScore, leadGrade])
            totalAdded++
          }
          totalSynced++
        }

        const totalPages = responseData.totalPages || 1
        if (page >= totalPages) hasMore = false
        else page++
      }
    }

    // Log the sync
    db.run('INSERT INTO sierra_sync_log (sync_type, leads_synced, leads_added, leads_updated) VALUES (?,?,?,?)',
      ['active_leads', totalSynced, totalAdded, totalUpdated])

    db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
      ['synced', 'sierra', `Sierra sync: ${totalSynced} leads (${totalAdded} new, ${totalUpdated} updated)`])

    res.json({
      success: true,
      total_synced: totalSynced,
      added: totalAdded,
      updated: totalUpdated,
    })
  } catch (err) {
    db.run('INSERT INTO sierra_sync_log (sync_type, errors) VALUES (?,?)',
      ['active_leads', err.message])
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
