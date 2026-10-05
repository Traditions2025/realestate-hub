// Leads the AI must never text, checked AT THE MOMENT OF SENDING.
//
// Two incidents, one cause (John, 2026-10-05):
//
//   Joseph Green, a FSBO seller at 7526 Cattail Ct NE, was answered by the AI.
//   Holly Stock, hand-added as a seller client, got an AI intro text 8 minutes later.
//
// ai-enrollment.js already refuses all of these. The trouble is WHEN it refuses: only at
// the moment of enrolment. A lead who becomes FSBO, or gets picked up by a campaign, or is
// flagged MLS-tracked AFTER being enrolled stays AI-managed, and the fence never runs
// again. Joseph was enrolled as a cold buyer months before anyone knew he was selling.
//
// So the same questions are asked again on every send. An enrolment-time exclusion is not a
// guard; it is a filter on who joins. This is the guard.
//
// SCOPE: campaign ownership and prospecting identity only - the cases where some OTHER
// system or a person owns the conversation. Deliberate human choices are NOT here:
// `auto_enroll_excluded` stays enrolment-only on purpose, because an agent switching AI on
// from the profile must mean exactly that.
import db from '../database.js'

/**
 * Why the AI may not text this lead, or null if it may.
 * `client` is a clients row; only the id is strictly required.
 */
export function aiForbiddenReason(client) {
  if (!client) return null
  const cid = Number(client.id)
  if (!cid) return null
  const has = (sql) => { try { return !!db.get(sql, [cid]) } catch { return false } }

  // Campaigns that own the conversation outright, and answer with their own approved
  // templates. A person replies to these leads, never the AI.
  if (has('SELECT client_id FROM cx_campaign WHERE client_id=?'))
    return 'Cancelled/Expired connection campaign — AI never texts these leads'
  if (has('SELECT client_id FROM fsbo_followups WHERE client_id=?'))
    return 'FSBO follow-up campaign — AI never texts these sellers'
  if (has('SELECT client_id FROM fb_seller_followups WHERE client_id=?'))
    return 'Fix It or Skip It seller campaign owns this lead'

  // Prospecting identities, independent of whether a campaign row exists yet. The FSBO
  // sheet and the MLS pull set these the moment a lead is identified, which is often long
  // after enrolment.
  if (String(client.fsbo_status || '').trim()) return 'FSBO-tracked seller — AI never texts these sellers'
  const listings = String(client.fsbo_listings || '').trim()
  if (listings && listings !== '[]') return 'FSBO-tracked seller (listing on file) — AI never texts these sellers'
  if (String(client.mls_status || '').trim()) return `MLS-tracked (${client.mls_status}) — a prospecting campaign owns this lead`

  // Meta seller-ad leads: the seller sequence and a human own them.
  if (String(client.tags || '').includes('FB Seller Ad'))
    return 'Meta seller-ad lead — the seller campaign and a human own it'

  return null
}

export const aiForbidden = (client) => !!aiForbiddenReason(client)
