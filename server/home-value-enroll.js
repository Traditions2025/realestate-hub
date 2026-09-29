// Home Value Weekly — automatic enrollment.
//
// Feeds the 6-month homeowner drip at a controlled rate instead of all at once. The Hub
// has sent ~10,000 emails in its whole life; this campaign is ~583,000 across six months,
// so the rate is the point, not a detail. Default 200 a day.
//
// OFF BY DEFAULT. Nothing enrolls until home_value_enroll_enabled is set to 1.
//
// Who qualifies (John, 2026-09-29):
//   - a real street address on file (not a PO box, not "None" — usableStreet decides)
//   - status NOT active / pending / junk / donotcontact  (case-insensitive: the data
//     contains both "junk" and "Junk")
//   - NOT an FSBO or an Expired/Cancelled lead — those have their own campaigns
//   - a real email, not opted out, and email_status is ValidAddress, TwoWayEmailing or
//     Unknown. WrongAddress is 8,455 of the file and is excluded outright.
//   - not already in this drip, ever
//   - has not already used the home value tool (they go to a conversation, not a drip)
//
// And one pacing rule: never enrol somebody who already has another campaign email
// landing the same day. Two emails from the same team in one day is how a warm contact
// becomes an unsubscribe.
import db from './database.js'
import { usableStreet, usableFirstName } from './routes/email.js'

const nowIso = () => new Date().toISOString()
export const HOME_VALUE_TAG = 'cedarrapidsmetroareahomevalue.sierrasellersites.com'
const CAMPAIGN_NAME = 'Home Value Weekly — 6 Month'

const EXCLUDED_STATUS = new Set(['active', 'pending', 'junk', 'donotcontact'])
const ALLOWED_EMAIL_STATUS = new Set(['validaddress', 'twowayemailing', 'unknown'])

export function homeValueConfig() {
  return {
    enabled: String(db.getSetting?.('home_value_enroll_enabled', '0')) === '1',
    daily_limit: Math.max(1, Number(db.getSetting?.('home_value_enroll_daily_limit', '200')) || 200),
  }
}

export function homeValueDrip() {
  return db.get('SELECT id, steps FROM drip_campaigns WHERE name = ?', [CAMPAIGN_NAME])
}

// Chicago calendar day for a timestamp — the collision check is about the DAY a person
// receives something, which is their day, not UTC's.
const chDay = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(d))

// One reason string, or null when the lead qualifies. Kept as a single function so the
// preview and the live tick can never disagree about who is eligible.
export function homeValueEligibility(c, ctx = {}) {
  const status = String(c.status || '').trim().toLowerCase()
  if (EXCLUDED_STATUS.has(status)) return `status is ${c.status}`
  if (!usableStreet(c.address)) return 'no usable street address'
  // A greeting is the first thing they read, so a record whose name is an email address,
  // a placeholder or import junk is left out rather than greeted as "Hi None,". 1,136
  // records in the file hold an email in first_name.
  if (!usableFirstName(c.first_name)) return 'no usable first name'

  const blob = `${c.tags || ''} ${c.source || ''}`.toLowerCase()
  if (c.fsbo_status || /fsbo/.test(blob)) return 'FSBO lead'
  if (c.mls_status || /expired|cancell?ed|withdrawn/.test(blob)) return 'Expired/Cancelled lead'

  const email = String(c.email || '').trim()
  if (!email || /notvalidemail/i.test(email)) return 'no real email'
  if (c.marketing_email_opt_out) return 'opted out of marketing email'
  const es = String(c.email_status || '').trim().toLowerCase()
  if (!ALLOWED_EMAIL_STATUS.has(es)) return `email status ${c.email_status || '(blank)'}`

  // Recent lookups only (John, 2026-09-29). Someone who checked their value last week
  // should not get an email asking them to check their value; someone who checked a year
  // ago is a fair person to ask again. 30 days is the line.
  if (ctx.recentLookup?.has(c.id)) return 'checked their home value in the last 30 days'

  // PAST CLIENTS (John, 2026-09-29). A Closed lead qualifies ONLY if they are already in
  // a Lifelong Friends past-client nurture. That list was hand-picked to leave out anyone
  // who transacted recently, so it carries a judgement the Hub cannot make for itself:
  // nothing in the data says when somebody last bought or sold. A past client who was
  // never put through that selection is left alone; John adds those by hand.
  if (String(c.status || '').trim().toLowerCase() === 'closed' && !ctx.inPastDrip?.has(c.id))
    return 'past client not in a Lifelong Friends nurture'

  // Named exclusions — people the team is actively working with. The data cannot know
  // this (a listing being prepared, a valuation visit last week); a person does.
  if (ctx.excludedIds?.has(c.id)) return 'manually excluded'
  if (ctx.enrolledIds?.has(c.id)) return 'already in this campaign'
  if (ctx.busyToday?.has(c.id)) return 'another campaign email lands today'   // send-time guard is the real one
  return null
}

