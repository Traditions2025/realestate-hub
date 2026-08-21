// HUB AI — regression scenario suite derived from the Conversation Training Book
// (Parts XV/XVI/XX). These lock in the DETERMINISTIC, safety-critical behaviors that
// back the buyer/seller scenario libraries: intent detection, natural-language
// opt-out (§83), autopilot exclusions (§50), and that the training rules actually
// reached the system prompt. Purely-conversational phrasing is graded by the live
// quality review, not here — we don't fake model assertions.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubai_scn_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.ANTHROPIC_API_KEY = ''

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { HIGH_INTENT_RE } = await import('../server/ai-followup/intent.js')
const { isNaturalOptOut } = await import('../server/ai-followup/policy.js')
const { isExcludedFromAutopilot } = await import('../server/ai-followup/state.js')
const { optKeyword } = await import('../server/twilio.js')
const { buildSystemPrompt } = await import('../server/ai-followup/prompts.js')

// ---------- Intent detection (§25, §48, §68, §105/§106 high-intent scenarios) ----------
// Phrases that MUST register as high intent (tour / offer / call / valuation / list).
const HIGH_INTENT = [
  'Can we see it Saturday?',
  'Can someone show us this house?',
  "We'd like to tour it tomorrow",
  'When can we see the property?',
  "We're ready to make an offer",
  'I want to put in an offer',
  'Can you call me this afternoon?',
  "We're pre-approved up to 450",
  'What is my house worth?',
  'I want to list my home',
  'Thinking about selling my house next month',
  'Do you do a cash offer?',
]
for (const msg of HIGH_INTENT) {
  test(`intent: high-intent phrase detected -> "${msg}"`, () => {
    assert.equal(HIGH_INTENT_RE.test(msg), true, 'should be flagged high intent')
  })
}

// Phrases that must NOT be treated as high intent (browsing / early / vague).
const LOW_INTENT = [
  "I'm just browsing right now",
  "We're honestly just looking",
  "Just curious what it's worth someday",   // curiosity, not "what's my house worth" valuation ask
  'Probably a year away',
  'Thanks for the info',
  'Maybe next year',
]
for (const msg of LOW_INTENT) {
  test(`intent: low-intent phrase NOT over-flagged -> "${msg}"`, () => {
    assert.equal(HIGH_INTENT_RE.test(msg), false, 'should NOT be flagged high intent')
  })
}

// ---------- Literal keyword opt-out (§82) ----------
for (const w of ['STOP', 'stop', 'Unsubscribe', 'CANCEL', 'quit', 'END', 'optout', 'opt-out']) {
  test(`opt-out: literal keyword "${w}" -> stop`, () => {
    assert.equal(optKeyword(w), 'stop')
  })
}
for (const w of ['START', 'yes', 'unstop']) {
  test(`opt-out: literal keyword "${w}" -> start`, () => {
    assert.equal(optKeyword(w), 'start')
  })
}

// ---------- Natural-language opt-out (§83) — NEW capability ----------
const NL_OPTOUT = [
  'stop texting me',
  'Please stop texting me',
  "don't text me again",
  'do not message me anymore',
  'quit texting me',
  'no more texts please',
  'take me off your list',
  'please remove me from your list',
  'unsubscribe me',
  'leave me alone',
  'lose my number',
  'stop bothering me',
  'can you stop contacting me',
]
for (const msg of NL_OPTOUT) {
  test(`opt-out: natural language honored -> "${msg}"`, () => {
    assert.equal(isNaturalOptOut(msg), true, 'should be treated as an opt-out')
    // literal keyword parser wouldn't catch these multi-word phrases:
    assert.equal(optKeyword(msg), null)
  })
}

// Must NOT be mistaken for opt-outs (would silently kill a live lead).
const NOT_OPTOUT = [
  'Can we stop by the house on Saturday?',
  'stop sending me listings over 500k but keep the rest',   // a preference, not an opt-out
  "I'll stop looking once we find the right one",
  'The bus stop is close to the house',
  'Text me the address when you get a chance',
  'What time should we meet?',
]
for (const msg of NOT_OPTOUT) {
  test(`opt-out: safe phrase NOT treated as opt-out -> "${msg}"`, () => {
    assert.equal(isNaturalOptOut(msg), false, 'must not opt this lead out')
  })
}

// ---------- Autopilot exclusions (§50, §51, §52) ----------
const EXCLUDED = [
  { tags: 'MLS: Expired', source: 'MLS Import' },
  { tags: 'MLS: Cancelled', source: '' },
  { tags: 'FSBO NEW', source: '' },
  { tags: '', source: 'FSBO Scrape' },
]
for (const c of EXCLUDED) {
  test(`exclusions: prospecting import excluded -> ${c.tags || c.source}`, () => {
    assert.equal(isExcludedFromAutopilot(c), true)
  })
}
const NOT_EXCLUDED = [
  { tags: 'Buyer, Hot', source: 'Sierra IDX' },
  { tags: 'Past Client', source: 'Website' },
  { tags: '', source: '' },
]
for (const c of NOT_EXCLUDED) {
  test(`exclusions: normal inbound lead NOT excluded -> ${c.tags || c.source || 'blank'}`, () => {
    assert.equal(isExcludedFromAutopilot(c), false)
  })
}

// ---------- Training reached the system prompt (§2, §19, §88, §53-59) ----------
test('prompt: conversation-first + accuracy + situations guidance is present', () => {
  const p = buildSystemPrompt({ lead_type: 'buyer' })
  assert.match(p, /CONVERSATION FIRST/i)
  assert.match(p, /never answer a property\/condition question with a qualifying question/i)
  assert.match(p, /VERIFIED .*INFERRED .*UNKNOWN/is)
  assert.match(p, /Zillow/i)                 // pricing-objection handling
  assert.match(p, /never say commissions are fixed/i)
  assert.match(p, /Fair Housing/i)           // still carries the existing guardrails
})

test('prompt: seller playbook still selected for sellers', () => {
  const p = buildSystemPrompt({ lead_type: 'seller' })
  assert.match(p, /SELLER PLAYBOOK/i)
})
