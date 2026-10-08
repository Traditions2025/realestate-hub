// Admin diagnostics (Phase 15/16 / P0-3): failure visibility + backup health.
// Owner/Admin only. Read-only except resolving failures.
import { Router } from 'express'
import * as fsSync from 'fs'
import db from '../database.js'
import { requirePermission } from './auth.js'
import { listFailures, failureCounts, resolveFailure, resolveAll } from '../failures.js'
import { splitNotes, stampFor } from '../client-notes.js'

const router = Router()

// ── Import condo properties from an MLS export ───────────────────────────────────────
// John supplied an "Agent Single Line" export of active/pending/sold condos. This is the
// only authoritative statement in the system of what IS a condo: FUB's property.type is
// empty on this account and listings.property_type is unpopulated.
//
// Keyed on MLS#, which joins straight to fub_activity.prop_mls, and on a normalised
// address so an owner can be matched too. Re-importing refreshes rather than duplicating.
export function addressKey(a) {
  return String(a || '').toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/(street|st|avenue|ave|road|rd|drive|dr|court|ct|lane|ln|circle|cir|boulevard|blvd|place|pl|trail|trl|way|alley|aly|terrace|ter)/g, '')
    .replace(/(north|south|east|west|ne|nw|se|sw|n|s|e|w)/g, '')
    .replace(/\s+/g, ' ').trim()
}

router.post('/condo-import', requirePermission('settings.edit'), (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null
  if (!rows) return res.status(400).json({ error: 'rows[] is required' })
  const money = (v) => { const n = Number(String(v || '').replace(/[^0-9.]/g, '')); return n > 0 ? n : null }
  let imported = 0, skipped = 0
  for (const r of rows) {
    const mls = String(r['MLS#'] || r.mls || '').trim()
    const addr = String(r.Address || r.address || '').trim()
    if (!mls || !addr) { skipped++; continue }
    db.run(`INSERT INTO condo_properties
      (mls_number, address, address_key, city, sub_type, style, status, current_price, close_price, close_date, beds, baths, year_built, imported_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(mls_number) DO UPDATE SET
        address=excluded.address, address_key=excluded.address_key, city=excluded.city,
        sub_type=excluded.sub_type, style=excluded.style, status=excluded.status,
        current_price=excluded.current_price, close_price=excluded.close_price,
        close_date=excluded.close_date, imported_at=datetime('now')`,
      [mls, addr, addressKey(addr), String(r.City || '').trim(), String(r.SubType || '').trim(),
       String(r.Style || '').trim(), String(r.Status || '').trim(),
       money(r['Current Price']), money(r['Close Price']), String(r['Close Date'] || '').trim(),
       String(r['Beds Total'] || '').trim(), String(r['Baths Total'] || '').trim(),
       String(r['Year Built'] || '').trim()])
    imported++
  }
  res.json({ imported, skipped,
    total_in_table: (db.get('SELECT COUNT(*) c FROM condo_properties') || {}).c || 0,
    by_city: db.all('SELECT city, COUNT(*) n FROM condo_properties GROUP BY city ORDER BY n DESC LIMIT 5'),
    by_status: db.all('SELECT status, COUNT(*) n FROM condo_properties GROUP BY status ORDER BY n DESC') })
})

// ── Who looked at what: property-interest search ─────────────────────────────────────
// John, 2026-10-08: "who looked at condos in Marion in the $150k-$300k price range in
// the last few years, even if it's just 1 view".
//
// Read-only. The view history lives in fub_activity (city, price, street, MLS, title) and
// lead_activity (Sierra page views). Neither records a property TYPE, so "condo" has to be
// inferred — and the endpoint says which signal matched on every row rather than quietly
// deciding. `debug=1` returns the shape of the data instead of results, because guessing
// at the distribution is how you build a filter that silently matches nothing.
// The search itself, as a function, so a saved list can be REBUILT from the same
// criteria later instead of being a snapshot that rots the day someone views another
// condo. The route is a thin wrapper over it.
function runPropertyInterest(q) {
  const req = { query: q || {} }
  const res = { _j: null, json(v) { this._j = v; return v }, status() { return this } }
  propertyInterestHandler(req, res)
  return res._j
}

