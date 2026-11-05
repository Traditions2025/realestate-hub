// Sierra opening a SECOND lead for somebody we already have (John, 2026-11-05).
//
// Barney Foley is a past client, #108, Sierra lead 2326815. He filled in the home value
// form and Sierra minted lead 2588214 as a brand-new buyer. The Hub mirrored it into
// #46176 - no history, status new, type buyer - and the AI texted him a buyer opener six
// minutes later.
//
// Adoption existed but only looked at Hub records with NO Sierra id, because it was built
// for Facebook ad leads born in the Hub. #108 already had one, so it was never a
// candidate despite an exact phone and name match.
//
// A Hub record can now answer to more than one Sierra id, so the second lead lands on the
// person we already know rather than beside them. Re-pointing instead would orphan the
// original lead, and its next sync would create the very duplicate this prevents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { processLead } = await import('../server/sierra-helper.js')

let seq = 0
// Unique per CALL. Slicing a timestamp to a fixed width handed every test the same id,
// so the "second" lead was found by sierra_lead_id and adoption never ran.
const sid = () => '9' + String(Date.now()).slice(-7) + String(++seq).padStart(3, '0')
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')


// A number no other record holds. A fixed prefix plus four digits collides with leads
// left behind by other suites in the shared test database, and a collision reads as a
// duplicate - which is the very thing these tests are about.
function freePhone(prefix) {
  for (let i = 0; i < 500; i++) {
    const p = `(319) ${prefix}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`
    if (!db.get('SELECT 1 x FROM clients WHERE phone = ?', [p])) return p
  }
  throw new Error('no free phone for the fixture')
}

const lead = (id, over = {}) => ({
  id, firstName: 'Barney', lastName: 'Foley', leadStatus: 'New', leadType: 'buyer',
  email: null, phone: null, tags: [], ...over,
})
const mkPastClient = (over = {}) => db.run(
  `INSERT INTO clients (first_name, last_name, type, status, phone, email, sierra_lead_id, tags)
   VALUES (?,?,?,?,?,?,?,?)`,
  [over.first || 'Barney', over.last || 'Foley', 'seller', over.status || 'closed',
    over.phone || null, over.email || null, over.sierra || sid(), '["FUB Stage: Past Client"]'],
).lastInsertRowid

test('a second Sierra lead for the same person does NOT create a twin', () => {
  const phone = freePhone('423')
  const first = mkPastClient({ phone })
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  const second = sid()
  processLead(lead(second, { phone, leadStatus: 'New' }))
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before, 'no new record')
  const c = db.get('SELECT status, type, alt_sierra_ids FROM clients WHERE id=?', [first])
  assert.match(String(c.alt_sierra_ids), new RegExp(second), 'the new lead id is attached to him')
  assert.equal(c.status, 'closed', 'he is still a past client, so the AI leaves him alone')
})

test('the original Sierra id still resolves to him', () => {
  // Re-pointing would orphan the first lead and its next sync would make the duplicate.
  const phone = freePhone('423')
  const original = sid()
  const first = mkPastClient({ phone, sierra: original })
  processLead(lead(sid(), { phone }))
  const c = db.get('SELECT id FROM clients WHERE sierra_lead_id=?', [original])
  assert.equal(c.id, first, 'the first id still points at him')
})

test('the second id resolves to him too, on every later sync', () => {
  const phone = freePhone('423')
  const first = mkPastClient({ phone })
  const second = sid()
  processLead(lead(second, { phone }))
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  processLead(lead(second, { phone, leadStatus: 'Active' }))   // sync it again
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before, 'still no twin on the second pass')
  assert.equal(db.get('SELECT COUNT(*) n FROM clients WHERE sierra_lead_id=?', [second]).n, 0,
    'it did not re-point either')
})

test('an email match is enough on its own', () => {
  const email = `barney${uniq()}@unitypoint.org`
  const first = mkPastClient({ email })
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  processLead(lead(sid(), { email }))
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before)
  assert.equal(db.get('SELECT status FROM clients WHERE id=?', [first]).status, 'closed')
})

// ---- the line that must NOT be crossed -------------------------------------------

test('a household sharing a phone is never collapsed', () => {
  // Martin Cram and Katie Cram are two people on one number, and there are hundreds of
  // those pairs in the file. Same surname is not the same person.
  const phone = freePhone('431')
  mkPastClient({ first: 'Martin', last: 'Cram', phone })
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  const katie = sid()
  processLead(lead(katie, { firstName: 'Katie', lastName: 'Cram', phone }))
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before + 1, 'Katie gets her own record')
  assert.ok(db.get('SELECT id FROM clients WHERE sierra_lead_id=?', [katie]), 'and it is hers')
})

test('a shared line with a different surname is two people as well', () => {
  const phone = freePhone('366')
  mkPastClient({ first: 'Kim', last: 'McIrvin', phone })
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  processLead(lead(sid(), { firstName: 'Brandon', lastName: 'Scheel', phone }))
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before + 1)
})

test('a genuinely new person is still inserted', () => {
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  const s = sid()
  processLead(lead(s, { firstName: 'Nobody', lastName: 'Known' + uniq(), phone: freePhone('999'), email: `new${uniq()}@example.com` }))
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before + 1)
  assert.ok(db.get('SELECT id FROM clients WHERE sierra_lead_id=?', [s]))
})

test('a merged-away record is never adopted onto', () => {
  const phone = freePhone('423')
  const dead = mkPastClient({ phone })
  db.run('UPDATE clients SET merged_into=? WHERE id=?', [1, dead])
  const before = db.get('SELECT COUNT(*) n FROM clients').n
  const s = sid()
  processLead(lead(s, { phone }))
  assert.equal(db.get('SELECT COUNT(*) n FROM clients').n, before + 1, 'a new record, not the archived one')
  assert.equal(db.get('SELECT alt_sierra_ids FROM clients WHERE id=?', [dead]).alt_sierra_ids, null)
})
