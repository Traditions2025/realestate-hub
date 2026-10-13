// Area-based value outreach for the buyer nurture.
//
// John, 2026-10-13: instead of asking a lead to explain themselves again, occasionally send
// something useful — the newest listings in the area they have actually been browsing.
//
// TWO HARD RULES, both his:
//
// 1. ONE URL PER TEXT. Never two area links in one SMS. Multiple links read as spam, hurt
//    deliverability, and make the message feel automated. If a lead has searched several
//    communities, pick the single strongest and offer to narrow it down in conversation.
//
// 2. ONLY WITH REAL SEARCH HISTORY. If there is no reliable recent search for a FEATURED
//    community, send no link at all and fall back to an ordinary nurture message. A guessed
//    area is worse than no area: it tells the lead we are not actually paying attention.
//
// Selection order, strongest signal first: most recent search area, then the area with the
// most listing views, then the lead's saved-search city.
import db from '../../server/database.js'

/** The featured communities, and only these. An area not on this list has no page to link. */
export const FEATURED_COMMUNITIES = {
  alburnett: 'Alburnett',
  bertram: 'Bertram',
  'cedar rapids': 'Cedar Rapids',
  ely: 'Ely',
  fairfax: 'Fairfax',
  hiawatha: 'Hiawatha',
  lisbon: 'Lisbon',
  marion: 'Marion',
  'mount vernon': 'Mount Vernon',
  robins: 'Robins',
  swisher: 'Swisher',
}

const SITE = 'https://www.mattsmithteam.com'

/** Featured-community URL, or null when the city is not one we have a page for. */
export function communityUrl(city) {
  const key = normaliseCity(city)
  if (!key || !FEATURED_COMMUNITIES[key]) return null
  return `${SITE}/${key.replace(/\s+/g, '-')}-ia-homes-for-sale/`
}

/** "MARION, IA" / "Marion , Iowa" / " marion " -> "marion". Returns '' when unusable. */
export function normaliseCity(raw) {
  let s = String(raw || '').split(',')[0].trim().toLowerCase()
  s = s.replace(/\s+(ia|iowa)$/i, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return s
}

/** Proper-case display name for a featured community, or '' if not featured. */
export function communityName(city) {
  const key = normaliseCity(city)
  return FEATURED_COMMUNITIES[key] || ''
}

const DAYS = 180   // "recent" search history. Older than this is not evidence of intent.

/**
 * Pick the ONE community to link for this lead, or null.
 *
 * Returns { city, name, url, reason } so a caller (and a human reading the log) can see WHY
 * that area was chosen rather than having to guess.
 */
export function pickArea(clientId, { days = DAYS } = {}) {
  const cid = Number(clientId)
  if (!cid) return null
  const since = new Date(Date.now() - days * 86400000).toISOString()

  // 1. Most recent search/view area.
  try {
    const rows = db.all(
      `SELECT prop_city AS city, MAX(occurred_at) AS last_at
         FROM fub_activity
        WHERE client_id = ? AND COALESCE(prop_city,'') <> '' AND occurred_at >= ?
        GROUP BY lower(prop_city)
        ORDER BY last_at DESC`, [cid, since])
    for (const r of rows) {
      const url = communityUrl(r.city)
      if (url) return { city: r.city, name: communityName(r.city), url, reason: 'most recent search area' }
    }
    // 2. Most-viewed area, when the most recent one is not a featured community.
    const byCount = db.all(
      `SELECT prop_city AS city, COUNT(*) AS n
         FROM fub_activity
        WHERE client_id = ? AND COALESCE(prop_city,'') <> '' AND occurred_at >= ?
        GROUP BY lower(prop_city)
        ORDER BY n DESC`, [cid, since])
    for (const r of byCount) {
      const url = communityUrl(r.city)
      if (url) return { city: r.city, name: communityName(r.city), url, reason: `most viewed area (${r.n} views)` }
    }
  } catch { /* no activity table or no rows: fall through to the saved city */ }

  // 3. The city on the lead record.
  try {
    const c = db.get('SELECT city FROM clients WHERE id = ?', [cid])
    const url = communityUrl(c?.city)
    if (url) return { city: c.city, name: communityName(c.city), url, reason: 'city on the lead record' }
  } catch {}

  return null
}

/**
 * Area-outreach wording. One link, always at the end, and the opener varies so it never
 * reads as "I saw you on our website" every single time.
 *
 * `cold` is for a lead we have not spoken to in a long time: it reintroduces John, which the
 * ordinary nurture messages deliberately do not.
 */
export const AREA_OPENERS = [
  "Hi {{first_name}}! Since you've been looking around {{area}}, I thought this might come in handy. Here are the newest listings in the area: {{url}} If anything stands out, just send it my way.",
  "Good morning, {{first_name}}! Thought I'd send this over since you've been keeping an eye on {{area}}. Here are the newest listings in the area in case something catches your attention: {{url}}",
  "Hi {{first_name}}! I noticed you've been looking around {{area}}, so I wanted to share the newest listings there in case it's helpful. No pressure at all: {{url}}",
  "Good afternoon, {{first_name}}! Since you've been keeping an eye on homes in {{area}}, I thought I'd send you the newest listings there in case something catches your eye: {{url}} Feel free to send me anything you want a second opinion on.",
  "Hi {{first_name}}! Thought this might come in handy since you've been looking around {{area}}. Here are the newest listings in the area: {{url}}",
]

/** Cold-lead versions: reintroduce John, because it has been a long time. */
export const AREA_OPENERS_COLD = [
  "Hi {{first_name}}! It's John with Matt Smith Team at RE/MAX. I noticed you've looked at a few homes around {{area}}, so I wanted to send over the newest listings there in case it's useful: {{url}} No need to be actively looking, just something handy to have.",
  "Hi {{first_name}}! Hope you've been doing well. I know we haven't talked in a while, but since you had been looking around {{area}}, I wanted to share the newest listings there in case it comes in handy: {{url}}",
]

/**
 * Build the area message for a lead, or null when there is no reliable featured community.
 * Returns the raw template text; merge fields are filled by the caller.
 */
export function buildAreaMessage(clientId, { cold = false, pick = null, seed = 0 } = {}) {
  const area = pick || pickArea(clientId)
  if (!area) return null
  const bank = cold ? AREA_OPENERS_COLD : AREA_OPENERS
  // Deterministic per lead AND per stage. Keyed on the lead alone, Day 17 and Day 30 handed
  // the same person a word-for-word identical area message — the exact repetition this bank
  // exists to avoid. `seed` is the stage index, so consecutive area messages differ.
  const idx = (Math.abs(Number(clientId) || 0) + Math.abs(Number(seed) || 0)) % bank.length
  const text = bank[idx].replace(/\{\{area\}\}/g, area.name).replace(/\{\{url\}\}/g, area.url)
  return { text, area }
}

/** Rule 1, enforced rather than trusted: at most one URL in an outgoing SMS. */
export function countUrls(text) {
  return (String(text || '').match(/https?:\/\/\S+/gi) || []).length
}
