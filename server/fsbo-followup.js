// FSBO AUTOMATIC TEXT FOLLOW-UP CAMPAIGN.
//
// Evolution of the original FSBO smart follow-up sequence into a persistent campaign
// (same doctrine as CX Connect): NO ELIGIBLE FSBO SHOULD REACH 14 DAYS ON MARKET AND
// THEN GET FORGOTTEN.
//
//   - AUTO-ENROLL when the listing's LIVE DOM reaches the threshold (default 14).
//     DOM is the authoritative listing DOM from the FSBO master sync (computed from
//     List Date daily), NOT "days since the Hub first saw the lead" — a property
//     imported at DOM 27 qualifies immediately.
//   - Opening cadence keeps the team's approved copy: availability check → (+7d)
//     still-available check → (+7d) the 35-years / first-14-days message — then a
//     low-pressure availability-only rotation every 40+ days while the listing stays
//     Available. Persistence ≠ pressure: text ten reads like text one.
//   - Eligibility is re-verified before EVERY send (Available? still FSBO? no STOP?
//     no response? no recent human contact? not paused/removed?).
//   - An inbound reply does NOT stop the campaign (John, 2026-10-20, reversing his
//     2026-09-14 rule): it is recorded, a high-priority FSBO Response task is created
//     and the team notified, and the schedule carries on untouched. NO automated
//     replies of any kind — every response is answered personally. The campaign ends
//     only on a manual pause/remove, an explicit STOP, or a DISQUALIFYING_REPLY
//     (wrong number, sold, rented, listed with an agent, holding, not interested).
//   - Off Market / sold / agent-listed / master-file removal stop future sends;
//     HISTORY IS PERMANENT (fsbo_campaign_log, communications, listing history).
//   - Manual pause/remove always wins; sweeps never silently resume or re-enroll.
//   - Sends only weekdays 9AM-4PM Central, trickled 1-2.5 min apart, through the
//     central policy + collision gates. Identity safety: "the home at {address}",
//     no first names in cold prospecting.
//
// Master switch: fsbo_followup_enabled (OFF by default — ships off).
import db from './database.js'
import { rule } from './rules.js'
import { automationTasksEnabled } from './automation-tasks.js'

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const DAY = 86400000

export function fsboEnabled() { return db.getSetting?.('fsbo_followup_enabled') === '1' }   // OFF until explicitly turned on (prevents an accidental mass-text)
export function fsboDomThreshold() { return rule('fsbo_campaign_dom_threshold') }

// Central-time parts.
function chi(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (t) => p.find(x => x.type === t)?.value
  return { weekday: g('weekday'), hour: Number(g('hour')) === 24 ? 0 : Number(g('hour')), minute: Number(g('minute')) }
}
// THE OUTBOUND TEXTING WINDOW. Weekdays only, 9AM until this hour, Central.
//
// Widened from 4PM to 5PM (John, 2026-10-15: "adjust texting time until 5PM"). One
// constant rather than a 16 repeated in four places, because the window is also used by
// the greeting ("Good afternoon" vs "Hello") and by AI auto-enrolment, and those drifting
// apart is how a lead gets a "Good afternoon" at 4:45 from one system and nothing from
// another.
// Read from the rules registry so the window can be changed without a deploy. The
// registry clamps it to 8am-7pm whatever is stored, so no setting can push a text outside
// daylight. Defaults are 9 and 17, which is what was hardcoded here before.
export const proactiveStartHour = () => rule('proactive_start_hour')
export const proactiveEndHour = () => rule('proactive_end_hour')
// Kept as a getter-backed export because ai-enrollment.js imports it by name.
export const PROACTIVE_END_HOUR = 17   // historical default; call proactiveEndHour() for the live value

