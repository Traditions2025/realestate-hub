import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

router.get('/', (req, res) => {
  const { type, status } = req.query
  let sql = 'SELECT * FROM marketing WHERE 1=1'
  const params = []

  if (type) { sql += ' AND type = ?'; params.push(type) }
  if (status) { sql += ' AND status = ?'; params.push(status) }

  sql += ' ORDER BY updated_at DESC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM marketing WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO marketing (name, type, status, platform, budget, spent,
    leads_generated, start_date, end_date, target_audience, description, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name, n(b.type), b.status || 'planned', n(b.platform), n(b.budget), b.spent || 0,
      b.leads_generated || 0, n(b.start_date), n(b.end_date), n(b.target_audience), n(b.description), n(b.notes)])

  logActivity('created', 'marketing', result.lastInsertRowid, `New campaign: ${b.name}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE marketing SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'marketing', Number(req.params.id), 'Updated campaign')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM marketing WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'marketing', Number(req.params.id), 'Deleted campaign')
  res.json({ success: true })
})

export default router
