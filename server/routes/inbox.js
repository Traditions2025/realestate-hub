import { Router } from 'express'
import Busboy from 'busboy'
import db from '../database.js'
import { sendViaSendGrid } from './email.js'
import { getAiClient, gatherFub, buildDossier, noDash, AI_MODEL } from './followup.js'

const router = Router()
const nowIso = () => new Date().toISOString()
const stripHtml = (s) => String(s == null ? '' : s).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t }

// last-10-digit phone key (same rule the Sierra matcher uses)
function phoneKey(p) {
  if (!p) return null
  const digits = String(p).replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}
// Match an incoming sender to a hub client: email exact (case-insensitive) or phone.
function matchClient(channel, fromAddr) {
  if (!fromAddr) return null
  if (channel === 'email') {
    return db.get('SELECT id, first_name, last_name FROM clients WHERE lower(email) = lower(?) LIMIT 1', [String(fromAddr).trim()])
  }
  const k = phoneKey(fromAddr)
  if (!k) return null
  // match on the last 10 digits of the stored phone
  const rows = db.all("SELECT id, first_name, last_name, phone FROM clients WHERE phone IS NOT NULL AND phone != ''")
  for (const c of rows) if (phoneKey(c.phone) === k) return c
  return null
}

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Email John (or whoever inbox_notify_email is) when a client texts the Hub.
async function notifyInboundText(client, body, fromPhone) {
  try {
    const to = db.getSetting('inbox_notify_email', 'johnwithmattsmithteam@gmail.com') || ''
    if (!to) return
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim() || fromPhone
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
      <p style="margin:0 0 10px;"><strong>${escHtml(name)}</strong> just texted the Hub.</p>
      <p style="margin:0 0 4px;"><strong>From:</strong> ${escHtml(fromPhone)}</p>
      <p style="margin:8px 0;background:#f1f5f9;padding:10px 12px;border-radius:8px;">${escHtml(body).slice(0, 600)}</p>
      <p style="margin:6px 0 0;color:#64748b;font-size:12px;">Reply from the Hub Inbox.</p></div>`
    await sendViaSendGrid(to, 'Matt Smith Team', `New text from ${name}`, html, null, [], [], [], 'inbox_notify')
  } catch {}
}

const CHANNELS = ['email', 'text', 'call', 'voicemail']

// ---- list: grouped into conversations by contact (like the FUB inbox) ----
router.get('/', (req, res) => {
  const folder = req.query.folder || 'inbox'         // inbox | sent | closed
  const unreadOnly = req.query.unread === '1'
  const channels = String(req.query.channels || '').split(',').filter(c => CHANNELS.includes(c))
  const q = (req.query.q || '').trim().toLowerCase()

  const where = []
  const params = []
  if (folder === 'sent') where.push("direction = 'outgoing'")
  else if (folder === 'closed') where.push("status = 'closed'")
  else where.push("direction = 'incoming' AND status != 'closed'")   // inbox
  if (unreadOnly) where.push("status = 'unread'")
  if (channels.length) { where.push(`channel IN (${channels.map(() => '?').join(',')})`); params.push(...channels) }
  const sql = `SELECT * FROM communications WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT 1000`
  let rows = db.all(sql, params)
  if (q) rows = rows.filter(r => `${r.contact_name} ${r.subject} ${r.preview}`.toLowerCase().includes(q))

  // group by client into conversation threads
  const threads = new Map()
  for (const r of rows) {
    const key = r.client_id || `x_${r.from_addr}`
    if (!threads.has(key)) {
      threads.set(key, {
        client_id: r.client_id, contact_name: r.contact_name || 'Unknown',
        last: r, msg_count: 0, unread_count: 0, channels: new Set(),
      })
    }
    const t = threads.get(key)
    t.msg_count++
    if (r.status === 'unread') t.unread_count++
    t.channels.add(r.channel)
    // rows are newest-first, so the first seen is the latest
  }
  // lightweight AI intent hint per conversation (from the last analysis)
  const intents = {}
  try { for (const r of db.all('SELECT client_id, intent FROM inbox_ai WHERE intent IS NOT NULL')) intents[r.client_id] = r.intent } catch {}
  const list = [...threads.values()].map(t => ({ ...t, channels: [...t.channels], ai_intent: t.client_id ? (intents[t.client_id] || null) : null }))
  const totalUnread = db.get("SELECT COUNT(*) c FROM communications WHERE direction='incoming' AND status='unread'").c
  res.json({ conversations: list, total_unread: totalUnread })
})

// ---- one contact's full thread ----
router.get('/thread/:clientId', (req, res) => {
  const rows = db.all('SELECT * FROM communications WHERE client_id = ? ORDER BY occurred_at ASC LIMIT 500', [Number(req.params.clientId)])
  res.json(rows)
})

// ---- counts for the sidebar badges ----
router.get('/counts', (_req, res) => {
  const byChannel = {}
  for (const c of CHANNELS) byChannel[c] = db.get("SELECT COUNT(*) n FROM communications WHERE direction='incoming' AND status='unread' AND channel=?", [c]).n
  res.json({
    inbox_unread: db.get("SELECT COUNT(*) c FROM communications WHERE direction='incoming' AND status='unread'").c,
    inbox_total: db.get("SELECT COUNT(*) c FROM communications WHERE direction='incoming' AND status!='closed'").c,
    by_channel: byChannel,
  })
})

// ---- incoming webhook receiver (Twilio/FUB/email will POST here going forward) ----
// Only stores the item if the sender matches a hub client. Deduped by external_id.
router.post('/incoming', (req, res) => {
  const b = req.body || {}
  const channel = CHANNELS.includes(b.channel) ? b.channel : 'text'
  const direction = b.direction === 'outgoing' ? 'outgoing' : 'incoming'
  const from = b.from || b.from_addr || ''
  const to = b.to || b.to_addr || ''
  const externalId = b.external_id || `${channel}_${from}_${b.occurred_at || Date.now()}`

  if (b.external_id) {
    const dup = db.get('SELECT id FROM communications WHERE external_id = ?', [externalId])
    if (dup) return res.json({ matched: true, id: dup.id, duplicate: true })
  }
  // match against a client (for outgoing, match the recipient)
  const matchAddr = direction === 'outgoing' ? to : from
  const client = matchClient(channel, matchAddr)
  if (!client) return res.json({ matched: false, reason: 'sender not a hub client — skipped' })

  const preview = (b.preview || b.body || '').toString().replace(/\s+/g, ' ').trim().slice(0, 160)
  const r = db.run(
    `INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, has_attachment, occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [channel, direction, client.id, `${client.first_name || ''} ${client.last_name || ''}`.trim(),
      from, to, b.subject || null, preview, b.body || null, externalId, `c${client.id}_${channel}`,
      direction === 'outgoing' ? 'read' : 'unread', b.has_attachment ? 1 : 0, b.occurred_at || nowIso()])
  res.status(201).json({ matched: true, id: r.lastInsertRowid, client_id: client.id })
})

