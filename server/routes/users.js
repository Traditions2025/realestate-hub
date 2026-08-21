// User management (Phase 1). Owner/Admin only. Creating accounts, setting roles,
// enabling/disabling, resetting passwords. No hard deletes (preserve audit integrity —
// disable instead). Every mutation is written to the audit log.
import { Router } from 'express'
import db from '../database.js'
import { hashPassword } from '../auth/passwords.js'
import { ROLES, PERMISSIONS, isValidRole, can } from '../auth/rbac.js'
import { logAudit, recentAudit } from '../auth/audit.js'
import { requirePermission } from './auth.js'

const router = Router()
const pub = (u) => u && ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, status: u.status, two_factor_enabled: !!u.two_factor_enabled, last_login_at: u.last_login_at, created_at: u.created_at })

// Reference data for the UI.
router.get('/roles', requirePermission('users.manage'), (_req, res) => res.json({ roles: ROLES, permissions: PERMISSIONS }))

// System audit log (separate permission).
router.get('/audit', requirePermission('audit.view'), (req, res) => res.json(recentAudit(Number(req.query.limit) || 200, { action: req.query.action || null })))

router.get('/', requirePermission('users.manage'), (_req, res) => res.json(db.all('SELECT * FROM users ORDER BY name').map(pub)))

router.post('/', requirePermission('users.manage'), (req, res) => {
  const { name, email, phone, role, password } = req.body || {}
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' })
  if (!email || !/^\S+@\S+\.\S+$/.test(String(email))) return res.status(400).json({ error: 'A valid email is required.' })
  const r = (role && isValidRole(role)) ? String(role).toLowerCase() : 'agent'
  if (db.get('SELECT id FROM users WHERE lower(email)=lower(?)', [String(email).trim()])) return res.status(409).json({ error: 'A user with that email already exists.' })
  let hash = null, status = 'invited'
  if (password) { try { hash = hashPassword(password) } catch (e) { return res.status(400).json({ error: e.message }) } status = 'active' }
  const out = db.run('INSERT INTO users (name, email, phone, password_hash, role, status, password_changed_at) VALUES (?,?,?,?,?,?,?)',
    [String(name).trim(), String(email).trim(), phone ? String(phone).trim() : null, hash, r, status, hash ? new Date().toISOString() : null])
  logAudit({ action: 'user.created', entity_type: 'user', entity_id: out.lastInsertRowid, metadata: { email: String(email).trim(), role: r }, req })
  res.json({ success: true, id: out.lastInsertRowid })
})

router.put('/:id', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id)
  const u = db.get('SELECT * FROM users WHERE id=?', [id]); if (!u) return res.status(404).json({ error: 'User not found.' })
  const b = req.body || {}
  const sets = [], vals = [], changed = {}
  if (b.name !== undefined) { sets.push('name=?'); vals.push(String(b.name).trim()); changed.name = String(b.name).trim() }
  if (b.phone !== undefined) { sets.push('phone=?'); vals.push(b.phone ? String(b.phone).trim() : null) }
  if (b.role !== undefined) { if (!isValidRole(b.role)) return res.status(400).json({ error: 'Invalid role.' }); sets.push('role=?'); vals.push(String(b.role).toLowerCase()); changed.role = String(b.role).toLowerCase() }
  if (b.status !== undefined) { if (!['active', 'disabled', 'invited'].includes(b.status)) return res.status(400).json({ error: 'Invalid status.' }); sets.push('status=?'); vals.push(b.status); changed.status = b.status }
  // Never let the last active owner be demoted/disabled out of existence.
  if ((changed.role && u.role === 'owner' && changed.role !== 'owner') || (changed.status && u.role === 'owner' && changed.status !== 'active')) {
    const owners = db.get("SELECT COUNT(*) n FROM users WHERE role='owner' AND status='active'")?.n || 0
    if (owners <= 1) return res.status(400).json({ error: 'Cannot remove the last active owner.' })
  }
  if (!sets.length) return res.json({ success: true })
  sets.push("updated_at=datetime('now')"); vals.push(id)
  db.run(`UPDATE users SET ${sets.join(', ')} WHERE id=?`, vals)
  logAudit({ action: 'user.updated', entity_type: 'user', entity_id: id, metadata: changed, req })
  res.json({ success: true })
})

router.post('/:id/password', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id)
  const u = db.get('SELECT id FROM users WHERE id=?', [id]); if (!u) return res.status(404).json({ error: 'User not found.' })
  let hash; try { hash = hashPassword(req.body?.password) } catch (e) { return res.status(400).json({ error: e.message }) }
  db.run("UPDATE users SET password_hash=?, status=CASE WHEN status='invited' THEN 'active' ELSE status END, password_changed_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [hash, id])
  // Password change revokes existing sessions for that user.
  try { db.run("UPDATE user_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL", [id]) } catch {}
  logAudit({ action: 'user.password_reset', entity_type: 'user', entity_id: id, req })
  res.json({ success: true })
})

// Revoke all of a user's sessions (force re-login).
router.post('/:id/revoke-sessions', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id)
  db.run("UPDATE user_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL", [id])
  logAudit({ action: 'user.sessions_revoked', entity_type: 'user', entity_id: id, req })
  res.json({ success: true })
})

// Seed an initial OWNER if the users table is empty. Runs on boot. The legacy shared
// password keeps working regardless; this just makes per-user owner login available.
export function ensureOwnerSeed() {
  try {
    if ((db.get('SELECT COUNT(*) n FROM users')?.n || 0) > 0) return
    const email = (process.env.OWNER_EMAIL || 'mattsmithremax@gmail.com').trim()
    const pw = process.env.OWNER_PASSWORD || process.env.TEAM_PASSWORD || 'mattsmithteam2026'
    const hash = hashPassword(pw)
    db.run('INSERT INTO users (name, email, password_hash, role, status, password_changed_at) VALUES (?,?,?,?,?,datetime(\'now\'))',
      ['Matt Smith Team (Owner)', email, hash, 'owner', 'active'])
    logAudit({ actor: 'system', action: 'user.seeded_owner', entity_type: 'user', metadata: { email } })
    console.log('[users] seeded initial owner account:', email)
  } catch (e) { console.error('[users] owner seed failed:', e.message) }
}

export default router
