// The whole point of this lane is that it must never claim a relationship that does not
// exist. That is a copy property, and copy drifts, so it is asserted here rather than
// trusted to review.
import test from 'node:test'
import assert from 'node:assert'
import db, { initDb } from '../server/database.js'

await initDb()
// buyer_facts is created lazily by the first buyer-profile call, so a fixture that
// DELETEs from it before anything has initialised it fails on a clean database.
const { initBuyerProfile } = await import('../server/buyer-profile.js')
initBuyerProfile()
const CNC = await import('../server/ai-followup/cold-history-unknown.js')
const G = await import('../server/ai-followup/greeting.js')
const BP = await import('../server/buyer-profile.js')

const allMessages = () => {
  const out = []
  for (const s of CNC.CNC_STAGES) {
    for (const m of s.messages) out.push([s.key, m])
    for (const [f, m] of Object.entries(s.known || {})) out.push([`${s.key}.known.${f}`, m])
  }
  out.push(['home_to_sell', CNC.HOME_TO_SELL_ASK])
  return out
}

test('no message claims a conversation that never happened', () => {
  const bad = []
  for (const [where, msg] of allMessages()) {
    const hits = CNC.findBanned(msg)
    if (hits.length) bad.push(`${where}: ${hits.join(', ')} -> ${msg.slice(0, 70)}`)
  }
  assert.deepEqual(bad, [], 'banned phrases found:\n' + bad.join('\n'))
})

test('the old cold bank WOULD fail this check — proving the check bites', async () => {
  const P = await import('../server/ai-followup/prompts.js')
  const t1 = P.COLD_BUYER_STAGES[0].messages
  const offending = t1.filter(m => CNC.findBanned(m).length)
  assert.ok(offending.length > 0, 'the old bank should trip the banned list; if it does not, the list is too weak')
})

test('every message opens with a greeting token and a name', () => {
  for (const [where, msg] of allMessages()) {
    assert.ok(msg.startsWith('{{greeting}} {{first_name}},'), `${where} must open with the greeting tokens: ${msg.slice(0, 48)}`)
  }
})

test('bank sizes are small and purposeful, not padded', () => {
  const want = { t1: [6, 8], t2: [4, 6], t3: [4, 6], t4: [4, 6], t5: [4, 6], t6: [4, 6], ltn1: [3, 5], ltn2: [3, 5], ltn3: [3, 5], ltn4: [3, 5] }
  for (const s of CNC.CNC_STAGES) {
    const [lo, hi] = want[s.key]
    assert.ok(s.messages.length >= lo && s.messages.length <= hi,
      `${s.key} has ${s.messages.length}, expected ${lo}-${hi}`)
  }
  const total = CNC.CNC_STAGES.reduce((a, s) => a + s.messages.length, 0)
  assert.ok(total < 60, `bank is ${total}; the point was fewer templates, not another 152`)
})

test('no two stages ask the same question twice in different words', () => {
  // T1 and T2 are the pair most at risk: both are about where they stand.
  const t1 = CNC.CNC_STAGES.find(s => s.key === 't1').messages.join(' ').toLowerCase()
  const t2 = CNC.CNC_STAGES.find(s => s.key === 't2').messages.join(' ').toLowerCase()
  assert.ok(!/still looking/.test(t2), 'T2 must not re-ask T1 as "still looking"')
  assert.ok(t1.length && t2.length)
})

const CID = 990200001
const reset = () => db.run('DELETE FROM buyer_facts WHERE client_id=?', [CID])

test('a stage whose facts are all known and fresh is skipped, not padded', () => {
  reset()
  BP.setFact(CID, 'must_haves', 'big garage')
  BP.setFact(CID, 'property_type', 'ranch')
  BP.setFact(CID, 'preferred_location', 'Marion')
  const picked = CNC.selectMessage(CID, 't4')
  assert.equal(picked, null, 'T4 exists to learn those three; with all three known it has nothing to ask')
  reset()
})

test('a known-but-stale fact becomes a confirmation, never a fresh ask', () => {
  reset()
  const old = new Date(Date.now() - 400 * 86400000).toISOString()
  BP.setFact(CID, 'preferred_location', 'Marion', { at: old })
  const picked = CNC.selectMessage(CID, 'ltn3')
  assert.equal(picked.kind, 'confirm')
  assert.match(picked.text, /still mainly interested in Marion/)
  assert.ok(!/what type of home|is there a particular area/i.test(picked.text))
  reset()
})

test('an unknown fact still gets asked plainly', () => {
  reset()
  const picked = CNC.selectMessage(CID, 't4')
  assert.equal(picked.kind, 'ask')
  assert.ok(picked.text.includes('{{first_name}}'))
  reset()
})

test('the loop chases an unanswered fact before a stale one', () => {
  reset()
  assert.equal(CNC.nextUsefulTopic(CID).purpose, 'unanswered_fact')
  for (const f of ['preferred_location', 'timing', 'property_type', 'must_haves', 'price_max', 'home_to_sell']) BP.setFact(CID, f, 'x')
  assert.equal(CNC.nextUsefulTopic(CID).purpose, 'relationship')
  reset()
})

test('greetings render at send time and fall back when the clock is unknowable', () => {
  const local = { first_name: 'Dana', phone: '(319) 555-0101' }
  const far = { first_name: 'Dana', phone: '(212) 555-0101' }
  const morning = new Date('2026-10-27T15:00:00Z')  // 10am Central
  const evening = new Date('2026-10-28T01:00:00Z')  // 8pm Central

  assert.equal(G.timeOfDay(morning), 'morning')
  assert.equal(G.timeOfDay(evening), 'evening')
  assert.equal(G.localTimeKnown(local.phone), true)
  assert.equal(G.localTimeKnown(far.phone), false)

  // An out-of-area number never gets a time-of-day claim.
  for (let r = 0; r < 6; r++) {
    assert.ok(['Hi', 'Hello'].includes(G.greetingFor(far, { now: evening, rotation: r })))
  }
  const out = G.renderGreeting('{{greeting}} {{first_name}}, test', local, { now: morning, rotation: 1 })
  assert.equal(out, 'Good morning Dana, test')
})

test('a missing first name never produces "Hi ," or "Good morning there,"', () => {
  const nameless = { first_name: '', phone: '(319) 555-0102' }
  for (let r = 0; r < 8; r++) {
    const s = G.renderGreeting('{{greeting}} {{first_name}}, test', nameless, { rotation: r })
    assert.ok(!/,\s*,/.test(s), s)
    assert.ok(!/^Good (morning|afternoon|evening) there,/.test(s), s)
    assert.match(s, /^(Hi|Hello) there, test$/)
  }
})

test('rendered messages still carry no banned phrase', () => {
  const client = { first_name: 'Dana', phone: '(319) 555-0103' }
  for (const [where, msg] of allMessages()) {
    // {{value}} is filled by selectMessage from the stored fact, not by the greeting
    // renderer, so stand one in before checking the finished text.
    const withValue = msg.replaceAll('{{value}}', 'Marion')
    for (let r = 0; r < 4; r++) {
      const rendered = G.renderGreeting(withValue, client, { rotation: r })
      assert.deepEqual(CNC.findBanned(rendered), [], `${where} after rendering: ${rendered.slice(0, 70)}`)
      assert.ok(!rendered.includes('{{'), `${where} left an unrendered token: ${rendered}`)
    }
  }
})

test.after(() => { db.run('DELETE FROM buyer_facts WHERE client_id=?', [CID]) })
