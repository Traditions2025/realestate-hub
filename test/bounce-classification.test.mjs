// Hard versus soft bounces.
//
// John asked whether we should retry a few times before giving up, or whether we already
// know which addresses are genuinely dead. We did not: the Hub stored that an email
// bounced but never WHY, so a dead mailbox and a full one looked identical and no retry
// policy was possible. SendGrid sends both on every bounce.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const email = fs.readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')
const dbjs = fs.readFileSync(new URL('../server/database.js', import.meta.url), 'utf8')

test('email_events keeps the reason a message failed', () => {
  for (const col of ['bounce_type', 'reason', 'sg_status'])
    assert.ok(dbjs.includes(`'${col}'`), `email_events needs ${col}`)
})

test('the webhook actually stores them', () => {
  const hook = email.slice(email.indexOf('INSERT INTO email_events'), email.indexOf('INSERT INTO email_events') + 900)
  assert.match(hook, /bounce_type, reason, sg_status/)
  assert.match(hook, /ev\.type/)
  assert.match(hook, /ev\.reason/)
  assert.match(hook, /ev\.status/)
})

test('the reason is truncated, so one odd SMTP response cannot bloat the row', () => {
  assert.match(email, /String\(ev\.reason\)\.slice\(0, 500\)/)
})

test('a permanent failure is recognised by code AND by wording', () => {
  const block = email.slice(email.indexOf("router.get('/suppressions'"), email.indexOf("router.get('/sendgrid-settings'"))
  // 5xx is the SMTP permanent class; the wording check catches servers that answer oddly
  assert.match(block, /\^5\\d\\d/)
  assert.match(block, /does not exist\|no such user\|user unknown/)
})

test('the four suppression lists are kept separate, because they mean different things', () => {
  const block = email.slice(email.indexOf("router.get('/suppressions'"), email.indexOf("router.get('/sendgrid-settings'"))
  for (const list of ['bounces', 'blocks', 'invalid_emails', 'spam_reports'])
    assert.ok(block.includes(list), `${list} must be pulled separately`)
  assert.match(block, /bounces_permanent/)
  assert.match(block, /bounces_temporary/)
})

test('the suppression endpoint only reads', () => {
  const block = email.slice(email.indexOf("router.get('/suppressions'"), email.indexOf("router.get('/sendgrid-settings'"))
  assert.ok(!/method:\s*'(POST|PUT|DELETE|PATCH)'/i.test(block), 'it must never modify SendGrid state')
  assert.ok(!/INSERT|UPDATE|DELETE FROM/i.test(block), 'and must not write to the Hub')
})
