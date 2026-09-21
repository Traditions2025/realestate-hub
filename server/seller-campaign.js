// META SELLER CAMPAIGN — "Fix It or Skip It" family (John, 2026-09-19).
//
// Both current Meta campaigns feed one seller-offer family while the EXACT
// campaign/ad string is preserved for creative-level reporting:
//   "SELLER | Fix It or Skip It"
//   "Kitchen creative | Fix It or Skip It Walkthrough"
//
// The goal is not collecting leads — it's identifying homeowners who may sell,
// starting a REAL conversation fast (using the answers they already gave, never
// a generic "thanks for your interest"), alerting the team, and tracking each
// ad through to walkthroughs, signed listings, and closings.
//
// Doctrine (existing house rules):
//   - Dedupe phone → email, never name (ingestFbLead already does this).
//   - A reply on any channel STOPS automated conversation — humans own it.
//   - Active/Prime/Pending/Closed contacts never re-enter automation: they get
//     a Seller Intent Detected activity + task + notification only.
//   - Statuses are never changed by this module. Fields/tags do segmentation.
//   - First-touch source is never overwritten; the submission is recorded as
//     the latest conversion with full attribution.
//   - 9-4 CT window 7 days a week (FB-ad weekend exemption) + quiet-hour +
//     STOP/DNT policy gates on every send.
import db from './database.js'
import { ctParts } from './scheduling.js'

// SEND WINDOWS (John, 2026-09-19): the weekend exemption applies ONLY to the
// FIRST reach-out. Day 0 may send any day of the week; Day 1/3/7 follow-ups are
// weekdays only. Both use the 9:00 AM - 7:00 PM Central window; policy quiet
// hours and STOP/DNT gates still apply on top.
export function inSellerWindow(d = new Date(), { firstTouch = false } = {}) {
  const c = ctParts(d)
  if (!firstTouch && (c.weekday === 0 || c.weekday === 6)) return false
  return c.hour >= 9 && c.hour < 19
}
export function nextSellerSlot(from = new Date(), { firstTouch = false } = {}) {
  let d = new Date(from)
  for (let i = 0; i < 8; i++) {
    if (inSellerWindow(d, { firstTouch })) return d
    const c = ctParts(d)
    if (c.hour < 9) d = new Date(d.getTime() + ((9 - c.hour) * 60 - c.minute + Math.floor(Math.random() * 45)) * 60000)
    else d = new Date(d.getTime() + ((24 - c.hour + 9) * 60 - c.minute + Math.floor(Math.random() * 45)) * 60000)
  }
  return d
}

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
const DAY = 86400000

export const SELLER_FAMILY = 'Fix It or Skip It'
export const isSellerFamily = (s) => /fix.?it.?or.?skip/i.test(String(s || ''))
export function sellerCampaignEnabled() { return (db.getSetting?.('meta_seller_campaign_enabled') ?? '1') !== '0' }

export function initSellerCampaign() {
  db.run(`CREATE TABLE IF NOT EXISTS meta_seller_leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    campaign_raw TEXT,
    family TEXT,
    timeframe TEXT,
    improvement TEXT,
    availability TEXT,
    property TEXT,
    answers_json TEXT,
    existing_lead INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`)
  db.run(`CREATE TABLE IF NOT EXISTS fb_seller_followups (
    client_id INTEGER PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active',
    day0_at TEXT,
    next_step INTEGER NOT NULL DEFAULT 0,
    next_send_at TEXT,
    last_sent_at TEXT,
    stop_reason TEXT,
    updated_at TEXT
  )`)
  for (const [col, type] of [['seller_timeframe', 'TEXT'], ['seller_improvement', 'TEXT'], ['seller_availability', 'TEXT']]) {
    try { db.run(`ALTER TABLE clients ADD COLUMN ${col} ${type}`) } catch {}
  }
  try { db.run('CREATE INDEX IF NOT EXISTS idx_msl_client ON meta_seller_leads(client_id, created_at DESC)') } catch {}
  try { db.run('CREATE INDEX IF NOT EXISTS idx_msl_campaign ON meta_seller_leads(campaign_raw)') } catch {}
}

