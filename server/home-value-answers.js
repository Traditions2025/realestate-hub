// What the homeowner actually told us on the questionnaire, and what is still unknown.
//
// WHY THIS EXISTS. The landing page grew from "address + contact" into nine screens, so by
// the time the response sequence runs we usually already know the condition, the updates,
// the basement, the garage and when they might move. Until now none of it was stored: the
// intake parsed HV_Condition / HV_Timeline / HV_Would_Buy into a sentence in the activity
// log and threw the rest away, and HV_Data - which carries beds, baths, update ages,
// remodel depth, basement and garage - was never parsed at all. So every step asked as if
// it knew nothing, and a homeowner who had just filled in nine screens was asked to fill
// them in again by text.
//
// TWO HOMES FOR TWO KINDS OF FACT, deliberately:
//   home_value_answers   what they SUBMITTED, one row per submission. Keyed on the
//                        submission id because Sierra merges on email, so a homeowner who
//                        asks again in six months is the same lead and a different
//                        submission - and the newer answers should win without destroying
//                        what they said the first time.
//   home_value_sms       what we LEARNED afterwards (best feature, destination, reaction).
//                        That belongs to the person, not to one submission, and that table
//                        already holds the reply-derived facts.
//
// Nothing here sends anything. It reads answers and says what is still worth asking.
import db from './database.js'

const nowIso = () => new Date().toISOString()

/**
 * A past client, for the purposes of HOW we reach them about a home value: email only,
 * never a text (John, 2026-11-05).
 *
 * They are not a prospect being qualified. They already know us, they are on the
 * long-term Home Value nurture by email, and a text asking them to rate their house
 * reads as cold prospecting from the one team that should know better.
 *
 * Same test the long-term handoff in home-value-sms.js already makes when it chooses
 * between the past-client drip and the weekly one, so "past client" means one thing
 * across the whole Home Value system: closed, or carrying a past-client tag.
 */
export function isPastClient(client) {
  if (!client) return false
  const status = String(client.status || '').toLowerCase()
  if (status === 'closed') return true
  return /past client/i.test(String(client.tags || ''))
}

/**
 * The submission as QUESTIONS AND ANSWERS, for the Home Value box on the lead profile
 * (John, 2026-11-05 - "it needs to show what the question is and what the answer is",
 * then "make it a separate box instead").
 *
 * The questions are the form's own, in the form's own order, so the box reads like the
 * conversation they just had. A question they SKIPPED stays on the list with a null
 * answer rather than being dropped: what they did not answer is what tells you what is
 * still worth asking, and it is the same list the response sequence reads.
 *
 * Built from the STORED answers rather than the notification text, so it says the same
 * thing whether the submission arrived live or was recorded afterwards.
 */
export function submissionQA(clientId) {
  const a = latestAnswers(clientId)
  if (!a) return null

  const baths = [a.baths_full ? `${a.baths_full} full` : '',
    a.baths_half && a.baths_half !== '0' ? `${a.baths_half} half` : ''].filter(Boolean).join(', ')
  const bedBath = [a.beds ? `${a.beds} bed` : '', baths].filter(Boolean).join(', ')

  const updates = Object.entries(a.updates || {})
    .map(([item, age]) => `${item} (${/unsure/i.test(String(age)) ? 'not sure when' : String(age) + ' yrs'})`)
    .join(', ')

  const depth = [
    remodelLabel('remodel_kitchen', a.remodel_kitchen) && `kitchen ${remodelLabel('remodel_kitchen', a.remodel_kitchen)}`,
    remodelLabel('remodel_bath', a.remodel_bath) && `bathroom ${remodelLabel('remodel_bath', a.remodel_bath)}`,
    remodelLabel('remodel_basement', a.remodel_basement) && `basement ${remodelLabel('remodel_basement', a.remodel_basement)}`,
  ].filter(Boolean).join(', ')

  const FINISH = { none: 'unfinished', part: 'partially finished', mostly: 'mostly finished', all: 'fully finished' }
  const basement = [a.basement_type, FINISH[String(a.basement_finish || '').toLowerCase()] || a.basement_finish]
    .filter(Boolean).join(', ')

  const garage = [
    a.garage_stalls && a.garage_stalls !== '0' ? `${a.garage_stalls} stall` : (a.garage_stalls === '0' ? 'none' : ''),
    a.garage_type && a.garage_type !== 'unsure' ? a.garage_type : '',
    a.parking || '',
  ].filter(Boolean).join(', ')

  const clean = (v) => { const s = String(v == null ? '' : v).trim(); return s || null }
  const pairs = [
    ['How would you rate the overall condition of your home?', a.condition_rating ? `${a.condition_rating} out of 10` : null],
    ['What keeps it from being a 10?', clean(proseForHomeowner(a.condition_gap))],
    ["Let's make sure we have the house itself right", clean(bedBath)],
    ["What have you updated while you've owned the home?", clean(updates)],
    ['How extensive were those updates?', clean(depth)],
    ['Anything specific about the work?', clean(proseForHomeowner(a.work_notes))],
    ['Tell us a little about the basement', clean(basement)],
    ['Anything about the basement we should know?', clean(proseForHomeowner(a.basement_notes))],
    ['What kind of garage and parking does the home have?', clean(garage)],
    ['I am planning to move', clean(a.timeframe)],
    ['Would you need to buy another home?', clean(a.would_buy)],
    ["Anything else you'd like us to know?", clean(proseForHomeowner(a.other_notes))],
  ].map(([q, ans]) => ({ q, a: ans }))

  return {
    submission_id: a.submission_id,
    submitted_at: a.submitted_at,
    source: a.source,
    answered: pairs.filter((p) => p.a).length,
    total: pairs.length,
    pairs,
  }
}

