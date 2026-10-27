// BUYER LIFECYCLE ROUTING (John, 2026-10-27 — Part 37 steps 5 and 8).
//
// Decides which campaign owns the conversation with a lead, from evidence rather than
// from whatever enrolled them first. The pre-send gate in ai-followup/presend.js refuses
// a send from any campaign that is not the owner — but until something assigns owners,
// every lead sits at 'NONE' and the gate waves everything through. This is the part that
// makes it real.
//
// It also settles step 8, the cold-buyer split, because the same evidence answers it:
// a lead who has never sent us a message has no relationship to refer back to, and must
// never receive copy that claims one. "It's been a while since we last connected" is false
// for someone who never connected, and 20 of the 24 revive openers say exactly that.
//
// A RECORD EXISTING AND A RELATIONSHIP EXISTING ARE NOT THE SAME THING.
import db from './database.js'
import { setOwner, currentOwner, previousOwner, rank, outranks } from './ai-followup/presend.js'

// How long a temporary reactivation holds the lead before handing it back to whoever it
// displaced. Long enough for a reply to arrive, short enough that a single behaviour
// alert cannot strand a lead off its nurture forever.
const REACTIVATION_HOLD_DAYS = 10

const DAY = 86400000

/** Have they ever sent US anything, on any channel? This is the relationship test. */
export function hasEverReplied(clientId) {
  try {
    return !!db.get("SELECT id FROM communications WHERE client_id=? AND direction='incoming' LIMIT 1", [Number(clientId)])
  } catch { return false }
}

// The Hub holds no communication earlier than this. Everything before it lived in FUB,
// whose API never returned message bodies, so for any lead older than the horizon the
// absence of a reply in the Hub says nothing at all about whether one happened.
let COMMS_HORIZON = null
export function commsHorizon() {
  if (COMMS_HORIZON) return COMMS_HORIZON
  try {
    COMMS_HORIZON = db.get('SELECT MIN(occurred_at) m FROM communications')?.m || null
  } catch { COMMS_HORIZON = null }
  return COMMS_HORIZON
}

const IMPORTED_SOURCE = /import|piesync|fello|csv|realist|batchleads|forewarn|migrat/i

/**
 * Can we see this lead's whole history, or only what survived the migration?
 *
 *   'complete' the record was created after the Hub started holding conversations, and it
 *              did not come in from FUB. Absence of a reply here is real evidence.
 *   'partial'  the lead predates the comms horizon, or is FUB-linked, or arrived in a bulk
 *              import. Absence of a reply means nothing.
 *   'unknown'  cannot tell. Treated exactly like 'partial' for safety.
 */
export function historyCompleteness(clientId) {
  const cid = Number(clientId)
  const c = db.get('SELECT created_at, fub_person_id, source FROM clients WHERE id=?', [cid])
  if (!c) return 'unknown'
  if (c.fub_person_id) return 'partial'
  if (IMPORTED_SOURCE.test(String(c.source || ''))) return 'partial'
  const horizon = commsHorizon()
  if (!horizon || !c.created_at) return 'unknown'
  return String(c.created_at) >= String(horizon) ? 'complete' : 'partial'
}

/** A real two-way exchange, not just one stray inbound. Used for the cold-buyer split. */
export function hasRealConversation(clientId) {
  try {
    const inbound = db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND direction='incoming'", [Number(clientId)])?.n || 0
    if (inbound === 0) return false
    // One inbound and nothing from us is a wrong number or a STOP, not a conversation.
    const outbound = db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND direction='outgoing'", [Number(clientId)])?.n || 0
    return inbound >= 1 && outbound >= 1 && (inbound + outbound) >= 3
  } catch { return false }
}