function propertyInterestHandler(req, res) {
  const city = String(req.query.city || '').trim()
  const minP = Number(req.query.min) || 0
  const maxP = Number(req.query.max) || 99999999
  const since = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.since || '')) ? String(req.query.since).slice(0, 10) : null
  const wantType = String(req.query.type || '').trim().toLowerCase()
  // John, 2026-10-08: "all active status only... no dead or dnc". Dead and Do Not Contact
  // are never worth surfacing in a prospecting list, so they are excluded ALWAYS, not on
  // request - a lead-mining result that includes them is a trap. `status=` narrows
  // further to exactly one status when that is what is wanted.
  const NEVER = ['junk', 'donotcontact', 'archived']
  const onlyStatus = String(req.query.status || '').trim().toLowerCase()

  if (req.query.debug === '1') {
    return res.json({
      fub_activity_rows: (db.get('SELECT COUNT(*) c FROM fub_activity') || {}).c || 0,
      with_city: (db.get("SELECT COUNT(*) c FROM fub_activity WHERE COALESCE(prop_city,'') <> ''") || {}).c || 0,
      with_price: (db.get("SELECT COUNT(*) c FROM fub_activity WHERE COALESCE(prop_price,'') <> ''") || {}).c || 0,
      top_cities: db.all(`SELECT prop_city, COUNT(*) n FROM fub_activity
        WHERE COALESCE(prop_city,'') <> '' GROUP BY prop_city ORDER BY n DESC LIMIT 12`),
      price_samples: db.all(`SELECT DISTINCT prop_price FROM fub_activity
        WHERE COALESCE(prop_price,'') <> '' LIMIT 10`).map(r => r.prop_price),
      types: db.all(`SELECT type, COUNT(*) n FROM fub_activity GROUP BY type ORDER BY n DESC LIMIT 10`),
      listings_types: db.all(`SELECT property_type, COUNT(*) n FROM listings
        WHERE COALESCE(property_type,'') <> '' GROUP BY property_type ORDER BY n DESC LIMIT 12`),
      lead_activity_rows: (db.get('SELECT COUNT(*) c FROM lead_activity') || {}).c || 0,
      sample: db.all(`SELECT prop_street, prop_city, prop_price, prop_mls, substr(page_title,1,70) page_title, occurred_at
        FROM fub_activity WHERE COALESCE(prop_city,'') <> '' ORDER BY occurred_at DESC LIMIT 6`),
    })
  }

  // prop_price is free text ("$225,000", "225000", "$1.2M"), so the digits are what count.
  const rows = db.all(`SELECT a.client_id, a.prop_street, a.prop_city, a.prop_price, a.prop_mls,
      a.page_title, a.page_url, a.occurred_at,
      c.first_name, c.last_name, c.email, c.phone, c.status, c.type AS lead_type, c.agent_assigned,
      l.property_type AS listing_type, r.building_type AS realist_type
    FROM fub_activity a
    JOIN clients c ON c.id = a.client_id AND c.merged_into IS NULL
    LEFT JOIN listings l ON l.mls_number = a.prop_mls AND COALESCE(a.prop_mls,'') <> ''
    -- realist_properties has no MLS number; it is keyed on the ADDRESS. Joining on a
    -- column that does not exist 500'd the whole endpoint.
    LEFT JOIN realist_properties r ON lower(r.property_address) = lower(a.prop_street)
      AND COALESCE(a.prop_street,'') <> ''
    WHERE (? = '' OR lower(COALESCE(a.prop_city,'')) = lower(?)
           OR lower(COALESCE(a.page_title,'')) LIKE lower(?))
      AND lower(COALESCE(c.status,'')) NOT IN (${NEVER.map(() => '?').join(',')})
      AND COALESCE(c.hub_text_opt_out,0) = 0
      ${onlyStatus ? "AND lower(COALESCE(c.status,'')) = ?" : ''}
      ${since ? 'AND a.occurred_at >= ?' : ''}`,
    [city, city, `%${city}%`, ...NEVER,
     ...(onlyStatus ? [onlyStatus] : []), ...(since ? [since] : [])])

  const priceOf = (s) => {
    const t = String(s || '').replace(/[, $]/g, '')
    const m = t.match(/(\d+(?:\.\d+)?)\s*([mk])?/i)
    if (!m) return null
    let v = parseFloat(m[1])
    if (/m/i.test(m[2] || '')) v *= 1000000
    else if (/k/i.test(m[2] || '')) v *= 1000
    return v > 0 ? v : null
  }
  // No table records "condo", so three signals, strongest first. Each row says which
  // one fired, so a judgement call stays visible instead of hiding in a total.
  const condoSignal = (r) => {
    const lt = `${r.listing_type || ''} ${r.realist_type || ''}`.toLowerCase()
    if (/condo|townh|attached/.test(lt)) return 'listing type: ' + (r.listing_type || r.realist_type)
    const txt = `${r.prop_street || ''} ${r.page_title || ''} ${r.page_url || ''}`.toLowerCase()
    if (/\bcondo/.test(txt)) return 'the word condo in the listing'
    if (/\bunit\b|\bapt\b|\b#\s*\d|\bste\b/.test(txt)) return 'unit number in the address'
    // This feed writes a unit as a BARE TRAILING LETTER — "3900 Deer Valley Drive B" —
    // and never as Unit/Apt/#. 18 of 687 Marion addresses look like this, and none of
    // the patterns above matched a single one of them.
    if (/\s[a-z]$/i.test(String(r.prop_street || '').trim())) return 'trailing unit letter in the address'
    return null
  }

  const byClient = new Map()
  let priced = 0, inRange = 0
  for (const r of rows) {
    const p = priceOf(r.prop_price)
    if (p == null) continue
    priced++
    if (p < minP || p > maxP) continue
    inRange++
    const sig = wantType === 'condo' ? condoSignal(r) : 'n/a'
    if (wantType === 'condo' && !sig) continue
    const k = r.client_id
    if (!byClient.has(k)) {
      byClient.set(k, { client_id: k, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
        email: r.email, phone: r.phone, status: r.status, lead_type: r.lead_type,
        agent: r.agent_assigned, views: 0, first_seen: r.occurred_at, last_seen: r.occurred_at, properties: [] })
    }
    const e = byClient.get(k)
    e.views++
    if (r.occurred_at < e.first_seen) e.first_seen = r.occurred_at
    if (r.occurred_at > e.last_seen) e.last_seen = r.occurred_at
    if (e.properties.length < 8) e.properties.push({
      address: r.prop_street, price: r.prop_price, mls: r.prop_mls,
      when: String(r.occurred_at || '').slice(0, 10), why_condo: sig })
  }
  const leads = [...byClient.values()].sort((a, b) => b.views - a.views)
  res.json({
    filter: { city: city || '(any)', min: minP, max: maxP, since: since || '(all time)',
      type: wantType || '(any)', status: onlyStatus || '(any workable)',
      always_excluded: NEVER.concat('anyone who replied STOP') },
    rows_considered: rows.length, rows_with_a_price: priced, rows_in_price_range: inRange,
    leads: leads.length, total_views: leads.reduce((a, b) => a + b.views, 0),
    by_status: leads.reduce((m, l) => { const k = l.status || '(none)'; m[k] = (m[k] || 0) + 1; return m }, {}),
    results: leads,
    note: 'No table records property type, so condo is inferred; every property says which signal matched.',
  })
}

