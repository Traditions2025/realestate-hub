import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initDb, getDbStatus } from './database.js'
import db from './database.js'

import authRouter, { requireAuth } from './routes/auth.js'
import seedRouter, { autoSeedOnBoot } from './routes/seed.js'
import { startScheduler } from './scheduler.js'
import transactionsRouter from './routes/transactions.js'
import clientsRouter from './routes/clients.js'
import tasksRouter from './routes/tasks.js'
import projectsRouter from './routes/projects.js'
import notesRouter from './routes/notes.js'
import marketingRouter from './routes/marketing.js'
import showingsRouter from './routes/showings.js'
import dashboardRouter from './routes/dashboard.js'
import prelistingsRouter from './routes/prelistings.js'
import listingsRouter from './routes/listings.js'
import vendorsRouter from './routes/vendors.js'
import partnersRouter from './routes/partners.js'
import socialmediaRouter from './routes/socialmedia.js'
import calendarRouter from './routes/calendar.js'
import sierraRouter from './routes/sierra.js'
import emailRouter from './routes/email.js'
import listsRouter from './routes/lists.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function start() {
  await initDb()

  // Auto-seed vendors and partners on first boot (skipped if already exist)
  autoSeedOnBoot()

  const app = express()
  const PORT = process.env.PORT || 3001

  app.use(cors())
  app.use(express.json({ limit: '25mb' }))

  // Serve static files in production
  app.use(express.static(join(__dirname, '..', 'dist')))

  // Auth
  app.use('/api/auth', authRouter)
  app.use(requireAuth)

  // API Routes
  app.use('/api/transactions', transactionsRouter)
  app.use('/api/clients', clientsRouter)
  app.use('/api/tasks', tasksRouter)
  app.use('/api/projects', projectsRouter)
  app.use('/api/notes', notesRouter)
  app.use('/api/marketing', marketingRouter)
  app.use('/api/showings', showingsRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/pre-listings', prelistingsRouter)
  app.use('/api/listings', listingsRouter)
  app.use('/api/vendors', vendorsRouter)
  app.use('/api/partners', partnersRouter)
  app.use('/api/social-media', socialmediaRouter)
  app.use('/api/calendar', calendarRouter)
  app.use('/api/sierra', sierraRouter)
  app.use('/api/email', emailRouter)
  app.use('/api/lists', listsRouter)
  app.use('/api/seed', seedRouter)

  // Activity log — supports filtering by entity_type, action, since (ISO date), search
  app.get('/api/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const offset = Number(req.query.offset) || 0
    let sql = 'SELECT * FROM activity_log WHERE 1=1'
    const params = []
    if (req.query.entity_type) { sql += ' AND entity_type = ?'; params.push(req.query.entity_type) }
    if (req.query.action) { sql += ' AND action = ?'; params.push(req.query.action) }
    if (req.query.since) { sql += ' AND created_at >= ?'; params.push(req.query.since) }
    if (req.query.search) { sql += ' AND (details LIKE ? OR action LIKE ? OR entity_type LIKE ?)'; const term = `%${req.query.search}%`; params.push(term, term, term) }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)
    const rows = db.all(sql, params)
    const total = db.get('SELECT COUNT(*) as c FROM activity_log').c
    res.json({ rows, total, limit, offset })
  })

  // Distinct values for filter dropdowns
  app.get('/api/activity/filters', (_req, res) => {
    const types = db.all("SELECT DISTINCT entity_type FROM activity_log WHERE entity_type IS NOT NULL AND entity_type != '' ORDER BY entity_type").map(r => r.entity_type)
    const actions = db.all("SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL AND action != '' ORDER BY action").map(r => r.action)
    res.json({ entity_types: types, actions })
  })

  // DB persistence status - verify the database is being saved to a persistent disk
  app.get('/api/db-status', (req, res) => {
    const status = getDbStatus()
    const counts = {
      clients: db.get('SELECT COUNT(*) as c FROM clients').c,
      transactions: db.get('SELECT COUNT(*) as c FROM transactions').c,
      vendors: db.get('SELECT COUNT(*) as c FROM vendors').c,
      partners: db.get('SELECT COUNT(*) as c FROM partners').c,
      tasks: db.get('SELECT COUNT(*) as c FROM tasks').c,
    }
    res.json({ ...status, record_counts: counts })
  })

  // SPA fallback for production
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '..', 'dist', 'index.html'))
  })

  app.listen(PORT, () => {
    console.log('')
    console.log('  =============================================')
    console.log('  Matt Smith Team - Real Estate Hub v2.0')
    console.log('  =============================================')
    console.log(`  API Server:  http://localhost:${PORT}`)
    console.log('  =============================================')
    console.log('')

    // Start auto-sync scheduler
    startScheduler()
  })
}

start().catch(err => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
