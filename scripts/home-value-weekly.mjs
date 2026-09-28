// Home Value Weekly — 6 Month : 26 homeowner emails, one every 7 days.
//
// Built as data + one shell, not 26 hand-written HTML files, so subject lines, copy,
// CTA labels, order and timing are all editable afterwards: the 26 land as ordinary Hub
// templates (Templates tab) and the schedule lands as an ordinary drip (Campaigns), both
// editable in the UI. Re-running this updates in place by name — it never duplicates.
//
// Usage:  node scripts/home-value-weekly.mjs [--dry] [--base <url>]
//
// Design follows the brief: brand -> headline -> short useful body -> ONE button -> clean
// footer. Palette is sampled from the team logo itself (#191a2e background, gold #c9a227),
// so the header band is seamless with the logo rather than a navy rectangle on white.
//
// DATA INTEGRITY: no email claims a value moved, a neighbour sold, or an equity/mortgage
// figure. Every line is evergreen ("recent sales CAN influence...") because the Hub holds
// no per-property valuation feed. See the note at the bottom of the file.
import fs from 'fs'
import path from 'path'

const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const BASE = (args[args.indexOf('--base') + 1] && args.includes('--base')) ? args[args.indexOf('--base') + 1] : 'https://realestate-hub-1rzu.onrender.com'
const CAMPAIGN = 'Home Value Weekly — 6 Month'
const CATEGORY = 'Home Value Weekly'
const LOGO = 'https://realestate-hub-1rzu.onrender.com/logo.jpg'

// ---- palette, sampled from the logo ---------------------------------------------
const NAVY = '#191a2e'   // logo background, so the header band is seamless
const GOLD = '#c9a227'   // brand gold that still reads on white (the logo's own is a pale highlight)
const INK = '#1f2937'
const BODY = '#4b5563'
const MUTED = '#8a8f98'
const RULE = '#e6e8ec'
const PAGE = '#f2f3f5'

// ---- the shell ------------------------------------------------------------------
// Table-based and inline-styled: Outlook and Gmail strip <style> blocks, so every rule
// has to ride on the element. 640px card, single column, so it reflows on a phone with
// no horizontal scroll and a full-width tappable button.
function shell({ headline, paras, cta, ctaUrl = '{{home_value_url}}' }) {
  const p = paras.map(t =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BODY};">${t}</p>`).join('\n          ')
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};margin:0;padding:0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${RULE};">
      <tr><td align="center" style="background:${NAVY};padding:22px 24px;">
        <img src="${LOGO}" alt="Matt Smith Team, RE/MAX Concepts" width="210" style="display:block;width:210px;max-width:60%;height:auto;border:0;" />
      </td></tr>
      <tr><td style="height:3px;background:${GOLD};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 32px 8px;">
        <h1 style="margin:0 0 18px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:25px;line-height:1.3;font-weight:700;color:${INK};">${headline}</h1>
        <div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BODY};">Hi {{first_name}},</p>
          ${p}
        </div>
      </td></tr>
      <tr><td align="center" style="padding:10px 32px 34px;">
        <a href="${ctaUrl}" style="display:inline-block;background:${NAVY};color:#ffffff;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;letter-spacing:.03em;text-decoration:none;padding:15px 34px;border-radius:6px;">${cta}</a>
      </td></tr>
      <tr><td style="padding:0 32px;"><div style="height:1px;background:${RULE};font-size:0;line-height:0;">&nbsp;</div></td></tr>
      <tr><td style="padding:20px 32px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <p style="margin:0 0 4px;font-size:14px;font-weight:700;color:${INK};">Matt Smith Team | RE/MAX Concepts</p>
        <p style="margin:0 0 12px;font-size:13px;color:${MUTED};"><a href="https://www.mattsmithteam.com" style="color:${MUTED};text-decoration:underline;">MattSmithTeam.com</a> &nbsp;·&nbsp; Cedar Rapids &amp; Marion, Iowa</p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">You are receiving this because you are a homeowner in our database. Estimates shown are automated and are a starting point, not an appraisal.<br /><a href="{{unsubscribe}}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a> from these updates at any time.</p>
      </td></tr>
    </table>
  </td></tr>
