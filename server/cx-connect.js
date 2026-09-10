// CANCELLED / EXPIRED PERSISTENT CONNECTION SMS CAMPAIGN ("CX Connect").
//
// Purpose: MAKE CONTACT with cold Cancelled/Expired sellers and keep gently trying
// until they respond or become ineligible. The moment they respond, ALL automation
// stops and a human takes over. The AI NEVER composes or sends a reply to these
// leads — see handleCxInbound() and the orchestrator gate.
//
//   NO RESPONSE -> keep offering chances to respond (weekly, rotating angles)
//   RESPONSE    -> stop everything, flag for human follow-up
//
// Persistence means MORE OPPORTUNITIES TO RESPOND, never more sales pressure:
// the approved message library is fixed, angles rotate (no repeats within the last
// 3 sends), language follows how long the property has been off market, and no
// message ever gets more aggressive than the first one.
//
// Reuses: policy.canAutomatedSend (STOP/DNC/opt-out/landline/holiday/quiet-hours/
// collision/dedup), twilio.sendSms, notifications.notify, tasks, the same weekday
// 9AM-4PM Central proactive window as the FSBO sequence. Master switch is OFF until
// cx_campaign_enabled='1' (prevents an accidental mass-text on deploy).
import db from './database.js'

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const DAY = 86400000

export function cxEnabled() { try { return db.getSetting('cx_campaign_enabled', '0') === '1' } catch { return false } }

// ---------- time helpers (Central) ----------
function chi(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', hour12: false }).formatToParts(d)
  const g = (t) => p.find(x => x.type === t)?.value
  return { weekday: g('weekday'), hour: Number(g('hour')) === 24 ? 0 : Number(g('hour')) }
}
// Proactive prospecting texts go out weekdays 9AM-4PM Central only.
export function inCxWindow() {
  const c = chi()
  if (['Sat', 'Sun'].includes(c.weekday)) return false
  return c.hour >= 9 && c.hour < 16
}
// Salutation for the initial templates. Never "evening" (we don't text then).
function salutation() { const h = chi().hour; return h < 12 ? 'Hi good morning :)' : h < 16 ? 'Hi good afternoon :)' : 'Hello :)' }

// Shift a timestamp forward so it lands on a weekday (Sat -> Mon, Sun -> Mon), Central.
export function toWeekday(ts) {
  let d = new Date(ts)
  for (let i = 0; i < 3; i++) {
    const w = chi(d).weekday
    if (!['Sat', 'Sun'].includes(w)) break
    d = new Date(d.getTime() + DAY)
  }
  return d
}

// ---------- off-market age ----------
// off_market_date arrives as 'YYYY-MM-DD' or 'MM/DD/YYYY'.
export function parseOffMarket(v) {
  const s = String(v || '').trim()
  if (!s) return null
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]))
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : new Date(t)
}
export function daysSinceOffMarket(client) {
  const d = parseOffMarket(client?.off_market_date)
  if (!d) return null
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / DAY))
}
// Buckets: recent (0-30), mid (31-90), old (91-365), ancient (365+).
// Unknown date -> 'old' language ("previous listing", never "recently").
export function ageBucket(days) {
  if (days == null) return 'old'
  if (days <= 30) return 'recent'
  if (days <= 90) return 'mid'
  if (days <= 365) return 'old'
  return 'ancient'
}

