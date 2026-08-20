// HUB AI orchestrator — responsive inbound flow. HUB controls workflow + compliance;
// the model controls language + interpretation only. Fail-safe: any error never
// breaks the inbox and never sends a malformed or stale message.
import db from '../database.js'
import { getAiClient, AI_MODEL } from '../routes/followup.js'
import { canSendSms } from './policy.js'
import { flag, getConfig, inQuietHours } from './flags.js'
import { ensureState, transitionAiState, markInbound, markOutbound } from './state.js'
import { buildLeadAiContext } from './context.js'
import { computeIntent, saveIntent, getIntent, levelFor } from './intent.js'
import { applyMemory } from './memory.js'
import { createAiHandoff } from './handoff.js'
import { logAiAction } from './audit.js'
import { buildSystemPrompt, buildUserMessage, AI_PROMPT_VERSION, ALLOWED_ACTIONS } from './prompts.js'

const nowIso = () => new Date().toISOString()

function parseJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim()
  const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}
const noDash = (s) => String(s == null ? '' : s).replace(/[—–]/g, ', ')

// Latest message id for the client — used for the race-condition guard.
const latestMsgId = (cid) => db.get('SELECT MAX(id) m FROM communications WHERE client_id=?', [cid])?.m || 0

// Did a HUMAN (not AI) already reply after the most recent inbound? If so, suppress.
function humanAlreadyHandled(cid) {
  const lastIn = db.get("SELECT id, occurred_at FROM communications WHERE client_id=? AND direction='incoming' ORDER BY occurred_at DESC LIMIT 1", [cid])
  if (!lastIn) return false
  const laterHuman = db.get(`SELECT id FROM communications WHERE client_id=? AND direction='outgoing'
    AND occurred_at > ? AND (sent_by_type IS NULL OR sent_by_type NOT IN ('ai','automation','system')) LIMIT 1`, [cid, lastIn.occurred_at])
  return !!laterHuman
}

