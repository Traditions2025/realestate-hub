// The AI must never follow up anyone who asked what their home is worth.
//
// Matt, 2026-10-28, as the native questionnaire at mattsmithteam.com/home-value went live:
// no AI follow-up for a home value requester. Every lead the form creates carries the line
// "DO NOT ENROL IN AI FOLLOW-UP. Home Value response sequence only." in its note — but a
// note is a label, not a guard, and the standing rule here is that an enrolment exclusion
// is not a guard on its own either.
//
// Before this, server/ai-followup/ did not mention home_value_sms ANYWHERE. The response
// sequence existed, the AI lane had no idea it did, and nothing stopped the AI texting or
// answering a value requester. So the same three layers FSBO and Cancelled/Expired got on
// 2026-10-05 are asserted here:
//
//   ai-enrollment.js   never picked up in the first place
//   forbidden.js       refused at the moment any message would leave
//   orchestrator.js    refused when a reply arrives — and a reply is the POINT of the
//                      sequence, so this is the layer that would otherwise fire
//
// Each layer asks about the SUBMISSION as well as the campaign row, because the row is
// written only after the day-0 email succeeds (both enrolHvSms and scheduleConditionQuestion
// sit inside `if (emailed?.ok)`). A lead whose email bounced is still a value requester.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
import { initHvSms } from '../server/home-value-sms.js'

const read = (p) => fs.readFileSync(new URL('../server/' + p, import.meta.url), 'utf8')
const enrol = read('ai-enrollment.js')
const forbidden = read('ai-followup/forbidden.js')
const orch = read('ai-followup/orchestrator.js')

await initDb()
initHvSms()

const nowIso = () => new Date().toISOString()
let seq = 0
const mk = () => {
  seq += 1
  const now = nowIso()
  return db.run(`INSERT INTO clients (first_name, last_name, phone, email, type, status, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?)`,
    ['Value', 'Req' + seq + Math.random().toString(36).slice(2, 7),
     '(319) 555-' + String(1000 + seq).slice(-4),
     `hv${seq}-${Date.now()}@example.com`, 'seller', 'new', now, now]).lastInsertRowid
}
const enrolHv = (cid) => db.run(
  `INSERT OR REPLACE INTO home_value_sms (client_id, status, next_step, requested_at, next_send_at, updated_at)
   VALUES (?,?,?,?,?,?)`, [cid, 'active', 0, nowIso(), nowIso(), nowIso()])
const logSubmission = (cid) => db.run(
  `INSERT INTO activity_log (action, entity_type, entity_id, details, created_at)
   VALUES (?,?,?,?,?)`, ['home_value_submission', 'client', cid, '1903 Shady Grove Rd SW', nowIso()])

// ── all three layers are present in source ───────────────────────────────────────────
test('every layer names the home value campaign', () => {
  for (const [name, src] of [['ai-enrollment.js', enrol], ['forbidden.js', forbidden], ['orchestrator.js', orch]]) {
    assert.match(src, /home_value_sms/, `${name} must fence the home value campaign row`)
    assert.match(src, /home_value_submission/, `${name} must fence on the submission itself`)
  }
})

test('the orchestrator refusal sits above the force gate', () => {
  // below it, a manual send-now walks straight past — the FSBO lesson
  const forceGate = orch.indexOf('if (!force)')
  assert.ok(forceGate > 0, 'the force gate should be findable')
  assert.ok(orch.indexOf('home_value_sms') < forceGate,
    'the home value refusal must come before the force gate, like FSBO and Cancelled/Expired')
})

// ── the send-time rule ───────────────────────────────────────────────────────────────
test('a lead in the response sequence is refused at send time', async () => {
  const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
  const cid = mk()
  assert.equal(aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid])), null)
  enrolHv(cid)
  assert.match(String(aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid]))),
    /home value/i)
})

