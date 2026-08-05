import { Router } from 'express'
import db from '../database.js'

const router = Router()
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ''

// Pull opens/clicks/bounces/unsubscribes for a campaign from SendGrid's category
// stats (the campaign tags every send with its category). Summed across days.
async function categoryStats(category, startDate) {
  if (!SENDGRID_API_KEY || !category) return null
  try {
    const url = new URL('https://api.sendgrid.com/v3/categories/stats')
    url.searchParams.set('start_date', startDate)
    url.searchParams.set('categories', category)
    url.searchParams.set('aggregated_by', 'day')
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` } })
    if (!r.ok) return null
    const data = await r.json()
    const sum = { delivered: 0, opens: 0, unique_opens: 0, clicks: 0, unique_clicks: 0, bounces: 0, unsubscribes: 0, spam_reports: 0 }
    for (const day of (data || [])) for (const s of (day.stats || [])) { const m = s.metrics || {}; for (const k in sum) sum[k] += (m[k] || 0) }
    return sum
  } catch { return null }
}

// Campaign list + live SendGrid engagement stats.
router.get('/campaigns', async (_req, res) => {
  const rows = db.all('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100')
  const out = []
  for (const c of rows) {
    const startDate = String(c.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    const stats = await categoryStats(c.category, startDate)
    out.push({ ...c, stats })
  }
  res.json({ campaigns: out, sendgrid: !!SENDGRID_API_KEY })
})

// Per-campaign recipient log (for the Details view).
router.get('/campaigns/:id/recipients', (req, res) => {
  const rows = db.all('SELECT client_id, to_email, subject, status, error, sent_at FROM email_log WHERE campaign_id = ? ORDER BY sent_at DESC LIMIT 1000', [Number(req.params.id)])
  res.json(rows)
})

export default router
