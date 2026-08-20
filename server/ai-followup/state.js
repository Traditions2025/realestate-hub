// HUB AI lead state machine. Separate from CRM sales stage. Every transition is
// auditable via ai_actions. Frontend cannot set state directly — only via the
// controlled endpoints that call these helpers.
import db from '../database.js'

const nowIso = () => new Date().toISOString()

export const AI_STATES = [
  'NEW_UNCONTACTED', 'AI_ELIGIBLE', 'AI_INITIAL_OUTREACH', 'AI_WAITING_FOR_REPLY',
  'AI_CONVERSATION_ACTIVE', 'AI_ENGAGED', 'AI_NURTURE', 'AI_LONG_TERM_NURTURE',
  'AI_REENGAGED', 'AI_HIGH_INTENT', 'HUMAN_HANDOFF_REQUIRED', 'HUMAN_TAKEOVER',
  'CALLBACK_SCHEDULED', 'AI_PAUSED', 'NOT_INTERESTED', 'DO_NOT_TEXT', 'DO_NOT_CALL',
  'CLOSED_CONVERTED', 'AI_DISABLED',
]

export function ensureState(clientId, owner = null) {
  const cid = Number(clientId); if (!cid) return null
  let s = db.get('SELECT * FROM ai_lead_state WHERE client_id=?', [cid])
  if (!s) {
    db.run('INSERT OR IGNORE INTO ai_lead_state (client_id, ai_state, ai_owner, ai_state_changed_at, updated_at) VALUES (?,?,?,?,?)',
      [cid, 'NEW_UNCONTACTED', owner, nowIso(), nowIso()])
    s = db.get('SELECT * FROM ai_lead_state WHERE client_id=?', [cid])
  }
  return s
}

export function getState(clientId) { return db.get('SELECT * FROM ai_lead_state WHERE client_id=?', [Number(clientId)]) }

// Controlled transition. Returns { ok, from, to } and records an ai_actions row.
export function transitionAiState(clientId, toState, reason = '', metadata = {}) {
  const cid = Number(clientId)
  if (!AI_STATES.includes(toState)) return { ok: false, error: 'invalid state ' + toState }
  const s = ensureState(cid)
  const from = s?.ai_state || 'NEW_UNCONTACTED'
  db.run('UPDATE ai_lead_state SET ai_state=?, ai_state_changed_at=?, updated_at=? WHERE client_id=?', [toState, nowIso(), nowIso(), cid])
  try {
    db.run(`INSERT INTO ai_actions (client_id, action_type, ai_state_before, ai_state_after, reason, context_summary, status, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      [cid, 'STATE_TRANSITION', from, toState, reason, JSON.stringify(metadata || {}).slice(0, 2000), 'success', nowIso()])
  } catch {}
  return { ok: true, from, to: toState }
}

// timestamp helpers used by the orchestrator + human-activity suppression
export function markInbound(clientId) { ensureState(clientId); db.run('UPDATE ai_lead_state SET ai_last_inbound_at=?, updated_at=? WHERE client_id=?', [nowIso(), nowIso(), Number(clientId)]) }
export function markOutbound(clientId) { ensureState(clientId); db.run('UPDATE ai_lead_state SET ai_last_outbound_at=?, ai_last_action_at=?, updated_at=? WHERE client_id=?', [nowIso(), nowIso(), nowIso(), Number(clientId)]) }
export function markHumanContact(clientId) { ensureState(clientId); db.run('UPDATE ai_lead_state SET ai_last_human_contact_at=?, updated_at=? WHERE client_id=?', [nowIso(), nowIso(), Number(clientId)]) }
export function setNextAction(clientId, iso) { ensureState(clientId); db.run('UPDATE ai_lead_state SET ai_next_action_at=?, updated_at=? WHERE client_id=?', [iso || null, nowIso(), Number(clientId)]) }

export function pauseAi(clientId, until, reason = 'manual') {
  ensureState(clientId)
  db.run('UPDATE ai_lead_state SET ai_pause_until=?, ai_pause_reason=?, updated_at=? WHERE client_id=?', [until || null, reason, nowIso(), Number(clientId)])
  transitionAiState(clientId, 'AI_PAUSED', reason)
}
export function resumeAi(clientId, reason = 'manual') {
  ensureState(clientId)
  db.run('UPDATE ai_lead_state SET ai_pause_until=NULL, ai_pause_reason=NULL, updated_at=? WHERE client_id=?', [nowIso(), Number(clientId)])
  transitionAiState(clientId, 'AI_CONVERSATION_ACTIVE', reason)
}
export function setEnabled(clientId, enabled) { ensureState(clientId); db.run('UPDATE ai_lead_state SET ai_enabled=?, updated_at=? WHERE client_id=?', [enabled ? 1 : 0, nowIso(), Number(clientId)]) }
// Explicit per-lead enrollment (agent turned AI on for this specific lead).
export function setManaged(clientId, managed) { ensureState(clientId); db.run('UPDATE ai_lead_state SET ai_managed=?, updated_at=? WHERE client_id=?', [managed ? 1 : 0, nowIso(), Number(clientId)]) }
// Whether AI is allowed to act on this lead right now (autopilot OR explicitly enrolled).
export function aiManages(clientId) {
  if (db.getSetting('ai_autopilot', '0') === '1') return true
  return !!(db.get('SELECT ai_managed FROM ai_lead_state WHERE client_id=?', [Number(clientId)])?.ai_managed)
}

// Human takeover: pause autonomous conversation, cancel pending scheduled sends.
export function humanTakeover(clientId, reason = 'agent sent a message') {
  const cid = Number(clientId)
  markHumanContact(cid)
  transitionAiState(cid, 'HUMAN_TAKEOVER', reason)
  db.run("UPDATE ai_scheduled_actions SET state='canceled', canceled_at=?, error=? WHERE client_id=? AND state='pending'", [nowIso(), 'human takeover', cid])
}
