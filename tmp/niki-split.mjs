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
// wait for the build that knows about Message-ID platforms
for (let i = 0; i < 40; i++) {
  try {
    const t = await fetch(`${BASE}/api/inbox/contact-emails?email=niki.morris3@gmail.com&max=5`, { headers: H }).then(x => x.text())
    const j = JSON.parse(t)
    if ((j.messages || []).some(m => /Matrix|Sierra|FUB|one-to-one/.test(m.why || ''))) break
  } catch {}
  await sleep(15000)
}

const email = process.argv[2] || 'niki.morris3@gmail.com'
const r = await fetch(`${BASE}/api/inbox/contact-emails?email=${encodeURIComponent(email)}&max=60`, { headers: H }).then(x => x.json())
if (r.error) { console.error(r.error); process.exit(1) }
console.log(`\n${email}`)
console.log(`total ${r.count}   KEEP ${r.human_count}   DROP ${r.automated_count}\n`)
const show = (list) => {
  for (const m of list) {
    console.log(`${m.date.slice(0, 10)}  ${m.direction.padEnd(8)} ${String(m.subject).slice(0, 64)}`)
    console.log(`            from  ${String(m.from).slice(0, 72)}`)
    console.log(`            why   ${m.why}`)
  }
}
console.log('=============== KEPT ===============')
show(r.messages.filter(m => m.human))
console.log('\n=============== DROPPED ===============')
show(r.messages.filter(m => !m.human))
