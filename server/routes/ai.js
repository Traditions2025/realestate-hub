// HUB AI ISA — control + reporting API. All mutations are server-authorized; the
// model never reaches these routes. State changes go through the state machine.
import { Router } from 'express'
import db from '../database.js'
import { AI_FLAGS, AI_CONFIG_DEFAULTS, getFlags, getConfig, flag } from '../ai-followup/flags.js'
import { ensureState, getState, transitionAiState, pauseAi, resumeAi, humanTakeover, setEnabled, setManaged, isExcludedFromAutopilot, AI_STATES } from '../ai-followup/state.js'
import { getIntent, applyDecay, levelFor } from '../ai-followup/intent.js'
import { recentAiActions } from '../ai-followup/audit.js'
import { ensurePrefs } from '../ai-followup/policy.js'
import { memoryFields } from '../ai-followup/memory.js'
import { isStopStatus } from '../lead-sequences.js'
import { buildSystemPrompt, buildUserMessage, ALLOWED_ACTIONS } from '../ai-followup/prompts.js'
import { getAiClient, AI_MODEL } from './followup.js'
import { centralGreeting, centralSeason } from '../ai-followup/context.js'

const router = Router()
const nowIso = () => new Date().toISOString()

function sandboxParseJson(text) {
  let t = (text || '').trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i); if (fence) t = fence[1].trim()
  const s = t.indexOf('{'), e = t.lastIndexOf('}'); if (s >= 0 && e > s) t = t.slice(s, e + 1)
  return JSON.parse(t)
}
// Same em/en-dash strip the live orchestrator applies, so the sandbox matches production.
const stripDashes = (s) => String(s == null ? '' : s).replace(/\s*[—–]\s*/g, ', ').replace(/[ \t]{2,}/g, ' ')

// ---- AI Sandbox: run the REAL AI brain against a simulated lead + conversation.
// Pure model call — never sends a text, never touches a real lead or the DB. Returns the
// AI's full decision (drafted reply, chosen action, intent delta + signals, extracted
// memory, rolling summary, next state, handoff) so you can watch it think in real time.
router.post('/sandbox', async (req, res) => {
  const ai = getAiClient()
  if (!ai) return res.status(400).json({ error: 'AI not configured (ANTHROPIC_API_KEY missing on the server).' })
  const b = req.body || {}
  const lead = b.lead || {}
  const leadType = ['buyer', 'seller', 'both'].includes(lead.type) ? lead.type : 'buyer'
  const history = Array.isArray(b.messages) ? b.messages.slice(-30) : []
  const isFirst = !history.some(m => m.role === 'agent')
  const proactive = b.mode === 'proactive' || b.mode === 'revive'
  const revive = b.mode === 'revive'
  const nurture = b.mode === 'nurture'   // no-reply follow-up touch (nurture cadence)
  const coldStage = b.mode === 'cold_stage'   // old/cold-buyer staged drip (Text 1..6, LTN, loop)
  const stageIndex = Math.max(0, Number(b.stageIndex) || 0)
  const attempt = Math.max(1, Number(b.attempt) || 1)
  const activity = b.activity || {}
  const latest = String(b.latest || (history.length ? history[history.length - 1].text : '') || '').slice(0, 1200)
  if (!proactive && !nurture && !coldStage && !latest.trim()) return res.status(400).json({ error: 'Provide the latest lead message.' })
  // Build a synthetic context mirroring the shape context.js produces for a real lead.
  const facts = {
    first_name: lead.name || 'there', lead_type: leadType, lead_source: lead.source || 'Website',
    crm_status: 'new', city: lead.city || 'Cedar Rapids', team_area: 'Cedar Rapids / Marion, Iowa (Linn County)',
    is_first_text: isFirst, time_greeting: centralGreeting(),
    current_season: centralSeason().season, current_month: centralSeason().month,
    search_city: activity.search_city || lead.city || null,
    last_viewed_property: activity.last_viewed_property || null,
    recent_properties_viewed: Array.isArray(activity.recent_properties_viewed) ? activity.recent_properties_viewed : [],
    now: new Date().toISOString(),
  }
  const transcript = history.map(m => `${m.role === 'agent' ? 'AGENT (you)' : 'CONSUMER'}: ${m.text}`).join('\n') || '(no prior messages)'
  // Pass the (synthetic) lead through as `client` so the cold-seller detector can react to
  // fsbo_status / mls_status / tags / source when the sandbox simulates an FSBO/expired lead.
  const ctx = { facts, transcript, latestInbound: latest, lead_type: leadType, persona: getConfig().ai_persona || 'John with Matt Smith Team at RE/MAX Concepts', intelligence: { lead_type: leadType }, client: lead }
  // Revive test: rotate in one approved revive opener so you can click through all 20.
  let reviveInfo = null
  if (revive) { const { nextReviveOpener } = await import('../ai-followup/orchestrator.js'); reviveInfo = nextReviveOpener(); ctx.reviveTemplate = reviveInfo.text }
  // Proactive: the lead is browsing / behaving online and the AI reaches out FIRST — no
  // inbound message. Mirrors handleProactive's instruction (contextual reason, never
  // "I saw you browsing").
  const proactiveInstruction = `This is a lead the team has NOT texted yet. They have been active online: ${activity.description || 'browsing our website'}. Lead source: ${facts.lead_source}. Write a short, warm, welcoming opening SMS (follow the FIRST MESSAGE rules). Give a real, contextual reason for reaching out tied to what they were looking at (the city/area or a property, from the context) and end with ONE easy, low-pressure question. NEVER imply you are watching their activity (never say "I saw you viewed/browsing"); say "thanks for stopping by" instead. Return action SEND_TEXT with the message.`
  const reviveInstruction = `This is an OLD buyer lead with NO recent online activity; you are reconnecting after a long gap. Follow the REVIVE OPENER section exactly: send the approved body as one text with the greeting, "it's John with Matt Smith Team at RE/MAX", and MattSmithTeam.com at the end. Return action SEND_TEXT.`
  // Nurture follow-up (no reply): mirrors orchestrator.handleNurture's non-reengage instruction.
  const nurtureInstruction = `This lead has NOT replied to your prior message(s) shown in the transcript (nurture attempt ${attempt}). Write ONE short, low-pressure, genuinely useful text with a real, contextual reason to reach back out. Vary it clearly from the prior messages. Do not say "just checking in" or "following up" or repeat the greeting/intro from the first text. If there is genuinely nothing useful to say, return action NO_ACTION; otherwise return action SEND_TEXT with the message.`
  // Cold-buyer staged drip preview: Text 1 uses REVIVE_OPENER_BLOCK; stages 1+ use COLD_STAGE_BLOCK.
  let coldInfo = null
  if (coldStage) {
    const { COLD_BUYER_STAGES, COLD_STAGE_BLOCK, REVIVE_OPENER_BLOCK } = await import('../ai-followup/prompts.js')
    const stage = COLD_BUYER_STAGES[Math.min(stageIndex, COLD_BUYER_STAGES.length - 1)]
    const bank = stage.messages || []
    const approved = bank.length ? bank[stageIndex % bank.length] : null   // deterministic pick for preview
    coldInfo = { stage: stageIndex + 1, label: stage.label, day: stage.day, approved }
    ctx.coldStageInstruction = stageIndex === 0
      ? REVIVE_OPENER_BLOCK(approved || '', facts.time_greeting)
      : `MESSAGES ALREADY SENT (oldest to newest, no replies received):\n${transcript}\n\n${COLD_STAGE_BLOCK(stage, approved)}`
  }
  let userContent = revive
    ? `CONTEXT (JSON, trusted):\n${JSON.stringify(facts)}\n\n${reviveInstruction}\n\nReturn the JSON now.`
    : coldStage
      ? `CONTEXT (JSON, trusted):\n${JSON.stringify(facts)}\n\n${ctx.coldStageInstruction}\n\nReturn the JSON now.`
      : nurture
        ? `CONTEXT (JSON, trusted):\n${JSON.stringify(facts)}\n\nMESSAGES YOU ALREADY SENT (oldest to newest, no replies received):\n${transcript}\n\n${nurtureInstruction}\n\nReturn the JSON now.`
        : proactive
          ? `CONTEXT (JSON, trusted):\n${JSON.stringify(facts)}\n\n${proactiveInstruction}\n\nReturn the JSON now.`
          : buildUserMessage(ctx)
  // Refinement loop: the agent clicked a reply and asked for an improvement. Feed the prior
  // draft + their instruction so the model rewrites it (still following every rule).
  const refine = b.refine
  if (refine && String(refine.instruction || '').trim()) {
    userContent += `\n\nREVISION REQUEST — a team member reviewed your draft and wants it improved. Your previous draft was:\n"${String(refine.previous || '').slice(0, 600)}"\nRewrite the message per this instruction: "${String(refine.instruction).slice(0, 400)}". Keep EVERY rule (greeting, don't repeat their name, intro + website on a first text, etc.). Return the improved message in the same JSON format.`
  }
  const t0 = Date.now()
  try {
    const msg = await ai.messages.create({ model: AI_MODEL, max_tokens: 900, system: buildSystemPrompt(ctx), messages: [{ role: 'user', content: userContent }] })
    const decision = sandboxParseJson(msg.content?.[0]?.text || '')
    const action = ALLOWED_ACTIONS.includes(decision?.action) ? decision.action : 'NO_ACTION'
    const delta = Math.max(-20, Math.min(40, Number(decision?.intent_delta) || 0))
    const prevIntent = Math.max(0, Math.min(100, Number(b.intent) || 0))
    const newIntent = Math.max(0, Math.min(100, prevIntent + delta))
    res.json({
      action,
      message: stripDashes(decision?.message || '').trim(),
      intent_delta: delta, intent_before: prevIntent, intent_after: newIntent, intent_level: levelFor(newIntent),
      intent_signals: Array.isArray(decision?.intent_signals) ? decision.intent_signals : [],
      memory: decision?.memory || {}, conversation_type: decision?.conversation_type || null,
      summary: decision?.summary || '', next_state: decision?.next_state || null,
      handoff: decision?.handoff || { required: false },
      latency_ms: Date.now() - t0, tokens: msg.usage || {},
      revive_opener: reviveInfo ? { index: reviveInfo.index + 1, total: reviveInfo.total || 20, body: reviveInfo.text } : null,
      cold_stage: coldInfo,
    })
  } catch (e) { res.status(500).json({ error: 'model error: ' + e.message }) }
})

