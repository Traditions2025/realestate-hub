// INBOUND REPLY PARSING (John, 2026-10-27 — Part 37 step 4).
//
// Turn "We want something NE, 2 acres or more, at least 3 bedrooms and 2 baths. Wood
// fireplace would be nice." into stored fields, so nobody has to fill in a questionnaire
// and the next message can read what they said.
//
// Biased hard towards MISSING things rather than guessing. A wrong fact is worse than no
// fact: it gets quoted back ("still looking around Marion?") to someone who never said it,
// and that reads worse than simply asking. Everything here is confirmed-confidence only
// when the lead stated it plainly; anything softer is left for a human.
import { setFact } from './buyer-profile.js'

const norm = (s) => String(s || '')
  .replace(/[‘’�]/g, "'").replace(/[“”]/g, '"')
  .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()

// Towns and areas the team actually works. A bare word only becomes a location if it is
// on this list - otherwise "we looked at a ranch in good condition" turns into a town.
const AREAS = [
  'cedar rapids', 'marion', 'hiawatha', 'robins', 'ely', 'solon', 'swisher', 'shueyville',
  'north liberty', 'fairfax', 'walford', 'atkins', 'palo', 'center point', 'urbana',
  'alburnett', 'springville', 'mount vernon', 'lisbon', 'central city', 'coggon',
  'troy mills', 'prairieburg', 'anamosa', 'iowa city', 'tiffin', 'bertram', 'linn county',
]
const QUADRANTS = ['ne', 'nw', 'se', 'sw', 'northeast', 'northwest', 'southeast', 'southwest']

const PROPERTY_TYPES = [
  ['ranch', 'ranch'], ['two story', 'two-story'], ['two-story', 'two-story'], ['2 story', 'two-story'],
  ['split level', 'split level'], ['split-level', 'split level'], ['condo', 'condo'],
  ['townhouse', 'townhouse'], ['town home', 'townhouse'], ['acreage', 'acreage'],
  ['new construction', 'new construction'], ['newer', 'newer'], ['bungalow', 'bungalow'],
]

// "$300k", "300k", "$300,000", "300-450k"
function money(tok) {
  const t = String(tok).replace(/[$,\s]/g, '').toLowerCase()
  let m = t.match(/^(\d+(?:\.\d+)?)k$/)
  if (m) return Math.round(Number(m[1]) * 1000)
  m = t.match(/^(\d+(?:\.\d+)?)m$/)
  if (m) return Math.round(Number(m[1]) * 1000000)
  m = t.match(/^(\d{3,7})$/)
  if (m) {
    const n = Number(m[1])
    // 300 means $300k in conversation; 300000 means itself.
    if (n >= 50000) return n
    if (n >= 100 && n <= 999) return n * 1000
  }
  return null
}

