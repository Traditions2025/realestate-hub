import fs from 'fs'
const BASE = 'https://realestate-hub-1rzu.onrender.com'
const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const sleep = (ms) => new Promise(s => setTimeout(s, ms))
let token = null
for (let i = 0; i < 60 && !token; i++) {
  try {
    const t = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.text())
    token = JSON.parse(t).token
  } catch { await sleep(15000) }
}
if (!token) { console.error('login failed'); process.exit(1) }
const H = { 'x-auth-token': token }
const get = async (url, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    try { return JSON.parse(await fetch(BASE + url, { headers: H }).then(x => x.text())) }
    catch { await sleep(12000) }
  }
  return { error: 'unreachable' }
}

// wait for the build that runs the thread rescue
for (let i = 0; i < 40; i++) {
  const j = await get('/api/inbox/contact-emails?email=coylegabe@yahoo.com&max=80', 5)
  if ((j.messages || []).some(m => /its own wording|platform sender/.test(m.why || ''))) { console.error('matrix fix is live'); break }
  await sleep(15000)
}

// a spread of leads with email on file, across the statuses that actually get written to
const addrs = []
for (const st of ['pending', 'closed', 'active']) {
  const rows = await get(`/api/clients?limit=40&status=${st}`)
  for (const c of (Array.isArray(rows) ? rows : rows.items || [])) {
    const a = String(c.email || '').toLowerCase()
    if (!/@/.test(a)) continue
    if (/mattsmith|followupboss|sierra|noreply|no-reply|matrixmail|remax/i.test(a)) continue
    if (!addrs.includes(a)) addrs.push(a)
  }
}
const sample = ['niki.morris3@gmail.com', ...addrs].slice(0, 7)
console.log('sample: ' + sample.join(', ') + '\n')

const tally = {}
let tk = 0, td = 0
for (const email of sample) {
  const r = await get(`/api/inbox/contact-emails?email=${encodeURIComponent(email)}&max=80`)
  if (r.error) { console.log(`${email}  ERROR ${r.error}`); continue }
  tk += r.human_count || 0; td += r.automated_count || 0
  console.log(`\n--- ${email}   total ${r.count}  KEEP ${r.human_count}  DROP ${r.automated_count}`)
  for (const m of r.messages || []) {
    const why = String(m.why || '').replace(/\(.*\)/, '').trim()
    tally[why] = (tally[why] || 0) + 1
    if (m.human) console.log(`   KEEP  ${m.date.slice(0, 10)} ${String(m.direction).padEnd(8)} ${String(m.subject).slice(0, 56)}  [${why.slice(0, 34)}]`)
  }
}
console.log(`\n=========== TOTAL  KEEP ${tk}  DROP ${td}`)
console.log('\nwhy, across the sample:')
for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`)
