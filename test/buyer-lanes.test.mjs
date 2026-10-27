// Steps 6, 7, 9, 13 and 14. These exist because ownership introduced a failure mode that
// did not exist before it: a lead can be CORRECTLY owned by a lane that has nothing to
// say. FB_BUYER_PHASE_2 shipped that way — the owner was assigned before the lane was
// built, so every finished listing campaign parked its lead somewhere permanently silent,
// and nothing in the system looked wrong. The last test here is the one that catches it.
import test from 'node:test'
import assert from 'node:assert'
import db, { initDb } from '../server/database.js'

await initDb()
// buyer_facts is created lazily by the first buyer-profile call, so a fixture that
// DELETEs from it before anything has initialised it fails on a clean database.
const { initBuyerProfile } = await import('../server/buyer-profile.js')
initBuyerProfile()
// fb_listing_campaigns is created by the campaign module, not initDb(). Without this the
// fixtures below only work on a database where something else has already made the table —
// which is to say, on a developer's accumulated local DB and nowhere else.
const { initFbListingCampaign } = await import('../server/fb-listing-campaign.js')
initFbListingCampaign()
const P = await import('../server/ai-followup/presend.js')
const LC = await import('../server/buyer-lifecycle.js')
const BP = await import('../server/buyer-profile.js')
const P2 = await import('../server/ai-followup/phase2.js')
const REP = await import('../server/ai-followup/lane-report.js')

const BASE = 991200
let seq = 0
const agoIso = (days) => new Date(Date.now() - days * 86400000).toISOString()

