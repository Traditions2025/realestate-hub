// LEADS FROM THE IOWA DOWN PAYMENT ASSISTANCE PAGE GET NO AI, NO DRIP, NO AUTO EMAIL.
//
// Leon, 2026-11-20: "for leads on this campaign just pause anything A, drip, auto email".
// The marker is the Sierra tag "iowa-dpa", set by the landing page posting through
// /contact/?utm_campaign=iowa-dpa.
//
// Three things make this worth real tests rather than source assertions:
//
//   1. These leads arrive as ordinary status-NEW website registrations. That is exactly
//      the pool the AI fresh lane draws from, so "nothing owns them" is the default and
//      the tag is the only thing standing in the way.
//   2. A guard that reads a column its own query did not SELECT is silently dead.
//      dripBlockReason fetched status/email/email_status and nothing else, so the
//      enrolment test below is really a test that `tags` is on the row.
//   3. Over-blocking is the opposite failure and just as bad: these people filled in a
//      form and are waiting to hear back. Every test here has an untagged control, and
//      the manual channels are asserted to STILL work.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'

await initDb()

const {
  hasTag, suppressedCampaignReason, autoEmailSuppressedReason, isLeadInitiatedEmail, SUPPRESSED_TAGS,
} = await import('../server/suppressed-campaigns.js')

const TAG = 'iowa-dpa'
const now = () => new Date().toISOString()
let seq = 0

/**
 * A phone number no other record in this database holds.
 *
 * duplicateTwin() in forbidden.js refuses the AI for any lead sharing a phone with
 * another live record, and it is checked BEFORE the campaign rules. A hard-coded or
 * narrow-range number collides with the leads other test files insert, and the whole
 * suite then fails here for a reason that has nothing to do with this feature.
 */
const freePhone = () => {
  for (let i = 0; i < 200; i++) {
    const d10 = '319' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0')
    const clash = db.all('SELECT phone FROM clients WHERE phone LIKE ?', ['%' + d10.slice(-4)])
      .some((c) => String(c.phone || '').replace(/\D/g, '').slice(-10) === d10)
    if (!clash) return `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}`
  }
  throw new Error('could not find an unused phone number for the test')
}

