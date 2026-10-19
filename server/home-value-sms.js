// HOME VALUE REQUEST: the 45 day SMS follow-up (John, 2026-10-19).
//
// An EXTENSION of the existing Home Value Request workflow, not a second campaign. The
// email and the Day 0 condition question are already owned by home-value-intake.js and are
// not touched here; this picks up from Day 3 and runs to Day 45.
//
// THE POINT OF IT, which shapes every message: the goal is to help the homeowner get a
// better valuation, not to book an appointment. Each message asks for one specific thing an
// automated estimate cannot see - improvements, condition, unusual features, finished
// square footage - and the walkthrough is offered once, at Day 35, as the way to make the
// number more accurate rather than as a listing pitch.
//
// ANY REPLY ENDS IT. Not just a condition rating: a question, an objection, a wrong number,
// anything. The sequence cancels, a person is notified, and the AI is blocked from
// answering. That is the same rule the FSBO and Cancelled/Expired campaigns follow, and it
// is why those two gate the AI hand-off in routes/inbox.js.
import db from './database.js'
import { nextValidSlot, inProactiveWindow } from './fsbo-followup.js'

const nowIso = () => new Date().toISOString()
const DAY = 86400000

export function hvSmsEnabled() {
  try { return String(db.getSetting?.('home_value_sms_enabled', '1')) === '1' } catch { return true }
}

/**
 * The sequence. Day offsets are measured from the ORIGINAL home value request, not from
 * the previous send, so a message delayed by a weekend does not push everything after it.
 *
 * `key` is stable and is what the no-duplicate check reads, so reordering or re-wording a
 * step never re-sends one somebody already had.
 */
/**
 * ALTERNATING GREETING (John, 2026-10-19: "use alternate hi, hello and time of day").
 *
 * Rotated by STEP INDEX rather than by the global {{intro}} counter, so one lead is
 * guaranteed to see all three across their sequence instead of whatever the counter
 * happened to be on when their turn came.
 *
 * Day 0 is index 0 and stays "Hi", which is John's approved wording, so the rotation
 * starts at "Hello" on Day 3 and the whole run reads:
 *   Hi, Hello, time-of-day, Hi, Hello, time-of-day, Hi, Hello
 *
 * Never "Good evening": the sending window closes at 5pm, so it could only ever be wrong.
 */
export function timeGreeting(now = new Date()) {
  let h
  try {
    h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(now)) % 24
  } catch { h = now.getHours() }
  return h < 12 ? 'Good morning' : 'Good afternoon'
}
export function greetingFor(stepIndex, now = new Date()) {
  const i = ((Number(stepIndex) || 0) % 3 + 3) % 3
  return i === 0 ? 'Hi' : i === 1 ? 'Hello' : timeGreeting(now)
}

