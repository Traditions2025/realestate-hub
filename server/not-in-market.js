// ============================================================================
// NOT IN MARKET — centralized status-transition service.
//
// Meaning: we CONNECTED with this person and they explicitly confirmed no
// current buying/selling intent ("we're not moving anymore"). NOT a cold-lead
// or no-response status — inactivity alone never qualifies.
//
// Entering the status guarantees, server-side and idempotently:
//   active drips/automations stopped · scheduled sales texts cancelled ·
//   HUB AI paused + pending AI actions cancelled · current intent -> LOW ·
//   open sales-follow-up tasks closed · ONE annual human recheck task created.
// History and intelligence are always preserved. An explicit "never contact
// me" is NOT this status — that's the opt-out/exclusion path, no annual task.
// ============================================================================
import db from './database.js'
import { stopSequencesForClient } from './lead-sequences.js'

const nowIso = () => new Date().toISOString()
export const ANNUAL_TASK_TITLE = 'Annual Not in Market Recheck'
const log = (cid, details) => { try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['not_in_market', 'client', cid, details]) } catch {} }

export function executeNotInMarketTransition(clientId, { actor = 'system' } = {}) {
  const cid = Number(clientId)
  const c = db.get('SELECT id, first_name, last_name, agent_assigned FROM clients WHERE id=?', [cid])
  if (!c) return null
  const now = nowIso()
  const summary = { drips: 0, automations: 0, texts_cancelled: 0, ai_actions_cancelled: 0, tasks_closed: 0, annual_task: null, tx_conflict: false }

  // Active transaction = the status change may be a mistake; NEVER touch the
  // transaction workflow or its tasks. Sales nurture still stops (it's wrong for
  // someone under contract regardless), and the conflict is flagged for review.
  const activeTx = db.get(`SELECT id, property_address FROM transactions WHERE client_id=?
    AND property_status NOT IN ('Closed') AND property_status NOT LIKE 'Terminated%' AND property_status NOT LIKE 'Cancel%' LIMIT 1`, [cid])
  if (activeTx) { summary.tx_conflict = true; log(cid, `CONFLICT: moved to Not in Market with an ACTIVE transaction (${activeTx.property_address}) — transaction workflow preserved, review the status change`) }

  // 1. Drips + automations (marked removed; history/analytics preserved).
  const seq = stopSequencesForClient(cid, 'Not in Market — confirmed no current buying/selling intent')
  summary.drips = seq.drips; summary.automations = seq.automations

  // 2. Future scheduled texts.
  summary.texts_cancelled = db.run("UPDATE scheduled_texts SET status='canceled' WHERE client_id=? AND status='scheduled'", [cid]).changes || 0

  // 3. HUB AI off + pending AI actions cancelled (memory/history untouched).
  db.run(`INSERT INTO ai_lead_state (client_id, ai_enabled, ai_state, ai_state_changed_at)
          VALUES (?, 0, 'AI_DISABLED', ?)
          ON CONFLICT(client_id) DO UPDATE SET ai_enabled=0, ai_state='AI_DISABLED', ai_state_changed_at=excluded.ai_state_changed_at, updated_at=excluded.ai_state_changed_at`, [cid, now])
  summary.ai_actions_cancelled = db.run("UPDATE ai_scheduled_actions SET state='canceled', canceled_at=?, error='not in market', updated_at=? WHERE client_id=? AND state='pending'", [now, now, cid]).changes || 0

  // 4. Current intent -> LOW (peak/history live in ai_intent_history — untouched).
  try { db.run("UPDATE lead_intelligence SET intent_score=0, intent_level='LOW' WHERE client_id=?", [cid]) } catch {}

  // 5. Open SALES follow-up tasks: close only clearly sales-patterned ones; admin,
  //    transaction and unrelated manual tasks are preserved. Skipped entirely when
  //    an active transaction exists.
  if (!activeTx) {
    const SALES_RE = /follow[- ]?up|check[- ]?in|call|text|tour|showing|valuation|cma|financ|pre[- ]?approv|reconnect|nurtur/i
    for (const t of db.all("SELECT id, title FROM tasks WHERE related_type='client' AND related_id=? AND status NOT IN ('done','completed','cancelled','canceled')", [cid])) {
      if (t.title === ANNUAL_TASK_TITLE) continue
      if (SALES_RE.test(String(t.title || ''))) {
        db.run("UPDATE tasks SET status='done', completed_at=?, notes_log=COALESCE(notes_log,'') || ?, updated_at=? WHERE id=?",
          [now, '\n[auto] Closed: lead moved to Not in Market (no current buying/selling intent)', now, t.id])
        summary.tasks_closed++
      }
    }
  }

  // 6. THE one intentional future touch: an annual human recheck, one year out.
  //    Idempotent — an existing open annual task is reused, never duplicated.
  const existing = db.get("SELECT id, due_date FROM tasks WHERE related_type='client' AND related_id=? AND title=? AND status NOT IN ('done','completed','cancelled','canceled') LIMIT 1", [cid, ANNUAL_TASK_TITLE])
  if (existing) {
    summary.annual_task = { id: existing.id, due_date: existing.due_date, reused: true }
  } else {
    const due = new Date(); due.setFullYear(due.getFullYear() + 1)
    const dueDate = due.toISOString().slice(0, 10)
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim() || `client #${cid}`
    const r = db.run(`INSERT INTO tasks (title, description, priority, status, due_date, assigned_to, category, related_type, related_id)
                      VALUES (?,?,?,?,?,?,?,?,?)`,
      [ANNUAL_TASK_TITLE, `${name} confirmed no current buying/selling intent. Reconnect, ask how life and the house are treating them, and re-check plans.`,
        'low', 'todo', dueDate, c.agent_assigned || 'Matt Smith', 'follow-up', 'client', cid])
    summary.annual_task = { id: r.lastInsertRowid, due_date: dueDate, reused: false }
  }

  db.run('UPDATE clients SET not_in_market_at=?, updated_at=? WHERE id=?', [now, now, cid])

  log(cid, `Moved to Not in Market (${actor}): ${summary.drips} drip(s) + ${summary.automations} automation(s) stopped, `
    + `${summary.texts_cancelled} scheduled text(s) + ${summary.ai_actions_cancelled} AI action(s) cancelled, AI paused, `
    + `${summary.tasks_closed} sales task(s) closed, annual recheck ${summary.annual_task.reused ? 'already scheduled' : 'created'} for ${summary.annual_task.due_date}`)

  import('./followup-coverage.js').then(m => m.recalcCoverage(cid, { actorType: 'status' })).catch(() => {})
  return summary
}

// Leaving Not in Market for an active stage: retire the annual recheck (a real
// follow-up plan replaces it) and let coverage re-evaluate. Previous campaigns
// are NOT auto-restarted — humans/AI decide the right plan from current intent.
export function exitNotInMarket(clientId, newStatus) {
  const cid = Number(clientId)
  const r = db.run("UPDATE tasks SET status='done', completed_at=?, notes_log=COALESCE(notes_log,'') || ? WHERE related_type='client' AND related_id=? AND title=? AND status NOT IN ('done','completed','cancelled','canceled')",
    [nowIso(), `\n[auto] Closed: lead moved out of Not in Market to ${newStatus}`, cid, ANNUAL_TASK_TITLE])
  if (r.changes) log(cid, `Left Not in Market -> ${newStatus}: annual recheck task closed; follow-up plan now driven by the new status`)
  import('./followup-coverage.js').then(m => m.recalcCoverage(cid, { actorType: 'status' })).catch(() => {})
  return { annual_closed: r.changes || 0 }
}
