import { Router } from 'express'
import crypto from 'crypto'
import db from '../database.js'
import { verifyPassword, hashPassword } from '../auth/passwords.js'
import { logAudit } from '../auth/audit.js'

const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))

const router = Router()

const TEAM_PASSWORD = process.env.TEAM_PASSWORD || 'mattsmithteam2026'
// SECRET stays consistent across restarts when set via env var
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'mst-hub-default-secret-change-me-in-prod'
const TOKEN_EXPIRY_DAYS = 30

// Sign a token from an arbitrary payload: base64url(payload).signature
function signToken(payload) {
  const body = { iat: Date.now(), exp: Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000, ...payload }
  const payloadB64 = Buffer.from(JSON.stringify(body)).toString('base64url')
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url')
  return `${payloadB64}.${signature}`
}
// Legacy shared-login token (team principal → treated as owner). Kept for backwards compat.
function generateToken() { return signToken({ t: 'team' }) }
// Per-user token, tied to a revocable session (jti).
function generateUserToken(user, req) {
  const jti = crypto.randomBytes(16).toString('hex')
  const expires = new Date(Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
  try {
    const ip = (req?.headers['x-forwarded-for'] || '').split(',')[0].trim() || req?.socket?.remoteAddress || null
    const ua = String(req?.headers['user-agent'] || '').slice(0, 300)
    db.run('INSERT INTO user_sessions (id, user_id, expires_at, ip_address, user_agent, last_seen_at) VALUES (?,?,?,?,?,datetime(\'now\'))', [jti, user.id, expires, ip, ua])
  } catch {}
  return signToken({ t: 'user', uid: user.id, role: user.role, jti })
}

// Decode + verify a token. Returns the payload object, or null if invalid/expired.
function decodeToken(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [payloadB64, signature] = parts
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url')
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    if (!payload.exp || payload.exp < Date.now()) return null
    return payload
  } catch { return null }
}
// Boolean check (kept for the query-token media/recording/stream proxies).
export function verifyToken(token) { return !!decodeToken(token) }

// Resolve the principal for a decoded token: legacy team → owner; user → the DB row.
function principalFor(payload) {
  if (!payload) return null
  if (payload.t === 'user' && payload.uid) {
    const sess = payload.jti ? db.get('SELECT id, revoked_at, expires_at FROM user_sessions WHERE id=?', [payload.jti]) : null
    if (payload.jti && (!sess || sess.revoked_at)) return null   // logged out / revoked
    const u = db.get('SELECT id, name, email, role, status FROM users WHERE id=?', [payload.uid])
    if (!u || u.status !== 'active') return null
    try { if (payload.jti) db.run('UPDATE user_sessions SET last_seen_at=datetime(\'now\') WHERE id=?', [payload.jti]) } catch {}
    return { id: u.id, name: u.name, email: u.email, role: u.role, jti: payload.jti }
  }
  // Legacy shared login = full-access owner principal (backwards compatible).
  if (payload.t === 'team') return { id: null, name: 'Team', email: null, role: 'owner', team: true }
  // Any other token type (e.g. a password-reset token) is NOT a valid auth principal.
  return null
}

// Short-lived, single-purpose token for password reset (distinct type so it can never
// authenticate a session — principalFor() rejects t !== 'team'|'user').
function signResetToken(uid) {
  const body = { t: 'reset', uid, iat: Date.now(), exp: Date.now() + 60 * 60 * 1000 } // 1 hour
  const p = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${p}.${crypto.createHmac('sha256', TOKEN_SECRET).update(p).digest('base64url')}`
}

// Login: accepts { email, password } for a per-user account, OR { password } for the
// legacy shared team password. Both issue a 30-day token.
router.post('/login', (req, res) => {
  const { username, email, password } = req.body || {}
  // A per-user identifier can be a username OR an email.
  const ident = String(username || email || '').trim()
  if (ident) {
    const u = db.get('SELECT * FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)', [ident, ident])
    const ok = u && u.status === 'active' && u.password_hash && verifyPassword(password, u.password_hash)
    if (!ok) { logAudit({ actor: ident, action: 'login.failed', metadata: { ident }, req }); return res.status(401).json({ success: false, error: 'Wrong username or password' }) }
    try { db.run('UPDATE users SET last_login_at=datetime(\'now\') WHERE id=?', [u.id]) } catch {}
    const token = generateUserToken(u, req)
    logAudit({ user_id: u.id, actor: u.email, action: 'login', req })
    return res.json({ success: true, token, user: { id: u.id, name: u.name, email: u.email, role: u.role } })
  }
  if (password === TEAM_PASSWORD) {
    const token = generateToken()
    logAudit({ actor: 'team', action: 'login.shared', req })
    return res.json({ success: true, token })
  }
  logAudit({ actor: 'team', action: 'login.failed', req })
  return res.status(401).json({ success: false, error: 'Wrong password' })
})

// Verify token (used by the client on boot).
router.get('/verify', (req, res) => {
  const p = principalFor(decodeToken(req.headers['x-auth-token']))
  if (p) return res.json({ valid: true, user: p.team ? null : { id: p.id, name: p.name, email: p.email, role: p.role } })
  return res.status(401).json({ valid: false })
})

// Who am I (attached by requireAuth).
router.get('/me', (req, res) => res.json({ user: req.user || null }))

// Logout: revoke the current per-user session (legacy team tokens are stateless no-ops).
router.post('/logout', (req, res) => {
  const p = decodeToken(req.headers['x-auth-token'])
  if (p?.jti) { try { db.run('UPDATE user_sessions SET revoked_at=datetime(\'now\') WHERE id=?', [p.jti]) } catch {} logAudit({ user_id: p.uid, action: 'logout', req }) }
  res.json({ success: true })
})

// Forgot password: email a reset link to the matching account. Always returns success
// (never reveals whether an email is on file).
router.post('/forgot-password', async (req, res) => {
  const email = String(req.body?.email || '').trim()
  try {
    const u = email ? db.get('SELECT id, name, email, status FROM users WHERE lower(email)=lower(?)', [email]) : null
    if (u && u.status === 'active') {
      const token = signResetToken(u.id)
      const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
      const link = `${hub.replace(/\/+$/, '')}/reset-password?token=${encodeURIComponent(token)}`
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6">
        <p>Hi ${esc(u.name || '')},</p>
        <p>We received a request to reset your Matt Smith Team Hub password. Click below to set a new one — this link expires in 1 hour:</p>
        <p><a href="${link}" style="display:inline-block;background:#2563eb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:600">Reset my password</a></p>
        <p style="color:#64748b;font-size:12px">If you didn't request this, you can safely ignore this email — your password won't change.</p></div>`
      const { sendViaSendGrid } = await import('./email.js')
      await sendViaSendGrid(u.email, 'Matt Smith Team', 'Reset your Hub password', html, null, [], [], [], 'password_reset').catch(() => {})
      logAudit({ user_id: u.id, actor: u.email, action: 'password.reset_requested', req })
    }
  } catch (e) { console.error('[forgot-password]', e.message) }
  res.json({ success: true })
})

