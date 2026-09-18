// NATIVE APPOINTMENT SCHEDULING (John, 2026-09-18).
//
// Reusable appointment-type system + real availability engine + public booking,
// built ON TOP of the existing calendar: appointments ARE calendar_events rows
// (extended with scheduling columns), so the Hub Calendar page, the ICS team
// invites, and client linkage all keep working unchanged.
//
// First use: the "Fix It or Skip It Walkthrough" Meta seller campaign
// (/book/fix-it-or-skip-it), but nothing here is hard-coded to it — types are
// rows, and each active type gets a booking page at /book/{slug}.
//
// Conventions (existing project practice):
//   - calendar_events stores LOCAL CENTRAL date (event_date YYYY-MM-DD) +
//     start_time (HH:MM). DST safety comes from converting CT wall time to real
//     UTC instants with an Intl-based converter wherever an absolute moment
//     matters (reminders, notice windows) — never naive Date parsing.
//   - Public manage links use crypto-random tokens, never row ids.
//   - Availability is computed SERVER-SIDE and re-checked inside a write
//     transaction at booking time (better-sqlite3 is synchronous, so the
//     transaction is atomic; no separate lock needed).
import db from './database.js'
import crypto from 'crypto'

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const TZ = 'America/Chicago'
const DAY = 86400000

