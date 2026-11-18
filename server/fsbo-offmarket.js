// FSBO CONNECT - OFF MARKET
//
// A property that was advertised for sale by owner, is no longer advertised, and has no
// recorded sale. The job is to find out WHAT HAPPENED, not to win a listing.
//
//   NO RESPONSE -> a limited number of natural openings, then stop
//   RESPONSE    -> all automation stops, a person takes it
//
// WHY THIS IS NOT THE CANCELLED/EXPIRED CAMPAIGN (John's spec, 2026-11-18 §3)
// A cancelled or expired owner already tried an agent. A FSBO owner chose NOT to. So this
// library must never imply the attempt failed, that they priced it wrong, that they
// struggled, or that they need representation. The first question is simply whether it
// sold. Every message has to still read acceptably if the owner finds it six months later.
//
// THE HARD CAP IS THE POINT (§8). Cancelled/Expired runs weekly for ever, which is roughly
// 50 cold texts a year. This one stops after 8 unanswered sends and parks the lead in
// `exhausted`. Silence is not consent to unlimited outreach.
//
// REUSE, NOT A NEW ENGINE. Scheduling window, quiet hours, STOP/DNC/landline/holiday and
// collision checks all come from the modules the other campaigns already use and that are
// already tested. What is local to this file is the message library, the buckets, the
// cadence and the classifications - the four things §28 says a campaign should own so a
// FSBO ACTIVE campaign can later run on the same code with a different library.
import db from './database.js'
import { rule } from './rules.js'
import { inProactiveWindow, nextValidSlot } from './fsbo-followup.js'

const DAY = 86400000
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const nowIso = () => new Date().toISOString()

/** OFF until somebody turns it on. An accidental mass-text to 28 cold numbers is the one
 *  failure mode worth defaulting against. */
export function fsboOmEnabled() {
  try { return String(db.getSetting?.('fsbo_offmarket_enabled', '0')) === '1' } catch { return false }
}

export const MAX_ATTEMPTS = 8

const chi = (d = new Date()) => {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d)
  return { hour: Number(p.find(x => x.type === 'hour')?.value), weekday: p.find(x => x.type === 'weekday')?.value }
}

// §4. No after-4pm variant exists because nothing is scheduled after 4pm. If a send ever
// slips past the window the afternoon greeting is still true enough to go out.
function salutation() {
  return chi().hour < 12 ? 'Hi, good morning :)' : 'Hi, good afternoon :)'
}

// ---------- age buckets (§6) ----------
//
// WE DO NOT KNOW WHEN A FSBO CAME OFF MARKET, and the field that looks like it does is a
// trap. fsbo_status_at is written on EVERY master-file sync, not when the status changed,
// so every off-market FSBO reads as "today" and the whole pool would be bucketed `recent`.
// The first batch would have told 15 owners their listing came off the market today, some
// of whom listed in January.
//
// fsbo_dom is the honest signal. It is recomputed each sync as days since fsbo_list_date
// (checked: list 2026-02-18 + dom 273 = today; list 2026-08-17 + dom 93 = today), so it is
// the age of the LISTING, not of the disappearance. That is the better thing to bucket on
// anyway: a FSBO first advertised in January is an old situation whenever it vanished, and
// a FSBO advertised three weeks ago is a fresh one.
export function listingAgeDays(client) {
  // Number(null) is 0, and 0 is FINITE. Taking Number() straight off the field turns every
  // missing DOM into "nought days on market", which buckets as `recent` and tells the owner
  // their listing just came off - the precise mistake this function exists to prevent. The
  // CX module carries the same warning for the same reason. Unknown and zero must stay
  // distinguishable: zero is real (a listing pulled the day it went live).
  const raw = client?.fsbo_dom
  const dom = (raw === null || raw === undefined || String(raw).trim() === '') ? NaN : Number(raw)
  if (Number.isFinite(dom) && dom >= 0) return Math.floor(dom)
  // No DOM: derive it from the list date. fsbo_list_date arrives as M/D/YYYY.
  const t = Date.parse(client?.fsbo_list_date || '')
  if (!Number.isNaN(t)) return Math.max(0, Math.floor((Date.now() - t) / DAY))
  return null
}
/** The listing date, for display. Deliberately not called an off-market date: we do not
 *  have one, and naming it that is how the wrong field got used in the first place. */
export function listedDate(client) {
  const t = Date.parse(client?.fsbo_list_date || '')
  return Number.isNaN(t) ? null : new Date(t)
}
/** Unknown reads as OLD, never as recent: calling a year-old listing "recent" is the single
 *  most obvious tell that nobody actually looked. */
export function ageBucket(days) {
  if (days == null) return 'old'
  if (days <= 30) return 'recent'
  if (days <= 90) return 'mid'
  if (days <= 365) return 'old'
  return 'ancient'
}

// ---------- the approved library (§9, §10, §11) ----------
// Every message identifies John in full (§5). Never a bare "John with Matt Smith Team",
// which reads like an internal CRM note rather than a person introducing themselves.
const ID = 'This is John with Matt Smith Team at RE/MAX.'
const IDH = 'Hi, this is John with Matt Smith Team at RE/MAX.'

