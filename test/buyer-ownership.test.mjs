// Ownership is the thing that stops two campaigns texting one person, so the transitions
// matter at least as much as the initial assignment. These walk a lead through the states
// John listed, in order, and check it lands where it should at each step.
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
const RP = await import('../server/buyer-reply-parse.js')

const BASE = 990100
let seq = 0
const nowIso = () => new Date().toISOString()
const agoIso = (days) => new Date(Date.now() - days * 86400000).toISOString()

function mkLead({ status = 'new', type = 'buyer', createdDays = 400, tags = '[]', source = 'Import' } = {}) {
  const id = BASE + (++seq)
  db.run('DELETE FROM communications WHERE client_id=?', [id])
  db.run('DELETE FROM fb_listing_campaigns WHERE client_id=?', [id])
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, type, status, source, tags, created_at, communication_owner, communication_owner_prev)
          VALUES (?,?,?,?,?,?,?,?,'NONE',NULL)`,
  [id, 'Test', 'Lead' + seq, type, status, source, tags, agoIso(createdDays)])
  return id
}
const comm = (id, direction, channel, when, sentBy = null) =>
  db.run('INSERT INTO communications (channel, direction, client_id, occurred_at, sent_by_type, preview) VALUES (?,?,?,?,?,?)',
    [channel, direction, id, when, sentBy, 'test'])

test('an old lead that never replied is COLD_HISTORY_UNKNOWN, not previously-connected', () => {
  const id = mkLead()
  comm(id, 'outgoing', 'text', agoIso(200), 'ai')
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'COLD_HISTORY_UNKNOWN')
  assert.equal(LC.hasRealConversation(id), false)
})

test('an old lead with genuine two-way history is COLD_KNOWN_CONNECTED', () => {
  const id = mkLead()
  comm(id, 'outgoing', 'text', agoIso(210), 'ai')
  comm(id, 'incoming', 'text', agoIso(209))
  comm(id, 'outgoing', 'text', agoIso(209), 'human')
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'COLD_KNOWN_CONNECTED')
})

test('one stray inbound and nothing else is not a conversation', () => {
  const id = mkLead()
  comm(id, 'incoming', 'text', agoIso(300))
  assert.equal(LC.hasRealConversation(id), false)
})

test('a new Facebook ad lead is owned by FB_LISTING_PHASE_1', () => {
  const id = mkLead({ createdDays: 0, tags: '["FB Ad: 3485 Willowridge Rd Marion"]', source: 'Facebook Listing Ad' })
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'FB_LISTING_PHASE_1')
})

test('when the listing campaign ends the lead becomes FB_BUYER_PHASE_2, never cold buyer', () => {
  const id = mkLead({ createdDays: 40, tags: '["FB Ad: 1625 Ranmar Dr Ely"]', source: 'Facebook Listing Ad' })
  db.run(`INSERT OR REPLACE INTO fb_listing_campaigns (client_id, listing_label, status, day0_at, next_step, enrolled_at, updated_at)
          VALUES (?,?,?,?,?,?,?)`, [id, '1625 Ranmar Dr Ely', 'active', agoIso(40), 0, agoIso(40), agoIso(40)])
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'FB_LISTING_PHASE_1')

  db.run("UPDATE fb_listing_campaigns SET status='completed' WHERE client_id=?", [id])
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'FB_BUYER_PHASE_2', 'a finished listing lead must not fall into cold buyer')
})

test('a reply takes the lead to HUMAN_OWNED, and the claim lapses when it goes quiet', () => {
  const id = mkLead()
  comm(id, 'outgoing', 'text', agoIso(100), 'ai')
  comm(id, 'incoming', 'text', nowIso())
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'HUMAN_OWNED')

  // Same lead, same history, but the conversation is now weeks old.
  db.run("UPDATE communications SET occurred_at=? WHERE client_id=? AND direction='incoming'", [agoIso(30), id])
  LC.syncOwner(id)
  assert.notEqual(P.currentOwner(id), 'HUMAN_OWNED', 'a quiet conversation must hand the lead back')
})

test('a campaign may not take a lead off a human who is still active', () => {
  const id = mkLead()
  comm(id, 'incoming', 'text', nowIso())
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'HUMAN_OWNED')
  const r = LC.syncOwner(id)
  assert.equal(r.unchanged, true)
})

test('under contract outranks everything', () => {
  const id = mkLead({ status: 'pending' })
  LC.syncOwner(id)
  assert.equal(P.currentOwner(id), 'TRANSACTIONAL')
})

test('a reactivation parks the previous owner and hands it back', () => {
  const id = mkLead()
  LC.syncOwner(id)
  const before = P.currentOwner(id)
  assert.equal(before, 'COLD_HISTORY_UNKNOWN')

  LC.enterBehaviorReactivation(id, 'browsed several listings')
  assert.equal(P.currentOwner(id), 'BEHAVIOR_REACTIVATION')
  assert.equal(P.previousOwner(id), before)

  LC.exitBehaviorReactivation(id, 'no reply in the window')
  assert.equal(P.currentOwner(id), before, 'the lead must return to its nurture, not be stranded')
})

test('a reactivation cannot displace a human', () => {
  const id = mkLead()
  comm(id, 'incoming', 'text', nowIso())
  LC.syncOwner(id)
  const r = LC.enterBehaviorReactivation(id, 'browsed again')
  assert.equal(r.ok, false)
  assert.equal(P.currentOwner(id), 'HUMAN_OWNED')
})

test('the gate refuses a campaign that does not own the lead', () => {
  const id = mkLead()
  db.run("UPDATE clients SET phone='(319) 555-0100', hub_text_opt_out=0, sms_undeliverable=0 WHERE id=?", [id])
  P.setOwner(id, 'FB_LISTING_PHASE_1', 'test')
  const client = db.get('SELECT * FROM clients WHERE id=?', [id])
  const mine = P.preSendGate(client, { owner: 'FB_LISTING_PHASE_1', source: 'automation' })
  const theirs = P.preSendGate(client, { owner: 'COLD_HISTORY_UNKNOWN', source: 'ai' })
  assert.equal(theirs.ok, false)
  assert.match(theirs.reason, /owns this lead/)
  // the owning campaign is judged on its own merits, not blocked by ownership
  assert.ok(mine.ok || !/owns this lead/.test(mine.reason))
})

test('ownership resolution is deterministic regardless of trigger order', () => {
  const id = mkLead({ createdDays: 40, tags: '["FB Ad: test"]', source: 'Facebook Listing Ad' })
  comm(id, 'incoming', 'text', nowIso())
  const a = LC.classifyOwner(id).owner
  const b = LC.classifyOwner(id).owner
  LC.syncOwner(id); LC.syncOwner(id); LC.syncOwner(id)
  assert.equal(a, b)
  assert.equal(P.currentOwner(id), a, 'repeated syncs must not drift')
})

test('a reply is parsed into stored facts', () => {
  const id = mkLead()
  db.run('DELETE FROM buyer_facts WHERE client_id=?', [id])

  RP.captureBuyerReply(id, 'We want something in Marion, 3 bedrooms, around 325k')
  assert.equal(BP.factState(id, 'preferred_location').value, 'Marion')
  assert.equal(BP.factState(id, 'beds_min').value, '3')
  assert.equal(BP.factState(id, 'preferred_location').state, 'fresh')
  db.run('DELETE FROM buyer_facts WHERE client_id=?', [id])
})

test.after(() => {
  db.run('DELETE FROM communications WHERE client_id >= ? AND client_id <= ?', [BASE, BASE + 999])
  db.run('DELETE FROM fb_listing_campaigns WHERE client_id >= ? AND client_id <= ?', [BASE, BASE + 999])
  db.run('DELETE FROM buyer_facts WHERE client_id >= ? AND client_id <= ?', [BASE, BASE + 999])
  db.run('DELETE FROM clients WHERE id >= ? AND id <= ?', [BASE, BASE + 999])
})