export const HV_SMS_STEPS = [
  { key: 'day3_improvements', day: 3,
    purpose: 'Improvements that are not in public records',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, one thing that can make a difference when evaluating a home is any improvements that aren't reflected in public records. Have you made any major updates to ${c.street} over the years, like the kitchen, bathrooms, roof, or windows?` },
  { key: 'day7_reason', day: 7,
    purpose: 'Motivation, without assuming they are selling',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, just wanted to ask, were you mainly curious about what ${c.street} could be worth today, or is a possible move something you've been thinking about? Either way, we're happy to help you get a better understanding of the value.` },
  { key: 'day12_condition', day: 12,
    purpose: 'Updated, dated, or needing repair',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, another thing we consider when evaluating a home is its overall condition. Would you say ${c.street} is mostly move-in ready, or are there a few areas that could use some updating? That can help us better understand how it compares with other homes nearby.` },
  { key: 'day18_features', day: 18,
    purpose: 'Characteristics an automated valuation misses',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, when we evaluate a property, we look at what similar homes have actually sold for, not just what they're listed at. Is there anything about ${c.street} that you feel makes it different from other homes in the neighborhood?` },
  { key: 'day25_details', day: 25,
    purpose: 'Finished space and layout changes',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, sometimes public records don't tell the whole story, especially when it comes to finished basements or additional living space. Has anything changed with the layout or finished square footage of ${c.street} since you purchased it?` },
  { key: 'day35_walkthrough', day: 35, offersWalkthrough: true,
    purpose: 'Offer the walkthrough as accuracy, not as a pitch',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, one reason Matt prefers seeing a home in person is that photos and public records don't always reflect its actual condition or improvements. If you're open to it, he could stop by for a quick walkthrough so we can put together a more accurate value range for ${c.street}. Would that be helpful?` },
  { key: 'day45_final', day: 45, final: true,
    purpose: 'Leave the door open, then stop',
    text: (c) => `${c.greeting || 'Hi'} ${c.first_name}, just wanted to follow up one last time on your home value request for ${c.street}. We're happy to help whenever the timing is right, whether you're simply keeping track of your home's value or considering a move down the road. If you'd still like us to put together an estimate, just let me know!` },
]

export function initHvSms() {
  try {
    db.run(`CREATE TABLE IF NOT EXISTS home_value_sms (
      client_id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'scheduled',
      step_key TEXT,
      next_step INTEGER DEFAULT 0,
      requested_at TEXT,
      enrolled_at TEXT,
      email_sent_at TEXT,
      day0_sent_at TEXT,
      last_sent_at TEXT,
      next_send_at TEXT,
      replied_at TEXT,
      condition_rating INTEGER,
      improvements TEXT,
      repairs TEXT,
      reason TEXT,
      timeframe TEXT,
      walkthrough_offered_at TEXT,
      walkthrough_accepted_at TEXT,
      walkthrough_scheduled_at TEXT,
      stop_reason TEXT,
      updated_at TEXT
    )`)
    db.run(`CREATE TABLE IF NOT EXISTS home_value_sms_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER, event TEXT, step_key TEXT, reason TEXT, body TEXT,
      comm_id INTEGER, created_at TEXT
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_hvsms_due ON home_value_sms(status, next_send_at)')
  } catch {}
}
const log = (cid, event, extra = {}) => {
  try {
    db.run(`INSERT INTO home_value_sms_log (client_id, event, step_key, reason, body, comm_id, created_at)
            VALUES (?,?,?,?,?,?,?)`,
      [cid, event, extra.step_key || null, String(extra.reason || '').slice(0, 300) || null,
       extra.body || null, extra.comm_id || null, nowIso()])
  } catch {}
}

/** Merge fields with fallbacks, so a thin record never ships "Hi ," or "undefined". */
export function mergeFieldsFor(client) {
  const first = String(client?.first_name || '').trim()
  const usableFirst = first && !/^(none|null|n\/a|unknown|test)$/i.test(first) && !first.includes('@') && !/^\d/.test(first)
  const street = String(client?.address || '').trim()
  return {
    first_name: usableFirst ? first : 'there',
    street: street || 'your home',
    hasStreet: !!street,
  }
}

/**
 * Put a lead into the follow-up after their request has been handled.
 * Called by home-value-intake once the email has gone and Day 0 is queued.
 */
export function enrollHvSms(clientId, { requestedAt = nowIso(), emailSentAt = null, day0At = null } = {}) {
  initHvSms()
  const cid = Number(clientId)
  const c = db.get('SELECT * FROM clients WHERE id=? AND merged_into IS NULL', [cid])
  if (!c) return { ok: false, reason: 'no client' }
  const existing = db.get('SELECT * FROM home_value_sms WHERE client_id=?', [cid])
  // A repeat request is a strong signal and belongs to a person; it must not restart the
  // sequence or double up on somebody mid-way through it.
  if (existing) return { ok: false, reason: `already in this sequence (${existing.status})`, existing: true }
  if (String(c.phone || '').replace(/\D/g, '').length < 10) return { ok: false, reason: 'no mobile number' }

  const first = HV_SMS_STEPS[0]
  const due = nextValidSlot(new Date(Date.parse(requestedAt) + first.day * DAY))
  db.run(`INSERT INTO home_value_sms (client_id, status, next_step, requested_at, enrolled_at, email_sent_at, day0_sent_at, next_send_at, updated_at)
          VALUES (?,'active',0,?,?,?,?,?,?)`,
    [cid, requestedAt, nowIso(), emailSentAt, day0At, due.toISOString(), nowIso()])
  log(cid, 'enrolled', { reason: `first step ${first.key} due ${due.toISOString().slice(0, 16)}` })
  return { ok: true, next_send_at: due.toISOString(), first_step: first.key }
}

/** Everything this campaign has queued for a lead, so a reply can clear it. */
function pendingTextIds(cid) {
  try {
    return db.all(
      `SELECT id FROM scheduled_texts WHERE client_id=? AND status='scheduled'
         AND (created_by='home_value_sms' OR created_by='home_value_intake')`, [cid]).map(r => r.id)
  } catch { return [] }
}

/**
 * ANY inbound message ends the sequence. Returns true when this lead was in it, which the
 * inbound webhook uses to block the AI hand-off the same way it does for FSBO and CX.
 */
export function handleHvSmsInbound(clientId, body = '') {
  initHvSms()
  const cid = Number(clientId)
  const row = db.get('SELECT * FROM home_value_sms WHERE client_id=?', [cid])
  if (!row) return false
  const live = ['scheduled', 'active'].includes(row.status)

  // Cancel anything already queued, including the Day 0 question if it has not fired.
  const ids = pendingTextIds(cid)
  for (const id of ids) {
    db.run("UPDATE scheduled_texts SET status='canceled', error=? WHERE id=?", ['lead replied — human takes over', id])
  }

  if (live) {
    const rating = parseConditionRating(body)
    db.run(`UPDATE home_value_sms SET status='replied', replied_at=?, next_send_at=NULL,
            condition_rating=COALESCE(?, condition_rating), stop_reason='lead replied', updated_at=? WHERE client_id=?`,
      [nowIso(), rating, nowIso(), cid])
    log(cid, 'replied', { reason: `cancelled ${ids.length} queued message${ids.length === 1 ? '' : 's'}${rating ? `, condition ${rating}/10` : ''}`, body: String(body).slice(0, 300) })

    // A person owns it now. Same transition the other campaigns use, which is also what
    // stops the AI: forbidden.js and the hand-off both refuse HUMAN_TAKEOVER.
    import('./ai-followup/state.js')
      .then(m => m.transitionAiState(cid, 'HUMAN_TAKEOVER', 'replied to the home value follow-up'))
      .catch(() => {})

    const c = db.get('SELECT first_name, last_name, agent_assigned FROM clients WHERE id=?', [cid])
    const name = `${c?.first_name || ''} ${c?.last_name || ''}`.trim() || 'Lead'
    import('./notifications.js').then(m => m.notify({
      type: 'home_value_reply',
      title: `Home value reply: ${name}${rating ? ` — rated ${rating}/10` : ''}`,
      body: String(body).slice(0, 180) || '(no text)',
      link: `/clients/${cid}`, client_id: cid, dedupKey: `hvreply_${cid}_${Date.now()}`,
    })).catch(() => {})
  }
  return true     // in this campaign at all: the AI stays out either way
}

/** A 1-to-10 condition rating, when the reply is one. Null when it is anything else. */
export function parseConditionRating(body) {
  const s = String(body || '').trim()
  if (!s) return null
  let m = s.match(/^\s*(10|[1-9])\s*$/)                               // "7"
  if (!m) m = s.match(/\b(10|[1-9])\s*(?:\/|out of)\s*10\b/i)          // "7/10", "7 out of 10"
  if (!m) m = s.match(/^\s*(?:about|around|maybe|probably|i'?d say|id say)\s*(?:a\s*)?(10|[1-9])\b/i)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 10 ? n : null
}

/** Suggested next questions for the agent. Never sent automatically. */
export function agentSuggestions(rating) {
  // Number(null) is 0 and 0 is finite, so a bare isFinite check handed the agent the
  // "1 to 4" questions for a lead who had not rated anything at all. Only a real 1-to-10
  // counts. Third time this coercion has bitten today; validate, do not coerce.
  if (rating === null || rating === undefined || rating === '') return []
  const n = Number(rating)
  if (!Number.isFinite(n) || n < 1 || n > 10) return []
  const follow = n <= 4 ? "Appreciate you sharing that. Is it mostly cosmetic updates, or are there some larger repairs that would need to be addressed?"
    : n <= 6 ? "Thanks, that's helpful. Are there particular areas that need updating, like the kitchen, bathrooms, or flooring?"
      : n <= 8 ? "Gotcha! What would you say is keeping it from being a 10?"
        : "Sounds like you've kept it in great shape! Have you done any major renovations or updates in recent years?"
  return [
    follow,
    "Thanks, that gives us a better picture of the home! Matt can review the recent comparable sales, but the one thing that's difficult to account for without seeing the property is its actual condition and updates. Would you be open to having him stop by for a quick walkthrough? That would help us narrow down the value range.",
  ]
}

/** Why this lead may not be texted right now, or null. */
export function hvSmsBlock(client, row) {
  if (!client) return 'client gone'
  if (client.merged_into) return 'merged into another record'
  if (client.hub_text_opt_out) return 'replied STOP to our number'
  if (client.sms_undeliverable) return 'number is undeliverable'
  if (String(client.phone || '').replace(/\D/g, '').length < 10) return 'no mobile number'
  const st = String(client.status || '').toLowerCase()
  if (['junk', 'donotcontact', 'closed', 'archived', 'trash'].includes(st)) return `lead status ${client.status}`
  if (row && row.replied_at) return 'lead has replied'
  // One automated prospecting text a day, whoever queued it.
  const since = new Date(Date.now() - 20 * 3600000).toISOString()
  const already = db.get(
    `SELECT id FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing'
       AND occurred_at >= ? LIMIT 1`, [client.id, since])
  if (already) return 'already texted in the last 20 hours'
  return null
}

/** Run the due steps. Called on a timer. */
export async function runHvSmsSweep() {
  initHvSms()
  if (!hvSmsEnabled()) return { skipped: 'disabled' }
  if (!inProactiveWindow()) return { skipped: 'outside the weekday sending window' }
  const due = db.all(
    `SELECT * FROM home_value_sms WHERE status='active' AND next_send_at IS NOT NULL AND next_send_at <= ?
     ORDER BY next_send_at ASC LIMIT 20`, [nowIso()])
  const out = { sent: 0, deferred: 0, stopped: 0, completed: 0 }
  for (const row of due) {
    const c = db.get('SELECT * FROM clients WHERE id=?', [row.client_id])
    const step = HV_SMS_STEPS[row.next_step]
    if (!step) { finish(row.client_id, 'completed', 'ran out of steps'); out.completed++; continue }
    const block = hvSmsBlock(c, row)
    if (block) {
      const terminal = /STOP|undeliverable|no mobile|status|merged|gone|replied/i.test(block)
      if (terminal) { finish(row.client_id, 'suppressed', block); out.stopped++ }
      else { defer(row, block); out.deferred++ }
      continue
    }
    const sent = await sendStep(c, row, step)
    if (sent.ok) out.sent++; else { defer(row, sent.reason); out.deferred++ }
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 2500))   // trickle, never a blast
  }
  return out
}

async function sendStep(client, row, step) {
  const f = mergeFieldsFor(client)
  // +1 because Day 0 already used index 0 ("Hi"), so Day 3 starts the rotation at "Hello".
  const body = step.text({ first_name: f.first_name, street: f.street, greeting: greetingFor(row.next_step + 1) })
  try {
    const { canSendSms, canAutomatedSend } = await import('./ai-followup/policy.js')
    const gate = canSendSms(client, { channel: 'automation' })
    if (!gate.ok) return { ok: false, reason: gate.reason }
    const auto = canAutomatedSend(client, { source: 'drip' })
    if (!auto.ok) return { ok: false, reason: auto.reason }
    const { sendSms } = await import('./twilio.js')
    const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const r = await sendSms(client.phone, body, { statusCallback: HUB + '/api/inbox/twilio-status' })
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', client.id, name, r.from || '', client.phone, body.replace(/\s+/g, ' ').slice(0, 160), body,
       'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'Home Value SMS', 'home_value_sms', nowIso()])
    const nextIdx = row.next_step + 1
    const nextStep = HV_SMS_STEPS[nextIdx]
    const sets = {
      step_key: step.key, last_sent_at: nowIso(), next_step: nextIdx,
      walkthrough_offered_at: step.offersWalkthrough ? nowIso() : row.walkthrough_offered_at,
    }
    if (nextStep) {
      const at = nextValidSlot(new Date(Date.parse(row.requested_at) + nextStep.day * DAY))
      db.run(`UPDATE home_value_sms SET step_key=?, last_sent_at=?, next_step=?, next_send_at=?, walkthrough_offered_at=?, updated_at=? WHERE client_id=?`,
        [sets.step_key, sets.last_sent_at, nextIdx, at.toISOString(), sets.walkthrough_offered_at, nowIso(), client.id])
    } else {
      db.run(`UPDATE home_value_sms SET step_key=?, last_sent_at=?, next_step=?, next_send_at=NULL, status='completed', walkthrough_offered_at=?, updated_at=? WHERE client_id=?`,
        [sets.step_key, sets.last_sent_at, nextIdx, sets.walkthrough_offered_at, nowIso(), client.id])
    }
    log(client.id, 'sent', { step_key: step.key, body, comm_id: ins.lastInsertRowid })
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

function defer(row, reason) {
  const at = nextValidSlot(new Date(Date.now() + DAY))
  db.run('UPDATE home_value_sms SET next_send_at=?, updated_at=? WHERE client_id=?', [at.toISOString(), nowIso(), row.client_id])
  log(row.client_id, 'deferred', { step_key: HV_SMS_STEPS[row.next_step]?.key, reason })
}
function finish(cid, status, reason) {
  db.run('UPDATE home_value_sms SET status=?, next_send_at=NULL, stop_reason=?, updated_at=? WHERE client_id=?', [status, String(reason).slice(0, 200), nowIso(), cid])
  log(cid, status, { reason })
}

/** Everything the profile card needs. */
export function hvSmsState(clientId) {
  initHvSms()
  const cid = Number(clientId)
  const row = db.get('SELECT * FROM home_value_sms WHERE client_id=?', [cid])
  if (!row) return null
  const step = HV_SMS_STEPS[row.next_step] || null
  return {
    ...row,
    total_steps: HV_SMS_STEPS.length,
    next_step_key: step?.key || null,
    next_step_purpose: step?.purpose || null,
    suggestions: row.condition_rating ? agentSuggestions(row.condition_rating) : [],
    log: db.all('SELECT * FROM home_value_sms_log WHERE client_id=? ORDER BY id DESC LIMIT 25', [cid]),
  }
}

export function setHvSmsStatus(clientId, status, reason = 'set by agent') {
  const ok = ['scheduled', 'active', 'replied', 'walkthrough_scheduled', 'completed', 'suppressed', 'cancelled']
  if (!ok.includes(status)) return { ok: false, reason: 'unknown status' }
  initHvSms()
  if (['cancelled', 'suppressed', 'completed', 'walkthrough_scheduled'].includes(status)) {
    for (const id of pendingTextIds(Number(clientId))) {
      db.run("UPDATE scheduled_texts SET status='canceled', error=? WHERE id=?", [reason, id])
    }
    db.run('UPDATE home_value_sms SET status=?, next_send_at=NULL, stop_reason=?, updated_at=? WHERE client_id=?', [status, reason, nowIso(), Number(clientId)])
  } else {
    db.run('UPDATE home_value_sms SET status=?, updated_at=? WHERE client_id=?', [status, nowIso(), Number(clientId)])
  }
  log(Number(clientId), 'status_set', { reason: `${status}: ${reason}` })
  return { ok: true, status }
}
