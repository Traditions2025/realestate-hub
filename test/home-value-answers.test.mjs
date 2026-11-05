// Reading what the homeowner already told us, and working out what is still worth asking.
//
// The landing page grew to nine screens while the response sequence stayed as it was, so a
// homeowner who had just rated their condition, listed their updates and said when they
// might move was then asked all three again by text. The fix is not new copy, it is that
// nothing was STORED: HV_Data was never parsed, and condition/timeframe/would_buy went
// into a sentence in the activity log rather than a column anything could read.
//
// These pin the two halves of the foundation: the parse, and the "what is still unknown"
// decision that every conditional step will hang off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import db, { initDb } from '../server/database.js'
import { initHvSms } from '../server/home-value-sms.js'
import {
  parseHvData, saveAnswers, latestAnswers, initHvAnswers, nextBestQuestion,
  profileCompleteness, timeframeLane, known, rememberFact, mightMove,
} from '../server/home-value-answers.js'

await initDb()
initHvSms()
initHvAnswers()

const nowIso = () => new Date().toISOString()
let seq = 0
const mkClient = () => {
  seq += 1
  const now = nowIso()
  const id = db.run(`INSERT INTO clients (first_name, last_name, phone, email, type, status, created_at, updated_at)
                     VALUES (?,?,?,?,?,?,?,?)`,
    ['Dana', 'Reyes' + seq, '(319) 555-' + String(2000 + seq).slice(-4),
     `hva${seq}-${Date.now()}@example.com`, 'seller', 'new', now, now]).lastInsertRowid
  db.run(`INSERT OR REPLACE INTO home_value_sms (client_id, status, next_step, requested_at, updated_at)
          VALUES (?,?,?,?,?)`, [id, 'active', 0, now, now])
  return id
}

const FULL = 'id=HV-20261029-SNTN;cond=7;beds=3;bathsf=2;bathsh=0;'
  + 'upd=Roof:3-5,Furnace:6-10;bsmt=full|part;gar=2|attached;time=Just curious;buy=unsure;zip=52227'

// ── the parse ────────────────────────────────────────────────────────────────────────
test('HV_Data decodes into the fields the sequence needs', () => {
  const d = parseHvData(FULL)
  assert.equal(d.id, 'HV-20261029-SNTN')
  assert.equal(d.cond, '7')
  assert.equal(d.beds, '3')
  assert.equal(d.bathsf, '2')
  assert.equal(d.bathsh, '0')
  assert.deepEqual(d.updates, { Roof: '3-5', Furnace: '6-10' })
  assert.equal(d.basement_type, 'full')
  assert.equal(d.basement_finish, 'part')
  assert.equal(d.garage_stalls, '2')
  assert.equal(d.garage_type, 'attached')
  assert.equal(d.time, 'Just curious')
  assert.equal(d.buy, 'unsure')
})

test('upd splits on commas, not semicolons', () => {
  // the first build of the form joined upd with ';', which made Furnace parse as a
  // top-level key and silently lost the roof age
  const d = parseHvData(FULL)
  assert.ok(!('furnace' in d), 'Furnace must not become a top-level key')
  assert.equal(Object.keys(d.updates).length, 2)
})

test('upd=none means no updates, not an update called none', () => {
  const d = parseHvData('cond=5;upd=none;bsmt=slab|none')
  assert.deepEqual(d.updates, {})
})

test('junk in gives an empty shape out, never a crash', () => {
  for (const bad of ['', null, undefined, ';;;', 'garbage', '=']) {
    const d = parseHvData(bad)
    assert.deepEqual(d.updates, {})
  }
})