</table>`
}

// ---- the 26 weeks ---------------------------------------------------------------
// Subjects deliberately carry NO first name. {{first_name}} falls back to "there", which
// reads fine mid-sentence ("Hi there,") and badly at the head of a subject line
// ("there, what could..."). Every subject below reads correctly for a lead whose name,
// address or city we do not have — that is the brief's "never output broken merge-field
// language", solved by writing rather than by branching.
// Length rotates: quick hit (~45w), standard (~85w), deeper (~130w).
const WEEKS = [
  { n: 1, angle: 'VALUE', cta: 'SEE MY HOME VALUE',
    subject: 'What could {{street_address}} be worth today?',
    headline: 'Curious what your home is worth?',
    paras: ['Home values don\u2019t stay in one place. Recent sales, the homes currently available and changing buyer demand around {{city_or_area}} can all influence where a property stands today.',
      'Even if you\u2019re not planning a move, an updated estimate gives you a useful baseline for one of your largest assets.',
      'See the latest estimate for {{street_address}} and where your property could stand today.'] },
  { n: 2, angle: 'EQUITY', cta: 'DISCOVER MY EQUITY',
    subject: 'How much equity could you have in {{street_address}}?',
    headline: 'How much of your home is really yours?',
    paras: ['As a mortgage is paid down and a home\u2019s value changes, the amount of equity a homeowner may have can change too.',
      'Knowing the current estimated value of {{street_address}} gives you a starting point for understanding what you may have built over time.'] },
  { n: 3, angle: 'NEARBY_SALES', cta: 'SEE NEARBY SALES',
    subject: 'What are homes around {{street_address}} selling for?',
    headline: 'Nearby sales can change the picture',
    paras: ['What a home is listed for and what a buyer ultimately pays can be very different.',
      'Recent closed sales around {{city_or_area}} can tell you how buyers are valuing homes nearby, and where {{street_address}} may fit into today\u2019s market.'] },
  { n: 4, angle: 'VALUE', cta: 'SEE MY UPDATED VALUE',
    subject: 'Where does {{street_address}} stand today?',
    headline: 'Home values don\u2019t stand still',
    paras: ['New sales happen. Inventory changes. Buyer demand shifts.',
      'Over time, those changes can influence the estimated value of a property.',
      'Take another look at where {{street_address}} could stand in today\u2019s market.'] },
  { n: 5, angle: 'COMPARISON', cta: 'COMPARE MY HOME',
    subject: 'How does {{street_address}} compare today?',
    headline: 'Your home isn\u2019t valued in isolation',
    paras: ['Buyers compare homes on location, condition, size, features, updates and what else is available at the same time.',
      'That is why understanding the homes around yours can be as useful as knowing an estimated value.',
      'See how {{street_address}} fits into the current market.'] },
  { n: 6, angle: 'IMPROVEMENTS', cta: 'REVIEW MY HOME VALUE',
    subject: 'Have you improved {{street_address}}?',
    headline: 'An algorithm hasn\u2019t walked through your home',
    paras: ['Automated estimates are useful starting points, but they may not fully account for a remodeled kitchen, a finished basement, a new roof, updated mechanicals or the current condition of the property.',
      'See the current estimate for {{street_address}}, then consider whether the details of your home could tell a different story.'] },
  { n: 7, angle: 'FINANCIAL_PLANNING', cta: 'CHECK MY PROPERTY VALUE',
    subject: 'When did you last check your home value?',
    headline: 'One of your largest assets deserves an occasional check-in',
    paras: ['People regularly check savings, investments and retirement accounts, yet years can pass without checking the estimated value of their home.',
      'Even with no plans to move, knowing where your property stands gives you a more complete picture of what you own.'] },
  { n: 8, angle: 'EQUITY', cta: 'SEE WHERE I STAND',
    subject: 'Has your equity picture changed?',
    headline: 'Two things can change at the same time',
    paras: ['Equity isn\u2019t influenced only by home values.',
      'Mortgage paydown may also change how much of the property you effectively own over time.',
      'Start with an updated estimate for {{street_address}} and see where things could stand today.'] },
  { n: 9, angle: 'MARKET', cta: 'EXPLORE MY AREA',
    subject: 'What\u2019s happening around {{street_address}}?',
    headline: 'Your neighborhood helps tell the story',
    paras: ['Recent sales, new listings and changing competition around a property offer useful clues about how the local market is behaving.',
      'Take a look at what\u2019s happening around {{street_address}} and how your home could fit into the picture.'] },
  { n: 10, angle: 'PROFESSIONAL_VALUE', cta: 'SEE MY ESTIMATE',
    subject: 'How accurate is the estimate for {{street_address}}?',
    headline: 'A home is more than public records',
    paras: ['Automated valuations lean heavily on available property and market data.',
      'What they can\u2019t always read is condition, layout, improvements, finishes and the other differences between two homes that look similar on paper.',
      'See your current estimate and use it as a starting point.'] },
  { n: 11, angle: 'FINANCIAL_PLANNING', cta: 'SEE WHERE MY HOME STANDS',
    subject: 'What could your home value mean for your next move?',
    headline: 'Your current home can shape what\u2019s possible next',
    paras: ['If another home ever becomes part of your plans, the value and equity in your current property can become an important part of the equation.',
      'Even if that is well down the road, understanding where {{street_address}} stands today gives you a useful place to start.'] },
  { n: 12, angle: 'FINANCIAL_PLANNING', cta: 'CHECK MY HOME VALUE',
    subject: 'Could your home give you more options than you think?',
    headline: 'Knowing your value can make future decisions easier',
    paras: ['Moving to something larger, downsizing, relocating or staying exactly where you are can all look different depending on what your current home is worth.',
      'You don\u2019t need to be planning a move to understand your options.'] },
  { n: 13, angle: 'VALUE', cta: 'VIEW MY LATEST VALUE',
    subject: 'Time for another look at {{street_address}}',
    headline: 'A lot can change in a few months',
    paras: ['New homes have listed. Others have sold. Buyers have made decisions.',
      'Those changes create new information about the market around {{street_address}}.',
      'See where your property stands now.'] },
  { n: 14, angle: 'NEARBY_SALES', cta: 'SEE MARKET IMPACT',
    subject: 'Recent {{city_or_area}} sales are worth a look',
    headline: 'Closed sales tell us something asking prices can\u2019t',
    paras: ['An asking price shows what a homeowner hopes to receive.',
      'A closed sale shows what a buyer and seller actually agreed on.',
      'That is one reason recent closed sales are useful when you\u2019re working out where your own property may stand.'] },
  { n: 15, angle: 'FINANCIAL_PLANNING', cta: 'SEE MY CURRENT VALUE',
    subject: 'Why your current home value can matter',
    headline: 'Home value isn\u2019t only useful when you\u2019re moving',
    paras: ['There are several situations where understanding a property\u2019s current value may be useful, including certain refinancing or borrowing decisions and longer-term financial planning.',
      'Even if none of those are on your radar today, an updated estimate gives you a reference point.'] },
  { n: 16, angle: 'MARKET', cta: 'CHECK MY PROPERTY',
    subject: 'What\u2019s changed in the {{city_or_area}} housing market?',
    headline: 'The market keeps moving',
    paras: ['Inventory, buyer demand, recent sales and available competition can all change over time.',
      'Your home doesn\u2019t exist separately from those changes.',
      'See the latest information around {{street_address}} and where your property could fit today.'] },
  { n: 17, angle: 'IMPROVEMENTS', cta: 'REVIEW MY ESTIMATE',
    subject: 'What can\u2019t an online estimate see?',
    headline: 'Two similar homes can have very different stories',
    paras: ['Square footage and public records only tell part of the story.',
      'Condition, maintenance, improvements, layout and overall presentation can all influence how buyers compare one property with another.',
      'Start with the estimate for {{street_address}}, then decide whether the property deserves a closer look.'] },
  { n: 18, angle: 'FINANCIAL_PLANNING', cta: 'SEE MY HOME VALUE',
    subject: 'What could your home value mean for your future plans?',
    headline: 'The estimated value is only the starting point',
    paras: ['If a move ever becomes part of the plan, the home\u2019s value is one part of a larger picture.',
      'Mortgage balance, transaction expenses, potential repairs, concessions and timing can all influence the eventual outcome.',
      'The first useful number to understand is where the property could stand today.'] },
  { n: 19, angle: 'BUYER_PERSPECTIVE', cta: 'COMPARE MY HOME',
    subject: 'What would buyers compare {{street_address}} to?',
    headline: 'Buyers rarely evaluate a home by itself',
    paras: ['They weigh price, condition, location, features and the other homes available before deciding which property feels like the better fit.',
      'Understanding that competition helps put your home\u2019s estimated value into context.'] },
  { n: 20, angle: 'EQUITY', cta: 'DISCOVER MY EQUITY',
    subject: 'Worth another look at your home equity?',
    headline: 'Your equity picture can evolve',
    paras: ['Home values can move, and mortgage balances generally change over time as well.',
      'That means the equity picture you had a year or two ago may not look the same today.',
      'Start by seeing where {{street_address}} could currently stand.'] },
  { n: 21, angle: 'VALUE', cta: 'SEE MY MARKET VALUE',
    subject: 'Is your assessed value your home\u2019s market value?',
    headline: 'They\u2019re different numbers for different purposes',
    paras: ['A property tax assessment isn\u2019t necessarily the same as what buyers might pay for a home in today\u2019s market.',
      'Current competition, recent comparable sales, condition, features and buyer behaviour can all influence market value.',
      'See where {{street_address}} could stand today.'] },
  { n: 22, angle: 'VALUE', cta: 'UPDATE MY HOME VALUE',
    subject: 'How old is your last home value estimate?',
    headline: 'An old estimate can become an old picture',
    paras: ['The market around a home keeps changing after an estimate is created.',
      'New comparable sales close, inventory changes and buyer behaviour evolves.',
      'If it has been a while since you checked {{street_address}}, take another look.'] },
  { n: 23, angle: 'BUYER_PERSPECTIVE', cta: 'SEE HOW MY HOME COMPARES',
    subject: 'How might buyers see {{street_address}} today?',
    headline: 'Buyers compare choices, not just houses',
    paras: ['A buyer may weigh your home against several alternatives at different prices, locations and conditions before deciding what represents the best opportunity.',
      'That comparison can influence how a property is perceived in the current market.',
      'See where {{street_address}} fits today.'] },
  { n: 24, angle: 'VALUE', cta: 'EXPLORE MY HOME VALUE',
    subject: 'Is {{street_address}} really worth one exact number?',
    headline: 'Home value isn\u2019t always one perfect number',
    paras: ['Automated estimates can make property valuation look extremely precise.',
      'In practice, comparable sales, condition, improvements and current competition can support a range of possible values rather than one magic figure.',
      'Explore the latest estimate for {{street_address}}.'] },
  { n: 25, angle: 'PROFESSIONAL_VALUE', cta: 'REVIEW MY HOME VALUE',
    subject: 'Want a closer look at {{street_address}}?',
    headline: 'An estimate is a starting point',
    paras: ['Online valuations are convenient for keeping tabs on a property, but there is a limit to what an algorithm can know.',
      'A closer review can weigh condition, updates, layout, improvements and other details that never appear in public data.',
      'Start with your latest estimate. If you would like something more specific afterwards, it is easy to ask from there.'] },
  { n: 26, angle: 'VALUE', cta: 'SEE MY LATEST HOME VALUE',
    // The brief reuses week 4's subject here. Gmail threads on subject, so an identical
    // line would collapse the six-month review into the week-4 email and bury it. Same
    // meaning, own thread.
    subject: 'Six months on: where does {{street_address}} stand?',
    headline: 'Time for a fresh look at your home',
    paras: ['Over the last six months, homes have listed, buyers have made decisions and new sales have created more information about the market.',
      'Whether you are considering a move or simply keeping tabs on your property, it is useful to know where things stand today.',
      'Take a fresh look at {{street_address}}.'] },
]

// ---- guard rails the brief asks for, enforced here rather than trusted -----------
const BANNED_SUBJECT = /\$|\bdollars?\b|\bcash\b|\bmoney\b|\bprofit\b|\bpayout\b|\bwindfall\b|\bguaranteed\b|\bjackpot\b|urgent|act now|last chance|exploding/i
function audit() {
  const problems = []
  const subjects = new Set(), ctas = new Map()
  for (const w of WEEKS) {
    if (BANNED_SUBJECT.test(w.subject)) problems.push(`week ${w.n}: banned wording in subject "${w.subject}"`)
    if (w.subject.length > 78) problems.push(`week ${w.n}: subject ${w.subject.length} chars, will truncate`)
    subjects.add(w.subject)
    ctas.set(w.cta, (ctas.get(w.cta) || 0) + 1)
    const words = w.paras.join(' ').split(/\s+/).length
    if (words < 25 || words > 170) problems.push(`week ${w.n}: body ${words} words, outside 25-170`)
  }
  if (WEEKS.length !== 26) problems.push(`expected 26 weeks, found ${WEEKS.length}`)
  if (ctas.size < 14) problems.push(`only ${ctas.size} distinct CTA labels across 26 emails`)
  return { problems, distinctSubjects: subjects.size, distinctCtas: ctas.size }
}

// ---- build + publish -------------------------------------------------------------
const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.json())
if (!login.token) { console.error('login failed'); process.exit(1) }
const H = { 'x-auth-token': login.token, 'content-type': 'application/json' }

const a = audit()
console.log(`audit: ${a.problems.length ? a.problems.length + ' PROBLEM(S)' : 'clean'} | ${a.distinctSubjects}/26 distinct subjects | ${a.distinctCtas} distinct CTA labels`)
a.problems.forEach(p => console.log('   !! ' + p))
if (a.problems.length) process.exit(1)

const existing = await fetch(BASE + '/api/templates', { headers: H }).then(r => r.json())
const all = Array.isArray(existing) ? existing : (existing.templates || [])
const byName = new Map(all.map(t => [t.name, t]))

const stepIds = []
for (const w of WEEKS) {
  const name = `Home Value ${String(w.n).padStart(2, '0')} — ${w.headline}`
  const payload = {
    name, type: 'email', category: CATEGORY, subject: w.subject,
    body: shell({ headline: w.headline, paras: w.paras, cta: w.cta }),
    is_html: 1, tags: `home-value, homeowner, weekly, angle:${w.angle.toLowerCase()}`,
  }
  let id
  const hit = byName.get(name)
  if (DRY) { id = hit ? hit.id : `(new)`; }
  else if (hit) { await fetch(`${BASE}/api/templates/${hit.id}`, { method: 'PUT', headers: H, body: JSON.stringify(payload) }); id = hit.id }
  else { id = (await fetch(BASE + '/api/templates', { method: 'POST', headers: H, body: JSON.stringify(payload) }).then(r => r.json())).id }
  stepIds.push({ n: w.n, id, cta: w.cta, angle: w.angle })
  console.log(`  week ${String(w.n).padStart(2)}  tmpl ${String(id).padStart(4)}  ${w.cta}`)
}

if (DRY) { console.log('\n--dry: nothing written'); process.exit(0) }

// One step per week, 7 days apart. Step 1 goes out on enrollment (delay 0).
const steps = stepIds.map((s, i) => ({
  id: `hvw${String(s.n).padStart(2, '0')}`, template_id: Number(s.id),
  delay_days: i === 0 ? 0 : 7, send_time: '09:00', send_time_end: '16:00', include_properties: false,
}))
const drips = await fetch(BASE + '/api/drips', { headers: H }).then(r => r.json())
const existingDrip = (Array.isArray(drips) ? drips : []).find(d => d.name === CAMPAIGN)
const dripPayload = {
  name: CAMPAIGN,
  description: '26 homeowner emails, one every 7 days for 6 months. Gives a homeowner a new, legitimate reason each week to look at their property. Pauses the moment they reply — a reply is a person to talk to, not a step to advance.',
  steps,
  pause_on_reply: 1,
}
let dripId
if (existingDrip) { await fetch(`${BASE}/api/drips/${existingDrip.id}`, { method: 'PUT', headers: H, body: JSON.stringify(dripPayload) }); dripId = existingDrip.id }
else { dripId = (await fetch(BASE + '/api/drips', { method: 'POST', headers: H, body: JSON.stringify(dripPayload) }).then(r => r.json())).id }

console.log(`\ncampaign "${CAMPAIGN}" -> drip ${dripId}, ${steps.length} steps, 7-day cadence, pause-on-reply ON`)
console.log('Enrolled: nobody yet — enrolling is a separate, deliberate step.')

// DATA INTEGRITY NOTE, kept with the code that would have to change:
// every line above is evergreen. Nothing claims a value moved, a neighbour sold, or an
// equity/mortgage figure, because the Hub holds no per-property valuation feed to support
// such a claim. If a real feed is ever wired in, the specific-claim copy belongs here, and
// only then.
