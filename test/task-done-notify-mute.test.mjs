// The task-notification pause, read out of the source (John, 2026-11-12).
//
// Companion to task-done-notify-mute-live.test.mjs, which drives the real routes. These
// pin the rule itself and the things that must NOT get swept up in it, because the danger
// in a mute is always that it quietly covers more than intended and looks identical in
// production until something is missed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../server/routes/tasks.js', import.meta.url), 'utf8')
const DAILY = readFileSync(new URL('../server/daily-reminders.js', import.meta.url), 'utf8')

const MATT = 'mattsmithremax@gmail.com'
const JOHN = 'johnwithmattsmithteam@gmail.com'

function muteList(env) {
  const m = SRC.match(/const TASK_NOTIFY_MUTE = \(process\.env\.TASK_NOTIFY_MUTE === undefined\s*\n?\s*\?\s*'([^']*)'/)
  assert.ok(m, 'TASK_NOTIFY_MUTE has a default')
  return (env === undefined ? m[1] : env).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}
function defaultRecipients() {
  const m = SRC.match(/const TASK_NOTIFY_RECIPIENTS = \(process\.env\.TASK_NOTIFY_RECIPIENTS \|\|\s*\n?\s*'([^']*)'/)
  assert.ok(m, 'the recipient list has a default')
  return m[1].split(',').map(s => s.trim()).filter(Boolean)
}
const resolve = (env) => defaultRecipients().filter(a => !muteList(env).includes(a.toLowerCase()))

test('Matt is muted from task-change notifications', () => {
  assert.ok(!resolve().map(a => a.toLowerCase()).includes(MATT))
})

test('John still receives them, so nothing stops being recorded', () => {
  assert.ok(resolve().map(a => a.toLowerCase()).includes(JOHN))
  assert.ok(resolve().length >= 1, 'the email is still sent to someone')
})

test('the mute applies to every event, not just completion', () => {
  // The first version keyed off a `completed` flag, which let the Marilyn Tormey edit
  // through. There must be no event-specific condition left on the filter.
  assert.match(SRC, /const recipients = TASK_NOTIFY_RECIPIENTS\.filter\(a => !TASK_NOTIFY_MUTE\.includes\(a\.toLowerCase\(\)\)\)/,
    'one unconditional filter')
  assert.ok(!/opts\.completed/.test(SRC), 'no leftover completion-only branch')
  assert.ok(!/TASK_DONE_MUTE/.test(SRC), 'the old completion-only constant is gone')
  assert.ok(!/justCompleted/.test(SRC), 'and so is the flag that drove it')
})

test('the send uses the filtered list', () => {
  // The bug that would undo all of this: filter into a variable, then send to the raw list.
  const call = SRC.match(/await sendViaSendGrid\(\s*([A-Za-z_]+),/)
  assert.ok(call, 'the notify send exists')
  assert.equal(call[1], 'recipients')
})

test('the 9am daily reminder of tasks DUE is untouched', () => {
  // A digest Matt asked for is not per-change churn. Sweeping it up would mean he stops
  // being told what is due today, which nobody asked for.
  assert.match(DAILY, new RegExp(MATT.replace('.', '\\.')), 'Matt is still on the daily reminder')
  assert.ok(!/TASK_NOTIFY_MUTE/.test(DAILY), 'the mute does not reach into the daily reminder')
})

test('the manual Nudge button is untouched', () => {
  // Someone deliberately sending a message is not a notification.
  assert.match(SRC, /TEAM_EMAILS = \{[\s\S]*?matt: '[^']+'/, 'the nudge address book is intact')
  const nudge = SRC.slice(SRC.indexOf('Quick nudge'))
  assert.ok(!/TASK_NOTIFY_MUTE/.test(nudge), 'nudge does not consult the mute list')
})

test('unpausing is one environment variable', () => {
  assert.deepEqual(resolve('').map(a => a.toLowerCase()).sort(), [JOHN, MATT].sort(),
    'an empty TASK_NOTIFY_MUTE puts Matt back on everything')
})

test('the pause explains itself where the next person will look', () => {
  assert.match(SRC, /PAUSED, NOT REMOVED/)
  assert.match(SRC, /To UNPAUSE/)
  assert.match(SRC, /Marilyn Tormey/, 'and records why the narrow version was wrong')
})
