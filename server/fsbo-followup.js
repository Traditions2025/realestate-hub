// FSBO AI smart follow-up sequence. Scripted, compliance-gated outreach to Available
// FSBOs, keyed to days-on-market (DOM):
//   Step 1 (DOM >= 15): availability check.
//   On reply: canned response, then ~7 min later ask for their best email.
//   Step 2 (+7 days): the 35-years / first-14-days message.
//   Step 3 (+7 days): still-available check.
// Proactive sends only on WEEKDAYS 9AM-4PM Central. Replies are answered any time.
import db from './database.js'

const nowIso = () => new Date().toISOString()
const HUB = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'

export function fsboEnabled() { return db.getSetting?.('fsbo_followup_enabled') === '1' }   // OFF until explicitly turned on (prevents an accidental mass-text)

// Central-time parts.
function chi() {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
  const g = (t) => p.find(x => x.type === t)?.value
  return { weekday: g('weekday'), hour: Number(g('hour')) === 24 ? 0 : Number(g('hour')), minute: Number(g('minute')) }
}
// Weekday 9AM-4PM Central (through the 4 o'clock hour).
function inProactiveWindow() {
  const c = chi()
  if (['Sat', 'Sun'].includes(c.weekday)) return false
  return c.hour >= 9 && c.hour < 17
}
// Greeting: never "evening" (we don't text then). At 4PM+ just "Hello".
function greeting() { const h = chi().hour; return h < 12 ? 'Good morning' : h < 16 ? 'Good afternoon' : 'Hello' }
const dom = (c) => { const n = parseInt(String(c.fsbo_dom || '').replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n }
const daysSince = (ts) => ts ? (Date.now() - new Date(String(ts).replace(' ', 'T') + (String(ts).includes('Z') ? '' : 'Z')).getTime()) / 86400000 : 999

// ---- message templates ----
function street(c) { return c.address || 'your home' }
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

// ---- send helper (compliance-gated, logged like an AI text) ----
async function sendFsbo(client, body, { proactive = true } = {}) {
  const { canSendSms } = await import('./ai-followup/policy.js')
  const gate = canSendSms(client, { channel: 'ai', mode: proactive ? 'proactive' : 'responsive', force: !proactive })
  if (!gate.ok) return { ok: false, reason: gate.reason }
  try {
    const { sendSms } = await import('./twilio.js')
    const out = String(body).replace(/[ \t]{2,}/g, ' ').trim()
    const r = await sendSms(client.phone, out, { statusCallback: HUB + '/api/inbox/twilio-status' })
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', client.id, name, '', client.phone, out.replace(/\s+/g, ' ').slice(0, 160), out, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'FSBO AI', 'fsbo_ai', nowIso()])
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Send several texts to the same lead in order, spaced a few seconds apart so they
// arrive in sequence (Twilio doesn't guarantee ordering on back-to-back sends).
// Stops if any send is gated/fails; returns ok only if the FIRST text went out.
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

const fresh = (id) => db.get('SELECT * FROM clients WHERE id=?', [id])
const fu = (id) => db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [id])

// Eligible = an Available FSBO we can text (not junk/DNC/opted-out) with a phone.
function eligibleFsbos() {
  return db.all(`SELECT * FROM clients
    WHERE fsbo_status='Available' AND phone IS NOT NULL AND phone!=''
      AND (hub_text_opt_out IS NULL OR hub_text_opt_out=0)
      AND lower(status) NOT IN ('junk','donotcontact','closed','archived')
      AND merged_into IS NULL`)
}

// Main tick — enroll + advance the sequence. Proactive steps only fire in-window.
export async function runFsboFollowups() {
  if (!fsboEnabled()) return { skipped: 'disabled' }
  const window = inProactiveWindow()
  const out = { enrolled: 0, step1: 0, step2: 0, step3: 0, email_ask: 0, window }
  for (const c of eligibleFsbos()) {
    let row = fu(c.id)
    if (!row) {
      // If we've ALREADY texted this FSBO (manually or before), don't re-send the opener.
      // Enroll at step 1 dated to their earliest outbound text, so step 2 (+7 days) follows.
      const firstOut = db.get("SELECT MIN(occurred_at) m FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing'", [c.id])?.m
      if (firstOut) db.run("INSERT OR IGNORE INTO fsbo_followups (client_id, step, first_text_at, replied) VALUES (?,1,?,0)", [c.id, firstOut])
      else db.run('INSERT OR IGNORE INTO fsbo_followups (client_id) VALUES (?)', [c.id])
      row = fu(c.id); out.enrolled++
    }
    if (row.status !== 'active') continue

    // Email ask (after a reply) — send when due, in-window.
    if (window && row.email_ask_at && !row.email_asked && daysSince(row.email_ask_at) >= 0) {
      const r = await sendFsbo(c, MSG_EMAIL_ASK, { proactive: false })
      if (r.ok) { db.run("UPDATE fsbo_followups SET email_asked=1, email_ask_at=NULL, updated_at=? WHERE client_id=?", [nowIso(), c.id]); out.email_ask++ }
    }
    if (!window) continue

    if (row.step === 0 && dom(c) >= 15) {
      const r = await sendFsbo(c, msgStep1(c))
      if (r.ok) { db.run("UPDATE fsbo_followups SET step=1, first_text_at=?, updated_at=? WHERE client_id=?", [nowIso(), nowIso(), c.id]); out.step1++ }
    } else if (row.step === 1 && daysSince(row.first_text_at) >= 7) {
      const r = await sendFsboSeq(c, MSG_STEP2)
      if (r.ok) { db.run("UPDATE fsbo_followups SET step=2, step2_at=?, updated_at=? WHERE client_id=?", [nowIso(), nowIso(), c.id]); out.step2++ }
    } else if (row.step === 2 && daysSince(row.step2_at) >= 7) {
      const r = await sendFsbo(c, msgStep3(c))
      if (r.ok) { db.run("UPDATE fsbo_followups SET step=3, step3_at=?, status='done', updated_at=? WHERE client_id=?", [nowIso(), nowIso(), c.id]); out.step3++ }
    }
  }
  return out
}

const OPTOUT_RE = /\b(stop|unsubscribe|not interested|remove me|leave me alone|do not contact|quit)\b/i
const BUYER_Q_RE = /\b(buyer|do you have|are you interested|interested in|want to (see|buy|tour|view)|see the|show|tour|showing|offer|represent|are you an? agent|working with)\b/i

// Handle an inbound reply from an FSBO in the sequence. Returns true if we handled it.
export async function handleFsboReply(clientId, body) {
  if (!fsboEnabled()) return false
  const row = fu(clientId)
  if (!row || row.status !== 'active' || row.step < 1) return false
  const c = fresh(clientId); if (!c) return false
  const text = String(body || '')
  db.run("UPDATE fsbo_followups SET replied=1, updated_at=? WHERE client_id=?", [nowIso(), clientId])
  if (OPTOUT_RE.test(text)) { db.run("UPDATE fsbo_followups SET status='stopped' WHERE client_id=?", [clientId]); return false }  // let policy/opt-out handle it
  // Canned response to the availability check.
  const reply = BUYER_Q_RE.test(text) ? MSG_BUYER_Q : MSG_POSITIVE
  await sendFsbo(c, reply, { proactive: false })
  // Then ask for their best email ~7 min later (once), if we haven't yet.
  if (!row.email_asked && !row.email_ask_at) {
    const when = new Date(Date.now() + 7 * 60000).toISOString()
    db.run("UPDATE fsbo_followups SET email_ask_at=?, updated_at=? WHERE client_id=?", [when, nowIso(), clientId])
  }
  return true
}

// Daily 9:30 job: refresh the master file so the Hub FSBO list mirrors the sheet 1:1.
// Off Market FSBOs STAY on the list (labeled Off Market via the FSBO Status column) — they
// are never junked. They're simply excluded from the text sequence, which only targets
// Available FSBOs, so an Off Market listing is never messaged even mid-sequence.
export async function fsboDailyMaintenance() {
  const rep = { synced: false, errors: 0 }
  try {
    const { syncFsboMaster, ensureFsboListIncludesMaster } = await import('./fsbo-master.js')
    const r = await syncFsboMaster(); ensureFsboListIncludesMaster()
    rep.synced = true; rep.sheet_rows = r.sheet_rows; rep.created = r.created; rep.updated = r.updated
  } catch (e) { rep.errors++ }
  // Stop the sequence for anyone who has gone Off Market (don't keep an active enrollment),
  // without touching their lead status — they remain on the list.
  db.run("UPDATE fsbo_followups SET status='stopped' WHERE status='active' AND client_id IN (SELECT id FROM clients WHERE fsbo_status='Off Market')")
  db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
    ['fsbo_daily', 'fsbo', `Master synced (${rep.sheet_rows || 0} rows). Off Market kept on list.${rep.errors ? ` ${rep.errors} errors.` : ''}`])
  return rep
}
