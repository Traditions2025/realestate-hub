// Direct inbox connections (no DNS). Reads new mail over IMAP with App Passwords
// and drops client-matched incoming emails into the Inbox. Supports MULTIPLE
// mailboxes (e.g. mattsmithremax@gmail.com + matt@mattsmithteam.com), each read
// directly so neither inbox has to forward the other's promo/spam. Cursor-based
// per mailbox so old mail is never re-read. Inert until a mailbox is added.
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import db, { getSetting, setSetting } from './database.js'
import { sendViaSendGrid } from './routes/email.js'

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

// Email a heads-up when a client emails the inbox. Recipient is configurable in
// app_settings (inbox_notify_email); defaults to the team's ops inbox. Fire and
// forget so it never blocks or breaks the poll loop.
// Senders we never want a heads-up about: our own operational accounts (John /
// the team) and hosting-platform status mail (Render). The message still lands in
// the inbox; we just skip the email nudge so real client mail isn't buried.
const NOTIFY_SKIP_SENDERS = ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com', 'matt@mattsmithteam.com']
function skipInboxNotify(fromEmail, subject, client) {
  const from = String(fromEmail || '').toLowerCase().trim()
  const cname = `${client?.first_name || ''} ${client?.last_name || ''}`.toLowerCase()
  const subj = String(subject || '').toLowerCase()
  if (NOTIFY_SKIP_SENDERS.includes(from)) return true                 // our own ops mail
  if (/john with the matt smith team/.test(cname)) return true        // matched to John's record
  if (/@?(render\.com|onrender\.com)/.test(from)) return true         // Render platform mail
  if (/server failure|exited with status|render\.com|onrender\.com|deploy (failed|succeeded|live)/.test(subj)) return true
  return false
}

// Base notification recipients: John + Matt ALWAYS get inbox-email alerts (same
// pair the TC digest uses). Anything in the inbox_notify_email setting is ADDED on
// top and de-duped, so both always get it regardless of any older single-address setting.
const BASE_NOTIFY_RECIPIENTS = 'johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com'

// Strip stacked Re:/Fwd: prefixes and report whether it was a reply, so the alert
// subject can read: <name> replied to your email "<original subject>".
function cleanReplySubject(subject) {
  let s = String(subject || '').trim()
  const isReply = /^\s*(re|fwd?|aw|antwort)\s*:/i.test(s)
  s = s.replace(/^\s*((re|fwd?|aw|antwort)\s*:\s*)+/i, '').trim()
  return { clean: s, isReply }
}

