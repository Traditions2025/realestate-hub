// Shared helpers for processing Sierra leads (used by sync, scheduler, webhooks)
import db from './database.js'

const n = (v) => v === undefined || v === '' ? null : v

export function mapStatus(sierraStatus) {
  if (!sierraStatus) return 'active'
  return sierraStatus.toLowerCase().replace(/\s+/g, '_')
}

export function extractRealistScore(lead) {
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

export function gradeFromRealistScore(scoreStr) {
  if (!scoreStr) return null
  const num = parseInt(scoreStr, 10)
  if (!isNaN(num)) {
    if (num >= 800) return 'A+'
    if (num >= 700) return 'A'
    if (num >= 650) return 'B'
    if (num >= 600) return 'C'
    if (num >= 500) return 'D'
    return 'F'
  }
  if (scoreStr.includes('800')) return 'A+'
  if (scoreStr.includes('700')) return 'A'
  if (scoreStr.includes('650')) return 'B'
  if (scoreStr.includes('600')) return 'C'
  if (scoreStr.includes('500')) return 'D'
  return 'F'
}

// Normalize Sierra tags to clean string array
function normalizeTags(rawTags) {
  if (!rawTags) return []
  if (!Array.isArray(rawTags)) return []
  return rawTags
    .map(t => typeof t === 'string' ? t : (t.name || t.tag || ''))
    .filter(Boolean)
}

export function processLead(lead, sierraStatusOverride) {
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

  const actualStatus = lead.leadStatus || sierraStatusOverride
  const clientStatus = mapStatus(actualStatus)

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
    } else {
      budgetMin = search.minPrice || search.priceMin || null
      budgetMax = search.maxPrice || search.priceMax || null
    }
  }

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
  const tags = normalizeTags(lead.tags)
  const tagsStr = tags.length ? JSON.stringify(tags) : null
  const lenderName = lead.lender && lead.lender.agentUserId > 0
    ? `${lead.lender.agentUserFirstName} ${lead.lender.agentUserLastName}`.trim()
    : null
  const lenderStatus = n(lead.lenderStatus)
  const listingAgentStatus = n(lead.listingAgentStatus)

  const existing = db.get('SELECT id FROM clients WHERE sierra_lead_id = ?', [sierraId])
  if (existing) {
    db.run(`UPDATE clients SET first_name=?, last_name=?, email=?, phone=?,
      source=?, address=?, city=?, state=?, zip=?, type=?,
      budget_min=?, budget_max=?, agent_assigned=?, status=?,
      lead_score=?, lead_grade=?, visits=?, email_status=?, phone_status=?,
      sierra_update_date=?, sierra_creation_date=?, pond_id=?,
      marketing_email_opt_out=?, text_opt_out=?, ealert_opt_out=?, short_summary=?,
      tags=?, lender_name=?, lender_status=?, listing_agent_status=?,
      updated_at=datetime('now') WHERE id=?`,
      [firstName, lastName, email, phone, source, address, city, state, zip,
        type, budgetMin, budgetMax, agentAssigned, clientStatus,
        leadScore, leadGrade, visits, emailStatus, phoneStatus,
        sierraUpdateDate, sierraCreationDate, pondId,
        meOptOut, textOptOut, ealertOptOut, shortSummary,
        tagsStr, lenderName, lenderStatus, listingAgentStatus, existing.id])
    return 'updated'
  } else {
    db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
      source, agent_assigned, address, city, state, zip, budget_min, budget_max,
      sierra_lead_id, lead_score, lead_grade, visits, email_status, phone_status,
      sierra_update_date, sierra_creation_date, pond_id,
      marketing_email_opt_out, text_opt_out, ealert_opt_out, short_summary,
      tags, lender_name, lender_status, listing_agent_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firstName, lastName, email, phone, type, clientStatus, source,
        agentAssigned, address, city, state, zip, budgetMin, budgetMax,
        sierraId, leadScore, leadGrade, visits, emailStatus, phoneStatus,
        sierraUpdateDate, sierraCreationDate, pondId,
        meOptOut, textOptOut, ealertOptOut, shortSummary,
        tagsStr, lenderName, lenderStatus, listingAgentStatus])
    return 'added'
  }
}

const SIERRA_API_KEY = process.env.SIERRA_API_KEY || 'b97e3302-1985-46a4-9032-cb92e5cb3dd8'
const SIERRA_API_URL = 'https://api.sierrainteractivedev.com'

export async function sierraGet(endpoint, params = {}) {
  const url = new URL(`${SIERRA_API_URL}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const resp = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json', 'Sierra-ApiKey': SIERRA_API_KEY }
  })
  if (!resp.ok) throw new Error(`Sierra API ${resp.status}: ${resp.statusText}`)
  return resp.json()
}

export async function sierraPost(endpoint, data) {
  const resp = await fetch(`${SIERRA_API_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sierra-ApiKey': SIERRA_API_KEY },
    body: JSON.stringify(data),
  })
  if (!resp.ok) throw new Error(`Sierra API ${resp.status}: ${resp.statusText}`)
  return resp.json()
}

export async function sierraDelete(endpoint) {
  const resp = await fetch(`${SIERRA_API_URL}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Sierra-ApiKey': SIERRA_API_KEY },
  })
  if (!resp.ok) throw new Error(`Sierra API ${resp.status}: ${resp.statusText}`)
  return resp.text()
}