router.get('/property-interest', requirePermission('settings.view'), propertyInterestHandler)

// Save a property-interest search as a named client list.
// John, 2026-10-08: "then make that as a smart list Marion Condo Campaign".
//
// It stores BOTH the matching client_ids and the criteria that produced them. The ids
// make it usable immediately; the criteria let it be rebuilt, which matters because a
// snapshot is wrong the moment someone views another condo. Re-posting the same name
// refreshes that list rather than making a second one with the same name.
router.post('/property-interest/save-list', requirePermission('settings.edit'), (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name is required' })
  const criteria = {
    source: 'property-interest',
    city: req.body?.city || '', min: Number(req.body?.min) || 0, max: Number(req.body?.max) || 0,
    since: req.body?.since || null, type: req.body?.type || '', status: req.body?.status || '',
  }
  const found = runPropertyInterest({
    city: criteria.city, min: criteria.min, max: criteria.max,
    since: criteria.since, type: criteria.type, status: criteria.status,
  })
  if (!found || !Array.isArray(found.results)) return res.status(500).json({ error: 'search failed' })
  const ids = found.results.map(r => r.client_id)
  const existing = db.get('SELECT id FROM client_lists WHERE lower(name) = lower(?)', [name])
  if (existing) {
    db.run(`UPDATE client_lists SET description = ?, filter_criteria = ?, client_ids = ?,
            is_dynamic = 0, updated_at = datetime('now') WHERE id = ?`,
      [req.body?.description || null, JSON.stringify(criteria), JSON.stringify(ids), existing.id])
    return res.json({ list_id: existing.id, name, refreshed: true, members: ids.length, criteria,
      by_status: found.by_status, total_views: found.total_views })
  }
  const r = db.run(`INSERT INTO client_lists (name, description, filter_criteria, is_dynamic, client_ids)
                    VALUES (?,?,?,?,?)`,
    [name, req.body?.description || null, JSON.stringify(criteria), 0, JSON.stringify(ids)])
  res.status(201).json({ list_id: r.lastInsertRowid, name, created: true, members: ids.length, criteria,
    by_status: found.by_status, total_views: found.total_views })
})

// ── Remove the FUB text rows that never had a body ───────────────────────────────────
// John, 2026-10-08: "you can remove those text that you tried to import from FUB to HUB
// since nothing exist anyways just make sure you don't remove any actual text".
//
// Every condition below has to hold at once, and the body test is the real guard: a row
// is only removed because it SAYS it has no content, never because of where it came from.
// If FUB ever starts returning bodies, those rows stop matching and survive.
//
// Dry by default. `confirm` must be the exact count a dry run reported, so a number that
// moved between looking and deleting stops the run instead of taking a different set.
router.post('/purge-hidden-fub-texts', requirePermission('settings.edit'), (req, res) => {
  const WHERE = `channel = 'text'
      AND external_id LIKE 'fub_text_%'
      AND body LIKE '%hidden for privacy%'`
  const g = (sql, p = []) => { try { return (db.get(sql, p) || {}).c || 0 } catch { return 0 } }

  const target = g(`SELECT COUNT(*) c FROM communications WHERE ${WHERE}`)
  // everything we must NOT touch, counted before and after so the claim is checked
  const before = {
    all_texts: g("SELECT COUNT(*) c FROM communications WHERE channel='text'"),
    twilio_texts: g("SELECT COUNT(*) c FROM communications WHERE channel='text' AND external_id LIKE 'twilio_%'"),
    readable_fub_texts: g(`SELECT COUNT(*) c FROM communications WHERE channel='text'
      AND external_id LIKE 'fub_text_%' AND body NOT LIKE '%hidden for privacy%'`),
    notes: g("SELECT COUNT(*) c FROM communications WHERE channel='note'"),
    calls: g("SELECT COUNT(*) c FROM communications WHERE channel IN ('call','voicemail')"),
    emails: g("SELECT COUNT(*) c FROM communications WHERE channel='email'"),
  }
  const dry = req.body?.dry !== false
  if (dry) {
    return res.json({ dry: true, would_delete: target, protected: before,
      sample: db.all(`SELECT client_id, occurred_at, external_id, substr(body,1,60) body
                      FROM communications WHERE ${WHERE} ORDER BY occurred_at DESC LIMIT 5`),
      note: 'Pass {dry:false, confirm:<would_delete>} to run it.' })
  }
  if (Number(req.body?.confirm) !== target) {
    return res.status(409).json({ error: `confirm must equal the current count (${target}); it was ${req.body?.confirm}` })
  }
  db.run(`DELETE FROM communications WHERE ${WHERE}`)
  const after = {
    all_texts: g("SELECT COUNT(*) c FROM communications WHERE channel='text'"),
    twilio_texts: g("SELECT COUNT(*) c FROM communications WHERE channel='text' AND external_id LIKE 'twilio_%'"),
    readable_fub_texts: g(`SELECT COUNT(*) c FROM communications WHERE channel='text'
      AND external_id LIKE 'fub_text_%' AND body NOT LIKE '%hidden for privacy%'`),
    notes: g("SELECT COUNT(*) c FROM communications WHERE channel='note'"),
    calls: g("SELECT COUNT(*) c FROM communications WHERE channel IN ('call','voicemail')"),
    emails: g("SELECT COUNT(*) c FROM communications WHERE channel='email'"),
  }
  res.json({
    dry: false, deleted: target, before, after,
    // the only acceptable outcome: texts down by exactly the target, nothing else moved
    intact: before.twilio_texts === after.twilio_texts && before.notes === after.notes
      && before.calls === after.calls && before.emails === after.emails
      && before.readable_fub_texts === after.readable_fub_texts
      && (before.all_texts - after.all_texts) === target,
  })
})

