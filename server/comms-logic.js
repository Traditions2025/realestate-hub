// Pure, dependency-free comms helpers (unit-tested — no DB, no Twilio).

export function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '').split(':')
  return (parseInt(h, 10) || 0) * 60 + (parseInt(m, 10) || 0)
}

// Is the office open? now = { day: 0-6 (Sun=0), minutes: 0-1439 };
// cfg = { enabled, open 'HH:MM', close 'HH:MM', days: number[] }.
// Business hours off → always open. Close time is exclusive.
export function businessOpen(now, cfg = {}) {
  if (!cfg.enabled) return true
  const days = Array.isArray(cfg.days) ? cfg.days : []
  if (days.length && !days.includes(now.day)) return false
  return now.minutes >= toMinutes(cfg.open) && now.minutes < toMinutes(cfg.close)
}

// Mirrors the bulk/campaign exclusion: a STOP-to-our-number opt-out OR a stop
// status (Do Not Contact / Junk) removes a contact from a blast.
export function bulkExcluded(client = {}) {
  if (client.hub_text_opt_out) return true
  return ['junk', 'donotcontact'].includes(String(client.status || '').toLowerCase())
}
