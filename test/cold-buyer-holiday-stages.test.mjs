// A drip stage must never be destroyed by a condition that clears on its own.
//
// Norma Walker, 2026-10-15: "we did not introduce ourselves and no link."
//
// Her schedule said exactly why:
//
//   AI_COLD_BUYER  stage=0 (Day 1)  CANCELED
//     due    2026-10-12 15:11
//     error  US holiday - automated sends paused
//
// 2026-10-12 was Columbus Day. Day 1 is the only message that introduces us and the only
// one carrying the site link, so cancelling it meant the first text she ever received was
// the Day 4 continuation, three days later, from a number she could not place. She replied
// "Yes. Who is this?".
//
// Two faults, both fixed here:
//   1. businessSlot rolled weekends but not holidays, so the stage was scheduled onto one.
//   2. The drain treated "not today" as "never" - a blocked stage was canceled, and a
//      quiet-hours block was marked COMPLETED, which is worse: consumed, never sent, and
//      successful-looking in every report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { enrollColdBuyerSequence, isTransientBlock } = await import('../server/ai-followup/scheduler.js')
const { isUsHoliday } = await import('../server/holidays.js')

const mkLead = () => {
  const now = new Date().toISOString()
  return db.run(`INSERT INTO clients (first_name, last_name, phone, type, status, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?)`,
    ['Holiday', 'T' + Math.random().toString(36).slice(2, 7),
     '(319) 555-' + String(Math.floor(Math.random() * 10000)).padStart(4, '0'),
     'buyer', 'new', now, now]).lastInsertRowid
}
const weekday = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', weekday: 'short' })

// ── what put Norma where she was ─────────────────────────────────────────────────────
// Columbus Day was on the holiday list when her Day 1 was cancelled and was taken off it
// LATER THE SAME DAY (John: "Columbus Day is not widely observed"). So the date now reads
// as an ordinary Monday, and asserting otherwise would be asserting a bug we already fixed.
// What has to stay true is the behaviour for the holidays that ARE observed.
test('the holidays we do observe are known', () => {
  assert.equal(isUsHoliday(new Date('2026-11-26T18:00:00Z')), true, 'Thanksgiving 2026')
  assert.equal(isUsHoliday(new Date('2026-12-25T18:00:00Z')), true, 'Christmas 2026')
  assert.equal(isUsHoliday(new Date('2026-07-03T18:00:00Z')), true, 'Independence Day observed (4th is a Saturday)')
  assert.equal(isUsHoliday(new Date('2026-10-12T20:11:00Z')), false, 'Columbus Day, deliberately dropped')
})

test('no stage is ever scheduled onto a US holiday', () => {
  // anchor the sequence so stages land across a year, holidays included
  for (const anchor of ['2026-10-12T15:10:00Z', '2026-11-25T15:00:00Z', '2026-12-24T15:00:00Z',
    '2026-06-30T15:00:00Z', '2027-01-01T15:00:00Z']) {
    const cid = mkLead()
    const rows = enrollColdBuyerSequence(cid, { anchorIso: anchor })
    assert.equal(rows.length, 10)
    for (const r of rows) {
      assert.equal(isUsHoliday(new Date(r.execute_at)), false,
        `stage ${r.stage} from anchor ${anchor} landed on a holiday: ${r.execute_at}`)
    }
  }
})

test('and never onto a weekend either — the holiday bump must not undo that', () => {
  for (const anchor of ['2026-10-12T15:10:00Z', '2026-11-25T15:00:00Z', '2026-12-24T15:00:00Z']) {
    const cid = mkLead()
    for (const r of enrollColdBuyerSequence(cid, { anchorIso: anchor })) {
      const wd = weekday(r.execute_at)
      assert.ok(wd !== 'Sat' && wd !== 'Sun',
        `stage ${r.stage} landed on ${wd}: ${r.execute_at}`)
    }
  }
})

test('stages still run in order after the bumping', () => {
  const cid = mkLead()
  const rows = enrollColdBuyerSequence(cid, { anchorIso: '2026-11-20T15:00:00Z' })
  for (let i = 1; i < rows.length; i++) {
    assert.ok(new Date(rows[i].execute_at) > new Date(rows[i - 1].execute_at),
      `stage ${rows[i].stage} is not after stage ${rows[i - 1].stage}`)
  }
})

// ── "not today" is not "never" ───────────────────────────────────────────────────────
test('conditions that clear by themselves postpone the stage', () => {
  for (const r of ['US holiday — automated sends paused', 'quiet hours', 'AI paused until Monday']) {
    assert.equal(isTransientBlock(r), true, `${r} must postpone, not destroy the stage`)
  }
})

test('facts about the LEAD still cancel it', () => {
  for (const r of [
    'replied STOP to our number',
    'number is undeliverable (likely a landline)',
    'FSBO follow-up campaign — AI never texts these sellers',
    'added by hand and not switched on — turn AI on for this lead deliberately first',
    'lead status Junk',
    'Not in Market — proactive outreach paused',
  ]) {
    assert.equal(isTransientBlock(r), false, `${r} is about the lead, not the moment — it must cancel`)
  }
})

test('an empty or unknown reason cancels rather than deferring forever', () => {
  for (const r of ['', null, undefined, 'something nobody anticipated']) {
    assert.equal(isTransientBlock(r), false)
  }
})

// ── the drain wiring ─────────────────────────────────────────────────────────────────
import fs from 'node:fs'
const src = fs.readFileSync(new URL('../server/ai-followup/scheduler.js', import.meta.url), 'utf8')

test('the gate postpones before it cancels', () => {
  assert.match(src, /if \(isTransientBlock\(gate\.reason\)\) \{ defer\(a, gate\.reason\); continue \}/)
  const seg = src.slice(src.indexOf('if (!gate.ok)'), src.indexOf('if (!gate.ok)') + 700)
  assert.ok(seg.indexOf('isTransientBlock') < seg.indexOf("finish(a.id, 'canceled'"),
    'the transient check has to run before the cancel')
})

test('a quiet-hours block is no longer recorded as completed', () => {
  assert.match(src, /if \(!res\?\.sent && isTransientBlock\(res\?\.reason\)\) \{ defer\(a, res\.reason\); continue \}/)
  const seg = src.slice(src.indexOf('if (!res?.sent && isTransientBlock'))
  assert.ok(seg.indexOf('defer(a, res.reason)') < seg.indexOf("res?.sent ? 'completed'"),
    'otherwise a stage that never sent is still marked completed')
})

test('a stage cannot be postponed forever', () => {
  assert.match(src, /MAX_DEFERRALS/)
  assert.match(src, /deferred \$\{MAX_DEFERRALS\}x, giving up/)
})

test('a postponed stage goes back to pending with a real future slot', () => {
  assert.match(src, /state='pending', execute_at=\?/)
  assert.match(src, /businessSlot\(new Date\(Date\.now\(\) \+ 86400000\), coldSendOffsetMin\(a\.client_id\)\)/,
    'it must land in the approved daytime window, not simply +24h')
})
