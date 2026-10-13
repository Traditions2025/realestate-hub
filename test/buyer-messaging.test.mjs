// Cold-buyer nurture copy and area-based outreach. John's rewrite, 2026-10-13.
//
// The copy is his, used verbatim, so most of these tests protect properties that are easy to
// break by accident later: the website line staying gone, apostrophes staying GSM-7, John
// being introduced once rather than every message, and the one-link-per-SMS rule.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import * as B from '../server/ai-followup/buyer-messages.js'
import { COLD_BUYER_STAGES } from '../server/ai-followup/prompts.js'
import { fixGreetingForTime, centralPeriod, avoidJohnOnJohn } from '../server/ai-followup/cold-template.js'
import {
  communityUrl, communityName, normaliseCity, countUrls, FEATURED_COMMUNITIES,
  AREA_OPENERS, AREA_OPENERS_COLD,
} from '../server/ai-followup/area-links.js'

const ALL = B.ALL_BUYER_MESSAGES

/* ---------- the things John explicitly asked for ---------- */

test('the generic website line is gone from every single message', () => {
  const offenders = ALL.filter(m => /mattsmithteam\.com/i.test(m))
  assert.equal(offenders.length, 0,
    'the old bank appended "You can always browse the latest at MattSmithTeam.com" to all of them')
})

test('every message greets the lead by name', () => {
  const missing = ALL.filter(m => !m.includes('{{first_name}}'))
  assert.deepEqual(missing, [], 'each outreach must greet them by name')
})

test('John is introduced on Day 1 only, not re-introduced on every follow-up', () => {
  const intro = /John (?:here )?with Matt Smith Team/i
  assert.ok(B.DAY1.some(m => intro.test(m)), 'Day 1 should introduce John')
  for (const [name, bank] of Object.entries(B.BUYER_BANKS)) {
    if (name === 'DAY1') continue
    const offenders = bank.filter(m => intro.test(m))
    assert.deepEqual(offenders, [], `${name} must read as a continuing conversation`)
  }
})

test('the three greeting styles are all in use', () => {
  const starts = (bank) => ({
    morning: bank.filter(m => m.startsWith('Good morning,')).length,
    afternoon: bank.filter(m => m.startsWith('Good afternoon,')).length,
    hi: bank.filter(m => m.startsWith('Hi ')).length,
  })
  for (const key of ['DAY1', 'DAY4', 'DAY9', 'DAY17', 'DAY30', 'DAY50']) {
    const s = starts(B.BUYER_BANKS[key])
    assert.ok(s.morning > 0 && s.afternoon > 0 && s.hi > 0, `${key} should mix all three greetings`)
  }
})

/* ---------- SMS mechanics ---------- */

test('no curly quotes: they force UCS-2 and cut a segment from 160 chars to 70', () => {
  const offenders = ALL.filter(m => /[‘’“”–—…]/.test(m))
  assert.deepEqual(offenders.map(m => m.slice(0, 40)), [], 'use straight quotes and plain ASCII')
})

test('every message fits inside two GSM-7 segments', () => {
  const tooLong = ALL.filter(m => m.length > 306)   // 2 concatenated segments = 306 chars
  assert.deepEqual(tooLong.map(m => `${m.length}: ${m.slice(0, 50)}`), [])
})

test('no message carries a URL: links belong only to the area outreach', () => {
  const withUrls = ALL.filter(m => countUrls(m) > 0)
  assert.deepEqual(withUrls, [])
})

/* ---------- stage wiring ---------- */

test('the stages match the cadence the scheduler actually uses', () => {
  const days = COLD_BUYER_STAGES.filter(s => s.day != null).map(s => s.day)
  assert.deepEqual(days, [1, 4, 9, 17, 30, 50, 80, 120, 165, 210],
    'these must stay in step with COLD_DAYS in ai-followup/scheduler.js')
  assert.equal(COLD_BUYER_STAGES.at(-1).loop, true, 'the last stage is the perpetual loop')
})

