import { Router } from 'express'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

router.get('/', (req, res) => {
  const { platform, status, month } = req.query
  let sql = 'SELECT * FROM social_posts WHERE 1=1'
  const params = []
  if (platform) { sql += ' AND platform = ?'; params.push(platform) }
  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (month) { sql += ' AND scheduled_date LIKE ?'; params.push(`${month}%`) }
  sql += ' ORDER BY scheduled_date ASC, scheduled_time ASC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM social_posts WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO social_posts (title, platform, post_type, content, media_url,
    scheduled_date, scheduled_time, status, listing_id, campaign_id, hashtags,
    engagement_likes, engagement_comments, engagement_shares, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.title, b.platform, n(b.post_type), n(b.content), n(b.media_url),
      n(b.scheduled_date), n(b.scheduled_time), n(b.status) || 'draft',
      n(b.listing_id), n(b.campaign_id), n(b.hashtags),
      b.engagement_likes || 0, b.engagement_comments || 0, b.engagement_shares || 0, n(b.notes)])
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = req.body
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE social_posts SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM social_posts WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

export default router
