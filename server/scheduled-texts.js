// Scheduled one-to-one texts. A scheduler tick calls runDueScheduledTexts() every
// minute; it sends any text whose send_at has passed, AFTER re-checking compliance
// at send time (so a lead who replied STOP or was marked Do Not Contact between
// scheduling and sending is not texted). Sent messages land in the normal thread.
import db from './database.js'
import { fillTemplate } from './routes/email.js'
import { isStopStatus } from './lead-sequences.js'

const nowIso = () => new Date().toISOString()
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10)

export async function runDueScheduledTexts() {
  let due
  try { due = db.all("SELECT * FROM scheduled_texts WHERE status='scheduled' AND send_at <= ? ORDER BY send_at ASC LIMIT 50", [nowIso()]) }
  catch { return }
  if (!due || !due.length) return
  const { sendSms, twilioConfigured } = await import('./twilio.js')
  if (!twilioConfigured()) return   // leave them scheduled; try again next tick
  const hub = process.env.HUB_BASE_URL || 'https://realestate-hub-1rzu.onrender.com'
  for (const s of due) {
    try {
      const c = s.client_id ? db.get('SELECT * FROM clients WHERE id=?', [s.client_id]) : null
      const phone = (c && c.phone) || s.phone
      if (!phone || last10(phone).length < 10) { db.run("UPDATE scheduled_texts SET status='failed', error=? WHERE id=?", ['no valid phone', s.id]); continue }
      // Compliance re-check at send time.
      if (c && (c.hub_text_opt_out || isStopStatus(c.status))) { db.run("UPDATE scheduled_texts SET status='canceled', error=? WHERE id=?", ['recipient opted out / Do Not Contact at send time', s.id]); continue }
      const media = (() => { try { return JSON.parse(s.media_url || '[]') } catch { return [] } })()
      const outText = c ? fillTemplate(s.body || '', c).replace(/\{\{[^}]+\}\}/g, '').replace(/[ \t]{2,}/g, ' ').trim() : String(s.body || '').trim()
      if (!outText && !media.length) { db.run("UPDATE scheduled_texts SET status='failed', error=? WHERE id=?", ['empty message', s.id]); continue }
      const r = await sendSms(phone, outText, { statusCallback: hub + '/api/inbox/twilio-status', mediaUrls: media.map(m => m.url || m) })
      const name = c ? `${c.first_name || ''} ${c.last_name || ''}`.trim() : phone
      const ins = db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, preview, body, external_id, thread_key, status, has_attachment, media_url, delivery_status, agent, occurred_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ['text', 'outgoing', c ? c.id : null, name, '', phone, (outText || `[${media.length} photo]`).slice(0, 160), outText, 'twilio_' + r.sid,
          c ? `c${c.id}_text` : `u_${last10(phone)}`, 'read', media.length ? 1 : 0, media.length ? JSON.stringify(media) : null, r.status || 'queued',
          s.created_by ? `scheduled:${s.created_by}` : 'scheduled', nowIso()])
      db.run("UPDATE scheduled_texts SET status='sent', sent_comm_id=? WHERE id=?", [ins.lastInsertRowid, s.id])
      await new Promise(rs => setTimeout(rs, 400))   // gentle pacing
    } catch (e) {
      db.run("UPDATE scheduled_texts SET status='failed', error=? WHERE id=?", [String(e.message || e).slice(0, 300), s.id])
    }
  }
}
