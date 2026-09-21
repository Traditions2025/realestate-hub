// CALL INTELLIGENCE (John, 2026-09-21): FUB-style transcript + AI summary on
// every recorded call.
//
// Pipeline: call ends → the existing /api/voice/recording webhook stores the
// dual-channel recording on the call's communications row and QUEUES it here →
// Twilio Conversational Intelligence transcribes it (same Twilio account, no
// new vendor; dual-channel = real speaker attribution) → a 2-minute poller
// collects finished transcripts → Claude writes the bullet summary + key
// details + suggested tasks → both land on the call row (transcript,
// call_summary) where the profile + Inbox render them, and the team gets a
// notification.
//
// Guardrails: only calls with recordings >= MIN_SECONDS (no hangup stubs);
// master switch call_intel_enabled (on unless '0'); transcription failures mark
// the row 'failed' and never retry-loop; suggested tasks are DISPLAYED, never
// auto-created.
import db from './database.js'

const nowIso = () => new Date().toISOString()
const MIN_SECONDS = 20

export function callIntelEnabled() { return (db.getSetting?.('call_intel_enabled') ?? '1') !== '0' }

export function initCallIntel() {
  for (const [col, type] of [['intel_sid', 'TEXT'], ['intel_status', 'TEXT'], ['call_summary', 'TEXT']]) {
    try { db.run(`ALTER TABLE communications ADD COLUMN ${col} ${type}`) } catch {}
  }
  try { db.run("CREATE INDEX IF NOT EXISTS idx_comm_intel ON communications(intel_status) WHERE intel_status IS NOT NULL") } catch {}
}

function twilioCreds() {
  return {
    sid: (db.getSetting('twilio_account_sid', '') || '').trim(),
    token: (db.getSetting('twilio_auth_token', '') || '').trim(),
  }
}
function authHeader() {
  const c = twilioCreds()
  if (!c.sid || !c.token) return null
  return 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64')
}

// One-time: a Conversational Intelligence service on the existing account.
export async function ensureIntelService() {
  let sid = db.getSetting?.('twilio_intelligence_service_sid')
  if (sid) return sid
  const auth = authHeader()
  if (!auth) throw new Error('Twilio not configured')
  // Reuse if it already exists (idempotent across DB restores).
  const list = await fetch('https://intelligence.twilio.com/v2/Services?PageSize=50', { headers: { Authorization: auth } }).then(r => r.json()).catch(() => ({}))
  const existing = (list.services || []).find(s => s.unique_name === 'hub-call-intel')
  if (existing) { db.setSetting?.('twilio_intelligence_service_sid', existing.sid); return existing.sid }
  const params = new URLSearchParams({ UniqueName: 'hub-call-intel', FriendlyName: 'Matt Smith Team Hub call transcripts' })
  const r = await fetch('https://intelligence.twilio.com/v2/Services', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.sid) throw new Error('Intelligence service create failed: ' + (j.message || r.status))
  db.setSetting?.('twilio_intelligence_service_sid', j.sid)
  return j.sid
}

