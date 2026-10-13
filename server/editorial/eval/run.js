// Live writing evaluation. Operator-triggered; it calls the API (about 6 calls per
// fixture), so it is not part of `npm test`.
//
//   node server/editorial/eval/run.js                 all 10 fixtures, MLS channel
//   node server/editorial/eval/run.js fixer-upper     one fixture
//   EDITORIAL_EVAL_LEGACY_MODEL=claude-sonnet-4-6 ... raw draft on the model the old
//                                                     generator used (default: same model)
//
// For each fixture it compares:
//   1. Raw AI draft      the original one-shot Hub prompt (what we had before)
//   2. Revised draft     the engine's post-review rewrite, before fact verification
//   3. Verified final    the recommended version after verification and polish
// and scores each with the deterministic checker plus the fixture's own expectations
// (tone/positioning mismatch, missed selling points). Writes a Markdown + JSON report to
// server/editorial/eval/reports/.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FIXTURES, scoreAgainstFixture } from './fixtures.js'
import { runPipeline } from '../engine.js'
import { buildFactSheet } from '../facts.js'
import { lintCopy } from '../lint.js'
import { legacyMlsPrompt, LEGACY_VOICE } from '../prompts.js'
import { callJson, isConfigured, EDITORIAL_MODEL } from '../model.js'
import Anthropic from '@anthropic-ai/sdk'

const here = dirname(fileURLToPath(import.meta.url))
const LEGACY_MODEL = process.env.EDITORIAL_EVAL_LEGACY_MODEL || EDITORIAL_MODEL

async function rawDraft(listing) {
  const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const facts = buildFactSheet(listing).text
  const msg = await c.messages.create({ model: LEGACY_MODEL, max_tokens: 4000, system: LEGACY_VOICE, messages: [{ role: 'user', content: legacyMlsPrompt(facts) }] })
  return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim()
}

function assess(text, fixture, facts) {
  const lint = lintCopy(text, { channel: 'mls', facts, charLimit: 1000 })
  const fit = scoreAgainstFixture(text, fixture)
  return {
    text,
    errors: lint.stats.errors,
    warnings: lint.stats.warnings,
    characters: lint.stats.characters,
    findings: lint.findings.map(f => `[${f.severity}] ${f.message}${f.excerpt ? ` ("${f.excerpt.slice(0, 90)}")` : ''}`),
    fixture_pass: fit.pass,
    fixture_problems: fit.problems,
    coverage: fit.coverage,
  }
}

async function evalOne(fx) {
  const listing = { id: 0, ...fx.listing }
  const facts = buildFactSheet(listing).text
  const t0 = Date.now()
  const raw = await rawDraft(listing)
  const result = await runPipeline({ listing, channel: 'mls', input: {}, deps: { callJson } })
  const rec = result.final.versions.find(v => v.label === result.final.recommended)
  const revised = result.rewrite.find(v => v.label === result.final.recommended)
  return {
    id: fx.id, title: fx.title, seconds: Math.round((Date.now() - t0) / 1000),
    positioning: (result.analysis.positioning || []).map(p => p.category),
    top_selling_points: result.analysis.top_selling_points,
    questions_for_agent: result.analysis.questions_for_agent,
    raw: assess(raw, fx, facts),
    revised: assess(revised.text, fx, facts),
    final: { ...assess(rec.output, fx, facts), label: rec.label, removed_by_verification: rec.removed, reviewer_summary: result.review.find(r => r.label === rec.label)?.summary },
    alternatives: result.final.versions.filter(v => v.label !== rec.label).map(v => ({ label: v.label, text: v.output, errors: v.lint.stats.errors })),
    reference: fx.reference || null,
  }
}

function markdown(rows) {
  const sum = (k, f) => rows.reduce((a, r) => a + f(r[k]), 0)
  const lines = [
    `# Editorial engine eval, ${new Date().toISOString().slice(0, 10)}`,
    '',
    `Model: ${EDITORIAL_MODEL}. Raw draft model: ${LEGACY_MODEL}. ${rows.length} fixtures, MLS channel, 1,000-character limit.`,
    '',
    '| | Raw draft (old prompt) | Revised draft | Verified final |',
    '|---|---|---|---|',
    `| Checker errors (total) | ${sum('raw', x => x.errors)} | ${sum('revised', x => x.errors)} | ${sum('final', x => x.errors)} |`,
    `| Checker warnings (total) | ${sum('raw', x => x.warnings)} | ${sum('revised', x => x.warnings)} | ${sum('final', x => x.warnings)} |`,
    `| Fixture expectations met | ${sum('raw', x => x.fixture_pass ? 1 : 0)}/${rows.length} | ${sum('revised', x => x.fixture_pass ? 1 : 0)}/${rows.length} | ${sum('final', x => x.fixture_pass ? 1 : 0)}/${rows.length} |`,
    `| Average characters | ${Math.round(sum('raw', x => x.characters) / rows.length)} | ${Math.round(sum('revised', x => x.characters) / rows.length)} | ${Math.round(sum('final', x => x.characters) / rows.length)} |`,
    '',
    'A description is not successful because it is grammatical or fits the limit. Read the finals below against the facts.',
    '',
  ]
  for (const r of rows) {
    lines.push(`## ${r.title} (\`${r.id}\`)`, '', `Positioning: ${r.positioning.join('; ')}`, `Built around: ${(r.top_selling_points || []).join('; ')}`)
    if (r.questions_for_agent?.length) lines.push(`Questions the engine would ask the agent: ${r.questions_for_agent.join(' ')}`)
    for (const [k, title] of [['raw', '1. Raw AI draft (old prompt)'], ['revised', '2. Editorially revised draft'], ['final', `3. Verified final (Version ${r.final.label})`]]) {
      const x = r[k]
      lines.push('', `### ${title}`, '', `> ${x.text.replace(/\n+/g, ' ')}`, '',
        `${x.characters} chars, ${x.errors} errors, ${x.warnings} warnings, selling points ${x.coverage}${x.fixture_pass ? '' : `. **Fixture problems:** ${x.fixture_problems.join('; ')}`}`)
      if (x.findings.length) lines.push('', ...x.findings.map(f => `- ${f}`))
    }
    if (r.final.removed_by_verification?.length) lines.push('', `Removed by fact verification: ${r.final.removed_by_verification.join('; ')}`)
    if (r.reference) lines.push('', '### Team reference', '', `> ${r.reference}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function main() {
  if (!isConfigured()) { console.error('ANTHROPIC_API_KEY is not set. Run this where the key is available (e.g. the Render shell).'); process.exit(1) }
  const only = process.argv[2]
  const list = only ? FIXTURES.filter(f => f.id === only) : FIXTURES
  if (!list.length) { console.error(`No fixture "${only}". Options: ${FIXTURES.map(f => f.id).join(', ')}`); process.exit(1) }
  const rows = []
  for (const fx of list) {
    process.stdout.write(`${fx.id} ... `)
    try { const r = await evalOne(fx); rows.push(r); console.log(`raw ${r.raw.errors}e/${r.raw.warnings}w -> final ${r.final.errors}e/${r.final.warnings}w (${r.seconds}s)`) } catch (e) { console.log(`FAILED: ${e.message}`) }
  }
  if (!rows.length) process.exit(1)
  const dir = join(here, 'reports'); mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  writeFileSync(join(dir, `eval-${stamp}.json`), JSON.stringify(rows, null, 2))
  writeFileSync(join(dir, `eval-${stamp}.md`), markdown(rows))
  console.log(`\nReport: ${join(dir, `eval-${stamp}.md`)}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
