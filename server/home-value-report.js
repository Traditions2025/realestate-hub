// THE VALUE WE SEND BACK (John, 2026-11-05).
//
// The response sequence stopped asking questions the nine-screen form already answered,
// which left the obvious hole: the homeowner is told "we'll get that over to you within
// 24 hours" and nothing in the Hub produced the thing being promised. Matt or John review
// the submission against local sales, enter the range here, and this builds the report
// email around it.
//
// A RANGE, NEVER A SINGLE NUMBER. Matt's standing rule on every value we present, said
// again on 2026-10-19: "never a final or suggested single price anywhere in the report, no
// midpoints." A single figure reads as an appraisal and gets quoted back as one. Entering
// a range is also honest about what a desk review can actually tell you.
//
// NOT AN APPRAISAL, and the email says so. This is a licensed agent's opinion of value
// from public records, recent nearby sales and what the homeowner told us about the house.
//
// The report quotes THEIR answers back as sentences, never as fields. "You mentioned the
// roof was done in the last few years" - not "Roof: 3-5". Reading a form back to someone
// is what made the old sequence feel automated.
import db from './database.js'
import { latestAnswers, learnedFacts, proseForHomeowner, remodelLabel } from './home-value-answers.js'

const nowIso = () => new Date().toISOString()

export function initHvReports() {
  try {
    db.run(`CREATE TABLE IF NOT EXISTS home_value_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      submission_id TEXT,
      value_low INTEGER NOT NULL,
      value_high INTEGER NOT NULL,
      notes TEXT,                 -- what the reviewer wants said, in their own words
      prepared_by TEXT,
      status TEXT DEFAULT 'draft', -- draft | sent
      sent_at TEXT,
      created_at TEXT
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_hvrep_client ON home_value_reports(client_id, created_at)')
  } catch { /* best effort: a missing table must not take the route down */ }
}

const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US')

/**
 * Validate a range before anything is composed. Returns an error STRING or null, because
 * every caller wants to show the reason rather than catch an exception.
 */
export function checkRange(low, high) {
  const lo = Math.round(Number(low))
  const hi = Math.round(Number(high))
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return 'enter both ends of the range'
  if (hi < lo) return 'the high end is below the low end'
  // Guard the typo that sends a homeowner a number with a digit missing or a digit extra.
  // The floor is $40,000 rather than something token: a dropped digit on a typical Cedar
  // Rapids value ($285,000 -> $28,500) has to be caught, and that is the mistake worth
  // catching. A genuine sub-$40k valuation is rare enough to be worth a second look.
  if (lo < 40000) return `${money(lo)} looks too low - check the figure`
  if (hi > 5000000) return `${money(hi)} looks too high - check the figure`
  if (hi - lo > lo * 0.5) return 'that range is wider than 50% - narrow it before sending'
  return null
}

/**
 * The sentences about the house, built from what they told us on the form. Each one is
 * only included when they actually answered it, so the report never has a hole in it
 * where an unanswered question used to be.
 */
export function factSentences(clientId) {
  const a = latestAnswers(clientId) || {}
  const learned = learnedFacts(clientId) || {}
  const out = []

  const rating = a.condition_rating || learned.condition_rating
  if (rating) {
    const gap = proseForHomeowner(a.condition_gap)
    out.push(gap
      ? `You rated the overall condition a ${rating} out of 10, and mentioned ${gap.charAt(0).toLowerCase() + gap.slice(1).replace(/\.$/, '')}.`
      : `You rated the overall condition a ${rating} out of 10.`)
  }

  const updates = a.updates || {}
  const names = Object.keys(updates)
  if (names.length) {
    const recent = names.filter((k) => /^0-2|^3-5/.test(String(updates[k] || '')))
    const list = (recent.length ? recent : names).slice(0, 4).map((s) => s.toLowerCase())
    const phrase = list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1] : list[0]
    out.push(recent.length
      ? `You have updated the ${phrase} in recent years, which is the kind of thing an automated estimate rarely accounts for.`
      : `You told us about work on the ${phrase}.`)
  }

  const depth = remodelLabel('remodel_kitchen', a.remodel_kitchen)
  if (depth) out.push(`You described the kitchen work as ${depth}.`)

  if (a.basement_type || a.basement_finish) {
    const t = String(a.basement_type || '').toLowerCase()
    const f = String(a.basement_finish || '').toLowerCase()
    const said = t && f ? `a ${t} basement that is ${f === 'all' ? 'fully finished' : f === 'mostly' ? 'mostly finished' : f === 'part' ? 'partially finished' : f}`
      : t ? `a ${t} basement` : `a ${f} basement`
    out.push(`The home has ${said}, and finished space below grade is weighed differently from the space above it.`)
  }

  if (a.garage_stalls || a.garage_type) {
    const stalls = a.garage_stalls && a.garage_stalls !== '0' ? `${a.garage_stalls} stall` : ''
    const type = String(a.garage_type || '').toLowerCase()
    const said = [type && type !== 'unsure' ? type : '', stalls].filter(Boolean).join(' ')
    if (said) out.push(`There is ${/^[aeiou]/.test(said) ? 'an' : 'a'} ${said} garage, which matters more to buyers here than people expect.`)
  }

  const best = proseForHomeowner(learned.home_best_feature)
  if (best) out.push(`You mentioned ${best.charAt(0).toLowerCase() + best.slice(1).replace(/\.$/, '')} as one of the home's strongest features.`)

  return out
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const P = 'margin:0 0 16px;font-size:16px;line-height:1.65;color:#4b5563;'

/**
 * The report email. Branded the same way as the rest of the Home Value mail: dark header,
 * gold rule, one card. The range is the only number that is allowed to be large.
 */
export function buildReport(client, { low, high, notes = '' } = {}) {
  const bad = checkRange(low, high)
  if (bad) return { error: bad }
  const cid = Number(client?.id)
  const street = String(client?.address || '').trim() || 'your home'
  const first = String(client?.first_name || '').trim() || 'there'
  const facts = factSentences(cid)
  const factHtml = facts.length
    ? `<p style="${P}">Here is what we took into account beyond the public records:</p>
<ul style="margin:0 0 16px;padding:0 0 0 20px;font-size:16px;line-height:1.65;color:#4b5563;">
${facts.map((f) => `  <li style="margin:0 0 8px;">${esc(f)}</li>`).join('\n')}
</ul>`
    : ''
  const noteHtml = String(notes || '').trim()
    ? `<p style="${P}">${esc(String(notes).trim())}</p>`
    : ''

  const subject = `Your home value for ${street}`
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f2f3f5;margin:0;padding:0;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;">
<tr><td align="center" style="background:#191a2e;padding:22px 24px;">
<img src="https://realestate-hub-1rzu.onrender.com/logo.jpg" alt="Matt Smith Team, RE/MAX Concepts" width="210" style="display:block;border:0;">
</td></tr>
<tr><td style="height:3px;background:#c9a227;font-size:0;line-height:0;">&nbsp;</td></tr>
<tr><td style="padding:30px 32px 6px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#8a8f98;">Home value review</p>
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;font-weight:700;color:#1f2937;">${esc(street)}</h1>
<p style="${P}">Hi ${esc(first)},</p>
<p style="${P}">Thanks for your patience. We reviewed what you told us about the home alongside recent sales nearby, and here is where we think ${esc(street)} stands today.</p>
</td></tr>
<tr><td align="center" style="padding:6px 32px 10px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:10px;">
<tr><td align="center" style="padding:26px 20px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<p style="margin:0 0 8px;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#8a8f98;">Estimated value range</p>
<p style="margin:0;font-size:30px;line-height:1.25;font-weight:700;color:#191a2e;">${money(low)} &ndash; ${money(high)}</p>
</td></tr></table>
</td></tr>
<tr><td style="padding:16px 32px 26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${factHtml}
${noteHtml}
<p style="${P}">We give a range rather than one figure on purpose. The final number depends on how the home shows, what else is for sale at the time, and the terms of the offer, and anyone quoting a single figure from a desk is guessing at a precision that does not exist.</p>
<p style="${P}">If you would like us to walk through it properly, we can look at the specific sales behind this and what would move it in either direction. Just reply to this email.</p>
<p style="${P}">Matt Smith<br>Matt Smith Team | RE/MAX Concepts<br>319-431-5859</p>
<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#9aa0a6;border-top:1px solid #eceef1;padding-top:14px;">
This is our opinion of value based on recent comparable sales, public records and the information you provided about the home. It is not an appraisal, and it is not a guarantee of what the property will sell for.
</p>
</td></tr>
</table></td></tr></table>`

  return { subject, html, facts, low: Math.round(Number(low)), high: Math.round(Number(high)) }
}

/**
 * Home value requests with no report sent yet - the review queue.
 *
 * home_value_answers is created by the first submission that runs through the new intake,
 * so on a server that has not seen one yet the table is simply absent. That threw out of
 * an async route handler, which Express does not catch, so the request hung until the
 * caller gave up rather than returning an empty queue (found live, 2026-11-05).
 */
export function pendingReviews({ limit = 50 } = {}) {
  try {
    return listPending(limit)
  } catch {
    return []
  }
}

function listPending(limit) {
  return db.all(`
    SELECT c.id, c.first_name, c.last_name, c.email, c.address, c.city,
           a.submission_id, a.submitted_at, a.condition_rating, a.timeframe
    FROM home_value_answers a
    JOIN clients c ON c.id = a.client_id AND c.merged_into IS NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM home_value_reports r
      WHERE r.client_id = a.client_id AND r.status = 'sent' AND r.created_at >= a.submitted_at)
    ORDER BY a.submitted_at DESC LIMIT ?`, [Math.min(Number(limit) || 50, 200)])
}

export function latestReport(clientId) {
  return db.get('SELECT * FROM home_value_reports WHERE client_id = ? ORDER BY id DESC LIMIT 1', [Number(clientId)])
}

export function saveReport(clientId, { low, high, notes, preparedBy, submissionId, status = 'draft' }) {
  const r = db.run(`INSERT INTO home_value_reports
      (client_id, submission_id, value_low, value_high, notes, prepared_by, status, sent_at, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`,
    [Number(clientId), submissionId || null, Math.round(Number(low)), Math.round(Number(high)),
      String(notes || '').trim() || null, preparedBy || null, status,
      status === 'sent' ? nowIso() : null, nowIso()])
  return r.lastInsertRowid
}

export function markSent(id) {
  db.run("UPDATE home_value_reports SET status='sent', sent_at=? WHERE id=?", [nowIso(), Number(id)])
}
