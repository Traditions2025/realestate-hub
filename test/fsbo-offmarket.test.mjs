// FSBO CONNECT - OFF MARKET (John's build spec, 2026-11-18)
//
// A campaign that sends cold texts to people who chose NOT to use an agent. The dangerous
// parts are not the happy path:
//
//   - the wrong tone. A FSBO owner did not fail; implying it is the fastest way to lose them
//   - the missing cap. Cancelled/Expired runs for ever, roughly 50 texts a year. This must
//     stop at 8
//   - the AI answering. An FSBO reply reaching the AI is the exact breach of 2026-10-05
//   - the master switch. 28 cold numbers is one accidental sweep away
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as OM from '../server/fsbo-offmarket.js'

const SRC = readFileSync(new URL('../server/fsbo-offmarket.js', import.meta.url), 'utf8')
const INBOX = readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
const SCHED = readFileSync(new URL('../server/scheduler.js', import.meta.url), 'utf8')
const DB = readFileSync(new URL('../server/database.js', import.meta.url), 'utf8')
const ROUTE = readFileSync(new URL('../server/routes/fsbo-offmarket.js', import.meta.url), 'utf8')

const BUCKETS = ['recent', 'mid', 'old', 'ancient']
const everyMessage = () => [
  ...BUCKETS.map(b => OM.INTRO[b]('123 Main St', 'Hi, good morning :)')),
  ...BUCKETS.map(b => OM.FOLLOW_UP[b]('123 Main St')),
  ...OM.ROTATION.map(k => OM.ANGLES[k].text('123 Main St')),
]

// ---- the switch ------------------------------------------------------------------------

test('the campaign is OFF until somebody turns it on', () => {
  assert.equal(OM.fsboOmEnabled(), false)
  assert.match(SRC, /getSetting\?\.\('fsbo_offmarket_enabled', '0'\)/)
})

test('the sweep does nothing at all while it is off', () => {
  const fn = SRC.slice(SRC.indexOf('export async function runSweep'))
  assert.match(fn.slice(0, 220), /if \(!fsboOmEnabled\(\)\) return \{ skipped: 'disabled' \}/)
})

test('the scheduler calls it, so turning it on is the only remaining step', () => {
  assert.match(SCHED, /fsbo-offmarket\.js'\)\.then\(m => m\.runSweep/)
})

// ---- the hard cap (§8) -------------------------------------------------------------------

test('eight unanswered texts and it stops', () => {
  assert.equal(OM.MAX_ATTEMPTS, 8)
  assert.match(SRC, /attempt_count \|\| 0\) >= MAX_ATTEMPTS/)
  assert.match(SRC, /code: 'EXHAUSTED'/)
})

test('an exhausted lead is parked, never deleted', () => {
  // §8: keep them in Watch so a person can pick it up later.
  assert.match(SRC, /function parkOnWatch/)
  assert.match(SRC, /SET status='watch'/)
  assert.ok(!/DELETE FROM clients/.test(SRC))
})

test('the cap is applied at send time, not only when scheduling', () => {
  // A lead could otherwise be scheduled before the cap and send after it.
  const fn = SRC.slice(SRC.indexOf('export async function evaluateEligibility'))
  assert.ok(fn.includes('MAX_ATTEMPTS'), 'eligibility itself enforces the cap')
})

// ---- tone (§3, §12) -----------------------------------------------------------------------

test('no message implies the FSBO attempt failed or that they need an agent', () => {
  for (const m of everyMessage()) {
    for (const re of OM.BANNED) {
      assert.ok(!re.test(m), `banned phrasing ${re} in: ${m}`)
    }
  }
})

test('no message mentions listing, representation, buyers or price criticism', () => {
  const forbidden = [/\blist with\b/i, /\blisting appointment\b/i, /\brepresent/i,
    /\bbuyers?\b/i, /\bovervalued|overpriced\b/i, /\bexpired\b/i, /\bfailed\b/i]
  for (const m of everyMessage()) {
    for (const re of forbidden) assert.ok(!re.test(m), `${re} appears in: ${m}`)
  }
})

