import { Router } from 'express'
import db from '../database.js'
import { buildClientFilter } from './clients.js'
import { sendViaSendGrid } from './email.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

// ---- merge fields (same as email) ----
function fill(text, c) {
  if (!text) return ''
  return String(text)
    .replace(/\{\{first_name\}\}/g, c.first_name || 'there')
    .replace(/\{\{last_name\}\}/g, c.last_name || '')
    .replace(/\{\{full_name\}\}/g, `${c.first_name || ''} ${c.last_name || ''}`.trim())
    .replace(/\{\{city\}\}/g, c.city || 'Cedar Rapids')
    .replace(/\{\{address\}\}/g, c.address || 'your home')
}
const parseTags = (s) => { try { const a = JSON.parse(s || '[]'); return Array.isArray(a) ? a : [] } catch { return [] } }

// Resolve the audience — reuse the Clients filter engine (conditions + include/exclude).
function resolveAudience(audience) {
  const { where, params } = buildClientFilter(audience || {})
  return db.all(`SELECT * FROM clients${where} LIMIT 5000`, params)
}

// ---- action executors (per matched client) ----
async function runAction(act, client) {
  const cfg = act.config || {}
  switch (act.type) {
    case 'add_tag': {
      const tags = parseTags(client.tags)
      if (cfg.tag && !tags.includes(cfg.tag)) { tags.push(cfg.tag); db.run('UPDATE clients SET tags = ? WHERE id = ?', [JSON.stringify(tags), client.id]) }
      break
    }
    case 'remove_tag': {
      const tags = parseTags(client.tags).filter(t => t !== cfg.tag)
      db.run('UPDATE clients SET tags = ? WHERE id = ?', [JSON.stringify(tags), client.id])
      break
    }
    case 'add_note': {
      const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const note = `[${stamp} · automation] ${fill(cfg.text, client)}`
      const combined = client.notes ? `${note}\n${client.notes}` : note
      db.run('UPDATE clients SET notes = ? WHERE id = ?', [combined, client.id])
      break
    }
    case 'update_status': {
      if (cfg.status) db.run('UPDATE clients SET status = ? WHERE id = ?', [cfg.status, client.id])
      break
    }
    case 'assign': {
      if (cfg.agent) db.run('UPDATE clients SET agent_assigned = ? WHERE id = ?', [cfg.agent, client.id])
      break
    }
    case 'create_task': {
      const due = cfg.days_offset != null && cfg.days_offset !== '' ? new Date(Date.now() + Number(cfg.days_offset) * 86400000).toISOString().slice(0, 10) : null
      try {
        db.run("INSERT INTO tasks (title, status, priority, due_date, related_type, related_id) VALUES (?,?,?,?,?,?)",
          [fill(cfg.title || 'Follow up', client), 'todo', cfg.priority || 'medium', due, 'client', client.id])
      } catch { db.run("INSERT INTO tasks (title, status, priority) VALUES (?,?,?)", [fill(cfg.title || 'Follow up', client), 'todo', cfg.priority || 'medium']) }
      break
    }
    case 'send_email': {
      if (!client.email || client.marketing_email_opt_out) return
      if (['OptedOut', 'WrongAddress', 'ReportedAsSpam'].includes(client.email_status)) return
      let subject = cfg.subject, body = cfg.body
      if (cfg.template_id) {
        const t = db.get('SELECT subject, body FROM templates WHERE id = ?', [Number(cfg.template_id)])
        if (t) { subject = t.subject; body = t.body }
      }
      if (!subject || !body) throw new Error('email action missing template/subject/body')
      await sendViaSendGrid(client.email, `${client.first_name} ${client.last_name}`, fill(subject, client), fill(body, client))
      break
    }
    case 'send_text':
      throw new Error('Twilio SMS not configured yet')
    default:
      throw new Error(`action "${act.type}" not available yet`)
  }
}

// Map the visual flow's Condition steps into a Clients-filter audience.
function audienceFromSteps(steps) {
  const a = {}
  for (const s of steps) {
    if (s.kind !== 'condition') continue
    const c = s.config || {}
    switch (c.field) {
      case 'status':
        if (c.op === 'is_not') { a.statuses_exclude = [...(a.statuses_exclude || []), c.value] }
        else { a.statuses_include = [...(a.statuses_include || []), c.value] }
        break
      case 'tag':
        if (c.op === 'not') { a.tags_exclude = [...(a.tags_exclude || []), c.value] }
        else { a.tags_include = [...(a.tags_include || []), c.value] }
        break
      case 'has_listing_views': a.has_listing_views = '1'; break
      case 'has_email': a.has_email = '1'; break
      case 'last_visit_days':
        if (c.op === 'over') a.fub_days_min = c.value; else a.fub_days_max = c.value
        break
      case 'inactive_days': a.inactive_days = c.value; break
      case 'city': a.cities_include = [...(a.cities_include || []), c.value]; break
    }
  }
  return a
}
function actionsFromSteps(steps) {
  return steps.filter(s => s.kind === 'action').map(s => ({ type: s.actionType, config: s.config || {} }))
}

