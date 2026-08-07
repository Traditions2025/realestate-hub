// =====================================================================
// AI FOLLOW-UP RECOMMENDATIONS
// Adds a "Suggested Follow-Up" intelligence layer to the client dashboard.
// Blends HUB client data with Follow Up Boss (FUB) communication history,
// then asks Claude for: a recommended next action, the factual context
// behind it, a short relationship summary, and (when appropriate) a warm,
// specific follow-up email.
//
// Cost/perf: the AI runs only on explicit analyze/refresh, never on plain
// dashboard loads. The result + the FUB bundle it was built from are cached
// per client. GET returns the cache instantly and flags when new activity
// has landed since the last analysis so the UI can invite a refresh.
// =====================================================================
import { Router } from 'express'
import Anthropic from '@anthropic-ai/sdk'
import db from '../database.js'
import { fubGet, fubConfigured } from '../fub-helper.js'

const router = Router()
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'
let _client = null
function getClient() {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) return null
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// One row per client. Cached analysis + the FUB bundle it was built from.
try {
  db.run(`CREATE TABLE IF NOT EXISTS followup_recommendations (
    client_id INTEGER PRIMARY KEY,
    data TEXT,
    fub_data TEXT,
    fingerprint TEXT,
    analyzed_at TEXT
  )`)
} catch (e) { console.error('[followup] table init:', e.message) }

const nowIso = () => new Date().toISOString()
const centralToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())

// ---- helpers ------------------------------------------------------------
// Team rule: never em/en dashes in any generated writing. Belt-and-suspenders
// with the prompt rule — a spaced dash becomes a comma, a bare one a comma too.
const noDash = (s) => String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ').replace(/ ,/g, ',').replace(/,\s*,/g, ',')
function scrubDashes(data) {
  if (!data || typeof data !== 'object') return data
  if (data.summary) data.summary = noDash(data.summary)
  if (data.recommendation) { data.recommendation.label = noDash(data.recommendation.label); data.recommendation.rationale = noDash(data.recommendation.rationale) }
  if (Array.isArray(data.why)) data.why = data.why.map(noDash)
  if (Array.isArray(data.known)) data.known = data.known.map(noDash)
  if (data.email) { data.email.subject = noDash(data.email.subject); data.email.body = noDash(data.email.body) }
  return data
}

