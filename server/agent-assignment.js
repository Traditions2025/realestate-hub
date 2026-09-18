// John's rule (2026-09-18): every lead ADDED to the Hub belongs to Matt Smith.
// Sierra-sourced leads already arrive with his assignment; master-file creates,
// manual adds, imports and inbox-created contacts were landing unassigned.
//
// Forward-looking: only leads created on/after RULE_EPOCH are touched (the epoch
// reaches back one day to catch the C/E batch added just before the rule shipped).
// Only an EMPTY agent_assigned is filled — a deliberate assignment to anyone else
// (Hunter, John) is a human's call and stays. Runs on every scheduler tick, so any
// intake path — sheet sync, CSV import, manual add, inbox unknown-caller — is
// covered within ~10 minutes without having to enumerate them all.
import db from './database.js'

export const DEFAULT_AGENT = 'Matt Smith'
export const RULE_EPOCH = '2026-09-17'

export function enforceDefaultAgentAssignment({ dryRun = false } = {}) {
  const rows = db.all(
    `SELECT id, first_name, last_name, source, created_at FROM clients
     WHERE merged_into IS NULL AND (agent_assigned IS NULL OR agent_assigned = '')
       AND created_at >= ?`, [RULE_EPOCH])
  if (!dryRun && rows.length) {
    const now = new Date().toISOString()
    for (const r of rows) {
      db.run("UPDATE clients SET agent_assigned = ?, updated_at = ? WHERE id = ? AND (agent_assigned IS NULL OR agent_assigned = '')",
        [DEFAULT_AGENT, now, r.id])
    }
    console.log(`[agent-assignment] assigned ${rows.length} lead(s) to ${DEFAULT_AGENT}`)
  }
  return {
    count: rows.length, dryRun, agent: DEFAULT_AGENT, epoch: RULE_EPOCH,
    sample: rows.slice(0, 25).map(r => ({ id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(), source: r.source, created_at: r.created_at })),
  }
}
