// Editorial engine: the deterministic checker, the 7-stage pipeline with a scripted model,
// and the Hub plumbing (runs, apply, versions, library, rules history, feedback).
// Offline: no API calls. The DB part runs against a throwaway DB_DIR, never the real file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lintCopy, scrubMechanics } from '../server/editorial/lint.js'
import { buildFactSheet } from '../server/editorial/facts.js'
import { runPipeline, ensureSignoff, pickRecommended } from '../server/editorial/engine.js'

const FACTS = 'Property type: Ranch\nBedrooms: 3\nListed features: fenced yard; deck; main-floor laundry\nAgent-verified details: kitchen cabinets and counters replaced 2022'
const errs = (r) => r.findings.filter(f => f.severity === 'error').map(f => f.category)
const msgs = (r) => r.findings.map(f => f.message).join(' | ')

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------
test('clean, specific MLS copy passes with no findings', () => {
  const r = lintCopy('Kitchen cabinets and counters replaced in 2022 anchor the main level of this 3-bedroom ranch in Marion. Laundry is on the main floor. Outside, a deck looks over the fenced yard, which gives the lot more usable space than the front suggests.', { channel: 'mls', facts: FACTS, charLimit: 1000 })
  assert.equal(r.clean, true, msgs(r))
  assert.equal(r.findings.length, 0, msgs(r))
})

test('generic AI copy is caught on opening, ending, Fair Housing, claims, dashes and rhythm', () => {
  const r = lintCopy("Welcome to this stunning ranch nestled in Marion — perfect for families! The home features three bedrooms. The home features a fenced yard. This move-in ready gem won't last long, schedule your showing today!", { channel: 'mls', facts: FACTS })
  for (const c of ['opening', 'ending', 'fair-housing', 'unsupported-claim', 'mechanics', 'format']) assert.ok(errs(r).includes(c), `expected ${c}: ${msgs(r)}`)
  assert.match(msgs(r), /stunning/)
  assert.match(msgs(r), /Consecutive sentences/)
  assert.match(msgs(r), /Spelled-out number/)
})

test('materials and updates need evidence in the facts', () => {
  const r = lintCopy('Quartz counters and new windows brighten the kitchen.', { channel: 'mls', facts: 'Bedrooms: 3' })
  assert.ok(r.findings.some(f => /quartz/i.test(f.message)), msgs(r))
  assert.ok(r.findings.some(f => /new/i.test(f.message)), msgs(r))
  const ok = lintCopy('Quartz counters were added in the 2023 update.', { channel: 'mls', facts: 'Agent-verified details: quartz counters installed 2023 update' })
  assert.equal(ok.clean, true, msgs(ok))
})

test('MLS format: one paragraph, no bullets, character limit enforced', () => {
  const r = lintCopy('First paragraph here.\n\nSecond paragraph.\n- a bullet', { channel: 'mls', charLimit: 20 })
  assert.ok(errs(r).includes('format'))
  assert.ok(errs(r).includes('length'))
})

test('seller private context and prohibited claims are errors in every channel', () => {
  for (const channel of ['mls', 'active_social', 'premarket_blog']) {
    const r = lintCopy('Motivated seller relocating for work. Best schools in town and guaranteed appreciation.', { channel })
    assert.ok(errs(r).includes('seller-privacy'), channel)
    assert.ok(errs(r).includes('unsupported-claim'), channel)
  }
})

test('pre-market channels may not show price or street address', () => {
  const r = lintCopy('<p>The home at 123 Maple Ave is coming soon at $289,000.</p>', { channel: 'premarket_blog', address: '123 Maple Ave' })
  assert.equal(errs(r).filter(c => c === 'channel').length, 2, msgs(r))
})

