// HUB AI durable scheduler (Stages 3-5). Restart-safe + idempotent via
// ai_scheduled_actions (dedup_key, state locking). Drains due actions and runs
// the enqueue sweeps (new-lead first touch, nurture cadence, re-engagement,
// behavioral triggers). Everything is gated by the AI feature flags — if they are
// off, the worker is a cheap no-op. Wired into server/scheduler.js.
import db from '../database.js'
import { flag, getConfig, autopilotOn } from './flags.js'
import { canSendSms } from './policy.js'
import { preSendGate } from './presend.js'

// Which campaign each scheduled action belongs to, for the ownership check.
const OWNER_FOR_ACTION = {
  AI_FB_AD_OPENER: 'FB_LISTING_PHASE_1',
  AI_FB_AD_EMAIL: 'FB_LISTING_PHASE_1',
  AI_INITIAL_OUTREACH: 'GENERAL_NEW_BUYER',
  AI_FOLLOWUP: 'GENERAL_NEW_BUYER',
  AI_COLD_BUYER: 'COLD_HISTORY_UNKNOWN',
  AI_NURTURE_TOUCH: 'GENERAL_NEW_BUYER',
  AI_REENGAGE: 'BEHAVIOR_REACTIVATION',
  AI_BUYER_PHASE2: 'FB_BUYER_PHASE_2',
}
// Long-term prospecting, subject to the one-text-per-7-days budget. The first touches are
// not: a new lead who just enquired gets answered, not rationed.
const LONG_TERM_ACTIONS = new Set(['AI_COLD_BUYER', 'AI_NURTURE_TOUCH', 'AI_REENGAGE', 'AI_BUYER_PHASE2'])
import { ensureState, isExcludedFromAutopilot } from './state.js'
import { PHASE2_DAYS, PHASE2_LOOP_GAP } from './phase2.js'
import { isUsHoliday } from '../holidays.js'

const nowIso = () => new Date().toISOString()
const plusMin = (m) => new Date(Date.now() + m * 60000).toISOString()
const plusDays = (d) => new Date(Date.now() + d * 86400000).toISOString()

