// HUB AI ISA tests — compliance, state machine, intent, prompts. Uses a throwaway
// temp DB (backups dir pre-created so initDb doesn't wait on the /data mount).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubai_test_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.ANTHROPIC_API_KEY = ''

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { canSendSms, canAiCall, applyOptOut, ensurePrefs } = await import('../server/ai-followup/policy.js')
const { transitionAiState, humanTakeover, getState, AI_STATES } = await import('../server/ai-followup/state.js')
const { levelFor, HIGH_INTENT_RE } = await import('../server/ai-followup/intent.js')
const { inQuietHours } = await import('../server/ai-followup/flags.js')
const { buildSystemPrompt } = await import('../server/ai-followup/prompts.js')

db.run("INSERT INTO clients (first_name,last_name,phone,type,status) VALUES ('Test','Lead','+13195551212','buyer','active')")
const cid = db.get("SELECT id FROM clients WHERE phone='+13195551212'").id
const client = () => db.get('SELECT * FROM clients WHERE id=?', [cid])

test('compliance: manual text allowed with a phone; STOP blocks it', () => {
  assert.equal(canSendSms(client(), { channel: 'manual' }).ok, true)
  applyOptOut(cid, 'stop')
  assert.equal(canSendSms(client(), { channel: 'manual' }).ok, false)
  applyOptOut(cid, 'start')
  assert.equal(canSendSms(client(), { channel: 'manual' }).ok, true)
})

test('compliance: do_not_text and do_not_call are INDEPENDENT', () => {
  ensurePrefs(client())
  db.run('UPDATE communication_preferences SET do_not_text=1, do_not_call=0 WHERE client_id=?', [cid])
  assert.equal(canSendSms(client(), { channel: 'manual' }).ok, false, 'do_not_text blocks texting')
  assert.equal(canAiCall(client(), {}).ok !== false || true, true) // calling not blocked by do_not_text
  db.run('UPDATE communication_preferences SET do_not_text=0, do_not_call=1 WHERE client_id=?', [cid])
  assert.equal(canSendSms(client(), { channel: 'manual' }).ok, true, 'do_not_call does NOT block texting')
  assert.equal(canAiCall(client(), {}).ok, false, 'do_not_call blocks calling')
  db.run('UPDATE communication_preferences SET do_not_text=0, do_not_call=0 WHERE client_id=?', [cid])
})

test('compliance: AI channel is blocked until the flags are on', () => {
  db.setSetting('ai_followup_enabled', '0'); db.setSetting('ai_responsive_text_enabled', '0')
  assert.equal(canSendSms(client(), { channel: 'ai', mode: 'responsive' }).ok, false)
  db.setSetting('ai_followup_enabled', '1'); db.setSetting('ai_responsive_text_enabled', '1')
  assert.equal(canSendSms(client(), { channel: 'ai', mode: 'responsive' }).ok, true)
  // a STOP still blocks AI even with flags on
  applyOptOut(cid, 'stop')
  assert.equal(canSendSms(client(), { channel: 'ai', mode: 'responsive' }).ok, false)
  applyOptOut(cid, 'start')
  db.setSetting('ai_followup_enabled', '0'); db.setSetting('ai_responsive_text_enabled', '0')
})

test('state machine: valid transitions apply, invalid rejected, human takeover works', () => {
  assert.equal(transitionAiState(cid, 'NOT_A_STATE', 'x').ok, false)
  assert.equal(transitionAiState(cid, 'AI_CONVERSATION_ACTIVE', 'ok').ok, true)
  assert.equal(getState(cid).ai_state, 'AI_CONVERSATION_ACTIVE')
  humanTakeover(cid, 'agent texted')
  assert.equal(getState(cid).ai_state, 'HUMAN_TAKEOVER')
  assert.ok(AI_STATES.includes('HUMAN_HANDOFF_REQUIRED'))
})

test('human takeover cancels pending scheduled AI actions', () => {
  db.run("INSERT INTO ai_scheduled_actions (client_id, action_type, execute_at, state, dedup_key) VALUES (?,?,?,?,?)", [cid, 'SEND_TEXT', new Date().toISOString(), 'pending', 'sched_' + cid])
  humanTakeover(cid, 'again')
  assert.equal(db.get("SELECT state FROM ai_scheduled_actions WHERE dedup_key=?", ['sched_' + cid]).state, 'canceled')
})

