// P1-1: AI regression runner. Executes the scenario suite against the live model using
// the SAME prompt builders the production orchestrator uses, scores each turn, and
// persists a run + per-scenario results for prompt/model-version diffing.
//
// This requires an API key and is operator-triggered (never part of `npm test`, which
// runs offline). The pure scorer in score.js is what the unit tests cover.
import db from '../database.js'
import { getAiClient, AI_MODEL } from '../routes/followup.js'
import { buildSystemPrompt, buildUserMessage, AI_PROMPT_VERSION } from '../ai-followup/prompts.js'
import { ALL_SCENARIOS, BUYER, SELLER } from './scenarios.js'
import { scoreScenario, summarize } from './score.js'

const nowIso = () => new Date().toISOString()

function parseJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim()
  const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}

async function runOne(ai, model, scenario) {
  try {
    const msg = await ai.messages.create({
      model, max_tokens: 900,
      system: buildSystemPrompt(scenario.ctx),
      messages: [{ role: 'user', content: buildUserMessage(scenario.ctx) }],
    })
    const decision = parseJson(msg.content?.[0]?.text || '')
    return scoreScenario(decision, scenario)
  } catch (e) {
    // A model/parse error is a hard fail for that scenario, not a crash.
    return { score: 0, autofail: 'runner error: ' + e.message, action: 'ERROR', message: '', checks: [{ name: 'run', pass: false, detail: e.message }] }
  }
}

// Run the suite. opts.segment: 'buyer'|'seller'|undefined(all). opts.limit caps count.
export async function runEval(opts = {}) {
  const ai = getAiClient()
  if (!ai) return { ok: false, error: 'AI not configured (ANTHROPIC_API_KEY)' }
  const model = opts.model || AI_MODEL
  let set = opts.segment === 'buyer' ? BUYER : opts.segment === 'seller' ? SELLER : ALL_SCENARIOS
  if (opts.limit) set = set.slice(0, Number(opts.limit))

  const runId = db.run('INSERT INTO ai_eval_runs (model, prompt_version, total, status) VALUES (?,?,?,?)',
    [model, AI_PROMPT_VERSION, set.length, 'running']).lastInsertRowid

  const results = []
  // Small concurrency to keep it quick without hammering rate limits.
  const CONCURRENCY = 4
  for (let i = 0; i < set.length; i += CONCURRENCY) {
    const batch = set.slice(i, i + CONCURRENCY)
    const scored = await Promise.all(batch.map(sc => runOne(ai, model, sc).then(r => ({ sc, r }))))
    for (const { sc, r } of scored) {
      results.push(r)
      db.run('INSERT INTO ai_eval_results (run_id, scenario_id, segment, title, score, autofail, action, message, checks_json) VALUES (?,?,?,?,?,?,?,?,?)',
        [runId, sc.id, sc.segment, sc.title, r.score, r.autofail || null, r.action, r.message, JSON.stringify(r.checks || [])])
    }
  }

  const sum = summarize(results)
  db.run('UPDATE ai_eval_runs SET total=?, passed=?, failed=?, autofails=?, avg_score=?, pass_rate=?, status=? WHERE id=?',
    [sum.total, sum.passed, sum.failed, sum.autofails, sum.avg_score, sum.pass_rate, 'complete', runId])

  return { ok: true, run_id: runId, model, prompt_version: AI_PROMPT_VERSION, ...sum }
}

export function listRuns(limit = 30) {
  return db.all('SELECT * FROM ai_eval_runs ORDER BY id DESC LIMIT ?', [Number(limit)])
}
export function getRun(id) {
  const run = db.get('SELECT * FROM ai_eval_runs WHERE id=?', [Number(id)])
  if (!run) return null
  const results = db.all('SELECT scenario_id, segment, title, score, autofail, action, message, checks_json FROM ai_eval_results WHERE run_id=? ORDER BY score ASC, segment', [Number(id)])
  return { ...run, results: results.map(r => ({ ...r, checks: safeParse(r.checks_json) })) }
}
function safeParse(s) { try { return JSON.parse(s || '[]') } catch { return [] } }
