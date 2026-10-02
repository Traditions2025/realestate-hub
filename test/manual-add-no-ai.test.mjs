// A lead added by hand never auto-enrolls in AI — unless someone turns it on.
//
// Holly Stock (Hub 46095) was added in the Hub at 15:38 and got an AI intro text at 15:46,
// 22 seconds before a real human group message to her and Matt about her mother's condo.
// She read as a generic prospect and a known seller inside half a minute.
//
// The status check did not save her. The manual create route defaults a lead to 'active',
// but the fresh-lane hook runs the instant the row exists, so a lead typed in as New, or
// left New for the seconds before the status is set, is eligible.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()

const route = fs.readFileSync(new URL('../server/routes/clients.js', import.meta.url), 'utf8')
const ai = fs.readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8')
const enroll = fs.readFileSync(new URL('../server/ai-enrollment.js', import.meta.url), 'utf8')

test('a hand-added lead is marked excluded at creation', () => {
  const fn = route.slice(route.indexOf("router.post('/', (req, res) => {"))
  const body = fn.slice(0, fn.indexOf('res.status(201)'))
  assert.match(body, /auto_enroll_excluded=1/)
  assert.match(body, /added by hand in the Hub/)
  assert.ok(body.indexOf('auto_enroll_excluded=1') < body.indexOf('maybeAutoEnrollFresh'),
    'the exclusion must be recorded BEFORE the enrolment hook runs')
})

test('the exclusion is the durable flag the evaluator already honours', () => {
  // not a new mechanism: the same column an agent sets from the profile
  assert.match(enroll, /if \(st\?\.auto_enroll_excluded\) return fin\(EXCLUDED\('MANUAL_EXCLUDE'/)
})

test('"unless turned on" still works', () => {
  // enabling AI by hand must not consult the exclusion
  const enable = ai.slice(ai.indexOf("router.post('/lead/:id/enable'"))
  const line = enable.slice(0, enable.indexOf('\n'))
  assert.match(line, /setEnabled\(Number\(req\.params\.id\), true\)/)
  assert.ok(!line.includes('auto_enroll_excluded'), 'turning AI on is a deliberate act and overrides')
})

test('the decision is still evaluated, so there is an audit trail', () => {
  // skipping the hook silently would leave no record of WHY nothing fired
  const fn = route.slice(route.indexOf("router.post('/', (req, res) => {"))
  assert.match(fn, /maybeAutoEnrollFresh\(result\.lastInsertRowid\)/)
  assert.match(enroll, /logEnrollmentDecision\(ev, \{ actor: 'fresh_event' \}\)/)
})

test('the exclusion records who and why, not just a flag', () => {
  const fn = route.slice(route.indexOf("router.post('/', (req, res) => {"))
  assert.match(fn, /auto_enroll_excluded_by=\?/)
  assert.match(fn, /auto_enroll_excluded_at=\?/)
  assert.match(fn, /auto_enroll_excluded_reason=\?/)
})

test('a failure to mark the exclusion cannot break adding a lead', () => {
  // the lead still has to be created; the guard is best-effort and logged
  const fn = route.slice(route.indexOf("router.post('/', (req, res) => {"))
  const block = fn.slice(fn.indexOf('ensureState(result.lastInsertRowid)') - 200, fn.indexOf('maybeAutoEnrollFresh'))
  assert.match(block, /catch \(e\)/)
  assert.match(block, /console\.error/)
})

// ── the flag actually does what the evaluator expects ────────────────────────────────
test('setting the flag excludes the lead from auto-enrolment', async () => {
  const m = await import('../server/ai-enrollment.js')
  const { ensureState } = await import('../server/ai-followup/state.js')
  const now = new Date().toISOString()
  const id = db.run(
    `INSERT INTO clients (first_name, last_name, email, phone, type, status, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Hand', 'Added' + Math.random().toString(36).slice(2, 7), `h${Date.now()}@x.com`,
     '(319) 418-7731', 'seller', 'new', '[]', now, now]).lastInsertRowid
  ensureState(id)
  db.run(`UPDATE ai_lead_state SET auto_enroll_excluded=1, auto_enroll_excluded_reason=? WHERE client_id=?`,
    ['added by hand in the Hub', id])
  const ev = m.evaluateAiEnrollmentEligibility(id)
  assert.equal(ev.decision, 'excluded', 'a hand-added lead must not be eligible')
  // the evaluator surfaces the stored reason; that is what appears in the decision log
  assert.match(String(ev.reason || ''), /added by hand/)
})

test('without the flag the same lead would have been eligible to evaluate', async () => {
  // proves the exclusion is what stops it, not some unrelated rule
  const m = await import('../server/ai-enrollment.js')
  const now = new Date().toISOString()
  const id = db.run(
    `INSERT INTO clients (first_name, last_name, email, phone, type, status, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Hand', 'Control' + Math.random().toString(36).slice(2, 7), `c${Date.now()}@x.com`,
     '(319) 418-7732', 'seller', 'new', '[]', now, now]).lastInsertRowid
  const ev = m.evaluateAiEnrollmentEligibility(id)
  assert.ok(!/added by hand/.test(String(ev.reason || '')),
    'the control lead must pass, or fail for some OTHER reason')
})
