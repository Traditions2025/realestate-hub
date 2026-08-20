// HUB AI structured memory merge. Applies the model's per-turn `memory` object into
// lead_intelligence. Only fills/updates real values; blanks are ignored so a weak
// guess never wipes a known fact. Logs what changed.
import db from '../database.js'
const nowIso = () => new Date().toISOString()

// Map model memory fields → lead_intelligence columns (with light coercion).
const NUM = (v) => { const n = Number(String(v).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n }
const BOOL = (v) => v === true || v === 1 || /^(yes|true|1|y)$/i.test(String(v)) ? 1 : (v === false || v === 0 || /^(no|false|0|n)$/i.test(String(v)) ? 0 : null)
const STR = (v) => { const s = String(v == null ? '' : v).trim(); return s || null }

export function applyMemory(clientId, memory = {}, summary = null) {
  const cid = Number(clientId); if (!cid) return { changed: [] }
  const b = memory.buyer || {}, s = memory.seller || {}, g = memory.general || {}
  const set = {}
  const put = (col, val) => { if (val !== null && val !== undefined && val !== '') set[col] = val }
  put('price_min', NUM(b.price_min)); put('price_max', NUM(b.price_max))
  put('preferred_cities', STR(Array.isArray(b.cities) ? b.cities.join(', ') : b.cities))
  put('bedrooms_min', NUM(b.beds)); put('bathrooms_min', NUM(b.baths))
  put('buying_timeframe', STR(b.timeframe)); put('financing_status', STR(b.financing))
  const pre = BOOL(b.preapproved); if (pre !== null) set.preapproved = pre
  const nts = BOOL(b.needs_to_sell); if (nts !== null) set.needs_to_sell_first = nts
  put('must_haves', STR(Array.isArray(b.must_haves) ? b.must_haves.join(', ') : b.must_haves))
  put('deal_breakers', STR(Array.isArray(b.deal_breakers) ? b.deal_breakers.join(', ') : b.deal_breakers))
  put('property_types', STR(Array.isArray(b.property_types) ? b.property_types.join(', ') : b.property_types))
  put('seller_property_address', STR(s.address)); put('selling_timeframe', STR(s.timeframe))
  put('seller_motivation', STR(s.motivation)); put('seller_condition_notes', STR(s.condition))
  put('seller_price_expectation', STR(s.price_expectation))
  put('preferred_contact_method', STR(g.preferred_contact_method)); put('preferred_contact_time', STR(g.preferred_contact_time))
  const wwa = BOOL(g.working_with_agent); if (wwa !== null) set.working_with_agent = wwa
  put('motivation_summary', STR(g.motivation))
  if (Array.isArray(g.objections) && g.objections.length) set.objections_json = JSON.stringify(g.objections)
  if (memory.lead_type) put('lead_type', STR(memory.lead_type))
  if (summary) set.ai_summary = STR(summary)

  const cols = Object.keys(set)
  if (!cols.length) return { changed: [] }
  // Upsert
  db.run('INSERT OR IGNORE INTO lead_intelligence (client_id) VALUES (?)', [cid])
  const assigns = cols.map(c => `${c}=?`).join(', ')
  db.run(`UPDATE lead_intelligence SET ${assigns}, last_extracted_at=?, updated_at=? WHERE client_id=?`, [...cols.map(c => set[c]), nowIso(), nowIso(), cid])
  return { changed: cols }
}
