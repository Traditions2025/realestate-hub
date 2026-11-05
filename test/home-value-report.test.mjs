// The value we send back (John, 2026-11-05).
//
// The response promises a home value within 24 hours. Matt or John review the submission
// and enter a RANGE; this builds the report email around it.
//
// A RANGE, never a single number: Matt's standing rule on every value we present, said
// again 2026-10-19 - "never a final or suggested single price anywhere in the report, no
// midpoints". A single figure reads as an appraisal and gets quoted back as one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const HVR = await import('../server/home-value-report.js')
const HVA = await import('../server/home-value-answers.js')
HVR.initHvReports()
HVA.initHvAnswers()

let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')

const mkLead = () => db.run(
  'INSERT INTO clients (first_name, last_name, type, status, email, address, city) VALUES (?,?,?,?,?,?,?)',
  ['Barney', 'Foley', 'seller', 'closed', `hv${uniq()}@example.com`, '5661 Meadow Grass Cir SE', 'Cedar Rapids'],
).lastInsertRowid

const answer = (cid, over = {}) => HVA.saveAnswers(cid, {
  submission_id: 'HV-' + uniq(),
  condition: '9',
  condition_gap: 'The kitchen is still original',
  HV_Data: 'cond=9;beds=3;bathsf=2;bathsh=0;upd=Roof:3-5,Furnace:6-10;lvlk=cosmetic;bsmt=full|all;gar=2|attached;time=Just curious;buy=yes',
  timeframe: 'Just curious',
  would_buy: 'yes',
  ...over,
}, { submittedAt: new Date().toISOString() })

// ---- the range guard -------------------------------------------------------------

test('a single number is not a range', () => {
  assert.equal(HVR.checkRange(250000, 250000), null, 'equal ends are allowed, but see below')
  assert.ok(HVR.checkRange(300000, 250000), 'high below low is refused')
  assert.ok(HVR.checkRange(0, 250000), 'a missing end is refused')
  assert.ok(HVR.checkRange('', ''), 'blank is refused')
})

test('a fat-fingered figure is caught before a homeowner sees it', () => {
  assert.match(HVR.checkRange(28500, 31000) || '', /too low/, 'a digit dropped from $285,000')
  assert.match(HVR.checkRange(2500000, 6000000) || '', /too high/, 'a digit added')
  assert.match(HVR.checkRange(200000, 400000) || '', /wider than 50%/, 'a range that says nothing')
})

test('an ordinary Cedar Rapids range passes', () => {
  assert.equal(HVR.checkRange(285000, 310000), null)
})

// ---- the report ------------------------------------------------------------------

test('the range is in the email and no midpoint ever is', () => {
  const cid = mkLead(); answer(cid)
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const r = HVR.buildReport(c, { low: 285000, high: 310000 })
  assert.ok(!r.error)
  assert.match(r.html, /\$285,000/)
  assert.match(r.html, /\$310,000/)
  assert.ok(!r.html.includes('297,500'), 'no midpoint is calculated or shown')
  assert.match(r.subject, /5661 Meadow Grass Cir SE/)
})

test('it quotes their answers as sentences, never as form fields', () => {
  const cid = mkLead(); answer(cid)
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const r = HVR.buildReport(c, { low: 285000, high: 310000 })
  const text = r.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.match(text, /You rated the overall condition a 9 out of 10/)
  assert.match(text, /kitchen is still original/)
  assert.match(text, /full basement that is fully finished/)
  assert.match(text, /attached 2 stall garage/)
  // the copy rule: never read the database back at them
  for (const banned of ['HV_Data', 'cond=', 'bsmt=', 'According to', 'you selected', 'our system']) {
    assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `must not say ${banned}`)
  }
})

test('an empty questionnaire still produces a sendable report', () => {
  // No answers on file is the old-submission case, not an error.
  const cid = mkLead()
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const r = HVR.buildReport(c, { low: 200000, high: 220000 })
  assert.ok(!r.error)
  assert.equal(r.facts.length, 0)
  assert.match(r.html, /\$200,000/)
  assert.ok(!/Here is what we took into account/.test(r.html), 'no empty section is left behind')
})

