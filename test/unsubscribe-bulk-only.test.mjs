// Bulk mail must carry an unsubscribe; a 1:1 email an agent types must not.
//
// Background: the SendGrid account's own Subscription Tracking is off and there are no
// ASM groups, so nothing the Hub sent had an opt-out link. Marketing Campaigns adds one
// automatically; the Email API, which is what the Hub uses, does not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'

const SRC = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
const RAW = SRC.slice(SRC.indexOf('tracking_settings: {'), SRC.indexOf('tracking_settings: {') + 1600)
// Assert against CODE, not the comments explaining it: the note above this block mentions
// substitution_tag by name, and matching that read as the key actually being set.
const BLOCK = RAW.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

test('subscription tracking is attached only when a category is present', () => {
  assert.match(BLOCK, /\.\.\.\(category \? \{ subscription_tracking:/,
    'it must be conditional on category, so 1:1 mail never carries an unsubscribe')
})

test('it supplies html and text rather than a substitution tag', () => {
  // a substitution_tag that no template contains inserts nothing — the exact way the
  // missing link went unnoticed the first time
  assert.doesNotMatch(BLOCK, /substitution_tag/, 'a tag no template carries would insert nothing')
  assert.match(BLOCK, /html:/)
  assert.match(BLOCK, /text:/)
})

test('both versions carry the placeholder SendGrid swaps for the link', () => {
  // the html string is concatenated across lines, so match the block rather than
  // trying to pull the literal back out of the source
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
