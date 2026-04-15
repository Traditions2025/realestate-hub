import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

router.get('/', (req, res) => {
  const { status, category } = req.query
  let sql = 'SELECT * FROM projects WHERE 1=1'
  const params = []

  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (category) { sql += ' AND category = ?'; params.push(category) }

  sql += ' ORDER BY CASE priority WHEN "high" THEN 1 WHEN "medium" THEN 2 WHEN "low" THEN 3 END, updated_at DESC'
  const projects = db.all(sql, params)

  projects.forEach(p => {
    p.task_counts = db.all("SELECT status, COUNT(*) as count FROM tasks WHERE related_type = 'project' AND related_id = ? GROUP BY status", [p.id])
  })

  res.json(projects)
})

router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT * FROM projects WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Not found' })

  row.tasks = db.all("SELECT * FROM tasks WHERE related_type = 'project' AND related_id = ? ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END", [id])
  row.notes = db.all("SELECT * FROM notes WHERE related_type = 'project' AND related_id = ? ORDER BY created_at DESC", [id])

  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run('INSERT INTO projects (name, description, status, category, priority, due_date, owner, progress) VALUES (?,?,?,?,?,?,?,?)',
    [b.name, n(b.description), b.status || 'active', n(b.category), b.priority || 'medium', n(b.due_date), n(b.owner), b.progress || 0])

  logActivity('created', 'project', result.lastInsertRowid, `New project: ${b.name}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE projects SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'project', Number(req.params.id), 'Updated project')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM projects WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'project', Number(req.params.id), 'Deleted project')
  res.json({ success: true })
})

export default router
