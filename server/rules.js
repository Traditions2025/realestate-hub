// THE TUNABLE RULES, IN ONE PLACE (John, 2026-10-16).
//
// Every number that decides when and how often we contact somebody used to be either a
// constant in a file or an unlabelled row in app_settings. Changing one meant asking me and
// waiting for a deploy. This is the registry that makes them editable and, more importantly,
// makes them SAFE to edit.
//
// THE SAFETY MODEL, which is the whole point of this file:
//
//   A setting is a DIAL INSIDE A FIXED RANGE. It is never an override.
//
// Every rule declares a hard `min` and `max` that live in code, not in the database. A
// stored value outside that range is clamped, and a missing, blank, non-numeric or
// otherwise unusable value falls back to the DEFAULT. There is no input, and no corrupted
// row, that can widen a sending window past its ceiling, raise a cap past its ceiling, or
// turn a limit into "unlimited".
//
// Two consequences worth stating plainly, because they are the reason this is not just a
// settings table:
//
//   1. FAILURE IS ALWAYS TOWARD LESS SENDING. Every fallback is the safe end. If the
//      database is unreadable, the rules do not become permissive — they become the
//      defaults, which are the values that are live today.
//   2. THE GUARDS ARE NOT HERE. Nothing in forbidden.js, emailHardBlock or the STOP
//      handling is tunable, and nothing in this file can reach them. Those exist because
//      four separate fixes failed in that area, and a guard somebody can switch off in a
//      UI is not a guard. They belong in code with a test, and they stay there.
//
// DEFAULTS MUST EQUAL TODAY'S BEHAVIOUR. Every default below is the value that was live on
// 2026-10-16, so publishing this file changes nothing on its own. There is a test asserting
// exactly that, because a "refactor" that quietly moves a send window is the worst possible
// outcome here.
import db from './database.js'

/**
 * group  — matches the Outreach Rules document, so a rule in the PDF is findable here
 * key    — the app_settings key, unchanged where one already existed
 * min/max— HARD bounds. Code, not data. A stored value outside is clamped.
 * why    — what moving this actually does, in one line, for the person editing it
 */
export const RULES = {
  // ---- Email -------------------------------------------------------------
  max_emails_per_week: {
    group: 'Email', label: 'Emails per person per week', type: 'int',
    def: 2, min: 1, max: 7, unit: 'emails',
    why: 'Across every campaign and manual send, in a rolling 7 days.',
  },
  max_emails_per_day: {
    group: 'Email', label: 'Emails per person per day', type: 'int',
    def: 1, min: 1, max: 3, unit: 'emails',
    why: 'A second email the same day is held to tomorrow.',
  },
  max_emails_per_fortnight_past_client: {
    group: 'Email', label: 'Emails per past client per 14 days', type: 'int',
    def: 1, min: 1, max: 4, unit: 'emails',
    why: 'Past clients only. Counted across every campaign.',
  },
  drip_hold_days_after_email_reply: {
    group: 'Email', label: 'Hold a drip after they email us', type: 'int',
    def: 30, min: 1, max: 180, unit: 'days',
    why: 'Measured from their last email. The drip resumes by itself afterwards.',
  },

  // ---- Texting -----------------------------------------------------------
  // The window is the single most dangerous dial here: widening it is how a lead gets a
  // text at 7am. The hard bounds keep it inside daylight whatever the stored value says.
  proactive_start_hour: {
    group: 'Texting', label: 'Texting starts at', type: 'hour',
    def: 9, min: 8, max: 11, unit: ':00 Central',
    why: 'No automated text goes out before this hour, on any campaign.',
  },
  proactive_end_hour: {
    group: 'Texting', label: 'Texting stops at', type: 'hour',
    def: 17, min: 12, max: 19, unit: ':00 Central',
    why: 'Also decides when the greeting switches from "Good afternoon" to "Hello".',
  },
  text_dedupe_minutes: {
    group: 'Texting', label: 'Minimum gap between automated texts', type: 'int',
    def: 60, min: 15, max: 1440, unit: 'minutes',
    why: 'Stops two systems texting the same person minutes apart.',
  },
  human_conversation_hours: {
    group: 'Texting', label: 'Automation stays out after you text', type: 'int',
    def: 12, min: 1, max: 72, unit: 'hours',
    why: 'How long an automation waits after a person replies to you.',
  },

  // ---- The AI ------------------------------------------------------------
  ai_reactivation_daily_limit: {
    group: 'The AI', label: 'AI leads enrolled per day', type: 'int',
    def: 70, min: 1, max: 300, unit: 'leads',
    why: 'The reactivation lane only. Higher means more first texts per day.',
  },
  ai_enroll_defer_human_hours: {
    group: 'The AI', label: 'AI waits behind a person', type: 'int',
    def: 24, min: 1, max: 168, unit: 'hours',
    why: 'How long the AI holds off after anyone on the team contacts the lead.',
  },
  ai_fresh_window_days: {
    group: 'The AI', label: 'A lead counts as "fresh" for', type: 'int',
    def: 7, min: 1, max: 60, unit: 'days',
    why: 'New leads created inside this window go into the fresh lane.',
  },
  watch_no_text_months: {
    group: 'The AI', label: 'Watch lead must be quiet for', type: 'int',
    def: 6, min: 1, max: 24, unit: 'months',
    why: 'A Watch lead texted more recently than this is left to whoever is handling them.',
  },

  // ---- Who gets added ----------------------------------------------------
  home_value_daily_limit: {
    group: 'Who gets added', label: 'Home Value enrolled per day', type: 'int',
    def: 300, min: 1, max: 1000, unit: 'people',
    why: 'Shared across the weekly and past-client versions.',
  },
  home_value_recent_lookup_days: {
    group: 'Who gets added', label: 'Skip if they checked their value within', type: 'int',
    def: 30, min: 1, max: 365, unit: 'days',
    why: 'Stops us asking someone to check a value they just checked.',
  },
  home_value_defer_days_after_use: {
    group: 'Who gets added', label: 'Pause Home Value after they use the tool', type: 'int',
    def: 90, min: 7, max: 365, unit: 'days',
    why: 'The campaign steps aside for a person, then resumes on its own.',
  },
  fsbo_campaign_dom_threshold: {
    group: 'Who gets added', label: 'FSBO follow-up starts at', type: 'int',
    def: 14, min: 1, max: 120, unit: 'days on market',
    why: 'How long a FSBO has been listed before we first reach out.',
  },
  fsbo_availability_days: {
    group: 'Who gets added', label: 'FSBO availability check every', type: 'int',
    def: 30, min: 7, max: 180, unit: 'days',
    why: 'After the opening texts, how often we ask if it is still available.',
  },
}