/** A human on the team is in the middle of it. */
export function humanIsHandling(clientId, hours = 72) {
  const cid = Number(clientId)
  try {
    const st = db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [cid])
    if (st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED'].includes(st.ai_state)) return true
    const since = new Date(Date.now() - hours * 3600000).toISOString()
    // A human sending, a call either way, OR the lead having replied. An unanswered reply
    // is still an active conversation - arguably the most active kind, since somebody is
    // waiting on us. Keeping it evidence-based means a reply resolves to HUMAN_OWNED on
    // its own, and the claim lapses by itself once the window passes with nobody acting,
    // which is what lets the nurture resume rather than the lead being stranded.
    if (db.get(`SELECT id FROM communications WHERE client_id=? AND occurred_at >= ?
                AND (direction='incoming'
                     OR (direction='outgoing' AND channel='text' AND COALESCE(sent_by_type,'human')='human')
                     OR channel='call') LIMIT 1`,
    [cid, since])) return true
    return false
  } catch { return false }
}

/** Under contract, or otherwise being worked as a deal. */
export function inActiveTransaction(clientId) {
  const cid = Number(clientId)
  try {
    const c = db.get('SELECT status FROM clients WHERE id=?', [cid])
    const s = String(c?.status || '').toLowerCase()
    if (['pending', 'under contract', 'active', 'closed'].includes(s)) return s !== 'active'
    return false
  } catch { return false }
}

/**
 * What SHOULD own this lead, on the evidence. Order matters: the things that stop
 * automation outrank the things that schedule it.
 */
export function classifyOwner(clientId) {
  const cid = Number(clientId)
  const c = db.get('SELECT id, status, tags, source, created_at FROM clients WHERE id=? AND merged_into IS NULL', [cid])
  if (!c) return { owner: 'NONE', why: 'no client' }

  const status = String(c.status || '').toLowerCase()
  if (['junk', 'donotcontact', 'closed'].includes(status)) return { owner: 'NONE', why: `status ${status}` }
  if (inActiveTransaction(cid)) return { owner: 'TRANSACTIONAL', why: 'active transaction' }
  if (humanIsHandling(cid)) return { owner: 'HUMAN_OWNED', why: 'a human is handling this lead' }

  // A behaviour reactivation is an interruption with a time limit, not a campaign. While
  // it holds, it owns the lead; once the hold lapses the lead goes back to whoever it
  // displaced rather than being stranded off its nurture (Part 19).
  if (currentOwner(cid) === 'BEHAVIOR_REACTIVATION') {
    const since = db.get('SELECT communication_owner_at FROM clients WHERE id=?', [cid])?.communication_owner_at
    const heldDays = since ? (Date.now() - new Date(since).getTime()) / DAY : 999
    if (heldDays <= REACTIVATION_HOLD_DAYS) return { owner: 'BEHAVIOR_REACTIVATION', why: `reactivation holding, day ${Math.round(heldDays)}` }
    const back = previousOwner(cid)
    if (back && back !== 'BEHAVIOR_REACTIVATION') return { owner: back, why: 'reactivation lapsed, returning to previous owner' }
    // no memory of a previous owner: fall through and classify from scratch
  }

  // A live Facebook listing campaign owns its lead outright for its 30 days.
  try {
    const fb = db.get("SELECT status, day0_at FROM fb_listing_campaigns WHERE client_id=? ORDER BY rowid DESC LIMIT 1", [cid])
    if (fb && fb.status === 'active') return { owner: 'FB_LISTING_PHASE_1', why: 'listing campaign running' }
    if (fb && ['completed', 'responded', 'stopped'].includes(fb.status)) {
      // Finished phase 1, or pulled out of it early because the house went under contract.
      // These leads continue as themselves. They are NOT tipped into the generic cold
      // buyer campaign just because they got older.
      return { owner: 'FB_BUYER_PHASE_2', why: `listing campaign ${fb.status}` }
    }
  } catch { /* table may not exist yet */ }

  const tags = String(c.tags || '')
  const isFbAd = /"FB Ad/.test(tags) || /facebook/i.test(String(c.source || ''))
  if (isFbAd) return { owner: 'FB_LISTING_PHASE_1', why: 'facebook ad lead, campaign not yet recorded' }

  // The cold split. Only ONE direction of it is ever provable: seeing a two-way exchange
  // proves a relationship, but not seeing one proves nothing, because most of the history
  // never made it out of FUB. So the default is UNKNOWN, not "never connected", and only
  // positive evidence moves a lead out of it.
  const ageDays = c.created_at ? (Date.now() - new Date(c.created_at).getTime()) / DAY : 999
  if (ageDays <= 7) return { owner: 'GENERAL_NEW_BUYER', why: 'new lead' }
  if (hasRealConversation(cid)) return { owner: 'COLD_KNOWN_CONNECTED', why: 'two-way exchange visible in the Hub' }
  const hc = historyCompleteness(cid)
  return {
    owner: 'COLD_HISTORY_UNKNOWN',
    why: hc === 'complete'
      ? 'no reply on a record whose history is complete'
      : `history is ${hc}; absence of a reply is not evidence`,
    history_completeness: hc,
  }
}

