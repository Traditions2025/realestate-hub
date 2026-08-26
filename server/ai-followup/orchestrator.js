// HUB AI orchestrator — responsive inbound flow. HUB controls workflow + compliance;
// the model controls language + interpretation only. Fail-safe: any error never
// breaks the inbox and never sends a malformed or stale message.
import db from '../database.js'
import { getAiClient, AI_MODEL } from '../routes/followup.js'
import { canSendSms } from './policy.js'
import { flag, getConfig, inQuietHours } from './flags.js'
import { ensureState, transitionAiState, markInbound, markOutbound, aiManages } from './state.js'
import { buildLeadAiContext, centralGreeting } from './context.js'
import { computeIntent, saveIntent, getIntent, levelFor } from './intent.js'
import { applyMemory } from './memory.js'
import { createAiHandoff } from './handoff.js'
import { logAiAction } from './audit.js'
import { buildSystemPrompt, buildUserMessage, AI_PROMPT_VERSION, ALLOWED_ACTIONS, REVIVE_OPENERS } from './prompts.js'

// Rotate through the revive bank so all 20 openers get used (not just one). A persistent
// counter in settings advances every time we pick one.
export function nextReviveOpener() {
  const n = REVIVE_OPENERS.length
  const i = ((Number(db.getSetting?.('ai_revive_rotation') || 0) % n) + n) % n
  try { db.setSetting?.('ai_revive_rotation', String((i + 1) % n)) } catch {}
  return { index: i, text: REVIVE_OPENERS[i] }
}

const nowIso = () => new Date().toISOString()

function parseJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim()
  const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}
const noDash = (s) => String(s == null ? '' : s).replace(/[—–]/g, ', ')
// Safety net for the greeting rule: never let a message open with "Hey".
const noHey = (s) => String(s == null ? '' : s).replace(/^(\s*)hey\b([,!]*)/i, '$1Hi')

// Latest message id for the client — used for the race-condition guard.
const latestMsgId = (cid) => db.get('SELECT MAX(id) m FROM communications WHERE client_id=?', [cid])?.m || 0
// Is this the first text we've ever sent this contact?
const isFirstOutboundText = (cid) => !db.get("SELECT id FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing' LIMIT 1", [cid])
// Finalize any AI text. The model is NOT trusted with the time of day:
//  - FIRST text: force the opening greeting to the correct Central time-of-day + guarantee the website.
//  - Follow-ups: strip any time-of-day greeting the model added (they should just say Hi/Hello).
//  - Belt-and-suspenders: correct any remaining wrong "good morning/afternoon/evening" to Central.
function finalizeAiText(cid, message) {
  const g = centralGreeting()
  const first = isFirstOutboundText(cid)
  if (first) {
    message = message.replace(/^\s*(good\s+(morning|afternoon|evening)|hello|hi)\b/i, g)
  } else {
    message = message.replace(/\bgood\s+(morning|afternoon|evening)\b[!,.]?\s*/gi, '')
  }
  message = message.replace(/\bgood\s+(morning|afternoon|evening)\b/gi, g)
  message = message.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim()
  if (first && !/mattsmithteam\.com/i.test(message)) message = (message.trim() + ' MattSmithTeam.com').slice(0, 640)
  return message
}

// Did a HUMAN (not AI) already reply after the most recent inbound? If so, suppress.
function humanAlreadyHandled(cid) {
  const lastIn = db.get("SELECT id, occurred_at FROM communications WHERE client_id=? AND direction='incoming' ORDER BY occurred_at DESC LIMIT 1", [cid])
  if (!lastIn) return false
  const laterHuman = db.get(`SELECT id FROM communications WHERE client_id=? AND direction='outgoing'
    AND occurred_at > ? AND (sent_by_type IS NULL OR sent_by_type NOT IN ('ai','automation','system')) LIMIT 1`, [cid, lastIn.occurred_at])
  return !!laterHuman
}

