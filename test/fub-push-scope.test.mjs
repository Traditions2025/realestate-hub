// Scoping the FUB status push (John, 2026-10-27).
//
// The unscoped sweep would have made 163 changes nobody asked for alongside the 156
// junk/DNC ones that were asked for - mostly moving leads OUT of "High Probability
// Sellers" INTO "High Probability Buyer" on the strength of the Hub's `type` field, which
// was wrong on 52 Realist homeowners that same day.
import test from 'node:test'
import assert from 'node:assert'
import db, { initDb } from '../server/database.js'

await initDb()
const FUB = await import('../server/fub-status-push.js')

const BASE = 995100
let seq = 0
function mkLead(status) {
  const id = BASE + (++seq)
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, email, status, type, fub_person_id, tags, created_at, updated_at)
          VALUES (?,?,?,?,?, 'buyer', ?, '[]', datetime('now'), datetime('now'))`,
  [id, 'Scope', 'Case' + seq, `scope${id}@example.com`, status, 90000 + seq])
  return id
}

const junk = mkLead('junk')
const dnc = mkLead('donotcontact')
const prime = mkLead('prime')
const nim = mkLead('not_in_market')
const mine = new Set([junk, dnc, prime, nim])
const pick = (rows) => rows.filter(r => mine.has(r.id))

test('unscoped, the sweep considers every status — including the ones nobody asked about', () => {
  const got = pick(FUB.candidates({ limit: 100000, afterId: BASE }))
  const statuses = new Set(got.map(r => r.status))
  assert.ok(statuses.has('junk') && statuses.has('donotcontact'))
  assert.ok(statuses.has('prime'), 'prime is in the default sweep, which is the problem')
})

test('scoped to junk and DNC, nothing else is touched', () => {
  const got = pick(FUB.candidates({ limit: 100000, afterId: BASE, onlyStatuses: ['junk', 'donotcontact'] }))
  const ids = new Set(got.map(r => r.id))
  assert.ok(ids.has(junk), 'junk must be included')
  assert.ok(ids.has(dnc), 'donotcontact must be included')
  assert.ok(!ids.has(prime), 'prime must NOT be swept')
  assert.ok(!ids.has(nim), 'not_in_market must NOT be swept')
})

test('the scope is case and whitespace tolerant', () => {
  const got = pick(FUB.candidates({ limit: 100000, afterId: BASE, onlyStatuses: ['  JUNK  '] }))
  assert.deepEqual(got.map(r => r.id), [junk])
})

test('an empty or missing scope falls back to the full sweep, not to nothing', () => {
  for (const scope of [null, [], undefined]) {
    const got = pick(FUB.candidates({ limit: 100000, afterId: BASE, onlyStatuses: scope }))
    assert.ok(got.length >= 4, `scope ${JSON.stringify(scope)} must not silently select nothing`)
  }
})

test('remaining() counts the same scope the sweep uses', () => {
  const all = FUB.remaining(BASE)
  const scoped = FUB.remaining(BASE, ['junk', 'donotcontact'])
  assert.ok(scoped < all, 'a scoped run must have fewer left than an unscoped one')
  assert.ok(scoped >= 2, 'our two scoped leads should be counted')
})

// A deliberate human decision outranks a stale MLS tag (John, 2026-10-27).
//
// Eric Londquist (#29745) is junk BECAUSE his house went back on the market, so the
// "expired" mls_status is the out-of-date fact. stageFor checked MLS first and returned
// immediately, pushing him Dead -> Expired: out of a closed stage and into a workable one.
// The expired/cancelled rule itself says junk is a human's call and must never be touched
// (see expired-watch-rule.test.mjs).
test('junk beats an expired MLS tag — a closed lead is not reopened', () => {
  assert.equal(FUB.stageFor({ status: 'junk', mls_status: 'expired' }), 'Dead')
  assert.equal(FUB.stageFor({ status: 'junk', mls_status: 'cancelled' }), 'Dead')
  assert.equal(FUB.stageFor({ status: 'donotcontact', mls_status: 'expired' }), 'Do not Contact')
})

test('a WATCH lead still gets the specific MLS stage — that rule is unchanged', () => {
  // This is what MLS_TO_STAGE exists for: 'Watch' would throw away what the Hub knows.
  assert.equal(FUB.stageFor({ status: 'watch', mls_status: 'expired' }), 'Expired')
  assert.equal(FUB.stageFor({ status: 'watch', mls_status: 'cancelled' }), 'Cancelled')
  assert.equal(FUB.stageFor({ status: 'new', mls_status: 'canceled' }), 'Cancelled')
})

test('without an MLS tag the status still decides', () => {
  assert.equal(FUB.stageFor({ status: 'junk' }), 'Dead')
  assert.equal(FUB.stageFor({ status: 'closed' }), 'Past Client')
  assert.equal(FUB.stageFor({ status: 'prime', type: 'seller' }), 'High Probability Sellers')
})
