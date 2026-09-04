// ============================================================================
// FOLLOW-UP COVERAGE — the fall-through-prevention layer.
//
// One authoritative evaluator sits ABOVE Tasks, AI, Drips, Automations and
// Transactions and answers a single operational question for every lead:
//
//   "If we do nothing manually from this moment, will this person hear from
//    us again — and soon enough?"
//
// Core business rule: every eligible meaningful lead must always have ONE of
//   a future human task / a scheduled AI action / an active drip or automation
//   with a future touch / an active transaction / an intentional snooze / an
//   approved exclusion. Otherwise it is UNPROTECTED — an operational failure
//   condition that gets surfaced, not a quiet CRM state.
//
// This module never sends communication. It identifies need; policy.js and the
// existing senders decide whether any message may actually go out.
// ============================================================================
import db from './database.js'

const nowIso = () => new Date().toISOString()
const DAY = 86400000

// ---------------------------------------------------------------------------
// Config: maximum silent periods (days) + warning threshold. Stored as JSON in
// app_settings 'followup_coverage_config' so the team can tune per level.
// ---------------------------------------------------------------------------
export const COVERAGE_DEFAULTS = {
  high_intent: 2,            // intent >= high_intent_score
  active_opportunity: 3,
  qualified: 10,
  connected_buyer: 30,
  connected_seller: 30,
  watch: 60,                 // watch-status connected leads (longer-term)
  long_term: 75,             // long-term nurture (AI LTN / cold drip)
  past_client: 90,
  at_risk_fraction: 0.75,    // warn when 75% of the window has elapsed
  high_intent_score: 75,     // intent score that triggers the high_intent window
  opportunity_intent_score: 60, // intent score that makes a lead an ACTIVE_OPPORTUNITY
}
export function coverageConfig() {
  let saved = {}
  try { saved = JSON.parse(db.getSetting('followup_coverage_config', '{}') || '{}') } catch {}
  const cfg = { ...COVERAGE_DEFAULTS }
  for (const k of Object.keys(COVERAGE_DEFAULTS)) {
    const v = Number(saved[k])
    if (Number.isFinite(v) && v > 0) cfg[k] = v
  }
  return cfg
}

// Relationship levels, weakest → strongest. Once CONNECTED, a lead never
// auto-downgrades to NEVER_CONNECTED (ratchet via clients.relationship_level).
export const REL_LEVELS = ['never_connected', 'connected', 'qualified', 'active_opportunity', 'client']
const relIdx = (l) => Math.max(0, REL_LEVELS.indexOf(String(l || '').toLowerCase()))

const EXCLUDED_STATUSES = new Set(['junk', 'donotcontact', 'archived', 'spam'])
const OPEN_TASK_NOT = "('done','completed','cancelled','canceled')" // open = anything else
const ACTIVE_TX = "property_status NOT IN ('Closed') AND property_status NOT LIKE 'Terminated%' AND property_status NOT LIKE 'Cancel%' AND property_status NOT LIKE 'Fell%'"

// Team/internal records must never show up as "unprotected leads".
let _internalCache = { at: 0, ids: new Set() }
function internalIds() {
  if (Date.now() - _internalCache.at < 10 * 60 * 1000) return _internalCache.ids
  const ids = new Set()
  try {
    const emails = new Set()
    for (const t of ['team_agents', 'partners', 'vendors']) {
      try { for (const r of db.all(`SELECT email FROM ${t} WHERE email IS NOT NULL AND email != ''`)) emails.add(String(r.email).toLowerCase()) } catch {}
    }
    for (const r of db.all("SELECT id, email, first_name, last_name FROM clients WHERE merged_into IS NULL")) {
      const em = String(r.email || '').toLowerCase()
      const nm = `${r.first_name || ''} ${r.last_name || ''}`.toLowerCase()
      if ((em && emails.has(em)) || nm.includes('matt smith team') || em.includes('@mattsmithteam.com')) ids.add(r.id)
    }
  } catch {}
  _internalCache = { at: Date.now(), ids }
  return ids
}

