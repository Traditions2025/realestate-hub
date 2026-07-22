// =====================================================================
// Business-day math for contingency deadlines.
// A "business day" excludes weekends AND all U.S. national/federal holidays
// (observed). Counting starts the day AFTER the start date — the acceptance /
// contract date itself is never counted (per how Iowa purchase agreements read).
// =====================================================================

function ymd(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// month: 0-11, weekday: 0=Sun..6=Sat, n: 1-based occurrence in the month
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month, 1)
  const offset = (weekday - first.getDay() + 7) % 7
  return new Date(year, month, 1 + offset + (n - 1) * 7)
}
function lastWeekday(year, month, weekday) {
  const last = new Date(year, month + 1, 0)
  const offset = (last.getDay() - weekday + 7) % 7
  return new Date(year, month, last.getDate() - offset)
}
// Fixed-date holidays that land on a weekend are OBSERVED on the nearest weekday.
function observed(date) {
  const dow = date.getDay()
  if (dow === 6) return new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1) // Sat -> Fri
  if (dow === 0) return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1) // Sun -> Mon
  return date
}

const _cache = {}
export function federalHolidays(year) {
  if (_cache[year]) return _cache[year]
  const set = new Set()
  const add = (d) => set.add(ymd(d))
  add(observed(new Date(year, 0, 1)))    // New Year's Day
  add(nthWeekday(year, 0, 1, 3))         // MLK Day — 3rd Mon Jan
  add(nthWeekday(year, 1, 1, 3))         // Presidents' Day — 3rd Mon Feb
  add(lastWeekday(year, 4, 1))           // Memorial Day — last Mon May
  add(observed(new Date(year, 5, 19)))   // Juneteenth
  add(observed(new Date(year, 6, 4)))    // Independence Day
  add(nthWeekday(year, 8, 1, 1))         // Labor Day — 1st Mon Sep
  add(nthWeekday(year, 9, 1, 2))         // Columbus Day — 2nd Mon Oct
  add(observed(new Date(year, 10, 11)))  // Veterans Day
  add(nthWeekday(year, 10, 4, 4))        // Thanksgiving — 4th Thu Nov
  add(observed(new Date(year, 11, 25)))  // Christmas
  _cache[year] = set
  return set
}

export function isBusinessDay(date) {
  const dow = date.getDay()
  if (dow === 0 || dow === 6) return false          // weekend
  return !federalHolidays(date.getFullYear()).has(ymd(date))  // not a holiday
}

// Return the date that is `n` business days AFTER startStr (YYYY-MM-DD).
// The start (acceptance) date is NOT counted. Returns '' on bad input.
export function addBusinessDays(startStr, n) {
  const days = Number(n)
  if (!startStr || !days || days < 1) return ''
  const p = String(startStr).slice(0, 10).split('-').map(Number)
  if (p.length !== 3 || p.some(isNaN)) return ''
  const d = new Date(p[0], p[1] - 1, p[2])
  if (isNaN(d.getTime())) return ''
  let counted = 0
  while (counted < days) {
    d.setDate(d.getDate() + 1)
    if (isBusinessDay(d)) counted++
  }
  return ymd(d)
}
