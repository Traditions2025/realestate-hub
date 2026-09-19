// FB LISTING LEAD 30-DAY FOLLOW-UP CAMPAIGN (John, 2026-09-18).
//
// A Facebook lead who registered off ONE listing gets a property-interest
// follow-up, not generic buyer nurture: keep giving them easy chances to say
// "yes, that house", while learning whether the property was the draw or they
// have broader intent. Day 0 (opener text + no-reply email) is the EXISTING
// fb-ad pipeline — this module owns Days 2→30:
//
//   Day 2 SMS · 4 EMAIL · 7 SMS · 10 EMAIL · 14 SMS · 20 SMS · 23 EMAIL · 30 SMS
//
// Doctrine (same as FSBO/CX):
//   - Copy is JOHN'S, VERBATIM. Texts speak as John; emails sign Matt Smith Team.
//   - PROPERTY-STATUS CHECK BEFORE EVERY SEND (via the listing's transaction):
//       pending  → the "now pending" pivot text ONCE, then only the broader
//                  Day 20/23/30 search-discovery touches remain;
//       sold     → the "no longer available" pivot text ONCE, same pivot;
//       price ↓↑ → the price-update text as a reconnect (once per price), the
//                  next scheduled touch pushed out to keep spacing;
//       active/unknown → the normal sequence.
//   - HIERARCHY: buyer behavior → property status change → scheduled property
//     follow-up → generic nurture. A recent behavioral event (returned to the
//     listing, favorited, showing request) HOLDS the scheduled generic text and
//     notifies the team — a person reaching out beats a canned message.
//   - A reply on ANY channel stops the campaign first; humans own it. No
//     automated replies, ever.
//   - 9AM-4PM Central window SEVEN days a week (weekend exemption for FB-ad
//     leads, John 2026-09-19), trickled sends, central policy gates
//     (STOP/DNT/undeliverable/collision) re-checked per send.
//
// Master switch: fb_listing_campaign_enabled ('1' = on).
import db from './database.js'
import { ctParts } from './scheduling.js'

// WEEKEND EXEMPTION for Facebook-ad leads (John, 2026-09-19): these are hot
// inbound leads, so follow-ups send SEVEN days a week — same 9AM-4PM Central
// time rules, but Saturday/Sunday no longer roll to Monday. (FSBO/expired cold
// prospecting keeps its weekday-only window; this applies to FB campaigns only.)
export function inFbWindow(d = new Date()) {
  const c = ctParts(d)
  return c.hour >= 9 && c.hour < 16
}
export function nextFbSlot(from = new Date()) {
  let d = new Date(from)
  for (let i = 0; i < 5; i++) {
    const c = ctParts(d)
    if (c.hour < 9) { d = new Date(d.getTime() + ((9 - c.hour) * 60 - c.minute + Math.floor(Math.random() * 90)) * 60000); continue }
    if (c.hour >= 16) { d = new Date(d.getTime() + ((24 - c.hour + 9) * 60 - c.minute + Math.floor(Math.random() * 90)) * 60000); continue }
    return d
  }
  return d
}

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const DAY = 86400000

export function fbListingCampaignEnabled() { return db.getSetting?.('fb_listing_campaign_enabled') === '1' }

export function initFbListingCampaign() {
  db.run(`CREATE TABLE IF NOT EXISTS fb_listing_campaigns (
    client_id INTEGER PRIMARY KEY,
    listing_label TEXT,
    tx_id INTEGER,
    status TEXT NOT NULL DEFAULT 'active',
    day0_at TEXT,
    next_step INTEGER NOT NULL DEFAULT 0,
    next_send_at TEXT,
    last_sent_at TEXT,
    last_known_status TEXT,
    last_known_price REAL,
    price_notified_at REAL,
    pivoted TEXT,
    stop_reason TEXT,
    enrolled_at TEXT,
    updated_at TEXT
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS fb_listing_campaign_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    step_key TEXT,
    reason TEXT,
    listing_status TEXT,
    body TEXT,
    comm_id INTEGER,
    next_send_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  try { db.run('CREATE INDEX IF NOT EXISTS idx_fblc_log_client ON fb_listing_campaign_log(client_id, created_at DESC)') } catch {}
}

function logC(cid, event, extra = {}) {
  try {
    db.run(`INSERT INTO fb_listing_campaign_log (client_id, event, step_key, reason, listing_status, body, comm_id, next_send_at, created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      [cid, event, extra.step_key || null, extra.reason || null, extra.listing_status || null,
       extra.body || null, extra.comm_id || null, extra.next_send_at || null, nowIso()])
  } catch {}
}

