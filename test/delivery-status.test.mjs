// Every text we send shows whether it actually arrived.
//
// John, 2026-10-08: "we need to have a status to show on each text we sent to know where
// it's delivered or failed or what so we know it went out also I think we would know if
// text is detected as SPAM or blocked?"
//
// The Hub has recorded this all along — communications.delivery_status and error_message,
// written by the Twilio status callback — it was simply never on screen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const comp = src('../src/components/DeliveryStatus.jsx')
const inbox = src('../server/routes/inbox.js')

// ── the states Twilio actually reports ───────────────────────────────────────────────
test('every Twilio message status has a label', () => {
  // from Twilio's message lifecycle; an unlabelled one would render a raw API word
  for (const s of ['queued', 'accepted', 'scheduled', 'sending', 'sent', 'delivered',
                   'read', 'receiving', 'received', 'undelivered', 'failed', 'canceled']) {
    assert.match(comp, new RegExp(`\\b${s}:\\s*\\{`), `no label for "${s}"`)
  }
})

test('only delivered-class states read as good news', () => {
  const good = [...comp.matchAll(/(\w+):\s*\{ label: '[^']*',\s*tone: 'good'/g)].map(m => m[1])
  assert.deepEqual(good.sort(), ['delivered', 'read', 'received'])
})

test('"sent" is NOT shown as delivered', () => {
  // Twilio's `sent` means the carrier took it, not that a handset did. Calling that
  // delivered would tell John a message arrived when nobody has said so.
  const line = comp.slice(comp.indexOf('  sent:'), comp.indexOf('\n', comp.indexOf('  sent:')))
  assert.match(line, /tone: 'muted'/)
  assert.ok(!/label: 'Delivered'/.test(line))
})

test('a failure is shown as a failure', () => {
  for (const s of ['undelivered', 'failed', 'canceled']) {
    const line = comp.slice(comp.indexOf(`  ${s}:`), comp.indexOf('\n', comp.indexOf(`  ${s}:`)))
    assert.match(line, /tone: 'bad'/, `${s} must not read as neutral`)
  }
})

// ── spam and blocking ────────────────────────────────────────────────────────────────
test('the carrier codes for spam and blocking are translated server-side', () => {
  assert.match(inbox, /30007: 'Carrier filtered as spam'/)
  assert.match(inbox, /30004: 'Message blocked by the carrier'/)
})

test('a spam-filtered or blocked message is flagged, not just failed', () => {
  const { isSpamOrBlocked } = evalExport('isSpamOrBlocked')
  assert.ok(isSpamOrBlocked({ error_message: 'Carrier filtered as spam' }))
  assert.ok(isSpamOrBlocked({ error_message: 'Message blocked by the carrier' }))
  assert.ok(isSpamOrBlocked({ error_message: 'Carrier error 30007' }))
  assert.ok(!isSpamOrBlocked({ error_message: 'Unknown or non-existent number' }))
  assert.ok(!isSpamOrBlocked({}))
  assert.ok(!isSpamOrBlocked(null))
})

test('the reason is shown, not just the word "failed"', () => {
  // a blocked number and a spam filter need completely different responses
  assert.match(comp, /\{m\.error_message && /)
})

// ── what it does NOT claim ───────────────────────────────────────────────────────────
test('an inbound message gets no delivery status', () => {
  assert.match(comp, /if \(!m \|\| m\.direction !== 'outgoing'\) return null/)
})

test('a message with no receipt says so rather than showing nothing', () => {
  // rows that predate the status callback would otherwise read as though they never sent
  assert.match(comp, /no receipt/)
  assert.match(comp, /if \(!raw\)/)
})

test('an unknown status renders the word rather than crashing', () => {
  assert.match(comp, /STATES\[raw\] \|\| \{ label: raw/)
})

// ── wired in everywhere a message is rendered ────────────────────────────────────────
test('the profile shows it on bubbles and on cards', () => {
  const p = src('../src/pages/ClientProfile.jsx')
  assert.match(p, /import DeliveryStatus from '\.\.\/components\/DeliveryStatus\.jsx'/)
  assert.equal((p.match(/<DeliveryStatus m=\{m\} \/>/g) || []).length, 2)
})

test('all three Inbox panes show it', () => {
  const p = src('../src/pages/Inbox.jsx')
  assert.match(p, /import DeliveryStatus from '\.\.\/components\/DeliveryStatus\.jsx'/)
  assert.equal((p.match(/<DeliveryStatus m=\{m\} \/>/g) || []).length, 3)
})

test('the status callback stores both the state and the reason', () => {
  assert.match(inbox, /UPDATE communications SET delivery_status=\?, error_message=\?/)
})

// lift a pure export out of the component so the test runs the real code
function evalExport(name) {
  const i = comp.indexOf(`export const ${name} =`)
  const body = comp.slice(i, comp.indexOf('\n\n', i)).replace(/^export /, '')
  return eval(`(() => { ${body}; return { ${name} } })()`)
}