// Main entry: an eligible inbound text arrived. Returns a small result object.
export async function handleInboundText(clientId, inboundBody, { force = false } = {}) {
  const cid = Number(clientId)
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return { ok: false, reason: 'no client' }
  ensureState(cid)
  if (!force) { markInbound(cid); cancelPendingScheduled(cid, 'lead replied') }   // never talk over a live reply

  // ---- gates (HUB-controlled, never the model). A manual send-now (force) skips
  // the feature-flag + enrollment + human-handled gates but keeps hard compliance. ----
  if (!force) {
    if (!flag('ai_followup_enabled') || !flag('ai_responsive_text_enabled')) return logNo(cid, 'responsive AI disabled')
    if (!aiManages(cid)) return logNo(cid, 'lead not enrolled in AI (manual mode — enable AI on this lead first)')
    if (humanAlreadyHandled(cid)) return logNo(cid, 'a human already replied')
    const st = db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [cid])
    if (st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED'].includes(st.ai_state)) return logNo(cid, 'human owns the conversation')
  }
  const gate = canSendSms(client, { channel: 'ai', mode: 'responsive', force })
  if (!gate.ok) return logNo(cid, 'blocked: ' + gate.reason)

  const ai = getAiClient()
  if (!ai) return logNo(cid, 'AI not configured (ANTHROPIC_API_KEY)')

  const ctx = buildLeadAiContext(cid)
  const intentBefore = getIntent(cid).score
  const startedAtMsgId = latestMsgId(cid)
  const t0 = Date.now()
  let decision, usage = {}
  try {
    const nudge = force ? '\n\nA team member has manually asked you to send a message to this contact now. Continue the conversation with a natural, helpful reply — use action SEND_TEXT with a real message (do not choose NO_ACTION), unless the contact opted out.' : ''
    const msg = await ai.messages.create({
      model: AI_MODEL, max_tokens: 900,
      system: buildSystemPrompt(ctx),
      messages: [{ role: 'user', content: buildUserMessage(ctx) + nudge }],
    })
    usage = msg.usage || {}
    decision = parseJson(msg.content?.[0]?.text || '')
  } catch (e) {
    logAiAction({ client_id: cid, action_type: 'RESPONSE', model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: 'model error', status: 'failed', error: e.message, latency_ms: Date.now() - t0 })
    return { ok: false, reason: 'model error: ' + e.message }
  }

  // ---- validate the model output server-side ----
  const action = ALLOWED_ACTIONS.includes(decision?.action) ? decision.action : 'NO_ACTION'
  const message = noHey(noDash(String(decision?.message || '').trim())).slice(0, 640)
  const handoffReq = !!(decision?.handoff?.required)
  const cfg = getConfig()

  // ---- memory + intent (always safe to update) ----
  try { if (decision?.memory || decision?.summary || decision?.conversation_type) applyMemory(cid, decision.memory || {}, decision.summary, { source: 'ai', conversationType: decision.conversation_type }) } catch {}
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
    if (inQuietHours()) return logNo(cid, 'quiet hours', { intentBefore, intentAfter: intent.score })   // quiet hours apply even to a manual Send-AI-now
    if (latestMsgId(cid) !== startedAtMsgId) return logNo(cid, 'aborted stale send (new message arrived)', { intentBefore, intentAfter: intent.score })
    // re-check eligibility right before sending
    const fresh = db.get('SELECT * FROM clients WHERE id=?', [cid])
    const g2 = canSendSms(fresh, { channel: 'ai', mode: 'responsive', force })
    if (!g2.ok) return logNo(cid, 'blocked at send: ' + g2.reason)
    try {
      const finalMsg = finalizeAiText(cid, message)
      const actionId = logAiAction({ client_id: cid, action_type: 'SEND_TEXT', model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: 'responsive reply', context_summary: ctx.intelligence?.ai_summary || '', output_text: finalMsg, intent_before: intentBefore, intent_after: intent.score, tokens_input: usage.input_tokens, tokens_output: usage.output_tokens, latency_ms: Date.now() - t0, status: 'success' })
      await sendAiSms(fresh, finalMsg, actionId)
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

// Shared outbound generator (proactive / nurture / re-engage). HUB-gated, compliance
// re-checked, race-guarded, daily-capped, quiet-hours aware. force=true (manual "Send
// AI now") bypasses only the per-mode global flag, never compliance.
async function runOutbound(cid, { actionType, instruction, flagKey, nextState, force = false, stripGreeting = false, reviveTemplate = null }) {
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return { ok: false, reason: 'no client' }
  ensureState(cid)
  if (!force) { if (!flag('ai_followup_enabled')) return logNo(cid, 'AI disabled globally'); if (flagKey && !flag(flagKey)) return logNo(cid, flagKey + ' disabled'); if (!aiManages(cid)) return logNo(cid, 'lead not enrolled in AI (manual mode)') }
  const mode = force ? 'responsive' : 'proactive'
  const gate = canSendSms(client, { channel: 'ai', mode, force })
  if (!gate.ok) return logNo(cid, 'blocked: ' + gate.reason)
  if (inQuietHours()) return logNo(cid, 'quiet hours')   // quiet hours apply even to a manual Send-AI-now
  // daily cap
  const cap = Number(getConfig().ai_followup_max_per_day) || 4
  const sentToday = db.get("SELECT COUNT(*) n FROM communications WHERE client_id=? AND sent_by_type='ai' AND occurred_at >= datetime('now','-1 day')", [cid])?.n || 0
  if (!force && sentToday >= cap) return logNo(cid, 'daily AI cap reached')
  const ai = getAiClient(); if (!ai) return logNo(cid, 'AI not configured')
  const ctx = buildLeadAiContext(cid)
  if (reviveTemplate) ctx.reviveTemplate = reviveTemplate   // rotated revive opener wins
  const startedAtMsgId = latestMsgId(cid)
  const t0 = Date.now()
  let decision, usage = {}
  try {
    const msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 700, system: buildSystemPrompt(ctx), messages: [{ role: 'user', content: `CONTEXT (JSON, trusted):\n${JSON.stringify(ctx.facts)}\n\n${instruction}\n\nReturn the JSON now.` }] })
    usage = msg.usage || {}; decision = parseJson(msg.content?.[0]?.text || '')
  } catch (e) { logAiAction({ client_id: cid, action_type: actionType, status: 'failed', error: e.message, model_name: AI_MODEL }); return { ok: false, reason: e.message } }
  const message = noHey(noDash(String(decision?.message || '').trim())).slice(0, 640)
  if (!message || (ALLOWED_ACTIONS.includes(decision?.action) && decision.action !== 'SEND_TEXT')) return logNo(cid, 'AI chose not to send')
  if (latestMsgId(cid) !== startedAtMsgId) return logNo(cid, 'aborted stale (new message arrived)')
  const g2 = canSendSms(db.get('SELECT * FROM clients WHERE id=?', [cid]), { channel: 'ai', mode, force })
  if (!g2.ok) return logNo(cid, 'blocked at send: ' + g2.reason)
  try {
    if (decision?.memory || decision?.summary) { try { applyMemory(cid, decision.memory || {}, decision.summary) } catch {} }
    let finalMsg = finalizeAiText(cid, message)
    // A same-thread nudge must not re-greet — strip a leading "Hi Robert!/Hello there,".
    if (stripGreeting) finalMsg = finalMsg.replace(/^\s*(?:hi|hello|hey)\b[^\n]*?[,!]\s+/i, '').replace(/^\s*([a-z])/, (m, c) => c.toUpperCase())
    const actionId = logAiAction({ client_id: cid, action_type: actionType, model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: actionType.toLowerCase(), output_text: finalMsg, tokens_input: usage.input_tokens, tokens_output: usage.output_tokens, latency_ms: Date.now() - t0, status: 'success' })
    await sendAiSms(db.get('SELECT * FROM clients WHERE id=?', [cid]), finalMsg, actionId)
    markOutbound(cid)
    transitionAiState(cid, nextState || 'AI_WAITING_FOR_REPLY', actionType.toLowerCase())
    return { ok: true, sent: true }
  } catch (e) { return { ok: false, reason: e.message } }
}

