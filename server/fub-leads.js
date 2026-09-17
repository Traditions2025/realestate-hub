// FUB → Hub FACEBOOK-AD LEAD WATCHER. Facebook's lead ads deliver into FUB; this
// watches FUB's event stream (lead registrations/inquiries — NOT the people
// database) and ingests ONLY Facebook-ad events into the Hub, so the team gets
// the notification + instant AI first touch the FUB side never provides.
//
// HARD SCOPE RULES (the Hub must never mass-import FUB):
//   - reads /v1/events only — never walks /v1/people
//   - only events whose SOURCE matches the Facebook lead-ads integration
//   - only events with a lead-ish TYPE (registration / inquiry / lead)
//   - cursor starts at "now" on first run — zero historical import
//   - every candidate passes the shared intake dedupe (phone, then email), so an
//     ad fill from someone already in the Hub UPDATES their record (tag + note +
//     notification), never duplicates it
//   - ships DISABLED (fub_lead_watch_enabled, default '0'); preview first
import db from './database.js'
import { fubGet, fubConfigured } from './fub-helper.js'
import { ingestFbLead } from './lead-intake.js'

const nowIso = () => new Date().toISOString()
const FB_SOURCE_RE = /facebook|instagram lead/i
const LEAD_TYPE_RE = /registration|inquiry|lead/i

function looksLikeAdEvent(e) {
  return FB_SOURCE_RE.test(String(e.source || '')) && LEAD_TYPE_RE.test(String(e.type || ''))
}

function extractLead(e) {
  const p = e.person || {}
  const msg = String(e.message || '')
  // The registration note carries the form answers line by line (real format from
  // the 510 Broadway campaign):
  //   "User provided phone number: +13192703089"
  //   "What is your time frame to buy?: 1-3_months"
  //   "Are you working with a lender?: yes"
  //   "Form: 510 Broadway Springville"
  const line = (re) => { const m = msg.match(re); return m ? String(m[1]).trim() : '' }
  const phone = line(/user provided phone number:\s*([+\d()\-. ]{7,})/i)
    || (Array.isArray(p.phones) && p.phones[0] && p.phones[0].value) || p.phone || ''
  const email = (Array.isArray(p.emails) && p.emails[0] && p.emails[0].value) || p.email || ''
  const first = p.firstName || String(p.name || '').split(/\s+/)[0] || ''
  const last = p.lastName || String(p.name || '').split(/\s+/).slice(1).join(' ') || ''
  const c = e.campaign || {}
  const listing = line(/^form:\s*(.+)$/im) || line(/^ad campaign:\s*(.+)$/im)
    || c.campaign || c.content || c.term || String(e.description || '').slice(0, 80) || ''
  const timeline = (line(/time ?frame to (?:buy|sell|move)\??:?\s*([\w\-+ ]{2,30})/i)
    || (msg.match(/(0-3|1-3|3-6|6-12)\s*_?months|just curious[^.\n]*/i) || [''])[0]).replace(/_/g, ' ')
  const lender = line(/working with a lender\??:?\s*(yes|no)/i)
  return { first, last, email, phone, listing: String(listing).slice(0, 80),
    timeline: (timeline + (lender ? ` (lender: ${lender})` : '')).trim() }
}

// FUB's /events LIST returns slim rows — the registration message and person live
// on the event DETAIL (and the person record). Hydrate each matching event.
async function hydrate(e) {
  let full = e
  if (!e.message || !e.person) {
    try { full = { ...e, ...(await fubGet(`/events/${e.id}`)) } } catch {}
  }
  if (!full.person && (full.personId || e.personId)) {
    try { full.person = await fubGet(`/people/${full.personId || e.personId}`) } catch {}
  }
  return full
}

// ---------------------------------------------------------------------------
// EMAIL TRIGGER (primary, per John 2026-09-17): FUB's lead-notification emails to
// Matt's inbox are the signal. The Gmail poller hands every leads@followupboss.com
// email here. Facebook ones only:
//   "New Lead from Facebook - <name>"   → pull the lead into the Hub (create,
//        tag, notify, AI first text via the fresh lane)
//   "Lead Alert from Facebook - <name>" → existing person re-registered: tag +
//        note + notification ONLY (no new record, no auto-AI)
// Hot Sheet digests and other sources (Zillow etc) are ignored. Idempotent by
// Message-ID; gated by fub_lead_email_enabled (ships OFF).
export function parseFubLeadEmail(subject, text) {
  const subj = String(subject || '')
  const body = String(text || '')
  const isFacebook = /from facebook/i.test(subj) || /named [^\n]{2,60} from facebook|alert for [^\n]{2,60} from facebook/i.test(body)
  const isNew = /^new lead from/i.test(subj.trim())
  const isAlert = /lead alert/i.test(subj)
  if (!isFacebook || (!isNew && !isAlert)) return null
  // subject: "New Lead from Facebook - Rich Gholston" / "Lead Alert from Facebook - Steven Franklin - $499,000"
  const parts = subj.split(' - ').map(s => s.trim())
  let name = parts[1] || ''
  if (/^\$[\d,]+/.test(name)) name = parts[2] || ''
  const nm = name.split(/\s+/)
  const line = (re) => { const m = body.match(re); return m ? String(m[1]).trim() : '' }
  const phone = line(/user provided phone number:\s*([+\d()\-. ]{7,})/i) || line(/(\(\d{3}\)\s*\d{3}-\d{4})/)
  const email = line(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/) || null
  const timeline = (line(/time ?frame to (?:buy|sell|move)\??:?\s*([\w\-+ ]{2,30})/i) || '').replace(/_/g, ' ').trim()
  const lender = line(/working with a lender\??:?\s*(yes|no)/i)
  const listing = line(/^form:\s*(.+)$/im) || line(/^ad(?: campaign)?:\s*(.+)$/im) || ''
  return {
    kind: isNew ? 'new' : 'alert',
    first: nm[0] || '', last: nm.slice(1).join(' ') || '',
    phone, email, listing: String(listing).slice(0, 80),
    timeline: (timeline + (lender ? ` (lender: ${lender})` : '')).trim(),
  }
}

