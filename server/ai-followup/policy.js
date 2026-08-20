// HUB AI — centralized communication policy. EVERY outbound path (manual, bulk,
// scheduled, automation, AI) should ultimately consult these. STOP-to-our-number
// (hub_text_opt_out) and do_not_text are independent from do_not_call. Autonomous
// AI adds further gates (per-lead AI enable, pause, global flag). Returns a
// decision object with an auditable reason.
import db from '../database.js'
import { isStopStatus } from '../lead-sequences.js'

const nowIso = () => new Date().toISOString()
export const phoneKey = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 10 ? d.slice(-10) : null }

// Ensure a communication_preferences row exists; seed it from the client record.
export function ensurePrefs(client) {
  const cid = client?.id
  if (!cid) return null
  let p = db.get('SELECT * FROM communication_preferences WHERE client_id=?', [cid])
  if (!p) {
    // Seed: a STOP on file (hub_text_opt_out) starts opted_out; else unknown.
    const optedOut = !!client.hub_text_opt_out
    db.run(`INSERT OR IGNORE INTO communication_preferences (client_id, phone_e164, sms_status, do_not_text, created_at, updated_at)
            VALUES (?,?,?,?,?,?)`,
      [cid, client.phone || null, optedOut ? 'opted_out' : 'unknown', 0, nowIso(), nowIso()])
    p = db.get('SELECT * FROM communication_preferences WHERE client_id=?', [cid])
  }
  return p
}

// Decision for an outbound SMS. context.channel: 'manual'|'bulk'|'automation'|'ai'.
export function canSendSms(client, context = {}) {
  const channel = context.channel || 'manual'
  if (!client) return deny('no client')
  if (!client.phone || !phoneKey(client.phone)) return deny('no valid phone on file')
  const p = ensurePrefs(client)
  // Hard blocks that apply to EVERY channel:
  if (client.hub_text_opt_out) return deny('replied STOP to our number')          // legacy hard block
  if (p?.do_not_text) return deny('do_not_text is set')
  if (p?.sms_status === 'opted_out') return deny('SMS opted out')
  if (p?.sms_status === 'blocked') return deny('SMS blocked')
  // Campaign-style + AI channels also exclude Do Not Contact / Junk status:
  if (channel !== 'manual' && isStopStatus(client.status)) return deny(`lead status ${client.status}`)
  // AI-specific gates — skipped for a manual agent-triggered send (context.force),
  // which only needs the hard compliance blocks above (STOP / opt-out / status).
  if (channel === 'ai' && !context.force) {
    if (getFlag('ai_followup_enabled') !== '1') return deny('AI follow-up disabled globally')
    if (getFlag('ai_responsive_text_enabled') !== '1' && context.mode === 'responsive') return deny('responsive AI disabled')
    if (getFlag('ai_proactive_text_enabled') !== '1' && context.mode === 'proactive') return deny('proactive AI disabled')
    if (p && p.ai_text_enabled === 0) return deny('AI text disabled for this contact')
    if (p && p.ai_followup_paused) return deny('AI paused for this contact')
    const st = db.get('SELECT ai_enabled, ai_pause_until, ai_state FROM ai_lead_state WHERE client_id=?', [client.id])
    if (st && st.ai_enabled === 0) return deny('AI disabled for this contact')
    if (st && st.ai_pause_until && st.ai_pause_until > nowIso()) return deny('AI paused until ' + st.ai_pause_until)
    if (st && ['HUMAN_TAKEOVER', 'DO_NOT_TEXT', 'NOT_INTERESTED', 'AI_DISABLED', 'CLOSED_CONVERTED'].includes(st.ai_state)) return deny('AI state ' + st.ai_state)
  }
  return { ok: true, reason: `${channel} send allowed` }
}

// Decision for an outbound VOICE call. Independent of texting permission.
export function canAiCall(client, context = {}) {
  if (!client) return deny('no client')
  if (!client.phone || !phoneKey(client.phone)) return deny('no valid phone on file')
  const p = ensurePrefs(client)
  if (p?.do_not_call) return deny('do_not_call is set')
  if (isStopStatus(client.status)) return deny(`lead status ${client.status}`)
  if (getFlag('ai_voice_enabled') !== '1') return deny('AI voice disabled globally')
  if (p && p.ai_voice_enabled === 0) return deny('AI voice disabled for this contact')
  if (p && p.voice_consent_status === 'opted_out') return deny('voice opted out')
  return { ok: true, reason: 'AI call allowed' }
}

// STOP / START from our number flows here (keeps the two channels independent):
// STOP sets sms opted_out + hub_text_opt_out; it does NOT set do_not_call.
export function applyOptOut(clientId, kind, source = 'sms_reply') {
  const cid = Number(clientId); if (!cid) return
  const c = db.get('SELECT id, phone, hub_text_opt_out FROM clients WHERE id=?', [cid]); if (!c) return
  ensurePrefs(c)
  if (kind === 'stop') {
    db.run('UPDATE clients SET hub_text_opt_out=1, updated_at=? WHERE id=?', [nowIso(), cid])
    db.run(`UPDATE communication_preferences SET sms_status='opted_out', sms_opt_out_timestamp=?, sms_opt_out_source=?, updated_at=? WHERE client_id=?`, [nowIso(), source, nowIso(), cid])
  } else if (kind === 'start') {
    db.run('UPDATE clients SET hub_text_opt_out=0, updated_at=? WHERE id=?', [nowIso(), cid])
    db.run(`UPDATE communication_preferences SET sms_status='eligible', sms_opt_in_timestamp=?, updated_at=? WHERE client_id=?`, [nowIso(), nowIso(), cid])
  }
}

function deny(reason) { return { ok: false, reason } }
function getFlag(key) { try { return db.getSetting(key, '0') } catch { return '0' } }
