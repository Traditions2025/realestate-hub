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
  statSync, readdirSync, unlinkSync, copyFileSync,
  createReadStream, createWriteStream, renameSync, openSync, readSync, closeSync,
} from 'fs'
import { pipeline } from 'stream/promises'
import { createGzip, createGunzip } from 'zlib'
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
  // copyFileSync, not writeFileSync(readFileSync(...)): the read allocated a Node
  // Buffer the size of the ENTIRE database (~1 GB) before anything was written. This
  // function runs on every boot via the pre-boot snapshot in database.js, so that put
  // a 1 GB allocation on the startup path of a 2 GB instance. copyFileSync hands the
  // copy to the OS and holds no buffer at all.
  copyFileSync(DB_PATH, dest)
  return { path: dest, filename, size: stats.size, prefix }
}

export const GZ = '.gz'
const MIN_USABLE = 8 * 1024

/**
 * Keep the newest `keep` USABLE files for a prefix; delete the rest.
 *
 * The old version sorted by mtime alone. On 2026-11-23 a crash-looping backup left five
 * 0-byte files that were NEWER than every good one, so a rotation would have kept the
 * empty ones and deleted real backups. Unusable files (< 8 KB) are now always deleted
 * first, whatever their age, and only real backups count towards `keep`.
 * Matches both raw and .gz names.
 */
export function rotateBackups(prefix, keep) {
  if (!existsSync(BACKUP_DIR)) return { kept: 0, deleted: 0 }
  const matcher = new RegExp(`^realestate-hub\\.db\\.${prefix}-`)
  const all = readdirSync(BACKUP_DIR)
    .filter(f => matcher.test(f))
    .map(f => { const p = join(BACKUP_DIR, f); const st = statSync(p); return { name: f, path: p, mtime: st.mtimeMs, size: st.size } })
  const junk = all.filter(f => f.size < MIN_USABLE)
  const good = all.filter(f => f.size >= MIN_USABLE).sort((a, b) => b.mtime - a.mtime)
  let deleted = 0, deletedJunk = 0
  for (const f of [...junk, ...good.slice(keep)]) {
    try { unlinkSync(f.path); deleted++; if (f.size < MIN_USABLE) deletedJunk++ } catch {}
  }
  return { kept: Math.min(good.length, keep), deleted, deletedJunk, totalSeen: all.length }
}

/** Is this a real SQLite file? Reads 16 bytes, deliberately WITHOUT the driver:
 *  opening a bogus file with better-sqlite3 leaves a handle that blocks cleanup. */
export function looksLikeSqlite(path) {
  try {
    const b = Buffer.alloc(16)
    const fd = openSync(path, 'r')
    try { readSync(fd, b, 0, 16, 0) } finally { closeSync(fd) }
    return b.toString('latin1') === 'SQLite format 3\u0000'
  } catch { return false }
}

/** Stream-gzip src -> src.gz then remove src. Never holds the file in memory. */
export async function compressFile(src, { level = 6 } = {}) {
  if (!existsSync(src) || src.endsWith(GZ)) return { skipped: true }
  const tmp = src + '.gztmp', dest = src + GZ
  const before = statSync(src).size
  await pipeline(createReadStream(src), createGzip({ level }), createWriteStream(tmp))
  const after = statSync(tmp).size
  const head = Buffer.alloc(3)
  const fd = openSync(tmp, 'r'); try { readSync(fd, head, 0, 3, 0) } finally { closeSync(fd) }
  if (after < 20 || head[0] !== 0x1f || head[1] !== 0x8b || head[2] !== 0x08) {
    try { unlinkSync(tmp) } catch {}
    throw new Error('compressed output is not a valid gzip stream')
  }
  renameSync(tmp, dest)
  unlinkSync(src)
  return { src, dest, before, after, ratio: +(before / after).toFixed(2) }
}

/** Stream-gunzip src -> dest. Never holds the file in memory. */
export async function decompressFile(src, dest) {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest))
  return { src, dest, size: statSync(dest).size }
}

/**
 * Compress every backup of `prefix` except the newest `keepRaw`.
 *
 * The newest stays uncompressed on purpose: it is the one you reach for in an
 * emergency, so it restores instantly and verifies without a decompress. The write
 * path is untouched, so if compression ever fails the worst case is "stayed
 * uncompressed", never "unusable backup".
 */