// ---------------------------------------------------------------------------
// FORM-ANSWER MINING — the FUB email body carries "Question?: answer" lines.
// Values are normalized to the canonical option sets so they report cleanly.
// ---------------------------------------------------------------------------
const TIMEFRAMES = [
  [/within\s*3|0\s*-?\s*3|1\s*-?\s*3|asap|right away|immediately/i, 'Within 3 months'],
  [/3\s*-?\s*6/i, '3-6 months'],
  [/6\s*-?\s*12|6\s*months|within.*year/i, '6-12 months'],
  [/more than a year|12\s*\+|over a year|year\s*\+|next year/i, 'More than a year'],
  [/explor|just curious|browsing|not sure when/i, 'Just exploring'],
]
const IMPROVEMENTS = [
  [/kitchen/i, 'Kitchen'], [/bath/i, 'Bathrooms'], [/floor/i, 'Flooring'], [/paint/i, 'Paint'],
  [/exterior|landscap/i, 'Exterior / landscaping'], [/several/i, 'Several things'], [/not sure/i, 'Not sure yet'],
]
const AVAILABILITY = [
  [/weekday morning/i, 'Weekday mornings'], [/weekday afternoon/i, 'Weekday afternoons'],
  [/weekday evening/i, 'Weekday evenings'], [/saturday/i, 'Saturday'], [/flexible/i, "I'm flexible"],
]
const norm = (raw, table) => { for (const [re, v] of table) if (re.test(String(raw || ''))) return v; return null }

export function mineSellerAnswers(raw) {
  const t = String(raw || '')
  const line = (re) => { const m = t.match(re); return m ? String(m[1]).trim().replace(/_/g, ' ') : '' }
  const timeframe = norm(line(/(?:time ?frame|how soon|when).{0,40}(?:sell|mov)[^:]*:\s*([^\n]{2,60})/i) || t.match(/(?:sell|mov)[^\n]{0,60}?:\s*([^\n]{2,60})/i)?.[1] || '', TIMEFRAMES)
  const improvement = norm(line(/(?:updat|improv)[^:]*:\s*([^\n]{2,60})/i), IMPROVEMENTS)
  const availability = norm(line(/(?:walkthrough|easiest|walk-?through)[^:]*:\s*([^\n]{2,60})/i) || line(/when would[^:]*:\s*([^\n]{2,60})/i), AVAILABILITY)
  const property = line(/(?:property )?address[^:]*:\s*([^\n]{5,120})/i) || null
  return { timeframe, improvement, availability, property }
}

export const priorityForTimeframe = (tf) => ({
  'Within 3 months': 'PRIORITY 1', '3-6 months': 'PRIORITY 2', '6-12 months': 'PRIORITY 3',
  'More than a year': 'NURTURE', 'Just exploring': 'EARLY',
}[tf] || 'UNRANKED')

const emit = (event, clientId, extra = {}) => {
  try {
    db.run('INSERT OR IGNORE INTO automation_events (event_type, client_id, dedupe_key, payload) VALUES (?,?,?,?)',
      [event, clientId, `${event}_${clientId}_${extra.at || nowIso().slice(0, 10)}`, JSON.stringify(extra)])
  } catch {}
}

