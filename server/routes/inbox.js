import { Router } from 'express'
import Busboy from 'busboy'
import { createWriteStream, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import db from '../database.js'
import { sendViaSendGrid, emailHardBlock, fillTemplate } from './email.js'
import { getAiClient, gatherFub, buildDossier, noDash, AI_MODEL } from './followup.js'
import { notifyNewInbound } from '../gmail-inbox.js'
import { twilioWebhookGuard } from '../twilio-webhook.js'
import { isStopStatus, stopSequencesForClient } from '../lead-sequences.js'

// MMS uploads live next to the DB (the persistent /data disk on Render) and are
// served publicly at /uploads so Twilio can fetch them when sending an MMS.
const DB_DIR = process.env.DB_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPLOAD_DIR = join(DB_DIR, 'uploads')
try { mkdirSync(UPLOAD_DIR, { recursive: true }) } catch {}
const HUB_BASE = () => process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'

// Friendly, agent-readable text for the common Twilio messaging error codes.
function twilioErrorText(code) {
  const m = {
    30003: 'Phone unreachable (off or out of coverage)', 30004: 'Message blocked by the carrier',
    30005: 'Unknown or non-existent number', 30006: 'Landline or unreachable carrier (can’t receive texts)',
    30007: 'Carrier filtered as spam', 30008: 'Unknown delivery error', 21610: 'Recipient has opted out (STOP)',
    21614: 'Not a valid mobile number', 30034: 'Number not registered for A2P 10DLC',
  }
  return m[Number(code)] || (code ? `Carrier error ${code}` : null)
}

const router = Router()

// Diagnostic: re-send the inbox-email alert for a client's most recent inbound
// email (used to verify the alert format/recipients). Runs the real notify path.
router.post('/test-notify/:clientId', async (req, res) => {
  const cid = Number(req.params.clientId)
  const client = db.get('SELECT id, first_name, last_name FROM clients WHERE id = ?', [cid])
  if (!client) return res.status(404).json({ error: 'client not found' })
  const msg = db.get("SELECT subject, preview, from_addr FROM communications WHERE client_id = ? AND direction = 'incoming' AND channel = 'email' ORDER BY occurred_at DESC LIMIT 1", [cid])
  if (!msg) return res.status(404).json({ error: 'no inbound email for this client' })
  try {
    await notifyNewInbound(client, msg.subject, msg.preview, msg.from_addr)
    res.json({ sent: true, client: `${client.first_name || ''} ${client.last_name || ''}`.trim(), subject: msg.subject, from: msg.from_addr })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
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
// When several duplicate leads share the same phone/email, an inbound reply must
// land on the SAME record that holds the outgoing side of the conversation — not
// on whichever duplicate happens to have the lowest id (often an old junk record).
// Rank candidates: active conversation (most recent OUTGOING) > non-junk > most
// recent activity of any kind > newest record.
const JUNK_STATUSES = new Set(['junk', 'trash', 'spam'])
function pickBestClient(cands) {
  if (!cands || !cands.length) return null
  if (cands.length === 1) return cands[0]
  const scored = cands.map((c) => {
    let lastOut = '', lastAny = ''
    try { const r = db.get("SELECT MAX(occurred_at) m FROM communications WHERE client_id=? AND direction='outgoing'", [c.id]); lastOut = (r && r.m) || '' } catch {}
    try { const r = db.get('SELECT MAX(occurred_at) m FROM communications WHERE client_id=?', [c.id]); lastAny = (r && r.m) || '' } catch {}
    return { c, lastOut, lastAny, junk: JUNK_STATUSES.has(String(c.status || '').toLowerCase()) }
  })
  scored.sort((a, b) => {
    if (a.lastOut !== b.lastOut) return a.lastOut < b.lastOut ? 1 : -1   // active conversation wins
    if (a.junk !== b.junk) return a.junk ? 1 : -1                        // non-junk over junk
    if (a.lastAny !== b.lastAny) return a.lastAny < b.lastAny ? 1 : -1   // most recent activity
    return b.c.id - a.c.id                                               // newest record
  })
  return scored[0].c
}

function matchClient(channel, fromAddr) {
  if (!fromAddr) return null
  if (channel === 'email') {
    const rows = db.all('SELECT id, first_name, last_name, status FROM clients WHERE lower(email) = lower(?)', [String(fromAddr).trim()])
    return pickBestClient(rows)
  }
  const k = phoneKey(fromAddr)
  if (!k) return null
  // match on the last 10 digits of the stored phone
  const rows = db.all("SELECT id, first_name, last_name, phone, status FROM clients WHERE phone IS NOT NULL AND phone != ''").filter((c) => phoneKey(c.phone) === k)
  return pickBestClient(rows)
}

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '') }
const unknownKey = (phone) => { const k = phoneKey(phone); return k ? 'u_' + k : null }

// Re-point every unknown (client_id NULL) communication in a thread onto a real
// client, so the conversation becomes a normal lead thread going forward.
function relinkUnknownThread(key, clientId, name) {
  if (!key) return 0
  const rows = db.all('SELECT id, channel FROM communications WHERE thread_key = ? AND client_id IS NULL', [key])
  for (const row of rows) db.run('UPDATE communications SET client_id=?, contact_name=?, thread_key=? WHERE id=?', [clientId, name, `c${clientId}_${row.channel}`, row.id])
  return rows.length
}

// Email John when an UNKNOWN number (not yet a client) texts the Hub, so an
// inbound lead is never missed. Uses the same notify inbox as matched texts.
async function notifyUnknownInbound(fromPhone, body) {
  try {
    const to = db.getSetting('inbox_notify_email', 'johnwithmattsmithteam@gmail.com') || ''
    if (!to) return
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
      <p style="margin:0 0 10px;">A <strong>new number</strong> just texted the Hub (not in the CRM yet).</p>
      <p style="margin:0 0 4px;"><strong>From:</strong> ${escHtml(fmtPhone(fromPhone))}</p>
      <p style="margin:8px 0;background:#f1f5f9;padding:10px 12px;border-radius:8px;">${escHtml(body).slice(0, 600)}</p>
      <p style="margin:6px 0 0;color:#64748b;font-size:12px;">Open the Hub Inbox to reply and add them as a lead.</p></div>`
    await sendViaSendGrid(to, 'Matt Smith Team', 'New text from an unknown number', html, null, [], [], [], 'inbox_notify')
  } catch {}
}

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

  // group into conversation threads. A Twilio-Conversations group (group MMS) is keyed
  // by its conversation_sid so the group + every reply render as ONE thread.
  const threads = new Map()
  for (const r of rows) {
    const key = r.conversation_sid ? ('grp_' + r.conversation_sid) : (r.client_id || r.thread_key || `x_${r.from_addr}`)
    if (!threads.has(key)) {
      threads.set(key, {
        client_id: r.conversation_sid ? null : r.client_id, contact_name: r.contact_name || 'Unknown',
        last: r, msg_count: 0, unread_count: 0, channels: new Set(),
        unknown: !r.conversation_sid && !r.client_id, thread_key: r.thread_key || null,
        conversation_sid: r.conversation_sid || null, is_group: !!r.conversation_sid, group_meta: null,
        phone: r.client_id ? null : (r.from_addr || r.to_addr || ''),
      })
    }
    const t = threads.get(key)
    t.msg_count++
    if (r.status === 'unread') t.unread_count++
    t.channels.add(r.channel)
    if (r.group_meta && !t.group_meta) t.group_meta = r.group_meta
    // rows are newest-first, so the first seen is the latest
  }
  // Group threads get a stable "Group: name, name" label from the send's participants.
  for (const t of threads.values()) {
    if (t.is_group && t.group_meta) {
      try { const names = (JSON.parse(t.group_meta).participants || []).map(p => p.name || p.phone); if (names.length) t.contact_name = 'Group: ' + names.join(', ') } catch {}
    } else if (t.is_group && !/^Group:/.test(t.contact_name)) { t.contact_name = 'Group text' }
  }
  // lightweight AI intent hint per conversation (from the last analysis)
  const intents = {}
  try { for (const r of db.all('SELECT client_id, intent FROM inbox_ai WHERE intent IS NOT NULL')) intents[r.client_id] = r.intent } catch {}
  // conversation owner = the assigned agent on the client record
  const owners = {}
  try { for (const r of db.all("SELECT id, agent_assigned FROM clients WHERE agent_assigned IS NOT NULL AND agent_assigned != ''")) owners[r.id] = r.agent_assigned } catch {}
  let list = [...threads.values()].map(t => ({ ...t, channels: [...t.channels], ai_intent: t.client_id ? (intents[t.client_id] || null) : null, assigned_to: t.client_id ? (owners[t.client_id] || null) : null }))
  // assignment filter: a specific agent name, or 'unassigned'
  const assigned = (req.query.assigned || '').trim()
  if (assigned === 'unassigned') list = list.filter(c => !c.assigned_to)
  else if (assigned) list = list.filter(c => c.assigned_to === assigned)
  const totalUnread = db.get("SELECT COUNT(*) c FROM communications WHERE direction='incoming' AND status='unread'").c
  res.json({ conversations: list, total_unread: totalUnread })
})

// ---- REAL-TIME stream (Server-Sent Events). Pushes a 'changed' event whenever a
// new communication row appears, so the inbox updates near-instantly instead of
// waiting on the poll. EventSource can't set headers → token comes via ?token=. ----
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  if (res.flushHeaders) res.flushHeaders()
  res.write(': connected\n\n')
  let last = db.get('SELECT MAX(id) m FROM communications')?.m || 0
  const tick = setInterval(() => {
    try {
      const m = db.get('SELECT MAX(id) m FROM communications')?.m || 0
      if (m !== last) { last = m; res.write(`event: changed\ndata: ${JSON.stringify({ max_id: m })}\n\n`) }
      else res.write(': ping\n\n')   // heartbeat keeps the connection open through proxies
    } catch {}
  }, 3000)
  req.on('close', () => clearInterval(tick))
})

// ---- pull a contact's FULL email history straight from the mailboxes (All Mail,
// both directions) using the stored app passwords. For reconstructing complete
// threads that predate the inbox poller. Read-only. ----
router.get('/contact-emails', async (req, res) => {
  const email = String(req.query.email || '').trim()
  if (!email) return res.status(400).json({ error: 'email is required' })
  try { const { searchMailboxesForContact } = await import('../gmail-inbox.js'); res.json(await searchMailboxesForContact(email, { max: Number(req.query.max) || 600 })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- one contact's full thread ----
router.get('/thread/:clientId', (req, res) => {
  const cid = Number(req.params.clientId)
  const rows = db.all('SELECT * FROM communications WHERE client_id = ? ORDER BY occurred_at ASC LIMIT 500', [cid])
  // Group texts are stored ONCE with client_id NULL + a conversation_sid (they belong to
  // no single profile). Surface every group conversation this lead is part of on their
  // profile: match by the group's participant list (group_meta) or by phone on any row.
  try {
    const client = db.get('SELECT phone FROM clients WHERE id = ?', [cid])
    const k = client && client.phone ? phoneKey(client.phone) : null
    const groupRows = db.all('SELECT * FROM communications WHERE conversation_sid IS NOT NULL ORDER BY occurred_at ASC LIMIT 1000')
    const mySids = new Set()
    for (const g of groupRows) {
      if (g.client_id === cid) { mySids.add(g.conversation_sid); continue }
      if (!k) continue
      if (phoneKey(g.from_addr) === k || phoneKey(g.to_addr) === k) { mySids.add(g.conversation_sid); continue }
      try {
        const parts = (JSON.parse(g.group_meta || '{}').participants) || []
        if (parts.some(p => phoneKey(p.phone) === k || Number(p.client_id) === cid)) mySids.add(g.conversation_sid)
      } catch {}
    }
    if (mySids.size) {
      const seen = new Set(rows.map(r => r.id))
      for (const g of groupRows) if (mySids.has(g.conversation_sid) && !seen.has(g.id)) { rows.push(g); seen.add(g.id) }
      rows.sort((a, b) => String(a.occurred_at || '').localeCompare(String(b.occurred_at || '')))
    }
  } catch (e) { console.error('[thread] group-merge:', e.message) }
  res.json(rows)
})

// ---- team agents (for assignment); configurable via the inbox_agents setting ----
router.get('/agents', (_req, res) => {
  let names = []
  try { names = db.all('SELECT name FROM team_agents ORDER BY name').map(a => String(a.name).split(' ')[0]) } catch {}
  if (!names.length) names = (db.getSetting('inbox_agents', 'Matt,John,Hunter') || '').split(',').map(s => s.trim()).filter(Boolean)
  res.json([...new Set(names)])
})
// ---- assign / reassign a conversation to an agent (owner = clients.agent_assigned) ----
router.post('/thread/:clientId/assign', (req, res) => {
  const cid = Number(req.params.clientId)
  const agent = (req.body?.agent || '').trim() || null
  const c = db.get('SELECT id, agent_assigned FROM clients WHERE id=?', [cid])
  if (!c) return res.status(404).json({ error: 'client not found' })
  db.run('UPDATE clients SET agent_assigned=?, updated_at=? WHERE id=?', [agent, new Date().toISOString(), cid])
  if (agent) import('./automations.js').then(m => m.emitAutomationEvent('contact_assigned', cid, { agent })).catch(() => {})
  res.json({ success: true, assigned_to: agent })
})

// ---- UNKNOWN queue: an inbound text/call from a number not in the CRM. The
// conversation lives under a thread_key (u_<phone10>) with client_id NULL until
// an agent creates or links a lead, at which point it becomes a normal thread. ----
router.get('/unknown-thread', (req, res) => {
  const key = String(req.query.key || '')
  if (!key) return res.json([])
  res.json(db.all('SELECT * FROM communications WHERE thread_key = ? AND client_id IS NULL ORDER BY occurred_at ASC LIMIT 500', [key]))
})
router.post('/unknown-thread/read', (req, res) => {
  const key = String(req.body?.key || '')
  if (key) db.run("UPDATE communications SET status='read' WHERE thread_key=? AND client_id IS NULL AND status='unread'", [key])
  res.json({ success: true })
})
// Create a brand-new lead from an unknown conversation and re-point the thread onto it.
router.post('/unknown/create-lead', (req, res) => {
  const { key, phone, first_name, last_name } = req.body || {}
  const k = String(key || '')
  const last10 = phoneKey(phone) || k.replace(/^u_/, '')
  if (!/^\d{10}$/.test(last10)) return res.status(400).json({ error: 'no valid phone' })
  const already = db.all("SELECT id, first_name, last_name, phone FROM clients WHERE phone IS NOT NULL AND phone != ''").find(c => phoneKey(c.phone) === last10)
  const fn = String(first_name || '').trim() || 'Inbound'
  const ln = String(last_name || '').trim() || 'Lead'
  let cid
  if (already) { cid = already.id }
  else {
    const r = db.run("INSERT INTO clients (first_name, last_name, phone, type, status, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
      [fn, ln, phone || last10, 'buyer', 'active', 'Inbound Text (Hub)', nowIso(), nowIso()])
    cid = r.lastInsertRowid
  }
  const name = already ? `${already.first_name || ''} ${already.last_name || ''}`.trim() : `${fn} ${ln}`.trim()
  const n = relinkUnknownThread(k, cid, name || fmtPhone(last10))
  res.json({ success: true, client_id: cid, linked_messages: n, existing: !!already })
})
// Link an unknown conversation to an existing client.
router.post('/unknown/link', (req, res) => {
  const { key, client_id } = req.body || {}
  const c = db.get('SELECT id, first_name, last_name FROM clients WHERE id=?', [Number(client_id)])
  if (!c) return res.status(404).json({ error: 'client not found' })
  const n = relinkUnknownThread(String(key || ''), c.id, `${c.first_name || ''} ${c.last_name || ''}`.trim())
  res.json({ success: true, client_id: c.id, linked_messages: n })
})

// ---- secure recording/voicemail media proxy (streams Twilio media w/ account auth) ----
router.get('/recording/:id', async (req, res) => {
  const row = db.get('SELECT recording_url FROM communications WHERE id = ?', [Number(req.params.id)])
  if (!row?.recording_url) return res.status(404).send('No recording')
  const { twilioConfig } = await import('../twilio.js')
  const c = twilioConfig()
  const url = /\.(mp3|wav)$/i.test(row.recording_url) ? row.recording_url : row.recording_url + '.mp3'
  try {
    const tr = await fetch(url, { headers: { Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') } })
    if (!tr.ok) return res.status(502).send('Recording unavailable')
    res.set('Content-Type', tr.headers.get('content-type') || 'audio/mpeg')
    res.set('Cache-Control', 'private, max-age=3600')
    res.send(Buffer.from(await tr.arrayBuffer()))
  } catch { res.status(502).send('Recording error') }
})

// ---- MMS media proxy: streams an image attached to a message. Handles Twilio
// media (needs account auth) and our own /uploads URLs uniformly. Renders inline
// in the thread. Whitelisted for query-token auth like the recording proxy. ----
router.get('/media/:id/:idx', async (req, res) => {
  const row = db.get('SELECT media_url FROM communications WHERE id = ?', [Number(req.params.id)])
  let list = []; try { list = JSON.parse(row?.media_url || '[]') } catch {}
  const item = list[Number(req.params.idx)]
  if (!item?.url) return res.status(404).send('no media')
  try {
    const headers = {}
    if (/api\.twilio\.com/.test(item.url)) {
      const { twilioConfig } = await import('../twilio.js'); const c = twilioConfig()
      headers.Authorization = 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
    }
    const tr = await fetch(item.url, { headers })
    if (!tr.ok) return res.status(502).send('media unavailable')
    res.set('Content-Type', tr.headers.get('content-type') || item.type || 'image/jpeg')
    res.set('Cache-Control', 'private, max-age=86400')
    res.send(Buffer.from(await tr.arrayBuffer()))
  } catch { res.status(502).send('media error') }
})

// ---- upload a photo for an outgoing MMS. Stores it under /uploads (public) and
// returns the absolute URL so Twilio can fetch it at send time. ----
router.post('/upload-media', (req, res) => {
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return res.status(400).json({ error: 'expected an uploaded file' })
  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 5 * 1024 * 1024 } })
  let saved = null, tooBig = false, mime = 'image/jpeg'
  bb.on('file', (_n, stream, info) => {
    mime = info?.mimeType || 'image/jpeg'
    if (!/^image\//i.test(mime)) { stream.resume(); return }
    const ext = (mime.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg'
    const fname = `${randomUUID().replace(/-/g, '')}.${ext}`
    const full = join(UPLOAD_DIR, fname)
    const ws = createWriteStream(full)
    stream.on('limit', () => { tooBig = true; ws.destroy(); try { unlinkSync(full) } catch {} })
    ws.on('finish', () => { if (!tooBig) saved = fname })
    stream.pipe(ws)
  })
  bb.on('close', () => {
    if (tooBig) return res.status(413).json({ error: 'Image too large (max 5 MB).' })
    if (!saved) return res.status(400).json({ error: 'That file is not an image.' })
    res.json({ url: `${HUB_BASE()}/uploads/${saved}`, type: mime })
  })
  bb.on('error', () => res.status(500).json({ error: 'upload failed' }))
  req.pipe(bb)
})

// ---- Voicemail greeting: upload your own audio (mp3/wav) to play instead of the
// robot voice when a caller reaches voicemail. Stored on /uploads, URL in a setting. ----
router.get('/voicemail-greeting', (_req, res) => res.json({ url: db.getSetting('voicemail_greeting_url', '') || '' }))
router.delete('/voicemail-greeting', (_req, res) => { db.setSetting('voicemail_greeting_url', ''); res.json({ success: true }) })
router.post('/voicemail-greeting', (req, res) => {
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return res.status(400).json({ error: 'expected an uploaded file' })
  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 8 * 1024 * 1024 } })
  let saved = null, tooBig = false, badType = false
  bb.on('file', (_n, stream, info) => {
    const mime = info?.mimeType || ''
    // Twilio <Play> supports mp3 + wav reliably.
    const ext = /mpeg|mp3/i.test(mime) ? 'mp3' : /wav/i.test(mime) ? 'wav' : null
    if (!ext) { badType = true; stream.resume(); return }
    const fname = `vm_${randomUUID().replace(/-/g, '')}.${ext}`
    const full = join(UPLOAD_DIR, fname)
    const ws = createWriteStream(full)
    stream.on('limit', () => { tooBig = true; ws.destroy(); try { unlinkSync(full) } catch {} })
    ws.on('finish', () => { if (!tooBig) saved = fname })
    stream.pipe(ws)
  })
  bb.on('close', () => {
    if (tooBig) return res.status(413).json({ error: 'Audio too large (max 8 MB).' })
    if (badType) return res.status(400).json({ error: 'Please upload an MP3 or WAV file.' })
    if (!saved) return res.status(400).json({ error: 'No audio received.' })
    const url = `${HUB_BASE()}/uploads/${saved}`
    db.setSetting('voicemail_greeting_url', url)
    res.json({ success: true, url })
  })
  bb.on('error', () => res.status(500).json({ error: 'upload failed' }))
  req.pipe(bb)
})

// ---- link preview: fetch OpenGraph metadata for a URL found in a message so the
// inbox can show a rich card. In-memory cached 6h; SSRF-guarded (no private hosts). ----
const linkCache = new Map()
router.get('/link-preview', async (req, res) => {
  const url = String(req.query.url || '').trim()
  let u; try { u = new URL(url) } catch { return res.status(400).json({ error: 'bad url' }) }
  if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'bad url' })
  const host = u.hostname
  if (host === 'localhost' || host === '::1' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return res.status(400).json({ error: 'blocked host' })
  const hit = linkCache.get(url)
  if (hit && Date.now() - hit.t < 6 * 3600 * 1000) return res.json(hit.v)
  const fallback = { url, title: u.hostname.replace(/^www\./, ''), site: u.hostname.replace(/^www\./, ''), image: null, description: '' }
  try {
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HubBot/1.0; +link-preview)' } })
    clearTimeout(to)
    if (!/text\/html/i.test(r.headers.get('content-type') || '')) { linkCache.set(url, { t: Date.now(), v: fallback }); return res.json(fallback) }
    const html = (await r.text()).slice(0, 200000)
    const meta = (prop) => {
      const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'))
        || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'))
      return m ? m[1] : ''
    }
    const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''
    let image = meta('og:image') || meta('og:image:url') || meta('twitter:image')
    if (image && image.startsWith('//')) image = u.protocol + image
    else if (image && image.startsWith('/')) image = u.origin + image
    const v = {
      url, title: decode(meta('og:title') || titleTag) || fallback.title,
      description: decode(meta('og:description') || meta('description')).slice(0, 200),
      image: image || null, site: decode(meta('og:site_name')) || fallback.site,
    }
    linkCache.set(url, { t: Date.now(), v })
    res.json(v)
  } catch { res.json(fallback) }
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
router.post('/twilio-inbound', twilioWebhookGuard, async (req, res) => {
  try {
    const b = req.body || {}
    const from = b.From || b.from || ''
    const to = b.To || b.to || ''
    const body = b.Body || b.body || ''
    const sid = b.MessageSid || b.SmsSid || ''
    // MMS media (Twilio sends NumMedia + MediaUrl0.. / MediaContentType0..)
    const numMedia = Number(b.NumMedia || 0)
    const media = []
    for (let i = 0; i < numMedia; i++) { const u = b['MediaUrl' + i]; if (u) media.push({ url: u, type: b['MediaContentType' + i] || '' }) }
    const client = matchClient('text', from)
    // An inbound text proves the number can receive SMS → clear any stale "undeliverable" flag.
    if (client) { try { db.run('UPDATE clients SET sms_undeliverable=0, sms_undeliverable_reason=NULL WHERE id=? AND sms_undeliverable=1', [client.id]) } catch {} }
    // STOP / START compliance for OUR Hub number. This sets hub_text_opt_out (the only
    // thing that blocks outbound texting) — NOT the informational, Sierra-synced
    // text_opt_out. Calling is never blocked. START clears it.
    const { optKeyword } = await import('../twilio.js')
    const kw = optKeyword(body)
    // STOP/START flows through the centralized policy so hub_text_opt_out AND the
    // normalized communication_preferences stay in sync (do_not_call untouched).
    if (kw && client) { try { const { applyOptOut } = await import('../ai-followup/policy.js'); applyOptOut(client.id, kw, 'sms_reply') } catch { db.run('UPDATE clients SET hub_text_opt_out = ?, updated_at = ? WHERE id = ?', [kw === 'stop' ? 1 : 0, new Date().toISOString(), client.id]) } }
    // Natural-language opt-out ("stop texting me", "take me off your list") — only when
    // it's NOT already a literal keyword. Blocks TEXT only (calling stays independent).
    else if (!kw && client) { try { const { isNaturalOptOut, applyOptOut } = await import('../ai-followup/policy.js'); if (isNaturalOptOut(body)) applyOptOut(client.id, 'stop', 'sms_reply_nl') } catch {} }
    // Store the message whether or not the sender is a known client. Unknown
    // senders land in the Unknown queue (client_id NULL) so no inbound lead is lost.
    const externalId = 'twilio_' + (sid || `${from}_${Date.now()}`)
    const dup = db.get('SELECT id FROM communications WHERE external_id = ?', [externalId])
    if (!dup) {
      const preview = (String(body).replace(/\s+/g, ' ').trim() || (media.length ? `[${media.length} attachment${media.length === 1 ? '' : 's'}]` : '')).slice(0, 160)
      const name = client ? `${client.first_name || ''} ${client.last_name || ''}`.trim() : fmtPhone(from)
      const cid = client ? client.id : null
      const tkey = client ? `c${client.id}_text` : (unknownKey(from) || `u_${from}`)
      db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, has_attachment, media_url, delivery_status, occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['text', 'incoming', cid, name, from, to, null, preview, body, externalId, tkey, 'unread', media.length ? 1 : 0, media.length ? JSON.stringify(media) : null, 'received', nowIso()])
      if (client) {
        notifyInboundText(client, body || (media.length ? '[media]' : ''), from).catch(() => {})
        // P1-3: weighted behavioral event for the inbound text (feeds intent).
        try { import('../ai-followup/behavioral.js').then(m => m.recordBehavioralEvent(client.id, 'inbound_text', { source: 'sms', ref: externalId })).catch(() => {}) } catch {}
        // P2-4: notification for the inbound text.
        try { import('../notifications.js').then(m => m.notify({ type: 'inbound_text', title: `New text from ${name}`, body: (body || '[media]').slice(0, 160), link: `/clients?open=${client.id}`, client_id: client.id, dedupKey: 'inbound_' + externalId })).catch(() => {}) } catch {}
        // FSBO smart follow-up: if this lead is in the FSBO sequence, run the scripted reply.
        try { import('../fsbo-followup.js').then(m => m.handleFsboReply(client.id, body)).catch(() => {}) } catch {}
        // Automation triggers: incoming text (always) + text reply (if we've texted them before)
        import('./automations.js').then(m => {
          m.emitAutomationEvent('new_message_received', client.id, { body }, 'msg_' + externalId)
          const priorOut = db.get("SELECT id FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing' LIMIT 1", [client.id])
          if (priorOut) m.emitAutomationEvent('text_replied', client.id, { body }, 'reply_' + externalId)
        }).catch(() => {})
        // HUB AI responsive follow-up — fully gated + fail-safe; never blocks the webhook.
        if (body && !kw) import('../ai-followup/orchestrator.js').then(m => m.handleInboundText(client.id, body)).catch(e => console.error('[hubai]', e.message))
      } else notifyUnknownInbound(from, body || (media.length ? '[media]' : '')).catch(() => {})
    }
  } catch (e) { console.error('[twilio-inbound] error:', e.message) }
  // Always 200 with empty TwiML so Twilio doesn't retry or auto-reply.
  res.set('Content-Type', 'text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
})

// ---- Twilio delivery status (PUBLIC). Reconciles the outgoing text's delivery_status. ----
router.post('/twilio-status', twilioWebhookGuard, (req, res) => {
  try {
    const sid = req.body?.MessageSid || req.body?.SmsSid
    const status = req.body?.MessageStatus || req.body?.SmsStatus
    const errCode = req.body?.ErrorCode
    if (sid && status) {
      const err = (status === 'failed' || status === 'undelivered') ? twilioErrorText(errCode) : null
      db.run("UPDATE communications SET delivery_status=?, error_message=? WHERE external_id=? AND direction='outgoing'", [status, err, 'twilio_' + sid])
      // Landline / number-can't-receive-SMS codes → mark the contact so automated texts skip
      // it (30006 landline/unreachable carrier, 30005 unknown destination handset).
      if ((status === 'failed' || status === 'undelivered') && ['30006', '30005'].includes(String(errCode))) {
        const row = db.get("SELECT client_id FROM communications WHERE external_id=? AND direction='outgoing'", ['twilio_' + sid])
        if (row?.client_id && !db.get('SELECT sms_undeliverable FROM clients WHERE id=?', [row.client_id])?.sms_undeliverable) {
          db.run("UPDATE clients SET sms_undeliverable=1, sms_undeliverable_reason=?, sms_undeliverable_at=? WHERE id=?", [err || ('Twilio ' + errCode), new Date().toISOString(), row.client_id])
        }
      }
    }
  } catch {}
  res.sendStatus(204)
})

// ---- status changes ----
// Call notes + disposition on a communication row. "Do Not Call" flips the
// contact's opt-out so nothing (manual, automation, bulk) texts them again.
router.post('/:id/annotate', (req, res) => {
  const { notes, disposition } = req.body || {}
  const sets = [], vals = []
  if (notes !== undefined) { sets.push('notes=?'); vals.push(notes) }
  if (disposition !== undefined) { sets.push('disposition=?'); vals.push(disposition) }
  if (!sets.length) return res.json({ success: true })
  vals.push(Number(req.params.id))
  db.run(`UPDATE communications SET ${sets.join(', ')} WHERE id=?`, vals)
  // Automation trigger: a call outcome was set.
  if (disposition) {
    const cc = db.get('SELECT client_id FROM communications WHERE id=?', [Number(req.params.id)])
    if (cc?.client_id) import('./automations.js').then(m => m.emitAutomationEvent('call_disposition', cc.client_id, { disposition }, `disp_${req.params.id}_${disposition}`)).catch(() => {})
  }
  // "Do not call" during a call → set the lead's status to Do Not Contact. That
  // status pulls the lead out of every active drip + automation campaign
  // (stopSequencesForClient) and excludes them from bulk/automated outreach.
  // It does NOT set the text opt-out — only a STOP reply to our number does that.
  if (String(disposition || '').toLowerCase() === 'do not call') {
    const c = db.get('SELECT client_id FROM communications WHERE id=?', [Number(req.params.id)])
    if (c?.client_id) {
      db.run("UPDATE clients SET status='donotcontact', updated_at=? WHERE id=?", [new Date().toISOString(), c.client_id])
      const removed = stopSequencesForClient(c.client_id, 'do not call disposition')
      return res.json({ success: true, marked_do_not_contact: true, removed })
    }
  }
  res.json({ success: true })
})
router.post('/:id/read', (req, res) => { db.run("UPDATE communications SET status='read' WHERE id=?", [Number(req.params.id)]); res.json({ success: true }) })
router.post('/:id/unread', (req, res) => { db.run("UPDATE communications SET status='unread' WHERE id=?", [Number(req.params.id)]); res.json({ success: true }) })
router.post('/thread/:clientId/read', (req, res) => { db.run("UPDATE communications SET status='read' WHERE client_id=? AND status='unread'", [Number(req.params.clientId)]); res.json({ success: true }) })
router.post('/thread/:clientId/close', (req, res) => { db.run("UPDATE communications SET status='closed' WHERE client_id=?", [Number(req.params.clientId)]); res.json({ success: true }) })
router.delete('/:id', (req, res) => { db.run('DELETE FROM communications WHERE id=?', [Number(req.params.id)]); res.json({ success: true }) })

// ---- BULK TEXT campaign: dedup phones, exclude STOP opt-outs + no-phone, then
// queue sends in the background (safe pacing) so the request returns immediately.
// Returns the recipient breakdown up front; sent messages appear in the inbox. ----
router.post('/bulk-text', async (req, res) => {
  const { client_ids, body, bodies, template_id, name, created_by } = req.body || {}
  if (!Array.isArray(client_ids) || !client_ids.length) return res.status(400).json({ error: 'Select at least one recipient.' })
  // Multi-part: `bodies` is an ordered list of texts sent to each recipient in sequence
  // (e.g. a 3-part FSBO step). Falls back to the single `body`/template for compatibility.
  let parts = Array.isArray(bodies) ? bodies.map(b => String(b || '').trim()).filter(Boolean) : []
  if (!parts.length) {
    let msg0 = body
    if (template_id) { const t = db.get('SELECT body FROM templates WHERE id=?', [Number(template_id)]); if (t) msg0 = msg0 || t.body }
    if (msg0 && String(msg0).trim()) parts = [String(msg0).trim()]
  }
  if (!parts.length) return res.status(400).json({ error: 'A message is required.' })
  const msg = parts.join('\n\n')   // combined form for the campaign record + dup guard
  const { sendSms, twilioConfigured } = await import('../twilio.js')
  if (!twilioConfigured()) return res.status(400).json({ error: 'Texting isn’t connected yet.' })
  const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  // Double-launch guard: an identical body/name campaign started in the last 2 minutes
  // is almost certainly an accidental re-submit.
  const dupCampaign = db.get("SELECT id FROM text_campaigns WHERE ((name IS NOT NULL AND name = ?) OR body = ?) AND created_at >= datetime('now','-120 seconds') LIMIT 1", [name || null, msg])
  if (dupCampaign && !req.body?.force) return res.status(409).json({ error: 'An identical campaign was just launched moments ago. Re-send anyway?', duplicate: true })
  // Resolve the recipient list synchronously: dedup by phone, drop no-phone + STOP + Do Not Contact,
  // and skip anyone the AI or a human is actively handling / who was just texted (collision guard).
  const { canAutomatedSend } = await import('../ai-followup/policy.js')
  const seen = new Set(); const recipients = []
  let noPhone = 0, optedOut = 0, duplicates = 0, doNotContact = 0, collision = 0
  for (const cid of client_ids) {
    const c = db.get('SELECT * FROM clients WHERE id=?', [Number(cid)])
    const key = c && c.phone ? String(c.phone).replace(/\D/g, '').slice(-10) : ''
    if (!c || key.length < 10) { noPhone++; continue }
    if (seen.has(key)) { duplicates++; continue }
    seen.add(key)
    if (c.hub_text_opt_out) { optedOut++; continue }   // STOP-to-our-number
    if (isStopStatus(c.status)) { doNotContact++; continue }   // Do Not Contact / Junk — no campaign blasts
    // Agent-initiated blast: honor the chosen time (no quiet-hours block), but never
    // stack on an active AI/human conversation or a text we just sent.
    const gate = canAutomatedSend(c, { source: 'bulk', dedupMinutes: 60, respectQuietHours: false })
    if (!gate.ok) { collision++; continue }
    recipients.push(c)
  }
  // Record the campaign up front for auditing.
  const camp = db.run('INSERT INTO text_campaigns (name, created_by, body, template_id, total, queued, excluded_no_phone, excluded_stop, excluded_dnc, excluded_dup, status) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [name || null, created_by || null, msg, template_id || null, client_ids.length, recipients.length, noPhone, optedOut, doNotContact, duplicates, 'sending'])
  const campaignId = camp.lastInsertRowid
  // Fire the sends in the background so we never hit the HTTP timeout on big lists.
  // Pace BETWEEN people so a blast doesn't fire all at once (better deliverability + looks
  // human). Configurable via pace_seconds; default a natural 5 to 8 second gap, jittered.
  const paceOverrideMs = Number(req.body?.pace_seconds) > 0 ? Number(req.body.pace_seconds) * 1000 : null
  ;(async () => {
    let sent = 0
    for (const c of recipients) {
      try {
        const name2 = `${c.first_name || ''} ${c.last_name || ''}`.trim()
        let anySent = false
        const personPaceMs = paceOverrideMs != null ? paceOverrideMs : (5000 + Math.floor(Math.random() * 3000))
        for (let pi = 0; pi < parts.length; pi++) {
          const outText = fillTemplate(parts[pi], c).replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim()
          if (!outText) continue
          const r = await sendSms(c.phone, outText, { statusCallback: hub + '/api/inbox/twilio-status' })
          db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, campaign_id, occurred_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ['text', 'outgoing', c.id, name2, '', c.phone, outText.replace(/\s+/g, ' ').slice(0, 160), outText, 'twilio_' + r.sid, `c${c.id}_text`, 'read', r.status || 'queued', campaignId, nowIso()])
          anySent = true
          // ~5s between parts to the same person so they arrive in order; then the per-person pace.
          await new Promise(rs => setTimeout(rs, pi < parts.length - 1 ? 5000 : personPaceMs))
        }
        if (anySent) sent++
      } catch (e) {
        console.error('[bulk-text] send error:', e.message)
        try { const { recordFailure } = await import('../failures.js'); recordFailure('bulk', { ref: c.id, summary: `Bulk text failed to ${c.first_name || ''} ${c.last_name || ''}`.trim(), error: e.message }) } catch {}
      }
    }
    db.run("UPDATE text_campaigns SET status='sent', queued=?, completed_at=? WHERE id=?", [sent, nowIso(), campaignId])
    console.log(`[bulk-text] campaign ${campaignId} done: sent ${sent}`)
  })()
  res.json({ campaign_id: campaignId, queued: recipients.length, excluded: { no_phone: noPhone, opted_out_stop: optedOut, do_not_contact: doNotContact, duplicate_number: duplicates, active_conversation: collision }, total: client_ids.length })
})

// ---- bulk campaign list + per-campaign live counts (delivered/failed/replies/opt-outs) ----
router.get('/campaigns', (_req, res) => {
  const rows = db.all('SELECT * FROM text_campaigns ORDER BY id DESC LIMIT 100')
  const out = rows.map(camp => {
    const agg = db.get(`SELECT
        COUNT(*) sent,
        SUM(CASE WHEN delivery_status='delivered' THEN 1 ELSE 0 END) delivered,
        SUM(CASE WHEN delivery_status IN ('failed','undelivered') THEN 1 ELSE 0 END) failed
      FROM communications WHERE campaign_id=? AND direction='outgoing'`, [camp.id]) || {}
    // replies = distinct recipients who texted us back after the campaign started
    const replies = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications
      WHERE direction='incoming' AND channel='text' AND occurred_at > ?
        AND client_id IN (SELECT DISTINCT client_id FROM communications WHERE campaign_id=?)`, [camp.created_at, camp.id])?.n || 0
    const optOuts = db.get(`SELECT COUNT(*) n FROM clients WHERE hub_text_opt_out=1 AND id IN (SELECT DISTINCT client_id FROM communications WHERE campaign_id=?)`, [camp.id])?.n || 0
    return { ...camp, sent: agg.sent || 0, delivered: agg.delivered || 0, failed: agg.failed || 0, replies, opt_outs: optOuts }
  })
  res.json(out)
})

