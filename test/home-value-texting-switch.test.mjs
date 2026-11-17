// ONE SWITCH TURNS OFF HOME VALUE TEXTING (John, 2026-11-17)
//
// "remove any of the texting for home value response, the questionnaire are almost covering
// all of the items, we don't need to send any more of these messages, so disable the texting
// part of that for now."
//
// home_value_sms_enabled already gated the 45-day sequence runner, but NOT the Day 0
// condition question, which is the text he quoted ("You rated the home a 9 out of 10. What
// would you say is the main thing keeping it from being a 10?"). Turning the sequence off
// would still have let that one go out on every new request.
//
// The email and the report are deliberately NOT behind this switch: he asked to stop the
// texting, not the response.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const INTAKE = readFileSync(new URL('../server/home-value-intake.js', import.meta.url), 'utf8')
const SMS = readFileSync(new URL('../server/home-value-sms.js', import.meta.url), 'utf8')

test('the switch has exactly one definition', () => {
  assert.match(SMS, /export function hvSmsEnabled/)
  assert.equal((INTAKE.match(/function hvSmsEnabled/g) || []).length, 0,
    'intake must import it, not keep a second copy that drifts')
  assert.match(INTAKE, /import \{ hvSmsEnabled \} from '\.\/home-value-sms\.js'/)
})

test('the Day 0 condition question is behind the switch', () => {
  const fn = INTAKE.slice(INTAKE.indexOf('export function scheduleConditionQuestion'))
  const guard = fn.indexOf('hvSmsEnabled()')
  assert.ok(guard > 0, 'the gate exists')
  // It has to come before anything is written, or a disabled campaign still queues a text.
  assert.ok(guard < fn.indexOf('INSERT INTO scheduled_texts'),
    'the gate must run before the text is queued')
})

test('the 45 day sequence runner is behind the same switch', () => {
  const fn = SMS.slice(SMS.indexOf('export async function runHvSmsSweep'))
  assert.match(fn.slice(0, 400), /if \(!hvSmsEnabled\(\)\) return/)
})

test('turning texting off does NOT stop the email or the report', () => {
  // The switch is checked inside the text scheduler, not around the email send, so a lead
  // who asks for their home value still gets the answer.
  const body = INTAKE.slice(INTAKE.indexOf('THE CONDITION QUESTION'), INTAKE.indexOf('export function scheduleConditionQuestion'))
  assert.ok(!/hvSmsEnabled/.test(body),
    'the switch must not sit around the email half of the response')
})

test('past clients are still never texted, switch or no switch', () => {
  // A separate, older rule that must survive this change.
  const fn = INTAKE.slice(INTAKE.indexOf('export function scheduleConditionQuestion'))
  assert.match(fn, /isPastClient\(client\)/)
})
