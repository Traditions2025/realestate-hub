// The 45 day Home Value SMS follow-up (John's spec, 2026-10-19).
// Covers what the spec asked to be tested: scheduling, weekend adjustment, missing merge
// fields, incoming replies, suppression and completion.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubhvs_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const HV = await import('../server/home-value-sms.js')
HV.initHvSms()

const DAY = 86400000
let seq = 0
function mkClient(f = {}) {
  const id = 910000 + (++seq)
  db.run(`INSERT OR REPLACE INTO clients (id, first_name, last_name, phone, address, status, type, hub_text_opt_out, sms_undeliverable)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, f.first_name === undefined ? 'Dana' : f.first_name, 'Hv' + seq,
     f.phone === undefined ? '3195551212' : f.phone,
     f.address === undefined ? '14 Oak St' : f.address,
     f.status || 'new', 'seller', f.optOut ? 1 : 0, f.undeliverable ? 1 : 0])
  return db.get('SELECT * FROM clients WHERE id=?', [id])
}
const row = (cid) => db.get('SELECT * FROM home_value_sms WHERE client_id=?', [cid])

/* ---------- the sequence itself ---------- */

test('seven steps, on the days John specified', () => {
  assert.deepEqual(HV.HV_SMS_STEPS.map(s => s.day), [3, 7, 12, 18, 25, 35, 45])
  assert.equal(HV.HV_SMS_STEPS.length, 7)
  assert.equal(HV.HV_SMS_STEPS.at(-1).final, true)
})

test('every message is straight-apostrophe only', () => {
  const c = { first_name: 'Dana', street: '14 Oak St' }
  for (const s of HV.HV_SMS_STEPS) {
    assert.ok(!/[‘’“”]/.test(s.text(c)), `${s.key} has a curly apostrophe`)
  }
})

test('no message carries a link', () => {
  const c = { first_name: 'Dana', street: '14 Oak St' }
  for (const s of HV.HV_SMS_STEPS) assert.equal((s.text(c).match(/https?:\/\//g) || []).length, 0, s.key)
})

test('the walkthrough is offered once, at day 35, and never called mandatory', () => {
  const offers = HV.HV_SMS_STEPS.filter(s => s.offersWalkthrough)
  assert.equal(offers.length, 1)
  assert.equal(offers[0].day, 35)
  const t = offers[0].text({ first_name: 'D', street: 'X' })
  assert.match(t, /If you're open to it/)
  assert.doesNotMatch(t, /need to|must|required/i)
})

test('no message asks outright whether they want to sell', () => {
  const c = { first_name: 'Dana', street: '14 Oak St' }
  for (const s of HV.HV_SMS_STEPS) {
    assert.doesNotMatch(s.text(c), /are you (looking to|planning to|thinking of) sell\b/i, s.key)
  }
})

/* ---------- merge fields with fallbacks ---------- */

test('a usable name and address come through', () => {
  const f = HV.mergeFieldsFor(mkClient({ first_name: 'Marcus', address: '9 Elm Ct' }))
  assert.equal(f.first_name, 'Marcus')
  assert.equal(f.street, '9 Elm Ct')
})

test('junk names fall back to "there", never "Hi ,"', () => {
  for (const bad of ['', '   ', 'None', 'null', 'test', 'dana@example.com', '42']) {
    const f = HV.mergeFieldsFor({ first_name: bad, address: '1 A St' })
    assert.equal(f.first_name, 'there', `"${bad}" should fall back`)
  }
})

test('a missing address falls back to "your home"', () => {
  const f = HV.mergeFieldsFor({ first_name: 'Dana', address: '' })
  assert.equal(f.street, 'your home')
  const t = HV.HV_SMS_STEPS[0].text({ first_name: f.first_name, street: f.street })
  assert.match(t, /updates to your home over the years/)
  assert.doesNotMatch(t, /undefined|\{\{/)
})

/* ---------- enrolment and scheduling ---------- */

test('enrolling schedules day 3 from the REQUEST date, inside the weekday window', () => {
  const c = mkClient()
  const requested = new Date(Date.now() - 1 * DAY).toISOString()
  const r = HV.enrollHvSms(c.id, { requestedAt: requested })
  assert.equal(r.ok, true, r.reason || '')
  const st = row(c.id)
  assert.equal(st.status, 'active')
  assert.equal(st.next_step, 0)
  const at = new Date(st.next_send_at)
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(at)
  assert.ok(!['Sat', 'Sun'].includes(wd), `day 3 landed on ${wd}`)
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).formatToParts(at).find(p => p.type === 'hour').value)
  assert.ok(h >= 9 && h < 17, `scheduled at ${h}:00 Central`)
})

test('a weekend landing is moved to a weekday', () => {
  // request on a Thursday -> day 3 is Sunday
  const thursday = new Date(Date.UTC(2026, 9, 15, 15)).toISOString()
  const c = mkClient()
  HV.enrollHvSms(c.id, { requestedAt: thursday })
  const at = new Date(row(c.id).next_send_at)
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(at)
  assert.ok(!['Sat', 'Sun'].includes(wd), `landed on ${wd}`)
})

test('a lead with no mobile is never enrolled', () => {
  const c = mkClient({ phone: '' })
  const r = HV.enrollHvSms(c.id)
  assert.equal(r.ok, false)
  assert.ok(!row(c.id))
})

test('a repeat request does not restart or duplicate the sequence', () => {
  const c = mkClient()
  assert.equal(HV.enrollHvSms(c.id).ok, true)
  const second = HV.enrollHvSms(c.id)
  assert.equal(second.ok, false)
  assert.equal(second.existing, true)
  assert.equal(db.get('SELECT COUNT(*) n FROM home_value_sms WHERE client_id=?', [c.id]).n, 1)
})

/* ---------- any reply stops everything ---------- */

test('a reply cancels the sequence, every queued text, and hands over to a person', () => {
  const c = mkClient()
  HV.enrollHvSms(c.id)
  db.run(`INSERT INTO scheduled_texts (client_id, phone, body, send_at, status, created_by)
          VALUES (?,?,?,?,'scheduled','home_value_intake')`, [c.id, c.phone, 'the day 0 question', new Date(Date.now() + 60000).toISOString()])
  const was = HV.handleHvSmsInbound(c.id, 'who is this?')
  assert.equal(was, true, 'must report true so the AI hand-off is blocked')
  const st = row(c.id)
  assert.equal(st.status, 'replied')
  assert.ok(st.replied_at)
  assert.equal(st.next_send_at, null)
  const q = db.get("SELECT status FROM scheduled_texts WHERE client_id=?", [c.id])
  assert.equal(q.status, 'canceled', 'a queued Day 0 question must be pulled too')
})

test('a reply that is NOT a rating still stops it', () => {
  const c = mkClient()
  HV.enrollHvSms(c.id)
  HV.handleHvSmsInbound(c.id, 'please take me off your list')
  assert.equal(row(c.id).status, 'replied')
})

test('a lead not in the sequence is left alone', () => {
  const c = mkClient()
  assert.equal(HV.handleHvSmsInbound(c.id, 'hello'), false)
})

test('a condition rating is captured from the reply', () => {
  for (const [body, want] of [['7', 7], ['  10 ', 10], ['8/10', 8], ['about a 6', 6], ['9 out of 10', 9], ["I'd say 4", 4]]) {
    const c = mkClient()
    HV.enrollHvSms(c.id)
    HV.handleHvSmsInbound(c.id, body)
    assert.equal(row(c.id).condition_rating, want, `"${body}"`)
  }
})

test('prose is not mistaken for a rating', () => {
  for (const body of ['we have 3 bedrooms', 'call me at 319 555 1212', 'no thanks', '']) {
    assert.equal(HV.parseConditionRating(body), null, `"${body}"`)
  }
})

/* ---------- agent suggestions, never auto-sent ---------- */

test('each rating band gets John’s wording', () => {
  assert.match(HV.agentSuggestions(2)[0], /cosmetic updates, or are there some larger repairs/)
  assert.match(HV.agentSuggestions(5)[0], /particular areas that need updating/)
  assert.match(HV.agentSuggestions(8)[0], /keeping it from being a 10/)
  assert.match(HV.agentSuggestions(10)[0], /kept it in great shape/)
  for (const n of [1, 5, 8, 10]) assert.match(HV.agentSuggestions(n)[1], /quick walkthrough/)
})

test('no rating means no suggestions', () => {
  assert.deepEqual(HV.agentSuggestions(null), [])
  assert.deepEqual(HV.agentSuggestions('abc'), [])
})

/* ---------- suppression ---------- */

test('STOP, undeliverable, junk and no-phone all block a send', () => {
  const cases = [
    [{ optOut: true }, /STOP/],
    [{ undeliverable: true }, /undeliverable/],
    [{ status: 'junk' }, /status/],
    [{ phone: '' }, /no mobile/],
  ]
  for (const [f, re] of cases) {
    const c = mkClient(f)
    assert.match(String(HV.hvSmsBlock(c, null)), re, JSON.stringify(f))
  }
})

test('a text in the last 20 hours blocks a second one the same day', () => {
  const c = mkClient()
  assert.equal(HV.hvSmsBlock(c, null), null, 'clear to begin with')
  db.run(`INSERT INTO communications (channel, direction, client_id, preview, body, thread_key, status, occurred_at)
          VALUES ('text','outgoing',?,'x','x',?, 'read', ?)`, [c.id, `c${c.id}_text`, new Date(Date.now() - 3600000).toISOString()])
  assert.match(String(HV.hvSmsBlock(c, null)), /already texted/)
})

test('a lead who replied is blocked even if the row says active', () => {
  const c = mkClient()
  assert.match(String(HV.hvSmsBlock(c, { replied_at: new Date().toISOString() })), /replied/)
})

/* ---------- status control ---------- */

test('cancelling clears the queue and stops the sequence', () => {
  const c = mkClient()
  HV.enrollHvSms(c.id)
  db.run(`INSERT INTO scheduled_texts (client_id, phone, body, send_at, status, created_by)
          VALUES (?,?,?,?,'scheduled','home_value_sms')`, [c.id, c.phone, 'queued', new Date(Date.now() + 60000).toISOString()])
  HV.setHvSmsStatus(c.id, 'cancelled', 'agent cancelled')
  assert.equal(row(c.id).status, 'cancelled')
  assert.equal(row(c.id).next_send_at, null)
  assert.equal(db.get('SELECT status FROM scheduled_texts WHERE client_id=?', [c.id]).status, 'canceled')
})

test('an unknown status is refused', () => {
  const c = mkClient()
  HV.enrollHvSms(c.id)
  assert.equal(HV.setHvSmsStatus(c.id, 'whatever').ok, false)
})

test('the state object gives the profile what it needs', () => {
  const c = mkClient()
  HV.enrollHvSms(c.id)
  HV.handleHvSmsInbound(c.id, '7')
  const st = HV.hvSmsState(c.id)
  assert.equal(st.status, 'replied')
  assert.equal(st.condition_rating, 7)
  assert.equal(st.total_steps, 7)
  assert.equal(st.suggestions.length, 2, 'the agent gets suggestions once a rating is known')
  assert.ok(Array.isArray(st.log) && st.log.length > 0)
})

/* ---------- custom fields, both mechanisms (John: "make sure custom fields work") ---------- */

test('Day 0 tokens resolve through fillTemplate, including the fallbacks', async () => {
  const { fillTemplate } = await import('../server/routes/email.js')
  const { CONDITION_QUESTION } = await import('../server/home-value-intake.js')
  const cases = [
    { first: 'Dana', address: '14 Oak St', wantName: 'Hi Dana,', wantStreet: '14 Oak St' },
    { first: '', address: '14 Oak St', wantName: 'Hi there,', wantStreet: '14 Oak St' },
    { first: 'None', address: '14 Oak St', wantName: 'Hi there,', wantStreet: '14 Oak St' },
    { first: 'd@x.com', address: '14 Oak St', wantName: 'Hi there,', wantStreet: '14 Oak St' },
    { first: 'Dana', address: '', wantName: 'Hi Dana,', wantStreet: 'your home' },
  ]
  for (const t of cases) {
    const c = mkClient({ first_name: t.first, address: t.address })
    const out = fillTemplate(CONDITION_QUESTION, db.get('SELECT * FROM clients WHERE id=?', [c.id]))
    assert.ok(out.startsWith(t.wantName), `"${t.first}" -> ${out.slice(0, 20)}`)
    // Plain substring, no regex: the street values here contain no special characters and
    // escaping them through a heredoc is how this line broke the first time.
    assert.ok(out.includes(t.wantStreet), `expected "${t.wantStreet}" in: ${out.slice(0, 80)}`)
    assert.doesNotMatch(out, /\{\{|undefined|null|\bNone\b/, 'no raw token or junk reaches the phone')
  }
})

test('every Day 3+ step survives a record with no name and no address', () => {
  const f = HV.mergeFieldsFor({ first_name: '', address: '' })
  for (const s of HV.HV_SMS_STEPS) {
    const t = s.text({ first_name: f.first_name, street: f.street })
    assert.doesNotMatch(t, /\{\{|undefined|null/, `${s.key} leaked a placeholder`)
    assert.ok(t.startsWith('Hi there,'), `${s.key} greeting`)
    assert.match(t, /your home/, `${s.key} should use the address fallback`)
  }
})

test('a real street address appears verbatim in every step', () => {
  const f = HV.mergeFieldsFor({ first_name: 'Kurt', address: '2870 Hunters Ridge Rd' })
  for (const s of HV.HV_SMS_STEPS) {
    assert.match(s.text({ first_name: f.first_name, street: f.street }), /2870 Hunters Ridge Rd/, s.key)
  }
})
