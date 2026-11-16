// Keyword search across every message.
//
// John, 2026-11-16: "a word in text that I can search and it shows all the results of
// messages for that word, for ex, woodland".
//
// What was there before only filtered the latest 1000 rows of ONE folder, in JavaScript,
// over contact_name + subject + preview. preview is the first 160 characters, so a word
// further into a message, or in a message older than the last 1000, could not be found.
//
// WHY THIS DOES NOT JUST SEARCH `body`
// communications is 368MB, nearly all of it base64 images inlined into email bodies. A
// `body LIKE '%woodland%'` reads all 368MB on every keystroke, which on Render's instance is
// seconds per search and hammers a disk that is already at 7.7GB of 10GB. So each row gets a
// `search_text`: the same message with the markup and the base64 taken out, capped short.
// Searching that reads a few MB instead of a few hundred.
import db from './database.js'

// Long enough to hold a real message, short enough that the column cannot become the next
// thing that fills the disk. Texts land around 100 bytes; only long emails reach the cap.
const MAX_TEXT = 1200

/** Strip a stored message down to the words a person would search for. */
export function searchableText(row) {
  const parts = [row?.subject, row?.body || row?.preview, row?.transcript, row?.call_summary]
  let s = parts.filter(Boolean).join(' \n ')
  if (!s) return ''
  s = String(s)
    // data: URIs first - a single inlined image is megabytes of base64 that matches nothing
    // anyone would type, and leaving it in is the whole problem this column exists to avoid.
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    // Any base64-looking run that survived (CID blobs, tracking blobs).
    .replace(/\b[A-Za-z0-9+/]{120,}={0,2}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return s.slice(0, MAX_TEXT)
}

/**
 * Fill search_text for rows that do not have it yet, oldest first, in one batch.
 * Resumable by design: it selects on `search_text IS NULL`, so it can be called repeatedly
 * and simply stops finding work. Returns how much is left.
 */
export function backfillSearchText(limit = 2000) {
  const rows = db.all(
    `SELECT id, subject, body, preview, transcript, call_summary
       FROM communications WHERE search_text IS NULL ORDER BY id LIMIT ?`, [limit])
  let done = 0
  for (const r of rows) {
    // An empty message still gets '' rather than NULL, otherwise it is picked up forever.
    try { db.run('UPDATE communications SET search_text = ? WHERE id = ?', [searchableText(r), r.id]); done++ } catch {}
  }
  const remaining = db.get('SELECT COUNT(*) n FROM communications WHERE search_text IS NULL')?.n || 0
  return { indexed: done, remaining }
}

/** How much of the table is searchable. */
export function searchIndexStatus() {
  const total = db.get('SELECT COUNT(*) n FROM communications')?.n || 0
  const pending = db.get('SELECT COUNT(*) n FROM communications WHERE search_text IS NULL')?.n || 0
  return { total, indexed: total - pending, pending, ready: pending === 0 }
}

/** A readable window around the first match, so the result list shows WHY it matched. */
export function snippetAround(text, term, width = 160) {
  const s = String(text || '')
  if (!s) return ''
  const i = s.toLowerCase().indexOf(String(term || '').toLowerCase())
  if (i < 0) return s.slice(0, width) + (s.length > width ? '…' : '')
  const start = Math.max(0, i - Math.floor(width / 3))
  const end = Math.min(s.length, start + width)
  return (start > 0 ? '…' : '') + s.slice(start, end).trim() + (end < s.length ? '…' : '')
}

/**
 * Every message matching `q`, newest first.
 *
 * Deliberately NOT scoped to a folder or a direction: John is looking for a word, and a word
 * he said is as findable as a word he was sent. The caller can narrow afterwards.
 *
 * The payload carries a snippet, never a body. Returning bodies here is how the inbox list
 * came to cost 3.3GB of bandwidth in a month.
 */
export function searchMessages(q, { limit = 200, channel = '', clientId = null } = {}) {
  const term = String(q || '').trim()
  if (term.length < 2) return { query: term, count: 0, results: [], error: 'Type at least 2 characters.' }

  // LIKE wildcards in a person's search string would otherwise silently change the query.
  const esc = term.replace(/[\\%_]/g, c => '\\' + c)
  const like = `%${esc}%`
  const where = ["(search_text LIKE ? ESCAPE '\\' OR contact_name LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')"]
  const params = [like, like, like]
  if (channel) { where.push('channel = ?'); params.push(channel) }
  if (clientId) { where.push('client_id = ?'); params.push(Number(clientId)) }

  const rows = db.all(
    `SELECT id, client_id, contact_name, channel, direction, subject, occurred_at, thread_key,
            status, from_addr, to_addr, search_text
       FROM communications
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at DESC
      LIMIT ?`, [...params, Math.min(Number(limit) || 200, 500)])

  return {
    query: term,
    count: rows.length,
    truncated: rows.length >= Math.min(Number(limit) || 200, 500),
    results: rows.map(r => ({
      id: r.id,
      client_id: r.client_id,
      contact_name: r.contact_name,
      channel: r.channel,
      direction: r.direction,
      subject: r.subject,
      occurred_at: r.occurred_at,
      thread_key: r.thread_key,
      status: r.status,
      who: r.direction === 'outgoing' ? (r.to_addr || '') : (r.from_addr || ''),
      snippet: snippetAround(r.search_text, term),
    })),
  }
}
