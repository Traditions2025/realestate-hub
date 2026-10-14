// The cross-campaign email frequency cap (John, 2026-10-14): 1 a day, 2 a rolling week,
// counted across every campaign and manual send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

// Own database: these tests seed email_log, and a shared DB would both pollute other
// suites and let their rows change these counts.
const DIR = join(os.tmpdir(), 'hubcap_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const {
  emailCapState, emailCapBlock, recentLeadEmails, weeklyEmailCap, dailyEmailCap, isExemptTag,
} = await import('../server/email-cap.js')

const HOUR = 3600000
const DAY = 86400000
const iso = (ms) => new Date(ms).toISOString()

let seq = 0
function mkClient(email) {
  const id = 900000 + (++seq)
  db.run('INSERT OR REPLACE INTO clients (id, first_name, last_name, email, status, type) VALUES (?,?,?,?,?,?)',
    [id, 'Cap', 'Test' + seq, email || `cap${seq}@example.com`, 'new', 'buyer'])
  return id
}
function logEmail(cid, { at, template = 'drip_20', status = 'sent', delivery = null, to = null }) {
  db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, delivery_status, sent_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    [cid, to || db.get('SELECT email FROM clients WHERE id=?', [cid])?.email || 'x@example.com',
     'subject', 'body', template, status, delivery, iso(at)])
}

test('defaults are 2 a week and 1 a day', () => {
  db.setSetting('max_emails_per_week', '2')
  db.setSetting('max_emails_per_day', '1')
  assert.equal(weeklyEmailCap(), 2)
  assert.equal(dailyEmailCap(), 1)
})

test('a lead with no history is not capped', () => {
  const cid = mkClient()
  const s = emailCapState(cid)
  assert.equal(s.count_week, 0)
  assert.equal(s.capped, false)
  assert.equal(emailCapBlock(cid, 'drip_20'), null)
})

test('one email three days ago leaves room for a second', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 3 * DAY })
  const s = emailCapState(cid)
  assert.equal(s.count_week, 1)
  assert.equal(s.capped, false, 'one in the window is under the cap of 2')
})

test('two in the window caps the third', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY })
  logEmail(cid, { at: Date.now() - 4 * DAY })
  const s = emailCapState(cid)
  assert.equal(s.count_week, 2)
  assert.equal(s.capped, true)
  assert.match(s.reason, /2 emails in the last 7 days/)
})

test('the cap counts ACROSS campaigns, not per campaign', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY, template: 'drip_20' })
  logEmail(cid, { at: Date.now() - 3 * DAY, template: 'drip_2' })
  assert.equal(emailCapState(cid).capped, true, 'two different drips still add up to 2')
})

test('a MANUAL send counts toward the cap', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY, template: '385' })   // manual listing blast
  logEmail(cid, { at: Date.now() - 3 * DAY, template: null })    // composer, untagged
  const s = emailCapState(cid)
  assert.equal(s.count_week, 2)
  assert.equal(s.capped, true, 'the inbox does not care that a human sent it')
})

test('next_eligible_at is when the 2nd-newest ages out, not just tomorrow', () => {
  const cid = mkClient()
  const newest = Date.now() - 1 * DAY
  const second = Date.now() - 5 * DAY
  logEmail(cid, { at: newest })
  logEmail(cid, { at: second })
  const s = emailCapState(cid)
  const want = second + 7 * DAY
  const got = Date.parse(s.next_eligible_at)
  assert.ok(Math.abs(got - want) < 60000, `expected ~${iso(want)}, got ${s.next_eligible_at}`)
  assert.ok(got > Date.now() + DAY, 'and that is further out than tomorrow')
})

test('one email today caps today even when the week has room', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * HOUR })
  const s = emailCapState(cid)
  assert.equal(s.count_week, 1, 'only one in the week, so the weekly cap is not hit')
  assert.equal(s.count_today, 1)
  assert.equal(s.capped, true, 'but the daily cap of 1 is')
  assert.match(s.reason, /already emailed today/)
})

test('failed sends, bounces and drops do not count', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY, status: 'failed' })
  logEmail(cid, { at: Date.now() - 3 * DAY, delivery: 'bounce' })
  logEmail(cid, { at: Date.now() - 4 * DAY, delivery: 'dropped' })
  const s = emailCapState(cid)
  assert.equal(s.count_week, 0, 'an email that never arrived was not an email they got')
  assert.equal(s.capped, false)
})

test('test-harness traffic does not count', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY, template: 'drip_test_20' })
  logEmail(cid, { at: Date.now() - 3 * DAY, template: 'drip_test_5' })
  assert.equal(emailCapState(cid).count_week, 0)
})

test('an email just outside 7 days has aged out', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - (7 * DAY + HOUR) })
  logEmail(cid, { at: Date.now() - 2 * DAY })
  const s = emailCapState(cid)
  assert.equal(s.count_week, 1, 'the 7-day-old one is outside the window')
  assert.equal(s.capped, false)
})

test('transactional and first-contact sends are exempt and never blocked', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY })
  logEmail(cid, { at: Date.now() - 3 * DAY })
  assert.equal(emailCapState(cid).capped, true, 'this lead is at the cap')
  for (const tag of ['home_value_followup', 'fb_ad_email', 'ai_handoff']) {
    assert.ok(isExemptTag(tag), `${tag} should be exempt`)
    assert.equal(emailCapBlock(cid, tag), null, `${tag} must still send`)
  }
  assert.ok(emailCapBlock(cid, 'drip_20'), 'while a drip is still held')
})

test('an exempt send does not consume the cap for later nurture', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY, template: 'home_value_followup' })
  logEmail(cid, { at: Date.now() - 3 * DAY, template: 'fb_ad_email' })
  const s = emailCapState(cid)
  assert.equal(s.count_week, 0, 'answering them is not a marketing touch')
  assert.equal(s.capped, false)
})

test('a duplicate record on the same address shares the budget', () => {
  const addr = `dupe${Date.now()}@example.com`
  const a = mkClient(addr)
  const b = mkClient(addr)
  logEmail(a, { at: Date.now() - 2 * DAY, to: addr })
  logEmail(a, { at: Date.now() - 4 * DAY, to: addr })
  assert.equal(emailCapState(b).capped, true, 'two records, one inbox, one budget')
})

test('raising the cap lets the next one through without a deploy', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 2 * DAY })
  logEmail(cid, { at: Date.now() - 4 * DAY })
  assert.equal(emailCapState(cid).capped, true)
  db.setSetting('max_emails_per_week', '3')
  assert.equal(emailCapState(cid).capped, false, 'cap of 3 leaves room')
  db.setSetting('max_emails_per_week', '2')
  assert.equal(emailCapState(cid).capped, true)
})

test('recentLeadEmails reports newest first, which next_eligible_at depends on', () => {
  const cid = mkClient()
  logEmail(cid, { at: Date.now() - 5 * DAY, template: 'drip_5' })
  logEmail(cid, { at: Date.now() - 1 * DAY, template: 'drip_2' })
  logEmail(cid, { at: Date.now() - 3 * DAY, template: 'drip_20' })
  const r = recentLeadEmails(cid)
  assert.deepEqual(r.map(x => x.template), ['drip_2', 'drip_20', 'drip_5'])
})