// Rough months from a free-text timeframe ("3-6 months", "90 days", "ASAP",
// "next spring"…). Returns null when unparseable — never invent timelines.
export function timeframeMonths(s) {
  const t = String(s || '').toLowerCase().trim()
  if (!t) return null
  if (/asap|immediat|right away|now/.test(t)) return 1
  let m = t.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*month/); if (m) return Number(m[1])
  m = t.match(/(\d+)\s*month/); if (m) return Number(m[1])
  m = t.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*day/); if (m) return Math.max(1, Math.round(Number(m[1]) / 30))
  m = t.match(/(\d+)\s*day/); if (m) return Math.max(1, Math.round(Number(m[1]) / 30))
  m = t.match(/(\d+)\s*(?:-|to)\s*(\d+)\s*year/); if (m) return Number(m[1]) * 12
  m = t.match(/(\d+)\s*year/); if (m) return Number(m[1]) * 12
  return null
}

const daysAgo = (iso) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) : null

// ---------------------------------------------------------------------------
// The evaluator.
// ---------------------------------------------------------------------------
export function evaluateFollowUpCoverage(clientId) {
  const cid = Number(clientId)
  const c = db.get('SELECT * FROM clients WHERE id = ?', [cid])
  if (!c) return null
  const cfg = coverageConfig()
  const now = Date.now()
  const nowStr = nowIso()
  const status = String(c.status || '').toLowerCase()
  const type = String(c.type || '').toLowerCase()
  const isSeller = type.includes('seller') && !type.includes('buyer')

  // ---- exclusions ----------------------------------------------------------
  const internal = internalIds().has(cid)
  const excluded = internal || c.merged_into || EXCLUDED_STATUSES.has(status) || !!c.exclude_reason
  const li = db.get('SELECT * FROM lead_intelligence WHERE client_id = ?', [cid]) || {}
  const prefs = db.get('SELECT do_not_text, do_not_call, sms_status FROM communication_preferences WHERE client_id = ?', [cid]) || {}

  // ---- contact history (one indexed pass over this client's comms) ---------
  const comms = db.all(`SELECT direction, channel, body, preview, duration_sec, sent_by_type, occurred_at
    FROM communications WHERE client_id = ? ORDER BY occurred_at DESC LIMIT 400`, [cid])
  let lastInbound = null, lastHuman = null, lastMeaningful = null, everConnectedPair = false, sawOutbound = false
  for (let i = comms.length - 1; i >= 0; i--) { // oldest → newest for the pair check
    const m = comms[i]
    if (m.direction === 'outgoing') sawOutbound = true
    if (m.direction === 'incoming' && (m.channel === 'text' || m.channel === 'email')) {
      const len = String(m.body || m.preview || '').trim().length
      if (len >= 2 && sawOutbound) everConnectedPair = true
    }
  }
  for (const m of comms) { // newest → oldest for recency
    const isCallConvo = (m.channel === 'call') && Number(m.duration_sec || 0) >= 45
    const isInboundMsg = m.direction === 'incoming' && (m.channel === 'text' || m.channel === 'email') && String(m.body || m.preview || '').trim().length >= 2
    const isHumanOut = m.direction === 'outgoing' && (m.channel === 'text' || m.channel === 'email') && (m.sent_by_type === 'human' || (!m.sent_by_type && m.channel === 'text'))
    if (!lastInbound && isInboundMsg) lastInbound = m.occurred_at
    if (!lastHuman && (isHumanOut || isCallConvo)) lastHuman = m.occurred_at
    if (!lastMeaningful && (isInboundMsg || isHumanOut || isCallConvo)) lastMeaningful = m.occurred_at
    if (lastInbound && lastHuman && lastMeaningful) break
  }
  const connectedNow = everConnectedPair || comms.some(m => m.channel === 'call' && Number(m.duration_sec || 0) >= 45)

  // ---- relationship level (ratchet: never below stored CONNECTED) ----------
  const activeTx = db.get(`SELECT id, property_address, closing_date FROM transactions WHERE client_id = ? AND ${ACTIVE_TX} LIMIT 1`, [cid])
  const intent = Number(li.intent_score || 0)
  let level = 'never_connected'
  if (connectedNow) level = 'connected'
  if (level === 'connected' && (li.buying_timeframe || li.selling_timeframe || li.price_min || li.price_max || li.preapproved || li.seller_property_address || ['qualify', 'active', 'prime'].includes(status))) level = 'qualified'
  if ((level !== 'never_connected') && (intent >= cfg.opportunity_intent_score || status === 'prime' || db.get("SELECT id FROM ai_handoffs WHERE client_id=? AND status='open' LIMIT 1", [cid]))) level = 'active_opportunity'
  if (activeTx || status === 'pending' || status === 'closed') level = 'client'
  const stored = String(c.relationship_level || '').toLowerCase()
  if (relIdx(stored) >= 1 && relIdx(level) < 1) level = 'connected' // the CONNECTED ratchet
  if (relIdx(level) > relIdx(stored)) { try { db.run('UPDATE clients SET relationship_level=? WHERE id=?', [level, cid]) } catch {} }
  else if (stored && relIdx(stored) >= 1 && relIdx(level) < relIdx(stored) && stored === 'connected') level = 'connected'

  // ---- executability -------------------------------------------------------
  const textable = !!(c.phone && !c.hub_text_opt_out && !c.sms_undeliverable && !prefs.do_not_text)
  const emailable = !!(c.email && !['wrongaddress', 'bounced', 'spamreport'].includes(String(c.email_status || '').toLowerCase()))

  // ---- coverage candidates (future + executable only) ----------------------
  const candidates = []
  const task = db.get(`SELECT id, title, due_date, assigned_to, category FROM tasks
    WHERE related_type='client' AND related_id=? AND status NOT IN ${OPEN_TASK_NOT} AND due_date IS NOT NULL
    ORDER BY due_date ASC LIMIT 1`, [cid])
  if (task) candidates.push({ type: 'human_task', at: task.due_date.length <= 10 ? task.due_date + 'T17:00:00Z' : task.due_date, raw_at: task.due_date, owner: task.assigned_to || c.agent_assigned || null, source: 'task', label: task.title, overdue: task.due_date.slice(0, 10) < nowStr.slice(0, 10) })
  const schedText = textable ? db.get("SELECT id, send_at FROM scheduled_texts WHERE client_id=? AND status='scheduled' AND send_at > ? ORDER BY send_at ASC LIMIT 1", [cid, nowStr]) : null
  if (schedText) candidates.push({ type: 'human_task', at: schedText.send_at, owner: c.agent_assigned || null, source: 'scheduled_text', label: 'Scheduled text' })
  const aiAct = textable ? db.get("SELECT id, action_type, execute_at FROM ai_scheduled_actions WHERE client_id=? AND state='pending' ORDER BY execute_at ASC LIMIT 1", [cid]) : null
  if (aiAct) candidates.push({ type: 'ai', at: aiAct.execute_at, owner: 'HUB AI', source: 'ai_scheduled_actions', label: aiAct.action_type })
  const drip = emailable ? db.get(`SELECT e.id, e.next_run_at, d.name FROM drip_enrollments e LEFT JOIN drip_campaigns d ON d.id=e.drip_id
    WHERE e.client_id=? AND e.status='active' AND e.next_run_at IS NOT NULL ORDER BY e.next_run_at ASC LIMIT 1`, [cid]) : null
  if (drip) candidates.push({ type: 'drip', at: drip.next_run_at, owner: 'Nurture', source: 'drip', label: drip.name })
  const auto = db.get(`SELECT e.id, e.next_run_at, a.name FROM automation_enrollments e LEFT JOIN automations a ON a.id=e.automation_id
    WHERE e.client_id=? AND e.status IN ('active','waiting') AND e.next_run_at IS NOT NULL ORDER BY e.next_run_at ASC LIMIT 1`, [cid])
  if (auto) candidates.push({ type: 'drip', at: auto.next_run_at, owner: 'Automation', source: 'automation', label: auto.name })
  if (activeTx) candidates.push({ type: 'transaction', at: activeTx.closing_date || null, owner: c.agent_assigned || null, source: 'transaction', label: activeTx.property_address })
  const snoozed = c.snooze_until && new Date(c.snooze_until).getTime() > now

  // ---- pick next action + coverage type ------------------------------------
  const dated = candidates.filter(x => x.at).sort((a, b) => String(a.at).localeCompare(String(b.at)))
  const next = dated[0] || candidates[0] || null
  const PRIORITY = ['human_task', 'transaction', 'ai', 'drip']
  const coverageType = excluded ? 'excluded'
    : candidates.length ? PRIORITY.find(p => candidates.some(x => x.type === p))
    : snoozed ? 'snooze' : null

  // ---- silence window ------------------------------------------------------
  let windowKey =
    status === 'closed' ? 'past_client'
    : intent >= cfg.high_intent_score ? 'high_intent'
    : level === 'active_opportunity' ? 'active_opportunity'
    : level === 'qualified' ? 'qualified'
    : level === 'client' ? 'qualified'
    : level === 'connected' ? (status === 'watch' ? 'watch' : (isSeller ? 'connected_seller' : 'connected_buyer'))
    : null // never_connected: no silence standard
  // Timeline-aware tightening: a known short timeframe shrinks the window.
  const tfm = timeframeMonths(isSeller ? li.selling_timeframe : li.buying_timeframe)
  let maxSilence = windowKey ? cfg[windowKey] : null
  if (maxSilence != null && tfm != null) {
    if (tfm <= 1) maxSilence = Math.min(maxSilence, 3)
    else if (tfm <= 3) maxSilence = Math.min(maxSilence, 7)
    else if (tfm <= 6) maxSilence = Math.min(maxSilence, 14)
  }
  // AI long-term nurture states get the long_term window instead of buyer/seller.
  const aiState = db.get('SELECT ai_state, ai_enabled FROM ai_lead_state WHERE client_id=?', [cid])
  if (windowKey && (windowKey === 'connected_buyer' || windowKey === 'connected_seller') && aiState && /LONG_TERM/i.test(aiState.ai_state || '')) maxSilence = cfg.long_term

  const dsc = daysAgo(lastMeaningful)

  // ---- classify ------------------------------------------------------------
  let coverage_status, reason
  if (excluded) {
    coverage_status = 'excluded'
    reason = internal ? 'Internal/team record' : c.exclude_reason ? `Excluded: ${c.exclude_reason}` : `Status ${status}`
  } else if (candidates.length === 0 && snoozed) {
    coverage_status = 'snoozed'
    reason = `Snoozed until ${String(c.snooze_until).slice(0, 10)}${c.snooze_reason ? ` — ${c.snooze_reason}` : ''}`
  } else if (candidates.length === 0) {
    coverage_status = 'unprotected'
    reason = level === 'never_connected' ? 'No future action (never connected — lower urgency)'
      : `No future task, AI action, nurture or transaction${dsc != null ? ` — last meaningful contact ${dsc} days ago` : ''}`
  } else {
    const taskOverdue = next && next.overdue
    const overSilence = maxSilence != null && dsc != null && dsc >= maxSilence
    const nearSilence = maxSilence != null && dsc != null && dsc >= Math.floor(maxSilence * (cfg.at_risk_fraction || 0.75))
    if (taskOverdue) { coverage_status = 'at_risk'; reason = `Follow-up task overdue (due ${String(next.raw_at || next.at).slice(0, 10)})` }
    else if (overSilence) { coverage_status = 'at_risk'; reason = `Silent ${dsc} days (max ${maxSilence}) — next touch is ${next && next.at ? String(next.at).slice(0, 10) : 'unscheduled'}` }
    else if (nearSilence) { coverage_status = 'at_risk'; reason = `Approaching silence limit: ${dsc}/${maxSilence} days` }
    else { coverage_status = 'protected'; reason = `Covered by ${coverageType}${next && next.at ? ` (${String(next.at).slice(0, 10)})` : ''}` }
  }
  const overdue_by = (maxSilence != null && dsc != null && dsc > maxSilence) ? dsc - maxSilence : 0

  // ---- risk flags (only from data we actually have) ------------------------
  const flags = []
  if (!excluded && relIdx(level) >= 1 && coverage_status === 'unprotected') flags.push(isSeller ? 'connected_seller_no_next_action' : 'connected_buyer_no_next_action')
  if (!excluded && relIdx(level) >= 1 && maxSilence != null && dsc != null && dsc >= maxSilence) flags.push(isSeller ? 'seller_going_cold' : 'buyer_going_cold')
  if (!excluded && intent >= cfg.high_intent_score && (daysAgo(lastHuman) == null || daysAgo(lastHuman) > 2)) flags.push('high_intent_no_human_contact')
  if (!excluded && isSeller && tfm != null && tfm <= 3 && dsc != null && dsc > 7) flags.push('seller_short_timeline_stale')
  if (!excluded && li.preapproved && coverage_status === 'unprotected') flags.push('preapproved_buyer_no_followup')
  if (!excluded && li.needs_to_sell_first && !isSeller && coverage_status === 'unprotected') flags.push('needs_to_sell_first_uncovered')
  if (!excluded && relIdx(level) >= 1 && !c.agent_assigned) flags.push('ownerless')

  // ---- recommendation ------------------------------------------------------
  let recommended = null
  if (coverage_status === 'unprotected' && relIdx(level) >= 1) {
    if (intent >= cfg.high_intent_score) recommended = 'Call today — high intent'
    else if (isSeller && tfm != null && tfm <= 3) recommended = 'Call within 3 days — seller timeline under 90 days'
    else if (isSeller) recommended = 'Schedule seller follow-up (call or nurture)'
    else if (tfm != null && tfm >= 12) recommended = 'Enroll in monthly nurture — 12+ month timeline'
    else recommended = 'Create a follow-up task or start nurture'
  } else if (coverage_status === 'at_risk') recommended = next && next.overdue ? 'Complete or reschedule the overdue task' : 'Reach out before the silence limit'

  return {
    client_id: cid,
    coverage_status,
    coverage_type: coverageType,
    relationship_level: level,
    eligible: !excluded,
    last_meaningful_contact_at: lastMeaningful,
    last_human_contact_at: lastHuman,
    last_inbound_at: lastInbound,
    next_action_at: next ? (next.at || null) : null,
    next_action_type: next ? next.type : null,
    next_action_label: next ? (next.label || null) : null,
    next_action_owner: next ? (next.owner || null) : null,
    next_action_source: next ? next.source : null,
    days_since_meaningful_contact: dsc,
    max_allowed_silence_days: maxSilence,
    overdue_by_days: overdue_by,
    assigned_agent: c.agent_assigned || null,
    intent_score: intent,
    risk_flags: flags,
    reason,
    recommended_action: recommended,
    snooze_until: snoozed ? c.snooze_until : null,
    snooze_reason: snoozed ? (c.snooze_reason || null) : null,
    evaluated_at: nowStr,
  }
}

