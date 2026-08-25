// P2-3: web push delivery. Uses the `web-push` package if installed (pulled on Render's
// npm install); degrades to a no-op locally if absent, so the notification center works
// regardless. VAPID keys are generated once and stored in app_settings (or supplied via
// env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).
import db from './database.js'

let _wp = null, _tried = false, _keys = null
async function lib() {
  if (_tried) return _wp
  _tried = true
  try { _wp = (await import('web-push')).default } catch { _wp = null }
  return _wp
}
function keys() {
  if (_keys) return _keys
  let pub = process.env.VAPID_PUBLIC_KEY || db.getSetting?.('vapid_public_key')
  let priv = process.env.VAPID_PRIVATE_KEY || db.getSetting?.('vapid_private_key')
  _keys = (pub && priv) ? { pub, priv } : null
  return _keys
}
async function ensureKeys() {
  if (keys()) return _keys
  const wp = await lib(); if (!wp) return null
  const kp = wp.generateVAPIDKeys()
  db.setSetting?.('vapid_public_key', kp.publicKey)
  db.setSetting?.('vapid_private_key', kp.privateKey)
  _keys = { pub: kp.publicKey, priv: kp.privateKey }
  return _keys
}

export function vapidPublicKey() {
  // Sync best-effort; if not yet generated, kick off generation for next call.
  const k = keys(); if (k) return k.pub
  ensureKeys().catch(() => {})
  return null
}

export async function sendPush(subs, payload) {
  const wp = await lib(); if (!wp) return
  const k = await ensureKeys(); if (!k) return
  try { wp.setVapidDetails('mailto:mattsmithremax@gmail.com', k.pub, k.priv) } catch { return }
  const data = JSON.stringify({ title: payload.title || 'Hub', body: payload.body || '', link: payload.link || '/', type: payload.type || 'info' })
  for (const s of subs) {
    try {
      await wp.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data)
    } catch (e) {
      // Prune dead subscriptions (expired / unsubscribed).
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { try { db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [s.endpoint]) } catch {} }
    }
  }
}
