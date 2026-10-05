// Only real emails from a lead, or a reply, belong in the Hub's history.
//
// John, 2026-10-05: "we don't need to get automated listing alerts emails only those
// actual emails coming from lead or a reply". The cases below are the ACTUAL messages
// the mattsmithremax@gmail.com pull returned for Niki Morris — the three that decided
// this filter exists.
//
// The bias is deliberate: a marketing email wrongly kept is clutter, a real
// conversation wrongly dropped is history nobody can get back. So every ambiguous
// case here asserts KEEP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { classifyEmail, splitHumanEmails } from '../server/email-is-human.js'

const keep = (m) => { const v = classifyEmail(m); assert.ok(v.human, 'should KEEP but dropped: ' + v.why); return v }
const drop = (m) => { const v = classifyEmail(m); assert.ok(!v.human, 'should DROP but kept: ' + v.why); return v }

// ── the three real Niki Morris messages ──────────────────────────────────────────────
test('a real email Matt wrote is kept', () => {
  keep({ from: 'mattsmithremax@gmail.com', subject: 'Your recent inquiry at 2050 Newcastle Road, Marion, IA',
    body: 'Hello Niki, Hope this message finds you well. Matt asked me to send you the disclosures.' })
})
test('a real email with an attachment is kept', () => {
  keep({ from: 'mattsmithremax@gmail.com', subject: 'Sample Purchase Agreement',
    body: 'Happy Easter Niki! Please find attached Purchase agreement.' })
})
test('the Ylopo listing alert is dropped', () => {
  const v = drop({ from: 'alerts@mail.ylopo.com', subject: '[Morris, Niki ] Homes to consider by The Matt Smith  3',
    body: 'View these homes https://a.com https://b.com https://c.com https://d.com' })
  assert.match(v.why, /ylopo/)
})

// ── a reply is a conversation, whatever it looks like ────────────────────────────────
test('a reply is always kept, even with an alert-shaped subject', () => {
  const v = keep({ from: 'niki.morris3@gmail.com', subject: 'Re: New Listings in Marion',
    body: 'Can we see the second one Saturday?', inReplyTo: '<x@mail.gmail.com>' })
  assert.match(v.why, /thread/)
})
test('References alone is enough to count as a thread', () => {
  keep({ from: 'lead@gmail.com', subject: 'Market report', body: 'thanks!', references: '<a@x> <b@x>' })
})

// ── header signals, the strong ones ──────────────────────────────────────────────────
test('List-Unsubscribe means bulk', () => {
  drop({ from: 'matt@mattsmithteam.com', subject: 'Hello there', body: 'Hi Niki, hope you are well',
    headers: new Map([['list-unsubscribe', '<mailto:u@x.com>']]) })
})
test('a SendGrid campaign id means bulk', () => {
  drop({ from: 'matt@mattsmithteam.com', subject: 'Checking in', body: 'Hi Niki',
    headers: new Map([['x-sg-eid', 'abc123']]) })
})
test('Precedence: bulk means bulk', () => {
  drop({ from: 'matt@mattsmithteam.com', subject: 'x', body: 'y', headers: new Map([['precedence', 'bulk']]) })
})
test('plain-object headers work too, case-insensitively', () => {
  drop({ from: 'matt@mattsmithteam.com', subject: 'x', body: 'y', headers: { 'List-Id': '<news.x.com>' } })
})
test('a normal header set does not trip anything', () => {
  keep({ from: 'niki.morris3@gmail.com', subject: 'question', body: 'Hi Matt, one question',
    headers: new Map([['mime-version', '1.0'], ['content-type', 'text/plain']]) })
})

// ── senders that are machines ────────────────────────────────────────────────────────
for (const addr of ['no-reply@zillow.com', 'noreply@realtor.com', 'do-not-reply@x.com',
                    'notifications@facebookmail.com', 'alerts@homes.com', 'bounces@x.com',
                    'mailer-daemon@googlemail.com']) {
  test('machine sender ' + addr + ' is dropped', () => drop({ from: addr, subject: 'hi', body: 'hi' }))
}
for (const addr of ['niki.morris3@gmail.com', 'mattsmithremax@gmail.com', 'john@mattsmithteam.com',
                    'replyall@gmail.com', 'donna.updates@gmail.com']) {
  test('person ' + addr + ' is kept', () => keep({ from: addr, subject: 'hi', body: 'Hi Matt, hi' }))
}