// ---------------------------------------------------------------------------
// Persistence: followup_coverage is a queryable summary (one row per client);
// followup_coverage_events records only STATUS TRANSITIONS, never no-op runs.
// ---------------------------------------------------------------------------
export function recalcCoverage(clientId, { actorType = 'system', actorId = null } = {}) {
  let ev
  try { ev = evaluateFollowUpCoverage(clientId) } catch (e) {
    // Failure safety: never overwrite last-known state with a wrong answer.
    try { db.run('UPDATE followup_coverage SET eval_error=?, evaluated_at=? WHERE client_id=?', [String(e.message).slice(0, 200), nowIso(), Number(clientId)]) } catch {}
    console.error('[coverage] evaluate failed for', clientId, e.message)
    return null
  }
  if (!ev) return null
  const prev = db.get('SELECT coverage_status, coverage_type FROM followup_coverage WHERE client_id=?', [ev.client_id])
  db.run(`INSERT INTO followup_coverage (client_id, coverage_status, coverage_type, relationship_level, last_meaningful_contact_at, last_human_contact_at,
      next_action_at, next_action_type, next_action_owner, next_action_source, days_since_contact, max_silence_days, overdue_by_days,
      intent_score, risk_flags, reason, recommended_action, eval_error, evaluated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
    ON CONFLICT(client_id) DO UPDATE SET coverage_status=excluded.coverage_status, coverage_type=excluded.coverage_type,
      relationship_level=excluded.relationship_level, last_meaningful_contact_at=excluded.last_meaningful_contact_at,
      last_human_contact_at=excluded.last_human_contact_at, next_action_at=excluded.next_action_at, next_action_type=excluded.next_action_type,
      next_action_owner=excluded.next_action_owner, next_action_source=excluded.next_action_source, days_since_contact=excluded.days_since_contact,
      max_silence_days=excluded.max_silence_days, overdue_by_days=excluded.overdue_by_days, intent_score=excluded.intent_score,
      risk_flags=excluded.risk_flags, reason=excluded.reason, recommended_action=excluded.recommended_action, eval_error=NULL, evaluated_at=excluded.evaluated_at`,
    [ev.client_id, ev.coverage_status, ev.coverage_type, ev.relationship_level, ev.last_meaningful_contact_at, ev.last_human_contact_at,
      ev.next_action_at, ev.next_action_type, ev.next_action_owner, ev.next_action_source, ev.days_since_meaningful_contact, ev.max_allowed_silence_days,
      ev.overdue_by_days, ev.intent_score, JSON.stringify(ev.risk_flags), ev.reason, ev.recommended_action, ev.evaluated_at])
  // Log transitions; on a lead's FIRST evaluation only log a notable initial state
  // (an unprotected meaningful lead), never 45k "protected" baseline rows.
  const notable = ev.coverage_status === 'unprotected' && relIdx(ev.relationship_level) >= 1
  if ((prev && prev.coverage_status !== ev.coverage_status) || (!prev && notable)) {
    db.run(`INSERT INTO followup_coverage_events (client_id, previous_status, new_status, coverage_type, reason, actor_type, actor_id, created_at)
            VALUES (?,?,?,?,?,?,?,?)`,
      [ev.client_id, prev ? prev.coverage_status : null, ev.coverage_status, ev.coverage_type, ev.reason, actorType, actorId, nowIso()])
    // Notify (deduped by the transition itself) when a meaningful lead LOSES coverage.
    if (ev.coverage_status === 'unprotected' && relIdx(ev.relationship_level) >= 1 && prev && prev.coverage_status !== 'unprotected') {
      const c = db.get('SELECT first_name, last_name, type, agent_assigned FROM clients WHERE id=?', [ev.client_id])
      const nm = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : `#${ev.client_id}`
      import('./slack.js').then(m => m.postSlack(`:warning: Follow-up coverage lost — *${nm}* (${ev.relationship_level}${c?.type ? ', ' + c.type : ''}${c?.agent_assigned ? ', agent ' + c.agent_assigned : ''}). ${ev.reason}. ${ev.recommended_action ? 'Recommended: ' + ev.recommended_action : ''}`)).catch(() => {})
    }
  }
  return ev
}

