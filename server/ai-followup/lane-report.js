// BUYER LANE REPORTING (John, 2026-10-27, Part 37 step 14).
//
// Ownership made the follow-up system legible, and then immediately made a new kind of bug
// possible: a lead can be correctly owned by a lane that has nothing to say. That is what
// happened to FB_BUYER_PHASE_2 — the owner was assigned before the lane existed, so every
// finished listing campaign parked its lead somewhere permanently silent. Nothing looked
// wrong. The owner was right, the gate was right, the lead just never heard from anyone
// again.
//
// A count of leads per owner would not have caught it. What catches it is asking, for each
// owned lead, whether anything is actually scheduled to happen. That is `silentLeads`, and
// it is the report worth looking at.
import db from '../database.js'

const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()

/** Every owner with a live headcount. */
export function ownershipBreakdown() {
  try {
    return db.all(`SELECT COALESCE(communication_owner,'NONE') owner, COUNT(*) n
                   FROM clients WHERE merged_into IS NULL
                   GROUP BY owner ORDER BY n DESC`)
  } catch { return [] }
}

/** How much of the history we can actually see, which bounds what copy may claim. */
export function historyBreakdown() {
  try {
    return db.all(`SELECT COALESCE(history_completeness,'unknown') completeness, COUNT(*) n
                   FROM clients WHERE merged_into IS NULL
                   GROUP BY completeness ORDER BY n DESC`)
  } catch { return [] }
}

// Owners that are supposed to be sending something. TRANSACTIONAL and HUMAN_OWNED are
// silent on purpose — a person is handling those — and NONE is junk/DNC/closed.
const SENDING_OWNERS = [
  'BEHAVIOR_REACTIVATION', 'FB_LISTING_PHASE_1', 'FB_BUYER_PHASE_2',
  'GENERAL_NEW_BUYER', 'COLD_KNOWN_CONNECTED', 'COLD_HISTORY_UNKNOWN',
]

/**
 * THE BLACK-HOLE REPORT. Leads owned by a lane that is meant to be talking to them, with
 * nothing scheduled and nothing sent recently.
 *
 * A handful is normal — a lane between steps, a lead who just entered one. A cluster on a
 * single owner means that lane has stopped working, and the count is the number of people
 * it has stopped working for.
 */
export function silentLeads({ quietDays = 30, limit = 200 } = {}) {
  const since = iso(Date.now() - quietDays * DAY)
  const marks = SENDING_OWNERS.map(() => '?').join(',')
  let rows = []
  try {
    rows = db.all(`
      SELECT c.id, c.first_name, c.last_name, c.communication_owner owner, c.communication_owner_at since,
             (SELECT MAX(occurred_at) FROM communications m
               WHERE m.client_id = c.id AND m.direction='outgoing') last_out
      FROM clients c
      WHERE c.merged_into IS NULL
        AND c.communication_owner IN (${marks})
        AND NOT EXISTS (SELECT 1 FROM ai_scheduled_actions a
                         WHERE a.client_id = c.id AND a.state='pending')
        AND NOT EXISTS (SELECT 1 FROM communications m
                         WHERE m.client_id = c.id AND m.direction='outgoing' AND m.occurred_at >= ?)
      ORDER BY c.communication_owner, c.id
      LIMIT ?`, [...SENDING_OWNERS, since, Number(limit)])
  } catch { return { ok: false, reason: 'query failed' } }

  const byOwner = {}
  for (const r of rows) byOwner[r.owner] = (byOwner[r.owner] || 0) + 1
  return { ok: true, quietDays, total: rows.length, byOwner, leads: rows }
}

/**
 * Why automated messages did NOT go out, over a window. The gate refusing things is the
 * system working; the same reason appearing thousands of times is a lane misrouted.
 */
export function gateRefusals({ days = 7, limit = 40 } = {}) {
  const since = iso(Date.now() - days * DAY)
  try {
    return db.all(`SELECT state, COALESCE(error,'(none)') reason, action_type, COUNT(*) n
                   FROM ai_scheduled_actions
                   WHERE updated_at >= ? AND state IN ('canceled','failed')
                   GROUP BY state, reason, action_type
                   ORDER BY n DESC LIMIT ?`, [since, Number(limit)])
  } catch { return [] }
}

/** What each lane actually sent over a window, so a silent lane is visible next to a busy one. */
export function laneActivity({ days = 7 } = {}) {
  const since = iso(Date.now() - days * DAY)
  try {
    return db.all(`SELECT COALESCE(cl.communication_owner,'NONE') owner, COUNT(*) sent
                   FROM communications m JOIN clients cl ON cl.id = m.client_id
                   WHERE m.direction='outgoing' AND m.channel='text'
                     AND COALESCE(m.sent_by_type,'') != 'human' AND m.occurred_at >= ?
                   GROUP BY owner ORDER BY sent DESC`, [since])
  } catch { return [] }
}

/** Everything in one call, for the Reporting tab. */
export function buyerLaneReport({ quietDays = 30, days = 7 } = {}) {
  const silent = silentLeads({ quietDays })
  return {
    generated_at: new Date().toISOString(),
    ownership: ownershipBreakdown(),
    history: historyBreakdown(),
    activity: laneActivity({ days }),
    refusals: gateRefusals({ days }),
    silent: silent.ok ? { total: silent.total, byOwner: silent.byOwner, sample: silent.leads.slice(0, 25) } : silent,
  }
}
