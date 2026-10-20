// Google Calendar iCal import: times must land in CENTRAL, always (John, 2026-10-20).
//
// The first version of the import read DTSTART:20261022T140000Z, ignored the trailing Z,
// and stored "14:00". Matt's calendar said 9:00am. Every one of the 74 imported events was
// 5 hours late and one had already slid onto the wrong date. These tests pin the three
// input shapes and, most importantly, that the offset is NOT hardcoded.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubical_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const { parseICalDate } = await import('../server/scheduler.js')

const at = (raw) => {
  const r = parseICalDate(raw)
  return r.date + ' ' + (r.time || '--')
}

/* ---------- UTC input converts to Central ---------- */

test('a UTC morning event lands at the hour Matt sees', () => {
  // SHOOT DAY: Why We Stay pilot - Google shows 9:00am Central
  assert.equal(at('20261022T140000Z'), '2026-10-22 09:00')
})

test('a UTC afternoon event lands at the hour Matt sees', () => {
  // Review inspection - Google shows 10:00am Central
  assert.equal(at('20261018T150000Z'), '2026-10-18 10:00')
})

test('an evening event rolls BACK to the correct day, not forward', () => {
  // A 7:25pm Central showing arrives as 00:25Z the NEXT day. Stored raw it appeared on
  // Sept 23; it belongs on Sept 22. This is the bug that put a showing on the wrong date.
  assert.equal(at('20260923T002500Z'), '2026-09-22 19:25')
})

/* ---------- the offset must not be hardcoded ---------- */

test('December converts at -6, not -5', () => {
  // Central is CST in December. A fixed -5 would read 09:00 here and be an hour wrong
  // for half the year.
  assert.equal(at('20261201T140000Z'), '2026-12-01 08:00')
})

test('summer and winter differ by exactly one hour for the same UTC clock time', () => {
  const summer = parseICalDate('20260715T140000Z').time
  const winter = parseICalDate('20261215T140000Z').time
  assert.equal(summer, '09:00')
  assert.equal(winter, '08:00')
  assert.notEqual(summer, winter, 'a fixed offset would make these identical')
})

/* ---------- the other two input shapes are left alone ---------- */

test('an all-day event keeps its date and gets no time', () => {
  const r = parseICalDate('20261022')
  assert.equal(r.date, '2026-10-22')
  assert.equal(r.time, null)
})

test('a floating or TZID local time is already Central and is not shifted', () => {
  // No trailing Z means the time is in the calendar's own zone. Converting it again
  // would move it a second time.
  assert.equal(at('20261022T090000'), '2026-10-22 09:00')
})

/* ---------- edges ---------- */

test('midnight Central reads 00:00, never 24:00', () => {
  const r = parseICalDate('20261022T050000Z')   // 00:00 CDT
  assert.equal(r.time, '00:00')
  assert.equal(r.date, '2026-10-22')
})

test('junk and empty input return null rather than throwing', () => {
  assert.equal(parseICalDate(''), null)
  assert.equal(parseICalDate(null), null)
  assert.equal(parseICalDate('not-a-date'), null)
})

test('a real Google UID-style value with a time still parses', () => {
  assert.equal(at('20270101T060000Z'), '2027-01-01 00:00')
})