// ── platform domains ─────────────────────────────────────────────────────────────────
test('mail FROM a platform is a system message even when the name says Matt Smith', () => {
  drop({ from: 'matt@mail.sierrainteractive.com', subject: 'Your home update', body: 'Hi Niki' })
})
test('followupboss notification mail is dropped', () => {
  drop({ from: 'x@notify.followupboss.com', subject: 'New lead', body: 'A lead came in' })
})

// ── subject alone is never enough ────────────────────────────────────────────────────
test('an alert-style subject is KEPT when a person clearly wrote the body', () => {
  const v = keep({ from: 'niki.morris3@gmail.com', subject: 'just listed on Newcastle?',
    body: 'Hi Matt, I saw something just listed near us. Could we take a look this weekend?' })
  assert.match(v.why, /body reads like a person/)
})
test('an alert subject with a link-stack template body is dropped', () => {
  const v = drop({ from: 'someone@gmail.com', subject: 'New listings matching your saved search',
    body: '3 beds https://a https://b https://c https://d https://e' })
  assert.match(v.why, /template body/)
})
test('a greeting rescues even a link-heavy alert subject', () => {
  keep({ from: 'niki.morris3@gmail.com', subject: 'price drop?',
    body: 'Hi Matt - https://a https://b https://c https://d did these all drop?' })
})

// ── which system generated the Message-ID: the strongest signal there is ─────────────
// Every id below was read off a real message in mattsmithremax@gmail.com. Subject-line
// reading got the Matrix alerts wrong six times out of six; these ids get them right.
test('a Matrix MLS listing alert is dropped on its Message-ID', () => {
  const v = drop({ from: 'CDR@northcentralmatrixmail.com', messageId: '<5QKJS7UM2NU4.DLUAGRVH8U3W3@gprodcdra70b>',
    subject: '[Morris, Niki ] Homes to consider by The Matt Smith  319-431-5859',
    body: 'Dear Niki Morris, I have found 1 new or updated listing for you to review. Highlights View All Properties' })
  assert.match(v.why, /Matrix/)
})
test('the Matrix alert is dropped even though its body opens like a letter', () => {
  // this is exactly why the subject+body heuristic was not enough: "Dear Niki Morris"
  // reads as a greeting, and the alert carries only ONE link
  drop({ from: 'CDR@northcentralmatrixmail.com', messageId: '<x@gprodcdra70b>',
    subject: 'Homes to consider', body: 'Dear Niki Morris, I have found 1 new listing. https://one.link' })
})
test('a Sierra drip campaign is dropped even with no links at all', () => {
  const v = drop({ from: 'mattsmithremax@gmail.com', messageId: '<1.c5d77d0a58d3eef6d443@sierra-vm-srvc3>',
    subject: 'BREAKING: Home Mortgage Rates hit 5.5%',
    body: 'Please watch the video above. Hi Niki Meant to get this information to you yesterday' })
  assert.match(v.why, /Sierra/)
})
test('a FUB template blast is dropped on its link apparatus', () => {
  const v = drop({ from: 'matt@mattsmithteam.com', messageId: '<2924494-eb016ec4180750c0d14e32a83bb7e0d@followupboss.com>',
    subject: 'Good Evening. I saw you viewed some properties!',
    body: 'Hi Niki, I saw you viewed a few listings today. ' + 'https://fub.direct/1/x '.repeat(28) })
  assert.match(v.why, /FUB.*mass template/)
})
test('a short one-to-one email typed inside FUB is KEPT', () => {
  // FUB is also where an agent types a real reply. Dropping those would lose email
  // content nothing else has, because FUB withholds it from its own API.
  const v = keep({ from: 'matt@mattsmithteam.com', messageId: '<2924494-abc@followupboss.com>',
    subject: 'Tomorrow at 2', body: 'Niki - 2pm works. I will meet you at the house. Matt' })
  assert.match(v.why, /one-to-one/)
})
test('an unsubscribe footer is enough to call it a blast', () => {
  drop({ from: 'matt@mattsmithteam.com', messageId: '<9@followupboss.com>',
    subject: 'Market news', body: 'Hi Niki, some news. Unsubscribe' })
})
test('a hand-typed Gmail message is kept, links and all', () => {
  // "Warranty info" carries 12 links - every one of them an image in Matt's signature
  keep({ from: 'mattsmithremax@gmail.com', messageId: '<CAH6J5O2QoKKXp9E@mail.gmail.com>',
    subject: 'Warranty info', body: '[image: x] ' + 'https://www.mattsmithteam.com/sell '.repeat(12) })
})
test('Sample Purchase Agreement, the real thing, survives every rule', () => {
  keep({ from: 'mattsmithremax@gmail.com', messageId: '<CAH6J5O1H1Toxd@mail.gmail.com>',
    subject: 'Sample Purchase Agreement', body: 'Happy Easter Niki! Please find attached Purchase agreement.' })
})
test('the Message-ID is read from headers when not passed directly', () => {
  drop({ from: 'x@y.com', subject: 'Homes', body: 'x', headers: new Map([['message-id', '<a@gprodcdra70b>']]) })
})

