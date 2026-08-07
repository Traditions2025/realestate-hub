import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => (v === undefined || v === '' ? null : v)
const FIELDS = ['title', 'slug', 'category', 'status', 'post_date', 'post_time', 'live_url', 'tags', 'cover_url', 'meta_title', 'meta_description', 'author', 'notes']

// A scheduled post whose post_date has arrived (today or earlier, Central) is
// live — surface it as 'posted' so the tracker matches reality. Derived on read
// only (the stored value is left untouched so nothing that publishes off
// status='scheduled' is affected). The status filter runs on the derived value.
const effectiveStatus = (row, today) =>
  (row.status === 'scheduled' && row.post_date && String(row.post_date).slice(0, 10) <= today)
    ? 'posted' : row.status

router.get('/', (req, res) => {
  let sql = 'SELECT * FROM blog_posts WHERE 1=1'
  const p = []
  if (req.query.category) { sql += ' AND category = ?'; p.push(req.query.category) }
  if (req.query.month) { sql += ' AND post_date LIKE ?'; p.push(req.query.month + '%') }
  if (req.query.search) { sql += ' AND (title LIKE ? OR tags LIKE ? OR category LIKE ?)'; const t = `%${req.query.search}%`; p.push(t, t, t) }
  sql += ' ORDER BY (post_date IS NULL), post_date DESC, id DESC'
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  let rows = db.all(sql, p).map(r => ({ ...r, status: effectiveStatus(r, today) }))
  if (req.query.status) rows = rows.filter(r => r.status === req.query.status)
  res.json(rows)
})

router.get('/categories', (_req, res) => {
  res.json(db.all("SELECT DISTINCT category FROM blog_posts WHERE category IS NOT NULL AND category != '' ORDER BY category").map(r => r.category))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM blog_posts WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body || {}
  const cols = FIELDS.filter(f => f in b)
  if (!cols.includes('title')) return res.status(400).json({ error: 'title required' })
  const result = db.run(`INSERT INTO blog_posts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(f => n(b[f])))
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const b = req.body || {}
  const cols = FIELDS.filter(f => f in b)
  if (!cols.length) return res.json({ success: true })
  const sets = cols.map(c => `${c} = ?`).join(', ')
  db.run(`UPDATE blog_posts SET ${sets}, updated_at = datetime('now') WHERE id = ?`, [...cols.map(f => n(b[f])), Number(req.params.id)])
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM blog_posts WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

// Bulk import / upsert. Body: { posts: [...] } or a bare array. Matches on slug
// (preferred) or exact title, so a sync can run repeatedly without duplicating.
router.post('/import', (req, res) => {
  const posts = Array.isArray(req.body) ? req.body : (req.body?.posts || [])
  let added = 0, updated = 0
  db.beginBulk?.()
  try {
    for (const post of posts) {
      if (!post || !post.title) continue
      const existing = post.slug
        ? db.get('SELECT id FROM blog_posts WHERE slug = ?', [post.slug])
        : db.get('SELECT id FROM blog_posts WHERE title = ?', [post.title])
      const cols = FIELDS.filter(f => f in post)
      if (existing) {
        const sets = cols.map(c => `${c} = ?`).join(', ')
        db.run(`UPDATE blog_posts SET ${sets}, updated_at = datetime('now') WHERE id = ?`, [...cols.map(f => n(post[f])), existing.id])
        updated++
      } else {
        db.run(`INSERT INTO blog_posts (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(f => n(post[f])))
        added++
      }
    }
  } finally {
    db.endBulk?.()
  }
  res.json({ added, updated, total: posts.length })
})

export default router