// Proactive first-touch (new-lead opener). Used by "Send AI Now" and the scheduler.
export async function handleProactive(clientId, { force = false } = {}) {
  const cid = Number(clientId)
  const ctx0 = db.get('SELECT source FROM clients WHERE id=?', [cid]) || {}
  const res = await runOutbound(cid, {
    actionType: 'PROACTIVE', flagKey: 'ai_proactive_text_enabled', force, nextState: 'AI_WAITING_FOR_REPLY',
    instruction: `This is a lead the team has NOT texted yet. Lead source: ${ctx0.source || 'unknown'}. Write a short, warm, welcoming opening SMS (see the FIRST MESSAGE rules). Give a real, contextual reason for reaching out. Do not force an appointment.`,
  })
  // If enabled, schedule ONE same-thread nudge in case they don't reply. OFF by default:
  // a second same-day text to a non-responder is a carrier spam trigger, so we only do
  // this when ai_first_followup_enabled is turned on. Replies are always answered by the
  // responsive flow regardless.
  if (res?.sent && getConfig().ai_first_followup_enabled === '1') {
    try {
      const mins = Number(getConfig().ai_first_followup_minutes) || 30
      const when = new Date(Date.now() + mins * 60000).toISOString()
      const { scheduleAiAction } = await import('./scheduler.js')
      scheduleAiAction(cid, 'AI_FOLLOWUP', when, { reason: `no-reply follow-up (${mins}m)`, dedupKey: `firstfollowup_${cid}` })
    } catch {}
  }
  return res
}

