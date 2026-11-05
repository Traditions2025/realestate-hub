// The submission on the lead, as questions and answers (John, 2026-11-05):
// "it needs to show what the question is and what the answer is".
//
// Before this a submission left one run-on line in the activity log and nothing in the
// notes, which is where anyone looks before picking up the phone. Half the answers were
// missing from it entirely: beds, baths, the basement, the garage, how extensive the work
// was.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
await initDb()
const HVA = await import('../server/home-value-answers.js')
const HVI = await import('../server/home-value-intake.js')

let seq = 0
const uniq = () => String(Date.now()).slice(-6) + String(++seq).padStart(2, '0')
const mk = () => db.run(
  'INSERT INTO clients (first_name, last_name, type, status, address) VALUES (?,?,?,?,?)',
  ['Barney', 'Foley', 'seller', 'closed', '5661 Meadow Grass Cir SE'],
).lastInsertRowid

// Barney's real submission, as the form sent it.
const SUB = {
  submission_id: 'HV-' + uniq(),
  address_full: '5661 MEADOW GRASS CIR SE, CEDAR RAPIDS, IA, 52403',
  condition: '9',
  condition_gap: '',
  timeframe: 'Just curious',
  would_buy: 'yes',
  work_notes: '',
  basement_notes: '',
  other_notes: '',
  HV_Data: 'id=HV-X;cond=9;beds=3;bathsf=3;bathsh=1;upd=Kitchen:0-2,Other bathroom(s):unsure,' +
           'Interior paint:3-5,Deck:0-2,Landscaping:3-5;lvlk=partial;lvlb=partial;' +
           'bsmt=walkout|mostly;gar=3|attached;time=Just curious;buy=yes;zip=52403',
}

test('every question is named, with the answer beside it', () => {
  const n = HVA.submissionNote(SUB, { visit: 1 })
  assert.match(n, /How would you rate the overall condition of your home\? 9 out of 10/)
  assert.match(n, /Let's make sure we have the house itself right: 3 bed, 3 full, 1 half/)
  assert.match(n, /What have you updated while you've owned the home\? .*Kitchen \(0-2 yrs\)/)
  assert.match(n, /Other bathroom\(s\) \(not sure when\)/, 'an unknown age reads as unknown')
  assert.match(n, /How extensive were those updates\? kitchen a partial remodel, bathroom a partial remodel/)
  assert.match(n, /Tell us a little about the basement: walkout, mostly finished/)
  assert.match(n, /What kind of garage and parking does the home have\? 3 stall, attached/)
  assert.match(n, /I am planning to move: Just curious/)
  assert.match(n, /Would you need to buy another home\? yes/)
})

test('a question they skipped stays on the list, marked unanswered', () => {
  // What they did NOT answer is what tells you what is still worth asking.
  const n = HVA.submissionNote(SUB, { visit: 1 })
  assert.match(n, /What keeps it from being a 10\? \(not answered\)/)
  assert.match(n, /Anything else you'd like us to know\? \(not answered\)/)
})

test('it is one note, not fourteen', () => {
  // clients.notes is one text field and a line after a stamped one is a continuation, so
  // this must land as a single dated note.
  const cid = mk()
  HVI.writeSubmissionNote(cid, SUB, 1, '2026-11-05T17:23:04.000Z')
  const notes = db.get('SELECT notes FROM clients WHERE id=?', [cid]).notes
  const stamped = notes.split('\n').filter(l => /^\[[A-Z]/.test(l))
  assert.equal(stamped.length, 1, 'exactly one stamp')
  assert.match(stamped[0], /· Home Value\] HOME VALUE REQUEST/)
  assert.ok(notes.split('\n').length > 10, 'and the rest are its lines')
})

test('it carries the submission date, not today', () => {
  const cid = mk()
  HVI.writeSubmissionNote(cid, SUB, 1, '2026-11-05T17:23:04.000Z')
  assert.match(db.get('SELECT notes FROM clients WHERE id=?', [cid]).notes, /^\[Nov 5, 2026/)
})

test('the same submission is never written twice', () => {
  // The intake can see one notification twice; the questionnaire must not end up on the
  // record twice.
  const cid = mk()
  assert.equal(HVI.writeSubmissionNote(cid, SUB, 1).ok, true)
  assert.equal(HVI.writeSubmissionNote(cid, SUB, 1).ok, false, 'second time is refused')
  const notes = db.get('SELECT notes FROM clients WHERE id=?', [cid]).notes
  assert.equal(notes.split('HOME VALUE REQUEST').length - 1, 1)
})

test('a second, genuinely different request is added above the first', () => {
  const cid = mk()
  HVI.writeSubmissionNote(cid, SUB, 1, '2026-11-05T17:23:04.000Z')
  HVI.writeSubmissionNote(cid, { ...SUB, submission_id: 'HV-' + uniq(), condition: '7' }, 2, '2026-12-01T15:00:00.000Z')
  const notes = db.get('SELECT notes FROM clients WHERE id=?', [cid]).notes
  assert.match(notes, /^\[Dec 1, 2026/, 'newest first')
  assert.equal(notes.split('HOME VALUE REQUEST').length - 1, 2)
  assert.match(notes, /visit #2/)
})

test('an existing note on the lead is kept', () => {
  const cid = mk()
  db.run('UPDATE clients SET notes = ? WHERE id = ?', ['[Oct 1, 2026, 9:00 AM · John] Called, left a voicemail', cid])
  HVI.writeSubmissionNote(cid, SUB, 1)
  const notes = db.get('SELECT notes FROM clients WHERE id=?', [cid]).notes
  assert.match(notes, /Called, left a voicemail/)
  assert.ok(notes.indexOf('HOME VALUE REQUEST') < notes.indexOf('voicemail'), 'the new one is on top')
})

test('an empty submission still produces a readable note', () => {
  const n = HVA.submissionNote({ submission_id: 'HV-EMPTY' }, { visit: 1 })
  assert.match(n, /Your address: \(not answered\)/)
  assert.ok(!/undefined|NaN|\[object/.test(n), 'nothing leaks through')
})