function mkLead({ status = 'new', owner = 'NONE', createdDays = 400 } = {}) {
  const id = BASE + (++seq)
  db.run('DELETE FROM communications WHERE client_id=?', [id])
  db.run('DELETE FROM fb_listing_campaigns WHERE client_id=?', [id])
  db.run('DELETE FROM ai_scheduled_actions WHERE client_id=?', [id])
  db.run('DELETE FROM buyer_facts WHERE client_id=?', [id])
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, type, status, source, tags, created_at, communication_owner, communication_owner_prev)
          VALUES (?,?,?,'buyer',?,'Import','[]',?,?,NULL)`,
  [id, 'Lane', 'Test' + seq, status, agoIso(createdDays), owner])
  return id
}
const comm = (id, direction, when, sentBy = null) =>
  db.run('INSERT INTO communications (channel, direction, client_id, occurred_at, sent_by_type, preview) VALUES (?,?,?,?,?,?)',
    ['text', direction, id, when, sentBy, 'test'])
const pending = (id, type = 'AI_COLD_BUYER') =>
  db.run("INSERT INTO ai_scheduled_actions (client_id, action_type, execute_at, state, dedup_key, created_at, updated_at) VALUES (?,?,?,'pending',?,?,?)",
    [id, type, new Date(Date.now() + 86400000).toISOString(), `t_${id}_${type}_${Math.random()}`, agoIso(0), agoIso(0)])

// ---- STEP 7: phase 2 copy -----------------------------------------------------------

test('no phase 2 message exposes the CRM or chases', () => {
  const bad = []
  for (const s of P2.PHASE2_STAGES) {
    for (const m of s.messages) { const hit = P2.findBannedPhase2(m); if (hit.length) bad.push(`${s.key}: ${hit}`) }
    for (const k of Object.keys(s.known || {})) { const hit = P2.findBannedPhase2(s.known[k]); if (hit.length) bad.push(`${s.key}.${k}: ${hit}`) }
  }
  assert.deepEqual(bad, [], 'phase 2 copy tripped the banned list')
})

test('every phase 2 message carries a greeting token and a name', () => {
  for (const s of P2.PHASE2_STAGES) {
    for (const m of s.messages) {
      assert.ok(m.includes('{{greeting}}'), `${s.key} missing greeting: ${m}`)
      assert.ok(m.includes('{{first_name}}'), `${s.key} missing name: ${m}`)
    }
  }
})

test('phase 2 may reference the enquiry, because an fb campaign row proves it happened', () => {
  // The cold lane bans this language; phase 2 is the one place it is earned.
  const p1 = P2.PHASE2_STAGES.find(s => s.key === 'p1')
  assert.ok(p1.messages.some(m => /asked about|enquired/i.test(m)),
    'phase 2 should open from the property they actually asked about')
})

test('a phase 2 stage whose facts are known and fresh is skipped, not padded', () => {
  const id = mkLead()
  BP.setFact(id, 'timing', '3 months', { sourceType: 'confirmed' })
  assert.equal(P2.selectPhase2Message(id, 'p4'), null, 'p4 only exists to learn timing')
})

test('a phase 2 stage with an unknown fact still asks', () => {
  const id = mkLead()
  const m = P2.selectPhase2Message(id, 'p4', { rotation: 0 })
  assert.ok(m && m.kind === 'ask')
})

// ---- STEP 6: a status change is an event --------------------------------------------

const FB = await import('../server/fb-listing-campaign.js')

function mkCampaign(id, { status = 'Active', daysOut = 6 } = {}) {
  const txId = 900000 + (id % 1000)
  db.run('DELETE FROM transactions WHERE id=?', [txId])
  db.run("INSERT INTO transactions (id, property_address, property_status) VALUES (?,?,?)",
    [txId, '1625 Ranmar Dr', status])
  const next = new Date(Date.now() + daysOut * 86400000).toISOString()
  db.run(`INSERT OR REPLACE INTO fb_listing_campaigns
          (client_id, listing_label, tx_id, status, day0_at, next_step, next_send_at, enrolled_at, updated_at)
          VALUES (?,?,?,'active',?,3,?,?,?)`,
  [id, '1625 Ranmar Dr', txId, agoIso(20), next, agoIso(20), agoIso(0)])
  return next
}

test('a listing going under contract pulls the pivot forward instead of waiting a week', () => {
  const id = mkLead({ owner: 'FB_LISTING_PHASE_1' })
  const was = mkCampaign(id, { status: 'Under Contract', daysOut: 6 })
  const r = FB.pullForwardStatusChanges()
  assert.ok(r.pulled >= 1, 'nothing was pulled forward')
  const now = db.get('SELECT next_send_at, last_known_status FROM fb_listing_campaigns WHERE client_id=?', [id])
  assert.ok(now.next_send_at < was, `next touch should be sooner than ${was}, got ${now.next_send_at}`)
  assert.equal(now.last_known_status, 'pending')
})

test('pulling forward is idempotent — a second sweep does not keep moving it', () => {
  const id = mkLead({ owner: 'FB_LISTING_PHASE_1' })
  mkCampaign(id, { status: 'Under Contract', daysOut: 6 })
  FB.pullForwardStatusChanges()
  const first = db.get('SELECT next_send_at FROM fb_listing_campaigns WHERE client_id=?', [id]).next_send_at
  FB.pullForwardStatusChanges()
  const second = db.get('SELECT next_send_at FROM fb_listing_campaigns WHERE client_id=?', [id]).next_send_at
  assert.equal(first, second)
})

test('an active listing is left entirely alone', () => {
  const id = mkLead({ owner: 'FB_LISTING_PHASE_1' })
  const was = mkCampaign(id, { status: 'Active', daysOut: 6 })
  FB.pullForwardStatusChanges()
  const now = db.get('SELECT next_send_at FROM fb_listing_campaigns WHERE client_id=?', [id]).next_send_at
  assert.equal(now, was, 'an active listing must not have its cadence touched')
})

test('a lead who already pivoted is not pulled forward again', () => {
  const id = mkLead({ owner: 'FB_LISTING_PHASE_1' })
  const was = mkCampaign(id, { status: 'Under Contract', daysOut: 6 })
  db.run("UPDATE fb_listing_campaigns SET pivoted='pending' WHERE client_id=?", [id])
  FB.pullForwardStatusChanges()
  const now = db.get('SELECT next_send_at FROM fb_listing_campaigns WHERE client_id=?', [id]).next_send_at
  assert.equal(now, was, 'they have already been told')
})

// ---- STEP 9: reactivation is an event -----------------------------------------------

test('a weak signal does not reactivate anyone', () => {
  const id = mkLead({ owner: 'COLD_HISTORY_UNKNOWN' })
  const r = LC.maybeReactivateOnBehavior(id, 'email_open', 1)
  assert.equal(r.ok, false)
  assert.match(r.reason, /below threshold/)
})

test('a dormant cold lead coming back enters a reactivation', () => {
  const id = mkLead({ owner: 'COLD_HISTORY_UNKNOWN' })
  comm(id, 'outgoing', agoIso(90), 'ai')      // long silent
  const r = LC.maybeReactivateOnBehavior(id, 'saved_property', 6)
  assert.equal(r.ok, true, r.reason)
  assert.equal(P.currentOwner(id), 'BEHAVIOR_REACTIVATION')
  assert.equal(P.previousOwner(id), 'COLD_HISTORY_UNKNOWN', 'must remember what it displaced')
})

test('a lead we texted days ago is not "coming back"', () => {
  const id = mkLead({ owner: 'COLD_HISTORY_UNKNOWN' })
  comm(id, 'outgoing', agoIso(2), 'ai')
  const r = LC.maybeReactivateOnBehavior(id, 'saved_property', 6)
  assert.equal(r.ok, false)
  assert.match(r.reason, /under \d+ days/)
})

test('a live listing campaign is never interrupted by behaviour', () => {
  const id = mkLead({ owner: 'FB_LISTING_PHASE_1' })
  comm(id, 'outgoing', agoIso(90), 'ai')
  const r = LC.maybeReactivateOnBehavior(id, 'tour_request', 26)
  assert.equal(r.ok, false)
  assert.match(r.reason, /not interruptible/)
})

test('a human conversation outranks a comeback', () => {
  const id = mkLead({ owner: 'COLD_HISTORY_UNKNOWN' })
  comm(id, 'outgoing', agoIso(90), 'ai')
  comm(id, 'incoming', agoIso(1))              // they replied yesterday
  const r = LC.maybeReactivateOnBehavior(id, 'saved_property', 6)
  assert.equal(r.ok, false, 'a reply means a person owns this')
})

// ---- STEP 13: the way back ----------------------------------------------------------

test('leaving a reactivation returns the lead to the lane it displaced', () => {
  const id = mkLead({ owner: 'FB_BUYER_PHASE_2' })
  comm(id, 'outgoing', agoIso(90), 'ai')
  LC.maybeReactivateOnBehavior(id, 'saved_property', 6)
  assert.equal(P.currentOwner(id), 'BEHAVIOR_REACTIVATION')
  LC.exitBehaviorReactivation(id)
  assert.equal(P.currentOwner(id), 'FB_BUYER_PHASE_2')
})

test('re-arming never disturbs a lane that already has a touch queued', () => {
  const id = mkLead({ owner: 'FB_BUYER_PHASE_2' })
  pending(id, 'AI_BUYER_PHASE2')
  const r = LC.rearmLane(id, 'FB_BUYER_PHASE_2')
  assert.equal(r.unchanged, true)
})

// ---- STEP 14: the report that would have caught the phase 2 bug ---------------------

test('a lead owned by a sending lane with nothing queued is reported as silent', () => {
  const id = mkLead({ owner: 'FB_BUYER_PHASE_2' })
  comm(id, 'outgoing', agoIso(120), 'ai')     // owned, quiet, nothing pending
  const rep = REP.silentLeads({ quietDays: 30, limit: 1000 })
  assert.equal(rep.ok, true)
  assert.ok(rep.leads.some(l => l.id === id), 'the black-hole detector missed a silent lead')
})

test('a lane with a touch queued is NOT reported as silent', () => {
  const id = mkLead({ owner: 'FB_BUYER_PHASE_2' })
  comm(id, 'outgoing', agoIso(120), 'ai')
  pending(id, 'AI_BUYER_PHASE2')
  const rep = REP.silentLeads({ quietDays: 30, limit: 1000 })
  assert.ok(!rep.leads.some(l => l.id === id))
})

test('owners that are silent on purpose are not flagged', () => {
  const id = mkLead({ owner: 'HUMAN_OWNED' })
  comm(id, 'outgoing', agoIso(120), 'human')
  const rep = REP.silentLeads({ quietDays: 30, limit: 1000 })
  assert.ok(!rep.leads.some(l => l.id === id), 'a human handling a lead is not a black hole')
})

test('the report still answers when asked for everything at once', () => {
  const r = REP.buyerLaneReport({ quietDays: 30, days: 7 })
  assert.ok(Array.isArray(r.ownership))
  assert.ok(Array.isArray(r.history))
  assert.ok(r.silent)
})
