// Email the team before the Twilio balance hits zero.
//
// John, 2026-10-14: "we should be getting an email when balance is becoming low under $5."
//
// Twilio does not fail loudly when the money runs out — texts stop sending and calls stop
// connecting, with nothing in the Hub announcing it. These tests cover the two ways a
// balance watcher goes wrong: crying wolf (an API blip read as zero, or a daily email that
// never stops) and staying silent when it matters.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const mod = await import('../server/twilio-balance-alert.js')
const { alertThreshold, alertRecipients, DEFAULT_THRESHOLD } = mod

beforeEach(() => {
  db.setSetting('twilio_balance_alert_threshold', '')
  db.setSetting('twilio_balance_alert_to', '')
  db.setSetting('twilio_balance_alert_last_sent', '')
  db.setSetting('twilio_balance_alert_last_level', '')
})

test('the threshold is $5 unless someone changes it', () => {
  assert.equal(alertThreshold(), DEFAULT_THRESHOLD)
  assert.equal(DEFAULT_THRESHOLD, 5, 'the number John asked for')
})

test('the threshold is configurable without a deploy', () => {
  db.setSetting('twilio_balance_alert_threshold', '25')
  assert.equal(alertThreshold(), 25)
})

// '0' is in this list on purpose: a threshold of 0 can never be met, so it is a disabled
// alert that still looks configured. A typo must not silently switch the watch off.
test('a nonsense threshold falls back rather than disabling the alert', () => {
  for (const bad of ['abc', '-3', '', '0', '   ']) {
    db.setSetting('twilio_balance_alert_threshold', bad)
    assert.equal(alertThreshold(), DEFAULT_THRESHOLD, JSON.stringify(bad) + ' must not break the watch')
  }
})

test('both Matt and John get it by default', () => {
  const to = alertRecipients()
  assert.ok(to.includes('mattsmithremax@gmail.com'), 'Matt pays the bill')
  assert.ok(to.includes('johnwithmattsmithteam@gmail.com'), 'John runs the phone')
})

test('recipients are configurable and junk entries are dropped', () => {
  db.setSetting('twilio_balance_alert_to', 'a@b.com, not-an-email ,  c@d.com ')
  assert.deepEqual(alertRecipients(), ['a@b.com', 'c@d.com'])
})

// ── the decision itself, without touching Twilio or SendGrid ─────────────────────────
const src = fs.readFileSync(new URL('../server/twilio-balance-alert.js', import.meta.url), 'utf8')

test('an unknown balance is never treated as zero', () => {
  // an API blip, a network error or a suspended account must not fire "you are out of money"
  assert.match(src, /if \(balance === null\) return[^\n]*skipped_unknown_balance/)
  assert.ok(src.indexOf('skipped_unknown_balance') < src.indexOf('if (balance >= threshold)'),
    'the unknown case has to be settled before any comparison')
})

test('readBalance returns null rather than 0 when Twilio will not say', () => {
  const fn = src.slice(src.indexOf('export async function readBalance'), src.indexOf('function emailHtml'))
  assert.ok(!/balance: 0/.test(fn), 'a default of 0 would alert every time the API hiccuped')
  assert.match(fn, /Number\.isFinite\(n\) \? n : null/)
})

test('a healthy balance re-arms the alert', () => {
  // without this, one top-up and the next drop would be silent for a day
  assert.match(src, /if \(!dry\) db\.setSetting\(LAST_LEVEL_KEY, 'ok'\)/)
})

test('it does not email every hour while the balance stays low', () => {
  assert.match(src, /if \(!force && lastSent === today\)[\s\S]{0,160}already_sent_today/)
})

test('the day key is Central, like everything else here', () => {
  assert.match(src, /import \{ chicagoDateKey \} from '\.\/transaction-digest\.js'/)
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(src), 'a UTC day rolls over at 7pm Cedar Rapids time')
})

test('dry decides everything but sends nothing', () => {
  assert.match(src, /if \(dry\) return \{[^\n]*action: 'would_send'/)
  assert.ok(src.indexOf("action: 'would_send'") < src.indexOf('await sendViaSendGrid'),
    'the dry return must come before the send, or a check would email the team')
})

test('nothing is marked as sent when the send failed', () => {
  const after = src.slice(src.indexOf('await sendViaSendGrid'))
  assert.ok(after.indexOf("action: 'send_failed'") < after.indexOf('db.setSetting(LAST_SENT_KEY, today)'),
    'recording a failed send would suppress tomorrow’s retry')
})

test('with no recipients it reports that instead of pretending to send', () => {
  assert.match(src, /if \(!to\.length\) return[^\n]*no_recipients/)
})

// ── wiring ───────────────────────────────────────────────────────────────────────────
test('the scheduler runs it hourly, and once shortly after boot', () => {
  const sch = fs.readFileSync(new URL('../server/scheduler.js', import.meta.url), 'utf8')
  assert.match(sch, /twilio-balance-alert\.js'\)\.then\(m => m\.checkTwilioBalance\(\)\)[\s\S]{0,40}60 \* 60 \* 1000/)
  assert.match(sch, /setTimeout\([^\n]*twilio-balance-alert[^\n]*4 \* 60 \* 1000/)
})

test('the check route is dry, so looking cannot send', () => {
  const inbox = fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
  const r = inbox.slice(inbox.indexOf("router.get('/balance-alert'"), inbox.indexOf("router.post('/balance-alert/test'"))
  assert.match(r, /checkTwilioBalance\(\{ dry: true \}\)/)
  assert.ok(!/force/.test(r), 'a GET must never be able to force a real email')
})
