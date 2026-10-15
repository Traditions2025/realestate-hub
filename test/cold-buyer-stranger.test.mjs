// Never claim we have spoken to someone we have not.
//
// John, 2026-10-15, on Toni Cress: "first text seems to be too blanket."
//
// Her Day 1 was NOT skipped — stage 0 completed, and the message carried the introduction
// and the site link. The problem was what it said:
//
//   "Hi Toni! It's John with Matt Smith Team at RE/MAX. Just thought I'd check in.
//    Has what you're looking for changed at all since we last talked?"
//
// We had never talked. Her record held ZERO communications of any kind, and the system
// knew it — she was enrolled on the COLD_NEVER_CONNECTED lane. She replied STOP
// twenty-five minutes later.
//
// Half the Day 1 openers are written for a lead we really did speak to. Those are right
// for a dormant past conversation and wrong for someone who only ever registered on the
// site, so the bank is now filtered by whether a conversation actually happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assumesPriorContact, bankForStranger, renderColdStageTemplate } from '../server/ai-followup/cold-template.js'
import { DAY1, BUYER_BANKS } from '../server/ai-followup/buyer-messages.js'

const client = { id: 2, first_name: 'Toni', last_name: 'Cress' }

test('it recognises the exact message Toni got', () => {
  const hers = DAY1.find(t => t.includes("Has what you're looking for changed at all since we last talked"))
  assert.ok(hers, 'her opener should still be in the Day 1 bank')
  assert.equal(assumesPriorContact(hers), true)
})

test('every way the bank claims a prior conversation is caught', () => {
  for (const phrase of [
    'It’s been a little while since we last connected, so I thought I’d check in.',
    'I was looking back at our conversation and realized it has been a while.',
    'We connected a while back when you were looking at homes.',
    'I know it has been some time since we talked.',
    'Just wanted to reconnect and see where things stand.',
    'I was looking back at when we last talked about homes.',
    'We probably could have done a better job staying in touch after we last talked.',
  ]) {
    assert.equal(assumesPriorContact(phrase), true, `missed: ${phrase}`)
  }
})

test('a genuinely neutral opener is not filtered out', () => {
  for (const phrase of [
    'Hi {{first_name}}! Are you still keeping an eye on the market?',
    'Good morning, {{first_name}}! If the right home came up, would you want to know?',
    'Hi {{first_name}}! What would your next home need to have?',
  ]) {
    assert.equal(assumesPriorContact(phrase), false, `wrongly excluded: ${phrase}`)
  }
})

test('a stranger can only draw openers that do not claim a history', () => {
  const usable = bankForStranger(DAY1)
  assert.ok(usable.length > 0)
  for (const t of usable) {
    assert.equal(assumesPriorContact(t), false, `a stranger could still be told we talked: ${t}`)
  }
})

test('enough of the bank survives for the rotation to stay varied', () => {
  const usable = bankForStranger(DAY1)
  assert.ok(usable.length >= 8,
    `only ${usable.length} openers left for a stranger — too few, everyone would get the same text`)
})

test('a lead we HAVE spoken to still gets the full bank', () => {
  // the reconnect wording is the right wording there, and it is John's copy
  assert.equal(BUYER_BANKS.DAY1.length, DAY1.length)
  assert.ok(DAY1.some(assumesPriorContact), 'those openers must stay available for dormant leads')
})

test('filtering never leaves nothing to send', () => {
  // a bank written entirely in reconnect language falls back rather than sending silence
  const allPrior = ['Hi! Since we last talked, anything change?', 'Just reconnecting.']
  assert.deepEqual(bankForStranger(allPrior), allPrior)
  assert.deepEqual(bankForStranger([]), [])
})

test('a stranger-safe opener still introduces us and carries the site', async () => {
  for (const t of bankForStranger(DAY1)) {
    const out = await renderColdStageTemplate(0, t, client)
    assert.match(out, /Matt Smith Team/i, `no introduction: ${out}`)
    assert.ok(out.includes('https://www.mattsmithteam.com/'), `no site link: ${out}`)
    assert.equal(assumesPriorContact(out), false, `claims a history we do not have: ${out}`)
  }
})

// ── the handler asks the right question ──────────────────────────────────────────────
test('"ever connected" means a real conversation, not a marketing email', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../server/ai-followup/orchestrator.js', import.meta.url), 'utf8')
  assert.match(src, /direction='incoming' OR channel IN \('text','call','voicemail'\)/,
    'an email blast they never answered is not a conversation')
  assert.match(src, /const bank = everConnected \? \(stage\.messages \|\| \[\]\) : bankForStranger\(stage\.messages \|\| \[\]\)/)
})

test('the check runs before the message is chosen', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../server/ai-followup/orchestrator.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export async function handleColdBuyerStage'))
  assert.ok(fn.indexOf('everConnected') < fn.indexOf('const rotKey'),
    'the bank has to be narrowed before the rotation picks from it')
})