export function initHvAnswers() {
  try {
    db.run(`CREATE TABLE IF NOT EXISTS home_value_answers (
      submission_id TEXT PRIMARY KEY,
      client_id INTEGER NOT NULL,
      submitted_at TEXT,
      source TEXT,
      condition_rating INTEGER,
      condition_gap TEXT,
      beds TEXT, baths_full TEXT, baths_half TEXT,
      updates TEXT,
      remodel_kitchen TEXT, remodel_bath TEXT, remodel_basement TEXT,
      work_notes TEXT,
      basement_type TEXT, basement_finish TEXT, basement_notes TEXT,
      garage_stalls TEXT, garage_type TEXT, parking TEXT,
      timeframe TEXT, would_buy TEXT, other_notes TEXT,
      raw TEXT,
      created_at TEXT
    )`)
    db.run('CREATE INDEX IF NOT EXISTS idx_hvans_client ON home_value_answers(client_id, submitted_at)')
    // Facts learned during the sequence rather than on the form. They belong to the person.
    for (const col of ['home_best_feature TEXT', 'move_destination TEXT', 'valuation_reaction TEXT',
                       'seller_timing_detail TEXT', 'human_followup_required INTEGER DEFAULT 0']) {
      try { db.run(`ALTER TABLE home_value_sms ADD COLUMN ${col}`) } catch { /* already there */ }
    }
  } catch { /* table work is best effort; the sequence must still run */ }
}

/**
 * HV_Data is one line carrying the whole submission:
 *   id=HV-20261029-SNTN;cond=7;beds=3;bathsf=2;bathsh=0;upd=Roof:3-5,Furnace:6-10;
 *   bsmt=full|part;gar=2|attached;time=Just curious;buy=unsure;zip=52227
 * Pairs split on ';', key and value on '='. Inside `upd` the entries split on ',' and each
 * is Item:age - deliberately NOT ';', because joining it with ';' once made Furnace parse
 * as a top-level key. `bsmt` is type|finish and `gar` is stalls|type. ';', '|' and '=' are
 * stripped from every value before it is written, so splitting is safe.
 */
export function parseHvData(s) {
  const out = { updates: {} }
  const text = String(s || '').trim()
  if (!text) return out
  for (const pair of text.split(';')) {
    const i = pair.indexOf('=')
    if (i < 1) continue
    const k = pair.slice(0, i).trim().toLowerCase()
    const v = pair.slice(i + 1).trim()
    if (!v) continue
    if (k === 'upd') {
      if (/^none$/i.test(v)) continue
      for (const item of v.split(',')) {
        const j = item.lastIndexOf(':')
        if (j < 1) continue
        out.updates[item.slice(0, j).trim()] = item.slice(j + 1).trim()
      }
    } else if (k === 'bsmt') {
      const [type, finish] = v.split('|')
      out.basement_type = (type || '').trim() || null
      out.basement_finish = (finish || '').trim() || null
    } else if (k === 'gar') {
      const [stalls, type] = v.split('|')
      out.garage_stalls = (stalls || '').trim() || null
      out.garage_type = (type || '').trim() || null
    } else {
      out[k] = v
    }
  }
  return out
}

// Over 1000 characters the form truncates a prose answer and appends this marker. It is
// OUR plumbing, not their words: the full text is always in the readable note, so anything
// quoted back to a homeowner - an SMS, an email, anywhere - must have it stripped first.
// Stored verbatim so the record stays true; stripped at the point of use.
const TRUNCATION_MARKER = /\s*\[truncated - see the note\]\s*$/i