// John, 2026-11-18, on the first draft: "that does sound wrong... dont say been offered
// also we don't say all the time that it was for sale by owner, if we say for sale that's
// understandable."
//
// So: "was for sale", never "had previously been offered for sale by owner". The FSBO part
// is dropped from the wording entirely. It tells the owner nothing they do not know, and
// saying it back to them every time is what made these read like a database record rather
// than a person who noticed the house.
//
// "YOUR HOME AT X" IS DELIBERATE, and John's call (2026-11-18). The build spec's §4 warned
// that a FSBO number can come from skip tracing and may not reach the owner, which is why
// the first draft said "the home at X" and why the Cancelled/Expired library avoids "your
// home" entirely. He read that and chose the warmer wording for this campaign. Names are
// still never used: "your home at <address>" addresses the property, and anyone who is not
// the owner can see immediately that the text is not meant for them.
export const INTRO = {
  recent: (s, sal) => `${sal} ${ID} I came across your home at ${s} that was for sale recently and noticed it's no longer listed. Did you end up getting it sold? MattSmithTeam.com`,
  mid: (s, sal) => `${sal} ${ID} I came across your home at ${s} that was for sale a couple of months back and wasn't sure where things ended up. Did it ever sell? MattSmithTeam.com`,
  old: (s, sal) => `${sal} ${ID} I came across your home at ${s} that was for sale a while back and wasn't sure where things ended up. Did you ever get it sold? MattSmithTeam.com`,
  ancient: (s, sal) => `${sal} ${ID} I know it's been a long time, but I came across your home at ${s} that was for sale at one point. Did you ever end up selling it? MattSmithTeam.com`,
}

export const FOLLOW_UP = {
  recent: (s) => `Hi :) Just wanted to make sure you saw my message regarding ${s}. Is the property still available, or did you end up selling it?`,
  mid: (s) => `Hi :) Just wanted to make sure you saw my message regarding ${s}. I wasn't sure if the property sold or if plans simply changed.`,
  old: (s) => `Hi :) Just wanted to make sure you saw my message regarding ${s}. I wasn't sure if the property sold or if plans simply changed.`,
  ancient: (s) => `Hi :) Just wanted to make sure you saw my message regarding ${s}. I wasn't sure if the property sold or if plans simply changed.`,
}

export const ANGLES = {
  DID_IT_SELL: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} I wasn't sure where things ended up with ${s}. Did you ever get it sold?` },
  STILL_AVAILABLE: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Just checking back regarding ${s}. Is the property still something you'd consider selling?` },
  PLANS_CHANGED: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} I wasn't sure if plans changed with ${s} or if selling is still somewhere on the radar.` },
  HOLDING_PROPERTY: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Just wanted to check back regarding ${s}. Did you decide to hold onto the property for now?` },
  RIGHT_SITUATION: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Just curious about ${s}. If the right situation came along, would selling still be something you'd consider?` },
  SOLD_IT_YOURSELF: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Were you able to get ${s} sold on your own, or did you end up deciding to keep it?` },
  FUTURE_TIMING: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Is selling ${s} something that may come back up later, or are you planning to hold onto it for now?` },
  STILL_OPEN: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Just keeping an eye on ${s}. If selling is still something you'd consider at some point, feel free to let me know.` },
  RIGHT_OFFER: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} If the right offer came along for ${s}, would selling still be something you'd consider?` },
  LONG_TERM_CHECK: { buckets: ['old', 'ancient'], text: (s) => `${IDH} I know it's been a while since ${s} was for sale. Has selling it come back onto the radar at all?` },
  // §11: deliberately last, so the sequence ends by stepping back rather than pressing.
  OPEN_DOOR: { buckets: ['recent', 'mid', 'old', 'ancient'], text: (s) => `${IDH} Just keeping the door open regarding ${s}. If anything changes with the property, feel free to let me know.` },
}

export const ROTATION = ['DID_IT_SELL', 'STILL_AVAILABLE', 'PLANS_CHANGED', 'HOLDING_PROPERTY',
  'RIGHT_SITUATION', 'SOLD_IT_YOURSELF', 'FUTURE_TIMING', 'STILL_OPEN', 'RIGHT_OFFER',
  'LONG_TERM_CHECK', 'OPEN_DOOR']

/** Never the same angle twice inside 3 sends, and never one the bucket forbids. */
export function pickAngle(clientId, bucket) {
  const last3 = db.all(
    "SELECT angle FROM fsbo_om_log WHERE client_id=? AND event='sent' AND angle IS NOT NULL ORDER BY id DESC LIMIT 3",
    [clientId]).map(r => r.angle)
  const lastIdx = last3.length ? ROTATION.indexOf(last3[0]) : -1
  for (let i = 1; i <= ROTATION.length; i++) {
    const key = ROTATION[(lastIdx + i) % ROTATION.length]
    const a = ANGLES[key]
    if (!a || !a.buckets.includes(bucket)) continue
    if (last3.includes(key)) continue
    return key
  }
  // Everything suitable was used recently: take the oldest suitable one rather than repeat
  // the most recent.
  return ROTATION.find(k => ANGLES[k].buckets.includes(bucket)) || 'OPEN_DOOR'
}

// §12. Phrases that must never leave this campaign automatically. Asserted in tests against
// every rendered message, so a future edit cannot quietly reintroduce one.
export const BANNED = [
  /\bwe have (a )?buyers?\b/i, /\bbuyers? for your\b/i, /\bmore money\b/i,
  /\bwhy (didn'?t|couldn'?t) (it|you)\b/i, /\bwould you (list|consider hiring)\b/i,
  /\bspecialis?e in fsbo/i, /\bprofessional representation\b/i,
  /\b(over)?priced too high\b/i, /\byour (price|home) was\b/i, /\bready to list\b/i,
  /\bfailed to sell\b/i, /\bwe can sell it\b/i,
]

