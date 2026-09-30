// What happens to a lead when a message fails.
//
// The Hub used to record that an email bounced and nothing else, so nothing downstream
// acted: 86 addresses SendGrid had already rejected were still marked sendable, 25 were
// still enrolled in live campaigns, and 61 sends were silently discarded before they left
// the building (John, 2026-09-30).
//
// The SMTP code decides, not a retry count. Half the bounces on file turned out to be
// recoverable, so a blanket "three strikes" would have been wrong in both directions: it
// keeps hammering dead mailboxes two extra times each, AND risks dropping real people
// whose inbox happened to be full that week.
//
//   PERMANENT   550 5.1.1 no such mailbox      stop on the FIRST failure
//   TEMPORARY   552 5.2.2 inbox full, 4.x.x    keep sending; stop after 3 over 30+ days
//   SPAM        the person pressed report      stop immediately, and tell a human
//
// Every stop writes a tag saying WHY, so the reason is visible on the profile and
// filterable in the Clients list rather than buried in a log.
import db from './database.js'

export const STOP_TAG = {
  hard: 'Email Stopped: Hard Bounce',
  spam: 'Email Stopped: Spam Report',
  soft: 'Email Stopped: Repeated Soft Bounce',
}

// A permanent failure is a 5.x.x code, EXCEPT the two 5.x.x codes that are really
// temporary: 5.2.2 is a full mailbox and 5.2.1 is an inactive one, and both recover.
// Gmail and Outlook both answer "inbox full" with a 5-series code, which is why reading
// the first digit alone would throw away real people.
const SOFT_5XX = /^5\.2\.[12]\b/
const PERMANENT_WORDS = /does not exist|no such user|user unknown|unknown user|invalid recipient|recipient rejected|recipient address rejected|address rejected|no mailbox|mailbox unavailable|account (?:has been )?(?:disabled|suspended|closed)|domain not found|permanent failure/i
const TEMPORARY_WORDS = /out of storage|over quota|quota exceed|mailbox full|inbox is full|inactive|temporarily|try again|throttl|rate limit|greylist|deferred|busy|timed? out/i

/**
 * Classify one failure. Returns 'permanent' | 'temporary' | 'spam' | 'unknown'.
 * Wording is checked BEFORE the status code, because the words are specific and a server
 * that answers oddly still says plainly what happened.
 */
export function classifyFailure({ event_type, sg_status, reason, bounce_type } = {}) {
  if (event_type === 'spamreport') return 'spam'
  const text = String(reason || '')
  const status = String(sg_status || '').trim()

  if (TEMPORARY_WORDS.test(text)) return 'temporary'
  if (PERMANENT_WORDS.test(text)) return 'permanent'
  if (SOFT_5XX.test(status)) return 'temporary'
  if (/^5/.test(status)) return 'permanent'
  if (/^4/.test(status)) return 'temporary'
  // 'blocked' is reputation or throttling, which passes on its own
  if (String(bounce_type || '').toLowerCase() === 'blocked') return 'temporary'
  if (event_type === 'dropped') return 'permanent'   // SendGrid already refused to try
  return 'unknown'
}

const nowIso = () => new Date().toISOString()

function addTag(client, tag) {
  let tags = []
  try { tags = JSON.parse(client.tags || '[]') } catch {}
  if (!Array.isArray(tags)) tags = []
  if (tags.includes(tag)) return null
  tags.push(tag)
  return JSON.stringify(tags)
}

/** How many DISTINCT days this address has failed softly, and over what span. */
export function softFailureHistory(clientId) {
  const rows = db.all(
    `SELECT DISTINCT date(occurred_at) d FROM email_events
      WHERE client_id = ? AND event_type IN ('bounce','dropped') ORDER BY d`, [clientId])
  if (!rows.length) return { count: 0, spanDays: 0 }
  const first = Date.parse(rows[0].d), last = Date.parse(rows[rows.length - 1].d)
  return { count: rows.length, spanDays: Math.round((last - first) / 864e5) }
}

export const SOFT_MIN_FAILURES = 3
export const SOFT_MIN_SPAN_DAYS = 30

/**
 * Apply the policy to one lead. Returns what it did, or null when nothing should change.
 * Writes the status, the reason tag, a note on the profile and an activity row.
 */
export function applyFailure(clientId, failure = {}, { dryRun = false } = {}) {
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(clientId)])
  if (!client) return null

  const kind = classifyFailure(failure)
  if (kind === 'unknown') return null

  let stop = null
  if (kind === 'permanent') stop = 'hard'
  else if (kind === 'spam') stop = 'spam'
  else {
    // temporary: only after it has failed repeatedly, over a long enough period that a
    // holiday-full mailbox has had every chance to recover
    const h = softFailureHistory(clientId)
    if (h.count >= SOFT_MIN_FAILURES && h.spanDays >= SOFT_MIN_SPAN_DAYS) stop = 'soft'
    else return { client_id: clientId, kind, action: 'kept', history: h }
  }

  const status = stop === 'spam' ? 'ReportedAsSpam' : 'WrongAddress'
  if (client.email_status === status) return { client_id: clientId, kind, action: 'already-stopped' }

  const tag = STOP_TAG[stop]
  const tags = addTag(client, tag)
  const detail = `${tag} — ${String(failure.reason || failure.event_type || 'no reason recorded').slice(0, 200)}`

  if (!dryRun) {
    db.run(`UPDATE clients SET email_status = ?, ${tags ? 'tags = ?,' : ''} updated_at = ? WHERE id = ?`,
      tags ? [status, tags, nowIso(), clientId] : [status, nowIso(), clientId])
    // A spam report is the person telling us to stop. Marketing stops; a human still owns
    // the relationship, which is why this is flagged rather than quietly filed away.
    if (stop === 'spam') db.run('UPDATE clients SET marketing_email_opt_out = 1 WHERE id = ?', [clientId])
    try {
      db.run(`INSERT INTO notes (title, content, related_type, related_id, created_at)
              VALUES (?,?,?,?,?)`, ['Email marketing stopped', detail, 'client', clientId, nowIso()])
    } catch {}
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_marketing_stopped', 'client', clientId, detail])
  }
  return { client_id: clientId, kind, action: 'stopped', stop, status, tag, reason: failure.reason || null }
}

/** Pull the lead out of anything still queued to email them. */
export function removeFromActiveDrips(clientId, { dryRun = false } = {}) {
  const rows = db.all("SELECT id, drip_id FROM drip_enrollments WHERE client_id = ? AND status = 'active'", [Number(clientId)])
  if (!rows.length || dryRun) return rows.length
  for (const r of rows)
    db.run("UPDATE drip_enrollments SET status='removed', completed_at=?, next_run_at=NULL WHERE id=?", [nowIso(), r.id])
  return rows.length
}