// ---- SCHEDULED one-to-one texts: queue now, a background tick sends at send_at ----
router.post('/schedule-text', (req, res) => {
  const { client_id, body, media, send_at, created_by, timezone } = req.body || {}
  const cid = Number(client_id) || null
  const mediaArr = Array.isArray(media) ? media.filter(Boolean).slice(0, 10) : []
  if (!body && !mediaArr.length) return res.status(400).json({ error: 'A message is required.' })
  const when = new Date(send_at)
  if (!send_at || isNaN(when.getTime())) return res.status(400).json({ error: 'A valid send time is required.' })
  if (when.getTime() < Date.now() + 30000) return res.status(400).json({ error: 'Pick a time at least a minute in the future.' })
  const c = cid ? db.get('SELECT id, phone, hub_text_opt_out, status FROM clients WHERE id=?', [cid]) : null
  if (cid && !c) return res.status(404).json({ error: 'client not found' })
  if (c && !c.phone) return res.status(400).json({ error: 'no phone on file for this contact' })
  if (c && c.hub_text_opt_out) return res.status(400).json({ error: 'this contact replied STOP to our number — texting is blocked' })
  const r = db.run('INSERT INTO scheduled_texts (client_id, phone, body, media_url, send_at, timezone, created_by) VALUES (?,?,?,?,?,?,?)',
    [cid, c ? c.phone : (req.body?.phone || null), body || '', mediaArr.length ? JSON.stringify(mediaArr.map(u => ({ url: u, type: 'image' }))) : null, when.toISOString(), timezone || null, created_by || null])
  res.json({ success: true, id: r.lastInsertRowid, send_at: when.toISOString() })
})
router.get('/scheduled', (req, res) => {
  const cid = Number(req.query.client_id) || null
  const rows = cid
    ? db.all("SELECT * FROM scheduled_texts WHERE client_id=? AND status='scheduled' ORDER BY send_at ASC", [cid])
    : db.all("SELECT * FROM scheduled_texts WHERE status='scheduled' ORDER BY send_at ASC LIMIT 200")
  res.json(rows)
})
router.post('/scheduled/:id/cancel', (req, res) => {
  db.run("UPDATE scheduled_texts SET status='canceled' WHERE id=? AND status='scheduled'", [Number(req.params.id)])
  res.json({ success: true })
})
// Send a scheduled text immediately instead of waiting for its send_at.
router.post('/scheduled/:id/send-now', async (req, res) => {
  try { const m = await import('../scheduled-texts.js'); res.json(await m.sendScheduledNow(Number(req.params.id))) }
  catch (e) { res.status(500).json({ ok: false, error: e.message }) }
})