test('every message that names John introduces him in full (§5)', () => {
  for (const m of everyMessage()) {
    if (!/John/.test(m)) continue
    assert.match(m, /this is John with Matt Smith Team at RE\/MAX\./i,
      `incomplete introduction, reads like a CRM note: ${m}`)
    // the shorthand the spec bans outright
    assert.ok(!/^Hello, John with Matt Smith Team\./.test(m), `CRM-note shorthand: ${m}`)
  }
})

test('no first name merge field anywhere - identity is never assumed', () => {
  // Numbers can come from skip tracing, so the person holding the phone may not be the owner.
  for (const m of everyMessage()) assert.ok(!/\{\{\s*first_name/.test(m), m)
})

test('every message is anchored on the address', () => {
  for (const m of everyMessage()) assert.match(m, /123 Main St/, `no address in: ${m}`)
})

test('the last message steps back rather than pressing', () => {
  assert.equal(OM.ROTATION[OM.ROTATION.length - 1], 'OPEN_DOOR')
  assert.match(OM.ANGLES.OPEN_DOOR.text('123 Main St'), /keeping the door open/)
})

// ---- buckets (§6) ---------------------------------------------------------------------------

test('age buckets split where the spec says', () => {
  assert.equal(OM.ageBucket(0), 'recent')
  assert.equal(OM.ageBucket(30), 'recent')
  assert.equal(OM.ageBucket(31), 'mid')
  assert.equal(OM.ageBucket(90), 'mid')
  assert.equal(OM.ageBucket(91), 'old')
  assert.equal(OM.ageBucket(365), 'old')
  assert.equal(OM.ageBucket(366), 'ancient')
})

test('an unknown date is OLD, never recent', () => {
  assert.equal(OM.ageBucket(null), 'old')
  assert.ok(!/recently/.test(OM.INTRO.old('123 Main St', 'Hi, good morning :)')))
})

test('only the recent message may claim the listing just came down', () => {
  assert.match(OM.INTRO.recent('X', 'S'), /no longer listed/)
  for (const b of ['mid', 'old', 'ancient']) {
    assert.ok(!/no longer listed|recently/.test(OM.INTRO[b]('X', 'S')), `recency claim in ${b}`)
  }
})

test('nothing says "been offered" or repeats "for sale by owner"', () => {
  // John, 2026-11-18: "dont say been offered also we don't say all the time that it was for
  // sale by owner, if we say for sale that's understandable."
  for (const m of everyMessage()) {
    assert.ok(!/been offered/i.test(m), `"been offered" in: ${m}`)
    assert.ok(!/by owner|for-sale-by-owner|FSBO/i.test(m), `FSBO phrasing in: ${m}`)
  }
})

// ---- cadence (§7) ----------------------------------------------------------------------------

test('it is slower than Cancelled/Expired', () => {
  // CX is 2-3 days then weekly. This is 3-4, then ~10-12, then fortnightly.
  // Counted in calendar days Central, because scheduleNext also moves the clock into the
  // 9am-4pm window and a "3 day" gap is 2.8 days measured in milliseconds.
  const dayNum = (d) => {
    const s = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    return Math.round(Date.parse(s + 'T00:00:00Z') / 86400000)
  }
  const gap = (attempt, from) => dayNum(OM.scheduleNext(attempt, from)) - dayNum(from)
  for (let i = 0; i < 60; i++) {
    const from = new Date(Date.UTC(2026, 5, 1 + (i % 20), 15))
    const g1 = gap(1, from), g2 = gap(2, from), g5 = gap(5, from)
    // Each band allows +2 for the weekend shift, which can only push later.
    assert.ok(g1 >= 3 && g1 <= 6, `text 2 at ${g1} days`)
    assert.ok(g2 >= 7 && g2 <= 11, `text 3 at ${g2} days`)
    assert.ok(g5 >= 13 && g5 <= 17, `later texts at ${g5} days`)
    // and it is always slower than Cancelled/Expired, which is 2-3 days then weekly
    // The weekend shift only moves later, so a gap can never compress below its minimum.
    assert.ok(g1 >= 3, 'the cadence can never tighten below 3 days')
    assert.ok(g2 >= 7, 'nor below 7 for text 3')
    assert.ok(g5 >= 13, 'nor below the fortnight band (14 with a day either side)')
    assert.ok(g5 > 8, 'slower than the CX weekly cadence')
  }
})

test('nothing is ever scheduled on a weekend', () => {
  const wd = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d)
  for (let i = 0; i < 200; i++) {
    const d = OM.scheduleNext(1 + (i % 6), new Date(Date.UTC(2026, 5, 1 + (i % 28), 15)))
    assert.ok(!['Sat', 'Sun'].includes(wd(d)), `landed on ${wd(d)}`)
  }
})

test('nothing is ever scheduled outside 9am-4pm Central', () => {
  const hr = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).format(d))
  for (let i = 0; i < 200; i++) {
    const h = hr(OM.scheduleNext(1 + (i % 6), new Date(Date.UTC(2026, 5, 1 + (i % 28), 2))))
    assert.ok(h >= 9 && h < 16, `scheduled at ${h}:00 Central`)
  }
})