// ---------- cadence (§7) ----------
// Day 0, then 3-4 days, then 7-9 (so text 3 lands day 10-12), then every 14 days.
// Deliberately slower than Cancelled/Expired.
export function scheduleNext(attemptJustSent, from = new Date()) {
  const base = attemptJustSent === 1 ? 3 : attemptJustSent === 2 ? 7 : 14
  const jitter = attemptJustSent === 1 ? Math.round(Math.random())
    : attemptJustSent === 2 ? Math.floor(Math.random() * 3)
      : Math.floor(Math.random() * 3) - 1
  let d = new Date(from.getTime() + (base + jitter) * DAY)
  // The weekend shift only ever moves a send LATER.
  //
  // Cancelled/Expired resolves a Saturday to Friday or Monday at random, which can pull a
  // send forward and compress the gap below its intended minimum - a 3-day gap becoming 2.
  // For a campaign whose whole premise is being less aggressive than that one, a cadence
  // that can quietly tighten is the wrong failure. Saturday and Sunday both go to Monday.
  const wd = () => chi(d).weekday
  if (wd() === 'Sat') d = new Date(d.getTime() + 2 * DAY)
  else if (wd() === 'Sun') d = new Date(d.getTime() + DAY)
  const hour = 9 + Math.floor(Math.random() * 7)              // 9:00 - 15:59 Central
  d = new Date(d.getTime() + (hour - chi(d).hour) * 3600000)
  d = new Date(d.getTime() + (Math.floor(Math.random() * 60) - d.getUTCMinutes()) * 60000)
  return d
}

