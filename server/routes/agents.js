// Team agent directory — the roster you can assign conversations to and add to a
// client text. Not CRM contacts; team members with a name + phone + title.
import { Router } from 'express'
import db from '../database.js'

const router = Router()

router.get('/', (_req, res) => res.json(db.all('SELECT id, name, phone, title FROM team_agents ORDER BY name')))

router.post('/', (req, res) => {
  const { name, phone, title } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' })
  const r = db.run('INSERT INTO team_agents (name, phone, title) VALUES (?,?,?)', [String(name).trim(), phone ? String(phone).trim() : null, title ? String(title).trim() : null])
  res.json({ success: true, id: r.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const { name, phone, title } = req.body || {}
  const sets = [], vals = []
  if (name !== undefined) { sets.push('name=?'); vals.push(String(name).trim()) }
  if (phone !== undefined) { sets.push('phone=?'); vals.push(phone ? String(phone).trim() : null) }
  if (title !== undefined) { sets.push('title=?'); vals.push(title ? String(title).trim() : null) }
  if (sets.length) { vals.push(Number(req.params.id)); db.run(`UPDATE team_agents SET ${sets.join(', ')} WHERE id=?`, vals) }
  res.json({ success: true })
})

router.delete('/:id', (req, res) => { db.run('DELETE FROM team_agents WHERE id=?', [Number(req.params.id)]); res.json({ success: true }) })

export default router
