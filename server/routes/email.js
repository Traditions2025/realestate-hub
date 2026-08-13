import { Router } from 'express'
import db from '../database.js'
import { fubGet, fubConfigured } from '../fub-helper.js'
import { TRANSACTION_TEMPLATES, PRELISTING_TEMPLATES, fillMergeVars, buildMergeVars, lookupCloser } from '../transaction-email-templates.js'
import { buildDigest, sendDigest } from '../transaction-digest.js'

const router = Router()
const n = (v) => v === undefined || v === '' ? null : v

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || ''
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'mattsmithremax@gmail.com'
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Matt Smith Team'
const REPLY_TO = process.env.SENDGRID_REPLY_TO || 'matt@mattsmithteam.com'

// Always-CC recipients on transaction-related emails (team coordination)
const TRANSACTION_ALWAYS_CC = ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com']

// Closer info — resolved at request time from partners table (with env-var fallback)
// See lookupCloser() in ../transaction-email-templates.js

// Email signature - appended to all template emails
const SIGNATURE = `

—
Matt Smith
Broker Associate | Residential, Commercial, Ag Real Estate
Licensed in the State of Iowa
Matt Smith Team | RE/MAX Concepts
Local Trusted Realtor with 35+ years of Experience | Over 2,000 homes sold

Phone: (319) 431-5859
Website: https://www.mattsmithteam.com
Office: RE/MAX Concepts, 5235 Buffalo Rdg Dr NE, Cedar Rapids, IA 52411`

// Email templates with merge variables: {{first_name}}, {{last_name}}, {{address}}
const TEMPLATES = {
  'follow_up': {
    name: 'Follow Up',
    subject: 'Following up on your home search',
    body: `Hi {{first_name}},

Just checking in to see how your home search is going. I wanted to make sure you have everything you need.

Have any questions about the Cedar Rapids market or specific neighborhoods? I'm here to help.

Talk soon,${SIGNATURE}`
  },
  'just_listed': {
    name: 'Just Listed',
    subject: 'New Listing in {{city}} - You should see this',
    body: `Hi {{first_name}},

A new listing just hit the market in {{city}} that fits what you're looking for. Want to be among the first to see it before this weekend?

Reply or text me back and I'll send the full details + schedule a showing.${SIGNATURE}`
  },
  'market_update': {
    name: 'Market Update',
    subject: 'Cedar Rapids market update for {{city}}',
    body: `Hi {{first_name}},

Quick market snapshot for the Cedar Rapids metro area:

- Inventory continues to favor sellers in your price range
- Average days on market trending shorter
- Interest rates holding steady this month

Curious what your home would sell for in today's market? I'd be glad to put together a free home value estimate.${SIGNATURE}`
  },
  'home_value': {
    name: 'Home Value Check-in',
    subject: 'What\'s your home worth in 2026?',
    body: `Hi {{first_name}},

Quick question - have you wondered what your home at {{address}} is worth in today's market?

Values in your neighborhood have shifted in the last year. I can put together a free, no-obligation home value report based on recent sales nearby.

Just reply "yes" and I'll send it over.${SIGNATURE}`
  },
  'past_client': {
    name: 'Past Client Check-in',
    subject: 'Hope all is well',
    body: `Hi {{first_name}},

Hope you're doing well. Just thinking of you and wanted to check in.

If you ever know anyone thinking about buying or selling in Cedar Rapids, I'd appreciate the introduction. And if you ever have real estate questions yourself, I'm always here.${SIGNATURE}`
  },
  'showing_followup': {
    name: 'Showing Follow-Up',
    subject: 'How was the showing?',
    body: `Hi {{first_name}},

Wanted to follow up on the showing today. What did you think?

Anything specific that stood out (good or bad)? I'm happy to schedule another look or pull comps so we can decide on next steps.${SIGNATURE}`
  },
}

// One-time: migrate the built-in email templates into the editable `templates`
// table so they appear in the Templates tab and can be edited / added to.
// Called at boot after initDb. Idempotent (skips names already present).
export function seedEmailTemplates() {
  try {
    for (const t of Object.values(TEMPLATES)) {
      const exists = db.get("SELECT id FROM templates WHERE type = 'email' AND name = ?", [t.name])
      if (!exists) {
        db.run("INSERT INTO templates (name, type, category, subject, body, is_html) VALUES (?,?,?,?,?,0)",
          [t.name, 'email', 'Built-in', t.subject, t.body])
      }
    }
    // Editable wording for the dynamic "Homes They Viewed" email. The live property
    // cards get injected where {{properties}} appears. Category 'Dynamic' keeps it
    // out of the composer dropdown (the composer uses the 🏡 action), but it shows
    // in the Templates tab so the intro / subject / closing can be edited.
    if (!db.get("SELECT id FROM templates WHERE type = 'email' AND name = 'Homes They Viewed'")) {
      db.run("INSERT INTO templates (name, type, category, subject, body, is_html) VALUES (?,?,?,?,?,1)",
        ['Homes They Viewed', 'email', 'Dynamic',
          'Do you want to see any of these properties?',
          `<p style="margin:0 0 16px;">{{greeting}} {{first_name}}, would you like any more info or to go and see any of these properties?</p>\n{{properties}}\n<p style="margin:16px 0 0;">Just reply and let me know which ones catch your eye and I'll set up the showings.</p>`])
    }
  } catch (e) { console.error('[templates] seed error:', e.message) }
}

// Email templates for the composer — now sourced from the editable `templates`
// table (type='email'), so anything created/edited in the Templates tab shows here.
router.get('/templates', (req, res) => {
  // Exclude 'Dynamic' templates (e.g. Homes They Viewed) — the composer triggers
  // those via a dedicated action, so listing them here would duplicate the option.
  const rows = db.all("SELECT id, name, subject, body FROM templates WHERE type = 'email' AND (category IS NULL OR category != 'Dynamic') ORDER BY name")
  res.json(rows.map(t => ({ id: String(t.id), name: t.name, subject: t.subject, body: t.body })))
})

