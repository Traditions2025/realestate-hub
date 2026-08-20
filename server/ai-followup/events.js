// HUB AI lead-event log. Deduped by dedup_key. Mirrors interesting things into the
// AI layer without replacing the automations event bus (they can coexist).
import db from '../database.js'
const nowIso = () => new Date().toISOString()

export function recordLeadEvent(clientId, eventType, source = 'hub', metadata = {}, dedupKey = null) {
  try {
    const key = dedupKey || `${eventType}_${clientId}_${Date.now()}`
    db.run(`INSERT OR IGNORE INTO lead_events (client_id, event_type, event_source, event_timestamp, metadata_json, dedup_key, created_at)
            VALUES (?,?,?,?,?,?,?)`,
      [clientId || null, eventType, source, nowIso(), JSON.stringify(metadata || {}).slice(0, 4000), key, nowIso()])
  } catch (e) { console.error('[lead-events]', e.message) }
}

export function recentLeadEvents(clientId, limit = 50) {
  return db.all('SELECT * FROM lead_events WHERE client_id=? ORDER BY id DESC LIMIT ?', [Number(clientId), limit])
}
