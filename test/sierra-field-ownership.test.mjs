// Sierra sync field ownership (policy set 2026-09-11): the Hub is the master for
// contact/profile data. For EXISTING leads the sync may only write what Sierra
// genuinely owns — status (junk safety, NIM-guarded), opt-outs, tags, website
// visits, validation statuses, saved-search criteria, lender info, Sierra dates.
// It must NEVER overwrite Hub-owned fields: name, email, phone, address, type,
// budgets, agent assignment, Realist score/grade. New leads still insert in full.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { processLead } = await import('../server/sierra-helper.js')

let seq = 0
const sid = () => `own${Date.now()}${++seq}`

function mkHubClient(sierraId, fields = {}) {
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, phone, email, address, city, state, zip,
      budget_min, budget_max, agent_assigned, status, lead_score, lead_grade, sierra_lead_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fields.first_name || 'Hub', fields.last_name || 'Owned', fields.type || 'seller',
      fields.phone || '(319) 555-1111', fields.email || 'hub@example.com',
      fields.address || '10 Hub St', 'Cedar Rapids', 'IA', '52403',
      100000, 300000, 'Matt Smith', fields.status || 'new', fields.lead_score ?? '744', fields.lead_grade ?? 'A', String(sierraId)])
  return r.lastInsertRowid
}
const sierraLead = (id, over = {}) => ({
  id, firstName: 'SierraName', lastName: 'Stomp', email: 'sierra@example.com',
  phone: '(319) 555-9999', streetAddress: '99 Sierra Ave', city: 'Marion', state: 'IA', zip: '52302',
  leadType: 'buyer', leadStatus: 'Active', leadScore: 12, visits: 7,
  emailStatus: 'ValidAddress', phoneStatus: 'ValidPhone',
  assignedTo: { agentUserFirstName: 'Somebody', agentUserLastName: 'Else' },
  tags: ['From Sierra'], ...over,
})

test('sync never overwrites Hub-owned contact/profile fields on an existing lead', () => {
  const s = sid()
  const id = mkHubClient(s)
  processLead(sierraLead(s))
  const c = db.get('SELECT * FROM clients WHERE id=?', [id])
  assert.equal(c.first_name, 'Hub')
  assert.equal(c.last_name, 'Owned')
  assert.equal(c.email, 'hub@example.com')
  assert.equal(c.phone, '(319) 555-1111')
  assert.equal(c.address, '10 Hub St')
  assert.equal(c.type, 'seller')
  assert.equal(c.budget_min, 100000)
  assert.equal(c.budget_max, 300000)
  assert.equal(c.agent_assigned, 'Matt Smith')
  assert.equal(String(c.lead_score), '744', 'Realist score survives')
  assert.equal(c.lead_grade, 'A')
})

test('sync still writes what Sierra owns: status, visits, validation, tags', () => {
  const s = sid()
  const id = mkHubClient(s)
  processLead(sierraLead(s, { leadStatus: 'Junk' }))
  const c = db.get('SELECT * FROM clients WHERE id=?', [id])
  assert.equal(String(c.status).toLowerCase(), 'junk', 'Sierra-side junk flows in (safety)')
  assert.equal(c.visits, 7)
  assert.equal(c.email_status, 'ValidAddress')
  assert.ok(String(c.tags || '').includes('From Sierra'))
})

test('Not in Market still cannot be overwritten by Sierra status', () => {
  const s = sid()
  const id = mkHubClient(s, { status: 'not_in_market' })
  processLead(sierraLead(s, { leadStatus: 'Active' }))
  const c = db.get('SELECT status FROM clients WHERE id=?', [id])
  assert.equal(c.status, 'not_in_market')
})

test('sync BACKFILLS contact fields only when the Hub field is empty', () => {
  const s = sid()
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, sierra_lead_id, phone, email, address)
                    VALUES (?,?,?,?,?,NULL,NULL,NULL)`, ['Hub', 'Empty', 'buyer', 'new', String(s)])
  processLead(sierraLead(s))
  const c = db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
  assert.equal(c.phone, '(319) 555-9999', 'empty phone backfilled from Sierra')
  assert.equal(c.email, 'sierra@example.com', 'empty email backfilled')
  assert.equal(c.address, '99 Sierra Ave', 'empty address backfilled')
  // ...but a lead WITH Hub values keeps them (covered above) — run once more to
  // prove the backfilled values now stick even if Sierra changes again.
  processLead(sierraLead(s, { phone: '(319) 555-0000', email: 'other@example.com' }))
  const c2 = db.get('SELECT phone, email FROM clients WHERE id=?', [r.lastInsertRowid])
  assert.equal(c2.phone, '(319) 555-9999')
  assert.equal(c2.email, 'sierra@example.com')
})

test('backfill never uses a notvalidemail placeholder', () => {
  const s = sid()
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, sierra_lead_id, email)
                    VALUES (?,?,?,?,?,NULL)`, ['Hub', 'Empty2', 'buyer', 'new', String(s)])
  processLead(sierraLead(s, { email: 'x123@notvalidemail.com' }))
  const c = db.get('SELECT email FROM clients WHERE id=?', [r.lastInsertRowid])
  assert.equal(c.email, null)
})

test('new Sierra leads still insert with full contact data', () => {
  const s = sid()
  processLead(sierraLead(s))
  const c = db.get('SELECT * FROM clients WHERE sierra_lead_id=?', [String(s)])
  assert.ok(c, 'created')
  assert.equal(c.first_name, 'SierraName')
  assert.equal(c.phone, '(319) 555-9999')
  assert.equal(c.address, '99 Sierra Ave')
})