const firstArray = (o) => (o && typeof o === 'object' && !o.__error) ? (Object.values(o).find(Array.isArray) || []) : []
const clip = (s, n = 600) => { const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const dt = (s) => s ? String(s).slice(0, 10) : ''

// A cheap fingerprint of "has anything meaningful changed" — computed from the
// DB only (no FUB calls), so GET stays fast. If it differs from the stored
// fingerprint the cached analysis is flagged stale.
function activityFingerprint(client) {
  const act = db.get('SELECT COUNT(*) c, MAX(occurred_at) m FROM fub_activity WHERE client_id = ?', [client.id]) || {}
  return [
    client.status || '', client.updated_at || '', client.last_fub_activity_at || '',
    (client.notes || '').length, act.c || 0, act.m || '',
  ].join('|')
}

// Pull the client's FUB communication history. Every endpoint is optional and
// isolated — a 403/404/rate-limit on one never sinks the rest.
async function gatherFub(personId) {
  if (!personId || !fubConfigured()) return { available: false }
  const safe = async (fn) => { try { return await fn() } catch (e) { return { __error: e.status || e.message } } }
  const [person, notes, calls, emails, texts, tasks, appts, events] = await Promise.all([
    safe(() => fubGet(`/people/${personId}`, { fields: 'name,stage,source,tags,assignedTo,contacted,created,updated,price,lastActivity' })),
    safe(() => fubGet('/notes', { personId, limit: 20, sort: '-created' })),
    safe(() => fubGet('/calls', { personId, limit: 20, sort: '-created' })),
    safe(() => fubGet('/emails', { personId, limit: 12, sort: '-created' })),
    safe(() => fubGet('/textMessages', { personId, limit: 20, sort: '-created' })),
    safe(() => fubGet('/tasks', { personId, limit: 15, sort: '-created' })),
    safe(() => fubGet('/appointments', { personId, limit: 10, sort: '-created' })),
    safe(() => fubGet('/events', { personId, limit: 30, sort: '-created' })),
  ])
  return { available: true, person: person && !person.__error ? person : null,
    notes: firstArray(notes), calls: firstArray(calls), emails: firstArray(emails),
    texts: firstArray(texts), tasks: firstArray(tasks), appts: firstArray(appts), events: firstArray(events) }
}

// Shape the HUB + FUB data into a compact, factual dossier for the model.
function buildDossier(client, fub) {
  const hubActivity = db.all(
    `SELECT type, prop_street, prop_city, prop_price, prop_mls, page_title, occurred_at
     FROM fub_activity WHERE client_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 15`, [client.id])

  const d = { today: centralToday(), hub: {}, fub: { available: !!fub.available } }
  d.hub = {
    name: `${client.first_name || ''} ${client.last_name || ''}`.trim(),
    type: client.type || null,               // buyer / seller / both
    status: client.status || null,            // hub stage
    source: client.source || null,
    agent_assigned: client.agent_assigned || null,
    city: client.city || null,
    budget: (client.budget_min || client.budget_max) ? `${client.budget_min || '?'}-${client.budget_max || '?'}` : null,
    lead_score: client.lead_score || null,
    tags: (() => { try { return JSON.parse(client.tags || '[]') } catch { return [] } })(),
    created: dt(client.sierra_creation_date),
    last_web_activity: client.last_fub_activity_at ? `${dt(client.last_fub_activity_at)}: ${client.last_fub_activity_type || ''} ${client.last_fub_activity_detail || ''}`.trim() : null,
    marketing_opt_out: !!client.marketing_email_opt_out,
    short_summary: clip(client.short_summary, 300) || null,
    hub_notes: clip(client.notes, 1500) || null,
    recent_web: hubActivity.map(a => ({ when: dt(a.occurred_at), what: a.type, prop: a.prop_street ? `${a.prop_street}, ${a.prop_city || ''}${a.prop_price ? ' $' + a.prop_price : ''}` : (a.page_title || '') })),
  }
  if (fub.available) {
    const p = fub.person || {}
    d.fub.profile = { stage: p.stage || null, source: p.source || null,
      tags: Array.isArray(p.tags) ? p.tags : [],
      assigned: p.assignedTo?.name || p.assignedUserName || null,
      last_activity: dt(p.lastActivity) || null, contacted: p.contacted ?? null }
    d.fub.notes = (fub.notes || []).slice(0, 15).map(x => ({ when: dt(x.created), by: x.createdBy?.name || x.author || '', body: clip(x.body, 500) }))
    d.fub.calls = (fub.calls || []).slice(0, 15).map(x => ({ when: dt(x.created), outcome: x.outcome || x.note || '', dur: x.duration || null, note: clip(x.note, 300) }))
    d.fub.emails = (fub.emails || []).slice(0, 10).map(x => ({ when: dt(x.created), subject: clip(x.subject, 160), from: x.from || (x.isIncoming ? 'client' : 'agent'), body: clip(x.body || x.snippet, 400) }))
    d.fub.texts = (fub.texts || []).slice(0, 15).map(x => ({ when: dt(x.created), dir: x.isIncoming ? 'in' : 'out', body: clip(x.message || x.body, 240) }))
    d.fub.tasks = (fub.tasks || []).slice(0, 10).map(x => ({ due: dt(x.dueDate), done: !!x.isCompleted, what: clip(x.name || x.description, 160) }))
    d.fub.appointments = (fub.appts || []).slice(0, 8).map(x => ({ when: dt(x.start || x.date), what: clip(x.title || x.description, 160) }))
    d.fub.timeline = (fub.events || []).slice(0, 20).map(x => ({ when: dt(x.created), what: x.type || x.name || '' }))
  }
  return d
}

// A rough "is there enough to work with" gate, so we don't spend a model call
// on a truly empty contact.
function hasSignal(dossier) {
  const h = dossier.hub, f = dossier.fub
  const c = (h.hub_notes ? 1 : 0) + (h.short_summary ? 1 : 0) + (h.recent_web?.length || 0) + (h.last_web_activity ? 1 : 0)
    + (f.notes?.length || 0) + (f.calls?.length || 0) + (f.emails?.length || 0) + (f.texts?.length || 0)
    + (f.appointments?.length || 0) + (f.tasks?.length || 0)
  return c >= 2
}

const SYSTEM = `You are the relationship-intelligence layer inside a real estate CRM for the Matt Smith Team (Cedar Rapids / Marion, Iowa; RE/MAX Concepts). You help the agent decide the single best next step with one client, using ONLY the client records provided.

HARD RULES
- Never use em dashes or en dashes anywhere in ANY text you produce (recommendation, why, summary, or email). Use commas, periods, or the word "to" instead.
- Never invent facts, dates, conversations, promises, or preferences. Use only what is in the data. If unsure, leave it out.
- Not every client needs outreach right now. If timing says wait, recommend waiting or no action.
- Base the read on the WHOLE relationship, not just the latest ping.
- Keep any "why" bullets strictly factual (dates, stated intentions, concerns) drawn from the records.
- Output MUST be a single valid JSON object and nothing else. No markdown, no commentary.

CHOOSING THE ANGLE (important)
- Properties the client viewed are ONE possible signal, not the default topic. Do NOT assume the follow-up should be about a listing or a home they browsed.
- Very often the strongest and most natural reason to reach out has nothing to do with a property: where their head is at, whether their timing has changed, a life update in the notes (job, family, move), an unanswered question, a promise someone made, a concern to address, a past client worth reconnecting with, or a simple relationship check-in.
- Only center a property when repeated, recent, specific behavior genuinely makes it the strongest signal. When the record is thin or mostly old browsing, prefer a relationship, timing, or life-context reason instead. Match the angle to what the whole record actually supports.

EMAIL (only when action is "send_email")
- Warm, approachable, conversational, personal, confident, helpful. Like a real person writing to someone they already know, not a corporate template.
- Do not force a property or listing into the email. If the strongest reason to reach out is timing, a life update, an open question, or just reconnecting, write about that instead.
- NEVER open with "Just following up", "Checking in", "I wanted to touch base", "Circling back", or "Hope this email finds you well". Open with the client's actual context instead.
- The goal is not always to book an appointment. Match the relationship stage (reopen the conversation, ask if timing changed, answer an open question, share a relevant property or market note, reconnect, offer help).
- No fake scarcity or pressure. No placeholders like [Name]. Do not include a signature (the app adds it).

JSON SHAPE
{
  "enough_data": boolean,
  "summary": string,                     // 1-2 sentence plain relationship summary, or ""
  "recommendation": {
    "action": "send_email|call|send_text|send_property|market_update|schedule_appointment|complete_task|wait|none",
    "label": string,                     // e.g. "Send a casual email"
    "rationale": string                  // 1-2 sentences, plain language, what to do and the tone to strike
  },
  "why": [string],                       // 2-5 short FACTUAL context bullets ("Last meaningful conversation: June 12")
  "known": [string],                     // optional: notable known facts (motivation, timeline, concerns), supported by records only
  "email": { "subject": string, "body": string } | null   // present only when action is send_email
}
If there is not enough history to be confident, set enough_data=false and leave recommendation.action="none".`

function promptFor(dossier, extra = '') {
  return `Today's date is ${dossier.today} (America/Chicago).\n\nCLIENT RECORDS (JSON):\n${JSON.stringify(dossier, null, 1)}\n\n${extra}Return the JSON object now.`
}

function parseJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const s = t.indexOf('{'), e = t.lastIndexOf('}')
  if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}