// ---------------------------------------------------------------------------
// INTAKE — called from ingestFbLead's seller branch for every family submission.
// ---------------------------------------------------------------------------
export function handleSellerLead({ client_id, campaign_raw = '', raw_text = '', isExisting = false }) {
  initSellerCampaign()
  const cid = Number(client_id)
  const c = db.get('SELECT * FROM clients WHERE id = ?', [cid])
  if (!c) return { ok: false, reason: 'no client' }
  const a = mineSellerAnswers(raw_text)
  const property = a.property || [c.address, c.city].filter(Boolean).join(', ') || null

  // One submission row per lead per campaign per day (idempotent on email retries).
  const dup = db.get("SELECT id FROM meta_seller_leads WHERE client_id = ? AND campaign_raw = ? AND created_at >= datetime('now','-1 day')", [cid, campaign_raw])
  if (!dup) {
    db.run(`INSERT INTO meta_seller_leads (client_id, campaign_raw, family, timeframe, improvement, availability, property, answers_json, existing_lead)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      [cid, String(campaign_raw).slice(0, 120), SELLER_FAMILY, a.timeframe, a.improvement, a.availability, property,
       JSON.stringify(a), isExisting ? 1 : 0])
  }
  // Structured, reportable fields on the client (fill, never blank out).
  db.run(`UPDATE clients SET seller_timeframe = COALESCE(?, seller_timeframe), seller_improvement = COALESCE(?, seller_improvement),
          seller_availability = COALESCE(?, seller_availability), updated_at = ? WHERE id = ?`,
    [a.timeframe, a.improvement, a.availability, nowIso(), cid])
  // Family tags alongside the exact-campaign tag ingestFbLead already added.
  try {
    let tags = []; try { tags = JSON.parse(db.get('SELECT tags FROM clients WHERE id=?', [cid]).tags || '[]') } catch {}
    for (const t of ['Seller', 'Meta Lead', SELLER_FAMILY]) if (!tags.includes(t)) tags.push(t)
    db.run('UPDATE clients SET tags = ? WHERE id = ?', [JSON.stringify(tags), cid])
  } catch {}

  const priority = priorityForTimeframe(a.timeframe)
  const summary = [
    `Campaign: ${campaign_raw || SELLER_FAMILY}`,
    a.timeframe ? `Seller timeframe: ${a.timeframe} (${priority})` : null,
    a.improvement ? `Considering updates: ${a.improvement}` : null,
    a.availability ? `Preferred walkthrough time: ${a.availability}` : null,
    property ? `Property: ${property}` : null,
  ].filter(Boolean).join('\n')
  try {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['meta_seller_lead', 'client', cid, `${isExisting ? 'SELLER INTENT DETECTED (existing contact)' : 'NEW META SELLER LEAD'} — Fix It or Skip It Walkthrough\n${summary}`])
  } catch {}
  emit('meta_seller_lead.received', cid, { campaign: campaign_raw, timeframe: a.timeframe, at: nowIso() })

  // The hot statuses never re-enter automation; a person handles them.
  const status = String(c.status || '').toLowerCase()
  const hot = ['active', 'prime', 'pending', 'closed'].includes(status)

  // Conflict rule: a buyer nurture must not run alongside seller outreach.
  try {
    const buyerCamp = db.get("SELECT status FROM fb_listing_campaigns WHERE client_id = ? AND status = 'active'", [cid])
    if (buyerCamp) {
      db.run("UPDATE fb_listing_campaigns SET status = 'paused', stop_reason = 'paused: seller intent detected (Fix It or Skip It)', updated_at = ? WHERE client_id = ?", [nowIso(), cid])
      db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
        ['automation', 'client', cid, 'Buyer listing campaign paused — seller intent detected (Fix It or Skip It). No conflicting messaging.'])
    }
  } catch {}
  try { import('./ai-followup/orchestrator.js').then(m => m.cancelPendingScheduled(cid, 'seller intent — Fix It or Skip It')).catch(() => {}) } catch {}
  // If the general AI already claimed this lead (the fresh sweep runs every few
  // minutes), release it: seller-campaign leads are never buyer-AI territory.
  try {
    import('./ai-followup/state.js').then(st => {
      st.setManaged(cid, false); st.setEnabled(cid, false)
      st.transitionAiState(cid, 'AI_DISABLED', 'Fix It or Skip It seller campaign owns this lead')
    }).catch(() => {})
  } catch {}

  // Task: same-business-day review, higher priority when the timeframe is near.
  const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'Lead'
  try {
    const taskTitle = isExisting || hot ? `Seller intent: ${name} (existing contact) — Fix It or Skip It` : `Review Fix It or Skip It seller lead — ${name}`
    if (!db.get("SELECT id FROM tasks WHERE title = ? AND status != 'done' AND created_at >= datetime('now','-1 day')", [taskTitle])) {
      db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [taskTitle,
         summary + (a.availability ? `\n\nWhen scheduling, use their answer: "You mentioned ${a.availability.toLowerCase()} usually work best…" — it's a preference, not a confirmed appointment.` : ''),
         priority === 'PRIORITY 1' || hot ? 'high' : 'medium', 'todo', nowIso().slice(0, 10), 'Matt', 'Seller Lead',
         'client', cid, nowIso(), nowIso()])
    }
  } catch {}
  try {
    import('./notifications.js').then(m => m.notify({
      type: 'seller_lead', title: `${isExisting ? 'Seller intent (existing): ' : 'META SELLER LEAD: '}${name}`,
      body: [a.timeframe && `${a.timeframe} · ${priority}`, a.improvement, campaign_raw].filter(Boolean).join(' · '),
      link: `/clients/${cid}`, client_id: cid, dedupKey: `msl_${cid}_${nowIso().slice(0, 10)}`,
    })).catch(() => {})
  } catch {}

  // Automated first touch only for leads a human isn't already working, with a
  // phone, who haven't already messaged us since submitting.
  if (!hot && c.phone && sellerCampaignEnabled()) {
    const replied = db.get("SELECT id FROM communications WHERE client_id = ? AND direction = 'incoming' AND occurred_at >= datetime('now','-1 hour') LIMIT 1", [cid])
    if (!replied) enrollSellerFollowup(cid)
  }

  // 12-month "Fix It or Skip It" seller EMAIL drip (John, 2026-09-21): EVERY family
  // lead enrolls, hot statuses included — the emails are low-pressure and the drip
  // pauses itself the moment they reply (pause_on_reply). Stop statuses / Not in
  // Market / hard email blocks are refused inside enrollInDrip. The campaign is
  // looked up by name so environments without it skip cleanly.
  try {
    const emailDrip = db.get("SELECT id FROM drip_campaigns WHERE name LIKE 'Fix It or Skip It%' ORDER BY id LIMIT 1")
    if (emailDrip) {
      import('./routes/drips.js').then(m => {
        const eid = m.enrollInDrip(emailDrip.id, cid, { source: 'fix_it_or_skip_it' })
        // Email 1 goes out promptly (~5 min) ONLY inside the email window — 9AM-5PM CT
        // (John, 2026-09-21). Outside it, the engine's own scheduling (the step's
        // send window on the next valid day) stands.
        if (eid) {
          const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date()))
          if (h >= 9 && h < 17) db.run("UPDATE drip_enrollments SET next_run_at = ? WHERE id = ? AND current_step = 0 AND status='active'", [new Date(Date.now() + 5 * 60000).toISOString(), eid])
        }
      }).catch(() => {})
    }
  } catch {}
  return { ok: true, timeframe: a.timeframe, improvement: a.improvement, availability: a.availability, priority, automated: !hot }
}