// Everything the eligibility check needs that is not on the client row.
function buildContext(dripId) {
  const enrolledIds = new Set(db.all('SELECT client_id FROM drip_enrollments WHERE drip_id = ?', [dripId]).map(r => r.client_id))
  const today = chDay(Date.now())
  const busyToday = new Set(
    db.all("SELECT client_id, next_run_at FROM drip_enrollments WHERE status='active' AND next_run_at IS NOT NULL")
      .filter(r => chDay(r.next_run_at) === today).map(r => r.client_id))
  // Anyone who has used the home value tool in the last 30 days. Recorded by the intake,
  // which reads the Sierra notification emails, so it covers lookups the Hub never saw.
  const recentLookup = new Set(
    db.all(`SELECT entity_id FROM activity_log
             WHERE action = 'home_value_submission' AND entity_type = 'client'
               AND created_at >= datetime('now', '-30 days')`).map(r => r.entity_id))
  const pastDripIds = db.all("SELECT id FROM drip_campaigns WHERE name LIKE 'Lifelong Friends%'").map(r => r.id)
  const inPastDrip = new Set(pastDripIds.length
    ? db.all(`SELECT DISTINCT client_id FROM drip_enrollments WHERE status='active' AND drip_id IN (${pastDripIds.map(() => '?').join(',')})`, pastDripIds).map(r => r.client_id)
    : [])
  const excludedIds = new Set(String(db.getSetting?.('home_value_excluded_ids', '') || '')
    .split(',').map(s => Number(String(s).trim())).filter(Boolean))
  return { enrolledIds, busyToday, recentLookup, inPastDrip, excludedIds }
}

const enrolledToday = (dripId) => db.get(
  "SELECT COUNT(*) c FROM drip_enrollments WHERE drip_id=? AND date(entered_at) = date('now')", [dripId]).c

// A look at who would go next, and why the rest would not. Sends nothing.
export function homeValuePreview({ limit = 25 } = {}) {
  const drip = homeValueDrip()
  if (!drip) return { error: `campaign "${CAMPAIGN_NAME}" not found` }
  const ctx = buildContext(drip.id)
  const rows = db.all("SELECT * FROM clients WHERE merged_into IS NULL AND address IS NOT NULL AND address != '' ORDER BY id")
  const eligible = [], reasons = {}
  for (const c of rows) {
    const why = homeValueEligibility(c, ctx)
    if (why) { reasons[why] = (reasons[why] || 0) + 1; continue }
    eligible.push(c)
  }
  const cfg = homeValueConfig()
  // Breakdown computed over ALL eligible rows, never over the sample: the sample is
  // capped and counting from it silently understates by however much the cap cut off.
  const byStatus = {}
  eligible.forEach(c => { const k = String(c.status || '(blank)'); byStatus[k] = (byStatus[k] || 0) + 1 })
  // Membership of an active past-client drip, straight from the table rather than the
  // /activity endpoint, which returns at most 500 rows.
  const pastDripIds = db.all("SELECT id FROM drip_campaigns WHERE name LIKE 'Lifelong Friends%'").map(r => r.id)
  const inPastDrip = new Set(pastDripIds.length
    ? db.all(`SELECT DISTINCT client_id FROM drip_enrollments WHERE status='active' AND drip_id IN (${pastDripIds.map(() => '?').join(',')})`, pastDripIds).map(r => r.client_id)
    : [])
  const closedEligible = eligible.filter(c => String(c.status || '').toLowerCase() === 'closed')
  return {
    campaign: CAMPAIGN_NAME, drip_id: drip.id, ...cfg,
    enrolled_today: enrolledToday(drip.id),
    eligible_total: eligible.length,
    eligible_by_status: Object.fromEntries(Object.entries(byStatus).sort((a, b) => b[1] - a[1])),
    past_client_drips: pastDripIds,
    in_active_past_drip: inPastDrip.size,
    closed_eligible: closedEligible.length,
    closed_eligible_in_past_drip: closedEligible.filter(c => inPastDrip.has(c.id)).length,
    // WHY the rest are not in one. "Not in a past-client drip" is not the same as
    // "transacted recently", and the difference decides whether excluding them is right.
    closed_not_in_past_drip_why: (() => {
      const out = { ever_enrolled_but_not_active: 0, never_enrolled: 0, active_in_another_drip: 0 }
      const everIds = new Set(pastDripIds.length
        ? db.all(`SELECT DISTINCT client_id FROM drip_enrollments WHERE drip_id IN (${pastDripIds.map(() => '?').join(',')})`, pastDripIds).map(r => r.client_id)
        : [])
      const activeOther = new Set(db.all("SELECT DISTINCT client_id FROM drip_enrollments WHERE status='active'").map(r => r.client_id))
      for (const c of closedEligible) {
        if (inPastDrip.has(c.id)) continue
        if (everIds.has(c.id)) out.ever_enrolled_but_not_active++
        else if (activeOther.has(c.id)) out.active_in_another_drip++
        else out.never_enrolled++
      }
      return out
    })(),
    // Why fewer past clients qualify than are in the nurture: being in the nurture is one
    // requirement, the address/email rules are the others, and some fail those.
    past_drip_members_not_eligible: (() => {
      const eligibleIds = new Set(eligible.map(c => c.id))
      const misses = {}
      for (const id of inPastDrip) {
        if (eligibleIds.has(id)) continue
        const c = db.get('SELECT * FROM clients WHERE id = ?', [id])
        const why = c ? (homeValueEligibility(c, ctx) || 'eligible') : 'lead not found'
        misses[why] = (misses[why] || 0) + 1
      }
      return misses
    })(),
    reasons: Object.fromEntries(Object.entries(reasons).sort((a, b) => b[1] - a[1])),
    next: eligible.slice(0, limit).map(c => ({
      id: c.id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      address: usableStreet(c.address), city: c.city, status: c.status, email_status: c.email_status,
    })),
  }
}

