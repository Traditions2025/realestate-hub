// P0-2: unified automated-communication collision guard (policy.canAutomatedSend).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubcollide_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.ANTHROPIC_API_KEY = ''

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { canAutomatedSend, canSendSms } = await import('../server/ai-followup/policy.js')

let seq = 5550000
const mkClient = (over = {}) => {
  const phone = over.phone || ('+1319' + (seq++))
  const r = db.run("INSERT INTO clients (first_name,last_name,phone,type,status) VALUES ('T','L',?,?,?)", [phone, 'buyer', over.status || 'active'])
  return db.get('SELECT * FROM clients WHERE id=?', [r.lastInsertRowid])
}
const NO_TIME = { dedupMinutes: 0, respectQuietHours: false }

test('collision: a clean lead is allowed', () => {
  assert.equal(canAutomatedSend(mkClient(), NO_TIME).ok, true)
})

test('collision: STOP / opt-out blocks (hard compliance)', () => {
  const c = mkClient(); db.run('UPDATE clients SET hub_text_opt_out=1 WHERE id=?', [c.id])
  assert.equal(canAutomatedSend(db.get('SELECT * FROM clients WHERE id=?', [c.id]), NO_TIME).ok, false)
})

test('collision: Do Not Contact status blocks', () => {
  const c = mkClient({ status: 'donotcontact' })
  assert.equal(canAutomatedSend(c, NO_TIME).ok, false)
})

test('collision: a human takeover blocks automated sends', () => {
  const c = mkClient()
  db.run("INSERT INTO ai_lead_state (client_id, ai_state) VALUES (?, 'HUMAN_TAKEOVER')", [c.id])
  const r = canAutomatedSend(c, NO_TIME)
  assert.equal(r.ok, false); assert.match(r.reason, /human/i)
})

test('collision: a pending AI action blocks non-AI sources but not the AI itself', () => {
  const c = mkClient()
  db.run("INSERT INTO ai_scheduled_actions (client_id, action_type, execute_at) VALUES (?, 'AI_FOLLOWUP', datetime('now'))", [c.id])
  assert.equal(canAutomatedSend(c, { source: 'automation', ...NO_TIME }).ok, false)
  assert.equal(canAutomatedSend(c, { source: 'bulk', ...NO_TIME }).ok, false)
  assert.equal(canAutomatedSend(c, { source: 'ai', ...NO_TIME }).ok, true, 'the AI is allowed to act on its own pending action')
})

test('collision: AI actively conversing blocks other automated sources', () => {
  const c = mkClient()
  db.run("INSERT INTO ai_lead_state (client_id, ai_state, ai_managed) VALUES (?, 'AI_WAITING_FOR_REPLY', 1)", [c.id])
  assert.equal(canAutomatedSend(c, { source: 'automation', ...NO_TIME }).ok, false)
  assert.equal(canAutomatedSend(c, { source: 'ai', ...NO_TIME }).ok, true)
})

test('collision: a recently-sent text suppresses stacking (dedup window)', () => {
  const c = mkClient()
  db.run("INSERT INTO communications (channel, direction, client_id, occurred_at) VALUES ('text','outgoing',?,?)", [c.id, new Date().toISOString()])
  assert.equal(canAutomatedSend(c, { source: 'automation', dedupMinutes: 60, respectQuietHours: false }).ok, false)
  assert.equal(canAutomatedSend(c, { source: 'automation', dedupMinutes: 0, respectQuietHours: false }).ok, true, 'dedup off allows it')
})

test('landline: an undeliverable number is skipped for automated sends but not manual', () => {
  const c = mkClient()
  db.run('UPDATE clients SET sms_undeliverable=1 WHERE id=?', [c.id])
  const fresh = db.get('SELECT * FROM clients WHERE id=?', [c.id])
  assert.equal(canAutomatedSend(fresh, NO_TIME).ok, false)
  assert.equal(canSendSms(fresh, { channel: 'automation' }).ok, false)
  assert.equal(canSendSms(fresh, { channel: 'manual' }).ok, true, 'a human can still try manually')
})

test('collision: quiet hours block only when respectQuietHours is true', () => {
  db.setSetting('ai_quiet_hours_start', '00:00'); db.setSetting('ai_quiet_hours_end', '23:59'); db.setSetting('ai_quiet_hours_tz', 'America/Chicago')
  const c = mkClient()
  assert.equal(canAutomatedSend(c, { dedupMinutes: 0, respectQuietHours: true }).ok, false)
  assert.equal(canAutomatedSend(c, { dedupMinutes: 0, respectQuietHours: false }).ok, true)
  db.setSetting('ai_quiet_hours_start', '21:00'); db.setSetting('ai_quiet_hours_end', '08:00')  // restore
})
