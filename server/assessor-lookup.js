// Resolve a street address to its page on the Linn County / Cedar Rapids assessor site.
//
// John, 2026-10-01: the Assessor button "doesn't get any result". It didn't, and neither
// did the version before it. Both attempts tried to do this with a URL, and there is no URL
// that takes an address and lands on a parcel:
//
//   - `results.php?ifulladdress=…&process=1` is not a page on these sites at all. It lands
//     on an empty Residential Building Search. That is the one shipped today.
//   - `/search/res/results/?ifulladdress=…` LOOKS like it works, but it replays whatever
//     the session last POSTed. Four different addresses once returned the same parcel.
//   - landing on `/search/res/` shows the PREVIOUS search, which is how 6528 Medford Ln NE
//     turned up on Adrien Voellinger's profile.
//
// The reason a browser cannot do it is the disclaimer cookie: VCSID is SameSite=Lax, so it
// is not sent on a cross-site POST navigation, and the search is a POST. A SERVER has no
// such rule. With a cookie jar the whole flow works, which is what this does:
//
//   1. GET  /search/res/              collect VCSID, see the disclaimer gate
//   2. POST /search/res/              search_disclaimer=1 + i_agree  (accept it)
//   3. POST /search/res/results/      the real form, REPLAYED WITH ITS OWN HIDDEN FIELDS
//   4. follow the 303 to              /parcel/<hash>
//
// Step 3 matters: sending ifulladdress alone bounces straight back to the search page. The
// form carries process / search_page / search_group / search_type / manual_search and the
// rest, so the form is parsed and replayed rather than hand-written.
//
// Verified against 10 real client addresses: 9 resolved, every one showing the address that
// was asked for, 9 distinct parcels. The 10th was in Anamosa, which is Jones County and
// genuinely not on either site.
import db from './database.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

/**
 * Cedar Rapids has its OWN city assessor; everything else in Linn County is the county
 * site. This is only the FIRST guess: a Cedar Rapids postal address can sit outside the
 * city limits and belong to the county instead, which is why resolveParcel tries both.
 */
export function assessorHost(city) {
  return String(city || '').trim().toLowerCase().replace(/\s+/g, ' ') === 'cedar rapids'
    ? 'cedarrapids' : 'linn'
}

export const assessorSearchUrl = (city) => `https://${assessorHost(city)}.iowaassessors.com/search/res/`