// Main entry: an eligible inbound text arrived. Returns a small result object.
export async function handleInboundText(clientId, inboundBody) {
  const cid = Number(clientId)
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return { ok: false, reason: 'no client' }
  ensureState(cid)
  markInbound(cid)

  // ---- gates (HUB-controlled, never the model) ----
  if (!flag('ai_followup_enabled') || !flag('ai_responsive_text_enabled')) return logNo(cid, 'responsive AI disabled')
  const gate = canSendSms(client, { channel: 'ai', mode: 'responsive' })
  if (!gate.ok) return logNo(cid, 'blocked: ' + gate.reason)
  if (humanAlreadyHandled(cid)) return logNo(cid, 'a human already replied')
  const st = db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [cid])
  if (st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED'].includes(st.ai_state)) return logNo(cid, 'human owns the conversation')

  const ai = getAiClient()
  if (!ai) return logNo(cid, 'AI not configured (ANTHROPIC_API_KEY)')

  const ctx = buildLeadAiContext(cid)
  const intentBefore = getIntent(cid).score
  const startedAtMsgId = latestMsgId(cid)
  const t0 = Date.now()
  let decision, usage = {}
  try {
    const msg = await ai.messages.create({
      model: AI_MODEL, max_tokens: 900,
      system: buildSystemPrompt(ctx),
      messages: [{ role: 'user', content: buildUserMessage(ctx) }],
    })
    usage = msg.usage || {}
    decision = parseJson(msg.content?.[0]?.text || '')
  } catch (e) {
    logAiAction({ client_id: cid, action_type: 'RESPONSE', model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: 'model error', status: 'failed', error: e.message, latency_ms: Date.now() - t0 })
    return { ok: false, reason: 'model error: ' + e.message }
  }

  // ---- validate the model output server-side ----
  const action = ALLOWED_ACTIONS.includes(decision?.action) ? decision.action : 'NO_ACTION'
  const message = noDash(String(decision?.message || '').trim()).slice(0, 640)
  const handoffReq = !!(decision?.handoff?.required)
  const cfg = getConfig()

  // ---- memory + intent (always safe to update) ----
  try { if (decision?.memory || decision?.summary) applyMemory(cid, decision.memory || {}, decision.summary) } catch {}
  let intent = computeIntent(cid)
  const delta = Math.max(-20, Math.min(40, Number(decision?.intent_delta) || 0))
  intent.score = Math.max(0, Math.min(100, intent.score + delta))
  intent.level = levelFor(intent.score)
  if (Array.isArray(decision?.intent_signals)) intent.reasons = [...new Set([...intent.reasons, ...decision.intent_signals.map(String)])].slice(0, 8)
  saveIntent(cid, intent, 'ai')

  // ---- handoff (high intent or explicit) ----
  const threshold = Number(cfg.ai_intent_handoff_threshold) || 70
  let handoffId = null
  if ((handoffReq || intent.score >= threshold) && flag('ai_auto_handoff_enabled')) {
    handoffId = createAiHandoff(cid, { reason: decision?.handoff?.reason || 'High intent', urgency: intent.score >= 85 ? 'urgent' : 'high', summary: ctx.intelligence?.ai_summary || decision?.summary || '', intent_score: intent.score })
  }

  // ---- send (with race guard) ----
  let sent = false
  const shouldSend = action === 'SEND_TEXT' && message
  if (shouldSend) {
    if (inQuietHours()) return logNo(cid, 'quiet hours', { intentBefore, intentAfter: intent.score })
    if (latestMsgId(cid) !== startedAtMsgId) return logNo(cid, 'aborted stale send (new message arrived)', { intentBefore, intentAfter: intent.score })
    // re-check eligibility right before sending
    const fresh = db.get('SELECT * FROM clients WHERE id=?', [cid])
    const g2 = canSendSms(fresh, { channel: 'ai', mode: 'responsive' })
    if (!g2.ok) return logNo(cid, 'blocked at send: ' + g2.reason)
    try {
      const actionId = logAiAction({ client_id: cid, action_type: 'SEND_TEXT', model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: 'responsive reply', context_summary: ctx.intelligence?.ai_summary || '', output_text: message, intent_before: intentBefore, intent_after: intent.score, tokens_input: usage.input_tokens, tokens_output: usage.output_tokens, latency_ms: Date.now() - t0, status: 'success' })
      await sendAiSms(fresh, message, actionId)
      sent = true
      markOutbound(cid)
      transitionAiState(cid, handoffId ? 'HUMAN_HANDOFF_REQUIRED' : (decision?.next_state && ['AI_CONVERSATION_ACTIVE', 'AI_ENGAGED', 'AI_HIGH_INTENT', 'NOT_INTERESTED'].includes(decision.next_state) ? decision.next_state : 'AI_CONVERSATION_ACTIVE'), 'responsive reply sent')
    } catch (e) {
      logAiAction({ client_id: cid, action_type: 'SEND_TEXT', status: 'failed', error: e.message, client_id: cid })
      return { ok: false, reason: 'send failed: ' + e.message }
    }
  } else {
    logAiAction({ client_id: cid, action_type: action, model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: 'no send', context_summary: decision?.summary || '', intent_before: intentBefore, intent_after: intent.score, tokens_input: usage.input_tokens, tokens_output: usage.output_tokens, latency_ms: Date.now() - t0, status: 'success' })
  }

  return { ok: true, sent, action, handoff: handoffId, intent: intent.score }
}

