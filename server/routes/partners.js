import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

router.get('/', (req, res) => {
  const { role, search } = req.query
  let sql = 'SELECT * FROM partners WHERE 1=1'
  const params = []
  if (role) { sql += ' AND role = ?'; params.push(role) }
  if (search) { sql += ' AND (name LIKE ? OR company LIKE ? OR role LIKE ? OR specialty LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`) }
  sql += ' ORDER BY preferred DESC, name ASC'
  res.json(db.all(sql, params))
})

router.get('/roles', (req, res) => {
  const rows = db.all('SELECT DISTINCT role FROM partners WHERE role IS NOT NULL ORDER BY role')
  res.json(rows.map(r => r.role))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM partners WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO partners (name, company, role, phone, email, website,
    address, city, state, specialty, relationship_level, referral_count,
    last_referral_date, preferred, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.name, n(b.company), b.role, n(b.phone), n(b.email), n(b.website),
      n(b.address), n(b.city), n(b.state) || 'IA', n(b.specialty),
      n(b.relationship_level) || 'contact', b.referral_count || 0,
      n(b.last_referral_date), b.preferred || 0, n(b.notes)])
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE partners SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM partners WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

export default router
