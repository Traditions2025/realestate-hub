// Editorial Lab: run the listing editorial engine on this PC, nowhere else.
//
//   node tools/editorial-lab/server.mjs          start on http://127.0.0.1:8790 and open the app window
//   node tools/editorial-lab/server.mjs --fresh  re-copy the Hub database first
//
// Safe by construction: it mounts ONLY the listings and editorial routes on a COPY of the
// local Hub database (tmp/editorial-lab/, git-ignored). No scheduler, no drips, no Twilio,
// no email, no Sierra/FUB sync, nothing deployed. Listens on 127.0.0.1 only.
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LAB = join(HUB, 'tmp', 'editorial-lab')
const PORT = Number(process.env.EDITORIAL_LAB_PORT || 8790)
const CONFIG = join(LAB, 'config.json')
mkdirSync(LAB, { recursive: true })

// 1. Database copy (the real file is never opened)
const src = join(HUB, 'realestate-hub.db')
const dst = join(LAB, 'realestate-hub.db')
if (process.argv.includes('--fresh') || !existsSync(dst)) {
  if (existsSync(src)) { copyFileSync(src, dst); console.log('[lab] copied the local Hub database into tmp/editorial-lab/') }
  else console.log('[lab] no local Hub database found; starting with an empty one')
}
process.env.DB_DIR = LAB

// 2. Key + model from the lab's own config (never from the repo)
const readConfig = () => { try { return JSON.parse(readFileSync(CONFIG, 'utf8')) } catch { return {} } }
const cfg = readConfig()
if (cfg.anthropic_api_key && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = cfg.anthropic_api_key
if (cfg.editorial_model && !process.env.EDITORIAL_MODEL) process.env.EDITORIAL_MODEL = cfg.editorial_model

const { default: express } = await import('express')
const { default: db, initDb } = await import('../../server/database.js')
console.log('[lab] opening database copy…')
await initDb()
const { default: listingsRouter } = await import('../../server/routes/listings.js')
const { default: editorialRouter } = await import('../../server/routes/editorial.js')
const model = await import('../../server/editorial/model.js')
const { FIXTURES } = await import('../../server/editorial/eval/fixtures.js')
const { createServer: createVite } = await import('vite')

const app = express()
app.use((req, res, next) => {
  const ip = req.socket.remoteAddress || ''
  if (!/^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(ip)) return res.status(403).end()
  req.user = { email: 'editorial-lab@local', name: 'Editorial Lab' }
  next()
})
app.use(express.json({ limit: '5mb' }))

app.get('/lab/status', (_req, res) => {
  res.json({
    configured: model.isConfigured(),
    model: model.EDITORIAL_MODEL,
    db_copied_at: existsSync(dst) ? statSync(dst).birthtime : null,
    fixtures: FIXTURES.map(f => ({ id: f.id, title: f.title })),
  })
})

app.post('/lab/key', (req, res) => {
  const key = String(req.body?.key || '').trim()
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return res.status(400).json({ error: 'That does not look like an Anthropic API key (starts with sk-ant-).' })
  writeFileSync(CONFIG, JSON.stringify({ ...readConfig(), anthropic_api_key: key }, null, 2))
  process.env.ANTHROPIC_API_KEY = key
  model.resetClient()
  res.json({ configured: true })
})

// Load one of the 10 eval properties as a test listing.
app.post('/lab/fixtures/:id', (req, res) => {
  const fx = FIXTURES.find(f => f.id === req.params.id)
  if (!fx) return res.status(404).json({ error: 'No such test property' })
  const l = { ...fx.listing, features: JSON.stringify(fx.listing.features || []), stage: 'pre_listing', status: 'New', notes: `Editorial Lab test property: ${fx.title}` }
  const keys = Object.keys(l)
  const r = db.run(`INSERT INTO listings (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => l[k] ?? null))
  res.status(201).json({ id: Number(r.lastInsertRowid) })
})

app.use('/api/listings', listingsRouter)
app.use('/api/editorial', editorialRouter)
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not available in the Editorial Lab' }))

const vite = await createVite({ root: HUB, configFile: join(HUB, 'vite.config.js'), server: { middlewareMode: true, hmr: { port: PORT + 1 } }, appType: 'custom', logLevel: 'warn' })
app.use(vite.middlewares)
app.get(/^\/(?!api|lab).*/, async (req, res, next) => {
  try {
    const html = await vite.transformIndexHtml(req.originalUrl, readFileSync(join(HUB, 'tools', 'editorial-lab', 'index.html'), 'utf8'))
    res.status(200).set({ 'Content-Type': 'text/html' }).end(html)
  } catch (e) { vite.ssrFixStacktrace(e); next(e) }
})

app.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`
  console.log(`\n  Editorial Lab is running: ${url}\n  Local only. Close this window to stop it.\n`)
  if (process.argv.includes('--no-open')) return
  const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(p => existsSync(p))
  if (chrome) spawn(chrome, [`--app=${url}`, '--window-size=1400,950'], { detached: true, stdio: 'ignore' }).unref()
  else spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
})
