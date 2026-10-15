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
// The site, as a full URL so every phone makes it tappable. A bare "MattSmithTeam.com"
// is plain text on a lot of handsets.
export const SITE_URL = 'https://www.mattsmithteam.com/'

export async function renderColdStageTemplate(stageIndex, approvedBody, client, { firstContact = false } = {}) {
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

  // The introduction and the site belong to the lead's FIRST message from us. Normally that
  // is Day 1 - but if Day 1 never went out, the first thing they ever hear from us is a
  // mid-sequence continuation, and they have no idea who is texting.
  //
  // Norma Walker, 2026-10-15: her first ever text was a Day 4 message, and she replied
  // "Yes. Who is this?". So firstContact is honoured as well as the stage number.
  const introHere = Number(stageIndex) === 0 || firstContact === true
  if (introHere) msg = ensureIntroduction(msg)
  msg = avoidJohnOnJohn(msg, client)

  // DAY 1 ONLY: the site, as a full tappable URL (John, 2026-10-13: "the website on day one
  // first text can still be there but make it a full link instead with html and do not say
  // you can browse listings here").
  //
  // The old bank appended "You can always browse the latest at MattSmithTeam.com" to EVERY
  // message. Two problems: the sales phrasing, and a bare domain that many phones do not
  // turn into a link. A full https URL is tappable everywhere and needs no sentence around
  // it. Later stages carry no link at all — the area outreach is the only other one.
  if (introHere) msg = `${msg} ${SITE_URL}`

  return tidyFallbackGreeting(fillTemplate(msg, client))
    .replace(/\{\{[^}]+\}\}/g, '')               // drop any unresolved merge field
    .replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
}

/**
 * fillTemplate resolves {{first_name}} to "there" when the stored name is unusable — a
 * placeholder, an email address, digits, mojibake. "Hi there!" reads fine; "Good morning,
 * there!" does not, it reads like a broken mail merge, which is the exact impression these
 * messages exist to avoid. Drop the name from a timed greeting in that case.
 */
export function tidyFallbackGreeting(text) {
  return String(text || '').replace(/^(Good (?:morning|afternoon|evening)),\s*there!/i, '$1!')
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

/** The one sentence that says who is texting. Matches the three Day 1 openers that carry it. */
export const INTRO = "It's John with Matt Smith Team at RE/MAX."

/**
 * Guarantee the introduction on a lead's first message.
 *
 * John's rule is that John introduces himself on Day 1 and the thread reads as continuous
 * after that. The copy did not implement it: only 3 of the 24 Day 1 openers actually say
 * who is texting, so 7 in 8 leads were introduced to nobody and the next thing they saw was
 * a question from an unknown number.
 *
 * This does NOT rewrite John's sentences. It inserts the same introduction the three
 * complete openers already use, immediately after the greeting, and only when the chosen
 * message does not already introduce us. A message that says it keeps its own wording.
 */
export function ensureIntroduction(text) {
  const msg = String(text || '')
  if (/Matt Smith Team/i.test(msg)) return msg   // already introduces us; leave John's words alone
  // Insert after the opening greeting so it reads "Hi Norma! It's John with ... RE/MAX. ..."
  const greeting = /^((?:Hi|Hello|Hey|Good (?:morning|afternoon|evening)),?\s*\{\{first_name\}\}[!.,]?\s*)/i
  const m = greeting.exec(msg)
  if (m) return m[1].trimEnd() + ' ' + INTRO + ' ' + msg.slice(m[1].length)
  // No recognisable greeting (or no name): lead with the introduction.
  return INTRO + ' ' + msg
}

/**
 * Does this message claim we have spoken before?
 *
 * Half the Day 1 openers do - "since we last talked", "we connected a while back", "I was
 * looking back at our conversation". That is right for a dormant lead we really did speak
 * to, and wrong for a lead who only ever registered on the site.
 *
 * Toni Cress, 2026-10-15: enrolled on the COLD_NEVER_CONNECTED lane, with zero prior
 * communications of any kind, and her first ever message asked whether things had changed
 * "since we last talked". She replied STOP twenty-five minutes later. The system knew we
 * had never spoken and said we had anyway.
 */
export function assumesPriorContact(text) {
  return /we last (?:talked|spoke|connected|chatted)|last time we|we connected|since we (?:talked|spoke|connected)|reconnect|when we (?:talked|spoke)|our conversation|back when you|we spoke|staying in touch after/i
    .test(String(text || ''))
}

/**
 * Pick the messages usable for a lead we have never actually spoken to. Falls back to the
 * whole bank if filtering would leave nothing, because sending a slightly-off message
 * beats sending none.
 */
export function bankForStranger(messages) {
  const ok = (messages || []).filter(t => !assumesPriorContact(t))
  return ok.length ? ok : (messages || [])
}
