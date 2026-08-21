// P0-3: failure visibility log + backup verification.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubfail_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
db.run("INSERT INTO clients (first_name,last_name,phone,type,status) VALUES ('Backup','Test','+13195550000','buyer','active')")

const { recordFailure, listFailures, failureCounts, resolveFailure } = await import('../server/failures.js')
const { backupDbToDisk, verifyBackupFile, getBackupHealth } = await import('../server/backup.js')

// ---------- failure log ----------
test('failures: record + list open', () => {
  recordFailure('sms', { ref: 42, summary: 'text failed', error: 'Twilio 30007' })
  const open = listFailures({ state: 'open' })
  assert.ok(open.find(f => f.kind === 'sms' && f.ref === '42'))
})

test('failures: same kind+ref bumps retry_count instead of duplicating', () => {
  const before = listFailures({ state: 'open' }).filter(f => f.ref === '42').length
  recordFailure('sms', { ref: 42, summary: 'text failed again', error: 'Twilio 30007' })
  const rows = listFailures({ state: 'open' }).filter(f => f.ref === '42')
  assert.equal(rows.length, before, 'no new row for the same failure')
  assert.ok(rows[0].retry_count >= 1, 'retry_count bumped')
})

test('failures: counts by kind, and resolve removes from open', () => {
  recordFailure('backup', { ref: 'daily', summary: 'backup verify failed', error: 'integrity not ok' })
  const c = failureCounts()
  assert.ok(c.total >= 2 && c.by.sms >= 1 && c.by.backup >= 1)
  const one = listFailures({ state: 'open' })[0]
  resolveFailure(one.id)
  assert.ok(!listFailures({ state: 'open' }).find(f => f.id === one.id))
})

test('failures: recordFailure never throws on bad input', () => {
  assert.doesNotThrow(() => recordFailure('sms', { error: new Error('an Error object') }))
  assert.doesNotThrow(() => recordFailure('x'))
})

// ---------- backup verification ----------
test('backup: a fresh disk backup verifies as a usable database', () => {
  const b = backupDbToDisk('test')
  assert.ok(b.path, 'backup file was created: ' + JSON.stringify(b))
  const v = verifyBackupFile(b.path)
  assert.equal(v.ok, true, 'integrity: ' + JSON.stringify(v))
  assert.equal(v.integrity, 'ok')
  assert.ok(v.clients >= 1, 'clients table is queryable in the backup')
})

test('backup: verifyBackupFile rejects a missing / bogus file', () => {
  assert.equal(verifyBackupFile(join(DIR, 'nope.db')).ok, false)
})

test('backup: health snapshot reports a fresh, verified, non-stale backup', () => {
  const h = getBackupHealth()
  assert.ok(h.count >= 1)
  assert.equal(h.stale, false, 'a just-made backup is not stale')
  assert.equal(h.verified, true)
  assert.equal(h.ok, true)
})
