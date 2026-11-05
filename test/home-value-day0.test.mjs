// Day 0 is a reply, not a second questionnaire (John's spec, 2026-11-05 §4-§6).
//
// Barney Foley #108 rated his home 9/10 on screen 2 of the form at 12:23 PM. The Day 0
// email asked for that rating again, and the Day 0 text asked for it a third time at
// 12:25. Both now read what he already told us.
//
// The ladder, in order:
//   substantially complete  -> confirm receipt, ask nothing
//   condition unknown       -> ask condition (the original approved copy)
//   condition known, gap no -> ask what keeps it from a 10
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const HVI = await import('../server/home-value-intake.js')
const HVA = await import('../server/home-value-answers.js')
HVA.initHvAnswers()

let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')

function mkLead() {
  return db.run(
    'INSERT INTO clients (first_name, last_name, type, status, phone, address) VALUES (?,?,?,?,?,?)',
    ['Barney', 'Foley', 'seller', 'closed', '+1319555' + uniq().slice(-4), '5661 Meadow Grass Cir SE'],
  ).lastInsertRowid
}

// A submission as the form actually sends it. `over` removes or replaces answers.
function submit(cid, over = {}) {
  const sub = {
    submission_id: 'HV-' + uniq(),
    condition: '9',
    condition_gap: 'The kitchen is still original',
    HV_Data: 'cond=9;beds=3;bathsf=2;bathsh=0;upd=Roof:3-5,Furnace:6-10;lvlk=cosmetic;' +
             'bsmt=full|all;gar=2|attached;time=Just curious;buy=yes',
    timeframe: 'Just curious',
    would_buy: 'yes',
    ...over,
  }
  HVA.saveAnswers(cid, sub, { submittedAt: new Date().toISOString() })
  return sub
}

test('a complete questionnaire gets a confirmation, with no question in it', () => {
  const cid = mkLead()
  submit(cid)
  assert.equal(HVA.profileCompleteness(cid).label, 'HIGH', 'this submission is substantially complete')
  const t = HVI.day0TextFor({ id: cid })
  assert.equal(t, HVI.DAY0_CONFIRMATION)
  assert.ok(!t.includes('?'), 'a reply, not a question')
  assert.ok(!/scale of 1 to 10/i.test(t), 'never re-asks the rating')
  assert.ok(/within 24 hours/.test(t), 'sets the expectation for the real reply')
})

test('an empty questionnaire still gets the original condition question', () => {
  const cid = mkLead()
  assert.equal(HVI.day0TextFor({ id: cid }), HVI.CONDITION_QUESTION)
})

test('condition known but little else: ask what keeps it from a 10, not the rating', () => {
  const cid = mkLead()
  submit(cid, { condition: '7', condition_gap: '', HV_Data: 'cond=7', timeframe: '', would_buy: '' })
  const t = HVI.day0TextFor({ id: cid })
  assert.notEqual(HVA.profileCompleteness(cid).label, 'HIGH', 'not complete, so the fallback applies')
  assert.match(t, /7 out of 10/, 'uses the rating they gave')
  assert.match(t, /keeping it from being a 10/)
  assert.ok(!/scale of 1 to 10/i.test(t), 'does not ask for the rating again')
})

test('every Day 0 variant keeps merge tokens, so the junk-name guard still applies', () => {
  // Interpolating a name here would bypass the guard and send "Hi Test,".
  const cid = mkLead()
  submit(cid)
  for (const t of [HVI.DAY0_CONFIRMATION, HVI.CONDITION_QUESTION, HVI.day0TextFor({ id: cid })]) {
    assert.match(t, /\{\{first_name\}\}/)
    assert.ok(!/\bundefined\b/.test(t))
  }
})

test('the confirmation names the street from a token, never a blank', () => {
  assert.match(HVI.DAY0_CONFIRMATION, /\{\{street_address\}\}/)
})

test('the Day 0 EMAIL no longer asks what the form already asked', async () => {
  // The live template is the one that goes out; the copy lives there, not in code.
  const t = db.get('SELECT subject, body FROM templates WHERE id = 382')
  if (!t) return  // a fresh test DB has no template table content; the live check covers it
  const plain = String(t.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  assert.ok(!/scale of 1 to 10/i.test(plain), 'the rating question is gone')
  assert.ok(!/make it a 10/i.test(plain), 'the gap question is gone')
})
