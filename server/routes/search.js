// P2-5: universal cross-entity search. One query → typed hits across clients,
// transactions, tasks, and notes. Read-only.
import { Router } from 'express'
import db from '../database.js'

const router = Router()

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim()
  if (q.length < 2) return res.json({ query: q, results: [] })
  const like = `%${q}%`
  const perType = Math.min(Number(req.query.limit) || 8, 25)
  const results = []
  try {
    for (const c of db.all(
      `SELECT id, first_name, last_name, phone, email, city, status, type FROM clients
       WHERE merged_into IS NULL AND (
         (first_name || ' ' || last_name) LIKE ? OR email LIKE ? OR phone LIKE ? OR address LIKE ? OR city LIKE ?)
       ORDER BY CAST(lead_score AS INTEGER) DESC NULLS LAST LIMIT ?`,
      [like, like, like, like, like, perType]))
      results.push({ type: 'client', id: c.id, title: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone, subtitle: [c.city, c.type, c.status].filter(Boolean).join(' · '), href: `/clients?open=${c.id}` })

    for (const t of db.all(
      `SELECT id, property_address, buyer_name, seller_name, status FROM transactions
       WHERE property_address LIKE ? OR buyer_name LIKE ? OR seller_name LIKE ? ORDER BY updated_at DESC LIMIT ?`,
      [like, like, like, perType]))
      results.push({ type: 'transaction', id: t.id, title: t.property_address || t.buyer_name || t.seller_name || `Transaction ${t.id}`, subtitle: [t.buyer_name || t.seller_name, t.status].filter(Boolean).join(' · '), href: `/transactions?open=${t.id}` })

    for (const t of db.all(
      `SELECT id, title, status, due_date FROM tasks WHERE title LIKE ? OR description LIKE ? ORDER BY created_at DESC LIMIT ?`,
      [like, like, perType]))
      results.push({ type: 'task', id: t.id, title: t.title, subtitle: [t.status, t.due_date ? 'due ' + String(t.due_date).slice(0, 10) : ''].filter(Boolean).join(' · '), href: `/tasks` })

    for (const n of db.all(
      `SELECT id, title, content, related_type, related_id FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY created_at DESC LIMIT ?`,
      [like, like, perType]))
      results.push({ type: 'note', id: n.id, title: n.title || 'Note', subtitle: (n.content || '').slice(0, 80), href: n.related_type === 'client' ? `/clients?open=${n.related_id}` : `/notes` })
  } catch (e) { return res.status(500).json({ error: e.message }) }

  res.json({ query: q, count: results.length, results })
})

export default router
