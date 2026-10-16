// AUTO SUMMARY OF A LEAD'S CONVERSATION (John, 2026-10-16).
//
// Reading back through forty texts to work out what somebody actually said is the slowest
// part of picking up a lead, and the detail that matters is usually buried: an address, a
// number they have in their head, a tenant's lease, a spouse who has not been asked yet.
// This reads the thread and writes that down.
//
// THREE RULES THIS MODULE OBEYS, all of them learned elsewhere in this system:
//
//   1. IT CANNOT SEND ANYTHING. There is no send path in this file and nothing here is
//      reachable from one. Summarising is a read. It imports no sender, touches no
//      campaign table, and schedules nothing.
//   2. IT NEVER WRITES TO `notes`. Client notes are one hand-written field that must never
//      be machine-stamped. The summary lives in its own table and is labelled as
//      generated, so nobody mistakes it for something a person observed.
//   3. IT IS CACHED AND ONLY REGENERATES WHEN THE CONVERSATION CHANGES. A model call per
//      profile view would be money spent to re-read an unchanged thread.
//
// It is deliberately a SELLER/BUYER-AWARE summary rather than a generic one: what matters
// about a real estate lead is the property, the number, the timing and who else decides.
import db from './database.js'

const nowIso = () => new Date().toISOString()

export function initLeadSummary() {
  try {
    db.run(`CREATE TABLE IF NOT EXISTS lead_summaries (
      client_id INTEGER PRIMARY KEY,
      summary TEXT,
      headline TEXT,
      facts TEXT,              -- JSON: the structured bits, for filtering later
      model TEXT,
      message_count INTEGER,   -- what it was built from, so staleness is detectable
      last_message_at TEXT,
      generated_at TEXT,
      error TEXT
    )`)
  } catch {}
}

/** The conversation, oldest first, with the noise stripped out. */
export function conversationFor(clientId, { max = 120 } = {}) {
  const cid = Number(clientId)
  if (!Number.isFinite(cid)) return []
  let rows = []
  try {
    rows = db.all(
      `SELECT channel, direction, body, preview, subject, sent_by_type, agent, occurred_at
         FROM communications
        WHERE client_id = ?
        ORDER BY occurred_at DESC LIMIT ?`, [cid, max])
  } catch { return [] }
  return rows.reverse().map(r => {
    // An HTML email body is mostly markup; the subject is the useful part and the text is
    // not worth the tokens. Texts and notes come through as written.
    let text = String(r.body || r.preview || '').trim()
    const isHtml = /^\s*<|<\/(div|p|table|body)>/i.test(text)
    if (r.channel === 'email' && isHtml) text = `[email] ${String(r.subject || '').trim() || '(no subject)'}`
    else text = text.replace(/\s+/g, ' ').slice(0, 700)
    return {
      at: String(r.occurred_at || '').slice(0, 16),
      channel: r.channel,
      who: r.direction === 'incoming' ? 'LEAD' : (r.sent_by_type === 'human' ? 'US (person)' : `US (${r.sent_by_type || 'automated'})`),
      text,
    }
  }).filter(m => m.text)
}

/** Is the stored summary still describing the conversation as it stands? */
export function summaryState(clientId) {
  initLeadSummary()
  const cid = Number(clientId)
  const row = db.get('SELECT * FROM lead_summaries WHERE client_id=?', [cid]) || null
  const latest = db.get(
    `SELECT COUNT(*) n, MAX(occurred_at) last FROM communications WHERE client_id=?`, [cid]) || { n: 0, last: null }
  const stale = !row || row.message_count !== latest.n || String(row.last_message_at || '') !== String(latest.last || '')
  return { row, count: latest.n, last: latest.last, stale }
}

const SYSTEM = `You summarise a real estate lead's conversation for the agent who is about to pick it up.

Write ONE paragraph of flowing prose. No bullet points, no headings, no preamble.

Lead with what the agent most needs to know, which is usually what the person actually wants and when. Then the specifics: property addresses exactly as the lead gave them, the prices or numbers they named, their timing, their situation and motivation, anything blocking a next step (a tenant, a spouse, repairs underway, another agent), and who else is part of the decision. Finish with where the conversation was left.

Rules:
- Use ONLY what is in the transcript. Never infer a budget, a motivation or a timeline that was not said. If something important is unknown, say it is not known rather than guessing.
- Quote the lead's own words where a phrase carries meaning the paraphrase would lose.
- Distinguish what the LEAD said from what WE said. Do not report our own marketing claims back as facts about the lead.
- Plain, factual, unsentimental. No sales language, no adjectives doing work the facts should do.
- No em dashes.
- If the thread is only automated outreach with no reply, say exactly that and how many attempts.

Then return JSON only, no other text:
{"headline": "<8 words or fewer, the single most useful fact>",
 "summary": "<the paragraph>",
 "facts": {"role":"buyer|seller|investor|unclear","properties":["address as given"],"price_expectation":"<or null>","timeline":"<or null>","blockers":["..."],"decision_makers":["..."],"replied": true|false}}`

