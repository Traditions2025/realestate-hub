import { Router } from 'express'
import db from '../database.js'
import { SMART_LIST_SQL } from './clients.js'
import { fetchTodaysDeadlines } from '../daily-reminders.js'

// ---- Central-time day boundaries. occurred_at is stored as UTC ISO, so "today" counts must
// use the America/Chicago day window, never the raw UTC date. ----
function ctWindow() {
  const now = new Date()
  const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const pad = (n) => String(n).padStart(2, '0')
  const day = `${ct.getFullYear()}-${pad(ct.getMonth() + 1)}-${pad(ct.getDate())}`
  const offsetMs = now.getTime() - ct.getTime()
  const startUtc = new Date(Date.parse(day + 'T00:00:00Z') + offsetMs).toISOString()
  const endUtc = new Date(Date.parse(day + 'T00:00:00Z') + offsetMs + 86400000).toISOString()
  const monthStart = `${ct.getFullYear()}-${pad(ct.getMonth() + 1)}-01`
  const monthStartUtc = new Date(Date.parse(monthStart + 'T00:00:00Z') + offsetMs).toISOString()
  const yearStart = `${ct.getFullYear()}-01-01`
  return { ct, day, startUtc, endUtc, monthStart, monthStartUtc, yearStart }
}
// Every command-center block is isolated: one failing query never takes the dashboard down.
const safe = (fn, fallback) => { try { return fn() } catch (e) { console.error('[dashboard]', e.message); return fallback } }

const router = Router()

// closing_date is stored in BOTH 'YYYY-MM-DD' and 'M/D/YYYY' forms, so the old SQL string
// compare ('8/15/2026' >= '2026-09-01' is lexicographically TRUE) badly over-counted "this
// month". Parse both formats in JS and bound to the actual calendar month/year (Central).
function parseTxDate(s) {
  if (!s) return null
  s = String(s).trim()
  let d = null
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) d = new Date(s.slice(0, 10) + 'T12:00:00')
  else if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { const [m, dd, y] = s.split('/'); d = new Date(+y, +m - 1, +dd, 12) }
  else { d = new Date(s) }
  return isNaN(d?.getTime()) ? null : d
}
const txPrice = (p) => { const n = parseFloat(String(p == null ? '' : p).replace(/[^0-9.]/g, '')); return isNaN(n) ? 0 : n }
function closedStats() {
  const rows = db.all("SELECT closing_date, purchase_price FROM transactions WHERE property_status = 'Closed'")
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }))
  const y = now.getFullYear(), m = now.getMonth()
  let closedMonth = 0, monthVolume = 0, closedYear = 0, yearVolume = 0
  for (const r of rows) {
    const d = parseTxDate(r.closing_date)
    if (!d || d.getFullYear() !== y) continue
    closedYear++; yearVolume += txPrice(r.purchase_price)
    if (d.getMonth() === m) { closedMonth++; monthVolume += txPrice(r.purchase_price) }
  }
  return { closedMonth, monthVolume, closedYear, yearVolume }
}