// Complete a reset with the emailed token.
router.post('/reset-password', (req, res) => {
  const { token, password } = req.body || {}
  const p = decodeToken(token)
  if (!p || p.t !== 'reset' || !p.uid) return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' })
  const u = db.get('SELECT id, email, status FROM users WHERE id=?', [p.uid])
  if (!u || u.status !== 'active') return res.status(400).json({ error: 'Account not found or inactive.' })
  let hash; try { hash = hashPassword(password) } catch (e) { return res.status(400).json({ error: e.message }) }
  db.run("UPDATE users SET password_hash=?, password_changed_at=datetime('now'), updated_at=datetime('now') WHERE id=?", [hash, u.id])
  try { db.run("UPDATE user_sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL", [u.id]) } catch {}
  logAudit({ user_id: u.id, actor: u.email, action: 'password.reset_completed', req })
  res.json({ success: true })
})

// Middleware. Attaches req.user (principal). Legacy shared token → owner principal.
export function requireAuth(req, res, next) {
  if (req.path === '/api/auth/login' || req.path === '/api/auth/verify') return next()
  if (req.path === '/api/db-status') return next() // public diagnostics
  if (req.path === '/api/health') return next() // Render health probe — must be unauth
  if (req.path === '/api/sierra/webhook') return next() // Sierra calls this
  if (req.path === '/api/inbox/parse-inbound') return next() // SendGrid Inbound Parse posts here (no token)
  if (req.path === '/api/email/events') return next() // SendGrid Event Webhook (signature-verified when key configured)
  if (req.path === '/api/inbox/twilio-inbound') return next() // Twilio posts incoming texts here (no token)
  if (req.path === '/api/inbox/twilio-status') return next() // Twilio posts delivery status here (no token)
  if (req.path === '/api/inbox/conversations-webhook') return next() // Twilio Conversations (group MMS) inbound (no token)
  if (req.path === '/api/gdrive/connect' || req.path === '/api/gdrive/callback') return next() // Google OAuth browser redirects
  if (req.path.startsWith('/api/voice/') && req.path !== '/api/voice/token' && req.path !== '/api/voice/setup' && req.path !== '/api/voice/backfill-call-clients') return next() // Twilio Voice webhooks (signature-validated)
  if (req.path.startsWith('/api/social-media/img/')) return next() // public images so Meta/LinkedIn can fetch them
  if (req.path === '/api/social-media/queue' || req.path === '/api/social-media/result') return next() // n8n (checks its own shared key)
  if (req.path === '/api/track/beacon') return next() // tracking pixel beacons (public)
  if (req.path === '/track.js') return next() // tracking snippet served to public sites
  // Recording/voicemail media proxy: <audio> can't set headers, so accept a token
  // in the query string (validated the same way) as well as the header.
  if (req.path.startsWith('/api/inbox/recording/') || req.path.startsWith('/api/inbox/media/') || req.path === '/api/inbox/stream') {
    if (verifyToken(req.query.token) || verifyToken(req.headers['x-auth-token'])) return next()
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!req.path.startsWith('/api/')) return next()
  const principal = principalFor(decodeToken(req.headers['x-auth-token']))
  if (!principal) return res.status(401).json({ error: 'Unauthorized' })
  req.user = principal
  next()
}

// Route-level authorization guard: require a specific permission. Usage:
//   router.post('/x', requirePermission('clients.delete'), handler)
export function requirePermission(permission) {
  return (req, res, next) => {
    // Load lazily to avoid a require cycle at module init.
    import('../auth/rbac.js').then(({ can }) => {
      if (req.user && can(req.user.role, permission)) return next()
      logAudit({ action: 'authz.denied', entity_type: 'permission', entity_id: permission, req })
      res.status(403).json({ error: 'You do not have permission to do that.' })
    }).catch(() => res.status(403).json({ error: 'Forbidden' }))
  }
}

export default router
