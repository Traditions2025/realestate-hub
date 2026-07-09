import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { initDb, getDbStatus } from './database.js'
import db from './database.js'

import authRouter, { requireAuth } from './routes/auth.js'
import seedRouter, { autoSeedOnBoot } from './routes/seed.js'
import { startScheduler } from './scheduler.js'
import transactionsRouter from './routes/transactions.js'
import clientsRouter from './routes/clients.js'
import tasksRouter from './routes/tasks.js'
import projectsRouter from './routes/projects.js'
import notesRouter from './routes/notes.js'
import marketingRouter from './routes/marketing.js'
import showingsRouter from './routes/showings.js'
import dashboardRouter from './routes/dashboard.js'
import prelistingsRouter from './routes/prelistings.js'
import listingsRouter from './routes/listings.js'
import realistRouter from './routes/realist.js'
import vendorsRouter from './routes/vendors.js'
import partnersRouter from './routes/partners.js'
import socialmediaRouter from './routes/socialmedia.js'
import calendarRouter from './routes/calendar.js'
import sierraRouter from './routes/sierra.js'
import emailRouter from './routes/email.js'
import listsRouter from './routes/lists.js'
import templatesRouter from './routes/templates.js'
import trackingRouter, { startTrackingFlushTimer } from './routes/tracking.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// =====================================================================
// PUBLIC TRACKING SNIPPET
// Returned by GET /track.js. Pasted (via single <script> tag) into Sierra
// Interactive's tracking-code area. Fires beacons to /api/track/beacon for:
//   - pageview (every page load on mattsmithteam.com)
//   - listing_view (when MLS number is detected in URL)
//   - save (any click on a "save" / "favorite" button)
//   - pagedurations (sent on tab close via navigator.sendBeacon)
// Lead identification tried in order: window.siteData/visitor/lead → cookie
// → URL ?lid= parameter. Email is the most reliable Sierra exposes.
// =====================================================================
function getTrackingSnippet(beaconUrl) {
  return `(function(){
  'use strict';
  var BEACON = ${JSON.stringify(beaconUrl)};
  var SESSION_COOKIE = 'mst_lead_session';
  var COOKIE_DAYS = 30;

  function setCookie(name, value, days) {
    var d = new Date(); d.setTime(d.getTime() + days * 86400000);
    document.cookie = name + '=' + encodeURIComponent(value) + '; expires=' + d.toUTCString() + '; path=/; SameSite=Lax';
  }
  function getCookie(name) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function urlParam(name) {
    var m = window.location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Lead identification — try every known shape Sierra Interactive uses.
  function detectLead() {
    var lid = null, email = null;
    try {
      var s = window.siteData || window.SiteData || window.SIERRA || {};
      var v = s.visitor || s.currentVisitor || s.user || s.currentUser || s.lead || {};
      lid = v.leadId || v.id || v.LeadID || null;
      email = v.email || v.Email || v.emailAddress || null;
    } catch(e){}
    try { if (!email && window.SierraSite && window.SierraSite.leadEmail) email = window.SierraSite.leadEmail; } catch(e){}
    if (!lid)   lid   = urlParam('lid') || urlParam('leadId');
    if (!email) email = urlParam('em')  || urlParam('email');
    if (!lid && !email) {
      var saved = getCookie(SESSION_COOKIE);
      if (saved) {
        try { var parsed = JSON.parse(saved); lid = parsed.lid; email = parsed.em; } catch(e){}
      }
    } else {
      setCookie(SESSION_COOKIE, JSON.stringify({ lid: lid, em: email }), COOKIE_DAYS);
    }
    return { sierra_lead_id: lid, sierra_email: email };
  }

  // MLS number detection — Sierra listing pages typically have /listings/{mls}/
  // or query params. Fallback: data-mls attr, page-title pattern.
  function detectListingMls() {
    var path = window.location.pathname;
    var m = path.match(/\\/listings?\\/([A-Z0-9-]{4,})/i) ||
            path.match(/\\/mls\\/([A-Z0-9-]{4,})/i) ||
            path.match(/\\/property\\/([A-Z0-9-]{4,})/i);
    if (m) return m[1];
    var qs = urlParam('mls') || urlParam('mlsNumber') || urlParam('listingId');
    if (qs) return qs;
    var el = document.querySelector('[data-mls],[data-listing-mls]');
    if (el) return el.getAttribute('data-mls') || el.getAttribute('data-listing-mls');
    return null;
  }

  function send(payload) {
    try {
      var lead = detectLead();
      payload.sierra_lead_id = lead.sierra_lead_id;
      payload.sierra_email = lead.sierra_email;
      payload.page_url = window.location.href;
      payload.page_title = document.title;
      payload.referrer = document.referrer || null;
      var data = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        // sendBeacon is the only reliable way to send on unload.
        navigator.sendBeacon(BEACON, new Blob([data], { type: 'application/json' }));
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', BEACON, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.send(data);
      }
    } catch(e){}
  }

  // ----- Page view (immediately on load) -----
  var startTime = Date.now();
  var mls = detectListingMls();
  send({ event_type: mls ? 'listing_view' : 'pageview', listing_mls: mls });

  // ----- Save / favorite clicks -----
  // Watches the whole document for clicks on anything with "save" or "favorite"
  // semantics. Captures common Sierra button patterns.
  document.addEventListener('click', function(e) {
    var t = e.target;
    while (t && t !== document.body) {
      var txt = (t.textContent || '').toLowerCase();
      var cls = (t.className || '').toLowerCase();
      var aria = (t.getAttribute && t.getAttribute('aria-label') || '').toLowerCase();
      if (
        /favorite|favourite|^save\\b|save listing|save property|save to favorites/i.test(txt) ||
        /favorite|favourite|save-btn|btn-save|btn-favorite/i.test(cls) ||
        /favorite|save listing/i.test(aria)
      ) {
        send({ event_type: 'save', listing_mls: detectListingMls() });
        return;
      }
      t = t.parentNode;
    }
  }, true);

  // ----- Page duration (on tab close / navigation) -----
  function fireDuration() {
    var sec = Math.round((Date.now() - startTime) / 1000);
    if (sec > 0 && sec < 86400) {
      send({ event_type: 'pageduration', duration_sec: sec, listing_mls: mls });
    }
  }
  window.addEventListener('beforeunload', fireDuration);
  window.addEventListener('pagehide', fireDuration);
})();`
}

