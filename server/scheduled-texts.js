// Scheduled one-to-one texts. A scheduler tick calls runDueScheduledTexts() every
// minute; it sends any text whose send_at has passed, AFTER re-checking compliance
// at send time (so a lead who replied STOP or was marked Do Not Contact between
// scheduling and sending is not texted). Sent messages land in the normal thread.
import db from './database.js'
import { fillTemplate } from './routes/email.js'
import { isStopStatus } from './lead-sequences.js'
import { isUsHoliday } from './holidays.js'

const nowIso = () => new Date().toISOString()
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)

// Send ONE scheduled row now (used by the minute tick when due, and by "Send now"). Re-checks
// compliance at send time. Returns { ok, sent?, comm_id?, error? / skipped? }.
export async function sendScheduledRow(s) {
  const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  try {
    const { sendSms } = await import('./twilio.js')
    const c = s.client_id ? db.get('SELECT * FROM clients WHERE id=?', [s.client_id]) : null
    const phone = (c && c.phone) || s.phone
    if (!phone || last10(phone).length < 10) { db.run("UPDATE scheduled_texts SET status='failed', error=? WHERE id=?", ['no valid phone', s.id]); return { ok: false, error: 'no valid phone' } }
    // Compliance re-check at send time.
    if (c && (c.hub_text_opt_out || isStopStatus(c.status))) { db.run("UPDATE scheduled_texts SET status='canceled', error=? WHERE id=?", ['recipient opted out / Do Not Contact at send time', s.id]); return { ok: false, skipped: 'opted out / Do Not Contact' } }
    if (c && c.sms_undeliverable) { db.run("UPDATE scheduled_texts SET status='canceled', error=? WHERE id=?", ['number is undeliverable (likely a landline)', s.id]); return { ok: false, skipped: 'number undeliverable' } }
    // Collision guard (light): don't fire over a live AI/human handoff.
    if (c) {
      const st = db.get('SELECT ai_state FROM ai_lead_state WHERE client_id=?', [c.id])
      const pendingAi = db.get("SELECT id FROM ai_scheduled_actions WHERE client_id=? AND state='pending' LIMIT 1", [c.id])
      if ((st && ['HUMAN_TAKEOVER', 'HUMAN_HANDOFF_REQUIRED'].includes(st.ai_state)) || pendingAi) {
        db.run("UPDATE scheduled_texts SET status='canceled', error=? WHERE id=?", ['skipped: AI or a human is actively handling this lead', s.id]); return { ok: false, skipped: 'AI/human is handling this lead' }
      }
    }
    const media = (() => { try { return JSON.parse(s.media_url || '[]') } catch { return [] } })()
    const outText = c ? fillTemplate(s.body || '', c).replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim() : String(s.body || '').trim()
    if (!outText && !media.length) { db.run("UPDATE scheduled_texts SET status='failed', error=? WHERE id=?", ['empty message', s.id]); return { ok: false, error: 'empty message' } }
    const r = await sendSms(phone, outText, { statusCallback: hub + '/api/inbox/twilio-status', mediaUrls: media.map(m => m.url || m) })
    const name = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : phone
    const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, has_attachment, media_url, delivery_status, agent, occurred_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['text', 'outgoing', c ? c.id : null, name, '', phone, (outText || `[${media.length} photo]`).slice(0, 160), outText, 'twilio_' + r.sid,
        c ? `c${c.id}_text` : `u_${last10(phone)}`, 'read', media.length ? 1 : 0, media.length ? JSON.stringify(media) : null, r.status || 'queued',
        s.created_by ? `scheduled:${s.created_by}` : 'scheduled', nowIso()])
    db.run("UPDATE scheduled_texts SET status='sent', sent_comm_id=? WHERE id=?", [ins.lastInsertRowid, s.id])
    return { ok: true, sent: true, comm_id: ins.lastInsertRowid }
  } catch (e) {
    db.run("UPDATE scheduled_texts SET status='failed', error=? WHERE id=?", [String(e.message || e).slice(0, 300), s.id])
    try { const { recordFailure } = await import('./failures.js'); recordFailure('sms', { ref: s.client_id, summary: 'Scheduled text failed to send', error: e.message }) } catch {}
    return { ok: false, error: e.message }
  }
}

export async function runDueScheduledTexts() {
  let due
  try { due = db.all("SELECT * FROM scheduled_texts WHERE status='scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 50", [nowIso()]) }
  catch { return }
  if (!due || !due.length) return
  if (isUsHoliday()) return   // US holiday — leave them scheduled; they'll fire the next non-holiday tick
  const { twilioConfigured } = await import('./twilio.js')
  if (!twilioConfigured()) return   // leave them scheduled; try again next tick
  for (const s of due) {
    await sendScheduledRow(s)
    await new Promise(rs => setTimeout(rs, 400))   // gentle pacing
  }
}

// Send a specific scheduled text immediately (the "Send now" button). Ignores send_at.
export async function sendScheduledNow(id) {
  const s = db.get("SELECT * FROM scheduled_texts WHERE id=? AND status='scheduled'", [Number(id)])
  if (!s) return { ok: false, error: 'not found or already sent/canceled' }
  const { twilioConfigured } = await import('./twilio.js')
  if (!twilioConfigured()) return { ok: false, error: 'texting is not connected' }
  return sendScheduledRow(s)
}