// ---- Twilio inbound texts (PUBLIC — whitelisted in requireAuth; Twilio posts here) ----
// Twilio sends application/x-www-form-urlencoded: From, To, Body, MessageSid, ...
router.post('/twilio-inbound', async (req, res) => {
  try {
    const b = req.body || {}
    const from = b.From || b.from || ''
    const to = b.To || b.to || ''
    const body = b.Body || b.body || ''
    const sid = b.MessageSid || b.SmsSid || ''
    const client = matchClient('text', from)
    // STOP / START compliance — always honor it for a matched client.
    const { optKeyword } = await import('../twilio.js')
    const kw = optKeyword(body)
    if (kw && client) db.run('UPDATE clients SET text_opt_out = ? WHERE id = ?', [kw === 'stop' ? 1 : 0, client.id])
    if (client) {
      const externalId = 'twilio_' + (sid || `${from}_${Date.now()}`)
      const dup = db.get('SELECT id FROM communications WHERE external_id = ?', [externalId])
      if (!dup) {
        const preview = String(body).replace(/\s+/g, ' ').trim().slice(0, 160)
        const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
        db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, occurred_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['text', 'incoming', client.id, name, from, to, null, preview, body, externalId, `c${client.id}_text`, 'unread', nowIso()])
        notifyInboundText(client, body, from).catch(() => {})
      }
    }
  } catch (e) { console.error('[twilio-inbound] error:', e.message) }
  // Always 200 with empty TwiML so Twilio doesn't retry or auto-reply.
  res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
})

