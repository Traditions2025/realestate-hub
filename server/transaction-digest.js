// Daily transaction digest — assembles a status email for every transaction
// currently under contract and emails it to the team. Runs on a server-side
// schedule (see scheduler.js) so it works regardless of whether anyone's
// laptop is on.

import db from './database.js'
import { sendViaSendGrid } from './routes/email.js'

const DIGEST_RECIPIENTS = (process.env.TC_DIGEST_RECIPIENTS || 'johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean)

const ACTIVE_STATUSES = ['Under Contract', 'Pending', 'Clear to Close']

// =====================================================================
// Date helpers (timezone-safe local-date math)
// =====================================================================

// Accepts ISO (YYYY-MM-DD) or legacy Sheet format (M/D/YYYY)
function parseLocalDate(s) {
  if (!s) return null
  const str = String(s).trim()
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  return null
}

function formatLocalDate(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function todayLocal() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function daysBetween(a, b) {
  if (!a || !b) return null
  const ms = b.getTime() - a.getTime()
  return Math.round(ms / 86400000)
}

function fmtDate(s) {
  const d = parseLocalDate(s)
  if (!d) return ''
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

// "today's date in Chicago, in YYYY-MM-DD form" — used for digest_log uniqueness
export function chicagoDateKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const y = parts.find(p => p.type === 'year').value
  const mo = parts.find(p => p.type === 'month').value
  const d = parts.find(p => p.type === 'day').value
  return `${y}-${mo}-${d}`
}

// =====================================================================
// Per-transaction action items + days-out classification
// =====================================================================

const URGENT_DAYS = 3   // due in 3 days or less = urgent
const WATCH_DAYS  = 7   // due in 4-7 days = watch

function classify(daysOut) {
  if (daysOut == null) return null
  if (daysOut < 0) return 'overdue'
  if (daysOut === 0) return 'today'
  if (daysOut <= URGENT_DAYS) return 'urgent'
  if (daysOut <= WATCH_DAYS) return 'watch'
  return 'normal'
}

const SEVERITY = { overdue: 0, today: 1, urgent: 2, watch: 3, normal: 4 }
const COLORS = {
  overdue: '#dc2626',
  today:   '#dc2626',
  urgent:  '#ea580c',
  watch:   '#ca8a04',
  normal:  '#374151',
}
const LABEL = {
  overdue: 'OVERDUE',
  today:   'TODAY',
  urgent:  'URGENT',
  watch:   'WATCH',
  normal:  '',
}

// Build the list of "action items" for a transaction — date-driven things to track.
function buildActionItems(tx) {
  const today = todayLocal()
  const items = []

  const push = (label, dateStr, statusField) => {
    const d = parseLocalDate(dateStr)
    if (!d) return
    const out = daysBetween(today, d)
    const cls = classify(out)
    items.push({
      label,
      date: dateStr,
      daysOut: out,
      class: cls,
      status: statusField ? tx[statusField] : null,
    })
  }

  push('Earnest money due',          tx.earnest_money_due_date,    'earnest_money_deposit')
  push('IPI due',                    tx.ipi_due_date)
  push('Inspection deadline',        tx.inspection_contingency_date, 'home_inspection')
  push('Appraisal contingency',      tx.appraisal_contingency_date,  'appraisal_contingency_status')
  push('Mortgage contingency',       tx.mortgage_contingency_date)
  push('Financing release',          tx.financing_release)
  push('Final walkthrough',          tx.final_walkthrough)
  push('Closing',                    tx.closing_date)

  return items.sort((a, b) => {
    const sa = SEVERITY[a.class] ?? 9
    const sb = SEVERITY[b.class] ?? 9
    if (sa !== sb) return sa - sb
    return (a.daysOut ?? 9999) - (b.daysOut ?? 9999)
  })
}

// =====================================================================
// HTML rendering
// =====================================================================

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function pill(label, color, bg) {
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:${color};background:${bg};border:1px solid ${color}33;">${escapeHtml(label)}</span>`
}

function dateRow(it) {
  const c = COLORS[it.class] || COLORS.normal
  const tag = LABEL[it.class] ? `<span style="font-weight:700;color:${c};margin-right:6px;">${LABEL[it.class]}</span>` : ''
  const days = it.daysOut == null ? '' :
    it.daysOut === 0 ? ' (today)' :
    it.daysOut < 0   ? ` (${Math.abs(it.daysOut)}d ago)` :
                       ` (in ${it.daysOut}d)`
  const stat = it.status ? ` &middot; <span style="color:#6b7280;">${escapeHtml(it.status)}</span>` : ''
  return `<tr>
    <td style="padding:4px 12px 4px 0;color:#374151;font-size:13px;white-space:nowrap;">${escapeHtml(it.label)}</td>
    <td style="padding:4px 0;color:${c};font-size:13px;font-weight:500;">${tag}${escapeHtml(fmtDate(it.date))}${days}${stat}</td>
  </tr>`
}

function docStatusRow(label, value) {
  if (!value) return ''
  const isComplete = /complete|received|signed|approved|done/i.test(value)
  const color = isComplete ? '#16a34a' : '#6b7280'
  return `<span style="display:inline-block;margin:2px 8px 2px 0;font-size:11px;color:${color};">
    <strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}
  </span>`
}

function checklistChip(label, isDone) {
  const color = isDone ? '#16a34a' : '#9ca3af'
  const mark = isDone ? '✓' : '○'
  return `<span style="display:inline-block;margin:1px 8px 1px 0;font-size:11px;color:${color};">${mark} ${escapeHtml(label)}</span>`
}

function renderTransactionCard(tx) {
  const items = buildActionItems(tx)
  const urgent = items.filter(it => SEVERITY[it.class] <= 2)  // overdue/today/urgent
  const headerColor = urgent.length ? '#dc2626' : '#1f2937'
  // Type is 'listing', 'purchase', or 'both' (dual agency)
  const t = String(tx.type || '').toLowerCase()
  const sidePill =
    t === 'both'    ? pill('BOTH SIDES', '#a855f7', 'rgba(168,85,247,0.08)')
  : t === 'listing' ? pill('LISTING',    '#10b981', 'rgba(16,185,129,0.08)')
  :                   pill('PURCHASE',   '#3b82f6', 'rgba(59,130,246,0.08)')

  const dotloop = tx.dotloop_status ? pill(`Dotloop: ${tx.dotloop_status}`, '#7c3aed', 'rgba(124,58,237,0.08)') : ''

  const docs = [
    docStatusRow('Abstract',         tx.abstract),
    docStatusRow('Title',            tx.title_commitment),
    docStatusRow('Mortgage Payoff',  tx.mortgage_payoff),
    docStatusRow('ALTA',             tx.alta_statement),
    docStatusRow('Deed',             tx.deed_package),
  ].filter(Boolean).join('')

  // Side-aware. 'both' or blank → include every item.
  const showSide = (side) => {
    if (!tx.type || tx.type === 'both') return true
    return side === 'both' || side === tx.type
  }

  // Phased checklist definition (one source of truth, mirrors the form)
  const PHASES = [
    { label: 'Listing & Disclosures', items: [
      { field: 'mls_pending_marked',          label: 'MLS Marked Pending',                 side: 'listing' },
      { field: 'remove_listing_alerts',       label: 'Remove Listing Alerts',              side: 'listing' },
      { field: 'email_contract_closing',      label: 'Email Contract to Closing',          side: 'both' },
      { field: 'ayse_added_to_loop',          label: 'AYSE Added to Loop',                 side: 'both' },
      { field: 'ayse_contracts_signed',       label: 'AYSE Contracts Signed',              side: 'both' },
      { field: 'sellers_disclosure_received', label: 'Seller’s Disclosure (RPDS)',         side: 'listing' },
    ]},
    { label: 'Closing Logistics', items: [
      { field: 'closing_time_confirmed',      label: 'Closing Time Confirmed',             side: 'both' },
      { field: 'closing_location_confirmed',  label: 'Closing Location Confirmed',         side: 'both' },
      { field: 'closing_attendees_notified',  label: 'Buyer/Seller Notified of When/Where',side: 'both' },
      { field: 'closing_disclosure_reviewed', label: 'CD Reviewed (3-day rule)',           side: 'both' },
      { field: 'financing_release_followup',  label: 'Followed Up on Financing Release',   side: 'both' },
      { field: 'utilities_set',               label: 'Utilities Set to New Owner',         side: 'purchase' },
    ]},
    { label: 'Day-of & Post-Closing', items: [
      { field: 'seller_signed_deed',          label: 'Seller Signed Deed Package',         side: 'listing' },
      { field: 'keys_remotes_collected',      label: 'Keys / Remotes Collected',           side: 'both' },
      { field: 'sign_lockbox_removed',        label: 'Sign + Lockbox Removed',             side: 'listing' },
      { field: 'closing_complete',            label: 'Closing Complete',                   side: 'both' },
      { field: 'mls_sold_marked',             label: 'MLS Marked Sold',                    side: 'listing' },
      { field: 'sales_worksheet_added',       label: 'Sales Worksheet Added',              side: 'both' },
      { field: 'submit_loop_review',          label: 'Submit Loop for Review',             side: 'both' },
      { field: 'approved_commission',         label: 'Approved for Commission',            side: 'both' },
      { field: 'commission_received',         label: 'Commission Received',                side: 'both' },
      { field: 'testimonial_request',         label: 'Testimonial Request Sent',           side: 'both' },
      { field: 'referral_followup_30day',     label: '30-Day Post-Close Follow-Up',        side: 'both' },
    ]},
  ]

  // Compute completion progress + pending list
  const allRelevant = PHASES.flatMap(p => p.items.filter(it => showSide(it.side)))
  const totalCount = allRelevant.length
  const doneCount = allRelevant.filter(it => tx[it.field]).length
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0
  const progressColor = pct >= 80 ? '#16a34a' : pct >= 50 ? '#ca8a04' : '#dc2626'

  // Build per-phase pending lists (only items NOT yet done — what still needs doing)
  const pendingHtml = PHASES.map(phase => {
    const pending = phase.items.filter(it => showSide(it.side) && !tx[it.field])
    if (!pending.length) return ''
    const lis = pending.map(it => `<li style="margin:2px 0;color:#374151;">${escapeHtml(it.label)}</li>`).join('')
    return `<div style="margin-top:6px;">
      <div style="font-size:11px;font-weight:700;color:#9ca3af;text-transform:uppercase;letter-spacing:0.4px;">${escapeHtml(phase.label)}</div>
      <ul style="margin:2px 0 0 18px;padding:0;font-size:12px;list-style:disc;">${lis}</ul>
    </div>`
  }).filter(Boolean).join('')

  const progressBar = `
    <div style="margin-top:10px;">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#6b7280;margin-bottom:3px;">
        <span><strong>Checklist:</strong> ${doneCount} / ${totalCount} done (${pct}%)</span>
        ${pendingHtml ? `<span style="color:${progressColor};font-weight:600;">${totalCount - doneCount} pending</span>` : '<span style="color:#16a34a;font-weight:600;">✓ All complete</span>'}
      </div>
      <div style="height:6px;background:#f3f4f6;border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:${progressColor};"></div>
      </div>
    </div>`

  const checklist = progressBar + (pendingHtml ? `<div style="margin-top:8px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 12px;">${pendingHtml}</div>` : '')

  const closingDetails = (tx.closing_time || tx.closing_location || tx.buyer_payment_method)
    ? `<div style="margin-top:6px;font-size:12px;color:#374151;">
        ${(tx.closing_time || tx.closing_location) ? `<strong>Closing:</strong> ${escapeHtml(tx.closing_time || 'time TBD')}${tx.closing_location ? ' &middot; ' + escapeHtml(tx.closing_location) : ''}` : ''}
        ${tx.buyer_payment_method ? `${(tx.closing_time || tx.closing_location) ? ' &middot; ' : ''}<strong>Payment:</strong> ${escapeHtml(tx.buyer_payment_method)}` : ''}
      </div>`
    : ''

  const buyer  = tx.buyer_name  || (tx.transaction_type === 'purchase' ? '—' : '')
  const seller = tx.seller_name || ''
  const lender = [tx.lender_name, tx.lender_company].filter(Boolean).join(' / ') ||
                 (tx.type_of_finance ? `(${tx.type_of_finance})` : '')

  return `
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin:14px 0;background:#ffffff;">
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-bottom:8px;">
      <div style="font-size:16px;font-weight:700;color:${headerColor};flex:1;">${escapeHtml(tx.property_address || 'Address unknown')}</div>
      ${sidePill}
      ${pill(tx.property_status || '', '#374151', '#f3f4f6')}
      ${dotloop}
    </div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
      ${buyer ? `<strong>Buyer:</strong> ${escapeHtml(buyer)}` : ''}
      ${buyer && seller ? ' &middot; ' : ''}
      ${seller ? `<strong>Seller:</strong> ${escapeHtml(seller)}` : ''}
      ${lender ? ` &middot; <strong>Lender:</strong> ${escapeHtml(lender)}` : ''}
    </div>
    ${items.length ? `<table style="border-collapse:collapse;width:100%;margin-bottom:6px;"><tbody>${items.map(dateRow).join('')}</tbody></table>` : '<div style="color:#9ca3af;font-size:12px;">No dates set on this transaction.</div>'}
    ${closingDetails}
    ${docs ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed #e5e7eb;">${docs}</div>` : ''}
    ${checklist ? `<div style="margin-top:6px;">${checklist}</div>` : ''}
    ${tx.notes ? `<div style="margin-top:8px;font-size:12px;color:#4b5563;background:#fafafa;padding:8px 10px;border-radius:6px;border-left:3px solid #d1d5db;"><strong>Notes:</strong> ${escapeHtml(tx.notes)}</div>` : ''}
  </div>`
}

// =====================================================================
// Top-level: fetch + render full digest
// =====================================================================

export function fetchActiveTransactions() {
  const placeholders = ACTIVE_STATUSES.map(() => '?').join(',')
  return db.all(
    `SELECT * FROM transactions
     WHERE property_status IN (${placeholders})
     ORDER BY closing_date IS NULL, closing_date ASC, property_address ASC`,
    ACTIVE_STATUSES)
}

export function buildDigest(period = 'morning') {
  const txs = fetchActiveTransactions()
  const today = todayLocal()
  const periodLabel = period === 'morning' ? 'Morning Update' : 'Afternoon Update'

  // Aggregate flags across all transactions
  let overdue = 0, dueToday = 0, dueThisWeek = 0
  const allActions = []
  for (const tx of txs) {
    const items = buildActionItems(tx)
    for (const it of items) {
      if (it.class === 'overdue') overdue++
      else if (it.class === 'today') dueToday++
      else if (it.class === 'urgent' || it.class === 'watch') dueThisWeek++
      if (SEVERITY[it.class] <= 2) {
        allActions.push({ tx, item: it })
      }
    }
  }

  const dateLine = today.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  })

  const bannerColor = overdue ? '#dc2626' : dueToday ? '#ea580c' : '#16a34a'

  const summary = `
    <div style="background:${bannerColor};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0;">
      <div style="font-size:18px;font-weight:700;">Transaction Watchlist — ${escapeHtml(periodLabel)}</div>
      <div style="font-size:13px;opacity:0.92;margin-top:2px;">${escapeHtml(dateLine)}</div>
    </div>
    <div style="background:#f9fafb;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;padding:14px 18px;font-size:13px;color:#374151;">
      <strong>${txs.length}</strong> active transaction${txs.length === 1 ? '' : 's'}
      &middot; <span style="color:#dc2626;font-weight:700;">${overdue}</span> overdue
      &middot; <span style="color:#ea580c;font-weight:700;">${dueToday}</span> due today
      &middot; <span style="color:#ca8a04;font-weight:700;">${dueThisWeek}</span> due in next ${WATCH_DAYS}d
    </div>`

  let actionsBlock = ''
  if (allActions.length) {
    const rows = allActions.slice(0, 50).map(({ tx, item }) => {
      const c = COLORS[item.class]
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:${c};font-weight:700;white-space:nowrap;">${LABEL[item.class] || ''}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:13px;color:#1f2937;">${escapeHtml(tx.property_address || '—')}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#374151;">${escapeHtml(item.label)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;font-size:12px;color:#6b7280;white-space:nowrap;">${escapeHtml(fmtDate(item.date))}</td>
      </tr>`
    }).join('')
    actionsBlock = `
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:12px 14px;margin:14px 0;">
      <div style="font-size:14px;font-weight:700;color:#9a3412;margin-bottom:6px;">⚡ Action Items (${allActions.length})</div>
      <table style="border-collapse:collapse;width:100%;">${rows}</table>
    </div>`
  }

  const cards = txs.length
    ? txs.map(renderTransactionCard).join('')
    : `<div style="padding:30px;text-align:center;color:#6b7280;background:#fff;border:1px dashed #d1d5db;border-radius:8px;margin:14px 0;">No active transactions. Enjoy the breather. ☕</div>`

  const footer = `
    <div style="font-size:11px;color:#9ca3af;text-align:center;margin-top:18px;padding-top:12px;border-top:1px solid #e5e7eb;">
      Sent by Matt Smith Team Hub &middot; <a href="https://realestate-hub-1rzu.onrender.com/transactions" style="color:#6b7280;">Open dashboard</a>
    </div>`

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="max-width:780px;margin:0 auto;padding:18px;">
    ${summary}
    ${actionsBlock}
    ${cards}
    ${footer}
  </div>