// ---------------------------------------------------------------------------
// CONTEXTUAL FIRST TEXT — John's copy, keyed to what they told us. Never a
// generic "thanks for your interest".
// ---------------------------------------------------------------------------
// Staff-editable copy: overrides live in the seller_campaign_copy setting
// (JSON: { openers: {Kitchen: "..."}, day1: "...", day3: "...", day7: "..." });
// code holds John's approved defaults so a developer is never needed for edits.
function copyOverrides() { try { return JSON.parse(db.getSetting?.('seller_campaign_copy') || '{}') } catch { return {} } }

export function sellerOpener(first, improvement) {
  const n = first || 'there'
  const ov = copyOverrides().openers || {}
  const key = improvement || '_missing'
  if (ov[key]) return ov[key].replaceAll('{{first_name}}', n)
  const base = `Hi ${n}, it's John with Matt Smith Team at RE/MAX. I saw your Fix It or Skip It request`
  switch (improvement) {
    case 'Kitchen':
      return `${base} and that you're considering some kitchen updates. Are you already planning to do the work, or are you mainly trying to figure out whether it's worth doing before you sell?`
    case 'Bathrooms':
      return `${base} and that you're considering some bathroom updates. Are you already planning the work, or are you still trying to decide what would actually be worth doing before you sell?`
    case 'Flooring':
      return `${base} and that flooring is one of the things you're considering. Are you leaning toward replacing it, or are you still trying to decide whether it's worth doing before you sell?`
    case 'Paint':
      return `${base} and that paint is one of the things you're considering. Are you thinking about repainting most of the home, or just trying to figure out which areas actually need it before you sell?`
    case 'Exterior / landscaping':
      return `${base} and that you're considering some exterior or landscaping work. Are you already planning specific projects, or are you mainly trying to figure out what's actually worth doing before you sell?`
    case 'Several things':
      return `${base} and that there are several things you're considering updating. Have you already started making a list, or are you still trying to figure out what's actually worth doing?`
    case 'Not sure yet':
      return `${base}. Are there any parts of the home you're already wondering about, or are you mainly looking for a second opinion before deciding what to touch?`
    default:
      return `${base}. Before you spend money on updates, what's the main thing you're unsure whether you should fix or leave alone?`
  }
}