// ── Is every bad number actually flagged? ────────────────────────────────────────────
// John, 2026-10-08: "all those bad numbers are flagged correct? so we don't use them ever
// again". Flagging only happens on the Twilio callback, and only for number-side codes,
// and only for sends made since that callback existed — so the honest answer needs the
// gap measured, not assumed. Read-only.
//
// Number-side = the number itself cannot receive our text: unreachable, unknown, landline,
// not-a-mobile. Deliberately NOT spam-filtering or A2P problems, which fail a perfectly
// good number for reasons that have nothing to do with the number.
router.get('/undeliverable-audit', requirePermission('settings.view'), (_req, res) => {
  const NUMBER_SIDE = `(error_message LIKE '%unreachable%' OR error_message LIKE '%non-existent%'
     OR error_message LIKE '%Landline%' OR error_message LIKE '%not a valid mobile%')`
  const g = (sql, p = []) => { try { return (db.get(sql, p) || {}).c || 0 } catch { return 0 } }
  const failBase = `FROM communications WHERE channel='text' AND direction='outgoing'
    AND delivery_status IN ('failed','undelivered') AND client_id IS NOT NULL`

  const leadsWithNumberSideFail = g(`SELECT COUNT(DISTINCT client_id) c ${failBase} AND ${NUMBER_SIDE}`)
  const flagged = g('SELECT COUNT(*) c FROM clients WHERE COALESCE(sms_undeliverable,0)=1')
  // the gap that matters: a lead whose number bounced but who is NOT flagged, so the
  // next automation will text them again
  const missed = db.all(`SELECT c.id, c.first_name, c.last_name, c.phone, c.status,
      MAX(m.occurred_at) last_fail, MAX(m.error_message) reason, COUNT(*) fails
    FROM communications m JOIN clients c ON c.id = m.client_id
    WHERE m.channel='text' AND m.direction='outgoing'
      AND m.delivery_status IN ('failed','undelivered') AND ${NUMBER_SIDE}
      AND COALESCE(c.sms_undeliverable,0)=0 AND c.merged_into IS NULL
    GROUP BY c.id ORDER BY fails DESC, last_fail DESC`)

  res.json({
    leads_with_number_side_failure: leadsWithNumberSideFail,
    leads_flagged_undeliverable: flagged,
    not_flagged: missed.length,
    // these are the ones an automation would text again tomorrow
    sample: missed.slice(0, 20),
    by_reason: db.all(`SELECT error_message reason, COUNT(DISTINCT client_id) leads
      ${failBase} AND ${NUMBER_SIDE} GROUP BY reason ORDER BY leads DESC`),
    note: 'Spam-filtered and A2P failures are excluded on purpose: those fail a good number.',
  })
})

// ── Text delivery across everything the Hub has sent ─────────────────────────────────
// John, 2026-10-08: would we know if a text is filtered as spam or blocked? Yes — Twilio
// reports 30007 and 30004 and the callback already stores the reason. This counts them,
// so "would we know" has a number rather than a yes. Read-only.
router.get('/text-delivery', requirePermission('settings.view'), (req, res) => {
  const since = /^\d{4}-\d{2}-\d{2}/.test(String(req.query.since || ''))
    ? String(req.query.since).slice(0, 10) + 'T00:00:00' : null
  const w = since ? ' AND occurred_at >= ?' : ''
  const p = since ? [since] : []
  const base = `FROM communications WHERE channel='text' AND direction='outgoing' AND external_id LIKE 'twilio_%'${w}`
  const g = (sql, extra = []) => { try { return (db.get(sql, [...p, ...extra]) || {}).c || 0 } catch { return 0 } }
  const total = g(`SELECT COUNT(*) c ${base}`)
  res.json({
    since, total_sent: total,
    // NOT aliased `status`: communications HAS a status column (read/unread), and SQLite
    // binds GROUP BY to the real column before the output alias — which silently grouped
    // every text into two buckets, both labelled "delivered".
    by_status: db.all(`SELECT COALESCE(NULLIF(delivery_status,''),'(no receipt)') delivery, COUNT(*) n ${base} GROUP BY delivery ORDER BY n DESC`, p),
    failures_by_reason: db.all(`SELECT COALESCE(error_message,'(no reason given)') reason, COUNT(*) n
      ${base} AND delivery_status IN ('failed','undelivered') GROUP BY reason ORDER BY n DESC`, p),
    spam_or_blocked: g(`SELECT COUNT(*) c ${base} AND (error_message LIKE '%spam%' OR error_message LIKE '%blocked%')`),
    recent_failures: db.all(`SELECT c.first_name, c.last_name, m.to_addr, m.occurred_at, m.delivery_status, m.error_message
      FROM communications m LEFT JOIN clients c ON c.id = m.client_id
      WHERE m.channel='text' AND m.direction='outgoing' AND m.delivery_status IN ('failed','undelivered')${w ? ' AND m.occurred_at >= ?' : ''}
      ORDER BY m.occurred_at DESC LIMIT 15`, p),
    note: 'A carrier can also accept a message and silently drop it; that still reports as delivered. 30007/30004 are the cases a carrier admits to.',
  })
})

