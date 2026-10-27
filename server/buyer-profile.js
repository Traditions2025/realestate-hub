// BUYER ANSWER STORE (John, 2026-10-27 — Part 37 step 3).
//
// What a buyer has actually told us, so a later message can read it instead of asking
// again. Without this the whole of Phase 2 is dead text: every "if the answer is known"
// branch has nothing to read, and the sequence asks about an area they named months ago.
//
// A fact is NOT just a value. "Marion" said on the phone last week and "Marion" inferred
// from browsing six months ago are not the same thing, and only one of them is safe to
// quote back. So every fact carries where it came from, when, and how sure we are.
//
// APPEND ONLY. A preference that changes does not overwrite the old answer — the old row
// is marked superseded and a new current row is written. That is what gives the Hub real
// history: "Marion in May, Solon in October" stays answerable, and the pair of them is
// worth more than either on its own.
//
// Its own table rather than columns on `clients`: per-fact capture dates, confidence and
// supersession cannot live in a flat column set. Treat this table as the source of truth.
import db from './database.js'

const nowIso = () => new Date().toISOString()

// Controlled vocabulary. Deliberately closed, so the store never ends up holding
// preferred_area, preferred_location, location_preference and area all meaning one thing.
export const FACT_TYPES = [
  // search profile
  'preferred_location', 'secondary_locations', 'price_min', 'price_max', 'property_type',
  'beds_min', 'baths_min', 'garage', 'lot_acreage', 'must_haves', 'nice_to_haves',
  'deal_breakers', 'school_district', 'other_preferences',
  // sale dependency
  'home_to_sell', 'current_home_address', 'estimated_value', 'need_proceeds',
  // timing + financing
  'timing', 'financing',
  // communication
  'preferred_contact',
]

export const CONFIDENCE = ['confirmed', 'inferred', 'stale', 'unknown']
export const SOURCE_TYPES = ['sms_reply', 'call', 'email', 'form', 'website', 'inferred', 'agent', 'import']

// How long a fact stays quotable, in days. Past this it is not wrong, just no longer safe
// to assert: the message switches from "what area?" to "still Marion?".
// null = does not go stale on its own.
const FRESH_DAYS = {
  preferred_location: 180,
  secondary_locations: 180,
  price_min: 90,          // moves with rates and with what they have seen
  price_max: 90,
  property_type: 270,
  beds_min: 270,
  baths_min: 270,
  garage: 270,
  lot_acreage: 270,
  must_haves: 270,
  nice_to_haves: 270,
  deal_breakers: 270,
  school_district: 365,
  other_preferences: 270,
  home_to_sell: null,     // owning a house to sell does not expire
  current_home_address: null,
  estimated_value: 180,
  need_proceeds: 365,
  timing: 120,            // the most perishable thing a buyer tells us
  financing: 180,
  preferred_contact: null,
}

let ready = false
export function initBuyerProfile() {
  if (ready) return
  db.run(`CREATE TABLE IF NOT EXISTS buyer_facts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id        INTEGER NOT NULL,
    fact_type        TEXT    NOT NULL,
    value            TEXT    NOT NULL,
    source_type      TEXT,
    source_reference TEXT,
    confidence       TEXT    NOT NULL DEFAULT 'confirmed',
    captured_at      TEXT    NOT NULL,
    is_current       INTEGER NOT NULL DEFAULT 1,
    superseded_at    TEXT,
    notes            TEXT
  )`)
  db.run('CREATE INDEX IF NOT EXISTS idx_bf_client ON buyer_facts(client_id)')
  // The lookup every send does: this lead, this fact, the one that is current.
  db.run('CREATE INDEX IF NOT EXISTS idx_bf_current ON buyer_facts(client_id, fact_type, is_current)')
  ready = true
}

const clean = (v) => {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim()
  return s.length > 400 ? s.slice(0, 400) : s
}

/**
 * Record something a buyer told us.
 *
 * Same value again      -> refreshes captured_at on the current row. Re-confirmation makes
 *                          a fact fresher; it is not a change and leaves no history noise.
 * Different value       -> old row superseded, new current row written.
 * Inferred vs confirmed -> an inferred guess never supersedes something they said out loud.
 */
