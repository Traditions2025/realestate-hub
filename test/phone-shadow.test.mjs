// Hub phone edits must survive the Sierra sync. Since the 2026-09-11 field-
// ownership change, the sync NEVER writes phone on an existing lead (superseding
// the short-lived phone_sierra_shadow guard, whose column remains as an audit
// trail of replaced numbers). These tests pin that invariant from the phone's
// perspective; test/sierra-field-ownership.test.mjs covers the full field list.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { processLead } = await import('../server/sierra-helper.js')

let seq = 0
function mkSierraLead(sid, phone) {
  return { id: sid, firstName: 'Shadow', lastName: 'Test' + sid, phone, email: `shadow${sid}@example.com`, leadStatus: 'New' }
}
function mkClient(sid, phone) {
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, phone, status, sierra_lead_id)
                    VALUES (?,?,?,?,?,?)`, ['Shadow', 'Test' + sid, 'seller', phone, 'new', String(sid)])
  return r.lastInsertRowid
}
const sid = () => `st${Date.now()}${++seq}`

test('sync keeps the Hub phone even when Sierra reports the old (replaced) number', () => {
  const s = sid()
  const id = mkClient(s, '(319) 651-1418')
  processLead(mkSierraLead(s, '(319) 550-5663'))
  assert.equal(db.get('SELECT phone FROM clients WHERE id=?', [id]).phone, '(319) 651-1418')
})

test('sync keeps the Hub phone even when Sierra reports a brand-new number (Hub is master)', () => {
  const s = sid()
  const id = mkClient(s, '(319) 651-1418')
  processLead(mkSierraLead(s, '(319) 999-0000'))
  assert.equal(db.get('SELECT phone FROM clients WHERE id=?', [id]).phone, '(319) 651-1418')
})

test('an empty Sierra phone never wipes a Hub number', () => {
  const s = sid()
  const id = mkClient(s, '(563) 580-8865')
  processLead(mkSierraLead(s, null))
  assert.equal(db.get('SELECT phone FROM clients WHERE id=?', [id]).phone, '(563) 580-8865')
})
