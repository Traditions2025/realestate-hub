// HUB communications -> FUB.
//
// John, 2026-10-08: "make sure HUB communication records are push to FUB".
//
// The conversation sync brought FUB's history INTO the Hub. Nothing went the other way,
// so a text the Hub sent, a call it logged or an email it delivered was invisible to
// anyone working in FUB. This closes that side.
//
// ── Why it writes NOTES and not /textMessages ──────────────────────────────────────
// FUB's API has no endpoint for recording a text or an email that another system sent.
// /textMessages is read-only, and there is no "log this message" write. A note is the one
// place FUB accepts arbitrary content, which is also why FUB's own integrations
// (Structurely, Agent Legend) write their conversations into notes. So each Hub message
// becomes a note on the FUB person, prefixed with what it actually was.
//
// ── Why this cannot loop ───────────────────────────────────────────────────────────
// Three independent guards, because a sync that feeds itself is the one failure that
// grows without limit:
//   1. only rows the HUB originated are eligible - external_id twilio_* or hub_*, never
//      anything whose id starts fub_
//   2. every push is recorded in fub_comm_pushed, keyed on the communication id, so a
//      re-run is a no-op
//   3. the note body carries a marker, and the importer skips notes carrying it
import db from './database.js'
import { fubPost } from './fub-helper.js'

// Stamped on every note this writes. The FUB->HUB importer skips notes containing it, so
// a message cannot come back as a second copy of itself.
export const PUSH_MARKER = '[Hub]'

export function ensurePushTable() {
  db.run(`CREATE TABLE IF NOT EXISTS fub_comm_pushed (
    communication_id INTEGER PRIMARY KEY,
    fub_person_id INTEGER,
    fub_note_id INTEGER,
    pushed_at TEXT
  )`)
}

const fmtWhen = (iso) => {
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    })
  } catch { return String(iso || '') }
}

const CHANNEL_LABEL = {
  text: 'Text', email: 'Email', call: 'Call', voicemail: 'Voicemail', note: 'Note',
}

/** One Hub communication as the note body FUB will store. */
export function noteBody(m) {
  const what = CHANNEL_LABEL[m.channel] || m.channel
  const dir = m.direction === 'incoming' ? 'from' : 'to'
  const who = m.direction === 'incoming' ? (m.from_addr || '') : (m.to_addr || '')
  const head = `${PUSH_MARKER} ${what} ${dir} ${who || 'lead'} — ${fmtWhen(m.occurred_at)}`
  const bits = []
  if (m.subject) bits.push(`Subject: ${m.subject}`)
  if (m.duration_sec) bits.push(`Duration: ${Math.round(m.duration_sec / 60)}m ${m.duration_sec % 60}s`)
  if (m.delivery_status && m.direction === 'outgoing') bits.push(`Status: ${m.delivery_status}`)
  if (m.error_message) bits.push(`Error: ${m.error_message}`)
  const body = String(m.body || m.preview || '').trim()
  // A long email would otherwise push a FUB note to many KB; the Hub keeps the full copy.
  const text = body.length > 4000 ? body.slice(0, 4000) + '\n…(truncated; full copy in the Hub)' : body
  return [head, bits.join(' · '), '', text].filter(Boolean).join('\n')
}

/**
 * Rows eligible to push: Hub-originated, on a FUB-linked lead, not already pushed.
 *
 * `since` exists because the Hub holds years of history and pushing all of it would
 * bury a FUB record under thousands of notes. Forward-only by default.
 */
export function candidates({ afterId = 0, limit = 50, since = null, channels = null } = {}) {
  ensurePushTable()
  const chans = Array.isArray(channels) && channels.length ? channels : ['text', 'call', 'voicemail', 'email']
  const ph = chans.map(() => '?').join(',')
  const params = [...chans]
  let sql = `SELECT m.*, c.fub_person_id, c.first_name, c.last_name
    FROM communications m JOIN clients c ON c.id = m.client_id
    WHERE m.channel IN (${ph})
      AND c.fub_person_id IS NOT NULL
      AND c.merged_into IS NULL
      AND m.id > ?
      -- Hub-originated only. Anything imported FROM FUB keeps its fub_ id and is
      -- excluded here, which is the first and most important loop guard.
      AND (m.external_id LIKE 'twilio_%' OR m.external_id LIKE 'hub_%' OR m.external_id LIKE 'gmail_%')
      AND m.id NOT IN (SELECT communication_id FROM fub_comm_pushed)`
  params.push(Number(afterId) || 0)
  if (since) { sql += ' AND m.occurred_at >= ?'; params.push(since) }
  sql += ' ORDER BY m.id ASC LIMIT ?'
  params.push(Math.max(1, Math.min(Number(limit) || 50, 200)))
  return db.all(sql, params)
}

/**
 * Push a batch. Dry by default.
 *
 * Paced at 260ms on every call including the error path, because FUB rate-limits and a
 * dry run still costs nothing but is kept symmetrical so timing surprises show up early.
 */
export async function pushCommunications({
  dryRun = true, limit = 50, afterId = 0, since = null, channels = null, delayMs = 260,
} = {}) {
  ensurePushTable()
  const rows = candidates({ afterId, limit, since, channels })
  const out = { dry: dryRun, considered: rows.length, pushed: 0, failed: 0,
                last_id: Number(afterId) || 0, items: [] }
  for (const m of rows) {
    out.last_id = m.id
    const body = noteBody(m)
    if (dryRun) {
      out.items.push({ id: m.id, client: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
        fub: m.fub_person_id, channel: m.channel, preview: body.slice(0, 140) })
      continue
    }
    try {
      const r = await fubPost('/notes', { personId: Number(m.fub_person_id), subject: null, body })
      db.run('INSERT OR REPLACE INTO fub_comm_pushed (communication_id, fub_person_id, fub_note_id, pushed_at) VALUES (?,?,?,?)',
        [m.id, Number(m.fub_person_id), r?.id || null, new Date().toISOString()])
      out.pushed++
    } catch (e) {
      out.failed++
      out.items.push({ id: m.id, fub: m.fub_person_id, error: String(e.message).slice(0, 160) })
    }
    await new Promise(s => setTimeout(s, delayMs))
  }
  const left = db.get(`SELECT COUNT(*) c FROM communications m JOIN clients c ON c.id = m.client_id
    WHERE m.channel IN ('text','call','voicemail','email') AND c.fub_person_id IS NOT NULL
      AND c.merged_into IS NULL AND m.id > ?
      AND (m.external_id LIKE 'twilio_%' OR m.external_id LIKE 'hub_%' OR m.external_id LIKE 'gmail_%')
      AND m.id NOT IN (SELECT communication_id FROM fub_comm_pushed)`, [out.last_id])?.c || 0
  out.remaining = left
  out.done = left === 0
  return out
}
