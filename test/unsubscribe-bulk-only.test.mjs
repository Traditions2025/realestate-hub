// Marketing mail must carry an unsubscribe; transactional and 1:1 mail must not.
//
// Background: the SendGrid account's own Subscription Tracking is off and there are no
// ASM groups, so nothing the Hub sent had an opt-out link. Marketing Campaigns adds one
// automatically; the Email API, which is what the Hub uses, does not.
//
// The trap this pins: EVERY automated send carries a category, including password
// resets, calendar invites, internal lead alerts and Inbox 1:1s. Gating on "a category
// exists" would have put an unsubscribe footer on all of them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import { isBulkCategory } from '../server/routes/email.js'

const SRC = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
const RAW = SRC.slice(SRC.indexOf('tracking_settings: {'), SRC.indexOf('tracking_settings: {') + 1800)
// Assert against CODE, not the comments explaining it.
const BLOCK = RAW.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

test('marketing sends are treated as bulk', () => {
  for (const c of ['drip_20', 'drip_5', 'drip_test_20', 'auto_7', 'campaign_3', 'bulk_2024'])
    assert.equal(isBulkCategory(c), true, c + ' is marketing and needs an unsubscribe')
})

test('transactional and personal sends are NOT treated as bulk', () => {
  // these are the real categories the codebase sends with
  for (const c of ['password_reset', 'appointment', 'inbox_notify', 'inbox_compose',
    'ai_handoff', 'fb_lead_alert', 'sequence', null, undefined, ''])
    assert.equal(isBulkCategory(c), false, JSON.stringify(c) + ' must never gain an unsubscribe footer')
})

test('a password reset in particular never carries one', () => {
  assert.equal(isBulkCategory('password_reset'), false)
})

test('the send gates on isBulkCategory, not on a category merely existing', () => {
  assert.match(BLOCK, /isBulkCategory\(category\) \? \{ subscription_tracking:/)
  assert.doesNotMatch(BLOCK, /\(category \? \{ subscription_tracking/)
})

test('it supplies html and text rather than a substitution tag', () => {
  // a substitution_tag is only swapped where a template already contains it, and none of
  // the Hub's templates does — precisely how the missing link went unnoticed
  assert.doesNotMatch(BLOCK, /substitution_tag/)
  assert.match(BLOCK, /html:/)
  assert.match(BLOCK, /text:/)
})

test('both versions carry the placeholder SendGrid swaps for the link', () => {
  const placeholders = BLOCK.match(/<%[^%]*%>/g) || []
  assert.ok(placeholders.length >= 2,
    `html and text each need a <% %> or no link is inserted — found ${placeholders.length}`)
})

test('open and click tracking are untouched', () => {
  assert.match(BLOCK, /open_tracking: \{ enable: true \}/)
  assert.match(BLOCK, /click_tracking: \{ enable: true/)
})

test('the wording is plain and does not apologise', () => {
  assert.match(BLOCK, /Unsubscribe/i)
  assert.doesNotMatch(BLOCK, /sorry|apolog/i)
})
