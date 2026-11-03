// A wrong number's reply must not follow the lead once the real number is saved.
//
// Doug Riniker #26281, John 2026-11-03. The AI texted (319) 721-4755, a stranger
// answered "I'm not sure what you're talking about... I don't know who this Doug
// character is", and the auto-pause-on-reply rule dropped the lead into
// HUMAN_TAKEOVER. John then corrected the phone to 563-880-0738 — and canSendSms
// still refused every AI channel, because ai_state had outlived the number. The
// lead was permanently un-AI-able on the strength of a message WE NEVER GOT.
//
// hub_text_opt_out and the landline verdict already shed on a phone replacement
// (routes/clients.js, 2026-09-22 — Cole Hilgenberg). These pin the same rule one
// layer in, and pin the guard: somebody who answered on a number STILL on file
// keeps their block exactly as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const { releaseWrongNumberBlock, WRONG_NUMBER_CLEARABLE, transitionAiState, ensureState } =
  await import('../server/ai-followup/state.js')
const { canSendSms } = await import('../server/ai-followup/policy.js')

let seq = 0
function mkLead({ phone, alt = null, state = 'HUMAN_TAKEOVER' }) {
  const n = ++seq
  const r = db.run(`INSERT INTO clients (first_name, last_name, type, phone, alt_phones, status)
                    VALUES (?,?,?,?,?,?)`, ['Wrongnum', 'Case' + n, 'buyer', phone, alt, 'new'])
  const id = Number(r.lastInsertRowid)
  ensureState(id)
  transitionAiState(id, state, 'test setup')
  return id
}
function inbound(cid, from, body, when = new Date().toISOString()) {
  db.run(`INSERT INTO communications (client_id, channel, direction, from_addr, to_addr, body, occurred_at)
          VALUES (?,?,?,?,?,?,?)`, [cid, 'text', 'incoming', from, '+13193431562', body, when])
}

// ── the Doug case ────────────────────────────────────────────────────────────────
test('a reply from a number no longer on file stops blocking the AI', () => {
  const id = mkLead({ phone: '563-880-0738' })                 // the corrected number
  inbound(id, '+13197214755', "I don't know who this Doug character is")  // the old one

  const r = releaseWrongNumberBlock(id)
  assert.equal(r.cleared, true, 'the stranger on the old number must not hold the lead')
  assert.equal(r.from_state, 'HUMAN_TAKEOVER')
  assert.equal(db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [id]).ai_state, 'AI_ELIGIBLE')
  assert.equal(db.get('SELECT ai_enabled FROM ai_lead_state WHERE client_id=?', [id]).ai_enabled, 1)
})

test('and the AI policy actually lets a send through afterwards', () => {
  // canSendSms checks the global AI switches before the per-lead state, so this
  // turns them on (production has them on) and puts them back afterwards rather
  // than leaving the shared test DB changed.
  const flags = ['ai_followup_enabled', 'ai_proactive_text_enabled']
  const saved = flags.map(k => [k, db.getSetting(k, '0')])
  flags.forEach(k => db.setSetting(k, '1'))
  try {
    const id = mkLead({ phone: '563-880-0739' })
    inbound(id, '+13197214755', 'wrong number')

    const before = canSendSms(db.get('SELECT * FROM clients WHERE id=?', [id]), { channel: 'ai', mode: 'proactive' })
    assert.equal(before.ok, false, 'guard: it really was blocked')
    assert.match(before.reason, /HUMAN_TAKEOVER/)

    releaseWrongNumberBlock(id)
    const after = canSendSms(db.get('SELECT * FROM clients WHERE id=?', [id]), { channel: 'ai', mode: 'proactive' })
    assert.ok(!/ai state/i.test(after.reason || ''), 'the ai_state block must be gone: ' + after.reason)
  } finally {
    saved.forEach(([k, v]) => db.setSetting(k, v))
  }
})

// ── the guard ────────────────────────────────────────────────────────────────────
test('a reply from the number STILL on file keeps its block', () => {
  const id = mkLead({ phone: '(319) 721-4755' })
  inbound(id, '+13197214755', 'not interested, stop')

  const r = releaseWrongNumberBlock(id)
  assert.equal(r.cleared, false)
  assert.equal(r.why, 'replied from a number still on file')
  assert.equal(db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [id]).ai_state, 'HUMAN_TAKEOVER')
})

test('an alt_phones match counts as still on file', () => {
  const id = mkLead({ phone: '563-880-0740', alt: '319-721-4755' })
  inbound(id, '+13197214755', 'this is my second line, leave me alone')

  assert.equal(releaseWrongNumberBlock(id).cleared, false,
    'the lead gave us that number themselves — it is theirs, not a wrong number')
})

test('no inbound at all is left alone — nothing proves a reply caused the state', () => {
  const id = mkLead({ phone: '563-880-0741' })
  const r = releaseWrongNumberBlock(id)
  assert.equal(r.cleared, false)
  assert.match(r.why, /no inbound/)
})

// ── states an agent chose deliberately ───────────────────────────────────────────
test('AI_DISABLED, CLOSED_CONVERTED and AI_PAUSED are never auto-cleared', () => {
  for (const state of ['AI_DISABLED', 'CLOSED_CONVERTED', 'AI_PAUSED']) {
    const id = mkLead({ phone: '563-880-07' + (50 + seq), state })
    inbound(id, '+13197214755', 'wrong number')
    assert.equal(releaseWrongNumberBlock(id).cleared, false, `${state} is a human decision, not a number's verdict`)
    assert.equal(db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [id]).ai_state, state)
  }
})

test('the clearable list stays a subset of what canSendSms actually blocks on', () => {
  // If someone adds a state here that the policy never denied, this sweep would be
  // clearing something for no reason; if the policy adds one, this is where to decide.
  const policy = ['HUMAN_TAKEOVER', 'DO_NOT_TEXT', 'NOT_INTERESTED', 'AI_DISABLED', 'CLOSED_CONVERTED']
  for (const s of WRONG_NUMBER_CLEARABLE) {
    assert.ok(policy.includes(s), `${s} is cleared but canSendSms does not block on it`)
  }
})

test('dry run reports without writing', () => {
  const id = mkLead({ phone: '563-880-0742' })
  inbound(id, '+13197214755', 'wrong number')
  const r = releaseWrongNumberBlock(id, { dry: true })
  assert.equal(r.cleared, true)
  assert.equal(db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [id]).ai_state, 'HUMAN_TAKEOVER',
    'a dry run must not move the state')
})
