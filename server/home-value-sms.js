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

// THE HOME VALUE RESPONSE CAMPAIGN (John's spec, 2026-10-23).
//
// This is the SHORT-TERM response and qualification sequence that runs straight after
// someone asks what their house is worth. It is not the 26-email long-term nurture; a lead
// who reaches the end of this without replying is handed to that, and qualification never
// restarts there.
//
// Its job is not to win a listing appointment. It is to learn the things an automated
// valuation cannot see - condition, improvements, what a buyer would notice - and only much
// later, once those questions have earned it, to ask about a possible move. Day 15 is the
// first time intent is raised at all.
//
// SMS and EMAIL alternate and never carry the same content within a day. The text asks one
// easy question; the email that follows explains WHY that question matters. That is the
// whole reason both channels exist here instead of one being a copy of the other.
//
// Copy is John's, VERBATIM, including where it opens without a greeting. Earlier sequences
// rotated Hi/Hello/time-of-day; his copy here mostly starts mid-thought on purpose, so
// nothing is prepended to it.
export const HV_STEPS = [
  { key: 'day1_email', day: 1, channel: 'email',
    purpose: 'Explain why condition is the thing the estimate cannot see',
    subject: (c) => `One thing the estimate can't see at ${c.street}`,
    paras: (c) => [
      `Thanks again for requesting the value of your home at ${c.street}.`,
      `The estimate is a useful starting point, but one thing an automated valuation can't really see is the actual condition of the home.`,
      `Two homes with similar square footage, bedrooms and location can sell very differently depending on how they've been maintained and updated.`,
      `That's why we asked how you would rate the home's condition from 1 to 10.`,
      `If you have a second, just reply with a number. No explanation needed unless you'd like to give us more detail.`,
      `Thanks!`,
    ] },

  { key: 'day3_improvements', day: 3, channel: 'sms',
    purpose: 'Improvements, without handing them a questionnaire',
    text: (c) => `Another thing the online estimate won't know is what you've done to the home over the years. Have you made any major updates such as the kitchen, bathrooms, roof, windows, HVAC, basement or anything else?` },

  { key: 'day5_email', day: 5, channel: 'email',
    purpose: 'Why improvements move a valuation',
    subject: (c) => `Has anything changed at ${c.street}?`,
    paras: (c) => [
      `One of the biggest limitations with online home-value estimates is that they usually don't know what has actually been improved inside the property.`,
      `A new roof, updated kitchen, finished basement, newer mechanicals, windows or other improvements can all affect how buyers compare one home to another.`,
      `If you've made any meaningful updates to ${c.street}, just reply and let us know what you've done.`,
      `Even a short list helps us understand whether the automated estimate is likely missing something.`,
      `Thanks!`,
    ] },

  { key: 'day8_buyer_notice', day: 8, channel: 'sms',
    purpose: 'Open question that surfaces condition, remodels or deferred maintenance',
    text: (c) => `If you had to pick one thing about the house that a buyer would probably notice first, either good or bad, what would it be?` },

  { key: 'day11_email', day: 11, channel: 'email',
    purpose: 'The buyer perspective, and that it is fine for the answer to be a negative',
    subject: (c) => `What would a buyer notice first?`,
    paras: (c) => [
      `When we look at home values, one thing we think about is what a buyer would notice when they first walk through the property.`,
      `Sometimes it's a remodeled kitchen, a great backyard or an unusually nice layout.`,
      `Other times it's something the homeowner already knows could use attention.`,
      `Those details aren't reflected very well in an automated estimate.`,
      `If there's one feature or condition item at ${c.street} that you think stands out most, feel free to reply and let me know.`,
    ] },

  { key: 'day15_intent', day: 15, channel: 'sms',
    purpose: 'FIRST mention of a possible move, deliberately not before this',
    text: (c) => `Just curious, are you mainly checking the value to keep tabs on the property, or is a move something you might consider at some point?` },

  { key: 'day19_email', day: 19, channel: 'email',
    purpose: 'Make either answer comfortable to give',
    subject: (c) => `Just curious about your plans for ${c.street}`,
    paras: (c) => [
      `People check their home value for all kinds of reasons.`,
      `Sometimes they're simply curious about how the property has changed in value.`,
      `Other times they're thinking about moving sometime down the road and want to understand where they stand before making any decisions.`,
      `Either reason is completely fine.`,
      `I'm just curious which is closer to your situation with ${c.street}.`,
      `Feel free to hit reply and let me know.`,
    ] },

  { key: 'day23_where', day: 23, channel: 'sms',
    purpose: 'Learn real intent without assuming they are selling',
    text: (c) => `If you ever did make a move, do you already have an idea where you'd want to go next, or is that not really on the radar yet?` },

  { key: 'day28_email', day: 28, channel: 'email',
    purpose: 'Value is one piece; offer the numbers without asking for anything',
    subject: (c) => `Knowing the value is only part of the picture`,
    paras: (c) => [
      `Knowing what ${c.street} may be worth is helpful, but if a move ever becomes part of the plan, that's usually only one piece of the puzzle.`,
      `The next questions tend to be things like:`,
      `Where would you go next?`,
      `What would that home cost?`,
      `How much equity would you have available?`,
      `Would you need to sell first, or could you buy before selling?`,
      `There's no need to figure any of that out now.`,
      `But if a move is something you may consider eventually, we're always happy to help you understand the numbers and options before you make any decisions.`,
    ] },

  { key: 'day32_expectation', day: 32, channel: 'sms',
    purpose: 'The easiest possible question, to reopen a dead thread',
    text: (c) => `One last home-value question for you :) Do you feel like the estimate you received was about what you expected, higher than expected, or lower than expected?` },

  { key: 'day37_email', day: 37, channel: 'email',
    purpose: 'Same question with the context that makes it safe to answer',
    subject: (c) => `Did the value surprise you?`,
    paras: (c) => [
      `I wanted to ask one last simple question about the valuation you received for ${c.street}.`,
      `Did the estimate feel:`,
      `Higher than you expected?`,
      `About what you expected?`,
      `Or lower than you expected?`,
      `There's no wrong answer.`,
      `Online estimates are really just a starting point, and the actual condition, updates, location within the neighborhood and current competition can change the picture.`,
      `If you're curious, just reply with "higher," "about right" or "lower."`,
    ] },

  { key: 'day45_sms_close', day: 45, channel: 'sms',
    purpose: 'Soft close. No pressure language, no last chance, no appointment ask',
    // The only step that opens with a name, so it is the only one that can print
    // "Hi undefined". mergeFieldsFor already defaults to "there", but a close is the worst
    // possible place to discover that a caller skipped it.
    text: (c) => `Hi ${c.first_name || 'there'}, we'll leave things here for now. If you ever want a closer look at the value of ${c.street || 'your home'} or have any real estate questions, we're always happy to help. MattSmithTeam.com` },

  { key: 'day45_email_close', day: 45, channel: 'email', final: true,
    purpose: 'Soft close, and the handoff point to long-term nurture',
    subject: (c) => `We'll leave things here for now`,
    paras: (c) => [
      `We'll leave things here for now, but I hope the home-value information was helpful.`,
      `If you ever want us to take a closer look at ${c.street}, compare it with recent nearby sales or help you understand what the property could realistically be worth in today's market, we're always happy to help.`,
      `No pressure and no obligation.`,
      `You can also keep an eye on the market anytime at MattSmithTeam.com.`,
      `Thanks again for reaching out to our team.`,
    ] },
]