// ---- routes -------------------------------------------------------------

// Cached recommendation (fast; never calls the model or FUB).
router.get('/:clientId', (req, res) => {
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(req.params.clientId)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const row = db.get('SELECT * FROM followup_recommendations WHERE client_id = ?', [client.id])
  if (!row) return res.json({ exists: false, ai_available: !!process.env.ANTHROPIC_API_KEY, fub_available: fubConfigured() })
  let data = {}; try { data = JSON.parse(row.data || '{}') } catch {}
  scrubDashes(data)   // display dash-free even for analyses cached before the no-em-dash rule
  res.json({ exists: true, analyzed_at: row.analyzed_at, stale: row.fingerprint !== activityFingerprint(client),
    ai_available: !!process.env.ANTHROPIC_API_KEY, fub_available: fubConfigured(), ...data })
})

// Run (or re-run) the analysis. Pulls fresh FUB history, calls the model, caches.
router.post('/:clientId/analyze', async (req, res) => {
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(req.params.clientId)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const ai = getClient()
  if (!ai) return res.status(503).json({ error: 'AI is not configured (ANTHROPIC_API_KEY missing).' })

  try {
    const fub = await gatherFub(client.fub_person_id)
    const dossier = buildDossier(client, fub)
    if (!hasSignal(dossier)) {
      const data = { enough_data: false, summary: '', recommendation: { action: 'none', label: 'Not enough history yet', rationale: '' }, why: [], known: [], email: null }
      const fp = activityFingerprint(client); const at = nowIso()
      db.run(`INSERT INTO followup_recommendations (client_id, data, fub_data, fingerprint, analyzed_at) VALUES (?,?,?,?,?)
              ON CONFLICT(client_id) DO UPDATE SET data=excluded.data, fub_data=excluded.fub_data, fingerprint=excluded.fingerprint, analyzed_at=excluded.analyzed_at`,
        [client.id, JSON.stringify(data), JSON.stringify(dossier), fp, at])
      return res.json({ exists: true, analyzed_at: at, stale: false, fub_available: fub.available, ...data })
    }
    const msg = await ai.messages.create({ model: MODEL, max_tokens: 1600, system: SYSTEM, messages: [{ role: 'user', content: promptFor(dossier) }] })
    let data
    try { data = parseJson(msg.content?.[0]?.text || '') }
    catch { return res.status(502).json({ error: 'AI returned an unreadable response. Try refreshing.' }) }
    scrubDashes(data)
    // never email an opted-out contact
    if (client.marketing_email_opt_out && data.email) data.email = null

    const fp = activityFingerprint(client); const at = nowIso()
    db.run(`INSERT INTO followup_recommendations (client_id, data, fub_data, fingerprint, analyzed_at) VALUES (?,?,?,?,?)
            ON CONFLICT(client_id) DO UPDATE SET data=excluded.data, fub_data=excluded.fub_data, fingerprint=excluded.fingerprint, analyzed_at=excluded.analyzed_at`,
      [client.id, JSON.stringify(data), JSON.stringify(dossier), fp, at])
    try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['followup_analyzed', 'client', client.id, `AI follow-up: ${data.recommendation?.label || 'analyzed'}`]) } catch {}
    res.json({ exists: true, analyzed_at: at, stale: false, fub_available: fub.available, ...data })
  } catch (e) {
    console.error('[followup] analyze failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Rewrite / (re)generate the suggested email. Reuses the cached dossier so it
// stays grounded in the same client history without re-pulling FUB.
const EMAIL_INSTRUCTIONS = {
  regenerate: 'Write a fresh version, same intent, different wording and a new natural opening.',
  shorter: 'Make it noticeably shorter and tighter while keeping the personal hook.',
  casual: 'Make it warmer and more casual, like texting a friend, still professional enough to send.',
  direct: 'Make it more direct and to the point about the next step, without losing warmth.',
}
router.post('/:clientId/email', async (req, res) => {
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(req.params.clientId)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  if (client.marketing_email_opt_out) return res.status(400).json({ error: 'This client is opted out of marketing email.' })
  const ai = getClient()
  if (!ai) return res.status(503).json({ error: 'AI is not configured.' })
  const row = db.get('SELECT * FROM followup_recommendations WHERE client_id = ?', [client.id])
  if (!row) return res.status(400).json({ error: 'Run the analysis first.' })
  let dossier = {}; try { dossier = JSON.parse(row.fub_data || '{}') } catch {}

  // Free-text context/insight the agent typed (e.g. "the property is now pending").
  // Treated as a true, authoritative fact and allowed to change the email's purpose.
  const ctx = String(req.body?.context || '').trim().slice(0, 800)
  const preset = EMAIL_INSTRUCTIONS[req.body?.instruction]
  const instruction = ctx
    ? `The agent added this real, up-to-the-minute context or insight. Treat it as TRUE and important, and rework the email so it genuinely fits it (even if it changes the purpose of the message, e.g. a property being pending or sold, a timing change, a new concern): "${ctx}".`
    : (preset || 'Write the follow-up email.')
  const current = req.body?.current
  const extra = `TASK: Draft a follow-up EMAIL to this client. ${instruction}\n`
    + (current?.body ? `\nCURRENT DRAFT (revise this):\nSubject: ${current.subject || ''}\n${current.body}\n` : '')
    + `\nReturn ONLY JSON: {"email":{"subject":string,"body":string}}. Follow the tone + no-em-dash rules from the system prompt (warm, specific, no generic openers, no signature).\n`
  try {
    const msg = await ai.messages.create({ model: MODEL, max_tokens: 900, system: SYSTEM, messages: [{ role: 'user', content: promptFor(dossier, extra) }] })
    let out; try { out = parseJson(msg.content?.[0]?.text || '') } catch { return res.status(502).json({ error: 'AI returned an unreadable email.' }) }
    const email = out.email || out
    if (!email || !email.body) return res.status(502).json({ error: 'No email produced.' })
    email.subject = noDash(email.subject); email.body = noDash(email.body)
    // persist the latest email back into the cached recommendation
    try { const data = JSON.parse(row.data || '{}'); data.email = email; db.run('UPDATE followup_recommendations SET data = ? WHERE client_id = ?', [JSON.stringify(data), client.id]) } catch {}
    res.json({ email })
  } catch (e) {
    console.error('[followup] email failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Reusable AI + context building blocks for other features (e.g. the Inbox
// suggested-reply). Same Claude client, FUB pull, dossier, and dash scrubbing.
export { MODEL as AI_MODEL, getClient as getAiClient, gatherFub, buildDossier, noDash }

export default router
