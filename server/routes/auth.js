import { Router } from 'express'
import crypto from 'crypto'

const router = Router()

const TEAM_PASSWORD = process.env.TEAM_PASSWORD || 'mattsmithteam2026'
const TOKEN_SECRET = process.env.TOKEN_SECRET || crypto.randomBytes(32).toString('hex')
const TOKEN_EXPIRY_DAYS = 30

// Active tokens (in production you'd use a database, but this works for team size)
const validTokens = new Set()

function generateToken() {
  const token = crypto.randomBytes(32).toString('hex')
  validTokens.add(token)
  return token
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
  if (token && validTokens.has(token)) {
    res.json({ valid: true })
  } else {
    res.status(401).json({ valid: false })
  }
})

// Middleware to protect API routes
export function requireAuth(req, res, next) {
  // Allow login and verify endpoints
  if (req.path === '/api/auth/login' || req.path === '/api/auth/verify') {
    return next()
  }
  // Allow static files
  if (!req.path.startsWith('/api/')) {
    return next()
  }
  const token = req.headers['x-auth-token']
  if (token && validTokens.has(token)) {
    return next()
  }
  res.status(401).json({ error: 'Unauthorized' })
}

export default router
