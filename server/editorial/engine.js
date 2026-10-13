// The editorial pipeline. Never accepts a first draft.
//
//   1 analysis      property understanding, feature ranking, positioning   (model)
//   2+3 draft       outline then draft, 1 or 3 genuinely different versions (model)
//   4 review        separate editor pass + deterministic checker findings  (model + lint)
//   5 rewrite       real editorial changes, not synonym swaps               (model)
//   6 verify        every claim checked against the fact sheet             (model)
//   7 polish        mechanical scrub, checker again, targeted repair if needed
//
// Pure orchestration: the model call, progress callback and library/rules lookups are all
// injected, so the whole thing runs offline in tests with a scripted model.
import { CHANNELS, SIGNOFF, TONES, LENGTHS } from './rules.js'
import { buildFactSheet, controlsForPrompt, parseList } from './facts.js'
import { lintCopy, scrubMechanics, findingsForPrompt } from './lint.js'
import {
  CHARTER, teamContextBlock, analysisPrompt, ANALYSIS_SCHEMA, draftPrompt, DRAFT_SCHEMA,
  REVIEWER_SYSTEM, reviewPrompt, REVIEW_SCHEMA, rewritePrompt, REWRITE_SCHEMA,
  VERIFIER_SYSTEM, verifyPrompt, VERIFY_SCHEMA, repairPrompt, REPAIR_SCHEMA,
  selectionPrompt, SELECTION_SCHEMA,
} from './prompts.js'

export const STAGES = [
  { key: 'analysis', label: 'Property analysis' },
  { key: 'draft', label: 'Outline and first draft' },
  { key: 'review', label: 'Critical review' },
  { key: 'rewrite', label: 'Rewrite' },
  { key: 'verify', label: 'Fact verification' },
  { key: 'polish', label: 'Final polish' },
]

// CRAAR accepts at least 3,427 (the longest of the team's 70 past remarks); 3,400 is proven safe.
export const DEFAULT_MLS_CHAR_LIMIT = 3400

export function normalizeSettings(input = {}, channel = 'mls') {
  if (!CHANNELS[channel]) throw new Error(`Unknown channel: ${channel}`)
  const c = CHANNELS[channel]
  const versions = channel === 'mls' || input.alternatives ? ['A', 'B', 'C'] : c.versions
  return {
    channel,
    tone: TONES[input.tone] ? input.tone : 'natural',
    length: LENGTHS[input.length] ? input.length : 'standard',
    angle: input.angle || 'auto',
    opening: input.opening || 'auto',
    charLimit: channel === 'mls' ? (Number(input.charLimit) > 0 ? Number(input.charLimit) : DEFAULT_MLS_CHAR_LIMIT) : null,
    emphasize: parseList(input.emphasize),
    exclude: parseList(input.exclude),
    instructions: String(input.instructions || '').slice(0, 1000),
    versions,
  }
}

const systemBlocks = (teamContext) => {
  const blocks = [{ type: 'text', text: CHARTER, cache_control: { type: 'ephemeral' } }]
  if (teamContext) blocks.push({ type: 'text', text: teamContext })
  return blocks
}

// Map whatever labels the model returned back onto the requested ones, by label or position.
function alignVersions(requested, got) {
  const list = Array.isArray(got) ? got : []
  return requested.map((label, i) => {
    const hit = list.find(v => String(v.label || '').replace(/^version\s*/i, '').trim().toUpperCase() === label) || list[i] || {}
    return { ...hit, label }
  })
}

function hasSignoff(t) { return /Matt Smith \| Broker Associate\s*\n\s*Matt Smith Team \| RE\/MAX Concepts/.test(t) }

