// One place that talks to Claude for the editorial engine.
//
// callJson({ system, prompt, schema, effort, maxTokens }) -> parsed object
//
// Model: EDITORIAL_MODEL, else claude-opus-5-5. Writing quality is the whole point of this
// feature, so it does not inherit ANTHROPIC_MODEL (which the high-volume follow-up paths
// use). Structured outputs keep every stage's JSON valid; the parse fallback covers a model
// override that does not support them.
import Anthropic from '@anthropic-ai/sdk'

export const EDITORIAL_MODEL = process.env.EDITORIAL_MODEL || 'claude-opus-5-5'

let _client = null
function client() {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) return null
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 5 * 60 * 1000, maxRetries: 2 })
  return _client
}

export function isConfigured() { return !!process.env.ANTHROPIC_API_KEY }
// After the key changes at runtime (the local Editorial Lab sets it from its own config).
export function resetClient() { _client = null }

const supportsEffort = (m) => /opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos/.test(m)
const supportsFallbacks = (m) => /^claude-(opus-5|fable-5|sonnet-5-5)/.test(m)

function parseJson(text) {
  let t = String(text || '').trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const a = t.indexOf('{'); const b = t.lastIndexOf('}')
  if (a === -1 || b === -1) throw new Error('No JSON object in model output')
  return JSON.parse(t.slice(a, b + 1))
}

export async function callJson({ system, prompt, schema, effort = 'medium', maxTokens = 16000, model = EDITORIAL_MODEL }) {
  const c = client()
  if (!c) throw new Error('ANTHROPIC_API_KEY not configured')
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
  }
  const output_config = {}
  if (supportsEffort(model)) output_config.effort = effort
  if (schema) output_config.format = { type: 'json_schema', schema }
  if (Object.keys(output_config).length) body.output_config = output_config
  const headers = {}
  if (supportsFallbacks(model)) {
    // Refusal fallback: on the rare safety-classifier decline the API re-runs the request on
    // a fallback model in the same call instead of returning nothing.
    body.fallbacks = 'default'
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01'
  }
  const msg = await c.messages.create(body, { headers })
  if (msg.stop_reason === 'refusal') throw new Error('The model declined this request')
  if (msg.stop_reason === 'max_tokens') throw new Error('Model output was cut off (max_tokens)')
  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  return { data: parseJson(text), usage: msg.usage, model: msg.model }
}
