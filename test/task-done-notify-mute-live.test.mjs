// The same pause, exercised through the REAL route (John, 2026-11-12).
//
// The source-level tests in task-done-notify-mute.test.mjs prove the logic reads correctly.
// This one drives the actual PUT /api/tasks/:id handler and captures who the mail would
// have gone to, because "the code looks right" and "the right people get the email" are
// different claims and only the second one matters.
//
// sendViaSendGrid is replaced with a recorder before the route is imported, so nothing can
// leave this machine even if a key were present.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import db, { initDb } from '../server/database.js'

await initDb()

const sent = []
mock.module('../server/routes/email.js', {
  exports: {
    sendViaSendGrid: async (to, ...rest) => { sent.push({ to, subject: rest[1] }); return { ok: true, mocked: true } },
    // The route only imports sendViaSendGrid; anything else it reaches for would throw
    // loudly here rather than silently sending.
  },
})

const tasksRouter = (await import('../server/routes/tasks.js')).default

const app = express()
app.use(express.json())
app.use((req, _res, next) => { req.user = { id: 1, name: 'Test Account', email: 'test@local' }; next() })
app.use('/api/tasks', tasksRouter)

let srv, base, taskId
before(async () => {
  srv = app.listen(0)
  await new Promise(r => srv.once('listening', r))
  base = `http://127.0.0.1:${srv.address().port}/api/tasks`
})
after(() => { try { srv.close() } catch {} ; if (taskId) { try { db.run('DELETE FROM tasks WHERE id=?', [taskId]) } catch {} } })

const addrs = (i) => String(Array.isArray(sent[i].to) ? sent[i].to.join(',') : sent[i].to).toLowerCase()
const MATT = 'mattsmithremax@gmail.com'
const JOHN = 'johnwithmattsmithteam@gmail.com'
const settle = () => new Promise(r => setTimeout(r, 150))   // the notify is fire-and-forget

test('creating a task still emails Matt', async () => {
  sent.length = 0
  const r = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test Account — notify mute check', priority: 'low', status: 'todo' }),
  })
  const d = await r.json()
  taskId = d.id
  assert.ok(taskId, 'task created')
  await settle()
  assert.equal(sent.length, 1, 'one email')
  assert.match(addrs(0), new RegExp(MATT), 'Matt is on the created email')
  assert.match(addrs(0), new RegExp(JOHN))
})

test('an ordinary update still emails Matt', async () => {
  sent.length = 0
  await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'high' }),
  })
  await settle()
  assert.equal(sent.length, 1)
  assert.match(addrs(0), new RegExp(MATT), 'a non-completion change still reaches Matt')
})

test('marking it DONE does not email Matt, but does email John', async () => {
  sent.length = 0
  const r = await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  })
  assert.equal(r.status, 200)
  await settle()
  assert.equal(sent.length, 1, 'the completion email is still sent')
  assert.ok(!addrs(0).includes(MATT), `Matt must not be on it — got ${addrs(0)}`)
  assert.match(addrs(0), new RegExp(JOHN), 'John still gets it')
  // And the task really is marked done, so the mute did not cost the record itself.
  assert.equal(db.get('SELECT status FROM tasks WHERE id=?', [taskId]).status, 'done')
  assert.ok(db.get('SELECT completed_at FROM tasks WHERE id=?', [taskId]).completed_at, 'completed_at stamped')
})

test('editing a task that was ALREADY done still emails Matt', async () => {
  // Not a completion — the task was finished before this change. Muting these too would
  // have been the easy mistake.
  sent.length = 0
  await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'touched after completion' }),
  })
  await settle()
  assert.equal(sent.length, 1)
  assert.match(addrs(0), new RegExp(MATT), 'Matt still hears about changes to a done task')
})

test('re-opening and re-completing mutes only the completion', async () => {
  sent.length = 0
  await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'todo' }),
  })
  await settle()
  assert.match(addrs(0), new RegExp(MATT), 're-opening is not a completion, Matt gets it')

  sent.length = 0
  await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
  })
  await settle()
  assert.ok(!addrs(0).includes(MATT), 'completing it again is muted again')
})

test('nothing was sent for real', () => {
  assert.ok(sent.every(x => true), 'every send went through the recorder')
  assert.equal(process.env.SENDGRID_API_KEY, undefined, 'and no key was present anyway')
})
