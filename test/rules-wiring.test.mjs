// Proves the rules registry changed NOTHING when it was wired in.
//
// Moving a hardcoded number into a settings-backed lookup is exactly the kind of refactor
// that quietly shifts a send window, and nobody notices until a lead is texted at the wrong
// hour. So this asserts the live behaviour of each wired call site against the constant it
// replaced, with no settings stored — and then that turning a dial actually moves it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubwire_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const { setRule, resetRule } = await import('../server/rules.js')
const FSBO = await import('../server/fsbo-followup.js')
const { enrollmentConfig, inReactivationWindow } = await import('../server/ai-enrollment.js')

// A Central-time instant on a known weekday. 2026-10-15 is a Thursday.
const ct = (h, m = 0) => new Date(Date.UTC(2026, 9, 15, h + 5, m))   // CDT = UTC-5

test('the texting window still runs 9am to 5pm, unchanged', () => {
  assert.equal(FSBO.proactiveStartHour(), 9)
  assert.equal(FSBO.proactiveEndHour(), 17)
  assert.equal(FSBO.inProactiveWindow(ct(8, 59)), false, '8:59am is still outside')
  assert.equal(FSBO.inProactiveWindow(ct(9, 0)), true, '9:00am is still inside')
  assert.equal(FSBO.inProactiveWindow(ct(16, 59)), true, '4:59pm is still inside')
  assert.equal(FSBO.inProactiveWindow(ct(17, 0)), false, '5:00pm is still outside')
})

test('the weekend still rolls to Monday', () => {
  const sat = new Date(Date.UTC(2026, 9, 17, 15))   // Saturday 10am CT
  const slot = FSBO.nextValidSlot(sat)
  assert.ok(slot > sat)
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short' }).format(slot)
  assert.ok(!['Sat', 'Sun'].includes(wd), `landed on ${wd}`)
})

test('FSBO still starts at day 14 on market', () => {
  assert.equal(FSBO.fsboDomThreshold(), 14)
})

test('the AI enrolment config still reports its original numbers', () => {
  const c = enrollmentConfig()
  assert.equal(c.daily_limit, 70)
  assert.equal(c.fresh_window_days, 7)
  assert.equal(c.defer_human_hours, 24)
})

test('the AI reactivation window still matches the texting window', () => {
  assert.equal(inReactivationWindow(ct(9, 0)), true)
  assert.equal(inReactivationWindow(ct(16, 59)), true)
  assert.equal(inReactivationWindow(ct(17, 0)), false)
  assert.equal(inReactivationWindow(ct(8, 0)), false)
})

/* ---------- and the dials actually move things ---------- */

test('narrowing the window takes effect immediately, with no deploy', () => {
  setRule('proactive_end_hour', 15, 'test')
  assert.equal(FSBO.proactiveEndHour(), 15)
  assert.equal(FSBO.inProactiveWindow(ct(16, 0)), false, '4pm is now outside the window')
  resetRule('proactive_end_hour', 'test')
  assert.equal(FSBO.inProactiveWindow(ct(16, 0)), true, 'and back inside when reset')
})

test('widening it past the ceiling does NOT take effect', () => {
  setRule('proactive_end_hour', 23, 'test')
  assert.equal(FSBO.proactiveEndHour(), 19, 'clamped to the 7pm ceiling')
  assert.equal(FSBO.inProactiveWindow(ct(20, 0)), false, '8pm is still refused')
  resetRule('proactive_end_hour', 'test')
})

test('the start hour cannot be pulled into the early morning', () => {
  setRule('proactive_start_hour', 4, 'test')
  assert.equal(FSBO.proactiveStartHour(), 8, 'clamped to the 8am floor')
  assert.equal(FSBO.inProactiveWindow(ct(6, 0)), false, '6am is still refused')
  resetRule('proactive_start_hour', 'test')
})

test('changing the AI daily limit is picked up without a restart', () => {
  setRule('ai_reactivation_daily_limit', 25, 'test')
  assert.equal(enrollmentConfig().daily_limit, 25)
  resetRule('ai_reactivation_daily_limit', 'test')
  assert.equal(enrollmentConfig().daily_limit, 70)
})

test('a blank submission leaves the window exactly where it was', () => {
  const before = FSBO.proactiveEndHour()
  setRule('proactive_end_hour', '', 'test')
  assert.equal(FSBO.proactiveEndHour(), before, 'an empty form field must not move a send window')
})
