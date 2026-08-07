import { Router } from 'express'
import db from '../database.js'
import { stopSequencesForClient, isStopStatus, activeSequencesForClient } from '../lead-sequences.js'

const router = Router()

// sql.js doesn't accept undefined, convert to null
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

// Get counts per status for tabs
router.get('/status-counts', (req, res) => {
  const rows = db.all(`SELECT status, COUNT(*) as count FROM clients
    WHERE status IS NOT NULL AND status != ''
    GROUP BY status ORDER BY count DESC`)
  res.json(rows)
})

// Get just the IDs matching a filter (for "select all" mass actions)
// By default returns ALL matching IDs regardless of email/opt-out status.
// Pass ?email_ready=1 to only return clients with valid email + not opted out (for bulk email button).
router.get('/ids', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10000, 50000)
  const filterInput = { ...req.query }
  if (req.query.email_ready === '1' || req.query.email_ready === 'true') {
    filterInput.has_email = '1'
    filterInput.exclude_optouts = '1'
  }
  const { where, params } = buildClientFilter(filterInput)
  const ids = db.all(`SELECT id FROM clients${where} ORDER BY updated_at DESC LIMIT ?`,
    [...params, limit]).map(r => r.id)
  res.json({ ids, count: ids.length })
})

// Lightweight breakdown - just counts, no rows
router.get('/breakdown', (req, res) => {
  const total = db.get('SELECT COUNT(*) as c FROM clients').c
  const buyers = db.get("SELECT COUNT(*) as c FROM clients WHERE type IN ('buyer','both')").c
  const sellers = db.get("SELECT COUNT(*) as c FROM clients WHERE type IN ('seller','both')").c
  res.json({ total, buyers, sellers })
})