/**
 * Put the right owner on the record.
 *
 * ALWAYS recomputes from evidence; it never takes an owner as an argument. That is what
 * makes it deterministic: two triggers firing seconds apart both recompute and both reach
 * the same answer, so the order they land in does not decide who owns the lead.
 *
 * A weaker claim cannot displace a stronger one while the stronger one's evidence still
 * holds. classifyOwner already encodes that evidence with its own expiry — a human who
 * has gone quiet for 72 hours stops counting as handling the lead — so a step DOWN only
 * happens once the stronger claim has genuinely lapsed.
 */
export function syncOwner(clientId, { force = false, reason = '' } = {}) {
  const cid = Number(clientId)
  const held = currentOwner(cid)
  const { owner, why } = classifyOwner(cid)
  if (held === owner) return { ok: true, unchanged: true, owner }
  if (!force && outranks(held, owner)) {
    // classifyOwner would have returned the stronger owner if its evidence still held, so
    // reaching here means it has lapsed and stepping down is correct. Logged either way.
    if (held === 'HUMAN_OWNED' && owner !== 'TRANSACTIONAL' && humanIsHandling(cid)) {
      return { ok: false, reason: 'a human is still handling this lead', owner: held }
    }
  }
  const res = { ...setOwner(cid, owner, [why, reason].filter(Boolean).join('; ')), why, from: held }
  // Taking ownership without giving the lane a voice is how a lead goes quiet while every
  // report shows it correctly owned. Entering phase 2 arms phase 2 (step 7).
  if (res.ok && owner === 'FB_BUYER_PHASE_2' && held !== 'FB_BUYER_PHASE_2') {
    try { rearmLane(cid, owner) } catch { /* never break a legitimate ownership change */ }
  }
  return res
}

/** A reply means a person owns this now. Called from the inbound path. */
export function claimForHuman(clientId, why = 'lead replied') {
  return setOwner(Number(clientId), 'HUMAN_OWNED', why)
}

/** Park the current owner and interrupt with a reactivation. Temporary by design. */
export function enterBehaviorReactivation(clientId, why = 'renewed website activity') {
  const cid = Number(clientId)
  const held = currentOwner(cid)
  if (held === 'HUMAN_OWNED' || held === 'TRANSACTIONAL') {
    return { ok: false, reason: `${held} outranks a reactivation`, owner: held }
  }
  return setOwner(cid, 'BEHAVIOR_REACTIVATION', why, { keepPrevious: held })
}

/**
 * Hand the lead back to whoever the reactivation displaced — and RE-ARM them (step 13).
 *
 * Returning the label is not the same as returning the lead. The displaced lane's next
 * action was cancelled or consumed while the reactivation held, so a lead handed back to
 * FB_BUYER_PHASE_2 or a cold lane with nothing queued simply goes silent: correctly
 * owned, permanently quiet, and invisible because ownership looks right in every report.
 * Whoever gets the lead back gets a next touch with it.
 */
