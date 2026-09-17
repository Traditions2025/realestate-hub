// AI TEXTING AUTO-ENROLLMENT ENGINE — fresh-lead speed-to-lead + database reactivation.
//
// One central evaluator (evaluateAiEnrollmentEligibility) decides, for any lead, whether
// the AI texting system may take it on. Three decision states:
//   eligible  — may be enrolled now (carries classification + lane + priority)
//   deferred  — temporarily blocked (recent human contact, takeover, pending sends); retry later
//   excluded  — terminal for auto-enrollment (wrong status, prospecting source, CX Connect,
//               FSBO/C-E identity, STOP/DNT, undeliverable, manual exclusion, already enrolled)
//
// THE POOL IS STATUS = NEW. "New" is a CRM status, NOT "recently created" — a lead can sit
// in New for years. Age NEVER excludes; it only affects classification and message routing.
//
// Two lanes:
//   fresh        — FRESH_INCOMING leads (created within the fresh window, never worked by a
//                  human). Event-driven + a 10-min safety sweep. NEVER capped: speed-to-lead.
//   reactivation — everything else in the eligible pool (cold never-connected, cold
//                  previously-connected, re-engaged dormant). Batched hourly inside the
//                  weekday send window, capped per day (ai_reactivation_daily_limit).
//
// Enrollment != sending. Enrolling turns the lead's AI on (ai_enabled + ai_managed) and
// schedules the appropriate first action; every actual send still passes the full policy
// gates (canSendSms, quiet hours, holiday, daily cap, line-type screen) at execute time.
//
// Everything is gated by ai_auto_enroll_mode: 'off' (default) | 'fresh' | 'full'.
import db from './database.js'
import { getConfig, inQuietHours } from './ai-followup/flags.js'
import { ensureState, setEnabled, setManaged, transitionAiState, isExcludedFromAutopilot } from './ai-followup/state.js'
import { scheduleAiAction, enrollColdBuyerSequence } from './ai-followup/scheduler.js'

const nowIso = () => new Date().toISOString()

// ---- settings -------------------------------------------------------------
// Source classes that are prospecting/import ORIGINS (built from the audited production
// distribution of the New pool, 2026-09-14). Matched against the lead's source FIELD
// (exact, lowercased) — never against tags, so a genuine Zillow lead that ARRIVED via a
// migration/import keeps its origin and is not excluded (migration != origin).
export const DEFAULT_SOURCE_EXCLUDE = [
  'realist', 'import', 'imported', 'csv import', 'piesync', 'forewarn', 'batchleads',
  'fsbo', 'fsbo zillow', 'expired', 'expired/cancelled mls', 'cancelled', 'cancel',
  'withdrawn', 'foreclosure', 'foreclosures',
].join(',')

export function enrollmentConfig() {
  return {
    mode: db.getSetting('ai_auto_enroll_mode', 'off'),                                   // off | fresh | full
    daily_limit: Number(db.getSetting('ai_reactivation_daily_limit', '150')) || 150,
    fresh_window_days: Number(db.getSetting('ai_fresh_window_days', '7')) || 7,
    defer_human_hours: Number(db.getSetting('ai_enroll_defer_human_hours', '24')) || 24,
    source_exclude: (db.getSetting('ai_enroll_source_exclude', DEFAULT_SOURCE_EXCLUDE) || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  }
}

// ---- time helpers ---------------------------------------------------------
function ctParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, weekday: 'short', hour: '2-digit' }).formatToParts(d)
  const get = (t) => (p.find(x => x.type === t) || {}).value
  let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0
  return { wd: get('weekday'), hour: hh }
}
// Reactivation enrolls only inside the weekday daytime window (9AM-4PM CT) so the
// staggered first sends land inside approved hours, mirroring the CX Connect pattern.
export function inReactivationWindow(d = new Date()) {
  const { wd, hour } = ctParts(d)
  return !['Sat', 'Sun'].includes(wd) && hour >= 9 && hour < 16
}
// First allowed send time at/after `from`: skip quiet hours in 15-min steps (max 24h).
export function nextAllowedIso(from = new Date()) {
  let t = new Date(from)
  for (let i = 0; i < 96 && inQuietHours(t); i++) t = new Date(t.getTime() + 15 * 60000)
  return t.toISOString()
}

