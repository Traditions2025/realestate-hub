// Admin diagnostics (Phase 15/16 / P0-3): failure visibility + backup health.
// Owner/Admin only. Read-only except resolving failures.
import { Router } from 'express'
import db from '../database.js'
import { requirePermission } from './auth.js'
import { listFailures, failureCounts, resolveFailure, resolveAll } from '../failures.js'

const router = Router()

// P2-6: one-glance system health — every integration, the sync queue, and recent errors.
router.get('/integrations', requirePermission('settings.view'), (_req, res) => {
  try {
    const setting = (k) => db.getSetting?.(k) || null
    const lastSync = db.get("SELECT synced_at, sync_type, leads_synced FROM sierra_sync_log WHERE errors IS NULL OR errors='' ORDER BY synced_at DESC LIMIT 1")
    const lastErr = db.get("SELECT synced_at, errors FROM sierra_sync_log WHERE errors IS NOT NULL AND errors!='' ORDER BY synced_at DESC LIMIT 1")
    const ageMin = (ts) => ts ? Math.round((Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime()) / 60000) : null
    const status = (ok, detail) => ({ ok, detail })
    const twilio = !!(process.env.TWILIO_ACCOUNT_SID || setting('twilio_account_sid'))
    const sendgrid = !!(process.env.SENDGRID_API_KEY || setting('sendgrid_api_key'))
    const anthropic = !!process.env.ANTHROPIC_API_KEY
    const gdrive = !!setting('google_drive_refresh_token')
    const push = (() => { try { return db.get('SELECT COUNT(*) n FROM push_subscriptions').n } catch { return 0 } })()
    res.json({
      integrations: {
        sierra: status(!!lastSync, lastSync ? `last sync ${ageMin(lastSync.synced_at)} min ago (${lastSync.leads_synced} leads)` : 'no successful sync logged'),
        twilio: status(twilio, twilio ? 'configured' : 'not configured'),
        sendgrid: status(sendgrid, sendgrid ? 'configured' : 'not configured'),
        anthropic_ai: status(anthropic, anthropic ? 'key present' : 'no API key'),
        google_drive_backup: status(gdrive, gdrive ? 'connected' : 'not connected'),
        web_push: status(true, `${push} device${push === 1 ? '' : 's'} subscribed`),
      },
      sync: {
        last_success: lastSync?.synced_at || null,
        last_success_age_min: ageMin(lastSync?.synced_at),
        last_error: lastErr ? { at: lastErr.synced_at, message: String(lastErr.errors).slice(0, 200) } : null,
      },
      queues: {
        scheduled_texts_pending: (() => { try { return db.get("SELECT COUNT(*) n FROM scheduled_texts WHERE status='pending'").n } catch { return 0 } })(),
        ai_actions_due: (() => { try { return db.get("SELECT COUNT(*) n FROM ai_lead_state WHERE ai_next_action_at IS NOT NULL AND ai_next_action_at <= datetime('now')").n } catch { return 0 } })(),
        open_handoffs: (() => { try { return db.get("SELECT COUNT(*) n FROM ai_handoffs WHERE status='open'").n } catch { return 0 } })(),
        unread_notifications: (() => { try { return db.get('SELECT COUNT(*) n FROM notifications WHERE read=0').n } catch { return 0 } })(),
      },
      open_failures: failureCounts(),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

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

// P2-7: owner data export. Whitelisted data tables only — never app_settings / auth /
// push_subscriptions (which hold secrets/keys). Streams CSV so it opens in Excel/Sheets.
const EXPORTABLE = {
  clients: 'SELECT id, first_name, last_name, email, phone, type, status, source, agent_assigned, address, city, state, zip, lead_score, fsbo_status, tags, sierra_lead_id, created_at FROM clients WHERE merged_into IS NULL',
  transactions: 'SELECT * FROM transactions',
  tasks: 'SELECT id, title, description, priority, status, due_date, assigned_to, category, related_type, related_id, created_at FROM tasks',
  notes: 'SELECT id, title, content, related_type, related_id, created_at FROM notes',
  communications: 'SELECT id, channel, direction, client_id, contact_name, preview, occurred_at FROM communications',
}
router.get('/export/:table', requirePermission('settings.edit'), (req, res) => {
  const t = String(req.params.table || '').toLowerCase()
  const sql = EXPORTABLE[t]
  if (!sql) return res.status(400).json({ error: 'not exportable', allowed: Object.keys(EXPORTABLE) })
  let rows = []
  try { rows = db.all(sql + ' LIMIT 200000') } catch (e) { return res.status(500).json({ error: e.message }) }
  const cols = rows.length ? Object.keys(rows[0]) : []
  const esc = (v) => { let s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const csv = cols.join(',') + '\r\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\r\n') + (rows.length ? '\r\n' : '')
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${t}-export-${stamp}.csv"`)
  import('../auth/audit.js').then(({ logAudit }) => logAudit({ action: 'data.exported', entity_type: t, req })).catch(() => {})
  res.send(csv)
})
router.get('/export', requirePermission('settings.view'), (_req, res) => res.json({ tables: Object.keys(EXPORTABLE), note: 'Secrets, auth, and push tables are never exported.' }))

// Twilio message history for one number, straight from Twilio's records —
// finds texts sent before the Hub logged communications (pre-Hub blasts).
router.get('/twilio-history', requirePermission('settings.view'), async (req, res) => {
  try {
    const db2 = (await import('../database.js')).default
    const sid = (db2.getSetting('twilio_account_sid', '') || '').trim()
    const token = (db2.getSetting('twilio_auth_token', '') || '').trim()
    if (!sid || !token) return res.status(400).json({ error: 'Twilio not configured' })
    const d10 = String(req.query.to || '').replace(/\D/g, '').slice(-10)
    if (d10.length !== 10) return res.status(400).json({ error: 'to=phone required' })
    const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
    const out = []
    for (const dir of ['To', 'From']) {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?${dir}=%2B1${d10}&PageSize=200`, { headers: { Authorization: auth } })
      const j = await r.json().catch(() => ({}))
      for (const m of (j.messages || [])) out.push({ date: m.date_sent || m.date_created, direction: m.direction, status: m.status, body: String(m.body || '').slice(0, 300) })
    }
    out.sort((a, b) => new Date(a.date) - new Date(b.date))
    res.json({ phone: d10, count: out.length, messages: out })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Calendbook webhook URLs (shared key) — paste these into Calendbook's Webhook integration.
router.get('/calendbook-urls', requirePermission('settings.view'), async (_req, res) => {
  const { calendbookKey } = await import('../calendbook.js')
  const base = (process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com') + '/api/public/calendbook'
  const k = calendbookKey()
  res.json(Object.fromEntries(['booking', 'reschedule', 'cancellation', 'reminder'].map(x => [x, `${base}/${x}?key=${k}`])))
})

// New-lead default agent rule (also runs on every scheduler tick). ?dry=1 previews.
router.post('/assign-default-agent', requirePermission('settings.edit'), async (req, res) => {
  try {
    const { enforceDefaultAgentAssignment } = await import('../agent-assignment.js')
    res.json(enforceDefaultAgentAssignment({ dryRun: req.query.dry === '1' || req.query.dry === 'true' }))
  } catch (e) { res.status(500).json({ error: e.message }) }
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