// Preview the message the AI would send next — WITHOUT sending, logging a send, or
// changing state. Picks first-touch / reply / follow-up based on the conversation.
export async function previewMessage(clientId, { context = '' } = {}) {
  const cid = Number(clientId)
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return { ok: false, reason: 'no client' }
  const ai = getAiClient(); if (!ai) return { ok: false, reason: 'AI not configured (ANTHROPIC_API_KEY missing)' }
  const ctx = buildLeadAiContext(cid)
  const lastText = db.get("SELECT direction FROM communications WHERE client_id=? AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
  let kind, instruction
  if (!lastText) { kind = 'first text'; instruction = `This is a lead the team has NOT texted yet. Lead source: ${ctx.facts.lead_source || 'unknown'}. Write a short, natural opening SMS to start a conversation. Give a real, contextual reason for reaching out based on the context. Do not force an appointment.` }
  else if (lastText.direction === 'incoming') { kind = 'reply'; instruction = null }
  else { kind = 'follow-up'; instruction = `You've already been in touch and are getting to know this lead. Send ONE short, natural follow-up asking the single most useful thing you do NOT know yet (buyer: area, then price, then property type (single-family or condo), then style (ranch, two-story, or something else), then beds, then timeframe, then financing; seller: address, then timeframe, then motivation). One question, no re-intro, do not repeat prior messages.` }
  // Agent-supplied context: a fact/steer the AI must fold into the text (e.g. "this
  // home just went pending", "they mentioned they have a dog", "push a Saturday tour").
  const ctxNote = String(context || '').trim()
  const ctxBlock = ctxNote ? `\n\nIMPORTANT — the agent added this context; naturally work it into the message (do not quote it verbatim, do not mention "the agent"):\n${ctxNote.slice(0, 500)}` : ''
  const userContent = instruction
    ? `CONTEXT (JSON, trusted):\n${JSON.stringify(ctx.facts)}\n\n${instruction}${ctxBlock}\n\nReturn the JSON now.`
    : buildUserMessage(ctx) + ctxBlock
  let decision, usage = {}
  try { const msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 700, system: buildSystemPrompt(ctx), messages: [{ role: 'user', content: userContent }] }); usage = msg.usage || {}; decision = parseJson(msg.content?.[0]?.text || '') }
  catch (e) { return { ok: false, reason: e.message } }
  let message = noHey(noDash(String(decision?.message || '').trim())).slice(0, 640)
  if (message) message = finalizeAiText(cid, message)
  const elig = canSendSms(client, { channel: 'ai', mode: 'responsive', force: true })
  logAiAction({ client_id: cid, action_type: 'PREVIEW', model_name: AI_MODEL, prompt_version: AI_PROMPT_VERSION, reason: 'preview ' + kind, output_text: message, tokens_input: usage.input_tokens, tokens_output: usage.output_tokens, status: 'success' })
  return { ok: true, kind, message: message || '(the AI would not send here — nothing to say)', eligible: elig.ok, block_reason: elig.ok ? null : elig.reason }
}