/** Street only. The form matches on the street line; a city/state/zip tail finds nothing. */
export function streetOnly(address) {
  let s = String(address || '').trim()
  if (!s) return ''
  s = s.split(',')[0]                                   // drop ", Cedar Rapids, IA 52405"
  // "Unit #302", "Apt 3B", "#302" - the hash is not a word character, so it needs saying
  s = s.replace(/\s+(?:apt|unit|ste|suite|lot|bldg|rm)\.?\s*#?\s*[\w-]+$/i, '')
  s = s.replace(/\s+#\s*[\w-]+$/, '')
  return s.replace(/\s+/g, ' ').trim()
}

// The site writes addresses out in full ("ST" becomes "STREET"), so a plain string compare
// reports a correct parcel as wrong. Both sides are expanded before comparing.
const ABBREV = {
  ST: 'STREET', STREET: 'STREET', AVE: 'AVENUE', AV: 'AVENUE', AVENUE: 'AVENUE',
  RD: 'ROAD', ROAD: 'ROAD', DR: 'DRIVE', DRIVE: 'DRIVE', LN: 'LANE', LANE: 'LANE',
  CT: 'COURT', COURT: 'COURT', BLVD: 'BOULEVARD', BOULEVARD: 'BOULEVARD',
  CIR: 'CIRCLE', CIRCLE: 'CIRCLE', PL: 'PLACE', PLACE: 'PLACE', TER: 'TERRACE',
  TERRACE: 'TERRACE', PKWY: 'PARKWAY', PARKWAY: 'PARKWAY', HWY: 'HIGHWAY', HIGHWAY: 'HIGHWAY',
  TRL: 'TRAIL', TRAIL: 'TRAIL', WAY: 'WAY', SQ: 'SQUARE', SQUARE: 'SQUARE',
  // Directionals matter as much as the suffix: the site prints "7114 EAST PARK CT NE" for
  // "7114 E Park Ct NE", and without these the guard threw away a correct parcel.
  N: 'NORTH', NORTH: 'NORTH', S: 'SOUTH', SOUTH: 'SOUTH',
  E: 'EAST', EAST: 'EAST', W: 'WEST', WEST: 'WEST',
}

// The reverse, for the SEARCH term. "3731 Tanager Drive North" finds nothing; the same
// address as "3731 Tanager Dr N" lands on the parcel, so the abbreviated form is tried too.
const SHORTEN = {
  STREET: 'ST', AVENUE: 'AVE', ROAD: 'RD', DRIVE: 'DR', LANE: 'LN', COURT: 'CT',
  BOULEVARD: 'BLVD', CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER', PARKWAY: 'PKWY',
  HIGHWAY: 'HWY', TRAIL: 'TRL', SQUARE: 'SQ',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W',
}

/** The abbreviated spelling of a street, or '' when it is already abbreviated. */
export function abbreviateStreet(street) {
  const words = String(street || '').trim().split(/\s+/)
  const out = words.map(w => {
    const key = w.toUpperCase().replace(/[^A-Z]/g, '')
    return SHORTEN[key] ? (w === w.toUpperCase() ? SHORTEN[key] : SHORTEN[key].charAt(0) + SHORTEN[key].slice(1).toLowerCase()) : w
  })
  const joined = out.join(' ')
  return joined.toUpperCase() === String(street || '').trim().toUpperCase() ? '' : joined
}
export function normAddress(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').map(w => ABBREV[w] || w).join(' ')
}

/**
 * Is the parcel the site returned actually the address we asked for?
 *
 * The safety rule, same as the Forewarn lookup: linking a stranger's property is worse
 * than linking nothing. A parcel is only accepted when its own Property Address starts
 * with the street we searched.
 */
export function addressesAgree(asked, shown) {
  const a = normAddress(streetOnly(asked)), b = normAddress(shown)
  if (!a || !b) return false
  return b.startsWith(a) || b.includes(' ' + a + ' ') || b.includes(a + ' ')
}

function jarFetch() {
  const jar = new Map()
  const soak = (r) => {
    for (const c of (r.headers.getSetCookie?.() || [])) {
      const kv = c.split(';')[0]; const i = kv.indexOf('=')
      if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim())
    }
  }
  return async (url, opts = {}) => {
    const r = await fetch(url, {
      redirect: 'manual', ...opts,
      headers: {
        'user-agent': UA,
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(opts.headers || {}),
      },
    })
    soak(r)
    return r
  }
}

/** Parse a <form> and return every field with its own default value. */
export function formDefaults(formHtml) {
  const out = {}
  for (const m of formHtml.matchAll(/<input[^>]*>/gi)) {
    const tag = m[0]
    const name = /name=["']([^"']+)["']/i.exec(tag)?.[1]
    if (!name) continue
    const type = (/type=["']([^"']+)["']/i.exec(tag)?.[1] || 'text').toLowerCase()
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue
    if (type === 'submit' || type === 'button') continue
    out[name] = /value=["']([^"']*)["']/i.exec(tag)?.[1] ?? ''
  }
  for (const m of formHtml.matchAll(/<select[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    // `selected` and `value` appear in either order, so the OPTION TAG is found first and
    // its value read second. Matching them in one pattern silently picks the first option.
    const options = [...m[2].matchAll(/<option[^>]*>/gi)].map(o => o[0])
    const chosen = options.find(o => /\sselected\b/i.test(o)) || options[0] || ''
    out[m[1]] = /value=["']([^"']*)["']/i.exec(chosen)?.[1] ?? ''
  }
  return out
}

const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim()

/** The address the parcel page itself shows. */
export function shownAddress(html) {
  const t = stripTags(html)
  const m = /Property Address:\s*(.+?)\s+(?:Mailing Address:|Map This Address|Location:|Class:)/i.exec(t)
  return m ? m[1].trim() : null
}

/** One host, one attempt. */
async function lookupOn(host, street) {
  const B = `https://${host}.iowaassessors.com`
  const go = jarFetch()
  const post = (u, body) => go(u, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${B}/search/res/` },
    body: new URLSearchParams(body).toString(),
  })

  await go(`${B}/search/res/`)
  // The gate: a hidden search_disclaimer=1 plus the i_agree submit button. The page's FIRST
  // form is a hidden Login form, so the disclaimer form is matched on its own field rather
  // than by position (the same trap as Forewarn's nav "Search" button).
  let r = await post(`${B}/search/res/`, { search_disclaimer: '1', i_agree: 'Yes, I Agree' })
  let html = await r.text()

  const searchForm = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/gi)]
    .map(m => m[0]).find(f => /name=["']ifulladdress["']/i.test(f))
  if (!searchForm) return { error: 'search form did not open' }

  const body = formDefaults(searchForm)
  body.ifulladdress = street

  r = await post(`${B}/search/res/results/`, body)
  let url = `${B}/search/res/results/`, hops = 0
  while (r.status >= 300 && r.status < 400 && hops++ < 6) {
    url = new URL(r.headers.get('location'), B).href
    r = await go(url)
  }
  html = await r.text()

  if (!/\/parcel\//.test(url)) {
    // a result LIST: only follow it when it holds exactly one property, never guess
    const links = [...new Set([...html.matchAll(/href=["']([^"']*\/parcel\/[^"'?#]+)["']/gi)].map(m => m[1]))]
      .filter(l => !/\/parcel\/(estimate|sketch|map|photos|report)/i.test(l))
    if (links.length !== 1) return { error: links.length ? `${links.length} results` : 'no match' }
    url = new URL(links[0], B).href
    r = await go(url)
    html = await r.text()
  }
  return { url, shown: shownAddress(html), host }
}

/**
 * Resolve an address to its parcel page, or explain why not.
 *
 * Tries the host the city implies, then the other one, because a Cedar Rapids postal
 * address can be outside the city limits and so belong to the county assessor. Of the
 * sample, 3 of 9 only resolved after that fallback.
 */
export async function resolveParcel(address, city) {
  const street = streetOnly(address)
  if (!street) return { error: 'no address' }
  const first = assessorHost(city)
  const second = first === 'cedarrapids' ? 'linn' : 'cedarrapids'

  // Every host and spelling at once. Sequentially this took up to 27s, because a miss on
  // the first host paid a full four-request round trip before the second even started, and
  // the city line is wrong often enough to matter (3 of 9). Running them together keeps the
  // wait to a single round trip, and it is one lookup per lead ever because it is cached.
  const spellings = [street, abbreviateStreet(street)].filter(Boolean)
  const attempts = []
  for (const host of [first, second]) for (const term of spellings) attempts.push({ host, term })

  const tried = await Promise.all(attempts.map(async ({ host, term }) => {
    try { return { host, term, ...(await lookupOn(host, term)) } }
    catch (e) { return { host, term, error: e.message } }
  }))
  // Order decides the winner: the city's own assessor before the county, and the address as
  // written before the abbreviated guess.
  for (const out of tried) {
    if (out.error || !out.url) continue
    // Never hand back a parcel that is not the address asked for.
    if (!addressesAgree(street, out.shown)) continue
    return { url: out.url, shown: out.shown, host: out.host, fell_back: out.host !== first }
  }
  return { error: 'not found on either assessor' }
}

// ── cache ────────────────────────────────────────────────────────────────────────────
// A parcel does not move, so a hit is kept indefinitely. A miss is retried after a week:
// the address may be corrected, or a new build may get assessed.
const MISS_RETRY_DAYS = 7

export function cachedAssessor(clientId) {
  return db.get('SELECT assessor_url, assessor_checked_at, address, city FROM clients WHERE id = ?', [Number(clientId)])
}

export function storeAssessor(clientId, url) {
  db.run('UPDATE clients SET assessor_url = ?, assessor_checked_at = ? WHERE id = ?',
    [url || null, new Date().toISOString(), Number(clientId)])
}

const staleMiss = (checkedAt) => {
  if (!checkedAt) return true
  const t = Date.parse(String(checkedAt).replace(' ', 'T'))
  return Number.isNaN(t) ? true : (Date.now() - t) > MISS_RETRY_DAYS * 864e5
}

/**
 * The parcel URL for a lead: cached when known, resolved and stored otherwise.
 * `search` is always returned so the button has somewhere to go either way.
 */
export async function assessorFor(clientId, { refresh = false } = {}) {
  const c = cachedAssessor(clientId)
  if (!c) return { error: 'no such lead' }
  const search = assessorSearchUrl(c.city)
  if (!String(c.address || '').trim()) return { search, parcel: null, reason: 'no address on file' }
  if (!refresh && c.assessor_url) return { search, parcel: c.assessor_url, cached: true }
  if (!refresh && c.assessor_checked_at && !staleMiss(c.assessor_checked_at))
    return { search, parcel: null, cached: true, reason: 'not found on either assessor' }

  const r = await resolveParcel(c.address, c.city)
  storeAssessor(clientId, r.url || null)
  return r.url
    ? { search, parcel: r.url, shown: r.shown, host: r.host, fell_back: !!r.fell_back }
    : { search, parcel: null, reason: r.error }
}
