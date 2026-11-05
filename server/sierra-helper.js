// Shared helpers for processing Sierra leads (used by sync, scheduler, webhooks)
import db from './database.js'
import { stopSequencesForClient, isStopStatus } from './lead-sequences.js'
import { tidyName, tidyPlace } from './routes/email.js'

const n = (v) => v === undefined || v === '' ? null : v

// The contact fields the sync fills in when the Hub's copy is blank. Clearing one of
// these in the Hub is recorded on clients.cleared_fields so the backfill below can tell
// a deliberate deletion from a gap, and leave it deleted. routes/clients.js writes that
// list; keeping the field names here keeps the two halves from drifting apart.
export const BACKFILLED_FIELDS = ['phone', 'email', 'address', 'city', 'state', 'zip']

export function mapStatus(sierraStatus) {
  if (!sierraStatus) return 'active'
  return sierraStatus.toLowerCase().replace(/\s+/g, '_')
}

export function extractRealistScore(lead) {
  const summary = lead.shortSummary || ''
  const m1 = summary.match(/realist\s*score\s*[:=]?\s*(\d{1,4})/i)
  if (m1) return m1[1]
  const tags = lead.tags || []
  for (const t of tags) {
    const tagStr = typeof t === 'string' ? t : (t.name || t.tag || '')
    const m = tagStr.match(/realist\s*score\s*(.+)/i)
    if (m) return m[1].trim()
  }
  return null
}

export function gradeFromRealistScore(scoreStr) {
  if (!scoreStr) return null
  const num = parseInt(scoreStr, 10)
  if (!isNaN(num)) {
    if (num >= 800) return 'A+'
    if (num >= 700) return 'A'
    if (num >= 650) return 'B'
    if (num >= 600) return 'C'
    if (num >= 500) return 'D'
    return 'F'
  }
  if (scoreStr.includes('800')) return 'A+'
  if (scoreStr.includes('700')) return 'A'
  if (scoreStr.includes('650')) return 'B'
  if (scoreStr.includes('600')) return 'C'
  if (scoreStr.includes('500')) return 'D'
  return 'F'
}

// Normalize Sierra tags to clean string array
function normalizeTags(rawTags) {
  if (!rawTags) return []
  if (!Array.isArray(rawTags)) return []
  return rawTags
    .map(t => typeof t === 'string' ? t : (t.name || t.tag || ''))
    .filter(Boolean)
}