// ---- Twilio delivery status (PUBLIC — whitelisted). Marks failed sends visibly. ----
router.post('/twilio-status', (req, res) => {
  try {
    const sid = req.body?.MessageSid || req.body?.SmsSid
    const status = req.body?.MessageStatus || req.body?.SmsStatus
    if (sid && (status === 'failed' || status === 'undelivered')) {
      db.run("UPDATE communications SET preview = '⚠ Not delivered — ' || preview WHERE external_id = ? AND direction='outgoing' AND preview NOT LIKE '⚠%'", ['twilio_' + sid])
    }
  } catch {}
  res.sendStatus(204)
})

// ---- status changes ----
router.post('/:id/read', (req, res) => { db.run("UPDATE communications SET status='read' WHERE id=?", [Number(req.params.id)]); res.json({ success: true }) })
router.post('/:id/unread', (req, res) => { db.run("UPDATE communications SET status='unread' WHERE id=?", [Number(req.params.id)]); res.json({ success: true }) })
router.post('/thread/:clientId/read', (req, res) => { db.run("UPDATE communications SET status='read' WHERE client_id=? AND status='unread'", [Number(req.params.clientId)]); res.json({ success: true }) })
router.post('/thread/:clientId/close', (req, res) => { db.run("UPDATE communications SET status='closed' WHERE client_id=?", [Number(req.params.clientId)]); res.json({ success: true }) })
router.delete('/:id', (req, res) => { db.run('DELETE FROM communications WHERE id=?', [Number(req.params.id)]); res.json({ success: true }) })

// ---- contact search for the composer (name / email / phone) ----
router.get('/contacts', (req, res) => {
  const q = (req.query.q || '').trim()
  if (q.length < 2) return res.json([])
  const like = `%${q}%`
  const rows = db.all(
    `SELECT id, first_name, last_name, email, phone FROM clients
     WHERE (first_name || ' ' || last_name LIKE ? OR email LIKE ? OR phone LIKE ?)
     AND status NOT IN ('archived','junk') ORDER BY first_name LIMIT 12`, [like, like, like])
  res.json(rows)
})