// ── a thread never arrives as an answer with no question ────────────────────────────
test('a dropped message a kept reply points at is brought back', async () => {
  const { rescueThreadParents } = await import('../server/email-is-human.js')
  // the real shape: Niki replied to a FUB template, so her reply is kept and the
  // template is not. Keeping only her side would leave an answer with no question.
  const batch = [
    { messageId: '<parent@followupboss.com>', subject: 'Market changes for your home on 7009 Springwood Pl Nw',
      human: false, why: 'FUB template send, mass template body' },
    { messageId: '<reply@mail.gmail.com>', subject: 'Re: Market changes', human: true,
      why: 'part of a thread', inReplyTo: '<parent@followupboss.com>' },
  ]
  rescueThreadParents(batch)
  assert.equal(batch[0].human, true)
  assert.match(batch[0].why, /a kept reply points at this message/)
  assert.match(batch[0].why, /FUB template send/, 'the original reason is kept, not erased')
})

test('the rescue walks back up a chain', async () => {
  const { rescueThreadParents } = await import('../server/email-is-human.js')
  const batch = [
    { messageId: '<a@sierra-vm-srvc3>', human: false, why: 'Sierra drip campaign' },
    { messageId: '<b@followupboss.com>', human: false, why: 'FUB template send, mass template body',
      inReplyTo: '<a@sierra-vm-srvc3>' },
    { messageId: '<c@mail.gmail.com>', human: true, why: 'part of a thread', references: '<b@followupboss.com>' },
  ]
  rescueThreadParents(batch)
  assert.equal(batch[1].human, true, 'the direct parent comes back')
  assert.equal(batch[0].human, true, 'and so does its own parent')
})

test('a template nobody replied to stays dropped', async () => {
  const { rescueThreadParents } = await import('../server/email-is-human.js')
  const batch = [
    { messageId: '<alert@gprodcdra70b>', human: false, why: 'Matrix MLS listing alert' },
    { messageId: '<x@mail.gmail.com>', human: true, why: 'no automation markers' },
  ]
  rescueThreadParents(batch)
  assert.equal(batch[0].human, false, 'the rescue needs real thread linkage, not proximity')
})

test('the rescue only ever keeps more, never less', async () => {
  const { rescueThreadParents } = await import('../server/email-is-human.js')
  const batch = [{ messageId: '<a@x>', human: true, why: 'ok' }, { messageId: '<b@x>', human: false, why: 'bulk' }]
  rescueThreadParents(batch)
  assert.equal(batch[0].human, true)
})