test('social captions need the exact sign-off; ensureSignoff puts it before hashtags', () => {
  const caption = 'A 3-bedroom ranch in Marion with a fenced yard.\n\n#CedarRapids #MarionIowa'
  assert.ok(errs(lintCopy(caption, { channel: 'active_social' })).includes('channel'))
  const fixed = ensureSignoff(caption)
  assert.match(fixed, /fenced yard\.\n\nMatt Smith \| Broker Associate\nMatt Smith Team \| RE\/MAX Concepts\n\n#CedarRapids/)
  assert.equal(lintCopy(fixed, { channel: 'active_social' }).clean, true)
  assert.equal(ensureSignoff(fixed), fixed, 'idempotent')
})

test('team avoid-phrase rules are enforced', () => {
  const rules = [{ kind: 'avoid_phrase', pattern: 'perfect for entertaining', rule_text: 'Never write "perfect for entertaining".' }]
  const r = lintCopy('The patio is perfect for entertaining.', { channel: 'mls', customRules: rules })
  assert.ok(errs(r).includes('team-rule'))
})

test('scrubMechanics removes dashes without changing meaning', () => {
  assert.equal(scrubMechanics('A deck — and a yard.'), 'A deck, and a yard.')
  assert.equal(scrubMechanics('Built 2010–2012.'), 'Built 2010 to 2012.')
})

// ---------------------------------------------------------------------------
// Fact sheet
// ---------------------------------------------------------------------------
test('fact sheet excludes seller and internal fields, and honours exclusions', () => {
  const f = buildFactSheet({
    property_address: '123 Maple Ave', city: 'Marion', bedrooms: 3, features: ['Deck', 'Hot tub'],
    seller_name: 'Pat Seller', seller_phone: '319-555-0100', notes: 'Seller relocating, needs $300K net',
    marketing_facts: 'Roof 2021',
  }, { exclude: ['hot tub'] })
  assert.doesNotMatch(f.text, /Pat Seller|555-0100|relocating|300K/)
  assert.doesNotMatch(f.text, /Hot tub/)
  assert.match(f.text, /Roof 2021/)
  assert.match(f.text, /Bedrooms: 3/)
})

// ---------------------------------------------------------------------------
// Pipeline with a scripted model
// ---------------------------------------------------------------------------
const ANALYSIS = {
  property_category: 'ranch', condition: { summary: 'Kitchen updated 2022', evidence: ['2022 kitchen'], confidence: 'partial' },
  positioning: [{ category: 'Updated and thoughtfully improved', evidence: '2022 kitchen' }], price_context: 'Mid-market.',
  primary_features: [{ feature: '2022 kitchen', evidence: 'agent details', benefit: '' }], supporting_features: [], minor_features: [],
  photo_led_features: [], limitations: [], top_selling_points: ['2022 kitchen', 'fenced yard', 'main-floor laundry'],
  recommended_tone: 'natural', recommended_angle: 'updates', claims_to_avoid: ['move-in ready'], questions_for_agent: [],
}
const GOOD = 'Kitchen cabinets and counters replaced in 2022 anchor the main level of this 3-bedroom ranch. Laundry is on the main floor. Outside, a deck looks over the fenced yard, which gives the lot more usable space than the front suggests.'

function scriptedModel(overrides = {}) {
  const calls = []
  const fn = async ({ prompt, system }) => {
    const stage = /STAGE 1:/.test(prompt) ? 'analysis' : /STAGES 2 AND 3/.test(prompt) ? 'draft' : /STAGE 4:/.test(prompt) ? 'review'
      : /STAGE 5:/.test(prompt) ? 'rewrite' : /STAGE 6:/.test(prompt) ? 'verify' : /STAGE 7:/.test(prompt) ? 'polish' : 'other'
    calls.push({ stage, prompt, system })
    const labels = (prompt.match(/--- ([A-C]) /g) || []).map(s => s[4])
    const vs = (labels.length ? labels : ['A', 'B', 'C'])
    if (overrides[stage]) return { data: overrides[stage]({ prompt, vs }), usage: {} }
    switch (stage) {
      case 'analysis': return { data: ANALYSIS, usage: {} }
      case 'draft': return { data: { versions: ['A', 'B', 'C'].map(l => ({ label: `Version ${l}`, opening_approach: 'E', outline: { opening: '', middle: [], ending: '' }, subject: '', preview: '', text: `Welcome to this stunning home — perfect! ${l}` })) }, usage: {} }
      case 'review': return { data: { versions: vs.map(l => ({ label: l, issues: [{ sentence: 'Welcome...', category: 'opening', problem: 'generic', fix: 'lead with kitchen' }], missing_high_value_features: [], unsupported_claims: [], positioning_check: 'ok', summary: 'Rewrite the opening.' })) }, usage: {} }
      case 'rewrite': return { data: { versions: vs.map(l => ({ label: l, subject: '', preview: '', text: GOOD, changes: ['new opening'] })) }, usage: {} }
      case 'verify': return { data: { versions: vs.map(l => ({ label: l, claims: [{ claim: '2022 kitchen', status: 'supported', source: 'agent details' }], corrected_subject: '', corrected_preview: '', corrected_text: GOOD, removed: [] })) }, usage: {} }
      default: return { data: { versions: [] }, usage: {} }
    }
  }
  return { fn, calls }
}

const LISTING = {
  id: 1, property_address: '123 Maple Ave', city: 'Marion', property_type: 'Ranch', bedrooms: 3,
  features: ['fenced yard', 'deck', 'main-floor laundry'], marketing_facts: 'kitchen cabinets and counters replaced 2022',
  seller_name: 'Pat Seller', notes: 'Seller relocating, needs $300K net',
}

test('MLS pipeline: 5 model calls when no repair is needed, 3 versions, review sees checker findings, private notes never sent', async () => {
  const m = scriptedModel()
  const stages = []
  const r = await runPipeline({ listing: LISTING, channel: 'mls', input: {}, deps: { callJson: m.fn, onStage: (s) => stages.push(s) } })
  assert.deepEqual(m.calls.map(c => c.stage), ['analysis', 'draft', 'review', 'rewrite', 'verify'])
  assert.equal(r.final.versions.length, 3)
  assert.equal(r.final.recommended, 'A')
  assert.ok(r.final.versions.every(v => v.lint.clean), JSON.stringify(r.final.versions.map(v => v.lint.findings)))
  // The draft was bad; the reviewer was shown the checker's evidence about it.
  const reviewPrompt = m.calls.find(c => c.stage === 'review').prompt
  assert.match(reviewPrompt, /Welcome to\/home/)
  assert.ok(r.drafts.every(d => !d.lint.clean))
  for (const c of m.calls) assert.doesNotMatch(JSON.stringify(c), /Pat Seller|relocating|300K/)
  assert.ok(stages.includes('polish') && stages.at(-1) === 'done')
})

test('verification removes an unsupported claim', async () => {
  const m = scriptedModel({
    rewrite: ({ vs }) => ({ versions: vs.map(l => ({ label: l, subject: '', preview: '', text: GOOD + ' Sunlight fills every room.', changes: [] })) }),
    verify: ({ vs }) => ({ versions: vs.map(l => ({ label: l, claims: [{ claim: 'Sunlight fills every room', status: 'unsupported', source: '' }], corrected_subject: '', corrected_preview: '', corrected_text: GOOD, removed: ['Sunlight fills every room'] })) }),
  })
  const r = await runPipeline({ listing: LISTING, channel: 'mls', input: {}, deps: { callJson: m.fn } })
  assert.ok(r.final.versions.every(v => !/Sunlight/.test(v.text)))
  assert.deepEqual(r.final.versions[0].removed, ['Sunlight fills every room'])
})

test('polish repairs remaining checker errors, and only keeps a repair that helps', async () => {
  const bad = GOOD + ' Schedule your showing today.'
  const m = scriptedModel({
    rewrite: ({ vs }) => ({ versions: vs.map(l => ({ label: l, subject: '', preview: '', text: bad, changes: [] })) }),
    verify: ({ vs }) => ({ versions: vs.map(l => ({ label: l, claims: [], corrected_subject: '', corrected_preview: '', corrected_text: bad, removed: [] })) }),
    // Fixes A, makes B worse, ignores C.
    polish: () => ({ versions: [{ label: 'A', text: GOOD }, { label: 'B', text: bad + ' Perfect for families.' }] }),
  })
  const r = await runPipeline({ listing: LISTING, channel: 'mls', input: {}, deps: { callJson: m.fn } })
  const byL = Object.fromEntries(r.final.versions.map(v => [v.label, v]))
  assert.equal(byL.A.text, GOOD)
  assert.equal(byL.B.text, bad, 'a worse repair is discarded')
  assert.deepEqual(r.final.repaired, ['A'])
  assert.equal(r.final.recommended, 'A')
})

test('social channel: single version, cached analysis skips stage 1, sign-off guaranteed', async () => {
  const m = scriptedModel({
    draft: () => ({ versions: [{ label: 'A', opening_approach: 'B', outline: { opening: '', middle: [], ending: '' }, subject: '', preview: '', text: 'x' }] }),
    rewrite: ({ vs }) => ({ versions: vs.map(l => ({ label: l, subject: '', preview: '', text: 'A 2022 kitchen and a fenced yard in Marion.\n\n#MarionIowa #CedarRapidsRealEstate', changes: [] })) }),
    verify: ({ vs }) => ({ versions: vs.map(l => ({ label: l, claims: [], corrected_subject: '', corrected_preview: '', corrected_text: '', removed: [] })) }),
  })
  const r = await runPipeline({ listing: LISTING, channel: 'active_social', input: {}, deps: { callJson: m.fn, cachedAnalysis: ANALYSIS } })
  assert.ok(!m.calls.some(c => c.stage === 'analysis'))
  assert.equal(r.final.versions.length, 1)
  assert.match(r.final.versions[0].text, /Matt Smith \| Broker Associate\nMatt Smith Team \| RE\/MAX Concepts\n\n#MarionIowa/)
})

test('pickRecommended prefers A, falls back to a clean version', () => {
  const v = (label, clean, errors = clean ? 0 : 2) => ({ label, lint: { clean, stats: { errors } } })
  assert.equal(pickRecommended([v('A', true), v('B', true)]).label, 'A')
  assert.equal(pickRecommended([v('A', false), v('B', false), v('C', true)]).label, 'C')
  assert.equal(pickRecommended([v('A', false, 3), v('B', false, 1)]).label, 'B')
})

// ---------------------------------------------------------------------------
// Hub plumbing against a throwaway database
// ---------------------------------------------------------------------------
test('runs, apply, version history, library, rules audit trail and feedback', async () => {
  process.env.DB_DIR = mkdtempSync(join(tmpdir(), 'editorial-test-'))
  const { default: db, initDb } = await import('../server/database.js')
  await initDb()
  const service = await import('../server/editorial/service.js')
  const store = await import('../server/editorial/store.js')

  const ins = db.run(`INSERT INTO listings (property_address, city, property_type, bedrooms, features, marketing_facts, notes, seller_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, ['123 Maple Ave', 'Marion', 'Ranch', 3, JSON.stringify(LISTING.features), LISTING.marketing_facts, LISTING.notes, LISTING.seller_name])
  const listingId = Number(ins.lastInsertRowid)

  const m = scriptedModel()
  const { runId, promise } = service.startRun({ listingId, channel: 'mls', input: { tone: 'warm' }, user: 'test@x', callJson: m.fn })
  await promise
  const run = service.getRunForClient(runId)
  assert.equal(run.status, 'done')
  assert.equal(run.final.versions.length, 3)
  assert.equal(run.settings.charLimit, 3400, 'default MLS character limit applied')

  // Second run reuses the analysis for the unchanged fact sheet.
  const m2 = scriptedModel()
  await service.startRun({ listingId, channel: 'active_social', input: {}, callJson: m2.fn }).promise
  assert.ok(!m2.calls.some(c => c.stage === 'analysis'))

  // Apply B with a hand edit: both the AI version and the human edit are on record.
  const edited = GOOD.replace('Outside, a', 'A')
  const applied = service.applyVersion({ runId, label: 'B', text: edited, user: 'test@x' })
  assert.equal(applied.content, edited)
  assert.equal(db.get('SELECT marketing_listing_description AS d FROM listings WHERE id = ?', [listingId]).d, edited)
  const versions = store.listVersions(listingId, 'mls')
  assert.deepEqual(versions.map(v => v.source), ['human', 'ai'])

  // Library entry captures the original draft against the approved text.
  const libId = store.addLibraryEntry({ listing_id: listingId, channel: 'mls', approved_text: edited, original_draft: store.lastAiVersion(listingId, 'mls').content, label: 'excellent', edit_reasons: 'Tighter ending' })
  const picked = store.pickExamples({ channel: 'mls', propertyType: 'ranch', positioning: [] })
  assert.ok(picked.examples.some(e => e.id === libId))
  assert.throws(() => store.updateLibraryEntry(libId, { label: 'brilliant' }))

  // Feedback recurs 3 times -> suggested as a rule -> adopted -> audited -> enforced.
  for (let i = 0; i < 3; i++) store.addFeedback({ listingId, runId, channel: 'mls', text: "Don't say perfect for entertaining." })
  const sug = store.feedbackSummary().find(s => s.feedback_key === 'no_entertaining')
  assert.equal(sug.n, 3)
  assert.equal(sug.suggest_rule, true)
  const ruleId = store.createRule({ rule_text: sug.proposed_rule, kind: sug.proposed_kind, pattern: sug.proposed_pattern, feedback_key: sug.feedback_key, source: 'feedback', user: 'test@x' })
  store.updateRule(ruleId, { active: false }, { user: 'test@x', reason: 'trial' })
  const hist = store.ruleHistoryList().filter(h => h.rule_id === ruleId).map(h => h.action)
  assert.deepEqual(hist, ['disabled', 'created'])
  assert.equal(store.feedbackSummary().find(s => s.feedback_key === 'no_entertaining').suggest_rule, false)
  store.updateRule(ruleId, { active: true }, { user: 'test@x' })
  const rules = store.listRules({ activeOnly: true, channel: 'mls' })
  assert.ok(errs(lintCopy('The patio is perfect for entertaining.', { channel: 'mls', customRules: rules })).includes('team-rule'))
})

// ---------------------------------------------------------------------------
// Eval suite (offline shape check; the live run is server/editorial/eval/run.js)
// ---------------------------------------------------------------------------
test('eval fixtures cover the 10 required property types and score sensibly', async () => {
  const { FIXTURES, scoreAgainstFixture } = await import('../server/editorial/eval/fixtures.js')
  assert.equal(FIXTURES.length, 10)
  assert.equal(new Set(FIXTURES.map(f => f.id)).size, 10)
  for (const f of FIXTURES) {
    assert.ok(f.listing.property_address && f.listing.city && f.expect.must_cover.length, f.id)
    assert.doesNotMatch(buildFactSheet(f.listing).text, /seller/i, f.id)
  }
  const fixer = FIXTURES.find(f => f.id === 'fixer-upper')
  assert.equal(scoreAgainstFixture('This move-in ready charming gem has been fully updated.', fixer).pass, false)
  assert.equal(scoreAgainstFixture('Sold as-is, this 1920 home keeps its original woodwork on a one-third acre lot.', fixer).pass, true)
})

test('typed addresses split into street, city and zip with or without commas', async () => {
  const { splitTyped } = await import('../server/editorial/autofill.js')
  assert.deepEqual(splitTyped('3495 McGowan Blvd, Marion'), { street: '3495 McGowan Blvd', city: 'Marion', zip: '' })
  assert.deepEqual(splitTyped('1418 Fixture Ave NE Cedar Rapids IA 52402'), { street: '1418 Fixture Ave NE', city: 'Cedar Rapids', zip: '52402' })
  assert.deepEqual(splitTyped('2950 Fixture Rd, Center Point, IA 52213'), { street: '2950 Fixture Rd', city: 'Center Point', zip: '52213' })
})
