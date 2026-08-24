// P1-5: Smart Audiences engine — AND/OR compile, behavioral fields, safety, preview.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubaud_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.ANTHROPIC_API_KEY = ''

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { compileAudience, previewAudience, fieldMeta } = await import('../server/smart-audience.js')

let seq = 880000
const mk = (over = {}) => {
  const r = db.run('INSERT INTO clients (first_name,last_name,phone,email,type,status,city,source,lead_score,realist_sell_score) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['A' + (seq++), 'Seg', '+1319' + (seq), over.email ?? null, over.type || 'buyer', over.status || 'active', over.city || 'Marion', over.source || 'Website', over.lead_score ?? 500, over.realist_sell_score ?? null])
  return r.lastInsertRowid
}
const setIntent = (cid, score, ctype) => db.run(`INSERT INTO lead_intelligence (client_id,intent_score,peak_intent,conversation_type) VALUES (?,?,?,?)
  ON CONFLICT(client_id) DO UPDATE SET intent_score=excluded.intent_score, peak_intent=excluded.peak_intent, conversation_type=excluded.conversation_type`, [cid, score, score, ctype || null])
const countOf = (tree) => { const { where, params } = compileAudience(tree); return db.get(`SELECT COUNT(*) c FROM clients c${where}`, params).c }

test('empty tree matches everyone', () => {
  const before = db.get('SELECT COUNT(*) c FROM clients').c
  assert.equal(countOf({ all: [] }), before)
  assert.equal(countOf(null), before)
})

test('AND narrows, OR widens', () => {
  const a = mk({ city: 'Marion', type: 'seller', lead_score: 900 })
  mk({ city: 'Hiawatha', type: 'buyer', lead_score: 100 })
  const andHit = { all: [{ field: 'city', op: 'eq', value: 'Marion' }, { field: 'type', op: 'eq', value: 'seller' }, { field: 'lead_score', op: 'gte', value: 800 }] }
  assert.ok(countOf(andHit) >= 1)
  const orHit = { any: [{ field: 'city', op: 'eq', value: 'Hiawatha' }, { field: 'city', op: 'eq', value: 'Marion' }] }
  assert.ok(countOf(orHit) >= 2)
  // nested: (seller AND score>=800) OR city=Hiawatha
  const nested = { any: [andHit, { field: 'city', op: 'eq', value: 'Hiawatha' }] }
  assert.ok(countOf(nested) >= 2)
  assert.ok(a)
})

test('behavioral field: intent + conversation_type via subquery', () => {
  const hot = mk({ city: 'Robins' }); setIntent(hot, 82, 'seller')
  const cold = mk({ city: 'Robins' }); setIntent(cold, 10, 'buyer')
  const hiIntent = countOf({ all: [{ field: 'city', op: 'eq', value: 'Robins' }, { field: 'intent', op: 'gte', value: 70 }] })
  assert.equal(hiIntent, 1)
  const sellers = countOf({ all: [{ field: 'conversation_type', op: 'eq', value: 'seller' }] })
  assert.ok(sellers >= 1)
})

test('operators: between, in, contains, is_true/null', () => {
  assert.doesNotThrow(() => compileAudience({ all: [{ field: 'lead_score', op: 'between', value: [300, 700] }] }))
  assert.doesNotThrow(() => compileAudience({ all: [{ field: 'city', op: 'in', value: ['Marion', 'Hiawatha'] }] }))
  assert.doesNotThrow(() => compileAudience({ all: [{ field: 'has_email', op: 'is_true' }] }))
  assert.doesNotThrow(() => compileAudience({ all: [{ field: 'tag', op: 'contains', value: 'VIP' }] }))
  assert.doesNotThrow(() => compileAudience({ all: [{ field: 'realist_sell_score', op: 'not_null' }] }))
})

test('rejects unknown fields and bad operators (no injection)', () => {
  assert.throws(() => compileAudience({ all: [{ field: 'password; DROP TABLE clients', op: 'eq', value: 'x' }] }), /unknown field/)
  assert.throws(() => compileAudience({ all: [{ field: 'lead_score', op: 'sql_inject', value: 1 }] }), /not allowed/)
  // a value that looks like SQL is bound as a param, never interpolated
  const { where, params } = compileAudience({ all: [{ field: 'city', op: 'eq', value: "'; DROP TABLE clients; --" }] })
  assert.match(where, /c\.city = \?/)
  assert.equal(params[0], "'; DROP TABLE clients; --")
})

test('previewAudience returns count + sample; fieldMeta lists ops', () => {
  const p = previewAudience(db, { all: [{ field: 'type', op: 'eq', value: 'buyer' }] }, { limit: 5 })
  assert.ok(p.count >= 1)
  assert.ok(p.sample.length <= 5)
  const meta = fieldMeta()
  assert.ok(meta.find(m => m.key === 'intent' && m.ops.includes('gte')))
})
