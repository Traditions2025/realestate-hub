import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

router.get('/', (req, res) => {
  const { status, priority, assigned_to, category } = req.query
  let sql = 'SELECT * FROM tasks WHERE 1=1'
  const params = []

  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (priority) { sql += ' AND priority = ?'; params.push(priority) }
  if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to) }
  if (category) { sql += ' AND category = ?'; params.push(category) }

  sql += ' ORDER BY CASE priority WHEN "high" THEN 1 WHEN "medium" THEN 2 WHEN "low" THEN 3 END, due_date ASC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO tasks (title, description, priority, status, due_date,
    assigned_to, category, related_type, related_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    [b.title, n(b.description), b.priority || 'medium', b.status || 'todo', n(b.due_date),
      n(b.assigned_to), n(b.category), n(b.related_type), n(b.related_id)])

  logActivity('created', 'task', result.lastInsertRowid, `New task: ${b.title}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE tasks SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'task', Number(req.params.id), 'Updated task')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM tasks WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'task', Number(req.params.id), 'Deleted task')
  res.json({ success: true })
})

export default router
