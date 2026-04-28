import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initDb } from './database.js'
import db from './database.js'

import authRouter, { requireAuth } from './routes/auth.js'
import seedRouter, { autoSeedOnBoot } from './routes/seed.js'
import transactionsRouter from './routes/transactions.js'
import clientsRouter from './routes/clients.js'
import tasksRouter from './routes/tasks.js'
import projectsRouter from './routes/projects.js'
import notesRouter from './routes/notes.js'
import marketingRouter from './routes/marketing.js'
import showingsRouter from './routes/showings.js'
import dashboardRouter from './routes/dashboard.js'
import prelistingsRouter from './routes/prelistings.js'
import vendorsRouter from './routes/vendors.js'
import partnersRouter from './routes/partners.js'
import socialmediaRouter from './routes/socialmedia.js'
import calendarRouter from './routes/calendar.js'
import sierraRouter from './routes/sierra.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

async function start() {
  await initDb()

  // Auto-seed vendors and partners on first boot (skipped if already exist)
  autoSeedOnBoot()

  const app = express()
  const PORT = process.env.PORT || 3001

  app.use(cors())
  app.use(express.json())

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
  app.use('/api/vendors', vendorsRouter)
  app.use('/api/partners', partnersRouter)
  app.use('/api/social-media', socialmediaRouter)
  app.use('/api/calendar', calendarRouter)
  app.use('/api/sierra', sierraRouter)
  app.use('/api/seed', seedRouter)

  // Activity log
  app.get('/api/activity', (req, res) => {
    const limit = Number(req.query.limit) || 20
    const rows = db.all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT ?', [limit])
    res.json(rows)
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
  })
}

start().catch(err => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
