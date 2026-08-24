// Off-site DB backups to Google Drive (Phase 2 resilience). The emailed backup is
// capped at 25 MB and the DB is now ~119 MB, so that copy gets skipped — this pushes
// the gzipped DB into "Matt Smith Team Hub / Render" on the connected Google account.
//
// Auth is OAuth 2.0 (drive.file scope). A one-time "Connect Google Drive" flow stores a
// refresh token in app_settings; from then on the daily backup uploads automatically.
// Inert until connected. No new npm deps — raw REST via fetch.
import db from './database.js'
import { readFileSync, existsSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import zlib from 'zlib'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_DIR = process.env.DB_DIR || join(__dirname, '..')
const DB_PATH = join(DB_DIR, 'realestate-hub.db')
const ROOT_FOLDER = 'Matt Smith Team Hub'
const SUB_FOLDER = 'Render'
const KEEP = 30   // keep the newest N backups in Drive

export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export function oauthClient() {
  return {
    id: process.env.GOOGLE_OAUTH_CLIENT_ID || db.getSetting('google_oauth_client_id', ''),
    secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || db.getSetting('google_oauth_client_secret', ''),
  }
}
export function refreshToken() { return process.env.GOOGLE_DRIVE_REFRESH_TOKEN || db.getSetting('google_drive_refresh_token', '') }
export function oauthConfigured() { const c = oauthClient(); return !!(c.id && c.secret) }
export function gdriveConnected() { return oauthConfigured() && !!refreshToken() }

// Exchange the stored refresh token for a short-lived access token (cached).
let _tok = { access: null, exp: 0 }
async function accessToken() {
  if (_tok.access && Date.now() < _tok.exp - 60000) return _tok.access
  const c = oauthClient(), rt = refreshToken()
  if (!c.id || !c.secret || !rt) throw new Error('Google Drive is not connected')
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: rt, grant_type: 'refresh_token' }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || `token ${r.status}`)
  _tok = { access: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 }
  return _tok.access
}

// Exchange an OAuth authorization code for tokens; store the refresh token. Called by the callback.
export async function exchangeCode(code, redirectUri) {
  const c = oauthClient()
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error_description || j.error || `token ${r.status}`)
  if (j.refresh_token) db.setSetting('google_drive_refresh_token', j.refresh_token)
  else if (!refreshToken()) throw new Error('Google did not return a refresh token — revoke prior access and reconnect with prompt=consent.')
  db.setSetting('gdrive_connected_at', new Date().toISOString())
  return { connected: true }
}

async function drive(method, path, { query, body, headers } = {}) {
  const tok = await accessToken()
  const url = 'https://www.googleapis.com/drive/v3' + path + (query ? ('?' + new URLSearchParams(query)) : '')
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer ' + tok, ...(headers || {}) }, body })
  if (method === 'DELETE' && r.status === 204) return {}
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error?.message || `drive ${r.status}`)
  return j
}
async function ensureFolder(name, parentId) {
  const q = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false` + (parentId ? ` and '${parentId}' in parents` : '')
  const found = await drive('GET', '/files', { query: { q, fields: 'files(id,name)', spaces: 'drive' } })
  if (found.files?.[0]) return found.files[0].id
  const created = await drive('POST', '/files', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) }) })
  return created.id
}
export async function ensureBackupFolder() {
  const root = await ensureFolder(ROOT_FOLDER, null)
  const render = await ensureFolder(SUB_FOLDER, root)
  return { root, render }
}
async function uploadResumable(name, buffer, mimeType, parentId) {
  const tok = await accessToken()
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
    method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parents: [parentId] }),
  })
  if (!init.ok) throw new Error('resumable init failed: ' + init.status)
  const uploadUrl = init.headers.get('location')
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': mimeType, 'Content-Length': String(buffer.length) }, body: buffer })
  const j = await put.json().catch(() => ({}))
  if (!put.ok) throw new Error('upload failed: ' + put.status)
  return j
}

// Gzip the DB and upload it to Matt Smith Team Hub / Render, then prune old copies.
export async function backupDbToGDrive() {
  if (!gdriveConnected()) return { skipped: 'not-connected' }
  if (!existsSync(DB_PATH)) return { skipped: 'db-missing' }
  const raw = readFileSync(DB_PATH)
  if (raw.length < 8 * 1024) return { skipped: 'db-too-small' }
  const gz = zlib.gzipSync(raw, { level: 9 })
  const { render } = await ensureBackupFolder()
  const name = `realestate-hub.db.${new Date().toISOString().replace(/[:.]/g, '-')}.gz`
  const file = await uploadResumable(name, gz, 'application/gzip', render)
  db.setSetting('gdrive_last_backup_at', new Date().toISOString())
  db.setSetting('gdrive_last_backup_name', name)
  db.setSetting('gdrive_last_backup_kb', String(Math.round(gz.length / 1024)))
  try {
    const list = await drive('GET', '/files', { query: { q: `'${render}' in parents and trashed=false`, fields: 'files(id,name,createdTime)', orderBy: 'createdTime desc', pageSize: '100' } })
    for (const f of (list.files || []).slice(KEEP)) await drive('DELETE', '/files/' + f.id).catch(() => {})
  } catch {}
  return { uploaded: name, fileId: file.id, sizeKb: Math.round(gz.length / 1024), rawMb: Math.round(raw.length / 1024 / 1024 * 10) / 10 }
}

export function gdriveStatus() {
  return {
    oauth_configured: oauthConfigured(),
    connected: gdriveConnected(),
    connected_at: db.getSetting('gdrive_connected_at', null),
    last_backup_at: db.getSetting('gdrive_last_backup_at', null),
    last_backup_name: db.getSetting('gdrive_last_backup_name', null),
    last_backup_kb: Number(db.getSetting('gdrive_last_backup_kb', 0)) || null,
    folder: `${ROOT_FOLDER} / ${SUB_FOLDER}`,
  }
}
