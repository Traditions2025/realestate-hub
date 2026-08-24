// =====================================================================
// Hub data protection — multi-layer backup system.
//
//  1. backupDbToDisk(prefix)  — copy the live DB file to /data/backups
//     with a timestamped suffix. Rotated per-prefix. Used for both daily
//     scheduled backups AND a pre-migration safety snapshot on every boot.
//
//  2. backupDbViaEmail()      — gzip the DB file and email it as an
//     attachment via SendGrid to BACKUP_RECIPIENTS (default: matt's email).
//     This puts a copy OFF the Render disk, so even if the disk dies or
//     gets wiped, you can restore from your inbox. Cap at 25 MB compressed
//     to stay under SendGrid's 30 MB limit; if larger, disk-only that day.
//
//  3. rotateBackups(prefix, keep) — delete older backup files past N most-
//     recent for the prefix, so the disk doesn't fill up.
// =====================================================================

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  statSync, readdirSync, unlinkSync,
} from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import zlib from 'zlib'
import Database from 'better-sqlite3'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DB_DIR = process.env.DB_DIR || join(__dirname, '..')
const DB_PATH = join(DB_DIR, 'realestate-hub.db')
const BACKUP_DIR = join(DB_DIR, 'backups')

// Hard cap so we don't crash SendGrid's request size limit
const MAX_EMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024

function ensureBackupDir() {
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true })
  }
}

function tsLabel() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

// Copy the current DB file to /data/backups with a timestamped suffix.
// `prefix` becomes part of the filename for rotation grouping.
export function backupDbToDisk(prefix = 'daily') {
  if (!existsSync(DB_PATH)) return { skipped: 'db-missing' }
  ensureBackupDir()
  const stats = statSync(DB_PATH)
  if (stats.size < 8 * 1024) return { skipped: 'db-too-small', size: stats.size }
  const filename = `realestate-hub.db.${prefix}-${tsLabel()}`
  const dest = join(BACKUP_DIR, filename)
  writeFileSync(dest, readFileSync(DB_PATH))
  return { path: dest, filename, size: stats.size, prefix }
}

// Keep only the newest `keep` files for a given prefix; delete the rest.
export function rotateBackups(prefix, keep) {
  if (!existsSync(BACKUP_DIR)) return { kept: 0, deleted: 0 }
  const matcher = new RegExp(`^realestate-hub\\.db\\.${prefix}-`)
  const files = readdirSync(BACKUP_DIR)
    .filter(f => matcher.test(f))
    .map(f => {
      const p = join(BACKUP_DIR, f)
      return { name: f, path: p, mtime: statSync(p).mtimeMs }
    })
    .sort((a, b) => b.mtime - a.mtime)
  const toDelete = files.slice(keep)
  let deleted = 0
  for (const f of toDelete) {
    try { unlinkSync(f.path); deleted++ } catch {}
  }
  return { kept: files.length - deleted, deleted, totalSeen: files.length }
}

// List recent backups (for diagnostics / a future restore UI).
export function listBackups() {
  if (!existsSync(BACKUP_DIR)) return []
  return readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('realestate-hub.db.'))
    .map(f => {
      const p = join(BACKUP_DIR, f)
      const s = statSync(p)
      return { name: f, sizeKb: Math.round(s.size / 1024), mtime: s.mtime.toISOString(), location: 'backups' }
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
}

// List ALL recovery candidates: includes /data/realestate-hub.db.broken-* files
// (left over from the now-disabled auto-rename recovery) AND /data/backups/*.
// Use this to find data wiped by the old recovery path.
export function listRecoveryCandidates() {
  const out = []
  if (existsSync(DB_DIR)) {
    for (const f of readdirSync(DB_DIR)) {
      if (!f.startsWith('realestate-hub.db.')) continue
      // Skip current live file; we want sidecars
      if (f === 'realestate-hub.db') continue
      try {
        const p = join(DB_DIR, f)
        const s = statSync(p)
        if (!s.isFile()) continue
        out.push({
          name: f,
          path: p,
          sizeKb: Math.round(s.size / 1024),
          mtime: s.mtime.toISOString(),
          location: 'data',
          kind: f.includes('broken') ? 'broken' : 'other',
        })
      } catch {}
    }
  }
  for (const b of listBackups()) {
    out.push({ ...b, path: join(BACKUP_DIR, b.name), kind: 'backup' })
  }
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime))
}

