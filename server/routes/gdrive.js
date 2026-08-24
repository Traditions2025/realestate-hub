// Google Drive backup: one-click OAuth connect + status + manual backup.
// /connect and /callback are public (top-level browser redirects, no Hub token);
// /status and /backup-now are admin-only.
import { Router } from 'express'
import db from '../database.js'
import { requirePermission } from './auth.js'
import { oauthClient, oauthConfigured, exchangeCode, gdriveStatus, backupDbToGDrive, OAUTH_SCOPE } from '../gdrive-backup.js'

const router = Router()
const HUB = () => (process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com').replace(/\/+$/, '')
const redirectUri = () => HUB() + '/api/gdrive/callback'

router.get('/connect', (_req, res) => {
  if (!oauthConfigured()) return res.status(400).send('Google Drive OAuth client is not configured yet. Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the server, then try again.')
  const c = oauthClient()
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: c.id, redirect_uri: redirectUri(), response_type: 'code', scope: OAUTH_SCOPE,
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  })
  res.redirect(url)
})

router.get('/callback', async (req, res) => {
  if (!req.query.code) return res.status(400).send('<h3>Google Drive connection was cancelled.</h3>')
  try {
    await exchangeCode(req.query.code, redirectUri())
    res.send('<html><body style="font-family:system-ui,sans-serif;text-align:center;padding:48px"><h2>✓ Google Drive connected</h2><p>Backups will save to <b>Matt Smith Team Hub / Render</b>.</p><p><a href="/admin">Back to the Hub</a></p></body></html>')
  } catch (e) { res.status(500).send('<h3>Could not connect Google Drive</h3><pre>' + String(e.message) + '</pre><p><a href="/admin">Back</a></p>') }
})

// Save the Google OAuth client id/secret in settings (so no Render-env editing needed).
router.post('/config', requirePermission('settings.edit'), (req, res) => {
  const { client_id, client_secret } = req.body || {}
  if (client_id !== undefined) db.setSetting('google_oauth_client_id', String(client_id || '').trim())
  if (client_secret !== undefined) db.setSetting('google_oauth_client_secret', String(client_secret || '').trim())
  res.json({ success: true, configured: oauthConfigured() })
})

router.get('/status', requirePermission('settings.view'), (_req, res) => res.json({ ...gdriveStatus(), redirect_uri: redirectUri() }))
router.post('/backup-now', requirePermission('settings.edit'), async (_req, res) => {
  try { res.json(await backupDbToGDrive()) } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