async function start() {
  await initDb()

  // Auto-seed vendors and partners on first boot (skipped if already exist)
  autoSeedOnBoot()

  const app = express()
  const PORT = process.env.PORT || 3001

  app.use(cors())
  app.use(express.json({ limit: '25mb' }))

  // Serve static files in production
  app.use(express.static(join(__dirname, '..', 'dist')))

  // Auth
  app.use('/api/auth', authRouter)
  app.use(requireAuth)

  // API Routes
  app.use('/api/transactions', transactionsRouter)
  app.use('/api/clients', clientsRouter)
  app.use('/api/tasks', tasksRouter)
  app.use('/api/projects', projectsRouter)
  app.use('/api/notes', notesRouter)
  app.use('/api/marketing', marketingRouter)
  app.use('/api/showings', showingsRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/pre-listings', prelistingsRouter)
  app.use('/api/listings', listingsRouter)
  app.use('/api/realist', realistRouter)
  app.use('/api/vendors', vendorsRouter)
  app.use('/api/partners', partnersRouter)
  app.use('/api/social-media', socialmediaRouter)
  app.use('/api/calendar', calendarRouter)
  app.use('/api/sierra', sierraRouter)
  app.use('/api/email', emailRouter)
  app.use('/api/lists', listsRouter)
  app.use('/api/templates', templatesRouter)
  app.use('/api/track', trackingRouter)
  app.use('/api/seed', seedRouter)

  // Start the in-memory tracking beacon flush timer (writes buffered events
  // to the DB every 10s in a single batch — see routes/tracking.js).
  startTrackingFlushTimer()

  // Public tracking snippet — served as JS so Sierra's tracking-code area
  // can load it with a single <script src="..."> tag. Inline to avoid an
  // extra file to deploy. Cached for 5 minutes.
  app.get('/track.js', (req, res) => {
    const beaconUrl = `${req.protocol}://${req.get('host')}/api/track/beacon`
    res.set('Content-Type', 'application/javascript; charset=utf-8')
    res.set('Cache-Control', 'public, max-age=300')
    res.send(getTrackingSnippet(beaconUrl))
  })

  // Activity log — supports filtering by entity_type, action, since (ISO date), search
  app.get('/api/activity', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500)
    const offset = Number(req.query.offset) || 0
    let sql = 'SELECT * FROM activity_log WHERE 1=1'
    const params = []
    if (req.query.entity_type) { sql += ' AND entity_type = ?'; params.push(req.query.entity_type) }
    if (req.query.action) { sql += ' AND action = ?'; params.push(req.query.action) }
    if (req.query.since) { sql += ' AND created_at >= ?'; params.push(req.query.since) }
    if (req.query.search) { sql += ' AND (details LIKE ? OR action LIKE ? OR entity_type LIKE ?)'; const term = `%${req.query.search}%`; params.push(term, term, term) }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
    params.push(limit, offset)
    const rows = db.all(sql, params)
    const total = db.get('SELECT COUNT(*) as c FROM activity_log').c
    res.json({ rows, total, limit, offset })
  })

  // Distinct values for filter dropdowns
  app.get('/api/activity/filters', (_req, res) => {
    const types = db.all("SELECT DISTINCT entity_type FROM activity_log WHERE entity_type IS NOT NULL AND entity_type != '' ORDER BY entity_type").map(r => r.entity_type)
    const actions = db.all("SELECT DISTINCT action FROM activity_log WHERE action IS NOT NULL AND action != '' ORDER BY action").map(r => r.action)
    res.json({ entity_types: types, actions })
  })

  // DB persistence status - verify the database is being saved to a persistent disk
  app.get('/api/db-status', (req, res) => {
    const status = getDbStatus()
    const counts = {
      clients: db.get('SELECT COUNT(*) as c FROM clients').c,
      transactions: db.get('SELECT COUNT(*) as c FROM transactions').c,
      vendors: db.get('SELECT COUNT(*) as c FROM vendors').c,
      partners: db.get('SELECT COUNT(*) as c FROM partners').c,
      tasks: db.get('SELECT COUNT(*) as c FROM tasks').c,
    }
    res.json({ ...status, record_counts: counts })
  })

  // ---- LAYER 5: health check (unauthenticated) ----
  // Configure Render's "Health Check Path" to /api/health. If the DB ever
  // becomes unqueryable, this returns 503 and Render keeps the prior healthy
  // instance routed instead of swapping in a broken one.
  app.get('/api/health', (_req, res) => {
    const h = db.checkDbHealth ? db.checkDbHealth() : { ok: true, note: 'check-not-available' }
    if (h.ok) return res.json({ ok: true, ...h, ts: new Date().toISOString() })
    res.status(503).json({ ok: false, ...h, ts: new Date().toISOString() })
  })

  // Manual trigger: send the per-person daily task/deadline reminder emails
  // right now. Useful for testing the formatting, or for a "re-send today's"
  // workflow if SendGrid had a hiccup at 9 AM.
  app.post('/api/reminders/run-now', async (_req, res) => {
    try {
      const { runDailyRemindersNow } = await import('./scheduler.js')
      const result = await runDailyRemindersNow(true)
      res.json(result)
    } catch (err) {
      res.status(500).json({ success: false, error: err.message })
    }
  })

  // Configure the Slack webhook URL at runtime (stored in app_settings, never
  // in source control). Body: { webhook_url }. Returns whether it's set.
  app.post('/api/slack/config', (req, res) => {
    try {
      const { webhook_url } = req.body || {}
      if (!webhook_url || !/^https:\/\/hooks\.slack\.com\//.test(webhook_url)) {
        return res.status(400).json({ error: 'Provide a valid https://hooks.slack.com/... webhook_url' })
      }
      db.setSetting('slack_webhook_url', webhook_url)
      res.json({ ok: true, configured: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })
  app.get('/api/slack/config', (_req, res) => {
    const url = process.env.SLACK_WEBHOOK_URL || db.getSetting('slack_webhook_url')
    res.json({ configured: !!url, source: process.env.SLACK_WEBHOOK_URL ? 'env' : (url ? 'db' : 'none') })
  })

  // Manual trigger: fire the Slack transaction-deadline alert right now.
  // Useful to preview the 10 AM post's formatting on demand.
  app.post('/api/slack/deadline-now', async (_req, res) => {
    try {
      const { runDeadlineAlert } = await import('./slack.js')
      const result = await runDeadlineAlert()
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Manual backup trigger — run the daily backup right now (useful for testing
  // or for a "make a backup before I do something risky" workflow).
  app.post('/api/backup/now', async (_req, res) => {
    try {
      const { runDailyBackup } = await import('./backup.js')
      const result = await runDailyBackup()
      res.json(result)
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // List on-disk backups — for diagnostics and a future restore UI.
  app.get('/api/backup/list', async (_req, res) => {
    try {
      const { listBackups } = await import('./backup.js')
      res.json(listBackups())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // List ALL recovery candidates including .broken-* sidecar files in /data/.
  app.get('/api/backup/candidates', async (_req, res) => {
    try {
      const { listRecoveryCandidates } = await import('./backup.js')
      res.json(listRecoveryCandidates())
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Restore the live DB from a chosen candidate file. Request body:
  // { source: "/data/realestate-hub.db.broken-..." }
  // The current live DB is renamed aside first. After this call you must
  // restart the service (Render: Manual Deploy → Deploy latest commit) so
  // the new file is loaded into memory.
  app.post('/api/backup/restore', async (req, res) => {
    try {
      const { source } = req.body || {}
      if (!source) return res.status(400).json({ error: 'source path required' })
      const { restoreFromFile } = await import('./backup.js')
      const result = restoreFromFile(source)
      res.json({
        ...result,
        next_step: 'Restart the service so the new file is loaded into memory (Render: Manual Deploy → Deploy latest commit).',
      })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // SPA fallback for production
  app.get('*', (req, res) => {
    res.sendFile(join(__dirname, '..', 'dist', 'index.html'))
  })

  app.listen(PORT, () => {
    console.log('')
    console.log('  =============================================')
    console.log('  Matt Smith Team - Real Estate Hub v2.0')
    console.log('  =============================================')
    console.log(`  API Server:  http://localhost:${PORT}`)
    console.log('  =============================================')
    console.log('')

    // Start auto-sync scheduler
    startScheduler()
  })
}

start().catch(err => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
