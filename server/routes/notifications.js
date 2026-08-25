// P2-4: notification center API. P2-3: web-push subscription management.
import { Router } from 'express'
import db from '../database.js'
import { listNotifications, unreadCount, markRead, markAllRead } from '../notifications.js'

const router = Router()

router.get('/', (req, res) => res.json({ unread: unreadCount(), items: listNotifications({ limit: Number(req.query.limit) || 30, unreadOnly: req.query.unread === '1' }) }))
router.get('/unread-count', (_req, res) => res.json({ unread: unreadCount() }))
router.post('/:id/read', (req, res) => { markRead(req.params.id); res.json({ success: true }) })
router.post('/read-all', (_req, res) => { markAllRead(); res.json({ success: true }) })

// ---- P2-3: web push subscriptions ----
router.get('/vapid-public-key', async (_req, res) => {
  try { const m = await import('../web-push.js'); res.json({ key: m.vapidPublicKey() }) }
  catch { res.json({ key: null }) }
})
router.post('/subscribe', (req, res) => {
  const s = req.body || {}
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth) return res.status(400).json({ error: 'invalid subscription' })
  try {
    db.run(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at) VALUES (?,?,?,datetime('now'))
            ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`,
      [s.endpoint, s.keys.p256dh, s.keys.auth])
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/unsubscribe', (req, res) => {
  try { db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [req.body?.endpoint || '']); res.json({ success: true }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
