// Who gets emailed when a lead texts the Hub.
//
// Matt was added only off-hours (weekday after 6 PM Central, weekends, holidays). John,
// 2026-10-13: "turn on text notifications for Matt, no time specific" — he wants to know who
// replied whenever it happens. These tests pin that the time-of-day gate is gone and cannot
// come back by accident, and that both recipients stay configurable without a deploy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
const fn = src.slice(src.indexOf('async function notifyInboundText'), src.indexOf('async function notifyInboundText') + 1800)

test('the inbound-text alert has no time-of-day gate at all', () => {
  assert.equal(src.includes('isOffHoursCentral'), false, 'the off-hours helper must be gone, not left dead')
  assert.doesNotMatch(fn, /getHours|hr >= 18|weekend/i, 'no hour or weekday test may decide who is alerted')
})

test('the always-copied recipient is applied unconditionally', () => {
  const i = fn.indexOf('inbox_notify_always_cc')
  assert.ok(i > -1, 'there must be an always-copied setting')
  // the loop that adds it must not sit inside an if
  assert.match(fn, /for \(const a of always[\s\S]{0,120}recips\.add\(a\)/,
    'the always-cc list is added with a plain loop, not behind a condition')
})

test('both recipient lists come from settings, so changing them needs no deploy', () => {
  assert.match(fn, /getSetting\('inbox_notify_email'/)
  assert.match(fn, /getSetting\('inbox_notify_always_cc'/)
})

test('Matt is the default always-cc, so the behaviour holds even with no setting row', () => {
  assert.match(fn, /inbox_notify_always_cc',\s*'mattsmithremax@gmail\.com'/)
})

test('recipients are de-duplicated, so nobody is emailed twice', () => {
  assert.match(fn, /new Set\(/, 'a Set collapses an address present in both lists')
})