function currentGreeting() {
  const hour = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/Chicago' }).format(new Date()))
  return hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'
}
function savedSignatureHtml() {
  return (db.getSetting?.('email_signature', '') || '') || 'Matt Smith<br/>Matt Smith Team, RE/MAX Real Estate Concepts'
}

// Build the "homes they viewed" property cards for a client from the STORED
// listings in the Hub (fub_activity). No FUB call — safe for bulk sends. Returns
// '' when the client has no cached listings.
// Render cards from normalized rows: [{ mls, street, city, state, zip, price }]
function cardHtmlFromRows(rows, max = 5) {
  const seen = new Set(); const cards = []
  const usd = (v) => { const n = Number(v); return isFinite(n) && n > 0 ? '$' + n.toLocaleString() : '' }
  for (const v of rows) {
    if (!v.mls || seen.has(v.mls)) continue
    seen.add(v.mls)
    const slug = `${v.street || ''} ${v.city || ''} ${v.state || ''} ${v.zip || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const url = `https://www.mattsmithteam.com/property-search/detail/352/${v.mls}/${slug}/`
    const photo = `https://cdn.listingphotos.sierrastatic.com/large/352/352_${v.mls}_01.jpg`
    const addr = `${v.street || ''} ${v.city || ''}, ${v.state || ''} ${v.zip || ''}`.replace(/\s+/g, ' ').replace(/\s,/g, ',').trim()
    const price = usd(v.price)
    cards.push(`<table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;margin:0 0 14px;border:1px solid #e2e8f0;border-radius:8px;"><tr>
<td valign="top" style="padding:12px;width:174px;"><a href="${url}"><img src="${photo}" alt="${addr}" width="150" style="width:150px;height:auto;border-radius:6px;display:block;border:0;"/></a></td>
<td valign="top" style="padding:12px 12px 12px 0;font-family:Arial,Helvetica,sans-serif;">
<a href="${url}" style="color:#2563eb;font-weight:bold;font-size:15px;text-decoration:none;">${addr} | MLS ${v.mls}</a>
${price ? `<div style="color:#334155;font-size:13px;margin-top:6px;">${price}</div>` : ''}
<div style="color:#475569;font-size:13px;margin-top:6px;">Home for sale at ${addr}, with MLS ${v.mls}.</div>
</td></tr></table>`)
    if (cards.length >= max) break
  }
  return cards.join('\n')
}

// Cards from the Hub's STORED listings (fub_activity) — no FUB call.
export function buildPropertyCards(clientId, max = 5) {
  const rows = db.all("SELECT prop_mls, prop_street, prop_city, prop_state, prop_zip, prop_price FROM fub_activity WHERE client_id = ? AND prop_mls IS NOT NULL AND prop_mls != '' ORDER BY occurred_at DESC, id DESC", [clientId])
  return cardHtmlFromRows(rows.map(v => ({ mls: v.prop_mls, street: v.prop_street, city: v.prop_city, state: v.prop_state, zip: v.prop_zip, price: v.prop_price })), max)
}

// Cards from a LIVE FUB pull (real-time). Warms the cache with what it fetches,
// and falls back to the stored cache if FUB errors / rate-limits / returns nothing.
export async function buildPropertyCardsLive(client, max = 5) {
  if (!client?.fub_person_id || !fubConfigured()) return buildPropertyCards(client?.id, max)
  try {
    let data = null
    for (let i = 0; i < 3; i++) {
      try { data = await fubGet('/events', { personId: client.fub_person_id, limit: 100, sort: '-created' }); break }
      catch (err) { if (err && err.status === 429 && i < 2) { await new Promise(r => setTimeout(r, 1200 * (i + 1))); continue } throw err }
    }
    const seen = new Set(); const rows = []
    for (const e of (data?.events || [])) {
      const p = e.property
      if (!p || !p.mlsNumber || p.forRent || seen.has(p.mlsNumber)) continue
      seen.add(p.mlsNumber)
      rows.push({ mls: p.mlsNumber, street: p.street, city: p.city, state: p.state, zip: p.code, price: p.price, occurred: e.occurred || e.created, eventId: e.id })
      if (rows.length >= max) break
    }
    if (!rows.length) return buildPropertyCards(client.id, max)
    // Warm the cache with the freshly-fetched views (dedup by event id).
    try {
      db.beginBulk?.()
      for (const r of rows) {
        if (!db.get('SELECT id FROM fub_activity WHERE fub_event_id = ?', [r.eventId])) {
          db.run("INSERT INTO fub_activity (fub_event_id, client_id, fub_person_id, type, prop_street, prop_city, prop_state, prop_zip, prop_mls, prop_price, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [r.eventId, client.id, client.fub_person_id, 'Viewed Property', r.street || null, r.city || null, r.state || null, r.zip || null, r.mls || null, (r.price != null ? String(r.price) : null), r.occurred])
        }
      }
    } finally { db.endBulk?.() }
    return cardHtmlFromRows(rows, max)
  } catch { return buildPropertyCards(client.id, max) }
}

const fmtMoney = (v) => v ? '$' + Number(v).toLocaleString() : ''
function priceRangeStr(min, max) {
  if (min && max) return `${fmtMoney(min)} to ${fmtMoney(max)}`
  if (max) return `up to ${fmtMoney(max)}`
  if (min) return `${fmtMoney(min)}+`
  return ''
}
// Primary "city of interest" from the FUB viewed-cities list (first = top), else city.
const primaryCity = (client) => (String(client.fub_viewed_cities || '').split(',').map(s => s.trim()).filter(Boolean)[0]) || client.city || ''
// City of the LAST property they viewed in FUB (last_fub_activity_detail is
// "street, city"), which is the freshest interest signal. Falls back to the
// top viewed city, then their own city.
function lastViewedCity(client) {
  const d = String(client.last_fub_activity_detail || '').trim()
  if (d) {
    const parts = d.split(',').map(s => s.trim()).filter(Boolean)
    const last = parts[parts.length - 1]
    if (last && !/\d/.test(last) && last.length <= 40) return last
  }
  return ''
}
// Clean the FUB viewed-cities list into a short, natural phrase: drop street-ish
// noise ("… Road/St/Ave …") and duplicates, keep the top 3, join with "and".
const STREETISH = /\b(road|rd|st|street|ave|avenue|dr|drive|lane|ln|ct|court|blvd|way|cir|circle|pl|place|ter|terrace|hwy|highway|pkwy)\b/i
function listingInterestStr(raw, fallback) {
  const seen = new Set()
  const cities = String(raw || '').split(',').map(s => s.trim())
    .filter(s => s && !/\d/.test(s) && !STREETISH.test(s))
    .filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true })
    .slice(0, 3)
  if (!cities.length) return fallback || ''
  if (cities.length === 1) return cities[0]
  if (cities.length === 2) return `${cities[0]} and ${cities[1]}`
  return `${cities.slice(0, -1).join(', ')}, and ${cities[cities.length - 1]}`
}