test('each stage is wired to its own bank, with nothing empty', () => {
  for (const s of COLD_BUYER_STAGES) {
    assert.ok(Array.isArray(s.messages) && s.messages.length > 0, `${s.key} has no messages`)
  }
  assert.equal(COLD_BUYER_STAGES.find(s => s.key === 't1').messages.length, 24)
  assert.equal(COLD_BUYER_STAGES.find(s => s.key === 'loop').messages.length, 8)
})

test('area outreach is enabled on Day 17, Day 30 and the loop, and nowhere else', () => {
  const eligible = COLD_BUYER_STAGES.filter(s => s.areaEligible).map(s => s.key)
  assert.deepEqual(eligible.sort(), ['loop', 't4', 't5'],
    'Day 1 stays a reconnect, not a link drop')
})

/* ---------- greeting correction ---------- */

const at = (utcHour) => new Date(Date.UTC(2026, 9, 13, utcHour, 0, 0))   // Oct 13, CDT = UTC-5

test('a morning greeting sent in the afternoon is corrected', () => {
  const out = fixGreetingForTime('Good morning, {{first_name}}! Test?', at(19))  // 2pm CT
  assert.match(out, /^Good afternoon, \{\{first_name\}\}!/)
})

test('a correct greeting is left exactly as written', () => {
  const msg = 'Good morning, {{first_name}}! Test?'
  assert.equal(fixGreetingForTime(msg, at(14)), msg)   // 9am CT
})

test('in the evening a timed greeting becomes the neutral Hi', () => {
  const out = fixGreetingForTime('Good afternoon, {{first_name}}! Test?', at(2)) // 9pm CT
  assert.match(out, /^Hi \{\{first_name\}\}!/)
  assert.doesNotMatch(out, /Good (morning|afternoon|evening)/)
})

test('"Hi" is never rewritten, which is what keeps the mix varied', () => {
  const msg = 'Hi {{first_name}}! Test?'
  for (const h of [14, 19, 2]) assert.equal(fixGreetingForTime(msg, at(h)), msg)
})

test('centralPeriod splits the day the way the copy assumes', () => {
  assert.equal(centralPeriod(at(14)), 'morning')     // 9am
  assert.equal(centralPeriod(at(19)), 'afternoon')   // 2pm
  assert.equal(centralPeriod(at(2)), 'evening')      // 9pm
})