/** The safe value for a rule: stored if usable and in range, otherwise the default. */
export function rule(key) {
  const spec = RULES[key]
  if (!spec) throw new Error(`unknown rule: ${key}`)
  let raw
  try { raw = db.getSetting?.(key, null) } catch { raw = null }
  if (raw === null || raw === undefined || String(raw).trim() === '') return spec.def
  const n = Number(raw)
  // NaN, Infinity, nonsense text: fall back to the default rather than guessing. Clamping
  // NaN would produce the MIN, which for a cap is the safe end but for a window start is
  // the permissive one, so the default is the only consistently safe answer.
  if (!Number.isFinite(n)) return spec.def
  const v = spec.type === 'int' || spec.type === 'hour' ? Math.round(n) : n
  return Math.min(spec.max, Math.max(spec.min, v))
}

/** Every rule with its current value, for the settings screen and the audit. */
export function allRules() {
  return Object.entries(RULES).map(([key, spec]) => {
    let stored = null
    try { stored = db.getSetting?.(key, null) } catch {}
    const value = rule(key)
    const hasStored = stored !== null && stored !== undefined && String(stored).trim() !== ''
    return {
      key, ...spec, value,
      stored: hasStored ? String(stored) : null,
      at_default: !hasStored || value === spec.def,
      // Surfaced so a nonsense stored value is visible rather than silently corrected.
      clamped: hasStored && Number.isFinite(Number(stored)) && Number(stored) !== value,
    }
  })
}

/**
 * Change a rule. Returns what was actually applied, which may differ from what was asked
 * for — the caller is expected to show that back rather than assume it took.
 */
export function setRule(key, value, actor = 'agent') {
  const spec = RULES[key]
  if (!spec) return { ok: false, reason: `unknown rule: ${key}` }

  // REFUSE, do not coerce. Number('') and Number([]) are both 0 and both FINITE, so a
  // bare isFinite check let an empty form field through as a zero and then clamped it to
  // the minimum. Submitting a blank box would have quietly moved "texting stops at" from
  // 5pm to noon. Caught by the stress test before this shipped; the lesson is that
  // coercion and validation are not the same thing.
  const raw = typeof value === 'string' ? value.trim() : value
  const usable = (typeof raw === 'number' && Number.isFinite(raw))
    || (typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw)))
  if (!usable) return { ok: false, reason: 'not a number', key, unchanged: rule(key) }
  const n = Number(raw)
  const rounded = Math.round(n)
  const applied = Math.min(spec.max, Math.max(spec.min, rounded))
  const before = rule(key)
  db.setSetting(key, String(applied))
  try {
    db.run('INSERT INTO activity_log (action, entity_type, entity_id, details) VALUES (?,?,?,?)',
      ['rule_changed', 'setting', null,
       `${key}: ${before} -> ${applied}${applied !== rounded ? ` (asked for ${rounded}, clamped to the ${applied === spec.max ? 'maximum' : 'minimum'})` : ''} by ${actor}`])
  } catch {}
  return { ok: true, key, before, applied, asked: rounded, clamped: applied !== rounded, spec }
}

/** Reset a rule to the value that was live when this registry was written. */
export function resetRule(key, actor = 'agent') {
  const spec = RULES[key]
  if (!spec) return { ok: false, reason: `unknown rule: ${key}` }
  return setRule(key, spec.def, actor)
}
