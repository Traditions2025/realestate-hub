// Admin diagnostics (Phase 15/16 / P0-3): failure visibility + backup health.
// Owner/Admin only. Read-only except resolving failures.
import { Router } from 'express'
import { requirePermission } from './auth.js'
import { listFailures, failureCounts, resolveFailure, resolveAll } from '../failures.js'

const router = Router()

// One call for the admin System Health panel.
router.get('/health', requirePermission('settings.view'), async (_req, res) => {
  try {
    const { getBackupHealth } = await import('../backup.js')
    const { gdriveStatus } = await import('../gdrive-backup.js')
    res.json({ failures: failureCounts(), backup: getBackupHealth(), gdrive: gdriveStatus() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Database diagnostics (integrity, size, journal mode, migrations, sync errors).
router.get('/db-health', requirePermission('settings.view'), async (_req, res) => {
  try { const { getDbHealth } = await import('../database.js'); res.json(getDbHealth()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/failures', requirePermission('settings.view'), (req, res) => {
  res.json(listFailures({ state: req.query.state || 'open', limit: Number(req.query.limit) || 100 }))
})

router.post('/failures/:id/resolve', requirePermission('settings.edit'), (req, res) => {
  const r = resolveFailure(Number(req.params.id))
  import('../auth/audit.js').then(({ logAudit }) => logAudit({ action: 'failure.resolved', entity_type: 'failed_job', entity_id: req.params.id, req })).catch(() => {})
  res.json(r)
})

router.post('/failures/resolve-all', requirePermission('settings.edit'), (req, res) => {
  const r = resolveAll(req.body?.kind || null)
  import('../auth/audit.js').then(({ logAudit }) => logAudit({ action: 'failure.resolved_all', metadata: { kind: req.body?.kind || 'all' }, req })).catch(() => {})
  res.json(r)
})

export default router
