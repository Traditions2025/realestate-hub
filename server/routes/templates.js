import { Router } from 'express'
import db from '../database.js'
import { fubGet, fubConfigured } from '../fub-helper.js'
import { fillTemplate } from './email.js'
import { readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const router = Router()
const n = (v) => v === undefined ? null : v

// Maintenance: surgically restore specific template rows (and optionally one drip campaign
// row) from the NEWEST daily disk backup — the raw DB copies in <DB_DIR>/backups. Used when
// content was overwritten in place and the prior version is needed back.
router.post('/restore-from-backup', (req, res) => {
  try {
    const ids = (Array.isArray(req.body?.template_ids) ? req.body.template_ids : []).map(Number).filter(Boolean)
    const dripId = Number(req.body?.drip_id) || null
    if (!ids.length && !dripId) return res.status(400).json({ error: 'template_ids or drip_id required' })
    const DB_DIR = process.env.DB_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    const dir = join(DB_DIR, 'backups')
    if (!existsSync(dir)) return res.status(404).json({ error: 'no backups directory' })
    const file = readdirSync(dir).filter(f => f.startsWith('realestate-hub.db.daily-')).sort().pop()
    if (!file) return res.status(404).json({ error: 'no daily backup found' })
    const p = join(dir, file).replace(/'/g, "''")
    db.run(`ATTACH DATABASE '${p}' AS bak`)
    let restoredTemplates = 0, restoredDrip = false
    try {
      if (ids.length) {
        db.run(`INSERT OR REPLACE INTO templates SELECT * FROM bak.templates WHERE id IN (${ids.join(',')})`)
        restoredTemplates = db.get(`SELECT COUNT(*) c FROM bak.templates WHERE id IN (${ids.join(',')})`).c
      }
      if (dripId) {
        db.run(`INSERT OR REPLACE INTO drip_campaigns SELECT * FROM bak.drip_campaigns WHERE id = ${dripId}`)
        restoredDrip = !!db.get(`SELECT 1 x FROM bak.drip_campaigns WHERE id = ${dripId}`)
      }
    } finally { db.run('DETACH DATABASE bak') }
    res.json({ success: true, backup: file, restored_templates: restoredTemplates, restored_drip: restoredDrip })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Render a template body/subject with a specific lead's data (live preview of merge fields).
router.post('/render', (req, res) => {
  const { body = '', subject = '', client_id } = req.body || {}
  const client = client_id ? db.get('SELECT * FROM clients WHERE id = ?', [Number(client_id)]) : null
  if (!client) return res.json({ body, subject, filled: false })
  const strip = (s) => fillTemplate(s || '', client).replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim()
  res.json({ body: strip(body), subject: strip(subject), filled: true })
})

// FUB text templates live under one of a few possible endpoint names depending on
// the account. Try each and return the first that responds with a list.
const FUB_TEMPLATE_ENDPOINTS = ['/textMessageTemplates', '/textTemplates', '/smsTemplates', '/templates']
async function fetchFubTextTemplates() {
  let lastErr = null
  for (const ep of FUB_TEMPLATE_ENDPOINTS) {
    try {
      const d = await fubGet(ep, { limit: 100 })
      const key = Object.keys(d || {}).find(k => Array.isArray(d[k]))
      const list = key ? d[key] : (Array.isArray(d) ? d : [])
      // email templates endpoint (/templates) has html; keep text-ish ones only if we fell back to it
      const mapped = list.map(t => ({ id: t.id, name: t.name || t.title || 'FUB Template', body: t.body || t.message || t.text || t.bodyText || '' }))
        .filter(t => t.body && !/^<.*>/.test(t.body.trim()))
      if (mapped.length || ep !== '/templates') return { endpoint: ep, templates: mapped }
    } catch (e) { lastErr = e; if (e.status && e.status !== 404) throw e }
  }
  if (lastErr) throw lastErr
  return { endpoint: null, templates: [] }
}

// Convert FUB merge tokens (%contact_first_name%) to the Hub's ({{first_name}}) so
// imported templates work with fillTemplate. Unknown %tokens% are removed so a
// customer never sees a raw placeholder.
// %? allows for FUB templates with an unclosed token (e.g. "%greeting_time" without
// the trailing %). Order matters: handle the "Good %greeting_time" phrasing first.
function convertFubTokens(s) {
  return String(s)
    .replace(/good\s+%greeting_time%?/gi, 'Hi')
    .replace(/%greeting_time%?/gi, 'Hi')
    .replace(/%contact_first_name%?/gi, '{{first_name}}')
    .replace(/%contact_last_name%?/gi, '{{last_name}}')
    .replace(/%contact_full_name%?|%contact_name%?/gi, '{{full_name}}')
    .replace(/%contact_city%?/gi, '{{city}}')
    .replace(/%contact_email%?/gi, '{{email}}')
    .replace(/%contact_(address|street)%?/gi, '{{address}}')
    .replace(/%(inquiry_address|viewed_address)%?/gi, '{{last_viewed_address}}')
    .replace(/%lender_first_name%?/gi, '{{lender_name}}')
    .replace(/%(sender|agent|user)_first_name%?/gi, 'John')
    // no Hub equivalent (Ylopo alert link / viewed-property URL) → remove so nothing leaks
    .replace(/%custom_ylopo_listing_alert%?|%viewed_address_url%?/gi, '')
    .replace(/%[a-z0-9_]+%?/gi, '')      // safety: strip any other token (closed OR unclosed)
    .replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?:)])/g, '$1').trim()
}

// Probe: what FUB text templates are available (no import).
router.get('/fub-text', async (_req, res) => {
  if (!fubConfigured()) return res.status(400).json({ error: 'Follow Up Boss API key not configured' })
  try {
    const r = await fetchFubTextTemplates()
    // distinct raw %tokens% used across ALL templates, so we can confirm every one maps
    const tokenSet = new Set()
    for (const t of r.templates) for (const m of String(t.body || '').match(/%[a-z0-9_]+%/gi) || []) tokenSet.add(m.toLowerCase())
    const tokens = [...tokenSet].sort()
    const unmapped = tokens.filter(tok => convertFubTokens(tok) !== '' && /%/.test(convertFubTokens(tok)))
    res.json({ endpoint: r.endpoint, count: r.templates.length, tokens, unmapped, templates: r.templates.slice(0, 5) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Import FUB text templates into the Hub templates (type text), dedupe by name.
router.post('/import-fub', async (_req, res) => {
  if (!fubConfigured()) return res.status(400).json({ error: 'Follow Up Boss API key not configured' })
  let templates
  try { ({ templates } = await fetchFubTextTemplates()) } catch (e) { return res.status(500).json({ error: 'FUB error: ' + e.message }) }
  let imported = 0, updated = 0, skipped = 0, ylopoSkipped = 0
  for (const t of templates) {
    const raw = String(t.body || '')
    // Skip templates that rely on a Ylopo link (listing alert / viewed-property URL) — no Hub equivalent.
    if (/%custom_ylopo_listing_alert%|%viewed_address_url%/i.test(raw)) { ylopoSkipped++; continue }
    const name = String(t.name || '').trim() || 'FUB Template'
    const body = convertFubTokens(raw.trim())
    if (!body) { skipped++; continue }
    const existing = db.get("SELECT id, tags FROM templates WHERE name=? AND type='text'", [name])
    if (existing) {
      // refresh a previously imported FUB template (re-convert); never overwrite a hand-made one
      if (String(existing.tags || '').includes('imported:fub')) { db.run("UPDATE templates SET body=?, updated_at=datetime('now') WHERE id=?", [body, existing.id]); updated++ }
      else skipped++
      continue
    }
    db.run("INSERT INTO templates (name, type, category, body, is_html, tags) VALUES (?,?,?,?,?,?)", [name, 'text', 'FUB', body, 0, 'imported:fub'])
    imported++
  }
  res.json({ success: true, imported, updated, skipped, ylopo_skipped: ylopoSkipped, total: templates.length })
})

function logActivity(action, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)',
    [action, 'template', entityId, details])
}

// List templates with optional type / search filters
router.get('/', (req, res) => {
  const { type, q } = req.query
  let where = ' WHERE 1=1'
  const params = []
  if (type) { where += ' AND type = ?'; params.push(type) }
  if (q) {
    where += ' AND (name LIKE ? OR subject LIKE ? OR body LIKE ? OR tags LIKE ? OR category LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like, like, like)
  }
  const rows = db.all(
    `SELECT id, name, type, category, subject, body, is_html, tags, used_count, last_used_at, created_at, updated_at
     FROM templates${where} ORDER BY updated_at DESC`,
    params)
  res.json(rows)
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM templates WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body || {}
  if (!b.name || !b.body) return res.status(400).json({ error: 'name and body required' })
  const type = b.type || 'email'
  const isHtml = b.is_html ? 1 : 0
  const result = db.run(
    `INSERT INTO templates (name, type, category, subject, body, is_html, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [b.name, type, n(b.category), n(b.subject), b.body, isHtml, n(b.tags)])
  logActivity('created', result.lastInsertRowid, `Template: ${b.name}`)
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const b = req.body || {}
  const id = Number(req.params.id)
  const fields = { ...b }
  delete fields.id
  delete fields.created_at
  fields.updated_at = new Date().toISOString()
  if ('is_html' in fields) fields.is_html = fields.is_html ? 1 : 0
  const keys = Object.keys(fields)
  if (!keys.length) return res.json({ success: true })
  const sets = keys.map(k => `${k} = ?`).join(', ')
  db.run(`UPDATE templates SET ${sets} WHERE id = ?`, [...keys.map(k => n(fields[k])), id])
  logActivity('updated', id, `Updated template`)
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT name FROM templates WHERE id = ?', [id])
  db.run('DELETE FROM templates WHERE id = ?', [id])
  logActivity('deleted', id, row ? `Deleted template: ${row.name}` : 'Deleted template')
  res.json({ success: true })
})

// Increment usage counter (call when a template is loaded into a composer)
router.post('/:id/used', (req, res) => {
  const id = Number(req.params.id)
  db.run(`UPDATE templates SET used_count = COALESCE(used_count, 0) + 1, last_used_at = datetime('now') WHERE id = ?`, [id])
  res.json({ success: true })
})

// Duplicate a template
router.post('/:id/duplicate', (req, res) => {
  const id = Number(req.params.id)
  const row = db.get('SELECT * FROM templates WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Not found' })
  const result = db.run(
    `INSERT INTO templates (name, type, category, subject, body, is_html, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [`${row.name} (copy)`, row.type, row.category, row.subject, row.body, row.is_html, row.tags])
  res.status(201).json({ id: result.lastInsertRowid })
})

export default router