// ---- VOICEMAIL DROP: during a live outbound call that reached the callee's
// voicemail, redirect the callee leg to play a saved recording, then hang up. ----
router.post('/drop-voicemail', async (req, res) => {
  const { parent_sid, voicemail_id, url } = req.body || {}
  let audioUrl = url
  if (!audioUrl && voicemail_id) { const v = db.get('SELECT url FROM voicemails WHERE id=?', [Number(voicemail_id)]); audioUrl = v?.url }
  if (!audioUrl) return res.status(400).json({ error: 'Pick a voicemail to drop.' })
  const { vmDropChildMap } = await import('../voice-state.js')
  let childSid = parent_sid ? vmDropChildMap.get(parent_sid)?.childSid : null
  if (!childSid) { // fallback: the most recent active callee leg (single softphone)
    let latest = null
    for (const [, val] of vmDropChildMap) if (!latest || val.at > latest.at) latest = val
    childSid = latest?.childSid
  }
  if (!childSid) return res.status(409).json({ error: 'No active call to drop into. Drop once the call is connected to their voicemail.' })
  try {
    const { updateCallTwiml } = await import('../twilio.js')
    await updateCallTwiml(childSid, `<Response><Play>${escHtml(audioUrl)}</Play><Hangup/></Response>`)
    if (parent_sid) db.run("UPDATE communications SET disposition='Left voicemail' WHERE external_id=?", ['twiliocall_' + parent_sid])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

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
  const { channel, subject, body } = req.body || {}
  const client_ids = Array.isArray(req.body?.client_ids) ? req.body.client_ids : []
  // Raw phone recipients (e.g. team agents not in the CRM): [{ phone, name }] or ["+1..."].
  const rawPhones = Array.isArray(req.body?.phones) ? req.body.phones.map(p => (typeof p === 'string' ? { phone: p } : p)).filter(p => p && p.phone) : []
  // media: array of public https URLs (from /upload-media) to attach as MMS
  const media = Array.isArray(req.body?.media) ? req.body.media.filter(Boolean).slice(0, 10) : []
  if (!client_ids.length && !rawPhones.length) return res.status(400).json({ error: 'Add at least one recipient.' })
  if (!body && !(channel === 'text' && media.length)) return res.status(400).json({ error: 'A message is required.' })

  // ---- TEXT (Twilio) ----
  if (channel === 'text') {
    const { sendSms, twilioConfigured } = await import('../twilio.js')
    if (!twilioConfigured()) return res.status(400).json({ error: 'Texting isn’t connected yet — add your Twilio details in Settings and turn it on.' })
    const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const results = []
    for (const cid of client_ids) {
      const c = db.get('SELECT * FROM clients WHERE id = ?', [Number(cid)])
      if (!c || !c.phone) { results.push({ client_id: cid, ok: false, error: 'no phone on file' }); continue }
      if (c.hub_text_opt_out) { results.push({ client_id: cid, ok: false, error: 'replied STOP to our number — texting blocked (you can still call)' }); continue }
      const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
      // Fill merge fields per recipient, then strip any UNRESOLVED {{...}} so a
      // customer never receives a raw placeholder.
      const outText = fillTemplate(body || '', c).replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim()
      if (!outText && !media.length) { results.push({ client_id: cid, ok: false, error: 'message empty after merge fields' }); continue }
      try {
        const r = await sendSms(c.phone, outText, { statusCallback: hub + '/api/inbox/twilio-status', mediaUrls: media })
        const preview = (String(outText).replace(/\s+/g, ' ').trim() || (media.length ? `[${media.length} photo${media.length === 1 ? '' : 's'}]` : '')).slice(0, 160)
        db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, has_attachment, media_url, delivery_status, agent, sent_by_type, occurred_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['text', 'outgoing', c.id, name, '', c.phone, null, preview, outText, 'twilio_' + r.sid, `c${c.id}_text`, 'read', media.length ? 1 : 0, media.length ? JSON.stringify(media.map(u => ({ url: u, type: 'image' }))) : null, r.status || 'queued', req.body?.agent || null, 'human', nowIso()])
        // A human texting an AI-managed lead → AI backs off (only if AI already touched this lead).
        if (db.get('SELECT client_id FROM ai_lead_state WHERE client_id=?', [c.id])) { try { const { humanTakeover } = await import('../ai-followup/state.js'); humanTakeover(c.id, 'agent sent a text') } catch {} }
        results.push({ client_id: cid, ok: true })
      } catch (e) { results.push({ client_id: cid, ok: false, error: e.message }) }
    }
    // Raw phone recipients (team agents etc.) — no CRM record, no consumer compliance gate.
    for (const rp of rawPhones) {
      const outText = String(body || '').replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim()
      if (!outText && !media.length) { results.push({ phone: rp.phone, ok: false, error: 'empty message' }); continue }
      try {
        const r = await sendSms(rp.phone, outText, { statusCallback: hub + '/api/inbox/twilio-status', mediaUrls: media })
        const p10 = String(rp.phone).replace(/\D/g, '').slice(-10)
        db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, has_attachment, media_url, delivery_status, agent, sent_by_type, occurred_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['text', 'outgoing', null, rp.name || fmtPhone(rp.phone), '', rp.phone, (outText || `[${media.length} photo]`).slice(0, 160), outText, 'twilio_' + r.sid, `u_${p10}`, 'read', media.length ? 1 : 0, media.length ? JSON.stringify(media.map(u => ({ url: u, type: 'image' }))) : null, r.status || 'queued', req.body?.agent || null, 'human', nowIso()])
        results.push({ phone: rp.phone, ok: true })
      } catch (e) { results.push({ phone: rp.phone, ok: false, error: e.message }) }
    }
    return res.json({ sent: results.filter(r => r.ok).length, results })
  }

  // ---- EMAIL (SendGrid) ----
  if (!subject) return res.status(400).json({ error: 'Subject and message are required.' })
  const results = []
  for (const cid of client_ids) {
    const c = db.get('SELECT * FROM clients WHERE id = ?', [Number(cid)])
    const hard = emailHardBlock(c)
    if (hard) { results.push({ client_id: cid, ok: false, error: hard }); continue }
    // Opted-out contacts are allowed (tagged in the UI), per team policy.
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

// Read-only: actual Twilio balance + today's & this month's Lookup usage/charges,
// so we can see exactly what the line-type scrub cost (not an estimate).
router.get('/twilio-usage', async (_req, res) => {
  const { twilioConfig } = await import('../twilio.js')
  const c = twilioConfig()
  if (!c.sid || !c.token) return res.status(400).json({ error: 'twilio not configured' })
  const auth = 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
  const get = async (u) => { try { const r = await fetch(u, { headers: { Authorization: auth } }); return await r.json() } catch (e) { return { error: e.message } } }
  const bal = await get(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Balance.json`)
  const pick = (recs) => (recs || []).filter(r => /lookup/i.test(r.category)).map(r => ({ category: r.category, count: Number(r.count || 0), price: Number(r.price || 0), price_unit: r.price_unit }))
  const today = await get(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Usage/Records/Today.json?PageSize=500`)
  const month = await get(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Usage/Records/ThisMonth.json?PageSize=500`)
  const tRec = pick(today.usage_records), mRec = pick(month.usage_records)
  res.json({
    balance: bal.balance, currency: bal.currency,
    lookup_today: tRec, lookup_today_charge: +tRec.reduce((s, r) => s + r.price, 0).toFixed(4), lookup_today_count: tRec.reduce((s, r) => s + r.count, 0),
    lookup_month: mRec, lookup_month_charge: +mRec.reduce((s, r) => s + r.price, 0).toFixed(4), lookup_month_count: mRec.reduce((s, r) => s + r.count, 0),
  })
})

// Line-type scrub: run Twilio Lookup on AI-on leads and flag landlines / fixed VoIP as
// undeliverable (so they're dropped from the drip and never texted), improving sent rate.
// dry_run:true returns the candidate count + cost estimate. Processes up to `limit` per call
// (re-invoke while remaining>0). Sets sms_undeliverable + cancels their pending drip texts.
router.post('/scrub-line-types', async (req, res) => {
  const dryRun = req.body?.dry_run === true
  const limit = Math.min(Number(req.body?.limit) || 300, 600)
  // Only leads NOT already line-checked (sms_line_checked_at) so we never re-look-up a number.
  const rows = db.all(`SELECT c.id, c.phone, c.first_name, c.last_name FROM clients c
    WHERE c.merged_into IS NULL AND c.phone IS NOT NULL AND TRIM(c.phone) != ''
      AND (c.sms_undeliverable IS NULL OR c.sms_undeliverable = 0)
      AND c.sms_line_checked_at IS NULL
      AND ( EXISTS (SELECT 1 FROM ai_lead_state s WHERE s.client_id=c.id AND (s.ai_enabled=1 OR s.ai_managed=1))
         OR EXISTS (SELECT 1 FROM ai_scheduled_actions a WHERE a.client_id=c.id AND a.state='pending') )`)
  if (dryRun) return res.json({ candidates: rows.length, est_cost_usd: +(rows.length * 0.005).toFixed(2) })
  const batch = rows.slice(0, limit)
  const { lookupLineType } = await import('../twilio.js')
  const out = { checked: 0, mobile: 0, textable_other: 0, flagged_landline: 0, unknown: 0, errors: 0, flagged: [] }
  let idx = 0
  const worker = async () => {
    while (idx < batch.length) {
      const r = batch[idx++]
      const lt = await lookupLineType(r.phone)
      out.checked++
      if (lt.error) { out.errors++; continue }   // leave unchecked so a later run retries
      // Record the result so this number is never looked up again.
      try { db.run("UPDATE clients SET sms_line_type=?, sms_line_checked_at=? WHERE id=?", [lt.line_type || 'unknown', nowIso(), r.id]) } catch {}
      if (lt.textable === false) {
        out.flagged_landline++
        try { db.run("UPDATE clients SET sms_undeliverable=1, sms_undeliverable_reason=?, sms_undeliverable_at=? WHERE id=?", [`Twilio Lookup: ${lt.line_type}`, nowIso(), r.id]) } catch {}
        try { db.run("UPDATE ai_scheduled_actions SET state='canceled', error='landline/fixed-voip - removed from drip', updated_at=datetime('now') WHERE client_id=? AND state='pending'", [r.id]) } catch {}
        if (out.flagged.length < 100) out.flagged.push({ id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), line_type: lt.line_type })
      } else if (lt.line_type === 'mobile') out.mobile++
      else if (lt.line_type) out.textable_other++
      else out.unknown++
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
  out.remaining = Math.max(0, rows.length - batch.length)
  res.json(out)
})

// ===================== GROUP TEXTING (Twilio Conversations / group MMS) =====================
// Readiness check: is the account/number able to do true group MMS?
router.get('/group-status', async (_req, res) => {
  try { const { conversationsStatus } = await import('../twilio-conversations.js'); res.json(await conversationsStatus()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
// One-time setup: provision the Conversations service + point its webhook at the Hub.
router.post('/group-setup', async (_req, res) => {
  try {
    const { ensureConversationsWebhook } = await import('../twilio-conversations.js')
    const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    res.json({ service_sid: await ensureConversationsWebhook(hub), webhook: hub + '/api/inbox/conversations-webhook' })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// Send a group text: one real group-MMS conversation to all recipients.
// recipients: [{ client_id?, phone, name }]  — compliance-checked for known clients.
router.post('/group-text', async (req, res) => {
  const body = String(req.body?.body || '').trim()
  const raw = Array.isArray(req.body?.recipients) ? req.body.recipients : []
  if (!body) return res.status(400).json({ error: 'A message is required.' })
  // Resolve + compliance-check known clients; keep raw phones (team agents) as-is.
  const recipients = [], blocked = []
  for (const r of raw) {
    if (r.client_id) {
      const c = db.get('SELECT * FROM clients WHERE id=?', [Number(r.client_id)])
      if (!c || !c.phone) { blocked.push({ ...r, reason: 'no phone' }); continue }
      if (c.hub_text_opt_out) { blocked.push({ name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), reason: 'replied STOP' }); continue }
      recipients.push({ phone: c.phone, name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.phone, client_id: c.id })
    } else if (r.phone) {
      recipients.push({ phone: r.phone, name: r.name || null })
    }
  }
  if (recipients.length < 2) return res.status(400).json({ error: 'A group text needs at least 2 eligible recipients.', blocked })
  try {
    // Twilio binds each participant+proxy pair to ONE conversation, so re-texting the SAME
    // group must reuse the existing conversation instead of creating a new one (which errors
    // "binding already exists"). Find a prior group whose participant set matches exactly.
    const wantKeys = new Set(recipients.map(r => phoneKey(r.phone)).filter(Boolean))
    let reuseSid = null
    if (wantKeys.size >= 2) {
      for (const g of db.all("SELECT DISTINCT conversation_sid, group_meta FROM communications WHERE conversation_sid IS NOT NULL AND group_meta IS NOT NULL ORDER BY id DESC")) {
        try {
          const keys = new Set(((JSON.parse(g.group_meta).participants) || []).map(p => phoneKey(p.phone)).filter(Boolean))
          if (keys.size === wantKeys.size && [...wantKeys].every(k => keys.has(k))) { reuseSid = g.conversation_sid; break }
        } catch {}
      }
    }
    const { createGroupText, sendConversationMessage } = await import('../twilio-conversations.js')
    if (reuseSid) {
      const out = await sendConversationMessage(reuseSid, body)
      db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, sent_by_type, conversation_sid, occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['text', 'outgoing', null, 'You', '', '', body.replace(/\s+/g, ' ').slice(0, 160), body, 'conv_' + out.messageSid, 'grp_' + reuseSid, 'read', 'human', reuseSid, nowIso()])
      return res.json({ success: true, conversation_sid: reuseSid, reused: true, sent_to: recipients.length, blocked })
    }
    const out = await createGroupText({ recipients, body })
    const meta = JSON.stringify({ participants: out.participants.map(p => ({ phone: p.phone, name: p.name, client_id: p.client_id || null })) })
    const names = out.participants.map(p => p.name || p.phone).join(', ')
    db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, sent_by_type, conversation_sid, group_meta, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', null, `Group: ${names}`.slice(0, 120), '', '', body.replace(/\s+/g, ' ').slice(0, 160), body, 'conv_' + out.messageSid, 'grp_' + out.conversationSid, 'read', 'human', out.conversationSid, meta, nowIso()])
    res.json({ success: true, conversation_sid: out.conversationSid, sent_to: out.participants.length, skipped: out.skipped, blocked })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// Inbound: Twilio Conversations onMessageAdded webhook (group replies). Public.
router.post('/conversations-webhook', async (req, res) => {
  try {
    const b = req.body || {}
    const source = String(b.Source || '')
    const author = String(b.Author || '')
    // Only store INBOUND replies (from an SMS participant), not our own API sends.
    const isInbound = source.toUpperCase() === 'SMS' || /^\+?\d{6,}$/.test(author)
    if (isInbound && b.ConversationSid && b.Body) {
      const ext = 'conv_' + (b.MessageSid || `${b.ConversationSid}_${Date.now()}`)
      if (!db.get('SELECT id FROM communications WHERE external_id=?', [ext])) {
        const match = matchClient('text', author)
        const name = match ? `${match.first_name || ''} ${match.last_name || ''}`.trim() : fmtPhone(author)
        db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, conversation_sid, occurred_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['text', 'incoming', match ? match.id : null, name, author, '', String(b.Body).replace(/\s+/g, ' ').slice(0, 160), String(b.Body), ext, 'grp_' + b.ConversationSid, 'unread', b.ConversationSid, nowIso()])
      }
    }
  } catch (e) { console.error('[conversations-webhook]', e.message) }
  res.sendStatus(204)
})
// Reply INTO an existing group conversation (message goes to everyone).
router.post('/group-reply', async (req, res) => {
  const sid = String(req.body?.conversation_sid || '')
  const body = String(req.body?.body || '').trim()
  if (!sid || !body) return res.status(400).json({ error: 'A conversation and message are required.' })
  try {
    const { sendConversationMessage } = await import('../twilio-conversations.js')
    const out = await sendConversationMessage(sid, body)
    db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, sent_by_type, conversation_sid, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', null, 'You', '', '', body.replace(/\s+/g, ' ').slice(0, 160), body, 'conv_' + out.messageSid, 'grp_' + sid, 'read', 'human', sid, nowIso()])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// All messages in a group conversation (the group send + every reply), oldest first.
router.get('/group-thread', (req, res) => {
  const sid = String(req.query.sid || '')
  if (!sid) return res.json([])
  const rows = db.all('SELECT * FROM communications WHERE conversation_sid = ? ORDER BY occurred_at ASC LIMIT 500', [sid])
  try { db.run("UPDATE communications SET status='read' WHERE conversation_sid=? AND status='unread'", [sid]) } catch {}
  res.json(rows)
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
// Newest inbound message of ANY channel (text or email). The suggested reply
// used to only fire on emails, so text conversations never got a suggestion.
const latestIncoming = (rows) => [...rows].reverse().find(m => m.direction === 'incoming' && (m.channel === 'email' || m.channel === 'text'))

// SMS reply prompt — short, natural, no subject, no formal signature. Mirrors the
// team's texting voice (John with Matt Smith Team at RE/MAX; never salesy).
const REPLY_SYSTEM_TEXT = `You are drafting a TEXT MESSAGE reply as John with the Matt Smith Team (RE/MAX Concepts, Cedar Rapids / Marion, Iowa) to a client's text. Use ONLY the client records and the message thread provided.

First identify what the client is actually asking or telling you (their intent), then write a short text that directly addresses THAT, not a generic acknowledgement.

HARD RULES
- This is an SMS. Keep it short and natural, the way a real person texts. Usually 1 to 3 sentences. No greeting block, no formal signature, no email formatting.
- Never use em dashes or en dashes. Use commas, periods, or the word "to".
- Never invent facts, promises, prices, dates, or availability. Use only what is in the records and thread. If you don't know something, say you'll find out.
- Warm, friendly, conversational, confident, helpful. Never salesy, corporate, stiff, or pushy.
- Do NOT use filler like "Thank you for reaching out", "Just checking in", or "I wanted to follow up". Just reply naturally.
- Address their real intent. Add a natural next step ONLY when it fits. It is fine to reply with no ask.

Return ONLY this JSON:
{
  "intent": one of ${JSON.stringify(INTENTS)},
  "summary": "1-2 sentence plain summary of what they're asking and where the relationship stands, or ''",
  "reply": { "body": "the text message" }
}`
function threadTranscript(rows) {
  return rows.slice(-12).map(m => {
    const who = m.direction === 'outgoing' ? 'Matt (agent)' : (m.contact_name || 'Client')
    const when = String(m.occurred_at || '').slice(0, 16).replace('T', ' ')
    const text = m.channel === 'email' ? stripHtml(m.body || m.preview) : (m.body || m.preview || '')
    const tag = m.channel === 'text' ? ' (text)' : ''
    return `[${when}] ${who}${m.subject ? ' — ' + m.subject : ''}${tag}:\n${clip(text, 900)}`
  }).join('\n\n')
}
async function generateReply(client, rows, adjustInstruction, context, current) {
  const ai = getAiClient()
  if (!ai) return { error: 'AI is not configured (ANTHROPIC_API_KEY missing).' }
  // Draft in the channel of the latest inbound message: SMS reply for a text, email reply for an email.
  const inc = latestIncoming(rows)
  const channel = inc && inc.channel === 'text' ? 'text' : 'email'
  const system = channel === 'text' ? REPLY_SYSTEM_TEXT : REPLY_SYSTEM
  let dossier = {}
  try { dossier = buildDossier(client, await gatherFub(client.fub_person_id)) } catch {}
  const transcript = threadTranscript(rows)
  const extra = (adjustInstruction || context)
    ? `\nADJUST THE REPLY: ${adjustInstruction || ''}${context ? ` Extra context from the agent, treat as true and important: "${String(context).slice(0, 600)}".` : ''}\n`
      + (current && current.body ? `CURRENT DRAFT to revise:\n${current.subject ? `Subject: ${current.subject}\n` : ''}${current.body}\n` : '')
    : ''
  const userMsg = `CLIENT CONTEXT (JSON):\n${JSON.stringify(dossier)}\n\n${channel === 'text' ? 'MESSAGE' : 'EMAIL'} THREAD (oldest to newest):\n${transcript}\n${extra}\nReturn the JSON now.`
  let msg
  try { msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 1200, system, messages: [{ role: 'user', content: userMsg }] }) }
  catch (e) { return { error: e.message } }
  let out; try { out = parseJson(msg.content?.[0]?.text || '') } catch { return { error: 'AI returned an unreadable response.' } }
  out.channel = channel
  if (out.summary) out.summary = noDash(out.summary)
  if (out.reply) {
    out.reply.body = noDash(out.reply.body || '')
    out.reply.subject = channel === 'text' ? '' : noDash(out.reply.subject || '')
  }
  return out
}

// cached suggestion + intent + draft (no model call)
router.get('/thread/:clientId/ai', (req, res) => {
  const cid = Number(req.params.clientId)
  const client = db.get('SELECT id FROM clients WHERE id = ?', [cid])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  const rows = db.all('SELECT id, direction, channel, occurred_at FROM communications WHERE client_id = ? ORDER BY occurred_at ASC', [cid])
  const inc = latestIncoming(rows)
  const row = db.get('SELECT * FROM inbox_ai WHERE client_id = ?', [cid])
  const parse = (s) => { try { return JSON.parse(s || 'null') } catch { return null } }
  res.json({
    ai_available: !!process.env.ANTHROPIC_API_KEY,
    has_incoming: !!inc,
    channel: inc ? inc.channel : null,
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
  const inc = latestIncoming(rows)
  if (!inc) return res.json({ has_incoming: false })
  const out = await generateReply(client, rows)
  if (out.error) return res.status(502).json({ error: out.error })
  const suggestion = out.reply ? JSON.stringify(out.reply) : null
  const existing = db.get('SELECT draft FROM inbox_ai WHERE client_id = ?', [cid])
  db.run(`INSERT INTO inbox_ai (client_id, based_on_msg_id, intent, summary, suggestion, draft, updated_at) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(client_id) DO UPDATE SET based_on_msg_id=excluded.based_on_msg_id, intent=excluded.intent, summary=excluded.summary, suggestion=excluded.suggestion, updated_at=excluded.updated_at`,
    [cid, inc.id, out.intent || null, out.summary || null, suggestion, existing ? existing.draft : null, nowIso()])
  res.json({ has_incoming: true, channel: out.channel, intent: out.intent || null, summary: out.summary || null, suggestion: out.reply || null, stale: false })
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
