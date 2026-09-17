import { Router } from 'express'
import db from '../database.js'
import { syncGoogleCalendar } from '../scheduler.js'

const router = Router()
const n = (v) => v === undefined ? null : v

router.get('/', (req, res) => {
  const { event_type, month, date } = req.query
  let sql = 'SELECT * FROM calendar_events WHERE 1=1'
  const params = []
  if (event_type) { sql += ' AND event_type = ?'; params.push(event_type) }
  if (month) { sql += ' AND event_date LIKE ?'; params.push(`${month}%`) }
  if (date) { sql += ' AND event_date = ?'; params.push(date) }
  sql += ' ORDER BY event_date ASC, start_time ASC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM calendar_events WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time,
    end_time, location, description, attendees, related_type, related_id,
    reminder_minutes, recurring, color, completed)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.title, b.event_type, b.event_date, n(b.start_time), n(b.end_time),
      n(b.location), n(b.description), n(b.attendees), n(b.related_type),
      n(b.related_id), b.reminder_minutes || 30, n(b.recurring),
      n(b.color) || 'blue', b.completed || 0])
  res.status(201).json({ id: result.lastInsertRowid })
})

// ---- LEAD APPOINTMENTS (John, 2026-09-17) ----
// Profile "Add appointment": type Showing / Walkthrough / Buyer Meeting + date,
// time, title, notes. Walkthrough auto-titles "Walkthrough - {address} - {name}".
// Notes always carry the lead's Hub profile link. Saved on the Hub calendar AND
// emailed to John + Matt as a real calendar invite (ICS, shows Yes/No in Gmail).
const APPT_TYPES = { showing: 'Showing', walkthrough: 'Walkthrough', buyer_meeting: 'Buyer Meeting' }
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
router.post('/appointment', async (req, res) => {
  try {
    const b = req.body || {}
    const cid = Number(b.client_id)
    const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
    if (!c) return res.status(404).json({ error: 'client not found' })
    const typeKey = String(b.type || 'showing').toLowerCase()
    const typeLabel = APPT_TYPES[typeKey] || 'Appointment'
    if (!b.date || !b.time) return res.status(400).json({ error: 'date and time are required' })
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Lead'
    const address = [c.address, c.city].filter(Boolean).join(', ')
    // Auto-title: walkthrough = address + name + type; others default to type + name.
    const title = String(b.title || '').trim()
      || (typeKey === 'walkthrough' && address ? `Walkthrough - ${address} - ${name}` : `${typeLabel} - ${name}`)
    const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const profileLink = `${hub}/clients/${cid}`
    const notes = String(b.notes || '').trim()
    const description = `Hub profile: ${profileLink}${c.phone ? `\nPhone: ${c.phone}` : ''}${notes ? `\n\n${notes}` : ''}`
    const durationMin = Number(b.duration_minutes) || 60
    // Times come in as local Central date + HH:MM. Store as-is for the Hub calendar;
    // the ICS pins the Central timezone explicitly so invitees see the right hour.
    const startLocal = `${b.date}T${b.time}:00`
    const endDate = new Date(new Date(`${b.date}T${b.time}:00`).getTime() + durationMin * 60000)
    const pad = (x) => String(x).padStart(2, '0')
    const endLocal = `${endDate.getFullYear()}-${pad(endDate.getMonth() + 1)}-${pad(endDate.getDate())}T${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:00`
    const attendees = ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com']
    const ins = db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time, end_time, location, description, attendees, related_type, related_id, reminder_minutes, color)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [title, typeKey, b.date, `${b.time}`, endLocal.slice(11, 16), address || null, description, attendees.join(','), 'client', cid, 30, 'gold'])
    try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['appointment', 'client', cid, `${title} — ${b.date} ${b.time}`]) } catch {}
    // ICS invite (METHOD:REQUEST) → Gmail renders Add-to-calendar with Yes/No/Maybe.
    const fmtIcs = (s) => s.replace(/[-:]/g, '')
    const uid = `hubappt-${ins.lastInsertRowid}@mattsmithteam.com`
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Matt Smith Team Hub//EN', 'METHOD:REQUEST',
      'BEGIN:VTIMEZONE', 'TZID:America/Chicago', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0600', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
      'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'TZOFFSETFROM:-0600', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT', 'END:VTIMEZONE',
      'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
      `DTSTART;TZID=America/Chicago:${fmtIcs(startLocal)}`, `DTEND;TZID=America/Chicago:${fmtIcs(endLocal)}`,
      `SUMMARY:${icsEsc(title)}`, `DESCRIPTION:${icsEsc(description)}`,
      address ? `LOCATION:${icsEsc(address)}` : null,
      'ORGANIZER;CN=Matt Smith Team Hub:mailto:matt@mattsmithteam.com',
      ...attendees.map(a => `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
      'STATUS:CONFIRMED', 'SEQUENCE:0', 'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n')
    const { sendViaSendGrid } = await import('./email.js')
    const whenPretty = new Date(`${b.date}T${b.time}:00`).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
      <p style="font-size:16px;margin:0 0 8px;"><strong>${title}</strong></p>
      <p style="margin:0 0 4px;"><strong>When:</strong> ${whenPretty} (Central)</p>
      ${address ? `<p style="margin:0 0 4px;"><strong>Where:</strong> ${address}</p>` : ''}
      ${notes ? `<p style="margin:8px 0 4px;"><strong>Notes:</strong> ${notes.replace(/</g, '&lt;')}</p>` : ''}
      <p style="margin:12px 0 0;"><a href="${profileLink}" style="display:inline-block;background:#B9963B;color:#241a04;font-weight:700;padding:9px 16px;border-radius:8px;text-decoration:none;">View Lead</a></p></div>`
    const attachment = { content: Buffer.from(ics).toString('base64'), filename: 'invite.ics', type: 'text/calendar; method=REQUEST', disposition: 'attachment' }
    await sendViaSendGrid(attendees.join(','), 'Matt Smith Team', `Appointment: ${title} — ${whenPretty}`, html, null, [], [attachment], [], 'appointment')
    res.status(201).json({ id: ins.lastInsertRowid, title, date: b.date, time: b.time, invited: attendees })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE calendar_events SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM calendar_events WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

// Trigger Google Calendar iCal sync now
router.post('/sync-ical', async (req, res) => {
  try {
    await syncGoogleCalendar()
    const count = db.get('SELECT COUNT(*) as c FROM calendar_events').c
    res.json({ success: true, total_events: count })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Receive synced events from frontend (which calls Google Calendar MCP)
router.post('/sync-google', (req, res) => {
  const { events } = req.body
  if (!events || !Array.isArray(events)) return res.status(400).json({ error: 'events array required' })

  let added = 0
  let updated = 0

  for (const ev of events) {
    if (!ev.title || !ev.event_date) continue

    // Check if already synced by google_event_id
    const existing = ev.google_event_id
      ? db.get('SELECT id FROM calendar_events WHERE google_event_id = ?', [ev.google_event_id])
      : null

    if (existing) {
      db.run(`UPDATE calendar_events SET title=?, event_type=?, event_date=?, start_time=?,
        end_time=?, location=?, description=?, attendees=?, color=?,
        updated_at=datetime('now') WHERE id=?`,
        [ev.title, ev.event_type || 'Other', ev.event_date, n(ev.start_time),
          n(ev.end_time), n(ev.location), n(ev.description), n(ev.attendees),
          n(ev.color) || 'blue', existing.id])
      updated++
    } else {
      db.run(`INSERT INTO calendar_events (title, event_type, event_date, start_time,
        end_time, location, description, attendees, color, google_event_id)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [ev.title, ev.event_type || 'Other', ev.event_date, n(ev.start_time),
          n(ev.end_time), n(ev.location), n(ev.description), n(ev.attendees),
          n(ev.color) || 'blue', n(ev.google_event_id)])
      added++
    }
  }

  db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
    ['synced', 'calendar', `Google Calendar sync: ${added} added, ${updated} updated`])

  res.json({ success: true, added, updated })
})

export default router