// Build the WHERE clause + params from query/body filters
export function buildClientFilter(q) {
  let where = ' WHERE 1=1'
  const params = []

  // Type filter: 'buyer' / 'seller' includes 'both' (clients flagged as both buyer & seller match either filter)
  if (q.type === 'buyer') {
    where += " AND type IN ('buyer', 'both')"
  } else if (q.type === 'seller') {
    where += " AND type IN ('seller', 'both')"
  } else if (q.type === 'both') {
    where += " AND type = 'both'"
  } else if (q.type) {
    where += ' AND type = ?'; params.push(q.type)
  }

  // Single status (legacy)
  if (q.status) { where += ' AND status = ?'; params.push(q.status) }

  // Multi-status include/exclude
  if (q.statuses_include) {
    const arr = Array.isArray(q.statuses_include) ? q.statuses_include : q.statuses_include.split(',').filter(Boolean)
    if (arr.length) {
      where += ' AND status IN (' + arr.map(() => '?').join(',') + ')'
      params.push(...arr)
    }
  }
  if (q.statuses_exclude) {
    const arr = Array.isArray(q.statuses_exclude) ? q.statuses_exclude : q.statuses_exclude.split(',').filter(Boolean)
    if (arr.length) {
      where += ' AND (status IS NULL OR status NOT IN (' + arr.map(() => '?').join(',') + '))'
      params.push(...arr)
    }
  }

  // Tags include - lead must have ANY of these tags (OR logic)
  if (q.tags_include) {
    const arr = Array.isArray(q.tags_include) ? q.tags_include : q.tags_include.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND (' + arr.map(() => 'tags LIKE ?').join(' OR ') + ')'
      arr.forEach(tag => params.push(`%"${tag}"%`))
    }
  }
  // Tags exclude - lead must NOT have any of these tags
  if (q.tags_exclude) {
    const arr = Array.isArray(q.tags_exclude) ? q.tags_exclude : q.tags_exclude.split(',').map(s => s.trim()).filter(Boolean)
    for (const tag of arr) {
      where += ' AND (tags IS NULL OR tags NOT LIKE ?)'
      params.push(`%"${tag}"%`)
    }
  }

  // Zip include/exclude
  if (q.zips_include) {
    const arr = Array.isArray(q.zips_include) ? q.zips_include : q.zips_include.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND zip IN (' + arr.map(() => '?').join(',') + ')'
      params.push(...arr)
    }
  }
  if (q.zips_exclude) {
    const arr = Array.isArray(q.zips_exclude) ? q.zips_exclude : q.zips_exclude.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND (zip IS NULL OR zip NOT IN (' + arr.map(() => '?').join(',') + '))'
      params.push(...arr)
    }
  }

  // City include/exclude
  if (q.cities_include) {
    const arr = Array.isArray(q.cities_include) ? q.cities_include : q.cities_include.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND city IN (' + arr.map(() => '?').join(',') + ')'
      params.push(...arr)
    }
  }

  // Viewed-cities include ("where they're looking" — from FUB property views).
  // fub_viewed_cities is a comma-joined string, so match ANY requested city as a substring.
  if (q.viewed_cities_include) {
    const arr = Array.isArray(q.viewed_cities_include) ? q.viewed_cities_include : q.viewed_cities_include.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND (' + arr.map(() => 'fub_viewed_cities LIKE ?').join(' OR ') + ')'
      arr.forEach(c => params.push(`%${c}%`))
    }
  }

  // Source include/exclude
  if (q.sources_include) {
    const arr = Array.isArray(q.sources_include) ? q.sources_include : q.sources_include.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND source IN (' + arr.map(() => '?').join(',') + ')'
      params.push(...arr)
    }
  }
  if (q.sources_exclude) {
    const arr = Array.isArray(q.sources_exclude) ? q.sources_exclude : q.sources_exclude.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      where += ' AND (source IS NULL OR source NOT IN (' + arr.map(() => '?').join(',') + '))'
      params.push(...arr)
    }
  }

  // Has email / has phone
  if (q.has_email === '1' || q.has_email === 'true') where += " AND email IS NOT NULL AND email != ''"
  if (q.has_phone === '1' || q.has_phone === 'true') where += " AND phone IS NOT NULL AND phone != ''"
  if (q.exclude_optouts === '1' || q.exclude_optouts === 'true') {
    where += ' AND (marketing_email_opt_out IS NULL OR marketing_email_opt_out = 0)'
  }

  // Email status filter
  if (q.email_statuses) {
    const arr = Array.isArray(q.email_statuses) ? q.email_statuses : q.email_statuses.split(',').filter(Boolean)
    if (arr.length) {
      where += ' AND email_status IN (' + arr.map(() => '?').join(',') + ')'
      params.push(...arr)
    }
  }

  // Lead score min/max
  if (q.score_min) {
    where += ' AND CAST(lead_score AS INTEGER) >= ?'
    params.push(Number(q.score_min))
  }
  if (q.score_max) {
    where += ' AND CAST(lead_score AS INTEGER) <= ?'
    params.push(Number(q.score_max))
  }

  // Visits min/max
  if (q.visits_min) {
    where += ' AND visits >= ?'
    params.push(Number(q.visits_min))
  }
  if (q.visits_max) {
    where += ' AND visits <= ?'
    params.push(Number(q.visits_max))
  }

  // Activity date filters - "active in past N days"
  if (q.activity_days) {
    where += " AND sierra_update_date IS NOT NULL AND sierra_update_date >= datetime('now', ?)"
    params.push(`-${Number(q.activity_days)} days`)
  }
  // Created in past N days (new leads)
  if (q.created_days) {
    where += " AND sierra_creation_date IS NOT NULL AND sierra_creation_date >= datetime('now', ?)"
    params.push(`-${Number(q.created_days)} days`)
  }
  // Inactive for N+ days (need re-engagement)
  if (q.inactive_days) {
    where += " AND (sierra_update_date IS NULL OR sierra_update_date < datetime('now', ?))"
    params.push(`-${Number(q.inactive_days)} days`)
  }

  // FUB listing-activity filters (property/listing views from Follow Up Boss).
  // Only clients who have viewed listings.
  if (q.has_listing_views === '1' || q.has_listing_views === 'true') {
    where += " AND last_fub_activity_at IS NOT NULL AND last_fub_activity_at != ''"
  }
  // Actually viewed properties: N+ distinct listings (from stored FUB property views).
  // Stricter than has_listing_views — guarantees the lead has homes to show.
  if (q.properties_viewed_min) {
    where += " AND (SELECT COUNT(DISTINCT prop_mls) FROM fub_activity fa WHERE fa.client_id = clients.id AND fa.prop_mls IS NOT NULL AND fa.prop_mls != '') >= ?"
    params.push(Number(q.properties_viewed_min))
  }
  // Last listing visit at LEAST N days ago (e.g. 90+ => older, cold).
  if (q.fub_days_min) {
    where += " AND last_fub_activity_at IS NOT NULL AND last_fub_activity_at <= datetime('now', ?)"
    params.push(`-${Number(q.fub_days_min)} days`)
  }
  // Last listing visit at MOST N days ago (e.g. within 30 => recent, hot).
  if (q.fub_days_max) {
    where += " AND last_fub_activity_at IS NOT NULL AND last_fub_activity_at >= datetime('now', ?)"
    params.push(`-${Number(q.fub_days_max)} days`)
  }

  // ---- Property criteria filters (from saved search) ----
  // "Looking for price ≥ X" — the lead's price ceiling has to allow X
  if (q.search_price_at_least) {
    where += ' AND search_price_max IS NOT NULL AND search_price_max >= ?'
    params.push(Number(q.search_price_at_least))
  }
  // "Looking for price ≤ X" — the lead's price floor has to allow X
  if (q.search_price_at_most) {
    where += ' AND (search_price_min IS NULL OR search_price_min <= ?)'
    params.push(Number(q.search_price_at_most))
  }
  // Lead is willing to pay at least this much (their max ≥ value)
  if (q.search_max_price_min) {
    where += ' AND search_price_max >= ?'
    params.push(Number(q.search_max_price_min))
  }
  if (q.search_max_price_max) {
    where += ' AND search_price_max <= ?'
    params.push(Number(q.search_max_price_max))
  }
  // Beds/baths/sqft minimums the lead is looking for
  if (q.search_beds_min) {
    where += ' AND search_beds_min >= ?'
    params.push(Number(q.search_beds_min))
  }
  if (q.search_beds_max) {
    where += ' AND search_beds_min <= ?'
    params.push(Number(q.search_beds_max))
  }
  if (q.search_baths_min) {
    where += ' AND search_baths_min >= ?'
    params.push(Number(q.search_baths_min))
  }
  if (q.search_sqft_min) {
    where += ' AND search_sqft_min >= ?'
    params.push(Number(q.search_sqft_min))
  }
  // Has at least one saved search
  if (q.has_saved_search === '1') {
    where += ' AND has_saved_search = 1'
  }

  // ---- Realist enrichment filters ----
  if (q.realist_value_min) {
    where += ' AND realist_market_value >= ?'
    params.push(Number(q.realist_value_min))
  }
  if (q.realist_value_max) {
    where += ' AND realist_market_value <= ?'
    params.push(Number(q.realist_value_max))
  }
  if (q.realist_year_built_min) {
    where += ' AND realist_year_built >= ?'
    params.push(Number(q.realist_year_built_min))
  }
  if (q.realist_year_built_max) {
    where += ' AND realist_year_built <= ?'
    params.push(Number(q.realist_year_built_max))
  }
  if (q.realist_sell_score_min) {
    where += ' AND realist_sell_score >= ?'
    params.push(Number(q.realist_sell_score_min))
  }
  if (q.realist_owner_occupied === '1') {
    where += ' AND realist_owner_occupied = 1'
  }
  if (q.realist_owner_occupied === '0') {
    where += ' AND realist_owner_occupied = 0'
  }
  if (q.has_realist === '1') {
    where += ' AND realist_property_id IS NOT NULL'
  }
  // Property types (any-of)
  const searchTypes = q.search_property_types
    ? (Array.isArray(q.search_property_types) ? q.search_property_types : String(q.search_property_types).split(',').filter(Boolean))
    : []
  if (searchTypes.length) {
    where += ' AND (' + searchTypes.map(() => 'search_property_types LIKE ?').join(' OR ') + ')'
    searchTypes.forEach(t => params.push(`%"${t}"%`))
  }
  // Regions (any-of)
  const searchRegions = q.search_regions
    ? (Array.isArray(q.search_regions) ? q.search_regions : String(q.search_regions).split(',').filter(Boolean))
    : []
  if (searchRegions.length) {
    where += ' AND (' + searchRegions.map(() => 'search_regions LIKE ?').join(' OR ') + ')'
    searchRegions.forEach(r => params.push(`%${r}%`))
  }

  // Search
  if (q.search) {
    where += ` AND (first_name LIKE ? OR last_name LIKE ?
      OR (first_name || ' ' || last_name) LIKE ?
      OR email LIKE ? OR phone LIKE ?
      OR address LIKE ? OR city LIKE ? OR zip LIKE ?
      OR source LIKE ? OR agent_assigned LIKE ?)`
    const term = `%${q.search}%`
    params.push(term, term, term, term, term, term, term, term, term, term)
  }

  return { where, params }
}

