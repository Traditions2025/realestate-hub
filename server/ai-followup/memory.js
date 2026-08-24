// HUB AI structured memory merge. Applies the model's per-turn `memory` object into
// lead_intelligence. Only fills/updates real values; blanks are ignored so a weak
// guess never wipes a known fact. Logs what changed.
//
// P1-2: also records per-field provenance (source / confidence / timestamp) in
// lead_memory_fields, and a single-word conversation_type classification. Provenance
// is confidence-gated: a low-confidence AI guess never overwrites a higher-confidence
// known fact of the same field.
import db from '../database.js'
const nowIso = () => new Date().toISOString()

// Map model memory fields → lead_intelligence columns (with light coercion).
const NUM = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n }
const BOOL = (v) => v === true || v === 1 || /^(yes|true|1|y)$/i.test(String(v)) ? 1 : (v === false || v === 0 || /^(no|false|0|n)$/i.test(String(v)) ? 0 : null)
const STR = (v) => { const s = String(v == null ? '' : v).trim(); return s || null }

const CONV_TYPES = ['buyer', 'seller', 'both', 'investor', 'renter', 'past_client', 'unknown']
export function normalizeConversationType(v) {
  const s = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (CONV_TYPES.includes(s)) return s
  if (s === 'buyer_seller' || s === 'seller_buyer') return 'both'
  if (s === 'investor_buyer') return 'investor'
  return null
}

// Record field-level provenance. Returns true if the write is accepted (equal or higher
// confidence than what's stored, or new), false if a stronger prior fact was kept.
function recordProvenance(cid, field, value, source, confidence) {
  const prev = db.get('SELECT confidence, value FROM lead_memory_fields WHERE client_id=? AND field=?', [cid, field])
  // A human/import fact is authoritative; the AI does not overwrite it with a lower-confidence guess.
  if (prev && prev.confidence != null && confidence < prev.confidence - 0.001) return false
  db.run(`INSERT INTO lead_memory_fields (client_id, field, value, source, confidence, updated_at)
          VALUES (?,?,?,?,?,?)
          ON CONFLICT(client_id, field) DO UPDATE SET value=excluded.value, source=excluded.source, confidence=excluded.confidence, updated_at=excluded.updated_at`,
    [cid, field, value == null ? null : String(value), source, confidence, nowIso()])
  return true
}

export function applyMemory(clientId, memory = {}, summary = null, opts = {}) {
  const cid = Number(clientId); if (!cid) return { changed: [] }
  const source = opts.source || 'ai'
  // Per-field confidence map from the model, if provided (memory.confidence: { field: 0..1 }).
  const confMap = (memory && typeof memory.confidence === 'object' && memory.confidence) || {}
  const defConf = typeof opts.confidence === 'number' ? opts.confidence : 0.6
  const b = memory.buyer || {}, s = memory.seller || {}, g = memory.general || {}
  const set = {}
  const put = (col, val, key) => {
    if (val === null || val === undefined || val === '') return
    const conf = typeof confMap[key] === 'number' ? confMap[key] : (typeof confMap[col] === 'number' ? confMap[col] : defConf)
    if (recordProvenance(cid, col, val, source, conf)) set[col] = val
  }
  put('price_min', NUM(b.price_min), 'price_min'); put('price_max', NUM(b.price_max), 'price_max')
  put('preferred_cities', STR(Array.isArray(b.cities) ? b.cities.join(', ') : b.cities), 'cities')
  put('bedrooms_min', NUM(b.beds), 'beds'); put('bathrooms_min', NUM(b.baths), 'baths')
  put('buying_timeframe', STR(b.timeframe), 'timeframe'); put('financing_status', STR(b.financing), 'financing')
  const pre = BOOL(b.preapproved); if (pre !== null && recordProvenance(cid, 'preapproved', pre, source, confMap.preapproved ?? defConf)) set.preapproved = pre
  const nts = BOOL(b.needs_to_sell); if (nts !== null && recordProvenance(cid, 'needs_to_sell_first', nts, source, confMap.needs_to_sell ?? defConf)) set.needs_to_sell_first = nts
  put('must_haves', STR(Array.isArray(b.must_haves) ? b.must_haves.join(', ') : b.must_haves), 'must_haves')
  put('deal_breakers', STR(Array.isArray(b.deal_breakers) ? b.deal_breakers.join(', ') : b.deal_breakers), 'deal_breakers')
  put('property_types', STR(Array.isArray(b.property_types) ? b.property_types.join(', ') : b.property_types), 'property_types')
  put('seller_property_address', STR(s.address), 'seller_address'); put('selling_timeframe', STR(s.timeframe), 'selling_timeframe')
  put('seller_motivation', STR(s.motivation), 'seller_motivation'); put('seller_condition_notes', STR(s.condition), 'seller_condition')
  put('seller_price_expectation', STR(s.price_expectation), 'seller_price_expectation')
  put('preferred_contact_method', STR(g.preferred_contact_method), 'preferred_contact_method'); put('preferred_contact_time', STR(g.preferred_contact_time), 'preferred_contact_time')
  const wwa = BOOL(g.working_with_agent); if (wwa !== null && recordProvenance(cid, 'working_with_agent', wwa, source, confMap.working_with_agent ?? defConf)) set.working_with_agent = wwa
  put('motivation_summary', STR(g.motivation), 'motivation')
  if (Array.isArray(g.objections) && g.objections.length) set.objections_json = JSON.stringify(g.objections)
  if (memory.lead_type) put('lead_type', STR(memory.lead_type), 'lead_type')
  const convType = normalizeConversationType(opts.conversationType || memory.conversation_type)
  if (convType) set.conversation_type = convType
  if (summary) set.ai_summary = STR(summary)

  const cols = Object.keys(set)
  if (!cols.length) return { changed: [], conversation_type: convType || null }
  // Upsert
  db.run('INSERT OR IGNORE INTO lead_intelligence (client_id) VALUES (?)', [cid])
  const assigns = cols.map(c => `${c}=?`).join(', ')
  db.run(`UPDATE lead_intelligence SET ${assigns}, last_extracted_at=?, updated_at=? WHERE client_id=?`, [...cols.map(c => set[c]), nowIso(), nowIso(), cid])
  return { changed: cols, conversation_type: convType || null }
}

// Read the provenance trail for a lead (most-recent first). Used by the profile UI to
// show where each fact came from and how sure we are.
export function memoryFields(clientId) {
  return db.all('SELECT field, value, source, confidence, updated_at FROM lead_memory_fields WHERE client_id=? ORDER BY updated_at DESC', [Number(clientId)])
}
