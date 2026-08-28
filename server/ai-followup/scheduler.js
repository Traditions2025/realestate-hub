// HUB AI durable scheduler (Stages 3-5). Restart-safe + idempotent via
// ai_scheduled_actions (dedup_key, state locking). Drains due actions and runs
// the enqueue sweeps (new-lead first touch, nurture cadence, re-engagement,
// behavioral triggers). Everything is gated by the AI feature flags — if they are
// off, the worker is a cheap no-op. Wired into server/scheduler.js.
import db from '../database.js'
import { flag, getConfig, autopilotOn } from './flags.js'
import { canSendSms } from './policy.js'
import { ensureState, isExcludedFromAutopilot } from './state.js'

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
      // re-check eligibility immediately before executing
      const gate = canSendSms(client, { channel: 'ai', mode: 'proactive' })
      if (!gate.ok) { finish(a.id, 'canceled', gate.reason); continue }
      // if the lead replied or a human took over since scheduling, skip
      const st = db.get('SELECT ai_state, ai_last_inbound_at, ai_last_human_contact_at FROM ai_lead_state WHERE client_id=?', [a.client_id])
      if (st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED', 'AI_DISABLED', 'NOT_INTERESTED'].includes(st.ai_state)) { finish(a.id, 'canceled', 'state ' + st.ai_state); continue }
      const payload = (() => { try { return JSON.parse(a.payload_json || '{}') } catch { return {} } })()
      let res
      if (a.action_type === 'AI_INITIAL_OUTREACH') { res = await orch.handleProactive(a.client_id); if (res?.sent) scheduleNurture(a.client_id, 0) }
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
      finish(a.id, res?.sent ? 'completed' : (res?.ok ? 'completed' : 'failed'), res?.reason || null)
    } catch (e) { finish(a.id, 'failed', String(e.message).slice(0, 200)) }
  }
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
  const d = new Date(date)
  d.setUTCHours(15, 0, 0, 0)
  d.setUTCMinutes(Math.max(0, Math.min(359, offsetMin || 0)))
  for (let i = 0; i < 3; i++) {
    const wd = new Date(d).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short' })
    if (wd === 'Sat') d.setUTCDate(d.getUTCDate() + 2)
    else if (wd === 'Sun') d.setUTCDate(d.getUTCDate() + 1)
    else break
  }
  return d.toISOString()
}
function nextBusinessSlot(gapDays, offsetMin = 0) { return businessSlot(new Date(Date.now() + gapDays * 86400000), offsetMin) }

// Pre-schedule the WHOLE remaining cold-buyer sequence (stages fromStage..9) on a lead's
// account, each dated from their Text 1 anchor (weekday/daytime). Explicit enrollment, NOT
// gated by autopilot — but nothing SENDS until ai_followup_enabled is on AND each date
// arrives. The perpetual loop (stage 10) is chained by the drain after LTN4. Idempotent
// via dedup_key `coldbuyer_<cid>_<stage>`. Returns the scheduled rows for display.
export function enrollColdBuyerSequence(clientId, { fromStage = 0, anchorIso = null } = {}) {
  const anchor = anchorIso ? new Date(anchorIso) : new Date()
  const off = coldSendOffsetMin(clientId)   // spread this lead's sends across the daytime window
  const out = []
  for (let k = Math.max(0, Number(fromStage) || 0); k < COLD_DAYS.length; k++) {
    const when = k === 0 ? plusMin(2) : businessSlot(new Date(anchor.getTime() + (COLD_DAYS[k] - COLD_DAYS[0]) * 86400000), off)
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
    // only for eligible, textable, never-contacted leads
    const contacted = db.get("SELECT id FROM communications WHERE client_id=? LIMIT 1", [c.id])
    if (!contacted && c.phone && !c.hub_text_opt_out) {
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
export function behavioralSweep() {
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
    // raise intent + (if configured) nudge; scheduled as a nurture-style contextual touch
    scheduleAiAction(c.id, 'AI_NURTURE_TOUCH', plusMin(3), { reason: `high site activity (${h.n} views)`, payload: { step: 0, behavioral: true, mls: h.mls }, dedupKey: `behavioral_${c.id}_${new Date().toISOString().slice(0, 10)}` })
    try { db.run("INSERT OR IGNORE INTO ai_scheduled_actions (client_id, action_type, execute_at, state, reason, dedup_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)", [c.id, 'AI_BEHAVIORAL', nowIso(), 'completed', 'behavioral marker', `behmark_${c.id}_${new Date().toISOString().slice(0, 10)}`, nowIso(), nowIso()]) } catch {}
  }
}