test('a requester whose day-0 email bounced is STILL refused', async () => {
  // no home_value_sms row is ever written for them, which is exactly the hole a
  // campaign-row-only guard would leave
  const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
  const cid = mk()
  logSubmission(cid)
  assert.ok(!db.get('SELECT client_id FROM home_value_sms WHERE client_id=?', [cid]),
    'this lead is deliberately NOT in the campaign table')
  assert.match(String(aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid]))),
    /worth|home value/i)
})

test('the refusal survives the sequence finishing', async () => {
  // "no AI follow-up for anyone who requests a home value" has no expiry date, and the row
  // stays behind once the 45 days are up — same as fsbo_followups
  const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
  const cid = mk()
  enrolHv(cid)
  db.run("UPDATE home_value_sms SET status='done', next_send_at=NULL WHERE client_id=?", [cid])
  assert.match(String(aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid]))),
    /home value/i)
})

// ── the reply path, which is the one that would actually have fired ──────────────────
test('the orchestrator refuses to answer a value requester, even forced', async () => {
  const { handleInboundText } = await import('../server/ai-followup/orchestrator.js')
  const cid = mk()
  enrolHv(cid)
  // the reply the sequence is designed to earn
  const r = await handleInboundText(cid, 'I would say about a 7', { force: true })
  assert.equal(r.ok, false, 'a person answers a condition rating, not the AI')
  assert.match(String(r.reason), /home value/i)
})

test('a bounced requester is refused on the reply path too', async () => {
  const { handleInboundText } = await import('../server/ai-followup/orchestrator.js')
  const cid = mk()
  logSubmission(cid)
  const r = await handleInboundText(cid, 'who is this?', { force: true })
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /home value/i)
})

// ── enrolment ────────────────────────────────────────────────────────────────────────
test('eligibility refuses a value requester before anything is scheduled', async () => {
  const { evaluateAiEnrollmentEligibility } = await import('../server/ai-enrollment.js')
  const cid = mk()
  enrolHv(cid)
  const ev = evaluateAiEnrollmentEligibility(cid)
  assert.equal(ev.decision, 'excluded', 'a value requester must never be eligible')
  assert.equal(ev.reason_code, 'HOME_VALUE')
})

test('a bounced requester is refused by eligibility too', async () => {
  const { evaluateAiEnrollmentEligibility } = await import('../server/ai-enrollment.js')
  const cid = mk()
  logSubmission(cid)
  const ev = evaluateAiEnrollmentEligibility(cid)
  assert.equal(ev.decision, 'excluded')
  assert.equal(ev.reason_code, 'HOME_VALUE')
})

// The fence has to be asked BEFORE the cheaper ones, or its reason never surfaces and the
// enrolment log blames something else. A real-looking name is used deliberately: with a
// random one the name-quality fence answers first and this test proves nothing.
test('the home value fence is reached before the name-quality fence', () => {
  const hv = enrol.indexOf('home_value_sms')
  const name = enrol.indexOf('NAME_QUALITY')
  assert.ok(hv > 0 && name > 0, 'both fences should be findable')
  assert.ok(hv < name, 'a value requester should be excluded as HOME_VALUE, not NAME_QUALITY')
})

// ── and it must not switch the AI off for everyone else ──────────────────────────────
test('an ordinary lead is untouched by the new guard', async () => {
  const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
  const cid = mk()
  assert.equal(aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid])), null,
    'the guard must only catch value requesters')
})

test('the guard is scoped to the AI, so the response sequence itself still sends', () => {
  // hvSmsBlock owns whether a sequence step goes out; the AI rule must not reach into it
  const policy = read('ai-followup/policy.js')
  const block = policy.slice(policy.indexOf("if (channel === 'ai') {"),
                             policy.indexOf("if (channel === 'ai') {") + 400)
  assert.match(block, /aiForbiddenReason\(client\)/)
  assert.match(block, /channel === 'ai'/, 'the deny is scoped to the AI channel only')
  const hv = read('home-value-sms.js')
  assert.ok(!/aiForbiddenReason/.test(hv),
    'the home value sequence must not ask the AI rule about its own sends')
})