// FUB "At a Glance" price point: the average price of the homes this lead has
// actually viewed (from their FUB property-view events), rounded to the nearest
// $10k. Far more real than the Sierra saved-search band, which is a shared default
// (~$200k-$600k) on 99% of leads. Blank when we have no viewed-home prices.
function fubPricePoint(client) {
  // Prefer the stored FUB At-a-Glance value (works for cold leads); fall back to
  // averaging any locally-synced recent property views.
  if (client && client.fub_price_point) return client.fub_price_point
  const clientId = client && client.id
  if (!clientId) return ''
  try {
    const rows = db.all("SELECT prop_price FROM fub_activity WHERE client_id = ? AND prop_price IS NOT NULL AND prop_price != ''", [clientId])
    const nums = rows.map(r => Number(String(r.prop_price).replace(/[^0-9.]/g, ''))).filter(n => n > 10000 && n < 20000000)
    if (!nums.length) return ''
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length
    return '$' + (Math.round(avg / 10000) * 10000).toLocaleString()
  } catch { return '' }
}
// Suppress the Sierra saved-search band when it is the shared default so we never
// state a budget the lead never actually chose.
function searchPriceRange(client) {
  const min = Number(client.search_price_min) || 0, max = Number(client.search_price_max) || 0
  if (min === 200000 && max === 600000) return ''   // the ~99% default — not real
  return priceRangeStr(client.search_price_min, client.search_price_max)
}

function fillTemplate(text, client) {
  if (!text) return ''
  // Lender: client records rarely carry it, so fall back to the lender on this
  // client's most recent transaction (populated once they're under contract).
  let lenderName = client.lender_name || ''
  let lenderCompany = client.lender_company || ''
  if ((!lenderName || !lenderCompany) && client.id) {
    try {
      const tx = db.get(`SELECT lender_name, lender_company FROM transactions
        WHERE client_id = ? AND (lender_name IS NOT NULL OR lender_company IS NOT NULL)
        ORDER BY updated_at DESC LIMIT 1`, [client.id])
      if (tx) { lenderName = lenderName || tx.lender_name || ''; lenderCompany = lenderCompany || tx.lender_company || '' }
    } catch {}
  }
  return text
    .replace(/\{\{first_name\}\}/g, client.first_name || 'there')
    .replace(/\{\{last_name\}\}/g, client.last_name || '')
    .replace(/\{\{full_name\}\}/g, `${client.first_name || ''} ${client.last_name || ''}`.trim())
    .replace(/\{\{email\}\}/g, client.email || '')
    .replace(/\{\{phone\}\}/g, client.phone || '')
    .replace(/\{\{address\}\}/g, client.address || 'your home')
    .replace(/\{\{city\}\}/g, client.city || 'Cedar Rapids')
    .replace(/\{\{state\}\}/g, client.state || '')
    .replace(/\{\{zip\}\}/g, client.zip || '')
    .replace(/\{\{city_of_interest\}\}/g, lastViewedCity(client) || primaryCity(client))
    .replace(/\{\{listing_interest\}\}/g, listingInterestStr(client.fub_viewed_cities, primaryCity(client)))
    .replace(/\{\{last_viewed_address\}\}/g, client.last_fub_activity_detail || '')
    .replace(/\{\{search_price_range\}\}/g, searchPriceRange(client))
    .replace(/\{\{price_point\}\}/g, fubPricePoint(client))
    .replace(/\{\{lender_name\}\}/g, lenderName)
    .replace(/\{\{lender_company\}\}/g, lenderCompany)
    .replace(/\{\{agent\}\}/g, client.agent_assigned || 'Matt Smith')
    .replace(/\{\{greeting\}\}/g, currentGreeting())
    .replace(/\{\{signature\}\}/g, savedSignatureHtml())
}

// Placeholder / known-bad email domains we must never send to. Sierra assigns
// leads with no real email an address at @notvalidemail.com — sending there
// bounces and hurts sender reputation, so every send path is gated on this.
const BLOCKED_EMAIL_DOMAINS = ['@notvalidemail.com']
export function isBlockedEmail(email) {
  const e = String(email || '').toLowerCase().trim()
  if (!e) return true
  return BLOCKED_EMAIL_DOMAINS.some(d => e.endsWith(d))
}

// ---- Emailability guard --------------------------------------------------
// The team's decision (2026-08-12): an "opt-out" should TAG a contact, not hard
// block them, because in Sierra a property-alert unsubscribe also flips the
// marketing-email opt-out — so many "opted out" leads never actually unsubscribed
// from us. We still HARD block the cases that genuinely must never be emailed:
//   - no address / blocked throwaway domain
//   - a spam complaint (ReportedAsSpam) — sending again wrecks deliverability
//   - a bad address (WrongAddress) — it just bounces
// SendGrid's own suppression list remains the backstop for true unsubscribes.
export function emailHardBlock(client) {
  if (!client || !client.email || !String(client.email).trim()) return 'no email'
  if (isBlockedEmail(client.email)) return 'blocked email domain'
  if (client.email_status === 'ReportedAsSpam') return 'reported as spam'
  if (client.email_status === 'WrongAddress') return 'wrong address'
  return null
}
// Soft, informational: which kind of opt-out is on file (for tagging), or null.
//   'email' = actually opted out of our marketing email
//   'alert' = only unsubscribed from property alerts (still emailable)
export function emailOptOutTag(client) {
  if (!client) return null
  if (client.marketing_email_opt_out || client.email_status === 'OptedOut') return 'email'
  if (client.ealert_opt_out) return 'alert'
  return null
}

