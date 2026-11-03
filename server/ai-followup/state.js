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
// Imported prospecting lists (expired / cancelled / FSBO, etc.) are NOT inbound
// leads — they have their own drips and never opted in. Autopilot must never
// auto-treat them as new leads. Matched by substring against tags + source
// (configurable via ai_autopilot_exclude). An agent can still enable AI on one
// manually (that sets ai_managed and overrides this).
export function isExcludedFromAutopilot(client) {
  const hay = ((client?.tags || '') + ' ' + (client?.source || '')).toLowerCase()
  const status = String(client?.status || '').toLowerCase()
  const list = (key, def = '') => (db.getSetting(key, def) || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  // 1) tag / source substring match
  if (list('ai_autopilot_exclude', 'fsbo,mls: expired,mls: cancelled').some(p => hay.includes(p))) return true
  // 2) status match
  if (status && list('ai_exclude_statuses').some(p => status === p || status.includes(p))) return true
  // 3) combination rules — tag AND status must both match
  let rules = []; try { rules = JSON.parse(db.getSetting('ai_exclude_rules', '[]') || '[]') } catch {}
  for (const r of (Array.isArray(rules) ? rules : [])) {
    const t = String(r?.tag || '').trim().toLowerCase(), s = String(r?.status || '').trim().toLowerCase()
    if (!t && !s) continue
    const tOk = !t || hay.includes(t)
    const sOk = !s || status === s || status.includes(s)
    if (tOk && sOk) return true
  }
  return false
}

// Whether AI is allowed to act on this lead right now:
//  - explicitly enrolled by an agent (ai_managed) → always yes
//  - else autopilot on AND not an excluded prospecting import → yes
//  - else no (manual mode)
export function aiManages(clientId) {
  const cid = Number(clientId)
  if (db.get('SELECT ai_managed FROM ai_lead_state WHERE client_id=?', [cid])?.ai_managed) return true
  if (db.getSetting('ai_autopilot', '0') !== '1') return false
  const c = db.get('SELECT tags, source FROM clients WHERE id=?', [cid])
  return !isExcludedFromAutopilot(c)
}

// ---- a block that belongs to the NUMBER, not the lead ---------------------------
//
// When a stranger answers a mis-keyed number ("I don't know who this Doug character
// is"), the auto-pause-on-reply rule drops the lead into HUMAN_TAKEOVER, and
// canSendSms then refuses every AI channel while it sits there. The state outlives
// the number: correcting the phone left the lead permanently un-AI-able even though
// WE NEVER HEARD FROM THEM. hub_text_opt_out and the landline verdict already shed
// on a phone replacement (routes/clients.js); this is the same rule one layer in.
//
// The test is historyBlock()'s (server/cx-connect.js): a reply only counts if it came
// from a number STILL on the record. Someone who answered on a current number keeps
// their block exactly as before, and states an agent chose deliberately — AI_DISABLED,
// CLOSED_CONVERTED, AI_PAUSED — are never touched.
//
// (Doug Riniker #26281, John 2026-11-03; same rule as Cole Hilgenberg 2026-09-22.)
export const WRONG_NUMBER_CLEARABLE = ['HUMAN_TAKEOVER', 'NOT_INTERESTED', 'DO_NOT_TEXT']

export function releaseWrongNumberBlock(clientId, { dry = false } = {}) {
  const cid = Number(clientId)
  const d10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)
  const st = db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [cid])
  if (!st || !WRONG_NUMBER_CLEARABLE.includes(st.ai_state)) return { cleared: false, why: 'not in a number-derived blocked state', ai_state: st?.ai_state || null }

  const c = db.get('SELECT phone, alt_phones FROM clients WHERE id=?', [cid])
  const current = new Set([c?.phone, ...String(c?.alt_phones || '').split(',')].map(d10).filter(s => s.length === 10))
  const inbound = db.all(`SELECT from_addr, body, occurred_at FROM communications WHERE client_id=?
    AND direction='incoming' AND channel IN ('text','call','voicemail')
    ORDER BY occurred_at DESC LIMIT 200`, [cid])
  if (!inbound.length) return { cleared: false, why: 'no inbound on file - the state was not set by a reply', ai_state: st.ai_state }

  const own = inbound.find(m => { const f = d10(m.from_addr); return f.length === 10 && current.has(f) })
  if (own) return { cleared: false, why: 'replied from a number still on file', from: own.from_addr, ai_state: st.ai_state }

  const out = { cleared: true, from_state: st.ai_state, old_reply_from: inbound[0].from_addr, old_reply: String(inbound[0].body || '').slice(0, 140) }
  if (dry) return out
  db.run('UPDATE ai_lead_state SET ai_enabled=1, ai_pause_until=NULL, ai_pause_reason=NULL, updated_at=? WHERE client_id=?', [nowIso(), cid])
  transitionAiState(cid, 'AI_ELIGIBLE', 'phone number replaced - the old state came from a reply by a number no longer on file')
  return out
}

// Human takeover: pause autonomous conversation, cancel pending scheduled sends.
export function humanTakeover(clientId, reason = 'agent sent a message') {
  const cid = Number(clientId)
  markHumanContact(cid)
  transitionAiState(cid, 'HUMAN_TAKEOVER', reason)
  db.run("UPDATE ai_scheduled_actions SET state='canceled', canceled_at=?, error=? WHERE client_id=? AND state='pending'", [nowIso(), 'human takeover', cid])
}
