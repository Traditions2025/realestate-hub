// HOW MANY EMAILS ONE LEAD MAY GET IN A WEEK (John, 2026-10-14).
//
// "No lead should be getting more than 2 emails in a week" — across EVERY campaign, not
// per campaign. A lead can sit in several drips at once plus get a manual listing blast,
// and nothing used to add those up. Measured over the 21 days to 2026-10-14: 138 people
// went over 2 in a rolling week, the worst at 6, from drip 20 + drip 2 + the two manual
// listing sends on 10-10.
//
// WHAT COUNTS: every email the Hub actually sent to that person in the trailing 7 days —
// drips, campaigns, automations AND manual one-off sends. The lead's inbox does not care
// which part of the Hub sent it, so neither does the count. Counting only drips would
// miss the biggest stacker we have, which is a manual blast landing on top of a drip.
//
// WHAT IS GATED: automated sends only. A manual email a person chose to send is never
// blocked — it still counts toward the next automated send, but a human deciding to
// write to somebody outranks a queue. Transactional replies are exempt outright
// (EXEMPT_TAGS): somebody who just asked for their home value gets the answer.
//
// WHY email_log AND NOT drip_executions: executions only know about drips. email_log is
// the one table that sees every send, which is the whole point of a cross-campaign cap.
//
// A capped send DEFERS, it never cancels — the touch keeps its place in the sequence and
// lands when the window clears. nextEligibleIso is computed from the data rather than
// "try again tomorrow", so a blocked enrollment does not re-check daily for a week and
// fill the log with noise.
import db from './database.js'

export const DEFAULT_WEEKLY_CAP = 2
export const DEFAULT_DAILY_CAP = 1
const WEEK_MS = 7 * 86400000

// PAST CLIENTS GET A QUIETER CAP (John, 2026-10-15: "for past clients strictly for drip
// campaigns only 1 email in 2 weeks").
//
// Both Lifelong Friends drips were already 30 days apart, so the cadence was never the
// problem. The problem is a past client sitting in SEVERAL campaigns at once: Lifelong
// Friends every 30 days is fine on its own, but add Home Value Weekly and they are getting
// something most weeks. A cadence cannot see across campaigns; a cap can.
const PAST_CLIENT_WINDOW_MS = 14 * 86400000
export const DEFAULT_PAST_CLIENT_CAP = 1
export function pastClientCap() {
  const n = Number(db.getSetting?.('max_emails_per_fortnight_past_client', String(DEFAULT_PAST_CLIENT_CAP)))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PAST_CLIENT_CAP
}

/** A past client by status or by tag, since the two do not always agree in this data. */
export function isPastClient(client) {
  if (!client) return false
  if (String(client.status || '').trim().toLowerCase() === 'closed') return true
  return /past client/i.test(String(client.tags || ''))
}

// Transactional, triggered and FIRST-CONTACT sends. These answer something the person
// just did, or are the first thing we ever say to them, so they are never held back and
// never counted against the cap. Somebody who asked for their home value gets the answer,
// and a brand new lead who just inquired gets a reply — a nurture queue does not outrank
// either. fb_ad_email is the Day-0 follow-up to a lead who did not answer the opener
// text, so it is still first contact, not nurture.
const EXEMPT_TAGS = new Set([
  'home_value_followup', 'Home Value Request', 'ai_handoff', 'fb_lead_alert', 'fb_ad_email',
])

const isTestTag = (t) => /^drip_test_/i.test(String(t || ''))

/** The cap, as a number. Settable without a deploy; a bad value falls back to the default. */
export function weeklyEmailCap() {
  const n = Number(db.getSetting?.('max_emails_per_week', String(DEFAULT_WEEKLY_CAP)))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_WEEKLY_CAP
}
export function dailyEmailCap() {
  const n = Number(db.getSetting?.('max_emails_per_day', String(DEFAULT_DAILY_CAP)))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_DAILY_CAP
}

/** True when this send is a transactional reply and so sits outside the cap entirely. */
export function isExemptTag(tag) { return EXEMPT_TAGS.has(String(tag || '')) }

/**
 * Every email that reached this lead in the trailing 7 days, newest first.
 *
 * Matched on client_id OR the same address, because duplicate records for one person are
 * common in this file and two records pointing at one inbox is still one inbox.
 *
 * Excluded: failed sends, bounces and drops (they never arrived), internal digests
 * (client_id IS NULL), test traffic, and the transactional tags above.
 */