// ---------------------------------------------------------------------------
// Snooze expiry: past-date snoozes are cleared, the lead re-evaluates (usually
// straight to UNPROTECTED → Needs Attention) and the wake-up is logged.
// ---------------------------------------------------------------------------
export function expireSnoozes() {
  const due = db.all("SELECT id, snooze_until, snooze_reason FROM clients WHERE snooze_until IS NOT NULL AND snooze_until <= ?", [nowIso()])
  for (const r of due) {
    db.run('UPDATE clients SET snooze_until=NULL, snooze_reason=NULL, updated_at=? WHERE id=?', [nowIso(), r.id])
    db.run(`INSERT INTO followup_coverage_events (client_id, previous_status, new_status, coverage_type, reason, actor_type, actor_id, created_at)
            VALUES (?,?,?,?,?,?,?,?)`, [r.id, 'snoozed', 'due', 'snooze', `Snooze expired (${String(r.snooze_until).slice(0, 10)})${r.snooze_reason ? ' — ' + r.snooze_reason : ''}`, 'system', null, nowIso()])
    recalcCoverage(r.id)
  }
  return due.length
}

// ---------------------------------------------------------------------------
// Incremental sweep (every 10 min): re-evaluate clients whose underlying
// coverage inputs changed recently, so freshness is event-driven in practice
// without hooking every code path individually.
// ---------------------------------------------------------------------------
export function runCoverageSweep() {
  const since = new Date(Date.now() - 20 * 60 * 1000).toISOString()
  const ids = new Set()
  const add = (sql, params) => { try { for (const r of db.all(sql, params)) if (r.cid) ids.add(r.cid) } catch {} }
  add('SELECT DISTINCT client_id cid FROM communications WHERE occurred_at >= ?', [since])
  add("SELECT DISTINCT related_id cid FROM tasks WHERE related_type='client' AND updated_at >= ?", [since])
  add('SELECT DISTINCT client_id cid FROM ai_scheduled_actions WHERE updated_at >= ?', [since])
  add('SELECT DISTINCT client_id cid FROM drip_enrollments WHERE entered_at >= ? OR completed_at >= ?', [since, since])
  add('SELECT DISTINCT client_id cid FROM automation_enrollments WHERE entered_at >= ? OR completed_at >= ?', [since, since])
  add('SELECT DISTINCT client_id cid FROM transactions WHERE updated_at >= ?', [since])
  expireSnoozes()
  let n = 0
  for (const cid of ids) { if (recalcCoverage(cid)) n++ ; if (n >= 300) break }
  return { swept: n }
}