// ---------- approved message library ----------
// {{street}} is the street address only. No owner names, no "your home" — identity
// is never assumed (numbers often come from skip tracing). No activity questions,
// no manufactured sales hooks, message 40 no more aggressive than message 1.
const A = (street) => street
export const INITIAL = {
  recent: (s, sal) => `${sal} I'm John with Matt Smith Team at RE/MAX. Our team noticed the home at ${A(s)} recently came off the market and wanted to check if it's still available? MattSmithTeam.com`,
  mid: (s, sal) => `${sal} I'm John with Matt Smith Team at RE/MAX. I came across the previous listing for ${A(s)} and wanted to check if the property is still available? MattSmithTeam.com`,
  old: (s, sal) => `${sal} I'm John with Matt Smith Team at RE/MAX. I came across the previous listing for ${A(s)} from a while back and wasn't sure where things ended up. Did the property ever get sold? MattSmithTeam.com`,
  ancient: (s, sal) => `${sal} I'm John with Matt Smith Team at RE/MAX. I know it's been quite a while, but I came across the older listing for ${A(s)} and was curious if the plans for the property are any different these days. MattSmithTeam.com`,
}
export const SECOND = {
  recent: (s) => `Hi :) Just checking in to see if you saw my message regarding ${A(s)}. Is the property still available? MattSmithTeam.com`,
  mid: (s) => `Hi :) Just wanted to follow up on my message about ${A(s)}. Did the property ever get sold?`,
  old: (s) => `Hi :) Just following up on my message regarding ${A(s)}. I wasn't sure where things ended up with the property.`,
  ancient: (s) => `Hi :) Just following up on my message regarding ${A(s)}. I wasn't sure where things ended up with the property.`,
}
// Weekly angles. buckets: which age buckets the angle suits. Variants per bucket
// where the wording must differ (old listings never get "recently"/"still off market"
// style recency claims).
export const ANGLES = {
  DID_IT_SELL: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hello, John with Matt Smith Team. I wasn't sure where things ended up with ${A(s)}. Did the property ever get sold?` },
  PLANS_CHANGED: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi, just checking back regarding ${A(s)}. Did plans for the property change, or is a move still something being considered?` },
  CURRENT_PLANS: { buckets: ['mid', 'old', 'ancient'], text: (s) => `Hi, just checking back regarding ${A(s)}. What are the plans for the property these days?` },
  HAS_ANYTHING_CHANGED: {
    buckets: ['recent', 'mid', 'old', 'ancient'],
    text: (s, b) => (b === 'old' || b === 'ancient')
      ? `Hello :) It's been a while since ${A(s)} was listed. Just wanted to see if anything has changed with the plans for the property.`
      : `Hello :) I wasn't sure if anything had changed with ${A(s)} since it came off market. Just wanted to check back.`,
  },
  FUTURE_POSSIBILITY: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hello :) Wanted to check back on ${A(s)}. Is a future sale still a possibility, or have things gone in a different direction?` },
  HOLD_VS_MOVE: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi, wanted to check back about ${A(s)}. Did the plans for the property change, or could a move still happen?` },
  SIMPLE_CHECK_IN: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi, John with Matt Smith Team. I wasn't sure if things were simply put on pause with ${A(s)} or if the plans changed completely.` },
  RIGHT_OFFER: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hello, John with Matt Smith Team. If the right offer came along for ${A(s)}, would that still be something you'd consider?` },
  PROPERTY_DECISION: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi :) Just checking back to see if anything has been decided with ${A(s)}.` },
  FUTURE_TIMING: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi, just checking back on ${A(s)}. Is putting the property back on the market something that may happen later on?` },
  OPEN_DOOR: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi :) Just keeping the door open regarding ${A(s)}. If anything changes with the property, feel free to let me know.` },
  BACK_TO_MARKET: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hi :) Just wanted to see if bringing ${A(s)} back to market is something being considered.` },
  MAKING_A_MOVE: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `Hello :) John with Matt Smith Team. Just curious if making a move is still somewhere in the plans regarding ${A(s)}.` },
  GET_IT_SOLD: { buckets: ['mid', 'old', 'ancient'], text: (s) => `Hello, John with Matt Smith Team. Not sure where things landed with ${A(s)}, but is getting the property sold still somewhere in the plans?` },
  MARKET_RETURN: { buckets: ['mid', 'old', 'ancient'], text: (s) => `Hello, John with Matt Smith Team. Is taking ${A(s)} back to market something that might happen, or are things on hold for now?` },
  RIGHT_SITUATION: { buckets: ['mid', 'old', 'ancient'], text: (s) => `Hi, just checking back on ${A(s)}. If the right situation came along, would getting the property sold still be something worth considering?` },
  LONG_TERM_REACTIVATION: { buckets: ['old', 'ancient'], text: (s) => `Hi, John with Matt Smith Team. I know it's been some time since ${A(s)} was listed. Has making a move come back onto the radar at all?` },
  OLD_LISTING: { buckets: ['old', 'ancient'], text: (s) => `Hello, John with Matt Smith Team. I came across the older listing for ${A(s)} again and was curious if the plans for the property are any different these days.` },
}
// Rotation order (from the approved 13-week example). Selection walks this list,
// skips angles used in the last 3 sends and angles wrong for the age bucket.
const ROTATION = ['DID_IT_SELL', 'PLANS_CHANGED', 'CURRENT_PLANS', 'HAS_ANYTHING_CHANGED', 'FUTURE_POSSIBILITY', 'HOLD_VS_MOVE', 'SIMPLE_CHECK_IN', 'RIGHT_OFFER', 'PROPERTY_DECISION', 'FUTURE_TIMING', 'OPEN_DOOR', 'BACK_TO_MARKET', 'LONG_TERM_REACTIVATION', 'MAKING_A_MOVE', 'GET_IT_SOLD', 'MARKET_RETURN', 'RIGHT_SITUATION', 'OLD_LISTING']