// ── storing and reading back ─────────────────────────────────────────────────────────
test('a submission is stored and read back with its updates decoded', () => {
  const cid = mkClient()
  const r = saveAnswers(cid, { submission_id: 'HV-20261029-AAAA', HV_Data: FULL,
                               condition: '7', timeframe: 'Just curious', would_buy: 'unsure' })
  assert.equal(r.ok, true)
  const a = latestAnswers(cid)
  assert.equal(a.condition_rating, 7)
  assert.deepEqual(a.updates, { Roof: '3-5', Furnace: '6-10' })
  assert.equal(a.basement_type, 'full')
  assert.equal(a.garage_stalls, '2')
  assert.equal(a.timeframe, 'Just curious')
})

test('asking twice keeps both submissions and reads the newer one', () => {
  // Sierra merges on email, so a second request six months later is the SAME lead. The
  // newer answers must win without destroying what they said the first time.
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-1', HV_Data: 'cond=4' }, { submittedAt: '2026-01-01T10:00:00Z' })
  saveAnswers(cid, { submission_id: 'HV-2', HV_Data: 'cond=9' }, { submittedAt: '2026-06-01T10:00:00Z' })
  assert.equal(latestAnswers(cid).condition_rating, 9)
  const all = db.all('SELECT submission_id FROM home_value_answers WHERE client_id=?', [cid])
  assert.equal(all.length, 2, 'the first submission is kept')
})

test('the same submission seen twice is stored once', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-DUP', HV_Data: 'cond=6' })
  saveAnswers(cid, { submission_id: 'HV-DUP', HV_Data: 'cond=6' })
  const all = db.all('SELECT submission_id FROM home_value_answers WHERE client_id=?', [cid])
  assert.equal(all.length, 1)
})

// ── what is still worth asking ───────────────────────────────────────────────────────
test('nothing submitted: start where the old sequence started', () => {
  const cid = mkClient()
  assert.equal(nextBestQuestion(cid), 'condition')
  assert.equal(profileCompleteness(cid).label, 'LOW')
})

test('condition given, gap missing: ask the gap, never the rating again', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-C', condition: '7' })
  assert.equal(known(cid, 'condition'), true)
  assert.equal(nextBestQuestion(cid), 'condition_gap')
})

test('condition and gap both given: move past both', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-CG', condition: '8', condition_gap: 'kitchen is original' })
  const q = nextBestQuestion(cid)
  assert.ok(!['condition', 'condition_gap'].includes(q), `must not re-ask, got ${q}`)
})

test('updates listed with ages: do not ask whether they made updates', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-U', condition: '8', condition_gap: 'x', HV_Data: FULL })
  assert.equal(known(cid, 'updates'), true)
  assert.equal(known(cid, 'update_timing'), true)
  assert.notEqual(nextBestQuestion(cid), 'updates')
})

test('an update with an unsure age still needs its timing', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-UT', condition: '8', condition_gap: 'x',
                     HV_Data: 'upd=Roof:unsure,Kitchen:3-5' })
  assert.equal(known(cid, 'updates'), true)
  assert.equal(known(cid, 'update_timing'), false)
  assert.equal(nextBestQuestion(cid), 'update_timing')
})

// WHAT THE FORM DOES NOT SEND, pinned here because it drives everything above.
// HV_Data carries exactly eleven keys (form.js buildFields): id, cond, beds, bathsf,
// bathsh, upd, bsmt, gar, time, buy, zip. Screen 3's "what keeps it from a 10" and screen
// 5's remodel depth are collected on the page but reach us ONLY inside the human-readable
// Questions block, which is explicitly not a parsing target. So the Hub cannot know them,
// and the sequence should still ask - which is the correct behaviour, not a bug.
test('the form does not transmit the condition gap or the remodel depth', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-FORM', condition: '8', HV_Data: FULL,
                     timeframe: 'Just curious', would_buy: 'unsure' })
  assert.equal(known(cid, 'condition'), true, 'cond IS in HV_Data')
  assert.equal(known(cid, 'updates'), true, 'upd IS in HV_Data')
  assert.equal(known(cid, 'basement'), true, 'bsmt IS in HV_Data')
  assert.equal(known(cid, 'condition_gap'), false, 'not transmitted - must still be asked')
  assert.equal(known(cid, 'remodel_depth'), false, 'not transmitted - must still be asked')
})

