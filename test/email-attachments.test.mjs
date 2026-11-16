// ATTACH A FILE TO AN EMAIL (John, 2026-11-16)
//
// People reply to the five-minute walkthrough drip asking for the checklist, and the reply
// has to carry the PDF. SendGrid already took attachments; /api/inbox/send was passing a
// hardcoded empty array, and the composer had no way to pick a file.
//
// The dangerous parts are not the happy path:
//   - base64 in communications.body is what grew the database to 660MB and burned a month
//     of Render bandwidth, so the content must NOT be stored, only the filenames
//   - a blocked file type sends "successfully" and is dropped before it reaches anyone
//   - a size limit enforced only in the browser is not a limit
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { cleanEmailAttachments } from '../server/email-attachments.js'

const UI = readFileSync(new URL('../src/pages/Inbox.jsx', import.meta.url), 'utf8')
const API = readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
// The picker, the limits and the base64 reader live in one shared module, because there are
// four email composers and three copies of a size limit is three limits that drift apart.
const SHARED = readFileSync(new URL('../src/components/emailAttachments.jsx', import.meta.url), 'utf8')
const PROFILE = readFileSync(new URL('../src/pages/ClientProfile.jsx', import.meta.url), 'utf8')
const CLIENTS = readFileSync(new URL('../src/pages/Clients.jsx', import.meta.url), 'utf8')
const EMAIL_API = readFileSync(new URL('../server/routes/email.js', import.meta.url), 'utf8')

const b64 = (s) => Buffer.from(s).toString('base64')
const one = (over = {}) => [{ filename: 'checklist.pdf', type: 'application/pdf', content_base64: b64('hello'), ...over }]

// ---- the validator ------------------------------------------------------------------

test('no attachments is not an error', () => {
  assert.deepEqual(cleanEmailAttachments(undefined), { ok: [], error: null })
  assert.deepEqual(cleanEmailAttachments([]), { ok: [], error: null })
})

test('a PDF passes through with a disposition SendGrid understands', () => {
  const r = cleanEmailAttachments(one())
  assert.equal(r.error, null)
  assert.equal(r.ok.length, 1)
  assert.equal(r.ok[0].filename, 'checklist.pdf')
  assert.equal(r.ok[0].type, 'application/pdf')
  assert.equal(r.ok[0].disposition, 'attachment')
})

test('an executable is refused rather than silently dropped by the recipient', () => {
  for (const name of ['setup.exe', 'run.bat', 'thing.js', 'a.PS1', 'x.vbs']) {
    const r = cleanEmailAttachments(one({ filename: name }))
    assert.match(r.error || '', /email providers block/, `${name} should be refused`)
    assert.equal(r.ok.length, 0)
  }
})

