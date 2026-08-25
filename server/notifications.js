// P2-4: notification center. A tiny persistence + query layer over the notifications
// table plus web-push fan-out (P2-3). notify() is the single entry point emitters use.
import db from './database.js'
const nowIso = () => new Date().toISOString()

// Create a notification. dedupKey makes repeat emits idempotent (returns existing).
export function notify({ type = 'info', title, body = '', link = '', client_id = null, dedupKey = null } = {}) {
  if (!title) return { ok: false }
  try {
    const key = dedupKey || null
    const r = db.run(
      `INSERT OR IGNORE INTO notifications (type, title, body, link, client_id, dedup_key, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [type, String(title).slice(0, 200), String(body || '').slice(0, 500), link || '', client_id, key, nowIso()])
    const inserted = r.changes > 0
    if (inserted) { try { pushToSubscribers({ type, title, body, link }) } catch {} }
    return { ok: true, id: r.lastInsertRowid, inserted }
  } catch (e) { return { ok: false, error: e.message } }
}

export function listNotifications({ limit = 30, unreadOnly = false } = {}) {
  const where = unreadOnly ? 'WHERE read = 0' : ''
  return db.all(`SELECT * FROM notifications ${where} ORDER BY id DESC LIMIT ?`, [Math.min(Number(limit) || 30, 100)])
}
export function unreadCount() { return db.get('SELECT COUNT(*) n FROM notifications WHERE read = 0').n }
export function markRead(id) { db.run('UPDATE notifications SET read = 1 WHERE id = ?', [Number(id)]) }
export function markAllRead() { db.run('UPDATE notifications SET read = 1 WHERE read = 0') }

// ---- Web push (P2-3) — best-effort, no-op until VAPID keys + subscriptions exist ----
export function pushToSubscribers(payload) {
  let subs = []
  try { subs = db.all('SELECT endpoint, p256dh, auth FROM push_subscriptions') } catch { return }
  if (!subs.length) return
  import('./web-push.js').then(m => m.sendPush(subs, payload)).catch(() => {})
}
