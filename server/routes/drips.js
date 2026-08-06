import { Router } from 'express'
import db from '../database.js'
import { sendSequenceEmail } from './email.js'
import { bumpPastHolidays, isUsHoliday } from '../holidays.js'

const router = Router()
const parse = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const nowIso = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// timezone: convert a Chicago wall-clock (Y-M-D H:M) into a UTC ISO instant.
// double-applies the tz offset so DST is handled correctly.
// ---------------------------------------------------------------------------
function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {})
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second)
  return asUTC - date.getTime()
}
// target = enrollment/prev-send time + delay_days, then clamp clock to send_time (Chicago)
function nextSendIso(fromMs, delayDays, sendTime) {
  const base = new Date(fromMs + (Number(delayDays) || 0) * 86400000)
  // read the Chicago calendar date of `base`
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(base).reduce((a, x) => (a[x.type] = x.value, a), {})
  const [h, m] = String(sendTime || '09:00').split(':').map(Number)
  const guess = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h || 9, m || 0))
  const off = tzOffsetMs('America/Chicago', guess)
  // never schedule a send on a US federal holiday — push to the next non-holiday day
  return bumpPastHolidays(new Date(guess.getTime() - off).toISOString())
}

// ---------------------------------------------------------------------------
// enrollment (called from Clients UI or the automation engine)
// ---------------------------------------------------------------------------
export function enrollInDrip(dripId, clientId, opts = {}) {
  const drip = db.get('SELECT * FROM drip_campaigns WHERE id = ?', [Number(dripId)])
  if (!drip) return null
  const steps = parse(drip.steps, [])
  if (!steps.length) return null
  // don't double-enroll an active contact
  const active = db.get("SELECT id FROM drip_enrollments WHERE drip_id=? AND client_id=? AND status='active'", [dripId, clientId])
  if (active) return active.id
  const next = nextSendIso(Date.now(), steps[0].delay_days, steps[0].send_time)
  const r = db.run('INSERT INTO drip_enrollments (drip_id, client_id, status, current_step, next_run_at, source, automation_id) VALUES (?,?,?,?,?,?,?)',
    [dripId, clientId, 'active', 0, next, opts.source || 'manual', opts.automation_id || null])
  return r.lastInsertRowid
}

// ---------------------------------------------------------------------------
// engine tick — send any due step, schedule the next
// ---------------------------------------------------------------------------
export async function dripTick() {
  const due = db.all("SELECT * FROM drip_enrollments WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 100", [nowIso()])
  for (const enr of due) {
    try { await advanceDrip(enr) }
    catch (e) { console.error('[drips] step error:', e.message); db.run('UPDATE drip_enrollments SET last_error=? WHERE id=?', [e.message, enr.id]) }
  }
}

async function advanceDrip(enr) {
  const drip = db.get('SELECT * FROM drip_campaigns WHERE id = ?', [enr.drip_id])
  if (!drip) return db.run("UPDATE drip_enrollments SET status='removed', completed_at=? WHERE id=?", [nowIso(), enr.id])
  const steps = parse(drip.steps, [])
  const idx = enr.current_step
  if (idx >= steps.length) return db.run("UPDATE drip_enrollments SET status='completed', completed_at=?, next_run_at=NULL WHERE id=?", [nowIso(), enr.id])
  const step = steps[idx]
  const client = db.get('SELECT * FROM clients WHERE id = ?', [enr.client_id])
  if (!client) return db.run("UPDATE drip_enrollments SET status='removed', completed_at=? WHERE id=?", [nowIso(), enr.id])

  // no sends on US federal holidays — defer to the next non-holiday day
  if (isUsHoliday(new Date())) return db.run('UPDATE drip_enrollments SET next_run_at=? WHERE id=?', [bumpPastHolidays(nowIso()), enr.id])

  // idempotency: one successful send per (enrollment, step)
  const key = `drip${enr.id}_step${idx}`
  const prior = db.get('SELECT * FROM drip_executions WHERE idempotency_key = ?', [key])
  if (!prior || prior.status !== 'success') {
    try {
      const res = await sendSequenceEmail(client, step, `drip_${enr.drip_id}`)
      const status = res.ok ? 'success' : 'success' // a skip (opt-out) still advances; recorded with reason
      if (prior) db.run('UPDATE drip_executions SET status=?, sent_at=?, error=? WHERE id=?', [status, nowIso(), res.ok ? null : res.reason, prior.id])
      else db.run('INSERT INTO drip_executions (enrollment_id, drip_id, step_index, idempotency_key, status, error) VALUES (?,?,?,?,?,?)', [enr.id, enr.drip_id, idx, key, status, res.ok ? null : res.reason])
    } catch (e) {
      // hard failure -> record + retry in ~15 min, up to a few times
      if (prior) db.run('UPDATE drip_executions SET status=?, error=? WHERE id=?', ['failed', e.message, prior.id])
      else db.run('INSERT INTO drip_executions (enrollment_id, drip_id, step_index, idempotency_key, status, error) VALUES (?,?,?,?,?,?)', [enr.id, enr.drip_id, idx, key, 'failed', e.message])
      const attempts = db.get('SELECT COUNT(*) c FROM drip_executions WHERE enrollment_id=? AND step_index=? AND status=\'failed\'', [enr.id, idx]).c
      if (attempts >= 3) return db.run("UPDATE drip_enrollments SET status='failed', last_error=?, completed_at=?, next_run_at=NULL WHERE id=?", [e.message, nowIso(), enr.id])
      // retry this same step shortly (unique key means we won't double-send on success)
      db.run('DELETE FROM drip_executions WHERE idempotency_key=?', [key])
      return db.run('UPDATE drip_enrollments SET next_run_at=?, last_error=? WHERE id=?', [new Date(Date.now() + 15 * 60000).toISOString(), e.message, enr.id])
    }
  }

  // advance to the next step (or complete)
  const nextIdx = idx + 1
  if (nextIdx >= steps.length) {
    db.run("UPDATE drip_enrollments SET status='completed', current_step=?, completed_at=?, next_run_at=NULL WHERE id=?", [nextIdx, nowIso(), enr.id])
  } else {
    const next = nextSendIso(Date.now(), steps[nextIdx].delay_days, steps[nextIdx].send_time)
    db.run('UPDATE drip_enrollments SET current_step=?, next_run_at=? WHERE id=?', [nextIdx, next, enr.id])
  }
}

