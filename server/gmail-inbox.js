// Direct Gmail connection (no DNS) — reads new mail over IMAP with an App
// Password and drops client-matched incoming emails into the Inbox. Inert until
// credentials are saved in Settings. Cursor-based so it never re-reads old mail.
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import db, { getSetting, setSetting } from './database.js'

const nowIso = () => new Date().toISOString()

export function gmailConfigured() {
  return !!(getSetting('gmail_user', null) && getSetting('gmail_app_password', null))
}
export function gmailStatus() {
  return {
    configured: gmailConfigured(),
    user: getSetting('gmail_user', '') || '',
    connected: getSetting('gmail_connected', '0') === '1',
    last_poll: getSetting('gmail_last_poll', null),
    last_error: getSetting('gmail_last_error', '') || '',
    imported: Number(getSetting('gmail_imported_count', '0')) || 0,
  }
}
function matchClientByEmail(email) {
  if (!email) return null
  return db.get('SELECT id, first_name, last_name FROM clients WHERE lower(email) = lower(?) LIMIT 1', [String(email).trim()])
}

let _polling = false
export async function pollGmail() {
  if (_polling || !gmailConfigured()) return { skipped: true }
  _polling = true
  const user = getSetting('gmail_user')
  const pass = String(getSetting('gmail_app_password') || '').replace(/\s+/g, '') // Google shows app pw with spaces
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user, pass }, logger: false,
    greetingTimeout: 10000, socketTimeout: 45000,
  })
  let imported = 0
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      const status = await client.status('INBOX', { uidNext: true })
      const uidNext = status.uidNext || 1
      let cursor = Number(getSetting('gmail_last_uid', '0'))
      // First connect (or after reconnecting creds): seed to "now" so we only
      // capture mail that arrives AFTER connecting — never backfill the inbox.
      if (!cursor) {
        setSetting('gmail_last_uid', String(uidNext - 1))
        setSetting('gmail_connected', '1'); setSetting('gmail_last_error', ''); setSetting('gmail_last_poll', nowIso())
        return { seeded: true, from_uid: uidNext - 1 }
      }
      let maxUid = cursor, count = 0
      if (uidNext - 1 > cursor) {
        for await (const msg of client.fetch(`${cursor + 1}:*`, { uid: true, source: true, internalDate: true }, { uid: true })) {
          if (!msg.uid || msg.uid <= cursor) continue
          maxUid = Math.max(maxUid, msg.uid)
          if (++count > 200) break // storm guard
          let parsed
          try { parsed = await simpleParser(msg.source) } catch { continue }
          const fromEmail = (parsed.from?.value?.[0]?.address || '').toLowerCase()
          const c = matchClientByEmail(fromEmail)
          if (!c) continue // only store client-matched mail
          const extId = 'gmail_' + (parsed.messageId || `${user}_${msg.uid}`)
          if (db.get('SELECT id FROM communications WHERE external_id = ?', [extId])) continue
          const text = String(parsed.text || parsed.html || '').replace(/<[^>]+>/g, ' ')
          const preview = text.replace(/\s+/g, ' ').trim().slice(0, 160)
          const name = `${c.first_name || ''} ${c.last_name || ''}`.trim()
          db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, has_attachment, occurred_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ['email', 'incoming', c.id, name, fromEmail, user, parsed.subject || '(no subject)', preview,
              String(parsed.html || parsed.text || ''), extId, `c${c.id}_email`, 'unread',
              (parsed.attachments && parsed.attachments.length) ? 1 : 0,
              (msg.internalDate || parsed.date || new Date()).toISOString()])
          imported++
        }
      }
      setSetting('gmail_last_uid', String(maxUid))
      setSetting('gmail_connected', '1'); setSetting('gmail_last_error', ''); setSetting('gmail_last_poll', nowIso())
      if (imported) setSetting('gmail_imported_count', String((Number(getSetting('gmail_imported_count', '0')) || 0) + imported))
    } finally { lock.release() }
    await client.logout()
  } catch (e) {
    setSetting('gmail_connected', '0'); setSetting('gmail_last_error', e.message || String(e))
    try { await client.logout() } catch {}
    return { error: e.message }
  } finally { _polling = false }
  return { imported }
}
