// Failure visibility log (Phase 16 / P0-3). Records failed sends / AI actions / syncs /
// backups so nothing is silently lost, and admins can see + resolve them. Deliberately
// visibility-first: it does NOT auto-retry SMS sends (that could double-text). Fire-and-
// forget — recording a failure must never throw into the path that failed.
import db from './database.js'

// Record a failure. If an OPEN failure with the same kind+ref exists, bump its count
// instead of stacking duplicates.
export function recordFailure(kind, { ref = null, summary = null, error = null, payload = null } = {}) {
  try {
    const err = String(error && error.message ? error.message : error || '').slice(0, 600)
    const r = ref != null ? String(ref) : null
    const existing = r ? db.get("SELECT id FROM failed_jobs WHERE kind=? AND ref=? AND state='open' ORDER BY id DESC LIMIT 1", [kind, r]) : null
    if (existing) {
      db.run("UPDATE failed_jobs SET retry_count=retry_count+1, last_error=?, summary=COALESCE(?, summary), updated_at=datetime('now') WHERE id=?", [err, summary, existing.id])
    } else {
      db.run("INSERT INTO failed_jobs (kind, ref, summary, payload_json, last_error) VALUES (?,?,?,?,?)",
        [kind, r, summary || null, payload ? JSON.stringify(payload) : null, err])
    }
  } catch (e) { try { console.error('[failures] record failed:', e.message) } catch {} }
}

export function listFailures({ state = 'open', limit = 100 } = {}) {
  return db.all(`SELECT * FROM failed_jobs ${state === 'all' ? '' : 'WHERE state=?'} ORDER BY updated_at DESC, id DESC LIMIT ?`,
    state === 'all' ? [Math.min(500, limit)] : [state, Math.min(500, limit)])
}

export function failureCounts() {
  const rows = db.all("SELECT kind, COUNT(*) n FROM failed_jobs WHERE state='open' GROUP BY kind")
  const by = {}; let total = 0
  for (const r of rows) { by[r.kind] = r.n; total += r.n }
  return { total, by }
}

export function resolveFailure(id) { db.run("UPDATE failed_jobs SET state='resolved', updated_at=datetime('now') WHERE id=?", [Number(id)]); return { success: true } }
export function resolveAll(kind = null) {
  if (kind) db.run("UPDATE failed_jobs SET state='resolved', updated_at=datetime('now') WHERE state='open' AND kind=?", [kind])
  else db.run("UPDATE failed_jobs SET state='resolved', updated_at=datetime('now') WHERE state='open'")
  return { success: true }
}