// ---------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------
function dripStats(id) {
  const s = db.get(`SELECT
    SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
    COUNT(*) AS total FROM drip_enrollments WHERE drip_id=?`, [id]) || {}
  const sent = db.get("SELECT COUNT(*) c FROM drip_executions WHERE drip_id=? AND status='success'", [id]).c
  return { active: s.active || 0, completed: s.completed || 0, failed: s.failed || 0, total: s.total || 0, emails_sent: sent }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const rows = db.all('SELECT * FROM drip_campaigns ORDER BY updated_at DESC')
  res.json(rows.map(d => ({ ...d, steps: parse(d.steps, []), stats: dripStats(d.id) })))
})
router.get('/:id', (req, res) => {
  const d = db.get('SELECT * FROM drip_campaigns WHERE id=?', [Number(req.params.id)])
  if (!d) return res.status(404).json({ error: 'Drip not found' })
  d.steps = parse(d.steps, []); d.stats = dripStats(d.id)
  res.json(d)
})
router.post('/', (req, res) => {
  const b = req.body || {}
  const r = db.run('INSERT INTO drip_campaigns (name, description, steps) VALUES (?,?,?)',
    [b.name || 'Untitled drip', b.description || null, JSON.stringify(b.steps || [])])
  res.status(201).json({ id: r.lastInsertRowid })
})
router.put('/:id', (req, res) => {
  const b = req.body || {}
  const cur = db.get('SELECT * FROM drip_campaigns WHERE id=?', [Number(req.params.id)])
  if (!cur) return res.status(404).json({ error: 'Drip not found' })
  db.run("UPDATE drip_campaigns SET name=?, description=?, steps=?, updated_at=datetime('now') WHERE id=?",
    [b.name ?? cur.name, b.description ?? cur.description, JSON.stringify(b.steps ?? parse(cur.steps, [])), Number(req.params.id)])
  res.json({ success: true })
})
router.delete('/:id', (req, res) => {
  db.run('DELETE FROM drip_campaigns WHERE id=?', [Number(req.params.id)])
  res.json({ success: true })
})

// ---- enroll contacts manually ----
router.post('/:id/enroll', (req, res) => {
  const ids = req.body?.client_ids || []
  let n = 0
  for (const cid of ids) { if (enrollInDrip(Number(req.params.id), Number(cid), { source: 'manual' })) n++ }
  res.json({ success: true, enrolled: n })
})
router.post('/enrollments/:eid/remove', (req, res) => {
  db.run("UPDATE drip_enrollments SET status='removed', completed_at=? WHERE id=?", [nowIso(), Number(req.params.eid)])
  res.json({ success: true })
})

// ---- activity ----
router.get('/:id/activity', (req, res) => {
  const rows = db.all(`SELECT e.*, c.first_name, c.last_name, c.email
    FROM drip_enrollments e LEFT JOIN clients c ON c.id = e.client_id
    WHERE e.drip_id = ? ORDER BY e.entered_at DESC LIMIT 500`, [Number(req.params.id)])
  res.json(rows)
})

export default router