// Shared sender for sequence/drip/automation emails. Resolves a template if given,
// fills merge fields, injects live property cards where {{properties}} appears (or
// when include_properties is set), respects opt-outs, and tags a SendGrid category
// so the send shows up in Reporting. Returns a short status string.
// Record an outgoing client email in the Inbox (communications) so EVERY email
// we send a client, not just Inbox replies, shows up under Sent and threads with
// that client. Best-effort: never let logging break a send. Skips no-client /
// no-email sends (team notifications, digests, etc. pass no client).
export function logSentToInbox(client, subject, body, externalId) {
  try {
    if (!client || !client.id || !client.email) return
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    const preview = String(body || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
    db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['email', 'outgoing', client.id, name, FROM_EMAIL, client.email, subject || '', preview, body || '',
        externalId || `out_${Date.now()}_${client.id}_${Math.floor(Math.random() * 1e6)}`, `c${client.id}_email`, 'read', new Date().toISOString()])
  } catch { /* logging must never break a send */ }
}

export async function sendSequenceEmail(client, cfg = {}, category = null) {
  const hard = emailHardBlock(client)
  if (hard) return { ok: false, reason: hard }
  // Opted-out contacts are allowed through (tagged), per team policy.
  let subject = cfg.subject, body = cfg.body
  if (cfg.template_id) {
    const t = db.get('SELECT subject, body FROM templates WHERE id = ?', [Number(cfg.template_id)])
    if (t) { subject = subject || t.subject; body = body || t.body }
  }
  if (!subject || !body) throw new Error('email step missing subject/body/template')
  subject = fillTemplate(subject, client)
  body = fillTemplate(body, client)
  if (cfg.include_properties || /\{\{properties\}\}/.test(body)) {
    let cards = ''
    try { cards = await buildPropertyCardsLive(client, Number(cfg.max) || 4) } catch {}
    body = /\{\{properties\}\}/.test(body) ? body.replace(/\{\{properties\}\}/g, cards) : (body + cards)
  }
  await sendViaSendGrid(client.email, `${client.first_name || ''} ${client.last_name || ''}`.trim(), subject, body, cfg.reply_to || null, [], [], [], category)
  logSentToInbox(client, subject, body, category ? `${category}_${Date.now()}_${client.id}` : null)
  return { ok: true, subject }
}

// Render a sequence/drip step exactly as sendSequenceEmail would build it, but
// WITHOUT sending — uses STORED property cards (no live FUB call), safe & instant
// for previews. Returns { subject, body }.
export function previewSequenceEmail(client, cfg = {}) {
  let subject = cfg.subject, body = cfg.body
  if (cfg.template_id) {
    const t = db.get('SELECT subject, body FROM templates WHERE id = ?', [Number(cfg.template_id)])
    if (t) { subject = subject || t.subject; body = body || t.body }
  }
  subject = fillTemplate(subject || '', client)
  body = fillTemplate(body || '', client)
  if (cfg.include_properties || /\{\{properties\}\}/.test(body)) {
    let cards = ''
    try { cards = buildPropertyCards(client.id, Number(cfg.max) || 4) } catch {}
    body = /\{\{properties\}\}/.test(body) ? body.replace(/\{\{properties\}\}/g, cards) : (body + cards)
  }
  return { subject, body }
}

// Preview a template filled with client data. Loads from the editable `templates`
// table (numeric id). Falls back to the built-in constant for any legacy string id.
router.get('/preview/:templateId/:clientId', (req, res) => {
  const idNum = Number(req.params.templateId)
  let tpl = idNum ? db.get('SELECT name, subject, body FROM templates WHERE id = ?', [idNum]) : null
  if (!tpl) tpl = TEMPLATES[req.params.templateId]
  if (!tpl) return res.status(404).json({ error: 'Template not found' })
  const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(req.params.clientId)])
  if (!client) return res.status(404).json({ error: 'Client not found' })
  res.json({
    subject: fillTemplate(tpl.subject, client),
    body: fillTemplate(tpl.body, client),
  })
})

// Extract YouTube video ID from a URL (returns null if not a YouTube URL)
function parseYoutubeId(url) {
  if (!url) return null
  const s = String(url).trim()
  let m = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,15})/)
  if (m) return m[1]
  m = s.match(/[?&]v=([A-Za-z0-9_-]{6,15})/)
  if (m) return m[1]
  m = s.match(/youtube\.com\/(?:embed|shorts)\/([A-Za-z0-9_-]{6,15})/)
  if (m) return m[1]
  return null
}

// Build email-safe YouTube preview block (clickable thumbnail with play overlay)
function buildYoutubeEmbedHtml(url) {
  const id = parseYoutubeId(url)
  if (!id) return null
  const watchUrl = `https://www.youtube.com/watch?v=${id}`
  const thumb = `https://img.youtube.com/vi/${id}/hqdefault.jpg`
  return `<div style="margin:14px 0;text-align:center;"><a href="${watchUrl}" target="_blank" rel="noopener" style="display:inline-block;position:relative;text-decoration:none;max-width:560px;width:100%;"><img src="${thumb}" alt="Watch video on YouTube" style="display:block;width:100%;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.18);" /><span style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(255,0,0,0.92);color:#fff;font-family:Arial,sans-serif;font-weight:700;font-size:18px;padding:10px 22px;border-radius:8px;letter-spacing:0.5px;">▶ Play</span></a><div style="font-family:Arial,sans-serif;font-size:12px;color:#666;margin-top:6px;">Click the image to watch on YouTube</div></div>`
}

