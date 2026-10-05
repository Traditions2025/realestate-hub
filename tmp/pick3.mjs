import fs from 'fs'
const BASE = 'https://realestate-hub-1rzu.onrender.com'
const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.json())
const H = { 'x-auth-token': login.token }
const r = await fetch(BASE + '/api/inbox/?channel=email&limit=60', { headers: H }).then(x => x.json())
const list = Array.isArray(r) ? r : (r.items || r.threads || r.rows || [])
const seen = new Map()
for (const t of list) {
  const e = t.client_email || t.email || t.from_addr || ''
  if (!/@/.test(e)) continue
  const addr = (e.match(/[\w.+-]+@[\w.-]+/) || [])[0]
  if (!addr || /mattsmith|followupboss|sierra|noreply|no-reply/i.test(addr)) continue
  if (!seen.has(addr)) seen.set(addr, (t.client_name || t.contact_name || ''))
}
console.log([...seen.entries()].slice(0, 10).map(([a, n]) => a + '   ' + n).join('\n'))