/** A real clients row, with a unique phone/email so duplicateTwin does not block instead. */
const mk = (tags = null, over = {}) => {
  seq++
  const uniq = `${Date.now()}${seq}${Math.floor(Math.random() * 1e6)}`
  return db.run(`INSERT INTO clients (first_name, last_name, phone, email, type, status, tags, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Test', 'Account', freePhone(), `dpa${uniq}@example.com`,
      'buyer', over.status || 'new', tags ? JSON.stringify(tags) : null, now(), now()]).lastInsertRowid
}
const row = (id) => db.get('SELECT * FROM clients WHERE id=?', [id])

// The two shapes that actually arrive, taken from the live submissions Leon verified:
//   lead 2596677  tags=["iowa-dpa"]
//   lead 2596678  tags=["ia_form_check","iowa-dpa"]   <- the ad's own tag kept too
const tagged = () => row(mk([TAG]))
const taggedWithAdTag = () => row(mk(['ia_form_check', TAG]))
const plain = () => row(mk(['Buyer', 'Cedar Rapids']))

// ── the tag test itself ──────────────────────────────────────────────────────────────
// clients.tags is a JSON array string. A bare substring match would be wrong in a file
// where tags like "Buyer" and "BUYER LEADS NEW" coexist, so the element is matched whole.

test('the tag is matched as a whole element, in either live shape', () => {
  assert.ok(hasTag(tagged(), TAG))
  assert.ok(hasTag(taggedWithAdTag(), TAG), 'the ad campaign tag riding along must not hide it')
})

test('a longer tag that merely CONTAINS the name does not match', () => {
  // the failure this prevents: a future "iowa-dpa-2027" campaign silently inheriting the
  // suppression, or worse, a tag like "no-iowa-dpa" matching it
  assert.equal(hasTag({ tags: JSON.stringify(['iowa-dpa-2027']) }, TAG), false)
  assert.equal(hasTag({ tags: JSON.stringify(['not-iowa-dpa']) }, TAG), false)
  assert.equal(suppressedCampaignReason({ tags: JSON.stringify(['iowa-dpa-2027']) }), null)
})

test('case does not matter, because Sierra does not promise one', () => {
  assert.ok(hasTag({ tags: JSON.stringify(['IOWA-DPA']) }, TAG))
  assert.ok(hasTag({ tags: JSON.stringify(['Iowa-DPA']) }, TAG))
})

test('a lead with no tags, or a null row, is not suppressed', () => {
  assert.equal(suppressedCampaignReason(row(mk(null))), null)
  assert.equal(suppressedCampaignReason(null), null)
  assert.equal(suppressedCampaignReason({}), null)
})

test('an unparseable tags column still suppresses rather than throwing', () => {
  // defensive: the guard failing OPEN would text somebody, so a malformed column must
  // not be the thing that decides it
  assert.equal(hasTag({ tags: '["iowa-dpa"' }, TAG), true, 'truncated JSON falls back to the quoted form')
  assert.equal(hasTag({ tags: 'iowa-dpa' }, TAG), false, 'an unquoted bare word is not an element')
})

test('the reason names the campaign, so a skip in the log is readable', () => {
  assert.match(String(suppressedCampaignReason(tagged())), /down payment/i)
  assert.equal(SUPPRESSED_TAGS.length, 1, 'one tag today; this is the list to edit to lift it')
})

// ── 1. AI ────────────────────────────────────────────────────────────────────────────
const { aiForbiddenReason } = await import('../server/ai-followup/forbidden.js')

test('the AI is forbidden from an iowa-dpa lead', () => {
  assert.match(String(aiForbiddenReason(tagged())), /down payment/i)
})

test('the AI is NOT forbidden from an ordinary new lead', () => {
  assert.equal(aiForbiddenReason(plain()), null, 'the guard must not switch the AI off for the base')
})

test('the tag arriving AFTER enrolment still blocks', () => {
  // the lesson from Joseph Green: an enrolment-time fence never runs again. Sierra can
  // add the tag on a later sync than the one that created the record.
  const id = mk(null)
  assert.equal(aiForbiddenReason(row(id)), null)
  db.run('UPDATE clients SET tags=? WHERE id=?', [JSON.stringify([TAG]), id])
  assert.match(String(aiForbiddenReason(row(id))), /down payment/i)
})

// ── 2. Texts: drip, automation, bulk and AI, from ONE placement ──────────────────────
const { canSendSms, canAutomatedSend } = await import('../server/ai-followup/policy.js')

test('every automated text channel is denied', () => {
  const c = tagged()
  for (const channel of ['automation', 'bulk', 'drip', 'ai']) {
    const g = canSendSms(c, { channel })
    assert.equal(g.ok, false, `channel ${channel} must be denied`)
    assert.match(String(g.reason), /down payment/i, `channel ${channel} reason`)
  }
})

test('a FORCED AI send is denied too', () => {
  // "Send AI now" is how Megan Walt got two texts she should never have had: the force
  // flag skips the AI gates, so a campaign fence that sits inside them is no fence.
  const g = canSendSms(tagged(), { channel: 'ai', mode: 'responsive', force: true })
  assert.equal(g.ok, false)
  assert.match(String(g.reason), /down payment/i)
})

test('canAutomatedSend is denied, which is what covers drip and bulk in practice', () => {
  // cx-connect, fsbo, the automations builder and the inbox bulk texter all come through
  // here rather than calling canSendSms themselves
  for (const source of ['drip', 'automation', 'bulk']) {
    const g = canAutomatedSend(tagged(), { source, dedupMinutes: 0, respectQuietHours: false })
    assert.equal(g.ok, false, source)
    assert.match(String(g.reason), /down payment/i, source)
  }
})

test('A PERSON CAN STILL TEXT THEM BY HAND', () => {
  // the whole point. They filled in a form; pausing the automation is not silence.
  const g = canSendSms(tagged(), { channel: 'manual' })
  assert.equal(g.ok, true, 'a manual 1:1 text must not be blocked: ' + g.reason)
})

test('an appointment they booked still gets its reminder text', () => {
  // scheduling.js passes transactional:true. Without it, a lead who books a walkthrough
  // gets the confirmation email but no reminder text, which is just a broken appointment.
  const g = canSendSms(tagged(), { channel: 'automation', transactional: true })
  assert.equal(g.ok, true, 'transactional sends must pass: ' + g.reason)
})

test('transactional does NOT become a hole in compliance', () => {
  // it forgives the campaign suppression only; STOP still means stop
  const id = mk([TAG])
  db.run('UPDATE clients SET hub_text_opt_out=1 WHERE id=?', [id])
  const g = canSendSms(row(id), { channel: 'automation', transactional: true })
  assert.equal(g.ok, false)
  assert.match(String(g.reason), /STOP/i)
})

test('an ordinary lead still passes the automated text gate', () => {
  const g = canSendSms(plain(), { channel: 'automation' })
  assert.equal(g.ok, true, 'the base must keep working: ' + g.reason)
})

// ── 3. Automated email ───────────────────────────────────────────────────────────────
const { sendSequenceEmail } = await import('../server/routes/email.js')

test('the shared sequence sender refuses a drip email, before any send', async () => {
  // sendSequenceEmail is the one path behind drip steps, listing alerts and the home
  // value sequence. It returns before touching SendGrid, which is why this is safe to run.
  const r = await sendSequenceEmail(tagged(), { subject: 'Hi', body: '<p>Hi</p>' }, 'drip_7')
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /down payment/i)
})

test('a reply to something they did is still allowed through', () => {
  const c = tagged()
  for (const cat of ['appointment_confirmation', 'appointment_reminder',
    'home_value_followup', 'home_value_response', 'home_value_report', 'drip_test_4']) {
    assert.equal(autoEmailSuppressedReason(c, cat), null, cat + ' must not be suppressed')
    assert.equal(isLeadInitiatedEmail(cat), true, cat)
  }
})

test('campaign and nurture categories are suppressed', () => {
  const c = tagged()
  for (const cat of ['drip_7', 'fb_listing_campaign', 'fb_ad_email', 'camp_12', null]) {
    assert.match(String(autoEmailSuppressedReason(c, cat)), /down payment/i, String(cat))
  }
})

test('an ordinary lead is unaffected on every category', () => {
  const c = plain()
  for (const cat of ['drip_7', 'fb_listing_campaign', null]) {
    assert.equal(autoEmailSuppressedReason(c, cat), null, String(cat))
  }
})

// ── 4. Drip ENROLMENT: they never join in the first place ────────────────────────────
const { dripBlockReason } = await import('../server/routes/drips.js')

const dripId = db.run('INSERT INTO drip_campaigns (name, steps) VALUES (?,?)',
  ['Test Account suppression drip', JSON.stringify([{ subject: 's', body: 'b', delay_days: 0 }])]).lastInsertRowid

test('an iowa-dpa lead cannot be enrolled in a drip', () => {
  // THIS IS ALSO THE TEST THAT `tags` IS ON dripBlockReason's SELECT. The query used to
  // fetch status/email/email_status only, so the check would have read undefined and
  // waved every one of these leads straight through.
  const r = dripBlockReason(dripId, tagged().id)
  assert.ok(r, 'enrolment must be refused')
  assert.match(String(r.reason), /down payment/i)
})

test('an ordinary lead can still be enrolled', () => {
  const r = dripBlockReason(dripId, plain().id)
  assert.equal(r, null, 'drips must keep working for everybody else: ' + JSON.stringify(r))
})

// ── 5. the suppression is reversible ─────────────────────────────────────────────────
test('dropping the tag frees the lead again', () => {
  // Leon may want these leads nurtured later. Removing the tag in the Hub is enough;
  // nothing else was written to the record, so there is no second thing to undo.
  const id = mk([TAG])
  assert.match(String(aiForbiddenReason(row(id))), /down payment/i)
  db.run('UPDATE clients SET tags=? WHERE id=?', [JSON.stringify(['Buyer']), id])
  assert.equal(aiForbiddenReason(row(id)), null)
  assert.equal(canSendSms(row(id), { channel: 'automation' }).ok, true)
})

test('no row is written to the client to mark the suppression', () => {
  // it is derived from the tag every time it is asked, so Sierra remains the source of
  // truth and nothing has to be back-filled for leads that synced before this shipped
  const c = tagged()
  assert.equal(c.marketing_email_opt_out || 0, 0,
    'marketing_email_opt_out must NOT be used: the Sierra sync overwrites it every hour')
  assert.equal(c.hub_text_opt_out || 0, 0)
})