function parseJson(s) {
  const t = String(s || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(t) } catch {}
  const m = t.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

/**
 * Build (or rebuild) the summary. Returns the stored row either way.
 * `force` regenerates even when the conversation has not moved.
 */
export async function generateLeadSummary(clientId, { force = false } = {}) {
  initLeadSummary()
  const cid = Number(clientId)
  const client = db.get('SELECT id, first_name, last_name, status, type, address, city FROM clients WHERE id=? AND merged_into IS NULL', [cid])
  if (!client) return { ok: false, reason: 'no such client' }

  const st = summaryState(cid)
  if (!force && !st.stale && st.row?.summary) return { ok: true, cached: true, ...st.row }

  const convo = conversationFor(cid)
  if (!convo.length) return { ok: false, reason: 'no conversation to summarise' }

  const { getAiClient, AI_MODEL } = await import('./routes/followup.js')
  const ai = getAiClient()
  if (!ai) return { ok: false, reason: 'AI not configured (ANTHROPIC_API_KEY)' }

  // The record itself is given as context but marked, so the model does not restate a
  // stale field as if the lead had said it. Norma Walker is typed "buyer" and spent the
  // whole conversation describing two properties she is selling.
  const header = `LEAD RECORD (may be stale, the transcript wins): ${client.first_name || ''} ${client.last_name || ''}`.trim()
    + ` | status ${client.status || '?'} | typed as ${client.type || '?'}`
    + (client.address ? ` | address on file ${client.address}` : '')
  const transcript = convo.map(m => `[${m.at}] ${m.who}: ${m.text}`).join('\n')

  let out, model = AI_MODEL
  try {
    const msg = await ai.messages.create({
      model, max_tokens: 1100, system: SYSTEM,
      messages: [{ role: 'user', content: `${header}\n\nTRANSCRIPT (${convo.length} messages, oldest first):\n${transcript}\n\nReturn the JSON now.` }],
    })
    out = parseJson(msg.content?.[0]?.text || '')
  } catch (e) {
    db.run(`INSERT INTO lead_summaries (client_id, error, generated_at) VALUES (?,?,?)
            ON CONFLICT(client_id) DO UPDATE SET error=excluded.error, generated_at=excluded.generated_at`,
      [cid, String(e.message).slice(0, 300), nowIso()])
    return { ok: false, reason: 'model error: ' + e.message }
  }
  if (!out?.summary) return { ok: false, reason: 'model returned nothing usable' }

  // No em dashes, standing rule for anything we write.
  const summary = String(out.summary).replace(/\s*[—–]\s*/g, ', ').trim()
  const headline = String(out.headline || '').replace(/\s*[—–]\s*/g, ', ').trim().slice(0, 90)

  db.run(`INSERT INTO lead_summaries (client_id, summary, headline, facts, model, message_count, last_message_at, generated_at, error)
          VALUES (?,?,?,?,?,?,?,?,NULL)
          ON CONFLICT(client_id) DO UPDATE SET
            summary=excluded.summary, headline=excluded.headline, facts=excluded.facts,
            model=excluded.model, message_count=excluded.message_count,
            last_message_at=excluded.last_message_at, generated_at=excluded.generated_at, error=NULL`,
    [cid, summary, headline, JSON.stringify(out.facts || {}), model, st.count, st.last, nowIso()])

  return { ok: true, cached: false, client_id: cid, summary, headline, facts: out.facts || {}, model, message_count: st.count, generated_at: nowIso() }
}

/** The stored summary, with whether it still matches the conversation. */
export function getLeadSummary(clientId) {
  const st = summaryState(clientId)
  if (!st.row?.summary) return { ok: false, reason: st.row?.error ? 'last attempt failed: ' + st.row.error : 'not generated yet', stale: st.stale, message_count: st.count }
  let facts = {}
  try { facts = JSON.parse(st.row.facts || '{}') } catch {}
  return {
    ok: true, client_id: Number(clientId), summary: st.row.summary, headline: st.row.headline,
    facts, model: st.row.model, generated_at: st.row.generated_at,
    built_from_messages: st.row.message_count, message_count: st.count,
    stale: st.stale,
    generated: true,   // always surfaced, so the UI can label it rather than pass it off as a person's note
  }
}