// Enrol up to the remaining daily quota. Oldest leads first, so the file is worked through
// in a stable order rather than re-shuffled every run.
export async function homeValueEnrollTick({ force = false } = {}) {
  const cfg = homeValueConfig()
  if (!cfg.enabled && !force) return { skipped: 'enrollment is off', ...cfg }
  const drip = homeValueDrip()
  if (!drip) return { error: `campaign "${CAMPAIGN_NAME}" not found` }

  const done = enrolledToday(drip.id)
  const room = cfg.daily_limit - done
  if (room <= 0) return { enrolled: 0, reason: 'daily limit reached', enrolled_today: done, ...cfg }

  const ctx = buildContext(drip.id)
  const { enrollInDrip } = await import('./routes/drips.js')
  const rows = db.all("SELECT * FROM clients WHERE merged_into IS NULL AND address IS NOT NULL AND address != '' ORDER BY id")

  let enrolled = 0
  const failures = []
  for (const c of rows) {
    if (enrolled >= room) break
    if (homeValueEligibility(c, ctx)) continue
    try {
      // allowConcurrent: this campaign sits alongside the others rather than competing
      // with them (John), so a lead already in Before the Sign still qualifies. The rule
      // that two emails never land the same day is enforced at SEND time in advanceDrip.
      const id = enrollInDrip(drip.id, c.id, { source: 'home_value_auto', allowConcurrent: true })
      if (id) {
        enrolled++
        ctx.enrolledIds.add(c.id)
        ctx.busyToday.add(c.id)
      } else failures.push(`${c.id}:refused`)
    } catch (e) { failures.push(`${c.id}:${e.message}`) }
  }
  if (enrolled) {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['home_value_enrolled', 'drip', drip.id, `${enrolled} enrolled (${done + enrolled}/${cfg.daily_limit} today)`])
  }
  return { enrolled, enrolled_today: done + enrolled, daily_limit: cfg.daily_limit, failures: failures.slice(0, 10) }
}

// Somebody enrolled in the drip has now used the home value tool. That is a conversation
// starting, so the campaign steps aside for 90 days (John, 2026-09-29) rather than stopping
// dead: a person picks it up now, and if nothing comes of it the emails resume on their own
// three months later instead of the lead being quietly dropped.
//
// It stays ACTIVE with a future next_run_at rather than paused, because a paused enrollment
// needs somebody to remember to resume it, and nobody ever does.
export const HOME_VALUE_RESUME_DAYS = 90
export function deferOnHomeValueSubmission(clientId, days = HOME_VALUE_RESUME_DAYS) {
  const drip = homeValueDrip()
  if (!drip) return { deferred: 0 }
  const rows = db.all("SELECT id, current_step FROM drip_enrollments WHERE drip_id=? AND client_id=? AND status='active'", [drip.id, Number(clientId)])
  const resumeAt = new Date(Date.now() + days * 86400000).toISOString()
  for (const r of rows) {
    db.run('UPDATE drip_enrollments SET next_run_at=? WHERE id=?', [resumeAt, r.id])
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['home_value_deferred', 'client', Number(clientId),
        `used the home value tool — campaign resumes ${resumeAt.slice(0, 10)} (${days} days), conversation first`])
  }
  return { deferred: rows.length, resume_at: resumeAt }
}
