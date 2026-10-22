// WHAT TEXTING ACTUALLY COSTS, from Twilio's own billing records.
//
// John, 2026-10-22: "Is the MMS costing us more? like the group text from yesterday with
// Melena and Matt, or was that just normal texting?"
//
// Worth asking, because group texting is MMS by protocol, not by choice. Twilio's own
// words: "Group texting, or more specifically Group MMS, uses the Multimedia Messaging
// Service (MMS) protocol to exchange ordinary text messages among a group of three or more
// people." So a group text is billed as MMS even when it carries no picture at all.
//
// And a group bills PER RECIPIENT. One message to a group of two is two billed messages,
// which is the part that is easy to miss when the Hub shows it as a single row.
//
// Everything here is read-only against the Messages resource. `price` is what Twilio
// actually charged, so this reports rather than estimates. Price arrives a short while
// after the send, so the newest messages can still read null.
import { twilioConfig } from './twilio.js'

const authHeader = () => { const c = twilioConfig(); return 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64') }

export async function twilioCostBreakdown({ days = 2, limit = 200 } = {}) {
  const c = twilioConfig()
  if (!c.sid || !c.token) return { error: 'Twilio not configured' }
  const since = new Date(Date.now() - (Number(days) || 2) * 86400000).toISOString().slice(0, 10)
  const url = `https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`
    + `?DateSent%3E=${since}&PageSize=${Math.min(Number(limit) || 200, 1000)}`
  const r = await fetch(url, { headers: { Authorization: authHeader() } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) return { error: j.message || `Twilio ${r.status}` }

  const rows = (j.messages || []).map(m => ({
    sid: m.sid,
    direction: m.direction,
    to: m.to, from: m.from,
    segments: Number(m.num_segments) || 0,
    media: Number(m.num_media) || 0,
    // MMS is what Twilio BILLED as MMS. A group text with no picture still counts, which is
    // exactly the thing being asked about.
    kind: Number(m.num_media) > 0 ? 'MMS (with media)' : (String(m.sid || '').startsWith('MM') ? 'MMS (no media)' : 'SMS'),
    price: m.price === null || m.price === undefined ? null : Math.abs(Number(m.price)),
    sent: m.date_sent,
    body: String(m.body || '').replace(/\s+/g, ' ').slice(0, 60),
  }))

  const summary = {}
  for (const x of rows) {
    const k = `${x.direction} ${x.kind}`
    summary[k] = summary[k] || { count: 0, segments: 0, priced: 0, cost: 0 }
    summary[k].count++
    summary[k].segments += x.segments
    if (x.price != null) { summary[k].priced++; summary[k].cost += x.price }
  }
  for (const k of Object.keys(summary)) {
    summary[k].cost = Math.round(summary[k].cost * 10000) / 10000
    summary[k].avg_each = summary[k].priced ? Math.round((summary[k].cost / summary[k].priced) * 10000) / 10000 : null
  }
  const total = Math.round(rows.reduce((a, x) => a + (x.price || 0), 0) * 10000) / 10000
  const unpriced = rows.filter(x => x.price == null).length

  return {
    since, messages: rows.length, total_cost: total,
    not_yet_priced: unpriced,
    note: unpriced ? 'Twilio fills in price a little after the send, so the newest can read null.' : undefined,
    by_type: summary,
    rows,
  }
}