// ---- compose + send (Email now; Text arrives with Twilio) ----
router.post('/send', async (req, res) => {
  const { channel, client_ids, subject, body } = req.body || {}
  if (!Array.isArray(client_ids) || !client_ids.length) return res.status(400).json({ error: 'Add at least one recipient.' })
  if (!body) return res.status(400).json({ error: 'A message is required.' })

  // ---- TEXT (Twilio) ----
  if (channel === 'text') {
    const { sendSms, twilioConfigured } = await import('../twilio.js')
    if (!twilioConfigured()) return res.status(400).json({ error: 'Texting isn’t connected yet — add your Twilio details in Settings and turn it on.' })
    const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const results = []
    for (const cid of client_ids) {
      const c = db.get('SELECT * FROM clients WHERE id = ?', [Number(cid)])
      if (!c || !c.phone) { results.push({ client_id: cid, ok: false, error: 'no phone on file' }); continue }
      if (c.text_opt_out) { results.push({ client_id: cid, ok: false, error: 'opted out of texts' }); continue }
      const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
      try {
        const r = await sendSms(c.phone, body, { statusCallback: hub + '/api/inbox/twilio-status' })
        const preview = String(body).replace(/\s+/g, ' ').trim().slice(0, 160)
        db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, occurred_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['text', 'outgoing', c.id, name, '', c.phone, null, preview, body, 'twilio_' + r.sid, `c${c.id}_text`, 'read', nowIso()])
        results.push({ client_id: cid, ok: true })
      } catch (e) { results.push({ client_id: cid, ok: false, error: e.message }) }
    }
    return res.json({ sent: results.filter(r => r.ok).length, results })
  }

  // ---- EMAIL (SendGrid) ----
  if (!subject) return res.status(400).json({ error: 'Subject and message are required.' })
  const results = []
  for (const cid of client_ids) {
    const c = db.get('SELECT * FROM clients WHERE id = ?', [Number(cid)])
    if (!c || !c.email) { results.push({ client_id: cid, ok: false, error: 'no email on file' }); continue }
    if (c.marketing_email_opt_out) { results.push({ client_id: cid, ok: false, error: 'opted out' }); continue }
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
    try {
      await sendViaSendGrid(c.email, name, subject, body, null, [], [], [], 'inbox_compose')
      const preview = String(body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
      db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['email', 'outgoing', c.id, name, 'matt@mattsmithteam.com', c.email, subject, preview, body, `out_${Date.now()}_${c.id}`, `c${c.id}_email`, 'read', nowIso()])
      results.push({ client_id: cid, ok: true })
    } catch (e) { results.push({ client_id: cid, ok: false, error: e.message }) }
  }
  res.json({ sent: results.filter(r => r.ok).length, results })
})

// ---- REAL-TIME inbound receiver (SendGrid Inbound Parse posts here) ----
// Public route (SendGrid can't send an auth token). Only stores the message if
// the sender matches a hub client. Always 200 so SendGrid doesn't retry.
function parseMultipart(req, res, next) {
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return next()
  try {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 1 } })
    req.body = {}
    bb.on('field', (name, val) => { req.body[name] = val })
    bb.on('file', (_n, stream) => { req.body._hasAttachment = true; stream.resume() }) // discard attachment bytes
    bb.on('close', () => next())
    bb.on('error', () => next())
    req.pipe(bb)
  } catch { next() }
}
router.post('/parse-inbound', parseMultipart, (req, res) => {
  const b = req.body || {}
  // sender email: from "Name <email>" header, else the SMTP envelope
  let fromEmail = b.from || ''
  const m = String(fromEmail).match(/<([^>]+)>/)
  if (m) fromEmail = m[1]
  else if (!/@/.test(fromEmail)) { try { const env = JSON.parse(b.envelope || '{}'); if (env.from) fromEmail = env.from } catch {} }
  fromEmail = String(fromEmail).trim().toLowerCase()

  const client = matchClient('email', fromEmail)
  if (!client) return res.status(200).json({ matched: false })

  const text = String(b.text || b.html || '').replace(/<[^>]+>/g, ' ')
  const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160)
  const midMatch = String(b.headers || '').match(/Message-ID:\s*<([^>]+)>/i)
  const externalId = midMatch ? `sg_${midMatch[1]}` : `sgparse_${fromEmail}_${Date.now()}`
  const dup = db.get('SELECT id FROM communications WHERE external_id = ?', [externalId])
  if (dup) return res.status(200).json({ matched: true, duplicate: true })

  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  const r = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, has_attachment, occurred_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['email', 'incoming', client.id, name, fromEmail, b.to || '', b.subject || '(no subject)', preview,
      String(b.html || b.text || ''), externalId, `c${client.id}_email`, 'unread', b._hasAttachment ? 1 : 0, nowIso()])
  res.status(200).json({ matched: true, id: r.lastInsertRowid })
})

// =====================================================================
// AI SUGGESTED REPLY — analyze the incoming email + the full thread + the
// client's HUB/FUB context, then draft a warm, on-point reply. Cached per
// conversation (inbox_ai), keyed to the latest incoming message so it isn't
// regenerated on every open. Reuses the follow-up AI stack.
// =====================================================================
const INTENTS = ['Needs Response', 'Question', 'Scheduling Request', 'Property Interest', 'High Intent', 'Information Request', 'No Response Needed']

