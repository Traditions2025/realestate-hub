// The lead conversation auto-summary (John, 2026-10-16).
//
// The model call itself is not exercised here: what matters is everything AROUND it, and
// the first test is the one that matters most, because a feature that reads conversations
// has no business being anywhere near the code that sends them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync, readFileSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubsum_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const S = await import('../server/lead-summary.js')
S.initLeadSummary()

let seq = 0
function mkClient(f = {}) {
  const id = 940000 + (++seq)
  db.run('INSERT OR REPLACE INTO clients (id, first_name, last_name, status, type, address) VALUES (?,?,?,?,?,?)',
    [id, f.first_name || 'Sum', 'Test' + seq, f.status || 'new', f.type || 'buyer', f.address || null])
  return id
}
const msg = (cid, dir, text, { channel = 'text', at = Date.now(), by = null, subject = null } = {}) =>
  db.run(`INSERT INTO communications (channel, direction, client_id, preview, body, subject, sent_by_type, thread_key, status, occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [channel, dir, cid, String(text).slice(0, 160), text, subject, by, `c${cid}_${channel}`, 'read', new Date(at).toISOString()])

/* ---------- the rule that matters most ---------- */

test('the summary module cannot send anything', () => {
  const src = readFileSync(new URL('../server/lead-summary.js', import.meta.url), 'utf8')
  for (const forbidden of [
    'sendSms', 'sendViaSendGrid', 'sendSequenceEmail', 'twilio', 'scheduleAiAction',
    'enrollInDrip', 'canSendSms', 'fsbo-followup', 'orchestrator',
  ]) {
    assert.ok(!src.includes(forbidden), `lead-summary.js references ${forbidden} - summarising is a read`)
  }
})

test('it never writes to the hand-written notes field', () => {
  const src = readFileSync(new URL('../server/lead-summary.js', import.meta.url), 'utf8')
  assert.ok(!/UPDATE\s+clients\s+SET[^;]*\bnotes\b/i.test(src), 'must never stamp the notes field')
  assert.ok(!/INSERT\s+INTO\s+client_notes/i.test(src))
})

/* ---------- reading the conversation ---------- */

test('the transcript comes back oldest first, with both sides marked', () => {
  const cid = mkClient()
  msg(cid, 'outgoing', 'Opening text', { at: Date.now() - 3000, by: 'ai' })
  msg(cid, 'incoming', 'Yes. Who is this?', { at: Date.now() - 2000 })
  msg(cid, 'outgoing', 'This is John', { at: Date.now() - 1000, by: 'human' })
  const c = S.conversationFor(cid)
  assert.equal(c.length, 3)
  assert.deepEqual(c.map(m => m.text), ['Opening text', 'Yes. Who is this?', 'This is John'])
  // The actual sender is named rather than flattened to "automated", so the model can tell
  // an AI opener from a campaign send from a person typing.
  assert.equal(c[0].who, 'US (ai)')
  assert.equal(c[1].who, 'LEAD')
  assert.equal(c[2].who, 'US (person)')
})

test('a send with no sender recorded still reads as automated, not as a person', () => {
  const cid = mkClient()
  msg(cid, 'outgoing', 'campaign text', { by: null })
  assert.equal(S.conversationFor(cid)[0].who, 'US (automated)',
    'an unattributed send must never be presented as a person writing')
})

test('an HTML email is reduced to its subject rather than its markup', () => {
  const cid = mkClient()
  msg(cid, 'outgoing', '<!DOCTYPE html><html><body><table><tr><td>' + 'x'.repeat(4000) + '</td></tr></table></body></html>',
      { channel: 'email', subject: 'These homes are going under contract' })
  const c = S.conversationFor(cid)
  assert.equal(c.length, 1)
  assert.equal(c[0].text, '[email] These homes are going under contract')
  assert.ok(c[0].text.length < 80, 'the markup must not reach the model')
})

test('a plain text email keeps its body', () => {
  const cid = mkClient()
  msg(cid, 'incoming', 'Sounds good, call me Tuesday', { channel: 'email', subject: 'Re: your home' })
  assert.equal(S.conversationFor(cid)[0].text, 'Sounds good, call me Tuesday')
})

test('empty messages are dropped', () => {
  const cid = mkClient()
  msg(cid, 'outgoing', '   ')
  msg(cid, 'incoming', 'real message')
  const c = S.conversationFor(cid)
  assert.equal(c.length, 1)
  assert.equal(c[0].text, 'real message')
})

/* ---------- staleness: when a rebuild is actually needed ---------- */

test('with no conversation there is nothing to summarise', async () => {
  const cid = mkClient()
  const r = await S.generateLeadSummary(cid)
  assert.equal(r.ok, false)
  assert.match(r.reason, /no conversation/)
})

test('a summary is stale the moment a new message lands', () => {
  const cid = mkClient()
  msg(cid, 'incoming', 'first')
  assert.equal(S.summaryState(cid).stale, true, 'nothing stored yet')
  // stand in for a generated row
  db.run(`INSERT INTO lead_summaries (client_id, summary, message_count, last_message_at, generated_at)
          VALUES (?,?,?,?,?)`,
    [cid, 'A summary.', S.summaryState(cid).count, S.summaryState(cid).last, new Date().toISOString()])
  assert.equal(S.summaryState(cid).stale, false, 'matches the thread it was built from')
  msg(cid, 'incoming', 'second', { at: Date.now() + 1000 })
  assert.equal(S.summaryState(cid).stale, true, 'a new message makes it stale')
})

test('getLeadSummary always says the text was generated, and whether it is stale', () => {
  const cid = mkClient()
  msg(cid, 'incoming', 'hello')
  const st = S.summaryState(cid)
  db.run(`INSERT INTO lead_summaries (client_id, summary, headline, facts, message_count, last_message_at, generated_at)
          VALUES (?,?,?,?,?,?,?)`,
    [cid, 'They want to sell in spring.', 'Selling in spring', '{"role":"seller"}', st.count, st.last, new Date().toISOString()])
  const g = S.getLeadSummary(cid)
  assert.equal(g.ok, true)
  assert.equal(g.generated, true, 'the UI must be able to label this as machine written')
  assert.equal(g.stale, false)
  assert.equal(g.facts.role, 'seller')
  msg(cid, 'incoming', 'actually, make that summer', { at: Date.now() + 2000 })
  assert.equal(S.getLeadSummary(cid).stale, true, 'and know when it is out of date')
})

test('a lead with no summary reports why, rather than returning nothing', () => {
  const cid = mkClient()
  const g = S.getLeadSummary(cid)
  assert.equal(g.ok, false)
  assert.match(g.reason, /not generated yet/)
})

test('a failed model call is recorded and reported, not silently swallowed', () => {
  const cid = mkClient()
  db.run(`INSERT INTO lead_summaries (client_id, error, generated_at) VALUES (?,?,?)`,
    [cid, 'model error: overloaded', new Date().toISOString()])
  const g = S.getLeadSummary(cid)
  assert.equal(g.ok, false)
  assert.match(g.reason, /last attempt failed/)
})

test('a merged lead is refused', async () => {
  const cid = mkClient()
  msg(cid, 'incoming', 'hi')
  db.run('UPDATE clients SET merged_into=1 WHERE id=?', [cid])
  const r = await S.generateLeadSummary(cid)
  assert.equal(r.ok, false)
  assert.match(r.reason, /no such client/)
})

test('the transcript is capped so one huge thread cannot run away', () => {
  const cid = mkClient()
  for (let i = 0; i < 200; i++) msg(cid, i % 2 ? 'incoming' : 'outgoing', 'message ' + i, { at: Date.now() + i * 1000 })
  const c = S.conversationFor(cid)
  assert.ok(c.length <= 120, `got ${c.length}`)
  assert.equal(c[c.length - 1].text, 'message 199', 'and keeps the most recent, not the oldest')
})

test('a single very long message is truncated', () => {
  const cid = mkClient()
  msg(cid, 'incoming', 'y'.repeat(5000))
  assert.ok(S.conversationFor(cid)[0].text.length <= 700)
})