export function exitBehaviorReactivation(clientId, why = 'reactivation finished') {
  const cid = Number(clientId)
  if (currentOwner(cid) !== 'BEHAVIOR_REACTIVATION') return { ok: true, unchanged: true, owner: currentOwner(cid) }
  const back = previousOwner(cid)
  const res = (back && back !== 'BEHAVIOR_REACTIVATION')
    ? setOwner(cid, back, why, { keepPrevious: null })
    : syncOwner(cid, { reason: why })
  try { rearmLane(cid, res?.owner || currentOwner(cid)) } catch { /* re-arming must never break the handback */ }
  return res
}

/** Does this lead have any automated touch still queued? */
function hasPendingAction(cid) {
  try {
    return !!db.get("SELECT 1 FROM ai_scheduled_actions WHERE client_id=? AND state='pending' LIMIT 1", [Number(cid)])
  } catch { return false }
}

/**
 * Give a lane a next touch if it has none. Only ever ADDS a scheduled action, never
 * cancels or reschedules one, so it cannot disturb a lane that is already running.
 */
export function rearmLane(clientId, owner) {
  const cid = Number(clientId)
  if (hasPendingAction(cid)) return { ok: true, unchanged: true, reason: 'lane already has a pending touch' }
  if (owner === 'FB_BUYER_PHASE_2') {
    import('./ai-followup/scheduler.js').then(m => m.schedulePhase2(cid, 0)).catch(() => {})
    return { ok: true, rearmed: 'phase2' }
  }
  if (owner === 'COLD_HISTORY_UNKNOWN' || owner === 'COLD_KNOWN_CONNECTED') {
    // The staged run was pre-scheduled at enrollment; with nothing left pending, the lead
    // belongs on the perpetual loop rather than stranded at the end of the sequence.
    import('./ai-followup/scheduler.js').then(m => m.scheduleColdBuyer(cid, 10)).catch(() => {})
    return { ok: true, rearmed: 'cold loop' }
  }
  return { ok: true, unchanged: true, reason: `no lane to re-arm for ${owner}` }
}

// ---- STEP 9: RE-ENGAGEMENT IS AN EVENT, NOT A TIMER --------------------------------
//
// enterBehaviorReactivation and exitBehaviorReactivation existed, were correct, and were
// called by NOTHING. Reactivation was an owner with no door into it. Meanwhile the only
// behaviour-driven path, behavioralSweep, scheduled AI_NURTURE_TOUCH — which the pre-send
// gate now attributes to GENERAL_NEW_BUYER, so for exactly the dormant leads it was built
// for (owned by a cold lane or phase 2) every one of its touches would be refused.
//
// Behaviour is a moment. A lead who comes back to the site after months of silence is
// telling us something on the day they do it, not on the day a sweep next runs.

/** Events strong enough to mean something. A single email open is not a comeback. */
const REACTIVATION_MIN_WEIGHT = 5
/** How quiet the lead must have been for renewed activity to count as a comeback. */
const DORMANT_DAYS = 14
/** Lanes a reactivation may interrupt. A live listing campaign is NOT one of them: it has
 *  its own behaviour hold, which notifies a human instead of texting over the top. */
const REACTIVATABLE = new Set(['COLD_HISTORY_UNKNOWN', 'COLD_KNOWN_CONNECTED', 'FB_BUYER_PHASE_2', 'GENERAL_NEW_BUYER'])

function lastAutomatedTouchAt(cid) {
  try {
    return db.get(`SELECT MAX(occurred_at) m FROM communications
      WHERE client_id=? AND direction='outgoing' AND COALESCE(sent_by_type,'') != 'human'`, [Number(cid)])?.m || null
  } catch { return null }
}

