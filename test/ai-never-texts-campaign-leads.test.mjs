// The AI must never engage an FSBO seller or a Cancelled/Expired lead.
//
// John, 2026-10-05: "we have a very strict rule that AI should not be engaged to any FSBO
// Leads and Cancelled/Expired." It had been, twice. Joseph Green answered "Yes, it is
// available." about 7526 Cattail Ct NE at 16:10 and the AI replied "How's it going so far
// with the sale?" a minute later. Jamie Northrup the same, on 2026-09-01.
//
// Cancelled/Expired was guarded in three places. FSBO was guarded in NONE of them, and the
// gap was structural rather than a one-off:
//
//   routes/inbox.js      awaited handleCxInbound and gated the AI on it, but called
//                        handleFsboReply fire-and-forget and discarded the answer
//   orchestrator.js      refused cx_campaign leads, calling itself "defense in depth for
//                        every other caller" - it only ever covered Cancelled/Expired
//   policy.js            denied cx_campaign on the final send gate, nothing for FSBO
//
// And the deeper reason it could happen at all: AI enrolment DOES exclude an FSBO lead, but
// only at the moment of enrolment. A cold buyer later identified as a FSBO seller stays
// AI-managed, so the exclusion never fires again. The guards below run at the moment of
// ACTION, which is why they have to exist as well as the enrolment check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL('../server/' + p, import.meta.url), 'utf8')
const inbox = read('routes/inbox.js')
const orch = read('ai-followup/orchestrator.js')
const policy = read('ai-followup/policy.js')
const enrol = read('ai-enrollment.js')

// ── layer 1: the inbound webhook ─────────────────────────────────────────────────────
test('the FSBO reply handler is AWAITED, not fired and forgotten', () => {
  // this is the actual bug: its answer was thrown away, so it could not gate anything
  assert.match(inbox, /fsboLead = await f\.handleFsboReply\(client\.id, body\)/)
  assert.ok(!/import\('\.\.\/fsbo-followup\.js'\)\.then\(m => m\.handleFsboReply/.test(inbox),
    'the fire-and-forget call is what let the reply through')
})

test('the AI hand-off is skipped for BOTH campaigns', () => {
  const gate = /if \(body && !kw && ([^)]*)\) import\('\.\.\/ai-followup\/orchestrator\.js'\)/.exec(inbox)
  assert.ok(gate, 'the AI hand-off gate should be findable')
  assert.match(gate[1], /!cxLead/, 'Cancelled/Expired')
  assert.match(gate[1], /!fsboLead/, 'FSBO')
})

// ── layer 2: the orchestrator ────────────────────────────────────────────────────────
test('the orchestrator refuses both campaigns, even when forced', () => {
  assert.match(orch, /FROM cx_campaign WHERE client_id=\?/)
  assert.match(orch, /FROM fsbo_followups WHERE client_id=\?/)
  // both refusals must sit ABOVE the force/enrolment gates, or a manual send walks past them
  const forceGate = orch.indexOf('if (!force)')
  assert.ok(orch.indexOf('fsbo_followups') < forceGate,
    'the FSBO refusal must come before the force gate, like the Cancelled/Expired one')
})

// ── layer 3: the final send gate ─────────────────────────────────────────────────────
test('policy denies an AI send to either campaign', () => {
  // the checks live in forbidden.js now; policy asks it, so assert on what it asks
  const block = policy.slice(policy.indexOf("if (channel === 'ai') {"), policy.indexOf("if (channel === 'ai') {") + 400)
  assert.match(block, /aiForbiddenReason\(client\)/)
  assert.match(forbidden, /cx_campaign/)
  assert.match(forbidden, /fsbo_followups/)
  // fsbo_status catches a seller the campaign table has not caught up with
  assert.match(forbidden, /client\.fsbo_status/)
})

test('the FSBO deny is checked on EVERY send, not once at enrolment', () => {
  // the whole reason this was reachable: enrolment excludes FSBO, but only at that moment
  assert.match(enrol, /c\.fsbo_status \|\|/, 'enrolment still excludes FSBO')
  assert.match(forbidden, /moment of enrolment/i,
    'the reason the send-time check is needed should be written down')
})

// ── the rule itself ──────────────────────────────────────────────────────────────────
test('the campaign openers are NOT what is blocked', () => {
  // fsbo_ai and the CX templates are approved outbound; only channel 'ai' is gated, so
  // blocking too broadly would silence the campaigns themselves
  const block = policy.slice(policy.indexOf("if (channel === 'ai') {"), policy.indexOf("if (channel === 'ai') {") + 900)
  assert.match(block, /^\s*if \(channel === 'ai'\)/m, 'the deny is scoped to the AI channel')
  assert.match(policy, /channel 'automation'\/'drip'/, 'the campaigns keep their own path')
})