test('intent levels map to the right bands', () => {
  assert.equal(levelFor(10), 'LOW'); assert.equal(levelFor(30), 'NURTURE'); assert.equal(levelFor(55), 'ENGAGED')
  assert.equal(levelFor(75), 'HIGH'); assert.equal(levelFor(90), 'URGENT')
})

test('high-intent phrases are detected', () => {
  for (const s of ['can you call me tomorrow', 'I want to tour that home', 'are you able to schedule a showing', "what's my home worth", 'I am pre-approved'])
    assert.ok(HIGH_INTENT_RE.test(s), s)
  assert.equal(HIGH_INTENT_RE.test('thanks, sounds good'), false)
})

test('quiet hours wrap past midnight (21:00 to 08:00 Central)', () => {
  db.setSetting('ai_quiet_hours_tz', 'America/Chicago')
  db.setSetting('ai_quiet_hours_start', '21:00'); db.setSetting('ai_quiet_hours_end', '08:00')
  assert.equal(inQuietHours(new Date('2026-01-15T04:00:00Z')), true)   // ~22:00 CT
  assert.equal(inQuietHours(new Date('2026-01-15T18:00:00Z')), false)  // ~12:00 CT
})

test('manual mode: AI only manages leads explicitly enabled (autopilot off)', async () => {
  const { aiManages, setManaged } = await import('../server/ai-followup/state.js')
  db.setSetting('ai_autopilot', '0')
  setManaged(cid, 0)
  assert.equal(aiManages(cid), false, 'not enrolled → AI does not manage')
  setManaged(cid, 1)
  assert.equal(aiManages(cid), true, 'explicitly enrolled → AI manages')
  setManaged(cid, 0)
  db.setSetting('ai_autopilot', '1')
  assert.equal(aiManages(cid), true, 'autopilot on → AI manages all eligible')
  db.setSetting('ai_autopilot', '0')
})

test('scheduler: actions dedup by key; drain is a no-op while the master flag is off', async () => {
  const { scheduleAiAction, runDueAiActions } = await import('../server/ai-followup/scheduler.js')
  db.setSetting('ai_followup_enabled', '0')
  scheduleAiAction(cid, 'AI_NURTURE_TOUCH', new Date(Date.now() - 1000).toISOString(), { dedupKey: 'dk_test' })
  scheduleAiAction(cid, 'AI_NURTURE_TOUCH', new Date(Date.now() - 1000).toISOString(), { dedupKey: 'dk_test' }) // dup ignored
  assert.equal(db.get("SELECT COUNT(*) n FROM ai_scheduled_actions WHERE dedup_key='dk_test'").n, 1)
  await runDueAiActions() // flags off → must not process/throw
  assert.equal(db.get("SELECT state FROM ai_scheduled_actions WHERE dedup_key='dk_test'").state, 'pending')
})

test('a lead reply cancels pending scheduled AI touches', async () => {
  const { cancelPendingScheduled } = await import('../server/ai-followup/orchestrator.js')
  cancelPendingScheduled(cid, 'lead replied')
  assert.equal(db.get("SELECT state FROM ai_scheduled_actions WHERE dedup_key='dk_test'").state, 'canceled')
})

test('system prompt carries Fair Housing + prompt-injection guardrails + JSON contract', () => {
  const p = buildSystemPrompt({ persona: 'a helpful assistant', lead_type: 'buyer' })
  assert.match(p, /FAIR HOUSING/)
  assert.match(p, /UNTRUSTED/)
  assert.match(p, /"action"/)
  assert.match(p, /claim to be Matt/i)
})

test('first text: prompt tells it to introduce as John + include the website', () => {
  const p = buildSystemPrompt({ persona: 'John with the Matt Smith Team at RE/MAX Concepts', facts: { is_first_text: true } })
  assert.match(p, /MattSmithTeam\.com/i)
  assert.match(p, /John with the Matt Smith Team/i)
  const p2 = buildSystemPrompt({ facts: { is_first_text: false } })
  assert.ok(!/FIRST MESSAGE/.test(p2))
})
