// "Your home value estimate for ..." — the email that goes out after someone submits the
// home value form on cedarrapidsmetroareahomevalue.sierrasellersites.com.
//
// Copy is John's, verbatim. The only additions are the merge fields and the Loom preview.
//
// The Loom thumbnail uses `-with-play.jpg` (35KB, play button baked in) rather than
// `-with-play.gif` (1MB) — an animated GIF that size is a poor thing to push into an inbox,
// and several clients show only its first frame anyway.
//
//   node scripts/home-value-request-followup.mjs [--dry]
import fs from 'fs'

const DRY = process.argv.includes('--dry')
const BASE = 'https://realestate-hub-1rzu.onrender.com'
const NAME = 'Home Value Request — Follow-Up'
const CATEGORY = 'Home Value Request'
const LOGO = 'https://realestate-hub-1rzu.onrender.com/logo.jpg'

const LOOM_URL = 'https://www.loom.com/share/38bcb36d11db495ba234dc10d57b39fa?sid=f398341f-8371-4b4e-b475-a51e7790778a'
const LOOM_THUMB = 'https://cdn.loom.com/sessions/thumbnails/38bcb36d11db495ba234dc10d57b39fa-with-play.jpg'

const NAVY = '#191a2e', GOLD = '#c9a227', INK = '#1f2937', BODY = '#4b5563'
const MUTED = '#8a8f98', RULE = '#e6e8ec', PAGE = '#f2f3f5'
const TEAM_EMAIL = 'mattsmithremax@gmail.com'
const OFFICE_ADDRESS = 'RE/MAX Concepts \u00b7 5235 Buffalo Ridge Dr, Cedar Rapids, IA 52411'

const paras = [
  'Thanks for checking the value of your home at {{street_address}}.',
  'Your online estimate is a helpful starting point, but it may not tell the whole story. Automated values rely heavily on available property and market data, and they cannot always account for things like renovations, updates, condition, finishes, a finished basement, newer mechanicals, or other features inside the home.',
  'That means two homes that look similar on paper can sometimes have very different real-world values.',
  'Someone from the Matt Smith Team may reach out with a few quick questions about your home so we can better understand anything the online estimate may be missing.',
  'And just so you know, you do not need to be thinking about selling. A lot of homeowners simply want to know where their home stands today.',
  'If there are any major updates or improvements you think we should know about, just reply to this email and tell us about them.',
]

const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};margin:0;padding:0;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:640px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${RULE};">
      <tr><td align="center" style="background:${NAVY};padding:22px 24px;">
        <img src="${LOGO}" alt="Matt Smith Team, RE/MAX Concepts" width="210" height="105" style="display:block;width:210px;max-width:60%;height:auto;border:0;outline:none;text-decoration:none;" />
      </td></tr>
      <tr><td style="height:3px;background:${GOLD};font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:30px 32px 6px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;font-weight:700;color:${INK};">Your estimate is a starting point. Here is what it cannot see.</h1>
        <p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BODY};">Hi {{first_name}},</p>
      </td></tr>
      <tr><td align="center" style="padding:4px 32px 22px;">
        <a href="${LOOM_URL}" style="display:block;text-decoration:none;">
          <img src="${LOOM_THUMB}" alt="Watch: what an online estimate cannot see about your home" width="576" style="display:block;width:100%;max-width:576px;height:auto;border:1px solid ${RULE};border-radius:8px;" />
        </a>
        <p style="margin:9px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:${MUTED};">
          <a href="${LOOM_URL}" style="color:${MUTED};text-decoration:underline;">Watch the short video</a>
        </p>
      </td></tr>
      <tr><td style="padding:0 32px 26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        ${paras.map(t => `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${BODY};">${t}</p>`).join('\n        ')}
      </td></tr>
      <tr><td style="padding:0 32px;"><div style="height:1px;background:${RULE};font-size:0;line-height:0;">&nbsp;</div></td></tr>
      <tr><td style="padding:20px 32px 28px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <p style="margin:0 0 3px;font-size:14px;font-weight:700;color:${INK};">Matt Smith</p>
        <p style="margin:0 0 6px;font-size:13px;color:${BODY};">Matt Smith Team | RE/MAX Concepts</p>
        <p style="margin:0 0 14px;font-size:13px;line-height:1.7;color:${BODY};">
          <a href="tel:+13194315859" style="color:${BODY};text-decoration:none;">319-431-5859</a><br />
          <a href="mailto:${TEAM_EMAIL}" style="color:${BODY};text-decoration:underline;">${TEAM_EMAIL}</a><br />
          <a href="https://www.mattsmithteam.com" style="color:${BODY};text-decoration:underline;">MattSmithTeam.com</a>
        </p>
        <p style="margin:0 0 10px;font-size:12px;line-height:1.6;color:${MUTED};">${OFFICE_ADDRESS}</p>
        <p style="margin:0;font-size:12px;line-height:1.6;color:${MUTED};">Estimates shown are automated and are a starting point, not an appraisal.</p>
      </td></tr>
    </table>
  </td></tr>
</table>`

const payload = {
  name: NAME, type: 'email', category: CATEGORY,
  subject: 'Your home value estimate for {{street_address}}',
  body, is_html: 1,
  tags: 'home-value, seller, cma-request, loom, auto-followup',
}

const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.json())
const H = { 'x-auth-token': login.token, 'content-type': 'application/json' }

const all = await fetch(BASE + '/api/templates', { headers: H }).then(r => r.json())
const hit = (Array.isArray(all) ? all : all.templates || []).find(t => t.name === NAME)
if (DRY) { console.log(hit ? `would update template ${hit.id}` : 'would create a new template'); process.exit(0) }
let id
if (hit) { await fetch(`${BASE}/api/templates/${hit.id}`, { method: 'PUT', headers: H, body: JSON.stringify(payload) }); id = hit.id }
else { id = (await fetch(BASE + '/api/templates', { method: 'POST', headers: H, body: JSON.stringify(payload) }).then(r => r.json())).id }
console.log(`template ${id}: ${NAME}`)
console.log(`subject: ${payload.subject}`)
console.log(`loom   : ${LOOM_URL}`)