</body></html>`

  const subject = overdue
    ? `[${overdue} OVERDUE] TC ${periodLabel} — ${txs.length} active transactions`
    : dueToday
      ? `[${dueToday} due today] TC ${periodLabel} — ${txs.length} active transactions`
      : `TC ${periodLabel} — ${txs.length} active transactions`

  return {
    subject,
    html,
    transactionCount: txs.length,
    actionCount: allActions.length,
    overdue,
    dueToday,
    dueThisWeek,
  }
}

// =====================================================================
// Sending + idempotency
// =====================================================================

export async function sendDigest(period = 'morning', { force = false } = {}) {
  const digestDate = chicagoDateKey()
  if (!force) {
    const existing = db.get('SELECT id, success FROM digest_log WHERE digest_date = ? AND period = ?', [digestDate, period])
    if (existing && existing.success) {
      return { skipped: true, reason: 'already_sent', digestDate, period }
    }
  }

  const built = buildDigest(period)
  const recipients = DIGEST_RECIPIENTS

  let success = 1
  let error = null
  try {
    await sendViaSendGrid(
      recipients,        // to
      'Matt Smith Team', // toName
      built.subject,
      built.html,
      undefined,         // replyTo (default)
      [],                // cc
      [])                // attachments
  } catch (err) {
    success = 0
    error = err.message
    console.error('[digest] send failed:', err.message)
  }

  // Record in digest_log (replace prior row for this date+period if it failed earlier)
  db.run(`INSERT OR REPLACE INTO digest_log
          (digest_date, period, recipients, transaction_count, action_count, success, error, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [digestDate, period, recipients.join(','), built.transactionCount, built.actionCount, success, error])

  // Also record in email_log so it shows in the Updates → Email Log tab
  if (success) {
    for (const to of recipients) {
      db.run(`INSERT INTO email_log (to_email, from_email, from_name, subject, body, template, status, provider, sent_by)
              VALUES (?, ?, ?, ?, ?, ?, 'sent', 'sendgrid', 'scheduler')`,
        [to, process.env.SENDGRID_FROM_EMAIL || 'matt@mattsmithteam.com',
         'Matt Smith Team', built.subject, built.html, `tc-digest-${period}`])
    }
  }

  return {
    skipped: false,
    success: !!success,
    error,
    digestDate,
    period,
    transactionCount: built.transactionCount,
    actionCount: built.actionCount,
    recipients,
  }
}