export async function compressOldBackups(prefix, keepRaw = 1) {
  if (!existsSync(BACKUP_DIR)) return { compressed: 0, freedBytes: 0, errors: [] }
  const re = new RegExp(`^realestate-hub\\.db\\.${prefix}-`)
  const files = readdirSync(BACKUP_DIR)
    .filter(f => re.test(f) && !f.endsWith(GZ))
    .map(f => { const p = join(BACKUP_DIR, f); const st = statSync(p); return { name: f, path: p, mtime: st.mtimeMs, size: st.size } })
    .sort((a, b) => b.mtime - a.mtime)
  const out = { compressed: 0, freedBytes: 0, errors: [] }
  for (const f of files.slice(keepRaw)) {
    if (f.size < MIN_USABLE) continue
    try { const r = await compressFile(f.path); out.compressed++; out.freedBytes += r.before - r.after }
    catch (e) { out.errors.push(`${f.name}: ${e.message}`) }
  }
  return out
}

/** Abandoned staging files from an interrupted restore. */
export function sweepStaging(olderThanMs = 3600000) {
  let swept = 0
  try {
    for (const f of readdirSync(DB_DIR)) {
      if (!f.startsWith('restore-staging-')) continue
      const p = join(DB_DIR, f)
      if (Date.now() - statSync(p).mtimeMs < olderThanMs) continue
      try { unlinkSync(p); swept++ } catch {}
    }
  } catch {}
  return swept
}

