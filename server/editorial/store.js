// Persistence for the editorial engine: runs, version history, the reference library,
// team rules (with audit history) and feedback.
import db from '../database.js'
import { FEEDBACK_PRESETS } from './rules.js'

const J = (v) => (v === undefined ? null : JSON.stringify(v))
const P = (s, fb = null) => { if (!s) return fb; try { return JSON.parse(s) } catch { return fb } }
const now = () => new Date().toISOString()

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------
export function createRun({ listingId, channel, settings, factsHash, model, user }) {
  const r = db.run(
    'INSERT INTO editorial_runs (listing_id, channel, status, stage, settings, facts_hash, model, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [listingId, channel, 'running', 'analysis', J(settings), factsHash, model, user || null])
  return Number(r.lastInsertRowid)
}

export function updateRun(id, fields) {
  const keys = Object.keys(fields)
  if (!keys.length) return
  const vals = keys.map(k => (['settings', 'analysis', 'drafts', 'review', 'rewrite', 'verification', 'final'].includes(k) ? J(fields[k]) : fields[k]))
  db.run(`UPDATE editorial_runs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...vals, id])
}

export function getRun(id) {
  const r = db.get('SELECT * FROM editorial_runs WHERE id = ?', [Number(id)])
  if (!r) return null
  for (const k of ['settings', 'analysis', 'drafts', 'review', 'rewrite', 'verification', 'final']) r[k] = P(r[k])
  return r
}

export function latestRun(listingId, channel, { status = 'done' } = {}) {
  const r = db.get('SELECT id FROM editorial_runs WHERE listing_id = ? AND channel = ? AND status = ? ORDER BY id DESC LIMIT 1', [Number(listingId), channel, status])
  return r ? getRun(r.id) : null
}

// Most recent analysis for this exact fact sheet, any channel. Lets social/email reuse the
// MLS analysis instead of paying for it again.
export function cachedAnalysis(listingId, factsHash) {
  const r = db.get(`SELECT analysis FROM editorial_runs WHERE listing_id = ? AND facts_hash = ? AND analysis IS NOT NULL
                    ORDER BY id DESC LIMIT 1`, [Number(listingId), factsHash])
  return r ? P(r.analysis) : null
}

// ---------------------------------------------------------------------------
// Versions (restore previous)
// ---------------------------------------------------------------------------
export function addVersion({ listingId, channel, content, source, label = null, runId = null, user = null }) {
  if (!content || !String(content).trim()) return null
  const last = db.get('SELECT content FROM editorial_versions WHERE listing_id = ? AND channel = ? ORDER BY id DESC LIMIT 1', [Number(listingId), channel])
  if (last && last.content === content) return null
  const r = db.run('INSERT INTO editorial_versions (listing_id, channel, content, source, version_label, run_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(listingId), channel, content, source, label, runId, user])
  return Number(r.lastInsertRowid)
}

export function listVersions(listingId, channel, limit = 30) {
  return db.all('SELECT id, channel, source, version_label, run_id, created_by, created_at, content FROM editorial_versions WHERE listing_id = ? AND channel = ? ORDER BY id DESC LIMIT ?',
    [Number(listingId), channel, limit])
}

export function getVersion(id) {
  return db.get('SELECT * FROM editorial_versions WHERE id = ?', [Number(id)])
}

export function lastAiVersion(listingId, channel) {
  return db.get("SELECT * FROM editorial_versions WHERE listing_id = ? AND channel = ? AND source = 'ai' ORDER BY id DESC LIMIT 1", [Number(listingId), channel])
}

// ---------------------------------------------------------------------------
// Reference library
// ---------------------------------------------------------------------------
export const LIBRARY_LABELS = ['excellent', 'acceptable', 'needs_improvement', 'do_not_imitate']

export function addLibraryEntry(e) {
  const label = LIBRARY_LABELS.includes(e.label) ? e.label : 'acceptable'
  const r = db.run(`INSERT INTO editorial_library (listing_id, channel, property_type, price_positioning, key_characteristics, tone,
      approved_text, original_draft, human_edits, edit_reasons, label, approved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [e.listing_id || null, e.channel || 'mls', e.property_type || null, e.price_positioning || null, e.key_characteristics || null, e.tone || null,
    e.approved_text, e.original_draft || null, e.human_edits || null, e.edit_reasons || null, label, e.approved_by || null])
  return Number(r.lastInsertRowid)
}

export function updateLibraryEntry(id, fields) {
  const allowed = ['label', 'edit_reasons', 'property_type', 'price_positioning', 'key_characteristics', 'tone', 'approved_text']
  const keys = Object.keys(fields).filter(k => allowed.includes(k))
  if (fields.label && !LIBRARY_LABELS.includes(fields.label)) throw new Error('invalid label')
  if (!keys.length) return
  db.run(`UPDATE editorial_library SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, [...keys.map(k => fields[k]), now(), Number(id)])
}

export function deleteLibraryEntry(id) { db.run('DELETE FROM editorial_library WHERE id = ?', [Number(id)]) }

export function listLibrary({ channel, label } = {}) {
  let sql = 'SELECT * FROM editorial_library WHERE 1=1'
  const p = []
  if (channel) { sql += ' AND channel = ?'; p.push(channel) }
  if (label) { sql += ' AND label = ?'; p.push(label) }
  return db.all(sql + ' ORDER BY approved_at DESC, id DESC', p)
}

const typeKey = (t) => {
  const s = String(t || '').toLowerCase()
  if (/condo|town/.test(s)) return 'attached'
  if (/multi|duplex|triplex|fourplex|investment/.test(s)) return 'multi'
  if (/acre|farm|rural|land/.test(s)) return 'rural'
  if (/new/.test(s)) return 'new'
  return 'single'
}

// Pick style references for a draft: up to 3 good examples, nearest property type and
// positioning first, most recent first; plus up to 2 "do not imitate" examples.
export function pickExamples({ channel = 'mls', propertyType, positioning = [] }) {
  const rows = db.all("SELECT * FROM editorial_library WHERE channel = ? AND label IN ('excellent','acceptable','do_not_imitate') ORDER BY approved_at DESC, id DESC LIMIT 200", [channel])
  const tk = typeKey(propertyType)
  const pos = new Set(positioning.map(p => String(p).toLowerCase()))
  const score = (r) => (r.label === 'excellent' ? 3 : 1) + (typeKey(r.property_type) === tk ? 3 : 0) +
    (String(r.price_positioning || '').toLowerCase().split(/\s*[;,]\s*/).some(x => pos.has(x)) ? 2 : 0)
  const good = rows.filter(r => r.label !== 'do_not_imitate').map(r => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s).slice(0, 3).map(x => x.r)
  const avoid = rows.filter(r => r.label === 'do_not_imitate').slice(0, 2)
  return { examples: good, avoidExamples: avoid }
}

// ---------------------------------------------------------------------------
// Rules (+ audit history)
// ---------------------------------------------------------------------------
function ruleHistory(ruleId, action, before, after, reason, user) {
  db.run('INSERT INTO editorial_rule_history (rule_id, action, before_json, after_json, reason, changed_by) VALUES (?, ?, ?, ?, ?, ?)',
    [ruleId, action, J(before), J(after), reason || null, user || null])
}

export function listRules({ activeOnly = false, channel } = {}) {
  let rows = db.all(`SELECT * FROM editorial_rules ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY id`)
  if (channel) rows = rows.filter(r => !r.channel || r.channel === channel)
  return rows
}

export function getRule(id) { return db.get('SELECT * FROM editorial_rules WHERE id = ?', [Number(id)]) }

export function createRule({ rule_text, kind = 'guidance', pattern = null, channel = null, source = 'manual', feedback_key = null, reason, user }) {
  if (!rule_text || !String(rule_text).trim()) throw new Error('rule_text required')
  if (!['guidance', 'avoid_phrase'].includes(kind)) throw new Error('kind must be guidance or avoid_phrase')
  if (kind === 'avoid_phrase' && !pattern) throw new Error('avoid_phrase rules need a pattern')
  const r = db.run('INSERT INTO editorial_rules (rule_text, kind, pattern, channel, source, feedback_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [String(rule_text).trim(), kind, pattern, channel, source, feedback_key, user || null])
  const id = Number(r.lastInsertRowid)
  ruleHistory(id, 'created', null, getRule(id), reason, user)
  return id
}

export function updateRule(id, fields, { reason, user } = {}) {
  const before = getRule(id)
  if (!before) throw new Error('rule not found')
  const allowed = ['rule_text', 'kind', 'pattern', 'channel', 'active']
  const keys = Object.keys(fields).filter(k => allowed.includes(k))
  if (!keys.length) return before
  db.run(`UPDATE editorial_rules SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    [...keys.map(k => (k === 'active' ? (fields[k] ? 1 : 0) : fields[k])), now(), Number(id)])
  const after = getRule(id)
  ruleHistory(Number(id), 'active' in fields && keys.length === 1 ? (fields.active ? 'enabled' : 'disabled') : 'edited', before, after, reason, user)
  return after
}

export function ruleHistoryList(limit = 100) {
  return db.all(`SELECT h.*, r.rule_text FROM editorial_rule_history h LEFT JOIN editorial_rules r ON r.id = h.rule_id ORDER BY h.id DESC LIMIT ?`, [limit])
}

// ---------------------------------------------------------------------------
// Feedback -> rules
// ---------------------------------------------------------------------------
export function feedbackKey(text) {
  const preset = FEEDBACK_PRESETS.find(p => p.text.toLowerCase() === String(text).trim().toLowerCase() || p.key === text)
  if (preset) return preset.key
  return String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

export function addFeedback({ listingId, runId, channel, text, user }) {
  const key = feedbackKey(text)
  const preset = FEEDBACK_PRESETS.find(p => p.key === key)
  db.run('INSERT INTO editorial_feedback (listing_id, run_id, channel, feedback_key, text, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [listingId || null, runId || null, channel || null, key, preset ? preset.text : String(text).trim(), user || null])
  return key
}

// Recurring feedback that has not become a rule yet. threshold = how many times before the
// UI suggests adopting it.
export function feedbackSummary({ threshold = 3 } = {}) {
  const rows = db.all(`SELECT feedback_key, MAX(text) AS text, COUNT(*) AS n, MAX(created_at) AS last_at
                       FROM editorial_feedback GROUP BY feedback_key ORDER BY n DESC, last_at DESC`)
  const ruled = new Set(db.all('SELECT feedback_key FROM editorial_rules WHERE feedback_key IS NOT NULL').map(r => r.feedback_key))
  return rows.map(r => {
    const preset = FEEDBACK_PRESETS.find(p => p.key === r.feedback_key)
    return {
      ...r,
      has_rule: ruled.has(r.feedback_key),
      suggest_rule: !ruled.has(r.feedback_key) && r.n >= threshold,
      proposed_rule: preset?.rule || `Team feedback: ${r.text}`,
      proposed_kind: preset?.avoid ? 'avoid_phrase' : 'guidance',
      proposed_pattern: preset?.avoid ? preset.avoid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null,
    }
  })
}
