// HUB AI audit log — answers "why did the AI do this?". Never stores secrets.
import db from '../database.js'
const nowIso = () => new Date().toISOString()

export function logAiAction(fields = {}) {
  try {
    const r = db.run(`INSERT INTO ai_actions
      (client_id, event_id, action_type, ai_state_before, ai_state_after, model_name, prompt_version, reason, context_summary, tool_calls_json, output_text, intent_before, intent_after, tokens_input, tokens_output, latency_ms, status, error, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [fields.client_id || null, fields.event_id || null, fields.action_type || null, fields.ai_state_before || null, fields.ai_state_after || null,
        fields.model_name || null, fields.prompt_version || null, fields.reason || null, (fields.context_summary || '').slice(0, 4000),
        fields.tool_calls_json ? JSON.stringify(fields.tool_calls_json).slice(0, 4000) : null, (fields.output_text || '').slice(0, 4000),
        fields.intent_before ?? null, fields.intent_after ?? null, fields.tokens_input ?? null, fields.tokens_output ?? null,
        fields.latency_ms ?? null, fields.status || 'success', fields.error || null, nowIso()])
    return r.lastInsertRowid
  } catch (e) { console.error('[ai-audit]', e.message); return null }
}

export function recentAiActions(clientId, limit = 50) {
  return db.all('SELECT * FROM ai_actions WHERE client_id=? ORDER BY id DESC LIMIT ?', [Number(clientId), limit])
}
