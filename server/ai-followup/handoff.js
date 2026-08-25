// HUB AI high-intent handoff → the AI Opportunities queue + agent notification.
import db from '../database.js'
import { transitionAiState, pauseAi } from './state.js'
const nowIso = () => new Date().toISOString()

// Create a handoff (deduped: one open handoff per client). Pauses autonomous
// qualification and notifies the assigned agent (email/Slack via notifyAgent).
export function createAiHandoff(clientId, { reason, urgency = 'high', summary = '', recommended_action = '', intent_score = null } = {}) {
  const cid = Number(clientId); if (!cid) return null
  const c = db.get('SELECT id, first_name, last_name, agent_assigned FROM clients WHERE id=?', [cid])
  if (!c) return null
  const existing = db.get("SELECT id FROM ai_handoffs WHERE client_id=? AND status='open' ORDER BY id DESC LIMIT 1", [cid])
  if (existing) {
    db.run('UPDATE ai_handoffs SET reason=?, urgency=?, summary=?, recommended_action=?, intent_score=? WHERE id=?',
      [reason, urgency, summary, recommended_action, intent_score, existing.id])
    return existing.id
  }
  const r = db.run(`INSERT INTO ai_handoffs (client_id, assigned_to, urgency, reason, summary, recommended_action, intent_score, status, created_at)
                    VALUES (?,?,?,?,?,?,?,?,?)`,
    [cid, c.agent_assigned || null, urgency, reason, summary, recommended_action, intent_score, 'open', nowIso()])
  // Pause autonomous qualification; a human should take it from here.
  transitionAiState(cid, 'HUMAN_HANDOFF_REQUIRED', reason || 'high intent')
  notifyHandoff(c, { reason, urgency, summary, intent_score }).catch(() => {})
  // P2-4: in-app notification for the handoff.
  try { import('../notifications.js').then(m => m.notify({ type: 'handoff', title: `⚑ Handoff: ${`${c.first_name || ''} ${c.last_name || ''}`.trim() || 'lead'}`, body: reason || summary || 'High intent', link: `/clients?open=${cid}`, client_id: cid, dedupKey: 'handoff_' + r.lastInsertRowid })).catch(() => {}) } catch {}
  return r.lastInsertRowid
}

async function notifyHandoff(client, { reason, urgency, summary, intent_score }) {
  try {
    const { sendViaSendGrid } = await import('../routes/email.js')
    const to = db.getSetting('inbox_notify_email', 'johnwithmattsmithteam@gmail.com') || ''
    if (!to) return
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim() || 'A lead'
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a;line-height:1.5;">
      <p style="margin:0 0 8px;"><strong>🤖 HUB AI ${esc((urgency || '').toUpperCase())} handoff</strong></p>
      <p style="margin:0 0 4px;"><strong>${esc(name)}</strong>${intent_score != null ? ` · intent ${intent_score}` : ''}</p>
      <p style="margin:6px 0;"><strong>Why:</strong> ${esc(reason)}</p>
      ${summary ? `<p style="margin:6px 0;background:#f1f5f9;padding:10px 12px;border-radius:8px;">${esc(summary)}</p>` : ''}
      <p style="margin:6px 0 0;color:#64748b;font-size:12px;">Open AI Opportunities in the Hub to take over.</p></div>`
    await sendViaSendGrid(to, 'Matt Smith Team', `AI handoff: ${name}`, html, null, [], [], [], 'ai_handoff')
  } catch {}
  try { const { postSlack } = await import('../slack.js'); if (postSlack) await postSlack(`🤖 HUB AI handoff (${urgency}): ${client.first_name || ''} ${client.last_name || ''} — ${reason}`) } catch {}
}