// ---- classification (§14) ----------------------------------------------------------------------

test('each reply lands in the right bucket', () => {
  const cases = {
    'we already sold it': 'SOLD',
    'rented it out to a tenant': 'RENTED',
    'listed with another agent': 'LISTED_WITH_AGENT',
    'decided not to sell, keeping it': 'HOLDING_PROPERTY',
    'maybe next spring': 'FUTURE_TIMEFRAME',
    'I am selling it myself, no realtor': 'SELLING_MYSELF',
    "I'd sell at $300k": 'WOULD_SELL_FOR_PRICE',
    'yes still available': 'STILL_AVAILABLE',
    'not interested, stop contacting me': 'NOT_INTERESTED',
    'wrong number': 'WRONG_NUMBER',
  }
  for (const [text, want] of Object.entries(cases)) {
    assert.equal(OM.classifyInbound(text), want, `"${text}"`)
  }
})

test('choosing to sell alone is NOT recorded as not-interested (§14)', () => {
  // They may still sell. Marking them uninterested would bury a live opportunity.
  assert.equal(OM.CLASS_OUTCOME.SELLING_MYSELF.status, 'selling_myself')
  assert.notEqual(OM.CLASS_OUTCOME.SELLING_MYSELF.status, 'not_interested')
})

test('a price is read out of the reply and stored', () => {
  assert.equal(OM.parsePriceThreshold("I'd take $300k"), 300000)
  assert.equal(OM.parsePriceThreshold('anything over 425'), 425000)
  assert.equal(OM.parsePriceThreshold('$412,500 and it is yours'), 412500)
  assert.equal(OM.parsePriceThreshold('no number here'), null)
})

test('an unreadable reply goes to a human, never to a guess', () => {
  assert.equal(OM.classifyInbound('hmm'), 'NEEDS_HUMAN_REVIEW')
  assert.equal(OM.CLASS_OUTCOME.NEEDS_HUMAN_REVIEW.status, 'response_received')
})

// ---- the handoff (§13) ------------------------------------------------------------------------

test('a reply stops the campaign and the AI never answers', () => {
  const fn = SRC.slice(SRC.indexOf('export function handleInbound'))
  assert.match(fn, /next_send_at=NULL/)
  assert.match(fn, /scheduled_texts SET status='canceled'/)
  assert.match(fn, /flagHuman/)
  // and the inbound route gates the AI on it
  assert.match(INBOX, /fsboOmLead = om\.handleInbound/)
  assert.match(INBOX, /!cxLead && !fsboLead && !fsboOmLead && !hvLead/)
})

test('a reply raises a task for a person', () => {
  assert.match(SRC, /INSERT INTO tasks/)
  assert.match(SRC, /A person owns this now/)
})

// ---- eligibility (§2, §18) --------------------------------------------------------------------

test('an active FSBO is refused - that is the other campaign', () => {
  assert.match(SRC, /code: 'FSBO_ACTIVE'/)
})

