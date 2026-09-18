// New-lead default agent rule (John, 2026-09-18): any lead added to the Hub with
// no agent gets Matt Smith. Only EMPTY agent_assigned is filled (a deliberate
// assignment to anyone else stays), and only leads created on/after the rule
// epoch are touched — the historical backlog is never mass-reassigned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { enforceDefaultAgentAssignment, DEFAULT_AGENT, RULE_EPOCH } = await import('../server/agent-assignment.js')

const seeded = []
function mk(fields = {}) {
  const cols = {
    first_name: 'AgentRule', last_name: 'Test' + Date.now() + Math.floor(Math.random() * 1e6),
    type: 'seller', status: 'new', source: 'Expired/Cancelled Mls',
    agent_assigned: fields.agent_assigned === undefined ? null : fields.agent_assigned,
    created_at: fields.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
  const keys = Object.keys(cols)
  const r = db.run(`INSERT INTO clients (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => cols[k]))
  seeded.push(r.lastInsertRowid)
  return r.lastInsertRowid
}
const agentOf = (id) => db.get('SELECT agent_assigned FROM clients WHERE id=?', [id]).agent_assigned

test('unassigned new lead gets Matt Smith', () => {
  const id = mk()
  const res = enforceDefaultAgentAssignment()
  assert.ok(res.count >= 1)
  assert.equal(agentOf(id), DEFAULT_AGENT)
})

test('empty-string assignment is treated as unassigned', () => {
  const id = mk({ agent_assigned: '' })
  enforceDefaultAgentAssignment()
  assert.equal(agentOf(id), DEFAULT_AGENT)
})

test('a deliberate assignment to someone else is never overwritten', () => {
  const id = mk({ agent_assigned: 'Hunter Caves' })
  enforceDefaultAgentAssignment()
  assert.equal(agentOf(id), 'Hunter Caves')
})

test('leads created before the rule epoch are left alone', () => {
  const id = mk({ created_at: '2026-09-01T00:00:00.000Z' })
  assert.ok('2026-09-01' < RULE_EPOCH)
  enforceDefaultAgentAssignment()
  assert.equal(agentOf(id), null)
})

test('dryRun counts but writes nothing', () => {
  const id = mk()
  const res = enforceDefaultAgentAssignment({ dryRun: true })
  assert.ok(res.count >= 1)
  assert.equal(agentOf(id), null)
  enforceDefaultAgentAssignment()   // then the real pass assigns it
  assert.equal(agentOf(id), DEFAULT_AGENT)
})

test('cleanup seeded rows', () => {
  for (const id of seeded) db.run('DELETE FROM clients WHERE id=?', [id])
})
