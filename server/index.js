import express from 'express'
import cors from 'cors'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { statfsSync, readFileSync, existsSync, appendFileSync, writeFileSync } from 'fs'
import { initDb, getDbStatus } from './database.js'
import db from './database.js'

import authRouter, { requireAuth } from './routes/auth.js'
import seedRouter, { autoSeedOnBoot } from './routes/seed.js'
import { startScheduler } from './scheduler.js'
import { purgeStopStatusEnrollments } from './lead-sequences.js'
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
import automationsRouter from './routes/automations.js'
import reportingRouter from './routes/reporting.js'
import dripsRouter from './routes/drips.js'
import campaignMatchRouter from './routes/campaign-match.js'
import inboxRouter from './routes/inbox.js'
import trackingRouter, { startTrackingFlushTimer } from './routes/tracking.js'
import followupRouter from './routes/followup.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Persistent crash log on the data disk, so an "Exited with status 1" leaves a
// stack trace we can actually read (via GET /api/crash-log) instead of it only
// living in Render's ephemeral log stream.
const CRASH_LOG = join(process.env.DB_DIR || '/data', 'crash-log.jsonl')
function recordCrash(kind, err) {
  try {
    const line = JSON.stringify({
      t: new Date().toISOString(), kind,
      msg: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 10).join('\n') : null,
    }) + '\n'
    appendFileSync(CRASH_LOG, line)
    const raw = readFileSync(CRASH_LOG, 'utf8')
    if (raw.length > 200000) writeFileSync(CRASH_LOG, raw.trim().split('\n').slice(-150).join('\n') + '\n')
  } catch {}
}

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
  app.use(express.urlencoded({ extended: false, limit: '2mb' })) // Twilio webhooks post form-urlencoded

  // Serve static files in production
  app.use(express.static(join(__dirname, '..', 'dist')))
  // Publicly serve MMS uploads (so Twilio can fetch them); lives on the /data disk.
  app.use('/uploads', express.static(join(process.env.DB_DIR || join(__dirname, '..'), 'uploads')))

  // Auth
  app.use('/api/auth', authRouter)
  app.use(requireAuth)

  // Recent crashes captured by the process handlers (most recent first).
  app.get('/api/crash-log', (_req, res) => {
    try {
      if (!existsSync(CRASH_LOG)) return res.json({ count: 0, crashes: [] })
      const lines = readFileSync(CRASH_LOG, 'utf8').trim().split('\n').filter(Boolean)
      const crashes = lines.slice(-50).map(l => { try { return JSON.parse(l) } catch { return { raw: l } } }).reverse()
      res.json({ count: lines.length, crashes })
    } catch (e) { res.json({ count: 0, crashes: [], error: e.message }) }
  })

  // "What's New" walkthrough screenshots. Served ONLY to authenticated users (this
  // route is behind requireAuth) so client data in the screenshots never goes public.
  app.get('/api/whatsnew/:name', (req, res) => {
    const name = String(req.params.name || '')
    if (!/^[a-z0-9-]+\.png$/i.test(name)) return res.status(400).end()
    const p = join(__dirname, 'whatsnew', name)
    if (!existsSync(p)) return res.status(404).end()
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('Cache-Control', 'private, max-age=86400')
    res.end(readFileSync(p))
  })

  // Link preview (unfurl): fetch a URL server-side and parse its Open Graph / meta
  // tags so the email composer can insert a rich preview card. Used by EmailToolbar.
  app.get('/api/link-preview', async (req, res) => {
    const target = String(req.query.url || '').trim()
    if (!/^https?:\/\//i.test(target)) return res.status(400).json({ error: 'A valid http(s) URL is required' })
    const decode = (s) => String(s || '')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
      .replace(/&#x27;/gi, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim()
    const absolutize = (u) => { try { return new URL(u, target).href } catch { return u } }
    // Bot-challenge / interstitial / access-denied pages return useless metadata.
    const challenge = /just a moment|attention required|checking your browser|please wait|enable javascript|cf-browser-verification|access (?:to this page has been )?denied|are you a (?:human|robot)|verify you are human|ddos protection/i
    // Try user-agents in order. facebookexternalhit is what Facebook/iMessage/Slack use
    // to unfurl links, so Cloudflare-protected sites (incl. the team's own Sierra site)
    // almost always allowlist it. Fall back to a normal browser UA for sites that block bots.
    const UAS = [
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Mozilla/5.0 (compatible; Twitterbot/1.0)',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    ]
    const parse = (html) => {
      const meta = {}
      for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
        const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1]
        const val = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1]
        if (key && val != null && !(key.toLowerCase() in meta)) meta[key.toLowerCase()] = val
      }
      const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || ''
      const title = decode(meta['og:title'] || meta['twitter:title'] || titleTag)
      const description = decode(meta['og:description'] || meta['twitter:description'] || meta['description'] || '')
      const rawImg = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || ''
      const image = rawImg ? absolutize(decode(rawImg)) : ''
      const siteName = decode(meta['og:site_name'] || '')
      const blocked = challenge.test(title) || challenge.test(titleTag)
      return { title, description, image, siteName, blocked }
    }
    let last = { title: '', description: '', image: '', siteName: '' }
    for (const ua of UAS) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 8000)
        const r = await fetch(target, {
          redirect: 'follow', signal: ctrl.signal,
          headers: { 'User-Agent': ua, 'Accept': 'text/html,application/xhtml+xml' },
        })
        clearTimeout(timer)
        const html = (await r.text()).slice(0, 600000)
        const p = parse(html)
        if (!p.blocked && (p.title || p.image)) {
          return res.json({ url: target, title: p.title, description: p.description, image: p.image, siteName: p.siteName })
        }
        if (!p.blocked) last = { title: p.title, description: p.description, image: p.image, siteName: p.siteName }
      } catch (err) {
        last = { ...last, error: err.message }
      }
    }
    // No UA produced usable, non-challenge metadata — return whatever we have (often blank),
    // so the card falls back to a clean domain-only preview.
    res.json({ url: target, ...last })
  })

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
  app.use('/api/automations', automationsRouter)
  app.use('/api/reporting', reportingRouter)
  app.use('/api/drips', dripsRouter)
  app.use('/api/campaign-match', campaignMatchRouter)
  app.use('/api/inbox', inboxRouter)
  app.use('/api/followup', followupRouter)
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
    let account = {}, business = {}
    try { account = JSON.parse(db.getSetting('account_info', '{}') || '{}') } catch {}
    try { business = JSON.parse(db.getSetting('business_registration', '{}') || '{}') } catch {}
    res.json({ signature: db.getSetting('email_signature', '') || '', account, business, from_name: db.getSetting('email_from_name', '') || '' })
  })
  app.post('/api/settings/profile', (req, res) => {
    const { signature, account, business, from_name } = req.body || {}
    if (signature !== undefined) db.setSetting('email_signature', String(signature || ''))
    if (account !== undefined) db.setSetting('account_info', JSON.stringify(account || {}))
    if (business !== undefined) db.setSetting('business_registration', JSON.stringify(business || {}))
    if (from_name !== undefined) db.setSetting('email_from_name', String(from_name || '').trim())
    let acct = {}, biz = {}
    try { acct = JSON.parse(db.getSetting('account_info', '{}') || '{}') } catch {}
    try { biz = JSON.parse(db.getSetting('business_registration', '{}') || '{}') } catch {}
    res.json({ success: true, signature: db.getSetting('email_signature', '') || '', account: acct, business: biz, from_name: db.getSetting('email_from_name', '') || '' })
  })

  // Twilio texting config. The Auth Token is write-only from the UI's side — we never
  // send it back, only whether it's set + the last 4 chars, so it can't leak via the API.
  app.get('/api/settings/twilio', async (_req, res) => {
    const { twilioConfig } = await import('./twilio.js')
    const c = twilioConfig()
    res.json({
      account_sid: c.sid,
      auth_token_set: !!c.token,
      auth_token_last4: c.token ? c.token.slice(-4) : '',
      from_number: c.from,
      messaging_service_sid: c.messagingServiceSid,
      enabled: c.enabled,
      inbound_webhook: (process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com') + '/api/inbox/twilio-inbound',
    })
  })
  app.post('/api/settings/twilio', (req, res) => {
    const { account_sid, auth_token, from_number, messaging_service_sid, enabled } = req.body || {}
    if (account_sid !== undefined) db.setSetting('twilio_account_sid', String(account_sid || '').trim())
    if (auth_token) db.setSetting('twilio_auth_token', String(auth_token).trim()) // only overwrite if a new value is provided
    if (from_number !== undefined) db.setSetting('twilio_from_number', String(from_number || '').trim())
    if (messaging_service_sid !== undefined) db.setSetting('twilio_messaging_service_sid', String(messaging_service_sid || '').trim())
    if (enabled !== undefined) db.setSetting('twilio_enabled', enabled ? '1' : '0')
    res.json({ success: true })
  })
  app.post('/api/settings/twilio/verify', async (_req, res) => {
    const { twilioVerify } = await import('./twilio.js')
    res.json(await twilioVerify())
  })
  // Communications health check (admin diagnostics). Never returns secrets.
  app.get('/api/settings/twilio/health', async (_req, res) => {
    try { const { commsHealth } = await import('./twilio.js'); res.json(await commsHealth()) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  // Webhook signature telemetry — proves real Twilio webhooks validate before
  // flipping to 'enforce'. `ready_to_enforce` = at least one valid, zero invalid.
  app.get('/api/settings/twilio/signature', (_req, res) => {
    const valid = Number(db.getSetting('twilio_sig_valid_count', '0'))
    const invalid = Number(db.getSetting('twilio_sig_invalid_count', '0'))
    res.json({
      mode: db.getSetting('twilio_signature_mode', 'monitor'),
      valid, invalid,
      last_valid_at: db.getSetting('twilio_sig_last_valid_at', null),
      last_invalid_at: db.getSetting('twilio_sig_last_invalid_at', null),
      last_invalid_path: db.getSetting('twilio_sig_last_invalid_path', null),
      ready_to_enforce: valid > 0 && invalid === 0,
      record_calls: db.getSetting('twilio_record_calls', '0') === '1',
      missed_call_textback_enabled: db.getSetting('missed_call_textback_enabled', '1') === '1',
      missed_call_textback_message: db.getSetting('missed_call_textback_message', 'Sorry we missed your call! This is the Matt Smith Team. How can we help? You can reply right here.'),
    })
  })
  // Admin toggles: webhook signature enforcement, call recording, missed-call text-back.
  app.post('/api/settings/twilio/mode', (req, res) => {
    const b = req.body || {}
    if (b.signature_mode && ['enforce', 'monitor', 'off'].includes(b.signature_mode)) db.setSetting('twilio_signature_mode', b.signature_mode)
    if (b.record_calls !== undefined) db.setSetting('twilio_record_calls', b.record_calls ? '1' : '0')
    if (b.missed_call_textback !== undefined) db.setSetting('missed_call_textback_enabled', b.missed_call_textback ? '1' : '0')
    if (typeof b.missed_call_message === 'string' && b.missed_call_message.trim()) db.setSetting('missed_call_textback_message', b.missed_call_message.trim().slice(0, 320))
    res.json({
      success: true,
      signature_mode: db.getSetting('twilio_signature_mode', 'monitor'),
      record_calls: db.getSetting('twilio_record_calls', '0'),
      missed_call_textback_enabled: db.getSetting('missed_call_textback_enabled', '1'),
    })
  })
  // A2P 10DLC status for a number (brand + campaign + messaging-service membership).
  app.get('/api/settings/twilio/a2p', async (req, res) => {
    try {
      const { a2pStatus } = await import('./twilio.js')
      res.json(await a2pStatus(req.query.number || null))
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // ===================== VOICE (browser softphone) =====================
  const HUB_BASE = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  const xml = (res, body) => res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`)
  const escXml = (s) => String(s == null ? '' : s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]))
  const fmtPhoneUS = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '') }
  const isDncStatus = (s) => ['junk', 'donotcontact'].includes(String(s || '').toLowerCase())
  // Best-effort match an inbound/outbound phone to a client + log the call. Unknown
  // numbers are still logged (client_id NULL, thread_key u_<phone10>) so the Unknown
  // queue catches inbound calls from people not yet in the CRM.
  // Insert-or-update a call / voicemail communication row, keyed by Twilio SID.
  const upsertCall = (channel, direction, phone, f = {}) => {
    try {
      const last10 = String(phone || '').replace(/\D/g, '').slice(-10)
      if (!last10) return null
      const match = db.all('SELECT id, first_name, last_name, phone FROM clients WHERE phone LIKE ?', ['%' + last10.slice(-7)])
        .find(x => String(x.phone || '').replace(/\D/g, '').slice(-10) === last10)
      const ext = 'twiliocall_' + (f.sid || Date.now())
      const label = channel === 'voicemail' ? 'Voicemail' : `${direction === 'incoming' ? 'Incoming' : 'Outgoing'} call`
      const tail = f.disposition ? ` — ${f.disposition}` : (f.delivery_status && !['completed', 'ringing', 'initiated'].includes(f.delivery_status) ? ` (${f.delivery_status})` : '')
      const preview = (label + tail).slice(0, 160)
      const existing = db.get('SELECT id FROM communications WHERE external_id = ?', [ext])
      if (existing) {
        const sets = ['preview=?'], vals = [preview]
        for (const k of ['delivery_status', 'duration_sec', 'recording_url', 'recording_sid', 'transcript', 'disposition']) if (f[k] != null) { sets.push(`${k}=?`); vals.push(f[k]) }
        if (channel === 'voicemail') { sets.push('channel=?', "status='unread'"); vals.push('voicemail') }
        vals.push(existing.id)
        db.run(`UPDATE communications SET ${sets.join(', ')} WHERE id=?`, vals)
        return match ? match.id : null
      }
      const cid = match ? match.id : null
      const cname = match ? `${match.first_name || ''} ${match.last_name || ''}`.trim() : fmtPhoneUS(phone)
      const tkey = match ? `c${match.id}_call` : `u_${last10}`
      db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, external_id, thread_key, status, delivery_status, duration_sec, recording_url, recording_sid, transcript, disposition, occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [channel, direction, cid, cname, direction === 'incoming' ? phone : '', direction === 'outgoing' ? phone : '',
          null, preview, ext, tkey, direction === 'incoming' ? 'unread' : 'read',
          f.delivery_status || null, f.duration_sec || null, f.recording_url || null, f.recording_sid || null, f.transcript || null, f.disposition || null, new Date().toISOString()])
      return cid
    } catch { return null }
  }
  // Auto text-back when an inbound call is missed. Off/on via missed_call_textback_enabled
  // (default on). Deduped per call (external_id missedcb_<sid>). Uses the SAME texting
  // permission model as every other outbound text: a known contact who replied STOP
  // (hub_text_opt_out) or is Do Not Contact/Junk is skipped; unknown callers are allowed
  // (they just called us). Fires only for numbers we can text back.
  const missedCallTextBack = async (from, callSid) => {
    try {
      if (db.getSetting('missed_call_textback_enabled', '1') !== '1') return
      const last10 = String(from || '').replace(/\D/g, '').slice(-10)
      if (last10.length < 10) return
      const ext = 'missedcb_' + (callSid || last10)
      if (db.get('SELECT id FROM communications WHERE external_id=?', [ext])) return
      const match = db.all('SELECT id, first_name, last_name, phone, status, hub_text_opt_out FROM clients WHERE phone LIKE ?', ['%' + last10.slice(-7)])
        .find(x => String(x.phone || '').replace(/\D/g, '').slice(-10) === last10)
      if (match && (match.hub_text_opt_out || isDncStatus(match.status))) return
      const msg = db.getSetting('missed_call_textback_message', 'Sorry we missed your call! This is the Matt Smith Team. How can we help? You can reply right here.')
      const { sendSms } = await import('./twilio.js')
      const r = await sendSms(from, msg, { statusCallback: HUB_BASE + '/api/inbox/twilio-status' })
      const name = match ? `${match.first_name || ''} ${match.last_name || ''}`.trim() : fmtPhoneUS(from)
      db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['text', 'outgoing', match ? match.id : null, name, '', from, msg.slice(0, 160), msg, ext, match ? `c${match.id}_text` : `u_${last10}`, 'read', r.status || 'queued', 'auto:missed-call', new Date().toISOString()])
      console.log('[missed-call textback] sent to', last10)
    } catch (e) { console.error('[missed-call textback]', e.message) }
  }
  // Twilio signature guard (dynamic import; module is cached after first load).
  const twGuard = (req, res, next) => import('./twilio-webhook.js').then(m => m.twilioWebhookGuard(req, res, next)).catch(() => next())

  // Access token for the browser Device.
  app.get('/api/voice/token', async (_req, res) => {
    try { const { voiceToken } = await import('./voice.js'); res.json(voiceToken()) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  // One-time setup: create API key + TwiML app + wire the number's voice webhooks.
  app.post('/api/voice/setup', async (_req, res) => {
    try { const { ensureVoiceInfra } = await import('./voice.js'); res.json(await ensureVoiceInfra(HUB_BASE)) }
    catch (e) { res.status(500).json({ ok: false, error: e.message }) }
  })
  // TwiML: browser places an outbound call → dial the number from the Hub caller ID.
  app.post('/api/voice/outbound', twGuard, async (req, res) => {
    const { toE164, twilioConfig } = await import('./twilio.js')
    const to = toE164(req.body?.To || '')
    const from = twilioConfig().from
    if (!to) return xml(res, `<Say>No number was provided.</Say>`)
    upsertCall('call', 'outgoing', to, { sid: req.body?.CallSid, delivery_status: 'initiated' })
    const rec = (db.getSetting && db.getSetting('twilio_record_calls', '0')) === '1'
    const recAttr = rec ? ` record="record-from-answer-dual" recordingStatusCallback="${HUB_BASE}/api/voice/recording"` : ''
    xml(res, `<Dial answerOnBridge="true" callerId="${escXml(from)}"${recAttr}><Number>${escXml(to)}</Number></Dial>`)
  })
  // TwiML: inbound call → ring the browser client; the Dial `action` handles the result.
  app.post('/api/voice/inbound', twGuard, (req, res) => {
    const from = req.body?.From || ''
    upsertCall('call', 'incoming', from, { sid: req.body?.CallSid, delivery_status: 'ringing' })
    xml(res, `<Dial answerOnBridge="true" timeout="20" action="${HUB_BASE}/api/voice/dial-complete" callerId="${escXml(from)}"><Client>hub</Client></Dial>`)
  })
  // After the browser Dial finishes: answered → log completed; missed → take a voicemail.
  app.post('/api/voice/dial-complete', twGuard, (req, res) => {
    const b = req.body || {}
    const from = b.From || ''
    if ((b.DialCallStatus || '') === 'completed') {
      upsertCall('call', 'incoming', from, { sid: b.CallSid, delivery_status: 'completed', duration_sec: Number(b.DialCallDuration || 0) || null })
      return xml(res, `<Hangup/>`)
    }
    upsertCall('call', 'incoming', from, { sid: b.CallSid, delivery_status: 'missed', disposition: 'Missed call' })
    missedCallTextBack(from, b.CallSid)   // fire-and-forget auto text-back
    xml(res, `<Say voice="alice">Sorry we missed you. Please leave a message after the tone.</Say><Record maxLength="120" playBeep="true" transcribe="true" transcribeCallback="${HUB_BASE}/api/voice/transcription" action="${HUB_BASE}/api/voice/voicemail-done"/><Say voice="alice">We did not receive a message. Goodbye.</Say>`)
  })
  // Voicemail recording finished (Record `action`) → store it on the timeline.
  app.post('/api/voice/voicemail-done', twGuard, (req, res) => {
    const b = req.body || {}
    if (b.RecordingUrl) upsertCall('voicemail', 'incoming', b.From || '', { sid: b.CallSid, delivery_status: 'completed', recording_url: b.RecordingUrl, recording_sid: b.RecordingSid, duration_sec: Number(b.RecordingDuration || 0) || null, disposition: 'Voicemail' })
    xml(res, `<Say voice="alice">Thank you. Goodbye.</Say><Hangup/>`)
  })
  // Voicemail transcription ready → attach transcript to the row.
  app.post('/api/voice/transcription', twGuard, (req, res) => {
    try { if (req.body?.CallSid && req.body?.TranscriptionText) db.run('UPDATE communications SET transcript=? WHERE external_id=?', [req.body.TranscriptionText, 'twiliocall_' + req.body.CallSid]) } catch {}
    res.sendStatus(204)
  })
  // Call recording ready (when recording is enabled) → attach media.
  app.post('/api/voice/recording', twGuard, (req, res) => {
    try { if (req.body?.CallSid && req.body?.RecordingUrl) db.run('UPDATE communications SET recording_url=?, recording_sid=? WHERE external_id=?', [req.body.RecordingUrl, req.body.RecordingSid, 'twiliocall_' + req.body.CallSid]) } catch {}
    res.sendStatus(204)
  })
  // Call status callback → reconcile final status + duration.
  app.post('/api/voice/status', twGuard, (req, res) => {
    try {
      const b = req.body || {}
      const dir = (b.Direction || '').includes('inbound') ? 'incoming' : 'outgoing'
      const phone = dir === 'incoming' ? b.From : b.To
      upsertCall('call', dir, phone, { sid: b.CallSid, delivery_status: b.CallStatus, duration_sec: Number(b.CallDuration || 0) || null })
    } catch {}
    res.sendStatus(204)
  })
  // Send a one-off test text (verify outbound works end to end).
  app.post('/api/settings/twilio/test-send', async (req, res) => {
    const { to, body } = req.body || {}
    if (!to) return res.status(400).json({ error: 'to (phone number) is required' })
    try {
      const { sendSms } = await import('./twilio.js')
      const base = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
      const r = await sendSms(to, body || 'Test from the Matt Smith Team Hub — texting is live. You can reply to this message.', { statusCallback: base + '/api/inbox/twilio-status' })
      res.json({ success: true, ...r })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })
  // Point a Twilio number's inbound + status webhooks at the Hub (defaults to the
  // configured From number). Repoints it away from GoHighLevel/whatever it was on.
  app.post('/api/settings/twilio/wire-number', async (req, res) => {
    const base = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
    const b = req.body || {}
    const number = b.number || db.getSetting('twilio_from_number', '')
    // Defaults point the number at the Hub; pass sms_url/status_url to point it
    // elsewhere (e.g. restore a number back to GoHighLevel/LeadConnector).
    const smsUrl = b.sms_url || (base + '/api/inbox/twilio-inbound')
    const statusUrl = b.status_url || (base + '/api/inbox/twilio-status')
    try {
      const { wireNumberToHub } = await import('./twilio.js')
      const r = await wireNumberToHub(number, smsUrl, statusUrl)
      res.json({ success: true, ...r })
    } catch (e) { res.status(500).json({ error: e.message }) }
  })

  // Inbox mailboxes (App Password over IMAP). Multiple mailboxes supported; each
  // read directly (no forwarding). Creds live in app_settings, never in git.
  app.get('/api/settings/mailboxes', async (_req, res) => {
    const { mailboxesPublic } = await import('./gmail-inbox.js')
    res.json(mailboxesPublic())
  })
  app.post('/api/settings/mailboxes', async (req, res) => {
    const { user, app_password, host } = req.body || {}
    if (!user || !app_password) return res.status(400).json({ error: 'Email and App Password are required.' })
    const { addMailbox, testMailbox } = await import('./gmail-inbox.js')
    const id = addMailbox({ user, app_password, host })
    const status = await testMailbox(id)   // connect + seed immediately
    res.json({ id, ...status })
  })
  app.post('/api/settings/mailboxes/:id/test', async (req, res) => {
    const { testMailbox } = await import('./gmail-inbox.js')
    res.json(await testMailbox(req.params.id))
  })
  app.delete('/api/settings/mailboxes/:id', async (req, res) => {
    const { removeMailbox } = await import('./gmail-inbox.js')
    removeMailbox(req.params.id)
    res.json({ success: true })
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
    const COLS = ['fub_event_id', 'client_id', 'fub_person_id', 'type', 'page_title', 'page_url', 'page_duration', 'prop_street', 'prop_city', 'prop_state', 'prop_zip', 'prop_mls', 'prop_price', 'occurred_at', 'description']
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
      let source = 'live'

      // 1) Pull the lead's CURRENT viewed listings LIVE from FUB (real-time).
      const { fubGet, fubConfigured } = await import('./fub-helper.js')
      let data = null
      if (fubConfigured()) {
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            try { data = await fubGet('/events', { personId: client.fub_person_id, limit: 100, sort: '-created' }); break }
            catch (err) {
              if (err && err.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, 1200 * (attempt + 1))); continue }
              throw err
            }
          }
        } catch { data = null }  // fall through to cache
      }
      for (const e of (data?.events || [])) {
        const p = e.property
        if (!p || !p.mlsNumber || p.forRent || seen.has(p.mlsNumber)) continue
        seen.add(p.mlsNumber); props.push({ mlsNumber: p.mlsNumber, street: p.street, city: p.city, state: p.state, code: p.code, price: p.price, occurred: e.occurred || e.created, eventId: e.id })
        if (props.length >= max) break
      }
      // Warm the cache with what we just pulled (dedup by event id).
      if (props.length) {
        try {
          db.beginBulk?.()
          for (const p of props) {
            if (p.eventId && !db.get('SELECT id FROM fub_activity WHERE fub_event_id = ?', [p.eventId])) {
              db.run("INSERT INTO fub_activity (fub_event_id, client_id, fub_person_id, type, prop_street, prop_city, prop_state, prop_zip, prop_mls, prop_price, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                [p.eventId, clientId, client.fub_person_id, 'Viewed Property', p.street || null, p.city || null, p.state || null, p.code || null, p.mlsNumber || null, (p.price != null ? String(p.price) : null), p.occurred])
            }
          }
        } finally { db.endBulk?.() }
      }

      // 2) Fall back to the Hub's stored listings if FUB is unavailable / returned nothing.
      if (!props.length) {
        source = 'cache'
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

    // One-time cleanup: pull any lead already in a stop status (Junk/DNC) out of
    // every active drip + automation. Idempotent, so safe to run each boot.
    try { purgeStopStatusEnrollments() } catch (e) { console.error('[boot] stop-status purge failed:', e.message) }

    // Start auto-sync scheduler
    startScheduler()
  })
}

// ---- Global safety net ----------------------------------------------------
// Node 15+ terminates the process on an UNHANDLED promise rejection by default
// (this surfaces as Render's "Exited with status 1"). A single stray rejection
// in one request or scheduled job should not take the whole Hub offline — log
// it loudly and stay up. A truly uncaught synchronous exception may leave the
// process in an unknown state, so we log and exit for a clean restart (Render
// restarts automatically; the DB has atomic saves + multi-layer backups).
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] kept the Hub alive:', reason && reason.stack ? reason.stack : reason)
  recordCrash('unhandledRejection', reason)
})
process.on('uncaughtException', (err) => {
  // Keep the Hub UP. A single stray error (a dropped socket, a background job) should
  // not take the whole service down and page the team via Render. All real state is
  // disk-backed (better-sqlite3 transactions), so surviving is safe; the error is
  // recorded to /api/crash-log so we can find and fix the root cause. True fatal
  // conditions (OOM) can't be caught here anyway.
  console.error('[uncaughtException] logged; keeping the Hub alive:', err && err.stack ? err.stack : err)
  recordCrash('uncaughtException', err)
})

start().catch(err => {
  console.error('Failed to start server:', err)
  process.exit(1)
})