const FOLLOWUP_DEFAULTS = {
  day1: `Just following up on the Fix It or Skip It request you sent over. Before you put money into the house, we can take a quick look and help you sort out what may be worth doing and what you may be better off leaving alone. Is there one project you're most unsure about?`,
  day3: `One quick question before I close the loop for now: are you thinking a move would happen in the next few months, later this year, or are you mostly planning ahead?`,
  day7: `Still happy to help whenever it becomes useful. Even if you're months away, it can help to know what not to spend money on before you sell.`,
}
const FOLLOWUPS = [null,
  () => copyOverrides().day1 || FOLLOWUP_DEFAULTS.day1,
  () => copyOverrides().day3 || FOLLOWUP_DEFAULTS.day3,
  () => copyOverrides().day7 || FOLLOWUP_DEFAULTS.day7,
]
const STEP_DAYS = [0, 1, 3, 7]

export function enrollSellerFollowup(cid) {
  const firstAt = new Date(Date.now() + 5 * 60000)   // ~5 min after the form, like the buyer opener
  db.run(`INSERT INTO fb_seller_followups (client_id, status, day0_at, next_step, next_send_at, updated_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT (client_id) DO UPDATE SET status='active', day0_at=excluded.day0_at, next_step=0, next_send_at=excluded.next_send_at, stop_reason=NULL, updated_at=excluded.updated_at`,
    [cid, 'active', nowIso(), 0, firstAt.toISOString(), nowIso()])
}

async function sendSellerSms(client, body) {
  try {
    const { canSendSms, canAutomatedSend } = await import('./ai-followup/policy.js')
    const gate = canSendSms(client, { channel: 'automation' })
    if (!gate.ok) return { ok: false, reason: gate.reason }
    const auto = canAutomatedSend(client, { source: 'automation', dedupMinutes: 60 })
    if (!auto.ok) return { ok: false, reason: auto.reason }
    const { sendSms } = await import('./twilio.js')
    const r = await sendSms(client.phone, body, { statusCallback: HUB + '/api/inbox/twilio-status' })
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', client.id, name, '', client.phone, body.slice(0, 160), body, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'Seller AI', 'seller_ai', nowIso()])
    return { ok: true, comm_id: ins.lastInsertRowid }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Post-send state advance, exported for the regression test. This UPDATE once had 5
// placeholders and only 4 params (2026-09-21): better-sqlite3 threw AFTER the SMS was
// out, the scheduler's catch() ate it, and the step never advanced — Luis got the same
// Day-0 opener 8 times on a 3-hour dedup-defer loop before it was caught.
export function advanceSellerStep(row, c) {
  const nextStep = row.next_step + 1
  if (nextStep >= STEP_DAYS.length) {
    // Sequence done, no reply → timeframe-based nurture: a dated human task,
    // never an automatic Not in Market.
    const tf = c.seller_timeframe || 'Just exploring'
    const weeks = NURTURE_TASK_WEEKS[tf] || 8
    const due2 = new Date(Date.now() + weeks * 7 * DAY).toISOString().slice(0, 10)
    db.run("UPDATE fb_seller_followups SET status = 'nurture', next_step = ?, next_send_at = NULL, last_sent_at = ?, updated_at = ? WHERE client_id = ?", [nextStep, nowIso(), nowIso(), row.client_id])
    try {
      db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [`Seller nurture check-in — ${`${c.first_name || ''} ${c.last_name || ''}`.trim()}`,
         `Fix It or Skip It lead, no reply to the 4-text opener sequence. Timeframe: ${tf}. Their walkthrough availability: ${c.seller_availability || 'unknown'}.`,
         'medium', 'todo', due2, 'Matt', 'Seller Lead', 'client', row.client_id, nowIso(), nowIso()])
    } catch {}
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['meta_seller_lead', 'client', row.client_id, `Fix It or Skip It sequence complete (no reply) — moved to ${tf} nurture; check-in task due ${due2}`])
    return 'nurtured'
  }
  const at = nextSellerSlot(new Date(new Date(row.day0_at).getTime() + STEP_DAYS[nextStep] * DAY)).toISOString()
  db.run('UPDATE fb_seller_followups SET next_step = ?, next_send_at = ?, last_sent_at = ?, updated_at = ? WHERE client_id = ?', [nextStep, at, nowIso(), nowIso(), row.client_id])
  return 'advanced'
}

