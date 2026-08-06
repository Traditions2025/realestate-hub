import { Router } from 'express'
import Busboy from 'busboy'
import db from '../database.js'
import { sendViaSendGrid } from './email.js'

const router = Router()
const nowIso = () => new Date().toISOString()

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
  const list = [...threads.values()].map(t => ({ ...t, channels: [...t.channels] }))
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
  if (channel === 'text') return res.status(400).json({ error: 'Texting turns on once Twilio is connected.' })
  if (!Array.isArray(client_ids) || !client_ids.length) return res.status(400).json({ error: 'Add at least one recipient.' })
  if (!subject || !body) return res.status(400).json({ error: 'Subject and message are required.' })
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

export default router