// Send an AI SMS through the existing Twilio path and log it as an AI communication.
async function sendAiSms(client, text, aiActionId) {
  const { sendSms } = await import('../twilio.js')
  const { fillTemplate } = await import('../routes/email.js')
  const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  const out = fillTemplate(text, client).replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim() || text
  const r = await sendSms(client.phone, out, { statusCallback: hub + '/api/inbox/twilio-status' })
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, delivery_status, agent, sent_by_type, ai_action_id, occurred_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['text', 'outgoing', client.id, name, '', client.phone, out.replace(/\s+/g, ' ').slice(0, 160), out, 'twilio_' + r.sid, `c${client.id}_text`, 'read', r.status || 'queued', 'HUB AI', 'ai', aiActionId || null, nowIso()])
  return r
}

// Proactive first-touch (new-lead opener). Used by the "Send AI Now" control and,
// later, the proactive scheduler. force=true (manual) bypasses the global proactive
// flag but still honors all compliance gates.
export async function handleProactive(clientId, { force = false } = {}) {
  const cid = Number(clientId)
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return { ok: false, reason: 'no client' }
  ensureState(cid)
  if (!force && (!flag('ai_followup_enabled') || !flag('ai_proactive_text_enabled'))) return logNo(cid, 'proactive AI disabled')
  const gate = canSendSms(client, { channel: 'ai', mode: force ? 'responsive' : 'proactive' })
  if (!gate.ok) return logNo(cid, 'blocked: ' + gate.reason)
  if (inQuietHours() && !force) return logNo(cid, 'quiet hours')
  const ai = getAiClient(); if (!ai) return logNo(cid, 'AI not configured')
  const ctx = buildLeadAiContext(cid)
  const startedAtMsgId = latestMsgId(cid)
  const t0 = Date.now()
  const userMsg = `This is a lead the team has NOT texted yet (or is re-engaging). Lead source: ${ctx.facts.lead_source || 'unknown'}. Write a short, natural opening SMS to start a conversation — give a real, contextual reason for reaching out based on the context. Do not force an appointment. Return the JSON now.`
  let decision, usage = {}
  try {
    const msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 700, system: buildSystemPrompt(ctx), messages: [{ role: 'user', content: `CONTEXT (JSON, trusted):\n${JSON.stringify(ctx.facts)}\n\n${userMsg}` }] })
    usage = msg.usage || {}; decision = parseJson(msg.content?.[0]?.text || '')
  } catch (e) { logAiAction({ client_id: cid, action_type: 'PROACTIVE', status: 'failed', error: e.message, model_name: AI_MODEL }); return { ok: false, reason: e.message } }
  const message = noDash(String(decision?.message || '').trim()).slice(0, 640)
  if (!message || (ALLOWED_ACTIONS.includes(decision?.action) && decision.action !== 'SEND_TEXT')) return logNo(cid, 'AI chose not to open')
  if (latestMsgId(cid) !== startedAtMsgId) return logNo(cid, 'aborted stale (new message arrived)')
  const g2 = canSendSms(db.get('SELECT * FROM clients WHERE id=?', [cid]), { channel: 'ai', mode: force ? 'responsive' : 'proactive' })
  if (!g2.ok) return logNo(cid, 'blocked at send: ' + g2.reason)
  try {
    const actionId = logAiAction({ client_id: cid, action_type: 'PROACTIVE', model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: force ? 'manual send now' : 'proactive first touch', output_text: message, tokens_input: usage.input_tokens, tokens_output: usage.output_tokens, latency_ms: Date.now() - t0, status: 'success' })
    await sendAiSms(db.get('SELECT * FROM clients WHERE id=?', [cid]), message, actionId)
    markOutbound(cid)
    transitionAiState(cid, 'AI_WAITING_FOR_REPLY', force ? 'manual AI send' : 'proactive first touch')
    return { ok: true, sent: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

function logNo(cid, reason, extra = {}) {
  logAiAction({ client_id: cid, action_type: 'NO_ACTION', reason, prompt_version: AI_PROMPT_VERSION, intent_before: extra.intentBefore, intent_after: extra.intentAfter, status: 'success' })
  return { ok: true, sent: false, action: 'NO_ACTION', reason }
}
