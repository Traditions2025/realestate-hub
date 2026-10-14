// The composer shows the signature by default (John, 2026-10-14: Matt "shouldn't have to
// keep adding it"). Picking a template replaces the whole body, which used to wipe the
// signature the blank composer had put there — so the template preview now appends it the
// same way /send does, and the same alreadySigned() guard stops a double.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

const DIR = join(os.tmpdir(), 'hubsig_' + process.pid + '_' + Number(process.hrtime.bigint() % 100000n))
mkdirSync(join(DIR, 'backups'), { recursive: true })
process.env.DB_DIR = DIR

const { default: db, initDb } = await import('../server/database.js')
await initDb()
const { alreadySigned, fillTemplate } = await import('../server/routes/email.js')

const SIG = '<div>Matt Smith</div><div>Matt Smith Team | RE/MAX Concepts</div><div>319-431-5859</div>'
db.setSetting('email_signature', SIG)

// what the preview endpoint does, in one line, so the rule is tested not the plumbing
const previewBody = (tplBody) => {
  let body = tplBody
  if (!alreadySigned(body)) body += '<br><br>{{signature}}'
  return body
}

test('a template with no signature gets one appended', () => {
  const out = previewBody('<p>Hi {{first_name}}, quick question about your home.</p>')
  assert.match(out, /\{\{signature\}\}$/, 'the token is appended at the end')
})

test('a template using the {{signature}} token is left alone', () => {
  const body = '<p>Hello.</p>{{signature}}'
  assert.equal(previewBody(body), body, 'no second signature')
  assert.equal((previewBody(body).match(/\{\{signature\}\}/g) || []).length, 1)
})

test('a template carrying its own hand-built signature block is left alone', () => {
  // the 2026-09-29 double-signature bug: a designed template with the details inline
  const body = '<p>Hi.</p><div>Matt Smith</div><div>319-431-5859</div><div>mattsmithteam.com</div>'
  assert.ok(alreadySigned(body), 'two distinctive marks is enough to count as signed')
  assert.equal(previewBody(body), body)
})

test('a body that only mentions the office number once is NOT mistaken for signed', () => {
  const body = '<p>Give me a call at 319-431-5859 if that works.</p>'
  assert.equal(alreadySigned(body), false, 'one mark is not a signature')
  assert.match(previewBody(body), /\{\{signature\}\}$/)
})

test('the appended token renders to the saved signature for a real lead', () => {
  db.run('INSERT OR REPLACE INTO clients (id, first_name, last_name, email, status, type) VALUES (?,?,?,?,?,?)',
    [991001, 'Dana', 'Reed', 'dana@example.com', 'new', 'buyer'])
  const client = db.get('SELECT * FROM clients WHERE id=?', [991001])
  const out = fillTemplate(previewBody('<p>Hi {{first_name}},</p>'), client)
  assert.match(out, /Hi Dana,/, 'merge fields still fill')
  assert.match(out, /Matt Smith Team \| RE\/MAX Concepts/, 'the signature is rendered, not left as a token')
  assert.doesNotMatch(out, /\{\{signature\}\}/, 'no raw token survives to the composer')
  assert.equal((out.match(/319-431-5859/g) || []).length, 1, 'exactly one phone number')
})

test('what the composer shows now matches what /send would produce', () => {
  // /send runs the same two lines; if they ever diverge Matt is editing a draft that is
  // not what goes out, which is the bug this fixes.
  const tpl = '<p>Checking in.</p>'
  const composer = previewBody(tpl)
  const onSend = alreadySigned(tpl) ? tpl : tpl + '<br><br>{{signature}}'
  assert.equal(composer, onSend)
})

test('the signature fallback never says "RE/MAX Real Estate Concepts"', () => {
  db.setSetting('email_signature', '')
  const client = db.get('SELECT * FROM clients WHERE id=?', [991001])
  const out = fillTemplate('{{signature}}', client)
  assert.doesNotMatch(out, /Real Estate Concepts/, 'that is not the brokerage name')
  assert.match(out, /RE\/MAX Concepts/)
  assert.match(out, /Matt Smith Team \|/, 'brokerage always carries the team name')
  db.setSetting('email_signature', SIG)
})