// ── Do any FUB NOTES carry text-message content? ─────────────────────────────────────
// John, 2026-10-07: the texts came over "from FUB as notes", converted to show as texts.
// The /textMessages endpoint withholds bodies, but /notes does not — so if an integration
// logged a conversation INTO a note, the words are already in the Hub under channel
// 'note'. This looks for that rather than assuming it either way. Read-only.
router.get('/fub-notes-with-text', requirePermission('settings.view'), (req, res) => {
  const base = "FROM communications WHERE channel='note' AND external_id LIKE 'fub_note_%'"
  const g = (sql, p = []) => { try { return (db.get(sql, p) || {}).c || 0 } catch { return 0 } }
  const total = g(`SELECT COUNT(*) c ${base}`)
  // phrases an integration uses when it writes a conversation into a note
  const PATTERNS = [
    ['sent a text', "body LIKE '%sent a text%'"],
    ['text message', "body LIKE '%text message%'"],
    ['texted', "body LIKE '%texted%'"],
    ['sms', "body LIKE '%SMS%'"],
    ['incoming/outgoing text', "body LIKE '%ncoming text%' OR body LIKE '%utgoing text%'"],
    ['reply from lead', "body LIKE '%replied%'"],
  ]
  const hits = {}
  for (const [label, where] of PATTERNS) hits[label] = g(`SELECT COUNT(*) c ${base} AND (${where})`)
  res.json({
    total_fub_notes: total,
    matches: hits,
    // which systems write FUB notes at all — the likely source of any transcript
    by_source: db.all(`SELECT COALESCE(disposition,'(none)') note_source, COUNT(*) n ${base} GROUP BY note_source ORDER BY n DESC`),
    samples: db.all(`SELECT client_id, occurred_at, COALESCE(disposition,'') source, substr(body,1,220) body
      ${base} AND (body LIKE '%sent a text%' OR body LIKE '%text message%' OR body LIKE '%texted%')
      ORDER BY occurred_at DESC LIMIT 12`),
    // How much of the hidden-text problem these notes could actually close. The SMS
    // assistants wrote their messages into notes; everything else is alerts and email
    // copies, so only these are convertible.
    recoverable: (() => {
      const SMS_SOURCES = "disposition IN ('Structurely','CallAction.co')"
      const notes = g(`SELECT COUNT(*) c ${base} AND ${SMS_SOURCES}`)
      const leads = g(`SELECT COUNT(DISTINCT client_id) c ${base} AND ${SMS_SOURCES} AND client_id IS NOT NULL`)
      // a note is only worth converting if it is the message itself, not a status line
      const real = g(`SELECT COUNT(*) c ${base} AND disposition='Structurely'
                      AND body NOT LIKE '%View & Respond%' AND length(body) > 25`)
      const leadsWithHidden = g(`SELECT COUNT(DISTINCT n.client_id) c
        FROM communications n WHERE n.channel='note' AND n.external_id LIKE 'fub_note_%'
          AND ${SMS_SOURCES} AND n.client_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM communications t WHERE t.client_id = n.client_id
                      AND t.channel='text' AND t.body LIKE '%hidden for privacy%')`)
      return { sms_assistant_notes: notes, leads, structurely_real_messages: real,
               leads_that_also_have_hidden_texts: leadsWithHidden }
    })(),
    // ?source= reads one system's notes directly. Structurely and CallAction are SMS
    // assistants, so their notes are the likeliest place a real conversation was written.
    from_source: req.query.source
      ? db.all(`SELECT client_id, occurred_at, substr(body,1,700) body ${base} AND disposition = ?
                ORDER BY occurred_at DESC LIMIT ?`,
          [String(req.query.source), Math.min(Number(req.query.limit) || 8, 40)])
      : undefined,
  })
})

// ── Imported FUB texts: how many arrived with their body withheld ────────────────────
// John, 2026-10-07: "it actually worked before". This answers that from the data rather
// than from memory — if readable rows and hidden rows were imported on the same days, it
// never worked for these leads and nothing changed. Read-only.
router.get('/fub-text-privacy', requirePermission('settings.view'), (_req, res) => {
  const H = "body LIKE '%hidden for privacy%'"
  const g = (sql, p = []) => { try { return (db.get(sql, p) || {}).c || 0 } catch { return 0 } }
  const base = "FROM communications WHERE channel='text' AND external_id LIKE 'fub_%'"
  const total = g(`SELECT COUNT(*) c ${base}`)
  const hidden = g(`SELECT COUNT(*) c ${base} AND ${H}`)
  const rows = db.all(`SELECT substr(occurred_at,1,7) ym,
      SUM(CASE WHEN ${H} THEN 1 ELSE 0 END) hidden, COUNT(*) total
    ${base} GROUP BY ym ORDER BY ym`)
  // whether a lead is all-hidden or mixed says whether this is per-lead or per-message
  const perLead = db.all(`SELECT client_id,
      SUM(CASE WHEN ${H} THEN 1 ELSE 0 END) hidden, COUNT(*) total
    ${base} AND client_id IS NOT NULL GROUP BY client_id`)
  const allHidden = perLead.filter(r => r.hidden === r.total).length
  const noneHidden = perLead.filter(r => r.hidden === 0).length
  res.json({
    total_fub_texts: total, hidden, readable: total - hidden,
    leads_with_fub_texts: perLead.length,
    leads_all_hidden: allHidden, leads_none_hidden: noneHidden,
    leads_mixed: perLead.length - allHidden - noneHidden,
    by_message_month: rows,
    // the import date matters more than the message date for "did it change"
    imported_readable_sample: db.all(`SELECT client_id, occurred_at, substr(body,1,50) body
      ${base} AND NOT ${H} ORDER BY occurred_at DESC LIMIT 8`),
  })
})