// ---- per-lead AI card ----
router.get('/lead/:id', (req, res) => {
  const cid = Number(req.params.id)
  const client = db.get('SELECT id, first_name, last_name, phone, agent_assigned, status, source FROM clients WHERE id=?', [cid])
  if (!client) return res.status(404).json({ error: 'client not found' })
  const state = ensureState(cid)
  const prefs = ensurePrefs(client)
  const li = db.get('SELECT * FROM lead_intelligence WHERE client_id=?', [cid]) || {}
  const intent = getIntent(cid)
  const lastConsumer = db.get("SELECT body, occurred_at FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
  const openHandoff = db.get("SELECT id, urgency, reason, created_at FROM ai_handoffs WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [cid])
  res.json({
    ai_enabled: state?.ai_enabled === 1, ai_state: state?.ai_state, ai_state_changed_at: state?.ai_state_changed_at,
    ai_last_action_at: state?.ai_last_action_at, ai_next_action_at: state?.ai_next_action_at,
    ai_pause_until: state?.ai_pause_until, ai_pause_reason: state?.ai_pause_reason, ai_owner: state?.ai_owner || client.agent_assigned,
    intent, summary: li.ai_summary || null, lead_type: li.lead_type || client.type, conversation_type: li.conversation_type || null,
    memory_fields: memoryFields(cid),
    prefs: { do_not_text: !!prefs?.do_not_text, do_not_call: !!prefs?.do_not_call, ai_text_enabled: prefs?.ai_text_enabled !== 0, ai_voice_enabled: prefs?.ai_voice_enabled === 1, sms_status: prefs?.sms_status, hub_text_opt_out: !!client.hub_text_opt_out },
    last_consumer_message: lastConsumer ? { text: lastConsumer.body, at: lastConsumer.occurred_at } : null,
    open_handoff: openHandoff || null,
    ai_managed: state?.ai_managed === 1,
    global: { responsive: flag('ai_responsive_text_enabled'), proactive: flag('ai_proactive_text_enabled'), master: flag('ai_followup_enabled'), autopilot: flag('ai_autopilot') },
  })
})

router.get('/lead/:id/history', (req, res) => res.json(recentAiActions(Number(req.params.id), 60)))
// Preview the next AI message WITHOUT sending it.
router.post('/lead/:id/preview', async (req, res) => {
  try { const m = await import('../ai-followup/orchestrator.js'); res.json(await m.previewMessage(Number(req.params.id), { context: req.body?.context || '', approach: String(req.body?.approach || '') })) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- per-lead controls ----
router.post('/lead/:id/enable', (req, res) => { setEnabled(Number(req.params.id), true); setManaged(Number(req.params.id), true); transitionAiState(Number(req.params.id), 'AI_ELIGIBLE', 'enabled by agent'); res.json({ success: true }) })
router.post('/lead/:id/stop', (req, res) => { setEnabled(Number(req.params.id), false); setManaged(Number(req.params.id), false); transitionAiState(Number(req.params.id), 'AI_DISABLED', 'stopped by agent'); res.json({ success: true }) })
router.post('/lead/:id/resume', (req, res) => { resumeAi(Number(req.params.id), 'resumed by agent'); res.json({ success: true }) })
router.post('/lead/:id/takeover', (req, res) => { humanTakeover(Number(req.params.id), 'agent takeover'); res.json({ success: true }) })
router.post('/lead/:id/pause', (req, res) => {
  const cid = Number(req.params.id)
  const opt = String(req.body?.duration || 'until')
  const map = { '1h': 3600e3, 'today': 12 * 3600e3, '3d': 3 * 864e5, '7d': 7 * 864e5 }
  let until = null
  if (map[opt]) until = new Date(Date.now() + map[opt]).toISOString()
  pauseAi(cid, until, req.body?.reason || 'paused by agent')
  res.json({ success: true, until })
})
router.post('/lead/:id/prefs', (req, res) => {
  const cid = Number(req.params.id); const b = req.body || {}
  const c = db.get('SELECT id, phone, hub_text_opt_out FROM clients WHERE id=?', [cid]); if (!c) return res.status(404).json({ error: 'not found' })
  ensurePrefs(c)
  const sets = [], vals = []
  for (const k of ['do_not_text', 'do_not_call', 'ai_text_enabled', 'ai_voice_enabled']) if (b[k] !== undefined) { sets.push(`${k}=?`); vals.push(b[k] ? 1 : 0) }
  if (sets.length) { vals.push(cid); db.run(`UPDATE communication_preferences SET ${sets.join(', ')}, updated_at='${nowIso()}' WHERE client_id=?`, vals) }
  res.json({ success: true })
})
// Send an AI message now (proactive opener / manual trigger) — honors all compliance.
// Purge past clients from the cold-buyer drip: scan everyone with pending cold-buyer
// actions (plus any extra_ids), keep only PAST CLIENTS (status closed OR genuine PC tag),
// cancel their queued drip texts, and turn AI off. dry_run:true previews.
router.post('/cold-buyer/purge-past-clients', (req, res) => {
  const dryRun = req.body?.dry_run === true
  const extra = (Array.isArray(req.body?.extra_ids) ? req.body.extra_ids : []).map(Number).filter(Boolean)
  const isGenuinePC = (t) => String(t || '').split(',').some(x => { const l = x.toLowerCase(); return l.includes('past client') && !l.includes('unsubscribed') })
  const cohort = db.all("SELECT DISTINCT client_id FROM ai_scheduled_actions WHERE action_type='AI_COLD_BUYER' AND state='pending'").map(r => r.client_id)
  const ids = [...new Set([...cohort, ...extra])]
  const targets = []
  for (const id of ids) {
    const c = db.get('SELECT id, first_name, last_name, status, tags FROM clients WHERE id=?', [id]); if (!c) continue
    if (!(String(c.status || '').toLowerCase() === 'closed' || isGenuinePC(c.tags))) continue   // past clients only
    const pend = db.get("SELECT COUNT(*) n FROM ai_scheduled_actions WHERE client_id=? AND state='pending'", [id])?.n || 0
    let s = {}; try { s = db.get('SELECT ai_enabled, ai_managed FROM ai_lead_state WHERE client_id=?', [id]) || {} } catch {}
    if (!pend && !s.ai_enabled && !s.ai_managed) continue   // nothing to undo
    targets.push({ id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), status: c.status, pending: pend, ai_enabled: !!s.ai_enabled, ai_managed: !!s.ai_managed })
  }
  if (dryRun) return res.json({ count: targets.length, targets })
  let canceled = 0
  for (const t of targets) {
    try { const r = db.run("UPDATE ai_scheduled_actions SET state='canceled', error='past client - removed from cold-buyer drip', updated_at=datetime('now') WHERE client_id=? AND state='pending'", [t.id]); canceled += r.changes || 0 } catch {}
    try { setEnabled(t.id, false); setManaged(t.id, false); transitionAiState(t.id, 'AI_DISABLED', 'past client - not a cold buyer') } catch {}
  }
  res.json({ targets: targets.length, drip_texts_canceled: canceled, ai_disabled: targets.length, ids: targets.map(t => t.id) })
})

// Turn OFF all AI for FSBO leads. Flips the FSBO follow-up master switch off (the proactive
// FSBO sequence uses force-sends that bypass per-lead flags, so the global switch is the real
// stop), AND disables/unmanages every FSBO lead + cancels their pending scheduled AI actions +
// stops active FSBO follow-up enrollments. ?dry=1 previews the count.
router.post('/fsbo/disable-all', (req, res) => {
  const dry = req.query.dry === '1' || req.body?.dry === true
  const ids = db.all("SELECT id FROM clients WHERE fsbo_status IS NOT NULL AND fsbo_status != '' AND merged_into IS NULL").map(r => r.id)
  if (dry) return res.json({ dry: true, fsbo_leads: ids.length })
  db.setSetting?.('fsbo_followup_enabled', '0')   // master FSBO follow-up switch OFF
  let canceled = 0, stopped = 0
  for (const id of ids) {
    try { const r = db.run("UPDATE ai_scheduled_actions SET state='canceled', error='FSBO AI turned off', updated_at=datetime('now') WHERE client_id=? AND state='pending'", [id]); canceled += r.changes || 0 } catch {}
    try { setEnabled(id, false); setManaged(id, false); transitionAiState(id, 'AI_DISABLED', 'FSBO AI turned off') } catch {}
    try { const r = db.run("UPDATE fsbo_followups SET status='stopped' WHERE client_id=? AND status='active'", [id]); stopped += r.changes || 0 } catch {}
  }
  res.json({ fsbo_followup_enabled: false, fsbo_leads: ids.length, ai_disabled: ids.length, scheduled_canceled: canceled, followups_stopped: stopped })
})

// Turn OFF all AI for Cancelled/Expired leads (tagged/sourced Cancelled or Expired, or carrying
// an MLS status). Disables + unmanages each lead, sets AI_DISABLED, and cancels pending scheduled
// AI actions. (No proactive force-send sequence exists for these like FSBO, so per-lead is the
// full stop.) ?dry=1 previews the count.
router.post('/expired/disable-all', (req, res) => {
  const dry = req.query.dry === '1' || req.body?.dry === true
  const ids = db.all(`SELECT id FROM clients WHERE merged_into IS NULL AND (
      lower(coalesce(tags,'')) LIKE '%cancelled%' OR lower(coalesce(tags,'')) LIKE '%expired%'
      OR lower(coalesce(source,'')) LIKE '%cancelled%' OR lower(coalesce(source,'')) LIKE '%expired%'
      OR (mls_status IS NOT NULL AND mls_status != ''))`).map(r => r.id)
  if (dry) return res.json({ dry: true, expired_cancelled_leads: ids.length })
  let canceled = 0
  for (const id of ids) {
    try { const r = db.run("UPDATE ai_scheduled_actions SET state='canceled', error='Cancelled/Expired AI turned off', updated_at=datetime('now') WHERE client_id=? AND state='pending'", [id]); canceled += r.changes || 0 } catch {}
    try { setEnabled(id, false); setManaged(id, false); transitionAiState(id, 'AI_DISABLED', 'Cancelled/Expired AI turned off') } catch {}
  }
  res.json({ expired_cancelled_leads: ids.length, ai_disabled: ids.length, scheduled_canceled: canceled })
})

// Bulk: report AI state (enabled / managed / state / pending drip actions) for a set of leads.
router.post('/lead-states', (req, res) => {
  const ids = (Array.isArray(req.body?.client_ids) ? req.body.client_ids : []).map(Number).filter(Boolean)
  if (!ids.length) return res.status(400).json({ error: 'client_ids required' })
  const out = ids.map(id => {
    const c = db.get('SELECT id, first_name, last_name, status, agent_assigned FROM clients WHERE id=?', [id]); if (!c) return null
    let s = {}; try { s = db.get('SELECT ai_enabled, ai_managed, ai_state FROM ai_lead_state WHERE client_id=?', [id]) || {} } catch {}
    let pend = 0; try { pend = db.get("SELECT COUNT(*) n FROM ai_scheduled_actions WHERE client_id=? AND state='pending'", [id])?.n || 0 } catch {}
    return { id, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), status: c.status, agent: c.agent_assigned, ai_enabled: !!s.ai_enabled, ai_managed: !!s.ai_managed, ai_state: s.ai_state || null, pending_actions: pend }
  }).filter(Boolean)
  const aiOn = out.filter(x => x.ai_enabled || x.ai_managed || x.pending_actions > 0)
  res.json({ total: out.length, ai_on_count: aiOn.length, ai_on: aiOn })
})

router.post('/lead/:id/send-now', async (req, res) => {
  try {
    const cid = Number(req.params.id)
    setManaged(cid, true)   // a manual "Send AI now" enrolls the lead
    const m = await import('../ai-followup/orchestrator.js')
    const lastText = db.get("SELECT direction FROM communications WHERE client_id=? AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
    const lastIn = db.get("SELECT body FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
    // Right message for where the conversation is: no texts yet → opener; they replied
    // → answer + qualify; we texted with no reply → the next qualifying follow-up.
    const { isDormantLead } = await import('../ai-followup/context.js')
    let result
    // Never-texted lead: a DORMANT one (no recent activity, not brand new) enters the staged
    // cold-buyer drip at Text 1 (buyers) or gets the generic revive (sellers). A fresh lead
    // gets the activity-aware proactive opener.
    if (!lastText) {
      if (isDormantLead(cid)) {
        const t = String((db.get('SELECT type FROM clients WHERE id=?', [cid]) || {}).type || '').toLowerCase()
        if (t.includes('seller') && !t.includes('buyer')) result = await m.handleNurture(cid, { reengage: true, force: true })
        else { result = await m.handleColdBuyerStage(cid, 0, { force: true }); if (result?.sent) { const s = await import('../ai-followup/scheduler.js'); s.scheduleColdBuyer(cid, 1) } }
      } else result = await m.handleProactive(cid, { force: true })
    }
    else if (lastText.direction === 'incoming' && lastIn) result = await m.handleInboundText(cid, lastIn.body, { force: true })
    else result = await m.handleFollowup(cid, { force: true })
    // Manual click should reliably send: if that path produced nothing, try a follow-up.
    if (result && result.ok && !result.sent && !/blocked|STOP|opt|quiet/i.test(result.reason || '')) {
      const p = await m.handleFollowup(cid, { force: true })
      if (p?.sent) result = p
    }
    res.json(result)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- BULK "Send AI now" across selected leads. Same per-lead routing + compliance
// as /send-now, but SKIPS autopilot-excluded prospecting leads (FSBO / expired /
// cancelled / configured exclusions) so a bulk action can never accidentally blast a
// list the team walled off. Those can still be enabled one-by-one from a profile. ----
router.post('/bulk-send-now', async (req, res) => {
  const ids = Array.isArray(req.body?.client_ids) ? req.body.client_ids.map(Number).filter(Boolean) : []
  const includeExcluded = req.body?.include_excluded === true
  if (!ids.length) return res.status(400).json({ error: 'Select at least one lead.' })
  if (ids.length > 500) return res.status(400).json({ error: 'Too many at once — select 500 or fewer.' })
  const m = await import('../ai-followup/orchestrator.js')
  const { isDormantLead } = await import('../ai-followup/context.js')
  const out = { total: ids.length, sent: 0, skipped: 0, blocked: 0, results: [] }
  for (const cid of ids) {
    try {
      const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
      if (!client) { out.skipped++; out.results.push({ client_id: cid, ok: false, skipped: true, reason: 'no client' }); continue }
      const nm = `${client.first_name || ''} ${client.last_name || ''}`.trim()
      if (!includeExcluded && isExcludedFromAutopilot(client)) {
        out.skipped++; out.results.push({ client_id: cid, name: nm, ok: false, skipped: true, reason: 'excluded prospecting lead (FSBO/expired/cancelled or matched an exclusion)' }); continue
      }
      setManaged(cid, true)   // a manual Send AI enrolls the lead, same as per-lead
      const lastText = db.get("SELECT direction FROM communications WHERE client_id=? AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
      const lastIn = db.get("SELECT body FROM communications WHERE client_id=? AND direction='incoming' AND channel='text' ORDER BY occurred_at DESC LIMIT 1", [cid])
      let result
      // Dormant (no recent activity, not brand new) → staged cold-buyer drip at Text 1 (buyers)
      // or generic revive (sellers). Fresh lead → proactive opener.
      if (!lastText) {
        const t = String(client.type || '').toLowerCase()
        if (!isDormantLead(cid)) result = await m.handleProactive(cid, { force: true })
        else if (t.includes('seller') && !t.includes('buyer')) result = await m.handleNurture(cid, { reengage: true, force: true })
        else { result = await m.handleColdBuyerStage(cid, 0, { force: true }); if (result?.sent) { const s = await import('../ai-followup/scheduler.js'); s.scheduleColdBuyer(cid, 1) } }
      }
      else if (lastText.direction === 'incoming' && lastIn) result = await m.handleInboundText(cid, lastIn.body, { force: true })
      else result = await m.handleFollowup(cid, { force: true })
      if (result && result.ok && !result.sent && !/blocked|STOP|opt|quiet/i.test(result.reason || '')) {
        const p = await m.handleFollowup(cid, { force: true }); if (p?.sent) result = p
      }
      if (result?.sent) { out.sent++; out.results.push({ client_id: cid, name: nm, ok: true }) }
      else { out.blocked++; out.results.push({ client_id: cid, name: nm, ok: false, reason: result?.reason || 'nothing to send' }) }
    } catch (e) { out.blocked++; out.results.push({ client_id: cid, ok: false, reason: e.message }) }
  }
  res.json(out)
})

// ---- COLD-BUYER DRIP: enroll leads + pre-schedule their remaining sequence. Explicit,
// gated NOTHING sends until the AI engine (ai_followup + ai_nurture) is on and each date
// arrives. Used to continue leads that already got Text 1 (start at Text 2) and for tests. ----
router.post('/cold-buyer/enroll', async (req, res) => {
  const ids = Array.isArray(req.body?.client_ids) ? req.body.client_ids.map(Number).filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: 'client_ids required' })
  const explicitFrom = req.body?.from_stage != null ? Number(req.body.from_stage) : null
  const { enrollColdBuyerSequence } = await import('../ai-followup/scheduler.js')
  const results = []
  for (const cid of ids) {
    try {
      const c = db.get('SELECT * FROM clients WHERE id=?', [cid])
      if (!c) { results.push({ client_id: cid, ok: false, reason: 'no client' }); continue }
      // Anchor = their most recent AI/revive Text 1 (so Text 2 lands on the right day); else now.
      const anchor = db.get("SELECT occurred_at FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing' AND sent_by_type IN ('ai','fsbo_ai') ORDER BY occurred_at DESC LIMIT 1", [cid])
      const fromStage = explicitFrom != null ? explicitFrom : (anchor ? 1 : 0)   // already got Text 1 -> start at Text 2
      setManaged(cid, true); setEnabled(cid, true)
      const scheduled = enrollColdBuyerSequence(cid, { fromStage, anchorIso: anchor?.occurred_at || null })
      results.push({ client_id: cid, name: `${c.first_name || ''} ${c.last_name || ''}`.trim(), start_text: fromStage + 1, anchor: anchor?.occurred_at || 'now', scheduled })
    } catch (e) { results.push({ client_id: cid, ok: false, reason: e.message }) }
  }
  res.json({ enrolled: results.filter(r => r.scheduled).length, results })
})

// Enroll the whole cohort that got an AI/revive Text 1 in a window and did NOT reply.
// Filters to buyers, excludes opt-outs / DNC / excluded lists / no-phone. Continues each
// at Text 2. dry_run:true returns the list without scheduling. Idempotent (dedup_key).
router.post('/cold-buyer/enroll-cohort', async (req, res) => {
  const since = req.body?.since || '2026-08-26T00:00:00Z'
  const until = req.body?.until || '2026-08-27T00:00:00Z'
  const dryRun = req.body?.dry_run === true
  const { enrollColdBuyerSequence } = await import('../ai-followup/scheduler.js')
  const rows = db.all(`SELECT co.client_id cid, MIN(co.occurred_at) first_at
    FROM communications co
    WHERE co.channel='text' AND co.direction='outgoing' AND co.sent_by_type IN ('ai','fsbo_ai')
      AND co.occurred_at >= ? AND co.occurred_at < ?
    GROUP BY co.client_id`, [since, until])
  const enroll = [], skipped = []
  for (const r of rows) {
    const c = db.get('SELECT * FROM clients WHERE id=?', [r.cid]); if (!c) continue
    const nm = `${c.first_name || ''} ${c.last_name || ''}`.trim()
    if (db.get("SELECT 1 FROM communications WHERE client_id=? AND channel='text' AND direction='incoming' AND occurred_at >= ? LIMIT 1", [r.cid, r.first_at])) { skipped.push({ cid: r.cid, nm, reason: 'replied' }); continue }
    const t = String(c.type || '').toLowerCase()
    if (t.includes('seller') && !t.includes('buyer')) { skipped.push({ cid: r.cid, nm, reason: 'seller' }); continue }
    if (c.hub_text_opt_out) { skipped.push({ cid: r.cid, nm, reason: 'opted out' }); continue }
    if (isStopStatus(c.status)) { skipped.push({ cid: r.cid, nm, reason: 'status ' + c.status }); continue }
    if (isExcludedFromAutopilot(c)) { skipped.push({ cid: r.cid, nm, reason: 'excluded list' }); continue }
    if (!c.phone) { skipped.push({ cid: r.cid, nm, reason: 'no phone' }); continue }
    enroll.push({ cid: r.cid, nm, first_at: r.first_at })
  }
  if (dryRun) return res.json({ would_enroll: enroll.length, skipped_count: skipped.length, enroll, skipped })
  let done = 0
  for (const e of enroll) { setManaged(e.cid, true); setEnabled(e.cid, true); enrollColdBuyerSequence(e.cid, { fromStage: 1, anchorIso: e.first_at }); done++ }
  res.json({ enrolled: done, enrolled_list: enroll.map(e => e.nm), skipped_count: skipped.length, skipped })
})

// PREVIEW the full templated sequence for a lead (no Claude, no send). For review.
router.post('/cold-buyer/preview-templated', async (req, res) => {
  const cid = Number(req.body?.client_id)
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return res.status(404).json({ error: 'client not found' })
  const { COLD_BUYER_STAGES } = await import('../ai-followup/prompts.js')
  const out = []
  for (let i = 0; i < COLD_BUYER_STAGES.length; i++) {
    const stage = COLD_BUYER_STAGES[i]
    const bank = stage.messages || []
    if (!bank.length) { out.push({ stage: i + 1, label: stage.label, needs_bank: true, message: '(no approved bank — currently AI-composed; needs a bank to template)' }); continue }
    const approved = bank[(cid + i) % bank.length]   // deterministic rotation for preview
    const { renderColdStageTemplate } = await import('../ai-followup/cold-template.js')
    out.push({ stage: i + 1, label: stage.label, message: await renderColdStageTemplate(i, approved, client) })
  }
  let area = ''
  try { const { fillTemplate } = await import('./email.js'); area = fillTemplate('{{city_of_interest}}', client).split(',')[0].trim() } catch {}
  res.json({ client: `${client.first_name || ''} ${client.last_name || ''}`.trim(), resolved_area: (area && !/^\d/.test(area)) ? area : 'your area', stages: out })
})

// Stagger the pending cold-buyer sends: re-time every pending AI_COLD_BUYER action so a
// same-day wave spreads across the daytime window (per-lead offset) instead of one burst.
router.post('/cold-buyer/stagger', async (req, res) => {
  const dryRun = req.body?.dry_run === true
  const { coldSendOffsetMin } = await import('../ai-followup/scheduler.js')
  const rows = db.all("SELECT id, client_id, execute_at FROM ai_scheduled_actions WHERE action_type='AI_COLD_BUYER' AND state='pending'")
  const byDay = {}
  let changed = 0
  for (const r of rows) {
    const off = coldSendOffsetMin(r.client_id)
    const nd = new Date(r.execute_at)
    nd.setUTCHours(15, 0, 0, 0); nd.setUTCMinutes(off)   // 15:00 UTC + offset = ~10am-4pm CT, same date
    const newAt = nd.toISOString()
    const day = newAt.slice(0, 10)
    byDay[day] = (byDay[day] || 0) + 1
    if (!dryRun && newAt !== r.execute_at) { db.run("UPDATE ai_scheduled_actions SET execute_at=? WHERE id=?", [newAt, r.id]); changed++ }
  }
  res.json({ dry_run: dryRun, pending_actions: rows.length, restaggered: dryRun ? 0 : changed, spread_by_day: byDay })
})

// View a lead's pending cold-buyer drip schedule (what's programmed on their account).
router.get('/lead/:id/cold-buyer', (req, res) => {
  const cid = Number(req.params.id)
  const rows = db.all("SELECT id, execute_at, state, reason, payload_json FROM ai_scheduled_actions WHERE client_id=? AND action_type='AI_COLD_BUYER' AND state IN ('pending','processing') ORDER BY execute_at ASC", [cid])
  res.json(rows.map(r => { let p = {}; try { p = JSON.parse(r.payload_json || '{}') } catch {} return { id: r.id, text_number: (Number(p.stage) || 0) + 1, execute_at: r.execute_at, state: r.state } }))
})

// ---- Today's Intelligence: morning summary + prioritized action queue (P1-4) ----
// A "what needs attention today" view driven by decayed intent + recent behavior.
router.get('/intelligence', (_req, res) => {
  try {
    const handoffs_pending = db.get("SELECT COUNT(*) n FROM ai_handoffs WHERE status='open'")?.n || 0
    const rows = db.all(`SELECT li.client_id, li.intent_score, li.intent_reason_json, li.updated_at, li.peak_intent, li.ai_summary, li.conversation_type,
        c.first_name, c.last_name, c.phone, c.type, c.source, c.status, c.hub_text_opt_out, c.sms_undeliverable, c.agent_assigned, c.lead_score
      FROM lead_intelligence li JOIN clients c ON c.id = li.client_id
      WHERE li.intent_score > 0 AND c.phone IS NOT NULL AND c.phone != ''
      ORDER BY li.intent_score DESC LIMIT 400`)
    const queue = []
    for (const r of rows) {
      if (r.hub_text_opt_out || r.sms_undeliverable || isStopStatus(r.status)) continue
      const intent = applyDecay(r.intent_score, r.updated_at)
      if (intent < 25) continue   // below NURTURE
      let reasons = []; try { reasons = JSON.parse(r.intent_reason_json || '[]') } catch {}
      const lastOut = db.get("SELECT occurred_at FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing' ORDER BY occurred_at DESC LIMIT 1", [r.client_id])?.occurred_at || null
      const lastIn = db.get("SELECT occurred_at FROM communications WHERE client_id=? AND channel='text' AND direction='incoming' ORDER BY occurred_at DESC LIMIT 1", [r.client_id])?.occurred_at || null
      const needsReply = !!(lastIn && (!lastOut || lastIn > lastOut))
      const level = levelFor(intent)
      let action = 'Follow up'
      if (needsReply) action = 'Reply — they responded'
      else if (level === 'URGENT' || level === 'HIGH') action = 'Call now'
      else if (!lastOut) action = 'Reach out'
      queue.push({
        client_id: r.client_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.phone, phone: r.phone,
        type: r.conversation_type || r.type, source: r.source, intent, peak: r.peak_intent || r.intent_score, level, reasons: reasons.slice(0, 4),
        summary: r.ai_summary || '', last_outbound: lastOut, last_inbound: lastIn, needs_reply: needsReply,
        recommended_action: action, assigned_to: r.agent_assigned || null,
      })
    }
    queue.sort((a, b) => (b.needs_reply - a.needs_reply) || (b.intent - a.intent))
    const top = queue.slice(0, 50)
    // Behavioral signals (approximate, from what we have)
    const reengaged = db.get(`SELECT COUNT(DISTINCT la.client_id) n FROM lead_activity la
      WHERE la.created_at >= datetime('now','-3 days')
      AND NOT EXISTS (SELECT 1 FROM communications co WHERE co.client_id=la.client_id AND co.direction='outgoing' AND co.occurred_at >= datetime('now','-14 days'))`)?.n || 0
    const repeat_views = db.get(`SELECT COUNT(*) n FROM (SELECT client_id FROM lead_activity WHERE created_at >= datetime('now','-14 days') GROUP BY client_id HAVING COUNT(*) >= 3)`)?.n || 0
    const seller_opps = db.get(`SELECT COUNT(*) n FROM clients WHERE (type IN ('seller','both')) AND CAST(lead_score AS INTEGER) >= 600`)?.n || 0
    res.json({
      summary: {
        needs_reply: top.filter(q => q.needs_reply).length,
        high_intent: top.filter(q => q.intent >= 70).length,
        in_queue: queue.length,
        handoffs_pending, reengaged, repeat_views, seller_opps,
      },
      queue: top,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- AI Opportunities (handoff queue) ----
router.get('/opportunities', (req, res) => {
  const status = String(req.query.status || 'open')
  const where = ['h.status = ?']; const params = [status]
  if (req.query.assigned === 'unassigned') where.push("(h.assigned_to IS NULL OR h.assigned_to = '')")
  else if (req.query.assigned) { where.push('h.assigned_to = ?'); params.push(req.query.assigned) }
  if (req.query.urgency) { where.push('h.urgency = ?'); params.push(req.query.urgency) }
  const rows = db.all(`SELECT h.*, c.first_name, c.last_name, c.phone, c.type, c.source, li.ai_summary, li.intent_level
    FROM ai_handoffs h JOIN clients c ON c.id=h.client_id LEFT JOIN lead_intelligence li ON li.client_id=h.client_id
    WHERE ${where.join(' AND ')} ORDER BY (CASE h.urgency WHEN 'urgent' THEN 0 ELSE 1 END), h.intent_score DESC, h.created_at ASC LIMIT 200`, params)
  res.json(rows.map(r => ({
    id: r.id, client_id: r.client_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.phone, phone: r.phone,
    type: r.type, source: r.source, urgency: r.urgency, reason: r.reason, summary: r.summary || r.ai_summary || '',
    recommended_action: r.recommended_action, intent_score: r.intent_score, intent_level: r.intent_level, assigned_to: r.assigned_to,
    status: r.status, created_at: r.created_at,
  })))
})
router.post('/opportunities/:id/ack', (req, res) => { db.run("UPDATE ai_handoffs SET status='acknowledged', acknowledged_at=? WHERE id=?", [nowIso(), Number(req.params.id)]); res.json({ success: true }) })
router.post('/opportunities/:id/resolve', (req, res) => { db.run("UPDATE ai_handoffs SET status='resolved', completed_at=? WHERE id=?", [nowIso(), Number(req.params.id)]); res.json({ success: true }) })

// ---- AI regression eval (P1-1): operator-triggered scenario suite + saved runs ----
router.get('/eval/scenarios', async (_req, res) => {
  const { ALL_SCENARIOS } = await import('../ai-eval/scenarios.js')
  res.json(ALL_SCENARIOS.map(s => ({ id: s.id, segment: s.segment, title: s.title })))
})
router.get('/eval/runs', async (_req, res) => { const { listRuns } = await import('../ai-eval/run.js'); res.json(listRuns(30)) })
router.get('/eval/runs/:id', async (req, res) => { const { getRun } = await import('../ai-eval/run.js'); const r = getRun(Number(req.params.id)); r ? res.json(r) : res.status(404).json({ error: 'run not found' }) })
router.post('/eval/run', async (req, res) => {
  try {
    const { runEval } = await import('../ai-eval/run.js')
    const out = await runEval({ segment: req.body?.segment, limit: req.body?.limit, model: req.body?.model })
    out.ok ? res.json(out) : res.status(400).json(out)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ---- facets: distinct tags / statuses / sources for the exclusion picker ----
let _facetCache = { at: 0, data: null }
router.get('/facets', (_req, res) => {
  if (_facetCache.data && Date.now() - _facetCache.at < 60000) return res.json(_facetCache.data)
  const statuses = db.all("SELECT status FROM clients WHERE status IS NOT NULL AND status != '' GROUP BY status ORDER BY COUNT(*) DESC").map(r => r.status)
  const sources = db.all("SELECT source FROM clients WHERE source IS NOT NULL AND source != '' GROUP BY source ORDER BY COUNT(*) DESC LIMIT 100").map(r => r.source)
  const tagCounts = new Map()
  try {
    for (const row of db.all("SELECT tags FROM clients WHERE tags IS NOT NULL AND tags != '' AND tags != '[]'")) {
      let arr = []
      try { const p = JSON.parse(row.tags); if (Array.isArray(p)) arr = p } catch { arr = String(row.tags).split(',') }
      for (let t of arr) { t = String(t).trim(); if (t) tagCounts.set(t, (tagCounts.get(t) || 0) + 1) }
    }
  } catch {}
  const tags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 400).map(([t]) => t)
  const data = { tags, statuses, sources }
  _facetCache = { at: Date.now(), data }
  res.json(data)
})

// ---- settings (flags + config) ----
router.get('/settings', (_req, res) => res.json({ flags: getFlags(), config: getConfig() }))
router.post('/settings', (req, res) => {
  const b = req.body || {}
  if (b.flags) for (const f of AI_FLAGS) if (b.flags[f] !== undefined) db.setSetting(f, b.flags[f] ? '1' : '0')
  if (b.config) for (const k of Object.keys(AI_CONFIG_DEFAULTS)) if (b.config[k] !== undefined) db.setSetting(k, String(b.config[k]))
  res.json({ success: true, flags: getFlags(), config: getConfig() })
})

// ---- quality review: recent AI messages the admin can rate ----
router.get('/quality', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const filter = String(req.query.filter || 'sends')
  const conds = [`substr(a.created_at,1,10) >= date('now','-${days} days')`]
  if (filter === 'sends') conds.push("a.action_type IN ('SEND_TEXT','PROACTIVE','NURTURE','REENGAGE') AND a.output_text IS NOT NULL AND a.output_text != ''")
  else if (filter === 'handoffs') conds.push("a.action_type='STATE_TRANSITION' AND a.ai_state_after='HUMAN_HANDOFF_REQUIRED'")
  else if (filter === 'errors') conds.push("a.status='failed'")
  else if (filter === 'rated_bad') conds.push("a.rating IN ('needs_work','incorrect','unsafe')")
  const rows = db.all(`SELECT a.id, a.client_id, a.action_type, a.output_text, a.reason, a.status, a.rating, a.created_at, a.intent_after,
      c.first_name, c.last_name FROM ai_actions a LEFT JOIN clients c ON c.id=a.client_id
      WHERE ${conds.join(' AND ')} ORDER BY a.id DESC LIMIT 100`)
  res.json(rows.map(r => ({ id: r.id, client_id: r.client_id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || '(unknown)', action_type: r.action_type, text: r.output_text, reason: r.reason, status: r.status, rating: r.rating, intent: r.intent_after, created_at: r.created_at })))
})
router.post('/actions/:id/rate', (req, res) => {
  const rating = String(req.body?.rating || '')
  if (!['good', 'needs_work', 'incorrect', 'unsafe', ''].includes(rating)) return res.status(400).json({ error: 'invalid rating' })
  db.run('UPDATE ai_actions SET rating=? WHERE id=?', [rating || null, Number(req.params.id)])
  res.json({ success: true })
})

// ---- scheduler health ----
router.get('/scheduler', (_req, res) => {
  const c = (w, p = []) => { try { return db.get(`SELECT COUNT(*) n FROM ai_scheduled_actions WHERE ${w}`, p).n } catch { return 0 } }
  const next = db.get("SELECT execute_at FROM ai_scheduled_actions WHERE state='pending' ORDER BY execute_at ASC LIMIT 1")
  res.json({ pending: c("state='pending'"), processing: c("state='processing'"), completed_24h: c("state='completed' AND completed_at >= datetime('now','-1 day')"), failed: c("state='failed'"), canceled_24h: c("state='canceled' AND completed_at >= datetime('now','-1 day')"), next_execute_at: next?.execute_at || null })
})

// ---- diagnostics ----
router.get('/diagnostics', (_req, res) => {
  const count = (t, w = '1=1', p = []) => { try { return db.get(`SELECT COUNT(*) n FROM ${t} WHERE ${w}`, p).n } catch { return null } }
  res.json({
    anthropic_configured: !!process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    flags: getFlags(), config_present: true,
    ai_states_tracked: count('ai_lead_state'),
    open_handoffs: count('ai_handoffs', "status='open'"),
    pending_scheduled: count('ai_scheduled_actions', "state='pending'"),
    failed_scheduled: count('ai_scheduled_actions', "state='failed'"),
    ai_actions_total: count('ai_actions'),
    ai_sends_24h: count('communications', "sent_by_type='ai' AND occurred_at >= datetime('now','-1 day')"),
    prompt_version: 'hubai-2026.08.20-1',
  })
})

// ---- analytics ----
router.get('/analytics', (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)
  const since = `date('now','-${days} days')`
  const c = (w, p = []) => { try { return db.get(`SELECT COUNT(*) n FROM ${w}`, p).n } catch { return 0 } }
  const aiSends = c(`communications WHERE sent_by_type='ai' AND substr(occurred_at,1,10) >= ${since}`)
  const leadsManaged = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications WHERE sent_by_type='ai' AND substr(occurred_at,1,10) >= ${since}`)?.n || 0
  const replies = db.get(`SELECT COUNT(DISTINCT client_id) n FROM communications WHERE direction='incoming' AND channel='text' AND client_id IN (SELECT DISTINCT client_id FROM communications WHERE sent_by_type='ai') AND substr(occurred_at,1,10) >= ${since}`)?.n || 0
  const handoffs = c(`ai_handoffs WHERE substr(created_at,1,10) >= ${since}`)
  const handoffsResolved = c(`ai_handoffs WHERE status IN ('acknowledged','contacted','resolved') AND substr(created_at,1,10) >= ${since}`)
  const tokIn = db.get(`SELECT SUM(tokens_input) i, SUM(tokens_output) o FROM ai_actions WHERE substr(created_at,1,10) >= ${since}`) || {}
  const highIntent = db.get(`SELECT COUNT(*) n FROM lead_intelligence WHERE intent_score >= 70`)?.n || 0
  const byDay = db.all(`SELECT substr(occurred_at,1,10) day, COUNT(*) n FROM communications WHERE sent_by_type='ai' AND substr(occurred_at,1,10) >= ${since} GROUP BY day ORDER BY day`)
  res.json({ ai_sends: aiSends, leads_managed: leadsManaged, replies, response_rate: leadsManaged ? Math.round((replies / leadsManaged) * 100) : null, handoffs, handoffs_actioned: handoffsResolved, high_intent_leads: highIntent, tokens_input: tokIn.i || 0, tokens_output: tokIn.o || 0, by_day: byDay })
})

export default router
