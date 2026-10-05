import fs from 'fs'
const BASE = 'https://realestate-hub-1rzu.onrender.com'
const pw = fs.readFileSync('C:/Users/USer/.claude/projects/c--Users-USer-Downloads-Claude-Code-Matt-Smith-Team/memory/.hub-automation-pw', 'utf8').trim()
const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'automation@mattsmithteam.com', password: pw }) }).then(r => r.json())
const H = { 'x-auth-token': login.token, 'content-type': 'application/json' }
// leads who have actually written to us: an incoming email already on file
const q = `SELECT c.email, c.first_name, c.last_name, COUNT(*) n
           FROM communications m JOIN clients c ON c.id = m.client_id
           WHERE m.channel='email' AND m.direction='incoming' AND c.email IS NOT NULL AND c.email <> ''
           GROUP BY c.id ORDER BY n DESC LIMIT 8`
const r = await fetch(BASE + '/api/admin/query', { method: 'POST', headers: H, body: JSON.stringify({ sql: q }) }).then(x => x.text())
console.log(r.slice(0, 1200))
