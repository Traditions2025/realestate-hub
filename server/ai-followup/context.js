// HUB AI — build a bounded decision context for a lead. Never dumps a lifetime
// transcript: recent messages + structured memory + rolling summary + light behavior.
import db from '../database.js'
import { ensureState } from './state.js'
import { getIntent } from './intent.js'
import { getConfig } from './flags.js'

// The team's time-of-day greeting, strictly in Central time (CST/CDT).
export function centralGreeting(now = new Date()) {
  try {
    let h = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour12: false, hour: '2-digit' }).format(now), 10)
    if (h === 24) h = 0
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  } catch { return 'Hi' }
}

const stripHtml = (s) => String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + '…' : t }

export function buildLeadAiContext(clientId) {
  const cid = Number(clientId)
  const client = db.get('SELECT * FROM clients WHERE id=?', [cid])
  if (!client) return null
  const state = ensureState(cid)
  const li = db.get('SELECT * FROM lead_intelligence WHERE client_id=?', [cid]) || {}
  const intent = getIntent(cid)
  const cfg = getConfig()

  const msgs = db.all(`SELECT direction, channel, sent_by_type, subject, body, preview, occurred_at
    FROM communications WHERE client_id=? AND channel IN ('text','email','call','voicemail')
    ORDER BY occurred_at DESC LIMIT 14`, [cid]).reverse()
  const transcript = msgs.map(m => {
    const who = m.direction === 'outgoing' ? (m.sent_by_type === 'ai' ? 'AI (team assistant)' : 'Team') : 'Consumer'
    const when = String(m.occurred_at || '').slice(0, 16).replace('T', ' ')
    const text = m.channel === 'email' ? stripHtml(m.body || m.preview) : (m.body || m.preview || `(${m.channel})`)
    return `[${when}] ${who}: ${clip(text, 600)}`
  }).join('\n')
  const latestInbound = [...msgs].reverse().find(m => m.direction === 'incoming')
  const priorOutText = db.get("SELECT id FROM communications WHERE client_id=? AND channel='text' AND direction='outgoing' LIMIT 1", [cid])
  const isFirstText = !priorOutText

  let behavior = []
  try {
    behavior = db.all(`SELECT event_type, listing_mls, page_title, created_at FROM lead_activity WHERE client_id=? ORDER BY id DESC LIMIT 6`, [cid])
      .map(a => `${a.event_type}${a.listing_mls ? ' ' + a.listing_mls : ''}${a.page_title ? ' (' + clip(a.page_title, 40) + ')' : ''}`)
  } catch {}
  // FUB property views (the freshest interest signal) → city of search + last property.
  let fubViews = []
  try { fubViews = db.all(`SELECT prop_street, prop_city, prop_mls, occurred_at FROM fub_activity WHERE client_id=? ORDER BY occurred_at DESC, id DESC LIMIT 5`, [cid]) } catch {}
  const lastViewed = fubViews[0]
  const searchCity = (lastViewed && lastViewed.prop_city) || (String(li.preferred_cities || '').split(',').map(s => s.trim()).filter(Boolean)[0]) || client.city || null
  const lastViewedProperty = lastViewed ? [lastViewed.prop_street, lastViewed.prop_city].filter(Boolean).join(', ') : (li.last_property_discussed || null)
  // Time-of-day greeting — ALWAYS Central (America/Chicago = CST/CDT). Never the
  // contact's timezone, never server UTC. The team + leads are all Central.
  const timeGreeting = centralGreeting()

  const facts = {
    contact: { name: `${client.first_name || ''} ${client.last_name || ''}`.trim(), city: client.city || null, type: client.type || null },
    assigned_agent: client.agent_assigned || cfg.ai_default_owner,
    lead_source: client.source || null,
    crm_status: client.status || null,
    ai_state: state?.ai_state || null,
    registered: client.created_at || null,
    intent: { score: intent.score, level: intent.level, reasons: intent.reasons },
    intelligence: {
      lead_type: li.lead_type || client.type || null,
      price_min: li.price_min || null, price_max: li.price_max || null,
      preferred_cities: li.preferred_cities || null, bedrooms_min: li.bedrooms_min || null,
      bathrooms_min: li.bathrooms_min || null, property_types: li.property_types || null,
      buying_timeframe: li.buying_timeframe || null, selling_timeframe: li.selling_timeframe || null,
      preapproved: li.preapproved, needs_to_sell_first: li.needs_to_sell_first,
      working_with_agent: li.working_with_agent,
      seller_property_address: li.seller_property_address || null, seller_motivation: li.seller_motivation || null,
      must_haves: li.must_haves || null, deal_breakers: li.deal_breakers || null,
      last_property_discussed: li.last_property_discussed || null,
    },
    rolling_summary: li.ai_summary || null,
    recent_website_activity: behavior,
    now: new Date().toISOString(),
    team_area: 'Cedar Rapids / Marion, Iowa (Linn County)',
    is_first_text: isFirstText,
    time_greeting: timeGreeting,
    search_city: searchCity,
    last_viewed_property: lastViewedProperty,
    recent_properties_viewed: fubViews.map(v => [v.prop_street, v.prop_city, v.prop_mls].filter(Boolean).join(' ')).filter(Boolean),
  }
  return { client, state, intelligence: li, lead_type: li.lead_type || client.type || 'buyer', persona: cfg.ai_persona, facts, transcript, latestInbound: latestInbound ? (latestInbound.body || latestInbound.preview) : '' }
}
