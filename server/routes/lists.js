import { Router } from 'express'
import db from '../database.js'
import { compileAudience, previewAudience, fieldMeta } from '../smart-audience.js'
import { syncFsboMaster, ensureFsboListIncludesMaster, fsboMasterCsvUrl } from '../fsbo-master.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

// A dynamic list's filter_criteria is one of two shapes:
//  - legacy flat filter (buildClientFilterForList)  — {type, status, tags_include, ...}
//  - v2 smart-audience tree                          — {version:2, tree:{all|any:[...]}}
// resolveDynamic returns { where, params } for either. Both are used against
// `FROM clients c`; the legacy filter's unqualified column names resolve fine under
// the alias, and the smart compiler emits c.-qualified expressions.
function resolveDynamic(filter) {
  if (filter && filter.version === 2 && filter.tree) return compileAudience(filter.tree)
  return buildClientFilterForList(filter)
}

// List all saved client lists
router.get('/', (req, res) => {
  const lists = db.all('SELECT id, name, description, is_dynamic, filter_criteria, client_ids, created_at, updated_at FROM client_lists ORDER BY updated_at DESC')
  // Compute current count for each
  const enriched = lists.map(l => {
    let count = 0
    if (l.is_dynamic && l.filter_criteria) {
      try {
        const filter = JSON.parse(l.filter_criteria)
        const { where, params } = resolveDynamic(filter)
        count = db.get(`SELECT COUNT(*) as c FROM clients c${where}`, params).c
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
      const { where, params } = resolveDynamic(filter)
      clientIds = db.all(`SELECT c.id FROM clients c${where}`, params).map(r => r.id)
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

// FSBO master-file sync: pull the FSBO master Google Sheet onto clients (fsbo_status),
// and guarantee the FSBO list includes every master FSBO. Returns a reconciliation report.
router.post('/fsbo/sync', async (_req, res) => {
  try {
    const report = await syncFsboMaster()
    const listFix = ensureFsboListIncludesMaster()
    res.json({ ok: true, source: fsboMasterCsvUrl(), ...report, list: listFix })
  } catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})
router.get('/fsbo/status', (_req, res) => {
  const counts = db.all("SELECT fsbo_status s, COUNT(*) n FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' GROUP BY fsbo_status")
  res.json({ last_sync: db.getSetting?.('fsbo_master_last_sync') || null, source: fsboMasterCsvUrl(), counts })
})

// FSBO smart follow-up: status, manual run, enable/disable, and off-market->junk now.
// Diagnose why the Hub FSBO count differs from the master sheet: duplicates (same phone
// on 2+ records) and orphans (fsbo_status set but the phone isn't in the master anymore).
router.get('/fsbo/audit', async (_req, res) => {
  try {
    const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
    const { fetchFsboMasterRows } = await import('../fsbo-master.js')
    const master = await fetchFsboMasterRows()
    const masterPhones = new Set(master.map(r => last10(r.phone)).filter(Boolean))
    const recs = db.all("SELECT id, first_name, last_name, phone, email, sierra_lead_id, fsbo_status, status, created_at FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL")
    const onList = recs.filter(r => !['junk', 'donotcontact', 'archived'].includes(String(r.status || '').toLowerCase()))
    // group by phone to find duplicates
    const byPhone = {}
    for (const r of onList) { const k = last10(r.phone) || `noPhone_${r.id}`; (byPhone[k] = byPhone[k] || []).push(r) }
    const dupes = Object.entries(byPhone).filter(([, g]) => g.length > 1)
      .map(([k, g]) => ({ phone: k, count: g.length, records: g.map(r => ({ id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), sierra_lead_id: r.sierra_lead_id, email: r.email, status: r.status, created_at: r.created_at })) }))
    const orphans = onList.filter(r => { const k = last10(r.phone); return k && !masterPhones.has(k) })
      .map(r => ({ id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), phone: r.phone, sierra_lead_id: r.sierra_lead_id, fsbo_status: r.fsbo_status, status: r.status, created_at: r.created_at }))
    const noPhone = onList.filter(r => !last10(r.phone)).map(r => ({ id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() }))
    res.json({
      master_rows: master.length, master_unique_phones: masterPhones.size,
      hub_fsbo_status_total: recs.length, hub_on_list: onList.length,
      duplicate_groups: dupes.length, duplicate_extra_records: dupes.reduce((a, g) => a + g.count - 1, 0),
      orphans_not_in_master: orphans.length, no_phone: noPhone.length,
      dupes, orphans, noPhone,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// Collapse duplicate FSBO records sharing a phone. Hub-native sync duplicates (all the
// losers have no Sierra profile) are merged automatically into the oldest record; groups
// where a loser has its OWN sierra_lead_id are left for manual review (they may be genuine
// separate Sierra profiles, e.g. one owner with two listings). Pass {dry:true} to preview.
router.post('/fsbo/dedupe', (req, res) => {
  const dry = req.body?.dry === true || req.query.dry === '1'
  const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : '' }
  const now = new Date().toISOString()
  const recs = db.all("SELECT id, first_name, last_name, phone, sierra_lead_id, fsbo_status, fsbo_list_date, fsbo_dom, fsbo_notes, fsbo_link, status, created_at FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL AND lower(status) NOT IN ('junk','donotcontact','archived')")
  const groups = {}
  for (const r of recs) { const k = last10(r.phone); if (!k) continue; (groups[k] = groups[k] || []).push(r) }
  const merged = [], review = []
  for (const [k, g] of Object.entries(groups)) {
    if (g.length < 2) continue
    g.sort((a, b) => a.id - b.id)
    const canonical = g[0], losers = g.slice(1)
    if (losers.every(l => !l.sierra_lead_id)) {
      for (const l of losers) {
        if (!dry) {
          const set = [], val = []
          for (const f of ['fsbo_list_date', 'fsbo_dom', 'fsbo_notes', 'fsbo_link']) if (!canonical[f] && l[f]) { set.push(`${f}=?`); val.push(l[f]) }
          if (set.length) { val.push(canonical.id); db.run(`UPDATE clients SET ${set.join(', ')} WHERE id=?`, val) }
          db.run('UPDATE clients SET fsbo_status=NULL, fsbo_list_date=NULL, fsbo_dom=NULL, merged_into=?, updated_at=? WHERE id=?', [canonical.id, now, l.id])
        }
      }
      merged.push({ phone: k, name: `${canonical.first_name || ''} ${canonical.last_name || ''}`.trim(), kept: canonical.id, removed: losers.map(l => l.id) })
    } else {
      review.push({ phone: k, name: `${canonical.first_name || ''} ${canonical.last_name || ''}`.trim(), records: g.map(r => ({ id: r.id, sierra_lead_id: r.sierra_lead_id, status: r.status, fsbo_status: r.fsbo_status, created_at: r.created_at })) })
    }
  }
  res.json({ dry, merged_groups: merged.length, records_removed: merged.reduce((a, m) => a + m.removed.length, 0), needs_review: review.length, merged, review })
})
router.get('/fsbo/followup', (_req, res) => {
  const byStep = db.all("SELECT step, COUNT(*) n FROM fsbo_followups WHERE status='active' GROUP BY step")
  const totals = {
    enabled: db.getSetting?.('fsbo_followup_enabled') === '1',
    enrolled: db.get("SELECT COUNT(*) n FROM fsbo_followups WHERE status='active'")?.n || 0,
    by_step: Object.fromEntries(byStep.map(r => [`step_${r.step}`, r.n])),
    replied: db.get("SELECT COUNT(*) n FROM fsbo_followups WHERE replied=1")?.n || 0,
    done: db.get("SELECT COUNT(*) n FROM fsbo_followups WHERE status='done'")?.n || 0,
    eligible_available: db.get("SELECT COUNT(*) n FROM clients WHERE fsbo_status='Available' AND phone IS NOT NULL AND phone!='' AND (hub_text_opt_out IS NULL OR hub_text_opt_out=0) AND lower(status) NOT IN ('junk','donotcontact','closed','archived')")?.n || 0,
  }
  res.json(totals)
})
router.post('/fsbo/followup/toggle', (req, res) => { const on = req.body?.enabled === true || req.body?.enabled === '1'; db.setSetting('fsbo_followup_enabled', on ? '1' : '0'); res.json({ enabled: on }) })
router.post('/fsbo/followup/run', async (_req, res) => {
  try { const m = await import('../fsbo-followup.js'); res.json(await m.runFsboFollowups()) } catch (e) { res.status(500).json({ error: e.message }) }
})
// Mark FSBOs as already-contacted (e.g. texted manually in Sierra), so the sequence skips
// the opener and continues at the +1-week message. Accepts phones and/or client_ids.
router.post('/fsbo/followup/seed', (req, res) => {
  const b = req.body || {}
  const daysAgo = Number(b.days_ago) || 7
  const firstTextAt = new Date(Date.now() - daysAgo * 86400000).toISOString()
  const last10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null }
  const ids = new Set((Array.isArray(b.client_ids) ? b.client_ids : []).map(Number).filter(Boolean))
  const wanted = new Set((Array.isArray(b.phones) ? b.phones : []).map(last10).filter(Boolean))
  if (wanted.size) {
    // Stored phones are formatted, so match on normalized last-10 across the FSBO set.
    for (const c of db.all("SELECT id, phone FROM clients WHERE fsbo_status IS NOT NULL AND phone IS NOT NULL AND phone != ''")) {
      const k = last10(c.phone); if (k && wanted.has(k)) ids.add(c.id)
    }
  }
  const seeded = []
  for (const id of ids) {
    db.run(`INSERT INTO fsbo_followups (client_id, step, first_text_at, replied, status)
            VALUES (?,1,?,1,'active')
            ON CONFLICT(client_id) DO UPDATE SET step=MAX(step,1), first_text_at=COALESCE(first_text_at,excluded.first_text_at), replied=1`,
      [id, firstTextAt])
    seeded.push(id)
  }
  res.json({ seeded: seeded.length, client_ids: seeded, first_text_at: firstTextAt })
})
router.post('/fsbo/junk-off-market', async (_req, res) => {
  try { const m = await import('../fsbo-followup.js'); res.json(await m.fsboDailyMaintenance()) } catch (e) { res.status(500).json({ error: e.message }) }
})

// Smart Audiences (P1-5): the field catalog the condition builder offers.
router.get('/smart/fields', (_req, res) => res.json(fieldMeta()))

// Smart Audiences: preview a condition tree (count + sample). Segmentation only — never sends.
router.post('/smart/preview', (req, res) => {
  try {
    const tree = req.body?.tree ?? req.body ?? {}
    res.json(previewAudience(db, tree, { limit: Math.min(Number(req.body?.limit) || 25, 100) }))
  } catch (e) { res.status(400).json({ error: e.message }) }
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
  if (q.has_fsbo_status) where += " AND fsbo_status IS NOT NULL AND fsbo_status != ''"
  if (q.fsbo_statuses_include?.length) {
    where += ' AND fsbo_status IN (' + q.fsbo_statuses_include.map(() => '?').join(',') + ')'
    params.push(...q.fsbo_statuses_include)
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