// Social channels: guarantee the exact sign-off sits before the hashtags.
export function ensureSignoff(text) {
  if (hasSignoff(text)) return text
  let t = String(text || '').replace(/^\s*Matt Smith \| Broker Associate.*$/gim, '').replace(/^\s*Matt Smith Team \| RE\/MAX.*$/gim, '').trimEnd()
  const tagStart = t.search(/(^|\n)\s*#\w/)
  if (tagStart === -1) return `${t}\n\n${SIGNOFF}`
  return `${t.slice(0, tagStart).trimEnd()}\n\n${SIGNOFF}\n\n${t.slice(tagStart).trim()}`
}

export function composeOutput(channel, v) {
  const c = CHANNELS[channel]
  if (c.json) return `Subject: ${v.subject || ''}\nPreview: ${v.preview || ''}\n\n${v.text || ''}`.trim()
  return v.text || ''
}

function lintOpts(settings, facts, customRules, record) {
  return { channel: settings.channel, facts: facts.text, charLimit: settings.charLimit, customRules, address: record?.street_address }
}

function finalizeText(channel, text) {
  let t = scrubMechanics(text)
  if (CHANNELS[channel].signoff) t = ensureSignoff(t)
  if (channel === 'mls') t = t.replace(/\s*\n+\s*/g, ' ').trim()
  return t
}

/**
 * @param {object} p
 * @param {object} p.listing       listings row (features parsed)
 * @param {string} p.channel
 * @param {object} p.input         raw controls from the UI
 * @param {object} p.deps          { callJson, onStage?, customRules?, pickExamples?, marketContext?, cachedAnalysis? }
 */
export async function runPipeline({ listing, channel = 'mls', input = {}, deps }) {
  const settings = normalizeSettings(input, channel)
  const { callJson } = deps
  const onStage = deps.onStage || (() => {})
  const customRules = deps.customRules || []
  const facts = buildFactSheet(listing, settings)
  const controls = controlsForPrompt(settings)
  const usage = []
  const track = (stage, r) => { usage.push({ stage, ...(r.usage || {}) }); return r.data }

  // 1. Analysis (reused when the fact sheet has not changed)
  onStage('analysis', {})
  let analysis = deps.cachedAnalysis || null
  if (!analysis) {
    const preTeam = teamContextBlock({ rules: customRules.filter(r => r.kind === 'guidance'), marketContext: deps.marketContext })
    analysis = track('analysis', await callJson({ system: systemBlocks(preTeam), prompt: analysisPrompt({ facts: facts.text, controls }), schema: ANALYSIS_SCHEMA, effort: 'medium' }))
  }
  onStage('analysis', { analysis })

  const lib = deps.pickExamples
    ? deps.pickExamples({ channel, propertyType: analysis.property_category || listing.property_type, positioning: (analysis.positioning || []).map(p => p.category) })
    : { examples: [], avoidExamples: [] }
  const team = teamContextBlock({ rules: customRules.filter(r => r.kind === 'guidance' || r.kind === 'avoid_phrase'), examples: lib.examples, avoidExamples: lib.avoidExamples, marketContext: deps.marketContext })
  const sys = systemBlocks(team)
  const lopts = lintOpts(settings, facts, customRules, facts.record)

  // 2+3. Outline + draft
  onStage('draft', {})
  const draftOut = track('draft', await callJson({ system: sys, prompt: draftPrompt({ facts: facts.text, analysis, settings, versions: settings.versions }), schema: DRAFT_SCHEMA, effort: 'medium' }))
  const drafts = alignVersions(settings.versions, draftOut.versions).map(d => ({ ...d, text: String(d.text || '').trim() }))
  const draftLint = Object.fromEntries(drafts.map(d => [d.label, lintCopy(finalizeText(channel, d.text), lopts)]))
  onStage('draft', { drafts })

  // 4. Critical review: a separate editor, given the checker's evidence
  onStage('review', {})
  const reviewSys = [{ type: 'text', text: REVIEWER_SYSTEM + '\n\nTHE TEAM STANDARD YOU ENFORCE:\n\n' + CHARTER, cache_control: { type: 'ephemeral' } }]
  if (team) reviewSys.push({ type: 'text', text: team })
  const reviewOut = track('review', await callJson({
    system: reviewSys,
    prompt: reviewPrompt({ facts: facts.text, analysis, settings, drafts, lintByLabel: Object.fromEntries(drafts.map(d => [d.label, findingsForPrompt(draftLint[d.label].findings)])) }),
    schema: REVIEW_SCHEMA, effort: 'medium',
  }))
  const review = alignVersions(settings.versions, reviewOut.versions)
  onStage('review', { review })

  // 5. Rewrite
  onStage('rewrite', {})
  const rewriteOut = track('rewrite', await callJson({ system: sys, prompt: rewritePrompt({ facts: facts.text, settings, drafts, review }), schema: REWRITE_SCHEMA, effort: 'medium' }))
  const rewritten = alignVersions(settings.versions, rewriteOut.versions).map((v, i) => ({ ...v, text: String(v.text || drafts[i].text).trim() }))
  onStage('rewrite', { rewrite: rewritten })

  // 6. Fact verification
  onStage('verify', {})
  const verifyOut = track('verify', await callJson({ system: [{ type: 'text', text: VERIFIER_SYSTEM }], prompt: verifyPrompt({ facts: facts.text, versions: rewritten }), schema: VERIFY_SCHEMA, effort: 'low' }))
  const verification = alignVersions(settings.versions, verifyOut.versions)
  let current = rewritten.map((v, i) => {
    const vf = verification[i] || {}
    const unsupported = (vf.claims || []).filter(c => c.status === 'unsupported')
    const useCorrected = unsupported.length && vf.corrected_text
    return {
      label: v.label,
      subject: (unsupported.length && vf.corrected_subject) || v.subject || '',
      preview: (unsupported.length && vf.corrected_preview) || v.preview || '',
      text: finalizeText(channel, useCorrected ? vf.corrected_text : v.text),
      changes: v.changes || [],
      claims: vf.claims || [],
      removed: vf.removed || [],
    }
  })
  onStage('verify', { verification })

  // 7. Polish: checker again; one targeted repair for anything still at error level
  onStage('polish', {})
  let lints = current.map(v => lintCopy(v.text, lopts))
  const needRepair = current.map((v, i) => ({ v, l: lints[i] })).filter(x => !x.l.clean)
  let repaired = []
  if (needRepair.length) {
    const out = track('polish', await callJson({
      system: sys,
      prompt: repairPrompt({ facts: facts.text, settings, items: needRepair.map(x => ({ label: x.v.label, text: x.v.text, problems: findingsForPrompt(x.l.findings.filter(f => f.severity === 'error')) })) }),
      schema: REPAIR_SCHEMA, effort: 'medium',
    }))
    for (const r of out.versions || []) {
      const idx = current.findIndex(v => v.label === String(r.label || '').replace(/^version\s*/i, '').trim().toUpperCase())
      if (idx === -1 || !r.text) continue
      const fixed = finalizeText(channel, r.text)
      const fixedLint = lintCopy(fixed, lopts)
      // Keep the repair only if it actually reduced errors.
      if (fixedLint.stats.errors < lints[idx].stats.errors) {
        current[idx] = { ...current[idx], text: fixed }
        lints[idx] = fixedLint
        repaired.push(current[idx].label)
      }
    }
  }

  const versions = current.map((v, i) => ({ ...v, output: composeOutput(channel, v), lint: lints[i] }))
  const recommended = pickRecommended(versions)
  const result = {
    settings,
    facts: { text: facts.text, hash: facts.hash },
    analysis,
    drafts: drafts.map(d => ({ ...d, lint: draftLint[d.label] })),
    review,
    rewrite: rewritten,
    verification,
    final: { versions, recommended: recommended.label, recommended_reason: recommended.reason, repaired },
    examples_used: (lib.examples || []).map(e => e.id),
    usage,
  }
  onStage('done', { final: result.final })
  return result
}

// Version A is the default. Move off it only when it still has errors another version does not.
export function pickRecommended(versions) {
  const a = versions.find(v => v.label === 'A') || versions[0]
  if (a.lint.clean) return { label: a.label, reason: versions.length > 1 ? 'Balanced Professional is the default and passed every check.' : 'Passed every check.' }
  const clean = versions.find(v => v.lint.clean)
  if (clean) return { label: clean.label, reason: `Version ${a.label} still has checker errors; ${clean.label} passed every check.` }
  const best = [...versions].sort((x, y) => x.lint.stats.errors - y.lint.stats.errors)[0]
  return { label: best.label, reason: 'No version passed every check. Review the flagged items before using.' }
}

// Rewrite one selected passage; returns alternatives, each linted in place.
export async function rewriteSelection({ listing, channel = 'mls', input = {}, fullText, selection, instruction, deps }) {
  if (!selection || !fullText || !fullText.includes(selection)) throw new Error('Selection must be part of the current text')
  const settings = normalizeSettings(input, channel)
  const facts = buildFactSheet(listing, settings)
  const customRules = deps.customRules || []
  const sys = systemBlocks(teamContextBlock({ rules: customRules }))
  const { data } = await deps.callJson({ system: sys, prompt: selectionPrompt({ facts: facts.text, settings, fullText, selection, instruction }), schema: SELECTION_SCHEMA, effort: 'medium' })
  const lopts = lintOpts(settings, facts, customRules, facts.record)
  return (data.alternatives || []).slice(0, 3).map(a => {
    const replacement = scrubMechanics(a.text)
    const full = finalizeText(channel, fullText.replace(selection, replacement))
    return { text: replacement, why: a.why, full_text: full, lint: lintCopy(full, lopts) }
  })
}