// ── behaviour, not just source ───────────────────────────────────────────────────────
// The path that actually sends is handleInboundText. /ai/suggest is the advisory panel a
// human reads and composes nothing to send, so asserting on that would prove nothing.
import db, { initDb } from '../server/database.js'
await initDb()

const mk = (over = {}) => {
  const now = new Date().toISOString()
  return db.run(`INSERT INTO clients (first_name, last_name, phone, email, type, status, fsbo_status, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Guard', 'T' + Math.random().toString(36).slice(2, 8),
     '(319) ' + (200 + Math.floor(Math.random() * 700)) + '-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
     `g${Date.now()}${Math.random()}@x.com`, over.type || 'buyer', over.status || 'new',
     over.fsbo_status ?? null, now, now]).lastInsertRowid
}

test('the orchestrator refuses an FSBO campaign lead, even forced', async () => {
  const { handleInboundText } = await import('../server/ai-followup/orchestrator.js')
  const cid = mk({})
  db.run("INSERT OR REPLACE INTO fsbo_followups (client_id, status, updated_at) VALUES (?,?,?)",
    [cid, 'active', new Date().toISOString()])
  const r = await handleInboundText(cid, 'Yes, it is available.', { force: true })
  assert.equal(r.ok, false, 'it must not compose a reply for a FSBO seller')
  assert.match(String(r.reason), /FSBO/i)
})

test('the orchestrator still refuses a Cancelled/Expired lead', async () => {
  const { handleInboundText } = await import('../server/ai-followup/orchestrator.js')
  const cid = mk({})
  db.run("INSERT OR REPLACE INTO cx_campaign (client_id, status, enrolled_at, updated_at) VALUES (?,?,?,?)",
    [cid, 'active', new Date().toISOString(), new Date().toISOString()])
  const r = await handleInboundText(cid, 'who is this?', { force: true })
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /Cancelled\/Expired/i)
})

test('an ordinary lead is NOT blocked by the new guard', () => {
  // the guards must not quietly switch the AI off for everyone else
  const cid = mk({})
  assert.ok(!db.get('SELECT client_id FROM fsbo_followups WHERE client_id=?', [cid]))
  assert.ok(!db.get('SELECT client_id FROM cx_campaign WHERE client_id=?', [cid]))
})

// ── the real lesson: enrolment fences must also exist at SEND time ───────────────────
// Joseph Green was enrolled as a cold buyer months before anyone knew he was selling, and
// Holly Stock was hand-added as a seller client. Both were refused by ai-enrollment.js -
// but only at the moment of enrolment, which had already passed. forbidden.js asks the same
// questions again on every send.
const forbidden = read('ai-followup/forbidden.js')

test('every campaign fence in enrolment has a send-time counterpart', () => {
  // if a fence exists only at enrolment, a lead who acquires it later keeps getting texts
  const fences = [
    ['cx_campaign', /cx_campaign/],
    ['fsbo_followups', /fsbo_followups/],
    ['fb_seller_followups', /fb_seller_followups/],
    ['fsbo_status', /fsbo_status/],
    ['fsbo_listings', /fsbo_listings/],
    ['mls_status', /mls_status/],
    ['FB Seller Ad', /FB Seller Ad/],
  ]
  for (const [name, re] of fences) {
    assert.match(enrol, re, `${name} should be fenced at enrolment`)
    assert.match(forbidden, re, `${name} is fenced at enrolment but NOT at send time`)
  }
})

test('policy asks the shared rule rather than keeping its own copy', () => {
  // two copies drift; that is how FSBO ended up guarded in one place and not the other
  assert.match(policy, /import \{ aiForbiddenReason \} from '\.\/forbidden\.js'/)
  assert.match(policy, /const why = aiForbiddenReason\(client\)/)
})

test('a deliberate human decision is NOT in the send-time rule', () => {
  // auto_enroll_excluded stays enrolment-only on purpose: an agent switching AI on from the
  // profile must mean exactly that
  // mentioned in forbidden.js's comments to say WHY it is absent; what matters is that it
  // is never used as a send-time denial
  assert.ok(!/if \(.*auto_enroll_excluded.*\) return/.test(forbidden),
    'turning AI on by hand must still work')
  assert.match(enrol, /auto_enroll_excluded/, 'but it still blocks AUTO-enrolment')
})

test('the shared rule lets an ordinary lead through', async () => {
  const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
  const cid = mk({})
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  assert.equal(aiForbiddenReason(c), null, 'the guard must not switch the AI off for everyone')
})

test('the shared rule catches an identity acquired AFTER enrolment', async () => {
  const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')
  const cid = mk({})
  assert.equal(aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid])), null)
  // ...the FSBO sheet identifies them a month later
  db.run("UPDATE clients SET fsbo_status='Available' WHERE id=?", [cid])
  const after = aiForbiddenReason(db.get('SELECT * FROM clients WHERE id=?', [cid]))
  assert.match(String(after), /FSBO/, 'this is exactly the case enrolment-time checks miss')
})
