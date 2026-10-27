// UNIVERSAL PRE-SEND GATE (John, 2026-10-27).
//
// One question, asked in one place, immediately before any automated prospecting text:
// should this person receive a message from THIS campaign right now?
//
// Why this exists. Eight separate paths can text a buyer, and routing was decided once at
// enrolment. Nothing re-asked at send time whether another lane had since taken the lead
// over, so two campaigns could each believe they owned the same person. On 2026-10-26 a
// Willowridge ad lead had a cold-buyer message and a listing opener queued for the same
// 3:15 PM, from two different records.
//
// The second half of the problem was coverage. canAutomatedSend() already held most of
// the right checks, but ONLY the campaign paths called it:
//
//   called it    cx-connect, fb-listing, fsbo, home-value, automations, bulk, seller
//   did NOT      the entire AI lane - orchestrator.js and scheduler.js went straight to
//                canSendSms({channel:'ai'}), skipping the stacking guard, the pending-action
//                check and the active-human-conversation check
//
// So this module does not reinvent those checks. It calls canAutomatedSend for everything
// it already gets right, then adds the two it cannot know about: who owns the lead, and
// how many prospecting texts that person has already had this week.
import db from '../database.js'
import { canAutomatedSend } from './policy.js'

// Every campaign that may own a lead. A lead has at most one.
//
// Ordered HIGHEST claim first. Two triggers can fire seconds apart — a reply arriving
// while a campaign tick is mid-run — and without a fixed order whichever wrote last would
// arbitrarily win. Ownership is therefore always RECOMPUTED FROM EVIDENCE rather than
// asserted by a trigger, and this ranking settles ties. A lower claim can never displace a
// higher one while the higher one's evidence still holds; it steps down only when that
// evidence expires (the human conversation goes quiet, the campaign completes).
export const OWNER_PRIORITY = [
  'TRANSACTIONAL',
  'HUMAN_OWNED',
  'BEHAVIOR_REACTIVATION',
  'FB_LISTING_PHASE_1',
  'FB_BUYER_PHASE_2',
  'GENERAL_NEW_BUYER',
  // Named for what the Hub can actually prove. The Hub holds no conversation earlier than
  // June 2026 while client records go back to September 2023, and most history lived in
  // FUB, which never handed over message bodies. So a lead with no visible reply has NOT
  // been shown to have never replied - we simply cannot see. Calling that state
  // "never connected" licensed copy that asserts a fact we do not have.
  'COLD_KNOWN_CONNECTED',   // a two-way exchange is visible in the Hub
  'COLD_HISTORY_UNKNOWN',   // no visible exchange, and we cannot tell whether one happened
  'NONE',
]
export const OWNERS = OWNER_PRIORITY
export const rank = (owner) => {
  const i = OWNER_PRIORITY.indexOf(owner)
  return i === -1 ? OWNER_PRIORITY.length : i
}
/** True when `a` outranks `b` (a lower index is a stronger claim). */
export const outranks = (a, b) => rank(a) < rank(b)

// Owners that are not prospecting and therefore never blocked by the weekly budget.
const NON_PROSPECTING = new Set(['TRANSACTIONAL', 'HUMAN_OWNED'])

// One automated prospecting text per person per 7 days, counted across EVERY campaign.
// Replies, appointment logistics and anything transactional are not prospecting and do
// not count. Phase 1 campaigns keep their designed cadence and pass `longTerm: false`;
// they are still subject to every other check here.
const PROSPECTING_WINDOW_DAYS = 7

const deny = (reason, extra = {}) => ({ ok: false, reason, ...extra })

export function currentOwner(clientId) {
  try {
    return db.get('SELECT communication_owner FROM clients WHERE id=?', [Number(clientId)])?.communication_owner || 'NONE'
  } catch { return 'NONE' }
}

