// Removing one email from a live drip. Steps are a positional array and BOTH the
// enrollment pointer and the send-dedupe key are that index, so a naive splice makes
// everyone past the removed step match an already-sent key and silently skip the rest
// of the campaign. This pins the realignment that prevents that.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()

let seq = 0

// The same work the drip5-remove-sn04 boot migration does, against any drip/step.
function removeStep(dripId, stepId) {
  const row = db.get('SELECT steps FROM drip_campaigns WHERE id=?', [dripId])
  if (!row) return null
  const steps = JSON.parse(row.steps || '[]')
  const idx = steps.findIndex(s => s && s.id === stepId)
  if (idx < 0) return null

  steps.splice(idx, 1)
  db.run("UPDATE drip_campaigns SET steps=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(steps), dripId])
  db.run('DELETE FROM drip_executions WHERE drip_id=? AND step_index=?', [dripId, idx])
  const maxIdx = db.get('SELECT MAX(step_index) m FROM drip_executions WHERE drip_id=?', [dripId]).m ?? -1
  for (let i = idx + 1; i <= maxIdx; i++) {
    db.run(`UPDATE drip_executions SET step_index = ?, idempotency_key = 'drip' || enrollment_id || '_step' || ?
             WHERE drip_id = ? AND step_index = ?`, [i - 1, i - 1, dripId, i])
  }
  db.run('UPDATE drip_enrollments SET current_step = current_step - 1 WHERE drip_id=? AND current_step > ?', [dripId, idx])
  return idx
}

function mkDrip(stepIds) {
  const steps = stepIds.map((id, i) => ({ id, template_id: 900 + i, delay_days: 7, send_time: '09:00' }))
  const r = db.run('INSERT INTO drip_campaigns (name, steps) VALUES (?,?)',
    [`RemovalTest${Date.now()}${++seq}`, JSON.stringify(steps)])
  return Number(r.lastInsertRowid)
}

// A lead sitting at `currentStep`, having already been sent every earlier step.
function mkEnrollment(dripId, currentStep) {
  const c = db.run('INSERT INTO clients (first_name, last_name, type, status) VALUES (?,?,?,?)',
    ['Drip', 'Removal' + (++seq), 'seller', 'new'])
  const e = db.run(`INSERT INTO drip_enrollments (drip_id, client_id, status, current_step, next_run_at)
                    VALUES (?,?,'active',?,?)`, [dripId, Number(c.lastInsertRowid), currentStep, new Date().toISOString()])
  const eid = Number(e.lastInsertRowid)
  for (let i = 0; i < currentStep; i++) {
    db.run(`INSERT INTO drip_executions (enrollment_id, drip_id, step_index, idempotency_key, status)
            VALUES (?,?,?,?,'success')`, [eid, dripId, i, `drip${eid}_step${i}`])
  }
  return eid
}

const IDS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']

test('the removed email is gone and the remaining order is intact', () => {
  const d = mkDrip(IDS)
  const idx = removeStep(d, 's3')
  assert.equal(idx, 3)
  const steps = JSON.parse(db.get('SELECT steps FROM drip_campaigns WHERE id=?', [d]).steps)
  assert.equal(steps.length, 7)
  assert.deepEqual(steps.map(s => s.id), ['s0', 's1', 's2', 's4', 's5', 's6', 's7'])
})

test('a lead who has not reached it yet keeps their place and skips only that email', () => {
  const d = mkDrip(IDS)
  const eid = mkEnrollment(d, 1)             // next up is s1
  removeStep(d, 's3')
  const e = db.get('SELECT current_step FROM drip_enrollments WHERE id=?', [eid])
  assert.equal(e.current_step, 1)
  const steps = JSON.parse(db.get('SELECT steps FROM drip_campaigns WHERE id=?', [d]).steps)
  assert.equal(steps[e.current_step].id, 's1')
})

test('a lead sitting exactly on it moves to the next email, not past it', () => {
  const d = mkDrip(IDS)
  const eid = mkEnrollment(d, 3)             // s3 was next
  removeStep(d, 's3')
  const e = db.get('SELECT current_step FROM drip_enrollments WHERE id=?', [eid])
  const steps = JSON.parse(db.get('SELECT steps FROM drip_campaigns WHERE id=?', [d]).steps)
  assert.equal(steps[e.current_step].id, 's4')
})

test('a lead already past it still gets every remaining email, none skipped', () => {
  const d = mkDrip(IDS)
  const eid = mkEnrollment(d, 6)             // already had s0..s5, next is s6
  removeStep(d, 's3')
  const e = db.get('SELECT current_step FROM drip_enrollments WHERE id=?', [eid])
  const steps = JSON.parse(db.get('SELECT steps FROM drip_campaigns WHERE id=?', [d]).steps)
  assert.equal(steps[e.current_step].id, 's6', 'pointer must still land on s6')

  // The send-dedupe key is the index. Every step they have NOT had must be unclaimed,
  // or the runner treats it as already sent and advances without emailing.
  for (let i = e.current_step; i < steps.length; i++) {
    const prior = db.get('SELECT status FROM drip_executions WHERE idempotency_key=?', [`drip${eid}_step${i}`])
    assert.ok(!prior, `step ${i} (${steps[i].id}) must not look already-sent`)
  }
  // and the history they DO have still points at the right emails
  const sent = db.all('SELECT step_index FROM drip_executions WHERE enrollment_id=? ORDER BY step_index', [eid])
  assert.deepEqual(sent.map(r => r.step_index), [0, 1, 2, 3, 4], 's3 dropped, later rows slid down')
})

test('re-keying never collides on the UNIQUE idempotency key', () => {
  const d = mkDrip(IDS)
  const eid = mkEnrollment(d, 8)             // every step sent
  removeStep(d, 's3')
  const rows = db.all('SELECT idempotency_key FROM drip_executions WHERE enrollment_id=?', [eid])
  assert.equal(rows.length, 7)
  assert.equal(new Set(rows.map(r => r.idempotency_key)).size, 7)
})

test('removing a step that is already gone is a no-op', () => {
  const d = mkDrip(IDS)
  removeStep(d, 's3')
  assert.equal(removeStep(d, 's3'), null)
  assert.equal(JSON.parse(db.get('SELECT steps FROM drip_campaigns WHERE id=?', [d]).steps).length, 7)
})
