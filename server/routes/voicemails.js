// Saved voicemail recordings — uploaded/managed on the Templates tab. Reused for
// live-call voicemail drops. MP3/WAV only (Twilio <Play> plays those reliably).
import { Router } from 'express'
import Busboy from 'busboy'
import { createWriteStream, mkdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import db from '../database.js'

const DB_DIR = process.env.DB_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPLOAD_DIR = join(DB_DIR, 'uploads')
try { mkdirSync(UPLOAD_DIR, { recursive: true }) } catch {}
const HUB_BASE = () => process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'

const router = Router()

router.get('/', (_req, res) => res.json(db.all('SELECT * FROM voicemails ORDER BY id DESC')))

router.post('/', (req, res) => {
  if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return res.status(400).json({ error: 'expected an uploaded file' })
  const bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 8 * 1024 * 1024 } })
  let saved = null, tooBig = false, badType = false, name = ''
  bb.on('field', (n, val) => { if (n === 'name') name = String(val || '').slice(0, 120) })
  bb.on('file', (_n, stream, info) => {
    const mime = info?.mimeType || ''
    const ext = /mpeg|mp3/i.test(mime) ? 'mp3' : /wav/i.test(mime) ? 'wav' : null
    if (!ext) { badType = true; stream.resume(); return }
    const fname = `vm_${randomUUID().replace(/-/g, '')}.${ext}`
    const full = join(UPLOAD_DIR, fname)
    const ws = createWriteStream(full)
    stream.on('limit', () => { tooBig = true; ws.destroy(); try { unlinkSync(full) } catch {} })
    ws.on('finish', () => { if (!tooBig) saved = fname })
    stream.pipe(ws)
  })
  bb.on('close', () => {
    if (tooBig) return res.status(413).json({ error: 'Audio too large (max 8 MB).' })
    if (badType) return res.status(400).json({ error: 'Please upload an MP3 or WAV file.' })
    if (!saved) return res.status(400).json({ error: 'No audio received.' })
    const url = `${HUB_BASE()}/uploads/${saved}`
    const r = db.run('INSERT INTO voicemails (name, url) VALUES (?,?)', [name || 'Voicemail', url])
    res.json({ success: true, id: r.lastInsertRowid, name: name || 'Voicemail', url })
  })
  bb.on('error', () => res.status(500).json({ error: 'upload failed' }))
  req.pipe(bb)
})

router.delete('/:id', (req, res) => {
  const row = db.get('SELECT url FROM voicemails WHERE id=?', [Number(req.params.id)])
  db.run('DELETE FROM voicemails WHERE id=?', [Number(req.params.id)])
  if (row?.url) { try { const f = row.url.split('/uploads/')[1]; if (f) unlinkSync(join(UPLOAD_DIR, f)) } catch {} }
  res.json({ success: true })
})

export default router