// ---------------------------------------------------------------------------
// CENTRAL-TIME MATH (DST-safe, no naive strings)
// ---------------------------------------------------------------------------
const ctFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' })
export function ctParts(d = new Date()) {
  const p = ctFmt.formatToParts(d); const g = (t) => p.find(x => x.type === t)?.value
  return { date: `${g('year')}-${g('month')}-${g('day')}`, hour: Number(g('hour')) % 24, minute: Number(g('minute')), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) }
}
// CT wall time -> UTC Date. Two-pass offset correction handles DST edges.
export function ctToUtc(dateStr, hm) {
  const [h, m] = String(hm).split(':').map(Number)
  const guess = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)
  for (let i = 0; i < 2; i++) {
    const p = ctParts(guess)
    const diff = (Date.parse(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`) - Date.parse(`${p.date}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:00Z`))
    if (!diff) break
    guess.setTime(guess.getTime() + diff)
  }
  return guess
}
const hm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0) }
export function fmtCtPretty(dateStr, hmStr) {
  const d = ctToUtc(dateStr, hmStr)
  return d.toLocaleString('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------
export function initScheduling() {
  db.run(`CREATE TABLE IF NOT EXISTS appointment_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    public_title TEXT,
    slug TEXT UNIQUE,
    description TEXT,
    duration_min INTEGER NOT NULL DEFAULT 30,
    location_type TEXT DEFAULT 'property',
    team_members TEXT DEFAULT '["Matt Smith"]',
    min_notice_hours INTEGER DEFAULT 4,
    max_days_ahead INTEGER DEFAULT 21,
    buffer_before_min INTEGER DEFAULT 0,
    buffer_after_min INTEGER DEFAULT 15,
    windows_json TEXT,
    questions_json TEXT,
    confirmation_message TEXT,
    require_address INTEGER DEFAULT 0,
    color TEXT DEFAULT 'gold',
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS team_availability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_member TEXT NOT NULL,
    weekday INTEGER NOT NULL,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS availability_exceptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_member TEXT NOT NULL,
    date TEXT NOT NULL,
    start_min INTEGER,
    end_min INTEGER,
    reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS appointment_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    offset_min INTEGER NOT NULL,
    channel TEXT NOT NULL,
    due_at TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    sent_at TEXT,
    UNIQUE(event_id, offset_min, channel)
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS booking_page_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT, event TEXT, session TEXT, meta TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  for (const [col, type] of [
    ['appt_type_id', 'INTEGER'], ['appt_status', 'TEXT'], ['manage_token', 'TEXT'],
    ['team_member', 'TEXT'], ['duration_min', 'INTEGER'], ['answers_json', 'TEXT'],
    ['attribution_json', 'TEXT'], ['source', 'TEXT'], ['campaign', 'TEXT'],
    ['cancelled_at', 'TEXT'], ['cancelled_by', 'TEXT'], ['cancel_reason', 'TEXT'],
    ['rescheduled_from', 'TEXT'],
  ]) { try { db.run(`ALTER TABLE calendar_events ADD COLUMN ${col} ${type}`) } catch {} }
  try { db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_cal_manage_token ON calendar_events(manage_token)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_cal_appt_day ON calendar_events(event_date, appt_status)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_appt_rem_due ON appointment_reminders(state, due_at)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_avail_member ON team_availability(team_member, weekday)') } catch {}

  // Seed: default availability (Matt Smith, Mon-Fri 9-5) — only when empty.
  if (!db.get('SELECT id FROM team_availability LIMIT 1')) {
    for (let wd = 1; wd <= 5; wd++) db.run('INSERT INTO team_availability (team_member, weekday, start_min, end_min) VALUES (?,?,?,?)', ['Matt Smith', wd, 9 * 60, 17 * 60])
  }
  // Seed: Fix It or Skip It Walkthrough (idempotent by slug).
  if (!db.get("SELECT id FROM appointment_types WHERE slug = 'fix-it-or-skip-it'")) {
    db.run(`INSERT INTO appointment_types (name, public_title, slug, description, duration_min, location_type, team_members,
              min_notice_hours, max_days_ahead, buffer_before_min, buffer_after_min, windows_json, questions_json, confirmation_message, require_address, color, active)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['Fix It or Skip It Walkthrough',
       'Book Your 15-Minute Fix It or Skip It Walkthrough',
       'fix-it-or-skip-it',
       "Planning to sell sometime in the next year? Choose a convenient time for us to stop by and take a quick look at the home. We'll help identify what may be worth fixing, updating, or leaving alone before you sell.",
       15, 'property', JSON.stringify(['Matt Smith']),
       4, 21, 0, 15,
       JSON.stringify({ 1: [[600, 960]], 2: [[600, 960]], 3: [[600, 960]], 4: [[600, 960]], 5: [[600, 960]] }),   // type-specific: Mon-Fri 10AM-4PM
       JSON.stringify([
         { key: 'updating', label: "Anything you're already thinking about updating?", type: 'choice',
           options: ['Kitchen', 'Bathrooms', 'Flooring', 'Paint', 'Exterior / landscaping', 'Several things', 'Not sure yet'] },
         { key: 'notes', label: "Anything you'd like us to know before stopping by?", type: 'text' },
       ]),
       "We'll send you a confirmation and reach out if we need anything before the walkthrough.",
       1, 'gold', 1])
  }
}

export const getType = (idOrSlug) =>
  db.get('SELECT * FROM appointment_types WHERE id = ? OR slug = ?', [Number(idOrSlug) || -1, String(idOrSlug)])

// ---------------------------------------------------------------------------
// AVAILABILITY ENGINE — everything computed server-side, in CT wall time.
// ---------------------------------------------------------------------------
function windowsFor(type, member, weekday) {
  // Type-specific windows (if set) intersect the member's general working hours.
  const general = db.all('SELECT start_min, end_min FROM team_availability WHERE team_member = ? AND weekday = ?', [member, weekday])
    .map(r => [r.start_min, r.end_min])
  let wins = general
  try {
    const tw = type.windows_json ? JSON.parse(type.windows_json)[weekday] : null
    if (tw && tw.length) {
      wins = []
      for (const [ts, te] of tw) for (const [gs, ge] of general) {
        const s = Math.max(ts, gs), e = Math.min(te, ge)
        if (e > s) wins.push([s, e])
      }
    }
  } catch {}
  return wins
}

function busyRangesFor(member, dateStr, type) {
  const buf = (Number(type?.buffer_before_min) || 0) + 0   // buffers of the NEW appt are applied at slot level
  const busy = []
  // Existing appointments + any calendar event with a time that day for this member
  // (attendee events without team_member still block: they're on the shared calendar).
  for (const e of db.all(`SELECT start_time, end_time, duration_min, appt_status, team_member FROM calendar_events
      WHERE event_date = ? AND start_time IS NOT NULL AND (appt_status IS NULL OR appt_status IN ('scheduled','confirmed'))`, [dateStr])) {
    if (e.team_member && member && e.team_member !== member) continue
    const s = toMin(e.start_time)
    const eEnd = e.end_time ? toMin(e.end_time) : s + (Number(e.duration_min) || 60)
    // buffer_before = arrive-time before any appointment, buffer_after = leave-time
    // after one: an existing event blocks [start - before, end + after].
    busy.push([s - (Number(type?.buffer_before_min) || 0), eEnd + (Number(type?.buffer_after_min) || 0)])
  }
  // Blocked periods (NULL start/end = whole day)
  for (const x of db.all('SELECT start_min, end_min FROM availability_exceptions WHERE team_member = ? AND date = ?', [member, dateStr])) {
    busy.push([x.start_min == null ? 0 : x.start_min, x.end_min == null ? 1440 : x.end_min])
  }
  return busy
}

export function slotsForDate(type, dateStr, { step = null } = {}) {
  const dur = Number(type.duration_min) || 30
  const slotStep = step || Math.max(15, dur)
  const nowUtc = Date.now()
  const noticeMs = (Number(type.min_notice_hours) || 0) * 3600000
  const maxDate = new Date(nowUtc + (Number(type.max_days_ahead) || 21) * DAY)
  const todayCt = ctParts().date
  if (dateStr < todayCt) return []
  if (dateStr > ctParts(maxDate).date) return []
  // weekday of the CT date: derive via ctParts at noon CT that day (DST-safe)
  const wd = ctParts(ctToUtc(dateStr, '12:00')).weekday
  let members = []
  try { members = JSON.parse(type.team_members || '[]') } catch {}
  if (!members.length) members = ['Matt Smith']
  const out = []
  for (const member of members) {
    const wins = windowsFor(type, member, wd)
    if (!wins.length) continue
    const busy = busyRangesFor(member, dateStr, type)
    for (const [ws, we] of wins) {
      for (let t = Math.ceil(ws / slotStep) * slotStep; t + dur <= we; t += slotStep) {
        const startUtc = ctToUtc(dateStr, hm(t)).getTime()
        if (startUtc < nowUtc + noticeMs) continue
        if (busy.some(([bs, be]) => t < be && t + dur > bs)) continue
        if (!out.some(s => s.time === hm(t))) out.push({ time: hm(t), team_member: member })
      }
    }
  }
  return out.sort((a, b) => toMin(a.time) - toMin(b.time))
}

export function availableDays(type, { days = null } = {}) {
  const horizon = Math.min(Number(type.max_days_ahead) || 21, days || 60)
  const out = []
  for (let i = 0; i <= horizon; i++) {
    const dateStr = ctParts(new Date(Date.now() + i * DAY)).date
    if (out.includes(dateStr)) continue
    if (slotsForDate(type, dateStr).length) out.push(dateStr)
  }
  return out
}

// ---------------------------------------------------------------------------
// LEAD ASSOCIATION — reuse the intake dedupe doctrine: id > phone > email,
// never merge on name. New leads go through the normal clients insert.
// ---------------------------------------------------------------------------
export function findOrCreateLead({ lead_id = null, first = '', last = '', phone = null, email = null, address = null, city = null, state = null, zip = null, source = 'Booking Page' }) {
  if (lead_id && db.get('SELECT id FROM clients WHERE id = ? AND merged_into IS NULL', [Number(lead_id)])) {
    return { client_id: Number(lead_id), matched: 'id' }
  }
  const d10 = String(phone || '').replace(/\D/g, '').slice(-10)
  if (d10.length === 10) {
    const hit = db.all("SELECT id, phone, alt_phones FROM clients WHERE merged_into IS NULL AND (phone LIKE ? OR alt_phones LIKE ?)", ['%' + d10.slice(-4), '%' + d10.slice(-4) + '%'])
      .find(c => [c.phone, ...String(c.alt_phones || '').split(',')].some(p => String(p || '').replace(/\D/g, '').slice(-10) === d10))
    if (hit) return { client_id: hit.id, matched: 'phone' }
  }
  const cleanEmail = String(email || '').trim()
  if (cleanEmail) {
    const hit = db.get('SELECT id FROM clients WHERE lower(email) = lower(?) AND merged_into IS NULL', [cleanEmail])
    if (hit) return { client_id: hit.id, matched: 'email' }
  }
  const now = nowIso()
  const phoneFmt = d10.length === 10 ? `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}` : null
  const r = db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status, source, agent_assigned, register_date, address, city, state, zip, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [first || 'Unknown', last || '', cleanEmail || null, phoneFmt, 'seller', 'new', source, 'Matt Smith', now.slice(0, 10), address, city, state, zip, now, now])
  return { client_id: r.lastInsertRowid, matched: 'created' }
}

// ---------------------------------------------------------------------------
// BOOKING — atomic: availability re-checked inside the transaction.
// ---------------------------------------------------------------------------
const emitApptEvent = (event, clientId, eventId, payload = {}) => {
  try {
    db.run('INSERT OR IGNORE INTO automation_events (event_type, client_id, dedupe_key, payload) VALUES (?,?,?,?)',
      [event, clientId, `${event}_${eventId}_${payload.at || ''}`, JSON.stringify({ appointment_id: eventId, ...payload })])
  } catch {}
}

export function bookAppointment({ type, dateStr, time, client_id, propertyAddress = null, answers = null, attribution = null, source = null, campaign = null, createdBy = 'public', team_member = null, title = null, notes = null }) {
  const dur = Number(type.duration_min) || 30
  const token = crypto.randomBytes(24).toString('base64url')
  // Atomicity: db is synchronous (better-sqlite3 wrapper) and this block has no
  // awaits, so the availability re-check and the INSERT cannot interleave with a
  // concurrent booking — Node runs them back-to-back on one thread.
  const tx = (() => {
    const open = slotsForDate(type, dateStr).find(s => s.time === time && (!team_member || s.team_member === team_member))
    if (!open) throw Object.assign(new Error('That time was just taken — please pick another.'), { code: 'SLOT_TAKEN' })
    const member = team_member || open.team_member
    const c = db.get('SELECT first_name, last_name, phone FROM clients WHERE id = ?', [client_id])
    const name = `${c?.first_name || ''} ${c?.last_name || ''}`.trim() || 'Lead'
    const t = title || `${type.name} - ${name}`
    const endMin = toMin(time) + dur
    const description = `Hub profile: ${HUB}/clients/${client_id}${c?.phone ? `\nPhone: ${c.phone}` : ''}${notes ? `\n\n${notes}` : ''}`
    const ins = db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time, end_time, location, description, attendees, related_type, related_id,
            reminder_minutes, color, appt_type_id, appt_status, manage_token, team_member, duration_min, answers_json, attribution_json, source, campaign)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [t, 'appointment', dateStr, time, hm(endMin), propertyAddress, description,
       'johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com', 'client', client_id,
       30, type.color || 'gold', type.id, 'scheduled', token, member, dur,
       answers ? JSON.stringify(answers) : null, attribution ? JSON.stringify(attribution) : null, source, campaign])
    return { id: ins.lastInsertRowid, token, member, title: t }
  })()
  const r = tx
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', client_id, `Appointment Booked — ${type.name} — ${fmtCtPretty(dateStr, time)}${propertyAddress ? ' — ' + propertyAddress : ''}`]) } catch {}
  createReminders(r.id, type, dateStr, time)
  emitApptEvent('appointment.booked', client_id, r.id, { type: type.slug, at: `${dateStr}T${time}` })
  return r
}

// ---------------------------------------------------------------------------
// REMINDERS — 24h + 2h before by default, SMS + email; dedup by UNIQUE row,
// cancelled/rescheduled appointments cancel pending rows first.
// ---------------------------------------------------------------------------
export const DEFAULT_REMINDERS = [{ offset_min: 1440, channel: 'both' }, { offset_min: 120, channel: 'both' }]

export function createReminders(eventId, type, dateStr, time) {
  const startUtc = ctToUtc(dateStr, time).getTime()
  let plan = DEFAULT_REMINDERS
  try { const q = type.questions_json && JSON.parse(type.questions_json); if (Array.isArray(type.reminders)) plan = type.reminders } catch {}
  for (const rm of plan) {
    if (rm.channel === 'disabled') continue
    const due = new Date(startUtc - rm.offset_min * 60000).toISOString()
    if (new Date(due).getTime() <= Date.now()) continue   // booked inside the window: skip, confirmation covers it
    for (const ch of rm.channel === 'both' ? ['sms', 'email'] : [rm.channel]) {
      try { db.run('INSERT OR IGNORE INTO appointment_reminders (event_id, offset_min, channel, due_at, state) VALUES (?,?,?,?,?)', [eventId, rm.offset_min, ch, due, 'pending']) } catch {}
    }
  }
}
export function cancelReminders(eventId) {
  db.run("UPDATE appointment_reminders SET state = 'canceled' WHERE event_id = ? AND state = 'pending'", [eventId])
}

export async function runAppointmentReminders() {
  initScheduling()
  const due = db.all("SELECT r.*, e.event_date, e.start_time, e.related_id AS client_id, e.location, e.appt_type_id, e.appt_status FROM appointment_reminders r JOIN calendar_events e ON e.id = r.event_id WHERE r.state = 'pending' AND r.due_at <= ? LIMIT 25", [nowIso()])
  let sent = 0
  for (const r of due) {
    // Claim first so a crash can never double-send.
    const claim = db.run("UPDATE appointment_reminders SET state = 'sent', sent_at = ? WHERE id = ? AND state = 'pending'", [nowIso(), r.id])
    if (!claim.changes) continue
    if (!['scheduled', 'confirmed'].includes(r.appt_status)) { db.run("UPDATE appointment_reminders SET state = 'canceled' WHERE id = ?", [r.id]); continue }
    const c = db.get('SELECT * FROM clients WHERE id = ?', [r.client_id])
    if (!c) continue
    const type = db.get('SELECT * FROM appointment_types WHERE id = ?', [r.appt_type_id])
    const when = fmtCtPretty(r.event_date, r.start_time)
    try {
      if (r.channel === 'sms' && c.phone) {
        const body = `Hi ${c.first_name || 'there'}, a reminder from the Matt Smith Team: your ${type?.name || 'appointment'} is ${when}${r.location ? ` at ${r.location}` : ''}. If anything changes, just reply here.`
        await sendApptSms(c, body)
        sent++
      } else if (r.channel === 'email' && c.email) {
        const { sendSequenceEmail } = await import('./routes/email.js')
        await sendSequenceEmail(c, {
          subject: `Reminder: ${type?.public_title || type?.name || 'your appointment'}`,
          body: apptEmailHtml(c.first_name, [
            `A quick reminder about your ${type?.name || 'appointment'} with the Matt Smith Team:`,
            `<strong>${when}</strong>${r.location ? `<br>${r.location}` : ''}`,
            `Need to make a change? <a href="${HUB}/appointment/manage/${db.get('SELECT manage_token FROM calendar_events WHERE id=?', [r.event_id])?.manage_token}">Reschedule or cancel here</a>.`,
          ]),
        }, 'appointment_reminder')
        sent++
      }
    } catch (e) { console.error('[scheduling] reminder send error:', e.message) }
  }
  return { due: due.length, sent }
}

// ---------------------------------------------------------------------------
// CONFIRMATIONS — existing comms rails: Twilio SMS + communications log,
// SendGrid email, ICS team invite, in-app notification.
// ---------------------------------------------------------------------------
async function sendApptSms(client, body) {
  const { canSendSms } = await import('./ai-followup/policy.js')
  const gate = canSendSms(client, { channel: 'automation' })
  if (!gate.ok) return { ok: false, reason: gate.reason }
  const { sendSms } = await import('./twilio.js')
  const r = await sendSms(client.phone, body, { statusCallback: HUB + '/api/inbox/twilio-status' })
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['text', 'outgoing', client.id, name, '', client.phone, body.slice(0, 160), body, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'Scheduler', 'appointment', nowIso()])
  return { ok: true }
}

function apptEmailHtml(first, paras) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
<p>Hi ${String(first || 'there')},</p>
${paras.map(t => `<p>${t}</p>`).join('\n')}
<p>Matt Smith Team<br>RE/MAX Concepts</p></div>`
}

export function buildIcs({ id, title, dateStr, time, endTime, location, description, attendees = [] }) {
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
  const f = (d, t) => `${d.replace(/-/g, '')}T${t.replace(':', '')}00`
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Matt Smith Team Hub//EN', 'METHOD:REQUEST',
    'BEGIN:VTIMEZONE', 'TZID:America/Chicago', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
    'BEGIN:VEVENT', `UID:hubappt-${id}@mattsmithteam.com`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART;TZID=America/Chicago:${f(dateStr, time)}`, `DTEND;TZID=America/Chicago:${f(dateStr, endTime)}`,
    `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(description)}`,
    location ? `LOCATION:${esc(location)}` : null,
    'ORGANIZER;CN=Matt Smith Team:mailto:matt@mattsmithteam.com',
    ...attendees.map(a => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    'STATUS:CONFIRMED', 'SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n')
}

export async function sendBookingConfirmations(eventId) {
  const e = db.get('SELECT * FROM calendar_events WHERE id = ?', [eventId])
  if (!e) return
  const c = db.get('SELECT * FROM clients WHERE id = ?', [e.related_id])
  const type = db.get('SELECT * FROM appointment_types WHERE id = ?', [e.appt_type_id])
  const when = fmtCtPretty(e.event_date, e.start_time)
  const dateOnly = when.split(' at ')[0] || when
  const timeOnly = new Date(ctToUtc(e.event_date, e.start_time)).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' })
  const manage = `${HUB}/appointment/manage/${e.manage_token}`
  // Lead SMS (John's copy)
  if (c?.phone) {
    try {
      await sendApptSms(c, `Hi ${c.first_name || 'there'}, you're all set for your ${type?.name || 'appointment'} with the Matt Smith Team on ${dateOnly} at ${timeOnly}.${e.location ? ` We'll meet you at ${e.location}.` : ''} If anything changes, just reply here.`)
    } catch (err) { console.error('[scheduling] confirm sms:', err.message) }
  }
  // Lead email with reschedule/cancel links
  if (c?.email) {
    try {
      const { sendSequenceEmail } = await import('./routes/email.js')
      await sendSequenceEmail(c, {
        subject: type?.slug === 'fix-it-or-skip-it' ? 'Your Fix It or Skip It Walkthrough is Scheduled' : `Your ${type?.name || 'appointment'} is scheduled`,
        body: apptEmailHtml(c.first_name, [
          `You're booked! Here are the details:`,
          `<strong>${when}</strong>${e.location ? `<br>${e.location}` : ''}<br>${type?.name || 'Appointment'}${e.team_member ? ` with ${e.team_member}` : ''}`,
          type?.slug === 'fix-it-or-skip-it' ? `What to expect: a quick, no-pressure 15-minute walk through the home. We'll point out what may be worth fixing, what's worth updating, and what you can safely skip before selling.` : (type?.confirmation_message || ''),
          `Need to make a change? <a href="${manage}">Reschedule or cancel here</a>.`,
        ].filter(Boolean)),
      }, 'appointment_confirmation')
    } catch (err) { console.error('[scheduling] confirm email:', err.message) }
  }
  // Team ICS invite (existing pattern) + notification
  try {
    const { sendViaSendGrid } = await import('./routes/email.js')
    const ics = buildIcs({ id: e.id, title: e.title, dateStr: e.event_date, time: e.start_time, endTime: e.end_time, location: e.location, description: e.description, attendees: ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com'] })
    const att = { content: Buffer.from(ics).toString('base64'), filename: 'invite.ics', type: 'text/calendar; method=REQUEST', disposition: 'attachment' }
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
<p style="font-size:16px;margin:0 0 8px;"><strong>${e.title}</strong></p>
<p style="margin:0 0 4px;"><strong>When:</strong> ${when} (Central)</p>
${e.location ? `<p style="margin:0 0 4px;"><strong>Where:</strong> ${e.location}</p>` : ''}
${e.source ? `<p style="margin:0 0 4px;"><strong>Source:</strong> ${e.source}${e.campaign ? ' / ' + e.campaign : ''}</p>` : ''}
<p style="margin:12px 0 0;"><a href="${HUB}/clients/${e.related_id}" style="display:inline-block;background:#B9963B;color:#241a04;font-weight:700;padding:9px 16px;border-radius:8px;text-decoration:none;">View Lead</a></p></div>`
    await sendViaSendGrid('johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com', 'Matt Smith Team', `New booking: ${e.title} — ${when}`, html, null, [], [att], [], 'appointment')
  } catch (err) { console.error('[scheduling] team invite:', err.message) }
  try { const { notify } = await import('./notifications.js'); notify({ type: 'appointment', title: `Appointment booked: ${e.title}`, body: when, link: `/clients/${e.related_id}`, client_id: e.related_id, dedupKey: `appt_${e.id}` }) } catch {}
}

// ---------------------------------------------------------------------------
// RESCHEDULE / CANCEL / STATUS
// ---------------------------------------------------------------------------
export function getByToken(token) {
  if (!token || String(token).length < 20) return null
  return db.get('SELECT * FROM calendar_events WHERE manage_token = ?', [String(token)])
}

export function rescheduleAppointment(eventId, dateStr, time, { by = 'client' } = {}) {
  const e = db.get('SELECT * FROM calendar_events WHERE id = ?', [eventId])
  if (!e) throw new Error('not found')
  const type = db.get('SELECT * FROM appointment_types WHERE id = ?', [e.appt_type_id]) || { duration_min: e.duration_min || 30, team_members: JSON.stringify([e.team_member || 'Matt Smith']), min_notice_hours: 0, max_days_ahead: 60 }
  const oldWhen = `${e.event_date} ${e.start_time}`
  const dur = Number(e.duration_min || type.duration_min) || 30
  {
    // Same synchronous-block atomicity as bookAppointment.
    const open = slotsForDate(type, dateStr).find(s => s.time === time)
    if (!open) throw Object.assign(new Error('That time is not available.'), { code: 'SLOT_TAKEN' })
    db.run(`UPDATE calendar_events SET event_date = ?, start_time = ?, end_time = ?, appt_status = 'scheduled', rescheduled_from = ?, updated_at = ? WHERE id = ?`,
      [dateStr, time, hm(toMin(time) + dur), oldWhen, nowIso(), eventId])
  }
  cancelReminders(eventId)
  createReminders(eventId, type, dateStr, time)
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', e.related_id, `Appointment Rescheduled — ${fmtCtPretty(...oldWhen.split(' '))} -> ${fmtCtPretty(dateStr, time)}`]) } catch {}
  emitApptEvent('appointment.rescheduled', e.related_id, eventId, { at: `${dateStr}T${time}`, from: oldWhen })
  return { ok: true }
}

export function cancelAppointment(eventId, { by = 'client', reason = '' } = {}) {
  const e = db.get('SELECT * FROM calendar_events WHERE id = ?', [eventId])
  if (!e) throw new Error('not found')
  db.run("UPDATE calendar_events SET appt_status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ? WHERE id = ?",
    [nowIso(), by, String(reason || '').slice(0, 300), nowIso(), eventId])
  cancelReminders(eventId)
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', e.related_id, `Appointment Cancelled — ${e.title} — ${fmtCtPretty(e.event_date, e.start_time)}${reason ? ` (${reason})` : ''} — by ${by}`]) } catch {}
  emitApptEvent('appointment.cancelled', e.related_id, eventId, { by, reason })
  return { ok: true }
}

export function setAppointmentStatus(eventId, status, { by = 'staff' } = {}) {
  if (!['confirmed', 'completed', 'no_show'].includes(status)) throw new Error('bad status')
  const e = db.get('SELECT * FROM calendar_events WHERE id = ?', [eventId])
  if (!e) throw new Error('not found')
  db.run('UPDATE calendar_events SET appt_status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), eventId])
  if (['completed', 'no_show'].includes(status)) cancelReminders(eventId)
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', e.related_id, `Appointment ${status.replace('_', '-')} — ${e.title}`]) } catch {}
  emitApptEvent('appointment.' + status, e.related_id, eventId, { by })
  return { ok: true }
}

export function trackBookingEvent(slug, event, session, meta = null) {
  try { db.run('INSERT INTO booking_page_events (slug, event, session, meta) VALUES (?,?,?,?)', [String(slug || '').slice(0, 80), String(event || '').slice(0, 40), String(session || '').slice(0, 64), meta ? JSON.stringify(meta).slice(0, 800) : null]) } catch {}
}
