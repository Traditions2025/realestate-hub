// Whether the automations may put rows in the Tasks tab.
//
// John, 2026-10-05: "keep our tasks tab primarily for our own manual task only, remove any
// task there that was added from AI." 71 of the 239 tasks had been written by automations —
// 42 CX Response, 17 FSBO Response, 11 Annual Not in Market Recheck, 1 Fix It or Skip It.
// Deleting them alone would have fixed nothing: a CX Response task is written every time a
// cancelled/expired lead replies, so the tab would have refilled within days.
//
// A SETTING rather than deleted code, so it can be turned back on without a release, and so
// the reason survives next to the switch.
//
// Nothing is lost by it. Every one of these paths already raises a notification at the
// moment it matters — "RESPONSE RECEIVED — <name>" for a reply, and the conversation is in
// the Inbox either way. The task was a second copy of a signal that already existed.
import db from './database.js'

export const SETTING = 'automation_tasks_enabled'

/** Default OFF: the Tasks tab belongs to the team. */
export function automationTasksEnabled() {
  return String(db.getSetting(SETTING, '0') || '0') === '1'
}

/**
 * Insert a task on an automation's behalf, or don't.
 *
 * Returns the new id, or null when the switch is off — callers treat null as "skipped",
 * never as a failure.
 */
export function createAutomationTask({
  title, description = null, priority = 'medium', status = 'todo', due_date = null,
  assigned_to = null, category = null, related_type = null, related_id = null,
} = {}) {
  if (!automationTasksEnabled()) return null
  if (!String(title || '').trim()) return null
  const r = db.run(
    `INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [title, description, priority, status, due_date, assigned_to, category, related_type, related_id])
  return r.lastInsertRowid
}