// ---------- response classification (§14) ----------
// Deterministic patterns, no model in the send path: the same inbound text always lands the
// same way, and nothing waits on an API while deciding whether to stop texting somebody.
// Order matters - the first match wins, so the most specific go first.
export const CLASS_RULES = [
  ['WRONG_NUMBER', /\bwrong (number|person)\b|don'?t know (this|that|the) (property|house|address)|not me\b|never owned/i],
  ['NOT_INTERESTED', /\bnot interested\b|stop contacting|don'?t contact me|leave me alone|take me off/i],
  ['SOLD', /\b(already )?sold\b|\bwe sold\b|\bit sold\b|closed on it|property sold/i],
  ['RENTED', /\brent(ed|ing)?\b|\btenant|leased it|as a rental/i],
  ['LISTED_WITH_AGENT', /(another|different|new|an|our) (agent|realtor|broker)|re-?listed|have an agent|working with (a|an) (agent|realtor)/i],
  ['SELLING_MYSELF', /\bsell(ing)? (it )?(myself|on my own)\b|no (agent|realtor)|fsbo only|don'?t want (a )?realtor|by owner/i],
  ['WOULD_SELL_FOR_PRICE', /\$\s?\d[\d,.]*\s?k?\b|\b\d{3}\s?k\b|anything over|would sell (at|for)|right (price|offer|number)/i],
  ['FUTURE_TIMEFRAME', /\b(next|this) (year|spring|summer|fall|winter)\b|in (a few|\d+) (months|years)|after (the )?(holidays|tenants?|renovation|lease)|later (this|next) year|down the road/i],
  ['HOLDING_PROPERTY', /\b(keep(ing)? it|hold(ing)? on(to)?|decided not to sell|staying|not selling)\b/i],
  ['STILL_AVAILABLE', /\bstill (available|for sale|selling)\b|^yes\b|yes.{0,15}(available|selling)/i],
]
export function classifyInbound(text) {
  const s = String(text || '').trim()
  if (!s) return 'UNCLEAR'
  for (const [label, re] of CLASS_RULES) if (re.test(s)) return label
  return 'NEEDS_HUMAN_REVIEW'
}

/** "$300k", "300,000", "over 425" -> 300000 / 425000. Returns null when nothing is readable;
 *  a wrong number here would be stored as a seller's real price expectation. */
export function parsePriceThreshold(text) {
  const s = String(text || '')
  let m = s.match(/\$?\s?(\d{1,3})\s?[kK]\b/)
  if (m) return Number(m[1]) * 1000
  m = s.match(/\$\s?(\d{1,3}(?:,\d{3})+)/)
  if (m) return Number(m[1].replace(/,/g, ''))
  m = s.match(/\$\s?(\d{4,7})\b/)
  if (m) return Number(m[1])
  m = s.match(/\b(?:over|above|at least|around)\s+(\d{3})\b/i)   // "over 300" meaning 300k
  if (m) return Number(m[1]) * 1000
  return null
}

/** Where a classification leaves the campaign (§14, §21). */
export const CLASS_OUTCOME = {
  SOLD: { status: 'sold', terminal: true },
  RENTED: { status: 'rented', terminal: true },
  LISTED_WITH_AGENT: { status: 'listed_with_agent', terminal: true },
  HOLDING_PROPERTY: { status: 'holding', terminal: true },
  FUTURE_TIMEFRAME: { status: 'future_timing', terminal: true },
  // NOT marked not-interested: choosing to sell without an agent is a decision to respect,
  // not a rejection. They may still sell, and a person should pick it up from here.
  SELLING_MYSELF: { status: 'selling_myself', terminal: true },
  WOULD_SELL_FOR_PRICE: { status: 'price_trigger', terminal: true },
  STILL_AVAILABLE: { status: 'response_received', terminal: true, priority: true },
  NOT_INTERESTED: { status: 'not_interested', terminal: true },
  WRONG_NUMBER: { status: 'wrong_number', terminal: true },
  NEEDS_HUMAN_REVIEW: { status: 'response_received', terminal: true },
  UNCLEAR: { status: 'response_received', terminal: true },
}

// ---------- logging (§22) ----------
export function logOm(clientId, event, fields = {}) {
  try {
    db.run(`INSERT INTO fsbo_om_log (client_id, event, attempt, angle, template_key, age_bucket,
              days_off_market, eligibility_result, stop_reason, defer_reason, response_class,
              phone, comm_id, body, scheduled_for, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [clientId, event, fields.attempt ?? null, fields.angle ?? null, fields.template_key ?? null,
        fields.age_bucket ?? null, fields.days_off_market ?? null, fields.eligibility_result ?? null,
        fields.stop_reason ?? null, fields.defer_reason ?? null, fields.response_class ?? null,
        fields.phone ?? null, fields.comm_id ?? null, fields.body ?? null, fields.scheduled_for ?? null,
        nowIso()])
  } catch { /* the audit trail must never break a send decision */ }
}

const streetOf = (c) => String(c?.address || '').trim().split(',')[0].trim() || 'the property'

// ---------- duplicate protection (§26) ----------
// Only ONE seller acquisition campaign may own outbound texting for a person at a time, and
// this one sits below the others in priority. Checked at enrollment AND at send time,
// because another campaign can claim the lead after this one enrolled them.
export function ownedElsewhere(clientId) {
  try {
    const ai = db.get('SELECT ai_managed FROM ai_lead_state WHERE client_id=?', [clientId])
    if (ai && ai.ai_managed === 1) return 'HUB AI manages this lead'
  } catch {}
  try {
    const f = db.get("SELECT status FROM fsbo_followups WHERE client_id=? AND status='active'", [clientId])
    if (f) return 'the active FSBO sequence owns this lead'
  } catch {}
  try {
    const cx = db.get("SELECT status FROM cx_campaign WHERE client_id=? AND status='active'", [clientId])
    if (cx) return 'the Cancelled/Expired campaign owns this lead'
  } catch {}
  return null
}

// ---------- history (§14 PRIOR_RESPONSE, §18) ----------
// Any meaningful thing this person has ever said back. A reply from a number no longer on
// the record is ignored: that verdict belonged to the NUMBER, and a corrected phone should
// not stay blocked by it.
export function historyBlock(client) {
  const d10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)
  const current = new Set([client.phone, ...String(client.alt_phones || '').split(',')]
    .map(d10).filter(s => s.length === 10))
  let rows = []
  try {
    rows = db.all(`SELECT channel, body, preview, transcript, from_addr FROM communications
      WHERE client_id=? AND direction='incoming' AND channel IN ('text','email','call','voicemail')
      ORDER BY occurred_at DESC LIMIT 200`, [client.id])
  } catch { return null }
  let meaningful = false
  for (const m of rows) {
    if (['text', 'call', 'voicemail'].includes(m.channel) && current.size) {
      const from = d10(m.from_addr)
      if (from.length === 10 && !current.has(from)) continue
    }
    const text = [m.body, m.preview, m.transcript].filter(Boolean).join(' ').trim()
    if (text) meaningful = true
    const cls = classifyInbound(text)
    if (['WRONG_NUMBER', 'SOLD', 'RENTED', 'LISTED_WITH_AGENT', 'HOLDING_PROPERTY',
      'NOT_INTERESTED', 'SELLING_MYSELF'].includes(cls)) return { code: cls, detail: text.slice(0, 160) }
    if (cls === 'FUTURE_TIMEFRAME') return { code: 'FUTURE_TIMEFRAME', detail: text.slice(0, 160) }
  }
  if (meaningful) return { code: 'PRIOR_RESPONSE', detail: 'lead has replied before - a person owns this, not automation' }
  return null
}

// ---------- eligibility (§2, §18, §19) ----------
// Run at enrollment AND before EVERY send. terminal:true stops the campaign; terminal:false
// defers and keeps the lead enrolled.
export async function evaluateEligibility(client, { atEnroll = false, manual = false } = {}) {
  if (!client) return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'client not found' }
  if (client.merged_into) return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'merged into another record' }

  const phone = String(client.phone || '').replace(/\D/g, '')
  if (phone.length < 10) return { ok: false, terminal: true, code: 'WRONG_NUMBER', detail: 'no usable phone number' }
  // Every message is built around the address. Without one the text is meaningless.
  if (!String(client.address || '').trim()) return { ok: false, terminal: true, code: 'NO_ADDRESS', detail: 'no property address on file' }

  // §2: it has to actually be an off-market FSBO.
  const fs = String(client.fsbo_status || '').toLowerCase()
  if (!fs) return { ok: false, terminal: true, code: 'NOT_FSBO', detail: 'no FSBO status on this lead' }
  if (/sold/.test(fs)) return { ok: false, terminal: true, code: 'SOLD', detail: `FSBO status ${client.fsbo_status}` }
  if (/pending/.test(fs)) return { ok: false, terminal: true, code: 'PENDING', detail: `FSBO status ${client.fsbo_status}` }
  if (/available/.test(fs)) return { ok: false, terminal: true, code: 'FSBO_ACTIVE', detail: 'still advertised by owner - that is the FSBO Active campaign' }
  if (/disregard/.test(fs)) return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'marked Disregard on the FSBO master file' }
  if (client.fsbo_excluded) return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'manually excluded from FSBO' }

  // The MLS overrides the FSBO sheet: if it is listed, pending or sold there, stop.
  const mls = String(client.mls_status || '').toLowerCase()
  if (/sold|closed/.test(mls)) return { ok: false, terminal: true, code: 'SOLD', detail: `MLS status ${client.mls_status}` }
  if (/pending|contingent/.test(mls)) return { ok: false, terminal: true, code: 'PENDING', detail: `MLS status ${client.mls_status}` }
  if (/active/.test(mls)) return { ok: false, terminal: true, code: 'LISTED_WITH_AGENT', detail: `MLS status ${client.mls_status} - listed with an agent` }

  const status = String(client.status || '').toLowerCase()
  if (status === 'junk') return { ok: false, terminal: true, code: 'HUMAN_REMOVED', detail: 'lead junked' }
  if (['closed', 'pending', 'donotcontact', 'archived', 'trash'].includes(status)) {
    return { ok: false, terminal: true, code: 'OTHER_WORKFLOW', detail: `lead status ${client.status}` }
  }
  // §2: Not In Market is only overridden by a human re-enrolling by hand.
  if (status === 'not_in_market' && !manual) {
    return { ok: false, terminal: true, code: 'FUTURE_TIMEFRAME', detail: 'lead is Not In Market' }
  }
  if (client.hub_text_opt_out) return { ok: false, terminal: true, code: 'DNC', detail: 'replied STOP to our number' }
  // A manual enroll is a human saying "I have a good number now", so it forgives a stored
  // undeliverable verdict. Nothing else about the lead is forgiven.
  if (client.sms_undeliverable && !manual) {
    return { ok: false, terminal: true, code: 'WRONG_NUMBER', detail: client.sms_undeliverable_reason || 'number undeliverable (likely landline)' }
  }

  const owner = ownedElsewhere(client.id)
  if (owner) return { ok: false, terminal: true, code: 'OTHER_WORKFLOW', detail: owner }

  const hist = historyBlock(client)
  if (hist && !(manual && hist.code === 'WRONG_NUMBER')) {
    return { ok: false, terminal: true, code: hist.code, detail: hist.detail }
  }

  if (atEnroll) return { ok: true }

  // ---- send-time only ----
  const en = db.get('SELECT attempt_count FROM fsbo_om_campaign WHERE client_id=?', [client.id])
  if ((en?.attempt_count || 0) >= MAX_ATTEMPTS) {
    return { ok: false, terminal: true, code: 'EXHAUSTED', detail: `${MAX_ATTEMPTS} unanswered texts` }
  }

  // §16. Automation never talks over a person. Only HUMAN outreach defers - the campaign's
  // own sends are excluded, or it would permanently defer itself.
  const manualTouch = db.get(`SELECT occurred_at FROM communications WHERE client_id=? AND direction='outgoing'
    AND (sent_by_type IS NULL OR sent_by_type NOT IN ('ai','fsbo_ai','automation','system','cx_connect','drip','fsbo_offmarket'))
    AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1`, [client.id, new Date(Date.now() - 3 * DAY).toISOString()])
  if (manualTouch) return { ok: false, terminal: false, code: 'RECENT_MANUAL_CONTACT', detail: `manual outreach ${manualTouch.occurred_at}` }

  // §17. An inbound message in the last 24h means a live conversation; stay out of it.
  const liveInbound = db.get(`SELECT occurred_at FROM communications WHERE client_id=? AND direction='incoming'
    AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1`, [client.id, new Date(Date.now() - DAY).toISOString()])
  if (liveInbound) return { ok: false, terminal: false, code: 'LIVE_CONVERSATION', detail: `inbound ${liveInbound.occurred_at}` }

  // The shared compliance gate: STOP, opt-out, quiet hours, holiday, dedup, collisions.
  const { canAutomatedSend } = await import('./ai-followup/policy.js')
  const gate = canAutomatedSend(client, { source: 'drip', dedupMinutes: 20 * 60 })
  if (!gate.ok) {
    const terminal = /STOP|opted out|do_not_text|blocked|status/i.test(gate.reason)
    return { ok: false, terminal, code: terminal ? 'DNC' : 'COLLISION', detail: gate.reason }
  }
  return { ok: true }
}

// ---------- enrollment ----------
export async function enrollClient(clientId, by = 'auto') {
  const c = db.get('SELECT * FROM clients WHERE id=?', [Number(clientId)])
  if (!c) return { ok: false, reason: 'client not found' }
  const existing = db.get('SELECT * FROM fsbo_om_campaign WHERE client_id=?', [c.id])
  if (existing && ['active', 'response_received'].includes(existing.status)) {
    return { ok: false, reason: `already ${existing.status}` }
  }
  const manual = by !== 'auto'
  // §25: a manual restart is refused for the outcomes that must never be reopened.
  if (existing && ['dnc', 'not_interested', 'listed_with_agent', 'sold'].includes(existing.status) && manual) {
    return { ok: false, reason: `cannot restart a lead marked ${existing.status}` }
  }
  const ev = await evaluateEligibility(c, { atEnroll: true, manual })
  if (!ev.ok) { logOm(c.id, 'enroll_refused', { eligibility_result: ev.code, stop_reason: ev.detail }); return { ok: false, reason: `${ev.code}: ${ev.detail}` } }

  const days = listingAgeDays(c)
  const first = nextValidSlot(new Date(Date.now() + 60000)).toISOString()
  db.run(`INSERT INTO fsbo_om_campaign (client_id, status, attempt_count, enrolled_at, enrolled_by,
            next_send_at, age_bucket_at_enroll, off_market_date, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(client_id) DO UPDATE SET status='active', attempt_count=0, enrolled_at=excluded.enrolled_at,
            enrolled_by=excluded.enrolled_by, next_send_at=excluded.next_send_at, stop_reason=NULL,
            response_class=NULL, responded_at=NULL, updated_at=excluded.updated_at`,
    [c.id, 'active', 0, nowIso(), by, first, ageBucket(days), listedDate(c)?.toISOString() || null, nowIso()])
  logOm(c.id, 'enrolled', { age_bucket: ageBucket(days), days_off_market: days, scheduled_for: first, eligibility_result: 'ok' })
  return { ok: true, client_id: c.id, next_send_at: first }
}

/** Everyone the campaign would take, without enrolling anybody. */
export function eligiblePool() {
  return db.all(`SELECT * FROM clients
     WHERE merged_into IS NULL
       AND lower(COALESCE(fsbo_status,'')) = 'off market'
       AND COALESCE(fsbo_excluded,0) = 0
       AND phone IS NOT NULL AND phone != ''
       AND address IS NOT NULL AND address != ''`)
}

export async function bulkEnroll() {
  const out = { enrolled: [], skipped: [] }
  for (const c of eligiblePool()) {
    const r = await enrollClient(c.id, 'auto')
    if (r.ok) out.enrolled.push(c.id); else out.skipped.push({ id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), reason: r.reason })
  }
  return { ok: true, enrolled: out.enrolled.length, skipped: out.skipped }
}

// ---------- composing ----------
export function composeFor(client, attempt, bucket) {
  const s = streetOf(client)
  if (attempt === 1) return { body: INTRO[bucket](s, salutation()), angle: 'INTRO', templateKey: `intro_${bucket}` }
  if (attempt === 2) return { body: FOLLOW_UP[bucket](s), angle: 'FOLLOW_UP', templateKey: `followup_${bucket}` }
  const angle = pickAngle(client.id, bucket)
  return { body: ANGLES[angle].text(s), angle, templateKey: `angle_${angle}_${bucket}` }
}

// ---------- the sweep ----------
export async function runSweep({ limit = 25, dryRun = false } = {}) {
  if (!fsboOmEnabled()) return { skipped: 'disabled' }
  const due = db.all(`SELECT * FROM fsbo_om_campaign WHERE status='active' AND next_send_at IS NOT NULL
                        AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT ?`, [nowIso(), limit])
  const out = { considered: due.length, sent: 0, deferred: 0, stopped: 0, exhausted: 0, results: [] }
  for (const en of due) {
    const c = db.get('SELECT * FROM clients WHERE id=?', [en.client_id])
    const days = listingAgeDays(c)
    const bucket = ageBucket(days)
    const attempt = (en.attempt_count || 0) + 1

    const ev = await evaluateEligibility(c, {})
    if (!ev.ok) {
      if (ev.terminal) {
        const status = ev.code === 'EXHAUSTED' ? 'exhausted' : (CLASS_OUTCOME[ev.code]?.status || 'human_removed')
        if (!dryRun) {
          db.run("UPDATE fsbo_om_campaign SET status=?, next_send_at=NULL, stop_reason=?, updated_at=? WHERE client_id=?",
            [status, `${ev.code}: ${ev.detail}`.slice(0, 250), nowIso(), en.client_id])
          // §8: an exhausted lead is parked on Watch, never deleted.
          if (ev.code === 'EXHAUSTED') parkOnWatch(c)
          logOm(en.client_id, ev.code === 'EXHAUSTED' ? 'exhausted' : 'stopped',
            { attempt, age_bucket: bucket, days_off_market: days, eligibility_result: ev.code, stop_reason: ev.detail })
        }
        ev.code === 'EXHAUSTED' ? out.exhausted++ : out.stopped++
      } else {
        const push = nextValidSlot(new Date(Date.now() + (ev.code === 'RECENT_MANUAL_CONTACT' ? 3 : 1) * DAY)).toISOString()
        if (!dryRun) {
          db.run('UPDATE fsbo_om_campaign SET next_send_at=?, updated_at=? WHERE client_id=?', [push, nowIso(), en.client_id])
          logOm(en.client_id, 'deferred', { attempt, age_bucket: bucket, defer_reason: `${ev.code}: ${ev.detail}`, scheduled_for: push })
        }
        out.deferred++
      }
      out.results.push({ client_id: en.client_id, action: ev.terminal ? 'stopped' : 'deferred', code: ev.code })
      continue
    }

    const { body, angle, templateKey } = composeFor(c, attempt, bucket)
    if (dryRun) { out.results.push({ client_id: en.client_id, action: 'would_send', attempt, angle, body }); continue }

    try {
      const { sendSms } = await import('./twilio.js')
      const r = await sendSms(c.phone, body, { statusCallback: HUB + '/api/inbox/twilio-status' })
      const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
      const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr,
                 preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['text', 'outgoing', c.id, name, r.from || '', c.phone, body.replace(/\s+/g, ' ').slice(0, 160), body,
          'twilio_' + r.sid, `c${c.id}_text`, 'read', r.status || 'queued', 'FSBO Off Market', 'fsbo_offmarket', nowIso()])
      const exhausted = attempt >= MAX_ATTEMPTS
      const next = exhausted ? null : scheduleNext(attempt).toISOString()
      db.run(`UPDATE fsbo_om_campaign SET attempt_count=?, last_sent_at=?, last_angle=?, next_send_at=?,
                status=?, updated_at=? WHERE client_id=?`,
        [attempt, nowIso(), angle, next, exhausted ? 'exhausted' : 'active', nowIso(), en.client_id])
      if (exhausted) { parkOnWatch(c); logOm(en.client_id, 'exhausted', { attempt, stop_reason: `${MAX_ATTEMPTS} unanswered texts` }); out.exhausted++ }
      logOm(en.client_id, 'sent', { attempt, angle, template_key: templateKey, age_bucket: bucket,
        days_off_market: days, phone: c.phone, comm_id: ins.lastInsertRowid, body, scheduled_for: next, eligibility_result: 'ok' })
      out.sent++
      out.results.push({ client_id: en.client_id, action: 'sent', attempt, angle })
    } catch (e) {
      // §19: a provider failure defers, it never ends the campaign.
      const push = nextValidSlot(new Date(Date.now() + DAY)).toISOString()
      db.run('UPDATE fsbo_om_campaign SET next_send_at=?, updated_at=? WHERE client_id=?', [push, nowIso(), en.client_id])
      logOm(en.client_id, 'send_failed', { attempt, defer_reason: e.message, scheduled_for: push })
      out.deferred++
      out.results.push({ client_id: en.client_id, action: 'send_failed', error: e.message })
    }
  }
  return out
}

/** §8: exhausted means stop texting, not forget. The lead stays on Watch for a person. */
function parkOnWatch(c) {
  try {
    const s = String(c?.status || '').toLowerCase()
    if (c && ['new', 'active', 'qualify'].includes(s)) {
      db.run("UPDATE clients SET status='watch', updated_at=datetime('now') WHERE id=?", [c.id])
    }
  } catch {}
}

// ---------- inbound (§13) ----------
export function handleInbound(clientId, body, commId = null) {
  let en
  try { en = db.get('SELECT * FROM fsbo_om_campaign WHERE client_id=?', [clientId]) } catch { return false }
  if (!en) return false
  if (en.status === 'active') {
    const cls = classifyInbound(body)
    const outcome = CLASS_OUTCOME[cls] || { status: 'response_received' }
    const price = cls === 'WOULD_SELL_FOR_PRICE' ? parsePriceThreshold(body) : null
    db.run(`UPDATE fsbo_om_campaign SET status=?, next_send_at=NULL, response_class=?, responded_at=?,
              response_comm_id=?, seller_price_threshold=?, updated_at=? WHERE client_id=?`,
      [outcome.status, cls, nowIso(), commId, price, nowIso(), clientId])
    try {
      db.run("UPDATE scheduled_texts SET status='canceled', error='canceled: lead responded (FSBO Off Market)' WHERE client_id=? AND status='scheduled' AND created_by='fsbo_offmarket'", [clientId])
    } catch {}
    logOm(clientId, 'response', { response_class: cls, comm_id: commId, body, stop_reason: outcome.status })
    const c = db.get('SELECT * FROM clients WHERE id=?', [clientId])
    flagHuman(c, cls, body, price)
  }
  // Whatever the status: the AI never answers these leads.
  return true
}

function flagHuman(c, cls, detail, price) {
  if (!c) return
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || `Lead ${c.id}`
  const extra = price ? ` (would sell around $${price.toLocaleString()})` : ''
  try {
    import('./notifications.js').then(m => m.notify({
      type: 'fsbo_om_response',
      title: `RESPONSE - ${name} (FSBO Off Market)`,
      body: `${cls}${extra}: ${String(detail || '').slice(0, 200)}`,
      client_id: c.id,
    })).catch(() => {})
  } catch {}
  try {
    db.run(`INSERT INTO tasks (title, notes, status, priority, client_id, due_date, created_at)
            VALUES (?,?,?,?,?,?,?)`,
      [`FSBO Off Market reply: ${name}`,
        `Classified ${cls}${extra}. They said: "${String(detail || '').slice(0, 300)}"\nAutomation has stopped. A person owns this now.`,
        'todo', cls === 'STILL_AVAILABLE' || cls === 'WOULD_SELL_FOR_PRICE' ? 'high' : 'medium',
        c.id, new Date().toISOString().slice(0, 10), nowIso()])
  } catch {}
}

export function isEnrolled(clientId) {
  try { return !!db.get('SELECT client_id FROM fsbo_om_campaign WHERE client_id=?', [clientId]) } catch { return false }
}

// ---------- reporting (§20, §23, §24) ----------
export function stats() {
  const one = (sql, p = []) => { try { return db.get(sql, p) } catch { return null } }
  const all = (sql, p = []) => { try { return db.all(sql, p) } catch { return [] } }
  return {
    enabled: fsboOmEnabled(),
    max_attempts: MAX_ATTEMPTS,
    pool: eligiblePool().length,
    by_status: all('SELECT status, COUNT(*) n FROM fsbo_om_campaign GROUP BY status ORDER BY n DESC'),
    by_attempt: all("SELECT attempt_count a, COUNT(*) n FROM fsbo_om_campaign WHERE status='active' GROUP BY a ORDER BY a"),
    sent_total: one("SELECT COUNT(*) n FROM fsbo_om_log WHERE event='sent'")?.n || 0,
    sent_7d: one("SELECT COUNT(*) n FROM fsbo_om_log WHERE event='sent' AND created_at >= datetime('now','-7 day')")?.n || 0,
    responses: one("SELECT COUNT(*) n FROM fsbo_om_log WHERE event='response'")?.n || 0,
    responses_by_class: all("SELECT response_class c, COUNT(*) n FROM fsbo_om_log WHERE event='response' GROUP BY c ORDER BY n DESC"),
    responses_by_attempt: all(`SELECT l.attempt a, COUNT(*) n FROM fsbo_om_log l WHERE l.event='response' GROUP BY a ORDER BY a`),
    exhausted: one("SELECT COUNT(*) n FROM fsbo_om_campaign WHERE status='exhausted'")?.n || 0,
    due_now: one("SELECT COUNT(*) n FROM fsbo_om_campaign WHERE status='active' AND next_send_at <= ?", [nowIso()])?.n || 0,
  }
}

/** §24: which angle actually produces a seller conversation, not just a reply. A message
 *  that makes people angry is not a success because they answered it. */
export function anglePerformance() {
  const sent = db.all("SELECT angle, COUNT(*) n FROM fsbo_om_log WHERE event='sent' AND angle IS NOT NULL GROUP BY angle")
  const out = []
  for (const s of sent) {
    // The reply that followed this angle is the next response row for that lead.
    const rows = db.all(`SELECT r.response_class c, COUNT(*) n FROM fsbo_om_log x
       JOIN fsbo_om_log r ON r.client_id = x.client_id AND r.event='response' AND r.id > x.id
       WHERE x.event='sent' AND x.angle = ? GROUP BY c`, [s.angle])
    const total = rows.reduce((n, r) => n + r.n, 0)
    const positive = rows.filter(r => ['STILL_AVAILABLE', 'WOULD_SELL_FOR_PRICE', 'FUTURE_TIMEFRAME'].includes(r.c)).reduce((n, r) => n + r.n, 0)
    const negative = rows.filter(r => ['NOT_INTERESTED', 'WRONG_NUMBER'].includes(r.c)).reduce((n, r) => n + r.n, 0)
    out.push({
      angle: s.angle, sent: s.n, responses: total,
      response_pct: s.n ? Math.round(total / s.n * 100) : 0,
      opportunity: positive, opportunity_pct: s.n ? Math.round(positive / s.n * 100) : 0,
      negative,
      by_class: Object.fromEntries(rows.map(r => [r.c, r.n])),
    })
  }
  return out.sort((a, b) => b.opportunity_pct - a.opportunity_pct)
}

/** Everything §20 asks to see per enrolled lead. */
export function board() {
  return db.all(`SELECT e.*, c.first_name, c.last_name, c.address, c.phone, c.status AS lead_status,
                        c.fsbo_status, c.fsbo_status_at, c.mls_status
                   FROM fsbo_om_campaign e JOIN clients c ON c.id = e.client_id
                  ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, e.next_send_at ASC`)
    .map(r => {
      const days = listingAgeDays(r)
      const prior = db.all("SELECT angle FROM fsbo_om_log WHERE client_id=? AND event='sent' AND angle IS NOT NULL ORDER BY id DESC LIMIT 4", [r.client_id]).map(x => x.angle)
      const lastMsg = db.get("SELECT body, created_at FROM fsbo_om_log WHERE client_id=? AND event='sent' ORDER BY id DESC LIMIT 1", [r.client_id])
      const manual = db.get(`SELECT occurred_at FROM communications WHERE client_id=? AND direction='outgoing'
          AND (sent_by_type IS NULL OR sent_by_type NOT IN ('ai','fsbo_ai','automation','system','cx_connect','drip','fsbo_offmarket'))
          ORDER BY occurred_at DESC LIMIT 1`, [r.client_id])
      return {
        client_id: r.client_id,
        name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        address: r.address, phone: r.phone,
        campaign_status: r.status,
        age_bucket: ageBucket(days), listing_age_days: days, listed_date: r.off_market_date,
        sends: r.attempt_count || 0, of_max: MAX_ATTEMPTS,
        last_message: lastMsg?.body || null, last_sent_at: r.last_sent_at,
        next_send_at: r.next_send_at,
        last_angle: r.last_angle, prior_angles: prior.slice(1, 4),
        response_class: r.response_class, responded_at: r.responded_at,
        seller_price_threshold: r.seller_price_threshold,
        last_manual_contact: manual?.occurred_at || null,
        stop_reason: r.stop_reason,
      }
    })
}

export function pause(clientId, by = 'agent') {
  db.run("UPDATE fsbo_om_campaign SET status='deferred', next_send_at=NULL, paused_by=?, paused_at=?, updated_at=? WHERE client_id=?",
    [by, nowIso(), nowIso(), Number(clientId)])
  logOm(Number(clientId), 'paused', { stop_reason: `paused by ${by}` })
  return { ok: true }
}
export function resume(clientId, by = 'agent') {
  const next = nextValidSlot(new Date(Date.now() + 60000)).toISOString()
  db.run("UPDATE fsbo_om_campaign SET status='active', paused_by=NULL, paused_at=NULL, next_send_at=?, updated_at=? WHERE client_id=?",
    [next, nowIso(), Number(clientId)])
  logOm(Number(clientId), 'resumed', { scheduled_for: next, eligibility_result: `resumed by ${by}` })
  return { ok: true, next_send_at: next }
}
export function remove(clientId, by = 'agent', reason = '') {
  db.run("UPDATE fsbo_om_campaign SET status='human_removed', next_send_at=NULL, stop_reason=?, removed_by=?, removed_at=?, updated_at=? WHERE client_id=?",
    [`removed by ${by}: ${reason}`.slice(0, 250), by, nowIso(), nowIso(), Number(clientId)])
  logOm(Number(clientId), 'removed', { stop_reason: reason || `removed by ${by}` })
  return { ok: true }
}
