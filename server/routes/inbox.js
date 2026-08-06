import { Router } from 'express'
import db from '../database.js'

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

export default router
