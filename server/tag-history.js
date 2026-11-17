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

/** The day the trigger went in. Anything older than this is undatable, not undated. */
export function trackingSince() {
  try { return db.getSetting?.('tag_history_since', null) || null } catch { return null }
}

/**
 * Returns { since, tags: { <tag>: { added_at, status, removed_at? } } }.
 *
 * status is 'tracked' when we watched it arrive, 'pre_existing' when it was already on the
 * record before tracking began. The difference matters: showing a lead's import date as if
 * it were the tag's date would be a confident wrong answer, which is worse than no answer.
 */
export function tagHistoryFor(clientId) {
  const cid = Number(clientId)
  const since = trackingSince()
  const out = { since, tags: {} }
  if (!cid) return out

  const rows = db.all(
    'SELECT old_tags, new_tags, changed_at FROM client_tag_history WHERE client_id = ? ORDER BY id ASC',
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
      // Re-added after a removal: the latest arrival is the honest answer.
      out.tags[t] = { added_at: r.changed_at, status: 'tracked' }
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
