// Did the file really go out on the email?
//
// John, 2026-11-16: "how would I know if the pdf was really attached on the email therefore
// I want to see that on email".
//
// The has_attachment flag the Hub writes at send time only records what it TRIED to attach.
// If SendGrid dropped the part, or the composer sent an empty payload, that flag would still
// say yes. That is the same mistake as treating a Twilio message SID as proof of delivery:
// recording intent and calling it outcome.
//
// The only honest evidence is the message that actually went. Every send BCCs
// personal_email_bcc (matt@mattsmithteam.com), and that mailbox is connected over IMAP, so
// the delivered copy can be fetched and its MIME parts read. That is what this does, and it
// works on old sends too, because the copy has been sitting in the mailbox the whole time.
import db from './database.js'
import { searchMailboxesBySubject } from './gmail-inbox.js'

const DAY = 86400000
const norm = (s) => String(s || '').toLowerCase().trim()

/** Pull every address out of a parsed "to"/"from" header string. */
function addrs(s) {
  return (String(s || '').match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map(a => a.toLowerCase())
}

/**
 * Find the delivered copy of one outgoing email and report what was really attached.
 *
 * Returns a verdict rather than a boolean, because "we could not find the sent copy" is a
 * different answer from "the sent copy had no attachment", and showing the second when the
 * first is true would be a lie in the direction that matters.
 */
export async function verifySentAttachment(commId, { windowDays = 2 } = {}) {
  const m = db.get('SELECT * FROM communications WHERE id = ?', [Number(commId)])
  if (!m) return { ok: false, verdict: 'not_found', detail: 'No such message.' }
  if (m.channel !== 'email') return { ok: false, verdict: 'not_email', detail: 'Only an email can be checked this way.' }
  if (m.direction !== 'outgoing') return { ok: false, verdict: 'not_outgoing', detail: 'Only a message we sent can be checked.' }
  if (!m.subject) return { ok: false, verdict: 'no_subject', detail: 'This message has no subject to find it by.' }

  const sentAt = Date.parse(m.occurred_at || '') || Date.now()
  const since = new Date(sentAt - DAY).toISOString().slice(0, 10)

  let found
  try {
    found = await searchMailboxesBySubject(m.subject, { max: 25, since })
  } catch (e) {
    return { ok: false, verdict: 'mailbox_error', detail: e.message }
  }

  // The right copy: same recipient, closest in time to when we recorded the send.
  const want = norm(m.to_addr)
  const candidates = (found.messages || []).filter(x => {
    const within = Math.abs(Date.parse(x.date) - sentAt) < windowDays * DAY
    if (!within) return false
    return !want || addrs(x.to).includes(want) || addrs(x.from).includes(want)
  })
  candidates.sort((a, b) => Math.abs(Date.parse(a.date) - sentAt) - Math.abs(Date.parse(b.date) - sentAt))
  const hit = candidates[0]

  if (!hit) {
    // Deliberately NOT recorded as "no attachment": we did not see the message at all.
    return {
      ok: false, verdict: 'copy_not_found',
      detail: 'Could not find the sent copy in the connected mailboxes, so this is unproven either way.',
      searched: found.mailboxes,
    }
  }

  const real = hit.attachments || []
  const verdict = real.length ? 'attached' : 'no_attachment'
  const stamp = new Date().toISOString()

  // Write back what was REALLY on the message. If the Hub thought it sent a file and the
  // delivered copy has none, the row is corrected rather than left flattering.
  try {
    db.run('UPDATE communications SET has_attachment = ?, media_url = ?, attachment_verified_at = ?, attachment_verdict = ? WHERE id = ?',
      [real.length ? 1 : 0,
       real.length ? JSON.stringify(real.map(a => ({ filename: a.filename, type: a.type, bytes: a.bytes }))) : m.media_url || null,
       stamp, verdict, m.id])
  } catch { /* reporting the truth matters more than recording it */ }

  return {
    ok: true,
    verdict,
    verified_at: stamp,
    attachments: real,
    checked_copy: { mailbox: hit.mailbox, date: hit.date, to: hit.to, subject: hit.subject },
    claimed: !!m.has_attachment,
    // The case worth shouting about: the Hub said a file went and the delivered message
    // has none.
    mismatch: !!m.has_attachment && real.length === 0,
  }
}