const REPLY_SYSTEM = `You are drafting a REPLY as Matt Smith (Matt Smith Team, RE/MAX Concepts, Cedar Rapids / Marion, Iowa) to a client's email. Use ONLY the client records and the email thread provided.

First identify what the client is actually asking or telling you (their intent), then write a reply that directly addresses THAT, not a generic acknowledgement.

HARD RULES
- Never use em dashes or en dashes. Use commas, periods, or the word "to".
- Never invent facts, promises, prices, dates, or availability. Use only what is in the records and thread. If you don't know something, say you'll find out.
- Warm, approachable, conversational, personal, friendly, natural, confident, helpful. Like a real person replying to someone they already know. Not formal, corporate, stiff, or salesy.
- Do NOT use filler like "Thank you for reaching out", "I hope this email finds you well", "Please do not hesitate to contact me", "I wanted to follow up", or "Checking in". Just reply naturally.
- Address their real intent. Add a natural next step ONLY when it fits (answer the question, offer info, suggest a call or appointment, ask one simple clarifying question, send a property, or just continue the conversation with no ask). Do not force a call or appointment into every reply. It is fine to let them know there is no urgency.
- No signature (the app adds it).

Return ONLY this JSON:
{
  "intent": one of ${JSON.stringify(INTENTS)},
  "summary": "1-2 sentence plain summary of what they're asking and where the relationship stands, or ''",
  "reply": { "subject": "Re: ...", "body": "the reply text" }
}`

function parseJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim()
  const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}
const latestIncomingEmail = (rows) => [...rows].reverse().find(m => m.direction === 'incoming' && m.channel === 'email')
function threadTranscript(rows) {
  return rows.slice(-12).map(m => {
    const who = m.direction === 'outgoing' ? 'Matt (agent)' : (m.contact_name || 'Client')
    const when = String(m.occurred_at || '').slice(0, 16).replace('T', ' ')
    const text = m.channel === 'email' ? stripHtml(m.body || m.preview) : (m.body || m.preview || '')
    return `[${when}] ${who}${m.subject ? ' — ' + m.subject : ''}:\n${clip(text, 900)}`
  }).join('\n\n')
}
async function generateReply(client, rows, adjustInstruction, context, current) {
  const ai = getAiClient()
  if (!ai) return { error: 'AI is not configured (ANTHROPIC_API_KEY missing).' }
  let dossier = {}
  try { dossier = buildDossier(client, await gatherFub(client.fub_person_id)) } catch {}
  const transcript = threadTranscript(rows)
  const extra = (adjustInstruction || context)
    ? `\nADJUST THE REPLY: ${adjustInstruction || ''}${context ? ` Extra context from the agent, treat as true and important: "${String(context).slice(0, 600)}".` : ''}\n`
      + (current && current.body ? `CURRENT DRAFT to revise:\nSubject: ${current.subject || ''}\n${current.body}\n` : '')
    : ''
  const userMsg = `CLIENT CONTEXT (JSON):\n${JSON.stringify(dossier)}\n\nEMAIL THREAD (oldest to newest):\n${transcript}\n${extra}\nReturn the JSON now.`
  let msg
  try { msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 1200, system: REPLY_SYSTEM, messages: [{ role: 'user', content: userMsg }] }) }
  catch (e) { return { error: e.message } }
  let out; try { out = parseJson(msg.content?.[0]?.text || '') } catch { return { error: 'AI returned an unreadable response.' } }
  if (out.summary) out.summary = noDash(out.summary)
  if (out.reply) { out.reply.subject = noDash(out.reply.subject || ''); out.reply.body = noDash(out.reply.body || '') }
  return out
}

