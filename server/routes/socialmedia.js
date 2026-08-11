import { Router } from 'express'
import Busboy from 'busboy'
import crypto from 'crypto'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, basename, extname } from 'path'
import db from '../database.js'

const router = Router()
const n = (v) => v === undefined ? null : v

const __dirname = dirname(fileURLToPath(import.meta.url))
// Uploaded images live on the persistent disk (same place as the DB), NOT in
// the app bundle — otherwise every deploy would wipe them.
const UPLOAD_DIR = join(process.env.DB_DIR || join(__dirname, '..', '..'), 'social-uploads')
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }) } catch {}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
}

// The absolute base the outside world (Instagram/Meta/LinkedIn/n8n) uses to
// reach this Hub. Meta fetches images by public URL, so this must be correct.
function publicBase() {
  return (db.getSetting('public_base_url', 'https://realestate-hub-1rzu.onrender.com') || '').replace(/\/$/, '')
}
function imgUrl(file) {
  return file ? `${publicBase()}/api/social-media/img/${file}` : null
}

// Shared secret n8n presents on the queue/result endpoints. Auto-created once.
function n8nKey() {
  let k = db.getSetting('social_n8n_key', '')
  if (!k) { k = crypto.randomBytes(24).toString('hex'); db.setSetting('social_n8n_key', k) }
  return k
}
function checkKey(req, res) {
  const given = req.query.key || req.headers['x-social-key'] || ''
  if (given && given === n8nKey()) return true
  res.status(401).json({ error: 'Invalid or missing publishing key' })
  return false
}

// ---------- CONFIG (for the n8n setup panel) ----------
router.get('/config', (req, res) => {
  const base = publicBase()
  res.json({
    key: n8nKey(),
    public_base_url: base,
    queue_url: `${base}/api/social-media/queue`,
    result_url: `${base}/api/social-media/result`,
    img_base: `${base}/api/social-media/img/`,
  })
})
router.post('/config', (req, res) => {
  if (typeof req.body.public_base_url === 'string') {
    db.setSetting('public_base_url', req.body.public_base_url.trim().replace(/\/$/, ''))
  }
  if (req.body.regenerate) db.setSetting('social_n8n_key', crypto.randomBytes(24).toString('hex'))
  res.json({ success: true, key: n8nKey(), public_base_url: publicBase() })
})

// ---------- PUBLIC IMAGE SERVING (unauthenticated, whitelisted in auth.js) ----------
// Instagram/Meta/LinkedIn crawl this URL to fetch the media, so it can't require a token.
router.get('/img/:name', (req, res) => {
  const name = basename(req.params.name) // strip any path traversal
  const p = join(UPLOAD_DIR, name)
  if (!fs.existsSync(p)) return res.status(404).end()
  res.set('Content-Type', MIME[extname(name).toLowerCase()] || 'application/octet-stream')
  res.set('Cache-Control', 'public, max-age=31536000')
  fs.createReadStream(p).pipe(res)
})