export function processLead(lead, sierraStatusOverride) {
  const sierraId = String(lead.id)
  // Sierra hands back whatever was typed or imported upstream, including ALL CAPS surnames
  // and "Mcgowan". tidyName is the same presentation pass the email merge applies, so the
  // stored value matches what a greeting would show and the file does not drift back to
  // shouting after every sync. It only title-cases a value that is entirely one case, so a
  // name someone shaped deliberately ("ShaLynn", "DeWitt") is untouched.
  const firstName = tidyName(lead.firstName || '')
  const lastName = tidyName(lead.lastName || '')
  if (!firstName && !lastName) return null

  const email = n(lead.email)
  const phone = n(lead.phone)
  const source = n(lead.source)
  // An import split some addresses at the wrong point and left the street's quadrant
  // alone in the city column ("600 Nilsen Rd" / "Ne"). Put the quadrant back on the
  // street and treat the city as missing, or the backfill below keeps restoring it.
  let address = n(lead.streetAddress || lead.address)
  let city = n(lead.city)
  if (city && /^(ne|nw|se|sw)$/i.test(city)) {
    if (address && !/\b(ne|nw|se|sw)\b\s*$/i.test(address)) address = `${address} ${city.toUpperCase()}`
    city = null
  }
  // Sierra hands these over in whatever case its own source used, and the backfill below
  // writes them straight into any Hub field that is empty — which is how "GRAND MOUND"
  // landed on #29902 mid-cleanup (John 2026-11-03). Same rule as the names above: only a
  // value that is entirely one case is touched.
  address = tidyPlace(address)
  city = tidyPlace(city)
  const state = n(lead.state) || 'IA'
  const zip = n(lead.zip || lead.postalCode)

  const actualStatus = lead.leadStatus || sierraStatusOverride
  const clientStatus = mapStatus(actualStatus)

  let type = 'buyer'
  const leadType = (lead.leadType || '').toLowerCase()
  if (leadType === 'seller') type = 'seller'
  else if (leadType === 'both' || leadType === 'buyer/seller') type = 'both'

  let agentAssigned = null
  if (lead.assignedTo && lead.assignedTo.agentUserFirstName) {
    agentAssigned = `${lead.assignedTo.agentUserFirstName} ${lead.assignedTo.agentUserLastName}`.trim()
  }

  let budgetMin = null, budgetMax = null
  let searchPriceMin = null, searchPriceMax = null
  let searchBedsMin = null, searchBathsMin = null, searchSqftMin = null
  const searchRegionsSet = new Set()
  const searchTypesSet = new Set()
  const searches = lead.savedSearchesModel?.savedSearches || lead.savedSearches || []
  const hasSavedSearch = searches.length > 0 ? 1 : 0
  if (hasSavedSearch) {
    // Use the WIDEST range across all saved searches (max coverage = more matches)
    for (const s of searches) {
      const pMin = s.price?.min ?? s.minPrice ?? s.priceMin ?? null
      const pMax = s.price?.max ?? s.maxPrice ?? s.priceMax ?? null
      const bMin = s.bedrooms?.min ?? s.bedroomsMin ?? null
      const baMin = s.bathrooms?.min ?? s.bathroomsMin ?? null
      const sfMin = s.squareFeet?.min ?? s.sqftMin ?? null
      if (pMin != null && (searchPriceMin == null || pMin < searchPriceMin)) searchPriceMin = pMin
      if (pMax != null && (searchPriceMax == null || pMax > searchPriceMax)) searchPriceMax = pMax
      if (bMin != null && (searchBedsMin == null || bMin < searchBedsMin)) searchBedsMin = bMin
      if (baMin != null && (searchBathsMin == null || baMin < searchBathsMin)) searchBathsMin = baMin
      if (sfMin != null && (searchSqftMin == null || sfMin < searchSqftMin)) searchSqftMin = sfMin
      if (s.mlsRegions) {
        const regs = Array.isArray(s.mlsRegions) ? s.mlsRegions : String(s.mlsRegions).split(/[,;]/)
        regs.forEach(r => { if (r && String(r).trim()) searchRegionsSet.add(String(r).trim()) })
      }
      if (s.propertyTypes && typeof s.propertyTypes === 'object') {
        Object.entries(s.propertyTypes).forEach(([k, v]) => { if (v === 'On' || v === true) searchTypesSet.add(k) })
      }
    }
    budgetMin = searchPriceMin
    budgetMax = searchPriceMax
  }
  const searchRegions = searchRegionsSet.size ? JSON.stringify([...searchRegionsSet]) : null
  const searchPropertyTypes = searchTypesSet.size ? JSON.stringify([...searchTypesSet]) : null

  const leadScore = extractRealistScore(lead)
  const leadGrade = gradeFromRealistScore(leadScore)
  const visits = Number(lead.visits) || 0
  const emailStatus = n(lead.emailStatus)
  const phoneStatus = n(lead.phoneStatus)
  const sierraUpdateDate = n(lead.updateDate)
  const sierraCreationDate = n(lead.creationDate)
  const pondId = lead.pondId || null
  const meOptOut = lead.marketingEmailOptOut ? 1 : 0
  const textOptOut = lead.textOptOut ? 1 : 0
  const ealertOptOut = lead.eAlertOptOut ? 1 : 0
  const shortSummary = n(lead.shortSummary)
  const tags = normalizeTags(lead.tags)
  const tagsStr = tags.length ? JSON.stringify(tags) : null
  const lenderName = lead.lender && lead.lender.agentUserId > 0
    ? `${lead.lender.agentUserFirstName} ${lead.lender.agentUserLastName}`.trim()
    : null
  const lenderStatus = n(lead.lenderStatus)
  const listingAgentStatus = n(lead.listingAgentStatus)

  const COLS = 'id, status, tags, email, phone, first_name, last_name, sierra_lead_id, alt_sierra_ids, cleared_fields'
  let existing = db.get(`SELECT ${COLS} FROM clients WHERE sierra_lead_id = ?`, [sierraId])
  // A second Sierra lead already claimed by this person resolves to the same Hub record,
  // so the pair cannot ping-pong between two ids on alternating syncs.
  if (!existing) {
    existing = db.all(`SELECT ${COLS} FROM clients WHERE merged_into IS NULL AND alt_sierra_ids LIKE ?`, ['%' + sierraId + '%'])
      .find(c => String(c.alt_sierra_ids || '').split(',').map(s => s.trim()).includes(String(sierraId))) || null
  }
  let adopted = false
  if (!existing) {
    // ADOPT-DON'T-DUPLICATE (2026-09-21): FB ad leads are born in the Hub (FUB email
    // intake) and don't reach Sierra automatically, so John uploads them to Sierra
    // manually. Before this guard, the next sync pass INSERTed a twin of a lead the
    // Hub already had (4 dup pairs from the 09-18 upload). Match by exact email, or
    // by phone last-10 PLUS same first name — never bare phone, because household /
    // shared lines must never be collapsed (contact-cleanup rule).
    // WIDENED 2026-11-05 (John): a record that ALREADY has a Sierra id is now a candidate
    // too. The old rule only matched Hub-born records, so when Sierra minted a SECOND
    // lead for somebody it already had, nothing matched and the Hub made a twin with no
    // history - which the AI then texted as a new buyer six minutes later.
    const p10 = String(phone || '').replace(/\D/g, '').slice(-10)
    if (email && !/notvalidemail/i.test(email)) {
      existing = db.get(`SELECT ${COLS} FROM clients WHERE merged_into IS NULL AND lower(email)=lower(?) ORDER BY id ASC LIMIT 1`, [email])
    }
    if (!existing && p10.length === 10) {
      // Phone needs the NAME to agree, because a shared line is usually a household and
      // not one person. Barney Foley / Barney Foley is the same man; Martin Cram / Katie
      // Cram are two people on one number, and there are hundreds of those in the file.
      const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
      existing = db.all(`SELECT ${COLS} FROM clients WHERE merged_into IS NULL AND phone LIKE ?`, ['%' + p10.slice(-4)])
        .find(c => String(c.phone || '').replace(/\D/g, '').slice(-10) === p10
          && same(c.first_name, firstName) && same(c.last_name, lastName)) || null
    }
    if (existing) {
      adopted = true
      const prior = String(existing.sierra_lead_id || '').trim()
      if (prior && prior !== String(sierraId)) {
        // Keep the id this record already answers to and ADD the new one, rather than
        // re-pointing: overwriting would orphan the original lead, and its next sync
        // would create the very duplicate this is here to prevent.
        const alts = new Set(String(existing.alt_sierra_ids || '').split(',').map(s => s.trim()).filter(Boolean))
        alts.add(String(sierraId))
        db.run("UPDATE clients SET alt_sierra_ids=?, updated_at=datetime('now') WHERE id=?", [[...alts].join(','), existing.id])
        try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['updated', 'client', existing.id, `Sierra opened a second lead (${sierraId}) for this person; attached to this record instead of creating a duplicate`]) } catch {}
      } else {
        db.run("UPDATE clients SET sierra_lead_id=?, updated_at=datetime('now') WHERE id=?", [sierraId, existing.id])
        try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['updated', 'client', existing.id, `Sierra lead ${sierraId} matched this existing Hub record (adopted, no duplicate created)`]) } catch {}
      }
    }
  }
  if (existing) {
    // FIELD OWNERSHIP (policy set 2026-09-11): the Hub is the master for contact
    // and profile data. On an EXISTING lead the sync writes ONLY what Sierra
    // genuinely owns — status (junk safety; NIM-guarded), website visits,
    // validation statuses, Sierra dates/pond, opt-outs, summary, tags, lender
    // info, saved-search criteria. It NEVER REPLACES name, email, phone, address,
    // type, budgets, agent assignment, or the Realist score/grade: Hub edits to
    // those used to be silently reverted by the next sync pass (39 Forewarn-
    // verified phone numbers on 2026-09-10). The one exception: an EMPTY Hub
    // contact field is backfilled from Sierra (a lead adding their phone/email
    // on the website is new data, not an overwrite). New leads INSERT in full.
    // Tags are Sierra-owned EXCEPT Hub-native campaign tags (FB Ad / FB Seller Ad /
    // Meta Lead / Fix It or Skip It), which Sierra never knows about — union those
    // back in so a sync pass can't strip a lead out of its FB campaign identity.
    // Home value request tags are Hub-written too, and were being silently stripped.
    // Found 2026-10-29: James Osullivan was tagged by the intake at 20:35 on 10-27 and a
    // sync pass at 22:02 removed it; the three submissions from the new /home-value/ page
    // came back from Sierra with tags=[] for the same reason. Sierra never sets these, so
    // a sync pass had nothing to merge and replaced them with nothing. The Home Value
    // Requested smart list only kept working because it ORs in the activity row.
    // The address audit's tags are Hub-written for the same reason and were decaying the
    // same way: 491 of them applied on 2026-10-29, Sierra never sees them, and nothing
    // re-applies them. Every one of those leads has been reported by Sierra at least once
    // in the last year, so all 491 would have gone within a year - 8 of them within weeks.
    //
    // NOTE ON REMOVAL, because it is easy to read this the wrong way round: this preserves
    // a tag that is ON THE HUB RECORD. It does not resurrect one. Remove the tag in the Hub
    // and it stays removed; the Hub is master. What it stops is a SIERRA-side removal
    // silently reaching back and deleting Hub-owned information.
    //
    // Does Sierra's validation verdict still describe the contact point the Hub uses?
    // Only then may it be written. An empty Hub field counts as a match, because the
    // UPDATE backfills it from Sierra in the same statement — the verdict is then about
    // the address/number the Hub is adopting.
    const hubEmail = String(existing.email || '').trim().toLowerCase()
    const sierraOwnsEmailVerdict = !hubEmail || hubEmail === String(email || '').trim().toLowerCase()
    const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10)
    const sierraOwnsPhoneVerdict = !String(existing.phone || '').trim() || last10(existing.phone) === last10(phone)
    // 'FB Ad' with no colon: ai.js builds 'FB Ad' + (property ? ': ' + property : ''), so a
    // lead with no property name carried a bare 'FB Ad' that /^FB Ad:/ never matched.
    const HUB_NATIVE_TAG = (t) => /^(FB Ad\b|FB Seller Ad|Home Value:|Address Confirmed|Address Needs Update)/i.test(t)
      || /sierrasellersites\.com$/i.test(t)
      || ['Meta Lead', 'Fix It or Skip It', 'Seller'].includes(t)
    let hubTags = []
    try { const a = JSON.parse(existing.tags || '[]'); if (Array.isArray(a)) hubTags = a.map(x => String(x).trim()).filter(Boolean) } catch {}
    const keepTags = hubTags.filter(HUB_NATIVE_TAG)
    const mergedTags = [...new Set([...tags, ...keepTags])]
    const mergedTagsStr = mergedTags.length ? JSON.stringify(mergedTags) : null
    // First (adoption) pass keeps the Hub's status: the Hub record predates Sierra
    // here, so a manual upload's default "New" must not clobber e.g. Watch.
    const statusToWrite = adopted ? existing.status : clientStatus
    // 1 = this blank field may be filled from Sierra, 0 = it was emptied on purpose.
    let clearedFields = []
    try { const a = JSON.parse(existing.cleared_fields || '[]'); if (Array.isArray(a)) clearedFields = a } catch {}
    const mayFill = (f) => clearedFields.includes(f) ? 0 : 1
    db.run(`UPDATE clients SET
      -- A blank contact field is filled from Sierra's copy UNLESS someone emptied it on
      -- purpose. Without that second test the backfill cannot tell a gap from a deletion,
      -- and an address deleted at 11:26 was back by 11:57 (Amy Oberfoell #118, John
      -- 2026-11-03). The flags come from clients.cleared_fields, written by the PUT.
      phone   = CASE WHEN (phone   IS NULL OR phone   = '') AND ? THEN ? ELSE phone   END,
      email   = CASE WHEN (email  IS NULL OR email   = '') AND ? AND COALESCE(?, '') NOT LIKE '%notvalidemail%' THEN ? ELSE email END,
      address = CASE WHEN (address IS NULL OR address = '') AND ? THEN ? ELSE address END,
      city    = CASE WHEN (city    IS NULL OR city    = '') AND ? THEN ? ELSE city    END,
      state   = CASE WHEN (state   IS NULL OR state   = '') AND ? THEN ? ELSE state   END,
      zip     = CASE WHEN (zip     IS NULL OR zip     = '') AND ? THEN ? ELSE zip     END,
      status=CASE WHEN status='not_in_market' THEN status ELSE ? END, -- Hub-native status: Sierra has no equivalent, never overwrite it
      visits=?,
      -- emailStatus / phoneStatus are Sierra's verdicts on SIERRA'S copy of the address
      -- and the number. The Hub is master for both fields, so the moment a Hub edit makes
      -- them differ, Sierra is grading a contact point this lead no longer uses. Writing
      -- it anyway is what put email_status='WrongAddress' back on a corrected address at
      -- the next sync pass, and emailHardBlock then refused the lead from every drip
      -- forever (Doug Riniker #26281, John 2026-11-03). Same rule as the phone verdicts
      -- the PUT already sheds: a verdict belongs to the contact point it was made about.
      email_status = CASE WHEN ? THEN ? ELSE email_status END,
      phone_status = CASE WHEN ? THEN ? ELSE phone_status END,
      sierra_update_date=?, sierra_creation_date=?, pond_id=?,
      marketing_email_opt_out=?, text_opt_out=?, ealert_opt_out=?, short_summary=?,
      tags=?, lender_name=?, lender_status=?, listing_agent_status=?,
      search_price_min=?, search_price_max=?, search_beds_min=?, search_baths_min=?,
      search_sqft_min=?, search_regions=?, search_property_types=?, has_saved_search=?,
      updated_at=datetime('now') WHERE id=?`,
      [mayFill('phone'), phone, mayFill('email'), email, email, mayFill('address'), address,
        mayFill('city'), city, mayFill('state'), state, mayFill('zip'), zip,
        statusToWrite,
        visits,
        sierraOwnsEmailVerdict ? 1 : 0, emailStatus,
        sierraOwnsPhoneVerdict ? 1 : 0, phoneStatus,
        sierraUpdateDate, sierraCreationDate, pondId,
        meOptOut, textOptOut, ealertOptOut, shortSummary,
        mergedTagsStr, lenderName, lenderStatus, listingAgentStatus,
        searchPriceMin, searchPriceMax, searchBedsMin, searchBathsMin,
        searchSqftMin, searchRegions, searchPropertyTypes, hasSavedSearch,
        existing.id])
    // Junked in Sierra since we last saw it → pull out of active sequences.
    if (isStopStatus(clientStatus) && !isStopStatus(existing.status)) {
      stopSequencesForClient(existing.id, 'lead marked junk in Sierra')
    }
    return 'updated'
  } else {
    db.run(`INSERT INTO clients (first_name, last_name, email, phone, type, status,
      source, agent_assigned, address, city, state, zip, budget_min, budget_max,
      sierra_lead_id, lead_score, lead_grade, visits, email_status, phone_status,
      sierra_update_date, sierra_creation_date, pond_id,
      marketing_email_opt_out, text_opt_out, ealert_opt_out, short_summary,
      tags, lender_name, lender_status, listing_agent_status,
      search_price_min, search_price_max, search_beds_min, search_baths_min,
      search_sqft_min, search_regions, search_property_types, has_saved_search)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [firstName, lastName, email, phone, type, clientStatus, source,
        agentAssigned, address, city, state, zip, budgetMin, budgetMax,
        sierraId, leadScore, leadGrade, visits, emailStatus, phoneStatus,
        sierraUpdateDate, sierraCreationDate, pondId,
        meOptOut, textOptOut, ealertOptOut, shortSummary,
        tagsStr, lenderName, lenderStatus, listingAgentStatus,
        searchPriceMin, searchPriceMax, searchBedsMin, searchBathsMin,
        searchSqftMin, searchRegions, searchPropertyTypes, hasSavedSearch])
    // FRESH-LANE hook: a brand-new incoming lead goes straight to the AI enrollment
    // evaluator (speed-to-lead). No-op unless ai_auto_enroll_mode is fresh/full.
    try {
      const newId = db.get('SELECT id FROM clients WHERE sierra_lead_id=?', [sierraId])?.id
      if (newId) import('./ai-enrollment.js').then(m => m.maybeAutoEnrollFresh(newId)).catch(() => {})
    } catch {}
    return 'added'
  }
}

const SIERRA_API_KEY = process.env.SIERRA_API_KEY || 'b97e3302-1985-46a4-9032-cb92e5cb3dd8'
const SIERRA_API_URL = 'https://api.sierrainteractivedev.com'

export async function sierraGet(endpoint, params = {}) {
  const url = new URL(`${SIERRA_API_URL}${endpoint}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  const resp = await fetch(url.toString(), {
    headers: { 'Content-Type': 'application/json', 'Sierra-ApiKey': SIERRA_API_KEY }
  })
  if (!resp.ok) {
    let bodyText = ''
    try { bodyText = (await resp.text()).slice(0, 300) } catch {}
    const err = new Error(`Sierra API ${resp.status} ${resp.statusText}${bodyText ? ' — ' + bodyText : ''}`)
    err.status = resp.status
    err.endpoint = endpoint
    throw err
  }
  return resp.json()
}

export async function sierraPost(endpoint, data) {
  const resp = await fetch(`${SIERRA_API_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sierra-ApiKey': SIERRA_API_KEY },
    body: JSON.stringify(data),
  })
  if (!resp.ok) {
    let bodyText = ''
    try { bodyText = (await resp.text()).slice(0, 300) } catch {}
    throw new Error(`Sierra API ${resp.status} ${resp.statusText}${bodyText ? ' — ' + bodyText : ''}`)
  }
  return resp.json()
}

export async function sierraPut(endpoint, data) {
  const resp = await fetch(`${SIERRA_API_URL}${endpoint}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Sierra-ApiKey': SIERRA_API_KEY },
    body: JSON.stringify(data),
  })
  if (!resp.ok) {
    let bodyText = ''
    try { bodyText = (await resp.text()).slice(0, 300) } catch {}
    throw new Error(`Sierra API ${resp.status} ${resp.statusText}${bodyText ? ' — ' + bodyText : ''}`)
  }
  return resp.json()
}

export async function sierraDelete(endpoint) {
  const resp = await fetch(`${SIERRA_API_URL}${endpoint}`, {
    method: 'DELETE',
    headers: { 'Sierra-ApiKey': SIERRA_API_KEY },
  })
  if (!resp.ok) throw new Error(`Sierra API ${resp.status}: ${resp.statusText}`)
  return resp.text()
}