// Replace bare YouTube URLs in a body with embedded thumbnail blocks.
// Skips URLs already inside <a href="..."> or other attribute contexts.
function autoEmbedYoutubeLinks(body) {
  if (!body) return body
  const re = /(https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[\w=&-]+|embed\/[A-Za-z0-9_-]{6,15}|shorts\/[A-Za-z0-9_-]{6,15})|youtu\.be\/[A-Za-z0-9_-]{6,15})[^\s<"']*)/gi
  return body.replace(re, (match, url, offset, full) => {
    const before = full.slice(Math.max(0, offset - 80), offset)
    if (/<a\b[^>]*$/i.test(before)) return match
    if (/(href|src)\s*=\s*["'][^"']*$/i.test(before)) return match
    return buildYoutubeEmbedHtml(url) || match
  })
}

// Detect whether a body string contains HTML markup (paragraphs, links, formatting, etc.)
function looksLikeHtml(s) {
  if (!s) return false
  return /<\/?(html|head|body|p|div|br|a|h[1-6]|ul|ol|li|strong|em|b|i|table|tr|td|img|span|hr|blockquote|pre|code|style|center)\b/i.test(s) || /<!DOCTYPE\s+html/i.test(s)
}

// Convert plain text to nicely-formatted HTML:
// - Escape entities, then auto-link URLs / emails / phones
// - Treat blank lines as paragraph breaks (<p>...</p>)
// - Single newlines become <br>
function plainToHtml(text) {
  if (!text) return ''
  let s = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
  // http(s)://... URLs
  s = s.replace(
    /(\b(?:https?|ftp):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gi,
    '<a href="$1">$1</a>'
  )
  // www.* URLs (no protocol)
  s = s.replace(
    /(^|\s)(www\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gi,
    '$1<a href="https://$2">$2</a>'
  )
  // Email addresses
  s = s.replace(
    /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
    '<a href="mailto:$1">$1</a>'
  )
  // Phone numbers (319-431-5859 / (319) 431-5859 / 319.431.5859)
  s = s.replace(
    /(?<!\d)(\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4})(?!\d)/g,
    (m) => `<a href="tel:${m.replace(/[^0-9+]/g, '')}">${m}</a>`
  )
  // Paragraph breaks on 2+ newlines, line breaks on single newlines
  const paragraphs = s.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
  return paragraphs.map(p => `<p style="margin: 0 0 12px 0;">${p.replace(/\n/g, '<br>')}</p>`).join('\n')
}

// Convert HTML to a readable plain-text alternative for the multipart email
function htmlToPlain(html) {
  if (!html) return ''
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Parse a To field into clean email array — accepts string ("a@x, b@y") or array
function parseEmails(input) {
  if (!input) return []
  const arr = Array.isArray(input)
    ? input
    : String(input).split(/[,;\n]+/)
  return [...new Set(arr.map(s => s && String(s).trim()).filter(Boolean))]
}

// Send a single email via SendGrid (supports multiple To, CC, BCC, attachments)
export async function sendViaSendGrid(to, toName, subject, body, replyTo, ccList = [], attachments = [], bccList = [], category = null) {
  if (!SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY not set on server. Add it as an environment variable on Render.')
  }
  const toEmails = parseEmails(to).filter(e => !isBlockedEmail(e))
  if (!toEmails.length) throw new Error('No valid recipient email (placeholder/blocked domain)')
  const personalization = {
    to: toEmails.map((email, i) => ({
      email,
      name: i === 0 ? (toName || undefined) : undefined,
    })),
  }
  const toLowerSet = new Set(toEmails.map(e => e.toLowerCase()))
  if (ccList && ccList.length) {
    // Dedupe and exclude any primary recipients from CC
    const uniqueCc = [...new Set(ccList.filter(e => e && !toLowerSet.has(e.toLowerCase()) && !isBlockedEmail(e)))]
    if (uniqueCc.length) personalization.cc = uniqueCc.map(email => ({ email }))
  }
  if (bccList && bccList.length) {
    const ccLowerSet = new Set((personalization.cc || []).map(c => c.email.toLowerCase()))
    const uniqueBcc = [...new Set(bccList.filter(e => e && !toLowerSet.has(e.toLowerCase()) && !ccLowerSet.has(e.toLowerCase()) && !isBlockedEmail(e)))]
    if (uniqueBcc.length) personalization.bcc = uniqueBcc.map(email => ({ email }))
  }
  const resp = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [personalization],
      from: { email: FROM_EMAIL, name: (db.getSetting && db.getSetting('email_from_name', '')) || FROM_NAME },
      reply_to: { email: replyTo || REPLY_TO, name: (db.getSetting && db.getSetting('email_from_name', '')) || FROM_NAME },
      ...(category ? { categories: [String(category)].slice(0, 1) } : {}),
      subject,
      content: (() => {
        // Two paths:
        //  - Body has actual HTML tags → send as-is for HTML, strip tags for plain version
        //  - Body is plain text → auto-convert to HTML (wrap paragraphs, auto-link URLs/emails/phones)
        const isHtml = looksLikeHtml(body)
        let html = isHtml ? body : plainToHtml(body)
        // Auto-replace plain YouTube URLs with clickable thumbnail blocks
        html = autoEmbedYoutubeLinks(html)
        const plain = isHtml ? htmlToPlain(body) : body
        return [
          { type: 'text/plain', value: plain },
          { type: 'text/html', value: html },
        ]
      })(),
      ...(Array.isArray(attachments) && attachments.length ? {
        attachments: attachments.map(a => ({
          content: a.content_base64 || a.content,
          type: a.type || 'application/octet-stream',
          filename: a.filename || 'attachment',
          disposition: 'attachment',
        })),
      } : {}),
    }),
  })

  if (resp.status === 202) {
    return { success: true, messageId: resp.headers.get('x-message-id') }
  }
  const errText = await resp.text()
  throw new Error(`SendGrid ${resp.status}: ${errText.substring(0, 200)}`)
}

