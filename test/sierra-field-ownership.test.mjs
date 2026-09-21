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

// ---- Adopt-don't-duplicate (2026-09-21): a lead John manually uploads to Sierra
// already exists in the Hub (FB intake). The sync must attach the Sierra id to the
// existing record instead of inserting a twin.
const uniq = () => String(Date.now()).slice(-7) + String(++seq)

test('manually-uploaded Sierra lead ADOPTS the matching Hub record by email (no duplicate)', () => {
  const s = sid()
  const em = `fbadopt${uniq()}@example.com`
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, email, source, tags)
    VALUES ('Rich','Adoptee','buyer','watch',?,'Facebook Listing Ad','["FB Ad: 510 Broadway Springville"]')`, [em])
  const hubId = r.lastInsertRowid
  const out = processLead(sierraLead(s, { firstName: 'Rich', lastName: 'Adoptee', email: em, phone: null, leadStatus: 'New', tags: [] }))
  assert.equal(out, 'updated')
  assert.equal(db.get('SELECT COUNT(*) n FROM clients WHERE sierra_lead_id=?', [String(s)]).n, 1, 'exactly one record carries the sierra id')
  const c = db.get('SELECT * FROM clients WHERE id=?', [hubId])
  assert.equal(c.sierra_lead_id, String(s), 'sierra id attached to the existing Hub record')
  assert.equal(c.status, 'watch', 'adoption keeps the Hub status (upload default New must not clobber Watch)')
  assert.ok(String(c.tags).includes('FB Ad: 510 Broadway Springville'), 'Hub-native FB tag survives the sync tag write')
})

test('adoption by phone requires the SAME first name — household lines never collapse', () => {
  const s = sid()
  const digits = '555' + uniq()          // 10 fake digits
  const ph = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  db.run(`INSERT INTO clients (first_name, last_name, type, status, phone) VALUES ('Jane','Household','buyer','new',?)`, [ph])
  processLead(sierraLead(s, { firstName: 'John', lastName: 'Household', email: null, phone: ph, tags: [] }))
  const c = db.get('SELECT id, first_name FROM clients WHERE sierra_lead_id=?', [String(s)])
  assert.ok(c, 'inserted as a NEW record')
  assert.equal(c.first_name, 'John', 'Jane was not adopted onto')
})

test('adoption by phone + same first name works when there is no email', () => {
  const s = sid()
  const digits = '555' + uniq()
  const ph = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, phone, tags) VALUES ('Luis','Sameline','buyer','new',?, '["FB Ad: 510 Broadway Springville"]')`, [ph])
  processLead(sierraLead(s, { firstName: 'Luis', lastName: 'Sameline', email: null, phone: digits, tags: [] }))
  const c = db.get('SELECT sierra_lead_id, tags FROM clients WHERE id=?', [r.lastInsertRowid])
  assert.equal(c.sierra_lead_id, String(s))
  assert.ok(String(c.tags).includes('FB Ad'), 'FB tag kept')
})

test('later regular sync passes UNION Hub-native FB tags with Sierra tags instead of replacing', () => {
  const s = sid()
  mkHubClient(s, { first_name: 'Tagkeep' })
  db.run("UPDATE clients SET tags='[\"FB Ad: 510 Broadway Springville\",\"Random Hub Tag\"]' WHERE sierra_lead_id=?", [String(s)])
  processLead(sierraLead(s, { tags: ['From Sierra'] }))
  const c = db.get('SELECT tags FROM clients WHERE sierra_lead_id=?', [String(s)])
  assert.ok(String(c.tags).includes('From Sierra'), 'Sierra tag written')
  assert.ok(String(c.tags).includes('FB Ad: 510 Broadway Springville'), 'FB campaign tag preserved')
  assert.ok(!String(c.tags).includes('Random Hub Tag'), 'non-campaign Hub tags still follow Sierra (existing policy)')
})
