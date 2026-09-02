// =====================================================================
// DAILY TASK REMINDERS
// Per-person email at 9 AM CT with tasks due today (assigned to them) +
// transaction deadlines due today (shared across the team).
//
// Routing:
// - Tasks assigned to "Matt"          → only Matt's email
// - Tasks assigned to "Leo"           → only Leo's email
// - Tasks with no assignee            → BOTH (so nothing slips through)
// - Transaction deadlines due today   → BOTH (shared team responsibility)
//
// Idempotent: writes to daily_reminder_log with unique (date, recipient).
// =====================================================================
import db from './database.js'
import { sendViaSendGrid } from './routes/email.js'
import { chicagoDateKey } from './transaction-digest.js'

// Configurable via env if recipients change. Keys must match what the Tasks
// UI writes into tasks.assigned_to (currently "Matt" / "Leo").
const TEAM_EMAILS = {
  Matt: process.env.TASK_REMINDER_MATT || 'mattsmithremax@gmail.com',
  Leo:  process.env.TASK_REMINDER_LEO  || 'johnwithmattsmithteam@gmail.com',
}

// Tasks whose due_date matches today (Chicago timezone) AND not yet done.
function fetchTodaysTasks(todayKey) {
  // due_date is stored as 'YYYY-MM-DD' (from <input type="date">) or sometimes
  // 'M/D/YYYY' from legacy data. Try both.
  const [y, m, d] = todayKey.split('-')
  const altMD = `${Number(m)}/${Number(d)}/${y}`
  return db.all(
    `SELECT id, title, description, priority, assigned_to, category, related_type
     FROM tasks
     WHERE status != 'done'
       AND (due_date = ? OR due_date = ?)
     ORDER BY priority DESC, assigned_to, title`,
    [todayKey, altMD])
}

// Deadlines due today across all active transactions. Mirrors the per-field
// logic the digest uses, but flat list and only TODAY (not "next 7 days").
const ACTIVE_STATUSES = new Set(['Active', 'Coming Soon', 'Under Contract', 'Pending', 'Clear to Close'])
const DEADLINE_FIELDS = [
  { col: 'earnest_money_due_date',     label: 'Earnest Money',          statusCol: 'earnest_money_deposit',        terminal: ['Completed'] },
  { col: 'inspection_contingency_date',label: 'Home Inspection',        statusCol: 'home_inspection',              terminal: ['Completed', 'N/A', 'Not Applicable'] },
  { col: 'appraisal_contingency_date', label: 'Appraisal Contingency',  statusCol: 'appraisal_contingency_status', terminal: ['Approved', 'Completed', 'N/A', 'Not Applicable'] },
  { col: 'mortgage_contingency_date',  label: 'Mortgage Contingency',   statusCol: 'financing_status',             terminal: ['Approved'] },
  { col: 'financing_release',          label: 'Financing Release',      statusCol: 'financing_release_status',     terminal: ['Completed and Sent', 'Waived', 'N/A', 'Not Applicable'] },
  { col: 'inspection_release',         label: 'Inspection Release',     statusCol: 'inspection_release_status',    terminal: ['Completed and Sent', 'Waived', 'N/A', 'Not Applicable'] },
  { col: 'final_walkthrough',          label: 'Final Walkthrough',      statusCol: null,                            terminal: [] },
  { col: 'closing_date',               label: 'Closing',                statusCol: null,                            terminal: [] },
]

function fetchTodaysDeadlines(todayKey) {
  const placeholders = [...ACTIVE_STATUSES].map(() => '?').join(',')
  const txs = db.all(
    `SELECT * FROM transactions WHERE property_status IN (${placeholders})`,
    [...ACTIVE_STATUSES])

  const out = []
  const [y, m, d] = todayKey.split('-')
  const altMD = `${Number(m)}/${Number(d)}/${y}`

  for (const tx of txs) {
    const isPurchase = tx.type === 'purchase'
    const isListingOnly = tx.type === 'listing'
    for (const f of DEADLINE_FIELDS) {
      const dateVal = tx[f.col]
      if (!dateVal) continue
      if (dateVal !== todayKey && dateVal !== altMD) continue
      // Skip terminal statuses
      if (f.statusCol && f.terminal.length) {
        const status = tx[f.statusCol]
        if (status && f.terminal.includes(status)) continue
      }
      // Type-specific skips (mirror transactions.js / digest behavior)
      if (f.col === 'mortgage_payoff' && isPurchase) continue
      if (f.col === 'final_walkthrough' && isListingOnly) continue
      out.push({
        label: f.label,
        address: tx.property_address,
        side: tx.type,
        status: tx.property_status,
      })
    }
  }
  // Sort by label for stable email output
  out.sort((a, b) => a.label.localeCompare(b.label) || a.address.localeCompare(b.address))
  return out
}

function priorityBadge(p) {
  const map = { high: '#ef4444', medium: '#f59e0b', low: '#6b7280' }
  return `<span style="display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:3px;background:${map[p] || '#6b7280'};color:white;">${p || 'medium'}</span>`
}