// ---------------------------------------------------------------------------
// Daily audit: the wider database, batched. Evaluates every live client that
// could matter (has any contact info, not merged). Stores a last-run stamp so
// the scheduler can call this hourly and it self-throttles to once a day.
// ---------------------------------------------------------------------------
export async function runCoverageAudit({ force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10)
  if (!force && db.getSetting('coverage_audit_last_day', '') === today) return { skipped: true }
  db.setSetting('coverage_audit_last_day', today)
  const t0 = Date.now()
  expireSnoozes()
  const rows = db.all(`SELECT id FROM clients WHERE merged_into IS NULL
    AND (phone IS NOT NULL AND phone != '' OR email IS NOT NULL AND email != '')
    AND lower(coalesce(status,'')) NOT IN ('junk','donotcontact','archived')`)
  let n = 0, unprotectedMeaningful = 0
  // Small chunks + a real pause between them: the audit must never make the API
  // feel slow. ~40 evaluations (~0.4s) then 50ms of open event loop keeps request
  // latency normal while the audit works through the database in the background.
  for (let i = 0; i < rows.length; i += 40) {
    for (const r of rows.slice(i, i + 40)) {
      const ev = recalcCoverage(r.id)
      if (ev) { n++; if (ev.coverage_status === 'unprotected' && relIdx(ev.relationship_level) >= 1) unprotectedMeaningful++ }
    }
    await new Promise(res => setTimeout(res, 50))
  }
  const ms = Date.now() - t0
  console.log(`[coverage-audit] evaluated ${n} clients in ${Math.round(ms / 1000)}s — ${unprotectedMeaningful} connected+ unprotected`)
  try { db.setSetting('coverage_audit_last_result', JSON.stringify({ day: today, evaluated: n, unprotected_meaningful: unprotectedMeaningful, ms })) } catch {}
  // Persist the done-stamp NOW: a deploy restart minutes after the audit must not
  // find a stale DB snapshot and run the whole thing again on the fresh instance.
  try { db.saveDb() } catch {}
  return { evaluated: n, unprotected_meaningful: unprotectedMeaningful, ms }
}