// Follow-up touch: we've already reached out; ask the next useful qualifying
// question to learn what the lead wants (area, price, beds, timeframe, financing
// for buyers; address, timeframe, motivation for sellers). One question, no re-intro.
export async function handleFollowup(clientId, { force = false } = {}) {
  const cid = Number(clientId)
  // Has this lead ever replied? If NOT, this is a no-reply nudge that must CONTINUE the
  // opener in the same thread (no re-greeting, no re-intro, no new topic). If they HAVE
  // replied, it is a normal conversational follow-up.
  const hasInbound = !!db.get("SELECT id FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' LIMIT 1", [cid])
  const opener = db.get("SELECT body FROM communications WHERE client_id=? AND direction='outgoing' AND channel='text' ORDER BY occurred_at ASC LIMIT 1", [cid])
  const noReplyNudge = !hasInbound
  const instruction = noReplyNudge
    ? `You texted this person a first message a little earlier and they have NOT replied yet. Your first message was: "${(opener?.body || '').replace(/\s+/g, ' ').slice(0, 300)}". Send ONE short, friendly nudge that reads as a natural CONTINUATION of that same message, as if you were adding a second thought a moment later. HARD RULES: do NOT greet them again (no "Hi", "Hello", "Hey", or their name at the start), do NOT re-introduce yourself, do NOT start a new subject, and do NOT restate what you already said. Stay on the SAME thing you already mentioned (the home or area they were looking at) and add ONE light, low-pressure question to make it easy to reply. NEVER imply you are watching their activity (never say "I noticed you've been looking", "I saw you viewed", etc.). Keep it casual and human.`
    : `You've already been talking with this person and are getting to know them. Do NOT greet them again and do NOT re-introduce yourself. Using what you already know (context), send ONE short, natural follow-up that moves things forward by asking the single most useful thing you do NOT know yet. For a BUYER, prioritize in this order: the area/part of town, then price range, then property type (single-family home or condo), then home style (ranch, two-story, or something else), then beds/baths, then timeframe, then financing (pre-approved?). For a SELLER: the property address, then timeframe, then reason for selling. Ask exactly ONE question. Do not repeat your previous message, and never say "just following up" or "checking in".`
  return runOutbound(cid, {
    actionType: 'FOLLOWUP', flagKey: null, force, nextState: 'AI_CONVERSATION_ACTIVE',
    stripGreeting: true, instruction,
  })
}

// Nurture / re-engagement touch (scheduler-driven). attempt informs the tone.
export async function handleNurture(clientId, { reengage = false, attempt = 1 } = {}) {
  const cid = Number(clientId)
  // Reviving an OLD BUYER lead (no recent activity) uses the rotated approved revive bank so
  // all 20 openers get exercised, not a single stock line. Sellers keep the generic reconnect.
  const type = String(db.get('SELECT type FROM clients WHERE id=?', [cid])?.type || '').toLowerCase()
  const isSeller = type.includes('seller') && !type.includes('buyer')
  let reviveTemplate = null, instruction
  if (reengage && !isSeller) {
    reviveTemplate = nextReviveOpener().text
    instruction = `Reconnect with this OLD buyer lead who has no recent activity. Use the REVIVE OPENER section: send the approved body exactly as one text with the greeting, "it's John with Matt Smith Team", and MattSmithTeam.com at the end. Return action SEND_TEXT.`
  } else if (reengage) {
    instruction = `This lead went quiet a while ago and just showed fresh signs of life (or enough time has passed that their timing may have changed). Write ONE short, warm, low-pressure text that gives a genuine, contextual reason to reconnect. Do not say "just checking in".`
  } else {
    instruction = `This lead has not replied to recent messages (nurture attempt ${attempt}). Write ONE short, low-pressure, genuinely useful text with a real contextual reason. Vary it from prior messages. Do not say "just checking in" or "following up". If nothing useful to say, choose NO_ACTION.`
  }
  return runOutbound(cid, {
    actionType: reengage ? 'REENGAGE' : 'NURTURE', flagKey: 'ai_nurture_enabled',
    nextState: reengage ? 'AI_REENGAGED' : 'AI_LONG_TERM_NURTURE', reviveTemplate, instruction,
  })
}

// Cancel any pending scheduled AI actions for a lead (called when they reply or a
// human takes over) so we never talk over a live conversation.
export function cancelPendingScheduled(clientId, reason = 'lead replied') {
  try { db.run("UPDATE ai_scheduled_actions SET state='canceled', canceled_at=?, error=? WHERE client_id=? AND state='pending'", [nowIso(), reason, Number(clientId)]) } catch {}
}

function logNo(cid, reason, extra = {}) {
  logAiAction({ client_id: cid, action_type: 'NO_ACTION', reason, prompt_version: AI_PROMPT_VERSION, intent_before: extra.intentBefore, intent_after: extra.intentAfter, status: 'success' })
  return { ok: true, sent: false, action: 'NO_ACTION', reason }
}
