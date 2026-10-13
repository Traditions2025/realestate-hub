// The lead profile shows ONE timeline, newest at the top.
//
// John, 2026-10-13: "notes should show from top to bottom newest to oldest."
//
// Before this, the Notes tab grouped by SOURCE — imported FUB notes, then Sierra's, then
// the profile's own — so a note from years ago sat above one typed minutes ago. And on the
// All tab a brand-new note landed underneath every email, which is how he came to think a
// note had not saved at all (Patricia Stuckenschneider, same day).
//
// The hard part is that the two kinds of timestamp are not the same kind of thing: a note's
// stamp is Central WALL TIME, a communication's occurred_at is a UTC instant. Both are
// reduced to the same Central "YYYY-MM-DD HH:mm" string so they can be compared.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { centralKey, stampKey, newestFirst } from '../src/lib/timeline-order.js'

// ── note stamps ───────────────────────────────────────────────────────────────────────
test('a real stamp parses, PM included', () => {
  assert.equal(stampKey('Oct 13, 2026, 1:23 PM · John Solamo'), '2026-10-13 13:23')
})

test('AM stays in the morning and noon/midnight do not flip', () => {
  assert.equal(stampKey('Oct 13, 2026, 1:23 AM · John'), '2026-10-13 01:23')
  assert.equal(stampKey('Oct 13, 2026, 12:05 AM · John'), '2026-10-13 00:05')
  assert.equal(stampKey('Oct 13, 2026, 12:05 PM · John'), '2026-10-13 12:05')
})

test('single-digit days pad, so string order is date order', () => {
  assert.equal(stampKey('Oct 5, 2026, 3:04 PM · John'), '2026-10-05 15:04')
  assert.ok(stampKey('Oct 5, 2026, 3:04 PM') < stampKey('Oct 13, 2026, 1:23 PM'),
    'Oct 5 must sort before Oct 13 — the bug a plain string date would reintroduce')
})

test('every month maps, and January does not become October', () => {
  const got = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    .map(m => stampKey(`${m} 1, 2026, 9:00 AM`).slice(5, 7))
  assert.deepEqual(got, ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'])
})

test('an unstamped or junk note yields no key rather than a wrong one', () => {
  for (const s of ['', null, undefined, 'date not recorded', 'sometime last year', 'Xyz 3, 2026, 1:00 PM']) {
    assert.equal(stampKey(s), '', JSON.stringify(s) + ' must not produce a date')
  }
})

test('impossible clock values are refused, not wrapped around', () => {
  assert.equal(stampKey('Oct 13, 2026, 13:23 PM'), '', 'a 13 PM stamp is not a time')
  assert.equal(stampKey('Oct 99, 2026, 1:23 PM'), '')
  assert.equal(stampKey('Oct 13, 2026, 1:99 PM'), '')
})

// ── stored timestamps ─────────────────────────────────────────────────────────────────
test('a UTC instant is keyed in Central, not UTC', () => {
  // 18:23Z on Oct 13 is 1:23 PM Central (CDT, UTC-5) — the same moment as the note above
  assert.equal(centralKey('2026-10-13T18:23:03.946Z'), '2026-10-13 13:23')
})

test('the Central day is what counts, which is the whole point of using it', () => {
  // 01:30Z Oct 14 is still 8:30 PM Oct 13 in Cedar Rapids
  assert.equal(centralKey('2026-10-14T01:30:00Z'), '2026-10-13 20:30')
})

test('standard time is handled too, not just summer', () => {
  // January: CST is UTC-6
  assert.equal(centralKey('2026-01-15T18:23:00Z'), '2026-01-15 12:23')
})

test('a missing or unparseable timestamp yields no key', () => {
  for (const d of ['', null, undefined, 'nope']) assert.equal(centralKey(d), '')
})

// ── the merge, which is what John actually sees ───────────────────────────────────────
test('a note and an email minutes apart interleave correctly', () => {
  const out = newestFirst([
    { id: 'email-older', key: centralKey('2026-10-13T14:15:24.773Z') },   // 9:15 AM
    { id: 'note-newest', key: stampKey('Oct 13, 2026, 1:23 PM · John') },
    { id: 'email-newer', key: centralKey('2026-10-13T18:24:58.426Z') },   // 1:24 PM
    { id: 'call', key: centralKey('2026-10-13T18:21:34.224Z') },          // 1:21 PM
    { id: 'note-older', key: stampKey('Oct 13, 2026, 1:22 PM · John') },
  ])
  assert.deepEqual(out.map(x => x.id),
    ['email-newer', 'note-newest', 'note-older', 'call', 'email-older'],
    'this is Patricia Stuckenschneider’s real timeline')
})

test('both of her notes sit above the morning email, not buried under it', () => {
  const out = newestFirst([
    { id: 'morning-email', key: centralKey('2026-10-13T14:15:24.773Z') },
    { id: 'note-a', key: stampKey('Oct 13, 2026, 1:22 PM · John Solamo') },
    { id: 'note-b', key: stampKey('Oct 13, 2026, 1:23 PM · John Solamo') },
  ])
  assert.equal(out[out.length - 1].id, 'morning-email')
})

test('an old imported note cannot sit above a fresh one', () => {
  const out = newestFirst([
    { id: 'fub-2016', key: centralKey('2016-03-02T15:00:00Z') },
    { id: 'typed-today', key: stampKey('Oct 13, 2026, 1:23 PM · John') },
    { id: 'sierra-2024', key: centralKey('2024-07-11T20:00:00Z') },
  ])
  assert.deepEqual(out.map(x => x.id), ['typed-today', 'sierra-2024', 'fub-2016'],
    'grouping by source was what put 2016 on top')
})

test('undated notes go to the bottom and keep their order among themselves', () => {
  const out = newestFirst([
    { id: 'undated-1', key: '' },
    { id: 'dated', key: stampKey('Oct 13, 2026, 1:23 PM') },
    { id: 'undated-2', key: '' },
  ])
  assert.deepEqual(out.map(x => x.id), ['dated', 'undated-1', 'undated-2'])
})

test('nothing is dropped or duplicated by the sort', () => {
  const input = Array.from({ length: 40 }, (_, i) => ({
    id: 'x' + i,
    key: i % 7 === 0 ? '' : centralKey(new Date(Date.UTC(2026, 0, 1 + i, 12, 0)).toISOString()),
  }))
  const out = newestFirst(input)
  assert.equal(out.length, input.length)
  assert.deepEqual([...out.map(x => x.id)].sort(), [...input.map(x => x.id)].sort())
})

test('ties are stable, so equal-minute entries do not shuffle on re-render', () => {
  const same = stampKey('Oct 13, 2026, 1:23 PM')
  const a = newestFirst([{ id: 'p', key: same }, { id: 'q', key: same }, { id: 'r', key: same }])
  const b = newestFirst([{ id: 'p', key: same }, { id: 'q', key: same }, { id: 'r', key: same }])
  assert.deepEqual(a.map(x => x.id), ['p', 'q', 'r'])
  assert.deepEqual(a.map(x => x.id), b.map(x => x.id))
})

test('the input array is not mutated', () => {
  const input = [{ id: 'a', key: '2026-01-01 00:00' }, { id: 'b', key: '2026-02-01 00:00' }]
  newestFirst(input)
  assert.deepEqual(input.map(x => x.id), ['a', 'b'])
})
