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
//   - Opening cadence keeps the team's approved copy: availability check → (+7d) the
//     35-years / first-14-days message → (+7d) still-available check — then continues
//     ~weekly (6-8 day jitter) with a low-pressure rotating angle bank while the
//     listing stays Available. Persistence ≠ pressure: text ten reads like text one.
//   - Eligibility is re-verified before EVERY send (Available? still FSBO? no STOP?
//     no response? no recent human contact? not paused/removed?).
//   - An inbound reply STOPS AUTOMATION FIRST (state → responded), then the approved
//     scripted acknowledgment + best-email ask run, a high-priority FSBO Response
//     task is created and the team notified. Humans own it from there.
//   - Off Market / sold / agent-listed / master-file removal stop future sends;
//     HISTORY IS PERMANENT (fsbo_campaign_log, communications, listing history).
//   - Manual pause/remove always wins; sweeps never silently resume or re-enroll.
//   - Sends only weekdays 9AM-4PM Central, trickled 1-2.5 min apart, through the
//     central policy + collision gates. Identity safety: "the home at {address}",
//     no first names in cold prospecting.
//
// Master switch: fsbo_followup_enabled (OFF by default — ships off).
import db from './database.js'

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const DAY = 86400000

export function fsboEnabled() { return db.getSetting?.('fsbo_followup_enabled') === '1' }   // OFF until explicitly turned on (prevents an accidental mass-text)
export function fsboDomThreshold() { return Number(db.getSetting?.('fsbo_campaign_dom_threshold') || 14) || 14 }

