// Render a cold-buyer drip stage as a TEMPLATE (no Claude): approved bank message + merge
// fields. Claude stays reserved for inbound replies.
//
// REWRITTEN 2026-10-13 for John's new message bank. What changed and why:
//
// - The bank messages are now SELF-CONTAINED. Each one carries its own greeting and the
//   lead's first name. This file used to bolt "Good afternoon {{first_name}}, it's John with
//   Matt Smith Team at RE/MAX." onto the front of a bare question and append
//   "You can always browse the latest at MattSmithTeam.com" to every single message. Both are
//   gone: the first is what made these read like a CRM prompt, and the second was asking for
//   a click when the whole point of the text is a reply.
//
// - The greeting is CORRECTED to the send time instead of being trusted. The bank mixes
//   "Good morning", "Good afternoon" and "Hi" across its variants, and the rotation does not
//   know what time it is. Sending "Good morning" at 4pm is exactly the tell that gives an
//   automation away, so a mismatched greeting is rewritten. "Hi" is time-neutral and is left
//   alone, which preserves the intended mix.
export async function renderColdStageTemplate(stageIndex, approvedBody, client) {
  const { fillTemplate } = await import('../routes/email.js')

  // {{area}} -> the lead's search city, cleaned, with a safe fallback so a message never
  // ships a literal "{{area}}", a stray comma, or a bare "IA".
  let area = ''
  try { area = fillTemplate('{{city_of_interest}}', client).split(',')[0].trim() } catch {}
  if (!area || /^\d/.test(area)) area = 'your area'
  else area = area.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())

  let msg = String(approvedBody || '')
    .replace(/\{\{\s*area\s*\}\}/gi, area)
    .replace(/\[area\]/gi, area)                 // old bank spelling, still tolerated
    .replace(/\[price\]/gi, 'the right price')

  msg = fixGreetingForTime(msg)
  msg = avoidJohnOnJohn(msg, client)

  return fillTemplate(msg, client)
    .replace(/\{\{[^}]+\}\}/g, '')               // drop any unresolved merge field
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
}

/** 'morning' before noon Central, 'afternoon' to 5pm, otherwise 'evening'. */
export function centralPeriod(now = new Date()) {
  let hr
  try {
    hr = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', hour12: false })
      .formatToParts(now).find(p => p.type === 'hour')?.value)
  } catch { hr = now.getHours() }
  if (!Number.isFinite(hr)) return 'evening'
  if (hr < 12) return 'morning'
  if (hr < 17) return 'afternoon'
  return 'evening'
}

/**
 * Rewrite a leading "Good morning," / "Good afternoon," that does not match the send time.
 *
 * "Hi" is deliberately untouched: it works at any hour, and leaving it is what keeps the
 * bank's intended variety. In the evening a timed greeting becomes "Hi", because the bank
 * has no evening wording and inventing one would not be John's copy.
 */
export function fixGreetingForTime(text, now = new Date()) {
  const m = /^Good (morning|afternoon),\s*/i.exec(String(text || ''))
  if (!m) return text
  const period = centralPeriod(now)
  if (period === m[1].toLowerCase()) return text
  const rest = text.slice(m[0].length)
  if (period === 'evening') {
    // "Good morning, {{first_name}}! ..." -> "Hi {{first_name}}! ..."  (no comma after Hi)
    return 'Hi ' + rest
  }
  return `Good ${period}, ${rest}`
}

/**
 * Never send "Hi John! It's John with Matt Smith Team" to a lead who is also called John.
 * Only the Day 1 openers introduce John, so this only ever fires there.
 */
export function avoidJohnOnJohn(text, client) {
  const fn = String(client?.first_name || '').trim().toLowerCase()
  if (fn !== 'john') return text
  return String(text)
    .replace(/It's John with Matt Smith Team at RE\/MAX\./i, "It's John with Matt Smith Team at RE/MAX.")
    .replace(/^(Hi|Good (?:morning|afternoon|evening)),?\s*\{\{first_name\}\}!\s*/i, (m) =>
      m.replace(/,?\s*\{\{first_name\}\}/i, ''))
}
