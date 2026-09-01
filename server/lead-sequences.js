// Lead sequence lifecycle helpers — shared by the clients route, the Sierra
// sync, and the automation engine. Two jobs:
//   1. When a lead is moved to a "stop" status (Junk), pull it out of every
//      active drip + automation so no further emails/texts fire.
//   2. Surface a lead's currently-running plans for the lead profile.
import db from './database.js'

const nowIso = () => new Date().toISOString()

// Statuses that mean "stop contacting this lead". Moving a lead into any of
// these removes it from all active drips + automations so nothing else fires.
export const STOP_STATUSES = new Set(['junk', 'donotcontact'])

export function isStopStatus(status) {
  return STOP_STATUSES.has(String(status || '').toLowerCase())
}

// Remove a lead from every active drip + automation enrollment. Idempotent:
// if the lead has no active enrollments it is a cheap no-op. Returns the
// number of drip and automation enrollments that were actually stopped.
export function stopSequencesForClient(clientId, reason = 'lead marked junk') {
  const id = Number(clientId)
  if (!id) return { drips: 0, automations: 0 }
  const d = db.run(
    "UPDATE drip_enrollments SET status='removed', completed_at=? WHERE client_id=? AND status='active'",
    [nowIso(), id])
  const a = db.run(
    "UPDATE automation_enrollments SET status='removed', exit_reason=?, completed_at=?, next_run_at=NULL WHERE client_id=? AND status IN ('active','waiting')",
    [reason, nowIso(), id])
  return { drips: d.changes || 0, automations: a.changes || 0 }
}

// One-time / boot backfill: remove active enrollments for any lead ALREADY in a
// stop status (leads marked Junk/DNC before this rule existed, or added via a
// path that bypassed the status hook). Idempotent and cheap. Statuses are stored
// lowercase, so match on lower(status).
export function purgeStopStatusEnrollments() {
  const list = Array.from(STOP_STATUSES)
  const ph = list.map(() => '?').join(',')
  const d = db.run(
    `UPDATE drip_enrollments SET status='removed', completed_at=?
       WHERE status='active' AND client_id IN (SELECT id FROM clients WHERE lower(status) IN (${ph}))`,
    [nowIso(), ...list])
  const a = db.run(
    `UPDATE automation_enrollments SET status='removed', exit_reason='stop-status backfill', completed_at=?, next_run_at=NULL
       WHERE status IN ('active','waiting') AND client_id IN (SELECT id FROM clients WHERE lower(status) IN (${ph}))`,
    [nowIso(), ...list])
  if ((d.changes || 0) + (a.changes || 0) > 0) {
    console.log(`[lead-sequences] stop-status backfill removed ${d.changes || 0} drip + ${a.changes || 0} automation enrollment(s)`)
  }
  return { drips: d.changes || 0, automations: a.changes || 0 }
}

// The lead's currently-running plans (for the lead profile). Drips are joined
// to their campaign for a name + total step count; automations to their name.
export function activeSequencesForClient(clientId) {
  const id = Number(clientId)
  if (!id) return { drips: [], automations: [] }
  const drips = db.all(
    `SELECT e.id AS enrollment_id, e.drip_id, e.current_step, e.next_run_at, e.entered_at, e.source, e.status,
       d.name AS drip_name, d.steps AS steps
     FROM drip_enrollments e JOIN drip_campaigns d ON d.id = e.drip_id
     WHERE e.client_id=? AND e.status IN ('active','paused')
     ORDER BY e.entered_at DESC`, [id]
  ).map(r => {
    let stepsArr = []
    try { stepsArr = JSON.parse(r.steps || '[]') } catch { stepsArr = [] }
    const { steps, ...rest } = r
    const cur = stepsArr[r.current_step] || null
    return {
      ...rest,
      total_steps: stepsArr.length,
      // 1-based label for the human ("Email 4 of 12"); current_step is 0-based next-to-send.
      next_step_number: Math.min(r.current_step + 1, stepsArr.length),
      next_step_subject: cur ? (cur.subject || '(no subject)') : null,
    }
  })
  const automations = db.all(
    `SELECT e.id AS enrollment_id, e.automation_id, e.status, e.next_run_at, e.entered_at,
       a.name AS automation_name
     FROM automation_enrollments e JOIN automations a ON a.id = e.automation_id
     WHERE e.client_id=? AND e.status IN ('active','waiting','paused')
     ORDER BY e.entered_at DESC`, [id]
  )
  return { drips, automations }
}
