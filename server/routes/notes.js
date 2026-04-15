import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

router.get('/', (req, res) => {
  const { related_type, related_id, search } = req.query
  let sql = 'SELECT * FROM notes WHERE 1=1'
  const params = []

  if (related_type) { sql += ' AND related_type = ?'; params.push(related_type) }
  if (related_id) { sql += ' AND related_id = ?'; params.push(Number(related_id)) }
  if (search) { sql += ' AND (title LIKE ? OR content LIKE ?)'; params.push(`%${search}%`, `%${search}%`) }

  sql += ' ORDER BY pinned DESC, updated_at DESC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM notes WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run('INSERT INTO notes (title, content, color, pinned, related_type, related_id, tags) VALUES (?,?,?,?,?,?,?)',
    [b.title, n(b.content), b.color || 'default', b.pinned || 0, n(b.related_type), n(b.related_id), n(b.tags)])

  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE notes SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM notes WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

export default router