export function previousOwner(clientId) {
  try {
    return db.get('SELECT communication_owner_prev FROM clients WHERE id=?', [Number(clientId)])?.communication_owner_prev || null
  } catch { return null }
}

export function setOwner(clientId, owner, why = '', { keepPrevious = null } = {}) {
  if (!OWNERS.includes(owner)) return { ok: false, reason: `unknown owner ${owner}` }
  const prev = currentOwner(clientId)
  if (prev === owner) return { ok: true, unchanged: true, owner }
  // Entering the temporary reactivation state parks whoever it displaced, so the lead
  // goes back to them afterwards instead of being stranded.
  const park = keepPrevious !== null
    ? keepPrevious
    : (owner === 'BEHAVIOR_REACTIVATION' && prev !== 'BEHAVIOR_REACTIVATION' ? prev : undefined)
  const now = new Date().toISOString()
  if (park === undefined) {
    db.run('UPDATE clients SET communication_owner=?, communication_owner_at=?, updated_at=? WHERE id=?',
      [owner, now, now, Number(clientId)])
  } else {
    db.run('UPDATE clients SET communication_owner=?, communication_owner_prev=?, communication_owner_at=?, updated_at=? WHERE id=?',
      [owner, park, now, now, Number(clientId)])
  }
  try {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['owner_change', 'client', Number(clientId), `Communication owner ${prev} -> ${owner}${why ? ': ' + why : ''}`])
  } catch {}
  return { ok: true, owner, previous: prev }
}

// How many automated PROSPECTING texts this person has had in the window. Counted from
// communications, which is what actually went out, rather than from any campaign's own
// idea of what it sent.
export function prospectingSendsInWindow(clientId, days = PROSPECTING_WINDOW_DAYS) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  try {
    return db.get(
      `SELECT COUNT(*) n FROM communications
       WHERE client_id=? AND channel='text' AND direction='outgoing'
         AND occurred_at >= ? AND COALESCE(sent_by_type,'') != 'human'`,
      [Number(clientId), since])?.n || 0
  } catch { return 0 }
}

/**
 * The gate. Call immediately before sending, never at enrolment.
 *
 * @param client        the full client row
 * @param owner         the campaign asking to send (one of OWNERS)
 * @param source        'ai' | 'automation' | 'drip' | 'bulk' - passed through to canAutomatedSend
 * @param longTerm      true for long-term nurture, which is subject to the weekly budget.
 *                      false for a Phase 1 campaign running its designed cadence.
 * @param dedupMinutes  override the short stacking guard
 */
export function preSendGate(client, { owner = 'NONE', source = 'automation', longTerm = false, dedupMinutes = null } = {}) {
  if (!client) return deny('no client')
  const cid = client.id

  // 1-5, 8. Hard compliance, human conversation, AI conversation, recent human 1:1, the
  // short stacking guard, quiet hours and holidays. Already correct - reuse, do not copy.
  const base = canAutomatedSend(client, { source, dedupMinutes })
  if (!base.ok) return base

  // 6. OWNERSHIP. A lead has one communication owner. A campaign that does not own this
  // lead does not get to talk to them, however due its own schedule says it is.
  const held = currentOwner(cid)
  if (held === 'HUMAN_OWNED') return deny('a human owns this lead')
  if (held !== 'NONE' && held !== owner) {
    return deny(`${held} owns this lead, ${owner} may not send`, { owner: held })
  }

  // 7. WEEKLY PROSPECTING BUDGET. Stops several nurture systems stacking on one person.
  // Phase 1 cadences opt out; everything long-term is capped at one text per 7 days.
  if (longTerm && !NON_PROSPECTING.has(owner)) {
    const n = prospectingSendsInWindow(cid)
    if (n >= 1) return deny(`already had ${n} automated text in the last ${PROSPECTING_WINDOW_DAYS} days`)
  }

  return { ok: true, reason: `${owner} may send`, owner: held === 'NONE' ? owner : held }
}
