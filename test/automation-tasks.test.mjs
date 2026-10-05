// The Tasks tab belongs to the team.
//
// John, 2026-10-05: "keep our tasks tab primarily for our own manual task only, remove any
// task there that was added from AI." 71 of 239 tasks had been written by automations.
// Deleting them alone would have fixed nothing - a CX Response task is written every time a
// cancelled/expired lead replies, so the tab refills within days. The creation is gated.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import db, { initDb } from '../server/database.js'
await initDb()
const { automationTasksEnabled, createAutomationTask, SETTING } = await import('../server/automation-tasks.js')

const read = (p) => fs.readFileSync(new URL('../server/' + p, import.meta.url), 'utf8')
const SOURCES = ['cx-connect.js', 'fsbo-followup.js', 'not-in-market.js', 'seller-campaign.js', 'routes/drips.js']

test('the switch is OFF unless someone turns it on', () => {
  db.setSetting(SETTING, '0')
  assert.equal(automationTasksEnabled(), false)
})

test('nothing is written while it is off', () => {
  db.setSetting(SETTING, '0')
  const before = db.get('SELECT COUNT(*) n FROM tasks').n
  const id = createAutomationTask({ title: 'CX Response: Someone', related_type: 'client', related_id: 1 })
  assert.equal(id, null, 'it should report skipped, not fail')
  assert.equal(db.get('SELECT COUNT(*) n FROM tasks').n, before, 'no row may appear')
})

test('it can be turned back on without a release', () => {
  db.setSetting(SETTING, '1')
  try {
    const id = createAutomationTask({ title: 'CX Response: Switch Test', related_type: 'client', related_id: 1 })
    assert.ok(id, 'the task should be created again')
    const row = db.get('SELECT * FROM tasks WHERE id = ?', [id])
    assert.equal(row.title, 'CX Response: Switch Test')
    db.run('DELETE FROM tasks WHERE id = ?', [id])
  } finally { db.setSetting(SETTING, '0') }
})

test('a task with no title is never written', () => {
  db.setSetting(SETTING, '1')
  try {
    assert.equal(createAutomationTask({ title: '' }), null)
    assert.equal(createAutomationTask({ title: '   ' }), null)
    assert.equal(createAutomationTask({}), null)
  } finally { db.setSetting(SETTING, '0') }
})

// The whole point: no automation may write to the tab behind the switch's back.
//
// ONE deliberate exception, named here so a new one cannot quietly join it. The Annual Not
// in Market Recheck is a single human to-do a YEAR out, not noise that regenerates, and
// followup-coverage.js counts a future human task as the coverage for a parked lead. Gate
// it and every Not in Market lead evaluates UNPROTECTED and lands in Needs Attention -
// one kind of clutter traded for another.
const EXEMPT = []   // none: the annual recheck moved to a smart list 2026-10-05

test('EVERY automation task insert sits behind the switch, bar one named exception', () => {
  const ungated = []
  for (const f of SOURCES) {
    const lines = read(f).split('\n')
    lines.forEach((line, i) => {
      if (!/INSERT INTO tasks/.test(line)) return
      const before = lines.slice(Math.max(0, i - 9), i + 1).join('\n')
      // the values follow the INSERT, so the title is BELOW it
      const window = lines.slice(Math.max(0, i - 9), i + 4).join('\n')
      if (!/automationTasksEnabled\(\)|createAutomationTask\(/.test(before)) ungated.push({ f, line: i + 1, window })
    })
  }
  for (const u of ungated) {
    assert.ok(EXEMPT.some(e => u.f.endsWith(e)), `${u.f}:${u.line} writes a task with nothing gating it`)
    assert.match(u.window, /ANNUAL_TASK_TITLE/, `${u.f}:${u.line} is not the exempt annual recheck`)
  }
  assert.equal(ungated.length, EXEMPT.length,
    `expected exactly ${EXEMPT.length} ungated insert(s), found ${ungated.length}`)
})

// John moved it to a smart list (2026-10-05). The coverage side had to move with it: the
// task WAS the coverage for a parked lead, so without the status being excluded they would
// all read UNPROTECTED and fill Needs Attention.
test('the annual recheck is a smart list now, and coverage was moved with it', () => {
  const src = read('not-in-market.js')
  assert.match(src, /MOVED TO A SMART LIST/)
  assert.match(src, /createAutomationTask\(/, 'it goes through the gate like the rest')
  const cov = read('followup-coverage.js')
  assert.match(cov, /EXCLUDED_STATUSES = new Set\(\[[^\]]*'not_in_market'/,
    'a parked lead must not read UNPROTECTED now that no task covers it')
})

test('the smart list can actually express "due for a recheck"', async () => {
  const { compileAudience } = await import('../server/smart-audience.js')
  const q = compileAudience({ all: [
    { field: 'status', op: 'eq', value: 'not_in_market' },
    { field: 'not_in_market_days', op: 'gte', value: 365 },
  ] })
  assert.match(q.where, /c\.status = \?/)
  assert.match(q.where, /julianday\(c\.not_in_market_at\)/, 'the parked date is what makes it due')
  assert.deepEqual(q.params, ['not_in_market', 365])
})

test('the sources still raise their alert, so nothing is lost', () => {
  // the task was a second copy of a signal that already existed
  for (const f of ['cx-connect.js', 'fsbo-followup.js', 'seller-campaign.js', 'routes/drips.js'])
    assert.match(read(f), /notify\(\{/, `${f} should still notify`)
})

// not-in-market is the exception worth remembering: its task was the ONLY output, and
// notify() fires immediately and cannot be scheduled, so a "recheck in a year" alert would
// have landed today meaning nothing. It is deliberately not faked.
test('not-in-market does not fake a scheduled reminder', () => {
  const src = read('not-in-market.js')
  assert.ok(!/deliver_at/.test(src), 'notify() has no scheduled delivery; promising one would mislead')
  assert.match(src, /not_in_market_at/, 'the column smart lists read is what answers who is due')
})

test('closing and completing existing tasks still works', () => {
  // the gate must only stop CREATION - the automations still tidy up after themselves
  const src = read('seller-campaign.js')
  assert.match(src, /UPDATE tasks SET status='done'/, 'it should still close its own tasks')
  assert.match(read('not-in-market.js'), /UPDATE tasks SET status='done'/)
})