test('sold, pending and relisted all stop it', () => {
  const fn = SRC.slice(SRC.indexOf('export async function evaluateEligibility'))
  for (const code of ['SOLD', 'PENDING', 'LISTED_WITH_AGENT']) {
    assert.ok(fn.includes(`code: '${code}'`), `${code} must be a stop`)
  }
})

test('no address means no send, because every message is built on one', () => {
  assert.match(SRC, /code: 'NO_ADDRESS'/)
})

test('only one seller campaign owns a lead at a time (§26)', () => {
  assert.match(SRC, /export function ownedElsewhere/)
  assert.match(SRC, /fsbo_followups WHERE client_id=\? AND status='active'/)
  assert.match(SRC, /cx_campaign WHERE client_id=\? AND status='active'/)
  assert.match(SRC, /ai_lead_state/)
})

test('eligibility runs again before every send, not just at enrollment', () => {
  const sweep = SRC.slice(SRC.indexOf('export async function runSweep'))
  const call = sweep.slice(sweep.indexOf('await evaluateEligibility'))
  assert.match(call.slice(0, 120), /await evaluateEligibility\(c, \{/)
  // atEnroll must NOT be set here, or the send-time-only checks (attempt cap, recent manual
  // contact, a scheduled text already waiting) would be skipped on every send.
  assert.ok(!/atEnroll/.test(call.slice(0, 120)), 'the send-time check must not run in enrol mode')
})

test('any prior meaningful reply blocks the campaign', () => {
  assert.match(SRC, /code: 'PRIOR_RESPONSE'/)
})

test('a reply from a replaced number does not block the lead', () => {
  const fn = SRC.slice(SRC.indexOf('export function historyBlock'))
  assert.match(fn, /if \(from\.length === 10 && !current\.has\(from\)\) continue/)
})

// ---- deferral (§16, §17, §19) -------------------------------------------------------------------

test('automation never talks over a person', () => {
  assert.match(SRC, /code: 'RECENT_MANUAL_CONTACT'/)
  // and the campaign's own sends must not count as human contact, or it defers for ever
  assert.match(SRC, /NOT IN \('ai','fsbo_ai','automation','system','cx_connect','drip','fsbo_offmarket'\)/)
})

test('a live conversation in the last 24h defers the send', () => {
  assert.match(SRC, /code: 'LIVE_CONVERSATION'/)
})

test('a send failure defers, it never ends the campaign', () => {
  const sweep = SRC.slice(SRC.indexOf('export async function runSweep'))
  assert.match(sweep, /event 'send_failed'|'send_failed'/)
  assert.ok(!/status='stopped'[\s\S]{0,200}send_failed/.test(sweep))
})

// ---- audit (§22) ----------------------------------------------------------------------------------

test('every event is logged with what it needs to be audited', () => {
  for (const col of ['attempt', 'angle', 'template_key', 'age_bucket', 'response_class',
    'stop_reason', 'defer_reason', 'phone', 'body', 'scheduled_for']) {
    assert.ok(DB.includes(col), `fsbo_om_log needs ${col}`)
  }
  assert.match(SRC, /export function logOm/)
})

test('a logging failure never blocks a send decision', () => {
  const fn = SRC.slice(SRC.indexOf('export function logOm'))
  assert.match(fn.slice(0, 900), /catch \{/)
})

// ---- metrics (§24) ----------------------------------------------------------------------------------

test('angle performance measures opportunity, not just replies', () => {
  // "A message producing angry responses is not successful simply because people replied."
  const fn = SRC.slice(SRC.indexOf('export function anglePerformance'))
  assert.match(fn, /opportunity_pct/)
  assert.match(fn, /negative/)
  assert.match(fn, /NOT_INTERESTED', 'WRONG_NUMBER/)
})

// ---- reuse (§27, §28) ---------------------------------------------------------------------------------

test('the library is separable, so FSBO ACTIVE can reuse the engine', () => {
  for (const name of ['INTRO', 'FOLLOW_UP', 'ANGLES', 'ROTATION']) {
    assert.ok(SRC.includes(`export const ${name}`), `${name} must be exported, not inlined in the sender`)
  }
})

test('angles never repeat inside three sends', () => {
  assert.match(SRC, /ORDER BY id DESC LIMIT 3/)
  assert.match(SRC, /if \(last3\.includes\(key\)\) continue/)
})

// ---- age comes from DOM, not from a sync timestamp -------------------------------------
//
// The first build bucketed on fsbo_status_at, which the master-file sync rewrites on EVERY
// run. Every off-market FSBO therefore read as 0 days old, and the first batch would have
// told 15 owners their listing came off the market today - several of whom listed in
// January. John caught it: "Are you not able to detect DOM? as HUB has DOM on each FSBO."

const lead = (dom, listed) => ({ fsbo_dom: dom, fsbo_list_date: listed })

test('a sync timestamp is never used as the age', () => {
  assert.ok(!/fsbo_status_at/.test(SRC.slice(SRC.indexOf('export function listingAgeDays'), SRC.indexOf('export function ageBucket'))),
    'fsbo_status_at is the last sync time, not an event date')
})

test('DOM drives the bucket', () => {
  assert.equal(OM.listingAgeDays(lead(273, '2/18/2026')), 273)
  assert.equal(OM.ageBucket(OM.listingAgeDays(lead(273, '2/18/2026'))), 'old')
  assert.equal(OM.ageBucket(OM.listingAgeDays(lead(12, '11/6/2026'))), 'recent')
  assert.equal(OM.ageBucket(OM.listingAgeDays(lead(400, '1/1/2025'))), 'ancient')
})

test('a MISSING dom is unknown, not zero', () => {
  // Number(null) is 0 and 0 is finite, so a naive Number() read turns every missing DOM
  // into "listed today" and sends the recent wording to an old listing. Zero has to stay
  // real, because a listing can genuinely be pulled the day it goes live.
  assert.equal(OM.listingAgeDays(lead(0, '11/18/2026')), 0, 'zero is a real value')
  assert.equal(OM.ageBucket(OM.listingAgeDays(lead(0, '11/18/2026'))), 'recent')
  assert.equal(OM.listingAgeDays(lead(null, null)), null, 'unknown stays unknown')
  assert.equal(OM.ageBucket(OM.listingAgeDays(lead(null, null))), 'old', 'unknown is never recent')
  assert.equal(OM.ageBucket(OM.listingAgeDays(lead('', null))), 'old')
})

test('no DOM falls back to the list date rather than giving up', () => {
  const age = OM.listingAgeDays(lead(null, '5/6/2026'))
  assert.ok(age > 150 && age < 400, `derived ${age} days from the list date`)
  assert.equal(OM.ageBucket(age), 'old')
})

test('an old listing can never be told it came off market recently', () => {
  for (const c of [lead(273, '2/18/2026'), lead(null, null), lead(200, '5/1/2026')]) {
    const b = OM.ageBucket(OM.listingAgeDays(c))
    const msg = OM.INTRO[b]('123 Main St', 'Hi, good morning :)')
    assert.ok(!/no longer listed|was for sale recently/.test(msg), `recent wording reached a ${b} listing`)
  }
})

// ---- first sends are spread, not fired in one burst ------------------------------------
//
// Enrolling the pool used to set every lead to now + 60s. The sweep runs every 15 minutes
// with a limit of 25, so all 15 would have left the same Twilio number inside one minute.
// Fifteen near-identical cold texts in a row is the pattern carriers score as spam, and the
// number carries that for every conversation on it.

test('no more than a handful of first texts may land on one day', () => {
  assert.equal(OM.NEW_PER_DAY, 5)
  assert.match(SRC, /attempt_count = 0 AND next_send_at IS NOT NULL/)
  assert.match(SRC, /if \(taken >= NEW_PER_DAY\) continue/)
})

test('enrollment uses the staggered slot, not "one minute from now"', () => {
  const fn = SRC.slice(SRC.indexOf('export async function enrollClient'))
  assert.match(fn, /const first = firstSendSlot\(\)/)
  assert.ok(!/Date\.now\(\) \+ 60000\)\)\.toISOString\(\)[\s\S]{0,80}INSERT INTO fsbo_om_campaign/.test(fn),
    'the old immediate slot must be gone')
})

test('a first send is never scheduled in the past', () => {
  assert.match(SRC, /if \(d\.getTime\(\) < Date\.now\(\) \+ 60000\) continue/)
})

test('a staggered slot still respects the weekday window', () => {
  const hr = (d) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false }).format(d))
  const wd = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(d)
  for (let i = 0; i < 40; i++) {
    const d = new Date(OM.firstSendSlot())
    assert.ok(hr(d) >= 9 && hr(d) < 16, `slot at ${hr(d)}:00 Central`)
    assert.ok(!['Sat', 'Sun'].includes(wd(d)), `slot on ${wd(d)}`)
    assert.ok(d.getTime() > Date.now(), 'slot must be in the future')
  }
})

