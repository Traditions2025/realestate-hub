import { Router } from 'express'
import db from '../database.js'
import { AI_MODEL, getAiClient } from './followup.js'
import { enrollInDrip } from './drips.js'

const router = Router()

// ---------- small helpers ----------
const parse = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const nameOf = (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'
const tagsOf = (c) => (parse(c.tags, []) || []).map(t => String(t).toLowerCase())
const daysSince = (s) => { if (!s) return null; const t = Date.parse(s); if (isNaN(t)) return null; return Math.floor((Date.now() - t) / 86400000) }
const money = (v) => v ? '$' + Number(v).toLocaleString() : ''
const isOptedOut = (c) => !!c.marketing_email_opt_out || ['OptedOut', 'ReportedAsSpam', 'WrongAddress'].includes(c.email_status)

// Columns we score on (keep the payload lean vs SELECT *).
const COLS = `id, first_name, last_name, email, phone, type, status, source, tags, city, state, zip, address,
  lead_score, lead_grade, created_at, sierra_creation_date, sierra_update_date,
  last_fub_activity_at, last_fub_activity_type, last_fub_activity_detail, fub_viewed_cities,
  search_price_min, search_price_max, has_saved_search, visits, marketing_email_opt_out, ealert_opt_out,
  email_status, linkedin_url, job_title, employer`

// ---------- context (built once per analyze) ----------
function buildContext() {
  const txMap = new Map()
  for (const t of db.all('SELECT client_id, type, agency_type, property_status, closing_date, contract_date FROM transactions WHERE client_id IS NOT NULL')) {
    const cur = txMap.get(t.client_id) || { hasActiveTxn: false, isPastBuyer: false, isPastSeller: false, lastPurchase: null }
    const status = String(t.property_status || '').toLowerCase()
    const closed = status.includes('closed')
    if (!closed && !status.includes('cancel')) cur.hasActiveTxn = true
    const isPurchase = (t.type === 'purchase') || /buyer/i.test(t.agency_type || '')
    const isListing = (t.type === 'listing') || /listing|seller/i.test(t.agency_type || '')
    if (closed && isPurchase) { cur.isPastBuyer = true; if (t.closing_date && (!cur.lastPurchase || t.closing_date > cur.lastPurchase)) cur.lastPurchase = t.closing_date }
    if (closed && isListing) cur.isPastSeller = true
    txMap.set(t.client_id, cur)
  }
  const dripMap = new Map()
  for (const e of db.all("SELECT client_id, drip_id FROM drip_enrollments WHERE status='active'")) {
    const s = dripMap.get(e.client_id) || new Set(); s.add(e.drip_id); dripMap.set(e.client_id, s)
  }
  const pastBuyerIds = [...txMap.entries()].filter(([, v]) => v.isPastBuyer).map(([id]) => id)
  return { txMap, dripMap, pastBuyerIds }
}

// ---------- campaign registry ----------
// Each: hard exclusions (why NOT), a coarse candidate score + human factors (for
// ranking + grounding the AI), and an AI target-profile prompt.
const EMAIL_OK = "email IS NOT NULL AND email != '' AND (status IS NULL OR lower(status) NOT IN ('junk','donotcontact','blocked','archived','trash'))"
const inList = (ids) => ids.length ? `(${ids.join(',')})` : '(0)'

const CAMPAIGNS = [
  {
    key: 'cold_reengagement',
    label: 'Cold Lead Re-Engagement',
    dripId: 3,
    profile: 'Buyer leads who were once engaged (saved a search, viewed homes, had a budget) but have gone quiet for months. Best matches: real past engagement plus a long stretch of silence, and no sign they already bought or are actively working a deal.',
    sql: (ctx) => ({ where: `type IN ('buyer','both') AND ${EMAIL_OK} AND (has_saved_search=1 OR fub_viewed_cities IS NOT NULL OR visits>0 OR lead_score IS NOT NULL)`, params: [] }),
    hard: (c, ctx) => {
      if (isOptedOut(c)) return 'Unsubscribed / undeliverable email'
      if (ctx.dripMap.get(c.id)?.has(3)) return 'Already in The Comeback re-engagement'
      if (ctx.txMap.get(c.id)?.hasActiveTxn) return 'Has an active transaction in progress'
      const lp = ctx.txMap.get(c.id)?.lastPurchase; if (lp && daysSince(lp) < 120) return 'Purchased within the last 4 months'
      return null
    },
    score: (c, ctx) => {
      const f = []; let s = 0
      const inact = daysSince(c.last_fub_activity_at || c.sierra_update_date || c.created_at)
      if (inact != null) { if (inact > 365) { s += 40; f.push(`No activity in ${Math.round(inact / 30)} months`) } else if (inact > 180) { s += 32; f.push(`Quiet for ${Math.round(inact / 30)} months`) } else if (inact > 90) { s += 22; f.push(`Quiet for ${Math.round(inact / 30)} months`) } else if (inact > 60) { s += 10 } }
      if (c.has_saved_search) { s += 16; f.push('Had a saved search') }
      if (c.fub_viewed_cities) { s += 16; f.push(`Viewed homes in ${String(c.fub_viewed_cities).split(',')[0]}`) }
      if (c.visits > 0) { s += 8; f.push(`${c.visits} site visits`) }
      if (c.lead_score) { s += 8; f.push(`Lead score ${c.lead_score}`) }
      if (c.search_price_min || c.search_price_max) f.push(`Budget ${money(c.search_price_min) || '?'}-${money(c.search_price_max) || '?'}`)
      return { score: Math.min(100, s), factors: f }
    },
  },
  {
    key: 'seller_motivation',
    label: 'Seller Motivation',
    dripId: null,
    profile: 'Homeowners who may be ready to sell: they own a property (often a past buyer of ours who still owns it), have longer tenure, are marked as a seller or show seller-side signals (valuation, equity, market interest). Higher intent when they have engaged with seller/market content or mentioned moving.',
    sql: (ctx) => ({ where: `(type IN ('seller','both') OR id IN ${inList(ctx.pastBuyerIds)}) AND ${EMAIL_OK}`, params: [] }),
    hard: (c, ctx) => {
      if (isOptedOut(c)) return 'Unsubscribed / undeliverable email'
      if (ctx.txMap.get(c.id)?.hasActiveTxn) return 'Already has an active listing/transaction'
      return null
    },
    score: (c, ctx) => {
      const f = []; let s = 0; const tx = ctx.txMap.get(c.id); const tg = tagsOf(c)
      if (['seller', 'both'].includes(c.type)) { s += 30; f.push('Marked as a seller') }
      if (tx?.isPastBuyer && !tx?.isPastSeller) { s += 30; const yr = tx.lastPurchase ? tx.lastPurchase.slice(0, 4) : null; f.push(yr ? `Owns a home bought in ${yr}` : 'Owns a home (past buyer)') }
      const ten = tx?.lastPurchase ? daysSince(tx.lastPurchase) : null
      if (ten != null) { if (ten > 365 * 5) { s += 20; f.push(`${Math.floor(ten / 365)} years in the home`) } else if (ten > 365 * 3) { s += 10 } }
      if (tg.some(t => /sell|valuation|equity|listing|cma/.test(t))) { s += 15; f.push('Seller / valuation tag') }
      if (c.fub_viewed_cities || c.visits > 0) { s += 8; f.push('Recent market activity') }
      return { score: Math.min(100, s), factors: f }
    },
  },
  {
    key: 'home_value_nurture',
    label: 'Home Value Nurture',
    dripId: null,
    profile: 'Homeowners and past clients who would value a periodic plain-English update on what their home and neighborhood are worth. Property ownership and time-in-home matter most; immediate selling intent is not required.',
    sql: (ctx) => ({ where: `(type IN ('seller','both') OR id IN ${inList(ctx.pastBuyerIds)}) AND ${EMAIL_OK}`, params: [] }),
    hard: (c, ctx) => { if (isOptedOut(c)) return 'Unsubscribed / undeliverable email'; if (ctx.txMap.get(c.id)?.hasActiveTxn) return 'Active transaction in progress'; return null },
    score: (c, ctx) => {
      const f = []; let s = 0; const tx = ctx.txMap.get(c.id)
      if (tx?.isPastBuyer && !tx?.isPastSeller) { s += 45; const yr = tx.lastPurchase ? tx.lastPurchase.slice(0, 4) : null; f.push(yr ? `Homeowner since ${yr}` : 'Homeowner (past buyer)') }
      else if (['seller', 'both'].includes(c.type)) { s += 25; f.push('Marked as a seller') }
      if (c.address) { s += 10; f.push('Property address on file') }
      const ten = tx?.lastPurchase ? daysSince(tx.lastPurchase) : null
      if (ten != null && ten > 365 * 2) { s += 15; f.push(`${Math.floor(ten / 365)} years in the home`) }
      return { score: Math.min(100, s), factors: f }
    },
  },
  {
    key: 'first_time_buyer_edu',
    label: 'First-Time Buyer Education',
    dripId: null,
    profile: 'Buyer leads who look like first-time buyers: no prior purchase with us, a modest budget, and recent-enough interest. They benefit from education (financing, the twenty-percent myth, the process) rather than a hard sell.',
    sql: (ctx) => ({ where: `type IN ('buyer','both') AND id NOT IN ${inList(ctx.pastBuyerIds)} AND ${EMAIL_OK} AND (has_saved_search=1 OR fub_viewed_cities IS NOT NULL OR visits>0 OR lead_score IS NOT NULL)`, params: [] }),
    hard: (c, ctx) => { if (isOptedOut(c)) return 'Unsubscribed / undeliverable email'; if (ctx.txMap.get(c.id)?.hasActiveTxn) return 'Already under contract / active deal'; return null },
    score: (c, ctx) => {
      const f = []; let s = 20; f.push('Buyer, no prior purchase')
      const pmax = Number(c.search_price_max) || null
      if (pmax && pmax < 300000) { s += 25; f.push(`Budget under ${money(pmax)}`) } else if (pmax && pmax < 400000) { s += 12 }
      const inact = daysSince(c.last_fub_activity_at || c.sierra_update_date || c.created_at)
      if (inact != null && inact < 120) { s += 20; f.push('Active in the last few months') }
      if (c.has_saved_search) { s += 10; f.push('Has a saved search') }
      if (c.fub_viewed_cities) { s += 10; f.push(`Looking in ${String(c.fub_viewed_cities).split(',')[0]}`) }
      return { score: Math.min(100, s), factors: f }
    },
  },
  {
    key: 'downsizing_seller',
    label: 'Downsizing Seller',
    dripId: null,
    profile: 'Longer-tenured homeowners who may be ready to downsize: own the home for many years, often marked seller or a past buyer who still owns. Intent is higher with age/tenure and any move-related signals.',
    sql: (ctx) => ({ where: `(type IN ('seller','both') OR id IN ${inList(ctx.pastBuyerIds)}) AND ${EMAIL_OK}`, params: [] }),
    hard: (c, ctx) => { if (isOptedOut(c)) return 'Unsubscribed / undeliverable email'; if (ctx.txMap.get(c.id)?.hasActiveTxn) return 'Active transaction in progress'; return null },
    score: (c, ctx) => {
      const f = []; let s = 0; const tx = ctx.txMap.get(c.id)
      if (tx?.isPastBuyer && !tx?.isPastSeller) { s += 30; f.push('Owns a home (past buyer)') }
      const ten = tx?.lastPurchase ? daysSince(tx.lastPurchase) : null
      if (ten != null) { if (ten > 365 * 10) { s += 40; f.push(`${Math.floor(ten / 365)}+ years in the home`) } else if (ten > 365 * 6) { s += 22; f.push(`${Math.floor(ten / 365)} years in the home`) } }
      if (['seller', 'both'].includes(c.type)) { s += 12; f.push('Marked as a seller') }
      return { score: Math.min(100, s), factors: f }
    },
  },
  {
    key: 'past_client_homeowner',
    label: 'Past Client Homeowner',
    dripId: null,
    profile: 'Past clients who bought a home through us and still own it: the stay-in-touch homeowner track (anniversary, value, referrals). Strongest matches closed a purchase with us and have no later sale on record.',
    sql: (ctx) => ({ where: `id IN ${inList(ctx.pastBuyerIds)} AND ${EMAIL_OK}`, params: [] }),
    hard: (c, ctx) => { if (isOptedOut(c)) return 'Unsubscribed / undeliverable email'; return null },
    score: (c, ctx) => {
      const f = []; let s = 0; const tx = ctx.txMap.get(c.id)
      if (tx?.isPastBuyer) { s += 55; const yr = tx.lastPurchase ? tx.lastPurchase.slice(0, 4) : null; f.push(yr ? `Bought with us in ${yr}` : 'Past buyer client') }
      if (tx?.isPastBuyer && !tx?.isPastSeller) { s += 20; f.push('Still owns the home') }
      const ten = tx?.lastPurchase ? daysSince(tx.lastPurchase) : null
      if (ten != null && ten > 365) { s += 10; f.push(`${Math.floor(ten / 365)} years since closing`) }
      return { score: Math.min(100, s), factors: f }
    },
  },
]
const byKey = (k) => CAMPAIGNS.find(c => c.key === k)

// ---------- AI scoring (batched) ----------
const AI_LIMIT = 120, BATCH = 20
function leadSummary(c, factors, ctx) {
  const tx = ctx.txMap.get(c.id)
  const inact = daysSince(c.last_fub_activity_at || c.sierra_update_date || c.created_at)
  return {
    id: c.id, name: nameOf(c), type: c.type, status: c.status, source: c.source,
    city: c.city, budget: [c.search_price_min, c.search_price_max].filter(Boolean).map(money).join('-') || null,
    saved_search: !!c.has_saved_search, viewed_cities: c.fub_viewed_cities || null,
    last_activity_days_ago: inact, last_activity: c.last_fub_activity_type || null,
    lead_score: c.lead_score || null, tags: tagsOf(c).slice(0, 6),
    past_buyer: !!tx?.isPastBuyer, owns_home: !!(tx?.isPastBuyer && !tx?.isPastSeller),
    bought: tx?.lastPurchase || null, job: c.job_title || null, employer: c.employer || null,
    signals: factors,
  }
}
async function aiScore(campaign, leads) {
  const ai = getAiClient(); if (!ai) return null
  const sys = `You are a lead-intelligence analyst for a real estate team (Matt Smith Team, Cedar Rapids/Marion, Iowa). For the campaign below, score how well EACH lead fits, using their real signals.
CAMPAIGN: ${campaign.label}
TARGET PROFILE: ${campaign.profile}
For every lead return: match (0-100 fit for THIS campaign), intent (one of "Low","Medium","High" — how strong their real-estate intent looks right now), group ("high" if match>=80, "possible" if 55-79, "low" if <55), and why (ONE specific sentence citing the lead's actual signals; plain and factual; no exclamation points, no em dashes, do not invent facts).
Return ONLY a JSON array: [{"id":number,"match":number,"intent":"...","group":"...","why":"..."}]. No prose.`
  const batches = []
  for (let i = 0; i < leads.length; i += BATCH) batches.push(leads.slice(i, i + BATCH))
  const results = await Promise.all(batches.map(async (b) => {
    try {
      const msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 1800, system: sys, messages: [{ role: 'user', content: 'Leads:\n' + JSON.stringify(b) }] })
      const txt = msg.content?.[0]?.text || ''
      const a = txt.indexOf('['), z = txt.lastIndexOf(']')
      return a === -1 ? [] : JSON.parse(txt.slice(a, z + 1))
    } catch { return [] }
  }))
  const map = new Map()
  for (const arr of results) for (const r of (arr || [])) if (r && r.id != null) map.set(Number(r.id), r)
  return map
}