function streetOf(client) {
  const a = String(client.address || '').trim()
  return a || 'the property'
}

export function pickAngle(clientId, bucket) {
  const last3 = db.all("SELECT angle FROM cx_campaign_log WHERE client_id=? AND event='sent' AND angle IS NOT NULL ORDER BY id DESC LIMIT 3", [clientId]).map(r => r.angle)
  const lastIdx = last3.length ? ROTATION.indexOf(last3[0]) : -1
  for (let i = 1; i <= ROTATION.length; i++) {
    const key = ROTATION[(lastIdx + i) % ROTATION.length]
    const a = ANGLES[key]
    if (!a || !a.buckets.includes(bucket)) continue
    if (last3.includes(key)) continue
    return key
  }
  return 'SIMPLE_CHECK_IN'
}

// ---------- inbound-history analysis ----------
// Read the ACTUAL conversation (texts + emails + call transcripts), not just
// status/dates. Returns a terminal classification when a prior message already
// settled the outcome. Wrong-number/opt-out/etc. are TERMINAL; a stated future
// timeframe stops the generic campaign and flags for human review.
const CLASS_RULES = [
  ['WRONG_NUMBER', /\bwrong (number|person)\b|don'?t know (what|who) you|never (listed|owned|sold)/i],
  ['SOLD', /\b(already )?sold( it| the (house|home|property))?\b|\bwe sold\b|\bit sold\b|closed on it/i],
  ['RENTED', /\brent(ed|ing)?\b|\btenant|for rent|lease[ds]?\b/i],
  ['LISTED_WITH_AGENT', /(another|different|new|our|an) (agent|realtor|broker)|re-?listed with|working with (an agent|a realtor|someone)/i],
  ['HOLDING_PROPERTY', /\b(keep(ing)?|hold(ing)? on to|staying|not moving|decided to stay)\b/i],
  ['NOT_INTERESTED', /\bnot interested\b|\bno interest\b|no longer (interested|selling)|not (selling|going to sell)\b/i],
  ['FUTURE_TIMEFRAME', /\b(maybe|probably|possibly)?\s*(next|this) (year|spring|summer|fall|winter)\b|in (a few|[0-9]+) (months|years)|later (this|next) year|down the road/i],
  ['WANTS_CALL', /\bcall me\b|give me a call|phone me/i],
  ['STILL_AVAILABLE', /\bstill (available|for sale)\b|yes.{0,12}available/i],
]
export function classifyInbound(text) {
  const s = String(text || '').trim()
  if (!s) return 'UNCLEAR'
  for (const [label, re] of CLASS_RULES) if (re.test(s)) return label
  return 'NEEDS_HUMAN_REVIEW'
}
// Scan every meaningful inbound message on record. Returns null when history is
// clean, else { code, detail } describing why this campaign must not run.
function historyBlock(clientId) {
  const inbound = db.all(`SELECT channel, body, preview, transcript, occurred_at FROM communications
    WHERE client_id=? AND direction='incoming' AND channel IN ('text','email','call','voicemail')
    ORDER BY occurred_at DESC LIMIT 200`, [clientId])
  let meaningful = false
  for (const m of inbound) {
    const text = [m.body, m.preview, m.transcript].filter(Boolean).join(' ')
    if (m.channel !== 'call' || (text && text.length > 3)) meaningful = meaningful || !!String(text).trim() || m.channel === 'call'
    const cls = classifyInbound(text)
    if (['WRONG_NUMBER', 'SOLD', 'RENTED', 'LISTED_WITH_AGENT', 'HOLDING_PROPERTY', 'NOT_INTERESTED'].includes(cls)) {
      return { code: cls, detail: String(text).slice(0, 160) }
    }
    if (cls === 'FUTURE_TIMEFRAME') return { code: 'FUTURE_TIMEFRAME_ESTABLISHED', detail: String(text).slice(0, 160) }
  }
  // ANY meaningful inbound message means a human conversation exists (or existed):
  // this connection campaign is for leads who have never responded.
  if (meaningful) return { code: 'PRIOR_RESPONSE', detail: 'lead has replied before — human follow-up, not automation' }
  return null
}

// ---------- eligibility ----------
// Run at enrollment AND before EVERY send. Returns:
//   { ok:true }                                — send allowed
//   { ok:false, terminal:true,  code, detail } — stop the campaign (log + status)
//   { ok:false, terminal:false, code, detail } — defer (push next_send_at, keep active)
export async function evaluateEligibility(client, { atEnroll = false } = {}) {
  if (!client) return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'client not found' }
  if (client.merged_into) return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'merged into another record' }
  if (!client.phone) return { ok: false, terminal: true, code: 'WRONG_NUMBER', detail: 'no phone on file' }

  // Property status from the master-file-synced fields: anything back on/off the
  // market in the wrong direction stops prospecting.
  const mls = String(client.mls_status || '').toLowerCase()
  if (/sold|closed/.test(mls)) return { ok: false, terminal: true, code: 'SOLD', detail: `MLS status ${client.mls_status}` }
  if (/pending|contingent/.test(mls)) return { ok: false, terminal: true, code: 'PENDING', detail: `MLS status ${client.mls_status}` }
  if (/active/.test(mls)) return { ok: false, terminal: true, code: 'RELISTED', detail: `MLS status ${client.mls_status}` }
  const status = String(client.status || '').toLowerCase()
  if (status === 'junk') return { ok: false, terminal: true, code: 'RELISTED', detail: 'lead junked (relisted / not a prospect)' }
  if (['closed', 'pending', 'not_in_market', 'donotcontact', 'archived', 'trash'].includes(status)) {
    return { ok: false, terminal: true, code: status === 'not_in_market' ? 'FUTURE_TIMEFRAME_ESTABLISHED' : 'OTHER_WORKFLOW', detail: `lead status ${client.status}` }
  }
  if (client.hub_text_opt_out) return { ok: false, terminal: true, code: 'DNC', detail: 'replied STOP to our number' }
  if (client.sms_undeliverable) return { ok: false, terminal: true, code: 'WRONG_NUMBER', detail: 'number undeliverable (likely landline)' }

  // The actual conversation history rules over everything above.
  const hist = historyBlock(client.id)
  if (hist) return { ok: false, terminal: true, code: hist.code, detail: hist.detail }

  // Another automation actively owns this lead.
  try {
    const st = db.get('SELECT ai_state, ai_managed FROM ai_lead_state WHERE client_id=?', [client.id])
    if (st && st.ai_managed === 1) return { ok: false, terminal: true, code: 'OTHER_WORKFLOW', detail: 'HUB AI manages this lead' }
  } catch {}

  if (atEnroll) return { ok: true }

  // Send-time-only checks: recent MANUAL human touch defers the drip (the
  // automation must respect human activity, never talk over it).
  const manual = db.get(`SELECT occurred_at FROM communications WHERE client_id=? AND direction='outgoing'
    AND (sent_by_type IS NULL OR sent_by_type NOT IN ('ai','fsbo_ai','automation','system','cx_connect','drip'))
    AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1`, [client.id, new Date(Date.now() - 3 * DAY).toISOString()])
  if (manual) return { ok: false, terminal: false, code: 'RECENT_MANUAL_CONTACT', detail: `manual outreach ${manual.occurred_at}` }

  // Central collision/compliance gate (STOP, opt-out, quiet hours, dedup, live AI
  // or human conversation, holiday). dedupMinutes 20h = never two texts same day.
  const { canAutomatedSend } = await import('./ai-followup/policy.js')
  const gate = canAutomatedSend(client, { source: 'drip', dedupMinutes: 20 * 60 })
  if (!gate.ok) {
    const terminalReasons = /STOP|opted out|do_not_text|blocked|status/i.test(gate.reason)
    return { ok: false, terminal: terminalReasons, code: terminalReasons ? 'DNC' : 'COLLISION', detail: gate.reason }
  }
  return { ok: true }
}

