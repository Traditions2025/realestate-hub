// The submission in its own box on the lead profile, as questions and answers
// (John, 2026-11-05: "it needs to show what the question is and what the answer is",
// then "make it a separate box instead ... also add date").
//
// Before this a request left one run-on line in the activity log and nothing anyone would
// find. Half the answers were not recorded at all: beds, baths, the basement, the garage,
// how extensive the work was.
//
// It renders from the STORED answers, not from the notification text, so it says the same
// thing whether the submission arrived live or was recorded afterwards. Nothing is written
// into clients.notes - that field is for what a person wrote.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const HVA = await import('../server/home-value-answers.js')
HVA.initHvAnswers()

let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')
const mk = () => db.run(
  'INSERT INTO clients (first_name, last_name, type, status, address) VALUES (?,?,?,?,?)',
  ['Barney', 'Foley', 'seller', 'closed', '5661 Meadow Grass Cir SE'],
).lastInsertRowid

// Barney's real submission, as the form sent it.
const SUB = () => ({
  submission_id: 'HV-' + uniq(),
  address_full: '5661 MEADOW GRASS CIR SE, CEDAR RAPIDS, IA, 52403',
  condition: '9',
  condition_gap: '',
  timeframe: 'Just curious',
  would_buy: 'yes',
  source_line: 'mattsmithteam.com/home-value',
  HV_Data: 'id=HV-X;cond=9;beds=3;bathsf=3;bathsh=1;upd=Kitchen:0-2,Other bathroom(s):unsure,' +
           'Interior paint:3-5,Deck:0-2,Landscaping:3-5;lvlk=partial;lvlb=partial;' +
           'bsmt=walkout|mostly;gar=3|attached;time=Just curious;buy=yes;zip=52403',
})

const load = (cid, sub = SUB(), at = '2026-11-05T17:23:04.000Z') => {
  HVA.saveAnswers(cid, sub, { submittedAt: at })
  return HVA.submissionQA(cid)
}
const find = (qa, needle) => qa.pairs.find((p) => p.q.includes(needle))

test('every question is listed with the answer beside it', () => {
  const qa = load(mk())
  assert.equal(find(qa, 'rate the overall condition').a, '9 out of 10')
  assert.equal(find(qa, 'house itself right').a, '3 bed, 3 full, 1 half')
  assert.match(find(qa, 'updated while').a, /Kitchen \(0-2 yrs\)/)
  assert.match(find(qa, 'updated while').a, /Other bathroom\(s\) \(not sure when\)/, 'an unknown age reads as unknown')
  assert.equal(find(qa, 'How extensive').a, 'kitchen a partial remodel, bathroom a partial remodel')
  assert.equal(find(qa, 'about the basement').a, 'walkout, mostly finished')
  assert.equal(find(qa, 'garage and parking').a, '3 stall, attached')
  assert.equal(find(qa, 'planning to move').a, 'Just curious')
  assert.equal(find(qa, 'buy another home').a, 'yes')
})

test('a question they skipped stays on the list, with no answer', () => {
  // What they did NOT answer is what tells you what is still worth asking.
  const qa = load(mk())
  assert.equal(find(qa, 'keeps it from being a 10').a, null)
  assert.equal(find(qa, "Anything else you'd like").a, null)
  assert.equal(qa.pairs.length, 12, 'skipped questions are not dropped')
})

test('it counts how much of the form they actually filled in', () => {
  const qa = load(mk())
  assert.equal(qa.total, 12)
  assert.ok(qa.answered > 0 && qa.answered < qa.total)
  assert.equal(qa.answered, qa.pairs.filter((p) => p.a).length)
})

test('the date they asked comes back, for the box to show', () => {
  const qa = load(mk(), SUB(), '2026-11-05T17:23:04.000Z')
  assert.equal(qa.submitted_at, '2026-11-05T17:23:04.000Z')
  assert.match(qa.submission_id, /^HV-/)
})

test('a lead who never asked has no box at all', () => {
  assert.equal(HVA.submissionQA(mk()), null)
})

test('the newest request wins when somebody asks twice', () => {
  const cid = mk()
  load(cid, SUB(), '2026-11-05T17:23:04.000Z')
  const second = { ...SUB(), condition: '7', timeframe: '3-6 months' }
  const qa = load(cid, second, '2026-12-01T15:00:00.000Z')
  assert.equal(qa.submitted_at, '2026-12-01T15:00:00.000Z')
  assert.equal(find(qa, 'rate the overall condition').a, '7 out of 10')
  assert.equal(find(qa, 'planning to move').a, '3-6 months')
})

test('nothing is written into the notes field', () => {
  // The box replaced the note. clients.notes stays for what a person wrote, and a re-read
  // of the same submission cannot leave the questionnaire on the record twice.
  const cid = mk()
  db.run('UPDATE clients SET notes = ? WHERE id = ?', ['[Oct 1, 2026, 9:00 AM · John] Called, left a voicemail', cid])
  load(cid)
  const notes = db.get('SELECT notes FROM clients WHERE id=?', [cid]).notes
  assert.ok(!/HOME VALUE REQUEST/.test(notes), 'the questionnaire is not in the notes')
  assert.match(notes, /Called, left a voicemail/, 'and what a person wrote is untouched')
})

test('a homeowner sentence survives intact', () => {
  const cid = mk()
  const qa = load(cid, { ...SUB(), condition_gap: 'Kitchen is original; carpet needs replacing' })
  assert.equal(find(qa, 'keeps it from being a 10').a, 'Kitchen is original; carpet needs replacing')
})

test('an almost empty submission still lists every question', () => {
  const cid = mk()
  const qa = load(cid, { submission_id: 'HV-' + uniq(), condition: '', HV_Data: '' })
  assert.equal(qa.pairs.length, 12)
  assert.equal(qa.answered, 0)
  assert.ok(qa.pairs.every((p) => p.a === null), 'all unanswered, none undefined')
})
