// Sort keys for the lead profile's one timeline.
//
// A profile note's stamp is CENTRAL WALL TIME ("Oct 13, 2026, 1:23 PM · John Solamo");
// a communication's occurred_at is a UTC instant. To order them against each other, both
// become the same sortable "YYYY-MM-DD HH:mm" string in Central. Comparing as strings
// rather than instants is deliberate: turning a stamp into an instant needs the correct
// DST offset for that stamp's own date, and one wrong offset silently reorders the list.
// Rendering an instant in Central needs no arithmetic at all.

const CENTRAL_KEY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
})

/** A stored timestamp (ISO, Date, ms) → "YYYY-MM-DD HH:mm" in Central. '' when unusable. */
export function centralKey(dateLike) {
  if (dateLike === null || dateLike === undefined || dateLike === '') return ''
  const d = new Date(dateLike)
  if (isNaN(d.getTime())) return ''
  try { return CENTRAL_KEY.format(d).replace(',', '') } catch { return '' }
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

/**
 * A note stamp → "YYYY-MM-DD HH:mm". The stamp is already Central, so its parts are used
 * as-is. An unstamped or unparseable note returns '', which sorts to the bottom — honest,
 * because we genuinely do not know when it was written, and better than inventing a date.
 */
export function stampKey(stamp) {
  const m = String(stamp || '').match(/^\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AaPp])/)
  if (!m) return ''
  const mo = MONTHS[m[1].toLowerCase()]
  if (!mo) return ''
  const day = Number(m[2]); const hour12 = Number(m[4]); const min = Number(m[5])
  if (day < 1 || day > 31 || hour12 < 1 || hour12 > 12 || min > 59) return ''
  let h = hour12 % 12
  if (m[6].toLowerCase() === 'p') h += 12
  return `${m[3]}-${mo}-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

/** Newest first. Entries with no usable key go last, keeping their relative order. */
export function newestFirst(entries) {
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ka = a.e.key || ''; const kb = b.e.key || ''
      if (ka && !kb) return -1
      if (!ka && kb) return 1
      if (ka !== kb) return kb.localeCompare(ka)
      return a.i - b.i
    })
    .map(x => x.e)
}