// Send to a single client
router.post('/send', async (req, res) => {
  const { client_id, to_email, subject, body, template, cc, bcc, attachments } = req.body
  let client = null
  let recipient = to_email

  if (client_id) {
    client = db.get('SELECT * FROM clients WHERE id = ?', [Number(client_id)])
    if (!client) return res.status(404).json({ error: 'Client not found' })
    recipient = recipient || client.email
  }

  if (!recipient) return res.status(400).json({ error: 'No recipient email' })
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body required' })

  // Opt-outs are allowed (tagged, not blocked). Only hard-block undeliverable /
  // spam-complaint / bad-address cases.
  if (client) {
    const hard = emailHardBlock(client)
    if (hard) return res.status(400).json({ error: `Cannot email - ${hard}` })
  }

  const filledSubject = client ? fillTemplate(subject, client) : subject
  const filledBody = client ? fillTemplate(body, client) : body

  try {
    const result = await sendViaSendGrid(
      recipient,
      client ? `${client.first_name} ${client.last_name}` : null,
      filledSubject,
      filledBody,
      REPLY_TO,
      Array.isArray(cc) ? cc : [],
      Array.isArray(attachments) ? attachments : [],
      Array.isArray(bcc) ? bcc : []
    )
    db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
      template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [n(client_id), recipient, FROM_EMAIL, FROM_NAME, filledSubject, filledBody,
        n(template), 'sent', 'sendgrid', n(result.messageId), n(req.body.sent_by) || 'team'])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_sent', 'client', client_id || null, `Email sent to ${recipient}: ${filledSubject}`])
    if (client) logSentToInbox(client, filledSubject, filledBody)   // show under Inbox → Sent
    res.json({ success: true, messageId: result.messageId })
  } catch (err) {
    db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, error)
      VALUES (?,?,?,?,?,?,?)`,
      [n(client_id), recipient, filledSubject, filledBody, n(template), 'failed', err.message])
    res.status(500).json({ error: err.message })
  }
})

// Bulk send runs in the BACKGROUND (each recipient does a live FUB pull for their
// listings, so 100s of recipients take a minute+). The client kicks it off and
// polls /bulk-status for progress.
let _bulkState = { running: false, total: 0, done: 0, sent: 0, failed: 0, skipped: 0, noListings: 0, startedAt: null, finishedAt: null, errors: [] }

async function runBulkSend(client_ids, subject, body, template) {
  _bulkState = { running: true, total: client_ids.length, done: 0, sent: 0, failed: 0, skipped: 0, noListings: 0, startedAt: new Date().toISOString(), finishedAt: null, errors: [] }
  const wantsProperties = (body || '').includes('{{properties}}')
  // Create a campaign row for the Reporting tab; tag every send with its category
  // so SendGrid stats (opens/clicks/bounces) can be pulled per campaign.
  const camp = db.run('INSERT INTO email_campaigns (subject, from_name, recipients, status) VALUES (?,?,?,?)', [subject || '(no subject)', FROM_NAME, client_ids.length, 'sending'])
  const campaignId = camp.lastInsertRowid
  const category = 'camp_' + campaignId
  db.run('UPDATE email_campaigns SET category = ? WHERE id = ?', [category, campaignId])
  try {
    for (const id of client_ids) {
      const client = db.get('SELECT * FROM clients WHERE id = ?', [Number(id)])
      if (emailHardBlock(client)) { _bulkState.skipped++; _bulkState.done++; continue }
      // Opted-out contacts are included (tagged), per team policy.

      const filledSubject = fillTemplate(subject, client)
      let filledBody = fillTemplate(body, client)
      if (wantsProperties) {
        const cardsHtml = await buildPropertyCardsLive(client, 5)  // real-time, cache fallback
        if (!cardsHtml) { _bulkState.noListings++; _bulkState.skipped++; _bulkState.done++; continue }
        filledBody = filledBody.replace(/\{\{properties\}\}/g, cardsHtml)
      }
      try {
        const result = await sendViaSendGrid(client.email, `${client.first_name} ${client.last_name}`, filledSubject, filledBody, undefined, [], [], [], category)
        db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
          template, status, provider, provider_message_id, sent_by, campaign_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [client.id, client.email, FROM_EMAIL, FROM_NAME, filledSubject, filledBody, n(template), 'sent', 'sendgrid', n(result.messageId), 'team', campaignId])
        logSentToInbox(client, filledSubject, filledBody, `${category}_${client.id}`)   // show under Inbox → Sent
        _bulkState.sent++
      } catch (err) {
        _bulkState.failed++
        if (_bulkState.errors.length < 10) _bulkState.errors.push({ client_id: id, error: err.message })
      }
      _bulkState.done++
    }
    db.run('INSERT INTO activity_log (action, entity_type, details) VALUES (?,?,?)',
      ['bulk_email', 'client', `Bulk email: ${_bulkState.sent} sent, ${_bulkState.failed} failed, ${_bulkState.skipped} skipped`])
  } catch (e) {
    if (_bulkState.errors.length < 10) _bulkState.errors.push({ error: e.message })
  } finally {
    _bulkState.running = false
    _bulkState.finishedAt = new Date().toISOString()
    db.run("UPDATE email_campaigns SET sent=?, failed=?, skipped=?, status='finished', finished_at=datetime('now') WHERE id=?",
      [_bulkState.sent, _bulkState.failed, _bulkState.skipped, campaignId])
  }
}

router.post('/bulk', (req, res) => {
  const { client_ids, subject, body, template } = req.body
  if (!Array.isArray(client_ids) || client_ids.length === 0) return res.status(400).json({ error: 'client_ids required' })
  if (client_ids.length > 2000) return res.status(400).json({ error: 'Max 2000 recipients per bulk send. Send in batches.' })
  if (_bulkState.running) return res.json({ success: true, alreadyRunning: true, progress: _bulkState })
  runBulkSend(client_ids, subject, body, template).catch(() => { _bulkState.running = false; _bulkState.finishedAt = new Date().toISOString() })
  res.json({ success: true, started: true, total: client_ids.length })
})

router.get('/bulk-status', (_req, res) => res.json(_bulkState))

// Render one recipient's fully-personalized email (fills merge fields + injects
// their viewed listings) — used to PREVIEW a bulk send before sending.
router.post('/render-preview', async (req, res) => {
  const { client_id, subject, body } = req.body || {}
  const client = client_id ? db.get('SELECT * FROM clients WHERE id = ?', [Number(client_id)]) : null
  if (!client) return res.status(404).json({ error: 'client not found' })
  let filledBody = fillTemplate(body || '', client)
  const needsProps = filledBody.includes('{{properties}}')
  const cards = needsProps ? await buildPropertyCardsLive(client, 5) : ''  // real-time pull
  if (needsProps) {
    filledBody = filledBody.replace(/\{\{properties\}\}/g, cards || '<p style="color:#b91c1c;">(no listings found for this client — they would be skipped)</p>')
  }
  res.json({
    to: `${client.first_name} ${client.last_name} <${client.email || 'no email'}>`,
    subject: fillTemplate(subject || '', client),
    body: filledBody,
    has_listings: !!cards,
  })
})

// Email history for a client
router.get('/history/:clientId', (req, res) => {
  const rows = db.all('SELECT * FROM email_log WHERE client_id = ? ORDER BY sent_at DESC LIMIT 50',
    [Number(req.params.clientId)])
  res.json(rows)
})

// Total email stats
router.get('/stats', (req, res) => {
  const sent = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'sent'").c
  const failed = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'failed'").c
  const today = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'sent' AND sent_at >= date('now')").c
  res.json({ total_sent: sent, total_failed: failed, sent_today: today })
})

// Full email log with filtering + pagination — covers BOTH successful and failed sends
router.get('/log', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500)
  const offset = Number(req.query.offset) || 0
  let sql = 'SELECT * FROM email_log WHERE 1=1'
  const params = []
  if (req.query.search) {
    sql += ' AND (to_email LIKE ? OR subject LIKE ? OR error LIKE ?)'
    const term = `%${req.query.search}%`
    params.push(term, term, term)
  }
  if (req.query.status) { sql += ' AND status = ?'; params.push(req.query.status) }
  if (req.query.template) { sql += ' AND template = ?'; params.push(req.query.template) }
  if (req.query.since) { sql += ' AND sent_at >= ?'; params.push(req.query.since) }
  sql += ' ORDER BY sent_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)
  const rows = db.all(sql, params)
  const total = db.get('SELECT COUNT(*) as c FROM email_log').c
  const sentCount = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'sent'").c
  const failedCount = db.get("SELECT COUNT(*) as c FROM email_log WHERE status = 'failed'").c
  // Trim body in list response so we don't ship huge HTML over the wire
  const trimmed = rows.map(r => ({ ...r, body: (r.body || '').slice(0, 200) }))
  res.json({ rows: trimmed, total, sent: sentCount, failed: failedCount, limit, offset })
})

// Single email entry with full body
router.get('/log/:id', (req, res) => {
  const row = db.get('SELECT * FROM email_log WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.get('/check-config', (req, res) => {
  res.json({
    configured: !!SENDGRID_API_KEY,
    from_email: FROM_EMAIL,
    from_name: FROM_NAME,
  })
})

// =====================================================================
// TC daily digest — preview, force-send, history
// =====================================================================

// Preview the digest as HTML in the browser (renders directly, no email send)
router.get('/tc-digest/preview', (req, res) => {
  const period = req.query.period === 'afternoon' ? 'afternoon' : 'morning'
  const built = buildDigest(period)
  if (req.query.format === 'json') {
    return res.json({ subject: built.subject, html: built.html, transactionCount: built.transactionCount, actionCount: built.actionCount, overdue: built.overdue, dueToday: built.dueToday })
  }
  res.set('Content-Type', 'text/html; charset=utf-8').send(built.html)
})

// Force-send the digest now (ignores idempotency)
router.post('/tc-digest/send', async (req, res) => {
  const period = (req.body?.period || req.query?.period) === 'afternoon' ? 'afternoon' : 'morning'
  const force = req.body?.force !== false  // default true on manual trigger
  try {
    const r = await sendDigest(period, { force })
    res.json(r)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// History of recent digest fires
router.get('/tc-digest/log', (req, res) => {
  const rows = db.all('SELECT * FROM digest_log ORDER BY sent_at DESC LIMIT 50')
  res.json(rows)
})

// Render preview — returns the exact HTML the recipient will receive.
// Applies the same pipeline as sendViaSendGrid: plain→HTML, YouTube auto-embed.
router.post('/preview', (req, res) => {
  const { body, subject } = req.body || {}
  if (!body) return res.status(400).json({ error: 'body required' })
  const isHtml = looksLikeHtml(body)
  let html = isHtml ? body : plainToHtml(body)
  html = autoEmbedYoutubeLinks(html)
  res.json({
    subject: subject || '',
    html,
    from_email: FROM_EMAIL,
    from_name: FROM_NAME,
  })
})

// =========================================================
// TRANSACTION & PRE-LISTING TEMPLATES + SEND
// =========================================================

// List available transaction templates
router.get('/transaction-templates', (_req, res) => {
  const list = Object.entries(TRANSACTION_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    role: t.role,
    recipient: t.recipient,
    subject: t.subject,
  }))
  res.json(list)
})

// List available pre-listing templates
router.get('/prelisting-templates', (_req, res) => {
  const list = Object.entries(PRELISTING_TEMPLATES).map(([id, t]) => ({
    id,
    name: t.name,
    recipient: t.recipient,
    subject: t.subject,
  }))
  res.json(list)
})

// Preview a transaction template — fills merge vars from transaction + linked client
router.get('/transaction-preview/:templateId/:transactionId', (req, res) => {
  const tpl = TRANSACTION_TEMPLATES[req.params.templateId]
  if (!tpl) return res.status(404).json({ error: 'Template not found' })
  const tx = db.get('SELECT * FROM transactions WHERE id = ?', [Number(req.params.transactionId)])
  if (!tx) return res.status(404).json({ error: 'Transaction not found' })
  const client = tx.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [tx.client_id]) : null
  const vars = buildMergeVars(client, tx)
  res.json({
    template_id: req.params.templateId,
    name: tpl.name,
    role: tpl.role,
    recipient: tpl.recipient,
    subject: fillMergeVars(tpl.subject, vars),
    body: fillMergeVars(tpl.body, vars),
    suggested_to: resolveRecipient(tpl.recipient, client, tx),
    auto_cc: TRANSACTION_ALWAYS_CC,
    suggested_cc: suggestedCcs(tpl.recipient),
  })
})

// Preview a pre-listing template
router.get('/prelisting-preview/:templateId/:preListingId', (req, res) => {
  const tpl = PRELISTING_TEMPLATES[req.params.templateId]
  if (!tpl) return res.status(404).json({ error: 'Template not found' })
  const pl = db.get('SELECT * FROM pre_listings WHERE id = ?', [Number(req.params.preListingId)])
  if (!pl) return res.status(404).json({ error: 'Pre-listing not found' })
  const client = pl.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [pl.client_id]) : null
  const vars = buildMergeVars(client, { property_address: pl.property_address })
  res.json({
    template_id: req.params.templateId,
    name: tpl.name,
    subject: fillMergeVars(tpl.subject, vars),
    body: fillMergeVars(tpl.body, vars),
    suggested_to: client?.email || '',
  })
})

function resolveRecipient(recipientType, client, tx) {
  if (recipientType === 'client') return client?.email || ''
  if (recipientType === 'lender') return tx?.lender_email || ''
  if (recipientType === 'lender_team') return tx?.lender_email || ''
  if (recipientType === 'closer') return lookupCloser().email || ''
  return ''
}

// Suggested CCs based on recipient type
function suggestedCcs(recipientType) {
  if (recipientType === 'lender_team') {
    const closer = lookupCloser()
    return closer.email ? [closer.email] : []
  }
  return []
}

// Endpoint so the frontend can pre-populate Cherryl's email when "Email Cherryl" is clicked
router.get('/closer-info', (_req, res) => {
  res.json(lookupCloser())
})

// Send a pre-listing email (always CCs the team — same coordination policy)
router.post('/send-prelisting', async (req, res) => {
  const { pre_listing_id, to_email, to_name, subject, body, template_id, additional_cc, attachments } = req.body
  if (!to_email || !subject || !body) {
    return res.status(400).json({ error: 'to_email, subject, and body are required' })
  }
  const pl = pre_listing_id ? db.get('SELECT * FROM pre_listings WHERE id = ?', [Number(pre_listing_id)]) : null
  const client = pl?.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [pl.client_id]) : null

  const ccList = [...TRANSACTION_ALWAYS_CC]
  if (Array.isArray(additional_cc)) ccList.push(...additional_cc.filter(Boolean))

  try {
    const result = await sendViaSendGrid(to_email, to_name, subject, body, REPLY_TO, ccList, attachments)
    db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
      template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [n(client?.id), to_email, FROM_EMAIL, FROM_NAME, subject, body,
        n(template_id), 'sent', 'sendgrid', n(result.messageId), n(req.body.sent_by) || 'team'])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_sent', 'pre_listing', pl?.id || null, `Pre-listing email sent to ${to_email}: ${subject}`])
    res.json({ success: true, messageId: result.messageId, cc: ccList })
  } catch (err) {
    db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, error)
      VALUES (?,?,?,?,?,?,?)`,
      [n(client?.id), to_email, subject, body, n(template_id), 'failed', err.message])
    res.status(500).json({ error: err.message })
  }
})

