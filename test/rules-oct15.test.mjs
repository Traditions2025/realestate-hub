// John's rule changes, 2026-10-15.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubr15_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const CAP = await import('../server/email-cap.js')
const { PROACTIVE_END_HOUR, inProactiveWindow, nextValidSlot } = await import('../server/fsbo-followup.js')
const AREA = await import('../server/ai-followup/area-links.js')
const { applyOptOut } = await import('../server/ai-followup/policy.js')
const { evaluateAiEnrollmentEligibility } = await import('../server/ai-enrollment.js')
const { homeValueEligibility } = await import('../server/home-value-enroll.js')

const DAY = 86400000
let seq = 0
function mkClient(f = {}) {
  const id = 960000 + (++seq)
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, email, phone, status, type, address, tags)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, f.first_name || 'R', 'Test' + seq, f.email ?? `r${seq}@example.com`, f.phone ?? '3195550000',
     f.status || 'new', 'buyer', f.address ?? null, f.tags ?? null])
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}
const logEmail = (cid, at, tpl = 'drip_20') =>
  db.run(`INSERT INTO email_log (client_id, to_email, subject, body, template, status, sent_at)
          VALUES (?,?,?,?,?,?,?)`,
    [cid, db.get('SELECT email FROM clients WHERE id=?', [cid])?.email || 'x@e.com', 's', 'b', tpl, 'sent', new Date(at).toISOString()])
