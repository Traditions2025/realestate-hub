// DYNAMIC GREETINGS (John, 2026-10-27 — Part 37 step 10).
//
// Every automated SMS opens with a greeting, rendered at SEND time rather than baked into
// the template. A template containing "Good morning" sends "Good morning" at 7pm if the
// message is ever deferred, which is exactly what deferral does.
//
// Time-of-day only where the recipient's local time is actually knowable. We text Linn
// County from a Central-time office, so Central is a sound assumption here — but the
// moment a number is out of area that stops being true, and the honest fallback is a
// greeting that carries no claim about their clock.
import db from '../database.js'

const CENTRAL = 'America/Chicago'
// Iowa area codes, plus the neighbours we genuinely serve. A number outside these is not
// safe to assume is on Central time.
const LOCAL_AREA_CODES = new Set(['319', '563', '515', '641', '712'])

const NEUTRAL = ['Hi', 'Hello']

export function localMinutes(tz = CENTRAL, now = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now)
  const g = (t) => Number((p.find(x => x.type === t) || {}).value)
  let h = g('hour'); if (h === 24) h = 0
  return h * 60 + g('minute')
}

export function timeOfDay(now = new Date(), tz = CENTRAL) {
  const m = localMinutes(tz, now)
  if (m < 12 * 60) return 'morning'
  if (m <= 17 * 60) return 'afternoon'
  return 'evening'
}

/** Can we tell what time it is where they are? */
export function localTimeKnown(phone) {
  const d = String(phone || '').replace(/\D/g, '')
  const ten = d.length >= 10 ? d.slice(-10) : null
  if (!ten) return false
  return LOCAL_AREA_CODES.has(ten.slice(0, 3))
}

/**
 * The greeting for this send. Rotates so a lead does not get "Hi" every time, and falls
 * back to Hi/Hello whenever the local clock is not reliably knowable.
 */
export function greetingFor(client, { now = new Date(), rotation = null } = {}) {
  const rot = rotation == null ? Number(db.getSetting?.('ai_greeting_rot', '0') || 0) : rotation
  if (!localTimeKnown(client?.phone)) return NEUTRAL[rot % NEUTRAL.length]
  // Mix neutral and time-of-day so the sequence does not read as a clock readout.
  const pool = [NEUTRAL[0], `Good ${timeOfDay(now)}`, NEUTRAL[1], `Good ${timeOfDay(now)}`]
  return pool[rot % pool.length]
}

export function advanceGreetingRotation() {
  try {
    const cur = Number(db.getSetting('ai_greeting_rot', '0') || 0)
    db.setSetting('ai_greeting_rot', String((cur + 1) % 12))
  } catch { /* setting store unavailable in tests */ }
}

/**
 * Fill {{greeting}}, {{first_name}} and {{time_of_day}} in a template.
 * A blank or unusable first name becomes "there", the same fallback the rest of the Hub
 * uses, so a message never opens "Hi ,".
 */
export function renderGreeting(template, client, { now = new Date(), rotation = null } = {}) {
  const first = String(client?.first_name || '').trim()
  const usable = first && !/^(none|null|n\/a|unknown|test)$/i.test(first) && !first.includes('@') && !/^\d/.test(first)
  const name = usable ? first : 'there'
  const greet = greetingFor(client, { now, rotation })
  return String(template || '')
    .replaceAll('{{greeting}}', greet)
    .replaceAll('{{first_name}}', name)
    .replaceAll('{{time_of_day}}', timeOfDay(now))
    // "Good morning there," reads worse than "Hi there," - swap it when we have no name.
    .replace(/^Good (morning|afternoon|evening) there,/, 'Hi there,')
}