// cached suggestion + intent + draft (no model call)
router.get('/thread/:clientId/ai', (req, res) => {
  const cid = Number(req.params.clientId)
  const client = db.get('SELECT id FROM clients WHERE id = ?', [cid])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const rows = db.all('SELECT id, direction, channel, occurred_at FROM communications WHERE client_id = ? ORDER BY occurred_at ASC', [cid])
  const inc = latestIncomingEmail(rows)
  const row = db.get('SELECT * FROM inbox_ai WHERE client_id = ?', [cid])
  const parse = (s) => { try { return JSON.parse(s || 'null') } catch { return null } }
  res.json({
    ai_available: !!process.env.ANTHROPIC_API_KEY,
    has_incoming: !!inc,
    intent: row ? row.intent : null,
    summary: row ? row.summary : null,
    suggestion: parse(row && row.suggestion),
    draft: parse(row && row.draft),
    stale: inc ? (!row || row.based_on_msg_id !== inc.id) : false,
  })
})

// generate / regenerate the suggestion (model call), cache it, keep any draft
router.post('/thread/:clientId/ai/suggest', async (req, res) => {
  const cid = Number(req.params.clientId)
  const client = db.get('SELECT * FROM clients WHERE id = ?', [cid])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const rows = db.all('SELECT * FROM communications WHERE client_id = ? ORDER BY occurred_at ASC', [cid])
  const inc = latestIncomingEmail(rows)
  if (!inc) return res.json({ has_incoming: false })
  const out = await generateReply(client, rows)
  if (out.error) return res.status(502).json({ error: out.error })
  const suggestion = out.reply ? JSON.stringify(out.reply) : null
  const existing = db.get('SELECT draft FROM inbox_ai WHERE client_id = ?', [cid])
  db.run(`INSERT INTO inbox_ai (client_id, based_on_msg_id, intent, summary, suggestion, draft, updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(client_id) DO UPDATE SET based_on_msg_id=excluded.based_on_msg_id, intent=excluded.intent, summary=excluded.summary, suggestion=excluded.suggestion, updated_at=excluded.updated_at`,
    [cid, inc.id, out.intent || null, out.summary || null, suggestion, existing ? existing.draft : null, nowIso()])
  res.json({ has_incoming: true, intent: out.intent || null, summary: out.summary || null, suggestion: out.reply || null, stale: false })
})

// adjust the reply (shorter/casual/direct/warmer/regenerate/free-text context)
router.post('/thread/:clientId/ai/adjust', async (req, res) => {
  const cid = Number(req.params.clientId)
  const client = db.get('SELECT * FROM clients WHERE id = ?', [cid])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const rows = db.all('SELECT * FROM communications WHERE client_id = ? ORDER BY occurred_at ASC', [cid])
  const { instruction, context, current } = req.body || {}
  const MAP = { shorter: 'Make it noticeably shorter and tighter while keeping the personal hook.', casual: 'Make it warmer and more casual, like texting a friend, still professional enough to send.', direct: 'Make it more direct and to the point, without losing warmth.', warmer: 'Make it warmer and more personal.', regenerate: 'Rewrite it fresh, same intent, new wording and a new natural opening.' }
  const out = await generateReply(client, rows, MAP[instruction] || (instruction ? '' : 'Rewrite the reply.'), context, current)
  if (out.error) return res.status(502).json({ error: out.error })
  res.json({ reply: out.reply || null, intent: out.intent || null, summary: out.summary || null })
})

// persist the user's edited draft so it survives leaving/returning to the thread
router.post('/thread/:clientId/draft', (req, res) => {
  const cid = Number(req.params.clientId)
  const { subject, body } = req.body || {}
  const draft = (subject || body) ? JSON.stringify({ subject: subject || '', body: body || '' }) : null
  const existing = db.get('SELECT client_id FROM inbox_ai WHERE client_id = ?', [cid])
  if (existing) db.run('UPDATE inbox_ai SET draft = ?, updated_at = ? WHERE client_id = ?', [draft, nowIso(), cid])
  else db.run('INSERT INTO inbox_ai (client_id, draft, updated_at) VALUES (?,?,?)', [cid, draft, nowIso()])
  res.json({ success: true })
})

export default router
