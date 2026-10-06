// Every message shows which number it came from and which it went to.
//
// John, 2026-10-06: "on each text or message include where the text came from and what
// number so I know which one texted".
//
// Jacob Misener's thread is the case. His WIFE replied from his number and then gave her
// own (507-251-4908). Every message was headed "Jacob Misener", and a number appeared
// only on group texts, so nothing on screen showed two people and two numbers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const comp = src('../src/components/Endpoints.jsx')

// the pure helpers, lifted out of the component file so the test runs the REAL code
// rather than a copy of it that can drift (the mistake that once kept a broken assessor
// URL green)
const lift = (name) => {
  const i = comp.indexOf(`export const ${name} =`)
  assert.ok(i > -1, `${name} not found`)
  const body = comp.slice(i).replace(/^export /, '')
  const end = body.indexOf('\n\n')
  return body.slice(0, end < 0 ? undefined : end)
}
const { last10, fmtEndpoint, knownNumbers } = await import(
  'data:text/javascript,' + encodeURIComponent(
    lift('last10') + '\n' + lift('fmtEndpoint') + '\n' +
    comp.slice(comp.indexOf('export function knownNumbers'), comp.indexOf('export default')).replace(/^export /, '') +
    '\nexport { last10, fmtEndpoint, knownNumbers }'
  )
)

// ── formatting ───────────────────────────────────────────────────────────────────────
test('a number is shown the way the team writes it', () => {
  assert.equal(fmtEndpoint('+15072514908'), '(507) 251-4908')
  assert.equal(fmtEndpoint('5072514908'), '(507) 251-4908')
  assert.equal(fmtEndpoint('(507) 251-4908'), '(507) 251-4908')
})

test('an email address is left alone', () => {
  assert.equal(fmtEndpoint('niki.morris3@gmail.com'), 'niki.morris3@gmail.com')
})

test('something that is not a phone number is shown as-is, not mangled', () => {
  assert.equal(fmtEndpoint('short code 55512'), 'short code 55512')
  assert.equal(fmtEndpoint(''), '')
  assert.equal(fmtEndpoint(null), '')
})

test('the country code does not change the match', () => {
  assert.equal(last10('+1 (319) 431-5859'), '3194315859')
  assert.equal(last10('3194315859'), '3194315859')
})

// ── which numbers belong to the lead ─────────────────────────────────────────────────
test('the main phone and every alt phone count as on file', () => {
  const k = knownNumbers({ phone: '(319) 431-5859', alt_phones: '319-200-1234, +1 507 251 4908' })
  assert.ok(k.has('3194315859'))
  assert.ok(k.has('3192001234'))
  assert.ok(k.has('5072514908'))
  assert.equal(k.size, 3)
})

test('a lead with no numbers yields an empty set', () => {
  assert.equal(knownNumbers({}).size, 0)
  assert.equal(knownNumbers(null).size, 0)
  assert.equal(knownNumbers({ phone: '', alt_phones: '' }).size, 0)
})

test('a partial number is not treated as a number', () => {
  assert.equal(knownNumbers({ phone: '431-5859' }).size, 0, 'seven digits cannot be matched safely')
})

// ── the flag only fires when it means something ──────────────────────────────────────
test('the "not on file" flag is held back when nothing is on file', () => {
  // the Inbox does not carry the lead's full phone list; flagging every message there
  // would be worse than saying nothing
  const i = comp.indexOf('const unknown =')
  const line = comp.slice(i, comp.indexOf('\n', i))
  assert.match(line, /known\.size > 0/, 'an empty set must not mean "unknown"')
  assert.match(line, /theirs\.length === 10/, 'a partial number must not be flagged')
})

test('the flag checks the LEAD\'s side, not ours', () => {
  // on an outgoing message the lead is the `to`; on an incoming one they are the `from`
  const i = comp.indexOf('const theirs =')
  assert.match(comp.slice(i, comp.indexOf('\n', i)), /out \? m\.to_addr : m\.from_addr/)
})