const NURTURE_TASK_WEEKS = { 'Within 3 months': 1, '3-6 months': 3, '6-12 months': 6, 'More than a year': 8, 'Just exploring': 8 }

let sweeping = false
export async function runSellerFollowups() {
  if (!sellerCampaignEnabled()) return { skipped: 'disabled' }
  if (sweeping) return { skipped: 'running' }
  sweeping = true
  try {
    initSellerCampaign()
    const out = { sent: 0, stopped: 0, deferred: 0, nurtured: 0 }
    // HARD STOP CONDITIONS, checked every tick before any send:
    // reply (humans own it) > opt-out > status became hot > walkthrough scheduled.
    for (const r of db.all("SELECT client_id, day0_at, next_step FROM fb_seller_followups WHERE status = 'active'")) {
      const c = db.get('SELECT first_name, last_name, status, hub_text_opt_out FROM clients WHERE id = ?', [r.client_id])
      const name = `${c?.first_name || ''} ${c?.last_name || ''}`.trim()
      if (db.get("SELECT id FROM communications WHERE client_id = ? AND direction = 'incoming' AND occurred_at >= ? LIMIT 1", [r.client_id, r.day0_at])) {
        db.run("UPDATE fb_seller_followups SET status = 'responded', next_send_at = NULL, stop_reason = 'lead replied', updated_at = ? WHERE client_id = ?", [nowIso(), r.client_id])
        emit('meta_seller_lead.replied', r.client_id, { at: nowIso() })
        try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['meta_seller_lead', 'client', r.client_id, 'Fix It or Skip It Automation Stopped -- Reason: Lead Replied']) } catch {}
        try {
          db.run("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE related_id=? AND related_type='client' AND title LIKE 'Review Fix It or Skip It%' AND status != 'done'", [nowIso(), nowIso(), r.client_id])
          if (!db.get("SELECT id FROM tasks WHERE related_id=? AND title LIKE 'Respond to Fix It or Skip It%' AND status != 'done'", [r.client_id])) {
            db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
              [`Respond to Fix It or Skip It seller lead — ${name}`, 'They replied to the automated opener. The conversation is yours — automation is stopped.', 'high', 'todo', nowIso().slice(0, 10), 'Matt', 'Seller Lead', 'client', r.client_id, nowIso(), nowIso()])
          }
        } catch {}
        try { import('./notifications.js').then(m => m.notify({ type: 'seller_lead', title: `Seller lead replied: ${name}`, body: 'Automation stopped — the conversation is yours.', link: `/clients/${r.client_id}`, client_id: r.client_id, dedupKey: `msl_reply_${r.client_id}` })).catch(() => {}) } catch {}
        out.stopped++
        continue
      }
      if (c?.hub_text_opt_out) {
        db.run("UPDATE fb_seller_followups SET status = 'stopped', stop_reason = 'opted out', next_send_at = NULL, updated_at = ? WHERE client_id = ?", [nowIso(), r.client_id])
        out.stopped++; continue
      }
      if (['active', 'prime', 'pending', 'closed'].includes(String(c?.status || '').toLowerCase())) {
        db.run("UPDATE fb_seller_followups SET status = 'stopped', stop_reason = ?, next_send_at = NULL, updated_at = ? WHERE client_id = ?", ['status became ' + c.status, nowIso(), r.client_id])
        try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['meta_seller_lead', 'client', r.client_id, `Fix It or Skip It Automation Stopped -- Reason: status is now ${c.status} (being worked personally)`]) } catch {}
        out.stopped++; continue
      }
      const appt = db.get("SELECT id FROM calendar_events WHERE related_type='client' AND related_id=? AND appt_status IN ('scheduled','confirmed') AND created_at >= ? LIMIT 1", [r.client_id, r.day0_at])
      if (appt) {
        db.run("UPDATE fb_seller_followups SET status = 'stopped', stop_reason = 'appointment scheduled', next_send_at = NULL, updated_at = ? WHERE client_id = ?", [nowIso(), r.client_id])
        emit('fix_it_skip_it.appointment_scheduled', r.client_id, { at: nowIso() })
        try { db.run("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE related_id=? AND related_type='client' AND title LIKE 'Review Fix It or Skip It%' AND status != 'done'", [nowIso(), nowIso(), r.client_id]) } catch {}
        try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['meta_seller_lead', 'client', r.client_id, 'Fix It or Skip It Automation Stopped -- Reason: Walkthrough scheduled']) } catch {}
        out.stopped++; continue
      }
    }
    const due = db.all("SELECT * FROM fb_seller_followups WHERE status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= ? ORDER BY next_send_at ASC LIMIT 20", [nowIso()])
    for (let i = 0; i < due.length; i++) {
      const row = due[i]
      // Day 0 goes out promptly (policy quiet hours still gate it); later steps weekday-window only.
      // Day 0: any day 9AM-7PM CT (weekend exemption is FIRST-TOUCH only).
      // Day 1/3/7: weekdays 9AM-7PM CT.
      if (!inSellerWindow(new Date(), { firstTouch: row.next_step === 0 })) {
        if (row.next_step === 0) {
          const at = nextSellerSlot(new Date(), { firstTouch: true }).toISOString()
          if (at !== row.next_send_at) db.run('UPDATE fb_seller_followups SET next_send_at = ?, updated_at = ? WHERE client_id = ?', [at, nowIso(), row.client_id])
        }
        out.deferred++; continue
      }
      try {
        const c = db.get('SELECT * FROM clients WHERE id = ? AND merged_into IS NULL', [row.client_id])
        if (!c || !c.phone) { db.run("UPDATE fb_seller_followups SET status='stopped', stop_reason='no phone', next_send_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), row.client_id]); out.stopped++; continue }
        const body = row.next_step === 0 ? sellerOpener(c.first_name, c.seller_improvement) : FOLLOWUPS[row.next_step]()
        // SELF-HEAL (2026-09-21): if this exact text already went out to this lead, a prior
        // tick sent it and crashed before advancing. Never re-send the identical message —
        // advance the step as if the send just happened.
        const already = db.get("SELECT id FROM communications WHERE client_id = ? AND direction = 'outgoing' AND channel = 'text' AND body = ? LIMIT 1", [row.client_id, body])
        if (already) {
          if (row.next_step === 0) emit('meta_seller_lead.contacted', row.client_id, { at: nowIso() })
          const rr = advanceSellerStep(row, c)
          db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
            ['meta_seller_lead', 'client', row.client_id, `Seller step ${row.next_step} text was already sent (comm ${already.id}) — advanced without re-sending (${rr})`])
          out.repaired = (out.repaired || 0) + 1
          continue
        }
        const r = await sendSellerSms(c, body)
        if (!r.ok) {
          const push = nextSellerSlot(new Date(Date.now() + 3 * 3600000), { firstTouch: row.next_step === 0 }).toISOString()
          db.run('UPDATE fb_seller_followups SET next_send_at = ?, updated_at = ? WHERE client_id = ?', [push, nowIso(), row.client_id])
          out.deferred++; continue
        }
        if (row.next_step === 0) emit('meta_seller_lead.contacted', row.client_id, { at: nowIso() })
        if (advanceSellerStep(row, c) === 'nurtured') out.nurtured++
        out.sent++
        if (i < due.length - 1) await new Promise(res => setTimeout(res, 60000 + Math.floor(Math.random() * 90000)))
      } catch (e) {
        // One lead's failure must never kill the sweep — and never leave a sent-but-not-
        // advanced row hot: push it out so the next look is hours away, and record it.
        console.error('[seller-campaign] row error client', row.client_id, e.message)
        try {
          db.run('UPDATE fb_seller_followups SET next_send_at = ?, updated_at = ? WHERE client_id = ?',
            [nextSellerSlot(new Date(Date.now() + 3 * 3600000), { firstTouch: row.next_step === 0 }).toISOString(), nowIso(), row.client_id])
          db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
            ['meta_seller_lead', 'client', row.client_id, `Seller follow-up tick error (step ${row.next_step}): ${String(e.message).slice(0, 200)}`])
        } catch {}
        out.errors = (out.errors || 0) + 1
      }
    }
    return out
  } finally { sweeping = false }
}