// ---------- logging ----------
function logCx(clientId, event, fields = {}) {
  try {
    db.run(`INSERT INTO cx_campaign_log (client_id, event, message_number, angle, template_key, off_market_date, days_since_off_market, age_bucket, eligibility_result, suppression_reason, comm_id, body, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [clientId, event, fields.message_number ?? null, fields.angle ?? null, fields.template_key ?? null,
        fields.off_market_date ?? null, fields.days_since_off_market ?? null, fields.age_bucket ?? null,
        fields.eligibility_result ?? null, fields.suppression_reason ?? null, fields.comm_id ?? null,
        fields.body ? String(fields.body).slice(0, 500) : null, nowIso()])
  } catch (e) { console.error('[cx-connect] log failed:', e.message) }
}

// ---------- enrollment ----------
export async function enrollClient(clientId, enrolledBy = 'manual') {
  const c = db.get('SELECT * FROM clients WHERE id=?', [clientId])
  const existing = db.get('SELECT * FROM cx_campaign WHERE client_id=?', [clientId])
  if (existing && existing.status === 'active') return { ok: false, reason: 'already enrolled' }
  if (existing && existing.status === 'response_received') return { ok: false, reason: 'response received — human must decide before re-enrollment' }
  const ver = await evaluateEligibility(c, { atEnroll: true })
  if (!ver.ok) {
    logCx(clientId, 'enroll_refused', { eligibility_result: ver.code, suppression_reason: ver.detail })
    return { ok: false, reason: `${ver.code}: ${ver.detail}` }
  }
  const next = toWeekday(new Date()).toISOString()
  if (existing) {
    db.run(`UPDATE cx_campaign SET status='active', enrolled_at=?, enrolled_by=?, next_send_at=?, stop_reason=NULL, stopped_at=NULL, updated_at=? WHERE client_id=?`,
      [nowIso(), enrolledBy, next, nowIso(), clientId])
  } else {
    db.run(`INSERT INTO cx_campaign (client_id, status, enrolled_at, enrolled_by, attempt_count, next_send_at, updated_at)
            VALUES (?,?,?,?,0,?,?)`, [clientId, 'active', nowIso(), enrolledBy, next, nowIso()])
  }
  logCx(clientId, 'enrolled', { eligibility_result: 'ok', off_market_date: c.off_market_date || null })
  return { ok: true }
}

// Bulk enroll: every member of the Cancelled/Expired saved list, each individually
// eligibility-checked. Returns a full summary so nothing is silent.
export async function enrollList() {
  const list = db.get("SELECT * FROM lists WHERE lower(name) LIKE '%cancelled%' OR lower(name) LIKE '%expired%' ORDER BY id LIMIT 1")
  if (!list) return { ok: false, reason: 'Cancelled/Expired saved list not found' }
  let ids = []
  try { ids = JSON.parse(list.client_ids || '[]') } catch {}
  const out = { enrolled: [], skipped: [] }
  for (const id of ids) {
    const r = await enrollClient(id, 'bulk')
    if (r.ok) out.enrolled.push(id)
    else out.skipped.push({ id, reason: r.reason })
  }
  return { ok: true, list: list.name, total: ids.length, enrolled: out.enrolled.length, skipped: out.skipped }
}

// ---------- cadence ----------
// Attempt 1 -> day 2 OR 3 (randomly). Attempt 2 -> ~day 7. Then approximately
// weekly — deliberately varied so sends never settle into one fixed day/time:
//   * weekly gaps are 6-8 days, so the weekday drifts over the campaign
//   * a weekend landing resolves randomly to Friday (back) or Monday (forward)
//   * the send time is randomized inside the 9AM-4PM Central window
// Every send logs its exact timestamp + attempt + angle, so we can analyze which
// days and times actually generate responses. No attempt cap: the lead stays
// enrolled while eligible, re-verified before every single send.
export function scheduleNext(attemptJustSent, from = new Date()) {
  const baseDays = attemptJustSent === 1 ? 2 : attemptJustSent === 2 ? 5 : 7
  const jitter = attemptJustSent === 1 ? Math.round(Math.random())            // day 2 or 3
    : attemptJustSent >= 3 ? Math.floor(Math.random() * 3) - 1 : 0            // weekly: 6-8 days
  let d = new Date(from.getTime() + (baseDays + jitter) * DAY)
  // Saturday resolves randomly to Friday or Monday; Sunday always to Monday —
  // so the weekly gap never compresses below ~5 days.
  const wd = () => chi(d).weekday
  if (wd() === 'Sat') d = new Date(d.getTime() + (Math.random() < 0.5 ? -DAY : 2 * DAY))
  else if (wd() === 'Sun') d = new Date(d.getTime() + DAY)
  // Random time inside the window: 9:00 AM - 3:59 PM Central.
  const targetHour = 9 + Math.floor(Math.random() * 7)
  d = new Date(d.getTime() + (targetHour - chi(d).hour) * 3600000)
  d = new Date(d.getTime() + (Math.floor(Math.random() * 60) - d.getUTCMinutes()) * 60000)
  return d
}

// ---------- the sweep ----------
let sweeping = false
export async function runCxSweep() {
  if (sweeping) return
  if (!cxEnabled()) return
  if (!inCxWindow()) return
  sweeping = true
  try {
    const due = db.all("SELECT * FROM cx_campaign WHERE status='active' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT 25", [nowIso()])
    for (const en of due) {
      try { await sendNextForEnrollment(en) } catch (e) { console.error('[cx-connect] send failed for', en.client_id, e.message) }
      await new Promise(r => setTimeout(r, 1500))   // pace sends; never a burst
    }
  } finally { sweeping = false }
}

async function sendNextForEnrollment(en) {
  const c = db.get('SELECT * FROM clients WHERE id=?', [en.client_id])
  const days = daysSinceOffMarket(c || {})
  const bucket = ageBucket(days)
  const attempt = (en.attempt_count || 0) + 1
  const base = { message_number: attempt, off_market_date: c?.off_market_date || null, days_since_off_market: days, age_bucket: bucket }

  const ver = await evaluateEligibility(c)
  if (!ver.ok) {
    if (ver.terminal) {
      db.run("UPDATE cx_campaign SET status='ineligible', stop_reason=?, stopped_at=?, next_send_at=NULL, updated_at=? WHERE client_id=?",
        [`${ver.code}: ${ver.detail}`.slice(0, 250), nowIso(), nowIso(), en.client_id])
      logCx(en.client_id, 'stopped', { ...base, eligibility_result: 'ineligible', suppression_reason: ver.code })
      // A settled outcome discovered from history deserves human eyes, not silence.
      if (['FUTURE_TIMEFRAME_ESTABLISHED', 'PRIOR_RESPONSE'].includes(ver.code)) flagHumanReview(c, ver.code, ver.detail)
    } else {
      const push = toWeekday(new Date(Date.now() + (ver.code === 'RECENT_MANUAL_CONTACT' ? 3 : 1) * DAY)).toISOString()
      db.run('UPDATE cx_campaign SET next_send_at=?, updated_at=? WHERE client_id=?', [push, nowIso(), en.client_id])
      logCx(en.client_id, 'suppressed', { ...base, eligibility_result: 'deferred', suppression_reason: ver.code })
    }
    return
  }

  // Compose from the approved library only. Attempt 1/2 use the age-matched
  // intro/follow-up; attempt 3+ rotates angles (never the same angle twice in the
  // last 3 sends).
  const street = streetOf(c)
  let body, angle, templateKey
  if (attempt === 1) { body = INITIAL[bucket](street, salutation()); angle = 'INTRO'; templateKey = `initial_${bucket}` }
  else if (attempt === 2) { body = SECOND[bucket](street); angle = 'FOLLOW_UP'; templateKey = `second_${bucket}` }
  else {
    angle = pickAngle(en.client_id, bucket)
    templateKey = `angle_${angle}_${bucket}`
    body = ANGLES[angle].text(street, bucket)
  }

  const { sendSms } = await import('./twilio.js')
  const r = await sendSms(c.phone, body, { statusCallback: HUB + '/api/inbox/twilio-status' })
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
  const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['text', 'outgoing', c.id, name, '', c.phone, body.replace(/\s+/g, ' ').slice(0, 160), body, 'twilio_' + r.sid, `c${c.id}_text`, 'read', r.status || 'queued', 'CX Connect', 'cx_connect', nowIso()])
  const next = scheduleNext(attempt).toISOString()
  db.run('UPDATE cx_campaign SET attempt_count=?, last_sent_at=?, last_angle=?, next_send_at=?, updated_at=? WHERE client_id=?',
    [attempt, nowIso(), angle, next, nowIso(), en.client_id])
  logCx(en.client_id, 'sent', { ...base, angle, template_key: templateKey, comm_id: ins.lastInsertRowid, body, eligibility_result: 'ok' })
}

// ---------- inbound response: STOP FIRST, CLASSIFY SECOND ----------
// Called from the Twilio inbound webhook BEFORE any AI handling. Returns true when
// this lead is (or was) in the campaign — the caller must then NEVER hand the
// message to the AI responder. The AI does not speak to Cancelled/Expired
// connection-campaign leads, period.
export function handleCxInbound(clientId, body, commId = null) {
  let en
  try { en = db.get('SELECT * FROM cx_campaign WHERE client_id=?', [clientId]) } catch { return false }
  if (!en) return false
  if (en.status === 'active') {
    // 1-2) Stop the campaign + cancel anything pending immediately.
    db.run("UPDATE cx_campaign SET status='response_received', next_send_at=NULL, response_comm_id=?, response_at=?, updated_at=? WHERE client_id=?",
      [commId, nowIso(), nowIso(), clientId])
    try { db.run("UPDATE scheduled_texts SET status='canceled', error='canceled: lead responded (CX campaign)' WHERE client_id=? AND status='scheduled' AND created_by='cx_connect'", [clientId]) } catch {}
    // 3-6) Classify INTERNALLY (deterministic — no model in the send path), flag
    // for a human, notify, create the follow-up task.
    const cls = classifyInbound(body)
    db.run('UPDATE cx_campaign SET response_class=? WHERE client_id=?', [cls, clientId])
    logCx(clientId, 'response', { suppression_reason: cls, comm_id: commId, body })
    const c = db.get('SELECT * FROM clients WHERE id=?', [clientId])
    flagHumanReview(c, cls, body)
  }
  // 7-9) Whatever the status: the AI never replies to these leads.
  return true
}
export function cxEnrolled(clientId) {
  try { return !!db.get('SELECT client_id FROM cx_campaign WHERE client_id=?', [clientId]) } catch { return false }
}

function flagHumanReview(c, cls, detail) {
  if (!c) return
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || `Lead ${c.id}`
  try {
    import('./notifications.js').then(m => m.notify({
      type: 'cx_response', title: `RESPONSE RECEIVED — ${name} (Cancelled/Expired)`,
      body: `${cls}: ${String(detail || '').slice(0, 140)} — human follow-up required, campaign stopped.`,
      link: `/clients/${c.id}`, client_id: c.id, dedupKey: `cx_resp_${c.id}_${Date.now()}`,
    })).catch(() => {})
  } catch {}
  try {
    const open = db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'CX Response%' AND status IN ('todo','in_progress') LIMIT 1", [c.id])
    if (!open) {
      db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        [`CX Response: ${name}`, `Cancelled/Expired lead responded (${cls}). Review the conversation and reply personally — the automation has stopped and the AI will not respond.\nProperty: ${[c.address, c.city].filter(Boolean).join(', ')}\nMessage: ${String(detail || '').slice(0, 300)}`,
          'high', 'todo', new Date().toISOString().slice(0, 10), c.agent_assigned || 'Matt Smith', 'follow-up', 'client', c.id])
    }
  } catch (e) { console.error('[cx-connect] task failed:', e.message) }
}

// ---------- controls ----------
export function pauseCampaign(clientId) {
  db.run("UPDATE cx_campaign SET status='paused', updated_at=? WHERE client_id=? AND status='active'", [nowIso(), clientId])
  logCx(clientId, 'paused', {})
  return db.get('SELECT * FROM cx_campaign WHERE client_id=?', [clientId])
}
export async function resumeCampaign(clientId) {
  const en = db.get('SELECT * FROM cx_campaign WHERE client_id=?', [clientId])
  if (!en) return { ok: false, reason: 'not enrolled' }
  // Re-enrollment after a response (or a stop) is a deliberate HUMAN action, and
  // eligibility is re-verified from scratch.
  const c = db.get('SELECT * FROM clients WHERE id=?', [clientId])
  const ver = await evaluateEligibility(c, { atEnroll: true })
  if (!ver.ok) return { ok: false, reason: `${ver.code}: ${ver.detail}` }
  db.run("UPDATE cx_campaign SET status='active', next_send_at=?, stop_reason=NULL, stopped_at=NULL, updated_at=? WHERE client_id=?",
    [toWeekday(new Date()).toISOString(), nowIso(), clientId])
  logCx(clientId, 'resumed', {})
  return { ok: true }
}
export function removeFromCampaign(clientId) {
  db.run("UPDATE cx_campaign SET status='removed', next_send_at=NULL, stop_reason='HUMAN_REMOVED', stopped_at=?, updated_at=? WHERE client_id=?", [nowIso(), nowIso(), clientId])
  logCx(clientId, 'removed', { suppression_reason: 'HUMAN_REMOVED' })
  return { ok: true }
}

// ---------- dry-run preview (never sends, never writes) ----------
// "What would the next text be?" for N leads — exact message, angle, age bucket,
// and eligibility verdict, composed by the same code paths the sweep uses.
export async function previewNext(limit = 5) {
  limit = Math.min(Math.max(Number(limit) || 5, 1), 25)
  // Enrolled active leads first; if none are enrolled yet, simulate attempt 1
  // across the Cancelled/Expired saved list.
  let candidates = db.all("SELECT client_id, attempt_count FROM cx_campaign WHERE status='active' ORDER BY next_send_at ASC LIMIT 200")
    .map(e => ({ id: e.client_id, attempt: (e.attempt_count || 0) + 1 }))
  if (!candidates.length) {
    const list = db.get("SELECT * FROM lists WHERE lower(name) LIKE '%cancelled%' OR lower(name) LIKE '%expired%' ORDER BY id LIMIT 1")
    let ids = []
    try { ids = JSON.parse(list?.client_ids || '[]') } catch {}
    candidates = ids.map(id => ({ id, attempt: 1 }))
  }
  const previews = [], skipped = []
  for (const cand of candidates) {
    if (previews.length >= limit) break
    const c = db.get('SELECT * FROM clients WHERE id=?', [cand.id])
    if (!c) continue
    const days = daysSinceOffMarket(c)
    const bucket = ageBucket(days)
    const street = streetOf(c)
    let body, angle
    if (cand.attempt === 1) { body = INITIAL[bucket](street, salutation()); angle = 'INTRO' }
    else if (cand.attempt === 2) { body = SECOND[bucket](street); angle = 'FOLLOW_UP' }
    else { angle = pickAngle(c.id, bucket); body = ANGLES[angle].text(street, bucket) }
    const ver = await evaluateEligibility(c, { atEnroll: cand.attempt === 1 })
    const row = {
      client_id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), phone: c.phone,
      off_market_date: c.off_market_date || null, days_off_market: days, age_bucket: bucket,
      attempt: cand.attempt, angle, message: body,
      would_send: ver.ok, blocked: ver.ok ? null : `${ver.code}: ${ver.detail}`,
    }
    if (ver.ok) previews.push(row)
    else skipped.push(row)
  }
  return { dry_run: true, note: 'Nothing was sent or written. Window/collision rules are re-checked again at real send time.', previews, skipped: skipped.slice(0, 25) }
}

// ---------- read model for the UI ----------
export function campaignState(clientId) {
  const en = db.get('SELECT * FROM cx_campaign WHERE client_id=?', [clientId])
  if (!en) return { enrolled: false }
  const c = db.get('SELECT off_market_date, address FROM clients WHERE id=?', [clientId])
  const days = daysSinceOffMarket(c || {})
  const log = db.all('SELECT * FROM cx_campaign_log WHERE client_id=? ORDER BY id DESC LIMIT 30', [clientId])
  return { enrolled: true, ...en, days_off_market: days, age_bucket: ageBucket(days), log }
}
export function campaignStats() {
  const by = (q, p = []) => { try { return db.all(q, p) } catch { return [] } }
  return {
    enabled: cxEnabled(),
    statuses: by('SELECT status, COUNT(*) n FROM cx_campaign GROUP BY status'),
    sent_total: db.get("SELECT COUNT(*) n FROM cx_campaign_log WHERE event='sent'")?.n || 0,
    responses: db.get("SELECT COUNT(*) n FROM cx_campaign_log WHERE event='response'")?.n || 0,
    by_angle: by("SELECT angle, COUNT(*) n FROM cx_campaign_log WHERE event='sent' GROUP BY angle ORDER BY n DESC"),
    by_bucket: by("SELECT age_bucket, COUNT(*) n FROM cx_campaign_log WHERE event='sent' GROUP BY age_bucket"),
    by_attempt_response: by(`SELECT s.message_number attempt, COUNT(*) n FROM cx_campaign_log r
      JOIN cx_campaign c2 ON c2.client_id=r.client_id
      JOIN cx_campaign_log s ON s.client_id=r.client_id AND s.event='sent' AND s.id=(SELECT MAX(id) FROM cx_campaign_log WHERE client_id=r.client_id AND event='sent' AND id<r.id)
      WHERE r.event='response' GROUP BY s.message_number`),
    suppressions: by("SELECT suppression_reason, COUNT(*) n FROM cx_campaign_log WHERE event IN ('suppressed','stopped') GROUP BY suppression_reason ORDER BY n DESC"),
    response_classes: by('SELECT response_class, COUNT(*) n FROM cx_campaign WHERE response_class IS NOT NULL GROUP BY response_class'),
  }
}