test('a lead called John is not told "Hi John! It is John with Matt Smith Team"', () => {
  const msg = "Hi {{first_name}}! It's John with Matt Smith Team at RE/MAX. How did it go?"
  const out = avoidJohnOnJohn(msg, { first_name: 'John' })
  assert.doesNotMatch(out, /\{\{first_name\}\}/, 'the duplicate name is dropped from the greeting')
  assert.match(out, /It's John with Matt Smith Team/, 'but John still introduces himself')
  // anyone else keeps their name
  assert.equal(avoidJohnOnJohn(msg, { first_name: 'Sarah' }), msg)
})

/* ---------- area links ---------- */

test('every featured community maps to the agreed URL pattern', () => {
  assert.equal(communityUrl('Marion'), 'https://www.mattsmithteam.com/marion-ia-homes-for-sale/')
  assert.equal(communityUrl('Cedar Rapids'), 'https://www.mattsmithteam.com/cedar-rapids-ia-homes-for-sale/')
  assert.equal(communityUrl('Mount Vernon'), 'https://www.mattsmithteam.com/mount-vernon-ia-homes-for-sale/')
  assert.equal(Object.keys(FEATURED_COMMUNITIES).length, 11)
})

test('city strings are normalised the way the data actually arrives', () => {
  for (const v of ['MARION', 'Marion, IA', ' marion ', 'Marion, Iowa', 'marion,IA'])
    assert.equal(normaliseCity(v), 'marion', `failed on ${JSON.stringify(v)}`)
  assert.equal(communityName('CEDAR RAPIDS, IA'), 'Cedar Rapids')
})

test('a city with no featured page gets NO link, rather than a guess', () => {
  for (const v of ['Des Moines', 'Iowa City', 'Springville', '', null, undefined, '12345'])
    assert.equal(communityUrl(v), null, `${v} must not produce a link`)
})

test('every area message carries exactly one URL', () => {
  for (const t of [...AREA_OPENERS, ...AREA_OPENERS_COLD]) {
    const filled = t.replace('{{url}}', 'https://www.mattsmithteam.com/marion-ia-homes-for-sale/')
    assert.equal(countUrls(filled), 1, `more than one link in: ${t.slice(0, 50)}`)
  }
})

test('area messages greet by name, carry the link, and vary their opener', () => {
  for (const t of [...AREA_OPENERS, ...AREA_OPENERS_COLD]) {
    assert.ok(t.includes('{{first_name}}'), 'must greet by name')
    assert.ok(t.includes('{{url}}'), 'must carry the link')
  }
  const opens = AREA_OPENERS.map(t => t.slice(0, 24))
  assert.equal(new Set(opens).size, opens.length, 'openers must not all start the same way')
})

test('the city is NEVER named in the message text', () => {
  // John, 2026-10-13: send the listings link without mentioning the city. The URL still
  // points at the right community, so the area is obvious once they tap it, but the text
  // does not read as though we have been watching where they browse.
  for (const t of [...AREA_OPENERS, ...AREA_OPENERS_COLD]) {
    assert.ok(!t.includes('{{area}}'), `area token still present in: ${t.slice(0, 50)}`)
    for (const city of Object.values(FEATURED_COMMUNITIES))
      assert.ok(!t.includes(city), `hardcoded city "${city}" in an area message`)
  }
})

test('dropping the city does not loosen WHICH link is chosen', () => {
  // Not naming the area is a wording change. A Marion searcher must still not get a Cedar
  // Rapids page, so communityUrl stays strict about what is featured.
  assert.equal(communityUrl('Marion'), 'https://www.mattsmithteam.com/marion-ia-homes-for-sale/')
  assert.equal(communityUrl('Solon'), null)
})

test('only the cold versions reintroduce John', () => {
  assert.ok(AREA_OPENERS_COLD.some(t => /John with Matt Smith Team/.test(t)))
  assert.equal(AREA_OPENERS.filter(t => /John with Matt Smith Team/.test(t)).length, 0)
})

test('no area message says "I saw you on our website"', () => {
  for (const t of [...AREA_OPENERS, ...AREA_OPENERS_COLD])
    assert.doesNotMatch(t, /saw you on our website/i, 'rotate the wording; do not say this every time')
})

/* ---------- spot-check that the copy is John's, verbatim ---------- */

test('the copy is used exactly as written', () => {
  assert.equal(B.DAY1[0],
    "Hi {{first_name}}! It's John with Matt Smith Team at RE/MAX. It's been a little while since we last connected, so I thought I'd check in. How did things end up going with the home search?")
  assert.equal(B.DAY50[0],
    "Hi {{first_name}}! Should I keep you posted if something good comes up, or give you some space for now?")
  assert.equal(B.ONGOING.length, 8)
  assert.equal(B.DAY1.length, 24)
})

test('consecutive area messages differ, so Day 17 and Day 30 are not word-for-word identical', async () => {
  const { buildAreaMessage } = await import('../server/ai-followup/area-links.js')
  const pick = { city: 'Marion', name: 'Marion', url: 'https://www.mattsmithteam.com/marion-ia-homes-for-sale/', reason: 'test' }
  const d17 = buildAreaMessage(4242, { pick, seed: 3 })   // stage index 3 = Day 17
  const d30 = buildAreaMessage(4242, { pick, seed: 4 })   // stage index 4 = Day 30
  assert.notEqual(d17.text, d30.text, 'same lead, two stages, must not be the identical message')
})

test('area messages get the same time-of-day greeting correction as the bank', () => {
  const src = fs.readFileSync(new URL('../server/ai-followup/orchestrator.js', import.meta.url), 'utf8')
  const i = src.indexOf('buildAreaMessage')
  const block = src.slice(i, i + 900)
  assert.match(block, /fixGreetingForTime/,
    'an area message carries its own greeting and must not escape the correction')
})

/* ---------- auto-pause on reply, and the wrong-person doctrine ---------- */

test('any inbound reply auto-pauses the AI, gated by a setting', () => {
  const src = fs.readFileSync(new URL('../server/ai-followup/orchestrator.js', import.meta.url), 'utf8')
  const i = src.indexOf('export async function handleInboundText')
  const fn = src.slice(i, i + 5000)   // must reach canSendSms, which sits ~50 lines in
  assert.match(fn, /ai_auto_pause_on_reply/, 'must be a setting, so it can be turned back on without a deploy')
  assert.match(fn, /'1'\)\) === '1'/, 'default is ON')
  assert.match(fn, /HUMAN_TAKEOVER/, 'the lead is handed to a human')
  // and it must sit BEFORE the AI composes anything
  assert.ok(fn.indexOf('ai_auto_pause_on_reply') < fn.indexOf('canSendSms'),
    'the pause has to short-circuit before any reply is generated')
})

