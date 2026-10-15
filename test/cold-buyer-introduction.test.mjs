// A lead's FIRST message from us has to say who is texting.
//
// John, 2026-10-15, on Norma Walker: "we did not introduce ourselves and no link."
//
// She was auto-enrolled on Monday 2026-10-12 and the first text she ever received was on
// Thursday the 15th — a DAY 4 message. She replied "Yes. Who is this?" and John answered
// by hand. Two things were wrong:
//
//   1. Only 3 of the 24 Day 1 openers actually introduce John, so even a correct Day 1 left
//      7 in 8 leads introduced to nobody. The rule was "John introduces himself on Day 1";
//      the copy did not implement it.
//   2. Day 1 never fired for her at all. The ten stages are pre-scheduled independently, a
//      blocked one is marked failed and never retried, and the rest still fire on their own
//      dates — so a missed Day 1 silently becomes "no introduction, ever".
//
// The introduction and the site link are now tied to being the FIRST message, not to the
// stage number alone. John's sentences are never rewritten: the introduction is inserted
// only when the chosen message does not already carry it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ensureIntroduction, INTRO, SITE_URL, renderColdStageTemplate,
} from '../server/ai-followup/cold-template.js'
import { DAY1, DAY4, BUYER_BANKS } from '../server/ai-followup/buyer-messages.js'

const client = { id: 1, first_name: 'Norma', last_name: 'Walker', city: 'Marion' }

// ── the introduction itself ──────────────────────────────────────────────────────────
test('a message with no introduction gets one, after the greeting', () => {
  const out = ensureIntroduction('Good morning, {{first_name}}! Would you still be open to buying?')
  assert.equal(out, "Good morning, {{first_name}}! It's John with Matt Smith Team at RE/MAX. Would you still be open to buying?")
})

test("John's own wording is never rewritten when it is already there", () => {
  const already = "Hi {{first_name}}! It's John with Matt Smith Team at RE/MAX. It's been a little while."
  assert.equal(ensureIntroduction(already), already)
})

test('it matches the wording the complete openers already use', () => {
  const withIntro = DAY1.filter(t => /Matt Smith Team/i.test(t))
  assert.ok(withIntro.length >= 1)
  assert.ok(withIntro.some(t => t.includes(INTRO)),
    'the inserted sentence must be the one the bank already uses, not a new variant')
})

test('every greeting shape in the bank is recognised', () => {
  for (const g of ['Hi {{first_name}}!', 'Hello {{first_name}}!', 'Good morning, {{first_name}}!',
    'Good afternoon, {{first_name}}!', 'Good evening, {{first_name}}!']) {
    const out = ensureIntroduction(`${g} Did you ever find a place?`)
    assert.ok(out.startsWith(g), `greeting must survive intact: ${g} -> ${out}`)
    assert.ok(out.includes(INTRO), `introduction missing after ${g}`)
  }
})

test('a message with no greeting still introduces us, by leading with it', () => {
  const out = ensureIntroduction('Did you ever find a place?')
  assert.ok(out.startsWith(INTRO))
})

test('the introduction is added once, never twice', () => {
  const once = ensureIntroduction('Hi {{first_name}}! Any luck?')
  assert.equal(ensureIntroduction(once), once)
  assert.equal((once.match(/Matt Smith Team/gi) || []).length, 1)
})

// ── Day 1 ────────────────────────────────────────────────────────────────────────────
test('EVERY Day 1 opener now introduces us and carries the site', async () => {
  for (let i = 0; i < DAY1.length; i++) {
    const out = await renderColdStageTemplate(0, DAY1[i], client)
    assert.match(out, /Matt Smith Team/i, `Day 1 #${i + 1} does not say who is texting: ${out}`)
    assert.ok(out.includes(SITE_URL), `Day 1 #${i + 1} has no site link: ${out}`)
  }
})

// ── the case that actually happened ──────────────────────────────────────────────────
test('a later stage that is the lead’s FIRST contact introduces us', async () => {
  // Norma's exact message, Day 4 #14, as her first ever text
  const hers = DAY4.find(t => t.includes('Would you still be open to buying if the right opportunity came along'))
  assert.ok(hers, 'her message should still be in the Day 4 bank')
  const out = await renderColdStageTemplate(1, hers, client, { firstContact: true })
  assert.match(out, /Matt Smith Team/i, 'she had no idea who was texting')
  assert.ok(out.includes(SITE_URL), 'the first message is also where the site belongs')
})

test('a later stage mid-conversation stays continuous — no re-introduction, no link', async () => {
  const out = await renderColdStageTemplate(1, DAY4[0], client, { firstContact: false })
  assert.ok(!/Matt Smith Team/i.test(out), 'reintroducing ourselves mid-thread reads like an automation')
  assert.ok(!out.includes(SITE_URL), 'the site is the first message only')
})

test('that is the default, so nothing changes for leads already in a thread', async () => {
  const out = await renderColdStageTemplate(3, BUYER_BANKS.DAY17[0], client)
  assert.ok(!/Matt Smith Team/i.test(out))
})

// ── the orchestrator asks the right question ─────────────────────────────────────────
test('firstContact comes from whether we have EVER texted them', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../server/ai-followup/orchestrator.js', import.meta.url), 'utf8')
  assert.match(src, /direction='outgoing' LIMIT 1/)
  assert.match(src, /firstContact: !everTexted/)
})

// ── length, since the introduction costs characters ──────────────────────────────────
test('a Day 1 message stays within a sane SMS length', async () => {
  for (let i = 0; i < DAY1.length; i++) {
    const out = await renderColdStageTemplate(0, DAY1[i], client)
    assert.ok(out.length <= 480, `Day 1 #${i + 1} is ${out.length} chars, over 3 segments: ${out}`)
  }
})

test('straight apostrophes only — a curly one halves the segment size', async () => {
  for (let i = 0; i < DAY1.length; i++) {
    const out = await renderColdStageTemplate(0, DAY1[i], client)
    assert.ok(!/[‘’“”]/.test(out), `Day 1 #${i + 1} left GSM-7: ${out}`)
  }
})
