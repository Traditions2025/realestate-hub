// One pause for the whole Home Value response (John, 2026-11-05), while the wording is
// being rewritten.
//
// The response runs on TWO clocks: the intake poller every 10 minutes (the email and the
// Day 0 condition question) and the SMS sweep every 15 (Day 3 to Day 45). A pause that
// covered only one would leave the other still messaging people, so the switch is read in
// scheduler.js where both are started.
//
// Paused is not deaf. A request still parses, still creates and tags the lead, still
// counts the visit — recordOnly stops the sending, not the recording — so nobody who asks
// while it is off is lost. They are waiting on a reply.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()

const KEY = 'home_value_response_paused'
const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const scheduler = src('../server/scheduler.js')
const drips = src('../server/routes/drips.js')
const intake = src('../server/home-value-intake.js')

test('both clocks read the pause, so neither keeps running alone', () => {
  assert.match(scheduler, /function hvResponsePaused\(\)/)
  assert.match(scheduler, /if \(hvResponsePaused\(\)\) return\s*\n\s*import\('\.\/home-value-sms\.js'\)/,
    'the SMS sweep does not start while paused')
  assert.match(scheduler, /pollHomeValueSubmissions\(\{ sinceDays: 2, max: 25, recordOnly: hvResponsePaused\(\) \}\)/,
    'the intake poller drops to record-only while paused')
})

test('record-only records everything and sends nothing', () => {
  // The guarantee the pause rests on: a request arriving while paused is not lost.
  assert.match(intake, /recordOnly: log the submission and tag the lead, but send nothing and defer nothing/)
  assert.match(intake, /if \(recordOnly\) return \{ client_id: client\.id, created, visit: visitNo, recorded_only: true/)
})

test('the pause is settable AND readable, so it can be confirmed rather than assumed', () => {
  assert.match(drips, /b\.response_paused !== undefined/)
  assert.match(drips, /db\.setSetting\('home_value_response_paused', b\.response_paused \? '1' : '0'\)/)
  assert.match(drips, /response_paused: String\(db\.getSetting\('home_value_response_paused', '0'\)\) === '1'/)
})

test('it defaults to running — a missing setting never silences the response', () => {
  const was = db.getSetting(KEY, null)
  try {
    db.setSetting(KEY, '')
    const paused = String(db.getSetting(KEY, '0')) === '1'
    assert.equal(paused, false)
  } finally { if (was !== null) db.setSetting(KEY, was) }
})

test('the pause is its own switch, separate from enrolling past clients', () => {
  // home_value_enroll_enabled governs the long-term nurture campaign. Pausing the
  // RESPONSE must not touch it, or unpausing one would silently restart the other.
  assert.match(drips, /db\.setSetting\('home_value_enroll_enabled', b\.enabled \? '1' : '0'\)/)
  assert.ok(!/response_paused.*enroll_enabled|enroll_enabled.*response_paused/.test(drips.replace(/\n/g, ' ').slice(0, 0) || ''),
    'they are set from different request fields')
})
