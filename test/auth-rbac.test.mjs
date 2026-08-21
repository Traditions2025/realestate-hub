// P0-1: individual accounts + RBAC + audit-log foundation.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubauth_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.TEAM_PASSWORD = 'shared-test-pw'
process.env.OWNER_EMAIL = 'owner@example.com'
process.env.OWNER_PASSWORD = 'owner-strong-pw'

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { hashPassword, verifyPassword } = await import('../server/auth/passwords.js')
const { can, ROLES, isValidRole } = await import('../server/auth/rbac.js')
const { logAudit, recentAudit } = await import('../server/auth/audit.js')
const { ensureOwnerSeed } = await import('../server/routes/users.js')

// ---------- password hashing ----------
test('password: hash + verify round-trip', () => {
  const h = hashPassword('correct horse battery')
  assert.match(h, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/)
  assert.equal(verifyPassword('correct horse battery', h), true)
  assert.equal(verifyPassword('wrong password', h), false)
})
test('password: never stored in plaintext + min length enforced', () => {
  const h = hashPassword('abcdefgh')
  assert.ok(!h.includes('abcdefgh'))
  assert.throws(() => hashPassword('short'), /at least 8/)
})
test('password: garbage hash never verifies', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false)
  assert.equal(verifyPassword('x', ''), false)
  assert.equal(verifyPassword('x', null), false)
})

// ---------- RBAC ----------
test('rbac: owner can do everything', () => {
  for (const p of ['clients.delete', 'users.manage', 'ai.autopilot', 'settings.edit', 'data.export']) assert.equal(can('owner', p), true, p)
})
test('rbac: read_only can only view', () => {
  assert.equal(can('read_only', 'clients.view'), true)
  assert.equal(can('read_only', 'clients.edit'), false)
  assert.equal(can('read_only', 'communications.send'), false)
})
test('rbac: agent can edit clients + send, but not manage users or autopilot', () => {
  assert.equal(can('agent', 'clients.edit'), true)
  assert.equal(can('agent', 'communications.send'), true)
  assert.equal(can('agent', 'users.manage'), false)
  assert.equal(can('agent', 'ai.autopilot'), false)
})
test('rbac: isa can manage AI, marketing can edit automations', () => {
  assert.equal(can('isa', 'ai.manage'), true)
  assert.equal(can('isa', 'transactions.edit'), false)
  assert.equal(can('marketing', 'automations.edit'), true)
  assert.equal(can('marketing', 'communications.send'), false)
})
test('rbac: unknown role has no permissions; role validation works', () => {
  assert.equal(can('nobody', 'clients.view'), false)
  assert.equal(isValidRole('owner'), true)
  assert.equal(isValidRole('wizard'), false)
  assert.ok(ROLES.includes('transaction_coordinator'))
})

// ---------- owner seed ----------
test('seed: creates exactly one active owner, idempotent', () => {
  ensureOwnerSeed()
  ensureOwnerSeed()   // must not duplicate
  const owners = db.all("SELECT * FROM users WHERE role='owner'")
  assert.equal(owners.length, 1)
  assert.equal(owners[0].email, 'owner@example.com')
  assert.equal(owners[0].status, 'active')
  assert.equal(verifyPassword('owner-strong-pw', owners[0].password_hash), true)
})

// ---------- audit log ----------
test('audit: writes rows and reads them back newest-first', () => {
  logAudit({ actor: 'tester', action: 'unit.test', entity_type: 'thing', entity_id: 42, metadata: { a: 1 } })
  const rows = recentAudit(10, { action: 'unit.test' })
  assert.ok(rows.length >= 1)
  assert.equal(rows[0].action, 'unit.test')
  assert.equal(rows[0].entity_id, '42')
  assert.equal(JSON.parse(rows[0].metadata_json).a, 1)
})

// ---------- schema ----------
test('schema: users / user_sessions / audit_log tables exist', () => {
  for (const t of ['users', 'user_sessions', 'audit_log']) {
    const row = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t])
    assert.equal(row?.name, t, `${t} table missing`)
  }
})
test('schema: users.username exists and is unique; login lookup matches username OR email', () => {
  const cols = db.all('PRAGMA table_info(users)').map(c => c.name)
  assert.ok(cols.includes('username'), 'username column missing')
  db.run("INSERT INTO users (name, email, role, status, username) VALUES ('Jane','jane@x.com','agent','active','jsmith')")
  // Duplicate username is rejected by the unique index.
  assert.throws(() => db.run("INSERT INTO users (name, email, role, status, username) VALUES ('Jim','jim@x.com','agent','active','jsmith')"))
  // The login query resolves by username OR email.
  const byUser = db.get('SELECT id FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)', ['jsmith', 'jsmith'])
  const byEmail = db.get('SELECT id FROM users WHERE lower(username)=lower(?) OR lower(email)=lower(?)', ['jane@x.com', 'jane@x.com'])
  assert.ok(byUser && byEmail && byUser.id === byEmail.id)
})
