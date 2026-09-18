// CALENDBOOK WEBHOOK INTAKE (John, 2026-09-18).
//
// John's Calendbook subscription posts booking events to the Hub so bookings
// made there still land in the CRM: lead matched by phone/email (never name),
// appointment recorded on the shared calendar + the lead's timeline, automation
// events fired, team notified. Calendbook handles its own confirmations and
// reminders, so the Hub does NOT text/email the lead for these bookings —
// no double-messaging.
//
// Calendbook's payload shape isn't formally documented, so every delivery is
// stored RAW in calendbook_webhook_log first, then parsed defensively: a deep
// scan pulls the first email, phone, name, start time and event-type name it
// can find. If parsing can't find a start time, the team still gets a
// notification pointing at the raw log entry — nothing is ever dropped.
//
// Security: shared key in the URL (?key=...), same doctrine as fb-webhook.
import db from './database.js'
import crypto from 'crypto'
import { initScheduling, findOrCreateLead, ctParts, fmtCtPretty } from './scheduling.js'

const nowIso = () => new Date().toISOString()

export function calendbookKey() {
  let k = db.getSetting?.('calendbook_webhook_key')
  if (!k) { k = crypto.randomBytes(18).toString('base64url'); db.setSetting?.('calendbook_webhook_key', k) }
  return k
}