router.get('/', (req, res) => {
  const closed = closedStats()
  const stats = {
    transactions: {
      active: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status IN ('Active', 'Under Contract', 'Pending')").count,
      under_contract: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status = 'Under Contract'").count,
      clear_to_close: db.get("SELECT COUNT(*) as count FROM transactions WHERE property_status = 'Clear to Close'").count,
      closed_this_month: closed.closedMonth,
      total_volume: closed.monthVolume,
      closed_this_year: closed.closedYear,
      year_volume: closed.yearVolume,
      purchases: db.get("SELECT COUNT(*) as count FROM transactions WHERE type = 'purchase' AND property_status NOT IN ('Closed', 'Withdrawn', 'Expired', 'Cancelled')").count,
      listings: db.get("SELECT COUNT(*) as count FROM transactions WHERE type = 'listing' AND property_status NOT IN ('Closed', 'Withdrawn', 'Expired', 'Cancelled')").count,
    },
    comms: {
      emails_sent: db.get("SELECT COUNT(*) as count FROM communications WHERE channel = 'email' AND direction = 'outgoing'").count,
      texts_sent: db.get("SELECT COUNT(*) as count FROM communications WHERE channel = 'text' AND direction = 'outgoing'").count,
    },
    clients: {
      active_buyers: db.get("SELECT COUNT(*) as count FROM clients WHERE type IN ('buyer', 'both') AND status IN ('active', 'prime')").count,
      active_sellers: db.get("SELECT COUNT(*) as count FROM clients WHERE type IN ('seller', 'both') AND status IN ('active', 'prime')").count,
      active: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'active'").count,
      prime: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'prime'").count,
      potential: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'potential'").count,
      watch: db.get("SELECT COUNT(*) as count FROM clients WHERE status = 'watch'").count,
      total: db.get("SELECT COUNT(*) as count FROM clients").count,
    },
    tasks: {
      overdue: db.get("SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date < date('now')").count,
      due_today: db.get("SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date = date('now')").count,
      in_progress: db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'in_progress'").count,
      total_open: db.get("SELECT COUNT(*) as count FROM tasks WHERE status != 'done'").count,
    },
    projects: {
      active: db.get("SELECT COUNT(*) as count FROM projects WHERE status = 'active'").count,
    },
    pre_listings: {
      // Only ACTIVE pre-listings — exclude ones already promoted (Listed) or dropped,
      // so this matches the Pre-Listing column on the Transactions board.
      total: db.get("SELECT COUNT(*) as count FROM pre_listings WHERE status NOT IN ('Listed','Withdrawn','Cancelled','Migrated')").count,
      pending: db.get("SELECT COUNT(*) as count FROM pre_listings WHERE walkthrough = 'Pending'").count,
    },
    marketing: {
      active_campaigns: db.get("SELECT COUNT(*) as count FROM marketing WHERE status = 'active'").count,
      total_budget: db.get("SELECT COALESCE(SUM(budget), 0) as total FROM marketing WHERE status = 'active'").total,
      total_leads: db.get("SELECT COALESCE(SUM(leads_generated), 0) as total FROM marketing WHERE status = 'active'").total,
    },
    social_media: {
      scheduled: db.get("SELECT COUNT(*) as count FROM social_posts WHERE status = 'scheduled' AND scheduled_date >= date('now')").count,
      posted_this_week: db.get("SELECT COUNT(*) as count FROM social_posts WHERE status = 'posted' AND scheduled_date >= date('now', '-7 days')").count,
    },
    vendors: {
      total: db.get("SELECT COUNT(*) as count FROM vendors").count,
      preferred: db.get("SELECT COUNT(*) as count FROM vendors WHERE preferred = 1").count,
    },
    partners: {
      total: db.get("SELECT COUNT(*) as count FROM partners").count,
    },
    calendar: {
      today: db.get("SELECT COUNT(*) as count FROM calendar_events WHERE event_date = date('now')").count,
      this_week: db.get("SELECT COUNT(*) as count FROM calendar_events WHERE event_date BETWEEN date('now') AND date('now', '+7 days')").count,
    }
  }

  // Engagement metrics. Guarded so a missing table never breaks the dashboard.
  const safeCount = (sql) => { try { return db.get(sql).count } catch { return 0 } }
  stats.engagement = {
    // distinct leads currently moving through any active drip campaign
    in_drips: safeCount("SELECT COUNT(DISTINCT client_id) as count FROM drip_enrollments WHERE status = 'active'"),
    // distinct leads with a website visit in the last 24h (FUB web activity + our tracking pixel)
    website_24h: safeCount(`SELECT COUNT(DISTINCT client_id) as count FROM (
        SELECT client_id FROM fub_activity WHERE client_id IS NOT NULL AND occurred_at >= datetime('now','-1 day')
        UNION
        SELECT client_id FROM lead_activity WHERE client_id IS NOT NULL AND created_at >= datetime('now','-1 day'))`),
  }

  stats.recent_activity = db.all('SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 15')
  stats.upcoming_tasks = db.all("SELECT * FROM tasks WHERE status != 'done' ORDER BY CASE WHEN due_date < date('now') THEN 0 ELSE 1 END, due_date ASC LIMIT 10")
  stats.active_transactions = db.all(`SELECT t.*, c.first_name || ' ' || c.last_name as client_name
    FROM transactions t LEFT JOIN clients c ON t.client_id = c.id
    WHERE t.property_status IN ('Active', 'Under Contract', 'Pending', 'Clear to Close')
    ORDER BY t.closing_date ASC LIMIT 10`)
  stats.last_sierra_sync = db.get('SELECT * FROM sierra_sync_log ORDER BY synced_at DESC LIMIT 1')

  // ================= COMMAND CENTER BLOCKS (all Central-time) =================
  // Metric definitions (centralized, per HUB-SYSTEM-OVERVIEW.md):
  //   need_response      = latest text/email on the lead is INCOMING with no outgoing after it
  //                        (junk/DNC/merged excluded)
  //   ai_handoffs        = ai_handoffs rows with status='open'
  //   followups_due      = open tasks due today (CT); overdue_tasks = due before today
  //   appointments_today = calendar_events with event_date = CT today
  //   high_intent        = lead_intelligence.intent_score >= 70 (junk/DNC excluded)
  //   missed_call        = incoming call today with no duration
  //   failed_message     = delivery_status failed/undelivered today
  //   re-engaged         = activity in last 7d preceded by a 60+ day quiet gap
  const W = ctWindow()
  stats.today = { date: W.day }
  stats.todays_events = safe(() => db.all('SELECT * FROM calendar_events WHERE event_date = ? ORDER BY COALESCE(start_time, "99:99") ASC', [W.day]), [])

  // ---- Internal people are NOT leads: the team's own records (Matt Smith, John, Hunter),
  // and professional partners/vendors (closers like Cherryl, lenders, inspectors). Matched by
  // email + full name against team_agents/partners/vendors + the known internal addresses,
  // plus any record named "... Matt Smith Team". Excluded from Need Response / Attention. ----
  const internalIds = safe(() => {
    const emails = new Set(['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com', 'matt@mattsmithteam.com'])
    const names = new Set()
    try { for (const t of db.all('SELECT name FROM team_agents')) names.add(String(t.name).trim().toLowerCase()) } catch {}
    try { for (const p of db.all("SELECT name, email FROM partners")) { if (p.email) emails.add(String(p.email).trim().toLowerCase()); if (p.name) names.add(String(p.name).trim().toLowerCase()) } } catch {}
    try { for (const v of db.all("SELECT contact_name, email FROM vendors")) { if (v.email) emails.add(String(v.email).trim().toLowerCase()); if (v.contact_name) names.add(String(v.contact_name).trim().toLowerCase()) } } catch {}
    const ids = new Set()
    const rows = db.all("SELECT id, lower(trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))) nm, lower(coalesce(email,'')) em FROM clients WHERE merged_into IS NULL AND (email IS NOT NULL OR first_name IS NOT NULL)")
    for (const r of rows) {
      if ((r.em && emails.has(r.em)) || (r.nm && names.has(r.nm)) || (r.nm && r.nm.includes('matt smith team'))) ids.add(r.id)
    }
    // Anyone with a documented follow-up exclusion (internal record, represented,
    // wrong person…) never belongs in attention queues either.
    try { for (const r of db.all('SELECT id FROM clients WHERE exclude_reason IS NOT NULL')) ids.add(r.id) } catch {}
    return ids
  }, new Set())

  // ---- Need response (count + top rows with evidence) ----
  const needRowsAll = safe(() => db.all(`
    SELECT c.id, c.first_name, c.last_name, c.agent_assigned, t.li AS last_inbound_at
    FROM (SELECT client_id,
            MAX(CASE WHEN direction='incoming' THEN occurred_at END) li,
            MAX(CASE WHEN direction='outgoing' THEN occurred_at END) lo
          FROM communications WHERE client_id IS NOT NULL AND channel IN ('text','email')
          GROUP BY client_id) t
    JOIN clients c ON c.id = t.client_id
    WHERE t.li IS NOT NULL AND (t.lo IS NULL OR t.li > t.lo)
      AND c.merged_into IS NULL AND lower(coalesce(c.status,'')) NOT IN ('junk','donotcontact')
    ORDER BY t.li DESC`), [])
  // AI loop-closure filter — the same signal as the Inbox intent badge: a latest inbound
  // already classified "No Response Needed" (they just gave us the info we asked for, said
  // thanks/ok) is not attention-worthy. Classification is keyed to the latest incoming
  // message id, so an OLD label never suppresses a NEW reply.
  const classified = new Map()
  safe(() => { for (const r of db.all('SELECT client_id, intent, summary, based_on_msg_id FROM inbox_ai WHERE intent IS NOT NULL OR summary IS NOT NULL')) classified.set(r.client_id, r) })
  const _incCache = new Map()
  const latestIncMsg = (cid) => {
    if (_incCache.has(cid)) return _incCache.get(cid)
    const row = safe(() => db.get("SELECT id, body, preview FROM communications WHERE client_id=? AND direction='incoming' AND channel IN ('text','email') ORDER BY occurred_at DESC LIMIT 1", [cid]) ?? null, null)
    _incCache.set(cid, row); return row
  }
  const latestIncId = (cid) => latestIncMsg(cid)?.id ?? null
  // Deterministic loop-closers — no AI needed, and no waiting on the background
  // classifier. A reply that is NOTHING BUT the info we asked for (a bare email
  // address or phone number) or a bare acknowledgment closes the loop on its own.
  // Anything with more words falls through to the AI classification below.
  const AUTO_CLOSED = [
    /^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i,                                     // just an email address
    /^\+?[\d\s().-]{7,20}$/,                                              // just a phone number
    /^(thanks?( you| so much)?|ty|thx|ok(ay)?|sounds good|got it|perfect|great|awesome|will do|no problem|you too|anytime)[.!\s]*$/i,
    /^[\u{1F44D}\u{1F64F}\u{2764}\u{FE0F}\u{1F600}-\u{1F64F}\s]+$/u,      // just an emoji (thumbs up etc.)
  ]
  const autoClosed = (cid) => {
    const m = latestIncMsg(cid); if (!m) return false
    const body = String(m.body || m.preview || '').trim()
    return !!body && body.length <= 80 && AUTO_CLOSED.some(re => re.test(body))
  }
  // The Inbox AI sometimes labels a loop-closer with a specific intent ("Information Request"
  // for a provided email address) while its SUMMARY carries the real conclusion ("no further
  // action is needed"). Honor either — but only when keyed to the LATEST inbound message.
  const CLOSED_LOOP_RE = /no (further |additional )?(question|action|response|reply|follow[- ]?up)[^.]{0,50}(needed|required|necessary)|no (response|reply|action) (is )?(needed|required|necessary)|nothing (further )?(is )?(needed|required)|doesn'?t (need|require) a (response|reply)/i
  const noRespNeeded = (cid) => {
    const c = classified.get(cid)
    if (!c || c.based_on_msg_id !== latestIncId(cid)) return false
    if (c.intent === 'No Response Needed') return true
    return !!(c.summary && CLOSED_LOOP_RE.test(c.summary))
  }
  // Manually dismissed items ("✓ Done" on the dashboard) — keyed per item so new activity resurfaces.
  const dismissed = safe(() => new Set(db.all('SELECT type, client_id, ref FROM attention_dismissals').map(r => `${r.type}:${r.client_id}:${r.ref}`)), new Set())
  const needRows = needRowsAll.filter(r => !internalIds.has(r.id) && !autoClosed(r.id) && !noRespNeeded(r.id) && !dismissed.has(`need_response:${r.id}:${latestIncId(r.id)}`))
  // Background: classify unclassified candidates (fire-and-forget, tiny token cost) so
  // accuracy improves by the next refresh without anyone opening the Inbox first. The
  // batch must cover at least the 8 visible rows — a smaller cap starves older items
  // behind a stream of newer ones and they sit on the list unclassified for days.
  safe(() => {
    const todo = needRows.filter(r => { const c = classified.get(r.id); return !(c && c.based_on_msg_id === latestIncId(r.id)) }).slice(0, 12)
    if (todo.length) import('./inbox.js').then(m => { for (const r of todo) m.classifyLatestInbound(r.id).catch(() => {}) }).catch(() => {})
  })
  const needTop = needRows.slice(0, 8).map(r => safe(() => {
    const m = db.get("SELECT channel, preview, body FROM communications WHERE client_id=? AND direction='incoming' AND channel IN ('text','email') ORDER BY occurred_at DESC LIMIT 1", [r.id]) || {}
    const intent = db.get('SELECT intent_score FROM lead_intelligence WHERE client_id=?', [r.id])?.intent_score ?? null
    return { ...r, channel: m.channel || null, preview: String(m.preview || m.body || '').slice(0, 140), intent }
  }, r))

  // ---- Open AI handoffs ----
  const handoffs = safe(() => db.all(`SELECT h.id, h.client_id, h.reason, h.summary, h.urgency, h.recommended_action, h.intent_score, h.created_at, c.first_name, c.last_name
    FROM ai_handoffs h LEFT JOIN clients c ON c.id = h.client_id WHERE h.status='open' ORDER BY h.created_at DESC LIMIT 10`), [])
    .filter(h => !internalIds.has(h.client_id))

  // ---- Missed calls + failed messages today ----
  const missedCalls = safe(() => db.all(`SELECT co.id AS comm_id, co.client_id, co.from_addr, co.occurred_at, c.first_name, c.last_name
    FROM communications co LEFT JOIN clients c ON c.id = co.client_id
    WHERE co.channel='call' AND co.direction='incoming' AND (co.duration_sec IS NULL OR co.duration_sec = 0)
      AND co.occurred_at >= ? AND co.occurred_at < ? ORDER BY co.occurred_at DESC LIMIT 6`, [W.startUtc, W.endUtc]), [])
    .filter(m => !internalIds.has(m.client_id) && !dismissed.has(`missed_call:${m.client_id}:${m.comm_id}`))
  const failedToday = safe(() => db.get(`SELECT COUNT(*) c FROM communications WHERE direction='outgoing'
    AND delivery_status IN ('failed','undelivered') AND occurred_at >= ? AND occurred_at < ?`, [W.startUtc, W.endUtc]).c, 0)

  // ---- NEEDS YOUR ATTENTION: handoffs first, then unanswered replies, then missed calls ----
  const attention = []
  for (const h of handoffs) attention.push({ type: 'handoff', ref: String(h.id), client_id: h.client_id, name: `${h.first_name || ''} ${h.last_name || ''}`.trim() || 'Lead', reason: h.reason || 'AI handoff', detail: h.summary || h.recommended_action || '', intent: h.intent_score, urgency: h.urgency || 'high', at: h.created_at })
  for (const r of needTop) attention.push({ type: 'need_response', ref: String(latestIncId(r.id) || ''), client_id: r.id, name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Lead', reason: `Replied by ${r.channel || 'message'}, no response yet`, detail: r.preview, intent: r.intent, agent: r.agent_assigned, at: r.last_inbound_at })
  for (const m of missedCalls) attention.push({ type: 'missed_call', ref: String(m.comm_id), client_id: m.client_id, name: `${m.first_name || ''} ${m.last_name || ''}`.trim() || m.from_addr, reason: 'Missed call today', detail: '', at: m.occurred_at })
  // ---- Follow-up coverage failures: connected+ leads with NO future action. Ref is the
  // latest coverage transition event id, so dismissing one stays dismissed until the lead
  // LOSES coverage again (a new transition = a new ref = it resurfaces). ----
  safe(() => {
    const rows = db.all(`SELECT f.client_id, f.relationship_level, f.days_since_contact, f.reason, f.recommended_action, f.intent_score, f.evaluated_at,
        c.first_name, c.last_name, c.type, c.agent_assigned,
        (SELECT MAX(e.id) FROM followup_coverage_events e WHERE e.client_id = f.client_id AND e.new_status='unprotected') ev_id
      FROM followup_coverage f JOIN clients c ON c.id = f.client_id
      WHERE f.coverage_status = 'unprotected' AND f.relationship_level IN ('connected','qualified','active_opportunity','client')
        AND c.merged_into IS NULL
      ORDER BY f.intent_score DESC, f.days_since_contact DESC LIMIT 6`)
    for (const r of rows.filter(x => !internalIds.has(x.client_id))) {
      const ref = String(r.ev_id || 'cur')
      if (dismissed.has(`coverage:${r.client_id}:${ref}`)) continue
      attention.push({ type: 'coverage', ref, client_id: r.client_id,
        name: `${r.first_name || ''} ${r.last_name || ''}`.trim() || 'Lead',
        reason: `${String(r.relationship_level).replace(/_/g, ' ').toUpperCase()} ${r.type || 'lead'} — no future follow-up${r.days_since_contact != null ? ` (silent ${r.days_since_contact}d)` : ''}`,
        detail: r.recommended_action || r.reason || '', intent: r.intent_score || null, agent: r.agent_assigned, at: r.evaluated_at })
    }
  })
  stats.attention = attention.slice(0, 14)

  // ---- Task counts on the CT day ----
  const tasksToday = safe(() => db.get("SELECT COUNT(*) c FROM tasks WHERE status != 'done' AND due_date = ?", [W.day]).c, 0)
  const tasksOverdue = safe(() => db.get("SELECT COUNT(*) c FROM tasks WHERE status != 'done' AND due_date < ? AND due_date IS NOT NULL AND due_date != ''", [W.day]).c, 0)

  // ---- Action cards ----
  stats.cards = {
    need_response: needRows.length,
    ai_handoffs: handoffs.length,
    followups_due: tasksToday,
    overdue_tasks: tasksOverdue,
    appointments_today: stats.todays_events.length,
    priority_leads: new Set([...handoffs.map(h => h.client_id), ...needRows.slice(0, 50).map(r => r.id)].filter(Boolean)).size,
    new_leads_today: safe(() => db.get("SELECT COUNT(*) c FROM clients WHERE merged_into IS NULL AND substr(COALESCE(NULLIF(register_date,''), sierra_creation_date, created_at),1,10) = ?", [W.day]).c, 0),
  }

  // ---- Today's schedule: calendar events + transaction closings/walkthroughs today ----
  const schedule = stats.todays_events.map(e => ({ time: e.start_time || '', title: e.title, kind: e.event_type, location: e.location || '', link: '/calendar' }))
  safe(() => {
    for (const t of db.all("SELECT id, property_address, closing_date, final_walkthrough, property_status FROM transactions WHERE property_status NOT IN ('Closed','Cancelled','Withdrawn','Expired')")) {
      const c = parseTxDate(t.closing_date); const wd = parseTxDate(t.final_walkthrough)
      const isToday = (d) => d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === W.day
      if (isToday(c)) schedule.push({ time: '', title: 'Closing', kind: 'Closing', location: t.property_address, link: '/transactions' })
      if (isToday(wd)) schedule.push({ time: '', title: 'Final Walkthrough', kind: 'Walkthrough', location: t.property_address, link: '/transactions' })
    }
  })
  stats.schedule = schedule

  // ---- Lead pipeline (status counts + dynamic conditions) ----
  const statusCounts = {}
  safe(() => { for (const r of db.all('SELECT lower(coalesce(status,\'\')) s, COUNT(*) c FROM clients WHERE merged_into IS NULL GROUP BY 1')) statusCounts[r.s] = r.c })
  stats.pipeline = {
    prime: statusCounts.prime || 0, active: statusCounts.active || 0, new: statusCounts.new || 0,
    qualify: statusCounts.qualify || 0, watch: statusCounts.watch || 0, pending: statusCounts.pending || 0,
    high_intent: safe(() => db.get(`SELECT COUNT(*) c FROM lead_intelligence li JOIN clients c ON c.id=li.client_id
      WHERE li.intent_score >= 70 AND c.merged_into IS NULL AND lower(coalesce(c.status,'')) NOT IN ('junk','donotcontact')`).c, 0),
    need_response: needRows.length,
    ai_managed: safe(() => db.get('SELECT COUNT(*) c FROM ai_lead_state WHERE ai_managed=1 AND ai_enabled=1').c, 0),
    viewed_24h: stats.engagement.website_24h,
  }

  // ---- Prospecting (FSBO + Cancelled/Expired; surface only, never auto-contact) ----
  stats.prospecting = {
    fsbo_available: safe(() => db.get("SELECT COUNT(*) c FROM clients WHERE fsbo_status='Available' AND merged_into IS NULL AND lower(coalesce(status,'')) NOT IN ('junk','donotcontact')").c, 0),
    fsbo_aging_30: safe(() => db.get("SELECT COUNT(*) c FROM clients WHERE fsbo_status='Available' AND merged_into IS NULL AND lower(coalesce(status,'')) NOT IN ('junk','donotcontact') AND fsbo_dom IS NOT NULL AND fsbo_dom != '' AND CAST(fsbo_dom AS INTEGER) >= 30").c, 0),
    fsbo_followup_due: safe(() => db.get(`SELECT COUNT(*) c FROM clients WHERE merged_into IS NULL AND ${SMART_LIST_SQL.fsbo_dom14_no_text_2w}`).c, 0),
    cx_total: safe(() => db.get(`SELECT COUNT(*) c FROM clients WHERE merged_into IS NULL AND clients.status IN ('new','qualify','watch')
      AND (clients.tags LIKE '%"Sierra: Cancelled"%' OR clients.tags LIKE '%"Sierra: Expired"%' OR clients.tags LIKE '%"MLS: Cancelled"%' OR clients.tags LIKE '%"MLS: Expired"%')`).c, 0),
    cx_no_response: safe(() => db.get(`SELECT COUNT(*) c FROM clients WHERE merged_into IS NULL AND ${SMART_LIST_SQL.cx_no_response}`).c, 0),
  }

  // ---- Transactions: what's next + what needs action ----
  stats.tx = safe(() => {
    const open = db.all("SELECT id, property_address, closing_date, property_status FROM transactions WHERE property_status IN ('Active','Under Contract','Pending','Clear to Close')")
    const upcoming = []
    const plus7 = new Date(W.ct.getTime() + 7 * 86400000)
    for (const t of open) {
      const d = parseTxDate(t.closing_date)
      if (d && d >= new Date(W.ct.getFullYear(), W.ct.getMonth(), W.ct.getDate()) && d <= plus7) upcoming.push({ id: t.id, address: t.property_address, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`, status: t.property_status })
    }
    upcoming.sort((a, b) => a.date < b.date ? -1 : 1)
    const deadlines = safe(() => fetchTodaysDeadlines(W.day), [])
    return { open: open.length, closings_7d: upcoming.slice(0, 6), deadlines_today: deadlines.length, deadline_items: deadlines.slice(0, 5).map(d => ({ label: d.label || d.field, address: d.address || d.property_address || '' })) }
  }, { open: 0, closings_7d: [], deadlines_today: 0, deadline_items: [] })

  // ---- Opportunity radar (staff intelligence; counts + a few named examples) ----
  stats.radar = safe(() => {
    const nm = (r) => `${r.first_name || ''} ${r.last_name || ''}`.trim()
    const reengaged = db.all(`SELECT c.id, c.first_name, c.last_name, MAX(fa1.occurred_at) at FROM fub_activity fa1
      JOIN clients c ON c.id = fa1.client_id
      WHERE fa1.occurred_at >= datetime('now','-7 days') AND c.merged_into IS NULL
        AND lower(coalesce(c.status,'')) NOT IN ('junk','donotcontact')
        AND NOT EXISTS (SELECT 1 FROM fub_activity fa2 WHERE fa2.client_id = fa1.client_id
          AND fa2.occurred_at < fa1.occurred_at AND fa2.occurred_at >= datetime(fa1.occurred_at,'-60 days'))
      GROUP BY c.id ORDER BY at DESC LIMIT 50`).filter(r => !internalIds.has(r.id))
    const repeat = db.all(`SELECT c.id, c.first_name, c.last_name, fa.prop_street, fa.prop_city, COUNT(*) n
      FROM fub_activity fa JOIN clients c ON c.id = fa.client_id
      WHERE fa.occurred_at >= datetime('now','-7 days') AND fa.prop_mls IS NOT NULL AND fa.prop_mls != '' AND c.merged_into IS NULL
      GROUP BY fa.client_id, fa.prop_mls HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 50`).filter(r => !internalIds.has(r.id))
    const pcActive = db.all(`SELECT c.id, c.first_name, c.last_name, MAX(fa.occurred_at) at FROM fub_activity fa
      JOIN clients c ON c.id = fa.client_id
      WHERE fa.occurred_at >= datetime('now','-7 days')
        AND (lower(coalesce(c.status,''))='closed' OR (lower(coalesce(c.tags,'')) LIKE '%past client%' AND lower(coalesce(c.tags,'')) NOT LIKE '%unsubscribed%'))
      GROUP BY c.id ORDER BY at DESC LIMIT 20`).filter(r => !internalIds.has(r.id))
    return {
      reengaged: reengaged.length, repeat_viewers: new Set(repeat.map(r => r.id)).size, past_clients_active: pcActive.length,
      examples: {
        reengaged: reengaged.slice(0, 3).map(r => ({ id: r.id, name: nm(r) })),
        repeat: repeat.slice(0, 3).map(r => ({ id: r.id, name: nm(r), prop: [r.prop_street, r.prop_city].filter(Boolean).join(', '), n: r.n })),
        past_clients: pcActive.slice(0, 3).map(r => ({ id: r.id, name: nm(r) })),
      },
    }
  }, { reengaged: 0, repeat_viewers: 0, past_clients_active: 0, examples: { reengaged: [], repeat: [], past_clients: [] } })

  // ---- HUB AI today ----
  stats.ai = safe(() => ({
    managed: stats.pipeline.ai_managed,
    handoffs_open: handoffs.length,
    sent_today: db.get("SELECT COUNT(*) c FROM communications WHERE direction='outgoing' AND sent_by_type IN ('ai','fsbo_ai') AND occurred_at >= ? AND occurred_at < ?", [W.startUtc, W.endUtc]).c,
    responses_today: db.get(`SELECT COUNT(*) c FROM communications co JOIN ai_lead_state s ON s.client_id = co.client_id AND s.ai_managed = 1
      WHERE co.direction='incoming' AND co.channel='text' AND co.occurred_at >= ? AND co.occurred_at < ?`, [W.startUtc, W.endUtc]).c,
    intent_up_today: db.get("SELECT COUNT(*) c FROM ai_actions WHERE created_at >= ? AND created_at < ? AND intent_after > intent_before", [W.startUtc, W.endUtc]).c,
    failed_today: db.get("SELECT COUNT(*) c FROM ai_actions WHERE created_at >= ? AND created_at < ? AND status NOT IN ('success')", [W.startUtc, W.endUtc]).c,
  }), { managed: 0, handoffs_open: 0, sent_today: 0, responses_today: 0, intent_up_today: 0, failed_today: 0 })

  // ---- Communication health today ----
  stats.comm_today = safe(() => {
    const g = (sql) => db.get(sql, [W.startUtc, W.endUtc]).c
    return {
      texts_sent: g("SELECT COUNT(*) c FROM communications WHERE channel='text' AND direction='outgoing' AND occurred_at >= ? AND occurred_at < ?"),
      texts_received: g("SELECT COUNT(*) c FROM communications WHERE channel='text' AND direction='incoming' AND occurred_at >= ? AND occurred_at < ?"),
      emails_sent: g("SELECT COUNT(*) c FROM communications WHERE channel='email' AND direction='outgoing' AND occurred_at >= ? AND occurred_at < ?"),
      calls: g("SELECT COUNT(*) c FROM communications WHERE channel IN ('call','voicemail') AND occurred_at >= ? AND occurred_at < ?"),
      need_response: needRows.length,
      missed_calls: missedCalls.length,
      failed_messages: failedToday,
      emails_month: db.get("SELECT COUNT(*) c FROM communications WHERE channel='email' AND direction='outgoing' AND occurred_at >= ?", [W.monthStartUtc]).c,
      texts_month: db.get("SELECT COUNT(*) c FROM communications WHERE channel='text' AND direction='outgoing' AND occurred_at >= ?", [W.monthStartUtc]).c,
      drip_enrolled: db.get("SELECT COUNT(DISTINCT client_id) c FROM drip_enrollments WHERE status='active'").c,
    }
  }, {})

  // ---- Follow-up coverage (fall-through prevention) — the KPI target is ZERO ----
  stats.coverage = safe(() => {
    const g = (sql, p = []) => db.get(sql, p)?.n || 0
    const MEAN = "relationship_level IN ('connected','qualified','active_opportunity','client')"
    const live = 'client_id IN (SELECT id FROM clients WHERE merged_into IS NULL)'
    return {
      kpi_unprotected_connected: g(`SELECT COUNT(*) n FROM followup_coverage WHERE coverage_status='unprotected' AND ${MEAN} AND ${live}`),
      at_risk_meaningful: g(`SELECT COUNT(*) n FROM followup_coverage WHERE coverage_status='at_risk' AND ${MEAN} AND ${live}`),
      sellers_going_cold: g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%seller_going_cold%' AND ${live}`),
      buyers_going_cold: g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%buyer_going_cold%' AND ${live}`),
      high_intent_no_human: g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%high_intent_no_human_contact%' AND coverage_status IN ('unprotected','at_risk') AND ${live}`),
      overdue: g(`SELECT COUNT(*) n FROM followup_coverage WHERE overdue_by_days > 0 AND coverage_status IN ('at_risk','unprotected') AND ${live}`),
      snoozes_due_today: g('SELECT COUNT(*) n FROM clients WHERE merged_into IS NULL AND snooze_until IS NOT NULL AND substr(snooze_until,1,10) <= ?', [W.day]),
      ownerless: g(`SELECT COUNT(*) n FROM followup_coverage WHERE risk_flags LIKE '%ownerless%' AND ${live}`),
    }
  }, null)

  // ---- Business performance (owner/admin only — backend-gated, not just hidden) ----
  const role = String(req.user?.role || '').toLowerCase()
  if (role === 'owner' || role === 'admin' || req.user?.team) {
    stats.business = safe(() => {
      const newSince = (d) => db.get("SELECT COUNT(*) c FROM clients WHERE merged_into IS NULL AND substr(COALESCE(NULLIF(register_date,''), sierra_creation_date, created_at),1,10) >= ?", [d]).c
      return {
        mtd: { new_leads: newSince(W.monthStart), closed: closed.closedMonth, volume: closed.monthVolume },
        ytd: { new_leads: newSince(W.yearStart), closed: closed.closedYear, volume: closed.yearVolume },
      }
    }, null)
  }

  // ---- System health ----
  stats.health = safe(() => {
    const issues = []
    const ageH = (iso) => iso ? (Date.now() - new Date(iso).getTime()) / 3600000 : null
    const sierraAt = stats.last_sierra_sync?.synced_at || null
    if (sierraAt !== null && ageH(sierraAt) > 1) issues.push(`Sierra sync last ran ${Math.round(ageH(sierraAt))}h ago`)
    const backupAt = db.getSetting('gdrive_last_backup_at', null)
    if (!backupAt || ageH(backupAt) > 26) issues.push('Backup overdue')
    if (failedToday > 0) issues.push(`${failedToday} failed message${failedToday === 1 ? '' : 's'} today`)
    if (!process.env.ANTHROPIC_API_KEY) issues.push('AI key missing')
    return {
      ok: issues.length === 0,
      issues,
      sierra_last: sierraAt, backup_last: backupAt,
      fsbo_sync_last: db.getSetting('fsbo_master_last_sync', null),
      expired_sync_last: db.getSetting('expired_master_last_sync', null),
    }
  }, { ok: true, issues: [] })

  res.json(stats)
})

// Dismiss one Needs-Attention item ("✓ Done — already addressed"). Keyed per item, so a NEW
// reply/call from the same person resurfaces. Dismissing an AI handoff resolves it in the
// real handoff queue (same state the AI Opportunities page uses).
router.post('/attention/dismiss', (req, res) => {
  const { type, client_id, ref, undo } = req.body || {}
  if (!type) return res.status(400).json({ error: 'type required' })
  try {
    if (undo) {
      db.run('DELETE FROM attention_dismissals WHERE type=? AND client_id=? AND ref=?', [String(type), Number(client_id) || null, String(ref || '')])
      if (type === 'handoff' && ref) db.run("UPDATE ai_handoffs SET status='open', completed_at=NULL WHERE id=?", [Number(ref)])
      return res.json({ success: true, undone: true })
    }
    if (type === 'handoff' && ref) {
      db.run("UPDATE ai_handoffs SET status='resolved', completed_at=datetime('now') WHERE id=?", [Number(ref)])
    } else {
      db.run('INSERT OR IGNORE INTO attention_dismissals (type, client_id, ref) VALUES (?,?,?)', [String(type), Number(client_id) || null, String(ref || '')])
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