export function scheduleAiAction(clientId, actionType, executeAt, { reason = '', dedupKey = null, payload = {} } = {}) {
  try {
    db.run(`INSERT OR IGNORE INTO ai_scheduled_actions (client_id, action_type, execute_at, state, reason, payload_json, dedup_key, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      [clientId, actionType, executeAt, 'pending', reason, JSON.stringify(payload || {}), dedupKey || `${actionType}_${clientId}_${executeAt}`, nowIso(), nowIso()])
  } catch {}
}

// Nurture cadence: increasing spacing, then long-term. Returns days-until-next or null.
const NURTURE_DAYS = [2, 5, 14, 30, 60]

// ---- drain due actions ----
export async function runDueAiActions() {
  if (!flag('ai_followup_enabled')) return
  let due
  try { due = db.all("SELECT * FROM ai_scheduled_actions WHERE state='pending' AND execute_at <= ? ORDER BY execute_at ASC LIMIT 25", [nowIso()]) } catch { return }
  if (!due?.length) return
  const orch = await import('./orchestrator.js')
  for (const a of due) {
    // claim atomically (single-writer sqlite): only proceed if we flip pending->processing
    const claim = db.run("UPDATE ai_scheduled_actions SET state='processing', locked_at=?, attempt_count=attempt_count+1, updated_at=? WHERE id=? AND state='pending'", [nowIso(), nowIso(), a.id])
    if (!claim.changes) continue
    try {
      const client = db.get('SELECT * FROM clients WHERE id=?', [a.client_id])
      if (!client) { finish(a.id, 'failed', 'no client'); continue }
      // re-check eligibility immediately before executing. The FB-ad no-reply
      // EMAIL is exempt from the SMS gate — it must still send when the text
      // channel just failed (that's when the email matters most); the handler
      // + sendSequenceEmail apply email-side compliance.
      // The AI lane used to go straight to canSendSms({channel:'ai'}), which skips the
      // stacking guard, the pending-action check and the active-human-conversation check
      // that every campaign path already got through canAutomatedSend. It also had no way
      // of knowing another campaign owned the lead. It now goes through the same universal
      // gate as everything else (John, 2026-10-27).
      const gate = a.action_type === 'AI_FB_AD_EMAIL'
        ? { ok: true }
        : preSendGate(client, {
          owner: OWNER_FOR_ACTION[a.action_type] || 'GENERAL_NEW_BUYER',
          source: 'ai',
          // Phase 1 openers run their designed cadence; the long-term lanes are capped
          // at one prospecting text a week across every campaign.
          longTerm: LONG_TERM_ACTIONS.has(a.action_type),
        })
      if (!gate.ok) {
        // A block that will clear on its own must POSTPONE this stage, not destroy it.
        // Cancelling treats "not today" as "never": the stage is gone, and the next one
        // fires days later as if it had sent. That is how Norma Walker's Day 1 - the only
        // message that introduces us - vanished on Columbus Day and her first contact
        // became a Day 4 continuation from a number she could not place.
        if (isTransientBlock(gate.reason)) { defer(a, gate.reason); continue }
        finish(a.id, 'canceled', gate.reason); continue
      }
      // if the lead replied or a human took over since scheduling, skip
      const st = db.get('SELECT ai_state, ai_last_inbound_at, ai_last_human_contact_at FROM ai_lead_state WHERE client_id=?', [a.client_id])
      if (st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED', 'AI_DISABLED', 'NOT_INTERESTED'].includes(st.ai_state)) { finish(a.id, 'canceled', 'state ' + st.ai_state); continue }
      const payload = (() => { try { return JSON.parse(a.payload_json || '{}') } catch { return {} } })()
      let res
      if (a.action_type === 'AI_INITIAL_OUTREACH') { res = await orch.handleProactive(a.client_id); if (res?.sent) scheduleNurture(a.client_id, 0) }
      else if (a.action_type === 'AI_FB_AD_OPENER') { res = await orch.handleFbAdOpener(a.client_id, { property: payload.property || '' }); if (res?.sent) scheduleNurture(a.client_id, 0) }
      else if (a.action_type === 'AI_FB_AD_EMAIL') { res = await orch.handleFbAdEmail(a.client_id, { property: payload.property || '' }) }
      else if (a.action_type === 'AI_FOLLOWUP') { res = await orch.handleFollowup(a.client_id) }   // 10-min no-reply qualifying follow-up
      else if (a.action_type === 'AI_NURTURE_TOUCH') { const step = payload.step || 0; res = await orch.handleNurture(a.client_id, { attempt: step + 1 }); if (res?.sent) scheduleNurture(a.client_id, step + 1) }
      else if (a.action_type === 'AI_REENGAGE') { res = await orch.handleNurture(a.client_id, { reengage: true }) }
      else if (a.action_type === 'AI_COLD_BUYER') {
        // Staged old/cold-buyer drip. Active stages 0..9 were pre-scheduled at enrollment,
        // so we only chain the perpetual loop here (after LTN4). A reply/opt-out already
        // cancels the pending actions before we get here.
        const stage = Number(payload.stage) || 0
        res = await orch.handleColdBuyerStage(a.client_id, stage)
        if (stage >= COLD_DAYS.length - 1) scheduleColdBuyer(a.client_id, stage + 1)
      }
      else if (a.action_type === 'AI_BUYER_PHASE2') {
        // Phase 2 chains one step at a time: each send schedules the next, so a lead who
        // replies (and is handed to a human) simply stops, with nothing left pre-scheduled
        // on their account to fire later.
        const step = Number(payload.step) || 0
        res = await orch.handlePhase2Stage(a.client_id, step)
        // A skipped stage still advances — we learned nothing new, but re-asking what we
        // already know is exactly what the skip exists to prevent.
        schedulePhase2(a.client_id, step + 1)
      }
      // A stage that did not send because of a passing condition is POSTPONED. Without
      // this, quiet hours marked it 'completed' - consumed, never sent, and looking
      // successful in every report.
      if (!res?.sent && isTransientBlock(res?.reason)) { defer(a, res.reason); continue }
      finish(a.id, res?.sent ? 'completed' : (res?.ok ? 'completed' : 'failed'), res?.reason || null)
    } catch (e) { finish(a.id, 'failed', String(e.message).slice(0, 200)) }
  }
}
// Reasons that describe THIS MOMENT rather than this lead. They clear by themselves, so
// the stage is re-dated instead of being thrown away. Anything else - opted out, DNC,
// undeliverable, a campaign fence, a hand-added lead - is a property of the lead and
// cancelling is right.
const TRANSIENT = [/holiday/i, /quiet hours/i, /paused until/i, /rate limit/i, /temporarily/i]
export function isTransientBlock(reason) {
  const r = String(reason || '')
  return TRANSIENT.some(re => re.test(r))
}
// Push a blocked stage to the next real sending slot, keeping its per-lead time offset so
// it does not pile onto the same minute as everyone else's. Give up after 10 tries so a
// permanent condition misread as transient cannot defer forever.
// Facebook ad leads are the one case where speed is the whole point: somebody asked about
// a specific house minutes ago. A deferred ad opener goes out the moment quiet hours lift,
// 9:00 AM Central, with NO per-lead spread and NO weekend roll - ads run at weekends and a
// Saturday enquiry must not wait until Monday (John, 2026-10-27). Everything else keeps
// the spread slot, which exists to stop the whole database texting in the same minute.
const AD_PRIORITY = new Set(['AI_FB_AD_OPENER', 'AI_FB_AD_EMAIL'])

// The next 09:00 America/Chicago, today if that is still ahead of us, otherwise tomorrow.
// Computed against the zone rather than a fixed UTC hour, so it stays 9:00 across the DST
// change instead of drifting to 10:00 the way businessSlot does.
function nextNineCentral(from = new Date()) {
  const localMinutes = (d) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(d)
    const g = (t) => Number((p.find(x => x.type === t) || {}).value)
    let h = g('hour'); if (h === 24) h = 0
    return h * 60 + g('minute')
  }
  // Walk forward in 15-minute steps to the first instant at or just after 09:00 local.
  // Cheap, and a DST jump cannot fool it the way adding a fixed offset can.
  const d = new Date(from)
  d.setUTCSeconds(0, 0)
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 15) * 15)
  for (let i = 0; i < 4 * 24 * 9; i++) {
    const m = localMinutes(d)
    if (m >= 540 && m < 555 && !isUsHoliday(d)) return d.toISOString()   // 09:00-09:14 local
    d.setUTCMinutes(d.getUTCMinutes() + 15)
  }
  return businessSlot(new Date(Date.now() + 86400000), 0)
}

const MAX_DEFERRALS = 10
function defer(a, reason) {
  if ((Number(a.attempt_count) || 0) >= MAX_DEFERRALS) { finish(a.id, 'canceled', `${reason} (deferred ${MAX_DEFERRALS}x, giving up)`); return }
  const when = AD_PRIORITY.has(a.action_type)
    ? nextNineCentral()
    : businessSlot(new Date(Date.now() + 86400000), coldSendOffsetMin(a.client_id))
  db.run("UPDATE ai_scheduled_actions SET state='pending', execute_at=?, error=?, updated_at=? WHERE id=?",
    [when, `postponed: ${reason}`, nowIso(), a.id])
}
function finish(id, state, error) { db.run("UPDATE ai_scheduled_actions SET state=?, completed_at=?, error=?, updated_at=? WHERE id=?", [state, nowIso(), error, nowIso(), id]) }

// Schedule the next nurture touch after step `n` (n=0 means schedule first nurture).
function scheduleNurture(clientId, n) {
  if (!autopilotOn() || !flag('ai_nurture_enabled')) return
  if (n >= NURTURE_DAYS.length) return   // exhausted — falls to long-term (a slow re-engage sweep may pick it up)
  scheduleAiAction(clientId, 'AI_NURTURE_TOUCH', plusDays(NURTURE_DAYS[n]), { reason: `nurture step ${n + 1}`, payload: { step: n }, dedupKey: `nurture_${clientId}_${n}` })
}

// ---- OLD / COLD BUYER staged drip cadence ----
// Day-of-campaign for stages 0..9; after that a perpetual long-term loop (~52 days).
const COLD_DAYS = [1, 4, 9, 17, 30, 50, 80, 120, 165, 210]
const COLD_LOOP_INDEX = COLD_DAYS.length   // 10 = the 'loop' stage in COLD_BUYER_STAGES
const COLD_LOOP_GAP = 52

// A per-lead offset (0..359 minutes) so a whole cohort's sends SPREAD across the daytime
// window instead of firing at the same minute. Deterministic by client id.
export function coldSendOffsetMin(clientId) { return (Math.abs(Number(clientId) || 0) * 37) % 360 }

// A weekday date in the daytime window. Sat/Sun roll to Monday. 15:00 UTC + offsetMin lands
// ~10am to 4pm Central, inside the approved daytime sending window.
function businessSlot(date, offsetMin = 0) {
  let d = new Date(date)
  d.setUTCHours(15, 0, 0, 0)
  d.setUTCMinutes(Math.max(0, Math.min(359, offsetMin || 0)))
  // Weekends roll forward — and so do US holidays. A stage scheduled onto a holiday used
  // to be created normally and then REFUSED at send time by the holiday rule in policy.js,
  // which the drain recorded as canceled. Norma Walker's Day 1 was scheduled for Columbus
  // Day 2026 and destroyed that way, so the first message she ever got was Day 4 and she
  // replied "Yes. Who is this?". Bumping a holiday can land on a Saturday, and rolling a
  // weekend can land on a holiday, so the two run together until both are satisfied.
  for (let i = 0; i < 8; i++) {
    const wd = new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short' })
    if (wd === 'Sat') { d.setUTCDate(d.getUTCDate() + 2); continue }
    if (wd === 'Sun') { d.setUTCDate(d.getUTCDate() + 1); continue }
    if (isUsHoliday(d)) { d.setUTCDate(d.getUTCDate() + 1); continue }
    break
  }
  return d.toISOString()
}
function nextBusinessSlot(gapDays, offsetMin = 0) { return businessSlot(new Date(Date.now() + gapDays * 86400000), offsetMin) }

// Pre-schedule the WHOLE remaining cold-buyer sequence (stages fromStage..9) on a lead's
// account, each dated from their Text 1 anchor (weekday/daytime). Explicit enrollment, NOT
// gated by autopilot — but nothing SENDS until ai_followup_enabled is on AND each date
// arrives. The perpetual loop (stage 10) is chained by the drain after LTN4. Idempotent
// via dedup_key `coldbuyer_<cid>_<stage>`. Returns the scheduled rows for display.
export function enrollColdBuyerSequence(clientId, { fromStage = 0, anchorIso = null, firstAtIso = null } = {}) {
  const anchor = anchorIso ? new Date(anchorIso) : (firstAtIso ? new Date(firstAtIso) : new Date())
  const off = coldSendOffsetMin(clientId)   // spread this lead's sends across the daytime window
  const out = []
  for (let k = Math.max(0, Number(fromStage) || 0); k < COLD_DAYS.length; k++) {
    // firstAtIso (auto-enrollment) staggers Text 1 to a specific slot; default is +2 min
    const when = k === 0 ? (firstAtIso || plusMin(2)) : businessSlot(new Date(anchor.getTime() + (COLD_DAYS[k] - COLD_DAYS[0]) * 86400000), off)
    scheduleAiAction(clientId, 'AI_COLD_BUYER', when, { reason: `cold buyer stage ${k + 1} (enrolled)`, payload: { stage: k, preScheduled: true }, dedupKey: `coldbuyer_${clientId}_${k}` })
    out.push({ stage: k + 1, execute_at: when })
  }
  return out
}

// Chain the perpetual long-term loop (stage 10) after LTN4. Active stages 0..9 are
// pre-scheduled by enrollColdBuyerSequence, so this only handles the loop (gated).
export function scheduleColdBuyer(clientId, nextStage) {
  if (!autopilotOn() || !flag('ai_nurture_enabled')) return
  if ((Number(nextStage) || 0) < COLD_LOOP_INDEX) return
  const when = nextBusinessSlot(COLD_LOOP_GAP, coldSendOffsetMin(clientId))
  scheduleAiAction(clientId, 'AI_COLD_BUYER', when, { reason: 'cold buyer long-term loop', payload: { stage: COLD_LOOP_INDEX }, dedupKey: `coldbuyer_${clientId}_${COLD_LOOP_INDEX}_${new Date().toISOString().slice(0, 10)}` })
}

// ---- PHASE 2: the FB listing lead after their campaign ends (step 7) ----
// Chained one step at a time rather than pre-scheduled like the cold lane. Phase 2 exists
// to find out whether there is still a search, so each step's content depends on what the
// previous one learned; pre-scheduling ten of them would commit to questions we may no
// longer need to ask. It also means a lead who replies leaves nothing queued behind them.
export function schedulePhase2(clientId, step = 0) {
  if (!autopilotOn() || !flag('ai_nurture_enabled')) return
  const n = Math.max(0, Number(step) || 0)
  // PHASE2_DAYS are days since the campaign ended; chaining needs the gap between steps.
  const gap = n === 0 ? PHASE2_DAYS[0]
    : n < PHASE2_DAYS.length ? PHASE2_DAYS[n] - PHASE2_DAYS[n - 1]
      : PHASE2_LOOP_GAP
  const when = nextBusinessSlot(gap, coldSendOffsetMin(clientId))
  scheduleAiAction(clientId, 'AI_BUYER_PHASE2', when, {
    reason: `phase 2 step ${n + 1}`,
    payload: { step: n },
    // Dated so the perpetual loop can re-arm without colliding with its own past rows.
    dedupKey: `phase2_${clientId}_${n}_${when.slice(0, 10)}`,
  })
}

// ---- SWEEP: new leads → schedule a first touch (cursor-based; never backfills the DB) ----
export function newLeadSweep() {
  if (!autopilotOn() || !flag('ai_followup_enabled') || !flag('ai_proactive_text_enabled')) return
  const cur = db.getSetting('ai_newlead_cursor', null)
  if (cur == null) { const max = db.get('SELECT MAX(id) m FROM clients')?.m || 0; db.setSetting('ai_newlead_cursor', String(max)); return }
  const delay = Number(getConfig().ai_new_lead_delay_minutes) || 5
  const rows = db.all("SELECT id, phone, status, hub_text_opt_out, tags, source FROM clients WHERE id > ? ORDER BY id ASC LIMIT 200", [Number(cur)])
  for (const c of rows) {
    // NEVER auto first-touch imported prospecting lists (expired/cancelled/FSBO, etc.)
    if (isExcludedFromAutopilot(c)) continue
    // ...nor a lead somebody added BY HAND. The send gate refuses these anyway
    // (forbidden.js), but scheduling an action that can never fire just leaves phantom
    // pending rows on a lead the team is already working themselves.
    try { if (db.get('SELECT client_id FROM ai_lead_state WHERE client_id=? AND auto_enroll_excluded=1', [c.id])) continue } catch {}
    // only for eligible, textable, never-contacted leads
    const contacted = db.get("SELECT id FROM communications WHERE client_id=? LIMIT 1", [c.id])
    if (!contacted && c.phone && !c.hub_text_opt_out) {
      // Duplicate guard: if ANOTHER live record carries this same phone and already has
      // a conversation, this "new lead" is a duplicate of a lead the team is already
      // working (e.g. a Sierra registration syncing in after a manual quick-add) — the
      // AI must not first-touch someone mid-conversation. Merge the records instead.
      const p10 = String(c.phone).replace(/\D/g, '').slice(-10)
      if (p10.length === 10) {
        const twin = db.all("SELECT id, phone, alt_phones FROM clients WHERE id != ? AND merged_into IS NULL AND (phone LIKE ? OR alt_phones LIKE ?)", [c.id, '%' + p10.slice(-4), '%' + p10.slice(-4) + '%'])
          .find(x => ([x.phone, ...String(x.alt_phones || '').split(',')].some(p => String(p || '').replace(/\D/g, '').slice(-10) === p10))
            && db.get('SELECT id FROM communications WHERE client_id=? LIMIT 1', [x.id]))
        if (twin) continue
      }
      ensureState(c.id)
      const gate = canSendSms(c, { channel: 'ai', mode: 'proactive' })
      if (gate.ok) scheduleAiAction(c.id, 'AI_INITIAL_OUTREACH', plusMin(delay), { reason: 'new lead first touch', dedupKey: `firsttouch_${c.id}` })
    }
  }
  if (rows.length) db.setSetting('ai_newlead_cursor', String(rows[rows.length - 1].id))
}

// ---- SWEEP: re-engagement — dormant eligible leads with no recent activity ----
export function reengagementSweep() {
  if (!autopilotOn() || !flag('ai_followup_enabled') || !flag('ai_nurture_enabled')) return
  const rows = db.all(`SELECT c.id, c.phone, c.status, c.hub_text_opt_out, c.tags, c.source, c.type FROM clients c
    JOIN ai_lead_state s ON s.client_id=c.id
    WHERE c.phone IS NOT NULL AND c.phone != '' AND c.hub_text_opt_out=0
      AND s.ai_enabled=1 AND s.ai_state IN ('AI_LONG_TERM_NURTURE','AI_WAITING_FOR_REPLY','AI_NURTURE')
      AND (s.ai_last_outbound_at IS NULL OR s.ai_last_outbound_at <= datetime('now','-60 days'))
      AND (s.ai_last_inbound_at IS NULL OR s.ai_last_inbound_at <= datetime('now','-60 days'))
    LIMIT 25`)
  for (const c of rows) {
    if (isExcludedFromAutopilot(c)) continue
    const gate = canSendSms(c, { channel: 'ai', mode: 'proactive' })
    if (!gate.ok) continue
    // Buyers (and untyped leads) enter the staged cold-buyer drip at Text 1; sellers keep
    // the single generic reconnect.
    const t = String(c.type || '').toLowerCase()
    if (t.includes('seller') && !t.includes('buyer')) scheduleAiAction(c.id, 'AI_REENGAGE', plusMin(2), { reason: 'dormant re-engagement', dedupKey: `reengage_${c.id}_${new Date().toISOString().slice(0, 10)}` })
    else enrollColdBuyerSequence(c.id, { fromStage: 0 })   // Text 1 now + the full sequence pre-scheduled
  }
}

// ---- SWEEP: behavioral triggers from website activity (lead_activity) ----
// Thresholds + cooldown so a single view never triggers a text.
export async function behavioralSweep() {
  if (!autopilotOn() || !flag('ai_followup_enabled') || !flag('ai_behavioral_enabled')) return
  let hot = []
  try {
    hot = db.all(`SELECT client_id, COUNT(*) n, MAX(listing_mls) mls FROM lead_activity
      WHERE client_id IS NOT NULL AND created_at >= datetime('now','-3 days')
      GROUP BY client_id HAVING n >= 4 LIMIT 50`)
  } catch { return }
  for (const h of hot) {
    const c = db.get("SELECT id, phone, status, hub_text_opt_out, tags, source FROM clients WHERE id=?", [h.client_id])
    if (!c || !c.phone || c.hub_text_opt_out) continue
    if (isExcludedFromAutopilot(c)) continue
    // cooldown: one behavioral touch per client per 7 days
    const recent = db.get("SELECT id FROM ai_scheduled_actions WHERE client_id=? AND action_type='AI_BEHAVIORAL' AND created_at >= datetime('now','-7 days') LIMIT 1", [c.id])
    if (recent) continue
    const gate = canSendSms(c, { channel: 'ai', mode: 'proactive' })
    if (!gate.ok) continue
    // A dormant lead on a cold or phase-2 lane needs a REACTIVATION, not a nurture touch.
    // AI_NURTURE_TOUCH is attributed to GENERAL_NEW_BUYER by the pre-send gate, so for a
    // lead owned by any other lane it would be refused — silently, and for exactly the
    // leads this sweep exists to catch. Try the reactivation path first; the nurture touch
    // stays as the fallback for leads that lane genuinely owns.
    let reactivated = false
    try {
      const lc = await import('../buyer-lifecycle.js')
      reactivated = !!lc.maybeReactivateOnBehavior(c.id, 'website_return', 5)?.ok
    } catch { /* fall through to the nurture touch */ }
    if (!reactivated) {
      scheduleAiAction(c.id, 'AI_NURTURE_TOUCH', plusMin(3), { reason: `high site activity (${h.n} views)`, payload: { step: 0, behavioral: true, mls: h.mls }, dedupKey: `behavioral_${c.id}_${new Date().toISOString().slice(0, 10)}` })
    }
    try { db.run("INSERT OR IGNORE INTO ai_scheduled_actions (client_id, action_type, execute_at, state, reason, dedup_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [c.id, 'AI_BEHAVIORAL', nowIso(), 'completed', 'behavioral marker', `behmark_${c.id}_${new Date().toISOString().slice(0, 10)}`, nowIso(), nowIso()]) } catch {}
  }
}
