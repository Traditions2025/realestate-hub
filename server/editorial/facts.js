// The verified fact sheet: the only source of truth the writer may use.
//
// Deliberately EXCLUDED: seller_name/phone/email, notes (internal), original_list_price
// outside the price channel, client/transaction links. Internal notes are where agents put
// what a seller said privately (net floor, why they are moving), and that must never reach
// public copy. Only fields that describe the property, plus the marketing-safe
// `marketing_facts` box the agent fills in for writing, go in.
import crypto from 'node:crypto'

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

export function bathsLabel(l) {
  const full = num(l.bathrooms_full) || 0
  const half = num(l.bathrooms_half) || 0
  if (!full && !half) return null
  return half ? `${full} full and ${half} half` : `${full} full`
}

/**
 * @returns {{ lines: string[], text: string, hash: string, record: object }}
 */
export function buildFactSheet(l, controls = {}) {
  const features = Array.isArray(l.features) ? l.features : (() => { try { return JSON.parse(l.features || '[]') } catch { return [] } })()
  const exclude = (controls.exclude || []).map(s => String(s).toLowerCase().trim()).filter(Boolean)
  const keep = (s) => !exclude.some(x => String(s).toLowerCase().includes(x))

  const record = {
    city: l.city || null,
    state: l.state || 'IA',
    street_address: l.property_address || null,
    property_type: l.property_type || null,
    list_price: num(l.list_price),
    bedrooms: num(l.bedrooms),
    bathrooms: bathsLabel(l),
    square_feet: num(l.square_feet),
    lot_size: l.lot_size || null,
    year_built: num(l.year_built),
    stories: num(l.stories),
    garage_spaces: num(l.garage_spaces),
    basement: l.basement || null,
    heating: l.heating || null,
    cooling: l.cooling || null,
    flooring: l.flooring || null,
    schools: l.schools || null,
    hoa: l.hoa_fee ? `$${l.hoa_fee}/${l.hoa_frequency || 'month'}` : null,
    annual_taxes: num(l.taxes),
    features: features.filter(keep),
    agent_verified_details: l.marketing_facts || null,
    existing_public_remarks: l.description || null,
    dossier: (() => { try { return l.marketing_dossier ? JSON.parse(l.marketing_dossier) : null } catch { return null } })(),
  }
  const dz = record.dossier
  if (dz && !record.existing_public_remarks && dz.remarks_on_file?.length) record.existing_public_remarks = dz.remarks_on_file[0].text

  const lines = []
  const push = (k, v) => { if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) lines.push(`${k}: ${Array.isArray(v) ? v.join('; ') : v}`) }
  push('Street address', record.street_address)
  push('City', record.city ? `${record.city}, ${record.state}` : null)
  push('Property type', record.property_type)
  push('List price', record.list_price ? `$${record.list_price.toLocaleString('en-US')}` : null)
  push('Bedrooms', record.bedrooms)
  push('Bathrooms', record.bathrooms)
  push('Finished square feet', record.square_feet ? record.square_feet.toLocaleString('en-US') : null)
  push('Lot size', record.lot_size)
  push('Year built', record.year_built)
  push('Stories', record.stories)
  push('Garage', record.garage_spaces ? `${record.garage_spaces}-car` : null)
  push('Basement', record.basement)
  push('Heating', record.heating)
  push('Cooling', record.cooling)
  push('Flooring', record.flooring)
  push('Schools (as listed)', record.schools)
  push('HOA', record.hoa)
  push('Annual taxes', record.annual_taxes ? `$${record.annual_taxes.toLocaleString('en-US')}` : null)
  push('Listed features', record.features)
  push('Agent-verified details (updates, years, materials, setting)', record.agent_verified_details)
  if (dz) {
    const cur = (dz.facts || []).filter(f => !f.outdated && keep(f.text)).map(f => `${f.text} [${f.source}]`)
    const old = (dz.facts || []).filter(f => f.outdated && keep(f.text)).map(f => `${f.text} [${f.source}]`)
    push("From the team's files", cur)
    push("From the team's files but possibly outdated (older listing or record; use only if nothing contradicts it)", old)
    push('Clearly visible in the listing photos', (dz.photo_features || []).filter(f => keep(f.text)).map(f => f.text))
    push('Better shown in the photos than described', dz.photo_led)
    push('Sources disagree on (do not state these figures; ask the agent)', dz.conflicts)
  }
  push('Public remarks on file (may be from an earlier sale or another agent; use only facts the rest of this record does not contradict, never reuse wording)', record.existing_public_remarks)

  const text = lines.join('\n')
  const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)
  return { lines, text, hash, record }
}

// What the editor sees about the controls, in prompt form.
export function controlsForPrompt(c = {}) {
  const out = []
  if (c.emphasize?.length) out.push(`Emphasize (if verified): ${c.emphasize.join('; ')}`)
  if (c.exclude?.length) out.push(`Do not mention: ${c.exclude.join('; ')}`)
  if (c.angle && c.angle !== 'auto') out.push(`Primary marketing angle requested: ${c.angle}`)
  if (c.opening && c.opening !== 'auto') out.push(`Preferred opening approach: ${c.opening}`)
  if (c.instructions) out.push(`Agent's note for this run: ${c.instructions}`)
  return out.length ? out.join('\n') : '(none; make the editorial decisions yourself)'
}

export function parseList(v) {
  if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean)
  return String(v || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
}
