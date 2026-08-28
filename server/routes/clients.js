import { Router } from 'express'
import crypto from 'crypto'
import db from '../database.js'
import { stopSequencesForClient, isStopStatus, activeSequencesForClient } from '../lead-sequences.js'
import { gradeFromRealistScore } from '../sierra-helper.js'
import { fubGet, fubConfigured } from '../fub-helper.js'

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
  // Hide records that were merged into another client (kept for history, not shown).
  if (!q.include_merged) where += ' AND merged_into IS NULL'

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

  // Assigned agent include/exclude. Use the sentinel '__unassigned__' to match leads with no agent.
  if (q.agents_include) {
    const arr = Array.isArray(q.agents_include) ? q.agents_include : q.agents_include.split(',').map(s => s.trim()).filter(Boolean)
    if (arr.length) {
      const named = arr.filter(a => a !== '__unassigned__'), parts = []
      if (named.length) { parts.push('agent_assigned IN (' + named.map(() => '?').join(',') + ')'); params.push(...named) }
      if (arr.includes('__unassigned__')) parts.push("(agent_assigned IS NULL OR TRIM(agent_assigned) = '')")
      if (parts.length) where += ' AND (' + parts.join(' OR ') + ')'
    }
  }
  if (q.agents_exclude) {
    const arr = Array.isArray(q.agents_exclude) ? q.agents_exclude : q.agents_exclude.split(',').map(s => s.trim()).filter(Boolean)
    const named = arr.filter(a => a !== '__unassigned__')
    if (named.length) { where += ' AND (agent_assigned IS NULL OR agent_assigned NOT IN (' + named.map(() => '?').join(',') + '))'; params.push(...named) }
    if (arr.includes('__unassigned__')) where += " AND agent_assigned IS NOT NULL AND TRIM(agent_assigned) != ''"
  }

  // Has email / has phone (with / without)
  if (q.has_email === '1' || q.has_email === 'true') where += " AND email IS NOT NULL AND TRIM(email) != ''"
  else if (q.has_email === '0') where += " AND (email IS NULL OR TRIM(email) = '')"
  if (q.has_phone === '1' || q.has_phone === 'true') where += " AND phone IS NOT NULL AND TRIM(phone) != ''"
  else if (q.has_phone === '0') where += " AND (phone IS NULL OR TRIM(phone) = '')"
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

  // ---- Drip campaign enrollment filters ----
  // in_drip = '1' -> only leads currently enrolled in an ACTIVE drip
  // in_drip = '0' -> only leads NOT in any active drip
  // drip_id (optional) -> scope the include/exclude to one specific campaign
  if (q.in_drip === '1' || q.in_drip === 'true') {
    where += " AND EXISTS (SELECT 1 FROM drip_enrollments de WHERE de.client_id = clients.id AND de.status = 'active'"
    if (q.drip_id) { where += ' AND de.drip_id = ?'; params.push(Number(q.drip_id)) }
    where += ')'
  } else if (q.in_drip === '0' || q.in_drip === 'false') {
    where += " AND NOT EXISTS (SELECT 1 FROM drip_enrollments de WHERE de.client_id = clients.id AND de.status = 'active'"
    if (q.drip_id) { where += ' AND de.drip_id = ?'; params.push(Number(q.drip_id)) }
    where += ')'
  }

  // Address present / absent
  if (q.has_address === '1') {
    where += " AND address IS NOT NULL AND TRIM(address) != ''"
  } else if (q.has_address === '0') {
    where += " AND (address IS NULL OR TRIM(address) = '')"
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
  // FSBO master file: only clients carrying an fsbo_status (Available / Off Market).
  if (q.has_fsbo_status === '1' || q.has_fsbo_status === 1 || q.has_fsbo_status === true) {
    where += " AND fsbo_status IS NOT NULL AND fsbo_status != ''"
  }
  const fsboStatuses = q.fsbo_statuses_include
    ? (Array.isArray(q.fsbo_statuses_include) ? q.fsbo_statuses_include : String(q.fsbo_statuses_include).split(',').filter(Boolean))
    : []
  if (fsboStatuses.length) {
    where += ' AND fsbo_status IN (' + fsboStatuses.map(() => '?').join(',') + ')'
    fsboStatuses.forEach(s => params.push(s))
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

  // Last outgoing email / text recency. op 'less' = sent within N days; 'more' = NOT sent in
  // the last N days (last was longer ago, or never). Uses the communications feed.
  const recency = (channel, op, days) => {
    const n = Math.floor(Number(days))
    if (!['more', 'less'].includes(op) || !(n > 0)) return
    const sub = `EXISTS (SELECT 1 FROM communications co WHERE co.client_id=clients.id AND co.channel='${channel}' AND co.direction='outgoing' AND co.occurred_at >= datetime('now','-${n} days'))`
    where += op === 'less' ? ` AND ${sub}` : ` AND NOT ${sub}`
  }
  recency('email', q.last_email_op, q.last_email_days)
  recency('text', q.last_text_op, q.last_text_days)

  // Off Market Date recency (cancelled/expired): went off market more/less than N days ago.
  if (['more', 'less'].includes(q.off_market_op)) {
    const n = Math.floor(Number(q.off_market_days))
    if (n > 0) {
      where += q.off_market_op === 'more'
        ? ` AND off_market_date IS NOT NULL AND off_market_date != '' AND date(off_market_date) <= date('now','-${n} days')`
        : ` AND off_market_date IS NOT NULL AND off_market_date != '' AND date(off_market_date) >= date('now','-${n} days')`
    }
  }

  // AI Applied: has the AI been applied to this lead (enrolled/managed, or it has sent an AI
  // text). 'yes' = applied, 'no' = never touched by the AI.
  if (q.ai_applied === 'yes' || q.ai_applied === 'no') {
    const sub = `(EXISTS (SELECT 1 FROM ai_lead_state s WHERE s.client_id=clients.id AND s.ai_managed=1) OR EXISTS (SELECT 1 FROM communications co WHERE co.client_id=clients.id AND co.sent_by_type IN ('ai','fsbo_ai')))`
    where += q.ai_applied === 'yes' ? ` AND ${sub}` : ` AND NOT ${sub}`
  }

  return { where, params }
}

// Map sort key to SQL ORDER BY
const SORT_OPTIONS = {
  recent_activity: 'sierra_update_date DESC NULLS LAST',
  recent_added: "COALESCE(NULLIF(register_date,''), sierra_creation_date) DESC NULLS LAST",
  most_visits: 'visits DESC',
  least_visits: 'visits ASC',
  fsbo_available_first: "CASE fsbo_status WHEN 'Available' THEN 0 WHEN 'Off Market' THEN 1 ELSE 2 END ASC, updated_at DESC",
  fsbo_offmarket_first: "CASE fsbo_status WHEN 'Off Market' THEN 0 WHEN 'Available' THEN 1 ELSE 2 END ASC, updated_at DESC",
  fsbo_dom_high: 'CAST(fsbo_dom AS INTEGER) DESC NULLS LAST',
  fsbo_dom_low: 'CAST(fsbo_dom AS INTEGER) ASC NULLS LAST',
  highest_score: 'CAST(lead_score AS INTEGER) DESC NULLS LAST',
  lowest_score: 'CAST(lead_score AS INTEGER) ASC NULLS LAST',
  off_market_recent: "date(off_market_date) DESC NULLS LAST",
  off_market_oldest: "date(off_market_date) ASC NULLS LAST",
  name_az: 'last_name ASC, first_name ASC',
  name_za: 'last_name DESC, first_name DESC',
  recent_update: 'updated_at DESC',
  oldest_first: "COALESCE(NULLIF(register_date,''), sierra_creation_date) ASC NULLS LAST",
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

// ---- P2-5: duplicate detection + safe merge ----
// Find likely duplicate clients grouped by normalized phone (last 10) or exact name+zip.
// READ-ONLY audit: which 'new' leads look like an existing Past Client (status='closed'
// or tagged "past client") by phone / email / address / name? Reports only; changes nothing.
router.get('/audit/new-vs-past', (req, res) => {
  const normName = (f, l) => `${f || ''} ${l || ''}`.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\b[a-z]\b/g, ' ').replace(/\s+/g, ' ').trim()
  const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
  const normEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return (!s || s.includes('notvalidemail.com')) ? '' : s }
  const normAddr = (a) => { let s = String(a || '').toLowerCase().split(',')[0].replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); return (/\d/.test(s) && s.replace(/\d/g, '').trim().length >= 4) ? s : '' }
  // A GENUINE past-client tag is any "past client" tag EXCEPT the automation-noise
  // "Past Client Unsubscribed to E-Alerts" (created by an e-alert unsubscribe automation,
  // not a real past client). CavesservicesLLC tags ARE genuine (Hunter's past clients).
  const isGenuinePC = (tagsStr) => String(tagsStr || '').split(',').some(t => { const x = t.toLowerCase(); return x.includes('past client') && !x.includes('unsubscribed') })
  const past = db.all("SELECT id, first_name, last_name, phone, email, address, status, tags FROM clients WHERE lower(status)='closed' OR lower(coalesce(tags,'')) LIKE '%past client%'")
    .filter(p => String(p.status || '').toLowerCase() === 'closed' || isGenuinePC(p.tags))
  // Recs carry their normalized keys so we can score field overlap PER past record
  // (name+address to the SAME record = same person; name to one + address to another = noise).
  const recs = past.map(p => ({ id: p.id, name: `${p.first_name || ''} ${p.last_name || ''}`.trim(), status: p.status,
    nk: normName(p.first_name, p.last_name), pk: normPhone(p.phone), ek: normEmail(p.email), ak: normAddr(p.address) }))
  const byName = new Map(), byPhone = new Map(), byEmail = new Map(), byAddr = new Map()
  const add = (map, k, r) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(r) }
  for (const r of recs) { add(byName, r.nk, r); add(byPhone, r.pk, r); add(byEmail, r.ek, r); add(byAddr, r.ak, r) }

  // (A) New-status leads that carry a GENUINE past-client tag (noise tag excluded) — mis-status.
  const taggedNew = db.all("SELECT id, first_name, last_name, tags FROM clients WHERE lower(status)='new' AND lower(coalesce(tags,'')) LIKE '%past client%'")
    .filter(t => isGenuinePC(t.tags))

  const news = db.all("SELECT id, first_name, last_name, phone, email, address FROM clients WHERE lower(status)='new'")
  const high = [], weak = []
  for (const n of news) {
    const nm = normName(n.first_name, n.last_name), ph = normPhone(n.phone), em = normEmail(n.email), ad = normAddr(n.address)
    const cand = new Map()
    for (const [k, map] of [[nm, byName], [ph, byPhone], [em, byEmail], [ad, byAddr]]) if (k && map.has(k)) for (const r of map.get(k)) if (r.id !== n.id) cand.set(r.id, r)
    if (!cand.size) continue
    let best = null
    for (const r of cand.values()) {
      const f = []
      if (nm && r.nk === nm) f.push('name')
      if (ph && r.pk === ph) f.push('phone')
      if (em && r.ek === em) f.push('email')
      if (ad && r.ak === ad) f.push('address')
      if (!best || f.length > best.f.length) best = { r, f }
    }
    const f = best.f
    // Same person = email match, OR name matches the SAME record as a phone/email/address.
    const isHigh = f.includes('email') || (f.includes('name') && (f.includes('phone') || f.includes('email') || f.includes('address')))
    const row = { new_id: n.id, new_name: `${n.first_name || ''} ${n.last_name || ''}`.trim(), fields: f, past: { id: best.r.id, name: best.r.name, status: best.r.status } }
    ;(isHigh ? high : weak).push(row)
  }
  res.json({
    definition: "past = status 'closed' OR tag contains 'past client'; new = status 'new'. Fields scored per past record.",
    past_pool: recs.length, new_pool: news.length,
    tagged_in_new_count: taggedNew.length,
    tagged_in_new_sample: taggedNew.slice(0, 40).map(t => ({ id: t.id, name: `${t.first_name || ''} ${t.last_name || ''}`.trim() })),
    high_confidence_count: high.length, high_confidence_sample: high.slice(0, 60),
    weak_count: weak.length, weak_sample: weak.slice(0, 25),
  })
})

