// Staff-side scheduling API (auth'd): appointment types CRUD, team availability,
// blocked periods, manual booking from a profile, status actions, and the
// funnel stats. The public side lives in routes/booking.js.
import express from 'express'
import db from '../database.js'
import { requirePermission } from './auth.js'
import {
  initScheduling, getType, availableDays, slotsForDate, bookAppointment,
  sendBookingConfirmations, rescheduleAppointment, cancelAppointment,
  setAppointmentStatus, fmtCtPretty,
} from '../scheduling.js'

const router = express.Router()
router.use((_req, _res, next) => { initScheduling(); next() })

// ---- appointment types ----
router.get('/types', (_req, res) => {
  res.json(db.all('SELECT * FROM appointment_types ORDER BY active DESC, id ASC'))
})
router.post('/types', requirePermission('settings.edit'), (req, res) => {
  const b = req.body || {}
  if (!b.name || !b.slug) return res.status(400).json({ error: 'name and slug required' })
  if (!/^[a-z0-9-]{3,60}$/.test(b.slug)) return res.status(400).json({ error: 'slug: lowercase letters, numbers, dashes' })
  try {
    const r = db.run(`INSERT INTO appointment_types (name, public_title, slug, description, duration_min, location_type, team_members, min_notice_hours, max_days_ahead, buffer_before_min, buffer_after_min, windows_json, questions_json, confirmation_message, require_address, color, active)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.name, b.public_title || b.name, b.slug, b.description || '', Number(b.duration_min) || 30, b.location_type || 'property',
       JSON.stringify(b.team_members || ['Matt Smith']), Number(b.min_notice_hours) || 4, Number(b.max_days_ahead) || 21,
       Number(b.buffer_before_min) || 0, Number(b.buffer_after_min) || 0,
       b.windows ? JSON.stringify(b.windows) : null, b.questions ? JSON.stringify(b.questions) : null,
       b.confirmation_message || null, b.require_address ? 1 : 0, b.color || 'gold', 1])
    res.status(201).json({ id: r.lastInsertRowid })
  } catch (e) { res.status(400).json({ error: /UNIQUE/.test(e.message) ? 'slug already in use' : e.message }) }
})
router.put('/types/:id', requirePermission('settings.edit'), (req, res) => {
  const b = req.body || {}
  const t = db.get('SELECT * FROM appointment_types WHERE id = ?', [Number(req.params.id)])
  if (!t) return res.status(404).json({ error: 'not found' })
  db.run(`UPDATE appointment_types SET name=?, public_title=?, description=?, duration_min=?, location_type=?, team_members=?,
          min_notice_hours=?, max_days_ahead=?, buffer_before_min=?, buffer_after_min=?, windows_json=?, questions_json=?,
          confirmation_message=?, require_address=?, active=?, updated_at=? WHERE id=?`,
    [b.name ?? t.name, b.public_title ?? t.public_title, b.description ?? t.description,
     Number(b.duration_min ?? t.duration_min), b.location_type ?? t.location_type,
     b.team_members ? JSON.stringify(b.team_members) : t.team_members,
     Number(b.min_notice_hours ?? t.min_notice_hours), Number(b.max_days_ahead ?? t.max_days_ahead),
     Number(b.buffer_before_min ?? t.buffer_before_min), Number(b.buffer_after_min ?? t.buffer_after_min),
     b.windows !== undefined ? (b.windows ? JSON.stringify(b.windows) : null) : t.windows_json,
     b.questions !== undefined ? (b.questions ? JSON.stringify(b.questions) : null) : t.questions_json,
     b.confirmation_message ?? t.confirmation_message,
     b.require_address !== undefined ? (b.require_address ? 1 : 0) : t.require_address,
     b.active !== undefined ? (b.active ? 1 : 0) : t.active, new Date().toISOString(), t.id])
  res.json({ ok: true })
})
router.delete('/types/:id', requirePermission('settings.edit'), (req, res) => {
  const id = Number(req.params.id)
  const used = db.get('SELECT id FROM calendar_events WHERE appt_type_id = ? LIMIT 1', [id])
  if (used) { db.run('UPDATE appointment_types SET active = 0 WHERE id = ?', [id]); return res.json({ ok: true, archived: true }) }
  db.run('DELETE FROM appointment_types WHERE id = ?', [id])
  res.json({ ok: true, deleted: true })
})

// ---- availability ----
router.get('/availability', (_req, res) => {
  res.json({
    hours: db.all('SELECT * FROM team_availability ORDER BY team_member, weekday, start_min'),
    exceptions: db.all("SELECT * FROM availability_exceptions WHERE date >= date('now','-1 day') ORDER BY date"),
  })
})
router.put('/availability', requirePermission('settings.edit'), (req, res) => {
  // Full replace for one team member: { team_member, hours: [{weekday,start_min,end_min}...] }
  const b = req.body || {}
  if (!b.team_member || !Array.isArray(b.hours)) return res.status(400).json({ error: 'team_member and hours required' })
  {
    db.run('DELETE FROM team_availability WHERE team_member = ?', [b.team_member])
    for (const h of b.hours) {
      const wd = Number(h.weekday), s = Number(h.start_min), e = Number(h.end_min)
      if (wd < 0 || wd > 6 || !(e > s) || s < 0 || e > 1440) continue
      db.run('INSERT INTO team_availability (team_member, weekday, start_min, end_min) VALUES (?,?,?,?)', [b.team_member, wd, s, e])
    }
  }
  res.json({ ok: true })
})
router.post('/exceptions', requirePermission('settings.edit'), (req, res) => {
  const b = req.body || {}
  if (!b.team_member || !/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return res.status(400).json({ error: 'team_member and date required' })
  const r = db.run('INSERT INTO availability_exceptions (team_member, date, start_min, end_min, reason) VALUES (?,?,?,?,?)',
    [b.team_member, b.date, b.start_min != null ? Number(b.start_min) : null, b.end_min != null ? Number(b.end_min) : null, String(b.reason || '').slice(0, 120)])
  res.status(201).json({ id: r.lastInsertRowid })
})
router.delete('/exceptions/:id', requirePermission('settings.edit'), (req, res) => {
  db.run('DELETE FROM availability_exceptions WHERE id = ?', [Number(req.params.id)])
  res.json({ ok: true })
})

// ---- slots for staff booking UI ----
router.get('/types/:idOrSlug/days', (req, res) => {
  const t = getType(req.params.idOrSlug)
  if (!t) return res.status(404).json({ error: 'not found' })
  res.json({ days: availableDays(t) })
})
router.get('/types/:idOrSlug/slots', (req, res) => {
  const t = getType(req.params.idOrSlug)
  if (!t) return res.status(404).json({ error: 'not found' })
  res.json({ slots: slotsForDate(t, String(req.query.date || '')) })
})

// ---- appointments ----
router.get('/client/:id/appointments', (req, res) => {
  const rows = db.all(`SELECT e.*, t.name AS type_name FROM calendar_events e LEFT JOIN appointment_types t ON t.id = e.appt_type_id
    WHERE e.related_type = 'client' AND e.related_id = ? AND (e.appt_status IS NOT NULL OR e.event_type IN ('appointment','showing','walkthrough','buyer_meeting'))
    ORDER BY e.event_date DESC, e.start_time DESC LIMIT 50`, [Number(req.params.id)])
  res.json(rows.map(r => ({ ...r, when: r.start_time ? fmtCtPretty(r.event_date, r.start_time) : r.event_date })))
})
router.post('/appointments', async (req, res) => {
  try {
    const b = req.body || {}
    const t = getType(b.type_id || b.slug)
    if (!t) return res.status(400).json({ error: 'unknown appointment type' })
    const cid = Number(b.client_id)
    const c = db.get('SELECT id, address, city FROM clients WHERE id = ?', [cid])
    if (!c) return res.status(404).json({ error: 'client not found' })
    const r = bookAppointment({
      type: t, dateStr: String(b.date), time: String(b.time), client_id: cid,
      propertyAddress: b.property || [c.address, c.city].filter(Boolean).join(', ') || null,
      team_member: b.team_member || null, notes: b.notes || null,
      source: 'staff', createdBy: req.user?.email || 'staff',
    })
    if (b.send_confirmations !== false) sendBookingConfirmations(r.id).catch(() => {})
    res.status(201).json({ id: r.id, title: r.title })
  } catch (e) {
    if (e.code === 'SLOT_TAKEN') return res.status(409).json({ error: e.message })
    res.status(500).json({ error: e.message })
  }
})
router.get('/appointments/:id', (req, res) => {
  const e = db.get(`SELECT e.*, t.name AS type_name, c.first_name, c.last_name, c.phone, c.email FROM calendar_events e
    LEFT JOIN appointment_types t ON t.id = e.appt_type_id LEFT JOIN clients c ON c.id = e.related_id
    WHERE e.id = ?`, [Number(req.params.id)])
  if (!e) return res.status(404).json({ error: 'not found' })
  res.json({ ...e, when: e.start_time ? fmtCtPretty(e.event_date, e.start_time) : e.event_date })
})
router.post('/appointments/:id/status', (req, res) => {
  try { res.json(setAppointmentStatus(Number(req.params.id), String(req.body?.status || ''), { by: req.user?.email || 'staff' })) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
router.post('/appointments/:id/cancel', (req, res) => {
  try { res.json(cancelAppointment(Number(req.params.id), { by: req.user?.email || 'staff', reason: req.body?.reason || '' })) }
  catch (e) { res.status(400).json({ error: e.message }) }
})
router.post('/appointments/:id/reschedule', (req, res) => {
  try {
    const r = rescheduleAppointment(Number(req.params.id), String(req.body?.date), String(req.body?.time), { by: req.user?.email || 'staff' })
    sendBookingConfirmations(Number(req.params.id)).catch(() => {})
    res.json(r)
  } catch (e) {
    if (e.code === 'SLOT_TAKEN') return res.status(409).json({ error: e.message })
    res.status(400).json({ error: e.message })
  }
})

// ---- funnel stats ----
router.get('/stats', (_req, res) => {
  const by = (sql, params = []) => db.all(sql, params)
  res.json({
    appointments_by_status: by(`SELECT appt_status AS status, COUNT(*) c FROM calendar_events WHERE appt_status IS NOT NULL GROUP BY appt_status`),
    by_type: by(`SELECT t.name, COUNT(*) c FROM calendar_events e JOIN appointment_types t ON t.id = e.appt_type_id GROUP BY t.name`),
    by_source: by(`SELECT COALESCE(e.source,'unknown') source, COUNT(*) c FROM calendar_events e WHERE e.appt_status IS NOT NULL GROUP BY e.source`),
    by_campaign: by(`SELECT COALESCE(e.campaign,'—') campaign, COUNT(*) c FROM calendar_events e WHERE e.appt_status IS NOT NULL GROUP BY e.campaign`),
    page_funnel: by(`SELECT slug, event, COUNT(DISTINCT session) c FROM booking_page_events GROUP BY slug, event`),
  })
})

export default router
