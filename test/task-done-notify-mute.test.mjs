// MATT'S "TASK COMPLETED" EMAIL IS PAUSED (John, 2026-11-12)
//
// Matt asked to stop getting an email every time a task is ticked off. The risk in a change
// like this is always that it quietly mutes more than it was meant to, so these tests pin
// the edges: the completion email still goes to John, and every OTHER task email still goes
// to Matt. A pause that silently became "Matt stops hearing about tasks" would look
// identical in production until something was missed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../server/routes/tasks.js', import.meta.url), 'utf8')

// Re-create the module's own logic from its source so the test follows the real values
// rather than a copy of them that can drift.
function muteList(env) {
  const m = SRC.match(/const TASK_DONE_MUTE = \(process\.env\.TASK_DONE_MUTE === undefined\s*\?\s*'([^']*)'/)
  assert.ok(m, 'TASK_DONE_MUTE has a default')
  return (env === undefined ? m[1] : env).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}
function defaultRecipients() {
  const m = SRC.match(/const TASK_NOTIFY_RECIPIENTS = \(process\.env\.TASK_NOTIFY_RECIPIENTS \|\|\s*'([^']*)'/)
  assert.ok(m, 'the recipient list has a default')
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
}
const resolve = (completed, env) => {
  const mute = muteList(env)
  return completed ? defaultRecipients().filter(a => !mute.includes(a.toLowerCase())) : defaultRecipients()
}

const MATT = 'mattsmithremax@gmail.com'
const JOHN = 'johnwithmattsmithteam@gmail.com'

test('completing a task no longer emails Matt', () => {
  const to = resolve(true)
  assert.ok(!to.map(a => a.toLowerCase()).includes(MATT), 'Matt is not on the completion email')
})

test('but John still gets the completion email', () => {
  // The record of what got finished must not disappear from the team.
  const to = resolve(true)
  assert.ok(to.map(a => a.toLowerCase()).includes(JOHN), 'John still gets it')
  assert.ok(to.length >= 1, 'the completion email is still sent to someone')
})

test('every other task email still reaches Matt', () => {
  // created / updated / note added / deleted are untouched - this was a pause on ONE event.
  const to = resolve(false).map(a => a.toLowerCase())
  assert.ok(to.includes(MATT), 'Matt still gets non-completion task mail')
  assert.ok(to.includes(JOHN))
})

test('the mute is driven by an explicit completion flag, not by reading status', () => {
  // A note added to an already-finished task is not a completion. Guessing from
  // task.status === 'done' would have muted those too.
  assert.match(SRC, /opts\.completed\s*\n?\s*\?\s*TASK_NOTIFY_RECIPIENTS\.filter/,
    'the filter keys off opts.completed')
  assert.ok(!/task\.status === 'done'[\s\S]{0,80}TASK_DONE_MUTE/.test(SRC),
    'it never infers the completion from the status field')
})

test('only the transition INTO done sets that flag', () => {
  // justCompleted is set in the branch that also stamps completed_at, which is the one
  // place the code already knows the task was not done a moment ago.
  const m = SRC.match(/if \(isDone && !wasDone\) \{[\s\S]*?\}/)
  assert.ok(m, 'the transition branch exists')
  assert.match(m[0], /justCompleted = true/, 'the flag is set there')
  const reopen = SRC.match(/\} else if \(!isDone && wasDone\) \{[\s\S]*?\}/)
  assert.ok(reopen && !/justCompleted = true/.test(reopen[0]), 'reopening a task is not a completion')
})

test('the notifier is actually handed the flag', () => {
  assert.match(SRC, /notifyTaskChange\('updated', after, \{[^}]*completed: justCompleted/,
    'the PUT handler passes completed through')
})

test('the send uses the filtered list, not the raw recipient list', () => {
  // The bug that would undo all of this: filtering into a variable and then sending to
  // TASK_NOTIFY_RECIPIENTS anyway.
  const call = SRC.match(/await sendViaSendGrid\(\s*([A-Za-z_]+),/)
  assert.ok(call, 'the notify send exists')
  assert.equal(call[1], 'recipients', 'it sends to the filtered list')
})

test('unpausing is one environment variable', () => {
  // "For now" means this comes back. Setting TASK_DONE_MUTE to an empty string restores
  // Matt without a code change.
  assert.deepEqual(resolve(true, '').map(a => a.toLowerCase()).sort(), [JOHN, MATT].sort(),
    'an empty TASK_DONE_MUTE puts everyone back on the completion email')
})

test('the pause is documented where the next person will look', () => {
  assert.match(SRC, /PAUSED, NOT REMOVED/, 'the constant says it is a pause')
  assert.match(SRC, /To UNPAUSE/, 'and says how to undo it')
})