export function recentLeadEmails(clientId, { sinceMs = Date.now() - WEEK_MS } = {}) {
  const cid = Number(clientId)
  if (!Number.isFinite(cid)) return []
  const since = new Date(sinceMs).toISOString()
  const c = db.get('SELECT email FROM clients WHERE id=?', [cid])
  const addr = String(c?.email || '').trim().toLowerCase()
  let rows = []
  try {
    rows = db.all(
      `SELECT id, client_id, to_email, template, subject, sent_at, status, delivery_status
         FROM email_log
        WHERE sent_at >= ?
          AND (client_id = ? ${addr ? 'OR lower(to_email) = ?' : ''})
          AND status = 'sent'
          AND (delivery_status IS NULL OR delivery_status NOT IN ('bounce','dropped'))
        ORDER BY sent_at DESC`,
      addr ? [since, cid, addr] : [since, cid])
  } catch { return [] }
  return rows.filter(r => r.client_id != null && !isTestTag(r.template) && !isExemptTag(r.template))
}

/**
 * Where this lead stands against both caps right now.
 *
 * nextEligibleIso: when the window will have room again. For the weekly cap that is the
 * moment the cap-th newest email ages out — send at T and the only emails still inside
 * the window are those after T-7d, so T = (the cap-th newest).sent_at + 7 days.
 */
export function emailCapState(clientId, { now = Date.now() } = {}) {
  const weekly = weeklyEmailCap()
  const daily = dailyEmailCap()
  const client = (() => { try { return db.get('SELECT id, status, tags FROM clients WHERE id=?', [Number(clientId)]) } catch { return null } })()
  const past = isPastClient(client)
  const pcCap = pastClientCap()

  // A past client's window is the longer of the two, so one query serves both counts.
  const windowMs = past ? Math.max(WEEK_MS, PAST_CLIENT_WINDOW_MS) : WEEK_MS
  const all = recentLeadEmails(clientId, { sinceMs: now - windowMs })
  const recent = all.filter(r => Date.parse(r.sent_at) >= now - WEEK_MS)
  const today = recent.filter(r => isSameChicagoDay(r.sent_at, now))
  const fortnight = past ? all.filter(r => Date.parse(r.sent_at) >= now - PAST_CLIENT_WINDOW_MS) : []

  const overWeek = recent.length >= weekly
  const overDay = today.length >= daily
  const overPast = past && fortnight.length >= pcCap

  let nextEligibleIso = null
  const bump = (iso) => { if (iso && (!nextEligibleIso || iso > nextEligibleIso)) nextEligibleIso = iso }
  if (overWeek) {
    const t = Date.parse(recent[weekly - 1]?.sent_at)   // recent is newest-first
    if (Number.isFinite(t)) bump(new Date(t + WEEK_MS).toISOString())
  }
  if (overPast) {
    const t = Date.parse(fortnight[pcCap - 1]?.sent_at)
    if (Number.isFinite(t)) bump(new Date(t + PAST_CLIENT_WINDOW_MS).toISOString())
  }
  if (overDay) bump(new Date(now + 86400000).toISOString())

  return {
    cap: weekly, daily_cap: daily,
    past_client: past, past_client_cap: past ? pcCap : null,
    count_week: recent.length, count_today: today.length,
    count_fortnight: past ? fortnight.length : null,
    capped: overWeek || overDay || overPast,
    reason: overPast
      ? `past client — already had ${fortnight.length} email${fortnight.length === 1 ? '' : 's'} in the last 14 days (cap ${pcCap})`
      : overWeek
        ? `already had ${recent.length} email${recent.length === 1 ? '' : 's'} in the last 7 days (cap ${weekly})`
        : overDay ? `already emailed today (cap ${daily}/day)` : null,
    next_eligible_at: nextEligibleIso,
    recent: recent.map(r => ({ sent_at: r.sent_at, template: r.template, subject: r.subject })),
  }
}

/** Convenience for a send path: null to go ahead, or the state when it must wait. */
export function emailCapBlock(clientId, tag) {
  if (isExemptTag(tag)) return null
  const s = emailCapState(clientId)
  return s.capped ? s : null
}

function isSameChicagoDay(iso, nowMs) {
  const d = (t) => {
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)
    } catch { return new Date(t).toISOString().slice(0, 10) }
  }
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return false
  return d(t) === d(nowMs)
}