// Send a transaction-related email (always CCs the team)
router.post('/send-transaction', async (req, res) => {
  const { transaction_id, to_email, to_name, subject, body, template_id, additional_cc, attachments } = req.body
  if (!to_email || !subject || !body) {
    return res.status(400).json({ error: 'to_email, subject, and body are required' })
  }
  const tx = transaction_id ? db.get('SELECT * FROM transactions WHERE id = ?', [Number(transaction_id)]) : null
  const client = tx?.client_id ? db.get('SELECT * FROM clients WHERE id = ?', [tx.client_id]) : null

  // Build CC list: always-CC team members + any additional from request
  const ccList = [...TRANSACTION_ALWAYS_CC]
  if (Array.isArray(additional_cc)) ccList.push(...additional_cc.filter(Boolean))

  try {
    const result = await sendViaSendGrid(to_email, to_name, subject, body, REPLY_TO, ccList, attachments)
    const recipients = parseEmails(to_email).join(', ')
    const attachNote = Array.isArray(attachments) && attachments.length
      ? ` · ${attachments.length} attachment${attachments.length === 1 ? '' : 's'}: ${attachments.map(a => a.filename).join(', ')}`
      : ''
    db.run(`INSERT INTO email_log (client_id, to_email, from_email, from_name, subject, body,
      template, status, provider, provider_message_id, sent_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [n(client?.id), recipients, FROM_EMAIL, FROM_NAME, subject, body,
        n(template_id), 'sent', 'sendgrid', n(result.messageId), n(req.body.sent_by) || 'team'])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['email_sent', 'transaction', tx?.id || null, `Transaction email sent to ${recipients} (CC: ${ccList.join(', ')})${attachNote}: ${subject}`])
    res.json({ success: true, messageId: result.messageId, cc: ccList, recipients: parseEmails(to_email) })
  } catch (err) {
    db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, error)
      VALUES (?,?,?,?,?,?,?)`,
      [n(client?.id), String(to_email || ''), subject, body, n(template_id), 'failed', err.message])
    res.status(500).json({ error: err.message })
  }
})

export default router
