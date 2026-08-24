// P1-6: lead routing engine — matching, round-robin/weighted, sticky, enable gate.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubroute_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { routeLead, routeUnassigned, routingEnabled } = await import('../server/routing.js')

let seq = 700
const mkClient = (over = {}) => {
  const r = db.run('INSERT INTO clients (first_name,last_name,phone,type,status,source,city,zip,budget_max,agent_assigned) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['C' + (seq++), 'L', '+1319' + (seq), over.type || 'buyer', over.status || 'active', over.source || 'Website', over.city || 'Marion', over.zip || '52302', over.budget_max || 400000, over.agent_assigned || null])
  return db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
}
const addRule = (o) => db.run('INSERT INTO routing_rules (name, enabled, priority, conditions_json, method, targets_json) VALUES (?,?,?,?,?,?)',
  [o.name, o.enabled ?? 1, o.priority ?? 100, JSON.stringify(o.conditions || {}), o.method || 'round_robin', JSON.stringify(o.targets || [])]).lastInsertRowid
const fresh = (id) => db.get('SELECT * FROM clients WHERE id=?', [id])

test('routing OFF by default: nothing routes', () => {
  assert.equal(routingEnabled(), false)
  addRule({ name: 'all', targets: [{ agent: 'Matt' }] })
  const c = mkClient()
  assert.equal(routeLead(fresh(c.id)).routed, false)
  db.run('DELETE FROM routing_rules')
})

test('round-robin rotates across agents; history is logged', () => {
  db.setSetting('routing_enabled', '1')
  addRule({ name: 'rr', priority: 10, method: 'round_robin', targets: [{ agent: 'Matt' }, { agent: 'Hunter' }] })
  const c1 = mkClient(), c2 = mkClient(), c3 = mkClient()
  assert.equal(routeLead(fresh(c1.id)).agent, 'Matt')
  assert.equal(routeLead(fresh(c2.id)).agent, 'Hunter')
  assert.equal(routeLead(fresh(c3.id)).agent, 'Matt')
  assert.equal(fresh(c1.id).agent_assigned, 'Matt')
  assert.ok(db.get('SELECT id FROM routing_history WHERE client_id=?', [c1.id]))
  db.run('DELETE FROM routing_rules'); db.run('DELETE FROM routing_history')
})

test('a manual assignment is sticky (never auto-reassigned)', () => {
  addRule({ name: 'rr', method: 'round_robin', targets: [{ agent: 'Matt' }] })
  const c = mkClient({ agent_assigned: 'John' })
  const r = routeLead(fresh(c.id))
  assert.equal(r.routed, false); assert.match(r.reason, /already assigned/)
  db.run('DELETE FROM routing_rules')
})

test('weighted routing honors weights', () => {
  addRule({ name: 'w', method: 'weighted', targets: [{ agent: 'Matt', weight: 2 }, { agent: 'Hunter', weight: 1 }] })
  const agents = [mkClient(), mkClient(), mkClient()].map(c => routeLead(fresh(c.id)).agent)
  assert.deepEqual(agents, ['Matt', 'Matt', 'Hunter'])
  db.run('DELETE FROM routing_rules')
})

test('conditions filter which leads a rule matches (city + price)', () => {
  addRule({ name: 'marion-hi', priority: 5, method: 'specific', conditions: { cities: ['Marion'], price_min: 500000 }, targets: [{ agent: 'Matt' }] })
  const low = mkClient({ city: 'Marion', budget_max: 300000 })
  const other = mkClient({ city: 'Cedar Rapids', budget_max: 700000 })
  const hit = mkClient({ city: 'Marion', budget_max: 600000 })
  assert.equal(routeLead(fresh(low.id)).routed, false)
  assert.equal(routeLead(fresh(other.id)).routed, false)
  assert.equal(routeLead(fresh(hit.id)).agent, 'Matt')
  db.run('DELETE FROM routing_rules')
})

test('routeUnassigned dry-run does not assign; off returns not-ok', () => {
  addRule({ name: 'all', method: 'specific', targets: [{ agent: 'Matt' }] })
  const c = mkClient()
  const dry = routeUnassigned({ dryRun: true })
  assert.equal(dry.ok, true); assert.ok(dry.routed >= 1)
  assert.equal(fresh(c.id).agent_assigned, null, 'dry-run changed nothing')
  db.setSetting('routing_enabled', '0')
  assert.equal(routeUnassigned({ dryRun: false }).ok, false)
  db.setSetting('routing_enabled', '1'); db.run('DELETE FROM routing_rules')
})
