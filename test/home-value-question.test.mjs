// The condition question that follows the home value email (John, 2026-10-19).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubhvq_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const HV = await import('../server/home-value-intake.js')
const { rule, setRule, resetRule } = await import('../server/rules.js')

let seq = 0
function mkClient(f = {}) {
  const id = 920000 + (++seq)
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, phone, address, status, type, hub_text_opt_out, sms_undeliverable)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, f.first_name || 'Dana', 'Hv' + seq, f.phone === undefined ? '3195551212' : f.phone,
     f.address || '14 Oak St', 'new', 'seller', f.optOut ? 1 : 0, f.undeliverable ? 1 : 0])
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}
const queued = (cid) => db.get('SELECT * FROM scheduled_texts WHERE client_id=? ORDER BY id DESC LIMIT 1', [cid])

/* ---------- John's wording, exactly ---------- */

test('the message is word for word what John wrote', () => {
  assert.equal(HV.CONDITION_QUESTION,
    "Hi {{first_name}}, this is John with Matt Smith Team at RE/MAX. Thanks for requesting a home value estimate for {{street_address}}! To help us narrow down the value, I have a quick question. On a scale of 1 to 10, how would you rate your home's overall condition? 1 being it needs a complete renovation and 10 being in model-home condition.")
})

test('straight apostrophes only, or the text costs three segments', () => {
  assert.ok(!/[‘’“”]/.test(HV.CONDITION_QUESTION),
    'a curly apostrophe forces UCS-2 and cuts a segment from 160 characters to 70')
})

test('it carries no link, so the one-URL rule is safe', () => {
  assert.equal((HV.CONDITION_QUESTION.match(/https?:\/\//g) || []).length, 0)
})

test('both merge fields are present and resolvable', () => {
  assert.match(HV.CONDITION_QUESTION, /\{\{first_name\}\}/)
  assert.match(HV.CONDITION_QUESTION, /\{\{street_address\}\}/)
})

/* ---------- when it schedules ---------- */

test('it queues two minutes out by default', () => {
  const c = mkClient()
  const r = HV.scheduleConditionQuestion(c)
  assert.equal(r.ok, true, r.reason || '')
  const row = queued(c.id)
  assert.equal(row.status, 'scheduled')
  assert.equal(row.created_by, 'home_value_intake')
  const mins = (Date.parse(row.send_at) - Date.now()) / 60000
  // allow for quiet hours having pushed it; otherwise it is ~2 minutes
  if (!r.delayed_for_quiet_hours) assert.ok(mins > 1 && mins < 4, `scheduled ${mins.toFixed(1)} min out`)
})

test('the delay is a dial', () => {
  setRule('home_value_question_delay_minutes', 15, 'test')
  assert.equal(rule('home_value_question_delay_minutes'), 15)
  resetRule('home_value_question_delay_minutes', 'test')
  assert.equal(rule('home_value_question_delay_minutes'), 2)
})

test('quiet hours push it to the morning instead of texting at 11pm', () => {
  // 23:30 Central on a Tuesday
  const lateNight = new Date(Date.UTC(2026, 9, 20, 4, 30))   // 23:30 CDT on the 19th
  const out = HV.pushOutOfQuietHours(lateNight)
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).formatToParts(out).find(p => p.type === 'hour').value)
  assert.ok(h >= 8 && h < 21, `pushed to ${h}:00 Central, which is still quiet`)
  assert.ok(out > lateNight, 'and forward, never backward')
})

test('a daytime send is left exactly where it is', () => {
  const midday = new Date(Date.UTC(2026, 9, 19, 17, 0))     // 12:00 CDT
  assert.equal(HV.pushOutOfQuietHours(midday).getTime(), midday.getTime())
})

/* ---------- who does not get it ---------- */

test('no phone means no text, and that is not an error', () => {
  const c = mkClient({ phone: '' })
  const r = HV.scheduleConditionQuestion(c)
  assert.equal(r.ok, false)
  assert.match(r.reason, /no mobile number/)
  assert.ok(!queued(c.id), 'nothing queued')
})

test('a STOP on file is never queued', () => {
  const c = mkClient({ optOut: true })
  assert.equal(HV.scheduleConditionQuestion(c).ok, false)
  assert.ok(!queued(c.id), 'nothing queued')
})

test('an undeliverable number is never queued', () => {
  const c = mkClient({ undeliverable: true })
  assert.equal(HV.scheduleConditionQuestion(c).ok, false)
  assert.ok(!queued(c.id), 'nothing queued')
})

test('asked once, never asked again', () => {
  const c = mkClient()
  assert.equal(HV.scheduleConditionQuestion(c).ok, true)
  const second = HV.scheduleConditionQuestion(c)
  assert.equal(second.ok, false)
  assert.match(second.reason, /already asked/)
  assert.equal(db.get('SELECT COUNT(*) n FROM scheduled_texts WHERE client_id=?', [c.id]).n, 1,
    'a repeat home value request must not re-send the same canned question')
})

test('the queued row is addressed to the right person', () => {
  const c = mkClient({ first_name: 'Marcus' })
  HV.scheduleConditionQuestion(c)
  const row = queued(c.id)
  assert.equal(row.client_id, c.id)
  assert.equal(String(row.phone).replace(/\D/g, '').slice(-10), '3195551212')
  assert.match(row.body, /overall condition/)
})
