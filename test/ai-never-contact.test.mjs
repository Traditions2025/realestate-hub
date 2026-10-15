// The AI never-contact list (John, 2026-10-14): register somebody by email/phone BEFORE they
// exist in the Hub, and the AI must not reach them on any channel once they do.
//
// Tested against the REAL canSendSms, including force:true — the forced path is what texted
// Megan Walt twice, so a guard that only holds for scheduled sends is not a guard.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubncl_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const NC = await import('../server/ai-never-contact.js')
const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
const { canSendSms } = await import('../server/ai-followup/policy.js')
NC.initAiNeverContact()

let seq = 0
function mkClient({ email = null, phone = null, status = 'new' } = {}) {
  const id = 970000 + (++seq)
  db.run('INSERT OR REPLACE INTO clients (id, first_name, last_name, email, phone, status, type) VALUES (?,?,?,?,?,?,?)',
    [id, 'Test', 'Lead' + seq, email, phone, status, 'buyer'])
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}

/* ---------- the actual request ---------- */

test("Kurt and Lori's address is blocked before any lead record exists", () => {
  const r = NC.addAiNeverContact({
    email: 'kcoggon2@aol.com', name: 'Kurt and Lori Johnson',
    reason: 'listing alerts only — John, 2026-10-14', by: 'test',
  })
  assert.equal(r.ok, true)
  // Nothing in clients yet; the list is keyed on the address, not an id.
  assert.ok(!db.get('SELECT id FROM clients WHERE lower(email)=?', ['kcoggon2@aol.com']),
    'no client row exists for them yet')
  // Now the Sierra sync creates them.
  const c = mkClient({ email: 'kcoggon2@aol.com', phone: '(319) 555-0101' })
  const why = aiForbiddenReason(c)
  assert.ok(why, 'must be forbidden the moment the record appears')
  assert.match(why, /never-contact list/)
  assert.match(why, /listing alerts only/)
})

test('case and whitespace in the address do not get round it', () => {
  const c = mkClient({ email: '  KCoggon2@AOL.com  '.trim() })
  assert.ok(aiForbiddenReason({ ...c, email: ' KCoggon2@AOL.COM ' }), 'matched case-insensitively')
})

/* ---------- the send gate itself, not just the rule ---------- */

test('canSendSms refuses the AI channel for a listed lead', () => {
  const c = mkClient({ email: 'kcoggon2@aol.com', phone: '3195550102' })
  const d = canSendSms(c, { channel: 'ai', mode: 'proactive' })
  assert.equal(d.ok, false)
  assert.match(String(d.reason), /never-contact list/)
})

test('canSendSms refuses even with force:true — the path that double-texted Megan Walt', () => {
  const c = mkClient({ email: 'kcoggon2@aol.com', phone: '3195550103' })
  const d = canSendSms(c, { channel: 'ai', mode: 'proactive', force: true })
  assert.equal(d.ok, false, 'a forced AI send must still be refused')
  assert.match(String(d.reason), /never-contact list/)
})

test('a lead NOT on the list is unaffected — the guard is not a global outage', () => {
  const c = mkClient({ email: 'someone.else@example.com', phone: '3195559999' })
  assert.equal(aiForbiddenReason(c), null)
})

/* ---------- phone matching, for a lead that arrives without an email ---------- */

test('a phone registration matches however the number is formatted', () => {
  NC.addAiNeverContact({ phone: '(319) 431-7777', name: 'Phone only', reason: 'test', by: 'test' })
  for (const p of ['3194317777', '+1 319 431 7777', '1-319-431-7777', '(319)431-7777']) {
    const c = mkClient({ phone: p })
    assert.ok(aiForbiddenReason(c), `should match ${p}`)
  }
})

test('a short or junk phone number never matches', () => {
  assert.equal(NC.normalisePhone('431-7777'), '', '7 digits is not enough to identify anyone')
  assert.equal(NC.normalisePhone(''), '')
  const c = mkClient({ phone: '431-7777' })
  assert.equal(aiForbiddenReason(c), null)
})

test('a placeholder email never matches another placeholder', () => {
  assert.equal(NC.normaliseEmail('x@notvalidemail.com'), '')
  assert.equal(NC.normaliseEmail('not-an-email'), '')
  assert.equal(NC.normaliseEmail(null), '')
  const c = mkClient({ email: 'y@notvalidemail.com' })
  assert.equal(aiForbiddenReason(c), null, 'two placeholders are not the same person')
})

/* ---------- the list as a tool ---------- */

test('adding the same address twice does not duplicate it', () => {
  const a = NC.addAiNeverContact({ email: 'dupe@example.com', by: 'test' })
  const b = NC.addAiNeverContact({ email: 'DUPE@example.com', by: 'test' })
  assert.equal(b.already, true)
  assert.equal(b.id, a.id)
})

test('an entry with neither email nor phone is refused', () => {
  const r = NC.addAiNeverContact({ name: 'Nobody', by: 'test' })
  assert.equal(r.ok, false)
})

test('the list shows whether the lead has arrived yet', () => {
  const rows = NC.listAiNeverContact()
  const kurt = rows.find(r => r.email === 'kcoggon2@aol.com')
  assert.ok(kurt, 'Kurt and Lori are on the list')
  assert.equal(kurt.name, 'Kurt and Lori Johnson')
  assert.ok(kurt.matched_client_ids, 'and now match real client records')
})

test('removing an entry lets the AI reach them again', () => {
  const r = NC.addAiNeverContact({ email: 'temp@example.com', by: 'test' })
  const c = mkClient({ email: 'temp@example.com' })
  assert.ok(aiForbiddenReason(c), 'blocked while listed')
  NC.removeAiNeverContact(r.id)
  assert.equal(aiForbiddenReason(c), null, 'and allowed once removed')
})

/* ---------- the rule still covers everything it covered before ---------- */

test('the pre-existing never-rules are intact', () => {
  const closed = mkClient({ email: 'closed@example.com', status: 'closed' })
  assert.match(String(aiForbiddenReason(closed)), /past client/)
  const active = mkClient({ email: 'active@example.com', status: 'active' })
  assert.equal(aiForbiddenReason(active), null, "'active' must stay allowed — it is the hand-added default")
})