test('the board selects the columns the age is derived from', () => {
  // It did not, so every row reported a null age and fell back to `old`. The board showed
  // one bucket for everybody while the send path, which loads the whole client row, was
  // bucketing correctly - a dashboard quietly disagreeing with what actually goes out.
  const q = SRC.slice(SRC.indexOf('export function board'))
  assert.match(q, /c\.fsbo_dom/)
  assert.match(q, /c\.fsbo_list_date/)
})

test('a minimum gap between sends is enforced at send time', () => {
  // Spacing the scheduled times is not enough: the sweep runs every 15 minutes with a
  // limit of 25, so it collects everything due and sends it back to back. The gap has to
  // belong to the campaign, or any sweep can still produce a burst.
  assert.match(SRC, /export function gapRemainingMs/)
  assert.match(SRC, /fsbo_offmarket_min_gap_minutes/)
  const sweep = SRC.slice(SRC.indexOf('export async function runSweep'))
  assert.match(sweep, /const wait = gapRemainingMs\(\)/)
  // It must BREAK, not continue: the queue is due-ordered, so skipping would let a later
  // lead jump the one in front of it.
  assert.match(sweep, /if \(wait > 0\) \{[\s\S]{0,220}break/)
})

test('the pacing check sits after the dry-run return, so a preview is never paced', () => {
  const sweep = SRC.slice(SRC.indexOf('export async function runSweep'))
  assert.ok(sweep.indexOf('would_send') < sweep.indexOf('const wait = gapRemainingMs()'))
})

// ---- the override forgives words, never compliance -------------------------------------
//
// John reviewed the replies himself and judged those leads still worth contacting. The code
// refused them, correctly, so the way through is an explicit logged override rather than a
// weaker default - the same pattern the AI guards use for a hand-added lead.

test('an override exists and is recorded against whoever used it', () => {
  assert.match(SRC, /export async function enrollClient\(clientId, by = 'auto', \{ override = false \} = \{\}\)/)
  assert.match(SRC, /logOm\(c\.id, 'override'/)
  assert.match(SRC, /forgiven by \$\{by\}/)
})

test('it forgives ONLY what the lead previously said', () => {
  // The guard sits on the history block, which is the last check in eligibility. Every
  // compliance gate - STOP, opt-out, junk, sold, pending, relisted, another workflow -
  // is evaluated and returned BEFORE it, so an override cannot reach any of them.
  const fn = SRC.slice(SRC.indexOf('export async function evaluateEligibility'))
  const overridePoint = fn.indexOf('&& !override')
  for (const gate of ["code: 'DNC'", "code: 'SOLD'", "code: 'PENDING'", "code: 'LISTED_WITH_AGENT'", "lead junked"]) {
    const at = fn.indexOf(gate)
    assert.ok(at > 0 && at < overridePoint, `${gate} must be checked before the override point`)
  }
})

test('STOP can never be overridden', () => {
  const fn = SRC.slice(SRC.indexOf('export async function evaluateEligibility'))
  const dnc = fn.slice(fn.indexOf('hub_text_opt_out'), fn.indexOf('hub_text_opt_out') + 160)
  assert.ok(!/override/.test(dnc), 'the opt-out check must not consult the override')
})

// An override that only applies at enrolment is worse than none: on 2026-11-18 eight leads
// were enrolled with one and then stopped by the send-time check minutes later, because the
// sweep re-evaluated them without it. The decision has to be stored and re-read.

test('the override is stored on the row, not just used once at enrolment', () => {
  const fn = SRC.slice(SRC.indexOf('export async function enrollClient'))
  assert.match(fn, /history_override/, 'enrolment must persist the override')
  assert.match(fn, /const overrideNote = ev\.overrode \?/, 'it must record WHAT was forgiven and by whom')
})

test('the send-time check reads the stored override', () => {
  const sweep = SRC.slice(SRC.indexOf('export async function runSweep'))
  const call = sweep.slice(sweep.indexOf('await evaluateEligibility'))
  assert.match(call.slice(0, 120), /override: !!en\.history_override/,
    'the sweep must pass the row\'s stored override, or every overridden lead is stopped on its first pass')
})

test('an override cannot reopen a lead who declined in reply to OUR text', () => {
  const fn = SRC.slice(SRC.indexOf('export async function enrollClient'), SRC.indexOf('export function eligiblePool'))
  const reopen = fn.slice(fn.indexOf('const reopenable'), fn.indexOf('const ev = await evaluateEligibility'))
  // Never texted by this campaign is the whole condition: it is what separates a verdict
  // from an earlier conversation, which a person can read and forgive, from a reply to us.
  assert.match(reopen, /attempt_count \|\| 0\) === 0/)
  assert.match(reopen, /existing\.status === 'not_interested'/)
  // dnc, sold and listed_with_agent are facts, not opinions, and stay closed either way.
  for (const s of ['dnc', 'sold', 'listed_with_agent']) {
    assert.ok(!new RegExp(`status === '${s}'`).test(reopen), `${s} must not be reopenable`)
  }
})

// ---- retiming the queue must stay inside the texting window -----------------------------
//
// Retiming is the deliberate override of NEW_PER_DAY: a person asking for the whole batch
// promptly. What it must never do is make never-contacted sellers due outside 9-5, which
// the first version would have done at 4:17pm on 2026-11-18.

test('every retimed slot is clamped into the texting window', () => {
  const fn = SRC.slice(SRC.indexOf('export function retimeQueue'))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /const base = nextValidSlot\(/, 'the start of the queue must be clamped')
  assert.match(body, /const at = nextValidSlot\(new Date\(base\.getTime\(\) \+ i \* 60000\)\)/,
    'each slot must be clamped, not just the first: a long queue can run past the end hour')
  // Never in the past either, or everything retimed is instantly due at once.
  assert.match(body, /Date\.now\(\) \+ 60000/)
})

test('the retime route does no date arithmetic of its own', () => {
  const r = ROUTE.slice(ROUTE.indexOf("router.post('/retime'"))
  const body = r.slice(0, r.indexOf('\n})'))
  assert.match(body, /OM\.retimeQueue\(/)
  assert.ok(!/Date\.now\(\) \+/.test(body) && !/new Date\(base/.test(body),
    'the route must not compute send times; the window helper lives in the campaign module')
})

test('the window helper really does push an evening time to the next morning', async () => {
  const { nextValidSlot, inProactiveWindow } = await import('../server/fsbo-followup.js')
  // 9pm on a Tuesday, and 7am on a Wednesday: both outside, both must come back inside.
  for (const iso of ['2026-11-17T03:00:00.000Z', '2026-11-18T13:00:00.000Z']) {
    const at = nextValidSlot(new Date(iso))
    assert.ok(inProactiveWindow(at), `${iso} was not clamped into the window (got ${at.toISOString()})`)
  }
  // A time already inside the window is returned untouched, so an ordered queue stays ordered.
  const inside = new Date('2026-11-18T16:30:00.000Z')   // 10:30am Central, a Wednesday
  assert.equal(nextValidSlot(inside).getTime(), inside.getTime())
})
