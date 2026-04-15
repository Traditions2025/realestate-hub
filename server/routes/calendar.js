import { Router } from 'express'
import db from '../database.js'

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