// ---- John's sequence, verbatim -------------------------------------------
// %N first name, %P property label, %$ new price. property=true means the copy
// asserts the home is (or may be) available — those steps are skipped after a
// pending/sold pivot. The Day 20/23/30 touches only reference the property as
// the origin story, so they stay valid whatever happens to the listing.
const STEPS = [
  { key: 'd2_sms', day: 2, ch: 'sms', property: true,
    text: (n, p) => `Hi ${n} :) Just following up on ${p}. Was there anything about the home you wanted more information on?` },
  { key: 'd4_email', day: 4, ch: 'email', property: true,
    subject: (p) => `Still interested in ${p}?`,
    paras: (n, p) => [
      `Just wanted to follow up on the home you were looking at on Facebook.`,
      `If ${p} is one you're seriously considering, we can help with additional property information or answer anything that wasn't clear from the listing.`,
      `And if it wasn't quite the right one, that's completely fine too.`,
    ] },
  { key: 'd7_sms', day: 7, ch: 'sms', property: true,
    text: (n, p) => `Hello ${n}, just checking back on ${p}. Is that one still on your radar, or did you decide it wasn't quite what you're looking for?` },
  { key: 'd10_email', day: 10, ch: 'email', property: true,
    subject: () => `Was it this home or something similar?`,
    paras: (n, p) => [
      `I wanted to check back one more time about ${p}.`,
      `Sometimes the home someone originally finds us through isn't ultimately the one they choose, but it gives us a pretty good idea of what caught their attention.`,
      `If this one isn't quite right, but you're looking for something similar, just let us know what you'd change about it and we can keep an eye out.`,
    ] },
  { key: 'd14_sms', day: 14, ch: 'sms', property: true,
    text: (n, p) => `Hi ${n} :) Wanted to circle back on ${p}. Would you potentially want to take a look at it in person, or are you still just checking things out online?` },
  { key: 'd20_sms', day: 20, ch: 'sms', property: false,
    text: (n, p) => `Hi ${n}, John with Matt Smith Team :) Just curious, was ${p} mainly what caught your attention, or have you been looking at other homes too?` },
  { key: 'd23_email', day: 23, ch: 'email', property: false,
    subject: () => `Keeping an eye out`,
    paras: (n, p) => [
      `Just checking in since you originally found us through ${p}.`,
      `If you're still looking around, we're happy to keep an eye out for homes that fit what you're after. And if you're only browsing for now, that's perfectly fine too.`,
      `If there's one thing you'd want different from ${p}, what would it be?`,
    ] },
  { key: 'd30_sms', day: 30, ch: 'sms', property: false,
    text: (n, p) => `Hi ${n} :) Wanted to check in one more time since you originally reached out through ${p}. Are you still keeping an eye on homes, or has the home search been put on hold for now?` },
]

const PIVOT_TEXTS = {
  pending: (n, p) => `Hi ${n}, quick update on ${p} you were looking at. It looks like that one is now pending. Were you mainly interested in that particular home, or would you like to keep an eye on similar ones?`,
  sold: (n, p) => `Hi ${n}, just wanted to follow up since you originally found us through ${p}. That one is no longer available. Are you still looking for something similar?`,
  price: (n, p, price) => `Hi ${n} :) Quick update on ${p} you were looking at. The price was just adjusted to ${price}. Is that one still on your radar?`,
}

