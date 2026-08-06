// US federal holidays (incl. the weekend-observed dates), evaluated on the
// America/Chicago calendar. Used to make sure no automated email/text is sent on
// a holiday — sends that would land on one get pushed to the next non-holiday day.
const _cache = {}
const fmt = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const dow = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0=Sun … 6=Sat

function nthWeekday(y, m, weekday, n) {
  let c = 0
  for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === weekday && ++c === n) return d }
  return null
}
function lastWeekday(y, m, weekday) {
  let last = null
  for (let d = 1; d <= 31; d++) { const dt = new Date(Date.UTC(y, m - 1, d)); if (dt.getUTCMonth() !== m - 1) break; if (dt.getUTCDay() === weekday) last = d }
  return last
}
// add a fixed-date holiday plus its observed date (Sat→Fri, Sun→Mon)
function addFixed(set, y, m, d) {
  set.add(fmt(y, m, d))
  const w = dow(y, m, d)
  if (w === 6) { const p = new Date(Date.UTC(y, m - 1, d - 1)); set.add(fmt(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate())) }
  else if (w === 0) { const n = new Date(Date.UTC(y, m - 1, d + 1)); set.add(fmt(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate())) }
}
function holidaysForYear(y) {
  if (_cache[y]) return _cache[y]
  const s = new Set()
  addFixed(s, y, 1, 1)                       // New Year's Day
  s.add(fmt(y, 1, nthWeekday(y, 1, 1, 3)))   // MLK Jr — 3rd Mon Jan
  s.add(fmt(y, 2, nthWeekday(y, 2, 1, 3)))   // Presidents' Day — 3rd Mon Feb
  s.add(fmt(y, 5, lastWeekday(y, 5, 1)))     // Memorial Day — last Mon May
  addFixed(s, y, 6, 19)                      // Juneteenth
  addFixed(s, y, 7, 4)                       // Independence Day
  s.add(fmt(y, 9, nthWeekday(y, 9, 1, 1)))   // Labor Day — 1st Mon Sep
  s.add(fmt(y, 10, nthWeekday(y, 10, 1, 2))) // Columbus Day — 2nd Mon Oct
  addFixed(s, y, 11, 11)                     // Veterans Day
  s.add(fmt(y, 11, nthWeekday(y, 11, 4, 4))) // Thanksgiving — 4th Thu Nov
  addFixed(s, y, 12, 25)                     // Christmas Day
  if (dow(y + 1, 1, 1) === 6) s.add(fmt(y, 12, 31)) // next New Year observed on Dec 31
  _cache[y] = s
  return s
}
const chicagoYMD = (dateLike) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(dateLike instanceof Date ? dateLike : new Date(dateLike))

export function isUsHoliday(dateLike = new Date()) {
  const ymd = chicagoYMD(dateLike)
  return holidaysForYear(Number(ymd.slice(0, 4))).has(ymd)
}
// If the instant lands on a holiday (Chicago), move it forward a day at a time
// (keeping the clock time) until it's not a holiday.
export function bumpPastHolidays(iso) {
  let d = new Date(iso), guard = 0
  while (isUsHoliday(d) && guard++ < 25) d = new Date(d.getTime() + 86400000)
  return d.toISOString()
}