/** A prose answer in a form that is safe to say back to the person who wrote it. */
export function proseForHomeowner(s) {
  return String(s || '').replace(TRUNCATION_MARKER, '').trim()
}

// The remodel enums are NOT the same shape, and sharing one would silently mis-read every
// basement answer: a basement is never "cosmetic", and a kitchen is never "remodeled".
export const REMODEL_ENUMS = {
  remodel_kitchen: { cosmetic: 'a cosmetic refresh', partial: 'a partial remodel', full: 'a full remodel', unsure: 'not sure how extensive' },
  remodel_bath: { cosmetic: 'a cosmetic refresh', partial: 'a partial remodel', full: 'a full remodel', unsure: 'not sure how extensive' },
  remodel_basement: { finished: 'finished', remodeled: 'remodeled an existing finish', partial: 'partially finished', unsure: 'not sure how extensive' },
}

/** Plain-English form of a remodel answer, per field, or '' when it is not a known value. */
export function remodelLabel(field, value) {
  const map = REMODEL_ENUMS[field]
  if (!map) return ''
  return map[String(value || '').trim().toLowerCase()] || ''
}

/** Store one submission. Idempotent on the submission id. */
export function saveAnswers(clientId, sub, { submittedAt = nowIso() } = {}) {
  const cid = Number(clientId)
  if (!cid || !sub) return { ok: false, reason: 'no client' }
  const d = parseHvData(sub.HV_Data || sub.hv_data || sub.data_raw || '')
  // The labelled fields win over HV_Data where both exist: they are what the form posts
  // explicitly, and HV_Data is the belt-and-braces copy.
  const id = String(sub.submission_id || d.id || `hv_${cid}_${String(submittedAt).slice(0, 16)}`)
  const num = (v) => { const n = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(n) ? n : null }
  const row = {
    submission_id: id,
    client_id: cid,
    submitted_at: submittedAt,
    source: sub.source_line || null,
    condition_rating: num(sub.condition || d.cond),
    condition_gap: sub.condition_gap || null,
    beds: sub.beds || d.beds || null,
    baths_full: sub.baths || d.bathsf || null,
    baths_half: d.bathsh ?? null,
    updates: Object.keys(d.updates).length ? JSON.stringify(d.updates) : null,
    remodel_kitchen: d.lvlk || null,
    remodel_bath: d.lvlb || null,
    remodel_basement: d.lvlbs || null,
    work_notes: sub.work_notes || null,
    basement_type: d.basement_type || null,
    basement_finish: d.basement_finish || null,
    basement_notes: sub.basement_notes || null,
    garage_stalls: d.garage_stalls || null,
    garage_type: d.garage_type || null,
    parking: d.park || null,
    timeframe: sub.timeframe || d.time || null,
    would_buy: sub.would_buy || d.buy || null,
    other_notes: sub.other_notes || null,
    raw: sub.HV_Data || null,
    created_at: nowIso(),
  }
  const cols = Object.keys(row)
  try {
    db.run(`INSERT OR REPLACE INTO home_value_answers (${cols.join(',')})
            VALUES (${cols.map(() => '?').join(',')})`, cols.map((c) => row[c]))
  } catch (e) {
    return { ok: false, reason: e.message }
  }
  return { ok: true, submission_id: id, stored: row }
}

/** The most recent submission for this lead, with its updates decoded. */
export function latestAnswers(clientId) {
  const cid = Number(clientId)
  if (!cid) return null
  let r = null
  try {
    r = db.get(`SELECT * FROM home_value_answers WHERE client_id=?
                ORDER BY submitted_at DESC, rowid DESC LIMIT 1`, [cid])
  } catch { return null }
  if (!r) return null
  let updates = {}
  try { updates = JSON.parse(r.updates || '{}') || {} } catch { updates = {} }
  return { ...r, updates }
}

/** Facts learned after the form - best feature, destination, reaction. */
export function learnedFacts(clientId) {
  try {
    return db.get(`SELECT condition_rating, improvements, repairs, timeframe,
                          home_best_feature, move_destination, valuation_reaction,
                          seller_timing_detail, human_followup_required
                   FROM home_value_sms WHERE client_id=?`, [Number(clientId)]) || {}
  } catch { return {} }
}

