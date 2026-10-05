import fs from 'fs'
const BASE = 'https://realestate-hub-1rzu.onrender.com'
const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.json())
const H = { 'x-auth-token': login.token }
const r = await fetch(BASE + '/api/clients?limit=40&status=active&has_email=1', { headers: H }).then(x => x.text())
console.log(r.slice(0, 600))
