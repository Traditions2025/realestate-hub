// A hand-added lead cannot be texted by the AI through ANY path.
//
// John, 2026-10-06, after the fourth incident here: "I still don't know why you can't simply
// make the manual import as exclusion to AI enrollment?"
//
// It WAS an exclusion from enrolment, since 2026-10-02, and that part worked — auto-enrolment
// refused Megan Walt and logged it. The hole was that "Send AI now" never asks the enrolment
// question: it force-sends. An enrolment-level exclusion is not in its path at all.
//
// So the flag moved to where messages actually leave. Every path - scheduled, responsive,
// forced, bulk, and anything written later - passes through canSendSms, and it is asked
// there. These tests call the REAL functions; nothing live is ever sent (see
// feedback_never_send_while_investigating).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
const { canSendSms } = await import('../server/ai-followup/policy.js')
const { ensureState } = await import('../server/ai-followup/state.js')

const mk = (over = {}) => {
  const now = new Date().toISOString()
  const id = db.run(`INSERT INTO clients (first_name, last_name, phone, type, status, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?)`,
    ['Hand', 'T' + Math.random().toString(36).slice(2, 7),
     '(319) ' + (200 + Math.floor(Math.random() * 700)) + '-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
     'buyer', over.status || 'new', now, now]).lastInsertRowid
  ensureState(id)
  if (over.excluded) db.run('UPDATE ai_lead_state SET auto_enroll_excluded=1 WHERE client_id=?', [id])
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}

test('the exclusion is refused at SEND time, not only at enrolment', () => {
  const c = mk({ excluded: true })
  assert.match(String(aiForbiddenReason(c)), /added by hand/i)
})

// This is the one that matters: canSendSms is what every AI path goes through.
test('canSendSms refuses an AI text to a hand-added lead', () => {
  const c = mk({ excluded: true })
  const r = canSendSms(c, { channel: 'ai' })
  assert.equal(r.ok, false, 'no AI text may go to a hand-added lead')
  assert.match(String(r.reason), /added by hand/i)
})

// force is what "Send AI now" uses. It must not be a way round this.
test('FORCE does not get past it', () => {
  const c = mk({ excluded: true })
  const r = canSendSms(c, { channel: 'ai', force: true })
  assert.equal(r.ok, false, 'a forced send is exactly how Megan Walt was texted')
  assert.match(String(r.reason), /added by hand/i)
})

test('an ordinary lead is unaffected', () => {
  const c = mk({})
  assert.equal(aiForbiddenReason(c), null)
  const r = canSendSms(c, { channel: 'ai' })
  assert.ok(r.ok !== false || !/added by hand/i.test(String(r.reason || '')),
    'the guard must not block leads nobody excluded')
})

test('a human saying yes clears it, and then the AI may send', () => {
  const c = mk({ excluded: true })
  assert.match(String(aiForbiddenReason(c)), /added by hand/i)
  // what POST /api/ai/lead/:id/enable does
  db.run('UPDATE ai_lead_state SET auto_enroll_excluded=0 WHERE client_id=?', [c.id])
  const after = db.get('SELECT * FROM clients WHERE id=?', [c.id])
  assert.equal(aiForbiddenReason(after), null, 'turning AI on by hand must still work')
})

// ── the two routes that must clear it, so "yes" means yes ────────────────────────────
const ai = fs.readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8')

test('Enable AI clears the flag', () => {
  const fn = ai.slice(ai.indexOf("router.post('/lead/:id/enable'"), ai.indexOf("router.post('/lead/:id/enable'") + 420)
  assert.match(fn, /clearManualExclusion\(cid, req\.user\?\.email\)/)
  assert.ok(fn.indexOf('clearManualExclusion') < fn.indexOf('setEnabled'),
    'clear it before enabling, or the send gate still refuses')
})

test('the Send-AI-now override clears it too, and records who', () => {
  assert.match(ai, /function clearManualExclusion/)
  assert.match(ai, /ai_manual_override/)
})

test('nothing else quietly clears it', () => {
  // Allowed: the definition, Enable AI, and the two Send-AI-now overrides (single + bulk).
  // All are a person deliberately saying yes. Another caller means something started
  // clearing it quietly, which is how this whole class of bug keeps happening.
  const callers = ai.split(String.fromCharCode(10))
    .map((l, i) => ({ l: l.trim(), i }))
    .filter(x => /clearManualExclusion\(/.test(x.l) && !/^function clearManualExclusion/.test(x.l))
  assert.ok(callers.length <= 3,
    'clearManualExclusion is called from ' + callers.length + ' places: '
    + callers.map(x => 'line ' + (x.i + 1)).join(', '))
})

// newLeadSweep runs every 5 minutes and schedules a first touch. The send gate refuses a
// hand-added lead anyway, but scheduling an action that can never fire leaves phantom
// pending rows on a lead the team is already working.
test('the 5-minute new-lead sweep skips hand-added leads', () => {
  const src = fs.readFileSync(new URL('../server/ai-followup/scheduler.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function newLeadSweep'), src.indexOf('export function newLeadSweep') + 3000)
  assert.match(fn, /auto_enroll_excluded=1/)
  assert.ok(fn.indexOf('auto_enroll_excluded') < fn.indexOf('scheduleAiAction'),
    'skip before anything is scheduled')
})