// Central-time parts.
function chi(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
  const g = (t) => p.find(x => x.type === t)?.value
  return { weekday: g('weekday'), hour: Number(g('hour')) === 24 ? 0 : Number(g('hour')), minute: Number(g('minute')) }
}
// Weekday 9AM-4PM Central.
export function inProactiveWindow(d = new Date()) {
  const c = chi(d)
  if (['Sat', 'Sun'].includes(c.weekday)) return false
  return c.hour >= 9 && c.hour < 16
}
// Greeting: never "evening" (we don't text then). At 4PM+ just "Hello".
function greeting() { const h = chi().hour; return h < 12 ? 'Good morning' : h < 16 ? 'Good afternoon' : 'Hello' }
const dom = (c) => { const n = parseInt(String(c?.fsbo_dom || '').replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n }
const daysSince = (ts) => ts ? (Date.now() - new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z')).getTime()) / 86400000 : 999
const phone10 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null }

// Next valid send slot at/after `from`: weekdays 9AM-4PM CT. Saturday rolls Mon,
// Sunday rolls Mon, after-4PM rolls to next weekday morning at a random 9-11 time.
export function nextValidSlot(from = new Date()) {
  let d = new Date(from)
  for (let i = 0; i < 10; i++) {
    const c = chi(d)
    if (c.weekday === 'Sat') { d = new Date(d.getTime() + 2 * DAY) }
    else if (c.weekday === 'Sun') { d = new Date(d.getTime() + DAY) }
    else if (c.hour < 9) { d = new Date(d.getTime() + (9 - c.hour) * 3600000) ; continue }
    else if (c.hour >= 16) { d = new Date(d.getTime() + (24 - c.hour + 9) * 3600000); continue }
    else return d
    // rolled a day: land at a random morning slot 9-11 CT
    const c2 = chi(d)
    d = new Date(d.getTime() + (9 + Math.floor(Math.random() * 3) - c2.hour) * 3600000)
  }
  return d
}
// Next touch after attempt N just sent: +7d flat after attempts 1 and 2 (the approved
// opening cadence), then ~weekly with 6-8-day jitter so the pattern never looks robotic.
export function scheduleNextFsbo(attemptJustSent, from = new Date()) {
  const baseDays = attemptJustSent <= 2 ? 7 : 7 + (Math.floor(Math.random() * 3) - 1)   // 6-8
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
// (Step 3 legacy copy is the one historical exception, kept as approved).
function street(c) { return c.address || 'the property' }
function msgStep1(c) { return `${greeting()}, I'm John with Matt Smith Team at RE/MAX. Our team noticed your place on ${street(c)} for sale, beautiful home. Just want to make sure it's still available? MattSmithTeam.com` }
const MSG_EMAIL_ASK = "Hope to be in touch soon. What's the best email we can reach you at?"
const MSG_POSITIVE = 'Very good, thanks for letting me know'
const MSG_BUYER_Q = "At this time, we're just checking it's availability :)"
// Step 2 is sent the same day but broken into 3 shorter texts (no wall of text).
const MSG_STEP2 = [
  "Hi, it's John again with Matt Smith Team at RE/MAX. A little about us, we've sold over 2,000 homes throughout Cedar Rapids and the surrounding areas over the past 35+ years. One thing we've learned is that the first 14 days on the market are usually the most critical, and that's when most of the activity tends to happen. By the third week, activity can start to slow down.",
  "At this point, you might be thinking about adjusting the price. Before making a price reduction, though, it can be worth looking at whether price is actually the issue or if there are a few things that could be adjusted with the marketing or positioning first.",
  "Our team would be happy to put together an analysis of your home and give you our perspective if that would be helpful.",
]
function msgStep3(c) { return `Hi ${c.first_name || 'there'}, It's John with Matt Smith Team at REMAX wanted to see if your home at ${street(c)} is still available for sale? It still shows active on Zillow site but those sites don't always tell me everything I need to know.` }

// Attempt 4+ rotation: low-pressure angles. No manufactured hooks, no "we have a
// buyer", no "how has activity been", truthful about listing age. LONG_HAUL only
// speaks once DOM is genuinely high.
export const FSBO_ANGLES = {
  AVAILABILITY_RECHECK: { minDom: 0, text: (s) => `Hi, it's John with Matt Smith Team at RE/MAX. Just checking in, is the home at ${s} still available? MattSmithTeam.com` },
  STILL_FOR_SALE: { minDom: 0, text: (s) => `Hi, John with Matt Smith Team at RE/MAX. Is the home at ${s} still for sale? The websites don't always keep up, so figured I'd ask directly.` },
  CONTACT_PREFERENCE: { minDom: 0, text: (s) => `Hi, it's John with Matt Smith Team at RE/MAX. If it's ever easier to talk by email or a quick call about the home at ${s}, happy to do that instead. Otherwise text works great.` },
  GENERAL_CHECKIN: { minDom: 0, text: (s) => `Hi, John with Matt Smith Team at RE/MAX here. Wanted to touch base on the home at ${s}. Still moving ahead with the sale on your own?` },
  TIMING: { minDom: 21, text: (s) => `Hi, it's John with Matt Smith Team at RE/MAX. Curious how the timeline is looking for the home at ${s}. Is there a date you're hoping to have it sold by?` },
  SOFT_RESOURCE: { minDom: 21, text: (s) => `Hi, John with Matt Smith Team at RE/MAX. If it would ever help to compare notes on pricing or positioning for the home at ${s}, happy to share what we're seeing in the area. No strings attached.` },
  LONG_HAUL: { minDom: 61, text: (s) => `Hi, it's John with Matt Smith Team at RE/MAX. The home at ${s} has been on the market a while now. If you'd ever like a second set of eyes on what might be holding it back, glad to help.` },
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
  if (row?.status === 'responded' || row?.replied) return out('excluded', 'RESPONSE_RECEIVED', 'seller already responded — humans own this conversation')
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
    const inbound = db.all(`SELECT body, preview, transcript, channel FROM communications
      WHERE client_id=? AND direction='incoming' AND channel IN ('text','email','call','voicemail') ORDER BY occurred_at DESC LIMIT 200`, [cid])
    for (const m of inbound) {
      const text = [m.body, m.preview, m.transcript].filter(Boolean).join(' ')
      if (!String(text).trim()) continue
      const cls = classifyInbound(text)
      if (['WRONG_NUMBER', 'SOLD', 'RENTED', 'LISTED_WITH_AGENT', 'HOLDING_PROPERTY', 'NOT_INTERESTED'].includes(cls)) return out('excluded', 'PRIOR_' + cls, String(text).slice(0, 140))
      return out('excluded', 'PRIOR_RESPONSE', 'seller has replied before — human follow-up, not cold automation')
    }
  }

  // Safety net for an ENROLLED lead: any inbound message since enrollment (an email
  // reply, a voicemail — channels the SMS webhook does not route here) is a response
  // and stops cold automation, same as a text reply would.
  if (row?.enrolled_at && row.status === 'active') {
    const inb = db.get(`SELECT id FROM communications WHERE client_id=? AND direction='incoming'
      AND channel IN ('text','email','voicemail') AND occurred_at >= ? LIMIT 1`, [cid, row.enrolled_at])
    if (inb) return out('excluded', 'RESPONSE_RECEIVED', 'inbound message since enrollment — humans own this conversation')
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
      ['text', 'outgoing', client.id, name, '', client.phone, out.replace(/\s+/g, ' ').slice(0, 160), out, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'FSBO AI', 'fsbo_ai', nowIso()])
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
  // A prior reply = responded state (humans own it; never cold re-texted).
  db.run("UPDATE fsbo_followups SET status='responded', responded_at=COALESCE(responded_at, updated_at) WHERE replied=1 AND status IN ('active','done')")
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
    const out = { enrolled: 0, sent: 0, deferred: 0, stopped: 0, email_ask: 0, window: inProactiveWindow() }

    // 0) Event-follow-up: actives whose listing left Available stop right away.
    for (const r of db.all(`SELECT f.client_id, c.fsbo_status FROM fsbo_followups f JOIN clients c ON c.id=f.client_id
        WHERE f.status='active' AND (c.fsbo_status IS NULL OR c.fsbo_status != 'Available')`)) {
      const reason = r.fsbo_status ? `FSBO_OFF_MARKET: listing is ${r.fsbo_status}` : 'FSBO_OFF_MARKET: dropped off the master list'
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
      const ev = await evaluateFsboCampaignEligibility(cand.id)
      if (ev.decision !== 'eligible') continue   // waiting/excluded/deferred: no row, no noise
      const c = fresh(cand.id)
      const firstAt = nextValidSlot().toISOString()
      db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, started_dom, attempt_count, next_send_at, listing_address, updated_at)
              VALUES (?,?,?,?,?,?,?,?)
              ON CONFLICT (client_id) DO UPDATE SET status='active', enrolled_at=excluded.enrolled_at, started_dom=excluded.started_dom,
                next_send_at=excluded.next_send_at, listing_address=excluded.listing_address, stop_reason=NULL, updated_at=excluded.updated_at`,
        [cand.id, 'active', nowIso(), ev.dom, 0, firstAt, c.address || null, nowIso()])
      logFsbo(cand.id, 'enrolled', { reason: ev.reason_code, dom: ev.dom, listing_status: ev.listing_status, next_send_at: firstAt })
      out.enrolled++
    }

    // 2) Scripted email-ask follow-through for responded leads (responsive, any weekday time).
    for (const r of db.all("SELECT * FROM fsbo_followups WHERE email_ask_at IS NOT NULL AND email_asked=0 AND email_ask_at <= ?", [nowIso()])) {
      const c = fresh(r.client_id); if (!c) continue
      const s = await sendFsbo(c, MSG_EMAIL_ASK, { proactive: false })
      if (s.ok) { db.run('UPDATE fsbo_followups SET email_asked=1, email_ask_at=NULL, updated_at=? WHERE client_id=?', [nowIso(), r.client_id]); out.email_ask++ }
    }

    // 3) DUE SENDS — trickled 1-2.5 min apart, window + switch re-checked per send.
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
  else if (attempt === 2) { multi = MSG_STEP2; body = MSG_STEP2[0]; angle = 'MARKET_ANALYSIS'; templateKey = 'step2' }
  else if (attempt === 3) { body = msgStep3(c); angle = 'STILL_AVAILABLE'; templateKey = 'step3' }
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
// FIRST — then the approved scripted acknowledgment + best-email ask run, and a
// human gets a high-priority FSBO Response task. Returns true if handled.
export async function handleFsboReply(clientId, body) {
  const row = fu(clientId)
  if (!row) return false
  const wasActive = row.status === 'active'
  // 1) STOP FIRST — no further automated campaign text after a reply, ever.
  if (wasActive) {
    let cls = null
    try { const { classifyInbound } = await import('./cx-connect.js'); cls = classifyInbound(body) } catch {}
    db.run("UPDATE fsbo_followups SET status='responded', replied=1, responded_at=?, response_class=?, next_send_at=NULL, updated_at=? WHERE client_id=?",
      [nowIso(), cls, nowIso(), clientId])
    logFsbo(clientId, 'response', { reason: cls, body: String(body || '').slice(0, 200) })
    flagFsboResponse(fresh(clientId), cls, body)
  } else {
    db.run('UPDATE fsbo_followups SET replied=1, updated_at=? WHERE client_id=?', [nowIso(), clientId])
  }
  if (!fsboEnabled()) return wasActive
  const c = fresh(clientId); if (!c) return wasActive
  const text = String(body || '')
  if (OPTOUT_RE.test(text)) { db.run("UPDATE fsbo_followups SET status='stopped', stop_reason='STOP: opt-out reply', updated_at=? WHERE client_id=?", [nowIso(), clientId]); return true }  // policy/opt-out handles the rest
  // Approved scripted acknowledgment (availability check flow), then the best-email
  // ask ~7 min later (once) — the historical, approved behavior, unchanged. Only
  // after we have actually texted them (never a scripted reply to a cold inbound).
  if ((wasActive || row.status === 'responded') && (Number(row.attempt_count) || row.step)) {
    const reply = BUYER_Q_RE.test(text) ? MSG_BUYER_Q : MSG_POSITIVE
    await sendFsbo(c, reply, { proactive: false })
    if (!row.email_asked && !row.email_ask_at) {
      db.run('UPDATE fsbo_followups SET email_ask_at=?, updated_at=? WHERE client_id=?', [new Date(Date.now() + 7 * 60000).toISOString(), nowIso(), clientId])
    }
  }
  return true
}

// Notify + high-priority task when an FSBO responds (mirrors the CX pattern; one
// open task per conversation, never one per message).
function flagFsboResponse(c, cls, detail) {
  if (!c) return
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || `Lead ${c.id}`
  try {
    import('./notifications.js').then(m => m.notify({
      type: 'fsbo_response', title: `FSBO RESPONSE — ${name}`,
      body: `${cls || 'reply'}: ${String(detail || '').slice(0, 140)} — campaign stopped, human follow-up.`,
      link: `/clients/${c.id}`, client_id: c.id, dedupKey: `fsbo_resp_${c.id}_${Date.now()}`,
    })).catch(() => {})
  } catch {}
  try {
    const open = db.get("SELECT id FROM tasks WHERE related_type='client' AND related_id=? AND title LIKE 'FSBO Response%' AND status IN ('todo','in_progress') LIMIT 1", [c.id])
    if (!open) {
      db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        [`FSBO Response: ${name}`, `FSBO seller responded (${cls || 'reply'}). The campaign has stopped — review the conversation and reply personally.\nProperty: ${[c.address, c.city].filter(Boolean).join(', ')} (DOM ${c.fsbo_dom || '?'})\nMessage: ${String(detail || '').slice(0, 300)}`,
          'high', 'todo', new Date().toISOString().slice(0, 10), c.agent_assigned || 'Matt Smith', 'follow-up', 'client', c.id])
    }
  } catch {}
}

// ---- manual controls (always win over sweeps) ----
export function pauseFsboCampaign(clientId, by = 'agent') {
  db.run("UPDATE fsbo_followups SET status='paused', paused_at=?, paused_by=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), by, nowIso(), clientId])
  logFsbo(clientId, 'paused', { reason: 'by ' + by })
  return { ok: true }
}
export async function resumeFsboCampaign(clientId, by = 'agent') {
  const row = fu(clientId)
  if (!row) return { ok: false, reason: 'not enrolled' }
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
  db.run("UPDATE fsbo_followups SET status='removed', removed_at=?, removed_by=?, stop_reason=?, next_send_at=NULL, updated_at=? WHERE client_id=?",
    [nowIso(), by, reason ? 'MANUAL_REMOVAL: ' + reason : 'MANUAL_REMOVAL', nowIso(), clientId])
  logFsbo(clientId, 'removed', { reason: (reason || 'by ' + by) })
  return { ok: true }
}

// ---- state / stats / dry-run preview (ZERO writes) ----
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
