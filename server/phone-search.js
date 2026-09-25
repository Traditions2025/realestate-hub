// Searching by phone number must not depend on how the number was typed.
//
// Numbers are stored formatted — "(319) 551-6347" for 4,470 of 4,471 leads — and the
// search clauses compared that text literally. So a pasted "3195516347", a "319-551-6347"
// or a "+13195516347" off a caller ID matched nothing and the lead looked like it did not
// exist (John, 2026-09-25). Alternate numbers were never searched at all.
//
// Fix: compare digits to digits on both sides. SQLite has no regex, so the stored value is
// stripped with nested REPLACE() of the punctuation phone numbers actually carry. Commas
// are deliberately NOT stripped: alt_phones holds a comma-separated list, and keeping the
// separator stops one number's tail running into the next one's head and matching nothing real.

// Punctuation to remove from a stored number. Single-quoted SQL literals on purpose —
// double quotes are identifiers in SQLite, not strings.
const PHONE_PUNCT = ["'('", "')'", "'-'", "' '", "'.'", "'+'"]

// SQL expression that reduces a phone column to bare digits (plus any commas).
export const digitsOnlySql = (col) =>
  PHONE_PUNCT.reduce((expr, ch) => `REPLACE(${expr}, ${ch}, '')`, `COALESCE(${col}, '')`)

// The digits worth matching a phone column against, or '' when the term is not
// phone-shaped. 11+ digits keeps the last 10 so a leading country code still matches a
// locally-stored number. Under 7 digits is a street number, a ZIP or a year, not a phone —
// matching those against phones would only add noise to a name or address search.
export function phoneSearchDigits(term) {
  const digits = String(term == null ? '' : term).replace(/\D/g, '')
  const local = digits.length > 10 ? digits.slice(-10) : digits
  return local.length >= 7 ? local : ''
}

// The OR-clauses + params to fold into an existing search predicate. Empty when the term
// is not phone-shaped, so callers can spread it unconditionally.
export function phoneSearchClauses(term, cols = ['phone', 'alt_phones']) {
  const d = phoneSearchDigits(term)
  if (!d) return { clauses: [], params: [] }
  return {
    clauses: cols.map(c => `${digitsOnlySql(c)} LIKE ?`),
    params: cols.map(() => `%${d}%`),
  }
}