// ---- name quality ---------------------------------------------------------
// Good leads only (John, 2026-09-14): a lead must carry a REAL first + last name.
// Spammy registrations (email in the name field, digits, gibberish, placeholder
// words, single names) are excluded from auto-enrollment — an agent can still
// enable AI manually after cleaning the record up.
const NAME_BAD_WORDS = new Set(['test', 'testing', 'unknown', 'none', 'noname', 'n/a', 'na', 'asdf', 'asdfasdf', 'qwerty', 'fake', 'sample', 'admin', 'user', 'null', 'undefined', 'lead', 'buyer', 'seller', 'info', 'contact', 'customer', 'client', 'anonymous', 'anon', 'guest', 'firstname', 'lastname'])
export function looksRealName(first, last) {
  const f = String(first || '').trim(), l = String(last || '').trim()
  if (!f || !l) return false                                       // both parts required
  const full = f + ' ' + l
  if (/[@\d_]/.test(full)) return false                            // emails, digits, handles
  if (/https?:|www\.|\.com|\.net|\.org/i.test(full)) return false  // URLs / domains
  if (/[^\p{L}\s.'-]/u.test(full)) return false                    // only letters ' - . allowed
  const letters = (s) => s.replace(/[^\p{L}]/gu, '')
  if (letters(f).length < 2 || letters(l).length < 2) return false // "J." / bare initials
  const tokens = full.toLowerCase().split(/[\s.'-]+/).filter(Boolean)
  for (const t of tokens) {
    if (NAME_BAD_WORDS.has(t)) return false                        // placeholder words
    if (t.length > 3 && !/[aeiouyàáâäãéèêëíìîïóòôöõúùûü]/.test(t)) return false // vowel-less gibberish ("sdjkfh")
    if (t.length > 3 && /^(.)\1+$/.test(t)) return false           // "aaaa"
  }
  return true
}

// ---- the central evaluator ------------------------------------------------
const EXCLUDED = (code, reason, extra = {}) => ({ decision: 'excluded', reason_code: code, reason, ...extra })
const DEFERRED = (code, reason, retry_after = null, extra = {}) => ({ decision: 'deferred', reason_code: code, reason, retry_after, ...extra })

export function evaluateAiEnrollmentEligibility(clientId) {
  const cid = Number(clientId)
  const base = { client_id: cid, classification: null, lane: null, priority_score: null, warnings: [], evaluated_at: nowIso() }
  const fin = (r) => ({ ...base, ...r })
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!c) return fin(EXCLUDED('NOT_FOUND', 'no such client'))
  if (c.merged_into) return fin(EXCLUDED('MERGED', 'merged into #' + c.merged_into))

  // 1) THE POOL: Status = New only. (Age is NOT a factor — New can be years old.)
  const status = String(c.status || '').toLowerCase()
  if (status !== 'new') return fin(EXCLUDED('STATUS_NOT_NEW', `status is '${c.status || '(empty)'}' — only New-status leads auto-enroll`))

  // 2) Manual per-lead auto-enroll exclusion (durable; set from the profile).
  const st = db.get('SELECT * FROM ai_lead_state WHERE client_id=?', [cid])
  if (st?.auto_enroll_excluded) return fin(EXCLUDED('MANUAL_EXCLUDE', st.auto_enroll_excluded_reason || 'manually excluded from auto-enrollment'))

  // 3) Already in the AI's hands — nothing to do. NOTE: ai_enabled defaults to 1 on
  // every ai_lead_state row, so it alone proves nothing; "enrolled" means explicitly
  // managed, a pending scheduled action, or an ACTIVE ai_state (the existing
  // reengagement sweep owns dormant nurture-state leads — we stay out of its lane).
  const pending = db.get("SELECT id FROM ai_scheduled_actions WHERE client_id=? AND state='pending' LIMIT 1", [cid])
  if (st?.ai_managed === 1) return fin(EXCLUDED('ALREADY_ENROLLED', 'AI already manages this lead'))
  if (pending) return fin(EXCLUDED('ALREADY_ENROLLED', 'a scheduled AI action is already pending'))
  if (st && st.ai_enabled === 1 && ['AI_ELIGIBLE', 'AI_WAITING_FOR_REPLY', 'AI_CONVERSATION_ACTIVE', 'AI_ENGAGED', 'AI_HIGH_INTENT', 'AI_LONG_TERM_NURTURE', 'AI_NURTURE', 'AI_REENGAGED'].includes(st.ai_state)) {
    return fin(EXCLUDED('ALREADY_ENROLLED', `AI already working this lead (${st.ai_state})`))
  }

  // 4) CX Connect fence — the Cancelled/Expired campaign owns these leads outright.
  try { if (db.get('SELECT client_id FROM cx_campaign WHERE client_id=?', [cid])) return fin(EXCLUDED('CX_CAMPAIGN', 'enrolled in the Cancelled/Expired connection campaign — AI never texts these leads')) } catch {}

  // 5) Seller-prospecting identities, independent of status/source spelling.
  if (c.fsbo_status || (c.fsbo_listings && c.fsbo_listings !== '[]')) return fin(EXCLUDED('FSBO', 'FSBO-tracked lead'))
  if (c.mls_status) return fin(EXCLUDED('MLS_TRACKED', `MLS-tracked (${c.mls_status})`))

  // 6) Prospecting tags/sources (the existing autopilot exclusion setting: substrings).
  if (isExcludedFromAutopilot(c)) return fin(EXCLUDED('PROSPECTING_TAG', 'matches the autopilot exclusion list (tag/source)'))

  // 7) Source ORIGIN classes (exact match on the source field, from the production audit).
  const cfg = enrollmentConfig()
  const src = String(c.source || '').trim().toLowerCase()
  if (src && cfg.source_exclude.includes(src)) return fin(EXCLUDED('SOURCE_' + src.replace(/[^a-z0-9]+/g, '_').toUpperCase(), `source '${c.source}' is a prospecting/import origin`))

  // 7b) Name quality — good leads only. Spammy/placeholder registrations are out.
  if (!looksRealName(c.first_name, c.last_name)) return fin(EXCLUDED('NAME_QUALITY', `name '${`${c.first_name || ''} ${c.last_name || ''}`.trim() || '(empty)'}' is missing or does not look like a real first + last name`))

  // 8) Contactability.
  const d10 = String(c.phone || '').replace(/\D/g, '')
  if (!c.phone || d10.length < 10) return fin(EXCLUDED('NO_PHONE', 'no valid phone on file'))
  if (c.hub_text_opt_out) return fin(EXCLUDED('OPTED_OUT', 'replied STOP to our number'))
  const prefs = db.get('SELECT do_not_text, sms_status FROM communication_preferences WHERE client_id=?', [cid]) || {}
  if (prefs.do_not_text) return fin(EXCLUDED('OPTED_OUT', 'do_not_text is set'))
  if (['opted_out', 'blocked'].includes(prefs.sms_status)) return fin(EXCLUDED('OPTED_OUT', 'SMS ' + prefs.sms_status))
  if (c.sms_undeliverable) return fin(EXCLUDED('UNDELIVERABLE', c.sms_undeliverable_reason || 'number cannot receive SMS (likely landline)'))

  // 9) Active transaction — a client in a deal is not an outreach target.
  try { if (db.get("SELECT id FROM transactions WHERE client_id=? AND COALESCE(status,'') NOT IN ('closed','cancelled','canceled','terminated','archived') LIMIT 1", [cid])) return fin(EXCLUDED('ACTIVE_TRANSACTION', 'has an active transaction')) } catch {}

  // ---- contact history (one pass) -----------------------------------------
  const comms = db.all(`SELECT direction, channel, sent_by_type, duration_sec, occurred_at FROM communications
    WHERE client_id=? ORDER BY occurred_at DESC LIMIT 300`, [cid])
  let lastInbound = null, lastHumanOut = null, anyOutbound = false, anyInbound = false
  for (const m of comms) {
    if (m.direction === 'outgoing') {
      anyOutbound = true
      const human = (m.channel === 'call' && Number(m.duration_sec || 0) >= 45)
        || ((m.channel === 'text' || m.channel === 'email') && (m.sent_by_type === 'human' || (!m.sent_by_type && m.channel === 'text')))
      if (human && !lastHumanOut) lastHumanOut = m.occurred_at
    }
    if (m.direction === 'incoming') { anyInbound = true; if (!lastInbound) lastInbound = m.occurred_at }
  }

  // ---- deferrals (temporary; re-evaluated on the next pass) ---------------
  if (st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED'].includes(st.ai_state)) return fin(DEFERRED('HUMAN_TAKEOVER', 'a human owns this conversation'))
  const deferMs = cfg.defer_human_hours * 3600e3
  const lastTouch = [lastHumanOut, lastInbound].filter(Boolean).sort().pop() || null
  if (lastTouch && Date.now() - new Date(lastTouch).getTime() < deferMs) {
    return fin(DEFERRED('RECENT_HUMAN_CONTACT', `human contact within the last ${cfg.defer_human_hours}h`, new Date(new Date(lastTouch).getTime() + deferMs).toISOString()))
  }
  const schedText = db.get("SELECT send_at FROM scheduled_texts WHERE client_id=? AND status='scheduled' LIMIT 1", [cid])
  if (schedText) return fin(DEFERRED('PENDING_SCHEDULED_TEXT', 'a manual scheduled text is pending', schedText.send_at))

  // ---- classification ------------------------------------------------------
  const createdMs = c.created_at ? new Date(c.created_at).getTime() : 0
  const freshCutoff = Date.now() - cfg.fresh_window_days * 86400e3
  const lastActivity = [
    db.get('SELECT MAX(occurred_at) t FROM fub_activity WHERE client_id=?', [cid])?.t,
    (() => { try { return db.get('SELECT MAX(created_at) t FROM lead_activity WHERE client_id=?', [cid])?.t } catch { return null } })(),
    c.last_email_clicked_at,
  ].filter(Boolean).sort().pop() || null
  const activityRecent = lastActivity && Date.now() - new Date(lastActivity).getTime() < 14 * 86400e3
  const everConnected = anyInbound || ['connected', 'qualified', 'active_opportunity', 'client'].includes(String(c.relationship_level || '').toLowerCase())

  let classification
  if (createdMs >= freshCutoff && !lastHumanOut && !anyInbound) classification = 'FRESH_INCOMING'
  else if (activityRecent && (!lastTouch || Date.now() - new Date(lastTouch).getTime() > 60 * 86400e3)) classification = 'REENGAGED_DORMANT'
  else if (everConnected) classification = 'COLD_PREVIOUSLY_CONNECTED'
  else classification = 'COLD_NEVER_CONNECTED'
  const lane = classification === 'FRESH_INCOMING' ? 'fresh' : 'reactivation'

  // ---- priority (deterministic, rules-based) -------------------------------
  let score = { FRESH_INCOMING: 90, REENGAGED_DORMANT: 70, COLD_PREVIOUSLY_CONNECTED: 55, COLD_NEVER_CONNECTED: 40 }[classification]
  if (lastActivity && Date.now() - new Date(lastActivity).getTime() < 7 * 86400e3) score += 8
  if (c.last_email_clicked_at && Date.now() - new Date(c.last_email_clicked_at).getTime() < 7 * 86400e3) score += 6
  // an email OPEN alone is a weak signal — a token bump only
  else if (c.last_email_opened_at && Date.now() - new Date(c.last_email_opened_at).getTime() < 7 * 86400e3) score += 2
  if (String(c.type || '').trim()) score += 3
  score = Math.min(100, score)

  const warnings = []
  if (!anyOutbound && createdMs && createdMs < Date.now() - 365 * 86400e3) warnings.push('never contacted and over a year old')
  if (!src) warnings.push('no source recorded')
  return fin({ decision: 'eligible', reason_code: 'ELIGIBLE', reason: classification.toLowerCase().replace(/_/g, ' '), classification, lane, priority_score: score, warnings })
}

// ---- audit log (deduped) --------------------------------------------------
export function logEnrollmentDecision(ev, { enrolled = false, actor = 'system' } = {}) {
  try {
    db.run(`INSERT INTO ai_enrollment_log (client_id, decision, reason_code, reason, classification, lane, priority_score, enrolled, enrolled_at, actor, first_seen_at, last_seen_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (client_id, decision, reason_code) DO UPDATE SET
              times_seen = times_seen + 1, last_seen_at = excluded.last_seen_at,
              enrolled = MAX(enrolled, excluded.enrolled),
              enrolled_at = COALESCE(ai_enrollment_log.enrolled_at, excluded.enrolled_at),
              priority_score = excluded.priority_score, reason = excluded.reason`,
      [ev.client_id, ev.decision, ev.reason_code, ev.reason || null, ev.classification, ev.lane, ev.priority_score,
        enrolled ? 1 : 0, enrolled ? nowIso() : null, actor, nowIso(), nowIso()])
  } catch {}
}

// ---- enrollment executor --------------------------------------------------
// Turns the AI on for the lead and schedules the classification-appropriate first action.
// Buyers/untyped reactivations get the staged cold-buyer drip; sellers get the contextual
// re-engage; fresh leads get the new-lead first touch. All sends re-gate at execute time.
export function enrollLead(ev, { actor = 'system', firstAtIso = null, dryRun = false, routeAction = null, routePayload = {} } = {}) {
  const cid = ev.client_id
  const c = db.get('SELECT id, type FROM clients WHERE id=?', [cid])
  if (!c || ev.decision !== 'eligible') return { enrolled: false, reason: 'not eligible' }
  const isSeller = String(c.type || '').toLowerCase().includes('seller') && !String(c.type || '').toLowerCase().includes('buyer')
  let route
  if (routeAction) route = { action: routeAction, at: firstAtIso || nextAllowedIso() }   // caller-directed first action (e.g. the FB-ad opener bank)
  else if (ev.lane === 'fresh') route = { action: 'AI_INITIAL_OUTREACH', at: firstAtIso || nextAllowedIso(new Date(Date.now() + (Number(getConfig().ai_new_lead_delay_minutes) || 5) * 60000)) }
  else if (isSeller) route = { action: 'AI_REENGAGE', at: firstAtIso || nextAllowedIso() }
  else route = { action: 'AI_COLD_BUYER_SEQUENCE', at: firstAtIso || nextAllowedIso() }
  if (dryRun) return { enrolled: false, dry_run: true, route }
  ensureState(cid)
  setEnabled(cid, true)
  setManaged(cid, true)
  transitionAiState(cid, 'AI_ELIGIBLE', `auto-enrolled (${ev.classification}, ${ev.lane} lane)`)
  if (routeAction) scheduleAiAction(cid, routeAction, route.at, { reason: `auto-enroll: ${routeAction.toLowerCase()}`, payload: routePayload, dedupKey: `firsttouch_${cid}` })
  else if (route.action === 'AI_INITIAL_OUTREACH') scheduleAiAction(cid, 'AI_INITIAL_OUTREACH', route.at, { reason: 'auto-enroll: fresh lead first touch', dedupKey: `firsttouch_${cid}` })
  else if (route.action === 'AI_REENGAGE') scheduleAiAction(cid, 'AI_REENGAGE', route.at, { reason: 'auto-enroll: reactivation (seller)', dedupKey: `reengage_auto_${cid}` })
  else enrollColdBuyerSequence(cid, { firstAtIso: route.at })
  logEnrollmentDecision(ev, { enrolled: true, actor })
  try { import('./followup-coverage.js').then(m => m.recalcCoverage(cid, { actorType: 'system' })).catch(() => {}) } catch {}
  return { enrolled: true, route }
}

// ---- FRESH LANE (event hook + 10-min safety sweep; never capped) ----------
export async function maybeAutoEnrollFresh(clientId) {
  try {
    const mode = db.getSetting('ai_auto_enroll_mode', 'off')
    if (!['fresh', 'full'].includes(mode)) return null
    const ev = evaluateAiEnrollmentEligibility(clientId)
    logEnrollmentDecision(ev, { actor: 'fresh_event' })
    if (ev.decision === 'eligible' && ev.lane === 'fresh') return enrollLead(ev, { actor: 'fresh_event' })
    return null
  } catch { return null }
}

export function freshEnrollSweep() {
  const cfg = enrollmentConfig()
  if (!['fresh', 'full'].includes(cfg.mode)) return { enrolled: 0, skipped: 'mode off' }
  const rows = db.all(`SELECT id FROM clients WHERE lower(COALESCE(status,''))='new' AND merged_into IS NULL
    AND created_at >= datetime('now', ?)`, [`-${cfg.fresh_window_days} days`])
  let enrolled = 0
  for (const [i, r] of rows.entries()) {
    const ev = evaluateAiEnrollmentEligibility(r.id)
    logEnrollmentDecision(ev, { actor: 'fresh_sweep' })
    if (ev.decision === 'eligible' && ev.lane === 'fresh') {
      // small stagger (45s apart) so a batch arrival never bursts
      const at = nextAllowedIso(new Date(Date.now() + (Number(getConfig().ai_new_lead_delay_minutes) || 5) * 60000 + enrolled * 45000))
      if (enrollLead(ev, { actor: 'fresh_sweep', firstAtIso: at }).enrolled) enrolled++
    }
  }
  return { scanned: rows.length, enrolled }
}

// ---- REACTIVATION LANE (hourly tick, windowed, capped, cursor-walked) -----
export function enrolledTodayCount(lane = 'reactivation') {
  return db.get("SELECT COUNT(*) n FROM ai_enrollment_log WHERE lane=? AND enrolled=1 AND date(enrolled_at)=date('now')", [lane])?.n || 0
}

// Cheap SQL pre-filter mirroring the evaluator's most common exclusions, so the full
// evaluator only runs on plausible candidates. The evaluator remains the authority.
function reactivationCandidates(cursor, limit, sourceExclude) {
  const notIn = sourceExclude.map(() => '?').join(',')
  return db.all(`SELECT id FROM clients WHERE id > ? AND lower(COALESCE(status,''))='new' AND merged_into IS NULL
    AND phone IS NOT NULL AND phone != '' AND COALESCE(hub_text_opt_out,0)=0 AND COALESCE(sms_undeliverable,0)=0
    AND (fsbo_status IS NULL OR fsbo_status='') AND (mls_status IS NULL OR mls_status='')
    AND lower(trim(COALESCE(source,''))) NOT IN (${notIn})
    AND trim(COALESCE(first_name,'')) != '' AND trim(COALESCE(last_name,'')) != ''
    AND first_name NOT LIKE '%@%' AND last_name NOT LIKE '%@%'
    ORDER BY id ASC LIMIT ?`, [Number(cursor) || 0, ...sourceExclude, limit])
}

export function reactivationTick({ force = false } = {}) {
  const cfg = enrollmentConfig()
  if (cfg.mode !== 'full') return { enrolled: 0, skipped: 'reactivation mode off' }
  if (!force && !inReactivationWindow()) return { enrolled: 0, skipped: 'outside send window' }
  const already = enrolledTodayCount('reactivation')
  const remaining = Math.max(0, cfg.daily_limit - already)
  if (!remaining) return { enrolled: 0, skipped: 'daily limit reached', already }
  // ~7 hourly ticks fit in the 9AM-4PM window; keep each tick's batch small enough that
  // 2-3 min stagger between first sends fits inside the hour.
  const perTick = Math.min(remaining, Math.max(1, Math.ceil(cfg.daily_limit / 7)))
  const cursor = db.getSetting('ai_reactivation_cursor', '0')
  const cand = reactivationCandidates(cursor, perTick * 8, cfg.source_exclude)
  const evaluated = []
  for (const r of cand) {
    const ev = evaluateAiEnrollmentEligibility(r.id)
    logEnrollmentDecision(ev, { actor: 'reactivation_tick' })
    if (ev.decision === 'eligible' && ev.lane === 'reactivation') evaluated.push(ev)
  }
  // highest priority first within the batch
  evaluated.sort((a, b) => b.priority_score - a.priority_score)
  let enrolled = 0
  for (const ev of evaluated.slice(0, perTick)) {
    // stagger first sends 2-3 min apart (drip pacing rule: never a burst)
    const at = nextAllowedIso(new Date(Date.now() + enrolled * (120000 + Math.floor(Math.random() * 60000)) + 60000))
    if (enrollLead(ev, { actor: 'reactivation_tick', firstAtIso: at }).enrolled) enrolled++
  }
  // advance the cursor past what we examined; wrap when the pool is exhausted
  if (cand.length) db.setSetting('ai_reactivation_cursor', String(cand[cand.length - 1].id))
  if (cand.length < perTick * 8) db.setSetting('ai_reactivation_cursor', '0')
  return { scanned: cand.length, eligible: evaluated.length, enrolled, already: already + enrolled, cap: cfg.daily_limit }
}

// ---- dry run / preview (ZERO writes) --------------------------------------
export function previewEnrollment({ scan = 500, limit = 25 } = {}) {
  const cfg = enrollmentConfig()
  const cursor = db.getSetting('ai_reactivation_cursor', '0')
  const cand = reactivationCandidates(cursor, Math.min(Number(scan) || 500, 2000), cfg.source_exclude)
  const byDecision = {}, byReason = {}, byClass = {}, sample = []
  const eligible = []
  for (const r of cand) {
    const ev = evaluateAiEnrollmentEligibility(r.id)
    byDecision[ev.decision] = (byDecision[ev.decision] || 0) + 1
    byReason[ev.reason_code] = (byReason[ev.reason_code] || 0) + 1
    if (ev.classification) byClass[ev.classification] = (byClass[ev.classification] || 0) + 1
    if (ev.decision === 'eligible') eligible.push(ev)
  }
  eligible.sort((a, b) => b.priority_score - a.priority_score)
  for (const ev of eligible.slice(0, Number(limit) || 25)) {
    const c = db.get('SELECT first_name, last_name, source, type, created_at FROM clients WHERE id=?', [ev.client_id]) || {}
    sample.push({ ...ev, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), source: c.source, type: c.type, created_at: c.created_at, route: enrollLead(ev, { dryRun: true }).route })
  }
  // fresh-lane KPI: eligible fresh leads NOT yet enrolled should be 0 when fresh mode is on
  const freshRows = db.all(`SELECT id FROM clients WHERE lower(COALESCE(status,''))='new' AND merged_into IS NULL AND created_at >= datetime('now', ?)`, [`-${cfg.fresh_window_days} days`])
  let freshEligibleUnenrolled = 0
  for (const r of freshRows) { const ev = evaluateAiEnrollmentEligibility(r.id); if (ev.decision === 'eligible' && ev.lane === 'fresh') freshEligibleUnenrolled++ }
  return { mode: cfg.mode, scanned: cand.length, cursor: Number(cursor) || 0, by_decision: byDecision, by_reason: byReason, by_classification: byClass, eligible_in_scan: eligible.length, would_enroll_first: sample, fresh_window_days: cfg.fresh_window_days, fresh_eligible_unenrolled: freshEligibleUnenrolled, daily_limit: cfg.daily_limit, enrolled_today: enrolledTodayCount('reactivation') }
}

// ---- summary for Settings / KPI -------------------------------------------
export function enrollmentSummary() {
  const cfg = enrollmentConfig()
  const today = db.all("SELECT lane, COUNT(*) n FROM ai_enrollment_log WHERE enrolled=1 AND date(enrolled_at)=date('now') GROUP BY lane")
  const total = db.all('SELECT lane, COUNT(*) n FROM ai_enrollment_log WHERE enrolled=1 GROUP BY lane')
  const recent = db.all(`SELECT l.*, c.first_name, c.last_name FROM ai_enrollment_log l LEFT JOIN clients c ON c.id=l.client_id
    WHERE l.enrolled=1 ORDER BY l.enrolled_at DESC LIMIT 20`)
  return {
    config: { ...cfg, source_exclude: cfg.source_exclude.join(', ') },
    in_window: inReactivationWindow(),
    enrolled_today: Object.fromEntries(today.map(r => [r.lane, r.n])),
    enrolled_total: Object.fromEntries(total.map(r => [r.lane, r.n])),
    cursor: Number(db.getSetting('ai_reactivation_cursor', '0')) || 0,
    recent_enrollments: recent,
  }
}