// Queue transcription for one call row (called from the recording webhook and
// the manual backfill endpoint). Skips voicemails (they already transcribe),
// short recordings, and rows already queued/done.
export async function queueTranscription(commId, { force = false } = {}) {
  initCallIntel()
  if (!callIntelEnabled()) return { skipped: 'disabled' }
  const m = db.get('SELECT * FROM communications WHERE id = ?', [Number(commId)])
  if (!m) return { skipped: 'no row' }
  if (m.channel !== 'call' || !m.recording_sid) return { skipped: 'not a recorded call' }
  if (!force && m.intel_status && m.intel_status !== 'failed') return { skipped: 'already ' + m.intel_status }
  if (!force && Number(m.duration_sec || 0) > 0 && Number(m.duration_sec) < MIN_SECONDS) return { skipped: 'too short' }
  const auth = authHeader()
  if (!auth) return { skipped: 'twilio not configured' }
  const serviceSid = await ensureIntelService()
  const params = new URLSearchParams({
    ServiceSid: serviceSid,
    Channel: JSON.stringify({ media_properties: { source_sid: m.recording_sid } }),
  })
  const r = await fetch('https://intelligence.twilio.com/v2/Transcripts', { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' }, body: params })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.sid) {
    db.run("UPDATE communications SET intel_status = 'failed' WHERE id = ?", [m.id])
    return { error: j.message || ('HTTP ' + r.status) }
  }
  db.run("UPDATE communications SET intel_sid = ?, intel_status = 'queued' WHERE id = ?", [j.sid, m.id])
  return { ok: true, intel_sid: j.sid }
}

// Speaker labels: dual-channel recordings put the Twilio-side leg on one
// channel and the phone-side leg on the other. Which is the agent depends on
// call direction; the caller/agent mapping below matches record-from-answer-dual
// on our TwiML (channel 1 = the leg Twilio answered = agent side for outbound
// dials, caller side for inbound).
function speakerFor(channel, direction) {
  const agentChannel = direction === 'outgoing' ? 1 : 2
  return Number(channel) === agentChannel ? 'Agent (Matt Smith Team)' : 'Caller'
}

async function fetchSentences(intelSid, auth) {
  const out = []
  let url = `https://intelligence.twilio.com/v2/Transcripts/${intelSid}/Sentences?PageSize=200`
  for (let i = 0; i < 10 && url; i++) {
    const j = await fetch(url, { headers: { Authorization: auth } }).then(r => r.json()).catch(() => ({}))
    for (const s of (j.sentences || [])) out.push({ channel: s.media_channel, text: s.transcript })
    url = j.meta?.next_page_url || null
  }
  return out
}

async function summarize(transcript, clientName) {
  try {
    const { getAiClient, AI_MODEL } = await import('./routes/followup.js')
    const ai = getAiClient()
    if (!ai) return null
    const resp = await ai.messages.create({
      model: AI_MODEL, max_tokens: 700,
      system: 'You summarize real estate phone calls for the Matt Smith Team CRM (Cedar Rapids, Iowa). Be factual and concise; never invent details not in the transcript. Plain text only, no markdown headers.',
      messages: [{ role: 'user', content: `Summarize this call with ${clientName || 'a lead'}. Format EXACTLY as:\n\nSUMMARY:\n- (3-6 short bullets: situation, motivation, timeline, price/finance facts, objections, agreement reached)\n\nKEY DETAILS:\n- (bullet list of concrete facts worth saving: addresses, prices, timeframes, preferences)\n\nSUGGESTED TASKS:\n- (1-3 concrete follow-up actions the agent agreed to or should take)\n\nTRANSCRIPT:\n${transcript.slice(0, 24000)}` }],
    })
    return (resp.content?.[0]?.text || '').trim() || null
  } catch (e) { console.error('[call-intel] summary error:', e.message); return null }
}

// 2-minute poller: collect finished transcripts, write transcript + summary.
let polling = false
export async function pollCallIntelligence() {
  if (!callIntelEnabled() || polling) return { skipped: true }
  polling = true
  try {
    initCallIntel()
    const auth = authHeader()
    if (!auth) return { skipped: 'twilio not configured' }
    const pending = db.all("SELECT id, intel_sid, direction, client_id, contact_name FROM communications WHERE intel_status IN ('queued','in-progress') AND intel_sid IS NOT NULL LIMIT 10")
    const out = { checked: pending.length, completed: 0, failed: 0 }
    for (const m of pending) {
      const t = await fetch(`https://intelligence.twilio.com/v2/Transcripts/${m.intel_sid}`, { headers: { Authorization: auth } }).then(r => r.json()).catch(() => ({}))
      const status = t.status || 'unknown'
      if (['queued', 'in-progress'].includes(status)) {
        if (status !== 'queued') db.run("UPDATE communications SET intel_status = 'in-progress' WHERE id = ?", [m.id])
        continue
      }
      if (status !== 'completed') {
        db.run("UPDATE communications SET intel_status = 'failed' WHERE id = ?", [m.id])
        out.failed++
        continue
      }
      const sentences = await fetchSentences(m.intel_sid, auth)
      const transcript = sentences.map(s => `${speakerFor(s.channel, m.direction)}: ${s.text}`).join('\n')
      const name = m.contact_name || (m.client_id ? `${db.get('SELECT first_name, last_name FROM clients WHERE id=?', [m.client_id])?.first_name || ''}`.trim() : '') || 'the caller'
      const summary = transcript.length > 40 ? await summarize(transcript, name) : null
      db.run("UPDATE communications SET transcript = ?, call_summary = ?, intel_status = 'completed' WHERE id = ?", [transcript || null, summary, m.id])
      out.completed++
      if (m.client_id) {
        try {
          const { notify } = await import('./notifications.js')
          notify({ type: 'call_intel', title: `Call summary ready: ${name}`, body: (summary || transcript).split('\n').slice(0, 3).join(' ').slice(0, 120), link: `/clients/${m.client_id}`, client_id: m.client_id, dedupKey: `intel_${m.id}` })
        } catch {}
      }
    }
    return out
  } finally { polling = false }
}
