// System audit log (Phase 1). For SYSTEM actions — login, user/role changes, deletes,
// bulk SMS, AI autopilot/enable toggles, setting changes, exports. NOT for SMS/email
// conversation content (those have their own communications tables). Fire-and-forget:
// auditing must never break the action it records.
import db from '../database.js'

export function logAudit({ user_id = null, actor = null, action, entity_type = null, entity_id = null, metadata = null, req = null } = {}) {
  try {
    let ip = null, ua = null
    if (req) {
      ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null
      ua = String(req.headers['user-agent'] || '').slice(0, 300)
    }
    if (req?.user && user_id == null) user_id = req.user.id ?? null
    if (req?.user && actor == null) actor = req.user.email || req.user.name || (req.user.team ? 'team' : null)
    db.run(
      `INSERT INTO audit_log (user_id, actor, action, entity_type, entity_id, metadata_json, ip_address, user_agent) VALUES (?,?,?,?,?,?,?,?)`,
      [user_id, actor, String(action), entity_type, entity_id != null ? String(entity_id) : null, metadata ? JSON.stringify(metadata) : null, ip, ua]
    )
  } catch (e) { try { console.error('[audit] failed:', e.message) } catch {} }
}

export function recentAudit(limit = 200, { action = null, user_id = null } = {}) {
  const where = [], params = []
  if (action) { where.push('action = ?'); params.push(action) }
  if (user_id) { where.push('user_id = ?'); params.push(Number(user_id)) }
  const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`
  params.push(Math.min(1000, Number(limit) || 200))
  return db.all(sql, params)
}
