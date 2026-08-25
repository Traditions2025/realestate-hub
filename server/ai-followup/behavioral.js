// P1-3: normalized behavioral events (typed + weighted) feeding the intent score.
// Each event carries a weight from EVENT_WEIGHTS; behavioralScore() sums them with a
// recency half-life so old signals fade. This is the structured, auditable behavioral
// half of intent (the deterministic phrase/comms half lives in intent.js).
import db from '../database.js'
const nowIso = () => new Date().toISOString()

// Typed event catalog → base weight. Higher = stronger buying/selling signal.
export const EVENT_WEIGHTS = {
  property_view: 3,
  repeat_property_view: 6,     // same property seen again
  saved_search_created: 5,
  saved_property: 6,
  email_open: 1,
  email_click: 3,
  inbound_text: 8,
  inbound_call: 10,
  form_submit: 10,
  valuation_request: 22,       // "what's my home worth"
  tour_request: 26,
  offer_interest: 30,
  financing_started: 14,
  price_alert_click: 4,
  website_return: 5,           // came back after a gap
}
const RECENCY_HALF_LIFE_DAYS = 21   // a behavioral signal loses half its weight every 3 weeks

const daysAgo = (ts) => {
  if (!ts) return 0
  const iso = String(ts).includes('T') ? ts : String(ts).replace(' ', 'T') + 'Z'
  const d = (Date.now() - new Date(iso).getTime()) / 86400000
  return d > 0 ? d : 0
}

// Record one behavioral event. Unknown types default to weight 1. dedup_key makes repeat
// ingestion idempotent (e.g. one property view per client+property+day).
export function recordBehavioralEvent(clientId, eventType, opts = {}) {
  const cid = Number(clientId); if (!cid || !eventType) return { ok: false }
  const weight = opts.weight != null ? Number(opts.weight) : (EVENT_WEIGHTS[eventType] ?? 1)
  const occurred = opts.occurredAt || nowIso()
  const key = opts.dedupKey || `${eventType}:${cid}:${occurred.slice(0, 10)}:${opts.ref || ''}`
  try {
    const r = db.run(`INSERT OR IGNORE INTO behavioral_events (client_id, event_type, weight, source, occurred_at, metadata_json, dedup_key, created_at)
                      VALUES (?,?,?,?,?,?,?,?)`,
      [cid, eventType, weight, opts.source || 'hub', occurred, opts.metadata ? JSON.stringify(opts.metadata).slice(0, 2000) : null, key, nowIso()])
    return { ok: true, inserted: r.changes > 0 }
  } catch (e) { return { ok: false, error: e.message } }
}

// Time-decayed weighted behavioral score for a lead over `windowDays`. Returns a bounded
// contribution (0..cap) plus the top reasons, so intent stays explainable.
export function behavioralScore(clientId, { windowDays = 60, cap = 40 } = {}) {
  const cid = Number(clientId)
  const rows = db.all(
    `SELECT event_type, weight, occurred_at FROM behavioral_events
     WHERE client_id=? AND occurred_at >= datetime('now', ?)`,
    [cid, `-${Number(windowDays)} days`])
  let raw = 0
  const byType = {}
  for (const r of rows) {
    const decay = Math.pow(0.5, daysAgo(r.occurred_at) / RECENCY_HALF_LIFE_DAYS)
    const contrib = (Number(r.weight) || 0) * decay
    raw += contrib
    byType[r.event_type] = (byType[r.event_type] || 0) + contrib
  }
  const score = Math.min(cap, Math.round(raw))
  // Human reasons: strongest event types first.
  const reasons = Object.entries(byType).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([t]) => t.replace(/_/g, ' '))
  return { score, raw: Math.round(raw), events: rows.length, reasons }
}

export function recentBehavioralEvents(clientId, limit = 50) {
  return db.all('SELECT event_type, weight, source, occurred_at, metadata_json FROM behavioral_events WHERE client_id=? ORDER BY occurred_at DESC LIMIT ?', [Number(clientId), Number(limit)])
}
