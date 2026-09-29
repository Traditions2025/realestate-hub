// Three defects found by reading a real delivered email rather than the code, after John
// asked whether the home value email carries an unsubscribe.
//
// 1. The home value auto-response went to a real lead with NO opt-out. Its category,
//    `home_value_followup`, did not match the `<prefix>_<id>` bulk pattern.
// 2. The composer accepted a `category` in the request body and never passed it on, so a
//    send explicitly marked as marketing silently got no footer either.
// 3. The composer appended Matt's signature to a template that already ended in one. The
//    delivered email carried two "Matt Smith" blocks and two phone numbers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isBulkCategory, alreadySigned } from '../server/routes/email.js'

// ── 1. which sends get an unsubscribe ────────────────────────────────────────────────
test('marketing sends get an unsubscribe', () => {
  for (const c of ['drip_20', 'drip_test_20', 'auto_5', 'campaign_1', 'bulk_x',
    'home_value_followup', 'HOME_VALUE_FOLLOWUP'])
    assert.equal(isBulkCategory(c), true, c + ' is marketing and needs an opt-out')
})

test('transactional and 1:1 sends never gain an opt-out footer', () => {
  // an unsubscribe link on a password reset is absurd, and on a 1:1 reply it is wrong
  for (const c of ['password_reset', 'appointment', 'inbox_notify', 'inbox_compose',
    'ai_handoff', 'fb_lead_alert', 'tc-digest-afternoon', 'sequence', null, undefined, ''])
    assert.equal(isBulkCategory(c), false, String(c) + ' must not get an opt-out')
})

test('the intake still sends under the category the gate now recognises', () => {
  // if this constant is ever renamed, the unsubscribe silently disappears again
  const src = fs.readFileSync(new URL('../server/home-value-intake.js', import.meta.url), 'utf8')
  assert.match(src, /sendSequenceEmail\(client,\s*\{\s*template_id:\s*tpl\.id\s*\},\s*'home_value_followup'\)/)
  assert.equal(isBulkCategory('home_value_followup'), true)
})

// ── 2. the composer must pass the category through ───────────────────────────────────
test('the composer forwards a category to SendGrid', () => {
  const src = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
  const route = src.slice(src.indexOf("router.post('/send'"), src.indexOf("router.post('/send'") + 3000)
  assert.match(route, /const \{[^}]*\bcategory\b[^}]*\} = req\.body/, 'category must be read from the body')
  // non-greedy, because the argument itself contains parentheses: Array.isArray(bcc)
  assert.match(route, /withPersonalBcc\([\s\S]*?\),\s+category \|\| null/,
    'category must be the 9th argument to sendViaSendGrid')
})

// ── 3. never sign a body that is already signed ──────────────────────────────────────
const TEMPLATE_382_TAIL = `
  <p style="margin:0 0 3px;font-size:14px;font-weight:700;">Matt Smith</p>
  <p style="margin:0 0 6px;font-size:13px;">Matt Smith Team | RE/MAX Concepts</p>
  <p><a href="tel:+13194315859">319-431-5859</a><br />
     <a href="mailto:mattsmithremax@gmail.com">mattsmithremax@gmail.com</a><br />
     <a href="https://www.mattsmithteam.com">MattSmithTeam.com</a></p>`

test('a template that already ends in a signature is not signed twice', () => {
  assert.equal(alreadySigned(TEMPLATE_382_TAIL), true)
  assert.equal(alreadySigned('<p>Hi</p>' + TEMPLATE_382_TAIL), true)
})

test('the {{signature}} token still counts as signed', () => {
  assert.equal(alreadySigned('<p>Hi there</p>{{signature}}'), true)
  assert.equal(alreadySigned('<p>Hi there</p>{{ signature }}'), true)
})

test('an ordinary typed email is still signed for the agent', () => {
  for (const b of ['<p>Hi Laura, are you free Thursday?</p>', 'Quick question about the inspection.',
    '<p>Sending over the disclosures now.</p>', ''])
    assert.equal(alreadySigned(b), false, JSON.stringify(b.slice(0, 30)) + ' should still get a signature')
})

test('one stray mention of the office number is not a signature', () => {
  // the reason the check needs TWO marks, not one
  assert.equal(alreadySigned('<p>Call me on 319-431-5859 when you get a chance.</p>'), false)
  assert.equal(alreadySigned('<p>Our site is MattSmithTeam.com if you want to browse.</p>'), false)
})

test('two marks together are a signature', () => {
  assert.equal(alreadySigned('<p>Matt Smith<br>319-431-5859<br>mattsmithremax@gmail.com</p>'), true)
})
