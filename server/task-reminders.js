// =====================================================================
// Timed task reminders + calendar invites.
//  - When a task has a due date + time and an assignee, email that person a
//    calendar invite (.ics) so it lands on their calendar.
//  - Fire Slack reminders 30 min and 5 min before the task is due.
// Times are interpreted in America/Chicago (Central), matching the rest of
// the hub. Slack posts go to the same #transaction-tasks-deadlines webhook.
// =====================================================================
import db from './database.js'
import { postSlack } from './slack.js'

// assigned_to (as written by the Tasks UI) -> email. Overridable via env.
const PEOPLE = {
  Matt: process.env.TASK_REMINDER_MATT || 'mattsmithremax@gmail.com',
  Leo:  process.env.TASK_REMINDER_LEO  || 'johnwithmattsmithteam@gmail.com',
}
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'matt@mattsmithteam.com'

export function emailForAssignee(name) {
  return PEOPLE[String(name || '').trim()] || null
}

// ---- Timezone: convert a Chicago wall-clock to a real UTC instant ----
function tzOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const m = {}
  for (const p of dtf.formatToParts(date)) m[p.type] = p.value
  const asUTC = Date.UTC(m.year, m.month - 1, m.day, m.hour, m.minute, m.second)
  return (asUTC - date.getTime()) / 60000
}
function chicagoWallToUtc(dateStr, timeStr) {
  const [y, mo, d] = String(dateStr).slice(0, 10).split('-').map(Number)
  const [hh, mm] = String(timeStr || '09:00').split(':').map(Number)
  if (!y || !mo || !d) return null
  // Iterate twice to settle DST boundaries.
  let ts = Date.UTC(y, mo - 1, d, hh, mm)
  ts = Date.UTC(y, mo - 1, d, hh, mm) - tzOffsetMinutes(new Date(ts), 'America/Chicago') * 60000
  ts = Date.UTC(y, mo - 1, d, hh, mm) - tzOffsetMinutes(new Date(ts), 'America/Chicago') * 60000
  return new Date(ts)
}

function fmtTime(t) {
  if (!t) return ''
  const [h, m] = String(t).split(':').map(Number)
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = ((h + 11) % 12) + 1
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`
}
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escIcs = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, '\\n')
const icsStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

// ---- Calendar invite (.ics) ----
function buildTaskIcs(task, attendeeEmail) {
  const start = chicagoWallToUtc(task.due_date, task.due_time || '09:00')
  if (!start) return null
  const end = new Date(start.getTime() + 30 * 60000) // 30-minute block
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Matt Smith Team Hub//Tasks//EN',
    'CALSCALE:GREGORIAN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:task-${task.id}@mattsmithteam-hub`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${escIcs('Task: ' + task.title)}`,
    task.description ? `DESCRIPTION:${escIcs(task.description)}` : null,
    `ORGANIZER;CN=Matt Smith Team:mailto:${FROM_EMAIL}`,
    `ATTENDEE;CN=${escIcs(task.assigned_to || '')};RSVP=TRUE:mailto:${attendeeEmail}`,
    'STATUS:CONFIRMED', 'SEQUENCE:0',
    'BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:Task due in 30 minutes', 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-PT5M', 'ACTION:DISPLAY', 'DESCRIPTION:Task due in 5 minutes', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean)
  return lines.join('\r\n')
}

// Email a calendar invite to the assignee. Returns true if sent. Fire-and-forget
// from the routes. Re-invites automatically when the due date/time changes,
// tracked via tasks.calendar_invited (stores the datetime last invited for).
export async function sendTaskCalendarInvite(task) {
  if (!task || !task.due_date || !task.assigned_to) return false
  const email = emailForAssignee(task.assigned_to)
  if (!email) return false
  const stamp = `${task.due_date}T${task.due_time || '09:00'}`
  if (task.calendar_invited === stamp) return false // already invited for this exact time
  const ics = buildTaskIcs(task, email)
  if (!ics) return false
  const timeLabel = task.due_time ? ` at ${fmtTime(task.due_time)}` : ''
  const subject = `Task: ${task.title}`
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;">
    <p>A task has been assigned to you and added to your calendar.</p>
    <p><strong>${escHtml(task.title)}</strong><br>Due ${escHtml(task.due_date)}${timeLabel}</p>
    ${task.description ? `<p>${escHtml(task.description)}</p>` : ''}
    <p style="color:#888;font-size:12px;">You'll also get Slack reminders 30 and 5 minutes before it's due. — Matt Smith Team hub</p>
  </div>`
  try {
    const { sendViaSendGrid } = await import('./routes/email.js')
    await sendViaSendGrid([email], 'Matt Smith Team', subject, html, undefined, [], [
      { content_base64: Buffer.from(ics, 'utf8').toString('base64'), type: 'text/calendar; method=REQUEST; charset=UTF-8', filename: 'task.ics' },
    ])
    db.run('UPDATE tasks SET calendar_invited = ? WHERE id = ?', [stamp, task.id])
    return true
  } catch (e) {
    console.error('[task-reminders] calendar invite failed:', e.message)
    return false
  }
}

// ---- 30-min / 5-min Slack reminders (called every minute by the scheduler) ----
export async function checkTaskReminders() {
  try {
    const now = new Date()
    const tasks = db.all(
      `SELECT id, title, assigned_to, due_date, due_time, reminder_30_sent, reminder_5_sent
       FROM tasks
       WHERE status != 'done' AND due_date IS NOT NULL AND due_date != ''
             AND due_time IS NOT NULL AND due_time != ''`)
    for (const t of tasks) {
      const due = chicagoWallToUtc(t.due_date, t.due_time)
      if (!due) continue
      const mins = (due.getTime() - now.getTime()) / 60000
      const who = t.assigned_to ? `For: ${t.assigned_to} · ` : ''
      // 30-min reminder — fire once when the task is 5-30 min out
      if (!t.reminder_30_sent && mins <= 30 && mins > 5) {
        await postSlack(`:alarm_clock: *Task due in 30 minutes* — ${t.title}\n   ${who}Due today ${fmtTime(t.due_time)}`)
        db.run('UPDATE tasks SET reminder_30_sent = 1 WHERE id = ?', [t.id])
      }
      // 5-min reminder — fire once when the task is 0-5 min out
      if (!t.reminder_5_sent && mins <= 5 && mins > -1.5) {
        await postSlack(`:rotating_light: *Task due in 5 minutes* — ${t.title}\n   ${who}Due at ${fmtTime(t.due_time)}`)
        db.run('UPDATE tasks SET reminder_5_sent = 1 WHERE id = ?', [t.id])
      }
    }
  } catch (e) {
    console.error('[task-reminders] tick error:', e.message)
  }
}