// Copy a chosen sidecar file back over /data/realestate-hub.db. The current
// live file is renamed aside first so this is reversible. Returns { restoredFrom, backedUpAs }.
export function restoreFromFile(sourcePath) {
  if (!existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`)
  // Safety: refuse to restore from outside DB_DIR
  if (!sourcePath.startsWith(DB_DIR)) throw new Error('source must be inside data dir')
  const stat = statSync(sourcePath)
  if (!stat.isFile()) throw new Error('source is not a file')
  if (stat.size < 1024) throw new Error('source file too small, likely empty')

  const ts = tsLabel()
  const aside = `${DB_PATH}.replaced-${ts}`
  if (existsSync(DB_PATH)) {
    writeFileSync(aside, readFileSync(DB_PATH))
  }
  writeFileSync(DB_PATH, readFileSync(sourcePath))
  return { restoredFrom: sourcePath, backedUpAs: aside, size: stat.size }
}

// Send the DB as a gzipped email attachment. Off-Render backup.
// Recipients are configurable via BACKUP_RECIPIENTS env var (comma-separated).
export async function backupDbViaEmail() {
  if (!existsSync(DB_PATH)) return { skipped: 'db-missing' }
  const stats = statSync(DB_PATH)
  if (stats.size < 8 * 1024) return { skipped: 'db-too-small', size: stats.size }

  const recipients = (process.env.BACKUP_RECIPIENTS || 'mattsmithremax@gmail.com')
    .split(',').map(s => s.trim()).filter(Boolean)
  if (!recipients.length) return { skipped: 'no-recipients' }

  // Lazy-import to avoid any circular-load issues with the email module
  const { sendViaSendGrid } = await import('./routes/email.js')

  const raw = readFileSync(DB_PATH)
  const gzipped = zlib.gzipSync(raw, { level: 9 })

  if (gzipped.length > MAX_EMAIL_ATTACHMENT_BYTES) {
    return {
      skipped: 'too-large',
      rawSize: raw.length,
      gzippedSize: gzipped.length,
      limit: MAX_EMAIL_ATTACHMENT_BYTES,
    }
  }

  const filename = `realestate-hub.db.${tsLabel()}.gz`
  const dateStr = new Date().toISOString().slice(0, 10)
  const rawMb = (raw.length / 1024 / 1024).toFixed(2)
  const gzMb  = (gzipped.length / 1024 / 1024).toFixed(2)
  const subject = `[Hub Backup ${dateStr}] ${rawMb} MB raw / ${gzMb} MB compressed`
  const body = `
<p><strong>Automated Matt Smith Team Hub database backup.</strong></p>
<ul>
  <li><strong>Captured:</strong> ${new Date().toISOString()}</li>
  <li><strong>Raw size:</strong> ${rawMb} MB</li>
  <li><strong>Gzipped size:</strong> ${gzMb} MB</li>
  <li><strong>Source:</strong> realestate-hub on Render</li>
</ul>
<p><strong>To restore from this file:</strong></p>
<ol>
  <li>Download the attached <code>.gz</code></li>
  <li>Decompress: <code>gunzip realestate-hub.db.*.gz</code></li>
  <li>Replace <code>/data/realestate-hub.db</code> on Render (via shell or disk mount), or use the hub's <code>POST /api/backup/restore</code> endpoint when added</li>
  <li>Restart the service</li>
</ol>
<p style="font-size:11px;color:#9ca3af;">Keep these emails — they are off-site copies that survive Render disk corruption.</p>`

  await sendViaSendGrid(
    recipients,
    'Matt Smith Team',
    subject,
    body,
    undefined,
    [],
    [{
      filename,
      content: gzipped.toString('base64'),
      type: 'application/gzip',
    }]
  )

  return {
    recipients,
    rawSize: raw.length,
    gzippedSize: gzipped.length,
    sentAt: new Date().toISOString(),
  }
}

// Verify a backup file is a USABLE SQLite database, not just present. Opens it
// read-only, runs PRAGMA integrity_check, and confirms core data is queryable.
// "The job ran" is NOT the same as "a usable backup exists."
export function verifyBackupFile(path) {
  try {
    if (!existsSync(path)) return { ok: false, reason: 'file missing' }
    const s = statSync(path)
    if (!s.isFile() || s.size < 8 * 1024) return { ok: false, reason: 'file too small', sizeKb: Math.round(s.size / 1024) }
    const bdb = new Database(path, { readonly: true, fileMustExist: true })
    try {
      const integ = bdb.prepare('PRAGMA integrity_check').get()
      const integrity = integ ? Object.values(integ)[0] : null
      let clients = null; try { clients = bdb.prepare('SELECT COUNT(*) n FROM clients').get()?.n ?? null } catch {}
      return { ok: integrity === 'ok' && clients != null, integrity, clients, sizeKb: Math.round(s.size / 1024) }
    } finally { bdb.close() }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Health snapshot for the admin dashboard: newest backup age + whether it verifies.
export function getBackupHealth() {
  const backups = listBackups()
  const newest = backups[0] || null
  let ageHours = null, verify = null
  if (newest) {
    ageHours = Math.round(((Date.now() - new Date(newest.mtime).getTime()) / 3600000) * 10) / 10
    verify = verifyBackupFile(join(BACKUP_DIR, newest.name))
  }
  const stale = ageHours == null || ageHours > 48
  return {
    ok: !!(newest && verify && verify.ok && !stale),
    count: backups.length,
    newest: newest ? { name: newest.name, sizeKb: newest.sizeKb, mtime: newest.mtime } : null,
    age_hours: ageHours, stale, verified: !!(verify && verify.ok), verify,
  }
}

// Top-level runner — called from the scheduler. Composes the layers, VERIFIES the
// disk backup, and records a failure if anything is off. Returns a summary.
export async function runDailyBackup() {
  const result = { startedAt: new Date().toISOString() }
  try {
    result.disk = backupDbToDisk('daily')
    result.diskRotate = rotateBackups('daily', 14)  // keep 14 days
    if (result.disk?.path) result.diskVerify = verifyBackupFile(result.disk.path)
  } catch (err) {
    result.diskError = err.message
  }
  try {
    result.email = await backupDbViaEmail()
  } catch (err) {
    result.emailError = err.message
  }
  // Off-site to Google Drive (Matt Smith Team Hub / Render) — only if connected. This is
  // the reliable off-Render copy now that the DB exceeds the 25 MB email attachment cap.
  try {
    const { backupDbToGDrive, gdriveConnected } = await import('./gdrive-backup.js')
    if (gdriveConnected()) result.gdrive = await backupDbToGDrive()
  } catch (err) {
    result.gdriveError = err.message
    try { const { recordFailure } = await import('./failures.js'); recordFailure('backup', { ref: 'gdrive', summary: 'Google Drive off-site backup failed', error: err.message }) } catch {}
  }
  result.finishedAt = new Date().toISOString()
  console.log('[backup] daily run:', JSON.stringify(result))
  // Alert (via the failure log) if the disk backup didn't produce a usable file.
  try {
    const bad = result.diskError || result.disk?.skipped || (result.diskVerify && !result.diskVerify.ok)
    if (bad) {
      const { recordFailure } = await import('./failures.js')
      recordFailure('backup', { ref: 'daily', summary: 'Daily DB backup did not produce a verified, usable file', error: result.diskError || result.disk?.skipped || result.diskVerify?.reason || result.diskVerify?.integrity || 'verify failed', payload: { disk: result.disk, verify: result.diskVerify } })
    }
  } catch {}
  return result
}

export { DB_PATH, BACKUP_DIR }