// Map sort key to SQL ORDER BY
const SORT_OPTIONS = {
  recent_activity: 'sierra_update_date DESC NULLS LAST',
  recent_added: 'sierra_creation_date DESC NULLS LAST',
  most_visits: 'visits DESC',
  least_visits: 'visits ASC',
  highest_score: 'CAST(lead_score AS INTEGER) DESC NULLS LAST',
  lowest_score: 'CAST(lead_score AS INTEGER) ASC NULLS LAST',
  name_az: 'last_name ASC, first_name ASC',
  name_za: 'last_name DESC, first_name DESC',
  recent_update: 'updated_at DESC',
  oldest_first: 'sierra_creation_date ASC NULLS LAST',
  // Follow Up Boss last web visit (most/least active)
  recent_fub_visit: 'last_fub_activity_at DESC NULLS LAST',
  oldest_fub_visit: 'last_fub_activity_at ASC NULLS LAST',
  // Realist enrichment sorts
  highest_value: 'realist_market_value DESC NULLS LAST',
  lowest_value: 'realist_market_value ASC NULLS LAST',
  highest_sell_score: 'realist_sell_score DESC NULLS LAST',
  lowest_sell_score: 'realist_sell_score ASC NULLS LAST',
  newest_built: 'realist_year_built DESC NULLS LAST',
  oldest_built: 'realist_year_built ASC NULLS LAST',
  highest_last_sale: 'realist_last_sale_price DESC NULLS LAST',
  // Hub-tracked site activity (last 14 days). Uses a correlated subquery
  // against lead_activity; with the index on (client_id, created_at) this
  // is acceptable for the typical clients page size.
  hub_activity: "(SELECT COUNT(*) FROM lead_activity la WHERE la.client_id = clients.id AND la.created_at >= datetime('now','-14 days')) DESC, sierra_update_date DESC NULLS LAST",
}

