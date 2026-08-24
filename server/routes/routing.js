// Lead routing config API (P1-6). Owner/Admin only. Rules CRUD, master on/off, history,
// and a manual "run on unassigned" (dry-run or apply). Nothing routes automatically.
import { Router } from 'express'
import db from '../database.js'
import { requirePermission } from './auth.js'
import { logAudit } from '../auth/audit.js'
import { routeUnassigned, routingEnabled } from '../routing.js'

const router = Router()
const parse = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const pub = (r) => ({ id: r.id, name: r.name, enabled: !!r.enabled, priority: r.priority, method: r.method, conditions: parse(r.conditions_json, {}), targets: parse(r.targets_json, []) })

router.get('/settings', requirePermission('settings.view'), (_req, res) => res.json({ enabled: routingEnabled() }))
router.post('/settings', requirePermission('settings.edit'), (req, res) => {
  if (req.body?.enabled !== undefined) { db.setSetting('routing_enabled', req.body.enabled ? '1' : '0'); logAudit({ action: 'routing.toggled', metadata: { enabled: !!req.body.enabled }, req }) }
  res.json({ enabled: routingEnabled() })
})

router.get('/rules', requirePermission('settings.view'), (_req, res) => res.json(db.all('SELECT * FROM routing_rules ORDER BY priority ASC, id ASC').map(pub)))
router.post('/rules', requirePermission('settings.edit'), (req, res) => {
  const b = req.body || {}
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Rule name is required.' })
  const method = ['round_robin', 'weighted', 'specific'].includes(b.method) ? b.method : 'round_robin'
  const r = db.run('INSERT INTO routing_rules (name, enabled, priority, conditions_json, method, targets_json) VALUES (?,?,?,?,?,?)',
    [String(b.name).trim(), b.enabled === false ? 0 : 1, Number(b.priority) || 100, JSON.stringify(b.conditions || {}), method, JSON.stringify(b.targets || [])])
  logAudit({ action: 'routing.rule_created', entity_type: 'routing_rule', entity_id: r.lastInsertRowid, metadata: { name: b.name }, req })
  res.json({ success: true, id: r.lastInsertRowid })
})
router.put('/rules/:id', requirePermission('settings.edit'), (req, res) => {
  const id = Number(req.params.id); const b = req.body || {}
  const sets = [], vals = []
  if (b.name !== undefined) { sets.push('name=?'); vals.push(String(b.name).trim()) }
  if (b.enabled !== undefined) { sets.push('enabled=?'); vals.push(b.enabled ? 1 : 0) }
  if (b.priority !== undefined) { sets.push('priority=?'); vals.push(Number(b.priority) || 100) }
  if (b.method !== undefined) { sets.push('method=?'); vals.push(['round_robin', 'weighted', 'specific'].includes(b.method) ? b.method : 'round_robin') }
  if (b.conditions !== undefined) { sets.push('conditions_json=?'); vals.push(JSON.stringify(b.conditions || {})) }
  if (b.targets !== undefined) { sets.push('targets_json=?'); vals.push(JSON.stringify(b.targets || [])) }
  if (!sets.length) return res.json({ success: true })
  sets.push("updated_at=datetime('now')"); vals.push(id)
  db.run(`UPDATE routing_rules SET ${sets.join(', ')} WHERE id=?`, vals)
  logAudit({ action: 'routing.rule_updated', entity_type: 'routing_rule', entity_id: id, req })
  res.json({ success: true })
})
router.delete('/rules/:id', requirePermission('settings.edit'), (req, res) => { db.run('DELETE FROM routing_rules WHERE id=?', [Number(req.params.id)]); logAudit({ action: 'routing.rule_deleted', entity_type: 'routing_rule', entity_id: req.params.id, req }); res.json({ success: true }) })

router.get('/history', requirePermission('settings.view'), (req, res) => res.json(db.all('SELECT * FROM routing_history ORDER BY id DESC LIMIT ?', [Math.min(500, Number(req.query.limit) || 100)])))

// Manual run: preview (dryRun) or apply routing to currently-unassigned leads.
router.post('/run', requirePermission('settings.edit'), (req, res) => {
  const dryRun = req.body?.apply !== true
  const out = routeUnassigned({ dryRun })
  if (!dryRun && out.ok) logAudit({ action: 'routing.run', metadata: { routed: out.routed }, req })
  res.json(out)
})

export default router
