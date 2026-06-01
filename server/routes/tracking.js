// =====================================================================
// LEAD ACTIVITY TRACKING
//
// Public beacon endpoint that accepts events from the JS snippet pasted
// into Sierra Interactive's tracking-code area. Events are buffered in
// memory and flushed to the DB every 10s in a single batch — this avoids
// firing a 26 MB saveDb() on every page view.
//
// The flush is bounded (one INSERT per buffered event, single saveDb at
// the end) so it can't hang the event loop the way the Sierra sync does.
// On crash, up to 10s of events can be lost, which is acceptable for
// activity tracking.
// =====================================================================
import { Router } from 'express'
import db from '../database.js'

const router = Router()

// ---------- Beacon buffer (in-memory, flushed every 10s) ----------
const buffer = []
const BUFFER_FLUSH_INTERVAL_MS = 10_000
const BUFFER_MAX_ROWS = 500  // safety cap — flush early if it gets too big

function enqueueEvent(evt) {
  buffer.push(evt)
  if (buffer.length >= BUFFER_MAX_ROWS) flushBuffer()
}

function flushBuffer() {
  if (buffer.length === 0) return
  const batch = buffer.splice(0, buffer.length)
  try {
    // Pre-resolve sierra_lead_id / email -> client_id once, in-memory.
    // Avoids one SELECT per event.
    const sierraIds = new Set()
    const emails = new Set()
    for (const e of batch) {
      if (e.sierra_lead_id) sierraIds.add(String(e.sierra_lead_id))
      else if (e.sierra_email) emails.add(String(e.sierra_email).toLowerCase())
    }
    const idMap = new Map()
    if (sierraIds.size > 0) {
      const placeholders = [...sierraIds].map(() => '?').join(',')
      for (const r of db.all(`SELECT id, sierra_lead_id FROM clients WHERE sierra_lead_id IN (${placeholders})`, [...sierraIds])) {
        idMap.set(`sid:${r.sierra_lead_id}`, r.id)
      }
    }
    if (emails.size > 0) {
      const placeholders = [...emails].map(() => '?').join(',')
      for (const r of db.all(`SELECT id, LOWER(email) AS email FROM clients WHERE LOWER(email) IN (${placeholders})`, [...emails])) {
        idMap.set(`em:${r.email}`, r.id)
      }
    }

    db.beginBulk?.()
    try {
      for (const e of batch) {
        let clientId = null
        if (e.sierra_lead_id) clientId = idMap.get(`sid:${e.sierra_lead_id}`) || null
        else if (e.sierra_email) clientId = idMap.get(`em:${String(e.sierra_email).toLowerCase()}`) || null

        db.run(
          `INSERT INTO lead_activity
           (client_id, sierra_lead_id, sierra_email, event_type, page_url, page_title, referrer, listing_mls, duration_sec, ip_address, user_agent)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [clientId, e.sierra_lead_id || null, e.sierra_email || null, e.event_type,
           e.page_url || null, e.page_title || null, e.referrer || null,
           e.listing_mls || null, e.duration_sec || null, e.ip_address || null, e.user_agent || null])
      }
    } finally {
      db.endBulk?.()  // single saveDb at the end
    }
  } catch (err) {
    console.error('[tracking] buffer flush failed:', err.message)
    // Re-queue the batch so we don't lose it. Caps at BUFFER_MAX_ROWS so
    // a permanent failure can't grow memory unbounded.
    buffer.unshift(...batch.slice(-BUFFER_MAX_ROWS))
  }
}

// Start the flush timer once. Idempotent — checked via a module-level flag.
let flushTimerStarted = false
export function startTrackingFlushTimer() {
  if (flushTimerStarted) return
  flushTimerStarted = true
  setInterval(flushBuffer, BUFFER_FLUSH_INTERVAL_MS)
}

// ---------- POST /api/track/beacon ----------
// Unauthenticated. Open CORS. Body: { sierra_lead_id?, sierra_email?, event_type,
// page_url, page_title?, referrer?, listing_mls?, duration_sec? }
// Returns 204 (no body) for minimum bandwidth.
router.post('/beacon', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type')

  const b = req.body || {}
  // Bare-minimum validation. event_type is required to avoid garbage rows.
  const event_type = String(b.event_type || '').trim().slice(0, 32)
  if (!event_type) return res.status(204).end()

  enqueueEvent({
    sierra_lead_id: b.sierra_lead_id ? String(b.sierra_lead_id).slice(0, 64) : null,
    sierra_email:   b.sierra_email   ? String(b.sierra_email).toLowerCase().slice(0, 128) : null,
    event_type,
    page_url:       b.page_url       ? String(b.page_url).slice(0, 512) : null,
    page_title:     b.page_title     ? String(b.page_title).slice(0, 256) : null,
    referrer:       b.referrer       ? String(b.referrer).slice(0, 512) : null,
    listing_mls:    b.listing_mls    ? String(b.listing_mls).slice(0, 64) : null,
    duration_sec:   b.duration_sec   ? Math.min(Math.max(parseInt(b.duration_sec, 10) || 0, 0), 86400) : null,
    ip_address:     (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim().slice(0, 64),
    user_agent:     (req.headers['user-agent'] || '').toString().slice(0, 256),
  })
  res.status(204).end()
})

// Preflight for the beacon endpoint
router.options('/beacon', (_req, res) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type')
  res.status(204).end()
})

// ---------- GET /api/track/activity/:client_id ----------
router.get('/activity/:client_id', (req, res) => {
  flushBuffer()  // make sure recent events are visible
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const rows = db.all(
    `SELECT id, event_type, page_url, page_title, listing_mls, duration_sec, referrer, created_at
     FROM lead_activity WHERE client_id = ? ORDER BY created_at DESC LIMIT ?`,
    [Number(req.params.client_id), limit])

  // Summary: total events, distinct listings, page views, time on site
  const summary = db.get(
    `SELECT
       COUNT(*) AS total_events,
       COUNT(DISTINCT listing_mls) AS distinct_listings,
       COUNT(CASE WHEN event_type = 'pageview' THEN 1 END) AS pageviews,
       COUNT(CASE WHEN event_type = 'listing_view' THEN 1 END) AS listing_views,
       COUNT(CASE WHEN event_type = 'save' THEN 1 END) AS saves,
       SUM(COALESCE(duration_sec, 0)) AS total_seconds,
       MIN(created_at) AS first_seen,
       MAX(created_at) AS last_seen
     FROM lead_activity WHERE client_id = ?`,
    [Number(req.params.client_id)])

  res.json({ summary, events: rows })
})

// ---------- GET /api/track/recent (live feed for Dashboard) ----------
router.get('/recent', (req, res) => {
  flushBuffer()
  const limit = Math.min(Number(req.query.limit) || 30, 100)
  const rows = db.all(
    `SELECT a.id, a.event_type, a.page_url, a.page_title, a.listing_mls, a.duration_sec, a.created_at,
            a.client_id, c.first_name, c.last_name, c.sierra_lead_id
     FROM lead_activity a
     LEFT JOIN clients c ON c.id = a.client_id
     ORDER BY a.created_at DESC
     LIMIT ?`,
    [limit])
  res.json(rows)
})

// ---------- GET /api/track/top-leads (sort clients by recent activity) ----------
// Returns client IDs ranked by recent activity (last 14 days), used to
// power the "Most Active" sort option on the Clients page.
router.get('/top-leads', (req, res) => {
  flushBuffer()
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90)
  const limit = Math.min(Number(req.query.limit) || 200, 1000)
  const rows = db.all(
    `SELECT a.client_id,
            COUNT(*) AS event_count,
            COUNT(DISTINCT a.listing_mls) AS listings_viewed,
            COUNT(CASE WHEN a.event_type = 'save' THEN 1 END) AS saves,
            MAX(a.created_at) AS last_seen
     FROM lead_activity a
     WHERE a.client_id IS NOT NULL
       AND a.created_at >= datetime('now', '-${days} days')
     GROUP BY a.client_id
     ORDER BY event_count DESC, last_seen DESC
     LIMIT ?`,
    [limit])
  res.json(rows)
})

export default router
