import { Router } from 'express'
import db from '../database.js'
import { sendViaSendGrid } from './email.js'

const router = Router()
const n = (v) => v === undefined ? null : v

// Team member emails for the Nudge feature
const TEAM_EMAILS = {
  matt: 'mattsmithremax@gmail.com',
  leo: 'johnwithmattsmithteam@gmail.com',
  john: 'johnwithmattsmithteam@gmail.com',
}

// Per-change notifications — fired on every task create / update / note-add.
// Override the recipient list via TASK_NOTIFY_RECIPIENTS env var (comma-separated).
// Pass `silent: true` in the request body to skip notifications (used by the
// bulk seed endpoint so importing 60 tasks doesn't fire 60 emails).
const TASK_NOTIFY_RECIPIENTS = (process.env.TASK_NOTIFY_RECIPIENTS ||
  'johnwithmattsmithteam@gmail.com,mattsmithremax@gmail.com')
  .split(',').map(s => s.trim()).filter(Boolean)

const HUB_TASKS_URL = (process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com') + '/tasks'

async function notifyTaskChange(action, task, opts = {}) {
  if (!TASK_NOTIFY_RECIPIENTS.length) return
  if (opts.silent) return
  try {
    const verb =
      action === 'created'    ? 'created' :
      action === 'updated'    ? 'updated' :
      action === 'note_added' ? 'note added to' :
      action === 'deleted'    ? 'deleted' :
                                action
    const subject = `[Task ${verb}] ${task.title || 'Untitled'}`
    const due = task.due_date ? fmtDateLong(task.due_date) : '—'
    const lines = [
      `<p><strong>Task ${verb}</strong> on the Matt Smith Team Hub.</p>`,
      '<ul>',
      `<li><strong>Title:</strong> ${escapeHtmlLite(task.title || '—')}</li>`,
      task.description ? `<li><strong>Description:</strong> ${escapeHtmlLite(task.description)}</li>` : '',
      `<li><strong>Status:</strong> ${escapeHtmlLite((task.status || 'todo').replace(/_/g,' '))}</li>`,
      `<li><strong>Priority:</strong> ${escapeHtmlLite(task.priority || 'medium')}</li>`,
      `<li><strong>Due:</strong> ${escapeHtmlLite(due)}</li>`,
      task.assigned_to ? `<li><strong>Assigned to:</strong> ${escapeHtmlLite(task.assigned_to)}</li>` : '',
      task.category ? `<li><strong>Category:</strong> ${escapeHtmlLite(task.category)}</li>` : '',
      '</ul>',
    ]
    if (opts.note) {
      lines.push(`<p style="background:#f9fafb;border-left:3px solid #c89b4a;padding:10px 14px;border-radius:4px;font-size:14px;"><strong>Note${opts.noteBy ? ' by ' + escapeHtmlLite(opts.noteBy) : ''}:</strong><br>${escapeHtmlLite(opts.note).replace(/\n/g,'<br>')}</p>`)
    }
    if (opts.changeSummary) {
      lines.push(`<p style="font-size:12px;color:#6b7280;"><strong>What changed:</strong> ${escapeHtmlLite(opts.changeSummary)}</p>`)
    }
    lines.push(`<p><a href="${HUB_TASKS_URL}" style="background:#c89b4a;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:13px;">Open Tasks in Hub</a></p>`)
    lines.push('<p style="font-size:11px;color:#9ca3af;">— Matt Smith Team Hub</p>')

    await sendViaSendGrid(
      TASK_NOTIFY_RECIPIENTS,
      'Matt Smith Team',
      subject,
      lines.filter(Boolean).join('\n'),
      undefined,
      [],
      []
    )
  } catch (err) {
    console.error('[task-notify] send failed:', err.message)
  }
}

function escapeHtmlLite(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtDateLong(s) {
  if (!s) return ''
  const parts = String(s).split('-').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return s
  const d = new Date(parts[0], parts[1] - 1, parts[2])
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function logActivity(action, entityType, entityId, details) {
  db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?, ?, ?, ?)', [action, entityType, entityId, details])
}

router.get('/', (req, res) => {
  const { status, priority, assigned_to, category, related_type, related_id } = req.query
  let sql = 'SELECT * FROM tasks WHERE 1=1'
  const params = []

  if (status) { sql += ' AND status = ?'; params.push(status) }
  if (priority) { sql += ' AND priority = ?'; params.push(priority) }
  if (assigned_to) { sql += ' AND assigned_to = ?'; params.push(assigned_to) }
  if (category) { sql += ' AND category = ?'; params.push(category) }
  // Used by the Transactions modal's Custom Checklist sub-component to pull
  // tasks tied to one specific transaction. related_id is numeric.
  if (related_type) { sql += ' AND related_type = ?'; params.push(related_type) }
  if (related_id) { sql += ' AND related_id = ?'; params.push(Number(related_id)) }

  sql += ' ORDER BY CASE priority WHEN "high" THEN 1 WHEN "medium" THEN 2 WHEN "low" THEN 3 END, due_date ASC'
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO tasks (title, description, priority, status, due_date,
    assigned_to, category, related_type, related_id) VALUES (?,?,?,?,?,?,?,?,?)`,
    [b.title, n(b.description), b.priority || 'medium', b.status || 'todo', n(b.due_date),
      n(b.assigned_to), n(b.category), n(b.related_type), n(b.related_id)])

  logActivity('created', 'task', result.lastInsertRowid, `New task: ${b.title}`)
  // Notify team — fire-and-forget so HTTP response isn't blocked on SendGrid
  const created = db.get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid])
  notifyTaskChange('created', created, { silent: !!b.silent }).catch(() => {})
  // Post to Slack #transaction-tasks-deadlines so nothing gets unnoticed
  if (!b.silent) import('../slack.js').then(m => m.notifyTaskCreated(created)).catch(() => {})
  res.status(201).json({ id: result.lastInsertRowid })
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  const fields = req.body
  fields.updated_at = new Date().toISOString()

  // Auto-stamp completion: when status changes, set/clear completed_at
  if ('status' in fields) {
    const current = db.get('SELECT status, completed_at FROM tasks WHERE id = ?', [id])
    if (current) {
      const wasDone = current.status === 'done'
      const isDone = fields.status === 'done'
      if (isDone && !wasDone) {
        // Just marked done — capture timestamp
        fields.completed_at = new Date().toISOString()
      } else if (!isDone && wasDone) {
        // Moved out of done — clear the completion timestamp
        fields.completed_at = null
      }
      // If still done (was done, still done) — preserve existing completed_at unless caller explicitly set it
    }
  }

  const keys = Object.keys(fields)
  const sets = keys.map(k => `${k} = ?`).join(', ')
  const values = [...keys.map(k => n(fields[k])), id]

  db.run(`UPDATE tasks SET ${sets} WHERE id = ?`, values)
  logActivity('updated', 'task', id, fields.status === 'done' ? 'Marked done' : 'Updated task')
  // Build a short "what changed" summary for the notification email
  const changedKeys = Object.keys(fields).filter(k => k !== 'updated_at' && k !== 'notes_log')
  const changeSummary = changedKeys.length
    ? changedKeys.map(k => `${k} → ${String(fields[k] || '').slice(0, 60)}`).join('; ')
    : 'minor update'
  const after = db.get('SELECT * FROM tasks WHERE id = ?', [id])
  notifyTaskChange('updated', after, { silent: !!fields.silent, changeSummary }).catch(() => {})
  res.json({ success: true })
})

router.delete('/:id', (req, res) => {
  db.run('DELETE FROM tasks WHERE id = ?', [Number(req.params.id)])
  logActivity('deleted', 'task', Number(req.params.id), 'Deleted task')
  res.json({ success: true })
})

// Append a note to a task's running notes log (JSON array of {at, by, text})
router.post('/:id/notes', (req, res) => {
  const id = Number(req.params.id)
  const { text, by } = req.body || {}
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' })
  const row = db.get('SELECT * FROM tasks WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Task not found' })
  let log = []
  try { log = row.notes_log ? JSON.parse(row.notes_log) : [] } catch { log = [] }
  const noteText = text.trim()
  const noteBy = (by || '').trim() || null
  log.push({ at: new Date().toISOString(), by: noteBy, text: noteText })
  db.run("UPDATE tasks SET notes_log = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(log), id])
  logActivity('note_added', 'task', id, `Note added by ${by || 'team'}: ${noteText.slice(0, 100)}`)
  notifyTaskChange('note_added', row, { silent: !!req.body.silent, note: noteText, noteBy }).catch(() => {})
  res.json({ success: true, notes_log: log })
})

// Delete a note by index (keeps the rest in order)
router.delete('/:id/notes/:idx', (req, res) => {
  const id = Number(req.params.id)
  const idx = Number(req.params.idx)
  const row = db.get('SELECT notes_log FROM tasks WHERE id = ?', [id])
  if (!row) return res.status(404).json({ error: 'Task not found' })
  let log = []
  try { log = row.notes_log ? JSON.parse(row.notes_log) : [] } catch {}
  if (idx < 0 || idx >= log.length) return res.status(400).json({ error: 'invalid index' })
  log.splice(idx, 1)
  db.run("UPDATE tasks SET notes_log = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(log), id])
  res.json({ success: true, notes_log: log })
})

// =========================================================
// One-time seed: Matt's current task backlog (organized by category)
// Idempotent — won't duplicate tasks that already exist by title
// =========================================================
const MATTS_TASK_LIST = [
  // ============== CLOSED / TERMINATED ==============
  { title: '4609 Pineview NE (Ortiz) — transaction terminated', description: 'Terminated 4/22, earnest returned, Cherryl notified.', priority: 'low', status: 'done', category: 'Closed/Terminated' },

  // ============== ADMIN / SETUP (mostly done) ==============
  { title: 'Hunter set up in Sierra Interactive', priority: 'medium', status: 'done', category: 'Admin/Setup' },
  { title: "Ortiz's MLS search expanded (SE/SW/NW + Marion/Hiawatha/Robins)", priority: 'medium', status: 'done', category: 'Admin/Setup' },
  { title: "All Hunter's leads route to him", priority: 'medium', status: 'done', category: 'Admin/Setup' },
  { title: 'Spokeo background enrichment automated', description: 'Limited credits — monitor usage.', priority: 'low', status: 'in_progress', category: 'Admin/Setup' },
  { title: 'Group texting Sierra plan add-on ($25)', description: 'Decide whether to add the $25 group texting add-on to Sierra.', priority: 'medium', status: 'todo', category: 'Admin/Setup' },
  { title: 'Real Estate Hub app stood up + 45,608 leads syncing', priority: 'high', status: 'done', category: 'Admin/Setup' },
  { title: 'Render upgraded to $7 Starter + Anthropic API funded', priority: 'high', status: 'done', category: 'Admin/Setup' },
  { title: 'IPI roof bid forwarded for 3634 Honey Hill Dr SE', priority: 'medium', status: 'done', category: 'Admin/Setup' },
  { title: 'Inspection remedy + report sent to Cassie for 4711 Twin Pine Dr NE', priority: 'medium', status: 'done', category: 'Admin/Setup' },

  // ============== ACTIVE TRANSACTIONS ==============
  // 403 8th Ave SW (closing 5/15)
  { title: '403 8th Ave SW — Liz George Financing Release extension signed and sent', description: 'Buyer extending Financing Release into next week (gift funds). Signed by Mike and sent to Buyer\'s agent.', priority: 'high', status: 'done', category: 'Active Transaction', due_date: '2026-05-15' },

  // 1033 74th St NE (closing 5/15)
  { title: '1033 74th St NE — Drew Lewis utility transfer follow-up', description: 'Leo to follow up this week. Closing 5/15.', priority: 'high', status: 'todo', category: 'Active Transaction', assigned_to: 'Leo', due_date: '2026-05-15' },

  // 1103 26th St Marion (FHA, closing 6/18)
  { title: '1103 26th St Marion — FHA Amendatory signed and sent', description: 'FHA amendatory signed and sent to buyer\'s agent.', priority: 'medium', status: 'done', category: 'Active Transaction', due_date: '2026-06-18' },

  // 3634 Honey Hill SE (closing 7/1)
  { title: '3634 Honey Hill SE — Kelly Bemus client deciding on skylights', description: 'Waiting on response. Closing 7/1.', priority: 'medium', status: 'in_progress', category: 'Active Transaction', due_date: '2026-07-01' },
  { title: '3634 Honey Hill SE — Appraisal/title/financing release status checks', description: 'Run status checks on appraisal, title, and financing release.', priority: 'medium', status: 'todo', category: 'Active Transaction', due_date: '2026-07-01' },

  // 3657 Rueben Dr (subject-to-home-sale)
  { title: '3657 Rueben Dr — Monitor 1103 26th St Marion buyer\'s home listing', description: 'Subject-to-home-sale; track the buyer\'s home listing progress.', priority: 'medium', status: 'in_progress', category: 'Active Transaction' },
  { title: '3657 Rueben Dr — Pending submission to Des Moines', priority: 'high', status: 'todo', category: 'Active Transaction' },

  // 2416 C St SW (Stark — pending)
  { title: '2416 C St SW (Stark) — Seller Appointed Agency sent to Karen, awaiting signature', priority: 'high', status: 'in_progress', category: 'Active Transaction' },
  { title: '2416 C St SW (Stark) — Add Sales Worksheet', priority: 'medium', status: 'todo', category: 'Active Transaction' },
  { title: '2416 C St SW (Stark) — Submit to Des Moines', priority: 'high', status: 'todo', category: 'Active Transaction' },
  { title: '2416 C St SW (Stark) — Earnest money received (Layne dropped off check)', priority: 'high', status: 'done', category: 'Active Transaction' },

  // ============== PRE-LISTINGS / NEW BUSINESS ==============
  // Federalist (Lambs) — listing soon
  { title: 'Federalist (Lambs) — Listing agreement out for review/sign (Tim to sign)', priority: 'high', status: 'in_progress', category: 'Pre-Listing' },
  { title: 'Federalist (Lambs) — Agency Agreement (Tim to sign)', priority: 'high', status: 'in_progress', category: 'Pre-Listing' },
  { title: 'Federalist (Lambs) — Create listing description', priority: 'high', status: 'todo', category: 'Pre-Listing', assigned_to: 'Matt' },
  { title: 'Federalist (Lambs) — Disclosure (Lambs to sign)', priority: 'high', status: 'in_progress', category: 'Pre-Listing' },

  // Swisher acreage (Lamparek 1690 140th St NW)
  { title: 'Swisher acreage (Lamparek) — Acculevel quote $30K (no inspection done)', description: 'Acculevel Mon 5/4 2pm cancelled. They quoted $30k without checking.', priority: 'medium', status: 'done', category: 'Pre-Listing' },
  { title: "Swisher acreage (Lamparek) — Brown's Septic write-up (expecting tomorrow)", priority: 'medium', status: 'in_progress', category: 'Pre-Listing' },
  { title: 'Swisher acreage (Lamparek) — Johnson County Health (319-356-6040)', description: 'Path: deferral / demo waiver / future-install.', priority: 'medium', status: 'todo', category: 'Pre-Listing' },
  { title: 'Swisher acreage (Lamparek) — List as-is at $160K once basement assessed', priority: 'medium', status: 'in_progress', category: 'Pre-Listing' },
  { title: 'Swisher acreage (Lamparek) — Check status of L&E Basement site visit', priority: 'high', status: 'todo', category: 'Pre-Listing' },
  { title: 'Swisher acreage (Lamparek) — Drone shots', priority: 'medium', status: 'todo', category: 'Pre-Listing' },

  // 3822 Banar Ave SW (Melena Urbanowski)
  { title: '3822 Banar Ave SW (Urbanowski) — 5pm walkthrough', priority: 'high', status: 'todo', category: 'Pre-Listing', due_date: '2026-05-01' },
  { title: '3822 Banar Ave SW (Urbanowski) — CMA', priority: 'high', status: 'todo', category: 'Pre-Listing' },
  { title: '3822 Banar Ave SW (Urbanowski) — CMA Presentation', priority: 'high', status: 'todo', category: 'Pre-Listing' },

  // Amy Oberfell - 4600 Deer View Rd
  { title: 'Amy Oberfell (4600 Deer View Rd) — Pre-marketing materials before mid-May', priority: 'high', status: 'todo', category: 'Pre-Listing', due_date: '2026-05-15' },
  { title: 'Amy Oberfell (4600 Deer View Rd) — Confirm walkthrough with Matt', priority: 'medium', status: 'todo', category: 'Pre-Listing' },
  { title: 'Amy Oberfell (4600 Deer View Rd) — CMA', priority: 'medium', status: 'todo', category: 'Pre-Listing' },

  // Petriks 6820 Boulder Dr NW
  { title: 'Petriks (6820 Boulder Dr NW) — Heavy declutter help (Alburnett wrestling team idea)', priority: 'low', status: 'todo', category: 'Pre-Listing' },
  { title: 'Petriks (6820 Boulder Dr NW) — Check progress', priority: 'low', status: 'todo', category: 'Pre-Listing' },

  // ============== OUTREACH PINGS ==============
  { title: 'Teresa Bochkarev (Bottleworks) — check if still interested', priority: 'low', status: 'todo', category: 'Outreach' },
  { title: 'Andy Hanson — no response 4/30, send listing update', priority: 'medium', status: 'todo', category: 'Outreach', due_date: '2026-04-30' },
  { title: 'Matt Clarke (Tower Lane) — texted, no reply, check if still interested', priority: 'low', status: 'todo', category: 'Outreach' },
  { title: 'Sara Wright (Brighton Dr 2-story) — video sent, watch opens, check updates', priority: 'medium', status: 'todo', category: 'Outreach' },
  { title: 'Norma Walker — Matt handling personally about 721 F Ave', priority: 'medium', status: 'in_progress', category: 'Outreach', assigned_to: 'Matt' },
  { title: 'Rashida Washington — past client, Realist 650, follow up on 2416 C St specifics + Dupaco approval', description: 'Reached out on Facebook Marketplace for 2416 C St. Looking for bigger space. Follow up on property specifics and approval status with Dupaco.', priority: 'medium', status: 'todo', category: 'Outreach' },

  // ============== MARKETING / HUB / SYSTEMS BACKLOG ==============
  { title: 'Sierra blog SEO recovery — 89% impressions drop 4/17', description: '251 canonical overrides, 1,699 alternate-canonical flags from Claude-for-Chrome incident. Investigate and fix.', priority: 'high', status: 'todo', category: 'Marketing' },
  { title: '52411 high-Realist FB retargeting (skip Sierra fee, run direct)', priority: 'medium', status: 'todo', category: 'Marketing' },
  { title: 'Post all April closings as "Just Sold" social posts', priority: 'medium', status: 'todo', category: 'Marketing' },
  { title: 'Re-send 52411 value email to non-openers with new headline', priority: 'medium', status: 'todo', category: 'Marketing' },
  { title: 'Google Form replacing portal valuation page questions', priority: 'low', status: 'todo', category: 'Marketing' },
  { title: '"Foundation repair recommendations?" FB post via team page across Linn County groups', priority: 'low', status: 'todo', category: 'Marketing' },
  { title: 'FB Messenger auto-responder for C Street (mobile setup)', priority: 'medium', status: 'todo', category: 'Marketing' },
  { title: 'Review Homebot subscription with Matt', priority: 'low', status: 'todo', category: 'Marketing', assigned_to: 'Matt' },
  { title: 'Facebook Retargeting / Remarketing setup', priority: 'medium', status: 'todo', category: 'Marketing' },

  // ============== HUB BUILD (Leo) ==============
  { title: 'Hub build — Listings tab', priority: 'high', status: 'done', category: 'Hub Build', assigned_to: 'Leo' },
  { title: 'Hub build — AI chat on website', priority: 'low', status: 'todo', category: 'Hub Build', assigned_to: 'Leo' },
  { title: 'Hub build — Twilio texting integration', priority: 'medium', status: 'todo', category: 'Hub Build', assigned_to: 'Leo' },
  { title: 'Hub build — Email templates for transactions / pre-listings', priority: 'high', status: 'done', category: 'Hub Build', assigned_to: 'Leo' },
  { title: 'Hub build — Email blast to filtered groups', priority: 'medium', status: 'todo', category: 'Hub Build', assigned_to: 'Leo' },
]

router.post('/seed-matts-list', (req, res) => {
  let added = 0
  let skipped = 0
  // Bulk mode: skip saveDb() between each INSERT — would otherwise write the
  // full 24 MB DB to disk 59 times. With bulk mode we write once at the end.
  db.beginBulk?.()
  try {
    for (const t of MATTS_TASK_LIST) {
      const existing = db.get('SELECT id FROM tasks WHERE title = ?', [t.title])
      if (existing) { skipped++; continue }
      db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category)
        VALUES (?,?,?,?,?,?,?)`,
        [t.title, n(t.description), t.priority || 'medium', t.status || 'todo',
          n(t.due_date), n(t.assigned_to), n(t.category)])
      added++
    }
  } finally {
    db.endBulk?.()  // single saveDb() here
  }
  logActivity('seeded', 'task', null, `Imported Matt's task list: ${added} added, ${skipped} skipped (already existed)`)
  // No per-task notification emails on bulk seed — would spam 60+ emails
  res.json({ success: true, added, skipped, total: MATTS_TASK_LIST.length })
})

