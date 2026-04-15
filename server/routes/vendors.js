import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

router.get('/', (req, res) => {
  const { category, search } = req.query
  let sql = 'SELECT * FROM vendors WHERE 1=1'
  const params = []
  if (category) { sql += ' AND category = ?'; params.push(category) }
  if (search) { sql += ' AND (company_name LIKE ? OR contact_name LIKE ? OR category LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`) }
  sql += ' ORDER BY preferred DESC, company_name ASC'
  res.json(db.all(sql, params))
})

router.get('/categories', (req, res) => {
  const rows = db.all('SELECT DISTINCT category FROM vendors WHERE category IS NOT NULL ORDER BY category')
  res.json(rows.map(r => r.category))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM vendors WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO vendors (company_name, contact_name, category, phone, email,
    website, address, city, state, rating, preferred, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.company_name, n(b.contact_name), b.category, n(b.phone), n(b.email),
      n(b.website), n(b.address), n(b.city), n(b.state) || 'IA', b.rating || 0,
      b.preferred || 0, n(b.notes)])
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE vendors SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM vendors WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

export default router
