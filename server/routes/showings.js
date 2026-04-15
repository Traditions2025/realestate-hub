import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

router.get('/', (req, res) => {
  const { client_id } = req.query
  let sql = `SELECT s.*, c.first_name || ' ' || c.last_name as client_name
    FROM showings s LEFT JOIN clients c ON s.client_id = c.id WHERE 1=1`
  const params = []

  if (client_id) { sql += ' AND s.client_id = ?'; params.push(Number(client_id)) }

  sql += ' ORDER BY s.showing_date DESC, s.showing_time DESC'
  res.json(db.all(sql, params))
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO showings (client_id, address, city, mls_number, showing_date,
    showing_time, feedback, interest_level, list_price, notes) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [n(b.client_id), b.address, n(b.city), n(b.mls_number), n(b.showing_date), n(b.showing_time),
      n(b.feedback), n(b.interest_level), n(b.list_price), n(b.notes)])

  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE showings SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM showings WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

export default router
