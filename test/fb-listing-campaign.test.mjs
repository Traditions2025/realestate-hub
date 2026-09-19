// FB listing-lead 30-day campaign (John, 2026-09-18) — the non-negotiables:
// John's copy VERBATIM; Day 2→30 cadence (Day 0 belongs to the existing opener
// pipeline); enrollment starts at the right step for late joiners with a 1-day
// grace; a prior reply means the campaign never activates; property steps are
// flagged so a pending/sold pivot can skip them; pivot texts match John's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const m = await import('../server/fb-listing-campaign.js')
m.initFbListingCampaign()
const { FB_LISTING_STEPS: STEPS, FB_LISTING_PIVOTS: PIVOTS } = m

const seeded = { clients: [], comms: [], tx: [] }
function mkClient() {
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, phone, created_at, updated_at)
    VALUES ('Fblc','Test${Date.now()}${Math.floor(Math.random() * 1e6)}','buyer','new','(319) 555-0000',?,?)`,
    [new Date().toISOString(), new Date().toISOString()])
  seeded.clients.push(r.lastInsertRowid)
  return r.lastInsertRowid
}

test('cadence is Day 2/4/7/10/14/20/23/30 with the right channels', () => {
  assert.deepEqual(STEPS.map(s => [s.day, s.ch]),
    [[2, 'sms'], [4, 'email'], [7, 'sms'], [10, 'email'], [14, 'sms'], [20, 'sms'], [23, 'email'], [30, 'sms']])
  // Property-availability steps end at Day 14; 20/23/30 survive a pivot.
  assert.deepEqual(STEPS.map(s => s.property), [true, true, true, true, true, false, false, false])
})

test("John's copy is verbatim", () => {
  assert.equal(STEPS[0].text('Bev', '510 Broadway Springville'),
    'Hi Bev :) Just following up on 510 Broadway Springville. Was there anything about the home you wanted more information on?')
  assert.equal(STEPS[2].text('Rich', 'X'),
    "Hello Rich, just checking back on X. Is that one still on your radar, or did you decide it wasn't quite what you're looking for?")
  assert.equal(STEPS[5].text('Ann', 'X'),
    'Hi Ann, John with Matt Smith Team :) Just curious, was X mainly what caught your attention, or have you been looking at other homes too?')
  assert.equal(STEPS[7].text('Ann', 'X'),
    'Hi Ann :) Wanted to check in one more time since you originally reached out through X. Are you still keeping an eye on homes, or has the home search been put on hold for now?')
  assert.equal(STEPS[1].subject('X'), 'Still interested in X?')
  assert.equal(STEPS[3].subject(), 'Was it this home or something similar?')
  assert.equal(STEPS[6].subject(), 'Keeping an eye out')
  assert.ok(PIVOTS.pending('A', 'X').includes('It looks like that one is now pending.'))
  assert.ok(PIVOTS.sold('A', 'X').includes('That one is no longer available.'))
  assert.ok(PIVOTS.price('A', 'X', '$250,000').includes('The price was just adjusted to $250,000.'))
})

test('fresh enrollment starts at Day 2', () => {
  const id = mkClient()
  const r = m.enrollFbListingCampaign(id, '510 Broadway Springville', { actor: 'test' })
  assert.equal(r.status, 'active')
  assert.equal(r.next_step, 'd2_sms')
  assert.ok(r.next_send_at)
})

test('late enrollment starts at the right step, with a 1-day grace', () => {
  const id = mkClient()
  const r = m.enrollFbListingCampaign(id, 'X', { day0Iso: new Date(Date.now() - 7.9 * 86400000).toISOString(), actor: 'test' })
  assert.equal(r.next_step, 'd7_sms')   // 7.9 days elapsed: d7 is 0.9 days late = inside grace
  const r2 = m.enrollFbListingCampaign(mkClient(), 'X', { day0Iso: new Date(Date.now() - 8.5 * 86400000).toISOString(), actor: 'test' })
  assert.equal(r2.next_step, 'd10_email')  // 8.5 days: d7 is out of grace
})

test('a lead who already replied never activates', () => {
  const id = mkClient()
  const day0 = new Date(Date.now() - 2 * 86400000).toISOString()
  const c = db.run(`INSERT INTO communications (channel, direction, client_id, body, occurred_at) VALUES ('text','incoming',?,?,?)`,
    [id, 'just looking thanks', new Date().toISOString()])
  seeded.comms.push(c.lastInsertRowid)
  const r = m.enrollFbListingCampaign(id, 'X', { day0Iso: day0, actor: 'test' })
  assert.equal(r.status, 'responded')
  assert.equal(r.next_send_at, null)
})

test('past-day-30 enrollment completes instead of activating', () => {
  const r = m.enrollFbListingCampaign(mkClient(), 'X', { day0Iso: new Date(Date.now() - 45 * 86400000).toISOString(), actor: 'test' })
  assert.equal(r.status, 'completed')
})

test('listingState maps transaction statuses', () => {
  assert.equal(m.listingState({ property_status: 'Active' }), 'active')
  assert.equal(m.listingState({ property_status: 'Pending' }), 'pending')
  assert.equal(m.listingState({ property_status: 'Under Contract' }), 'pending')
  assert.equal(m.listingState({ property_status: 'Clear to Close' }), 'pending')
  assert.equal(m.listingState({ property_status: 'Closed' }), 'sold')
  assert.equal(m.listingState(null), 'unknown')
})

test('findListingTransaction matches by street number + name', () => {
  const t = db.run(`INSERT INTO transactions (property_address, type, property_status, created_at, updated_at)
    VALUES ('99871 Fblctest St, Springville, IA', 'listing', 'Active', ?, ?)`, [new Date().toISOString(), new Date().toISOString()])
  seeded.tx.push(t.lastInsertRowid)
  const found = m.findListingTransaction('99871 Fblctest Springville')
  assert.equal(found?.id, t.lastInsertRowid)
  assert.equal(m.findListingTransaction('nonsense label'), null)
})

test('cleanup seeded rows', () => {
  for (const id of seeded.clients) {
    db.run('DELETE FROM clients WHERE id=?', [id])
    db.run('DELETE FROM fb_listing_campaigns WHERE client_id=?', [id])
    db.run('DELETE FROM fb_listing_campaign_log WHERE client_id=?', [id])
  }
  for (const id of seeded.comms) db.run('DELETE FROM communications WHERE id=?', [id])
  for (const id of seeded.tx) db.run('DELETE FROM transactions WHERE id=?', [id])
})

test('weekend exemption: FB windows include Saturday/Sunday, 9-4 CT only', () => {
  // Sat 2027-06-19 10:00 CT (15:00Z in June/CDT) is IN window and stays Saturday.
  const satMorning = new Date('2027-06-19T15:00:00Z')
  assert.ok(m.inFbWindow(satMorning))
  assert.equal(m.nextFbSlot(satMorning).toISOString(), satMorning.toISOString())
  // Sat 20:00 CT is after hours -> rolls to SUNDAY morning, not Monday.
  const satNight = new Date('2027-06-20T01:00:00Z')
  const rolled = m.nextFbSlot(satNight)
  const ct = new Date(rolled).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hour12: false })
  assert.ok(ct.startsWith('Sun'), 'rolls to Sunday: ' + ct)
  assert.ok(!m.inFbWindow(satNight))
})