test('a nearly complete questionnaire asks only what the form could not tell us', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-ALL', condition: '8', condition_gap: 'kitchen',
                     HV_Data: FULL, timeframe: 'Just curious', would_buy: 'unsure' })
  const p = profileCompleteness(cid)
  assert.equal(p.label, 'HIGH', `expected HIGH, got ${p.label} (${p.known.join(',')})`)
  // condition, updates, timing, basement, garage and timeframe all came off the form, so
  // the only thing left worth asking is the remodel depth the form never sent
  assert.equal(nextBestQuestion(cid), 'remodel_depth')
})

test('when everything useful is known the answer is null, not an invented question', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-DONE', condition: '8', condition_gap: 'kitchen',
                     HV_Data: FULL + ';lvlk=full', timeframe: 'Just curious', would_buy: 'unsure' })
  rememberFact(cid, 'home_best_feature', 'the backyard')
  rememberFact(cid, 'valuation_reaction', 'Lower')
  assert.equal(nextBestQuestion(cid), null)
})

// ── intent routing ───────────────────────────────────────────────────────────────────
test('the stated timeframe decides the lane', () => {
  const cases = [
    ['Within 1-3 months', 'hot'],
    ['Within 3-6 months', 'warm'],
    ['Within 6-12 months', 'plan'],
    ['More than a year from now', 'plan'],
    ['Not right now, just curious', 'browse'],
  ]
  for (const [t, lane] of cases) {
    const cid = mkClient()
    saveAnswers(cid, { submission_id: 'HV-T' + t, timeframe: t })
    assert.equal(timeframeLane(cid), lane, `${t} should be ${lane}`)
  }
})

test('someone just curious is never asked where they would move', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-BR', condition: '8', condition_gap: 'x', HV_Data: FULL,
                     timeframe: 'Not right now, just curious', would_buy: 'No' })
  assert.equal(mightMove(cid), false)
  rememberFact(cid, 'home_best_feature', 'kitchen')
  assert.notEqual(nextBestQuestion(cid), 'destination')
})

test('someone moving within the year IS asked where', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-PL', condition: '8', condition_gap: 'x',
                     HV_Data: FULL + ';lvlk=full', timeframe: 'Within 6-12 months', would_buy: 'Yes' })
  rememberFact(cid, 'home_best_feature', 'kitchen')
  assert.equal(mightMove(cid), true)
  assert.equal(nextBestQuestion(cid), 'destination')
})

test('would-need-to-buy answered on the form is never asked again', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-NB', would_buy: 'Yes' })
  assert.equal(known(cid, 'need_to_buy'), true)
})

// ── facts learned later ──────────────────────────────────────────────────────────────
test('facts learned during the sequence are stored against the person', () => {
  const cid = mkClient()
  assert.equal(known(cid, 'best_feature'), false)
  assert.equal(rememberFact(cid, 'home_best_feature', 'the backyard').ok, true)
  assert.equal(known(cid, 'best_feature'), true)
  assert.equal(rememberFact(cid, 'nonsense_field', 'x').ok, false, 'only known fields are writable')
})

// ── the five rules the form's author pinned (2026-10-29) ─────────────────────────────
import { proseForHomeowner, remodelLabel, REMODEL_ENUMS } from '../server/home-value-answers.js'

// The exact payload captured from the form's own harness, traps included: the gap text
// carries ';', '|' and '=' deliberately, because homeowners write them and HV_Data's
// separators would have eaten them had the field not been kept separate.
const CAPTURED_GAP = 'Kitchen is original; the upstairs carpet needs replacing = tired. Garage | shed both need paint.'
const CAPTURED_DATA = 'id=HV-20261029-2TTQ;cond=7;beds=3;bathsf=2;bathsh=0;'
  + 'upd=Roof:3-5,Furnace:6-10;lvlk=full;lvlb=cosmetic;lvlbs=partial;'
  + 'bsmt=full|part;gar=2|attached;time=Just curious;buy=unsure;zip=52227'

