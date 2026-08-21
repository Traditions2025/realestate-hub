// HUB AI feature flags + config. All autonomous features default OFF in production
// until configuration + tests pass. Stored in app_settings.
import db from '../database.js'

export const AI_FLAGS = [
  'ai_followup_enabled',        // master switch
  'ai_autopilot',               // OFF = manual: AI only acts on leads an agent enables + no sweeps.
  'ai_responsive_text_enabled', // reply to inbound texts
  'ai_proactive_text_enabled',  // first-touch new leads (only when autopilot on)
  'ai_nurture_enabled',         // long-term / re-engagement (only when autopilot on)
  'ai_behavioral_enabled',      // website/IDX-triggered (only when autopilot on)
  'ai_voice_enabled',           // AI voice (future)
  'ai_auto_handoff_enabled',    // auto-create handoffs on high intent
]

// Autopilot ON = AI may act on all eligible leads + the enqueue sweeps run.
// Autopilot OFF (default) = AI only acts on leads explicitly enabled by an agent.
export function autopilotOn() { return db.getSetting('ai_autopilot', '0') === '1' }

export const AI_CONFIG_DEFAULTS = {
  ai_new_lead_delay_minutes: '5',
  ai_first_followup_minutes: '10',   // if no reply to the opener, send a qualifying follow-up after this many minutes
  ai_followup_max_per_day: '4',
  ai_quiet_hours_start: '21:00',
  ai_quiet_hours_end: '08:00',
  ai_quiet_hours_tz: 'America/Chicago',
  ai_intent_handoff_threshold: '70',
  ai_pause_after_human: '1',
  ai_pause_after_call: '1',
  ai_persona: 'John with Matt Smith Team at RE/MAX Concepts',
  ai_default_owner: 'Matt',
  ai_response_delay_seconds: '0',
  // ---- Autopilot exclusions (imported prospecting lists that never opted in). A
  // lead is excluded if it matches ANY tag/source substring, OR any status, OR any
  // combination rule (tag AND status both match). An agent can still enable AI manually.
  ai_autopilot_exclude: 'fsbo,mls: expired,mls: cancelled',   // tag/source substrings
  ai_exclude_statuses: '',                                    // comma statuses (lowercased match)
  ai_exclude_rules: '[]',                                     // JSON [{tag, status}] — both must match
}

export function getFlags() { const o = {}; for (const f of AI_FLAGS) o[f] = db.getSetting(f, '0') === '1'; return o }
export function flag(name) { return db.getSetting(name, '0') === '1' }
export function getConfig() { const o = {}; for (const [k, v] of Object.entries(AI_CONFIG_DEFAULTS)) o[k] = db.getSetting(k, v); return o }

// True when the current time (in the configured TZ) is inside the quiet window,
// which may wrap past midnight (e.g. 21:00 → 08:00). Autonomous sends are blocked.
export function inQuietHours(now = new Date()) {
  try {
    const tz = db.getSetting('ai_quiet_hours_tz', 'America/Chicago')
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(now)
    const get = (t) => (parts.find(x => x.type === t) || {}).value
    let hh = parseInt(get('hour'), 10); if (hh === 24) hh = 0
    const cur = hh * 60 + parseInt(get('minute'), 10)
    const toMin = (s) => { const [a, b] = String(s).split(':'); return (parseInt(a, 10) || 0) * 60 + (parseInt(b, 10) || 0) }
    const start = toMin(db.getSetting('ai_quiet_hours_start', '21:00'))
    const end = toMin(db.getSetting('ai_quiet_hours_end', '08:00'))
    if (start === end) return false
    return start < end ? (cur >= start && cur < end) : (cur >= start || cur < end)   // wrap past midnight
  } catch { return false }
}