// =========================================================
// NUDGE — quick email reminder to Matt or Leo about a task
// =========================================================
router.post('/:id/nudge', async (req, res) => {
  const id = Number(req.params.id)
  const task = db.get('SELECT * FROM tasks WHERE id = ?', [id])
  if (!task) return res.status(404).json({ error: 'Task not found' })

  let { recipient, message, sender } = req.body || {}
  // Resolve recipient → email address
  // Accepts: 'matt', 'leo', 'john', or a raw email
  const recipKey = String(recipient || task.assigned_to || '').trim().toLowerCase()
  let toEmail = TEAM_EMAILS[recipKey]
  let toName = recipKey
  if (!toEmail && /@/.test(recipient || '')) {
    toEmail = recipient.trim()
    toName = recipient.split('@')[0]
  }
  if (!toEmail) {
    return res.status(400).json({
      error: 'No recipient — task has no assignee, or recipient must be "matt", "leo", or a valid email',
    })
  }

  const recipFirst = (toName || recipKey || 'team').replace(/^./, c => c.toUpperCase()).split(/\s+/)[0]
  const senderName = (sender || 'the Matt Smith Team Hub').trim()

  const subject = `📌 Nudge: ${task.title}`
  const dueLine = task.due_date ? `Due: ${fmtDateLong(task.due_date)}` : 'No due date set'
  const lines = [
    `Hi ${recipFirst},`,
    '',
    `Quick nudge from ${senderName} on this task:`,
    '',
    `— ${task.title}`,
  ]
  if (task.description) lines.push(`  ${task.description}`)
  lines.push('')
  lines.push(`Status: ${(task.status || '').replace(/_/g, ' ')}  ·  Priority: ${task.priority || 'medium'}`)
  lines.push(dueLine)
  if (task.assigned_to && task.assigned_to.toLowerCase() !== recipKey) {
    lines.push(`Assigned to: ${task.assigned_to}`)
  }
  if (task.category) lines.push(`Category: ${task.category}`)
  if (message && message.trim()) {
    lines.push('')
    lines.push(message.trim())
  }
  lines.push('')
  lines.push('Open the hub to update or add notes:')
  lines.push('https://realestate-hub-1rzu.onrender.com/tasks')
  lines.push('')
  lines.push('— Matt Smith Team Hub')

  const body = lines.join('\n')

  try {
    await sendViaSendGrid(
      toEmail,
      recipFirst,
      subject,
      body,
      undefined, // replyTo (default)
      [],        // cc
      []         // attachments
    )
    // Append a note to the task's running log so the nudge is recorded
    let log = []
    try { log = task.notes_log ? JSON.parse(task.notes_log) : [] } catch {}
    log.push({
      at: new Date().toISOString(),
      by: senderName,
      text: `📌 Nudge sent to ${recipFirst} (${toEmail})${message ? ': ' + message : ''}`,
    })
    db.run("UPDATE tasks SET notes_log = ?, updated_at = datetime('now') WHERE id = ?",
      [JSON.stringify(log), id])
    logActivity('nudged', 'task', id, `Nudged ${recipFirst} (${toEmail}): ${task.title}`)
    res.json({ success: true, sent_to: toEmail })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
