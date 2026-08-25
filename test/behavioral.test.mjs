// P1-3: weighted behavioral events + intent integration (weighting, recency decay, dedup).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubbeh_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.ANTHROPIC_API_KEY = ''

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { recordBehavioralEvent, behavioralScore, EVENT_WEIGHTS } = await import('../server/ai-followup/behavioral.js')
const { computeIntent } = await import('../server/ai-followup/intent.js')

let seq = 770000
const mk = () => db.run("INSERT INTO clients (first_name,last_name,phone,type,status) VALUES ('B','E',?,?, 'active')", ['+1319' + (seq++), 'buyer']).lastInsertRowid

test('stronger event types score higher', () => {
  const a = mk(), b = mk()
  recordBehavioralEvent(a, 'property_view')
  recordBehavioralEvent(b, 'tour_request')
  assert.ok(behavioralScore(b).score > behavioralScore(a).score)
  assert.ok(EVENT_WEIGHTS.tour_request > EVENT_WEIGHTS.property_view)
})

test('dedup_key makes same-day repeats idempotent', () => {
  const a = mk()
  const r1 = recordBehavioralEvent(a, 'property_view', { ref: 'MLS123' })
  const r2 = recordBehavioralEvent(a, 'property_view', { ref: 'MLS123' })
  assert.equal(r1.inserted, true)
  assert.equal(r2.inserted, false)   // same client+type+day+ref → ignored
  assert.equal(db.get('SELECT COUNT(*) n FROM behavioral_events WHERE client_id=?', [a]).n, 1)
})

test('recency decay: an old event scores lower than a fresh one', () => {
  const fresh = mk(), old = mk()
  recordBehavioralEvent(fresh, 'form_submit')
  recordBehavioralEvent(old, 'form_submit', { occurredAt: new Date(Date.now() - 42 * 86400000).toISOString(), dedupKey: 'old-form' })
  const f = behavioralScore(fresh).score, o = behavioralScore(old).score
  assert.ok(f > o, `fresh ${f} should beat 42-day-old ${o}`)
  assert.ok(o < f / 2 + 1)   // ~2 half-lives (21d) → roughly a quarter
})

test('score is bounded by cap', () => {
  const a = mk()
  for (let i = 0; i < 20; i++) recordBehavioralEvent(a, 'offer_interest', { dedupKey: 'off' + i })
  assert.ok(behavioralScore(a, { cap: 40 }).score <= 40)
})

test('behavioral events lift the computed intent + add a reason', () => {
  const a = mk()
  const before = computeIntent(a).score
  recordBehavioralEvent(a, 'tour_request', { dedupKey: 't1' })
  recordBehavioralEvent(a, 'valuation_request', { dedupKey: 'v1' })
  const after = computeIntent(a)
  assert.ok(after.score > before)
  assert.ok(after.reasons.some(r => /behavior/i.test(r)))
})
