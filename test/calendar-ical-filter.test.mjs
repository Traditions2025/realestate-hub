// Which of Matt's Google events belong on the TEAM calendar (John, 2026-10-20).
//
// The first iCal import pulled 74 events off his primary calendar. 48 of them were things
// no one else should be reading: a podiatrist appointment, a deep tissue massage, two
// haircuts, a personal legal deadline with a case number, and a run of marketing webinars.
//
// Every title below is REAL - taken verbatim from what the live feed actually imported -
// so this suite is the record of what we decided each one is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubicalf_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const { isTeamCalendarEvent } = await import('../server/scheduler.js')

// Real appointments: these must reach the team calendar.
const KEEP = [
  'Showing Confirmed',
  'Inspection Confirmed',
  'Review inspection',
  'Gabe and Jacob Final Walkthrough',
  'Reminder: Gabe and Jacob Final Walkthrough Tomorrow at 8:30AM',
  'Rose Blank Walkthrough 2508 Shawn Crt. NW',
  'Closing — 2609 1st Ave SW, Cedar Rapids, IA 52404',
  "Deer view closing at O'Shea office",
  'Closing meet at the house 2800 3rd Ave: Exchange checks and give Original Deed docs to Jacque',
  'I will Send Amy the closing docs that I sent to Cheryl the first go round before Phil’s initialed along with closing papers',
  'Katherine Thompson 4504 Regal Ave evaluate home',
  'Coyle Purchase of 2609 1st AVE SW',
  'Maria and Todd  Evan’s wants to talk at 230 about downsizing they are calling me',
  'Appointment with Matt Smith',
]

// Everything else. Grouped by WHY, because the reasons are not the same.
const DROP_PERSONAL = [
  'Mike O podiatrist 3200 F Ave NW',
  '90 Minute Deep Tissue Massage at Massage by Rock',
  "Men's Haircut with Shelly Wehr",
  'Shelly haircut',
  'Pick up books for Amy on Deerview',
  'Tv and battery charger.  Gas from fleet farm',
]
const DROP_LEGAL = [
  'BACKUP: Citibank answer filed? Deadline TONIGHT',
  'FILE Citibank answer in EDMS (SCSC287671)',
  'Citibank SCSC287671: upload packet backs + file answer',
]
const DROP_WEBINAR = [
  'Mastering Expired Marketing: 5 Lessons To Go from Newbie To Pro',
  'Built to be Found: Use AI better, build your brand, and show up across Google, AI search, and social',
  'How to Grow on Instagram in a Sea of AI Slop',
  'How to make money with AI ',
  'Grok Bot Galaxy: Livestream',
  'Grok Bot for Post-Sales - Livestream',
  '💻 Webinar: The Zillow Hack',
  'PRO Essentials',
]
const DROP_PRODUCTION = [
  'SHOOT DAY: Why We Stay pilot (morning block)',
  'SHOOT DAY: golden hour close',
  'Hold: shoot day weather backup',
  "Show check-in (15 to 30 min): what's booked, what's next",
  'Show kickoff with Leo: Why We Stay pilot',
  'Show: pick the street + approve the 3 households',
  'Show: watch + approve the pilot cut',
]
const DROP_VAGUE = [
  '2:30 check-in',
  '4th Quarter Blitz',
  'Alarm notification',
  'Do videos on incentives',
  'Friend past clients LinkedIn',
  'Need to send my EO into the commission',
  'Pay sign it sign email',
  'Cherryl garage Wilson condo Wanda',
  'Cheryl Wilson Ave garage',
]

for (const t of KEEP) {
  test(`KEEP: ${t.slice(0, 58)}`, () => {
    assert.equal(isTeamCalendarEvent(t), true, 'a real appointment was filtered out')
  })
}

test('every personal appointment is kept off the team calendar', () => {
  for (const t of DROP_PERSONAL) assert.equal(isTeamCalendarEvent(t), false, `leaked: ${t}`)
})

test('the personal legal matter never reaches the team calendar', () => {
  // Three events carrying a case number. This is the one that matters most.
  for (const t of DROP_LEGAL) assert.equal(isTeamCalendarEvent(t), false, `leaked: ${t}`)
})

test('marketing webinars are not appointments', () => {
  for (const t of DROP_WEBINAR) assert.equal(isTeamCalendarEvent(t), false, `leaked: ${t}`)
})

test('video production blocks are not client appointments', () => {
  // Judgement call: these are real team work, but they are not transactions. If the team
  // wants shoot days visible, add 'shoot day' to the allow-list rather than loosening it.
  for (const t of DROP_PRODUCTION) assert.equal(isTeamCalendarEvent(t), false, `leaked: ${t}`)
})

test('vague personal notes and errands stay out', () => {
  for (const t of DROP_VAGUE) assert.equal(isTeamCalendarEvent(t), false, `leaked: ${t}`)
})

/* ---------- the shape of the rule ---------- */

test('the filter fails CLOSED on anything it does not recognise', () => {
  for (const t of ['', null, undefined, '   ', 'xyzzy', 'Lunch', 'Dentist']) {
    assert.equal(isTeamCalendarEvent(t), false)
  }
})

test('"show up" in marketing copy is not a "showing"', () => {
  // The webinar title contains "show up across Google". A sloppier pattern catches it.
  assert.equal(isTeamCalendarEvent('build your brand, and show up across Google'), false)
})

test('"golden hour close" is not a "closing"', () => {
  // Matching on "close" rather than "closing" would pull the whole video shoot through.
  assert.equal(isTeamCalendarEvent('SHOOT DAY: golden hour close'), false)
  assert.equal(isTeamCalendarEvent('Closing — 2609 1st Ave SW'), true)
})

test('it is case-insensitive, since Matt types titles freehand', () => {
  assert.equal(isTeamCalendarEvent('showing confirmed'), true)
  assert.equal(isTeamCalendarEvent('SHOWING CONFIRMED'), true)
  assert.equal(isTeamCalendarEvent('Final WalkThrough'), true)
})

test('the live feed splits exactly 14 keep / 33 drop', () => {
  const all = [...KEEP, ...DROP_PERSONAL, ...DROP_LEGAL, ...DROP_WEBINAR, ...DROP_PRODUCTION, ...DROP_VAGUE]
  assert.equal(all.length, 47, 'these are all 47 distinct titles the live feed produced')
  assert.equal(all.filter(isTeamCalendarEvent).length, 14)
})