test('a filename cannot break out of the mail header', () => {
  const r = cleanEmailAttachments(one({ filename: 'a"\r\nBcc: someone@example.com\r\n.pdf' }))
  assert.equal(r.error, null)
  assert.ok(!/[\r\n"]/.test(r.ok[0].filename), 'CR, LF and quotes must be stripped')
})

test('an empty or nameless attachment is refused', () => {
  assert.match(cleanEmailAttachments(one({ content_base64: '' })).error || '', /empty/i)
  assert.match(cleanEmailAttachments(one({ filename: '' })).error || '', /no filename/i)
})

test('content that is not base64 is refused', () => {
  assert.match(cleanEmailAttachments(one({ content_base64: 'not base64 !!' })).error || '', /not valid base64/)
})

test('the file count is capped', () => {
  const six = Array.from({ length: 6 }, (_, i) => one({ filename: `f${i}.pdf` })[0])
  assert.match(cleanEmailAttachments(six).error || '', /can carry 5 attachments/)
})

test('the total size is capped on the SERVER, not just in the browser', () => {
  // 11MB of content, which the UI would have stopped first. It must still be refused here.
  const big = one({ content_base64: 'A'.repeat(Math.ceil(11 * 1024 * 1024 * 4 / 3)) })
  assert.match(cleanEmailAttachments(big).error || '', /limit is 10 MB/)
})

test('base64 whitespace does not fail the check or reach SendGrid', () => {
  const r = cleanEmailAttachments(one({ content_base64: b64('hello').replace(/(.{2})/, '$1\n ') }))
  assert.equal(r.error, null)
  assert.ok(!/\s/.test(r.ok[0].content_base64))
})

// ---- the route ------------------------------------------------------------------------

test('the send route passes the attachments to SendGrid instead of an empty array', () => {
  assert.match(API, /sendViaSendGrid\(c\.email, name, subject, body, null, \[\], att\.ok,/,
    'the 7th argument is the attachments list')
})

test('attachment content is NEVER written to the communications row', () => {
  const route = API.slice(API.indexOf("router.post('/send'"))
  const insert = route.slice(route.indexOf('INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview'))
  assert.ok(!/content_base64/.test(insert.slice(0, 1200)),
    'storing base64 here is what grew the DB to 660MB')
  assert.match(insert, /a\.filename, type: a\.type/, 'filenames only')
})

test('a text cannot carry a file attachment', () => {
  // The group/MMS path has no way to send one, so accepting it would be a silent drop.
  assert.match(API, /A text cannot carry a file attachment/)
})

// ---- the composer ---------------------------------------------------------------------

test('EVERY email composer can attach a file', () => {
  // John, 2026-11-16, looking at the client profile: "does not show where to attach".
  // The first pass only covered the two composers in the Inbox. There are four.
  assert.match(UI, /attachments: attachPayload\(replyFiles\)/, 'Inbox thread reply')
  assert.match(UI, /attachments: channel === 'email' \? attachPayload\(files\) : \[\]/, 'Inbox new message')
  assert.match(PROFILE, /attachments: attachPayload\(files\)/, 'client profile composer')
  assert.match(PROFILE, /<EmailAttachBar files=\{files\} setFiles=\{setFiles\} \/>/, 'and it shows the control')
  assert.match(CLIENTS, /attachments: emailForm\.attachments \|\| \[\]/, 'Clients list composer')
})

test('the control lives inside the composer, not in some other component', () => {
  // It was first anchored on a muted-text div that appears several times in the file and
  // landed in a component where `files` does not exist.
  const composer = PROFILE.slice(PROFILE.indexOf('function EmailComposer'))
  assert.ok(composer.includes('<EmailAttachBar'), 'EmailAttachBar must be inside EmailComposer')
  assert.equal((PROFILE.match(/<EmailAttachBar/g) || []).length, 1, 'exactly once')
})

test('only the 3 fields the server wants are sent, not the local byte count', () => {
  assert.match(SHARED, /export const attachPayload = \(list\) =>/)
  assert.match(SHARED, /\.map\(\(\{ filename, type, content_base64 \}\)/)
})

test('one shared module holds the limits, so they cannot drift apart', () => {
  for (const [name, src] of [['Inbox', UI], ['ClientProfile', PROFILE]]) {
    assert.match(src, /from '\.\.\/components\/emailAttachments\.jsx'/, `${name} imports the shared module`)
  }
  // And nothing re-declares them locally.
  assert.ok(!/const EMAIL_MAX_BYTES\s*=/.test(UI), 'Inbox must not keep its own copy')
  assert.ok(!/const EMAIL_MAX_BYTES\s*=/.test(PROFILE), 'ClientProfile must not keep its own copy')
})

test('BOTH send routes validate, not just the inbox one', () => {
  // Clients.jsx posts attachments straight to /api/email/send, which checked nothing: no
  // cap, no blocked types, no filename sanitising.
  assert.match(EMAIL_API, /import \{ cleanEmailAttachments \} from '\.\.\/email-attachments\.js'/)
  assert.match(EMAIL_API, /const att = cleanEmailAttachments\(attachments\)/)
  assert.match(EMAIL_API, /if \(att\.error\) return res\.status\(400\)/)
  assert.ok(!/Array\.isArray\(attachments\) \? attachments : \[\],/.test(EMAIL_API),
    'the unchecked pass-through must be gone')
})

test('the rule has exactly one definition', () => {
  assert.ok(!/export function cleanEmailAttachments/.test(API),
    'inbox.js must import it, not keep a second copy that drifts')
})

test('an attachment on its own is enough to send an email', () => {
  // Sending the checklist with no covering note is a normal thing to do.
  assert.match(UI, /channel === 'email' && !body\.trim\(\) && !files\.length/)
  assert.match(UI, /!\(replyChannel === 'email' && replyFiles\.length\)/)
})

test('the picker does not offer file types the server will refuse', () => {
  const accept = (SHARED.match(/EMAIL_ACCEPT = '([^']+)'/) || [])[1] || ''
  assert.ok(accept.includes('.pdf'), 'PDF is the whole point')
  for (const bad of ['.exe', '.bat', '.js', '.ps1']) assert.ok(!accept.includes(bad), `${bad} must not be offered`)
})

test('attachments are cleared when the thread changes, so they cannot follow the next person', () => {
  // Leaving a PDF attached to the next conversation would send it to the wrong client.
  assert.match(UI, /setReplyMedia\(\[\]\); setReplyFiles\(\[\]\)/)
})
