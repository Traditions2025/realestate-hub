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

  sql += " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END, due_date ASC"
  res.json(db.all(sql, params))
})

router.get('/:id', (req, res) => {
  const row = db.get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)])
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

router.post('/', (req, res) => {
  const b = req.body
  const result = db.run(`INSERT INTO tasks (title, description, priority, status, due_date, due_time,
    assigned_to, category, related_type, related_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [b.title, n(b.description), b.priority || 'medium', b.status || 'todo', n(b.due_date), n(b.due_time),
      n(b.assigned_to), n(b.category), n(b.related_type), n(b.related_id)])

  logActivity('created', 'task', result.lastInsertRowid, `New task: ${b.title}`)
  // Notify team — fire-and-forget so HTTP response isn't blocked on SendGrid
  const created = db.get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid])
  notifyTaskChange('created', created, { silent: !!b.silent }).catch(() => {})
  // Post to Slack #transaction-tasks-deadlines so nothing gets unnoticed
  if (!b.silent) import('../slack.js').then(m => m.notifyTaskCreated(created)).catch(() => {})
  // If it has a due date+time and an assignee, email a calendar invite
  if (created.due_date && created.due_time && created.assigned_to) {
    import('../task-reminders.js').then(m => m.sendTaskCalendarInvite(created)).catch(() => {})
  }
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
  // If the due date/time changed, reset the timed Slack reminders so they fire
  // for the new time, and re-send the calendar invite.
  if ('due_date' in fields || 'due_time' in fields) {
    db.run('UPDATE tasks SET reminder_30_sent = 0, reminder_5_sent = 0 WHERE id = ?', [id])
  }
  const updatedTask = db.get('SELECT * FROM tasks WHERE id = ?', [id])
  if (updatedTask && updatedTask.due_date && updatedTask.due_time && updatedTask.assigned_to) {
    import('../task-reminders.js').then(m => m.sendTaskCalendarInvite(updatedTask)).catch(() => {})
  }
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