// READ-ONLY: inspect which "past client"-containing tags exist (to separate a genuine
// "Past Client" tag from automation noise like "Past Client Unsubscribed to E-Alerts").
router.get('/audit/past-client-tags', (req, res) => {
  const rows = db.all("SELECT tags FROM clients WHERE lower(coalesce(tags,'')) LIKE '%past client%'")
  const tagCounts = new Map()
  for (const r of rows) for (const t of String(r.tags || '').split(',').map(s => s.trim()).filter(Boolean)) if (t.toLowerCase().includes('past client')) tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
  const distinct = [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count)
  const taggedNew = db.all("SELECT id, first_name, last_name, tags FROM clients WHERE lower(status)='new' AND lower(coalesce(tags,'')) LIKE '%past client%'")
  const withTags = taggedNew.map(t => ({ id: t.id, name: `${t.first_name || ''} ${t.last_name || ''}`.trim(), pc_tags: String(t.tags || '').split(',').map(s => s.trim()).filter(x => x.toLowerCase().includes('past client')) }))
  res.json({ distinct_past_client_tags: distinct, tagged_in_new_count: withTags.length, tagged_in_new: withTags })
})

router.get('/duplicates', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  // Phone groups: same last-10 digits, more than one live (non-merged) client.
  // Cap the group size at 4 — a real household duplicate is 2-4 records; a number on
  // many contacts is a SHARED / brokerage / placeholder line (e.g. 555-5555) and must
  // never be merged (per the contact-cleanup rule). Also reject placeholder patterns.
  const isPlaceholder = (pk) => {
    const last7 = pk.slice(-7)
    if (/^(\d)\1{6}$/.test(last7)) return true          // all same digit
    if (last7 === '5555555' || last7 === '1234567' || last7 === '0000000') return true
    if (/5{4,}$/.test(pk)) return true                   // …5555 fake tails
    return false
  }
  const phoneRows = db.all(`
    SELECT substr(replace(replace(replace(replace(replace(phone,'(',''),')',''),'-',''),' ',''),'+',''), -10) AS pk,
           COUNT(*) n, GROUP_CONCAT(id) ids
    FROM clients
    WHERE phone IS NOT NULL AND phone != '' AND merged_into IS NULL
    GROUP BY pk HAVING n > 1 AND n <= 4 AND length(pk) = 10
    ORDER BY n DESC LIMIT ?`, [limit])
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const groups = phoneRows.filter(g => !isPlaceholder(g.pk)).map(g => {
    const ids = String(g.ids).split(',').map(Number)
    const members = db.all(`SELECT id, first_name, last_name, phone, email, address, city, status, source, type, sierra_lead_id,
      (SELECT COUNT(*) FROM communications co WHERE co.client_id=clients.id) comms
      FROM clients WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY comms DESC, id ASC`, ids)
    return { key: g.pk, match: 'phone', count: g.n, members }
  }).filter(g => {
    // Only a real duplicate if members actually look like the same person: at least two
    // share a last name OR a street address. A shared phone with all-different names is a
    // household/brokerage/shared line, never merged.
    const counts = {}
    for (const m of g.members) { const k = norm(m.last_name); if (k) counts[k] = (counts[k] || 0) + 1 }
    const sharedName = Object.values(counts).some(n => n >= 2)
    const addrs = {}
    for (const m of g.members) { const k = norm(m.address); if (k) addrs[k] = (addrs[k] || 0) + 1 }
    const sharedAddr = Object.values(addrs).some(n => n >= 2)
    return sharedName || sharedAddr
  })
  res.json({ groups, total: groups.length })
})