// ---------- IMAGE UPLOAD (multipart) ----------
router.post('/upload', (req, res) => {
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) {
    return res.status(400).json({ error: 'Expected multipart/form-data' })
  }
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024, files: 1 } })
  let saved = null, tooBig = false, hadFile = false
  bb.on('file', (_field, stream, info) => {
    hadFile = true
    const ext = (extname(info.filename || '') || '.jpg').toLowerCase()
    const file = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`
    const dest = join(UPLOAD_DIR, file)
    const out = fs.createWriteStream(dest)
    stream.on('limit', () => { tooBig = true; out.destroy(); try { fs.unlinkSync(dest) } catch {} })
    stream.pipe(out)
    out.on('finish', () => { if (!tooBig) saved = file })
  })
  bb.on('close', () => {
    if (tooBig) return res.status(413).json({ error: 'File too large (max 25MB)' })
    if (!hadFile || !saved) return res.status(400).json({ error: 'No file uploaded' })
    res.json({ file: saved, url: imgUrl(saved) })
  })
  bb.on('error', () => res.status(500).json({ error: 'Upload failed' }))
  req.pipe(bb)
})

// ---------- n8n QUEUE: posts that are due to publish ----------
// n8n polls this on a schedule. Returns queued posts whose scheduled time has
// arrived (or that have no schedule), plus stale 'posting' rows (reclaim after
// 15 min in case a prior n8n run died mid-post). Claims each row as 'posting'
// so a second poll won't double-publish before the result callback lands.
router.get('/queue', (req, res) => {
  if (!checkKey(req, res)) return
  const now = new Date()
  const nowIso = now.toISOString()
  const staleCut = new Date(now.getTime() - 15 * 60 * 1000).toISOString()
  const rows = db.all(`SELECT * FROM social_posts
    WHERE (publish_status = 'queued') OR (publish_status = 'posting' AND updated_at < ?)`, [staleCut])
  const due = rows.filter(r => {
    if (!r.scheduled_date) return true
    const t = r.scheduled_time || '00:00'
    // scheduled instant, interpreted in UTC-neutral compare against ISO now
    return `${r.scheduled_date}T${t}:00` <= nowIso.slice(0, 19)
  })
  const out = due.map(r => {
    db.run("UPDATE social_posts SET publish_status = 'posting', updated_at = ? WHERE id = ?", [nowIso, r.id])
    let targets = []
    try { targets = r.targets ? JSON.parse(r.targets) : [] } catch {}
    if (!targets.length && r.platform) targets = [r.platform]
    const caption = [r.content, r.hashtags].filter(Boolean).join('\n\n')
    return {
      id: r.id, title: r.title, content: r.content || '', hashtags: r.hashtags || '',
      caption, post_type: r.post_type, targets,
      image_url: imgUrl(r.image_file) || r.media_url || null,
      scheduled_date: r.scheduled_date, scheduled_time: r.scheduled_time,
    }
  })
  res.json(out)
})

// ---------- n8n RESULT CALLBACK ----------
// Body: { id, ok, results:[{platform, ok, post_id, url, error}], error }
router.post('/result', (req, res) => {
  if (!checkKey(req, res)) return
  const { id, ok, results, error } = req.body || {}
  if (!id) return res.status(400).json({ error: 'Missing id' })
  const row = db.get('SELECT id FROM social_posts WHERE id = ?', [Number(id)])
  if (!row) return res.status(404).json({ error: 'Post not found' })
  const success = ok !== false && !error
  db.run(`UPDATE social_posts SET publish_status = ?, status = ?, published_at = ?,
    publish_results = ?, updated_at = ? WHERE id = ?`,
    [success ? 'posted' : 'failed', success ? 'posted' : 'scheduled',
     success ? new Date().toISOString() : null,
     JSON.stringify(results || (error ? [{ error }] : [])), new Date().toISOString(), Number(id)])
  res.json({ success: true })
})

// ---------- Queue / unqueue a post for publishing (user action) ----------
router.post('/:id/queue', (req, res) => {
  const row = db.get('SELECT * FROM social_posts WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (!row.image_file && !row.media_url) return res.status(400).json({ error: 'Add an image before publishing' })
  let targets = []
  try { targets = row.targets ? JSON.parse(row.targets) : [] } catch {}
  if (!targets.length) return res.status(400).json({ error: 'Pick at least one page/platform to publish to' })
  db.run("UPDATE social_posts SET publish_status = 'queued', status = 'scheduled', publish_results = NULL, updated_at = ? WHERE id = ?",
    [new Date().toISOString(), Number(req.params.id)])
  res.json({ success: true })
})
router.post('/:id/unqueue', (req, res) => {
  db.run("UPDATE social_posts SET publish_status = 'idle', updated_at = ? WHERE id = ?",
    [new Date().toISOString(), Number(req.params.id)])
  res.json({ success: true })
})

// ---------- CRUD ----------
router.get('/', (req, res) => {
  const { platform, status, month } = req.query
  let sql = 'SELECT * FROM social_posts WHERE 1=1'
  const params = []
  if (platform) { sql += ' AND platform = ?'; params.push(platform) }
  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (month) { sql += ' AND scheduled_date LIKE ?'; params.push(`${month}%`) }
  sql += ' ORDER BY scheduled_date ASC, scheduled_time ASC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM social_posts WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const targets = Array.isArray(b.targets) ? JSON.stringify(b.targets) : n(b.targets)
  const result = db.run(`INSERT INTO social_posts (title, platform, post_type, content, media_url,
    scheduled_date, scheduled_time, status, listing_id, campaign_id, hashtags,
    engagement_likes, engagement_comments, engagement_shares, notes, image_file, targets)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [b.title, b.platform, n(b.post_type), n(b.content), n(b.media_url),
      n(b.scheduled_date), n(b.scheduled_time), n(b.status) || 'draft',
      n(b.listing_id), n(b.campaign_id), n(b.hashtags),
      b.engagement_likes || 0, b.engagement_comments || 0, b.engagement_shares || 0,
      n(b.notes), n(b.image_file), targets])
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const fields = { ...req.body }
  if (Array.isArray(fields.targets)) fields.targets = JSON.stringify(fields.targets)
  fields.updated_at = new Date().toISOString()
  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), Number(req.params.id)]
  db.run(`UPDATE social_posts SET ${sets} WHERE id = ?`, values)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  const row = db.get('SELECT image_file FROM social_posts WHERE id = ?', [Number(req.params.id)])
  if (row && row.image_file) { try { fs.unlinkSync(join(UPLOAD_DIR, basename(row.image_file))) } catch {} }
  db.run('DELETE FROM social_posts WHERE id = ?', [Number(req.params.id)])
  res.json({ success: true })
})

export default router
