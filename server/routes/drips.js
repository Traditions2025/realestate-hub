import { Router } from 'express'
import db from '../database.js'
import { sendSequenceEmail, previewSequenceEmail, emailHardBlock } from './email.js'
import { bumpPastHolidays, isUsHoliday } from '../holidays.js'
import { isStopStatus } from '../lead-sequences.js'

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
// pick the send minute-of-day: fixed at send_time, or a RANDOM minute in
// [send_time, send_time_end] when a window is set (e.g. 9:00–11:00 → each email
// goes at a different, natural-looking time inside that window).
function pickSendMinutes(start, end) {
  const toMin = (t, def) => { const [hh, mm] = String(t || def).split(':').map(Number); return (hh || 0) * 60 + (mm || 0) }
  const s = toMin(start, '09:00')
  if (!end) return s
  const e = toMin(end, start)
  if (e <= s) return s
  return s + Math.floor(Math.random() * (e - s + 1))
}
const _chParts = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
  .formatToParts(new Date(ms)).reduce((a, x) => (a[x.type] = x.value, a), {})
// Next send instant: on the target day (enroll/prev-send + delay_days), at a RANDOM
// minute in [send_time, send_time_end] (Chicago). If that day.s window already passed
// (e.g. enrolled after 11am for a Day-0 step), roll to the NEXT day.s window so a send
// never fires outside the window. Holidays skipped too.
function nextSendIso(fromMs, step) {
  const toMin = (t, def) => { const [hh, mm] = String(t || def).split(":").map(Number); return (hh || 0) * 60 + (mm || 0) }
  const startM = toMin(step.send_time, "09:00")
  const endM = Math.max(toMin(step.send_time_end, step.send_time), startM)
  const now = _chParts(Date.now())
  const todayYMD = `${now.year}-${now.month}-${now.day}`
  const nowMin = Number(now.hour === "24" ? 0 : now.hour) * 60 + Number(now.minute)
  let dayMs = fromMs + (Number(step.delay_days) || 0) * 86400000
  for (let i = 0; i < 45; i++) {
    const p = _chParts(dayMs)
    const isToday = `${p.year}-${p.month}-${p.day}` === todayYMD
    const lo = isToday ? Math.max(startM, nowMin + 1) : startM
    if (lo > endM) { dayMs += 86400000; continue }
    const mins = endM > lo ? lo + Math.floor(Math.random() * (endM - lo + 1)) : lo
    const guess = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Math.floor(mins / 60), mins % 60))
    const off = tzOffsetMs("America/Chicago", guess)
    return bumpPastHolidays(new Date(guess.getTime() - off).toISOString())
  }
  return bumpPastHolidays(new Date(fromMs + 86400000).toISOString())
}

// ---------------------------------------------------------------------------
// enrollment (called from Clients UI or the automation engine)
// ---------------------------------------------------------------------------
export function enrollInDrip(dripId, clientId, opts = {}) {
  const drip = db.get('SELECT * FROM drip_campaigns WHERE id = ?', [Number(dripId)])
  if (!drip) return null
  const steps = parse(drip.steps, [])
  if (!steps.length) return null
  // never enroll a lead we've been told to stop contacting (Junk / DNC)
  const cli = db.get('SELECT status, email, email_status FROM clients WHERE id = ?', [Number(clientId)])
  if (cli && isStopStatus(cli.status)) return null
  // drips are email-only: skip contacts we could never actually email (no address,
  // throwaway domain, prior spam complaint, known-bad address) so they don't clutter
  // the roster as enrolled-but-silent. Mirrors emailHardBlock at send time. Opt-outs
  // are NOT skipped here — team policy still emails them, tagged.
  if (cli && emailHardBlock(cli)) return null
  // one drip per lead: never stack a second active drip on a contact. If they are
  // already active in THIS drip, treat it as already-enrolled (no-op); if they are
  // active in a DIFFERENT drip, skip so a lead is never in two campaigns at once.
  const activeAny = db.get("SELECT id, drip_id FROM drip_enrollments WHERE client_id=? AND status='active' LIMIT 1", [clientId])
  if (activeAny) return Number(activeAny.drip_id) === Number(dripId) ? activeAny.id : null
  const next = nextSendIso(Date.now(), steps[0])
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

  // stop-contact guard: if the lead was moved to Junk/DNC, pull them out here too
  // (belt-and-suspenders in case the status hook didn't fire), no send.
  if (isStopStatus(client.status)) return db.run("UPDATE drip_enrollments SET status='removed', completed_at=? WHERE id=?", [nowIso(), enr.id])

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
    const next = nextSendIso(Date.now(), steps[nextIdx])
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
  // Enrollment usually PROTECTS these leads — refresh their coverage now.
  import('../followup-coverage.js').then(m => { for (const cid of ids) m.recalcCoverage(Number(cid), { actorType: 'drip' }) }).catch(() => {})
  res.json({ success: true, enrolled: n, skipped: ids.length - n, total: ids.length })
})
router.post('/enrollments/:eid/remove', (req, res) => {
  const row = db.get('SELECT client_id FROM drip_enrollments WHERE id=?', [Number(req.params.eid)])
  db.run("UPDATE drip_enrollments SET status='removed', completed_at=? WHERE id=?", [nowIso(), Number(req.params.eid)])
  // Removing a drip can leave the lead with NOTHING — recalc immediately.
  if (row?.client_id) import('../followup-coverage.js').then(m => m.recalcCoverage(row.client_id, { actorType: 'drip' })).catch(() => {})
  res.json({ success: true })
})