test("the reviewer's own note is carried through", () => {
  const cid = mkLead(); answer(cid)
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const r = HVR.buildReport(c, { low: 285000, high: 310000, notes: 'Two homes on your street sold above asking this autumn.' })
  assert.match(r.html, /sold above asking this autumn/)
})

test('it says plainly that it is not an appraisal', () => {
  const cid = mkLead(); answer(cid)
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const text = HVR.buildReport(c, { low: 285000, high: 310000 }).html.replace(/<[^>]+>/g, ' ')
  assert.match(text, /not an appraisal/)
  assert.match(text, /not a guarantee/)
})

test('it is signed by Matt, because all outbound mail is', () => {
  const cid = mkLead(); answer(cid)
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const html = HVR.buildReport(c, { low: 285000, high: 310000 }).html
  assert.match(html, /Matt Smith<br>Matt Smith Team \| RE\/MAX Concepts/)
  assert.ok(!/\bJohn\b/.test(html.replace(/<[^>]+>/g, ' ')), 'the John persona stays on SMS')
})

test("a homeowner's apostrophes cannot break the markup", () => {
  const cid = mkLead()
  answer(cid, { condition_gap: 'The "sunroom" & deck <need> work' })
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  const html = HVR.buildReport(c, { low: 285000, high: 310000 }).html
  assert.ok(!html.includes('<need>'), 'their angle brackets are escaped')
  assert.match(html, /&lt;need&gt;/)
})

// ---- the queue and the record ----------------------------------------------------

test('a lead who submitted shows in the review queue until a report is sent', () => {
  const cid = mkLead(); answer(cid)
  const inQueue = () => HVR.pendingReviews({ limit: 200 }).some((r) => r.id === cid)
  assert.ok(inQueue(), 'waiting for a value')
  HVR.saveReport(cid, { low: 285000, high: 310000, preparedBy: 'test', status: 'sent' })
  assert.ok(!inQueue(), 'answered, so out of the queue')
})

test('a draft does not count as answered', () => {
  const cid = mkLead(); answer(cid)
  HVR.saveReport(cid, { low: 1, high: 2, preparedBy: 'test', status: 'draft' })
  assert.ok(HVR.pendingReviews({ limit: 200 }).some((r) => r.id === cid), 'still waiting')
})

test('what was quoted is kept, so it can be answered for later', () => {
  const cid = mkLead(); answer(cid)
  HVR.saveReport(cid, { low: 285000, high: 310000, notes: 'desk review', preparedBy: 'john@example.com', status: 'sent' })
  const r = HVR.latestReport(cid)
  assert.equal(r.value_low, 285000)
  assert.equal(r.value_high, 310000)
  assert.equal(r.prepared_by, 'john@example.com')
  assert.equal(r.status, 'sent')
  assert.ok(r.sent_at, 'stamped')
})

// A server that has never taken a submission has no home_value_answers table. That threw
// out of an async route handler, which Express 4 does not catch, so the request hung
// until the caller gave up instead of returning an empty queue (found live, 2026-11-05).
test('an empty queue is an answer, not a hang', () => {
  const real = db.all
  db.all = () => { throw new Error('no such table: home_value_answers') }
  try {
    assert.deepEqual(HVR.pendingReviews({ limit: 10 }), [], 'returns empty rather than throwing')
  } finally { db.all = real }
})

test('every report route answers even when something faults', async () => {
  const src = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../server/routes/drips.js', import.meta.url), 'utf8'))
  const handlers = src.split('\n').filter(l => /router\.(get|post)\('\/home-value\/reports/.test(l))
  assert.equal(handlers.length, 4, 'four report routes')
  for (const m of src.matchAll(/router\.(?:get|post)\('\/home-value\/reports[^\n]*\n([\s\S]{0,2200}?)\n\}\)/g)) {
    assert.match(m[1], /catch \(e\) \{ res\.status\(500\)\.json/, 'each one answers on a fault')
  }
})