// Run one automation over its audience. Returns a summary.
export async function runAutomation(auto, { dryRun = false } = {}) {
  let audience, actions
  if (auto.flow_data) {
    const flow = (() => { try { return JSON.parse(auto.flow_data || '{}') } catch { return {} } })()
    const steps = flow.steps || []
    audience = audienceFromSteps(steps)
    actions = actionsFromSteps(steps)
  } else {
    audience = (() => { try { return JSON.parse(auto.audience || '{}') } catch { return {} } })()
    actions = (() => { try { return JSON.parse(auto.actions || '[]') } catch { return [] } })()
  }
  const clients = resolveAudience(audience)
  let done = 0, errors = 0
  const errSamples = []
  if (!dryRun) {
    for (const client of clients) {
      for (const act of actions) {
        try { await runAction(act, client); done++ }
        catch (e) { errors++; if (errSamples.length < 5) errSamples.push(`${act.type}: ${e.message}`) }
      }
    }
    const summary = `${clients.length} matched · ${done} actions · ${errors} errors`
    db.run('UPDATE automations SET last_run_at = datetime(\'now\'), last_run_summary = ? WHERE id = ?', [summary, auto.id])
    db.run('INSERT INTO automation_runs (automation_id, matched, actions_done, errors, detail) VALUES (?,?,?,?,?)',
      [auto.id, clients.length, done, errors, errSamples.join(' | ')])
  }
  return { matched: clients.length, actions_done: done, errors, errSamples }
}

// Scheduler entry: run any enabled schedule_daily automation whose run_time has
// passed today and hasn't run yet today (Chicago time).
export async function runDueAutomations() {
  const rows = db.all("SELECT * FROM automations WHERE enabled = 1 AND trigger_type = 'schedule_daily'")
  if (!rows.length) return
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
  const hh = parts.find(p => p.type === 'hour').value, mm = parts.find(p => p.type === 'minute').value
  const nowMin = Number(hh) * 60 + Number(mm)
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date()) // YYYY-MM-DD
  for (const a of rows) {
    const [rh, rm] = String(a.run_time || '09:00').split(':').map(Number)
    const runMin = (rh || 9) * 60 + (rm || 0)
    if (nowMin < runMin) continue
    const lastKey = a.last_run_at ? String(a.last_run_at).slice(0, 10) : null
    if (lastKey === todayKey) continue  // already ran today
    try { await runAutomation(a); console.log(`[automations] ran "${a.name}"`) }
    catch (e) { console.error('[automations] error:', e.message) }
  }
}

// ---- CRUD ----
router.get('/', (_req, res) => {
  res.json(db.all('SELECT * FROM automations ORDER BY updated_at DESC'))
})
router.get('/:id', (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id = ?', [Number(req.params.id)])
  if (!a) return res.status(404).json({ error: 'Not found' })
  a.recent_runs = db.all('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY run_at DESC LIMIT 10', [a.id])
  res.json(a)
})
router.post('/', (req, res) => {
  const b = req.body || {}
  const flow = b.flow || null
  const r = db.run('INSERT INTO automations (name, enabled, trigger_type, run_time, audience, actions, flow_data) VALUES (?,?,?,?,?,?,?)',
    [b.name || 'Untitled automation', b.enabled ? 1 : 0, flow?.trigger?.type || b.trigger_type || 'schedule_daily', b.run_time || '09:00',
      JSON.stringify(b.audience || {}), JSON.stringify(b.actions || []), flow ? JSON.stringify(flow) : null])
  res.status(201).json({ id: r.lastInsertRowid })
})
router.put('/:id', (req, res) => {
  const b = req.body || {}
  const flow = b.flow || null
  db.run(`UPDATE automations SET name=?, enabled=?, trigger_type=?, run_time=?, audience=?, actions=?, flow_data=?, updated_at=datetime('now') WHERE id=?`,
    [b.name || 'Untitled automation', b.enabled ? 1 : 0, flow?.trigger?.type || b.trigger_type || 'schedule_daily', b.run_time || '09:00',
      JSON.stringify(b.audience || {}), JSON.stringify(b.actions || []), flow ? JSON.stringify(flow) : (b.flow_data || null), Number(req.params.id)])
  res.json({ success: true })
})
router.delete('/:id', (req, res) => {
  db.run('DELETE FROM automations WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

// Preview the audience (count + a few samples) without running.
router.post('/preview-audience', (req, res) => {
  try {
    let audience = req.body?.audience || {}
    if (Array.isArray(req.body?.steps)) audience = audienceFromSteps(req.body.steps)
    else if (Array.isArray(req.body?.flow?.steps)) audience = audienceFromSteps(req.body.flow.steps)
    const { where, params } = buildClientFilter(audience)
    const count = db.get(`SELECT COUNT(*) as c FROM clients${where}`, params).c
    const sample = db.all(`SELECT id, first_name, last_name, email, status FROM clients${where} LIMIT 6`, params)
    res.json({ count, sample })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// Manual run (test now).
router.post('/:id/run-now', async (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id = ?', [Number(req.params.id)])
  if (!a) return res.status(404).json({ error: 'Not found' })
  try { const r = await runAutomation(a, { dryRun: !!req.body?.dry_run }); res.json({ success: true, ...r }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
