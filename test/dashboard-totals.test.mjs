// Lifetime totals. Added because "how many texts have we received" had no answer anywhere:
// the dashboard counted outgoing only, /api/email/stats counted the send log, and the
// inbox list caps at 1000 rows with no count.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../server/routes/dashboard.js', import.meta.url), 'utf8')
const block = src.slice(src.indexOf("router.get('/totals'"), src.indexOf("router.post('/attention/dismiss'"))

test('totals is a GET and reads nothing but counts', () => {
  assert.ok(block.length > 0, 'the route must exist')
  assert.ok(!/INSERT|UPDATE|DELETE|DROP/i.test(block), 'a totals endpoint must never write')
})

test('both directions are counted for every channel', () => {
  for (const ch of ['email', 'text', 'call'])
    for (const dir of ['outgoing', 'incoming'])
      assert.ok(block.includes(`comms('${ch}', '${dir}')`), `${ch} ${dir} is missing`)
})

test('email_log and communications are reported separately', () => {
  // they count different things: what the Hub SENT, versus the conversation record, which
  // also holds email history imported from Gmail
  assert.match(block, /sent_via_hub/)
  assert.match(block, /sent_logged/)
})

test('AI enrolled means managed AND enabled', () => {
  // a lead handed to a human can stay flagged as managed, so managed alone overcounts
  assert.match(block, /ai_managed = 1 AND ai_enabled = 1/)
  assert.match(block, /managed_total/, 'the wider number is reported too, for contrast')
})

test('drip totals count PEOPLE as well as enrolments', () => {
  // one person can sit in more than one campaign, so enrolments overstate reach
  assert.match(block, /COUNT\(DISTINCT client_id\)/)
  assert.match(block, /enrolments_active/)
})

test('a missing table yields null rather than a 500', () => {
  // the endpoint is a diagnostic; one absent table must not take the whole thing down
  assert.match(block, /try \{ return db\.get\(sql, params\)\.c \} catch \{ return null \}/)
})