export async function handleFubLeadEmail(parsedMail) {
  if (db.getSetting('fub_lead_email_enabled', '0') !== '1') return { skipped: 'disabled' }
  const html = String(parsedMail.html || '')
  const lead = parseFubLeadEmail(parsedMail.subject, String(parsedMail.text || html.replace(/<[^>]+>/g, ' ')))
  if (!lead) return { skipped: 'not a Facebook lead email' }
  // The FUB email carries machine-readable meta tags — prefer them over text parsing.
  // NOTE: the meta source can disagree with a Facebook subject (Christi Masters'
  // alert said "from Facebook" in the subject but meta source "mattsmithteam.com").
  // The SUBJECT is authoritative for the Facebook check — meta never vetoes it.
  const meta = (n) => { const m = html.match(new RegExp(`<meta name="lead_${n}" content="([^"]*)"`, 'i')); return m ? m[1].trim() : '' }
  const mName = meta('name'); if (mName) { const nm = mName.split(/\s+/); lead.first = nm[0] || lead.first; lead.last = nm.slice(1).join(' ') || lead.last }
  if (meta('phone')) lead.phone = meta('phone')
  if (meta('email')) lead.email = meta('email')
  const msgId = String(parsedMail.messageId || '').slice(0, 120)
  if (msgId && db.get('SELECT id FROM activity_log WHERE details LIKE ?', ['%[fub_email:' + msgId + ']%'])) return { skipped: 'already processed' }
  const r = ingestFbLead({ ...lead, marker: msgId ? `[fub_email:${msgId}]` : '' })
  return { processed: lead.kind, ...r }
}

// Poll the stream. dryRun: report what WOULD be ingested, write nothing, move no cursor.
export async function pollFubAdLeads({ dryRun = false, sinceIso = null, limit = 100, raw = false } = {}) {
  if (!fubConfigured()) return { skipped: 'FUB not configured' }
  if (!dryRun && db.getSetting('fub_lead_watch_enabled', '0') !== '1') return { skipped: 'watcher disabled (fub_lead_watch_enabled)' }
  let cursor = sinceIso || db.getSetting('fub_events_cursor', '')
  if (!cursor) {
    if (!dryRun) { db.setSetting('fub_events_cursor', nowIso()); return { initialized: nowIso(), note: 'cursor set to now — only NEW ad leads from here on' } }
    cursor = new Date(Date.now() - 48 * 3600e3).toISOString()   // preview window: last 48h
  }
  const j = await fubGet('/events', { limit })
  const events = j.events || []
  const out = { dry_run: dryRun, cursor, checked: events.length, fb_ad_events: 0, ingested: 0, matched_existing: 0, would_ingest: [] }
  let maxCreated = cursor
  // events come newest-first; process oldest-first so the cursor advances safely
  for (const e of [...events].reverse()) {
    const created = String(e.created || '')
    if (!(created > cursor)) continue
    if (created > maxCreated) maxCreated = created
    if (!looksLikeAdEvent(e)) continue
    out.fb_ad_events++
    const full = await hydrate(e)
    if (raw && out.would_ingest.length < 2) { out.would_ingest.push({ RAW: JSON.stringify(full).slice(0, 1800) }); continue }
    const L = extractLead(full)
    if (dryRun) { out.would_ingest.push({ created, type: e.type, source: e.source, ...L }); continue }
    const markerLike = `%[fub_event:${e.id}]%`
    if (db.get('SELECT id FROM activity_log WHERE details LIKE ?', [markerLike])) continue   // already ingested
    const r = ingestFbLead({ ...L, marker: `[fub_event:${e.id}]` })
    out.ingested++
    if (r.matched_existing) out.matched_existing++
  }
  if (!dryRun && maxCreated > cursor) db.setSetting('fub_events_cursor', maxCreated)
  return out
}