// ── wired into every place a message is rendered ─────────────────────────────────────
test('the profile shows it on texts and on calls and emails', () => {
  const p = src('../src/pages/ClientProfile.jsx')
  assert.match(p, /import Endpoints from '\.\.\/components\/Endpoints\.jsx'/)
  assert.ok((p.match(/<Endpoints /g) || []).length >= 2, 'chat bubbles AND the card layout')
  assert.match(p, /<Endpoints m=\{m\} client=\{client\}/, 'the profile knows the lead, so it can flag')
})

test('the profile passes the lead down to each message', () => {
  const p = src('../src/pages/ClientProfile.jsx')
  assert.ok(!/\<CommItem key=\{m\.id\} m=\{m\} \/\>/.test(p), 'every CommItem needs the client')
  assert.match(p, /function CommItem\(\{ m, client \}\)/)
})

test('a note gets no from/to, because it has no two ends', () => {
  const p = src('../src/pages/ClientProfile.jsx')
  const i = p.indexOf("{m.channel !== 'note'")
  assert.ok(i > -1, 'notes and internal rows must be excluded')
  assert.match(p.slice(i, i + 120), /m\.direction !== 'internal'/)
})

test('all three Inbox panes show it', () => {
  const p = src('../src/pages/Inbox.jsx')
  assert.match(p, /import Endpoints from '\.\.\/components\/Endpoints\.jsx'/)
  assert.equal((p.match(/<Endpoints /g) || []).length, 3, 'main thread, group and unknown')
})

// ── the Hub records its OWN number too ───────────────────────────────────────────────
// The live Misener thread showed every outgoing text as "? -> (319) 521-6995": from_addr
// was stored as '' on every send, so half of "what number" was missing.
test('sendSms reports the number it sent from', () => {
  const t = src('../server/twilio.js')
  assert.match(t, /return \{ sid: data\.sid, status: data\.status, to, from: data\.from \|\| c\.from \|\| '' \}/)
  // Twilio's own answer first: with a Messaging Service IT picks the number, so the
  // configured one is only a fallback
  assert.ok(t.indexOf('data.from') < t.indexOf("c.from || ''"), "Twilio's answer wins over the setting")
})

test('every outgoing text records the sending number', () => {
  for (const f of ['../server/routes/inbox.js', '../server/cx-connect.js',
                   '../server/fb-listing-campaign.js', '../server/fsbo-followup.js']) {
    const s = src(f)
    for (const line of s.split('\n')) {
      if (!line.includes("['text', 'outgoing'")) continue
      if (line.includes('grp_')) continue        // group sends go through a Conversation
      assert.match(line, /r2?\.from \|\| ''/, `${f}: an outgoing text with no sending number`)
    }
  }
})

test('the sending number comes from the right variable', () => {
  // the group copy-fallback uses r2, not r; r.from there would have been a silent
  // ReferenceError or, worse, picked up some other r
  const s = src('../server/routes/inbox.js')
  // the insert statement wraps, so look at the statement rather than the line
  const re = /(r2?)\.from \|\| ''/g
  let m, checked = 0
  while ((m = re.exec(s))) {
    const stmt = s.slice(m.index, m.index + 320)
    assert.ok(stmt.includes(`${m[1]}.sid`) || stmt.includes(`${m[1]}.status`),
      `the number must come from the same result the send returned, near: ${stmt.slice(0, 60)}`)
    checked++
  }
  assert.ok(checked >= 4, 'every send site should have been checked')
})

test('one implementation, not three copies', () => {
  // the Inbox used to format a number inline, and the profile had its own copy that only
  // ran on group texts
  const p = src('../src/pages/ClientProfile.jsx')
  assert.ok(!p.includes('const fmtEndpoint ='), 'the profile must not keep its own copy')
  assert.ok(!/m\.conversation_sid && m\.from_addr \?/.test(p), 'the group-only number line is gone')
})