// Merge duplicates into a primary. Reassigns ALL child records to the primary (nothing is
// lost), fills the primary's blank fields from the dupes, then archives each dupe with a
// merged_into pointer so the merge is reversible. Never hard-deletes.
// Tags may be stored as a JSON array string (["a","b"]) or a comma list; parse either.
function parseTags(s) {
  if (!s) return []
  try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(x => String(x).trim()).filter(Boolean) } catch {}
  return String(s).split(',').map(x => x.trim().replace(/^[\[\]"']+|[\[\]"']+$/g, '').trim()).filter(Boolean)
}
// Core merge: fold dupIds into primaryId. Reassigns every child record, keeps both
// contacts (alt_emails/alt_phones), UNIONS tags, fills primary blanks, archives dups
// (merged_into pointer → reversible). The survivor keeps the PRIMARY's status + contact.
function doMerge(primaryId, dupIds, keepBoth = true) {
  const primary = db.get('SELECT * FROM clients WHERE id=?', [primaryId])
  if (!primary) return { error: 'primary not found' }
  const reassignClientId = ['communications', 'ai_actions', 'behavioral_events', 'lead_events', 'ai_handoffs', 'showings', 'transactions', 'lead_activity']
  const norm10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : d }
  const emailKeep = String(primary.email || '').trim().toLowerCase()
  const phoneKeep10 = norm10(primary.phone)
  const altEmails = new Set(String(primary.alt_emails || '').split(',').map(s => s.trim()).filter(Boolean))
  const altPhones = new Set(String(primary.alt_phones || '').split(',').map(s => s.trim()).filter(Boolean))
  const tagSet = new Set(parseTags(primary.tags))
  const merged = []
  for (const dupId of dupIds) {
    if (!dupId || dupId === primaryId) continue
    const dup = db.get('SELECT * FROM clients WHERE id=?', [dupId])
    if (!dup) continue
    for (const tbl of reassignClientId) { try { db.run(`UPDATE ${tbl} SET client_id=? WHERE client_id=?`, [primaryId, dupId]) } catch {} }
    try { db.run("UPDATE notes SET related_id=? WHERE related_type='client' AND related_id=?", [primaryId, dupId]) } catch {}
    try { db.run("UPDATE tasks SET related_id=? WHERE related_type='client' AND related_id=?", [primaryId, dupId]) } catch {}
    const fillable = ['phone', 'email', 'address', 'city', 'state', 'zip', 'source', 'agent_assigned', 'sierra_lead_id', 'lead_score', 'lead_grade', 'fsbo_status']
    const sets = [], vals = []
    for (const f of fillable) { const pv = primary[f], dv = dup[f]; if ((pv === null || pv === undefined || pv === '') && dv !== null && dv !== undefined && dv !== '') { sets.push(`${f}=?`); vals.push(dv); primary[f] = dv } }
    if (sets.length) db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id=?`, [...vals, primaryId])
    if (keepBoth) {
      for (const e of [dup.email, ...String(dup.alt_emails || '').split(',')].map(s => String(s || '').trim()).filter(Boolean)) { if (e.toLowerCase() !== emailKeep && String(primary.email || '').trim().toLowerCase() !== e.toLowerCase()) altEmails.add(e) }
      for (const p of [dup.phone, ...String(dup.alt_phones || '').split(',')].map(s => String(s || '').trim()).filter(Boolean)) { if (norm10(p) !== phoneKeep10 && norm10(p) !== norm10(primary.phone)) altPhones.add(p) }
    }
    for (const t of parseTags(dup.tags)) tagSet.add(t)   // union tags onto survivor
    // Cancel any pending AI drip actions on the record being archived (never text a merged-away lead).
    try { db.run("UPDATE ai_scheduled_actions SET state='canceled', error='merged into ' || ?, updated_at=datetime('now') WHERE client_id=? AND state='pending'", [primaryId, dupId]) } catch {}
    db.run("UPDATE clients SET status='archived', merged_into=?, updated_at=datetime('now') WHERE id=?", [primaryId, dupId])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['merged', 'client', dupId, `Merged into ${primaryId}. Snapshot: ${JSON.stringify({ id: dup.id, first_name: dup.first_name, last_name: dup.last_name, phone: dup.phone, email: dup.email, address: dup.address, status: dup.status, source: dup.source }).slice(0, 900)}`])
    merged.push(dupId)
  }
  db.run("UPDATE clients SET tags=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify([...tagSet]), primaryId])
  if (keepBoth) db.run("UPDATE clients SET alt_emails=?, alt_phones=?, updated_at=datetime('now') WHERE id=?", [[...altEmails].join(', ') || null, [...altPhones].join(', ') || null, primaryId])
  return { success: true, primary_id: primaryId, merged, count: merged.length, alt_emails: [...altEmails], alt_phones: [...altPhones], tags: [...tagSet] }
}

router.post('/merge', (req, res) => {
  const primaryId = Number(req.body?.primary_id)
  const dupIds = (Array.isArray(req.body?.duplicate_ids) ? req.body.duplicate_ids : []).map(Number).filter(x => x && x !== primaryId)
  const keepBoth = req.body?.keep_both !== false
  if (!primaryId || !dupIds.length) return res.status(400).json({ error: 'primary_id and duplicate_ids required' })
  const r = doMerge(primaryId, dupIds, keepBoth)
  if (r.error) return res.status(r.error === 'primary not found' ? 404 : 400).json(r)
  res.json(r)
})

// Group B: cluster the high-confidence New-vs-PastClient duplicates and merge each cluster
// into its PAST-CLIENT record (closed preferred, else genuine-PC-tagged). Handles chains
// (e.g. 3 Kirk Watson records -> one). dry_run:true returns the plan and changes nothing.
router.post('/merge-past-client-dups', (req, res) => {
  const dryRun = req.body?.dry_run === true
  const normName = (f, l) => `${f || ''} ${l || ''}`.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\b[a-z]\b/g, ' ').replace(/\s+/g, ' ').trim()
  const normPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
  const normEmail = (e) => { const s = String(e || '').trim().toLowerCase(); return (!s || s.includes('notvalidemail.com')) ? '' : s }
  const normAddr = (a) => { let s = String(a || '').toLowerCase().split(',')[0].replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); return (/\d/.test(s) && s.replace(/\d/g, '').trim().length >= 4) ? s : '' }
  const isGenuinePC = (tagsStr) => String(tagsStr || '').split(',').some(t => { const x = t.toLowerCase(); return x.includes('past client') && !x.includes('unsubscribed') })
  const past = db.all("SELECT id, first_name, last_name, phone, email, address, status, tags FROM clients WHERE (lower(status)='closed' OR lower(coalesce(tags,'')) LIKE '%past client%') AND merged_into IS NULL")
    .filter(p => String(p.status || '').toLowerCase() === 'closed' || isGenuinePC(p.tags))
  const recs = past.map(p => ({ id: p.id, nk: normName(p.first_name, p.last_name), pk: normPhone(p.phone), ek: normEmail(p.email), ak: normAddr(p.address) }))
  const byName = new Map(), byPhone = new Map(), byEmail = new Map(), byAddr = new Map()
  const add = (m, k, r) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(r) }
  for (const r of recs) { add(byName, r.nk, r); add(byPhone, r.pk, r); add(byEmail, r.ek, r); add(byAddr, r.ak, r) }
  const news = db.all("SELECT id, first_name, last_name, phone, email, address FROM clients WHERE lower(status)='new' AND merged_into IS NULL")
  const pairs = []
  for (const n of news) {
    const nm = normName(n.first_name, n.last_name), ph = normPhone(n.phone), em = normEmail(n.email), ad = normAddr(n.address)
    const cand = new Map()
    for (const [k, m] of [[nm, byName], [ph, byPhone], [em, byEmail], [ad, byAddr]]) if (k && m.has(k)) for (const r of m.get(k)) if (r.id !== n.id) cand.set(r.id, r)
    if (!cand.size) continue
    let best = null
    for (const r of cand.values()) { const f = []; if (nm && r.nk === nm) f.push('name'); if (ph && r.pk === ph) f.push('phone'); if (em && r.ek === em) f.push('email'); if (ad && r.ak === ad) f.push('address'); if (!best || f.length > best.f.length) best = { r, f } }
    const f = best.f
    if (f.includes('email') || (f.includes('name') && (f.includes('phone') || f.includes('email') || f.includes('address')))) pairs.push({ new_id: n.id, past_id: best.r.id })
  }
  // Union-find cluster the pairs (chains: 3 records of the same person collapse to one group).
  const parent = new Map()
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a, b) => { parent.set(find(a), find(b)) }
  for (const p of pairs) union(p.new_id, p.past_id)
  const allIds = new Set(); pairs.forEach(p => { allIds.add(p.new_id); allIds.add(p.past_id) })
  const clusters = new Map()
  for (const id of allIds) { const root = find(id); if (!clusters.has(root)) clusters.set(root, new Set()); clusters.get(root).add(id) }
  const nm = (m) => `${m.first_name || ''} ${m.last_name || ''}`.trim()
  const score = (m) => { const st = String(m.status || '').toLowerCase(); if (st === 'closed') return 3; if (isGenuinePC(m.tags)) return 2; if (st !== 'new' && st !== 'archived') return 1; return 0 }
  const plan = []
  for (const ids of clusters.values()) {
    const members = [...ids].map(id => db.get('SELECT id, first_name, last_name, status, tags FROM clients WHERE id=? AND merged_into IS NULL', [id])).filter(Boolean)
    if (members.length < 2) continue
    members.sort((a, b) => score(b) - score(a) || a.id - b.id)
    const primary = members[0], dups = members.slice(1)
    plan.push({ primary: { id: primary.id, name: nm(primary), status: primary.status }, dups: dups.map(d => ({ id: d.id, name: nm(d), status: d.status })) })
  }
  if (dryRun) return res.json({ _v: 'gbmerge2', cluster_count: plan.length, records_to_merge: plan.reduce((s, c) => s + c.dups.length, 0), clusters: plan })
  const results = []
  for (const c of plan) results.push({ cluster: c, result: doMerge(c.primary.id, c.dups.map(d => d.id), true) })
  res.json({ merged_clusters: plan.length, records_merged: results.reduce((s, r) => s + (r.result.count || 0), 0), results })
})

// Extract MLS # and Off Market Date from the Sierra notes of Cancelled/Expired leads and
// populate the mls_number / off_market_date fields. dry_run previews. Processes up to `limit`
// (re-invoke while remaining>0). Returns leads where nothing could be found (for hand-off).
router.post('/cancelled-expired/extract-mls', async (req, res) => {
  const dryRun = req.body?.dry_run === true
  const limit = Math.min(Number(req.body?.limit) || 50, 100)
  const normDate = (s) => {
    const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); if (!m) return null
    let [, mo, da, yr] = m; if (yr.length === 2) yr = '20' + yr
    return `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
  }
  const extractMls = (t) => { const m = t.match(/MLS\s*#?\s*:?\s*(\d{6,8})\b/i); return m ? m[1] : null }
  const extractOff = (t) => {
    const m = t.match(/Off\s*Market\s*Date\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
      || t.match(/\bExpired\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
      || t.match(/Expire\s*Date\s*:?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
    return m ? normDate(m[1]) : null
  }
  const tagLikes = ['%"Sierra: Cancelled"%', '%"Sierra: Expired"%', '%"MLS: Cancelled"%', '%"MLS: Expired"%']
  const inSet = `merged_into IS NULL AND sierra_lead_id IS NOT NULL AND lower(status) IN ('new','qualify','watch') AND (${tagLikes.map(() => 'tags LIKE ?').join(' OR ')})`
  // Only leads not yet attempted this run — so each lead's Sierra notes are fetched ONCE.
  const all = db.all(`SELECT id, sierra_lead_id, first_name, last_name, mls_number, off_market_date FROM clients
    WHERE ${inSet} AND mls_extract_attempted_at IS NULL
      AND (mls_number IS NULL OR mls_number='' OR off_market_date IS NULL OR off_market_date='')`, tagLikes)
  if (dryRun) {
    // The definitive still-missing list (regardless of attempted) — for the hand-off.
    const miss = db.all(`SELECT id, first_name, last_name, mls_number, off_market_date FROM clients
      WHERE ${inSet} AND (mls_number IS NULL OR mls_number='' OR off_market_date IS NULL OR off_market_date='')`, tagLikes)
      .map(c => ({ id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), missing_mls: !c.mls_number, missing_off: !c.off_market_date }))
    return res.json({ candidates_unattempted: all.length, still_missing_total: miss.length, still_missing: miss })
  }
  const batch = all.slice(0, limit)
  const { sierraGet } = await import('../sierra-helper.js')
  const out = { processed: 0, mls_found: 0, off_found: 0, both_found: 0, none_found: 0, not_found: [] }
  for (const c of batch) {
    out.processed++
    let text = '', fetchOk = false
    try {
      const data = await sierraGet(`/notes/${c.sierra_lead_id}`, { pageSize: 50, pageNumber: 1 })
      text = (data.data?.records || []).map(n => String(n.contents || '').replace(/<[^>]+>/g, ' ')).join('  ').replace(/&gt;/g, '>').replace(/&lt;/g, '<')
      fetchOk = true
    } catch { }
    // Mark attempted only if the fetch worked, so a Sierra error retries later instead of being skipped forever.
    if (fetchOk) { try { db.run("UPDATE clients SET mls_extract_attempted_at=datetime('now') WHERE id=?", [c.id]) } catch {} }
    const mls = (!c.mls_number || c.mls_number === '') ? extractMls(text) : null
    const off = (!c.off_market_date || c.off_market_date === '') ? extractOff(text) : null
    const sets = [], vals = []
    if (mls) { sets.push('mls_number=?'); vals.push(mls); out.mls_found++ }
    if (off) { sets.push('off_market_date=?'); vals.push(off); out.off_found++ }
    if (mls && off) out.both_found++
    if (sets.length) { sets.push("updated_at=datetime('now')"); db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id=?`, [...vals, c.id]) }
    // Still missing something after this pass → hand-off candidate
    const stillMissMls = !(c.mls_number || mls), stillMissOff = !(c.off_market_date || off)
    if (stillMissMls || stillMissOff) { out.none_found++; if (out.not_found.length < 200) out.not_found.push({ id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), missing_mls: stillMissMls, missing_off: stillMissOff }) }
    await new Promise(r => setTimeout(r, 250))   // pace Sierra to avoid 429s
  }
  out.remaining = Math.max(0, all.length - batch.length)
  res.json(out)
})

// Reclassify leads to Past Client (status='closed'), optionally assigning an agent.
// Hub-only (does not push to Sierra). dry_run:true previews. Reversible via activity_log.
router.post('/reclassify-past-client', (req, res) => {
  const ids = (Array.isArray(req.body?.client_ids) ? req.body.client_ids : []).map(Number).filter(Boolean)
  const assignAgent = (req.body?.assign_agent || '').trim() || null
  const dryRun = req.body?.dry_run === true
  if (!ids.length) return res.status(400).json({ error: 'client_ids required' })
  const rows = ids.map(id => db.get('SELECT id, first_name, last_name, status, agent_assigned FROM clients WHERE id=? AND merged_into IS NULL', [id])).filter(Boolean)
  if (dryRun) return res.json({ would_change: rows.map(r => ({ id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), from: r.status, to: 'closed', agent: assignAgent || r.agent_assigned })) })
  let n = 0
  for (const r of rows) {
    const sets = [], vals = []
    if (String(r.status || '').toLowerCase() !== 'closed') sets.push("status='closed'")
    if (assignAgent) { sets.push('agent_assigned=?'); vals.push(assignAgent) }
    if (!sets.length) continue
    sets.push("updated_at=datetime('now')")
    db.run(`UPDATE clients SET ${sets.join(', ')} WHERE id=?`, [...vals, r.id])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['reclassify', 'client', r.id, `Past-client audit: status ${r.status} -> closed${assignAgent ? `; agent -> ${assignAgent}` : ''}`])
    n++
  }
  res.json({ changed: n, ids: rows.map(r => r.id) })
})

// ---- P2-2: Unified contact timeline ----
// Merges communications, notes, tasks, AI actions, handoffs, showings, behavioral events,
// transaction milestones, and status/assignment audit into one time-sorted stream.
router.get('/:id/timeline', (req, res) => {
  const id = Number(req.params.id)
  if (!db.get('SELECT id FROM clients WHERE id=?', [id])) return res.status(404).json({ error: 'not found' })
  const limit = Math.min(Number(req.query.limit) || 200, 1000)
  const ev = []
  const at = (t) => t ? String(t).replace(' ', 'T') : null
  try {
    for (const c of db.all("SELECT channel, direction, preview, body, occurred_at FROM communications WHERE client_id=? ORDER BY occurred_at DESC LIMIT 300", [id]))
      ev.push({ type: 'comm', channel: c.channel, dir: c.direction, icon: c.direction === 'incoming' ? '📥' : '📤', title: `${c.direction === 'incoming' ? 'Received' : 'Sent'} ${c.channel}`, detail: (c.preview || c.body || '').slice(0, 240), at: at(c.occurred_at) })
    for (const n of db.all("SELECT title, content, created_at FROM notes WHERE related_type='client' AND related_id=? ORDER BY created_at DESC LIMIT 100", [id]))
      ev.push({ type: 'note', icon: '📝', title: 'Note' + (n.title ? `: ${n.title}` : ''), detail: (n.content || '').slice(0, 240), at: at(n.created_at) })
    for (const t of db.all("SELECT title, status, due_date, completed_at, created_at FROM tasks WHERE related_type='client' AND related_id=? ORDER BY created_at DESC LIMIT 100", [id]))
      ev.push({ type: 'task', icon: t.status === 'done' ? '✅' : '☑️', title: `Task: ${t.title}`, detail: `${t.status}${t.due_date ? ' · due ' + String(t.due_date).slice(0, 10) : ''}`, at: at(t.completed_at || t.created_at) })
    for (const a of db.all("SELECT action_type, reason, output_text, status, created_at FROM ai_actions WHERE client_id=? ORDER BY id DESC LIMIT 100", [id]))
      ev.push({ type: 'ai', icon: '🤖', title: `AI ${String(a.action_type || '').replace(/_/g, ' ').toLowerCase()}`, detail: (a.output_text || a.reason || a.status || '').slice(0, 240), at: at(a.created_at) })
    for (const h of db.all("SELECT reason, urgency, status, created_at FROM ai_handoffs WHERE client_id=? ORDER BY id DESC LIMIT 40", [id]))
      ev.push({ type: 'handoff', icon: '⚑', title: `Handoff (${h.urgency || 'high'})`, detail: `${h.reason || ''} · ${h.status}`, at: at(h.created_at) })
    for (const s of db.all("SELECT showing_date, status, address FROM showings WHERE client_id=? ORDER BY showing_date DESC LIMIT 40", [id]))
      ev.push({ type: 'showing', icon: '🏡', title: 'Showing', detail: `${s.address || ''}${s.status ? ' · ' + s.status : ''}`, at: at(s.showing_date) })
    for (const b of db.all("SELECT event_type, weight, source, occurred_at FROM behavioral_events WHERE client_id=? ORDER BY occurred_at DESC LIMIT 60", [id]))
      ev.push({ type: 'behavior', icon: '📈', title: String(b.event_type || '').replace(/_/g, ' '), detail: `${b.source || ''} · weight ${b.weight}`, at: at(b.occurred_at) })
    for (const l of db.all("SELECT action, details, created_at FROM activity_log WHERE entity_type='client' AND entity_id=? ORDER BY id DESC LIMIT 80", [id]))
      ev.push({ type: 'audit', icon: '•', title: String(l.action || '').replace(/_/g, ' '), detail: (l.details || '').slice(0, 240), at: at(l.created_at) })
    for (const t of db.all("SELECT id, status, address, updated_at, created_at FROM transactions WHERE client_id=? ORDER BY updated_at DESC LIMIT 20", [id]))
      ev.push({ type: 'transaction', icon: '📄', title: `Transaction: ${t.status || 'open'}`, detail: t.address || '', at: at(t.updated_at || t.created_at) })
  } catch (e) { return res.status(500).json({ error: e.message }) }
  ev.sort((a, b) => (b.at || '').localeCompare(a.at || ''))
  res.json(ev.slice(0, limit))
})

// ---- CSV export ----
// Export selected leads (by id) OR the current filter as a CSV download. Export is
// always CSV. Body: { ids: [...] } for a selection, or the same filter params the list
// uses to export a whole list.
const EXPORT_COLUMNS = [
  ['first_name', 'First Name'], ['last_name', 'Last Name'], ['email', 'Email'], ['phone', 'Phone'],
  ['type', 'Type'], ['status', 'Status'], ['source', 'Source'], ['agent_assigned', 'Agent'],
  ['address', 'Address'], ['city', 'City'], ['state', 'State'], ['zip', 'Zip'],
  ['lead_score', 'Lead Score'], ['lead_grade', 'Grade'], ['fsbo_status', 'FSBO Status'],
  ['tags', 'Tags'], ['register_date', 'Registered'], ['created_at', 'Added'],
]
const csvEscape = (v) => {
  let s = v == null ? '' : String(v)
  // tags are stored as a JSON array string — flatten to a readable "a; b; c"
  if (s.startsWith('[') && s.endsWith(']')) { try { const a = JSON.parse(s); if (Array.isArray(a)) s = a.join('; ') } catch {} }
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function clientsToCsv(rows) {
  const head = EXPORT_COLUMNS.map(c => c[1]).join(',')
  const body = rows.map(r => EXPORT_COLUMNS.map(([k]) => csvEscape(r[k])).join(',')).join('\r\n')
  return head + '\r\n' + body + (body ? '\r\n' : '')
}
router.post('/export', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number).filter(Boolean))] : []
  let rows = []
  if (ids.length) {
    // Chunk the IN() to stay well under SQLite's bound-parameter limit.
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900)
      rows.push(...db.all(`SELECT * FROM clients WHERE id IN (${chunk.map(() => '?').join(',')})`, chunk))
    }
  } else {
    const { where, params } = buildClientFilter(req.body || {})
    const orderBy = SORT_OPTIONS[req.body?.sort] || SORT_OPTIONS.recent_activity
    rows = db.all(`SELECT * FROM clients${where} ORDER BY ${orderBy} LIMIT 100000`, params)
  }
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="clients-export-${stamp}.csv"`)
  res.send(clientsToCsv(rows))
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
  const agents = db.all("SELECT DISTINCT agent_assigned FROM clients WHERE agent_assigned IS NOT NULL AND TRIM(agent_assigned) != '' ORDER BY agent_assigned").map(r => r.agent_assigned)
  res.json({ zips, cities, sources, tags, viewed_cities, agents })
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
  // Manual Realist Score entry: normalize to digits and derive the A-F grade
  // whenever lead_score is set (or cleared) so the badge stays consistent.
  if (Object.prototype.hasOwnProperty.call(fields, 'lead_score')) {
    const digits = String(fields.lead_score ?? '').replace(/[^0-9]/g, '')
    fields.lead_score = digits || null
    fields.lead_grade = fields.lead_score ? gradeFromRealistScore(fields.lead_score) : null
  }
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

// FREE social enrichment (no paid API, no scraping). Two sources:
//   1) Follow Up Boss — most leads are FUB-linked and FUB carries a `socialData`
//      array (LinkedIn/Facebook/etc.) plus a profile `picture`. This is the best
//      free source we have.
//   2) Gravatar fallback — hash the email, pull any public profile/avatar/linked
//      accounts for whatever FUB didn't provide.
// Only fills blank fields; always stamps that we checked. Pass ?debug=1 to see
// the raw FUB socialData/picture payload.
const pickSocial = (found, c, type, val) => {
  if (!val || typeof val !== 'string') return
  const t = String(type || '').toLowerCase()
  if (!c.linkedin_url && !found.linkedin_url && (t.includes('linkedin') || /linkedin\.com/i.test(val))) found.linkedin_url = val.trim()
  if (!c.facebook_url && !found.facebook_url && (t.includes('facebook') || /facebook\.com/i.test(val))) found.facebook_url = val.trim()
}

// Pull social profiles + picture + job/company from a client's linked FUB person.
// FUB's `socialData` is a flat object: { linkedIn, facebook, twitter, company,
// title, bio, ... }. Returns a `found` object of only the blank fields we filled.
async function fubEnrich(c, debug) {
  const found = {}
  if (!c.fub_person_id || !fubConfigured()) return found
  const person = await fubGet(`/people/${c.fub_person_id}`, { fields: 'name,picture,socialData' })
  if (debug) { debug.fub_socialData = person.socialData; debug.fub_picture = person.picture }
  const sd = person.socialData
  const entries = Array.isArray(sd)
    ? sd
    : (sd && typeof sd === 'object' ? Object.entries(sd).map(([k, v]) => ({ type: k, value: v })) : [])
  for (const e of entries) {
    if (typeof e === 'string') { pickSocial(found, c, '', e); continue }
    pickSocial(found, c, e.type || e.label || e.name || e.network, e.value || e.url || e.link)
  }
  // Rich fields FUB gives for free (only fill blanks).
  const sdo = (sd && typeof sd === 'object' && !Array.isArray(sd)) ? sd : {}
  if (!c.job_title && sdo.title && typeof sdo.title === 'string') found.job_title = sdo.title.trim()
  if (!c.employer && sdo.company && typeof sdo.company === 'string') found.employer = sdo.company.trim()
  const p = person.picture
  const pic = typeof p === 'string' ? p : (p && (p.original || p.large || p.url || p.small)) || null
  if (pic && !c.avatar_url && !found.avatar_url) found.avatar_url = pic
  return found
}

function saveEnrichment(id, found, sources) {
  found.enriched_at = new Date().toISOString()
  found.enrichment_source = sources.length ? sources.join('+') : 'none'
  const keys = Object.keys(found)
  db.run(`UPDATE clients SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => found[k]), id])
}

router.post('/:id/enrich-free', async (req, res) => {
  const id = Number(req.params.id)
  const c = db.get('SELECT * FROM clients WHERE id = ?', [id])
  if (!c) return res.status(404).json({ error: 'Client not found' })
  let found = {}
  const sources = []
  const debug = {}

  // 1) Follow Up Boss (best free source)
  try {
    found = await fubEnrich(c, debug)
    if (Object.keys(found).length) sources.push('fub')
  } catch (e) { debug.fub_error = String(e.message || e) }

  // 2) Gravatar fallback for social/avatar still missing
  if (c.email && (!(c.linkedin_url || found.linkedin_url) || !(c.facebook_url || found.facebook_url) || !(c.avatar_url || found.avatar_url))) {
    const hash = crypto.createHash('md5').update(String(c.email).trim().toLowerCase()).digest('hex')
    let gp = null
    try {
      const r = await fetch(`https://www.gravatar.com/${hash}.json`, { headers: { 'User-Agent': 'MattSmithTeamHub/1.0 (+https://mattsmithteam.com)' } })
      if (r.ok) { const j = await r.json(); gp = (j && j.entry && j.entry[0]) || null }
    } catch { /* no match */ }
    if (gp) {
      const avatar = gp.thumbnailUrl || (gp.photos && gp.photos[0] && gp.photos[0].value) || null
      if (avatar && !c.avatar_url && !found.avatar_url) found.avatar_url = avatar
      for (const a of (Array.isArray(gp.accounts) ? gp.accounts : [])) pickSocial(found, c, a.domain || a.shortname, a.url)
      if (found.linkedin_url || found.facebook_url || found.avatar_url) sources.push('gravatar')
    }
  }

  const foundAny = !!(found.linkedin_url || found.facebook_url || found.avatar_url || found.job_title || found.employer)
  saveEnrichment(id, found, sources)
  const out = { found_any: foundAny, sources, ...found }
  if (req.query.debug) out._debug = debug
  res.json(out)
})

// Inspect the raw FUB person record (all fields) — used to see what data is
// available to pull. Read-only.
router.get('/:id/fub-raw', async (req, res) => {
  const c = db.get('SELECT fub_person_id FROM clients WHERE id = ?', [Number(req.params.id)])
  if (!c || !c.fub_person_id) return res.status(404).json({ error: 'client not linked to FUB' })
  if (!fubConfigured()) return res.status(400).json({ error: 'FUB not configured' })
  try {
    const person = await fubGet(`/people/${c.fub_person_id}`, { fields: 'allFields' })
    res.json(person)
  } catch (e) { res.status(500).json({ error: String(e.message || e) }) }
})

// FUB "At a Glance" price point: fetch this lead's FUB events and average the
// price of the homes they actually viewed (rounded to the nearest $10k). This is
// the number the agent sees in FUB's At-a-Glance widget, and it works for cold
// leads whose old views aren't in our local fub_activity table.
async function fubAvgViewedPrice(personId) {
  if (!personId || !fubConfigured()) return ''
  const nums = []
  try {
    // Page a few levels deep so a cold lead's older property views (which sit
    // beneath their newer non-property events) are still captured. Stop early
    // once we have enough priced views.
    for (let offset = 0; offset < 500; offset += 100) {
      const data = await fubGet('/events', { personId, limit: 100, offset, sort: '-created' })
      const events = data?.events || []
      for (const e of events) {
        const p = e && e.property && e.property.price
        const n = Number(String(p == null ? '' : p).replace(/[^0-9.]/g, ''))
        if (n > 10000 && n < 20000000) nums.push(n)
      }
      if (events.length < 100 || nums.length >= 25) break
    }
  } catch { /* partial is fine */ }
  if (!nums.length) return ''
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  return '$' + (Math.round(avg / 10000) * 10000).toLocaleString()
}

// On-demand single-lead price-point pull.
router.post('/:id/enrich-price', async (req, res) => {
  const c = db.get('SELECT id, fub_person_id FROM clients WHERE id = ?', [Number(req.params.id)])
  if (!c) return res.status(404).json({ error: 'Client not found' })
  const { price_point: pp } = await fubPersonInfo(c.fub_person_id)
  db.run('UPDATE clients SET fub_price_point = ?, fub_price_enriched_at = ? WHERE id = ?', [pp || null, new Date().toISOString(), c.id])
  res.json({ id: c.id, price_point: pp })
})

// Bulk price-point pull (background, resumable, rate-limited) — same pattern as
// the social pull. Fills fub_price_point for every FUB-linked lead not yet done.
let _fubPrice = { running: false, total: 0, done: 0, found: 0, started: null, finished: null, error: null }
router.get('/enrich-fub-price-bulk/status', (_req, res) => res.json(_fubPrice))
router.post('/enrich-fub-price-bulk', (req, res) => {
  if (_fubPrice.running) return res.json({ already_running: true, ..._fubPrice })
  if (!fubConfigured()) return res.status(400).json({ error: 'Follow Up Boss is not connected' })
  const redo = req.body && req.body.redo
  const rows = db.all(`SELECT id, fub_person_id FROM clients WHERE fub_person_id IS NOT NULL ${redo ? '' : 'AND fub_price_enriched_at IS NULL'} ORDER BY id`)
  _fubPrice = { running: true, total: rows.length, done: 0, found: 0, started: new Date().toISOString(), finished: null, error: null }
  res.json({ started: true, total: rows.length })
  ;(async () => {
    for (const row of rows) {
      try { const { price_point: pp } = await fubPersonInfo(row.fub_person_id); db.run('UPDATE clients SET fub_price_point = ?, fub_price_enriched_at = ? WHERE id = ?', [pp || null, new Date().toISOString(), row.id]); if (pp) _fubPrice.found++ }
      catch (e) { _fubPrice.error = String(e.message || e) }
      _fubPrice.done++
      await new Promise(r => setTimeout(r, 160))
    }
    _fubPrice.running = false; _fubPrice.finished = new Date().toISOString()
  })()
})

// Original registration date, recovered from FUB. FUB keeps the true sign-up
// time in a custom field (customRegTime, e.g. "Aug 24, 2019 02:41:55 AM") that
// predates our Sierra import; fall back to FUB's own person `created` date.
function toIsoDate(v) {
  if (!v) return null
  const t = Date.parse(String(v))
  if (isNaN(t)) return null
  return new Date(t).toISOString().slice(0, 10)
}
const fmtPrice = (v) => { const n = Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')); return (n > 10000 && n < 20000000) ? '$' + Math.round(n).toLocaleString() : '' }
// One person fetch → both the original register date AND the FUB price (their
// stated budget, else the At-a-Glance average). ~50% of engaged leads carry a price.
async function fubPersonInfo(personId) {
  if (!personId || !fubConfigured()) return { register_date: null, price_point: '' }
  try {
    const p = await fubGet(`/people/${personId}`, { fields: 'name,created,customRegTime,price,customAvePricePoint' })
    return {
      register_date: toIsoDate(p.customRegTime) || toIsoDate(p.created) || null,
      price_point: fmtPrice(p.price) || fmtPrice(p.customAvePricePoint) || '',
    }
  } catch { return { register_date: null, price_point: '' } }
}
router.post('/:id/enrich-register', async (req, res) => {
  const c = db.get('SELECT id, fub_person_id FROM clients WHERE id = ?', [Number(req.params.id)])
  if (!c) return res.status(404).json({ error: 'Client not found' })
  const info = await fubPersonInfo(c.fub_person_id)
  db.run('UPDATE clients SET register_date = ?, fub_price_point = ?, fub_price_enriched_at = ? WHERE id = ?', [info.register_date, info.price_point || null, new Date().toISOString(), c.id])
  res.json({ id: c.id, ...info })
})
let _fubReg = { running: false, total: 0, done: 0, found: 0, started: null, finished: null, error: null }
router.get('/enrich-fub-register-bulk/status', (_req, res) => res.json(_fubReg))
router.post('/enrich-fub-register-bulk', (req, res) => {
  if (_fubReg.running) return res.json({ already_running: true, ..._fubReg })
  if (!fubConfigured()) return res.status(400).json({ error: 'Follow Up Boss is not connected' })
  const redo = req.body && req.body.redo
  const rows = db.all(`SELECT id, fub_person_id FROM clients WHERE fub_person_id IS NOT NULL ${redo ? '' : 'AND register_date IS NULL'} ORDER BY id`)
  _fubReg = { running: true, total: rows.length, done: 0, found: 0, started: new Date().toISOString(), finished: null, error: null }
  res.json({ started: true, total: rows.length })
  ;(async () => {
    for (const row of rows) {
      try {
        const info = await fubPersonInfo(row.fub_person_id)
        db.run('UPDATE clients SET register_date = ?, fub_price_point = ?, fub_price_enriched_at = ? WHERE id = ?', [info.register_date || '', info.price_point || null, new Date().toISOString(), row.id])
        if (info.register_date) _fubReg.found++
      } catch (e) { _fubReg.error = String(e.message || e) }
      _fubReg.done++
      await new Promise(r => setTimeout(r, 150))
    }
    _fubReg.running = false; _fubReg.finished = new Date().toISOString()
  })()
})

// ---- Bulk FUB enrichment (free) ----
// Pulls FUB social profiles for every FUB-linked lead and saves them. FUB API
// only, rate-limited, resumable (skips already-enriched). Runs in the background.
let _fubBulk = { running: false, total: 0, done: 0, found: 0, started: null, finished: null, error: null }
router.get('/enrich-fub-bulk/status', (_req, res) => res.json(_fubBulk))
router.post('/enrich-fub-bulk', (req, res) => {
  if (_fubBulk.running) return res.json({ already_running: true, ..._fubBulk })
  if (!fubConfigured()) return res.status(400).json({ error: 'Follow Up Boss is not connected' })
  const redo = req.body && req.body.redo   // redo=true re-checks even already-enriched leads
  const rows = db.all(
    `SELECT id, fub_person_id, linkedin_url, facebook_url, avatar_url, job_title, employer
     FROM clients WHERE fub_person_id IS NOT NULL ${redo ? '' : 'AND enriched_at IS NULL'} ORDER BY id`)
  _fubBulk = { running: true, total: rows.length, done: 0, found: 0, started: new Date().toISOString(), finished: null, error: null }
  res.json({ started: true, total: rows.length })
  ;(async () => {
    for (const row of rows) {
      try {
        const found = await fubEnrich(row, null)
        if (Object.keys(found).length) { saveEnrichment(row.id, found, ['fub']); _fubBulk.found++ }
        else saveEnrichment(row.id, {}, [])   // stamp enriched_at so we skip next time
      } catch (e) { _fubBulk.error = String(e.message || e) }
      _fubBulk.done++
      await new Promise(r => setTimeout(r, 160))   // ~6/sec — well under FUB's rate limit
    }
    _fubBulk.running = false
    _fubBulk.finished = new Date().toISOString()
  })()
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

// Bulk assign (or clear) the owning agent on the selected leads.
router.post('/bulk-assign-agent', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean)
  const agent = String(req.body?.agent || '').trim()
  if (!ids.length) return res.status(400).json({ error: 'ids array required' })
  const now = new Date().toISOString()
  const ph = ids.map(() => '?').join(',')
  db.run(`UPDATE clients SET agent_assigned=?, updated_at=? WHERE id IN (${ph})`, [agent || null, now, ...ids])
  logActivity('bulk_assign_agent', 'client', 0, `Assigned ${ids.length} lead${ids.length === 1 ? '' : 's'} to ${agent || '(unassigned)'}`)
  res.json({ success: true, updated: ids.length, agent })
})

// Bulk add and/or remove tags (comma-separated tags field), case-insensitive, no dupes.
router.post('/bulk-tags', (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(Number).filter(Boolean)
  const add = (Array.isArray(req.body?.add) ? req.body.add : []).map(s => String(s).trim()).filter(Boolean)
  const remove = (Array.isArray(req.body?.remove) ? req.body.remove : []).map(s => String(s).trim()).filter(Boolean)
  const removeLc = remove.map(s => s.toLowerCase())
  if (!ids.length) return res.status(400).json({ error: 'ids array required' })
  if (!add.length && !remove.length) return res.status(400).json({ error: 'add or remove tags required' })
  const now = new Date().toISOString()
  let updated = 0
  db.beginBulk?.()
  try {
    for (const id of ids) {
      const row = db.get('SELECT tags FROM clients WHERE id=?', [id]); if (!row) continue
      let list = String(row.tags || '').split(',').map(s => s.trim()).filter(Boolean)
      if (removeLc.length) list = list.filter(t => !removeLc.includes(t.toLowerCase()))
      for (const t of add) if (!list.some(x => x.toLowerCase() === t.toLowerCase())) list.push(t)
      db.run('UPDATE clients SET tags=?, updated_at=? WHERE id=?', [list.join(', ') || null, now, id])
      updated++
    }
    logActivity('bulk_tags', 'client', 0, `Tags on ${updated} lead${updated === 1 ? '' : 's'}: +[${add.join(', ')}] -[${remove.join(', ')}]`)
  } finally { db.endBulk?.() }
  res.json({ success: true, updated, added: add, removed: remove })
})

// Auto-enrich newly-added FUB-linked leads (socials + register date + price) that
// haven't been pulled yet. Runs on the scheduler so new leads get enriched without
// the manual button. Newest leads first; small, rate-limited batch.
export async function enrichNewFubLeads(limit = 30) {
  if (!fubConfigured()) return { done: 0, found: 0 }
  const rows = db.all(`SELECT * FROM clients WHERE fub_person_id IS NOT NULL AND (enriched_at IS NULL OR register_date IS NULL) ORDER BY id DESC LIMIT ?`, [limit])
  let done = 0, found = 0
  for (const c of rows) {
    try {
      let social = {}
      try { social = await fubEnrich(c, null) } catch {}
      saveEnrichment(c.id, social, Object.keys(social).length ? ['fub'] : [])   // stamps enriched_at
      const info = await fubPersonInfo(c.fub_person_id)
      db.run('UPDATE clients SET register_date = ?, fub_price_point = ?, fub_price_enriched_at = ? WHERE id = ?', [info.register_date || '', info.price_point || null, new Date().toISOString(), c.id])
      if (info.register_date || info.price_point || Object.keys(social).length) found++
      done++
    } catch { /* skip this lead */ }
    await new Promise(r => setTimeout(r, 200))
  }
  if (done) console.log(`[enrich] auto-enriched ${done} new FUB leads (${found} with data)`)
  return { done, found }
}

export default router