export function initCalendbook() {
  db.run(`CREATE TABLE IF NOT EXISTS calendbook_webhook_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT,
    payload TEXT,
    parsed TEXT,
    event_id INTEGER,
    client_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
}

// ---- defensive payload mining ---------------------------------------------
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
function* walk(obj, path = '') {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) yield* walk(v, path ? `${path}.${k}` : k)
  } else yield [path, obj]
}
export function mineCalendbookPayload(p) {
  const out = { email: null, phone: null, name: null, first: '', last: '', start: null, end: null, type_name: null, notes: null, external_id: null, cancel_reason: null }
  for (const [path, v] of walk(p)) {
    const key = path.toLowerCase()
    const s = v == null ? '' : String(v).trim()
    if (!s) continue
    if (!out.email && EMAIL_RE.test(s) && !/organizer|host|owner/.test(key)) out.email = s
    if (!out.phone && /phone|mobile|tel/.test(key) && s.replace(/\D/g, '').length >= 10) out.phone = s
    if (!out.name && /(invitee|attendee|booker|guest|contact|customer)[._]?(full[._]?)?name$|^name$/.test(key)) out.name = s
    if (!out.start && /start/.test(key) && ISO_RE.test(s)) out.start = s
    if (!out.end && /end/.test(key) && ISO_RE.test(s)) out.end = s
    if (!out.type_name && /(event|meeting|service|appointment)[._-]?(type[._-]?)?(name|title)$|^title$/.test(key)) out.type_name = s
    if (!out.external_id && /(booking|event|appointment)[._-]?(id|uid)$|^uid$|^id$/.test(key) && s.length >= 4) out.external_id = s
    if (!out.notes && /note|message|comment|answer/.test(key) && s.length > 2 && s.length < 2000) out.notes = s
    if (!out.cancel_reason && /reason/.test(key)) out.cancel_reason = s
  }
  // Fallbacks: any ISO datetime anywhere as start; any email at all.
  if (!out.start) for (const [, v] of walk(p)) { const s = String(v || ''); if (ISO_RE.test(s)) { out.start = s; break } }
  if (!out.name) for (const [path, v] of walk(p)) { const key = path.toLowerCase(); if (/name/.test(key) && !/file|event|type|host|organizer|company/.test(key) && String(v || '').trim()) { out.name = String(v).trim(); break } }
  if (out.name) { const parts = out.name.split(/\s+/); out.first = parts[0] || ''; out.last = parts.slice(1).join(' ') }
  return out
}

function findExistingByExternalId(extId) {
  if (!extId) return null
  return db.get("SELECT * FROM calendar_events WHERE source = 'Calendbook' AND attribution_json LIKE ? ORDER BY id DESC LIMIT 1", [`%"calendbook_id":"${String(extId).replace(/"/g, '')}%`])
}

const emitEvent = (event, clientId, eventId, payload = {}) => {
  try {
    db.run('INSERT OR IGNORE INTO automation_events (event_type, client_id, dedupe_key, payload) VALUES (?,?,?,?)',
      [event, clientId, `${event}_cb_${eventId}_${payload.at || ''}`, JSON.stringify({ appointment_id: eventId, via: 'calendbook', ...payload })])
  } catch {}
}

export async function handleCalendbookWebhook(kind, payload) {
  initScheduling(); initCalendbook()
  const log = db.run('INSERT INTO calendbook_webhook_log (kind, payload) VALUES (?,?)', [kind, JSON.stringify(payload).slice(0, 20000)])
  const mined = mineCalendbookPayload(payload)
  db.run('UPDATE calendbook_webhook_log SET parsed = ? WHERE id = ?', [JSON.stringify(mined), log.lastInsertRowid])

  if (kind === 'reminder') return { ok: true, logged: true }   // Calendbook's own reminders — record only

  // Times → CT wall time (payload start is ISO with offset or Z).
  let dateStr = null, timeStr = null, endStr = null
  if (mined.start) {
    const d = new Date(mined.start)
    if (!isNaN(d.getTime())) {
      const ct = ctParts(d)
      dateStr = ct.date
      timeStr = `${String(ct.hour).padStart(2, '0')}:${String(ct.minute).padStart(2, '0')}`
      if (mined.end) { const e = new Date(mined.end); if (!isNaN(e.getTime())) { const ce = ctParts(e); endStr = `${String(ce.hour).padStart(2, '0')}:${String(ce.minute).padStart(2, '0')}` } }
    }
  }

  const existing = findExistingByExternalId(mined.external_id)

  if (kind === 'cancellation') {
    if (existing) {
      const { cancelAppointment } = await import('./scheduling.js')
      cancelAppointment(existing.id, { by: 'calendbook', reason: mined.cancel_reason || 'cancelled in Calendbook' })
      db.run('UPDATE calendbook_webhook_log SET event_id = ?, client_id = ? WHERE id = ?', [existing.id, existing.related_id, log.lastInsertRowid])
      return { ok: true, cancelled: existing.id }
    }
    notifyTeam(`Calendbook cancellation received`, `Couldn't match it to a Hub appointment — see Calendbook log #${log.lastInsertRowid}`, null)
    return { ok: true, unmatched: true }
  }

  // booking + reschedule need contact + time
  if (!mined.email && !mined.phone) {
    notifyTeam('Calendbook webhook: no contact info found', `Raw payload saved as Calendbook log #${log.lastInsertRowid} — needs a look`, null)
    return { ok: true, unparsed: true }
  }
  const { client_id, matched } = findOrCreateLead({
    first: mined.first || 'Unknown', last: mined.last || '', phone: mined.phone, email: mined.email, source: 'Calendbook',
  })

  if (kind === 'reschedule' && existing) {
    const old = `${existing.event_date} ${existing.start_time}`
    db.run("UPDATE calendar_events SET event_date = COALESCE(?, event_date), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time), appt_status = 'scheduled', rescheduled_from = ?, updated_at = ? WHERE id = ?",
      [dateStr, timeStr, endStr, old, nowIso(), existing.id])
    try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', client_id, `Appointment Rescheduled (Calendbook) — ${dateStr ? fmtCtPretty(dateStr, timeStr) : 'time pending'}`]) } catch {}
    emitEvent('appointment.rescheduled', client_id, existing.id, { at: `${dateStr}T${timeStr}` })
    db.run('UPDATE calendbook_webhook_log SET event_id = ?, client_id = ? WHERE id = ?', [existing.id, client_id, log.lastInsertRowid])
    return { ok: true, rescheduled: existing.id }
  }

  // New booking (or a reschedule we never saw the original of): record it.
  const name = mined.name || mined.email || mined.phone
  const typeName = mined.type_name || 'Calendbook Appointment'
  const type = db.get('SELECT * FROM appointment_types WHERE lower(name) = lower(?) OR lower(public_title) = lower(?)', [typeName, typeName])
  const title = `${typeName} - ${name}`
  const ins = db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time, end_time, description, attendees, related_type, related_id,
          reminder_minutes, color, appt_type_id, appt_status, manage_token, team_member, source, attribution_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [title, 'appointment', dateStr || ctParts().date, timeStr, endStr,
     `Booked via Calendbook${mined.notes ? `\n\n${mined.notes}` : ''}`,
     'johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com', 'client', client_id,
     30, type?.color || 'gold', type?.id || null, 'scheduled', crypto.randomBytes(24).toString('base64url'), 'Matt Smith',
     'Calendbook', JSON.stringify({ calendbook_id: mined.external_id || null })])
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', client_id, `Appointment Booked (Calendbook) — ${typeName}${dateStr && timeStr ? ` — ${fmtCtPretty(dateStr, timeStr)}` : ''}`]) } catch {}
  emitEvent('appointment.booked', client_id, ins.lastInsertRowid, { at: `${dateStr}T${timeStr}`, type: typeName })
  notifyTeam(`Calendbook booking: ${name}`, `${typeName}${dateStr && timeStr ? ` — ${fmtCtPretty(dateStr, timeStr)}` : ''} (lead ${matched})`, client_id)
  db.run('UPDATE calendbook_webhook_log SET event_id = ?, client_id = ? WHERE id = ?', [ins.lastInsertRowid, client_id, log.lastInsertRowid])
  return { ok: true, event_id: ins.lastInsertRowid, client_id, matched }
}

function notifyTeam(title, body, clientId) {
  import('./notifications.js').then(m => m.notify({
    type: 'appointment', title, body, link: clientId ? `/clients/${clientId}` : '/calendar', client_id: clientId,
    dedupKey: `cb_${title}_${body}`.slice(0, 120),
  })).catch(() => {})
}
