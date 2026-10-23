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

const C = { first_name: 'Dana', street: '14 Oak St' }
const smsOf = (s) => s.text(C)
const emailOf = (s) => [s.subject(C), ...s.paras(C)].join('\n')
const bodyOf = (s) => (s.channel === 'email' ? emailOf(s) : smsOf(s))

test('thirteen steps alternating SMS and email, on the days John specified', () => {
  assert.deepEqual(HV.HV_STEPS.map(s => s.day), [1, 3, 5, 8, 11, 15, 19, 23, 28, 32, 37, 45, 45])
  assert.deepEqual(HV.HV_STEPS.map(s => s.channel),
    ['email', 'sms', 'email', 'sms', 'email', 'sms', 'email', 'sms', 'email', 'sms', 'email', 'sms', 'email'])
  assert.equal(HV.HV_STEPS.at(-1).final, true)
})

test('every message is straight-apostrophe only', () => {
  // A curly apostrophe turns an SMS segment from 160 characters into 70.
  for (const s of HV.HV_STEPS) assert.ok(!/[‘’“”]/.test(bodyOf(s)), `${s.key} has a curly apostrophe`)
})

test('only the Day 45 close carries a link, and only one', () => {
  for (const s of HV.HV_STEPS.filter(x => x.channel === 'sms')) {
    const links = (smsOf(s).match(/MattSmithTeam\.com|https?:\/\//gi) || []).length
    if (s.day === 45) assert.equal(links, 1, 'the close should point somewhere, once')
    else assert.equal(links, 0, `${s.key} should carry no link`)
  }
})

test('intent is not raised before Day 15', () => {
  // The whole design: earn the question first. Days 1 to 11 are about the property.
  for (const s of HV.HV_STEPS.filter(x => x.day < 15)) {
    // The word itself is fine in market context: John's Day 1 email says two homes "can
    // sell very differently". What must not appear before Day 15 is the question pointed
    // at THEM.
    assert.doesNotMatch(bodyOf(s), /(are|were) you\b[^.?!]{0,40}(sell|mov)|thinking (about|of) (selling|moving)|plans? to (sell|move)|considering a move/i, s.key)
  }
  assert.match(smsOf(HV.HV_STEPS.find(s => s.day === 15)), /move/i, 'Day 15 is where intent starts')
})

test('no message asks outright whether they want to sell', () => {
  for (const s of HV.HV_STEPS) {
    assert.doesNotMatch(bodyOf(s), /are you (looking to|planning to|thinking of) sell\b/i, s.key)
  }
})

test('the close applies no pressure', () => {
  // John named the phrases he does not want: no last chance, no "still interested", no
  // "I've been trying to reach you", no appointment ask.
  for (const s of HV.HV_STEPS.filter(x => x.day === 45)) {
    assert.doesNotMatch(bodyOf(s), /still interested|last chance|trying to reach|schedule an appointment/i, s.key)
  }
})

test('email subjects avoid spam-heavy words', () => {
  for (const s of HV.HV_STEPS.filter(x => x.channel === 'email')) {
    assert.doesNotMatch(s.subject(C), /\$\$|\bcash\b|\bprofit\b|\bpayout\b/i, s.key)
  }
})

test('an SMS and the email near it never carry the same copy', () => {
  // The two channels exist to do different jobs: the text asks, the email explains why.
  for (let i = 1; i < HV.HV_STEPS.length; i++) {
    const a = HV.HV_STEPS[i - 1], b = HV.HV_STEPS[i]
    if (a.channel === b.channel) continue
    const norm = (t) => t.toLowerCase().replace(/[^a-z ]/g, '').trim()
    assert.notEqual(norm(bodyOf(a)), norm(bodyOf(b)), `${a.key} and ${b.key} duplicate each other`)
  }
})

test('every email signs off and greets the way John wrote it', () => {
  for (const s of HV.HV_STEPS.filter(x => x.channel === 'email')) {
    assert.ok(s.subject(C).length > 0 && s.paras(C).length > 0, s.key)
    assert.ok(!s.paras(C).some(p => /^Hi /.test(p)), `${s.key} should not repeat the greeting in the body`)
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
  const first = HV.HV_STEPS[0]                       // Day 1 is an email now
  const t = [first.subject({ street: f.street }), ...first.paras({ first_name: f.first_name, street: f.street })].join('\n')
  assert.match(t, /your home/)
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
  assert.equal(st.total_steps, 13)
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
  for (const s of HV.HV_STEPS) {
    const t = s.channel === 'email'
      ? [s.subject({ street: f.street }), ...s.paras({ first_name: f.first_name, street: f.street })].join('\n')
      : s.text({ first_name: f.first_name, street: f.street })
    assert.doesNotMatch(t, /\{\{|undefined|null/, `${s.key} leaked a placeholder`)
  }
})

test('a real street address appears verbatim in every step', () => {
  const f = HV.mergeFieldsFor({ first_name: 'Kurt', address: '2870 Hunters Ridge Rd' })
  // Not every step names the house: Day 8 and Day 32 are deliberately generic questions.
  // Decide by RENDERING with a marker, rather than by reading the function's source.
  const renders = (s, street) => s.channel === 'email'
    ? [s.subject({ street }), ...s.paras({ first_name: 'Kurt', street })].join('\n')
    : s.text({ first_name: 'Kurt', street })
  const naming = HV.HV_STEPS.filter(s => renders(s, 'ZZMARKERZZ').includes('ZZMARKERZZ'))
  assert.ok(naming.length >= 8, `most steps should still name the property, got ${naming.length}`)
  for (const s of naming) {
    const t = s.channel === 'email'
      ? [s.subject({ street: f.street }), ...s.paras({ first_name: f.first_name, street: f.street })].join('\n')
      : s.text({ first_name: f.first_name, street: f.street })
    assert.match(t, /2870 Hunters Ridge Rd/, s.key)
  }
})

/* ---------- alternating greeting ---------- */

test('the greeting alternates Hi, Hello, time of day', () => {
  assert.equal(HV.greetingFor(0), 'Hi')
  assert.equal(HV.greetingFor(1), 'Hello')
  assert.match(HV.greetingFor(2), /^Good (morning|afternoon)$/)
  assert.equal(HV.greetingFor(3), 'Hi', 'and wraps')
})

test('it is never "Good evening", because we stop texting at 5', () => {
  for (const h of [9, 12, 15, 16, 20, 23]) {
    const at = new Date(Date.UTC(2026, 9, 20, h + 5))
    assert.match(HV.timeGreeting(at), /^Good (morning|afternoon)$/, `${h}:00 Central`)
  }
})

test('one lead sees all three across the sequence', () => {
  const seen = new Set(HV.HV_SMS_STEPS.map((_, i) => {
    const g = HV.greetingFor(i + 1)
    return /^Good /.test(g) ? 'timeofday' : g
  }))
  assert.equal(seen.size, 3, 'Hi, Hello and a time-of-day greeting all appear')
})

test('the SMS copy opens exactly as John wrote it, with nothing prepended', () => {
  // The earlier campaign rotated Hi/Hello/time-of-day. This copy mostly opens mid-thought
  // on purpose, so a greeting must NOT be bolted on in front of it.
  for (const s of HV.HV_STEPS.filter(x => x.channel === 'sms')) {
    const t = s.text({ first_name: 'Dana', street: '1 A St' })
    assert.doesNotMatch(t, /^(Hi|Hello|Good (morning|afternoon|evening)) (Dana|there),? (Hi|Hello)/, s.key)
    assert.doesNotMatch(t, /undefined/, s.key)
  }
})

test('no step leaks undefined when a merge field is missing', () => {
  for (const s of HV.HV_STEPS.filter(x => x.channel === 'sms')) {
    assert.doesNotMatch(s.text({}), /undefined/, s.key)
  }
})

/* ---------- email identity: Matt, on every campaign ---------- */

test('the emails sign Matt, never John', () => {
  // John wrote "John" into his own spec for this campaign, then confirmed on 2026-10-23:
  // "always Matt on all campaigns". The rule exists because every outbound email leaves
  // Matt's marketing address, and two real leads once got John-signed mail from it.
  const html = HV.hvEmailHtml('Dana', ['First line.', 'Second line.'])
  assert.match(html, /Matt Smith<br>Matt Smith Team \| RE\/MAX Concepts/)
  assert.doesNotMatch(html, /\bJohn\b/, 'no John anywhere in an email')
})

test('no email body introduces the sender as John', () => {
  const C2 = { first_name: 'Dana', street: '14 Oak St' }
  for (const s of HV.HV_STEPS.filter(x => x.channel === 'email')) {
    const body = [s.subject(C2), ...s.paras(C2)].join('\n')
    assert.doesNotMatch(body, /\bJohn\b/, s.key)
  }
})

test('the SMS side stays John, because that number is his', () => {
  const C2 = { first_name: 'Dana', street: '14 Oak St' }
  const opener = HV.HV_STEPS.filter(x => x.channel === 'sms').map(s => s.text(C2)).join('\n')
  assert.doesNotMatch(opener, /Matt Smith Team at RE\/MAX\. I'm Matt/, 'SMS must not switch persona')
})
