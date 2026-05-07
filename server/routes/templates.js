import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

function logActivity(action, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)',
    [action, 'template', entityId, details])
}

// List templates with optional type / search filters
router.get('/', (req, res) => {
  const { type, q } = req.query
  let where = ' WHERE 1=1'
  const params = []
  if (type) { where += ' AND type = ?'; params.push(type) }
  if (q) {
    where += ' AND (name LIKE ? OR subject LIKE ? OR body LIKE ? OR tags LIKE ? OR category LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like, like, like)
  }
  const rows = db.all(
    `SELECT id, name, type, category, subject, body, is_html, tags, used_count, last_used_at, created_at, updated_at
     FROM templates${where} ORDER BY updated_at DESC`,
    params)
  res.json(rows)
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM templates WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body || {}
  if (!b.name || !b.body) return res.status(400).json({ error: 'name and body required' })
  const type = b.type || 'email'
  const isHtml = b.is_html ? 1 : 0
  const result = db.run(
    `INSERT INTO templates (name, type, category, subject, body, is_html, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [b.name, type, n(b.category), n(b.subject), b.body, isHtml, n(b.tags)])
  logActivity('created', result.lastInsertRowid, `Template: ${b.name}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const b = req.body || {}
  const id = Number(req.params.id)
  const fields = { ...b }
  delete fields.id
  delete fields.created_at
  fields.updated_at = new Date().toISOString()
  if ('is_html' in fields) fields.is_html = fields.is_html ? 1 : 0
  const keys = Object.keys(fields)
  if (!keys.length) return res.json({ success: true })
  const sets = keys.map(k => `${k} = ?`).join(', ')
  db.run(`UPDATE templates SET ${sets} WHERE id = ?`, [...keys.map(k => n(fields[k])), id])
  logActivity('updated', id, `Updated template`)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT name FROM templates WHERE id = ?', [id])
  db.run('DELETE FROM templates WHERE id = ?', [id])
  logActivity('deleted', id, row ? `Deleted template: ${row.name}` : 'Deleted template')
  res.json({ success: true })
})

// Increment usage counter (call when a template is loaded into a composer)
router.post('/:id/used', (req, res) => {
  const id = Number(req.params.id)
  db.run(`UPDATE templates SET used_count = COALESCE(used_count, 0) + 1, last_used_at = datetime('now') WHERE id = ?`, [id])
  res.json({ success: true })
})

// Duplicate a template
router.post('/:id/duplicate', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT * FROM templates WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Not found' })
  const result = db.run(
    `INSERT INTO templates (name, type, category, subject, body, is_html, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`${row.name} (copy)`, row.type, row.category, row.subject, row.body, row.is_html, row.tags])
  res.status(201).json({ id: result.lastInsertRowid })
})

export default router