// ── Profile notes: how many predate the rule that every note carries a date ──────────
// Read-only. A note written before 2026-10-05 may have no stamp, and there is no honest
// way to recover a date after the fact, so this counts them and shows a sample rather
// than quietly filling them in with today (John, 2026-10-05).
router.get('/notes-audit', requirePermission('settings.view'), (req, res) => {
  const rows = db.all("SELECT id, first_name, last_name, notes, created_at FROM clients WHERE notes IS NOT NULL AND trim(notes) <> ''")
  let dated = 0, undated = 0, clientsWithUndated = 0
  const byStampShape = {}
  const sample = []
  for (const c of rows) {
    const items = splitNotes(c.notes)
    let mine = 0
    for (const n of items) {
      if (n.stamp) {
        dated++
        // which of the four historical formats wrote it
        const shape = /^\d{4}-\d{2}-\d{2}/.test(n.stamp) ? 'lead intake (2026-10-05)'
          : /^\d{1,2}\/\d{1,2}\/\d{4}/.test(n.stamp) ? 'master file (10/5/2026)'
          : /automation/i.test(n.stamp) ? 'automation'
          : /\d:\d{2}/.test(n.stamp) ? 'profile (Oct 5, 2026, 3:04 PM)'
          : 'other'
        byStampShape[shape] = (byStampShape[shape] || 0) + 1
      } else {
        undated++; mine++
        if (sample.length < 25) sample.push({
          client_id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          created_at: c.created_at, line: n.index, text: n.text.slice(0, 160),
        })
      }
    }
    if (mine) clientsWithUndated++
  }
  res.json({
    clients_with_notes: rows.length, total_notes: dated + undated,
    dated, undated, clients_with_undated: clientsWithUndated,
    by_stamp_shape: byStampShape, sample,
  })
})

// Give the remaining undated notes a date we actually know.
//
// After continuation lines were folded into their notes, 23 undated notes were left and
// nearly all came from one line: lead-intake's INSERT wrote a brand new lead's intake note
// without a stamp. For those the date is not a guess - the note WAS the lead's creation,
// so created_at is exactly when it was written.
//
// A note that is not intake-shaped was typed later by a person, and created_at is only a
// lower bound, so it is labelled as such rather than dated precisely. Dry by default.
// Only the note shapes lead-intake and the form handlers actually write. A bare portal
// name ("Realtor") is somebody's own note, not an intake line, and claiming an exact date
// for it would be asserting something we do not know.
const INTAKE_NOTE = /^(facebook (listing|seller) ad lead|[a-z.]+ inquiry|answered form )/i

router.post('/notes-backfill', requirePermission('settings.edit'), (req, res) => {
  const dry = req.body?.dry !== false
  const rows = db.all("SELECT id, first_name, last_name, notes, created_at FROM clients WHERE notes IS NOT NULL AND trim(notes) <> ''")
  const changes = []
  for (const c of rows) {
    const items = splitNotes(c.notes)
    const undated = items.filter(n => !n.stamp)
    if (!undated.length) continue
    const lines = String(c.notes).split('\n')
    for (const n of undated) {
      const exact = INTAKE_NOTE.test(n.text.trim())
      const stamp = exact ? stampFor(c.created_at) : `added some time after ${stampFor(c.created_at)}`
      lines[n.index] = `[${stamp}] ${lines[n.index]}`
      changes.push({ client_id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        exact, stamp, text: n.text.split('\n')[0].slice(0, 90) })
    }
    if (!dry) db.run('UPDATE clients SET notes = ? WHERE id = ?', [lines.join('\n'), c.id])
  }
  res.json({ dry, would_stamp: changes.length,
    exact: changes.filter(c => c.exact).length,
    approximate: changes.filter(c => !c.exact).length, changes })
})

