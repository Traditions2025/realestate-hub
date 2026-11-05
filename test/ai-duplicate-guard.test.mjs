// The AI stays out of ambiguity (John, 2026-11-05).
//
// Barney Foley is a past client, #108. Sierra opened a second lead for him, the Hub
// mirrored it into #46176 as a brand-new buyer, and the AI texted him a buyer opener six
// minutes later. Nothing was broken: that record really was a new buyer lead. The history
// was simply on the other one, and the status that would have stopped it - closed - was
// on the other one too.
//
// So a lead that might be somebody we already know is not a lead the AI may speak to.
// Refused at ENROLMENT so it is never queued, and again at SEND time, because a twin can
// appear after a lead is already enrolled - which is exactly how Barney's arrived.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { duplicateTwin, aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
const { evaluateAiEnrollmentEligibility } = await import('../server/ai-enrollment.js')

let seq = 0
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

const mk = (o = {}) => {
  const id = db.run(
    'INSERT INTO clients (first_name, last_name, type, status, phone, email) VALUES (?,?,?,?,?,?)',
    [o.first || 'Barney', o.last || 'Foley', o.type || 'buyer', o.status || 'new', o.phone ?? null, o.email ?? null],
  ).lastInsertRowid
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}

test('a lead sharing a phone with another record is a possible duplicate', () => {
  const phone = freePhone('423')
  const past = mk({ status: 'closed', phone })
  const twin = mk({ status: 'new', phone })
  const d = duplicateTwin(twin)
  assert.ok(d, 'found')
  assert.equal(d.id, past.id)
  assert.equal(d.on, 'phone number')
  assert.equal(d.status, 'closed', 'and it reports what the other record is')
})

test('a shared email counts too', () => {
  const email = `barney${uniq()}@unitypoint.org`
  const past = mk({ status: 'closed', email })
  assert.equal(duplicateTwin(mk({ status: 'new', email })).id, past.id)
})

test('the AI refuses to text a possible duplicate', () => {
  const phone = freePhone('423')
  mk({ status: 'closed', phone })
  const why = aiForbiddenReason(mk({ status: 'new', phone }))
  assert.ok(why, 'forbidden')
  assert.match(why, /possibly the same person/)
  assert.match(why, /phone number/)
})

test('and refuses to enrol one in the first place', () => {
  const phone = freePhone('423')
  mk({ status: 'closed', phone })
  const r = evaluateAiEnrollmentEligibility(mk({ status: 'new', phone }).id)
  assert.equal(r.decision, 'excluded')
  assert.equal(r.reason_code, 'POSSIBLE_DUPLICATE')
  assert.match(r.reason, /shares a phone number with #/)
})

test('the check is wider than the merge rule, on purpose', () => {
  // sierra-helper will NOT join Martin and Katie Cram - different first names on one
  // line is a household. The AI still stays away: declining to text is free, and the
  // other record might be the past client.
  const phone = freePhone('431')
  mk({ first: 'Martin', last: 'Cram', status: 'closed', phone })
  const katie = mk({ first: 'Katie', last: 'Cram', status: 'new', phone })
  assert.ok(duplicateTwin(katie), 'a shared line is enough for the AI to hold off')
  assert.match(aiForbiddenReason(katie), /possibly the same person/)
})

// ---- what must NOT be treated as a duplicate -------------------------------------

test('a lead with nobody else on their number is fine', () => {
  const c = mk({ status: 'new', phone: freePhone('999'), email: `solo${uniq()}@example.com` })
  assert.equal(duplicateTwin(c), null)
  assert.ok(!/possibly the same person/.test(aiForbiddenReason(c) || ''))
})

test('a merged-away twin does not count', () => {
  // It has already been resolved; blocking on it would silence the survivor forever.
  const phone = freePhone('423')
  const dead = mk({ status: 'closed', phone })
  db.run('UPDATE clients SET merged_into=? WHERE id=?', [1, dead.id])
  assert.equal(duplicateTwin(mk({ status: 'new', phone })), null)
})

test('a placeholder number is not a shared number', () => {
  // Thousands of records carry a fake line. Treating that as a duplicate would silence
  // the AI across the whole base.
  for (const p of ['(555) 555-5555', '(319) 000-0000', '(319) 123-4567']) {
    mk({ status: 'closed', phone: p })
    assert.equal(duplicateTwin(mk({ status: 'new', phone: p })), null, `${p} must not match`)
  }
})

test('a notvalidemail placeholder is not a shared email', () => {
  const email = 'x' + uniq() + '@notvalidemail.com'
  mk({ status: 'closed', email })
  assert.equal(duplicateTwin(mk({ status: 'new', email })), null)
})

test('a lead with no phone and no email is not everybody else', () => {
  mk({ status: 'closed', phone: null, email: null })
  assert.equal(duplicateTwin(mk({ status: 'new', phone: null, email: null })), null)
})