export function parseBuyerReply(body) {
  const raw = norm(body)
  const s = raw.toLowerCase()
  const out = {}
  if (!s || s.length < 2) return out

  // ---- price range ----------------------------------------------------------
  // A range first, so "300-450k" is not read as a single number.
  let m = s.match(/\$?\s*(\d[\d,.]*\s*[km]?)\s*(?:-|to|through|up to)\s*\$?\s*(\d[\d,.]*\s*[km]?)/)
  if (m) {
    const lo = money(m[1]), hi = money(m[2])
    if (lo && hi && hi > lo && lo >= 50000 && hi <= 5000000) { out.price_min = String(lo); out.price_max = String(hi) }
  }
  if (!out.price_max) {
    m = s.match(/(?:under|below|less than|max(?:imum)?(?: of)?|up to|no more than|budget(?: of| is| around)?)\s*\$?\s*(\d[\d,.]*\s*[km]?)/)
    if (m) { const v = money(m[1]); if (v && v >= 50000 && v <= 5000000) out.price_max = String(v) }
  }
  if (!out.price_min && !out.price_max) {
    m = s.match(/(?:around|about|roughly|near|approximately)\s*\$?\s*(\d[\d,.]*\s*[km]?)/)
    if (m) { const v = money(m[1]); if (v && v >= 50000 && v <= 5000000) { out.price_min = String(Math.round(v * 0.9)); out.price_max = String(Math.round(v * 1.1)) } }
  }

  // ---- beds / baths ---------------------------------------------------------
  m = s.match(/(\d)\s*\+?\s*(?:bed|bedroom|br|bdrm)/)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 9) out.beds_min = m[1]
  m = s.match(/(\d(?:\.5)?)\s*\+?\s*(?:bath|bathroom|ba\b)/)
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 9) out.baths_min = m[1]

  // ---- lot / acreage --------------------------------------------------------
  m = s.match(/(\d+(?:\.\d+)?)\s*\+?\s*acre/)
  if (m) out.lot_acreage = `${m[1]}+ acres`
  else if (/\bacreage\b|\bsome land\b|\ba little land\b/.test(s)) out.lot_acreage = 'acreage wanted'

  // ---- garage ---------------------------------------------------------------
  m = s.match(/(\d)\s*(?:-|\s)?\s*(?:stall|car)\s*garage/)
  if (m) out.garage = `${m[1]}-stall`
  else if (/\bno garage\b/.test(s)) out.garage = 'none needed'

  // ---- location -------------------------------------------------------------
  const hits = AREAS.filter(a => new RegExp(`\\b${a.replace(/ /g, '\\s+')}\\b`).test(s))
  if (hits.length) {
    const title = (x) => x.replace(/\b\w/g, c => c.toUpperCase())
    out.preferred_location = title(hits[0])
    if (hits.length > 1) out.secondary_locations = hits.slice(1).map(title).join(', ')
  } else {
    // A bare quadrant only counts next to a place-ish word, so "NE" in "NE corner of the
    // kitchen" does not become their search area.
    const q = s.match(new RegExp(`\\b(${QUADRANTS.join('|')})\\b\\s*(?:side|part|area|of town|cedar rapids|cr)?`))
    if (q && /\b(side|part|area|of town|cedar rapids|cr)\b/.test(q[0])) out.preferred_location = q[1].toUpperCase()
    else if (q && /\b(looking|want|prefer|stay|move|focus)\w*\b[^.]{0,20}$/.test(s.slice(0, q.index))) out.preferred_location = q[1].toUpperCase()
  }

  // ---- property type --------------------------------------------------------
  for (const [needle, label] of PROPERTY_TYPES) {
    if (new RegExp(`\\b${needle.replace(/ /g, '\\s+')}\\b`).test(s)) { out.property_type = label; break }
  }

  // ---- home to sell ---------------------------------------------------------
  if (/\b(?:we|i)\s+(?:have|own|would have|'d have)\s+(?:a\s+)?(?:house|home|place|property)\s+(?:to\s+sell|we'd need to sell|that would need)/.test(s)
    || /\b(?:need|have)\s+to\s+sell\s+(?:our|my|the)\s+(?:house|home|place|current)/.test(s)
    || /\byes[, ].{0,30}\bsell\b.{0,20}\b(?:first|house|home)\b/.test(s)) out.home_to_sell = 'Yes'
  else if (/\b(?:no|nope|nothing)\b[^.]{0,25}\b(?:to sell|house to sell|home to sell)\b/.test(s)
    || /\bwe\s+(?:rent|are renting|'re renting)\b/.test(s)) out.home_to_sell = 'No'

  // ---- timing ---------------------------------------------------------------
  if (/\b(?:right now|immediately|asap|as soon as possible|actively looking|started looking again)\b/.test(s)) out.timing = 'now'
  else if (/\b(?:next|within|in)\s*(?:1|2|3|a few|couple(?: of)?)\s*months?\b/.test(s) || /\bthis spring\b|\bthis summer\b/.test(s)) out.timing = '0-3 months'
  else if (/\b(?:3|4|5|6)\s*(?:-|to)\s*(?:6|9|12)\s*months?\b/.test(s) || /\b(?:later|end of)\s+(?:this\s+)?year\b/.test(s)) out.timing = '3-6 months'
  else if (/\bnext year\b|\b(?:6|7|8|9|10|11|12)\s*(?:-|to)?\s*12\s*months?\b/.test(s)) out.timing = '6-12 months'
  else if (/\b(?:a year|two years|couple of years|few years)\s+(?:or so\s+)?(?:out|away|from now)\b/.test(s) || /\b12\+?\s*months\b/.test(s)) out.timing = '12+ months'
  else if (/\b(?:only|just)\s+if\b[^.]{0,30}\b(?:right|perfect)\b/.test(s) || /\bif the right (?:one|home|house|place)\b/.test(s)) out.timing = 'right home only'

  // ---- financing ------------------------------------------------------------
  if (/\bpre-?approved\b|\bpre-?qualified\b/.test(s)) out.financing = 'preapproved'
  else if (/\b(?:cash|paying cash|all cash)\b/.test(s)) out.financing = 'cash'
  else if (/\b(?:talked|spoke|working)\s+(?:to|with)\s+(?:a\s+)?(?:lender|bank|mortgage|loan officer)\b/.test(s)) out.financing = 'lender identified'
  else if (/\b(?:haven't|have not|not yet|no)\b[^.]{0,30}\b(?:lender|pre-?approved|financing|bank)\b/.test(s)) out.financing = 'not started'

  // ---- nice to have ---------------------------------------------------------
  m = raw.match(/([A-Za-z][\w\s-]{2,40}?)\s+(?:would be|'?d be)\s+(?:nice|great|a bonus|ideal)/i)
  if (m) out.nice_to_haves = m[1].trim().toLowerCase()
  // ---- must have ------------------------------------------------------------
  m = raw.match(/(?:has to have|must have|needs? to have|absolutely needs?|deal ?breaker(?: is)?|non-?negotiable(?: is)?)\s+(?:an?\s+)?([\w\s-]{2,45})/i)
  if (m) out.must_haves = m[1].trim().toLowerCase().replace(/[.,!?]+$/, '')

  return out
}

/**
 * Parse a reply and store whatever it yielded. Returns what was written, so the caller
 * can log it or show it to an agent.
 */
export function captureBuyerReply(clientId, body, { source = 'sms_reply', at = null } = {}) {
  const found = parseBuyerReply(body)
  const stored = {}
  const skipped = {}
  for (const [field, value] of Object.entries(found)) {
    const r = setFact(clientId, field, value, { source, confidence: 'confirmed', at })
    if (r.ok) stored[field] = value
    else skipped[field] = r.reason
  }
  return { found, stored, skipped }
}