// P2-6: one-glance system health — every integration, the sync queue, and recent errors.
router.get('/integrations', requirePermission('settings.view'), (_req, res) => {
  try {
    const setting = (k) => db.getSetting?.(k) || null
    const lastSync = db.get("SELECT synced_at, sync_type, leads_synced FROM sierra_sync_log WHERE errors IS NULL OR errors='' ORDER BY synced_at DESC LIMIT 1")
    const lastErr = db.get("SELECT synced_at, errors FROM sierra_sync_log WHERE errors IS NOT NULL AND errors!='' ORDER BY synced_at DESC LIMIT 1")
    const ageMin = (ts) => ts ? Math.round((Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime()) / 60000) : null
    const status = (ok, detail) => ({ ok, detail })
    const twilio = !!(process.env.TWILIO_ACCOUNT_SID || setting('twilio_account_sid'))
    const sendgrid = !!(process.env.SENDGRID_API_KEY || setting('sendgrid_api_key'))
    const anthropic = !!process.env.ANTHROPIC_API_KEY
    const gdrive = !!setting('google_drive_refresh_token')
    const push = (() => { try { return db.get('SELECT COUNT(*) n FROM push_subscriptions').n } catch { return 0 } })()
    res.json({
      integrations: {
        sierra: status(!!lastSync, lastSync ? `last sync ${ageMin(lastSync.synced_at)} min ago (${lastSync.leads_synced} leads)` : 'no successful sync logged'),
        twilio: status(twilio, twilio ? 'configured' : 'not configured'),
        sendgrid: status(sendgrid, sendgrid ? 'configured' : 'not configured'),
        anthropic_ai: status(anthropic, anthropic ? 'key present' : 'no API key'),
        google_drive_backup: status(gdrive, gdrive ? 'connected' : 'not connected'),
        web_push: status(true, `${push} device${push === 1 ? '' : 's'} subscribed`),
        disk: (() => { try {
          const st = fsSync.statfsSync(process.env.DB_DIR || '.')
          const freeGb = (st.bavail * st.bsize) / 1073741824
          const totGb = (st.blocks * st.bsize) / 1073741824
          const pct = Math.round(((totGb - freeGb) / totGb) * 100)
          return status(pct < 80, `${(totGb - freeGb).toFixed(1)} / ${totGb.toFixed(1)} GB used (${pct}%)${pct >= 80 ? ' — CLEAN UP: /api/admin/disk/cleanup' : ''}`)
        } catch (e) { return status(true, 'unavailable: ' + e.message) } })(),
      },
      sync: {
        last_success: lastSync?.synced_at || null,
        last_success_age_min: ageMin(lastSync?.synced_at),
        last_error: lastErr ? { at: lastErr.synced_at, message: String(lastErr.errors).slice(0, 200) } : null,
      },
      queues: {
        scheduled_texts_pending: (() => { try { return db.get("SELECT COUNT(*) n FROM scheduled_texts WHERE status='pending'").n } catch { return 0 } })(),
        ai_actions_due: (() => { try { return db.get("SELECT COUNT(*) n FROM ai_lead_state WHERE ai_next_action_at IS NOT NULL AND ai_next_action_at <= datetime('now')").n } catch { return 0 } })(),
        open_handoffs: (() => { try { return db.get("SELECT COUNT(*) n FROM ai_handoffs WHERE status='open'").n } catch { return 0 } })(),
        unread_notifications: (() => { try { return db.get('SELECT COUNT(*) n FROM notifications WHERE read=0').n } catch { return 0 } })(),
      },
      open_failures: failureCounts(),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// One call for the admin System Health panel.
router.get('/health', requirePermission('settings.view'), async (_req, res) => {
  try {
    const { getBackupHealth } = await import('../backup.js')
    const { gdriveStatus } = await import('../gdrive-backup.js')
    res.json({ failures: failureCounts(), backup: getBackupHealth(), gdrive: gdriveStatus() })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Database diagnostics (integrity, size, journal mode, migrations, sync errors).
router.get('/db-health', requirePermission('settings.view'), async (_req, res) => {
  try { const { getDbHealth } = await import('../database.js'); res.json(getDbHealth()) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// P2-7: owner data export. Whitelisted data tables only — never app_settings / auth /
// push_subscriptions (which hold secrets/keys). Streams CSV so it opens in Excel/Sheets.
const EXPORTABLE = {
  clients: 'SELECT id, first_name, last_name, email, phone, type, status, source, agent_assigned, address, city, state, zip, lead_score, fsbo_status, tags, sierra_lead_id, created_at FROM clients WHERE merged_into IS NULL',
  transactions: 'SELECT * FROM transactions',
  tasks: 'SELECT id, title, description, priority, status, due_date, assigned_to, category, related_type, related_id, created_at FROM tasks',
  notes: 'SELECT id, title, content, related_type, related_id, created_at FROM notes',
  communications: 'SELECT id, channel, direction, client_id, contact_name, preview, occurred_at FROM communications',
}
router.get('/export/:table', requirePermission('settings.edit'), (req, res) => {
  const t = String(req.params.table || '').toLowerCase()
  const sql = EXPORTABLE[t]
  if (!sql) return res.status(400).json({ error: 'not exportable', allowed: Object.keys(EXPORTABLE) })
  let rows = []
  try { rows = db.all(sql + ' LIMIT 200000') } catch (e) { return res.status(500).json({ error: e.message }) }
  const cols = rows.length ? Object.keys(rows[0]) : []
  const esc = (v) => { let s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const csv = cols.join(',') + '\r\n' + rows.map(r => cols.map(c => esc(r[c])).join(',')).join('\r\n') + (rows.length ? '\r\n' : '')
  const stamp = new Date().toISOString().slice(0, 10)
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${t}-export-${stamp}.csv"`)
  import('../auth/audit.js').then(({ logAudit }) => logAudit({ action: 'data.exported', entity_type: t, req })).catch(() => {})
  res.send(csv)
})
router.get('/export', requirePermission('settings.view'), (_req, res) => res.json({ tables: Object.keys(EXPORTABLE), note: 'Secrets, auth, and push tables are never exported.' }))

// Disk usage + emergency cleanup (2026-09-21: /data filled up — 200MB DB x
// 10 pre-boot + 14 daily backups ≈ 5GB — and every write in the Hub started
// failing: transaction saves 500'd and logins bounced because the session
// INSERT silently failed).
router.get('/disk', requirePermission('settings.view'), async (_req, res) => {
  try {
    const fs = await import('fs'); const path = await import('path')
    const dir = process.env.DB_DIR || '.'
    const files = fs.readdirSync(dir).map(f => {
      try { const st = fs.statSync(path.join(dir, f)); return { name: f, mb: +(st.size / 1048576).toFixed(1), mtime: st.mtime.toISOString().slice(0, 16) } } catch { return { name: f, mb: 0 } }
    }).sort((a, b) => b.mb - a.mb)
    res.json({ dir, total_mb: +files.reduce((s2, f) => s2 + f.mb, 0).toFixed(1), files: files.slice(0, 40) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
// Deep disk analysis: recursive directory sizes + what's inside the DB itself
// (per-table bytes via SQLite's dbstat when available, row counts regardless).
router.get('/disk/analysis', requirePermission('settings.view'), async (_req, res) => {
  try {
    const fs = await import('fs'); const path = await import('path')
    const dir = process.env.DB_DIR || '.'
    const walk = (d, depth = 0) => {
      let total = 0; const items = []
      let names = []
      try { names = fs.readdirSync(d) } catch { return { total: 0, items: [] } }
      for (const f of names) {
        const fp = path.join(d, f)
        try {
          const st = fs.statSync(fp)
          if (st.isDirectory()) {
            const sub = walk(fp, depth + 1)
            total += sub.total
            items.push({ name: f + '/', mb: +(sub.total / 1048576).toFixed(1), children: depth < 1 ? sub.items.slice(0, 20) : undefined })
          } else { total += st.size; items.push({ name: f, mb: +(st.size / 1048576).toFixed(1), mtime: st.mtime.toISOString().slice(0, 16) }) }
        } catch {}
      }
      items.sort((a2, b2) => b2.mb - a2.mb)
      return { total, items }
    }
    const tree = walk(dir)
    // DB internals
    let tables = []
    try {
      tables = db.all(`SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC LIMIT 30`)
        .map(r => ({ name: r.name, mb: +(r.bytes / 1048576).toFixed(1) }))
    } catch {
      tables = db.all(`SELECT name FROM sqlite_master WHERE type = 'table'`).map(t => {
        try { return { name: t.name, rows: db.get(`SELECT COUNT(*) c FROM "${t.name}"`).c } } catch { return { name: t.name, rows: null } }
      }).sort((a2, b2) => (b2.rows || 0) - (a2.rows || 0)).slice(0, 30)
    }
    res.json({ dir, total_mb: +(tree.total / 1048576).toFixed(1), files: tree.items.slice(0, 25), db_tables: tables })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/disk/cleanup', requirePermission('settings.edit'), async (req, res) => {
  try {
    const { rotateBackups } = await import('../backup.js')
    const out = {
      preboot: rotateBackups('pre-boot', Number(req.query.keep_preboot) || 2),
      daily: rotateBackups('daily', Number(req.query.keep_daily) || 4),
      prerestore: rotateBackups('pre-restore', 1),
      hourly: rotateBackups('hourly', 2),
    }
    res.json(out)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Twilio message history for one number, straight from Twilio's records —
// finds texts sent before the Hub logged communications (pre-Hub blasts).
router.get('/twilio-history', requirePermission('settings.view'), async (req, res) => {
  try {
    const db2 = (await import('../database.js')).default
    const sid = (db2.getSetting('twilio_account_sid', '') || '').trim()
    const token = (db2.getSetting('twilio_auth_token', '') || '').trim()
    if (!sid || !token) return res.status(400).json({ error: 'Twilio not configured' })
    const d10 = String(req.query.to || '').replace(/\D/g, '').slice(-10)
    if (d10.length !== 10) return res.status(400).json({ error: 'to=phone required' })
    const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64')
    const out = []
    for (const dir of ['To', 'From']) {
      const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json?${dir}=%2B1${d10}&PageSize=200`, { headers: { Authorization: auth } })
      const j = await r.json().catch(() => ({}))
      for (const m of (j.messages || [])) out.push({ date: m.date_sent || m.date_created, direction: m.direction, status: m.status, from: m.from, to: m.to, body: String(m.body || '').slice(0, 300) })
    }
    out.sort((a, b) => new Date(a.date) - new Date(b.date))
    res.json({ phone: d10, count: out.length, messages: out })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Calendbook webhook URLs (shared key) — paste these into Calendbook's Webhook integration.
router.get('/calendbook-urls', requirePermission('settings.view'), async (_req, res) => {
  const { calendbookKey } = await import('../calendbook.js')
  const base = (process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com') + '/api/public/calendbook'
  const k = calendbookKey()
  res.json(Object.fromEntries(['booking', 'reschedule', 'cancellation', 'reminder'].map(x => [x, `${base}/${x}?key=${k}`])))
})

// New-lead default agent rule (also runs on every scheduler tick). ?dry=1 previews.
router.post('/assign-default-agent', requirePermission('settings.edit'), async (req, res) => {
  try {
    const { enforceDefaultAgentAssignment } = await import('../agent-assignment.js')
    res.json(enforceDefaultAgentAssignment({ dryRun: req.query.dry === '1' || req.query.dry === 'true' }))
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/failures', requirePermission('settings.view'), (req, res) => {
  res.json(listFailures({ state: req.query.state || 'open', limit: Number(req.query.limit) || 100 }))
})

router.post('/failures/:id/resolve', requirePermission('settings.edit'), (req, res) => {
  const r = resolveFailure(Number(req.params.id))
  import('../auth/audit.js').then(({ logAudit }) => logAudit({ action: 'failure.resolved', entity_type: 'failed_job', entity_id: req.params.id, req })).catch(() => {})
  res.json(r)
})

router.post('/failures/resolve-all', requirePermission('settings.edit'), (req, res) => {
  const r = resolveAll(req.body?.kind || null)
  import('../auth/audit.js').then(({ logAudit }) => logAudit({ action: 'failure.resolved_all', metadata: { kind: req.body?.kind || 'all' }, req })).catch(() => {})
  res.json(r)
})

export default router
