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

// Pull EXISTING batch emails sent through SendGrid Marketing Campaigns (Single
// Sends) — e.g. anything sent before the Hub, like "Deal of the Week" — with stats.
async function sendGridSingleSends() {
  if (!SENDGRID_API_KEY) return []
  const H = { Authorization: `Bearer ${SENDGRID_API_KEY}` }
  try {
    const listR = await fetch('https://api.sendgrid.com/v3/marketing/singlesends?page_size=100', { headers: H })
    if (!listR.ok) return []
    const list = (await listR.json()).result || []
    if (!list.length) return []
    const ids = list.map(s => s.id).slice(0, 50)
    // stats endpoint is paginated by singlesend_ids
    let statsById = {}
    try {
      const stR = await fetch(`https://api.sendgrid.com/v3/marketing/stats/singlesends?singlesend_ids=${ids.join('&singlesend_ids=')}&page_size=50`, { headers: H })
      if (stR.ok) for (const r of ((await stR.json()).results || [])) statsById[r.id] = r.stats || {}
    } catch {}
    return list.map(s => {
      const st = statsById[s.id] || {}
      return {
        id: 'sg_' + s.id, source: 'sendgrid', subject: s.name, from_name: 'SendGrid Campaign',
        recipients: st.requests || st.delivered_count || 0, sent: st.delivered_count || 0,
        status: (s.status || 'finished') === 'triggered' ? 'finished' : (s.status || 'finished'),
        created_at: s.send_at || s.created_at,
        stats: { delivered: st.delivered_count || 0, unique_opens: st.unique_open_count || 0, unique_clicks: st.unique_click_count || 0, bounces: st.bounce_count || 0, unsubscribes: st.unsubscribe_count || 0 },
      }
    })
  } catch { return [] }
}

// Campaign list + live SendGrid engagement stats.
router.get('/campaigns', async (_req, res) => {
  const rows = db.all('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100')
  const hub = []
  for (const c of rows) {
    const startDate = String(c.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    const stats = await categoryStats(c.category, startDate)
    hub.push({ ...c, source: 'hub', stats })
  }
  const sg = await sendGridSingleSends()
  // Past Hub bulk sends from BEFORE campaign tracking — grouped from the email log
  // (5+ of the same subject on the same day = a batch). No per-campaign engagement
  // (they weren't category-tagged), but we surface the send with its recipient count.
  const logGroups = db.all(`
    SELECT subject, MAX(from_name) as from_name, MIN(sent_at) as created_at, COUNT(*) as sent
    FROM email_log
    WHERE campaign_id IS NULL AND status = 'sent' AND sent_at IS NOT NULL AND subject IS NOT NULL
    GROUP BY subject, substr(sent_at, 1, 10)
    HAVING COUNT(*) >= 5
    ORDER BY created_at DESC LIMIT 50`)
  const logCampaigns = logGroups.map((g, i) => ({
    id: 'log_' + i, source: 'hub-log', subject: g.subject, from_name: g.from_name || 'Matt Smith Team',
    recipients: g.sent, sent: g.sent, failed: 0, skipped: 0, status: 'finished', created_at: g.created_at, stats: null,
  }))
  const all = [...hub, ...sg, ...logCampaigns].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
  res.json({ campaigns: all, sendgrid: !!SENDGRID_API_KEY })
})

// Per-campaign recipient log (for the Details view).
router.get('/campaigns/:id/recipients', (req, res) => {
  const rows = db.all('SELECT client_id, to_email, subject, status, error, sent_at FROM email_log WHERE campaign_id = ? ORDER BY sent_at DESC LIMIT 1000', [Number(req.params.id)])
  res.json(rows)
})

export default router
