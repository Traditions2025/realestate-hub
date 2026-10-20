// An FSBO seller replying does NOT end the campaign.
//
// John, 2026-10-20: "even when we get a response the campaign should still be on, please
// make sure FSBO campaign is only turned off if it was manually done."
//
// This reverses his own 2026-09-14 rule, under which any reply moved the record to
// 'responded' and cleared next_send_at. A seller answering a question is engagement, not
// a reason to go quiet on them — a person still answers every reply personally, and the
// schedule carries on underneath.
//
// Four things still end it, and only four:
//   - a human pausing or removing the campaign
//   - an explicit STOP
//   - a disqualifying reply (wrong number / sold / rented / listed with an agent /
//     holding / not interested)
//   - the listing leaving the market
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { handleFsboReply, isDisqualifyingReply, DISQUALIFYING_REPLY } = await import('../server/fsbo-followup.js')
const { classifyInbound } = await import('../server/cx-connect.js')

const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString()

function mkEnrolled() {
  const now = new Date().toISOString()
  const cid = db.run(`INSERT INTO clients (first_name, last_name, phone, type, status, address, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?,?)`,
    ['Fsbo', 'T' + Math.random().toString(36).slice(2, 7),
     '(319) 555-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
     'seller', 'new', '123 Test St', now, now]).lastInsertRowid
  db.run(`INSERT INTO fsbo_followups (client_id, status, enrolled_at, next_send_at, attempt_count, replied, updated_at)
          VALUES (?,?,?,?,?,?,?)`, [cid, 'active', now, FUTURE, 2, 0, now])
  return cid
}
const row = (cid) => db.get('SELECT * FROM fsbo_followups WHERE client_id=?', [cid])

// ── the change John asked for ────────────────────────────────────────────────────────
test('an ordinary reply leaves the campaign ACTIVE and the schedule intact', async () => {
  const cid = mkEnrolled()
  await handleFsboReply(cid, 'Yes it is still available, what did you have in mind?')
  const r = row(cid)
  assert.equal(r.status, 'active', 'the campaign must keep running')
  assert.equal(r.next_send_at, FUTURE, 'the next send must not be cleared')
  assert.equal(r.replied, 1, 'the reply is still recorded')
  assert.ok(r.responded_at, 'and timestamped, so the team can see it')
})

test('a question keeps it running too', async () => {
  const cid = mkEnrolled()
  await handleFsboReply(cid, 'Who is this?')
  assert.equal(row(cid).status, 'active')
  assert.equal(row(cid).next_send_at, FUTURE)
})

test('a second reply does not overwrite when they FIRST answered', async () => {
  const cid = mkEnrolled()
  await handleFsboReply(cid, 'Still available')
  const first = row(cid).responded_at
  await new Promise(r => setTimeout(r, 5))
  await handleFsboReply(cid, 'Any update?')
  assert.equal(row(cid).responded_at, first, 'responded_at records the first reply')
  assert.equal(row(cid).status, 'active')
})

// ── what still ends it ───────────────────────────────────────────────────────────────
test('STOP still ends it — that is the law, not a preference', async () => {
  const cid = mkEnrolled()
  await handleFsboReply(cid, 'STOP')
  const r = row(cid)
  assert.equal(r.status, 'stopped')
  assert.match(String(r.stop_reason), /opt-out/i)
})

test('"not interested" ends it — persistence past a no is harassment', async () => {
  const cid = mkEnrolled()
  await handleFsboReply(cid, 'Not interested, thanks.')
  const r = row(cid)
  assert.equal(r.status, 'stopped')
  assert.equal(r.response_class, 'NOT_INTERESTED')
  assert.equal(r.next_send_at, null)
})

test('a wrong number ends it — every further text bothers an uninvolved person', async () => {
  const cid = mkEnrolled()
  await handleFsboReply(cid, 'You have the wrong number')
  assert.equal(row(cid).status, 'stopped')
  assert.equal(row(cid).response_class, 'WRONG_NUMBER')
})

test('sold or already listed ends it — there is nothing left to win', async () => {
  for (const [body, cls] of [
    ['We already sold it', 'SOLD'],
    ['We listed with another agent', 'LISTED_WITH_AGENT'],
    ['We decided to keep it', 'HOLDING_PROPERTY'],
    ['We are renting it out instead', 'RENTED'],
  ]) {
    const cid = mkEnrolled()
    await handleFsboReply(cid, body)
    assert.equal(row(cid).status, 'stopped', `${body} should stop the campaign`)
    assert.equal(row(cid).response_class, cls)
  }
})

// ── the rule is one list, consulted everywhere ───────────────────────────────────────
test('the disqualifying list is exactly the six intended', () => {
  assert.deepEqual([...DISQUALIFYING_REPLY].sort(),
    ['HOLDING_PROPERTY', 'LISTED_WITH_AGENT', 'NOT_INTERESTED', 'RENTED', 'SOLD', 'WRONG_NUMBER'])
})

test('engagement classes are NOT disqualifying', () => {
  for (const body of [
    'Still available',
    'Call me',
    'Maybe next spring',
    'What do you charge?',
  ]) {
    assert.equal(isDisqualifyingReply(classifyInbound(body)), false,
      `${body} (${classifyInbound(body)}) must keep the campaign running`)
  }
})

// ── nothing silently re-stops it elsewhere ───────────────────────────────────────────
import fs from 'node:fs'
const src = fs.readFileSync(new URL('../server/fsbo-followup.js', import.meta.url), 'utf8')

test('eligibility no longer excludes on a bare reply', () => {
  assert.ok(!/status === 'responded' \|\| row\?\.replied\) return out\('excluded'/.test(src),
    'the blanket RESPONSE_RECEIVED exclusion must be gone')
})

test('the prior-reply history scan no longer blocks on an ordinary reply', () => {
  assert.ok(!/PRIOR_RESPONSE/.test(src),
    'a seller who replied months ago can be enrolled again')
})

test('the inbound-since-enrollment safety net only fires on a disqualifying reply', () => {
  assert.match(src, /if \(inb && isDisqualifyingReply\(classify\(/)
})

test('manual pause and remove still win outright', () => {
  assert.match(src, /MANUAL_REMOVAL/)
  assert.match(src, /MANUAL_PAUSE/)
})

test('the migration that stamped every replier as responded is gone', () => {
  assert.ok(!/SET status='responded', responded_at=COALESCE/.test(src))
})

test('the team is told the campaign is still running', () => {
  assert.match(src, /campaign still running/)
  assert.match(src, /STILL RUNNING/)
})
