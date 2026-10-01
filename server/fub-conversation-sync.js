// Bring Follow Up Boss conversations into the Hub's timeline.
//
// The Hub's `communications` table already feeds both the Inbox and the profile timeline,
// so everything lands there and shows up without a second place to look. `external_id` is
// UNIQUE, which is what makes a re-run harmless.
//
// WHAT FUB WILL ACTUALLY GIVE US (probed 2026-09-30 against the live account):
//
//   notes    264,069  full body        bulk + incremental via updatedAfter
//   calls     38,280  outcome/duration bulk + incremental
//   texts    per person, full message  NO bulk - personId is required
//   emails   per person, CONTENT HIDDEN - FUB returns "[CONTENT HIDDEN]" for every
//            subject and body (51 of 51 sampled across 3 people), so email is not
//            synced. That is the API's answer, not a permission we can change.
//
// ONE DIRECTION for lead creation: a FUB person with no matching Hub lead is SKIPPED, never
// inserted. Pulling leads from FUB is what would create duplicates (John, 2026-09-30).
//
// NOTE BODIES ARE STRIPPED TO TEXT. Measured average is 2.4 KB of HTML per note, almost all
// of it Sierra Interactive email copies - 609 MB across 264k rows. The disk is 9.8 GB with
// 7.4 GB free, which would fit, except 10 backup copies of the database are retained, so
// every megabyte of growth costs ten. Stripping the markup keeps every note and every word
// while cutting roughly 2.4 KB to 0.5 KB. The Hub's timeline renders text, not email HTML.
import db from './database.js'
import { statfsSync } from 'fs'

export const SOURCES = { note: 'fub_note', call: 'fub_call', text: 'fub_text' }

// FUB stamps systemName from the X-System header, and fub-helper already sends
// 'MattSmithTeamHub'. That is the loop breaker: anything the Hub itself wrote into FUB is
// skipped on the way back, so a two-way sync cannot ping-pong.
export const HUB_SYSTEM_NAME = 'MattSmithTeamHub'

const BODY_CAP = 4000      // generous for a human note, far below a full HTML email
const PREVIEW_CAP = 180

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&mdash;': '-', '&ndash;': '-', '&hellip;': '...',
}

/**
 * HTML to readable text.
 *
 * Sierra pushes whole rendered emails into FUB as notes, so the body arrives as a styled
 * table. Script and style blocks go first (their CONTENTS are not text), block elements
 * become line breaks, then tags come out.
 */
export function htmlToText(html) {
  let s = String(html == null ? '' : html)
  if (!s) return ''
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v)
  s = s.replace(/&#(\d+);/g, (_, d) => { try { return String.fromCharCode(Number(d)) } catch { return ' ' } })
  s = s.replace(/[ \t ]+/g, ' ')
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n')
  return s.trim()
}

export const cap = (s, n) => {
  const t = String(s == null ? '' : s)
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…'
}

/** fub_person_id -> Hub client id, for the whole run. */
export function personMap() {
  const m = new Map()
  for (const r of db.all(
    `SELECT id, fub_person_id, trim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,'')) nm
       FROM clients
      WHERE merged_into IS NULL AND fub_person_id IS NOT NULL AND fub_person_id != ''`))
    m.set(String(r.fub_person_id), { id: r.id, name: r.nm })
  return m
}

const iso = (v) => {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

/** A FUB note as a Hub timeline row. */
export function mapNote(n, who) {
  const text = htmlToText(n.body)
  const subject = cap(String(n.subject || '').trim() || 'Note', 200)
  return {
    channel: 'note',
    direction: 'internal',             // a note is not sent to anyone
    client_id: who.id,
    contact_name: who.name || null,
    from_addr: null, to_addr: null,
    subject,
    preview: cap(text || subject, PREVIEW_CAP),
    body: cap(text, BODY_CAP),
    external_id: `${SOURCES.note}_${n.id}`,
    thread_key: `fub_person_${n.personId}`,
    status: 'read',                    // history, never an unread item in the Inbox
    occurred_at: iso(n.created) || iso(n.updated),
    agent: String(n.createdBy || '').trim() || null,
    disposition: String(n.systemName || '').trim() || 'Follow Up Boss',
  }
}

/** A FUB call as a Hub timeline row. */
export function mapCall(c, who) {
  const note = htmlToText(c.note)
  const outcome = String(c.outcome || '').trim()
  return {
    channel: 'call',
    direction: c.isIncoming ? 'incoming' : 'outgoing',
    client_id: who.id,
    contact_name: who.name || null,
    from_addr: c.fromNumber || null,
    to_addr: c.toNumber || c.phone || null,
    subject: cap(outcome || 'Call', 200),
    preview: cap(note || outcome || 'Call logged in Follow Up Boss', PREVIEW_CAP),
    body: cap(note, BODY_CAP),
    external_id: `${SOURCES.call}_${c.id}`,
    thread_key: `fub_person_${c.personId}`,
    status: 'read',
    occurred_at: iso(c.startedAt) || iso(c.created),
    agent: String(c.userName || '').trim() || null,
    duration_sec: Number(c.duration) || null,
    recording_url: c.recordingUrl || null,
    disposition: outcome || null,
  }
}

/** A FUB text as a Hub timeline row. */
export function mapText(t, who) {
  const msg = String(t.message || '').trim()
  return {
    channel: 'text',
    direction: t.isIncoming ? 'incoming' : 'outgoing',
    client_id: who.id,
    contact_name: who.name || null,
    from_addr: t.fromNumber || null,
    to_addr: t.toNumber || null,
    subject: null,
    preview: cap(msg, PREVIEW_CAP),
    body: cap(msg, BODY_CAP),
    external_id: `${SOURCES.text}_${t.id}`,
    thread_key: `fub_person_${t.personId}`,
    status: 'read',
    occurred_at: iso(t.created),
    agent: String(t.userName || '').trim() || null,
    delivery_status: String(t.deliveryStatus || '').trim() || null,
    media_url: (Array.isArray(t.media) && t.media[0] && (t.media[0].url || t.media[0])) || null,
  }
}

const COLS = ['channel', 'direction', 'client_id', 'contact_name', 'from_addr', 'to_addr',
  'subject', 'preview', 'body', 'external_id', 'thread_key', 'status', 'occurred_at',
  'agent', 'duration_sec', 'recording_url', 'disposition', 'delivery_status', 'media_url']

/** Insert one row, ignoring anything already stored (external_id is UNIQUE). */
export function storeRow(row) {
  const vals = COLS.map(c => (row[c] === undefined ? null : row[c]))
  const r = db.run(
    `INSERT OR IGNORE INTO communications (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, vals)
  return r && r.changes ? 1 : 0
}

/**
 * Free space on the data volume, in GB.
 *
 * Checked before and during an import. The disk filled once before (2026-09-21) and the
 * retained backups mean the database's size is multiplied, so a long import watches its
 * own footprint rather than trusting a number measured at the start.
 */
export function freeGb() {
  try {
    const st = statfsSync(process.env.DB_DIR || '.')
    return (st.bavail * st.bsize) / 1073741824
  } catch { return null }
}

export const MIN_FREE_GB = 2.0

/** Where the last incremental pull reached, per kind. */
export const cursorKey = (kind) => `fub_sync_${kind}_updated_through`
export function getCursor(kind) { return db.getSetting(cursorKey(kind)) || null }
export function setCursor(kind, v) { if (v) db.setSetting(cursorKey(kind), v) }
