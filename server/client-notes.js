// The one place that knows what a profile note looks like.
//
// John, 2026-10-05: "make sure all notes logged in HUB have a date log and moving forward".
//
// clients.notes is a single text field, newest first, one note per line. Four different
// places were writing into it, each inventing its own stamp:
//
//   ClientProfile.jsx   [Oct 5, 2026, 3:04 PM]      browser local time
//   master-file-log.js  [10/5/2026]                  Central
//   automations.js      [Oct 5, 2026 · automation]   no time
//   lead-intake.js      [2026-10-05]                 appended, not prepended
//
// So whether a note carried a date depended on which code path wrote it, and the profile
// showed a date only when the line happened to match its one pattern. This module owns the
// format instead, and the clients PUT route runs ensureStamped over anything written, so a
// note cannot land undated whoever writes it.
//
// Times are Central. The team is in Cedar Rapids and a note's date is read by people, not
// parsed by machines - a server in UTC stamping "Oct 6" on a note typed at 7pm on Oct 5
// would be wrong on the only thing the stamp is for.

const TZ = 'America/Chicago'

// Any of the four historical stamps, so an old note is still read correctly.
// Deliberately broad: anything in leading brackets counts as this line's stamp.
export const STAMP = /^\[([^\]\n]{1,80})\]\s*/

/** "Oct 5, 2026, 3:04 PM" in Central, whatever zone the server runs in. */
export function stampFor(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when)
  const at = isNaN(d.getTime()) ? new Date() : d
  return at.toLocaleString('en-US', {
    timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  })
}

/** Split the field into notes. Returns the stamp and the text for each line. */
export function splitNotes(notes) {
  const lines = String(notes || '').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const m = raw.match(STAMP)
    if (m) { out.push({ index: i, endIndex: i, raw, stamp: m[1], text: raw.slice(m[0].length) }); continue }
    if (!raw.trim()) continue
    // An unstamped line AFTER a note is the rest of that note, not a new one.
    //
    // Someone pasting a multi-line block into the note box produced one stamped line
    // and N orphans: the live audit counted 85 "undated notes" across 28 leads, and
    // nearly all of them were the tail of a pasted Zillow price history. Treating them
    // as continuations gives them the REAL date of the note they belong to, instead of
    // stamping 85 fragments with a date nobody recorded (John, 2026-10-05).
    if (out.length) {
      const prev = out[out.length - 1]
      prev.raw += '\n' + raw
      prev.text += '\n' + raw
      prev.endIndex = i
      continue
    }
    out.push({ index: i, endIndex: i, raw, stamp: '', text: raw })
  }
  return out
}

/** One note, stamped. `by` is appended to the stamp, not the text, so it stays out of search. */
export function formatNote(text, { when = new Date(), by = '' } = {}) {
  const body = String(text || '').replace(/\r/g, '').trim()
  const who = String(by || '').trim()
  return `[${stampFor(when)}${who ? ` · ${who}` : ''}] ${body}`
}

/**
 * Every line carries a stamp. Lines that already have one keep it exactly - re-stamping a
 * note would overwrite the real date with today's, which is worse than no date at all.
 *
 * `when` is what an undated line gets. The caller decides what that should be; there is no
 * honest default for a note whose date nobody recorded, so a backfill passes the client's
 * created_at rather than letting this module invent "now".
 */
export function ensureStamped(notes, { when = new Date(), by = '' } = {}) {
  const text = String(notes ?? '')
  if (!text.trim()) return text
  const lines = text.split('\n')
  let seenNote = false
  return lines.map(line => {
    if (!line.trim()) return line
    if (STAMP.test(line)) { seenNote = true; return line }
    // Only a note that starts undated gets a stamp. A line after one is the rest of
    // that note and already carries its date; stamping it would split one note into
    // two and put today's date on half of it.
    if (seenNote) return line
    seenNote = true
    return formatNote(line, { when, by })
  }).join('\n')
}

/** Add a note to the top. The only way anything should be adding one. */
export function prependNote(existing, text, opts = {}) {
  const note = formatNote(text, opts)
  const prior = String(existing || '').trim()
  return prior ? `${note}\n${prior}` : note
}

/**
 * Replace one note's text, keeping its original stamp and marking that it was edited.
 *
 * `index` is the line's position in the RAW field, not in whatever filtered or paged list
 * the UI happens to be showing - editing note 3 of a search result must not rewrite note 3
 * of the file.
 */
export function replaceNote(notes, index, newText, { when = new Date(), by = '' } = {}) {
  const lines = String(notes ?? '').split('\n')
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) throw new Error('note not found')
  const body = String(newText || '').replace(/\r/g, '').trim()
  if (!body) throw new Error('a note cannot be emptied; delete it instead')
  // A note can span several lines, so the edit replaces all of them. Editing the first
  // line of a pasted block and leaving its tail behind would orphan the rest.
  const note = splitNotes(notes).find(n => n.index === i)
  const end = note ? note.endIndex : i
  const m = lines[i].match(STAMP)
  // An edit never silently rewrites history: the original stamp stays and the edit is
  // recorded beside it. A note edited twice says so once, with the latest date.
  const original = m ? m[1].replace(/\s*\(edited[^)]*\)\s*$/, '') : stampFor(when)
  const who = String(by || '').trim()
  lines.splice(i, end - i + 1, `[${original} (edited ${stampFor(when)}${who ? ` by ${who}` : ''})] ${body}`)
  return lines.join('\n')
}

/** Remove one note by its raw line index. */
export function removeNote(notes, index) {
  const lines = String(notes ?? '').split('\n')
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) throw new Error('note not found')
  // the whole note, including any continuation lines
  const note = splitNotes(notes).find(n => n.index === i)
  lines.splice(i, (note ? note.endIndex : i) - i + 1)
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** How many notes on this field have no date at all. */
export function undatedCount(notes) {
  return splitNotes(notes).filter(n => !n.stamp).length
}
