// HUB AI intent scoring — explainable, deterministic base (0-100) combined with
// optional AI deltas from the orchestrator. Never LLM-only. Stores history.
import db from '../database.js'
const nowIso = () => new Date().toISOString()

export function levelFor(score) {
  if (score >= 85) return 'URGENT'
  if (score >= 70) return 'HIGH'
  if (score >= 50) return 'ENGAGED'
  if (score >= 25) return 'NURTURE'
  return 'LOW'
}

// Phrases that signal high intent (tour, offer, call request, valuation, financing).
export const HIGH_INTENT_RE = /\b(?:tour|showing|see the (?:home|house|place|property)|come see|visit|walk[- ]?through|come by|open house|make an offer|put in an offer|write an offer|pre[- ]?approv|pre[- ]?qualif|when can (?:i|we)|call me|give me a call|can you call|schedule|book a|available (?:today|tomorrow|this)|sell my (?:home|house)|list my (?:home|house)|what.?s my (?:home|house) worth|home value|market value|cash offer)/i

// Deterministic score from comms + behavior + structured intelligence.
export function computeIntent(clientId) {
  const cid = Number(clientId)
  const reasons = []
  let score = 0
  const li = db.get('SELECT * FROM lead_intelligence WHERE client_id=?', [cid]) || {}
  const inbound = db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND direction='incoming' AND channel='text'", [cid]) || {}
  if (inbound.n > 0) { score += 15; reasons.push('Replied to texts') }
  if (inbound.n >= 3) { score += 8; reasons.push('Multiple replies') }
  const lastIn = db.get("SELECT body FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
  if (lastIn && HIGH_INTENT_RE.test(lastIn.body || '')) { score += 30; reasons.push('Asked to tour / offer / call / home value') }
  let views = 0
  try { views = db.get("SELECT COUNT(*) n FROM lead_activity WHERE client_id=? AND created_at >= datetime('now','-14 days')", [cid])?.n || 0 } catch {}
  if (views >= 4) { score += 20; reasons.push(`${views} website activities in 2 weeks`) }
  else if (views >= 1) { score += 6; reasons.push('Recent website activity') }
  if (li.preapproved === 1) { score += 12; reasons.push('Pre-approved') }
  const tf = String(li.buying_timeframe || li.selling_timeframe || '')
  if (/\b(0-?30|30|60|asap|immediately|this month|few weeks|1-?2 ?month)/i.test(tf)) { score += 15; reasons.push('Short timeframe') }
  if (li.seller_property_address) { score += 8; reasons.push('Seller with a property address') }
  const c = db.get('SELECT status FROM clients WHERE id=?', [cid]) || {}
  if (['junk', 'donotcontact'].includes(String(c.status || '').toLowerCase())) { score = Math.min(score, 5); reasons.push('Do Not Contact / Junk') }
  score = Math.max(0, Math.min(100, score))
  return { score, level: levelFor(score), reasons }
}

export function getIntent(clientId) {
  const li = db.get('SELECT intent_score, intent_level, intent_reason_json FROM lead_intelligence WHERE client_id=?', [Number(clientId)])
  if (!li) return { score: 0, level: 'LOW', reasons: [] }
  let reasons = []; try { reasons = JSON.parse(li.intent_reason_json || '[]') } catch {}
  return { score: li.intent_score || 0, level: li.intent_level || 'LOW', reasons }
}

export function saveIntent(clientId, { score, level, reasons }, source = 'deterministic') {
  const cid = Number(clientId)
  db.run(`INSERT INTO lead_intelligence (client_id, intent_score, intent_level, intent_reason_json, updated_at)
          VALUES (?,?,?,?,datetime('now'))
          ON CONFLICT(client_id) DO UPDATE SET intent_score=excluded.intent_score, intent_level=excluded.intent_level, intent_reason_json=excluded.intent_reason_json, updated_at=datetime('now')`,
    [cid, score, level, JSON.stringify(reasons || [])])
  db.run('INSERT INTO ai_intent_history (client_id, score, level, reasons_json, source, created_at) VALUES (?,?,?,?,?,?)',
    [cid, score, level, JSON.stringify(reasons || []), source, nowIso()])
  return { score, level, reasons }
}