// ---------------------------------------------------------------------------
// REPORTING — creative vs creative, all the way down the funnel. Business
// outcomes (walkthroughs, listings, closings) join through the client, so a
// creative is judged on what it produced, not its CPL.
// ---------------------------------------------------------------------------
export function sellerCampaignStats() {
  initSellerCampaign()
  const campaigns = db.all(`SELECT campaign_raw, COUNT(*) leads, SUM(existing_lead) existing FROM meta_seller_leads GROUP BY campaign_raw`)
  const rows = campaigns.map(cp => {
    const ids = db.all('SELECT DISTINCT client_id FROM meta_seller_leads WHERE campaign_raw = ?', [cp.campaign_raw]).map(r => r.client_id)
    const inList = ids.length ? `(${ids.join(',')})` : '(-1)'
    const n = (sql) => { try { return db.get(sql).c } catch { return 0 } }
    return {
      campaign: cp.campaign_raw, family: SELLER_FAMILY, leads: cp.leads, existing_contacts: cp.existing || 0,
      contacted: n(`SELECT COUNT(DISTINCT client_id) c FROM automation_events WHERE event_type='meta_seller_lead.contacted' AND client_id IN ${inList}`),
      replied: n(`SELECT COUNT(DISTINCT client_id) c FROM automation_events WHERE event_type='meta_seller_lead.replied' AND client_id IN ${inList}`),
      timeframes: db.all(`SELECT timeframe, COUNT(*) c FROM meta_seller_leads WHERE campaign_raw = ? AND timeframe IS NOT NULL GROUP BY timeframe`, [cp.campaign_raw]),
      walkthroughs_scheduled: n(`SELECT COUNT(*) c FROM calendar_events WHERE related_id IN ${inList} AND related_type='client' AND appt_status IS NOT NULL`),
      walkthroughs_held: n(`SELECT COUNT(*) c FROM calendar_events WHERE related_id IN ${inList} AND related_type='client' AND appt_status='completed'`),
      signed_or_active: n(`SELECT COUNT(*) c FROM clients WHERE id IN ${inList} AND lower(status) IN ('active','prime','pending')`),
      closed: n(`SELECT COUNT(*) c FROM clients WHERE id IN ${inList} AND lower(status) = 'closed'`),
    }
  })
  return { family: SELLER_FAMILY, campaigns: rows, sequence: Object.fromEntries(db.all('SELECT status, COUNT(*) c FROM fb_seller_followups GROUP BY status').map(r => [r.status, r.c])) }
}

export function sellerIntent(cid) {
  initSellerCampaign()
  const subs = db.all('SELECT * FROM meta_seller_leads WHERE client_id = ? ORDER BY id DESC LIMIT 5', [Number(cid)])
  if (!subs.length) return null
  const c = db.get('SELECT seller_timeframe, seller_improvement, seller_availability FROM clients WHERE id = ?', [Number(cid)])
  const seq = db.get('SELECT status, next_step, next_send_at FROM fb_seller_followups WHERE client_id = ?', [Number(cid)])
  return { ...c, priority: priorityForTimeframe(c?.seller_timeframe), family: SELLER_FAMILY, submissions: subs, sequence: seq || null }
}
