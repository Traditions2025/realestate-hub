// Sample a handful of leads and report the kept/dropped split per person, with the
// reason tally. Read-only: nothing is imported.
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
  } catch { await sleep(15000) }
}
if (!token) { console.error('login failed'); process.exit(1) }
const H = { 'x-auth-token': token }

const get = async (url) => {
  for (let i = 0; i < 25; i++) {
    try { return JSON.parse(await fetch(BASE + url, { headers: H }).then(x => x.text())) }
    catch { await sleep(12000) }
  }
  return { error: 'unreachable' }
}

// wait for the build that runs the thread rescue
for (let i = 0; i < 40; i++) {
  const j = await get('/api/inbox/contact-emails?email=niki.morris3@gmail.com&max=60')
  if ((j.messages || []).some(m => /kept reply points at/.test(m.why || ''))) { console.error('rescue live'); break }
  await sleep(15000)
}

const emails = process.argv.slice(2)
const tally = {}
let tk = 0, td = 0
for (const email of emails) {
  const r = await get(`/api/inbox/contact-emails?email=${encodeURIComponent(email)}&max=80`)
  if (r.error) { console.log(`${email.padEnd(34)} ERROR ${r.error}`); continue }
  tk += r.human_count; td += r.automated_count
  console.log(`\n${email}   total ${r.count}  KEEP ${r.human_count}  DROP ${r.automated_count}`)
  for (const m of r.messages || []) {
    const why = String(m.why || '').replace(/\(.*\)/, '').trim()
    tally[why] = (tally[why] || 0) + 1
    if (m.human) console.log(`   KEEP  ${m.date.slice(0, 10)} ${m.direction.padEnd(8)} ${String(m.subject).slice(0, 58)}`)
  }
}
console.log(`\n==================== TOTAL  KEEP ${tk}  DROP ${td}`)
console.log('\nreasons:')
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