// ---------- ROUTES ----------
router.get('/campaigns', (_req, res) => {
  res.json(CAMPAIGNS.map(c => ({ key: c.key, label: c.label, dripId: c.dripId, hasDrip: !!c.dripId })))
})

router.post('/:key/analyze', async (req, res) => {
  const campaign = byKey(req.params.key)
  if (!campaign) return res.status(404).json({ error: 'Unknown campaign' })
  try {
    const ctx = buildContext()
    const { where, params } = campaign.sql(ctx)
    const rows = db.all(`SELECT ${COLS} FROM clients WHERE ${where}`, params)
    const eligible = [], notRec = []
    for (const c of rows) {
      const { score, factors } = campaign.score(c, ctx)
      const reason = campaign.hard(c, ctx)
      if (reason) { if (score >= 25) notRec.push({ id: c.id, name: nameOf(c), city: c.city, status: c.status, reason }); continue }
      if (score <= 0) continue
      eligible.push({ c, score, factors })
    }
    eligible.sort((a, b) => b.score - a.score)
    const totalEligible = eligible.length
    const top = eligible.slice(0, AI_LIMIT)
    const aiMap = await aiScore(campaign, top.map(x => leadSummary(x.c, x.factors, ctx)))
    const candidates = top.map(({ c, score, factors }) => {
      const ai = aiMap && aiMap.get(c.id)
      const match = ai ? Math.max(0, Math.min(100, Math.round(ai.match))) : score
      const group = ai?.group || (match >= 80 ? 'high' : match >= 55 ? 'possible' : 'low')
      const why = (ai?.why && String(ai.why).trim()) || factors.slice(0, 3).join(' • ') || 'Fits the campaign profile'
      return { id: c.id, name: nameOf(c), email: c.email, city: c.city, type: c.type, status: c.status, match, intent: ai?.intent || null, group, why, factors }
    }).sort((a, b) => b.match - a.match)
    const counts = {
      high: candidates.filter(x => x.group === 'high').length,
      possible: candidates.filter(x => x.group === 'possible').length,
      low: candidates.filter(x => x.group === 'low').length,
      total_eligible: totalEligible, not_recommended: notRec.length,
    }
    res.json({ campaign: { key: campaign.key, label: campaign.label, dripId: campaign.dripId, ai: !!aiMap }, counts, candidates, not_recommended: notRec.slice(0, 40) })
  } catch (e) {
    console.error('[campaign-match] analyze failed:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Pre-enroll quality-control warnings for a set of contacts.
router.post('/:key/preflight', (req, res) => {
  const campaign = byKey(req.params.key)
  if (!campaign) return res.status(404).json({ error: 'Unknown campaign' })
  const ids = (req.body?.ids || []).map(Number).filter(Boolean)
  if (!ids.length) return res.json({ total: 0, warnings: [] })
  const ctx = buildContext()
  const inSql = ids.join(',')
  const recent = new Set(db.all(`SELECT DISTINCT client_id FROM communications WHERE client_id IN (${inSql}) AND occurred_at >= datetime('now','-7 day')`).map(r => r.client_id))
  const otherDrip = [], recentContact = [], overlap = []
  for (const id of ids) {
    const drips = ctx.dripMap.get(id)
    if (drips && [...drips].some(d => d !== campaign.dripId)) otherDrip.push(id)
    if (drips && drips.size >= 1 && campaign.dripId && !drips.has(campaign.dripId)) overlap.push(id)
    if (recent.has(id)) recentContact.push(id)
  }
  const warnings = []
  if (otherDrip.length) warnings.push({ level: 'warn', text: `${otherDrip.length} are already in another nurture campaign` })
  if (recentContact.length) warnings.push({ level: 'warn', text: `${recentContact.length} were contacted by your team in the last 7 days` })
  res.json({ total: ids.length, warnings })
})

// Enroll selected contacts into the campaign's drip, recording why + match.
router.post('/:key/enroll', (req, res) => {
  const campaign = byKey(req.params.key)
  if (!campaign) return res.status(404).json({ error: 'Unknown campaign' })
  const dripId = Number(req.body?.drip_id) || campaign.dripId
  if (!dripId) return res.status(400).json({ error: 'This campaign has no drip yet. Build its drip first, or pass a drip_id.' })
  const items = Array.isArray(req.body?.items) ? req.body.items : []
  let enrolled = 0, skipped = 0
  for (const it of items) {
    const id = Number(it.id); if (!id) { skipped++; continue }
    const eid = enrollInDrip(dripId, id, { source: 'campaign_match' })
    if (eid) {
      db.run('UPDATE drip_enrollments SET enroll_reason=?, match_score=? WHERE id=?', [String(it.why || '').slice(0, 400) || null, it.match != null ? Number(it.match) : null, eid])
      enrolled++
    } else skipped++
  }
  try { db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)', ['campaign_match_enroll', 'drip', dripId, `Enrolled ${enrolled} via AI Campaign Match: ${campaign.label}`]) } catch {}
  res.json({ enrolled, skipped, drip_id: dripId })
})

export default router
