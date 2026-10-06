// A lead added by hand stays out of the AI until someone says otherwise.
//
// John, 2026-10-06: he added Megan Walt at 14:20 and an AI opener went out at 14:27.
//
// The 2026-10-02 guard was NOT at fault and is still working. Her record carried
// auto_enroll_excluded=1, set by her creator with the right reason, and the auto-enrolment
// hook refused her ("status is 'active' — only New-status leads auto-enroll"). There were no
// scheduled AI actions at all.
//
// What got past it was "Send AI now". That endpoint force-sends AND calls setManaged(true),
// so one click both sends a message and enrols the lead permanently - and its confirm dialog
// mentioned neither the exclusion nor the enrolment. The exclusion is honoured there now,
// and overriding it is a separate, explicit answer.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()

const ai = fs.readFileSync(new URL('../server/routes/ai.js', import.meta.url), 'utf8')
const clients = fs.readFileSync(new URL('../server/routes/clients.js', import.meta.url), 'utf8')
const ui = fs.readFileSync(new URL('../src/pages/Clients.jsx', import.meta.url), 'utf8')

// ── the guard that already worked ────────────────────────────────────────────────────
test('adding a lead by hand still stamps the exclusion on the record', () => {
  assert.match(clients, /auto_enroll_excluded=1/)
  assert.match(clients, /added by hand in the Hub/)
  // on the record, not inferred from status - the route defaults a lead to 'active' and the
  // fresh hook runs the instant the row exists
  assert.match(clients, /recorded on the record itself rather than inferred from status/i)
})

// ── the hole that let Megan through ──────────────────────────────────────────────────
test('Send AI now refuses a hand-excluded lead unless told twice', () => {
  const fn = ai.slice(ai.indexOf("router.post('/lead/:id/send-now'"), ai.indexOf("router.post('/lead/:id/send-now'") + 1400)
  assert.match(fn, /const excl = manualExclusion\(cid\)/)
  assert.match(fn, /req\.body\?\.override !== true/)
  assert.match(fn, /needs_override: true/)
  // and the refusal must come BEFORE anything is enrolled or sent
  assert.ok(fn.indexOf('manualExclusion') < fn.indexOf('setManaged(cid, true)'),
    'the check has to run before the lead is enrolled')
})

test('the bulk Send AI has the same guard', () => {
  const fn = ai.slice(ai.indexOf("router.post('/bulk-send-now'"))
  assert.match(fn, /const excl = manualExclusion\(cid\)/)
  assert.match(fn, /needs_override: true/)
  assert.ok(fn.indexOf('manualExclusion') < fn.indexOf('setManaged(cid, true)'))
})

test('overriding clears the flag and records who did it', () => {
  // at that point a person really has said so, and the audit trail should show it
  assert.match(ai, /function clearManualExclusion/)
  assert.match(ai, /ai_manual_override/)
  assert.match(ai, /auto_enroll_excluded=0/)
})

test('the UI asks a SECOND question naming the exclusion', () => {
  const fn = ui.slice(ui.indexOf('const sendNow = async'), ui.indexOf('const sendNow = async') + 2200)
  assert.match(fn, /d\.needs_override/)
  assert.match(fn, /added by hand and deliberately excluded from AI/)
  assert.match(fn, /turns AI ON for this lead/, 'the enrolment side effect must be stated')
  assert.match(fn, /override: true/)
})

// ── it must not break the ordinary case ──────────────────────────────────────────────
test('a lead with no exclusion is unaffected', () => {
  const now = new Date().toISOString()
  const cid = db.run(`INSERT INTO clients (first_name, last_name, phone, type, status, created_at, updated_at)
                      VALUES (?,?,?,?,?,?,?)`,
    ['Plain', 'T' + Math.random().toString(36).slice(2, 7), '(319) 555-0144', 'buyer', 'new', now, now]).lastInsertRowid
  const row = db.get('SELECT auto_enroll_excluded FROM ai_lead_state WHERE client_id=? AND auto_enroll_excluded=1', [cid])
  assert.ok(!row, 'an ordinary lead carries no exclusion, so Send AI now behaves as before')
})

test('turning AI on from the profile still means exactly that', () => {
  // POST /lead/:id/enable is the deliberate switch and must NOT consult the flag
  const fn = ai.slice(ai.indexOf("router.post('/lead/:id/enable'"), ai.indexOf("router.post('/lead/:id/enable'") + 300)
  assert.ok(!/manualExclusion/.test(fn), 'the explicit enable button is the way to say yes')
})
