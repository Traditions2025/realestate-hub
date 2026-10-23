// A COLD OPENER MUST NOT FOLLOW A REAL CONVERSATION (John, 2026-10-23).
//
// David Stickley came in off the 1625 Ranmar Dr ad at 2:08:23 PM. John called him at
// 2:08:52. The AI texted "Is there anything you'd like to know about the home?" at 2:13:55,
// five minutes after a call it knew nothing about.
//
// Every guard in the AI watched for an INBOUND reply, which is the wrong direction: a call
// John places leaves an OUTGOING row, and nothing was reading it. These tests pin the rule
// in the direction that actually failed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const { humanAlreadyReachedOut } = await import('../server/ai-followup/orchestrator.js')
const { default: leads } = await import('../server/fub-leads.js').then(m => ({ default: m })).catch(() => ({ default: null }))

const iso = (ms) => new Date(Date.now() + ms).toISOString()
let seq = 0
function mkLead(createdAt) {
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, status, phone, created_at, updated_at)
    VALUES ('Fbo','Lead${Date.now()}${++seq}','buyer','new','(319) 555-0${String(seq).padStart(3, '0')}',?,?)`,
    [createdAt, createdAt])
  return r.lastInsertRowid
}
function comm(cid, { direction, channel, sentBy, at }) {
  db.run(`INSERT INTO communications (channel, direction, client_id, body, preview, thread_key, status, sent_by_type, occurred_at)
          VALUES (?,?,?,?,?,?,'read',?,?)`,
    [channel, direction, cid, 'x', 'x', `c${cid}_${channel}`, sentBy || null, at])
}

test('a call placed after the lead arrives counts as human contact', () => {
  // The exact David Stickley shape: lead created, call 29 seconds later.
  const created = iso(-10 * 60000)
  const cid = mkLead(created)
  comm(cid, { direction: 'outgoing', channel: 'call', at: iso(-9 * 60000) })
  const hit = humanAlreadyReachedOut(cid, created)
  assert.ok(hit, 'the call must be seen')
  assert.equal(hit.channel, 'call')
})

test('a text an agent sent by hand counts too', () => {
  const created = iso(-10 * 60000)
  const cid = mkLead(created)
  comm(cid, { direction: 'outgoing', channel: 'text', sentBy: 'human', at: iso(-8 * 60000) })
  assert.ok(humanAlreadyReachedOut(cid, created))
})

test('the AI\'s own text does NOT count, or it would silence itself', () => {
  const created = iso(-10 * 60000)
  const cid = mkLead(created)
  comm(cid, { direction: 'outgoing', channel: 'text', sentBy: 'ai', at: iso(-8 * 60000) })
  assert.equal(humanAlreadyReachedOut(cid, created), null)
})

test('an INBOUND message is not "we reached out"', () => {
  // Inbound is already handled elsewhere, and treating it as human outreach here would
  // skip the opener for a lead nobody has actually spoken to.
  const created = iso(-10 * 60000)
  const cid = mkLead(created)
  comm(cid, { direction: 'incoming', channel: 'text', at: iso(-8 * 60000) })
  assert.equal(humanAlreadyReachedOut(cid, created), null)
})

test('contact from BEFORE the lead arrived does not block the opener', () => {
  // An old call to the same person months ago is not this conversation.
  const created = iso(-10 * 60000)
  const cid = mkLead(created)
  comm(cid, { direction: 'outgoing', channel: 'call', at: iso(-90 * 86400000) })
  assert.equal(humanAlreadyReachedOut(cid, created), null)
})

test('a lead nobody has touched still gets the opener', () => {
  const created = iso(-10 * 60000)
  const cid = mkLead(created)
  assert.equal(humanAlreadyReachedOut(cid, created), null)
})

/* ---------- the listing label that reached a customer ---------- */

// These call the REAL function rather than re-declaring the regex or grepping the source.
// The first version of this test did both and passed while the shipped cleaner was dead:
// a heredoc had turned its word boundary into a literal backspace byte, so it matched
// nothing and five leads were told "1625 Ranmar Dr Ely Form on Facebook" anyway. A test
// that does not execute the code under test proves nothing.
const { cleanListingLabel } = await import('../server/lead-intake.js')

test('the word "Form" is trimmed, because the FB form is named after the house', () => {
  assert.equal(cleanListingLabel('1625 Ranmar Dr Ely Form'), '1625 Ranmar Dr Ely')
  assert.equal(cleanListingLabel('1625 Ranmar Dr Ely - Lead Form'), '1625 Ranmar Dr Ely')
  assert.equal(cleanListingLabel('230 Bever Lane Instant Form'), '230 Bever Lane')
})

test('a street that genuinely contains the word is left alone', () => {
  // Trimming anywhere but the END would turn "12 Form Street" into "12 Street".
  assert.equal(cleanListingLabel('12 Form Street'), '12 Form Street')
  assert.equal(cleanListingLabel('510 Broadway St Springville, IA 52336'), '510 Broadway St Springville, IA 52336')
  assert.equal(cleanListingLabel('1625 Ranmar Dr Ely'), '1625 Ranmar Dr Ely')
})

test('the cleaner contains no control characters', () => {
  // The exact failure that shipped: \b became 0x08. Source-level, because a backspace in a
  // regex is invisible in every normal readout and silently matches nothing.
  const src = fs.readFileSync(new URL('../server/lead-intake.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('\u0008'), 'a literal backspace byte is in the source')
  assert.match(src, /listing = cleanListingLabel\(listing\)/, 'and it must be applied inside ingestFbLead, where every caller passes through')
})
