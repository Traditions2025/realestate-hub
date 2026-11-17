// When did each tag arrive on this lead?
//
// John, 2026-11-17: "when I hover the tag it should give me the info/date on when it was
// added."
//
// Nothing recorded this before. clients.tags is a flat JSON array of names with no dates,
// Sierra sends names only, and the one event type that could have carried it (tag_added in
// lead_events) is never written by anything. So tags already on a record CANNOT be dated,
// and this is careful to say "before tracking started" rather than invent a day.
//
// From 2026-11-17 a trigger on clients.tags records every change (see database.js). This
// turns those rows into a first-seen date per tag.
import db from './database.js'

const parse = (s) => {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    if (Array.isArray(v)) return v.map(x => String(x)).filter(Boolean)
  } catch {}
  // Older rows stored a comma-separated string.
  return String(s).split(',').map(x => x.trim()).filter(Boolean)
}

/**
 * The day tracking began. Anything older than this is undatable, not undated.
 *
 * Stamped lazily rather than during database init: getSetting is not reliably available
 * that early (the same ordering problem that makes followup's table init warn on boot), so
 * the value written there came back null. The earliest recorded change is a better answer
 * than "now" when one exists, because that IS when the trigger first saw something.
 */
export function trackingSince() {
  try {
    const stored = db.getSetting?.('tag_history_since', null)
    if (stored) return stored
    const first = db.get('SELECT MIN(changed_at) m FROM client_tag_history')?.m
    const since = first ? new Date(first + 'Z').toISOString() : new Date().toISOString()
    try { db.setSetting?.('tag_history_since', since) } catch {}
    return since
  } catch { return null }
}

/**
 * Returns { since, tags: { <tag>: { added_at, status, removed_at? } } }.
 *
 * status is 'tracked' when we watched it arrive, 'pre_existing' when it was already on the
 * record before tracking began. The difference matters: showing a lead's import date as if
 * it were the tag's date would be a confident wrong answer, which is worse than no answer.
 */
/**
 * Claim the change that was just made, so its date can be trusted and shown.
 *
 * Called by the deliberate tag actions only - somebody pressing + Tag, or removing one.
 * Everything else (the Sierra sync above all) leaves source NULL and stays undated.
 * Stamps the newest unclaimed row for this client, which the trigger has just written.
 */
export function attributeTagChange(clientId, source = 'hub') {
  const cid = Number(clientId)
  if (!cid) return
  try {
    db.run(`UPDATE client_tag_history SET source = ?
             WHERE id = (SELECT id FROM client_tag_history
                          WHERE client_id = ? AND source IS NULL
                          ORDER BY id DESC LIMIT 1)`, [String(source).slice(0, 40), cid])
  } catch { /* the date is a nicety; never break a tag edit over it */ }
}

export function tagHistoryFor(clientId) {
  const cid = Number(clientId)
  const since = trackingSince()
  const out = { since, tags: {} }
  if (!cid) return out

  const rows = db.all(
    'SELECT old_tags, new_tags, changed_at, source FROM client_tag_history WHERE client_id = ? ORDER BY id ASC',
    [cid])

  // Everything present before the first recorded change predates tracking. When there are
  // no rows at all, the lead's current tags are all pre-existing.
  const current = parse(db.get('SELECT tags FROM clients WHERE id = ?', [cid])?.tags)
  const baseline = rows.length ? parse(rows[0].old_tags) : current
  for (const t of baseline) out.tags[t] = { added_at: null, status: 'pre_existing' }

  for (const r of rows) {
    const before = new Set(parse(r.old_tags))
    for (const t of parse(r.new_tags)) {
      if (before.has(t)) continue
      // A DATE ONLY WHEN SOMEBODY CLAIMED THE CHANGE (John, 2026-11-17: "do not put the
      // sync date then since it's not accurate").
      //
      // The trigger catches every write, including the Sierra sync pulling tags a lead has
      // carried for months. Dating those by the day we happened to sync them would be a
      // confident wrong answer, which is worse than no answer. So an unclaimed change
      // records that the tag arrived without claiming to know WHEN it was really applied.
      // Re-added after a removal: the latest arrival is the honest answer.
      out.tags[t] = r.source
        ? { added_at: r.changed_at, status: 'tracked', source: r.source }
        : { added_at: null, status: 'undated_sync' }
    }
    const after = new Set(parse(r.new_tags))
    for (const t of before) {
      if (after.has(t)) continue
      if (out.tags[t]) out.tags[t].removed_at = r.changed_at
    }
  }

  // Only report on tags the lead actually has now.
  const live = new Set(current)
  for (const t of Object.keys(out.tags)) if (!live.has(t)) delete out.tags[t]
  for (const t of current) if (!out.tags[t]) out.tags[t] = { added_at: null, status: 'pre_existing' }

  return out
}
