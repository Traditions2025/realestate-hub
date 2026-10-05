import fs from 'fs'
const BASE = 'https://realestate-hub-1rzu.onrender.com'
const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const sleep = (ms) => new Promise(s => setTimeout(s, ms))
let token = null
for (let i = 0; i < 40 && !token; i++) {
  try {
    const t = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.text())
    token = JSON.parse(t).token
  } catch { console.error('login poll ' + (i + 1) + ': service restarting'); await sleep(15000) }
}
if (!token) { console.error('could not log in'); process.exit(1) }
const H = { 'x-auth-token': token }

// wait for the build that can return headers
let r = null
for (let i = 0; i < 40; i++) {
  try {
    r = await fetch(`${BASE}/api/inbox/contact-emails?email=coylegabe@yahoo.com&max=60&headers=1`, { headers: H }).then(x => x.text())
    r = JSON.parse(r)
    if (r.messages && r.messages.some(m => m.headers)) { console.error('headers live after ' + (i + 1) + ' polls'); break }
    console.error('poll ' + (i + 1) + ': no headers yet')
  } catch (e) { console.error('poll ' + (i + 1) + ': ' + e.message.slice(0, 60)) }
  await new Promise(s => setTimeout(s, 15000))
}
const INTERESTING = /^(list-|precedence|auto-submitted|x-mailer|x-campaign|x-sg|x-ses|x-sierra|x-feedback|return-path|sender|reply-to|x-report|x-mandrill|x-originating|x-matrix|x-priority|message-id)/i
const want = ['Homes per Matt Smith Remax', 'Homes between 200-225k', 'Real Estate Market Insights',
  'A quick favor', 'Coyle Purchase Closing', 'Appraisal is in', 'Home Warranty Options',
  'Congratulations Gabe']
const seen = new Set()
for (const m of r.messages || []) {
  const hit = want.find(w => String(m.subject).includes(w))
  if (!hit || seen.has(hit)) continue
  seen.add(hit)
  console.log('\n========== ' + String(m.subject).slice(0, 70))
  console.log('from: ' + m.from + '   verdict: ' + (m.human ? 'KEEP' : 'DROP') + ' (' + m.why + ')')
  for (const [k, v] of Object.entries(m.headers || {})) {
    if (INTERESTING.test(k)) console.log('  ' + k + ': ' + String(JSON.stringify(v)).slice(0, 150))
  }
  console.log('  BODY: ' + String(m.body || '').replace(/\s+/g, ' ').slice(0, 220))
  console.log('  links: ' + (String(m.body || '').match(/https?:\/\//g) || []).length)
}
