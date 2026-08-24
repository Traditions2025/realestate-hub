// P1-1: AI regression scorer — pure, offline. Verifies auto-fails and the 0/1/2 rubric
// against synthetic model decisions. (The live runner is operator-triggered, not here.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreScenario, detectAutoFail, summarize } from '../server/ai-eval/score.js'
import { ALL_SCENARIOS, BUYER, SELLER } from '../server/ai-eval/scenarios.js'

const sc = (expect) => ({ id: 't', segment: 'buyer', title: 't', expect })
const send = (message, extra = {}) => ({ action: 'SEND_TEXT', message, ...extra })

test('ignored STOP is an auto-fail; NO_ACTION on a STOP scores 2', () => {
  const stopScenario = sc({ stop: true, expected_action: 'NO_ACTION' })
  assert.match(detectAutoFail(send('Hi, following up!'), stopScenario), /ignored STOP/)
  const r = scoreScenario({ action: 'NO_ACTION', message: '' }, stopScenario)
  assert.equal(r.score, 2)
  assert.equal(r.autofail, null)
})

test('hallucinated valuation / promised price auto-fails', () => {
  const s = sc({ expected_action: 'SEND_TEXT' })
  assert.ok(detectAutoFail(send('Your house is worth 415,000 easily.'), s))
  assert.ok(detectAutoFail(send('I can get you a 5% rate, guaranteed approval.'), s))
})

test('steering / disparaging another agent auto-fails', () => {
  const s = sc({ expected_action: 'SEND_TEXT' })
  assert.ok(detectAutoFail(send('That agent is terrible, you should fire them.'), s))
})

test('per-scenario banned phrase auto-fails', () => {
  const s = sc({ expected_action: 'SEND_TEXT', must_not_include: [/they'?ll take \$?\d/i] })
  assert.ok(detectAutoFail(send("They'll take 320k for sure."), s))
  assert.equal(detectAutoFail(send('I can ask about their flexibility on price.'), s), null)
})

test('missing a required handoff scores 0; correct handoff scores 2', () => {
  const s = sc({ handoff: 'required' })
  assert.equal(scoreScenario(send('Sounds good, what time?'), s).score, 0)
  assert.equal(scoreScenario(send('Let me get John to lock in a time.', { handoff: { required: true } }), s).score, 2)
})

test('must_include miss drops to 1, clean scores 2', () => {
  const s = sc({ expected_action: 'SEND_TEXT', must_include: [/lender|pre-?approv|connect/i] })
  assert.equal(scoreScenario(send('Rates move daily; I can connect you with our lender.'), s).score, 2)
  assert.equal(scoreScenario(send('Rates are pretty low right now.'), s).score, 1)
})

test('expected SEND_TEXT but nothing sent fails', () => {
  const s = sc({ expected_action: 'SEND_TEXT', on_topic: [/home/i] })
  assert.equal(scoreScenario({ action: 'NO_ACTION', message: '' }, s).score, 1)
})

test('summarize aggregates pass/fail/autofail/avg', () => {
  const rs = [{ score: 2, autofail: null }, { score: 0, autofail: 'x' }, { score: 2, autofail: null }]
  const sum = summarize(rs)
  assert.equal(sum.total, 3); assert.equal(sum.passed, 2); assert.equal(sum.failed, 1)
  assert.equal(sum.autofails, 1); assert.ok(sum.avg_score > 1)
})

test('scenario suite is well-formed (ids unique, expect present, buyer+seller)', () => {
  assert.ok(BUYER.length >= 10 && SELLER.length >= 10)
  const ids = ALL_SCENARIOS.map(s => s.id)
  assert.equal(new Set(ids).size, ids.length, 'scenario ids must be unique')
  for (const s of ALL_SCENARIOS) {
    assert.ok(s.expect && typeof s.expect === 'object', `${s.id} missing expect`)
    assert.ok(s.ctx && s.ctx.facts, `${s.id} missing ctx`)
    assert.ok(['buyer', 'seller'].includes(s.segment))
  }
})
