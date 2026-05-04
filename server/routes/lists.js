import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

// List all saved client lists
router.get('/', (req, res) => {
  const lists = db.all('SELECT id, name, description, is_dynamic, filter_criteria, client_ids, created_at, updated_at FROM client_lists ORDER BY updated_at DESC')
  // Compute current count for each
  const enriched = lists.map(l => {
    let count = 0
    if (l.is_dynamic && l.filter_criteria) {
      try {
        const filter = JSON.parse(l.filter_criteria)
        const { where, params } = buildClientFilterForList(filter)
        count = db.get(`SELECT COUNT(*) as c FROM clients${where}`, params).c
      } catch {}
    } else if (l.client_ids) {
      try { count = JSON.parse(l.client_ids).length } catch {}
    }
    return { ...l, count }
  })
  res.json(enriched)
})

// Get a single list with its current matching clients
router.get('/:id', (req, res) => {
  const list = db.get('SELECT * FROM client_lists WHERE id = ?', [Number(req.params.id)])
  if (!list) return res.status(404).json({ error: 'List not found' })

  let clientIds = []
  if (list.is_dynamic && list.filter_criteria) {
    try {
      const filter = JSON.parse(list.filter_criteria)
      const { where, params } = buildClientFilterForList(filter)
      clientIds = db.all(`SELECT id FROM clients${where}`, params).map(r => r.id)
    } catch {}
  } else if (list.client_ids) {
    try { clientIds = JSON.parse(list.client_ids) } catch {}
  }

  res.json({ ...list, client_ids_resolved: clientIds, count: clientIds.length })
})

// Create a new list
router.post('/', (req, res) => {
  const { name, description, filter_criteria, is_dynamic, client_ids } = req.body
  if (!name) return res.status(400).json({ error: 'Name required' })

  const result = db.run(
    'INSERT INTO client_lists (name, description, filter_criteria, is_dynamic, client_ids) VALUES (?,?,?,?,?)',
    [name, n(description),
      filter_criteria ? JSON.stringify(filter_criteria) : null,
      is_dynamic === false ? 0 : 1,
      client_ids ? JSON.stringify(client_ids) : null])
  res.status(201).json({ id: result.lastInsertRowid })
})

// Update a list (rename, change description, refresh filter)
router.put('/:id', (req, res) => {
  const { name, description, filter_criteria, client_ids } = req.body
  const fields = []
  const params = []
  if (name !== undefined) { fields.push('name = ?'); params.push(name) }
  if (description !== undefined) { fields.push('description = ?'); params.push(n(description)) }
  if (filter_criteria !== undefined) { fields.push('filter_criteria = ?'); params.push(filter_criteria ? JSON.stringify(filter_criteria) : null) }
  if (client_ids !== undefined) { fields.push('client_ids = ?'); params.push(client_ids ? JSON.stringify(client_ids) : null) }
  fields.push("updated_at = datetime('now')")
  params.push(Number(req.params.id))
  db.run(`UPDATE client_lists SET ${fields.join(', ')} WHERE id = ?`, params)
  res.json({ success: true })
})

// Delete a list
router.delete('/:id', (req, res) => {
  db.run('DELETE FROM client_lists WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

// Helper: build filter from JSON criteria object (same logic as clients route)
function buildClientFilterForList(q) {
  let where = ' WHERE 1=1'
  const params = []
  if (q.type) { where += ' AND type = ?'; params.push(q.type) }
  if (q.status) { where += ' AND status = ?'; params.push(q.status) }
  if (q.statuses_include?.length) {
    where += ' AND status IN (' + q.statuses_include.map(() => '?').join(',') + ')'
    params.push(...q.statuses_include)
  }
  if (q.statuses_exclude?.length) {
    where += ' AND (status IS NULL OR status NOT IN (' + q.statuses_exclude.map(() => '?').join(',') + '))'
    params.push(...q.statuses_exclude)
  }
  // Tags include - lead must have ANY of these tags (OR logic)
  if (q.tags_include?.length) {
    where += ' AND (' + q.tags_include.map(() => 'tags LIKE ?').join(' OR ') + ')'
    q.tags_include.forEach(tag => params.push(`%"${tag}"%`))
  }
  if (q.tags_exclude?.length) {
    for (const tag of q.tags_exclude) {
      where += ' AND (tags IS NULL OR tags NOT LIKE ?)'; params.push(`%"${tag}"%`)
    }
  }
  if (q.zips_include?.length) {
    where += ' AND zip IN (' + q.zips_include.map(() => '?').join(',') + ')'
    params.push(...q.zips_include)
  }
  if (q.zips_exclude?.length) {
    where += ' AND (zip IS NULL OR zip NOT IN (' + q.zips_exclude.map(() => '?').join(',') + '))'
    params.push(...q.zips_exclude)
  }
  if (q.cities_include?.length) {
    where += ' AND city IN (' + q.cities_include.map(() => '?').join(',') + ')'
    params.push(...q.cities_include)
  }
  if (q.sources_include?.length) {
    where += ' AND source IN (' + q.sources_include.map(() => '?').join(',') + ')'
    params.push(...q.sources_include)
  }
  if (q.has_email) where += " AND email IS NOT NULL AND email != ''"
  if (q.exclude_optouts) where += ' AND (marketing_email_opt_out IS NULL OR marketing_email_opt_out = 0)'
  if (q.score_min) { where += ' AND CAST(lead_score AS INTEGER) >= ?'; params.push(Number(q.score_min)) }
  if (q.score_max) { where += ' AND CAST(lead_score AS INTEGER) <= ?'; params.push(Number(q.score_max)) }
  if (q.visits_min) { where += ' AND visits >= ?'; params.push(Number(q.visits_min)) }
  // Property criteria (saved search)
  if (q.search_price_at_least) { where += ' AND search_price_max >= ?'; params.push(Number(q.search_price_at_least)) }
  if (q.search_price_at_most) { where += ' AND (search_price_min IS NULL OR search_price_min <= ?)'; params.push(Number(q.search_price_at_most)) }
  if (q.search_max_price_min) { where += ' AND search_price_max >= ?'; params.push(Number(q.search_max_price_min)) }
  if (q.search_max_price_max) { where += ' AND search_price_max <= ?'; params.push(Number(q.search_max_price_max)) }
  if (q.search_beds_min) { where += ' AND search_beds_min >= ?'; params.push(Number(q.search_beds_min)) }
  if (q.search_baths_min) { where += ' AND search_baths_min >= ?'; params.push(Number(q.search_baths_min)) }
  if (q.search_sqft_min) { where += ' AND search_sqft_min >= ?'; params.push(Number(q.search_sqft_min)) }
  if (q.has_saved_search === 1 || q.has_saved_search === '1' || q.has_saved_search === true) where += ' AND has_saved_search = 1'
  if (q.search_property_types?.length) {
    where += ' AND (' + q.search_property_types.map(() => 'search_property_types LIKE ?').join(' OR ') + ')'
    q.search_property_types.forEach(t => params.push(`%"${t}"%`))
  }
  if (q.search_regions?.length) {
    where += ' AND (' + q.search_regions.map(() => 'search_regions LIKE ?').join(' OR ') + ')'
    q.search_regions.forEach(r => params.push(`%${r}%`))
  }
  return { where, params }
}

export default router