test('the captured HV_Data splits to 14 keys with the remodel levels intact', () => {
  const d = parseHvData(CAPTURED_DATA)
  assert.equal(d.lvlk, 'full')
  assert.equal(d.lvlb, 'cosmetic')
  assert.equal(d.lvlbs, 'partial')
  assert.deepEqual(d.updates, { Roof: '3-5', Furnace: '6-10' })
  assert.equal(d.basement_type, 'full')
  assert.equal(d.garage_stalls, '2')
})

test('prose keeps its punctuation because it never goes through the splitter', () => {
  // rule 4: ';', '|' and '=' are legal in a prose answer and fatal inside HV_Data
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-PROSE', condition: '7',
                     condition_gap: CAPTURED_GAP, HV_Data: CAPTURED_DATA })
  const a = latestAnswers(cid)
  assert.equal(a.condition_gap, CAPTURED_GAP, 'stored verbatim, separators and all')
  assert.ok(a.condition_gap.includes(';') && a.condition_gap.includes('|') && a.condition_gap.includes('='))
})

test('remodel depth off HV_Data counts as known', () => {
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-LVL', condition: '7', condition_gap: 'x', HV_Data: CAPTURED_DATA })
  assert.equal(known(cid, 'remodel_depth'), true)
  const a = latestAnswers(cid)
  assert.equal(a.remodel_kitchen, 'full')
  assert.equal(a.remodel_basement, 'partial')
})

test('the basement enum is read on its own terms, not the kitchen one', () => {
  // rule 3: a basement is never "cosmetic" and a kitchen is never "remodeled"
  assert.equal(remodelLabel('remodel_kitchen', 'full'), 'a full remodel')
  assert.equal(remodelLabel('remodel_basement', 'remodeled'), 'remodeled an existing finish')
  assert.equal(remodelLabel('remodel_basement', 'partial'), 'partially finished')
  assert.equal(remodelLabel('remodel_basement', 'cosmetic'), '', 'not a basement value')
  assert.equal(remodelLabel('remodel_kitchen', 'remodeled'), '', 'not a kitchen value')
  assert.notDeepEqual(REMODEL_ENUMS.remodel_kitchen, REMODEL_ENUMS.remodel_basement)
})

test('the truncation marker never reaches the homeowner', () => {
  // rule 2: it is our plumbing, and the full text is in the readable note anyway
  const long = 'The kitchen is original and the carpet is tired [truncated - see the note]'
  assert.equal(proseForHomeowner(long), 'The kitchen is original and the carpet is tired')
  assert.equal(proseForHomeowner('nothing to strip'), 'nothing to strip')
  assert.equal(proseForHomeowner(null), '')
})

test('an absent prose field is unknown, not an empty answer', () => {
  // rule 1: the form omits these entirely rather than sending a blank line
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-ABS', condition: '7', HV_Data: CAPTURED_DATA })
  assert.equal(latestAnswers(cid).condition_gap, null)
  assert.equal(known(cid, 'condition_gap'), false)
  assert.equal(nextBestQuestion(cid), 'condition_gap', 'so the sequence still asks it')
})

test('submissions from before the new fields still get asked, not skipped', () => {
  // rule 5: the old ones cannot be backfilled - the answers exist only in prose
  const cid = mkClient()
  saveAnswers(cid, { submission_id: 'HV-OLD', condition: '7',
                     HV_Data: 'id=HV-OLD;cond=7;upd=none;time=Just curious' })
  assert.equal(known(cid, 'condition'), true)
  assert.equal(known(cid, 'condition_gap'), false)
  assert.equal(known(cid, 'remodel_depth'), false)
})
