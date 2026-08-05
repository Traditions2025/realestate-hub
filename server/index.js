import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { statfsSync } from 'fs'
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
import blogPostsRouter from './routes/blog-posts.js'
import calendarRouter from './routes/calendar.js'
import sierraRouter from './routes/sierra.js'
import emailRouter, { seedEmailTemplates } from './routes/email.js'
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
  // Migrate built-in email templates into the editable templates table (idempotent)
  seedEmailTemplates()

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
  app.use('/api/blog-posts', blogPostsRouter)
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
    // Live disk usage of the persistent volume + process memory
    let disk = null, memory = null
    try {
      const mb = 1024 * 1024
      const st = statfsSync(process.env.DB_DIR || '.')
      const total = st.blocks * st.bsize
      const free = st.bavail * st.bsize
      disk = {
        total_mb: Math.round(total / mb),
        used_mb: Math.round((total - free) / mb),
        free_mb: Math.round(free / mb),
        used_pct: total ? Math.round((1 - free / total) * 100) : null,
      }
    } catch (e) { disk = { error: e.message } }
    try {
      const mb = 1024 * 1024
      const m = process.memoryUsage()
      memory = {
        rss_mb: Math.round(m.rss / mb),
        heap_used_mb: Math.round(m.heapUsed / mb),
        heap_total_mb: Math.round(m.heapTotal / mb),
        external_mb: Math.round(m.external / mb),
      }
    } catch (e) { memory = { error: e.message } }
    res.json({ ...status, record_counts: counts, disk, memory })
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

  // ---- FOLLOW UP BOSS connection (no lead/contact sync yet) ----
  // Store the FUB API key (in app_settings, never in git) and report status.
  app.post('/api/fub/config', async (req, res) => {
    try {
      const { api_key } = req.body || {}
      if (!api_key || typeof api_key !== 'string' || api_key.length < 20) {
        return res.status(400).json({ error: 'Provide a valid Follow Up Boss API key' })
      }
      db.setSetting('fub_api_key', api_key.trim())
      // Verify it immediately by calling FUB /identity.
      const { fubIdentity } = await import('./fub-helper.js')
      const id = await fubIdentity()
      res.json({ ok: true, connected: true, account: id.account || id.name, accountId: id.accountId, user: id.name })
    } catch (err) {
      res.status(502).json({ ok: false, connected: false, error: err.message })
    }
  })
  // Team profile settings — email signature (HTML) + account info. Stored in
  // app_settings. The signature is appended to composed/generated emails.
  app.get('/api/settings/profile', (_req, res) => {
    let account = {}
    try { account = JSON.parse(db.getSetting('account_info', '{}') || '{}') } catch {}
    res.json({ signature: db.getSetting('email_signature', '') || '', account })
  })
  app.post('/api/settings/profile', (req, res) => {
    const { signature, account } = req.body || {}
    if (signature !== undefined) db.setSetting('email_signature', String(signature || ''))
    if (account !== undefined) db.setSetting('account_info', JSON.stringify(account || {}))
    let acct = {}
    try { acct = JSON.parse(db.getSetting('account_info', '{}') || '{}') } catch {}
    res.json({ success: true, signature: db.getSetting('email_signature', '') || '', account: acct })
  })

  app.get('/api/fub/status', async (_req, res) => {
    try {
      const { fubConfigured, fubIdentity } = await import('./fub-helper.js')
      if (!fubConfigured()) return res.json({ configured: false, connected: false })
      const id = await fubIdentity()
      res.json({ configured: true, connected: true, account: id.account || id.name, accountId: id.accountId, user: id.name })
    } catch (err) {
      res.json({ configured: true, connected: false, error: err.message })
    }
  })

  // Recompute a client's "last FUB visit" summary from the newest activity row.
  function recomputeClientLastFub(clientId) {
    const last = db.get(
      'SELECT type, prop_street, prop_city, page_title, occurred_at FROM fub_activity WHERE client_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 1',
      [clientId])
    if (!last) return
    const detail = last.prop_street
      ? (last.prop_street + (last.prop_city ? `, ${last.prop_city}` : ''))
      : (last.page_title || null)
    db.run('UPDATE clients SET last_fub_activity_at = ?, last_fub_activity_type = ?, last_fub_activity_detail = ? WHERE id = ?',
      [last.occurred_at, last.type, detail, clientId])
  }

  // FUB activity: import (upsert by fub_event_id) + read per client.
  app.post('/api/fub/activity/import', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : (req.body?.activity || [])
    let added = 0, updated = 0
    const nn = (v) => (v === undefined || v === '' ? null : v)
    const affected = new Set()
    const COLS = ['fub_event_id', 'client_id', 'fub_person_id', 'type', 'page_title', 'page_url', 'page_duration', 'prop_street', 'prop_city', 'prop_state', 'prop_mls', 'prop_price', 'occurred_at', 'description']
    db.beginBulk?.()
    try {
      for (const r of rows) {
        if (!r || !r.fub_event_id) continue
        if (r.client_id) affected.add(r.client_id)
        const existing = db.get('SELECT id FROM fub_activity WHERE fub_event_id = ?', [r.fub_event_id])
        if (existing) { updated++; continue }  // events are immutable; skip if already stored
        db.run(`INSERT INTO fub_activity (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map(c => nn(r[c])))
        added++
        if (r.client_id && r.fub_person_id) db.run('UPDATE clients SET fub_person_id = ? WHERE id = ? AND (fub_person_id IS NULL OR fub_person_id = 0)', [r.fub_person_id, r.client_id])
      }
      for (const cid of affected) recomputeClientLastFub(cid)
    } finally { db.endBulk?.() }
    res.json({ added, skipped: updated, total: rows.length })
  })

  // One-time backfill: recompute last-FUB-visit for every client that has activity.
  app.post('/api/fub/activity/recompute-all', (_req, res) => {
    const ids = db.all('SELECT DISTINCT client_id FROM fub_activity WHERE client_id IS NOT NULL')
    db.beginBulk?.()
    try { for (const r of ids) recomputeClientLastFub(r.client_id) } finally { db.endBulk?.() }
    res.json({ recomputed: ids.length })
  })
  app.get('/api/fub/activity', (req, res) => {
    const clientId = Number(req.query.client_id)
    if (!clientId) return res.status(400).json({ error: 'client_id required' })
    const rows = db.all('SELECT * FROM fub_activity WHERE client_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 200', [clientId])
    res.json(rows)
  })

  // Lightweight "last web visit" writer for the full-base sync (all non-junk clients).
  // We DO NOT store every event for 30k+ clients (that would bloat the in-memory DB).
  // Instead we store only the single most-recent web visit summary on the client row,
  // which powers the "Last Visit" column + sorting. Full timelines are lazy-loaded live
  // from FUB via /api/fub/activity/live when a client is opened.
  app.post('/api/fub/last-visit/bulk', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : (req.body?.rows || [])
    const nn = (v) => (v === undefined || v === '' ? null : v)
    let updated = 0, linked = 0
    db.beginBulk?.()
    try {
      for (const r of rows) {
        if (!r || !r.client_id) continue
        if (r.fub_person_id) {
          const info = db.run('UPDATE clients SET fub_person_id = ? WHERE id = ? AND (fub_person_id IS NULL OR fub_person_id = 0)', [r.fub_person_id, r.client_id])
          if (info?.changes) linked++
        }
        if (!r.occurred_at) continue
        // Only advance the stored last-visit if the incoming one is newer (idempotent re-runs + incremental).
        const cur = db.get('SELECT last_fub_activity_at FROM clients WHERE id = ?', [r.client_id])
        if (cur && cur.last_fub_activity_at && String(cur.last_fub_activity_at) >= String(r.occurred_at)) continue
        db.run('UPDATE clients SET last_fub_activity_at = ?, last_fub_activity_type = ?, last_fub_activity_detail = ? WHERE id = ?',
          [nn(r.occurred_at), nn(r.type), nn(r.detail), r.client_id])
        updated++
      }
    } finally { db.endBulk?.() }
    res.json({ updated, linked, total: rows.length })
  })

  // Sierra's Realist-score grade bands (derived from live data): A+ >=800,
  // A 700-799, B 650-699, C 600-649, D 500-599, F <500.
  function realistGrade(s) {
    if (s >= 800) return 'A+'
    if (s >= 700) return 'A'
    if (s >= 650) return 'B'
    if (s >= 600) return 'C'
    if (s >= 500) return 'D'
    return 'F'
  }

  // Sync FUB's "Realist Sell Score" custom field (customRealistSellScore, 0-1000)
  // into the Hub's Realist Score = clients.lead_score (+ A-F grade). Rows:
  // [{ fub_person_id, score }], keyed by fub_person_id. BACKFILL ONLY — we only
  // set it where lead_score is empty, so Sierra-sourced scores stay authoritative
  // (Sierra's hourly sync owns those) and there's no overwrite thrash.
  app.post('/api/fub/realist-score/bulk', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : (req.body?.rows || [])
    let updated = 0
    db.beginBulk?.()
    try {
      for (const r of rows) {
        if (!r || (!r.fub_person_id && !r.client_id)) continue
        const score = (r.score === undefined || r.score === null || r.score === '') ? null : Math.round(Number(r.score))
        if (score === null || Number.isNaN(score)) continue
        const grade = realistGrade(score)
        // Prefer client_id (email-matched, dup-proof); fall back to fub_person_id. Empty-only.
        const info = r.client_id
          ? db.run("UPDATE clients SET lead_score = ?, lead_grade = ? WHERE id = ? AND (lead_score IS NULL OR lead_score = '')", [String(score), grade, r.client_id])
          : db.run("UPDATE clients SET lead_score = ?, lead_grade = ? WHERE fub_person_id = ? AND (lead_score IS NULL OR lead_score = '')", [String(score), grade, r.fub_person_id])
        updated += info?.changes || 0
      }
    } finally { db.endBulk?.() }
    res.json({ updated, total: rows.length })
  })

  // Overwrite the Hub's price range (clients.budget_min/max) with a FUB-derived
  // range computed from the actual list prices of properties the lead has viewed.
  // Rows: [{ fub_person_id, budget_min, budget_max }], keyed by fub_person_id.
  // This is an OVERWRITE (not backfill) — the FUB range reflects real shopping
  // behavior and is more accurate than Sierra's preset budget.
  app.post('/api/fub/budget/bulk', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : (req.body?.rows || [])
    let updated = 0
    db.beginBulk?.()
    try {
      for (const r of rows) {
        if (!r || !r.fub_person_id) continue
        const lo = (r.budget_min === undefined || r.budget_min === null || r.budget_min === '') ? null : Math.round(Number(r.budget_min))
        const hi = (r.budget_max === undefined || r.budget_max === null || r.budget_max === '') ? null : Math.round(Number(r.budget_max))
        if (lo === null && hi === null) continue
        const info = db.run('UPDATE clients SET budget_min = ?, budget_max = ? WHERE fub_person_id = ?', [lo, hi, r.fub_person_id])
        updated += info?.changes || 0
      }
    } finally { db.endBulk?.() }
    res.json({ updated, total: rows.length })
  })

  // Store the cities of properties a lead has viewed in FUB ("where they're looking").
  // Rows: [{ fub_person_id, cities }] where cities is a comma-joined string (freq-ordered).
  app.post('/api/fub/viewed-cities/bulk', (req, res) => {
    const rows = Array.isArray(req.body) ? req.body : (req.body?.rows || [])
    let updated = 0
    db.beginBulk?.()
    try {
      for (const r of rows) {
        if (!r || !r.fub_person_id) continue
        const cities = (r.cities === undefined || r.cities === null) ? null : String(r.cities).trim()
        if (!cities) continue
        const info = db.run('UPDATE clients SET fub_viewed_cities = ? WHERE fub_person_id = ?', [cities, r.fub_person_id])
        updated += info?.changes || 0
      }
    } finally { db.endBulk?.() }
    res.json({ updated, total: rows.length })
  })

  // Lazy-load a client's full web-activity timeline LIVE from FUB (no bulk storage).
  // Falls back to any stored fub_activity rows if the client isn't linked to a FUB person.
  app.get('/api/fub/activity/live', async (req, res) => {
    const clientId = Number(req.query.client_id)
    if (!clientId) return res.status(400).json({ error: 'client_id required' })
    const client = db.get('SELECT id, fub_person_id FROM clients WHERE id = ?', [clientId])
    const stored = db.all('SELECT * FROM fub_activity WHERE client_id = ? ORDER BY occurred_at DESC, id DESC LIMIT 200', [clientId])
    if (!client?.fub_person_id) return res.json({ source: 'stored', rows: stored })
    try {
      const { fubGet, fubConfigured } = await import('./fub-helper.js')
      if (!fubConfigured()) return res.json({ source: 'stored', rows: stored })
      const isWeb = (e) => !!(e.pageUrl || e.property || e.propertySearch) || /website|visit|view|propert|search|registration|inquir/i.test(e.type || '')
      const data = await fubGet('/events', { personId: client.fub_person_id, limit: 100, sort: '-created' })
      const rows = (data?.events || []).filter(isWeb).map(e => ({
        fub_event_id: e.id, client_id: clientId, fub_person_id: client.fub_person_id, type: e.type,
        page_title: e.pageTitle || null, page_url: e.pageUrl || null, page_duration: e.pageDuration || null,
        prop_street: e.property?.street || null, prop_city: e.property?.city || null, prop_state: e.property?.state || null,
        prop_mls: e.property?.mlsNumber || null, prop_price: e.property?.price || null,
        occurred_at: e.occurred || e.created, description: e.description || null,
      }))
      return res.json({ source: 'live', rows: rows.length ? rows : stored })
    } catch (e) {
      return res.json({ source: 'stored', rows: stored, error: String(e.message || e) })
    }
  })

  // Draft a "Do you want to see these properties?" email for a client, built from
  // the homes they've actually viewed in FUB. Pulls their recent property-view
  // events, dedupes by MLS, reconstructs the mattsmithteam.com listing links, and
  // grabs each listing's photo (og:image) so the email matches the FUB template.
  app.get('/api/fub/property-email', async (req, res) => {
    const clientId = Number(req.query.client_id)
    if (!clientId) return res.status(400).json({ error: 'client_id required' })
    const client = db.get('SELECT id, first_name, fub_person_id FROM clients WHERE id = ?', [clientId])
    if (!client) return res.status(404).json({ error: 'client not found' })
    if (!client.fub_person_id) return res.json({ count: 0, message: 'This client is not linked to a Follow Up Boss record.' })
    try {
      const max = Math.min(Number(req.query.max) || 5, 10)
      const seen = new Set(); const props = []
      let source = 'stored'

      // 1) Prefer the property views already stored in the Hub (fub_activity) — no FUB call.
      const stored = db.all(
        "SELECT prop_mls, prop_street, prop_city, prop_state, prop_zip, prop_price FROM fub_activity " +
        "WHERE client_id = ? AND prop_mls IS NOT NULL AND prop_mls != '' ORDER BY occurred_at DESC, id DESC",
        [clientId])
      for (const v of stored) {
        if (seen.has(v.prop_mls)) continue
        seen.add(v.prop_mls)
        props.push({ mlsNumber: v.prop_mls, street: v.prop_street, city: v.prop_city, state: v.prop_state, code: v.prop_zip, price: v.prop_price })
        if (props.length >= max) break
      }

      // 2) Only if we have nothing stored, fall back to a LIVE FUB pull (with 429 retry).
      if (!props.length) {
        source = 'live'
        const { fubGet, fubConfigured } = await import('./fub-helper.js')
        if (!fubConfigured()) return res.status(400).json({ error: 'FUB not configured' })
        let data = null
        for (let attempt = 0; attempt < 4; attempt++) {
          try { data = await fubGet('/events', { personId: client.fub_person_id, limit: 100, sort: '-created' }); break }
          catch (err) {
            if (err && err.status === 429 && attempt < 3) { await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); continue }
            throw err
          }
        }
        for (const e of (data?.events || [])) {
          const p = e.property
          if (!p || !p.mlsNumber || p.forRent) continue
          if (seen.has(p.mlsNumber)) continue
          seen.add(p.mlsNumber); props.push({ mlsNumber: p.mlsNumber, street: p.street, city: p.city, state: p.state, code: p.code, price: p.price })
          if (props.length >= max) break
        }
      }
      if (!props.length) return res.json({ count: 0, message: 'No viewed properties found for this client.' })

      const slugify = (p) => `${p.street} ${p.city} ${p.state} ${p.code || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      // Photo + link are built directly from the MLS number — no server-side fetch.
      // The image loads in the recipient's email client from Sierra's listing CDN.
      const cards = props.map((p) => ({
        ...p,
        url: `https://www.mattsmithteam.com/property-search/detail/352/${p.mlsNumber}/${slugify(p)}/`,
        photo: `https://cdn.listingphotos.sierrastatic.com/large/352/352_${p.mlsNumber}_01.jpg`,
      }))

      const usd = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? '$' + n.toLocaleString() : '' }
      const hourCT = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date()))
      const greet = hourCT < 12 ? 'Morning' : hourCT < 17 ? 'Afternoon' : 'Evening'
      const cardHtml = cards.map(c => {
        const addr = `${c.street} ${c.city}, ${c.state} ${c.code || ''}`.trim()
        const specs = [c.bedrooms && `${c.bedrooms} bd`, c.bathrooms && `${c.bathrooms} ba`, c.area && `${Number(c.area).toLocaleString()} sqft`, usd(c.price)].filter(Boolean).join(' &middot; ')
        const img = c.photo
          ? `<a href="${c.url}"><img src="${c.photo}" alt="${addr}" width="150" style="width:150px;height:auto;border-radius:6px;display:block;border:0;" /></a>`
          : `<a href="${c.url}" style="display:block;width:150px;height:110px;background:#eef1f5;border-radius:6px;text-align:center;line-height:110px;color:#64748b;font-size:12px;text-decoration:none;">View photo &rarr;</a>`
        return `<table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;margin:0 0 14px;border:1px solid #e2e8f0;border-radius:8px;"><tr>
<td valign="top" style="padding:12px;width:174px;">${img}</td>
<td valign="top" style="padding:12px 12px 12px 0;font-family:Arial,Helvetica,sans-serif;">
<a href="${c.url}" style="color:#2563eb;font-weight:bold;font-size:15px;text-decoration:none;">${addr} | MLS ${c.mlsNumber}</a>
<div style="color:#334155;font-size:13px;margin-top:6px;">${specs}</div>
<div style="color:#475569;font-size:13px;margin-top:6px;">Home for sale at ${addr}, with MLS ${c.mlsNumber}.</div>
</td></tr></table>`
      }).join('\n')

      const name = client.first_name || 'there'
      const savedSig = db.getSetting('email_signature', '') || ''
      const signature = savedSig
        ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;margin-top:18px;">${savedSig}</div>`
        : `<p style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;margin:18px 0 0;">Matt Smith<br/>Matt Smith Team, RE/MAX Real Estate Concepts</p>`

      // The wording is an editable "Homes They Viewed" template in the Templates tab.
      // Placeholders: {{greeting}} {{first_name}} {{properties}} (the property cards).
      const tpl = db.get("SELECT subject, body FROM templates WHERE type = 'email' AND name = 'Homes They Viewed' LIMIT 1")
      const subject = (tpl?.subject || 'Do you want to see any of these properties?')
        .replace(/\{\{greeting\}\}/g, greet).replace(/\{\{first_name\}\}/g, name)
      let inner = tpl?.body || `<p style="margin:0 0 16px;">{{greeting}} {{first_name}}, would you like any more info or to go and see any of these properties?</p>
{{properties}}
<p style="margin:16px 0 0;">Just reply and let me know which ones catch your eye and I'll set up the showings.</p>`
      inner = inner.replace(/\{\{greeting\}\}/g, greet).replace(/\{\{first_name\}\}/g, name)
      inner = inner.includes('{{properties}}') ? inner.replace(/\{\{properties\}\}/g, cardHtml) : (inner + '\n' + cardHtml)
      const body = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#0f172a;">
${inner}
${signature}
</div>`

      res.json({ subject, body, count: cards.length, photos: cards.filter(c => c.photo).length, source })
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) })
    }
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
