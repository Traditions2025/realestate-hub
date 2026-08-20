// HUB AI ISA — control + reporting API. All mutations are server-authorized; the
// model never reaches these routes. State changes go through the state machine.
import { Router } from 'express'
import db from '../database.js'
import { AI_FLAGS, AI_CONFIG_DEFAULTS, getFlags, getConfig, flag } from '../ai-followup/flags.js'
import { ensureState, getState, transitionAiState, pauseAi, resumeAi, humanTakeover, setEnabled, setManaged, AI_STATES } from '../ai-followup/state.js'
import { getIntent } from '../ai-followup/intent.js'
import { recentAiActions } from '../ai-followup/audit.js'
import { ensurePrefs } from '../ai-followup/policy.js'

const router = Router()
const nowIso = () => new Date().toISOString()

// ---- per-lead AI card ----
router.get('/lead/:id', (req, res) => {
  const cid = Number(req.params.id)
  const client = db.get('SELECT id, first_name, last_name, phone, agent_assigned, status, source FROM clients WHERE id=?', [cid])
  if (!client) return res.status(404).json({ error: 'client not found' })
  const state = ensureState(cid)
  const prefs = ensurePrefs(client)
  const li = db.get('SELECT * FROM lead_intelligence WHERE client_id=?', [cid]) || {}
  const intent = getIntent(cid)
  const lastConsumer = db.get("SELECT body, occurred_at FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
  const openHandoff = db.get("SELECT id, urgency, reason, created_at FROM ai_handoffs WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [cid])
  res.json({
    ai_enabled: state?.ai_enabled === 1, ai_state: state?.ai_state, ai_state_changed_at: state?.ai_state_changed_at,
    ai_last_action_at: state?.ai_last_action_at, ai_next_action_at: state?.ai_next_action_at,
    ai_pause_until: state?.ai_pause_until, ai_pause_reason: state?.ai_pause_reason, ai_owner: state?.ai_owner || client.agent_assigned,
    intent, summary: li.ai_summary || null, lead_type: li.lead_type || client.type,
    prefs: { do_not_text: !!prefs?.do_not_text, do_not_call: !!prefs?.do_not_call, ai_text_enabled: prefs?.ai_text_enabled !== 0, ai_voice_enabled: prefs?.ai_voice_enabled === 1, sms_status: prefs?.sms_status, hub_text_opt_out: !!client.hub_text_opt_out },
    last_consumer_message: lastConsumer ? { text: lastConsumer.body, at: lastConsumer.occurred_at } : null,
    open_handoff: openHandoff || null,
    ai_managed: state?.ai_managed === 1,
    global: { responsive: flag('ai_responsive_text_enabled'), proactive: flag('ai_proactive_text_enabled'), master: flag('ai_followup_enabled'), autopilot: flag('ai_autopilot') },
  })
})

router.get('/lead/:id/history', (req, res) => res.json(recentAiActions(Number(req.params.id), 60)))

// ---- per-lead controls ----
router.post('/lead/:id/enable', (req, res) => { setEnabled(Number(req.params.id), true); setManaged(Number(req.params.id), true); transitionAiState(Number(req.params.id), 'AI_ELIGIBLE', 'enabled by agent'); res.json({ success: true }) })
router.post('/lead/:id/stop', (req, res) => { setEnabled(Number(req.params.id), false); setManaged(Number(req.params.id), false); transitionAiState(Number(req.params.id), 'AI_DISABLED', 'stopped by agent'); res.json({ success: true }) })
router.post('/lead/:id/resume', (req, res) => { resumeAi(Number(req.params.id), 'resumed by agent'); res.json({ success: true }) })
router.post('/lead/:id/takeover', (req, res) => { humanTakeover(Number(req.params.id), 'agent takeover'); res.json({ success: true }) })
router.post('/lead/:id/pause', (req, res) => {
  const cid = Number(req.params.id)
  const opt = String(req.body?.duration || 'until')
  const map = { '1h': 3600e3, 'today': 12 * 3600e3, '3d': 3 * 864e5, '7d': 7 * 864e5 }
  let until = null
  if (map[opt]) until = new Date(Date.now() + map[opt]).toISOString()
  pauseAi(cid, until, req.body?.reason || 'paused by agent')
  res.json({ success: true, until })
})
router.post('/lead/:id/prefs', (req, res) => {
  const cid = Number(req.params.id); const b = req.body || {}
  const c = db.get('SELECT id, phone, hub_text_opt_out FROM clients WHERE id=?', [cid]); if (!c) return res.status(404).json({ error: 'not found' })
  ensurePrefs(c)
  const sets = [], vals = []
  for (const k of ['do_not_text', 'do_not_call', 'ai_text_enabled', 'ai_voice_enabled']) if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(b[k] ? 1 : 0) }
  if (sets.length) { vals.push(cid); db.run(`UPDATE communication_preferences SET ${sets.join(', ')}, updated_at='${nowIso()}' WHERE client_id=?`, vals) }
  res.json({ success: true })
})
// Send an AI message now (proactive opener / manual trigger) — honors all compliance.
router.post('/lead/:id/send-now', async (req, res) => {
  try {
    const cid = Number(req.params.id)
    setManaged(cid, true)   // a manual "Send AI now" enrolls the lead
    const hasInbound = db.get("SELECT id FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' LIMIT 1", [cid])
    const m = await import('../ai-followup/orchestrator.js')
    const lastIn = db.get("SELECT body FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
    const result = hasInbound && lastIn ? await m.handleInboundText(cid, lastIn.body, { force: true }) : await m.handleProactive(cid, { force: true })
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- AI Opportunities (handoff queue) ----
router.get('/opportunities', (req, res) => {
  const status = String(req.query.status || 'open')
  const where = ['h.status = ?']; const params = [status]
  if (req.query.assigned === 'unassigned') where.push("(h.assigned_to IS NULL OR h.assigned_to = '')")
  else if (req.query.assigned) { where.push('h.assigned_to = ?'); params.push(req.query.assigned) }
  if (req.query.urgency) { where.push('h.urgency = ?'); params.push(req.query.urgency) }
  const rows = db.all(`SELECT h.*, c.first_name, c.last_name, c.phone, c.type, c.source, li.ai_summary, li.intent_level
    FROM ai_handoffs h JOIN clients c ON c.id=h.client_id LEFT JOIN lead_intelligence li ON li.client_id=h.client_id
    WHERE ${where.join(' AND ')} ORDER BY (CASE h.urgency WHEN 'urgent' THEN 0 ELSE 1 END), h.intent_score DESC, h.created_at ASC LIMIT 200`, params)
  res.json(rows.map(r => ({
    id: r.id, client_id: r.client_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.phone, phone: r.phone,
    type: r.type, source: r.source, urgency: r.urgency, reason: r.reason, summary: r.summary || r.ai_summary || '',
    recommended_action: r.recommended_action, intent_score: r.intent_score, intent_level: r.intent_level, assigned_to: r.assigned_to,
    status: r.status, created_at: r.created_at,
  })))
})
router.post('/opportunities/:id/ack', (req, res) => { db.run("UPDATE ai_handoffs SET status='acknowledged', acknowledged_at=? WHERE id=?", [nowIso(), Number(req.params.id)]); res.json({ success: true }) })
router.post('/opportunities/:id/resolve', (req, res) => { db.run("UPDATE ai_handoffs SET status='resolved', completed_at=? WHERE id=?", [nowIso(), Number(req.params.id)]); res.json({ success: true }) })

// ---- settings (flags + config) ----
router.get('/settings', (_req, res) => res.json({ flags: getFlags(), config: getConfig() }))
router.post('/settings', (req, res) => {
  const b = req.body || {}
  if (b.flags) for (const f of AI_FLAGS) if (b.flags[f] !== undefined) db.setSetting(f, b.flags[f] ? '1' : '0')
  if (b.config) for (const k of Object.keys(AI_CONFIG_DEFAULTS)) if (b.config[k] !== undefined) db.setSetting(k, String(b.config[k]))
  res.json({ success: true, flags: getFlags(), config: getConfig() })
})

// ---- quality review: recent AI messages the admin can rate ----
router.get('/quality', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const filter = String(req.query.filter || 'sends')
  const conds = [`substr(a.created_at,1,10) >= date('now','-${days} days')`]
  if (filter === 'sends') conds.push("a.action_type IN ('SEND_TEXT','PROACTIVE','NURTURE','REENGAGE') AND a.output_text IS NOT NULL AND a.output_text != ''")
  else if (filter === 'handoffs') conds.push("a.action_type='STATE_TRANSITION' AND a.ai_state_after='HUMAN_HANDOFF_REQUIRED'")
  else if (filter === 'errors') conds.push("a.status='failed'")
  else if (filter === 'rated_bad') conds.push("a.rating IN ('needs_work','incorrect','unsafe')")
  const rows = db.all(`SELECT a.id, a.client_id, a.action_type, a.output_text, a.reason, a.status, a.rating, a.created_at, a.intent_after,
      c.first_name, c.last_name FROM ai_actions a LEFT JOIN clients c ON c.id=a.client_id
      WHERE ${conds.join(' AND ')} ORDER BY a.id DESC LIMIT 100`)
  res.json(rows.map(r => ({ id: r.id, client_id: r.client_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || '(unknown)', action_type: r.action_type, text: r.output_text, reason: r.reason, status: r.status, rating: r.rating, intent: r.intent_after, created_at: r.created_at })))
})
router.post('/actions/:id/rate', (req, res) => {
  const rating = String(req.body?.rating || '')
  if (!['good', 'needs_work', 'incorrect', 'unsafe', ''].includes(rating)) return res.status(400).json({ error: 'invalid rating' })
  db.run('UPDATE ai_actions SET rating=? WHERE id=?', [rating || null, Number(req.params.id)])
  res.json({ success: true })
})

// ---- scheduler health ----
router.get('/scheduler', (_req, res) => {
  const c = (w, p = []) => { try { return db.get(`SELECT COUNT(*) n FROM ai_scheduled_actions WHERE ${w}`, p).n } catch { return 0 } }
  const next = db.get("SELECT execute_at FROM ai_scheduled_actions WHERE state='pending' ORDER BY execute_at ASC LIMIT 1")
  res.json({ pending: c("state='pending'"), processing: c("state='processing'"), completed_24h: c("state='completed' AND completed_at >= datetime('now','-1 day')"), failed: c("state='failed'"), canceled_24h: c("state='canceled' AND completed_at >= datetime('now','-1 day')"), next_execute_at: next?.execute_at || null })
})

// ---- diagnostics ----
router.get('/diagnostics', (_req, res) => {
  const count = (t, w = '1=1', p = []) => { try { return db.get(`SELECT COUNT(*) n FROM ${t} WHERE ${w}`, p).n } catch { return null } }
  res.json({
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    flags: getFlags(), config_present: true,
    ai_states_tracked: count('ai_lead_state'),
    open_handoffs: count('ai_handoffs', "status='open'"),
    pending_scheduled: count('ai_scheduled_actions', "state='pending'"),
    failed_scheduled: count('ai_scheduled_actions', "state='failed'"),
    ai_actions_total: count('ai_actions'),
    ai_sends_24h: count('communications', "sent_by_type='ai' AND occurred_at >= datetime('now','-1 day')"),
    prompt_version: 'hubai-2026.08.20-1',
  })
})

// ---- analytics ----
router.get('/analytics', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const since = `date('now','-${days} days')`
  const c = (w, p = []) => { try { return db.get(`SELECT COUNT(*) n FROM ${w}`, p).n } catch { return 0 } }
  const aiSends = c(`communications WHERE sent_by_type='ai' AND substr(occurred_at,1,10) >= ${since}`)
  const leadsManaged = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications WHERE sent_by_type='ai' AND substr(occurred_at,1,10) >= ${since}`)?.n || 0
  const replies = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications WHERE direction='incoming' AND channel='text' AND client_id IN (SELECT DISTINCT client_id FROM communications WHERE sent_by_type='ai') AND substr(occurred_at,1,10) >= ${since}`)?.n || 0
  const handoffs = c(`ai_handoffs WHERE substr(created_at,1,10) >= ${since}`)
  const handoffsResolved = c(`ai_handoffs WHERE status IN ('acknowledged','contacted','resolved') AND substr(created_at,1,10) >= ${since}`)
  const tokIn = db.get(`SELECT SUM(tokens_input) i, SUM(tokens_output) o FROM ai_actions WHERE substr(created_at,1,10) >= ${since}`) || {}
  const highIntent = db.get(`SELECT COUNT(*) n FROM lead_intelligence WHERE intent_score >= 70`)?.n || 0
  const byDay = db.all(`SELECT substr(occurred_at,1,10) day, COUNT(*) n FROM communications WHERE sent_by_type='ai' AND substr(occurred_at,1,10) >= ${since} GROUP BY day ORDER BY day`)
  res.json({ ai_sends: aiSends, leads_managed: leadsManaged, replies, response_rate: leadsManaged ? Math.round((replies / leadsManaged) * 100) : null, handoffs, handoffs_actioned: handoffsResolved, high_intent_leads: highIntent, tokens_input: tokIn.i || 0, tokens_output: tokIn.o || 0, by_day: byDay })
})

export default router