const logComm = (cid, channel, direction, at) =>
  db.run(`INSERT INTO communications (channel, direction, client_id, preview, body, thread_key, status, occurred_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    [channel, direction, cid, 'p', 'b', `c${cid}_${channel}`, 'read', new Date(at).toISOString()])

/* ---------- texting window now runs to 5PM ---------- */

test('the texting window ends at 5PM, not 4PM', () => {
  assert.equal(PROACTIVE_END_HOUR, 17)
})

test('4:30pm on a weekday is now inside the window', () => {
  // 16:30 Central = 21:30 or 22:30 UTC depending on DST; build it in Central terms
  const at430 = new Date('2026-10-15T21:30:00Z')   // 16:30 CDT
  assert.equal(inProactiveWindow(at430), true)
})

test('5:30pm is still outside it, and rolls forward', () => {
  const at530 = new Date('2026-10-15T22:30:00Z')   // 17:30 CDT
  assert.equal(inProactiveWindow(at530), false)
  assert.ok(nextValidSlot(at530) > at530, 'a send due then is pushed to the next slot')
})

/* ---------- no known area now sends the general search ---------- */

test('a lead with no known area gets the general search link, not silence', () => {
  const c = mkClient()
  const m = AREA.buildAreaMessage(c.id, { seed: 0 })
  assert.ok(m, 'a message is produced where it used to be null')
  assert.match(m.text, /property-search\/results/)
  assert.equal(AREA.countUrls(m.text), 1, 'still exactly one link')
})

test('the general fallback still never names a city', () => {
  const c = mkClient()
  const m = AREA.buildAreaMessage(c.id, { seed: 1 })
  assert.doesNotMatch(m.text, /Cedar Rapids|Marion|Hiawatha/i)
})

/* ---------- past clients: 1 email per 14 days ---------- */

test('a past client is capped at 1 email in 14 days', () => {
  const c = mkClient({ status: 'closed' })
  assert.equal(CAP.emailCapState(c.id).capped, false, 'nothing sent yet')
  logEmail(c.id, Date.now() - 10 * DAY)
  const s = CAP.emailCapState(c.id)
  assert.equal(s.past_client, true)
  assert.equal(s.count_fortnight, 1)
  assert.equal(s.capped, true, 'one email 10 days ago is already the limit')
  assert.match(s.reason, /past client/)
})

test('a past client is free again once 14 days have passed', () => {
  const c = mkClient({ status: 'closed' })
  logEmail(c.id, Date.now() - 15 * DAY)
  assert.equal(CAP.emailCapState(c.id).capped, false)
})

test('the "past client" tag counts even when the status does not say closed', () => {
  const c = mkClient({ status: 'new', tags: '["Past Client","2021"]' })
  logEmail(c.id, Date.now() - 9 * DAY)
  assert.equal(CAP.emailCapState(c.id).capped, true)
})

test('an ordinary lead still gets the normal 2 a week', () => {
  const c = mkClient({ status: 'new' })
  logEmail(c.id, Date.now() - 9 * DAY)
  assert.equal(CAP.emailCapState(c.id).capped, false, '9 days ago is outside the 7-day window')
})

/* ---------- STOP moves them to Junk ---------- */

test('a literal STOP moves the lead to Junk', () => {
  const c = mkClient({ status: 'new' })
  applyOptOut(c.id, 'stop', 'sms_reply')
  const after = db.get('SELECT status, hub_text_opt_out FROM clients WHERE id=?', [c.id])
  assert.equal(after.hub_text_opt_out, 1)
  assert.equal(String(after.status).toLowerCase(), 'junk')
})

test('a natural-language opt-out junks them too (John: "move both to Junk")', () => {
  const c = mkClient({ status: 'new' })
  applyOptOut(c.id, 'stop', 'sms_reply_nl')
  const after = db.get('SELECT status, hub_text_opt_out FROM clients WHERE id=?', [c.id])
  assert.equal(after.hub_text_opt_out, 1, 'texting blocked')
  assert.equal(String(after.status).toLowerCase(), 'junk', 'and out of everything else as well')
})

test('the phrases that junk someone, and the ones that must not', async () => {
  const { isNaturalOptOut } = await import('../server/ai-followup/policy.js')
  for (const s of ['stop texting me', 'take me off your list', 'please stop messaging me',
                   'remove me', 'lose my number', 'leave me alone', 'stop bothering me',
                   "don't contact me again", 'unsubscribe me']) {
    assert.equal(isNaturalOptOut(s), true, `should opt out: "${s}"`)
  }
  // Junking a live lead by mistake costs a client, so the near-misses are asserted too.
  for (const s of ['stop by the house tomorrow', 'stop sending me listings in that range',
                   "I don't check my text messages often", "I don't always answer texts",
                   'can you stop at the house on your way', 'no more than 300k please']) {
    assert.equal(isNaturalOptOut(s), false, `must NOT opt out: "${s}"`)
  }
})

test('START does not resurrect them out of Junk', () => {
  const c = mkClient({ status: 'new' })
  applyOptOut(c.id, 'stop', 'sms_reply')
  applyOptOut(c.id, 'start', 'sms_reply')
  const after = db.get('SELECT status, hub_text_opt_out FROM clients WHERE id=?', [c.id])
  assert.equal(after.hub_text_opt_out, 0, 'texting re-enabled')
  assert.equal(String(after.status).toLowerCase(), 'junk', 'status stays for a person to review')
})

/* ---------- Watch leads, split by address ---------- */

test('a Watch lead with NO address and no recent text is allowed into AI follow-up', () => {
  const c = mkClient({ status: 'watch', address: null })
  const ev = evaluateAiEnrollmentEligibility(c.id)
  assert.notEqual(ev.reason_code, 'STATUS_NOT_NEW', 'Watch is no longer refused outright')
  assert.notEqual(ev.reason_code, 'WATCH_HAS_ADDRESS')
  assert.notEqual(ev.reason_code, 'WATCH_RECENT_TEXT')
})

test('a Watch lead WITH an address is sent to Home Value instead', () => {
  const c = mkClient({ status: 'watch', address: '123 Main St' })
  assert.equal(evaluateAiEnrollmentEligibility(c.id).reason_code, 'WATCH_HAS_ADDRESS')
})

test('a Watch lead texted in the last 6 months is left to the person handling them', () => {
  const c = mkClient({ status: 'watch', address: null })
  logComm(c.id, 'text', 'outgoing', Date.now() - 30 * DAY)
  assert.equal(evaluateAiEnrollmentEligibility(c.id).reason_code, 'WATCH_RECENT_TEXT')
})

test('a text older than 6 months does not block the Watch lead', () => {
  const c = mkClient({ status: 'watch', address: null })
  logComm(c.id, 'text', 'outgoing', Date.now() - 200 * DAY)
  assert.notEqual(evaluateAiEnrollmentEligibility(c.id).reason_code, 'WATCH_RECENT_TEXT')
})

test('Home Value refuses a Watch lead who emailed us inside 6 months', () => {
  const c = mkClient({ status: 'watch', address: '77 Oak Ave', email: 'w@example.com' })
  logComm(c.id, 'email', 'incoming', Date.now() - 20 * DAY)
  const why = homeValueEligibility(db.get('SELECT * FROM clients WHERE id=?', [c.id]), {})
  assert.match(String(why), /emailed us in the last 6 months/)
})

test('Home Value accepts a Watch lead whose last email to us is older than 6 months', () => {
  const c = mkClient({ status: 'watch', address: '78 Oak Ave', email: 'w2@example.com' })
  logComm(c.id, 'email', 'incoming', Date.now() - 300 * DAY)
  const why = homeValueEligibility(db.get('SELECT * FROM clients WHERE id=?', [c.id]), {})
  assert.doesNotMatch(String(why || ''), /emailed us in the last 6 months/)
})