function buildReminderHtml(personName, theirTasks, sharedDeadlines, dateLabel) {
  const taskRows = theirTasks.length === 0
    ? '<tr><td style="padding:10px;color:#888;font-style:italic;">No tasks due today.</td></tr>'
    : theirTasks.map(t => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;">
          <div style="font-weight:600;color:#111;">${escapeHtml(t.title)} ${priorityBadge(t.priority)}</div>
          ${t.description ? `<div style="font-size:13px;color:#555;margin-top:2px;">${escapeHtml(t.description).slice(0, 240)}</div>` : ''}
          ${t.assigned_to ? '' : '<div style="font-size:11px;color:#a16207;margin-top:2px;">(unassigned)</div>'}
          ${t.category ? `<div style="font-size:11px;color:#888;margin-top:2px;">${escapeHtml(t.category)}</div>` : ''}
        </td>
      </tr>`).join('')

  const deadlineRows = sharedDeadlines.length === 0
    ? '<tr><td style="padding:10px;color:#888;font-style:italic;">No transaction deadlines today.</td></tr>'
    : sharedDeadlines.map(d => `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;">
          <div style="font-weight:600;color:#111;">${escapeHtml(d.label)}</div>
          <div style="font-size:13px;color:#555;">${escapeHtml(d.address)} <span style="color:#888;">— ${escapeHtml(d.status)} ${d.side ? `(${escapeHtml(d.side)})` : ''}</span></div>
        </td>
      </tr>`).join('')

  return `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f7;margin:0;padding:20px;">
<div style="max-width:640px;margin:0 auto;background:white;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
  <div style="background:#1f2937;color:white;padding:20px;">
    <h1 style="margin:0;font-size:18px;">Good morning, ${escapeHtml(personName)} ☀</h1>
    <div style="font-size:13px;opacity:0.85;margin-top:4px;">Daily reminders for ${escapeHtml(dateLabel)}</div>
  </div>
  <div style="padding:20px;">
    <h2 style="margin:0 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;">Your tasks due today (${theirTasks.length})</h2>
    <table style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:6px;overflow:hidden;">${taskRows}</table>
    <h2 style="margin:24px 0 10px;font-size:14px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;">Transaction deadlines today (${sharedDeadlines.length})</h2>
    <table style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:6px;overflow:hidden;">${deadlineRows}</table>
    <div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#888;">
      Sent from the Matt Smith Team hub. Tasks marked done in the hub stop appearing here automatically.
    </div>
  </div>
</div>
</body></html>`
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// =====================================================================
// Main entry — sends one personal email per team member.
// =====================================================================
export async function sendDailyReminders({ force = false } = {}) {
  const todayKey = chicagoDateKey()
  const todayDate = new Date()
  const dateLabel = todayDate.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric',
  })

  // Idempotency: one row per (date, recipient)
  db.run(`CREATE TABLE IF NOT EXISTS daily_reminder_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reminder_date TEXT NOT NULL,
    recipient TEXT NOT NULL,
    task_count INTEGER,
    deadline_count INTEGER,
    success INTEGER,
    error TEXT,
    sent_at TEXT DEFAULT (datetime('now')),
    UNIQUE(reminder_date, recipient)
  )`)

  const allTasks = fetchTodaysTasks(todayKey)
  const deadlines = fetchTodaysDeadlines(todayKey)

  // Bucket tasks by assignee. Unassigned tasks go to BOTH.
  const buckets = { Matt: [], Leo: [] }
  for (const t of allTasks) {
    const a = (t.assigned_to || '').trim()
    if (a === 'Matt') buckets.Matt.push(t)
    else if (a === 'Leo') buckets.Leo.push(t)
    else {
      // Unassigned or unrecognized assignee — surface to both
      buckets.Matt.push(t)
      buckets.Leo.push(t)
    }
  }

  const results = []
  for (const [person, email] of Object.entries(TEAM_EMAILS)) {
    if (!force) {
      const existing = db.get(
        'SELECT id FROM daily_reminder_log WHERE reminder_date = ? AND recipient = ? AND success = 1',
        [todayKey, email])
      if (existing) {
        results.push({ person, email, skipped: 'already_sent_today' })
        continue
      }
    }

    const theirTasks = buckets[person] || []
    // Skip the email entirely if there's nothing for them today — no noise.
    if (theirTasks.length === 0 && deadlines.length === 0) {
      results.push({ person, email, skipped: 'nothing_due' })
      continue
    }

    const subject = `Today: ${theirTasks.length} task${theirTasks.length === 1 ? '' : 's'}, ${deadlines.length} deadline${deadlines.length === 1 ? '' : 's'} — ${dateLabel}`
    const html = buildReminderHtml(person, theirTasks, deadlines, dateLabel)

    let success = 1, error = null
    try {
      await sendViaSendGrid([email], 'Matt Smith Team', subject, html, undefined, [], [])
    } catch (err) {
      success = 0
      error = err.message
      console.error(`[daily-reminders] send to ${email} failed:`, err.message)
    }

    db.run(`INSERT OR REPLACE INTO daily_reminder_log
            (reminder_date, recipient, task_count, deadline_count, success, error, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [todayKey, email, theirTasks.length, deadlines.length, success, error])

    if (success) {
      db.run(`INSERT INTO email_log (to_email, from_email, from_name, subject, body, template, status, provider, sent_by)
              VALUES (?, ?, ?, ?, ?, ?, 'sent', 'sendgrid', 'scheduler')`,
        [email, process.env.SENDGRID_FROM_EMAIL || 'matt@mattsmithteam.com',
         'Matt Smith Team', subject, html, 'daily-task-reminder'])
    }

    results.push({ person, email, taskCount: theirTasks.length, deadlineCount: deadlines.length, success: !!success, error })
  }

  return { todayKey, results }
}