export function inProactiveWindow(d = new Date()) {
  const c = chi(d)
  if (['Sat', 'Sun'].includes(c.weekday)) return false
  return c.hour >= proactiveStartHour() && c.hour < proactiveEndHour()
}
// Greeting: never "evening" (we don't text then). At 5PM+ just "Hello".
function greeting() { const h = chi().hour; return h < 12 ? 'Good morning' : h < proactiveEndHour() ? 'Good afternoon' : 'Hello' }
const dom = (c) => { const n = parseInt(String(c?.fsbo_dom || '').replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n }
const daysSince = (ts) => ts ? (Date.now() - new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z')).getTime()) / 86400000 : 999
const phone10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null }

// Next valid send slot at/after `from`: weekdays 9AM-5PM CT. Saturday rolls Mon,
// Sunday rolls Mon, after-5PM rolls to next weekday morning at a random 9-11 time.
export function nextValidSlot(from = new Date()) {
  let d = new Date(from)
  for (let i = 0; i < 10; i++) {
    const c = chi(d)
    if (c.weekday === 'Sat') { d = new Date(d.getTime() + 2 * DAY) }
    else if (c.weekday === 'Sun') { d = new Date(d.getTime() + DAY) }
    else if (c.hour < proactiveStartHour()) { d = new Date(d.getTime() + (proactiveStartHour() - c.hour) * 3600000) ; continue }
    else if (c.hour >= proactiveEndHour()) { d = new Date(d.getTime() + (24 - c.hour + proactiveStartHour()) * 3600000); continue }
    else return d
    // rolled a day: land at a random morning slot 9-11 CT
    const c2 = chi(d)
    d = new Date(d.getTime() + (9 + Math.floor(Math.random() * 3) - c2.hour) * 3600000)
  }
  return d
}
// Next touch after attempt N just sent: +7d flat after attempts 1 and 2 (the approved
// opening cadence), then an availability check every 30 days or so for as long as the
// listing stays Available.
//
// Was 40-47 days. John, 2026-10-15: "after 30 days should reach out to ask if it's still
// available". The 3-day jitter stays so a batch of leads enrolled on the same day does not
// text them all on the same day a month later.
export function scheduleNextFsbo(attemptJustSent, from = new Date()) {
  const baseDays = attemptJustSent <= 2 ? 7 : rule('fsbo_availability_days') + Math.floor(Math.random() * 4)
  let d = new Date(from.getTime() + baseDays * DAY)
  const wd = () => chi(d).weekday
  if (wd() === 'Sat') d = new Date(d.getTime() + (Math.random() < 0.5 ? -DAY : 2 * DAY))
  else if (wd() === 'Sun') d = new Date(d.getTime() + DAY)
  const targetHour = 9 + Math.floor(Math.random() * 7)   // 9AM-3PM start
  d = new Date(d.getTime() + (targetHour - chi(d).hour) * 3600000)
  d.setMinutes(Math.floor(Math.random() * 60), 0, 0)
  return d
}

// ---- approved message library ----
// Identity safety: cold texts reference "the home at {street}" / the address — never
// "your home" until they establish ownership, and no first names in cold prospecting
// (the still-available Text 2 copy is the one historical exception, kept as approved).
function street(c) { return c.address || 'the property' }
function msgStep1(c) { return `${greeting()}, I'm John with Matt Smith Team at RE/MAX. Our team noticed your place on ${street(c)} for sale, beautiful home. Just want to make sure it's still available? MattSmithTeam.com` }
// The market-analysis message (sent as Text 3), now 2 texts.
//
// REMOVED 2026-10-05 (John): the opening credibility pitch - the homes-sold count, the
// years-of-experience line, and the claim about which weeks on market matter most. Never
// removed before despite the memory of it; git shows it was only ever REWORDED (bf27950).
// The exact wording is deliberately NOT quoted here, so a test can assert the phrases
// appear nowhere in this file.
//
// NOTE: the first remaining text still opens "At this point," which referred to the weeks
// described in the deleted message. Left exactly as approved rather than rewritten, because
// this is the approved library - flagged to John to reword or drop.
const MSG_ANALYSIS = [
  "At this point, you might be thinking about adjusting the price. Before making a price reduction, though, it can be worth looking at whether price is actually the issue or if there are a few things that could be adjusted with the marketing or positioning first.",
  "Our team would be happy to put together an analysis of your home and give you our perspective if that would be helpful.",
]
function msgStillAvailable(c) { return `Hi ${c.first_name || 'there'}, It's John with Matt Smith Team at REMAX wanted to see if your home at ${street(c)} is still available for sale? It still shows active on Zillow site but those sites don't always tell me everything I need to know.` }

// CAME OFF THE MARKET WITHOUT SELLING (John, 2026-10-15). One message, once, when the
// listing leaves the market unsold and nobody else has taken it.
//
// It does not pitch. They just failed to sell it themselves, which they know, and a pitch
// at that moment reads as having watched them fail. It names the fact, offers the obvious
// help once, and leaves. The word "FSBO" never appears: that is our filing term, not a
// thing a seller calls themselves.
const OFF_MARKET_TEXT = (c) =>
  `Hi ${c.first_name || 'there'}, it's John with Matt Smith Team at RE/MAX. I noticed the home at ${street(c)} is no longer listed. If you decided to hold off for now, that's completely fine. If you're still open to selling at some point, I'm happy to share what we're seeing in the area whenever it's useful.`

export function fsboOffMarketTextEnabled() {
  return String(db.getSetting?.('fsbo_off_market_text_enabled', '1')) === '1'
}

// Once per listing, ever. A seller who relists and comes off again should not be told the
// same thing twice, so the campaign log is the record rather than a flag on the client.
async function sendOffMarketText(clientId) {
  try {
    const c = db.get('SELECT * FROM clients WHERE id=? AND merged_into IS NULL', [Number(clientId)])
    if (!c || !c.phone) return { ok: false, reason: 'no phone' }
    const already = db.get(
      "SELECT id FROM fsbo_campaign_log WHERE client_id=? AND angle='OFF_MARKET_UNSOLD' AND event='sent' LIMIT 1",
      [Number(clientId)])
    if (already) return { ok: false, reason: 'already told once' }
    const r = await sendFsbo(c, OFF_MARKET_TEXT(c), { proactive: true })
    if (r.ok) logFsbo(Number(clientId), 'sent', { angle: 'OFF_MARKET_UNSOLD', body: OFF_MARKET_TEXT(c), comm_id: r.comm_id })
    else logFsbo(Number(clientId), 'deferred', { angle: 'OFF_MARKET_UNSOLD', reason: r.reason })
    return r
  } catch (e) { return { ok: false, reason: e.message } }
}

// Attempt 4+ rotation: availability checks only — low pressure,
// no manufactured hooks, no "we have a buyer", no "how has activity been".
export const FSBO_ANGLES = {
  AVAILABILITY_RECHECK: { minDom: 0, text: (s) => `Hi, it's John with Matt Smith Team at RE/MAX. Just checking in, is the home at ${s} still available? MattSmithTeam.com` },
  STILL_FOR_SALE: { minDom: 0, text: (s) => `Hi, John with Matt Smith Team at RE/MAX. Is the home at ${s} still for sale? The websites don't always keep up, so figured I'd ask directly.` },
  CONTACT_PREFERENCE: { minDom: 0, text: (s) => `Hi, it's John with Matt Smith Team at RE/MAX. If it's ever easier to talk by email or a quick call about the home at ${s}, happy to do that instead. Otherwise text works great.` },
  GENERAL_CHECKIN: { minDom: 0, text: (s) => `Hi, John with Matt Smith Team at RE/MAX here. Wanted to touch base on the home at ${s}. Still moving ahead with the sale on your own?` },
}
// Rotate angles: never repeat any of the last 3 sent to this lead; respect DOM gates.
export function pickFsboAngle(clientId, domNow) {
  let recent = []
  try { recent = db.all("SELECT angle FROM fsbo_campaign_log WHERE client_id=? AND event='sent' AND angle IS NOT NULL ORDER BY created_at DESC LIMIT 3", [clientId]).map(r => r.angle) } catch {}
  const keys = Object.keys(FSBO_ANGLES).filter(k => (FSBO_ANGLES[k].minDom || 0) <= domNow)
  const fresh = keys.filter(k => !recent.includes(k))
  const pool = fresh.length ? fresh : keys
  return pool[Math.floor(Math.random() * pool.length)]
}

// ---- campaign log (permanent; no sweep noise — events only) ----
function logFsbo(clientId, event, extra = {}) {
  try {
    db.run(`INSERT INTO fsbo_campaign_log (client_id, event, angle, template_key, reason, dom, listing_status, body, comm_id, next_send_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [clientId, event, extra.angle || null, extra.template_key || null, extra.reason || null,
        extra.dom ?? null, extra.listing_status || null, extra.body || null, extra.comm_id || null, extra.next_send_at || null, nowIso()])
  } catch {}
}

const fresh = (id) => db.get('SELECT * FROM clients WHERE id=?', [id])
const fu = (id) => db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [id])

// ---------------------------------------------------------------------------
// A MANUAL DECISION IS FINAL (John, 2026-10-12: "make sure nothing gets them
// enrolled again unless done manually").
//
// 'removed' = excluded, 'paused' = held. Both are an agent's explicit choice and
// only an agent action (Resume / Allow back in) clears them. Asked here, as its own
// function, so every automatic path consults the same rule instead of each one
// re-deriving it in SQL: the sweep's candidate query, the sweep's upsert, the
// history-seed endpoint and the merge all call this. Checking it in one place is the
// difference between an exclusion that holds and one that holds until somebody edits
// a WHERE clause.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A REPLY NO LONGER ENDS THE CAMPAIGN (John, 2026-10-20: "even when we get a response
// the campaign should still be on... only turned off if it was manually done").
//
// This reverses the 2026-09-14 rule. A seller answering a question is engagement, not a
// reason to go quiet on them - the campaign exists to stay in touch with an FSBO until
// they are ready to list, and a human still answers every reply personally.
//
// These replies DO still end it, because continuing would be wrong rather than merely
// persistent: we are texting the wrong person, or the house is no longer theirs to sell,
// or they have said no. An explicit STOP is handled separately and always wins.
export const DISQUALIFYING_REPLY = new Set([
  'WRONG_NUMBER',        // not the owner - every further text bothers an uninvolved person
  'SOLD', 'RENTED',      // nothing left to list
  'LISTED_WITH_AGENT',   // they have representation; continuing would be poaching
  'HOLDING_PROPERTY',    // not selling
  'NOT_INTERESTED',      // they said no. Persistence past a no is harassment, not follow-up
])
export function isDisqualifyingReply(cls) { return DISQUALIFYING_REPLY.has(String(cls || '')) }

export function fsboManualDecision(clientId) {
  try {
    return db.get(`SELECT client_id, status, enrolled_at, removed_at, removed_by, paused_at, paused_by, stop_reason
                   FROM fsbo_followups WHERE client_id=? AND status IN ('removed','paused')`, [Number(clientId)]) || null
  } catch { return null }
}

// ---------------------------------------------------------------------------
// THE ONE AUTHORITATIVE EVALUATOR — used by auto-enroll, every send, the profile
// card, the Settings preview, and the Smart-List semantics. Answers: should this
// FSBO be enrolled / keep receiving campaign texts?
//   decision: 'eligible' | 'waiting' (DOM below threshold) | 'deferred' | 'excluded'
// ---------------------------------------------------------------------------
export async function evaluateFsboCampaignEligibility(clientId) {
  const cid = Number(clientId)
  const c = fresh(cid)
  const out = (decision, reason_code, reason, extra = {}) => ({
    client_id: cid, eligible: decision === 'eligible', decision, reason_code, reason,
    dom: c ? dom(c) : null, listing_status: c?.fsbo_status || null, evaluated_at: nowIso(), ...extra,
  })
  if (!c) return out('excluded', 'NOT_FOUND', 'no such client')
  if (c.merged_into) return out('excluded', 'MERGED', 'merged into another record')

  // FSBO identity + live listing status (master sync is the authority)
  if (!c.fsbo_status) return out('excluded', 'NOT_ON_MASTER', 'not on the FSBO master list (history preserved)')
  if (c.fsbo_status !== 'Available') return out('excluded', 'FSBO_OFF_MARKET', `FSBO listing is ${c.fsbo_status}`)
  if (['junk', 'donotcontact', 'closed', 'archived'].includes(String(c.status || '').toLowerCase())) return out('excluded', 'LEAD_STATUS', `lead status ${c.status}`)
  if (c.fsbo_excluded) return out('excluded', 'MANUAL_EXCLUDE', 'marked Not-FSBO / excluded from FSBO tracking')

  // Manual campaign state always wins
  const row = fu(cid)
  if (row?.status === 'removed') return out('excluded', 'MANUAL_REMOVAL', `removed from campaign${row.removed_by ? ' by ' + row.removed_by : ''}`)
  if (row?.status === 'paused') return out('excluded', 'MANUAL_PAUSE', 'campaign paused by an agent (manual resume required)')
  // (A reply alone no longer excludes — see DISQUALIFYING_REPLY. 'stopped' below still does.)
  if (row?.status === 'stopped' && row.stop_reason && !String(row.stop_reason).startsWith('FSBO_OFF_MARKET')) {
    return out('excluded', 'STOPPED', row.stop_reason)
  }
  // (A campaign stopped ONLY because the listing went Off Market may re-qualify if
  //  the listing is Available again — that is exactly this fresh evaluation.)

  // Team doctrine: no LLC / corporate owners in cold prospecting (trusts and estates
  // are people-backed and are NOT entities — they stay eligible).
  const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase()
  if (/\b(llc|l\.l\.c|inc\b|incorporated|corp\b|corporation|ltd\b|properties|investments|holdings|enterprises)\b/.test(fullName)) {
    return out('excluded', 'ENTITY_OWNER', 'LLC/corporate owner — no cold prospecting to entities')
  }

  // Contactability
  if (!c.phone || !phone10(c.phone)) return out('excluded', 'NO_PHONE', 'no valid phone on file')
  if (c.hub_text_opt_out) return out('excluded', 'STOP', 'replied STOP to our number')
  const prefs = db.get('SELECT do_not_text, sms_status FROM communication_preferences WHERE client_id=?', [cid]) || {}
  if (prefs.do_not_text || ['opted_out', 'blocked'].includes(prefs.sms_status)) return out('excluded', 'DO_NOT_TEXT', 'texting is blocked for this contact')
  if (c.sms_undeliverable) return out('excluded', 'LANDLINE', c.sms_undeliverable_reason || 'number cannot receive SMS')

  // Conflicting automation: the FSBO campaign owns FSBO prospecting (never in
  // parallel with the generic AI or another campaign).
  try { if (db.get('SELECT client_id FROM cx_campaign WHERE client_id=?', [cid])) return out('excluded', 'CONFLICTING_CAMPAIGN', 'enrolled in the Cancelled/Expired campaign') } catch {}
  try { if (db.get('SELECT client_id FROM ai_lead_state WHERE client_id=? AND ai_managed=1', [cid])) return out('excluded', 'AI_MANAGED', 'HUB AI manages this lead (agent choice) — no parallel prospecting') } catch {}
  try { if (db.get("SELECT id FROM transactions WHERE client_id=? AND COALESCE(status,'') NOT IN ('closed','cancelled','canceled','terminated','archived') LIMIT 1", [cid])) return out('excluded', 'ACTIVE_TRANSACTION', 'active transaction with the team') } catch {}

  // Prior meaningful seller response (sold / listed with agent / not interested /
  // wrong number / any real reply) → cold prospecting is inappropriate.
  if (!row || !row.enrolled_at) {
    const { classifyInbound } = await import('./cx-connect.js')
    const inbound = db.all(`SELECT body, preview, transcript, channel, from_addr FROM communications
      WHERE client_id=? AND direction='incoming' AND channel IN ('text','email','call','voicemail') ORDER BY occurred_at DESC LIMIT 200`, [cid])
    // A reply from a number NO LONGER on file came from a wrong number that has
    // since been corrected — its verdict belongs to that number, not this seller
    // (same rule as the CX campaign, John 2026-09-22).
    const d10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)
    const current = new Set([c.phone, ...String(c.alt_phones || '').split(',')].map(d10).filter(s => s.length === 10))
    for (const m of inbound) {
      if (['text', 'call', 'voicemail'].includes(m.channel) && current.size) {
        const from = d10(m.from_addr)
        if (from.length === 10 && !current.has(from)) continue
      }
      const text = [m.body, m.preview, m.transcript].filter(Boolean).join(' ')
      if (!String(text).trim()) continue
      const cls = classifyInbound(text)
      if (['WRONG_NUMBER', 'SOLD', 'RENTED', 'LISTED_WITH_AGENT', 'HOLDING_PROPERTY', 'NOT_INTERESTED'].includes(cls)) return out('excluded', 'PRIOR_' + cls, String(text).slice(0, 140))
      // An ordinary prior reply no longer blocks: the campaign continues alongside the human.
      continue
    }
  }

  // Safety net for an ENROLLED lead: any inbound message since enrollment (an email
  // reply, a voicemail — channels the SMS webhook does not route here) is a response
  // and stops cold automation, same as a text reply would.
  if (row?.enrolled_at && row.status === 'active') {
    const inb = db.get(`SELECT body, preview, transcript FROM communications WHERE client_id=? AND direction='incoming'
      AND channel IN ('text','email','voicemail') AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT 1`, [cid, row.enrolled_at])
    // Narrowed 2026-10-20: an inbound message since enrollment used to stop the campaign
    // outright. Now only a disqualifying one does — an ordinary reply leaves it running.
    const { classifyInbound: classify } = await import('./cx-connect.js')
    if (inb && isDisqualifyingReply(classify([inb.body, inb.preview, inb.transcript].filter(Boolean).join(' ')))) {
      return out('excluded', 'RESPONSE_RECEIVED', 'disqualifying reply since enrollment')
    }
  }

  // Duplicate phone across records: only one campaign per number.
  const p10 = phone10(c.phone)
  if (p10) {
    const twin = db.all("SELECT f.client_id FROM fsbo_followups f JOIN clients t ON t.id=f.client_id WHERE f.status='active' AND f.client_id != ? AND t.phone LIKE ?", [cid, '%' + p10.slice(-4)])
      .find(x => phone10(db.get('SELECT phone FROM clients WHERE id=?', [x.client_id])?.phone) === p10)
    if (twin) return out('excluded', 'DUPLICATE_PHONE', `same number already in an active campaign (#${twin.client_id})`)
  }

  // THE THRESHOLD: live listing DOM. Below it = waiting, never sending.
  const d = dom(c)
  const threshold = fsboDomThreshold()
  if (d < threshold) return out('waiting', 'WAITING_FOR_DOM', `DOM ${d} — campaign starts at DOM ${threshold}`, { days_until: threshold - d })

  // Recent human contact defers (never talk over a human).
  const lastHuman = db.get(`SELECT MAX(occurred_at) m FROM communications WHERE client_id=? AND (
      (direction='outgoing' AND channel IN ('text','email') AND (sent_by_type='human' OR sent_by_type IS NULL))
      OR (channel='call' AND COALESCE(duration_sec,0) >= 45))`, [cid])?.m
  if (lastHuman && daysSince(lastHuman) < 1) return out('deferred', 'RECENT_HUMAN_ACTIVITY', 'a team member contacted this lead in the last 24h', { retry_after: new Date(new Date(lastHuman).getTime() + DAY).toISOString() })
  const schedText = db.get("SELECT send_at FROM scheduled_texts WHERE client_id=? AND status='scheduled' LIMIT 1", [cid])
  if (schedText) return out('deferred', 'PENDING_SCHEDULED_TEXT', 'a manual scheduled text is pending', { retry_after: schedText.send_at })

  return out('eligible', d >= threshold ? `DOM_${threshold}_AVAILABLE` : 'ELIGIBLE', `FSBO is Available with DOM ${d} and no blockers`, { next_action: row?.next_send_at ? `next send ${row.next_send_at}` : 'enroll + schedule first text at next valid slot' })
}

// ---- send helper (compliance-gated, logged like the original sequence) ----
async function sendFsbo(client, body, { proactive = true } = {}) {
  const { canSendSms, canAutomatedSend } = await import('./ai-followup/policy.js')
  // Central policy: campaign sends are 'automation' channel (STOP/DNT/status/holiday/
  // undeliverable). Proactive touches also pass the collision gate (quiet hours,
  // human conversation in progress, AI pending, 60-min duplicate window).
  const gate = canSendSms(client, { channel: 'automation' })
  if (!gate.ok) return { ok: false, reason: gate.reason }
  if (proactive) {
    const auto = canAutomatedSend(client, { source: 'automation', dedupMinutes: 60 })
    if (!auto.ok) return { ok: false, reason: auto.reason }
  }
  try {
    const { sendSms } = await import('./twilio.js')
    const out = String(body).replace(/[ \t]{2,}/g, ' ').trim()
    const r = await sendSms(client.phone, out, { statusCallback: HUB + '/api/inbox/twilio-status' })
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', client.id, name, r.from || '', client.phone, out.replace(/\s+/g, ' ').slice(0, 160), out, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'FSBO AI', 'fsbo_ai', nowIso()])
    return { ok: true, comm_id: ins.lastInsertRowid }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Send several texts to the same lead in order, spaced a few seconds apart so they
// arrive in sequence. Stops if any send is gated/fails; ok reflects the FIRST text.
async function sendFsboSeq(client, bodies, opts = {}) {
  let first = null
  for (let i = 0; i < bodies.length; i++) {
    if (i) await new Promise(r => setTimeout(r, 8000))
    const r = await sendFsbo(client, bodies[i], opts)
    if (i === 0) first = r
    if (!r.ok) break
  }
  return first || { ok: false, reason: 'empty' }
}

// One-time data migration of legacy sequence rows into campaign shape.
function migrateLegacyRows() {
  if (db.getSetting?.('fsbo_campaign_migrated') === '1') return
  // (The old migration that moved every replier to 'responded' is gone — a reply no
  //  longer ends the campaign. Existing 'responded' rows are reactivated deliberately.)
  // Active mid-sequence rows: carry the step into attempt_count + a due next send.
  for (const r of db.all("SELECT * FROM fsbo_followups WHERE status='active'")) {
    const attempts = Number(r.attempt_count) || Number(r.step) || 0
    const lastAt = r.step3_at || r.step2_at || r.first_text_at
    const next = r.next_send_at || (attempts ? scheduleNextFsbo(attempts, lastAt ? new Date(lastAt) : new Date()).toISOString() : null)
    db.run('UPDATE fsbo_followups SET attempt_count=?, last_sent_at=COALESCE(last_sent_at, ?), next_send_at=?, enrolled_at=COALESCE(enrolled_at, ?), updated_at=? WHERE client_id=?',
      [attempts, lastAt || null, next, r.first_text_at || r.updated_at || nowIso(), nowIso(), r.client_id])
  }
  // 'done' was the old 3-step terminus; the campaign continues weekly now.
  db.run("UPDATE fsbo_followups SET status='active', next_send_at=? WHERE status='done' AND replied=0", [nextValidSlot(new Date(Date.now() + 3 * DAY)).toISOString()])
  db.setSetting?.('fsbo_campaign_migrated', '1')
}

// ---------------------------------------------------------------------------
// MAIN SWEEP (every 15 min via scheduler): stop off-market actives, auto-enroll
// newly-eligible FSBOs (DOM threshold reached, imported above it, or blockers
// cleared), then trickle due sends inside the window. Self-healing by design.
// ---------------------------------------------------------------------------
let sweeping = false
export async function runFsboFollowups() {
  if (!fsboEnabled()) return { skipped: 'disabled' }
  if (sweeping) return { skipped: 'already running' }
  sweeping = true
  try {
    migrateLegacyRows()
    const out = { enrolled: 0, sent: 0, deferred: 0, stopped: 0, window: inProactiveWindow() }

    // 0) Event-follow-up: actives whose listing left Available stop right away.
    for (const r of db.all(`SELECT f.client_id, c.fsbo_status, c.mls_status FROM fsbo_followups f JOIN clients c ON c.id=f.client_id
        WHERE f.status='active' AND (c.fsbo_status IS NULL OR c.fsbo_status != 'Available')`)) {
      const reason = r.fsbo_status ? `FSBO_OFF_MARKET: listing is ${r.fsbo_status}` : 'FSBO_OFF_MARKET: dropped off the master list'

      // CAME OFF THE MARKET WITHOUT SELLING (John, 2026-10-15). Before, the campaign just
      // went quiet, which wastes the single most useful moment we get: they tried to sell
      // it themselves, it did not happen, and nobody has taken the listing.
      //
      // Sent only when all three are true, because each one means something different:
      //   fsbo_status = 'Off Market'  not Sold and not Pending, so it did not transact
      //   no mls_status              nobody has listed it with an agent either
      //   not 'Disregard'            the covered statuses are explicit, never a fallback
      //
      // "Listed with an agent" is not a value the FSBO sheet carries, so the MLS field is
      // what stands in for it. A seller who relists through an agent shows up there.
      const offMarketUnsold = String(r.fsbo_status || '').trim().toLowerCase() === 'off market'
        && !String(r.mls_status || '').trim()
      if (offMarketUnsold && fsboOffMarketTextEnabled()) {
        const sent = await sendOffMarketText(r.client_id)
        if (sent.ok) out.sent++
      }

      db.run("UPDATE fsbo_followups SET status='stopped', stop_reason=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [reason, nowIso(), r.client_id])
      logFsbo(r.client_id, 'stopped', { reason, listing_status: r.fsbo_status })
      out.stopped++
    }

    // 1) AUTO-ENROLL: every Available FSBO not actively enrolled gets evaluated.
    //    (Includes OFF_MARKET-stopped rows whose listing returned Available — the
    //    full evaluation, prior-response scan included, is the re-entry gate.)
    const candidates = db.all(`SELECT c.id FROM clients c LEFT JOIN fsbo_followups f ON f.client_id=c.id
      WHERE c.fsbo_status='Available' AND c.merged_into IS NULL
        AND (f.client_id IS NULL OR (f.status='stopped' AND f.stop_reason LIKE 'FSBO_OFF_MARKET%'))`)
    for (const cand of candidates) {
      // Guard 2 of 3. The candidate query above already skips a manual decision; this
      // asks again by id so a future edit to that JOIN cannot quietly re-open the door.
      if (fsboManualDecision(cand.id)) continue
      const ev = await evaluateFsboCampaignEligibility(cand.id)
      if (ev.decision !== 'eligible') continue   // waiting/excluded/deferred: no row, no noise
      const c = fresh(cand.id)
      const firstAt = nextValidSlot().toISOString()
      // Guard 3 of 3, in the write itself. Without the WHERE, this upsert would flip a
      // 'removed' row straight back to 'active' — the one statement in the system that
      // could undo an exclusion. An OFF_MARKET 'stopped' row is still allowed to revive,
      // which is the intended re-entry path when a listing comes back on the market.
      db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, started_dom, attempt_count, next_send_at, listing_address, updated_at)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT (client_id) DO UPDATE SET status='active', enrolled_at=excluded.enrolled_at, started_dom=excluded.started_dom,
                next_send_at=excluded.next_send_at, listing_address=excluded.listing_address, stop_reason=NULL, updated_at=excluded.updated_at
              WHERE fsbo_followups.status NOT IN ('removed','paused')`,
        [cand.id, 'active', nowIso(), ev.dom, 0, firstAt, c.address || null, nowIso()])
      if (!fu(cand.id) || fu(cand.id).status !== 'active') continue   // refused by the guard above
      logFsbo(cand.id, 'enrolled', { reason: ev.reason_code, dom: ev.dom, listing_status: ev.listing_status, next_send_at: firstAt })
      out.enrolled++
    }

    // 2) DUE SENDS — trickled 1-2.5 min apart, window + switch re-checked per send.
    //    (No automated replies of any kind: a response only ever stops the campaign
    //    and hands the seller to a human.)
    if (!inProactiveWindow()) return out
    const due = db.all("SELECT * FROM fsbo_followups WHERE status='active' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT 30", [nowIso()])
    for (let i = 0; i < due.length; i++) {
      if (!fsboEnabled() || !inProactiveWindow()) break   // 4PM crossed / switched off: rest waits for the next window
      const res = await sendNextFsbo(due[i])
      if (res === 'sent') out.sent++
      else if (res === 'deferred') out.deferred++
      else if (res === 'stopped') out.stopped++
      if (i < due.length - 1 && res === 'sent') await new Promise(r => setTimeout(r, 60000 + Math.floor(Math.random() * 90000)))
    }
    return out
  } finally { sweeping = false }
}

// One due enrollment: RE-EVALUATE, line-check, compose from the approved library, send.
async function sendNextFsbo(row) {
  const cid = row.client_id
  const ev = await evaluateFsboCampaignEligibility(cid)
  if (ev.decision === 'waiting') {   // DOM slipped under threshold (relist reset): wait again
    db.run('UPDATE fsbo_followups SET next_send_at=?, updated_at=? WHERE client_id=?', [nextValidSlot(new Date(Date.now() + (ev.days_until || 1) * DAY)).toISOString(), nowIso(), cid])
    return 'deferred'
  }
  if (ev.decision === 'deferred') {
    const push = nextValidSlot(new Date(Math.max(Date.now() + DAY, ev.retry_after ? new Date(ev.retry_after).getTime() : 0))).toISOString()
    db.run('UPDATE fsbo_followups SET next_send_at=?, updated_at=? WHERE client_id=?', [push, nowIso(), cid])
    if (row.stop_reason !== ev.reason_code) {   // log only when the reason changes — no sweep noise
      db.run('UPDATE fsbo_followups SET stop_reason=? WHERE client_id=?', [ev.reason_code, cid])
      logFsbo(cid, 'deferred', { reason: ev.reason_code, dom: ev.dom, listing_status: ev.listing_status, next_send_at: push })
    }
    return 'deferred'
  }
  if (ev.decision !== 'eligible') {
    db.run("UPDATE fsbo_followups SET status='stopped', stop_reason=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [`${ev.reason_code}: ${ev.reason}`.slice(0, 250), nowIso(), cid])
    logFsbo(cid, 'stopped', { reason: ev.reason_code, dom: ev.dom, listing_status: ev.listing_status })
    return 'stopped'
  }
  const c = fresh(cid)
  // Line-type screen before the FIRST campaign send to a never-checked number —
  // a landline never gets an FSBO text, and we never re-pay for a settled verdict.
  if (!row.attempt_count && !c.sms_line_checked_at && c.phone) {
    try {
      const { lookupLineType } = await import('./twilio.js')
      const lt = await lookupLineType(c.phone)
      if (!lt.error) {
        db.run('UPDATE clients SET sms_line_type=?, sms_line_checked_at=? WHERE id=?', [lt.line_type || 'unknown', nowIso(), cid])
        if (lt.textable === false) {
          db.run('UPDATE clients SET sms_undeliverable=1, sms_undeliverable_reason=?, sms_undeliverable_at=? WHERE id=?', [`Twilio Lookup: ${lt.line_type}`, nowIso(), cid])
          db.run("UPDATE fsbo_followups SET status='stopped', stop_reason=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [`LANDLINE: ${lt.line_type}`, nowIso(), cid])
          logFsbo(cid, 'stopped', { reason: 'LANDLINE', dom: ev.dom })
          return 'stopped'
        }
      }
    } catch {}
  }
  const attempt = (Number(row.attempt_count) || 0) + 1
  let body, angle, templateKey, multi = null
  if (attempt === 1) { body = msgStep1(c); angle = 'AVAILABILITY_CHECK'; templateKey = 'step1' }
  else if (attempt === 2) { body = msgStillAvailable(c); angle = 'STILL_AVAILABLE'; templateKey = 'step2' }
  else if (attempt === 3) { multi = MSG_ANALYSIS; body = MSG_ANALYSIS[0]; angle = 'MARKET_ANALYSIS'; templateKey = 'step3' }
  else { angle = pickFsboAngle(cid, ev.dom); templateKey = `angle_${angle}`; body = FSBO_ANGLES[angle].text(street(c)) }
  const r = multi ? await sendFsboSeq(c, multi) : await sendFsbo(c, body)
  if (!r.ok) {
    const push = nextValidSlot(new Date(Date.now() + DAY)).toISOString()
    db.run('UPDATE fsbo_followups SET next_send_at=?, updated_at=? WHERE client_id=?', [push, nowIso(), cid])
    logFsbo(cid, 'deferred', { reason: 'GATED: ' + r.reason, dom: ev.dom, next_send_at: push })
    return 'deferred'
  }
  const next = scheduleNextFsbo(attempt).toISOString()
  db.run(`UPDATE fsbo_followups SET attempt_count=?, step=?, last_sent_at=?, last_angle=?, next_send_at=?,
          first_text_at=COALESCE(first_text_at, ?), stop_reason=NULL, updated_at=? WHERE client_id=?`,
    [attempt, Math.min(attempt, 3), nowIso(), angle, next, nowIso(), nowIso(), cid])
  logFsbo(cid, 'sent', { angle, template_key: templateKey, dom: ev.dom, listing_status: ev.listing_status, body, comm_id: r.comm_id, next_send_at: next })
  return 'sent'
}

const OPTOUT_RE = /\b(stop|unsubscribe|not interested|remove me|leave me alone|do not contact|quit)\b/i
const BUYER_Q_RE = /\b(buyer|do you have|are you interested|interested in|want to (see|buy|tour|view)|see the|show|tour|showing|offer|represent|are you an? agent|working with)\b/i

// Handle an inbound reply from an FSBO in the campaign. RESPONSE STOPS AUTOMATION
// FIRST, a human gets a high-priority FSBO Response task + notification, and NOTHING
// auto-replies — every response is answered personally (John, 2026-09-14). Returns
// true if this lead is in the campaign.
export async function handleFsboReply(clientId, body) {
  const row = fu(clientId)
  if (!row) return false
  const wasActive = row.status === 'active'
  let cls = null
  try { const { classifyInbound } = await import('./cx-connect.js'); cls = classifyInbound(body) } catch {}
  const disqualifying = isDisqualifyingReply(cls)

  if (wasActive) {
    if (disqualifying) {
      // Wrong person, nothing left to sell, already represented, or a plain no. These end it.
      db.run("UPDATE fsbo_followups SET status='stopped', stop_reason=?, replied=1, responded_at=?, response_class=?, next_send_at=NULL, updated_at=? WHERE client_id=?",
        [`reply: ${cls}`, nowIso(), cls, nowIso(), clientId])
    } else {
      // A REPLY KEEPS THE CAMPAIGN RUNNING (John, 2026-10-20). It is recorded, a person is
      // told to answer, and the schedule is left exactly as it was — next_send_at is NOT
      // cleared and the status stays 'active'. Only a human pausing or removing it, an
      // explicit STOP, or a disqualifying reply ends it.
      db.run("UPDATE fsbo_followups SET replied=1, responded_at=COALESCE(responded_at, ?), response_class=?, updated_at=? WHERE client_id=?",
        [nowIso(), cls, nowIso(), clientId])
    }
    logFsbo(clientId, 'response', { reason: cls, body: String(body || '').slice(0, 200), campaign: disqualifying ? 'stopped' : 'continues' })
    flagFsboResponse(fresh(clientId), cls, body, { stopped: disqualifying })
  } else {
    db.run('UPDATE fsbo_followups SET replied=1, response_class=COALESCE(response_class, ?), updated_at=? WHERE client_id=?', [cls, nowIso(), clientId])
  }
  // An opt-out phrasing additionally hard-stops the record (policy handles the number).
  if (OPTOUT_RE.test(String(body || ''))) db.run("UPDATE fsbo_followups SET status='stopped', stop_reason='STOP: opt-out reply', updated_at=? WHERE client_id=?", [nowIso(), clientId])
  return true
}

// Notify + high-priority task when an FSBO responds (mirrors the CX pattern; one
// open task per conversation, never one per message).
function flagFsboResponse(c, cls, detail, { stopped = false } = {}) {
  if (!c) return
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || `Lead ${c.id}`
  try {
    import('./notifications.js').then(m => m.notify({
      type: 'fsbo_response', title: `FSBO RESPONSE — ${name}`,
      body: `${cls || 'reply'}: ${String(detail || '').slice(0, 140)} — ${stopped ? 'campaign stopped' : 'campaign still running'}, answer personally.`,
      link: `/clients/${c.id}`, client_id: c.id, dedupKey: `fsbo_resp_${c.id}_${Date.now()}`,
    })).catch(() => {})
  } catch {}
  try {
    const open = db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'FSBO Response%' AND status IN ('todo','in_progress') LIMIT 1", [c.id])
    if (!open) {
      if (automationTasksEnabled()) {   // Tasks tab is the team's, not the automations' (John 2026-10-05)
        db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id)
                VALUES (?,?,?,?,?,?,?,?,?)`,
          [`FSBO Response: ${name}`, `FSBO seller responded (${cls || 'reply'}). ${stopped ? 'The campaign has STOPPED.' : 'The campaign is STILL RUNNING — it stops only if you pause or remove it.'} Review the conversation and reply personally.\nProperty: ${[c.address, c.city].filter(Boolean).join(', ')} (DOM ${c.fsbo_dom || '?'})\nMessage: ${String(detail || '').slice(0, 300)}`,
            'high', 'todo', new Date().toISOString().slice(0, 10), c.agent_assigned || 'Matt Smith', 'follow-up', 'client', c.id])
      }
    }
  } catch {}
}

// ---- manual controls (always win over sweeps) ----
// Pause / remove must work BEFORE a lead is ever enrolled. A FSBO at DOM 3 has no
// fsbo_followups row yet, so the old UPDATE-only version changed nothing and still
// reported ok — the lead then auto-enrolled the moment they hit DOM 14 (John, 2026-10-12,
// Deborah Emrich at DOM 3). These upsert a decision row instead: the evaluator already
// treats status 'removed' / 'paused' as excluded, and the auto-enroll sweep only picks up
// leads with NO row (or an OFF_MARKET stop), so the decision holds at DOM 14 and after.
// enrolled_at stays NULL on a pre-enrolment row, which is how undoRow() tells the two apart.
function upsertDecision(clientId, status, fields = {}) {
  const cols = { status, updated_at: nowIso(), next_send_at: null, ...fields }
  const keys = Object.keys(cols)
  db.run(`INSERT INTO fsbo_followups (client_id, ${keys.join(', ')}) VALUES (?${keys.map(() => ', ?').join('')})
          ON CONFLICT (client_id) DO UPDATE SET ${keys.map(k => `${k}=excluded.${k}`).join(', ')}`,
    [clientId, ...keys.map(k => cols[k])])
}
export function pauseFsboCampaign(clientId, by = 'agent') {
  const pre = !fu(clientId)
  upsertDecision(clientId, 'paused', { paused_at: nowIso(), paused_by: by })
  logFsbo(clientId, 'paused', { reason: 'by ' + by + (pre ? ' (before enrolment)' : '') })
  return { ok: true, pre_enrollment: pre }
}
export async function resumeFsboCampaign(clientId, by = 'agent') {
  const row = fu(clientId)
  if (!row) return { ok: false, reason: 'not enrolled' }
  // A decision made before the lead ever enrolled is lifted, not resumed — see
  // allowBackIntoFsboCampaign. One button in the UI then covers both cases.
  if (!row.enrolled_at) return allowBackIntoFsboCampaign(clientId, by)
  // Re-evaluate BEFORE reactivating — resume never bypasses eligibility. A paused
  // row blocks itself in the evaluator, so lift the pause for the check.
  db.run("UPDATE fsbo_followups SET status='resuming' WHERE client_id=?", [clientId])
  let ev
  try { ev = await evaluateFsboCampaignEligibility(clientId) }
  catch (e) { db.run('UPDATE fsbo_followups SET status=? WHERE client_id=?', [row.status, clientId]); return { ok: false, reason: e.message } }
  if (ev.decision !== 'eligible') {
    db.run('UPDATE fsbo_followups SET status=? WHERE client_id=?', [row.status, clientId])
    return { ok: false, reason: `${ev.reason_code}: ${ev.reason}` }
  }
  const next = nextValidSlot().toISOString()
  db.run("UPDATE fsbo_followups SET status='active', paused_at=NULL, paused_by=NULL, stop_reason=NULL, next_send_at=?, updated_at=? WHERE client_id=?", [next, nowIso(), clientId])
  logFsbo(clientId, 'resumed', { reason: 'by ' + by, next_send_at: next })
  return { ok: true, next_send_at: next }
}
export function removeFromFsboCampaign(clientId, by = 'agent', reason = '') {
  const pre = !fu(clientId)
  upsertDecision(clientId, 'removed', {
    removed_at: nowIso(), removed_by: by,
    stop_reason: reason ? 'MANUAL_REMOVAL: ' + reason : 'MANUAL_REMOVAL',
  })
  logFsbo(clientId, 'removed', { reason: (reason || 'by ' + by) + (pre ? ' (before enrolment)' : '') })
  return { ok: true, pre_enrollment: pre }
}

// A merge must not lose an exclusion. doMerge copies fsbo_status onto the survivor when
// the survivor has none, so folding an excluded FSBO record into a plain lead moved the
// FSBO identity to a record with no decision row — and the sweep would enroll it. The
// decision belongs to the PERSON, not the row, so it travels to the survivor.
//
// An exclusion wins over the survivor's active campaign: an agent saying "do not text this
// seller" should stop the texting, and it is one click to undo. It does NOT override a
// manual decision the survivor already carries, and it never clears attempt history or
// enrolled_at, so "Allow back in" still routes to Resume for a lead who really enrolled.
export function carryFsboDecisionToSurvivor(primaryId, dupId, by = 'merge') {
  const dupDecision = fsboManualDecision(dupId)
  if (!dupDecision) return null
  if (fsboManualDecision(primaryId)) return null        // survivor already decided — leave it
  const note = `${dupDecision.status === 'removed' ? 'MANUAL_REMOVAL' : 'MANUAL_PAUSE'}: carried from merged record ${dupId}`
  upsertDecision(primaryId, dupDecision.status, dupDecision.status === 'removed'
    ? { removed_at: dupDecision.removed_at || nowIso(), removed_by: dupDecision.removed_by || by, stop_reason: note }
    : { paused_at: dupDecision.paused_at || nowIso(), paused_by: dupDecision.paused_by || by, stop_reason: note })
  logFsbo(primaryId, dupDecision.status === 'removed' ? 'removed' : 'paused', { reason: note })
  return { carried: dupDecision.status, from: dupId, to: primaryId }
}

// Undo a pause/removal. A row that never enrolled is DELETED rather than reactivated:
// resumeFsboCampaign demands current eligibility, and a DOM-3 lead is 'waiting', not
// eligible, so re-activating would refuse. Deleting returns them to a clean un-decided
// state, which is exactly what the auto-enroll sweep looks for at DOM 14.
export function allowBackIntoFsboCampaign(clientId, by = 'agent') {
  const row = fu(clientId)
  if (!row) return { ok: false, reason: 'no campaign decision on file' }
  if (row.enrolled_at) return { ok: false, reason: 'already enrolled once — use Resume', needs_resume: true }
  db.run('DELETE FROM fsbo_followups WHERE client_id=? AND enrolled_at IS NULL', [clientId])
  logFsbo(clientId, 'resumed', { reason: 'exclusion lifted before enrolment by ' + by })
  return { ok: true, pre_enrollment: true }
}

// ---- state / stats / dry-run preview (ZERO writes) ----
// Put back the sellers the OLD rule froze out.
//
// Until 2026-10-20 any reply moved a record to 'responded' and cleared next_send_at. John
// reversed that rule, so those records were turned off by a rule that no longer exists -
// not by anyone's decision. This returns them to 'active'.
//
// It is NOT a blanket undo. A record whose stored response_class is disqualifying (wrong
// number, sold, rented, listed with an agent, holding, not interested) stays off, because
// under the new rule it would have been stopped anyway. Anyone who opted out is already
// 'stopped' and is not touched.
//
// Sends are re-dated across business slots rather than all at once: 27 texts landing in
// the same minute is a different kind of mistake.
export function reactivateRespondedFsbo({ dry = true, by = 'agent' } = {}) {
  const rows = db.all("SELECT client_id, response_class, responded_at FROM fsbo_followups WHERE status='responded'")
  const resume = [], keepOff = []
  for (const r of rows) {
    const c = db.get('SELECT id, first_name, last_name, address, hub_text_opt_out FROM clients WHERE id=?', [r.client_id])
    const name = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : `#${r.client_id}`
    if (!c) { keepOff.push({ client_id: r.client_id, name, why: 'client record missing' }); continue }
    if (c.hub_text_opt_out) { keepOff.push({ client_id: r.client_id, name, why: 'opted out' }); continue }
    if (isDisqualifyingReply(r.response_class)) { keepOff.push({ client_id: r.client_id, name, why: r.response_class }); continue }
    resume.push({ client_id: r.client_id, name, address: c.address || null, response_class: r.response_class || 'unclassified', responded_at: r.responded_at })
  }
  if (!dry) {
    let slot = new Date(Date.now() + 10 * 60000)
    for (const x of resume) {
      const when = nextValidSlot(slot).toISOString()
      db.run("UPDATE fsbo_followups SET status='active', next_send_at=?, updated_at=? WHERE client_id=? AND status='responded'",
        [when, nowIso(), x.client_id])
      logFsbo(x.client_id, 'resumed', { reason: `reply no longer ends the campaign (by ${by})` })
      x.next_send_at = when
      slot = new Date(slot.getTime() + 3 * 60000)   // trickle, ~3 min apart
    }
  }
  return { dry, would_resume: resume.length, keeping_off: keepOff.length, resume, keep_off: keepOff }
}

export function fsboCampaignState(clientId) {
  const row = fu(clientId)
  const log = db.all('SELECT * FROM fsbo_campaign_log WHERE client_id=? ORDER BY created_at DESC LIMIT 30', [clientId])
  return { enrollment: row || null, log }
}
export function fsboCampaignStats() {
  const by = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM fsbo_followups GROUP BY status').map(r => [r.status, r.n]))
  return {
    enabled: fsboEnabled(), dom_threshold: fsboDomThreshold(),
    active: by.active || 0, responded: (by.responded || 0), paused: by.paused || 0,
    removed: by.removed || 0, stopped: by.stopped || 0,
    sent_7d: db.get("SELECT COUNT(*) n FROM fsbo_campaign_log WHERE event='sent' AND created_at >= datetime('now','-7 days')")?.n || 0,
    responses_7d: db.get("SELECT COUNT(*) n FROM fsbo_campaign_log WHERE event='response' AND created_at >= datetime('now','-7 days')")?.n || 0,
    due_now: db.get("SELECT COUNT(*) n FROM fsbo_followups WHERE status='active' AND next_send_at <= ?", [nowIso()])?.n || 0,
  }
}
export async function previewFsboCampaign() {
  const rows = db.all("SELECT id FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL")
  const table = [], byDecision = {}, byReason = {}
  for (const r of rows) {
    const ev = await evaluateFsboCampaignEligibility(r.id)
    const c = fresh(r.id); const row = fu(r.id)
    byDecision[ev.decision] = (byDecision[ev.decision] || 0) + 1
    byReason[ev.reason_code] = (byReason[ev.reason_code] || 0) + 1
    table.push({
      client_id: r.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      property: c.address || null, dom: ev.dom, fsbo_status: c.fsbo_status,
      phone_status: c.sms_undeliverable ? 'undeliverable' : (c.sms_line_type || 'unchecked'),
      campaign_state: row?.status || null, attempts: row?.attempt_count || 0,
      decision: ev.decision, reason: ev.reason_code,
      next_proposed_send: ev.decision === 'eligible' ? (row?.next_send_at || nextValidSlot().toISOString()) : null,
    })
  }
  const order = { eligible: 0, waiting: 1, deferred: 2, excluded: 3 }
  table.sort((a, b) => (order[a.decision] - order[b.decision]) || (b.dom || 0) - (a.dom || 0))
  return {
    dry_run: true, enabled: fsboEnabled(), dom_threshold: fsboDomThreshold(),
    evaluated: rows.length, by_decision: byDecision, by_reason: byReason,
    would_enroll: table.filter(t => t.decision === 'eligible' && !['active', 'responded', 'paused', 'removed'].includes(t.campaign_state || '')).length,
    table,
  }
}

// Daily 9:30 job: refresh the master file so the Hub FSBO list mirrors the sheet's Available +
// Off Market FSBOs. TEAM RULE (applied inside syncFsboMaster): a FSBO that has gone PENDING
// (under contract) drops OFF the list and is moved to Junk. Off Market (withdrawn/expired, did
// NOT sell) is different — those stay on the list, labeled, and are simply not texted.
export async function fsboDailyMaintenance() {
  const rep = { synced: false, errors: 0 }
  let r = null
  try {
    const { syncFsboMaster, ensureFsboListIncludesMaster } = await import('./fsbo-master.js')
    r = await syncFsboMaster(); ensureFsboListIncludesMaster()
    rep.synced = true; rep.sheet_rows = r.sheet_rows; rep.created = r.created; rep.updated = r.updated
    rep.on_list = r.on_list; rep.deduped = r.deduped; rep.profiles = r.profiles; rep.sheet_rows = r.sheet_rows
  } catch (e) { rep.errors++ }
  // Stop campaigns whose listing left Available (the 15-min sweep also does this;
  // belt and braces after the daily full sync). History stays.
  for (const row of db.all(`SELECT f.client_id, c.fsbo_status FROM fsbo_followups f JOIN clients c ON c.id=f.client_id
      WHERE f.status='active' AND (c.fsbo_status IS NULL OR c.fsbo_status != 'Available')`)) {
    const reason = row.fsbo_status ? `FSBO_OFF_MARKET: listing is ${row.fsbo_status}` : 'FSBO_OFF_MARKET: dropped off the master list'
    db.run("UPDATE fsbo_followups SET status='stopped', stop_reason=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [reason, nowIso(), row.client_id])
    logFsbo(row.client_id, 'stopped', { reason, listing_status: row.fsbo_status })
  }
  db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
    ['fsbo_daily', 'fsbo', `Master synced (${rep.sheet_rows || 0} rows). On list: ${rep.on_list ?? '?'}. Deduped: ${rep.deduped ?? 0}.${rep.errors ? ` ${rep.errors} errors.` : ''}`])
  // Invariant alert: one profile per (name+phone), so on-list should equal the profile count.
  try {
    if (r && r.on_list != null && r.profiles != null) {
      const gap = r.on_list - r.profiles
      if (gap > 3 || (r.deduped || 0) > 3) {
        const { postSlack } = await import('./slack.js')
        await postSlack(`:warning: FSBO list check — on-list ${r.on_list} vs ${r.profiles} expected profiles (gap ${gap}, self-healed ${r.deduped || 0} dupes today). Worth a look if this keeps growing.`)
      }
    }
  } catch {}
  return rep
}
