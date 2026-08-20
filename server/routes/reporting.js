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

// Retroactively pull opens/clicks for a specific subject from SendGrid's Email
// Activity API (works even for sends that were NOT category-tagged, like the
// pre-tracking Hub batches). Requires the Email Activity add-on on the account;
// returns null if it isn't available.
async function fetchActivityMessages(subject, dayIso) {
  if (!SENDGRID_API_KEY || !subject) return null
  try {
    const day = String(dayIso || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    const from = `${day}T00:00:00Z`
    const to = new Date(new Date(from).getTime() + 7 * 86400000).toISOString().slice(0, 19) + 'Z' // 7-day window for late opens
    const safe = String(subject).replace(/"/g, '\\"')
    const q = `subject="${safe}" AND last_event_time BETWEEN TIMESTAMP "${from}" AND TIMESTAMP "${to}"`
    const url = `https://api.sendgrid.com/v3/messages?limit=1000&query=${encodeURIComponent(q)}`
    const r = await fetch(url, { headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` } })
    if (!r.ok) return null
    return (await r.json()).messages || []
  } catch { return null }
}
async function messageActivityStats(subject, dayIso) {
  const msgs = await fetchActivityMessages(subject, dayIso)
  if (msgs == null) return null
  if (!msgs.length) return { delivered: 0, unique_opens: 0, unique_clicks: 0, bounces: 0, unsubscribes: 0, _source: 'activity' }
  return {
    delivered: msgs.filter(m => m.status === 'delivered').length || msgs.length,
    unique_opens: msgs.filter(m => (m.opens_count || 0) > 0).length,
    unique_clicks: msgs.filter(m => (m.clicks_count || 0) > 0).length,
    bounces: msgs.filter(m => m.status === 'bounce' || m.status === 'not_delivered').length,
    unsubscribes: 0,
    _source: 'activity',
  }
}

// The actual sent email (subject/from/body) — pulled from our own email_log so we
// show exactly what went out. Match by campaign_id first, else by subject.
router.get('/email-content', (req, res) => {
  const { subject, campaign_id } = req.query
  let row
  if (campaign_id && /^\d+$/.test(campaign_id)) row = db.get('SELECT subject, from_name, from_email, body, sent_at FROM email_log WHERE campaign_id=? AND body IS NOT NULL ORDER BY sent_at DESC LIMIT 1', [Number(campaign_id)])
  if (!row && subject) row = db.get('SELECT subject, from_name, from_email, body, sent_at FROM email_log WHERE subject=? AND body IS NOT NULL ORDER BY sent_at DESC LIMIT 1', [subject])
  if (!row) return res.status(404).json({ error: 'No stored copy of this email was found. (Emails sent outside the Hub don’t keep a body copy here.)' })
  res.json(row)
})

// Who opened / clicked / bounced / unsubscribed — the recipient list behind a number.
router.get('/recipients', async (req, res) => {
  const { subject, date, metric = 'opens' } = req.query
  const msgs = await fetchActivityMessages(subject, date)
  if (msgs == null) return res.status(200).json({ metric, count: 0, recipients: [], note: 'SendGrid activity feed unavailable.' })
  let rows
  if (metric === 'opens') rows = msgs.filter(m => (m.opens_count || 0) > 0)
  else if (metric === 'clicks') rows = msgs.filter(m => (m.clicks_count || 0) > 0)
  else if (metric === 'bounces') rows = msgs.filter(m => m.status === 'bounce' || m.status === 'not_delivered')
  else if (metric === 'delivered' || metric === 'sent') rows = msgs.filter(m => m.status === 'delivered')
  else rows = msgs
  let recipients = rows.map(m => ({ email: m.to_email, status: m.status, opens: m.opens_count || 0, clicks: m.clicks_count || 0, last_event_time: m.last_event_time }))

  // unsubscribes aren't on the message object — intersect this send's recipients
  // with SendGrid's global unsubscribe suppression list.
  if (metric === 'unsubscribes') {
    let unsub = []
    try {
      const r = await fetch('https://api.sendgrid.com/v3/suppression/unsubscribes?limit=500', { headers: { Authorization: `Bearer ${SENDGRID_API_KEY}` } })
      if (r.ok) unsub = (await r.json()).map(u => String(u.email).toLowerCase())
    } catch {}
    const set = new Set(unsub)
    recipients = msgs.map(m => m.to_email).filter(e => set.has(String(e).toLowerCase())).map(email => ({ email, status: 'unsubscribed' }))
  }

  // attach the contact's name from our CRM
  for (const r of recipients) {
    const c = db.get('SELECT id, first_name, last_name FROM clients WHERE lower(email) = lower(?) LIMIT 1', [r.email])
    r.name = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : ''
    r.client_id = c ? c.id : null
  }
  res.json({ metric, count: recipients.length, recipients })
})

// Diagnostic: is open/click tracking on, and is the Email Activity API reachable?
router.get('/_diag', async (req, res) => {
  const H = { Authorization: `Bearer ${SENDGRID_API_KEY}` }
  const out = { sendgrid_key: !!SENDGRID_API_KEY }
  try {
    const t = await fetch('https://api.sendgrid.com/v3/tracking_settings', { headers: H })
    out.tracking_status = t.status
    if (t.ok) { const d = await t.json(); out.tracking = (d.result || []).map(s => `${s.name}:${s.enabled}`) }
  } catch (e) { out.tracking_error = e.message }
  try {
    const m = await fetch('https://api.sendgrid.com/v3/messages?limit=1', { headers: H })
    out.activity_api_status = m.status
    out.activity_api_available = m.ok
    if (!m.ok) out.activity_api_body = (await m.text()).slice(0, 200)
  } catch (e) { out.activity_error = e.message }
  if (req.query.subject) out.subject_stats = await messageActivityStats(req.query.subject, req.query.date)
  res.json(out)
})

// The rows themselves, straight from our DB — instant, no SendGrid.
function baseCampaignRows() {
  const rows = db.all('SELECT * FROM email_campaigns ORDER BY created_at DESC LIMIT 100')
  const hub = rows.map(c => ({ ...c, source: 'hub' }))
  const logGroups = db.all(`
    SELECT subject, MAX(from_name) as from_name, MIN(sent_at) as created_at, COUNT(*) as sent
    FROM email_log
    WHERE campaign_id IS NULL AND status = 'sent' AND sent_at IS NOT NULL AND subject IS NOT NULL
    GROUP BY subject, substr(sent_at, 1, 10)
    HAVING COUNT(*) >= 5
    ORDER BY created_at DESC LIMIT 50`)
  const logCampaigns = logGroups.map((g, i) => ({
    id: 'log_' + i, source: 'hub-log', subject: g.subject, from_name: g.from_name || 'Matt Smith Team',
    recipients: g.sent, sent: g.sent, failed: 0, skipped: 0, status: 'finished', created_at: g.created_at,
    _statKey: { kind: 'activity', subject: g.subject, date: g.created_at },
  }))
  return { hub, logCampaigns }
}

// Attach SendGrid engagement to the base rows (the slow part — several ~6s API calls).
async function withEngagement() {
  const { hub, logCampaigns } = baseCampaignRows()
  const hubStatted = await Promise.all(hub.map(async c => {
    const startDate = String(c.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10)
    return { ...c, stats: await categoryStats(c.category, startDate) }
  }))
  const logStatted = await Promise.all(logCampaigns.map(async c => ({ ...c, stats: await messageActivityStats(c._statKey.subject, c._statKey.date) })))
  const sg = (await sendGridSingleSends()).filter(s => (s.recipients || 0) > 0 || (s.sent || 0) > 0)
  return [...hubStatted, ...sg, ...logStatted].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
}

// 10-min cache so repeat loads are instant (engagement numbers don't move by the second).
let campaignsCache = { at: 0, data: null }
const CACHE_MS = 10 * 60 * 1000

router.get('/campaigns', async (req, res) => {
  // Fast path: DB rows only, no SendGrid. The UI renders these immediately.
  if (req.query.stats === '0') {
    const { hub, logCampaigns } = baseCampaignRows()
    const all = [...hub, ...logCampaigns].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    return res.json({ campaigns: all, sendgrid: !!SENDGRID_API_KEY, pending: true })
  }
  const fresh = campaignsCache.data && (Date.now() - campaignsCache.at < CACHE_MS) && req.query.refresh !== '1'
  if (fresh) return res.json({ campaigns: campaignsCache.data, sendgrid: !!SENDGRID_API_KEY, cached: true })
  const data = await withEngagement()
  campaignsCache = { at: Date.now(), data }
  res.json({ campaigns: data, sendgrid: !!SENDGRID_API_KEY })
})

// Per-campaign recipient log (for the Details view).
router.get('/campaigns/:id/recipients', (req, res) => {
  const rows = db.all('SELECT client_id, to_email, subject, status, error, sent_at FROM email_log WHERE campaign_id = ? ORDER BY sent_at DESC LIMIT 1000', [Number(req.params.id)])
  res.json(rows)
})

// ---- SMS + call analytics (from the communications log; instant, no Twilio calls) ----
router.get('/comms', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const since = `date('now','-${days} days')`
  const q = (cond) => db.get(`SELECT COUNT(*) n FROM communications WHERE substr(occurred_at,1,10) >= ${since} AND ${cond}`).n
  const textsOut = q("channel='text' AND direction='outgoing'")
  const textsIn = q("channel='text' AND direction='incoming'")
  const delivered = q("channel='text' AND direction='outgoing' AND delivery_status='delivered'")
  const failed = q("channel='text' AND direction='outgoing' AND delivery_status IN ('failed','undelivered')")
  const finalized = q("channel='text' AND direction='outgoing' AND delivery_status IN ('delivered','failed','undelivered','sent')")
  const callsOut = q("channel='call' AND direction='outgoing'")
  const callsIn = q("channel='call' AND direction='incoming'")
  const answered = q("channel='call' AND delivery_status='completed'")
  const missed = q("channel='call' AND delivery_status='missed'")
  const voicemails = q("channel='voicemail'")
  const avgDur = db.get(`SELECT AVG(duration_sec) a FROM communications WHERE substr(occurred_at,1,10) >= ${since} AND channel='call' AND delivery_status='completed' AND duration_sec > 0`).a
  // contacts we texted who replied at least once (a light, honest response signal)
  const textedContacts = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications WHERE substr(occurred_at,1,10) >= ${since} AND channel='text' AND direction='outgoing'`).n
  const repliedContacts = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications WHERE substr(occurred_at,1,10) >= ${since} AND channel='text' AND direction='incoming'`).n
  const dispositions = db.all(`SELECT disposition d, COUNT(*) n FROM communications WHERE substr(occurred_at,1,10) >= ${since} AND disposition IS NOT NULL AND disposition != '' GROUP BY disposition ORDER BY n DESC`)
  const byDay = db.all(`SELECT substr(occurred_at,1,10) day,
      SUM(CASE WHEN channel='text' AND direction='outgoing' THEN 1 ELSE 0 END) texts_out,
      SUM(CASE WHEN channel='text' AND direction='incoming' THEN 1 ELSE 0 END) texts_in,
      SUM(CASE WHEN channel IN ('call','voicemail') THEN 1 ELSE 0 END) calls
    FROM communications WHERE substr(occurred_at,1,10) >= ${since} GROUP BY day ORDER BY day`)
  res.json({
    days,
    texts_out: textsOut, texts_in: textsIn, delivered, failed,
    delivery_rate: finalized ? Math.round(delivered / finalized * 100) : null,
    calls_out: callsOut, calls_in: callsIn, answered, missed, voicemails,
    avg_call_sec: avgDur ? Math.round(avgDur) : 0,
    reply_rate: textedContacts ? Math.round(repliedContacts / textedContacts * 100) : null,
    texted_contacts: textedContacts, replied_contacts: repliedContacts,
    dispositions, by_day: byDay,
  })
})

export default router
