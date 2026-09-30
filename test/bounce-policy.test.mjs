// What happens to a lead when a message fails.
//
// The classification is the whole thing. Half the bounces on file turned out to be
// recoverable, so a blanket "three strikes" would have been wrong in BOTH directions: it
// hammers dead mailboxes two extra times each, and risks dropping real people whose inbox
// happened to be full that week. Nicole Long was in the second group.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { classifyFailure, applyFailure, removeFromActiveDrips, STOP_TAG,
        SOFT_MIN_FAILURES, SOFT_MIN_SPAN_DAYS } = await import('../server/bounce-policy.js')

// ── classification ───────────────────────────────────────────────────────────────────
test('a dead mailbox is permanent', () => {
  for (const r of [
    '550 5.1.1 The email account that you tried to reach does not exist',
    '550 5.4.1 Recipient address rejected: Access denied',
    '554 5.7.1 Recipient address rejected',
    '550 permanent failure for one or more recipients',
  ]) assert.equal(classifyFailure({ event_type: 'bounce', reason: r, sg_status: '5.1.1' }), 'permanent', r)
})

// The trap: Gmail and Outlook answer "inbox full" with a FIVE-series code. Reading the
// first digit alone throws away real people.
test('a full inbox is temporary even though the code starts with 5', () => {
  const cases = [
    ['5.2.2', '552 5.2.2 The recipient inbox is out of storage space'],
    ['5.2.1', '550 5.2.1 The email account that you tried to reach is inactive'],
    ['4.2.2', '452 4.2.2 The recipient inbox is out of storage space'],
  ]
  for (const [status, r] of cases)
    assert.equal(classifyFailure({ event_type: 'bounce', reason: r, sg_status: status }), 'temporary', r)
})

test('mailbox full beats the permanent wording when both could match', () => {
  // "mailbox unavailable" reads permanent, but "quota exceeded" in the same line does not
  assert.equal(classifyFailure({ event_type: 'bounce', sg_status: '5.5.0',
    reason: '550 mailbox unavailable: quota exceeded' }), 'temporary')
})

test('a spam report is its own thing', () => {
  assert.equal(classifyFailure({ event_type: 'spamreport' }), 'spam')
})

test('a block is throttling, not a bad address', () => {
  assert.equal(classifyFailure({ event_type: 'bounce', bounce_type: 'blocked', reason: 'temporarily deferred' }), 'temporary')
})

test('dropped means SendGrid already refused, so it is permanent', () => {
  assert.equal(classifyFailure({ event_type: 'dropped' }), 'permanent')
})

test('an unreadable failure changes nothing rather than guessing', () => {
  assert.equal(classifyFailure({ event_type: 'bounce', reason: '', sg_status: '' }), 'unknown')
  assert.equal(applyFailure(999999, { event_type: 'bounce' }), null)
})

// ── applying it ──────────────────────────────────────────────────────────────────────
let cid
const mk = () => {
  const now = new Date().toISOString()
  const r = db.run(`INSERT INTO clients (first_name, last_name, email, type, status, email_status, tags, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
    ['Bounce', 'T' + Math.random().toString(36).slice(2, 8),
     `b${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`, 'buyer', 'new', 'ValidAddress', '[]', now, now])
  return r.lastInsertRowid
}
beforeEach(() => { cid = mk() })

test('a permanent bounce stops marketing on the FIRST failure', () => {
  const r = applyFailure(cid, { event_type: 'bounce', sg_status: '5.1.1', reason: '550 5.1.1 does not exist' })
  assert.equal(r.action, 'stopped')
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  assert.equal(c.email_status, 'WrongAddress', 'the existing send gate blocks WrongAddress')
  assert.match(c.tags, /Email Stopped: Hard Bounce/)
})

test('the reason is recorded where a person will see it', () => {
  applyFailure(cid, { event_type: 'bounce', sg_status: '5.1.1', reason: '550 5.1.1 no such user' })
  const note = db.get("SELECT * FROM notes WHERE related_type='client' AND related_id=? ORDER BY id DESC", [cid])
  assert.ok(note, 'a note should be left on the profile')
  assert.match(note.content, /Hard Bounce/)
  assert.match(note.content, /no such user/, 'the actual SMTP reason, not a summary')
  const log = db.get("SELECT * FROM activity_log WHERE entity_type='client' AND entity_id=? ORDER BY id DESC", [cid])
  assert.equal(log.action, 'email_marketing_stopped')
})

test('a single full inbox does NOT stop anything', () => {
  const r = applyFailure(cid, { event_type: 'bounce', sg_status: '5.2.2', reason: '552 5.2.2 out of storage space' })
  assert.equal(r.action, 'kept')
  assert.equal(db.get('SELECT email_status FROM clients WHERE id=?', [cid]).email_status, 'ValidAddress')
})

test('repeated soft failures over a long enough span DO stop it', () => {
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString()
  for (const d of [45, 30, 0])
    db.run('INSERT INTO email_events (client_id, event_type, occurred_at, sg_event_id) VALUES (?,?,?,?)',
      [cid, 'bounce', day(d), 'ev' + cid + '_' + d])
  const r = applyFailure(cid, { event_type: 'bounce', sg_status: '5.2.2', reason: 'out of storage space' })
  assert.equal(r.action, 'stopped')
  assert.match(db.get('SELECT tags FROM clients WHERE id=?', [cid]).tags, /Repeated Soft Bounce/)
})

test('three failures in three DAYS is not enough, the span matters too', () => {
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString()
  for (const d of [2, 1, 0])
    db.run('INSERT INTO email_events (client_id, event_type, occurred_at, sg_event_id) VALUES (?,?,?,?)',
      [cid, 'bounce', day(d), 'evs' + cid + '_' + d])
  const r = applyFailure(cid, { event_type: 'bounce', sg_status: '5.2.2', reason: 'out of storage space' })
  assert.equal(r.action, 'kept', `${SOFT_MIN_FAILURES} failures must also span ${SOFT_MIN_SPAN_DAYS}+ days`)
})

test('a spam report stops marketing and sets the opt-out flag', () => {
  const r = applyFailure(cid, { event_type: 'spamreport' })
  assert.equal(r.stop, 'spam')
  const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
  assert.equal(c.email_status, 'ReportedAsSpam')
  assert.equal(c.marketing_email_opt_out, 1)
  assert.match(c.tags, /Email Stopped: Spam Report/)
})

test('applying twice does not double-tag', () => {
  applyFailure(cid, { event_type: 'bounce', sg_status: '5.1.1', reason: 'does not exist' })
  const again = applyFailure(cid, { event_type: 'bounce', sg_status: '5.1.1', reason: 'does not exist' })
  assert.equal(again.action, 'already-stopped')
  const tags = JSON.parse(db.get('SELECT tags FROM clients WHERE id=?', [cid]).tags)
  assert.equal(tags.filter(t => t === STOP_TAG.hard).length, 1)
})

test('a dry run changes nothing', () => {
  applyFailure(cid, { event_type: 'bounce', sg_status: '5.1.1', reason: 'does not exist' }, { dryRun: true })
  assert.equal(db.get('SELECT email_status FROM clients WHERE id=?', [cid]).email_status, 'ValidAddress')
})

test('stopping also pulls them out of live campaigns', () => {
  db.run('INSERT INTO drip_enrollments (drip_id, client_id, status, current_step, entered_at) VALUES (?,?,?,?,?)',
    [18, cid, 'active', 3, new Date().toISOString()])
  assert.equal(removeFromActiveDrips(cid), 1)
  assert.equal(db.get('SELECT status FROM drip_enrollments WHERE client_id=?', [cid]).status, 'removed')
})