test('a reference cycle cannot hang the rescue', async () => {
  const { rescueThreadParents } = await import('../server/email-is-human.js')
  const batch = [
    { messageId: '<a@x>', human: true, why: 'ok', inReplyTo: '<b@x>' },
    { messageId: '<b@x>', human: false, why: 'bulk', inReplyTo: '<a@x>' },
  ]
  rescueThreadParents(batch)   // must simply return
  assert.equal(batch[1].human, true)
})

test('the search runs the rescue and does not leak the linkage fields', () => {
  const fn = fnSource(gmail, 'export async function searchMailboxesForContact')
  assert.match(fn, /rescueThreadParents\(dedup\)/)
  assert.ok(fn.indexOf('rescueThreadParents(dedup)') < fn.indexOf('const human = dedup.filter'),
    'the rescue must run BEFORE the counts are taken')
  assert.match(fn, /delete m\.inReplyTo; delete m\.references/)
})

// ── the governing bias, stated as a test ─────────────────────────────────────────────
test('an unrecognised email is kept, not dropped', () => {
  const v = keep({ from: 'someone@somewhere.org', subject: '', body: '' })
  assert.match(v.why, /no automation markers/)
})
test('an empty call does not throw', () => { assert.ok(classifyEmail().human) })
test('broken headers do not throw', () => {
  keep({ from: 'a@b.com', subject: 'x', body: 'y', headers: { get() { throw new Error('boom') } } })
})

// ── splitHumanEmails keeps the reason on every message ───────────────────────────────
test('the split reports both sides with a reason', () => {
  const { kept, dropped } = splitHumanEmails([
    { from: 'niki.morris3@gmail.com', subject: 'hi', body: 'Hi Matt' },
    { from: 'alerts@mail.ylopo.com', subject: 'Homes to consider', body: 'x' },
  ])
  assert.equal(kept.length, 1); assert.equal(dropped.length, 1)
  assert.ok(kept[0]._why && dropped[0]._why, 'every message carries why it landed where it did')
})

// ── wired into the Gmail path, not just sitting in a file ────────────────────────────
const fnSource = (src, decl) => {
  const i = src.indexOf(decl)
  if (i < 0) throw new Error('not found: ' + decl)
  const rest = src.slice(i + decl.length)
  const end = rest.indexOf(String.fromCharCode(10) + 'export ')
  return decl + (end < 0 ? rest : rest.slice(0, end))
}

const gmail = fs.readFileSync(new URL('../server/gmail-inbox.js', import.meta.url), 'utf8')

test('the mailbox search judges each message and carries the reason', () => {
  assert.match(gmail, /import \{ classifyEmail, rescueThreadParents \} from '\.\/email-is-human\.js'/)
  const fn = gmail.slice(gmail.indexOf('export async function searchMailboxesForContact'))
  assert.match(fn, /classifyEmail\(\{/)
  assert.match(fn, /human: verdict\.human, why: verdict\.why/)
  // the classifier's strongest signals must actually be passed in
  for (const field of ['headers:', 'inReplyTo:', 'references:', 'messageId:']) assert.ok(fn.includes(field), 'must pass ' + field)
})

test('the response reports the split so a sample can be reviewed before importing', () => {
  const ret = fnSource(gmail, 'export async function searchMailboxesForContact')
  assert.match(ret, /human_count/)
  assert.match(ret, /automated_count/)
})

test('the importer skips what the classifier rejected', () => {
  const fn = fnSource(gmail, 'export async function importContactHistory')
  assert.match(fn, /msg\.human === false/)
  // and reports it, so a surprising count is visible rather than silent
  assert.match(fn, /skipped_automated/)
})

test('importing automated mail is still possible, but only on purpose', () => {
  assert.match(gmail, /importContactHistory\(clientId, \{ includeAutomated = false \} = \{\}\)/)
  const route = fs.readFileSync(new URL('../server/routes/inbox.js', import.meta.url), 'utf8')
  assert.match(route, /include_automated === true/)
})

test('an unjudged message is kept, so a path that skips the classifier cannot drop mail', () => {
  // older callers of searchMailboxesForContact may predate the field
  const fn = fnSource(gmail, 'export async function importContactHistory')
  assert.ok(fn.includes('msg.human === false'), 'must test for an explicit false, never falsy')
})
