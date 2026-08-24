// P1-2: conversation classifier + structured memory provenance.
// - conversation_type normalization (enum coercion)
// - applyMemory writes lead_intelligence + per-field provenance
// - confidence-gating: a weaker guess never overwrites a stronger known fact
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubmem_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR
process.env.ANTHROPIC_API_KEY = ''

const { initDb } = await import('../server/database.js')
await initDb()
const db = (await import('../server/database.js')).default
const { applyMemory, memoryFields, normalizeConversationType } = await import('../server/ai-followup/memory.js')

let seq = 990000
const mkClient = () => {
  const r = db.run("INSERT INTO clients (first_name,last_name,phone,type,status) VALUES ('M','L',?,?, 'active')", ['+1319' + (seq++), 'buyer'])
  return r.lastInsertRowid
}
const li = (cid) => db.get('SELECT * FROM lead_intelligence WHERE client_id=?', [cid])
const prov = (cid, field) => db.get('SELECT * FROM lead_memory_fields WHERE client_id=? AND field=?', [cid, field])

test('normalizeConversationType coerces to the enum (or null)', () => {
  assert.equal(normalizeConversationType('Buyer'), 'buyer')
  assert.equal(normalizeConversationType('buyer-seller'), 'both')
  assert.equal(normalizeConversationType('past client'), 'past_client')
  assert.equal(normalizeConversationType('window shopper'), null)
  assert.equal(normalizeConversationType(''), null)
})

test('applyMemory writes intelligence columns, conversation_type, and provenance', () => {
  const cid = mkClient()
  const res = applyMemory(cid, {
    buyer: { price_min: 250000, price_max: 400000, cities: ['Marion', 'Hiawatha'], beds: 3 },
    general: { motivation: 'relocating for work' },
  }, 'Buyer around $250-400k in Marion.', { source: 'ai', conversationType: 'buyer', confidence: 0.7 })

  assert.ok(res.changed.includes('price_min'))
  assert.equal(res.conversation_type, 'buyer')
  const row = li(cid)
  assert.equal(row.price_min, 250000)
  assert.equal(row.preferred_cities, 'Marion, Hiawatha')
  assert.equal(row.conversation_type, 'buyer')
  assert.equal(row.ai_summary, 'Buyer around $250-400k in Marion.')
  const p = prov(cid, 'price_min')
  assert.equal(p.source, 'ai')
  assert.ok(Math.abs(p.confidence - 0.7) < 1e-6)
  assert.ok(memoryFields(cid).length >= 4)
})

test('a stronger prior fact is NOT overwritten by a weaker guess', () => {
  const cid = mkClient()
  // Human-confirmed high-confidence price floor.
  applyMemory(cid, { buyer: { price_min: 300000 } }, null, { source: 'human', confidence: 0.95 })
  assert.equal(li(cid).price_min, 300000)
  // A low-confidence AI guess must not clobber it.
  const res = applyMemory(cid, { buyer: { price_min: 200000 } }, null, { source: 'ai', confidence: 0.5 })
  assert.ok(!res.changed.includes('price_min'))
  assert.equal(li(cid).price_min, 300000)
  assert.equal(prov(cid, 'price_min').source, 'human')
  // An equal-or-higher-confidence correction DOES apply.
  applyMemory(cid, { buyer: { price_min: 275000 } }, null, { source: 'human', confidence: 0.97 })
  assert.equal(li(cid).price_min, 275000)
})

test('per-field confidence map overrides the default', () => {
  const cid = mkClient()
  applyMemory(cid, { buyer: { beds: 4, baths: 2 }, confidence: { beds: 0.9 } }, null, { source: 'ai', confidence: 0.6 })
  assert.ok(Math.abs(prov(cid, 'bedrooms_min').confidence - 0.9) < 1e-6)
  assert.ok(Math.abs(prov(cid, 'bathrooms_min').confidence - 0.6) < 1e-6)
})