export function rememberFact(clientId, field, value) {
  const allowed = ['home_best_feature', 'move_destination', 'valuation_reaction',
                   'seller_timing_detail', 'human_followup_required']
  if (!allowed.includes(field)) return { ok: false, reason: `not a learnable field: ${field}` }
  try {
    db.run(`UPDATE home_value_sms SET ${field}=?, updated_at=? WHERE client_id=?`,
      [value, nowIso(), Number(clientId)])
    return { ok: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

// ---- what do we still not know? ----------------------------------------------------
//
// Order matters: it is the order a person would ask in, most valuable first. Condition
// before anything else, because it is the single thing an automated estimate cannot see.
export const QUESTION_ORDER = [
  'condition', 'condition_gap', 'updates', 'update_timing', 'remodel_depth',
  'basement', 'garage', 'timeframe', 'need_to_buy', 'best_feature',
  'destination', 'valuation_reaction',
]

const has = (v) => v !== null && v !== undefined && String(v).trim() !== ''

/** True when that field is already answered, on the form or in a later reply. */
export function known(clientId, field, a = null, f = null) {
  const ans = a || latestAnswers(clientId) || {}
  const learned = f || learnedFacts(clientId) || {}
  const updates = ans.updates || {}
  switch (field) {
    case 'condition': return has(ans.condition_rating) || has(learned.condition_rating)
    case 'condition_gap': return has(ans.condition_gap) || has(learned.repairs)
    case 'updates': return Object.keys(updates).length > 0 || has(learned.improvements)
    // every update they reported carries an age, so timing is known only when none is blank
    case 'update_timing': {
      const vals = Object.values(updates)
      return vals.length > 0 && vals.every((v) => has(v) && !/unsure/i.test(String(v)))
    }
    case 'remodel_depth': return has(ans.remodel_kitchen) || has(ans.remodel_bath) || has(ans.remodel_basement)
    case 'basement': return has(ans.basement_type) || has(ans.basement_finish)
    case 'garage': return has(ans.garage_stalls) || has(ans.garage_type)
    case 'timeframe': return has(ans.timeframe) || has(learned.timeframe)
    case 'need_to_buy': return has(ans.would_buy)
    case 'best_feature': return has(learned.home_best_feature)
    case 'destination': return has(learned.move_destination)
    case 'valuation_reaction': return has(learned.valuation_reaction)
    default: return false
  }
}

/**
 * The next question worth asking, or null when there is nothing left worth asking.
 *
 * null is a real answer, not a failure: when everything useful is known the sequence
 * should interpret and educate rather than manufacture another question.
 */
export function nextBestQuestion(clientId) {
  const a = latestAnswers(clientId)
  const f = learnedFacts(clientId)
  // Nothing submitted at all: the old behaviour is right, start at condition.
  for (const q of QUESTION_ORDER) {
    // destination is only worth asking of someone who might actually move
    if (q === 'destination' && !mightMove(clientId, a, f)) continue
    if (!known(clientId, q, a, f)) return q
  }
  return null
}

/** Someone who said "just curious" is not asked where they would go next. */
export function mightMove(clientId, a = null, f = null) {
  const ans = a || latestAnswers(clientId) || {}
  const learned = f || learnedFacts(clientId) || {}
  const t = String(ans.timeframe || learned.timeframe || '').toLowerCase()
  if (!t) return false
  if (/curious|not right now|no plans/.test(t)) return false
  return true
}

/**
 * How much of the high-value picture we hold. Drives whether the early steps gather or
 * interpret.
 */
export const COMPLETENESS_FIELDS = ['condition', 'condition_gap', 'updates', 'update_timing',
                                    'basement', 'garage', 'timeframe']

export function profileCompleteness(clientId) {
  const a = latestAnswers(clientId)
  const f = learnedFacts(clientId)
  const got = COMPLETENESS_FIELDS.filter((q) => known(clientId, q, a, f))
  const pct = got.length / COMPLETENESS_FIELDS.length
  const label = pct >= 0.7 ? 'HIGH' : pct >= 0.35 ? 'MEDIUM' : 'LOW'
  return { label, known: got, missing: COMPLETENESS_FIELDS.filter((q) => !got.includes(q)), pct }
}

/**
 * What their stated timeframe means for the sequence.
 *   hot    1-3 months  - a person takes over, generic qualification pauses
 *   warm   3-6 months  - flagged for review, sequence becomes secondary
 *   plan   6-12 / 1y+  - keep going, start learning destination
 *   browse just curious - stay valuation-focused, never ask about moving
 */
export function timeframeLane(clientId, a = null, f = null) {
  const ans = a || latestAnswers(clientId) || {}
  const learned = f || learnedFacts(clientId) || {}
  const t = String(ans.timeframe || learned.timeframe || '').toLowerCase()
  if (!t) return 'unknown'
  if (/1-3|1 to 3|within 1|next month|asap/.test(t)) return 'hot'
  if (/3-6|3 to 6/.test(t)) return 'warm'
  if (/6-12|6 to 12|year|12 month/.test(t)) return 'plan'
  if (/curious|not right now|no plans/.test(t)) return 'browse'
  return 'unknown'
}
