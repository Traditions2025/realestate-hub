// A number the carrier has refused never gets texted again.
//
// John, 2026-10-08: "all those bad numbers are flagged correct? so we don't use them ever
// again or send a text".
//
// They were flagged, and every AUTOMATION honoured the flag — but the Hub's own send
// endpoint only checked the STOP opt-out, so a person or a bulk send could still text a
// known landline. This covers both halves: the flag is set, and every sender reads it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8')
const inbox = read('../server/routes/inbox.js')

// ── every path that can send a text checks the flag ──────────────────────────────────
test('every loop that texts a list of clients is guarded', () => {
  // There are three `for (const cid of client_ids)` loops in this file — a mass-text
  // campaign, the 1-to-1/bulk send, and an email send. indexOf finds only the first,
  // which is how a missing guard could hide; check them all and say which is which.
  const starts = [...inbox.matchAll(/for \(const cid of client_ids\)/g)].map(m => m.index)
  assert.equal(starts.length, 3, 'a new send loop appeared — it needs a guard too')
  let textLoops = 0
  for (let k = 0; k < starts.length; k++) {
    const loop = inbox.slice(starts[k], starts[k + 1] ?? starts[k] + 3000)
    if (!/sendSms\(/.test(loop)) continue          // the email loop needs no SMS guard
    textLoops++
    const direct = /if \(c\.sms_undeliverable\)/.test(loop)
    const viaPolicy = /canAutomatedSend\(/.test(loop)
    assert.ok(direct || viaPolicy,
      `the text loop at offset ${starts[k]} can send without checking sms_undeliverable`)
    if (direct) {
      assert.ok(loop.indexOf('c.sms_undeliverable') < loop.indexOf('sendSms('),
        'the check has to come BEFORE the send, not after')
    }
  }
  assert.equal(textLoops, 2, 'expected the campaign loop and the 1-to-1/bulk loop')
})

test('the campaign loop is covered by the policy gate, not by luck', () => {
  // it guards through canAutomatedSend, which only excludes undeliverable numbers when
  // the channel is not 'manual' — so the default matters
  const policy = read('../server/ai-followup/policy.js')
  assert.match(policy, /canAutomatedSend\(client, \{ source = 'automation'/)
  assert.match(policy, /canSendSms\(client, \{ channel: 'automation' \}\)/,
    "a 'manual' channel here would quietly disable the check for every campaign")
  assert.match(policy, /if \(channel !== 'manual' && client\.sms_undeliverable\) return deny/)
})

test('a scheduled text cannot be queued to an undeliverable number', () => {
  const i = inbox.indexOf('scheduled_texts (client_id')
  const fn = inbox.slice(Math.max(0, i - 1400), i)
  assert.match(fn, /if \(c && c\.sms_undeliverable\) return res\.status\(400\)/)
  // and the column has to be SELECTed, or the check reads undefined and never fires
  assert.match(fn, /SELECT id, phone, hub_text_opt_out, sms_undeliverable/)
})

test('the refusal says why, and that calling still works', () => {
  // "blocked" with no reason sends someone hunting; a landline is still callable
  const matches = [...inbox.matchAll(/can't receive texts — \$\{c\.sms_undeliverable_reason/g)]
  assert.ok(matches.length >= 2, 'both send paths should explain themselves')
  assert.match(inbox, /you can still call/)
})

test('the automations that text all honour it', () => {
  for (const [file, pattern] of [
    ['../server/ai-followup/policy.js', /client\.sms_undeliverable/],
    ['../server/ai-enrollment.js', /c\.sms_undeliverable/],
    ['../server/cx-connect.js', /client\.sms_undeliverable/],
    ['../server/fsbo-followup.js', /c\.sms_undeliverable/],
  ]) assert.match(read(file), pattern, file + ' does not check the flag')
})

// ── what the flag is, and is not, for ────────────────────────────────────────────────
test('only number-side failures set the flag', () => {
  // 30007 spam-filtering and 30034 A2P fail a PERFECTLY GOOD number; blocking on those
  // would throw away reachable leads
  const i = inbox.indexOf("['30003', '30005', '30006', '21614']")
  assert.ok(i > -1, 'the number-side code list must stay explicit')
  const near = inbox.slice(i - 700, i)
  assert.match(near, /30007/, 'the comment must say why spam-filtering is excluded')
})

test('the backfill marks the same reasons the live rule does', () => {
  const i = inbox.indexOf('backfill-undeliverable')
  const fn = inbox.slice(i, i + 1200)
  for (const r of ['Phone unreachable', 'Unknown or non-existent number',
                   'Landline or unreachable carrier', 'Not a valid mobile number']) {
    assert.ok(fn.includes(r), 'backfill misses: ' + r)
  }
})

test('a new phone number clears the flag', () => {
  // the verdict belonged to the OLD number; a fresh one deserves a fresh chance
  const clients = read('../server/routes/clients.js')
  assert.match(clients, /sms_undeliverable = 0, sms_undeliverable_reason = NULL/)
  assert.match(clients, /old verdict belonged to the old number/)
})

test('an inbound text from the number clears it too', () => {
  // if they just texted us, the number plainly works
  assert.match(inbox, /UPDATE clients SET sms_undeliverable=0, sms_undeliverable_reason=NULL WHERE id=\? AND sms_undeliverable=1/)
})
