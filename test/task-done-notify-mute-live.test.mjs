// MATT'S TASK NOTIFICATION EMAIL IS PAUSED (John, 2026-11-12)
//
// First shipped as a completion-only mute, which was too narrow: that same afternoon John
// edited task #88 (Marilyn Tormey - never completed, still "todo") and Matt was emailed,
// because an edit is not a completion. The pause now covers every per-change task email.
//
// These run against the REAL route handlers with sendViaSendGrid replaced by a recorder,
// so the assertions are about who the mail actually went to, and nothing can leave the
// machine. "The code looks right" and "the right people get the email" are different
// claims, and only the second one is the thing John reported.
import { test, mock, before, after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import db, { initDb } from '../server/database.js'

await initDb()

const sent = []
mock.module('../server/routes/email.js', {
  exports: {
    sendViaSendGrid: async (to, ...rest) => { sent.push({ to, subject: rest[1] }); return { ok: true, mocked: true } },
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

const expectMuted = (label) => {
  assert.equal(sent.length, 1, `${label}: exactly one email`)
  assert.ok(!addrs(0).includes(MATT), `${label}: Matt must not be on it - got ${addrs(0)}`)
  assert.match(addrs(0), new RegExp(JOHN), `${label}: John still gets it`)
}

test('creating a task does not email Matt', async () => {
  sent.length = 0
  const r = await fetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Test Account — notify mute check', priority: 'low', status: 'todo' }),
  })
  taskId = (await r.json()).id
  assert.ok(taskId, 'task created')
  await settle()
  expectMuted('created')
})

test('UPDATING a task does not email Matt — the #88 regression', async () => {
  // This is the exact case John reported: a task edited, never completed, Matt emailed.
  sent.length = 0
  const r = await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ priority: 'high' }),
  })
  assert.equal(r.status, 200)
  await settle()
  expectMuted('updated')
  // And the task is genuinely still open, as #88 was.
  assert.equal(db.get('SELECT status FROM tasks WHERE id=?', [taskId]).status, 'todo')
})

test('adding a note does not email Matt', async () => {
  sent.length = 0
  const r = await fetch(`${base}/${taskId}/notes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'Called, left a voicemail', by: 'Test Account' }),
  })
  assert.equal(r.status, 200, 'the note saved')
  await settle()
  expectMuted('note added')
})

test('completing a task does not email Matt, and still emails John', async () => {
  sent.length = 0
  const r = await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  })
  assert.equal(r.status, 200)
  await settle()
  expectMuted('completed')
  const row = db.get('SELECT status, completed_at FROM tasks WHERE id=?', [taskId])
  assert.equal(row.status, 'done')
  assert.ok(row.completed_at, 'completed_at still stamped — the mute costs the email, not the record')
})

test('editing an already-done task does not email Matt either', async () => {
  sent.length = 0
  await fetch(`${base}/${taskId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description: 'touched after completion' }),
  })
  await settle()
  expectMuted('edited after completion')
})

test('John never stops being told — every email still had a recipient', () => {
  assert.ok(sent.length >= 1)
  for (let i = 0; i < sent.length; i++) {
    const list = Array.isArray(sent[i].to) ? sent[i].to : String(sent[i].to).split(',')
    assert.ok(list.filter(Boolean).length >= 1, 'no email was sent to an empty list')
  }
})

test('nothing was sent for real', () => {
  assert.equal(process.env.SENDGRID_API_KEY, undefined, 'no key present')
  assert.ok(sent.every(x => x && x.to), 'every send went through the recorder')
})