export async function notifyNewInbound(client, subject, preview, fromEmail) {
  if (skipInboxNotify(fromEmail, subject, client)) return
  // John + Matt always, plus any configured extra recipients.
  const extra = getSetting('inbox_notify_email', '') || ''
  const recipients = [...new Set((BASE_NOTIFY_RECIPIENTS + ',' + extra)
    .split(/[,;]+/).map(e => e.trim().toLowerCase()).filter(Boolean))]
  if (!recipients.length) return
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim() || fromEmail
  const { clean, isReply } = cleanReplySubject(subject)
  const shortClean = clean.length > 90 ? clean.slice(0, 89) + '…' : clean
  // Detailed subject line so it's clear at a glance what the reply is about.
  const notifySubject = isReply
    ? `${name} replied to your email "${shortClean || '(no subject)'}"`
    : (clean ? `${name} emailed you: "${shortClean}"` : `${name} emailed you`)
  const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  const lead = isReply
    ? `<strong>${esc(name)}</strong> replied to your email:`
    : `<strong>${esc(name)}</strong> just emailed the inbox:`
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
    <p style="margin:0 0 10px;">${lead}</p>
    <p style="margin:0 0 12px;font-size:16px;color:#0f172a;"><strong>&ldquo;${esc(shortClean || subject || '(no subject)')}&rdquo;</strong></p>
    <p style="margin:0 0 4px;"><strong>From:</strong> ${esc(fromEmail)}</p>
    <p style="margin:0 0 14px;color:#475569;">${esc(preview || '')}</p>
    <p style="margin:0;"><a href="${hub}/inbox" style="color:#2563eb;font-weight:600;">Open it in the Hub Inbox</a></p>
  </div>`
  await sendViaSendGrid(recipients.join(','), 'Matt Smith Team', notifySubject, html, null, [], [], [], 'inbox_notify')
}

const nowIso = () => new Date().toISOString()
const parse = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const mkId = () => 'mb' + Math.random().toString(36).slice(2, 8)

// Mailbox list lives in app_settings (never in git). One-time migration folds the
// old single-mailbox keys into the list so the existing connection carries over.
function getMailboxes() {
  let list = parse(getSetting('inbox_mailboxes', null), null)
  if (!list) {
    const u = getSetting('gmail_user', ''), p = getSetting('gmail_app_password', '')
    list = (u && p) ? [{
      id: mkId(), user: u, host: 'imap.gmail.com', port: 993, app_password: p, enabled: true,
      cursor: Number(getSetting('gmail_last_uid', '0')) || 0, connected: getSetting('gmail_connected', '0') === '1',
      last_error: getSetting('gmail_last_error', '') || '', last_poll: getSetting('gmail_last_poll', null),
      imported: Number(getSetting('gmail_imported_count', '0')) || 0,
    }] : []
    setSetting('inbox_mailboxes', JSON.stringify(list))
  }
  return list
}
function saveMailboxes(list) { setSetting('inbox_mailboxes', JSON.stringify(list)) }

export function mailboxesPublic() {
  return getMailboxes().map(m => ({
    id: m.id, user: m.user, host: m.host, enabled: m.enabled !== false, connected: !!m.connected,
    last_poll: m.last_poll || null, last_error: m.last_error || '', imported: m.imported || 0, has_password: !!m.app_password,
  }))
}
export function addMailbox({ user, app_password, host }) {
  const list = getMailboxes()
  const pw = String(app_password || '').replace(/\s+/g, '')
  const existing = list.find(m => m.user.toLowerCase() === String(user).trim().toLowerCase())
  if (existing) {
    if (pw) existing.app_password = pw
    if (host) existing.host = host
    existing.enabled = true; existing.cursor = 0; existing.connected = false; existing.last_error = ''
  } else {
    list.push({ id: mkId(), user: String(user).trim(), host: host || 'imap.gmail.com', port: 993, app_password: pw, enabled: true, cursor: 0, connected: false, last_error: '', last_poll: null, imported: 0 })
  }
  saveMailboxes(list)
  return list.find(m => m.user.toLowerCase() === String(user).trim().toLowerCase())?.id
}
export function removeMailbox(id) { saveMailboxes(getMailboxes().filter(m => m.id !== id)) }

function matchClientByEmail(email) {
  if (!email) return null
  return db.get('SELECT id, first_name, last_name FROM clients WHERE lower(email) = lower(?) LIMIT 1', [String(email).trim()])
}

// Poll one mailbox, mutating its runtime fields (cursor/connected/last_error…).
async function pollOne(m) {
  const pass = String(m.app_password || '').replace(/\s+/g, '')
  const client = new ImapFlow({ host: m.host || 'imap.gmail.com', port: m.port || 993, secure: true, auth: { user: m.user, pass }, logger: false, greetingTimeout: 10000, socketTimeout: 45000 })
  // ImapFlow is an EventEmitter — an unhandled 'error' event (e.g. the Gmail socket
  // dropping mid-idle overnight) would otherwise crash the whole process. Absorb it.
  client.on('error', (e) => { console.error('[gmail-inbox] imap socket error:', e && e.message ? e.message : e) })
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { uidNext: true })
      const uidNext = status.uidNext || 1
      if (!m.cursor) {
        m.cursor = uidNext - 1                       // first connect: start from "now"
      } else if (uidNext - 1 > m.cursor) {
        let maxUid = m.cursor, count = 0
        for await (const msg of client.fetch(`${m.cursor + 1}:*`, { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (!msg.uid || msg.uid <= m.cursor) continue
          // Cap the batch BEFORE advancing the cursor, so the message that trips
          // the cap stays above it and gets imported on the next poll.
          if (++count > 200) break
          maxUid = Math.max(maxUid, msg.uid)
          let parsed; try { parsed = await simpleParser(msg.source) } catch { continue }
          const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase()
          const c = matchClientByEmail(fromEmail)
          if (!c) continue
          const extId = 'gmail_' + (parsed.messageId || `${m.user}_${msg.uid}`)
          if (db.get('SELECT id FROM communications WHERE external_id = ?', [extId])) continue
          const text = String(parsed.text || parsed.html || '').replace(/<[^>]+>/g, ' ')
          const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160)
          const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
          db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, has_attachment, occurred_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ['email', 'incoming', c.id, name, fromEmail, m.user, parsed.subject || '(no subject)', preview,
              String(parsed.html || parsed.text || ''), extId, `c${c.id}_email`, 'unread',
              (parsed.attachments && parsed.attachments.length) ? 1 : 0, (msg.internalDate || parsed.date || new Date()).toISOString()])
          m.imported = (m.imported || 0) + 1
          notifyNewInbound(c, parsed.subject, preview, fromEmail).catch(() => {})
        }
        m.cursor = maxUid
      }
      m.connected = true; m.last_error = ''; m.last_poll = nowIso()
    } finally { lock.release() }
    await client.logout()
  } catch (e) {
    m.connected = false; m.last_error = e.message || String(e)
    try { await client.logout() } catch {}
  }
}

let _polling = false
export async function pollAllMailboxes() {
  if (_polling) return
  _polling = true
  try {
    const all = getMailboxes()
    const active = all.filter(m => m.enabled !== false && m.app_password)
    if (!active.length) return
    for (const m of active) await pollOne(m)   // mutates objects in `all`
    saveMailboxes(all)
  } finally { _polling = false }
}
export const pollGmail = pollAllMailboxes   // scheduler compatibility

export async function testMailbox(id) {
  const all = getMailboxes()
  const m = all.find(x => x.id === id)
  if (!m) return { error: 'mailbox not found' }
  await pollOne(m)
  saveMailboxes(all)
  return { connected: m.connected, last_error: m.last_error || '' }
}

// legacy status helper (kept so any old caller keeps working)
export function gmailStatus() {
  const boxes = mailboxesPublic()
  return { configured: boxes.length > 0, mailboxes: boxes }
}