/** Item 6: dead sidecars beside the live DB (corrupt-/replaced-/broken-) older than `days`. */
export function listStaleSidecars(days = 30) {
  const cutoff = Date.now() - days * 86400000
  if (!existsSync(DB_DIR)) return []
  return readdirSync(DB_DIR)
    .filter(f => /^realestate-hub\.db\.(corrupt|replaced|broken)-/.test(f))
    .map(f => { const p = join(DB_DIR, f); const st = statSync(p); return { name: f, path: p, sizeKb: Math.round(st.size / 1024), mtime: st.mtime.toISOString() } })
    .filter(x => new Date(x.mtime).getTime() < cutoff)
}
export function pruneStaleSidecars(days = 30) {
  const list = listStaleSidecars(days)
  let deleted = 0, freedKb = 0
  for (const f of list) { try { unlinkSync(f.path); deleted++; freedKb += f.sizeKb } catch {} }
  return { deleted, freedKb, names: list.map(f => f.name) }
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
export async function restoreFromFile(sourcePath) {
  if (!existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`)
  // Safety: refuse to restore from outside DB_DIR
  if (!sourcePath.startsWith(DB_DIR)) throw new Error('source must be inside data dir')
  const stat = statSync(sourcePath)
  if (!stat.isFile()) throw new Error('source is not a file')
  if (stat.size < 1024) throw new Error('source file too small, likely empty')

  sweepStaging()
  const ts = tsLabel()
  let staged = sourcePath, tmp = null
  if (sourcePath.endsWith(GZ)) {
    tmp = join(DB_DIR, `restore-staging-${ts}.db`)
    await decompressFile(sourcePath, tmp)
    staged = tmp
  }
  // NEVER write something that is not a database over the live database. The header
  // check runs first so the driver never opens a bogus file and leaves a handle on it.
  try {
    if (!looksLikeSqlite(staged)) throw new Error('refusing to restore: source is not a SQLite database')
    const t = new Database(staged, { readonly: true, fileMustExist: true })
    let integ, clients
    try {
      integ = Object.values(t.prepare('PRAGMA integrity_check').get())[0]
      clients = t.prepare('SELECT COUNT(*) n FROM clients').get()?.n
    } finally { t.close() }
    if (integ !== 'ok') throw new Error('refusing to restore: integrity_check says ' + integ)
    if (!(clients > 0)) throw new Error('refusing to restore: source has no clients')
  } catch (e) {
    if (tmp) { try { unlinkSync(tmp) } catch {} }
    throw e
  }
  const aside = `${DB_PATH}.replaced-${ts}`
  if (existsSync(DB_PATH)) copyFileSync(DB_PATH, aside)
  copyFileSync(staged, DB_PATH)
  if (tmp) { try { unlinkSync(tmp) } catch {} }
  return { restoredFrom: sourcePath, backedUpAs: aside, size: statSync(DB_PATH).size, wasCompressed: !!tmp }
}

// Send the DB as a gzipped email attachment. Off-Render backup.
// Recipients are configurable via BACKUP_RECIPIENTS env var (comma-separated).
export async function backupDbViaEmail() {
  if (!existsSync(DB_PATH)) return { skipped: 'db-missing' }
  const stats = statSync(DB_PATH)
  if (stats.size < 8 * 1024) return { skipped: 'db-too-small', size: stats.size }

  // THE 2 AM CRASH (found 2026-11-23). Below, this used to readFileSync the whole
  // database and gzipSync it, and only THEN compare the result against the 25 MB email
  // limit. At ~1 GB that is a 1 GB raw buffer plus the gzip output plus zlib's own
  // state on a 2 GB instance: Render logged "Ran out of memory (used over 2GB)" four or
  // five times every night, each kill left a 0-byte file in backups/, and the work was
  // discarded anyway because the result could never fit in an email.
  //
  // The size is known from stat without reading anything, so the hopeless cases now
  // cost nothing. The multiplier is deliberately generous - gzip on SQLite gets roughly
  // 3-4x - so any database that could plausibly still fit gets a real attempt.
  const EMAIL_MAX_RAW_BYTES = MAX_EMAIL_ATTACHMENT_BYTES * 8
  if (stats.size > EMAIL_MAX_RAW_BYTES) {
    return {
      skipped: 'too-large-raw',
      rawSize: stats.size,
      limit: MAX_EMAIL_ATTACHMENT_BYTES,
      maxRaw: EMAIL_MAX_RAW_BYTES,
      note: 'database too large to email; the on-disk snapshot and the Render disk snapshot are the backups',
    }
  }

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
export async function verifyBackupFile(path) {
  let tmp = null
  try {
    if (!existsSync(path)) return { ok: false, reason: 'file missing' }
    const s = statSync(path)
    if (!s.isFile() || s.size < 1024) return { ok: false, reason: 'file too small', sizeKb: Math.round(s.size / 1024) }
    let target = path
    if (path.endsWith(GZ)) {
      tmp = join(DB_DIR, `verify-staging-${Date.now()}.db`)
      await decompressFile(path, tmp)
      target = tmp
    }
    if (!looksLikeSqlite(target)) return { ok: false, reason: 'not a SQLite database' }
    const bdb = new Database(target, { readonly: true, fileMustExist: true })
    try {
      const integ = bdb.prepare('PRAGMA integrity_check').get()
      const integrity = integ ? Object.values(integ)[0] : null
      let clients = null; try { clients = bdb.prepare('SELECT COUNT(*) n FROM clients').get()?.n ?? null } catch {}
      return { ok: integrity === 'ok' && clients != null, integrity, clients, sizeKb: Math.round(s.size / 1024), compressed: !!tmp }
    } finally { bdb.close() }
  } catch (e) { return { ok: false, reason: e.message } }
  finally { if (tmp) { try { unlinkSync(tmp) } catch {} } }
}

// Health snapshot for the admin dashboard: newest backup age + whether it verifies.
export async function getBackupHealth() {
  const backups = listBackups()
  const newest = backups[0] || null
  let ageHours = null, verify = null
  if (newest) {
    ageHours = Math.round(((Date.now() - new Date(newest.mtime).getTime()) / 3600000) * 10) / 10
    verify = await verifyBackupFile(join(BACKUP_DIR, newest.name))
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
    // 3, not 7. The 7 was set when a snapshot was ~200MB; at 1.7GB seven dailies plus
    // three pre-boots is 17GB on a 12GB disk, which cannot fit by arithmetic.
    result.diskRotate = rotateBackups('daily', 3)
    if (result.disk?.path) result.diskVerify = await verifyBackupFile(result.disk.path)
    // Compress everything except the newest of each kind. Newest stays raw so an
    // emergency restore is instant. Runs AFTER verify, so a failure here can never
    // leave the freshly-taken backup in a worse state than uncompressed.
    try {
      result.compressDaily = await compressOldBackups('daily', 1)
      result.compressPreboot = await compressOldBackups('pre-boot', 1)
    } catch (e) { result.compressError = e.message }
    try { result.sidecars = pruneStaleSidecars(30) } catch (e) { result.sidecarError = e.message }
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
