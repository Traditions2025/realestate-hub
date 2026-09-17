// FACEBOOK AD LEAD FIRST-TEXT BANK — John's approved copy, 2026-09-17, verbatim.
// No Claude in this path: the opener is always one of these 12 templates.
// Testing dimensions (per John): rotate the TEMPLATE across leads, rotate the
// INTRO (Hi / Hello / time-of-day) across leads, and every text ends with the
// website. {{first_name}} ← lead's first name; {{property_address}} ← the
// property from the ad they registered on (fallback phrase when missing).
import db from '../database.js'

const WEBSITE_TAIL = 'You can see more homes at www.mattsmithteam.com'

// Each body EXACTLY as approved, with INTRO (leading greeting word) and fields
// tokenized. %I = intro, %N = first name, %P = property address.
export const FB_AD_TEMPLATES = [
  { key: 'simple_direct', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) You were checking out %P on Facebook. Were you interested in that home specifically, or mostly just browsing?" },
  { key: 'availability', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) I saw you were looking at %P on Facebook. Are you interested in seeing if it's still available?" },
  { key: 'information', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) You were looking at the home at %P on Facebook. Was there anything about the property you wanted more information on?" },
  { key: 'interest', body: "%I %N, it's John with Matt Smith Team at RE/MAX. You recently checked out %P on Facebook :) Did that particular home catch your interest?" },
  { key: 'browsing_vs_buying', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) You came across %P on Facebook. Are you looking for a home right now, or mostly keeping an eye on what's available?" },
  { key: 'property_casual', body: "%I %N :) John with Matt Smith Team at RE/MAX. Just wanted to follow up on %P that you were checking out on Facebook. What did you think of it?" },
  { key: 'specific_vs_similar', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) You were checking out %P on Facebook. Is that particular home what caught your attention, or are you looking for something similar?" },
  { key: 'showing', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) I'm reaching out about %P that you saw on Facebook. Were you just checking it out online, or would you potentially want to see it in person?" },
  { key: 'help', body: "%I %N, John with Matt Smith Team at RE/MAX :) You were looking at %P on Facebook, so I wanted to reach out. Is there anything you'd like to know about the home?" },
  { key: 'shortest', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) You were checking out %P on Facebook. Were you interested in that particular home?" },
  { key: 'search_intent', body: "%I %N, John with Matt Smith Team at RE/MAX :) I saw you were checking out %P on Facebook. Is that around the area and price range you've been looking for?" },
  { key: 'conversation_starter', body: "%I %N, it's John with Matt Smith Team at RE/MAX :) You recently took a look at %P on Facebook. Was there something about that home that caught your eye?" },
]

// Intro rotation: Hi → Hello → time-of-day (Central; never "evening" — sends are daytime).
export function introVariant(idx) {
  const n = ((idx % 3) + 3) % 3
  if (n === 0) return 'Hi'
  if (n === 1) return 'Hello'
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(new Date()))
  return h < 12 ? 'Good morning' : h < 16 ? 'Good afternoon' : 'Hello'
}

// NO-REPLY FOLLOW-UP EMAIL (~10 min after the opener text, only if silent):
// about their inquiry — references the property they registered on.
export function renderFbAdEmail(client, property) {
  const first = String(client?.first_name || '').trim() || 'there'
  const prop = String(property || '').trim() || 'the home you saw on Facebook'
  // EMAILS ALWAYS IDENTIFY AS MATT SMITH (John, 2026-09-17): they send from
  // Matt's marketing address — introducing as John there is confusing. The
  // John persona is for TEXTS only.
  const subject = `Your inquiry on ${prop}`
  const body = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.6;">
<p>Hi ${first},</p>
<p>Matt Smith here with RE/MAX. You asked about ${prop} on Facebook, so my team sent you a quick text a few minutes ago as well.</p>
<p>Happy to get you anything you need on the home: full details, photos, or a time to see it in person. Just reply to this email or text us at (319) 343-1562 and let me know what would help.</p>
<p>You can also browse more homes anytime at <a href="https://www.mattsmithteam.com">www.mattsmithteam.com</a>.</p>
<p>Matt Smith<br>Matt Smith Team | RE/MAX Concepts</p></div>`
  return { subject, body }
}

// Render the next opener for a lead: rotates template and intro independently so
// the test covers combinations; returns { key, intro, text }.
export function renderFbAdOpener(client, property, { advance = true } = {}) {
  const t = Number(db.getSetting('fb_ad_tpl_rot', '0')) || 0
  const i = Number(db.getSetting('fb_ad_intro_rot', '0')) || 0
  if (advance) {
    db.setSetting('fb_ad_tpl_rot', String((t + 1) % FB_AD_TEMPLATES.length))
    db.setSetting('fb_ad_intro_rot', String((i + 1) % 3))
  }
  const tpl = FB_AD_TEMPLATES[t % FB_AD_TEMPLATES.length]
  const intro = introVariant(i)
  const first = String(client?.first_name || '').trim() || 'there'
  const prop = String(property || '').trim() || 'the home you saw'
  const text = tpl.body.replace('%I', intro).replace('%N', first).replaceAll('%P', prop) + ' ' + WEBSITE_TAIL
  return { key: tpl.key, intro, text }
}
