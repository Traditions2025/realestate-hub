// Hub-side phone edits must survive the Sierra incremental sync (the guard that
// would have prevented the 2026-09-11 revert of 39 Forewarn-verified numbers).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { processLead } = await import('../server/sierra-helper.js')

let seq = 0
function mkSierraLead(sid, phone) {
  return { id: sid, firstName: 'Shadow', lastName: 'Test' + sid, phone, emailAddress: `shadow${sid}@example.com`, status: 'New' }
}
function mkClient(sid, phone, shadow) {
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, phone, phone_sierra_shadow, status, sierra_lead_id)
                    VALUES (?,?,?,?,?,?,?)`, ['Shadow', 'Test' + sid, 'seller', phone, shadow, 'new', String(sid)])
  return r.lastInsertRowid
}
const sid = () => `st${Date.now()}${++seq}`

test('sync keeps the Hub phone while Sierra still reports the replaced number', () => {
  const s = sid()
  const id = mkClient(s, '(319) 651-1418', '(319) 550-5663')   // Hub set new; shadow = old Sierra number
  processLead(mkSierraLead(s, '(319) 550-5663'))               // Sierra still has the old one
  const c = db.get('SELECT phone, phone_sierra_shadow FROM clients WHERE id=?', [id])
  assert.equal(c.phone, '(319) 651-1418', 'Hub number kept')
  assert.equal(c.phone_sierra_shadow, '(319) 550-5663', 'shadow retained')
})

test('a genuinely NEW Sierra number wins and clears the shadow', () => {
  const s = sid()
  const id = mkClient(s, '(319) 651-1418', '(319) 550-5663')
  processLead(mkSierraLead(s, '(319) 999-0000'))
  const c = db.get('SELECT phone, phone_sierra_shadow FROM clients WHERE id=?', [id])
  assert.equal(c.phone, '(319) 999-0000')
  assert.equal(c.phone_sierra_shadow, null)
})

test('an empty Sierra phone never wipes a Hub number', () => {
  const s = sid()
  const id = mkClient(s, '(563) 580-8865', null)
  processLead(mkSierraLead(s, null))
  const c = db.get('SELECT phone FROM clients WHERE id=?', [id])
  assert.equal(c.phone, '(563) 580-8865')
})

test('matching numbers clear a stale shadow', () => {
  const s = sid()
  const id = mkClient(s, '(319) 651-1418', '(319) 550-5663')
  processLead(mkSierraLead(s, '319-651-1418'))
  const c = db.get('SELECT phone_sierra_shadow FROM clients WHERE id=?', [id])
  assert.equal(c.phone_sierra_shadow, null)
})