function emailHtml(first, paras) {
  const ps = paras.map(t => `<p>${t}</p>`).join('\n')
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
<p>Hi ${first},</p>
${ps}
<p>Matt Smith Team<br>RE/MAX Concepts</p></div>`
}

// ---- listing state --------------------------------------------------------
// The ad's listing label ("510 Broadway Springville") is matched to the team's
// own transaction by street number + street name. Missing/unmatched = 'unknown'
// and the sequence just runs normally without asserting a status.
export function findListingTransaction(label) {
  const m = String(label || '').match(/(\d+)\s+([A-Za-z]+)/)
  if (!m) return null
  return db.get(`SELECT id, property_address, property_status, purchase_price FROM transactions
    WHERE property_address LIKE ? AND property_address LIKE ? ORDER BY (type='listing') DESC, id DESC LIMIT 1`,
    [`%${m[1]}%`, `%${m[2]}%`])
}

export function listingState(tx) {
  const s = String(tx?.property_status || '').toLowerCase()
  if (!s) return 'unknown'
  if (s === 'active') return 'active'
  if (['under contract', 'pending', 'clear to close'].includes(s)) return 'pending'
  if (['closed', 'sold'].includes(s)) return 'sold'
  return 'unknown'
}

const fmtPrice = (p) => '$' + Number(p).toLocaleString('en-US')

// ---- schedule -------------------------------------------------------------
function stepDueAt(day0Iso, stepIdx) {
  const target = new Date(new Date(day0Iso).getTime() + STEPS[stepIdx].day * DAY)
  return nextFbSlot(target < new Date() ? new Date() : target)
}

// ---- enrollment -----------------------------------------------------------
// day0Iso = when the Day-0 opener went out (defaults to now for fresh intake).
// Enrollment starts the clock at the first step still ahead of the lead.
export function enrollFbListingCampaign(clientId, listingLabel, { day0Iso = null, actor = 'intake' } = {}) {
  initFbListingCampaign()
  const cid = Number(clientId)
  const c = db.get('SELECT id, first_name, phone, email FROM clients WHERE id=? AND merged_into IS NULL', [cid])
  if (!c) return { ok: false, reason: 'no client' }
  const day0 = day0Iso || nowIso()
  // A reply since day0 means a human already owns this lead.
  const replied = db.get("SELECT id FROM communications WHERE client_id=? AND direction='incoming' AND occurred_at >= ? LIMIT 1", [cid, day0])
  const elapsed = (Date.now() - new Date(day0).getTime()) / DAY
  // 1-day grace: a lead enrolled at day 2.4 still gets the Day-2 text (sent now),
  // rather than silently skipping to Day 4.
  let step = STEPS.findIndex(s => s.day >= elapsed - 1)
  if (step === -1) step = STEPS.length
  const tx = findListingTransaction(listingLabel)
  const status = replied ? 'responded' : (step >= STEPS.length ? 'completed' : 'active')
  const nextAt = status === 'active' ? stepDueAt(day0, step).toISOString() : null
  db.run(`INSERT INTO fb_listing_campaigns (client_id, listing_label, tx_id, status, day0_at, next_step, next_send_at, last_known_status, last_known_price, enrolled_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT (client_id) DO UPDATE SET listing_label=excluded.listing_label, tx_id=excluded.tx_id, status=excluded.status,
            day0_at=excluded.day0_at, next_step=excluded.next_step, next_send_at=excluded.next_send_at, stop_reason=NULL, updated_at=excluded.updated_at`,
    [cid, String(listingLabel || '').trim() || null, tx?.id || null, status, day0, step, nextAt,
     listingState(tx), tx?.purchase_price || null, nowIso(), nowIso()])
  logC(cid, 'enrolled', { reason: `${actor}; day0=${day0.slice(0, 10)}; starts at ${STEPS[step]?.key || 'done'}`, next_send_at: nextAt, listing_status: listingState(tx) })
  return { ok: true, status, next_step: STEPS[step]?.key || null, next_send_at: nextAt }
}

// ---- sending --------------------------------------------------------------
async function sendCampaignSms(client, body) {
  const { canSendSms, canAutomatedSend } = await import('./ai-followup/policy.js')
  const gate = canSendSms(client, { channel: 'automation' })
  if (!gate.ok) return { ok: false, reason: gate.reason }
  const auto = canAutomatedSend(client, { source: 'automation', dedupMinutes: 60 })
  if (!auto.ok) return { ok: false, reason: auto.reason }
  try {
    const { sendSms } = await import('./twilio.js')
    const out = String(body).replace(/[ \t]{2,}/g, ' ').trim()
    const r = await sendSms(client.phone, out, { statusCallback: HUB + '/api/inbox/twilio-status' })
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', client.id, name, '', client.phone, out.replace(/\s+/g, ' ').slice(0, 160), out, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'FB Listing AI', 'fb_listing_ai', nowIso()])
    return { ok: true, comm_id: ins.lastInsertRowid }
  } catch (e) { return { ok: false, reason: e.message } }
}

async function sendCampaignEmail(client, subject, paras) {
  try {
    const { sendSequenceEmail } = await import('./routes/email.js')
    const r = await sendSequenceEmail(client, { subject, body: emailHtml(String(client.first_name || '').trim() || 'there', paras) }, 'fb_listing_campaign')
    if (r?.ok === false) return { ok: false, reason: r.reason }
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

function advance(row, fromStep, { push = null } = {}) {
  const next = fromStep + 1
  if (next >= STEPS.length) {
    db.run("UPDATE fb_listing_campaigns SET status='completed', next_step=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [next, nowIso(), row.client_id])
    logC(row.client_id, 'completed', { reason: 'sequence finished (Day 30)' })
    return null
  }
  let at = stepDueAt(row.day0_at, next)
  if (push && push > at) at = nextFbSlot(push)
  db.run('UPDATE fb_listing_campaigns SET next_step=?, next_send_at=?, updated_at=? WHERE client_id=?', [next, at.toISOString(), nowIso(), row.client_id])
  return at
}

// Skip ahead past the property-specific steps after a pending/sold pivot.
function skipToBroader(row) {
  let step = row.next_step
  while (step < STEPS.length && STEPS[step].property) step++
  if (step >= STEPS.length) {
    db.run("UPDATE fb_listing_campaigns SET status='completed', next_send_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), row.client_id])
    return
  }
  const at = stepDueAt(row.day0_at, step)
  db.run('UPDATE fb_listing_campaigns SET next_step=?, next_send_at=?, updated_at=? WHERE client_id=?', [step, at.toISOString(), nowIso(), row.client_id])
}

let sweeping = false
export async function runFbListingCampaign() {
  if (!fbListingCampaignEnabled()) return { skipped: 'disabled' }
  if (sweeping) return { skipped: 'already running' }
  sweeping = true
  try {
    initFbListingCampaign()
    const out = { sent: 0, pivoted: 0, held: 0, stopped: 0, deferred: 0, window: inFbWindow() }

    // 1) RESPONSE STOPS FIRST — any inbound since day0 hands the lead to a human.
    for (const r of db.all("SELECT client_id, day0_at FROM fb_listing_campaigns WHERE status='active'")) {
      const replied = db.get("SELECT id FROM communications WHERE client_id=? AND direction='incoming' AND occurred_at >= ? LIMIT 1", [r.client_id, r.day0_at])
      if (replied) {
        db.run("UPDATE fb_listing_campaigns SET status='responded', next_send_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), r.client_id])
        logC(r.client_id, 'stopped', { reason: 'lead responded — human owns the conversation' })
        out.stopped++
      }
    }

    if (!inFbWindow()) return out
    const due = db.all("SELECT * FROM fb_listing_campaigns WHERE status='active' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT 30", [nowIso()])
    for (let i = 0; i < due.length; i++) {
      if (!fbListingCampaignEnabled() || !inFbWindow()) break
      const res = await sendNextStep(due[i])
      out[res] = (out[res] || 0) + 1
      if (i < due.length - 1 && res === 'sent') await new Promise(r => setTimeout(r, 60000 + Math.floor(Math.random() * 90000)))
    }
    return out
  } finally { sweeping = false }
}

async function sendNextStep(row) {
  const cid = row.client_id
  const c = db.get('SELECT * FROM clients WHERE id=? AND merged_into IS NULL', [cid])
  if (!c) { db.run("UPDATE fb_listing_campaigns SET status='stopped', stop_reason='client gone', next_send_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), cid]); return 'stopped' }
  const step = STEPS[row.next_step]
  if (!step) { db.run("UPDATE fb_listing_campaigns SET status='completed', next_send_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), cid]); return 'stopped' }
  const first = String(c.first_name || '').trim() || 'there'
  const prop = row.listing_label || 'the home you saw'
  const tx = row.tx_id ? db.get('SELECT id, property_status, purchase_price FROM transactions WHERE id=?', [row.tx_id]) : findListingTransaction(row.listing_label)
  const state = listingState(tx)

  // -- HIERARCHY 1: recent buyer behavior HOLDS the scheduled generic message.
  // Only the Day 14+ generic touches are held for behavior — a fresh registrant's
  // own signup activity must never suppress the early property messages.
  const hot = step.day >= 14 && db.get("SELECT id FROM behavioral_events WHERE client_id=? AND occurred_at >= ? LIMIT 1", [cid, new Date(Date.now() - 3 * DAY).toISOString()])
  if (hot) {
    try {
      const { notify } = await import('./notifications.js')
      notify({ type: 'fb_campaign_hot', title: `Hot behavior: ${first} ${c.last_name || ''}`.trim(),
        body: `Active on the site in the last 3 days — the scheduled ${step.key} touch was held. A personal reach-out beats the canned message.`,
        link: `/clients/${cid}`, client_id: cid, dedupKey: `fblc_hot_${cid}_${step.key}` })
    } catch {}
    logC(cid, 'held', { step_key: step.key, reason: 'recent behavioral activity — human follow-up instead', listing_status: state })
    advance(row, row.next_step)
    return 'held'
  }

  // -- HIERARCHY 2: property status change beats the scheduled property message.
  if (state === 'pending' && row.pivoted !== 'pending' && row.pivoted !== 'sold') {
    const r = await sendCampaignSms(c, PIVOT_TEXTS.pending(first, prop))
    if (!r.ok) return defer(row, r.reason)
    db.run("UPDATE fb_listing_campaigns SET pivoted='pending', last_known_status='pending', last_sent_at=?, updated_at=? WHERE client_id=?", [nowIso(), nowIso(), cid])
    logC(cid, 'sent', { step_key: 'pivot_pending', listing_status: state, body: PIVOT_TEXTS.pending(first, prop), comm_id: r.comm_id })
    skipToBroader({ ...row, next_step: row.next_step })
    return 'pivoted'
  }
  if (state === 'sold' && row.pivoted !== 'sold') {
    const r = await sendCampaignSms(c, PIVOT_TEXTS.sold(first, prop))
    if (!r.ok) return defer(row, r.reason)
    db.run("UPDATE fb_listing_campaigns SET pivoted='sold', last_known_status='sold', last_sent_at=?, updated_at=? WHERE client_id=?", [nowIso(), nowIso(), cid])
    logC(cid, 'sent', { step_key: 'pivot_sold', listing_status: state, body: PIVOT_TEXTS.sold(first, prop), comm_id: r.comm_id })
    skipToBroader({ ...row, next_step: row.next_step })
    return 'pivoted'
  }
  // Price change while active: a legitimate reconnect, once per price; the next
  // scheduled touch moves out 3 days so it doesn't crowd this one.
  if (state === 'active' && tx?.purchase_price && row.last_known_price && Number(tx.purchase_price) !== Number(row.last_known_price) && Number(tx.purchase_price) !== Number(row.price_notified_at || 0)) {
    const body = PIVOT_TEXTS.price(first, prop, fmtPrice(tx.purchase_price))
    const r = await sendCampaignSms(c, body)
    if (!r.ok) return defer(row, r.reason)
    db.run('UPDATE fb_listing_campaigns SET last_known_price=?, price_notified_at=?, last_sent_at=?, next_send_at=?, updated_at=? WHERE client_id=?',
      [tx.purchase_price, tx.purchase_price, nowIso(), nextFbSlot(new Date(Date.now() + 3 * DAY)).toISOString(), nowIso(), cid])
    logC(cid, 'sent', { step_key: 'price_update', listing_status: state, body, comm_id: r.comm_id })
    return 'pivoted'
  }
  if (tx?.purchase_price && !row.last_known_price) db.run('UPDATE fb_listing_campaigns SET last_known_price=? WHERE client_id=?', [tx.purchase_price, cid])

  // A property-specific step after a pivot no longer makes sense — skip forward.
  if (step.property && row.pivoted) { skipToBroader(row); return 'held' }

  // -- HIERARCHY 3: the scheduled step.
  if (step.ch === 'sms') {
    const r = await sendCampaignSms(c, step.text(first, prop))
    if (!r.ok) return defer(row, r.reason)
    db.run('UPDATE fb_listing_campaigns SET last_sent_at=?, last_known_status=?, updated_at=? WHERE client_id=?', [nowIso(), state, nowIso(), cid])
    logC(cid, 'sent', { step_key: step.key, listing_status: state, body: step.text(first, prop), comm_id: r.comm_id })
    advance(row, row.next_step)
    return 'sent'
  }
  // email step
  if (!c.email) { logC(cid, 'held', { step_key: step.key, reason: 'no email on file' }); advance(row, row.next_step); return 'held' }
  const r = await sendCampaignEmail(c, step.subject(prop), step.paras(first, prop))
  if (!r.ok) return defer(row, r.reason)
  db.run('UPDATE fb_listing_campaigns SET last_sent_at=?, last_known_status=?, updated_at=? WHERE client_id=?', [nowIso(), state, nowIso(), cid])
  logC(cid, 'sent', { step_key: step.key, listing_status: state, body: step.subject(prop), comm_id: null })
  advance(row, row.next_step)
  return 'sent'
}

function defer(row, reason) {
  const push = nextFbSlot(new Date(Date.now() + DAY)).toISOString()
  db.run('UPDATE fb_listing_campaigns SET next_send_at=?, updated_at=? WHERE client_id=?', [push, nowIso(), row.client_id])
  logC(row.client_id, 'deferred', { step_key: STEPS[row.next_step]?.key, reason: String(reason || '').slice(0, 200), next_send_at: push })
  return 'deferred'
}

// ---- controls -------------------------------------------------------------
export function pauseFbListingCampaign(cid, by = 'agent') {
  db.run("UPDATE fb_listing_campaigns SET status='paused', updated_at=? WHERE client_id=?", [nowIso(), Number(cid)])
  logC(Number(cid), 'paused', { reason: by }); return { ok: true }
}
export function resumeFbListingCampaign(cid, by = 'agent') {
  const row = db.get('SELECT * FROM fb_listing_campaigns WHERE client_id=?', [Number(cid)])
  if (!row) return { ok: false, reason: 'not enrolled' }
  const at = stepDueAt(row.day0_at, Math.min(row.next_step, STEPS.length - 1)).toISOString()
  db.run("UPDATE fb_listing_campaigns SET status='active', next_send_at=?, stop_reason=NULL, updated_at=? WHERE client_id=?", [at, nowIso(), Number(cid)])
  logC(Number(cid), 'resumed', { reason: by, next_send_at: at }); return { ok: true, next_send_at: at }
}
export function removeFromFbListingCampaign(cid, by = 'agent', reason = '') {
  db.run("UPDATE fb_listing_campaigns SET status='stopped', stop_reason=?, next_send_at=NULL, updated_at=? WHERE client_id=?", [('removed: ' + (reason || by)).slice(0, 200), nowIso(), Number(cid)])
  logC(Number(cid), 'stopped', { reason: 'removed by ' + by + (reason ? ': ' + reason : '') }); return { ok: true }
}
export function fbListingCampaignState(cid) {
  const row = db.get('SELECT * FROM fb_listing_campaigns WHERE client_id=?', [Number(cid)])
  if (!row) return null
  return { ...row, next_step_key: STEPS[row.next_step]?.key || null, log: db.all('SELECT * FROM fb_listing_campaign_log WHERE client_id=? ORDER BY id DESC LIMIT 25', [Number(cid)]) }
}
export function fbListingCampaignStats() {
  initFbListingCampaign()
  const by = {}
  for (const r of db.all('SELECT status, COUNT(*) c FROM fb_listing_campaigns GROUP BY status')) by[r.status] = r.c
  return { enabled: fbListingCampaignEnabled(), by_status: by,
    upcoming: db.all(`SELECT f.client_id, c.first_name, c.last_name, f.listing_label, f.next_step, f.next_send_at FROM fb_listing_campaigns f
      JOIN clients c ON c.id=f.client_id WHERE f.status='active' ORDER BY f.next_send_at ASC LIMIT 20`)
      .map(r => ({ ...r, next_step_key: STEPS[r.next_step]?.key || null })) }
}
export { STEPS as FB_LISTING_STEPS, PIVOT_TEXTS as FB_LISTING_PIVOTS }
