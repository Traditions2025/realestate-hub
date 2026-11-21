// LEADS A LANDING-PAGE CAMPAIGN OWNS OUTRIGHT (Leon, 2026-11-20).
//
// The Iowa down payment assistance page (/buyers/iowa-down-payment-assistance/) posts
// through Sierra's own /contact/ form with utm_campaign=iowa-dpa, and Sierra turns that
// into the tag "iowa-dpa". Leon's instruction, verbatim: "for leads on this campaign just
// pause anything A, drip, auto email".
//
// WHY A TAG AND NOT A CAMPAIGN TABLE. Every other fence in forbidden.js can ask "is there
// a row for this lead in cx_campaign / fsbo_followups / home_value_sms". These leads have
// no Hub-side campaign row to ask about: they arrive from Sierra as ordinary status-New
// website registrations, which is exactly the pool the AI fresh lane draws from. The tag
// is the only marker that exists at the moment the sync creates the record, and it is a
// FIXED value rather than the ad's own campaign name, so suppression does not depend on
// how an ad campaign happens to be named this month.
//
// WHAT IS STILL ALLOWED, DELIBERATELY:
//   - A person texting or emailing by hand. These people filled in a form and are waiting
//     for an answer, so "pause the automation" is not "never speak to them". Only the
//     non-manual channels are gated.
//   - Anything the lead themselves set off: an appointment confirmation or reminder, the
//     answer to a home value request. Same principle as EXEMPT_TAGS in email-cap.js - a
//     reply to something somebody just did is not a nurture queue, and blocking it would
//     mean a lead who books a walkthrough never gets the confirmation.
//
// TO LIFT IT: delete the tag's entry from SUPPRESSED_TAGS below and deploy. Removing the
// tag in Sierra would stop NEW leads carrying it but would not free the ones already
// synced, because the Hub keeps its own copy of the tag list.

/** Tags that mean another campaign, and a person, own the conversation. */
export const SUPPRESSED_TAGS = [
  {
    tag: 'iowa-dpa',
    why: 'Iowa down payment assistance campaign - AI, drips and automated email are paused for these leads; a person answers them',
  },
]

/**
 * Does this client carry `tag`?
 *
 * clients.tags is a JSON array string, written by sierra-helper.js from the Sierra tag
 * list. It is PARSED rather than substring-matched so a short tag can never match inside
 * a longer one; the quoted fallback mirrors the tags_include filter in routes/clients.js
 * for the case where the column holds something that will not parse.
 */
export function hasTag(client, tag) {
  const raw = String(client?.tags || '')
  const want = String(tag || '').trim().toLowerCase()
  if (!raw || !want) return false
  try {
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) return arr.some((t) => String(t).trim().toLowerCase() === want)
  } catch { /* not JSON - fall through to the quoted substring form */ }
  return raw.toLowerCase().includes('"' + want + '"')
}

/** Why no automated system may contact this lead, or null if they are fair game. */
export function suppressedCampaignReason(client) {
  if (!client) return null
  for (const entry of SUPPRESSED_TAGS) {
    if (hasTag(client, entry.tag)) return entry.why
  }
  return null
}

// Email categories that ANSWER something the lead just did. sendSequenceEmail stamps one
// of these on every send it makes, and these are the ones a suppressed lead still gets.
// drip_test_* is a campaign preview sent to an address a person typed themselves.
const LEAD_INITIATED_CATEGORIES = new Set([
  'appointment_confirmation',
  'appointment_reminder',
  'home_value_followup',
  'home_value_response',
  'home_value_report',
])

export function isLeadInitiatedEmail(category) {
  const c = String(category || '')
  return LEAD_INITIATED_CATEGORIES.has(c) || /^drip_test_/i.test(c)
}

/**
 * Why an AUTOMATED email must not go to this lead, or null.
 *
 * The manual composers (the Clients and Inbox send routes) deliberately do NOT call this:
 * a person choosing to write to somebody outranks a suppression meant for queues.
 */
export function autoEmailSuppressedReason(client, category = null) {
  if (isLeadInitiatedEmail(category)) return null
  return suppressedCampaignReason(client)
}