// ---- Action Plans controls: pause / resume / delay a single enrollment ----
// The drip tick only processes status='active', so 'paused' halts sends with no engine change.
router.post('/enrollments/:eid/pause', (req, res) => {
  const e = db.get('SELECT id, status FROM drip_enrollments WHERE id=?', [Number(req.params.eid)])
  if (!e) return res.status(404).json({ error: 'enrollment not found' })
  if (e.status === 'active') db.run("UPDATE drip_enrollments SET status='paused' WHERE id=?", [e.id])
  res.json({ success: true, status: 'paused' })
})
router.post('/enrollments/:eid/resume', (req, res) => {
  const e = db.get('SELECT * FROM drip_enrollments WHERE id=?', [Number(req.params.eid)])
  if (!e) return res.status(404).json({ error: 'enrollment not found' })
  if (e.status !== 'paused') return res.json({ success: true, status: e.status })
  // If the scheduled time passed while paused (or is missing), reschedule the current step for
  // the next send window; otherwise keep the existing future time.
  let next = e.next_run_at
  if (!next || next <= nowIso()) {
    const d = db.get('SELECT steps FROM drip_campaigns WHERE id=?', [e.drip_id])
    const step = parse(d?.steps, [])[e.current_step] || { send_time: '09:00' }
    next = nextSendIso(Date.now(), { ...step, delay_days: 0 })
  }
  db.run("UPDATE drip_enrollments SET status='active', next_run_at=? WHERE id=?", [next, e.id])
  res.json({ success: true, status: 'active', next_run_at: next })
})
// Delay the next email either by a preset { days } OR to an exact { until: 'YYYY-MM-DD' }.
// An explicit date is scheduled inside the campaign's normal send window on that calendar day
// (rolled forward off holidays / a passed window), so a hand-picked date still lands in-hours.
router.post('/enrollments/:eid/delay', (req, res) => {
  const e = db.get('SELECT id, drip_id, current_step, next_run_at FROM drip_enrollments WHERE id=?', [Number(req.params.eid)])
  if (!e) return res.status(404).json({ error: 'enrollment not found' })
  const until = String(req.body?.until || '').trim()
  let next
  if (until) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return res.status(400).json({ error: 'until must be YYYY-MM-DD' })
    const targetMs = Date.parse(until + 'T12:00:00Z')
    if (isNaN(targetMs)) return res.status(400).json({ error: 'invalid date' })
    const step = parse(db.get('SELECT steps FROM drip_campaigns WHERE id=?', [e.drip_id])?.steps, [])[e.current_step] || {}
    next = nextSendIso(Math.max(targetMs, Date.now()), { ...step, delay_days: 0 })   // that day, in the send window
  } else {
    const days = Math.floor(Number(req.body?.days) || 0)
    if (!(days > 0)) return res.status(400).json({ error: 'days must be positive, or pass until' })
    const baseMs = Math.max(Date.now(), e.next_run_at ? new Date(e.next_run_at).getTime() : Date.now())
    next = bumpPastHolidays(new Date(baseMs + days * 86400000).toISOString())
  }
  db.run('UPDATE drip_enrollments SET next_run_at=? WHERE id=?', [next, e.id])
  res.json({ success: true, next_run_at: next })
})

// ---- activity ----
router.get('/:id/activity', (req, res) => {
  const rows = db.all(`SELECT e.*, c.first_name, c.last_name, c.email
    FROM drip_enrollments e LEFT JOIN clients c ON c.id = e.client_id
    WHERE e.drip_id = ? ORDER BY e.entered_at DESC LIMIT 500`, [Number(req.params.id)])
  res.json(rows)
})


// ---- preview a step exactly as it will send (merge fields + signature + property cards) ----
router.get('/:id/preview/:step/:clientId', (req, res) => {
  const d = db.get('SELECT * FROM drip_campaigns WHERE id=?', [Number(req.params.id)])
  if (!d) return res.status(404).json({ error: 'Drip not found' })
  const steps = parse(d.steps, [])
  const step = steps[Number(req.params.step) || 0]
  if (!step) return res.status(404).json({ error: 'Step not found' })
  const client = db.get('SELECT * FROM clients WHERE id=?', [Number(req.params.clientId)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const out = previewSequenceEmail(client, step)
  res.json({ ...out, drip: d.name, step_index: Number(req.params.step) || 0, client_name: `${client.first_name||''} ${client.last_name||''}`.trim(), client_email: client.email })
})

export default router