/**
 * Called when a behavioral event lands. Promotes a dormant lead into a reactivation and
 * gives it a prompt touch. Returns why it declined, which makes the quiet path debuggable.
 */
export function maybeReactivateOnBehavior(clientId, eventType, weight = 0) {
  const cid = Number(clientId)
  if (!cid) return { ok: false, reason: 'no client' }
  if (Number(weight) < REACTIVATION_MIN_WEIGHT) return { ok: false, reason: `event weight ${weight} below threshold` }

  const held = currentOwner(cid)
  if (held === 'BEHAVIOR_REACTIVATION') return { ok: false, reason: 'already in a reactivation' }
  if (!REACTIVATABLE.has(held)) return { ok: false, reason: `${held} is not interruptible` }

  // Re-derive first: the held label may be stale, and interrupting a lead a human picked
  // up an hour ago would be exactly the collision ownership exists to prevent.
  const { owner: should } = classifyOwner(cid)
  if (!REACTIVATABLE.has(should)) return { ok: false, reason: `${should} owns this lead` }

  const last = lastAutomatedTouchAt(cid)
  if (last && (Date.now() - new Date(last).getTime()) / DAY < DORMANT_DAYS) {
    return { ok: false, reason: `last touch was under ${DORMANT_DAYS} days ago` }
  }

  const entered = enterBehaviorReactivation(cid, `renewed activity: ${eventType}`)
  if (!entered?.ok) return entered
  import('./ai-followup/scheduler.js').then(m => {
    m.scheduleAiAction(cid, 'AI_REENGAGE', new Date(Date.now() + 15 * 60000).toISOString(), {
      reason: `behavioral reactivation (${eventType})`,
      dedupKey: `reengage_beh_${cid}_${new Date().toISOString().slice(0, 10)}`,
    })
  }).catch(() => {})
  return { ok: true, owner: 'BEHAVIOR_REACTIVATION', from: held, event: eventType }
}

/**
 * Hourly reconciliation. Ownership changes for reasons no single call site sees — a
 * campaign completing, a human conversation going quiet, a reactivation hold lapsing, a
 * status edit in the UI. Rather than patch every one of those places and still miss one,
 * this re-derives ownership for the leads where it could plausibly have changed.
 *
 * Deliberately narrow: leads on a live or recently-ended campaign, leads with recent
 * conversation, and leads parked in a reactivation. Not the whole database every hour.
 */
export function reconcileOwners({ dryRun = false, limit = 500 } = {}) {
  const since = new Date(Date.now() - 14 * DAY).toISOString()
  let ids = []
  try {
    ids = db.all(`
      SELECT DISTINCT id FROM (
        SELECT client_id AS id FROM fb_listing_campaigns WHERE updated_at >= ?
        UNION SELECT client_id FROM communications WHERE occurred_at >= ?
        UNION SELECT id FROM clients WHERE communication_owner = 'BEHAVIOR_REACTIVATION'
      ) LIMIT ?`, [since, since, Number(limit)]).map(r => r.id).filter(Boolean)
  } catch { return { ok: false, reason: 'query failed' } }
  const res = syncOwners(ids, { dryRun })
  return { ok: true, considered: ids.length, ...res }
}

/** Re-classify a batch. Reporting + backfill; writes nothing in dryRun. */
export function syncOwners(clientIds, { dryRun = true } = {}) {
  const out = { changed: [], unchanged: 0, blocked: [] }
  for (const id of clientIds) {
    const held = currentOwner(id)
    const { owner, why } = classifyOwner(id)
    if (held === owner) { out.unchanged++; continue }
    if (held === 'HUMAN_OWNED' && owner !== 'TRANSACTIONAL') { out.blocked.push({ id, held, owner }); continue }
    if (!dryRun) setOwner(id, owner, why)
    out.changed.push({ id, from: held, to: owner, why })
  }
  return out
}
