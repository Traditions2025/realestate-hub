// Follow-Up Coverage API — read/evaluate coverage, snooze, exclude, settings,
// summaries. The evaluator itself lives in server/followup-coverage.js; these
// routes never send communication.
import { Router } from 'express'
import db from '../database.js'
import { evaluateFollowUpCoverage, recalcCoverage, runCoverageAudit, runCoverageSweep, coverageConfig, COVERAGE_DEFAULTS } from '../followup-coverage.js'

const router = Router()
const nowIso = () => new Date().toISOString()
const MEANINGFUL = "relationship_level IN ('connected','qualified','active_opportunity','client')"

// ---- team-wide summary: dashboard cards, KPI, reporting, per-agent views ----
router.get('/summary', (req, res) => {
  try {
    const g = (sql, params = []) => db.get(sql, params)?.n || 0
    const live = 'client_id IN (SELECT id FROM clients WHERE merged_into IS NULL)'
    const counts = {}
    for (const s of ['protected', 'at_risk', 'unprotected', 'snoozed', 'excluded']) {
      counts[s] = g(`SELECT COUNT(*) n FROM followup_coverage WHERE coverage_status='${s}' AND ${live}`)
    }
    const kpi_unprotected_connected = g(`SELECT COUNT(*) n FROM followup_coverage WHERE coverage_status='unprotected' AND ${MEANINGFUL} AND ${live}`)
    const going_cold_sellers = g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%seller_going_cold%' AND ${live}`)
    const going_cold_buyers = g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%buyer_going_cold%' AND ${live}`)
    const high_intent_no_human = g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%high_intent_no_human_contact%' AND coverage_status IN ('unprotected','at_risk') AND ${live}`)
    const overdue = g(`SELECT COUNT(*) n FROM followup_coverage WHERE overdue_by_days > 0 AND coverage_status IN ('at_risk','unprotected') AND ${live}`)
    const ownerless = g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%ownerless%' AND ${live}`)
    const today = nowIso().slice(0, 10)
    const snoozes_due_today = g('SELECT COUNT(*) n FROM clients WHERE merged_into IS NULL AND snooze_until IS NOT NULL AND substr(snooze_until,1,10) <= ?', [today])
    const avg = db.get(`SELECT AVG(days_since_contact) a FROM followup_coverage WHERE ${MEANINGFUL} AND coverage_status NOT IN ('excluded') AND ${live}`)?.a
    // per-agent accountability (unprotected + overdue by assigned agent)
    const by_agent = db.all(`SELECT coalesce(nullif(trim(c.agent_assigned),''),'(unassigned)') agent,
        SUM(CASE WHEN f.coverage_status='unprotected' AND f.${MEANINGFUL} THEN 1 ELSE 0 END) unprotected,
        SUM(CASE WHEN f.overdue_by_days > 0 THEN 1 ELSE 0 END) overdue
      FROM followup_coverage f JOIN clients c ON c.id = f.client_id
      WHERE c.merged_into IS NULL AND f.coverage_status IN ('unprotected','at_risk') GROUP BY 1 ORDER BY unprotected DESC, overdue DESC LIMIT 12`)
    const by_source = db.all(`SELECT coalesce(nullif(trim(c.source),''),'(none)') source, COUNT(*) n
      FROM followup_coverage f JOIN clients c ON c.id = f.client_id
      WHERE f.coverage_status='unprotected' AND f.${MEANINGFUL} AND c.merged_into IS NULL GROUP BY 1 ORDER BY n DESC LIMIT 10`)
    const by_type = db.all(`SELECT coalesce(nullif(trim(c.type),''),'(none)') type, COUNT(*) n
      FROM followup_coverage f JOIN clients c ON c.id = f.client_id
      WHERE f.coverage_status='unprotected' AND f.${MEANINGFUL} AND c.merged_into IS NULL GROUP BY 1 ORDER BY n DESC LIMIT 10`)
    let audit = null; try { audit = JSON.parse(db.getSetting('coverage_audit_last_result', 'null')) } catch {}
    res.json({ counts, kpi_unprotected_connected, going_cold_sellers, going_cold_buyers, high_intent_no_human, overdue, ownerless, snoozes_due_today, avg_days_since_contact: avg != null ? Math.round(avg) : null, by_agent, by_source, by_type, last_audit: audit })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- settings (silence windows) ----
router.get('/settings', (_req, res) => res.json({ config: coverageConfig(), defaults: COVERAGE_DEFAULTS }))
router.post('/settings', (req, res) => {
  const role = String(req.user?.role || '').toLowerCase()
  if (!(role === 'owner' || role === 'admin' || req.user?.team)) return res.status(403).json({ error: 'Owner/admin only' })
  const body = req.body || {}
  const clean = {}
  for (const k of Object.keys(COVERAGE_DEFAULTS)) {
    const v = Number(body[k])
    if (Number.isFinite(v) && v > 0) clean[k] = v
  }
  db.setSetting('followup_coverage_config', JSON.stringify(clean))
  res.json({ success: true, config: coverageConfig() })
})

// ---- coverage event history for a lead ----
router.get('/events/:clientId', (req, res) => {
  res.json(db.all('SELECT * FROM followup_coverage_events WHERE client_id=? ORDER BY created_at DESC LIMIT 50', [Number(req.params.clientId)]))
})

// ---- manual audit/sweep (also used by verification tooling) ----
router.post('/audit', async (req, res) => {
  try { res.json(await runCoverageAudit({ force: req.query.force === '1' || req.body?.force === true })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/sweep', (_req, res) => { try { res.json(runCoverageSweep()) } catch (e) { res.status(500).json({ error: e.message }) } })

// ---- snooze / exclusion (intentional deferral, never a hiding place) ----
router.post('/:clientId/snooze', (req, res) => {
  const cid = Number(req.params.clientId)
  const until = String(req.body?.until || '').slice(0, 10)
  const reason = String(req.body?.reason || '').slice(0, 300) || null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= nowIso().slice(0, 10)) return res.status(400).json({ error: 'Snooze needs a FUTURE date (YYYY-MM-DD). No snooze-forever.' })
  db.run('UPDATE clients SET snooze_until=?, snooze_reason=?, updated_at=? WHERE id=?', [until + 'T12:00:00Z', reason, nowIso(), cid])
  const ev = recalcCoverage(cid, { actorType: 'user', actorId: req.user?.name || req.user?.email || null })
  res.json({ success: true, coverage: ev })
})
router.post('/:clientId/unsnooze', (req, res) => {
  const cid = Number(req.params.clientId)
  db.run('UPDATE clients SET snooze_until=NULL, snooze_reason=NULL, updated_at=? WHERE id=?', [nowIso(), cid])
  res.json({ success: true, coverage: recalcCoverage(cid, { actorType: 'user', actorId: req.user?.name || null }) })
})
router.post('/:clientId/exclude', (req, res) => {
  const cid = Number(req.params.clientId)
  const reason = String(req.body?.reason || '').trim().slice(0, 200)
  if (!reason) return res.status(400).json({ error: 'An exclusion reason is required (who/why is tracked).' })
  db.run('UPDATE clients SET exclude_reason=?, excluded_by=?, excluded_at=?, updated_at=? WHERE id=?',
    [reason, req.user?.name || req.user?.email || 'unknown', nowIso(), nowIso(), cid])
  res.json({ success: true, coverage: recalcCoverage(cid, { actorType: 'user', actorId: req.user?.name || null }) })
})
router.post('/:clientId/unexclude', (req, res) => {
  const cid = Number(req.params.clientId)
  db.run('UPDATE clients SET exclude_reason=NULL, excluded_by=NULL, excluded_at=NULL, updated_at=? WHERE id=?', [nowIso(), cid])
  res.json({ success: true, coverage: recalcCoverage(cid, { actorType: 'user', actorId: req.user?.name || null }) })
})

// ---- live evaluation for one lead (profile card) ----
router.get('/:clientId', (req, res) => {
  try {
    const ev = recalcCoverage(Number(req.params.clientId), { actorType: 'view' })
    if (!ev) return res.status(404).json({ error: 'client not found' })
    res.json(ev)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
