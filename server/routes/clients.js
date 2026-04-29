import { Router } from 'express'
import db from '../database.js'

const router = Router()

// sql.js doesn't accept undefined, convert to null
const n = (v) => v === undefined ? null : v

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

// Get counts per status for tabs
router.get('/status-counts', (req, res) => {
  const rows = db.all(`SELECT status, COUNT(*) as count FROM clients
    WHERE status IS NOT NULL AND status != ''
    GROUP BY status ORDER BY count DESC`)
  res.json(rows)
})

// Get just the IDs matching a filter (for "select all" mass actions)
router.get('/ids', (req, res) => {
  const { type, status, search } = req.query
  const limit = Math.min(Number(req.query.limit) || 2000, 5000)

  let where = ' WHERE 1=1'
  const params = []
  if (type) { where += ' AND type = ?'; params.push(type) }
  if (status) { where += ' AND status = ?'; params.push(status) }
  if (search) {
    where += ` AND (first_name LIKE ? OR last_name LIKE ?
      OR (first_name || ' ' || last_name) LIKE ?
      OR email LIKE ? OR phone LIKE ?
      OR address LIKE ? OR city LIKE ? OR zip LIKE ?
      OR source LIKE ? OR agent_assigned LIKE ?)`
    const term = `%${search}%`
    params.push(term, term, term, term, term, term, term, term, term, term)
  }
  // Only include clients with valid email for mass action use
  where += " AND email IS NOT NULL AND email != '' AND (marketing_email_opt_out IS NULL OR marketing_email_opt_out = 0)"

  const ids = db.all(`SELECT id FROM clients${where} ORDER BY updated_at DESC LIMIT ?`,
    [...params, limit]).map(r => r.id)
  res.json({ ids, count: ids.length })
})

// Lightweight breakdown - just counts, no rows
router.get('/breakdown', (req, res) => {
  const total = db.get('SELECT COUNT(*) as c FROM clients').c
  const buyers = db.get("SELECT COUNT(*) as c FROM clients WHERE type IN ('buyer','both')").c
  const sellers = db.get("SELECT COUNT(*) as c FROM clients WHERE type IN ('seller','both')").c
  res.json({ total, buyers, sellers })
})

router.get('/', (req, res) => {
  const { type, status, search } = req.query
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  const offset = Number(req.query.offset) || 0

  let where = ' WHERE 1=1'
  const params = []

  if (type) { where += ' AND type = ?'; params.push(type) }
  if (status) { where += ' AND status = ?'; params.push(status) }
  if (search) {
    where += ` AND (first_name LIKE ? OR last_name LIKE ?
      OR (first_name || ' ' || last_name) LIKE ?
      OR email LIKE ? OR phone LIKE ?
      OR address LIKE ? OR city LIKE ? OR zip LIKE ?
      OR source LIKE ? OR agent_assigned LIKE ?)`
    const term = `%${search}%`
    params.push(term, term, term, term, term, term, term, term, term, term)
  }

  const total = db.get(`SELECT COUNT(*) as c FROM clients${where}`, params).c
  const rows = db.all(`SELECT * FROM clients${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset])

  // Return as array for backwards compat, but also include pagination headers
  res.set('X-Total-Count', String(total))
  res.set('X-Page-Limit', String(limit))
  res.set('X-Page-Offset', String(offset))
  res.json(rows)
})

router.get('/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT * FROM clients WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Not found' })

  const transactions = db.all('SELECT * FROM transactions WHERE client_id = ? ORDER BY updated_at DESC', [id])
  const showings = db.all('SELECT * FROM showings WHERE client_id = ? ORDER BY showing_date DESC', [id])
  const tasks = db.all("SELECT * FROM tasks WHERE related_type = 'client' AND related_id = ? ORDER BY due_date ASC", [id])
  const notes = db.all("SELECT * FROM notes WHERE related_type = 'client' AND related_id = ? ORDER BY created_at DESC", [id])

  res.json({ ...row, transactions, showings, tasks, notes })
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
    source, agent_assigned, address, city, budget_min, budget_max, preapproval_amount,
    preapproval_lender, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.first_name, b.last_name, n(b.email), n(b.phone), b.type, b.status || 'active', n(b.source),
      n(b.agent_assigned), n(b.address), n(b.city), n(b.budget_min), n(b.budget_max), n(b.preapproval_amount),
      n(b.preapproval_lender), n(b.notes)])

  logActivity('created', 'client', result.lastInsertRowid, `New ${b.type}: ${b.first_name} ${b.last_name}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]

  db.run(`UPDATE clients SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'client', Number(req.params.id), 'Updated client')
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM clients WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'client', Number(req.params.id), 'Deleted client')
  res.json({ success: true })
})

export default router
