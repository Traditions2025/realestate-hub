import { Router } from 'express'
import crypto from 'crypto'

const router = Router()

const TEAM_PASSWORD = process.env.TEAM_PASSWORD || 'mattsmithteam2026'
// SECRET stays consistent across restarts when set via env var
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'mst-hub-default-secret-change-me-in-prod'
const TOKEN_EXPIRY_DAYS = 30

// Sign a token: base64(payload).signature
function generateToken() {
  const payload = {
    t: 'team',
    iat: Date.now(),
    exp: Date.now() + TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url')
  return `${payloadB64}.${signature}`
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false
  const parts = token.split('.')
  if (parts.length !== 2) return false
  const [payloadB64, signature] = parts

  // Verify signature
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payloadB64).digest('base64url')
  if (signature !== expected) return false

  // Check expiry
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
    if (payload.exp < Date.now()) return false
    return true
  } catch {
    return false
  }
}

// Login
router.post('/login', (req, res) => {
  const { password } = req.body
  if (password === TEAM_PASSWORD) {
    const token = generateToken()
    res.json({ success: true, token })
  } else {
    res.status(401).json({ success: false, error: 'Wrong password' })
  }
})

// Verify token
router.get('/verify', (req, res) => {
  const token = req.headers['x-auth-token']
  if (verifyToken(token)) {
    res.json({ valid: true })
  } else {
    res.status(401).json({ valid: false })
  }
})

// Middleware
export function requireAuth(req, res, next) {
  if (req.path === '/api/auth/login' || req.path === '/api/auth/verify') return next()
  if (req.path === '/api/db-status') return next() // public diagnostics
  if (!req.path.startsWith('/api/')) return next()
  const token = req.headers['x-auth-token']
  if (verifyToken(token)) return next()
  res.status(401).json({ error: 'Unauthorized' })
}

export default router