test('a manual send-now can still draft for a paused lead', () => {
  const src = fs.readFileSync(new URL('../server/ai-followup/orchestrator.js', import.meta.url), 'utf8')
  // the guard line itself, not a comment mentioning the setting
  const line = src.split(/\r?\n/).find(l => l.includes("getSetting?.('ai_auto_pause_on_reply'"))
  assert.ok(line, 'the guard line should exist')
  assert.match(line, /!force\s*&&/, 'force must bypass the auto-pause')
})

test('the wrong-person doctrine is in the system prompt for buyers and cold sellers', async () => {
  const { buildSystemPrompt } = await import('../server/ai-followup/prompts.js')
  for (const client of [{ id: 1, first_name: 'Scott' }, { id: 2, first_name: 'Scott', fsbo_status: 'Available' }]) {
    const p = buildSystemPrompt({ client, lead_type: 'buyer' })
    assert.match(p, /WRONG PERSON OR NOT LOOKING/, 'doctrine missing for one of the prompt shapes')
  }
})

test('the doctrine bans the three things that make a bad moment worse', async () => {
  const { NOT_INTERESTED_DOCTRINE } = await import('../server/ai-followup/prompts.js')
  assert.match(NOT_INTERESTED_DOCTRINE, /remove you from our list/, 'must name the banned phrase')
  assert.match(NOT_INTERESTED_DOCTRINE, /UNLESS they\s*\n?\s*explicitly asked/, 'allowed only if they ask')
  assert.match(NOT_INTERESTED_DOCTRINE, /NEVER mention website activity/, 'never explain tracking')
  assert.match(NOT_INTERESTED_DOCTRINE, /not ask another qualifying question/, 'no further questions')
  assert.match(NOT_INTERESTED_DOCTRINE, /never copy these word for word/, 'examples are a tone guide, not a script')
})

/* ---------- Day 1 link ---------- */

test('Day 1 carries one full tappable URL, with no "browse listings" phrasing', async () => {
  const { renderColdStageTemplate } = await import('../server/ai-followup/cold-template.js')
  const { DAY1, DAY4 } = await import('../server/ai-followup/buyer-messages.js')
  const client = { id: 7, first_name: 'Sarah', city: 'Marion' }
  const d1 = await renderColdStageTemplate(0, DAY1[0], client)
  assert.match(d1, /https:\/\/www\.mattsmithteam\.com\//, 'a full URL, not a bare domain')
  assert.equal((d1.match(/https?:\/\//g) || []).length, 1, 'exactly one link')
  assert.doesNotMatch(d1, /browse/i, 'no "you can browse listings" phrasing')
})

test('no stage after Day 1 appends the website', async () => {
  const { renderColdStageTemplate } = await import('../server/ai-followup/cold-template.js')
  const B = await import('../server/ai-followup/buyer-messages.js')
  const client = { id: 7, first_name: 'Sarah', city: 'Marion' }
  for (const [i, bank] of [[1, B.DAY4], [2, B.DAY9], [5, B.DAY50], [10, B.ONGOING]]) {
    const out = await renderColdStageTemplate(i, bank[0], client)
    assert.doesNotMatch(out, /mattsmithteam\.com/i, `stage ${i} must carry no website link`)
  }
})