// Kept so the sequence PDF builder and the older tests keep resolving.
export const HV_SMS_STEPS = HV_STEPS

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
// THE BLOCK RULES ARE PER CHANNEL (John's dual-channel spec, 2026-10-23).
//
// This used to be SMS-only, which was fine when the campaign was SMS-only. Applied
// unchanged to the new email steps it would be wrong four separate ways: a TEXT opt-out
// would silence email, an undeliverable mobile would silence email, a homeowner with an
// email and no phone would receive nothing at all, and the "already texted in 20 hours"
// rule would hold an email back for a text the campaign itself had just sent. That last
// one matters most, because the sequence deliberately alternates the two.
//
// What both channels share: the record still exists, the lead has not replied, and the
// status is one we still contact.
export function hvSmsBlock(client, row, step = null) {
  if (!client) return 'client gone'
  if (client.merged_into) return 'merged into another record'
  const st = String(client.status || '').toLowerCase()
  if (['junk', 'donotcontact', 'closed', 'archived', 'trash'].includes(st)) return `lead status ${client.status}`
  if (row && row.replied_at) return 'lead has replied'

  if (step && step.channel === 'email') {
    // Opt-out, bounce and the cross-campaign email cap are enforced by emailCapBlock and
    // sendSequenceEmail at the point of sending, so they are not duplicated here.
    if (!String(client.email || '').trim()) return 'no email on file'
    return null
  }

  if (client.hub_text_opt_out) return 'replied STOP to our number'
  if (client.sms_undeliverable) return 'number is undeliverable'
  if (String(client.phone || '').replace(/\D/g, '').length < 10) return 'no mobile number'
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
    const block = hvSmsBlock(c, row, step)
    if (block) {
      // A homeowner with a phone but no email address should still get every TEXT in the
      // sequence. Missing one channel skips that step; it does not end the campaign.
      if (block === 'no email on file') {
        log(row.client_id, 'skipped', { step_key: step.key, reason: block })
        advanceAfterSend(c, row, step, { body: '(skipped, no email on file)', commId: null })
        out.deferred++
        continue
      }
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

// EMAIL IS MATT, ON EVERY CAMPAIGN (John, 2026-10-23, confirming the standing rule).
//
// His written spec for this campaign signed the emails "John". Asked about it, he was
// unambiguous: "always Matt on all campaigns". That matches why the rule exists - all
// outbound mail leaves Matt's marketing address, so a John sign-off confuses the reader,
// which is exactly what happened to Rich Gholston and Mark Herzberger.
//
// The John persona stays on SMS, where the number is his.
export function hvEmailHtml(first, paras) {
  const ps = paras.map(t => `<p>${t}</p>`).join('\n')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
<p>Hi ${first},</p>
${ps}
<p>Matt Smith<br>Matt Smith Team | RE/MAX Concepts</p></div>`
}

async function sendStep(client, row, step) {
  const f = mergeFieldsFor(client)
  try {
    // ---- EMAIL STEPS ----
    // They obey the same cross-campaign ceiling as every other automated email: 1 a day,
    // 2 a week, counted across drips, campaigns and manual sends. Over the cap returns
    // ok:false, which lands in defer() and keeps the touch rather than burning it.
    if (step.channel === 'email') {
      if (!String(client.email || '').trim()) return { ok: false, reason: 'no email on file' }
      const { emailCapBlock } = await import('./email-cap.js')
      const cap = emailCapBlock(client.id, 'home_value_response')
      if (cap) return { ok: false, reason: cap.reason }
      const { sendSequenceEmail } = await import('./routes/email.js')
      const subject = step.subject({ first_name: f.first_name, street: f.street })
      const paras = step.paras({ first_name: f.first_name, street: f.street })
      const r = await sendSequenceEmail(client, { subject, body: hvEmailHtml(f.first_name, paras) }, 'home_value_response')
      if (r?.ok === false) return { ok: false, reason: r.reason }
      advanceAfterSend(client, row, step, { body: subject, commId: null })
      return { ok: true }
    }

    // ---- SMS STEPS ----
    // No greeting is prepended. John's copy for this campaign deliberately opens
    // mid-thought, and the Hi/Hello/time-of-day rotation would fight it.
    const body = step.text({ first_name: f.first_name, street: f.street })
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
       'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'Home Value Response', 'home_value_sms', nowIso()])
    advanceAfterSend(client, row, step, { body, commId: ins.lastInsertRowid })
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Shared by both channels so the schedule can never advance one way for a text and another
// for an email.
function advanceAfterSend(client, row, step, { body, commId }) {
  {
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
      // END OF THE RESPONSE CAMPAIGN, NOT THE END OF THE RELATIONSHIP (John, 2026-10-23).
      //
      // Someone who never replied across 45 days is not a dead lead, they are a homeowner
      // who had nothing to say yet. They move to the long-term Home Value nurture, which
      // is market information rather than questions. Qualification never starts again:
      // that is the whole point of the handoff.
      handOffToLongTermNurture(client.id)
    }
    log(client.id, 'sent', { step_key: step.key, body, comm_id: commId })
  }
}

// The long-term nurture is an ordinary drip, so the handoff is an enrolment. Past clients
// have their own version of it, and the cap rules in the drip engine still apply, so this
// deliberately does not force anything: it asks, and logs what happened.
function handOffToLongTermNurture(cid) {
  try {
    const c = db.get('SELECT id, status, tags FROM clients WHERE id=? AND merged_into IS NULL', [cid])
    if (!c) return
    const isPastClient = String(c.status || '').toLowerCase() === 'closed' || /past client/i.test(String(c.tags || ''))
    const dripId = isPastClient ? 21 : 20
    const already = db.get('SELECT id FROM drip_enrollments WHERE client_id=? AND drip_id=? AND status IN (?,?)', [cid, dripId, 'active', 'paused'])
    if (already) { log(cid, 'handoff', { reason: `already in long-term drip ${dripId}` }); return }
    db.run(`INSERT INTO drip_enrollments (client_id, drip_id, status, current_step, source, enrolled_at, updated_at)
            VALUES (?,?,?,?,?,?,?)`, [cid, dripId, 'active', 0, 'home_value_response_handoff', nowIso(), nowIso()])
    log(cid, 'handoff', { reason: `moved to long-term Home Value nurture (drip ${dripId})` })
  } catch (e) { log(cid, 'handoff', { reason: 'handoff failed: ' + e.message }) }
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