router.get('/', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 5000)
  const offset = Number(req.query.offset) || 0
  const { where, params } = buildClientFilter(req.query)

  const sortKey = req.query.sort || 'recent_activity'
  const orderBy = SORT_OPTIONS[sortKey] || SORT_OPTIONS.recent_activity

  const total = db.get(`SELECT COUNT(*) as c FROM clients${where}`, params).c
  const rows = db.all(`SELECT * FROM clients${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [...params, limit, offset])

  res.set('X-Total-Count', String(total))
  res.set('X-Page-Limit', String(limit))
  res.set('X-Page-Offset', String(offset))
  res.json(rows)
})

// Get distinct values for filter dropdowns (zips, cities, sources)
router.get('/filter-options', (req, res) => {
  const zips = db.all("SELECT DISTINCT zip FROM clients WHERE zip IS NOT NULL AND zip != '' ORDER BY zip").map(r => r.zip)
  const cities = db.all("SELECT DISTINCT city FROM clients WHERE city IS NOT NULL AND city != '' ORDER BY city").map(r => r.city)
  const sources = db.all("SELECT DISTINCT source FROM clients WHERE source IS NOT NULL AND source != '' ORDER BY source").map(r => r.source)
  // Get popular tags
  const allTagsRows = db.all("SELECT tags FROM clients WHERE tags IS NOT NULL AND tags != ''")
  const tagCounts = {}
  for (const row of allTagsRows) {
    try {
      const parsed = JSON.parse(row.tags)
      for (const t of parsed) tagCounts[t] = (tagCounts[t] || 0) + 1
    } catch {}
  }
  // Return ALL tags so user can search/filter accurately
  const tags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).map(([t, c]) => ({ tag: t, count: c }))
  // Distinct "viewed cities" (where leads are looking, from FUB) — split the comma-joined field
  const viewedCounts = {}
  for (const row of db.all("SELECT fub_viewed_cities FROM clients WHERE fub_viewed_cities IS NOT NULL AND fub_viewed_cities != ''")) {
    for (const c of String(row.fub_viewed_cities).split(',').map(s => s.trim()).filter(Boolean)) {
      viewedCounts[c] = (viewedCounts[c] || 0) + 1
    }
  }
  const viewed_cities = Object.entries(viewedCounts).sort((a, b) => b[1] - a[1]).map(([c]) => c)
  res.json({ zips, cities, sources, tags, viewed_cities })
})

router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT * FROM clients WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Not found' })

  const transactions = db.all('SELECT * FROM transactions WHERE client_id = ? ORDER BY updated_at DESC', [id])
  const showings = db.all('SELECT * FROM showings WHERE client_id = ? ORDER BY showing_date DESC', [id])
  const tasks = db.all("SELECT * FROM tasks WHERE related_type = 'client' AND related_id = ? ORDER BY due_date ASC", [id])
  const notes = db.all("SELECT * FROM notes WHERE related_type = 'client' AND related_id = ? ORDER BY created_at DESC", [id])

  res.json({ ...row, transactions, showings, tasks, notes })
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
    source, agent_assigned, address, city, budget_min, budget_max, preapproval_amount,
    preapproval_lender, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.first_name, b.last_name, n(b.email), n(b.phone), b.type, b.status || 'active', n(b.source),
      n(b.agent_assigned), n(b.address), n(b.city), n(b.budget_min), n(b.budget_max), n(b.preapproval_amount),
      n(b.preapproval_lender), n(b.notes)])

  logActivity('created', 'client', result.lastInsertRowid, `New ${b.type}: ${b.first_name} ${b.last_name}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE clients SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'client', Number(req.params.id), 'Updated client')

  // Moving a lead to a stop status (Junk) pulls it out of every active drip
  // + automation so no further emails/texts fire.
  if (fields.status && isStopStatus(fields.status)) {
    const r = stopSequencesForClient(Number(req.params.id), `lead marked ${fields.status}`)
    if (r.drips || r.automations) {
      logActivity('sequences_stopped', 'client', Number(req.params.id),
        `Removed from ${r.drips} drip(s) + ${r.automations} automation(s) — status ${fields.status}`)
    }
  }
  res.json({ success: true })
})

// Active plans (drips + automations) currently running for this lead — powers
// the "Active Plans" section on the lead profile.
router.get('/:id/sequences', (req, res) => {
  res.json(activeSequencesForClient(Number(req.params.id)))
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM clients WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'client', Number(req.params.id), 'Deleted client')
  res.json({ success: true })
})

// Bulk type update — set type for multiple clients at once
router.post('/bulk-type', (req, res) => {
  const { ids, type } = req.body || {}
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' })
  if (!['buyer', 'seller', 'both'].includes(type)) return res.status(400).json({ error: 'type must be buyer, seller, or both' })

  const now = new Date().toISOString()
  db.beginBulk?.()
  try {
    const placeholders = ids.map(() => '?').join(',')
    db.run(`UPDATE clients SET type = ?, updated_at = ? WHERE id IN (${placeholders})`,
      [type, now, ...ids.map(Number)])
    logActivity('bulk_type', 'client', 0, `Set ${ids.length} client${ids.length === 1 ? '' : 's'} as ${type}`)
  } finally {
    db.endBulk?.()
  }
  res.json({ success: true, updated: ids.length, type })
})

export default router