export function setFact(clientId, factType, value, {
  source = 'sms_reply', sourceRef = null, confidence = 'confirmed', at = null, notes = null,
} = {}) {
  initBuyerProfile()
  const cid = Number(clientId)
  if (!cid || !FACT_TYPES.includes(factType)) return { ok: false, reason: `unknown fact_type ${factType}` }
  const v = clean(value)
  if (!v) return { ok: false, reason: 'empty value' }
  const conf = CONFIDENCE.includes(confidence) ? confidence : 'confirmed'
  const when = at || nowIso()

  const cur = db.get('SELECT * FROM buyer_facts WHERE client_id=? AND fact_type=? AND is_current=1 ORDER BY id DESC LIMIT 1', [cid, factType])

  if (cur && clean(cur.value).toLowerCase() === v.toLowerCase()) {
    db.run('UPDATE buyer_facts SET captured_at=?, source_type=?, source_reference=?, confidence=? WHERE id=?',
      [when, source, sourceRef, conf === 'inferred' && cur.confidence === 'confirmed' ? 'confirmed' : conf, cur.id])
    return { ok: true, fact_type: factType, value: v, changed: false, reconfirmed: true }
  }

  if (cur && cur.confidence === 'confirmed' && conf === 'inferred') {
    return { ok: false, reason: 'a confirmed answer already exists; an inferred one will not supersede it', kept: cur.value }
  }

  if (cur) {
    db.run('UPDATE buyer_facts SET is_current=0, superseded_at=? WHERE id=?', [nowIso(), cur.id])
  }
  db.run(`INSERT INTO buyer_facts (client_id, fact_type, value, source_type, source_reference, confidence, captured_at, is_current, notes)
          VALUES (?,?,?,?,?,?,?,1,?)`, [cid, factType, v, source, sourceRef, conf, when, notes])
  return { ok: true, fact_type: factType, value: v, changed: true, superseded: cur ? cur.value : null }
}

function withStaleness(row) {
  if (!row) return null
  const days = FRESH_DAYS[row.fact_type]
  const ageDays = (Date.now() - new Date(row.captured_at).getTime()) / 86400000
  const stale = days != null && ageDays > days
  return { ...row, age_days: Math.round(ageDays), stale, confidence: stale ? 'stale' : row.confidence }
}

/** Every current fact, keyed by fact_type. */
export function getProfile(clientId) {
  initBuyerProfile()
  const out = {}
  for (const r of db.all('SELECT * FROM buyer_facts WHERE client_id=? AND is_current=1', [Number(clientId)])) {
    out[r.fact_type] = withStaleness(r)
  }
  return out
}

export function getFact(clientId, factType) {
  initBuyerProfile()
  return withStaleness(db.get('SELECT * FROM buyer_facts WHERE client_id=? AND fact_type=? AND is_current=1 ORDER BY id DESC LIMIT 1',
    [Number(clientId), factType]))
}

/**
 * What the nurture actually needs to know before asking a question:
 *   'unknown'  nothing on file           -> ask the plain question
 *   'fresh'    known and still quotable  -> skip it, or ask a confirmation variant
 *   'stale'    known but old             -> ask "is it still X?", never "what is X?"
 */
export function factState(clientId, factType) {
  const f = getFact(clientId, factType)
  if (!f) return { state: 'unknown', value: null }
  return { state: f.stale ? 'stale' : 'fresh', value: f.value, confidence: f.confidence, age_days: f.age_days, source: f.source_type }
}

/** Which topics still have no answer — what is left worth asking. */
export function unansweredFactTypes(clientId, candidates = FACT_TYPES) {
  const p = getProfile(clientId)
  return candidates.filter(f => !p[f])
}

/** Everything ever recorded for a lead, newest first. Superseded rows included. */
export function factHistory(clientId, factType = null, limit = 100) {
  initBuyerProfile()
  return factType
    ? db.all('SELECT * FROM buyer_facts WHERE client_id=? AND fact_type=? ORDER BY id DESC LIMIT ?', [Number(clientId), factType, Number(limit)])
    : db.all('SELECT * FROM buyer_facts WHERE client_id=? ORDER BY id DESC LIMIT ?', [Number(clientId), Number(limit)])
}

/** One line for an AI prompt or an agent view. */
export function profileSummary(clientId) {
  const p = getProfile(clientId)
  const bits = []
  const add = (label, f) => { if (p[f]) bits.push(`${label} ${p[f].value}${p[f].stale ? ' (stale)' : ''}`) }
  add('area', 'preferred_location')
  if (p.price_min || p.price_max) bits.push(`budget ${p.price_min?.value || '?'}-${p.price_max?.value || '?'}`)
  add('type', 'property_type')
  add('beds', 'beds_min')
  add('baths', 'baths_min')
  add('lot', 'lot_acreage')
  add('must have', 'must_haves')
  add('timing', 'timing')
  add('financing', 'financing')
  if (p.home_to_sell) bits.push(`home to sell: ${p.home_to_sell.value}`)
  return bits.join(' · ')
}
