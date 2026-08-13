import { Router } from 'express'
import db from '../database.js'
import { getSetting, setSetting } from '../database.js'
import { buildClientFilter } from './clients.js'
import { sendViaSendGrid, buildPropertyCardsLive, logSentToInbox, emailHardBlock } from './email.js'
import { enrollInDrip } from './drips.js'
import { stopSequencesForClient, isStopStatus } from '../lead-sequences.js'
import { isUsHoliday, bumpPastHolidays } from '../holidays.js'
import { validateGraph, getDef, branchKeysFor, labelFor } from '../../shared/automationRegistry.js'

const router = Router()
const MAX_ATTEMPTS = 3
const STEP_GUARD = 60            // max synchronous nodes per stepper pass (loop protection)
const RETRY_DELAY_MIN = 5       // minutes before retrying a failed action

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
const parse = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
const parseTags = (s) => { const a = parse(s, []); return Array.isArray(a) ? a : [] }
const nowIso = () => new Date().toISOString()
const account = () => parse(getSetting('account_info', null), {}) || {}

function fillMerge(text, c) {
  if (!text) return ''
  const a = account()
  const money = (v) => v ? '$' + Number(v).toLocaleString() : ''
  const priceRange = c.search_price_min && c.search_price_max ? `${money(c.search_price_min)} to ${money(c.search_price_max)}`
    : c.search_price_max ? `up to ${money(c.search_price_max)}` : c.search_price_min ? `${money(c.search_price_min)}+` : ''
  const lvParts = String(c.last_fub_activity_detail || '').split(',').map(s => s.trim()).filter(Boolean)
  const lvCity = lvParts.length ? lvParts[lvParts.length - 1] : ''
  const cityOfInterest = ((lvCity && !/\d/.test(lvCity) && lvCity.length <= 40) ? lvCity : '')
    || (String(c.fub_viewed_cities || '').split(',').map(s => s.trim()).filter(Boolean)[0]) || c.city || ''
  const STREETISH = /\b(road|rd|st|street|ave|avenue|dr|drive|lane|ln|ct|court|blvd|way|cir|circle|pl|place|ter|terrace|hwy|highway|pkwy)\b/i
  const liSeen = new Set()
  const liCities = String(c.fub_viewed_cities || '').split(',').map(s => s.trim())
    .filter(s => s && !/\d/.test(s) && !STREETISH.test(s))
    .filter(s => { const k = s.toLowerCase(); if (liSeen.has(k)) return false; liSeen.add(k); return true })
    .slice(0, 3)
  const listingInterest = !liCities.length ? cityOfInterest
    : liCities.length === 1 ? liCities[0]
    : liCities.length === 2 ? `${liCities[0]} and ${liCities[1]}`
    : `${liCities.slice(0, -1).join(', ')}, and ${liCities[liCities.length - 1]}`
  return String(text)
    .replace(/\{\{first_name\}\}/g, c.first_name || 'there')
    .replace(/\{\{last_name\}\}/g, c.last_name || '')
    .replace(/\{\{full_name\}\}/g, `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'there')
    .replace(/\{\{city\}\}/g, c.city || 'Cedar Rapids')
    .replace(/\{\{address\}\}/g, c.address || 'your home')
    .replace(/\{\{state\}\}/g, c.state || '')
    .replace(/\{\{zip\}\}/g, c.zip || '')
    .replace(/\{\{city_of_interest\}\}/g, cityOfInterest)
    .replace(/\{\{listing_interest\}\}/g, listingInterest)
    .replace(/\{\{last_viewed_address\}\}/g, c.last_fub_activity_detail || '')
    .replace(/\{\{search_price_range\}\}/g, priceRange)
    .replace(/\{\{lender_name\}\}/g, c.lender_name || '')
    .replace(/\{\{lender_company\}\}/g, c.lender_company || '')
    .replace(/\{\{agent_name\}\}/g, c.agent_assigned || a.name || 'Matt Smith')
    .replace(/\{\{agent_phone\}\}/g, a.phone || '')
    .replace(/\{\{agent_email\}\}/g, a.email || 'matt@mattsmithteam.com')
    .replace(/\{\{company\}\}/g, a.company || 'Matt Smith Team | RE/MAX Concepts')
}

// ---------------------------------------------------------------------------
// graph model helpers  ({ nodes:[{id,kind,type,config,x,y}], edges:[{from,to,branch}] })
// ---------------------------------------------------------------------------
const emptyGraph = () => ({ nodes: [], edges: [] })
function parseGraph(s) { const g = parse(s, null); return g && Array.isArray(g.nodes) ? { nodes: g.nodes, edges: g.edges || [] } : emptyGraph() }
const nodeById = (g, id) => g.nodes.find(n => n.id === id) || null
function nextNodeId(g, fromId, branch = null) {
  const e = g.edges.find(x => x.from === fromId && (branch == null ? (x.branch == null || x.branch === 'next') : x.branch === branch))
  return e ? e.to : null
}
const triggerNodes = (g) => g.nodes.filter(n => n.kind === 'trigger')

// Convert a legacy linear flow ({trigger, steps[]}) into the graph model so old
// automations keep working and can be edited in the new builder.
function legacyToGraph(flow) {
  const g = emptyGraph()
  if (!flow || !flow.trigger) return g
  let y = 40, prev = null
  const tId = 'trg'
  g.nodes.push({ id: tId, kind: 'trigger', type: mapLegacyTrigger(flow.trigger.type), config: flow.trigger.config || {}, x: 0, y })
  prev = tId; y += 120
  for (const s of (flow.steps || [])) {
    const id = s.id || ('n' + Math.random().toString(36).slice(2, 8))
    const kind = s.kind === 'action' ? 'action' : 'control'
    const type = s.kind === 'action' ? mapLegacyAction(s.actionType) : (s.kind === 'condition' ? 'condition' : s.kind)
    const config = legacyConfig(s)
    g.nodes.push({ id, kind, type, config, x: 0, y })
    g.edges.push({ from: prev, to: id, branch: null })
    prev = id; y += 120
  }
  return g
}
const mapLegacyTrigger = (t) => ({ lead_created: 'contact_created', status_changed: 'stage_changed', schedule_daily: 'recurring_schedule' }[t] || t || 'manual_enrollment')
const mapLegacyAction = (t) => ({ assign: 'assign_agent', update_status: 'change_status' }[t] || t)
function legacyConfig(s) {
  const c = s.config || {}
  if (s.kind === 'condition') {
    // old single-field condition -> one rule
    const map = { status: 'status', tag: 'tags', city: 'property_city', last_visit_days: 'last_activity_days', inactive_days: 'last_activity_days', has_email: 'has_email', has_listing_views: 'has_listing_views' }
    const field = map[c.field] || c.field
    let op = 'is'
    if (c.field === 'status') op = c.op === 'is_not' ? 'is_not' : 'is'
    else if (c.field === 'tag') op = c.op === 'not' ? 'has_none' : 'has_any'
    else if (c.field === 'last_visit_days') op = c.op === 'over' ? 'not_in_last' : 'in_last'
    else if (c.field === 'inactive_days') op = 'not_in_last'
    else if (c.field === 'has_email' || c.field === 'has_listing_views') op = 'is'
    const value = (c.field === 'has_email' || c.field === 'has_listing_views') ? true : c.value
    return { logic: 'and', rules: field ? [{ field, op, value }] : [] }
  }
  return c
}

// ---------------------------------------------------------------------------
// derive the condition-evaluation view of a client
// ---------------------------------------------------------------------------
function deriveClient(client) {
  const views = db.get('SELECT COUNT(DISTINCT prop_mls) AS c FROM fub_activity WHERE client_id = ? AND prop_mls IS NOT NULL', [client.id])?.c || 0
  const lastAct = client.last_fub_activity_at ? Math.floor((Date.now() - new Date(client.last_fub_activity_at).getTime()) / 86400000) : null
  return {
    ...client,
    tags: parseTags(client.tags),
    lead_source: client.source || '',
    property_city: client.city || '',
    property_zip: client.zip || '',
    num_property_views: views,
    last_activity_days: lastAct,
    last_email_open_days: null,
    has_email: !!client.email,
    has_listing_views: !!client.last_fub_activity_at,
    created_date: client.created_at,
  }
}

function evalRule(rule, dc) {
  const raw = dc[rule.field]
  const op = rule.op
  const val = rule.value
  const asNum = (x) => Number(x)
  const s = (x) => (x == null ? '' : String(x)).toLowerCase()
  switch (op) {
    case 'is': if (typeof raw === 'boolean' || val === true || val === false) return String(raw) === String(val); return s(raw) === s(val)
    case 'is_not': return s(raw) !== s(val)
    case 'contains': return s(raw).includes(s(val))
    case 'not_contains': return !s(raw).includes(s(val))
    case 'starts_with': return s(raw).startsWith(s(val))
    case 'ends_with': return s(raw).endsWith(s(val))
    case 'is_empty': return raw == null || raw === '' || (Array.isArray(raw) && !raw.length)
    case 'is_not_empty': return !(raw == null || raw === '' || (Array.isArray(raw) && !raw.length))
    case 'gt': return asNum(raw) > asNum(val)
    case 'lt': return asNum(raw) < asNum(val)
    case 'gte': return asNum(raw) >= asNum(val)
    case 'lte': return asNum(raw) <= asNum(val)
    case 'before': return raw && val ? new Date(raw) < new Date(val) : false
    case 'after': return raw && val ? new Date(raw) > new Date(val) : false
    case 'in_last': return raw != null && asNum(raw) <= asNum(val)          // e.g. last_activity_days <= N
    case 'not_in_last': return raw == null || asNum(raw) > asNum(val)
    case 'has_any': { const arr = Array.isArray(raw) ? raw : []; const want = Array.isArray(val) ? val : String(val || '').split(',').map(x => x.trim()); return want.some(w => arr.includes(w)) }
    case 'has_all': { const arr = Array.isArray(raw) ? raw : []; const want = Array.isArray(val) ? val : String(val || '').split(',').map(x => x.trim()); return want.every(w => arr.includes(w)) }
    case 'has_none': { const arr = Array.isArray(raw) ? raw : []; const want = Array.isArray(val) ? val : String(val || '').split(',').map(x => x.trim()); return !want.some(w => arr.includes(w)) }
    default: return false
  }
}
function evalCondition(node, dc) {
  const c = node.config || {}
  const rules = c.rules || []
  if (!rules.length) return true
  const results = rules.map(r => evalRule(r, dc))
  return (c.logic === 'or') ? results.some(Boolean) : results.every(Boolean)
}

// ---------------------------------------------------------------------------
// action executors (per enrolled contact).  Return a short output string.
// Throw to trigger retry/failed handling.
// ---------------------------------------------------------------------------
async function runAction(node, client, ctx) {
  const cfg = node.config || {}
  switch (node.type) {
    case 'add_tag': {
      const tags = parseTags(client.tags)
      if (cfg.tag && !tags.includes(cfg.tag)) { tags.push(cfg.tag); db.run('UPDATE clients SET tags = ? WHERE id = ?', [JSON.stringify(tags), client.id]) }
      return `tagged ${cfg.tag}`
    }
    case 'remove_tag': {
      const tags = parseTags(client.tags).filter(t => t !== cfg.tag)
      db.run('UPDATE clients SET tags = ? WHERE id = ?', [JSON.stringify(tags), client.id])
      return `removed ${cfg.tag}`
    }
    case 'add_note': {
      const stamp = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      const note = `[${stamp} · automation] ${fillMerge(cfg.text, client)}`
      db.run('UPDATE clients SET notes = ? WHERE id = ?', [client.notes ? `${note}\n${client.notes}` : note, client.id])
      return 'note added'
    }
    case 'change_status': case 'change_stage': {
      if (cfg.status) {
        db.run('UPDATE clients SET status = ? WHERE id = ?', [cfg.status, client.id])
        if (isStopStatus(cfg.status)) stopSequencesForClient(client.id, `lead marked ${cfg.status}`)
      }
      return `status → ${cfg.status}`
    }
    case 'assign_agent': case 'reassign_agent': {
      if (cfg.agent) db.run('UPDATE clients SET agent_assigned = ? WHERE id = ?', [cfg.agent, client.id])
      return `assigned ${cfg.agent}`
    }
    case 'create_task': {
      const due = cfg.days_offset != null && cfg.days_offset !== '' ? new Date(Date.now() + Number(cfg.days_offset) * 86400000).toISOString().slice(0, 10) : null
      const title = fillMerge(cfg.title || 'Follow up', client)
      try { db.run("INSERT INTO tasks (title, status, priority, due_date, assigned_to, related_type, related_id) VALUES (?,?,?,?,?,?,?)", [title, 'todo', cfg.priority || 'medium', due, cfg.assignee || null, 'client', client.id]) }
      catch { db.run("INSERT INTO tasks (title, status, priority) VALUES (?,?,?)", [title, 'todo', cfg.priority || 'medium']) }
      return `task: ${title}`
    }
    case 'send_email': {
      if (!client.email) throw new Error('contact has no email')
      // Opt-outs are allowed (tagged), per team policy; only hard-block bad
      // address / spam complaint / blocked domain.
      const hardBlk = emailHardBlock(client)
      if (hardBlk) return `skipped (${hardBlk})`
      let subject = cfg.subject, body = cfg.body
      if (cfg.template_id) { const t = db.get('SELECT subject, body FROM templates WHERE id = ?', [Number(cfg.template_id)]); if (t) { subject = subject || t.subject; body = body || t.body } }
      if (!subject || !body) throw new Error('email missing subject/body/template')
      subject = fillMerge(subject, client); body = fillMerge(body, client)
      if (cfg.include_properties || /\{\{properties\}\}/.test(body)) {
        let cards = ''
        try { cards = await buildPropertyCardsLive(client, 4) } catch {}
        body = /\{\{properties\}\}/.test(body) ? body.replace(/\{\{properties\}\}/g, cards) : (body + cards)
      }
      const category = `auto_${ctx.automationId}`   // ties into the Reporting tab (opens/clicks)
      await sendViaSendGrid(client.email, `${client.first_name || ''} ${client.last_name || ''}`.trim(), subject, body, cfg.reply_to || null, [], [], [], category)
      logSentToInbox(client, subject, body, `${category}_${Date.now()}_${client.id}`)
      return `emailed: ${subject}`
    }
    case 'send_property_recommendation': {
      if (!client.email) throw new Error('contact has no email')
      let cards = ''
      try { cards = await buildPropertyCardsLive(client, Number(cfg.max) || 4) } catch {}
      if (!cards) return 'skipped (no properties)'
      const subj = 'A few homes I thought you should see'
      const body = `<p>Hi ${client.first_name || 'there'},</p><p>Based on what you've been looking at, here are a few homes worth a look:</p>${cards}<p>Want to see any in person? Just reply.</p><p>${account().name || 'Matt Smith'}</p>`
      await sendViaSendGrid(client.email, `${client.first_name || ''} ${client.last_name || ''}`.trim(), subj, body, null, [], [], [], `auto_${ctx.automationId}`)
      logSentToInbox(client, subj, body, `auto_${ctx.automationId}_${Date.now()}_${client.id}`)
      return 'sent recommendation'
    }
    case 'send_internal_notification': case 'notify_agent_property_activity': {
      const hook = getSetting('slack_webhook_url', null)
      const msg = fillMerge(cfg.message || cfg.text || `${client.first_name || ''} ${client.last_name || ''} — automation notification`, client)
      if (!hook) return 'no Slack webhook set (skipped)'
      try {
        await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `🤖 ${msg}` }) })
      } catch (e) { throw new Error('Slack post failed: ' + e.message) }
      return 'notified team'
    }
    case 'send_drip': {
      if (!cfg.drip_id) throw new Error('no drip campaign selected')
      const eid = enrollInDrip(Number(cfg.drip_id), client.id, { source: 'automation', automation_id: ctx.automationId })
      return eid ? `started drip #${cfg.drip_id}` : 'drip skipped (already enrolled / empty)'
    }
    case 'enroll_in_automation': {
      const target = db.get('SELECT * FROM automations WHERE id = ?', [Number(cfg.automation_id)])
      if (target && target.status === 'active') enrollClient(target, client.id, { source: 'chained' })
      return `enrolled in #${cfg.automation_id}`
    }
    case 'remove_from_automation': {
      db.run("UPDATE automation_enrollments SET status='removed', exit_reason='removed by automation', completed_at=? WHERE automation_id=? AND client_id=? AND status IN ('active','waiting')", [nowIso(), Number(cfg.automation_id), client.id])
      return `removed from #${cfg.automation_id}`
    }
    case 'end_automation': case 'stop':
      return '__END__'
    case 'send_text': {
      if (!client.phone) throw new Error('contact has no phone')
      if (client.text_opt_out) return 'skipped (opted out of texts)'
      let body = cfg.body
      if (cfg.template_id) { const t = db.get('SELECT body FROM templates WHERE id = ?', [Number(cfg.template_id)]); if (t) body = body || t.body }
      if (!body) throw new Error('text missing body/template')
      body = fillMerge(body, client)
      const { sendSms, twilioConfigured } = await import('../twilio.js')
      if (!twilioConfigured()) throw new Error('Texting is not connected — add Twilio in Settings')
      const r = await sendSms(client.phone, body)
      const preview = String(body).replace(/\s+/g, ' ').trim().slice(0, 160)
      const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
      try {
        db.run(`INSERT INTO communications (channel, direction, client_id, contact_name, from_addr, to_addr, subject, preview, body, external_id, thread_key, status, occurred_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['text', 'outgoing', client.id, name, '', client.phone, null, preview, body, 'twilio_' + r.sid, `c${client.id}_text`, 'read', nowIso()])
      } catch {}
      return `texted: ${preview.slice(0, 40)}`
    }
    case 'send_voicemail':
      throw new Error('Ringless voicemail is not connected yet')
    default:
      throw new Error(`action "${node.type}" is not available yet`)
  }
}

// ---------------------------------------------------------------------------
// idempotent execution record
// ---------------------------------------------------------------------------
function execKey(enrollmentId, nodeId) { return `enr${enrollmentId}_node${nodeId}` }
function priorExec(key) { return db.get('SELECT * FROM automation_executions WHERE idempotency_key = ?', [key]) }
function recordExec(enrollmentId, automationId, node, key, status, output, error, attempt) {
  const existing = priorExec(key)
  if (existing) {
    db.run('UPDATE automation_executions SET status=?, attempt=?, completed_at=?, output=?, error=? WHERE id=?',
      [status, attempt, nowIso(), output || null, error || null, existing.id])
  } else {
    db.run('INSERT INTO automation_executions (enrollment_id, automation_id, node_id, node_type, status, attempt, idempotency_key, completed_at, output, error) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [enrollmentId, automationId, node.id, node.type, status, attempt || 1, key, nowIso(), output || null, error || null])
  }
}

// ---------------------------------------------------------------------------
// delay computation
// ---------------------------------------------------------------------------
function computeDelayMs(cfg) {
  const amt = Number(cfg.amount) || 1
  const unit = cfg.unit || 'days'
  const mult = { minutes: 60000, hours: 3600000, days: 86400000, weeks: 604800000, months: 2592000000 }[unit] || 86400000
  return amt * mult
}
function applyDelay(cfg) {
  let when = new Date(Date.now() + computeDelayMs(cfg))
  if (cfg.skip_weekends) { while (when.getDay() === 0 || when.getDay() === 6) when = new Date(when.getTime() + 86400000) }
  if (cfg.business_hours) { const h = when.getHours(); if (h < 8) when.setHours(8, 0, 0, 0); else if (h >= 18) { when.setDate(when.getDate() + 1); when.setHours(8, 0, 0, 0) } }
  return bumpPastHolidays(when.toISOString())  // never resume onto a US federal holiday
}
const MESSAGING_ACTIONS = ['send_email', 'send_text', 'send_drip', 'send_property_recommendation']

// ---------------------------------------------------------------------------
// enrollment
// ---------------------------------------------------------------------------
function activeEnrollment(automationId, clientId) {
  return db.get("SELECT * FROM automation_enrollments WHERE automation_id=? AND client_id=? AND status IN ('active','waiting')", [automationId, clientId])
}
function enrollClient(auto, clientId, ctx = {}) {
  const settings = parse(auto.settings, {}) || {}
  // re-entry rules
  if (activeEnrollment(auto.id, clientId)) return null                 // already in flight
  if (!settings.allow_reentry) {
    const ever = db.get('SELECT COUNT(*) c FROM automation_enrollments WHERE automation_id=? AND client_id=?', [auto.id, clientId]).c
    if (ever > 0) return null                                          // enter-once
  } else if (settings.max_entries) {
    const cnt = db.get('SELECT COUNT(*) c FROM automation_enrollments WHERE automation_id=? AND client_id=?', [auto.id, clientId]).c
    if (cnt >= Number(settings.max_entries)) return null
  }
  const g = parseGraph(auto.active_graph)
  const trig = triggerNodes(g)[0]
  if (!trig) return null
  const first = nextNodeId(g, trig.id, null)
  const r = db.run('INSERT INTO automation_enrollments (automation_id, version_number, client_id, status, current_node_id, next_run_at, context) VALUES (?,?,?,?,?,?,?)',
    [auto.id, auto.active_version || 1, clientId, 'active', first, nowIso(), JSON.stringify(ctx || {})])
  return r.lastInsertRowid
}

function completeEnrollment(enr, status, reason) {
  db.run('UPDATE automation_enrollments SET status=?, exit_reason=?, completed_at=?, next_run_at=NULL WHERE id=?', [status, reason || null, nowIso(), enr.id])
}

// ---------------------------------------------------------------------------
// the stepper — advance one enrollment as far as it can go synchronously,
// parking it on delays / waits.
// ---------------------------------------------------------------------------
async function advanceEnrollment(enr) {
  const auto = db.get('SELECT * FROM automations WHERE id = ?', [enr.automation_id])
  if (!auto || auto.status !== 'active') return               // paused/deleted -> leave parked
  const g = parseGraph(auto.active_graph)
  const client = db.get('SELECT * FROM clients WHERE id = ?', [enr.client_id])
  if (!client) return completeEnrollment(enr, 'removed', 'contact deleted')
  const ctx = { automationId: auto.id, ...parse(enr.context, {}) }

  let nodeId = enr.current_node_id
  let guard = 0
  while (nodeId && guard++ < STEP_GUARD) {
    const node = nodeById(g, nodeId)
    if (!node) return completeEnrollment(enr, 'completed', 'reached end')

    // ---- controls that just route (synchronous) ----
    if (node.kind === 'trigger') { nodeId = nextNodeId(g, node.id, null); continue }

    if (node.type === 'condition') {
      const dc = deriveClient(client)
      nodeId = nextNodeId(g, node.id, evalCondition(node, dc) ? 'yes' : 'no')
      if (!nodeId) return completeEnrollment(enr, 'completed', 'condition path ended')
      continue
    }
    if (node.type === 'branch') {
      const dc = deriveClient(client)
      const val = String(dc[node.config?.field] ?? '')
      const vals = (node.config?.values || []).map(String)
      const key = vals.includes(val) ? val : 'other'
      nodeId = nextNodeId(g, node.id, key) || nextNodeId(g, node.id, 'other')
      if (!nodeId) return completeEnrollment(enr, 'completed', 'branch path ended')
      continue
    }
    if (node.type === 'random_split') {
      const pctA = Number(node.config?.percent_a ?? 50)
      const pick = ((enr.id * 2654435761) % 100) < pctA ? 'a' : 'b'   // stable per enrollment
      nodeId = nextNodeId(g, node.id, pick)
      if (!nodeId) return completeEnrollment(enr, 'completed', 'split path ended')
      continue
    }
    if (node.type === 'goto') {
      const t = node.config?.target_node
      if (!t || !nodeById(g, t)) return completeEnrollment(enr, 'failed', 'Go To target missing')
      nodeId = t; continue
    }
    if (node.type === 'goal') {
      const met = goalMet(node.config, client)
      nodeId = nextNodeId(g, node.id, met ? 'met' : 'continue')
      if (!nodeId) return completeEnrollment(enr, 'completed', 'goal path ended')
      continue
    }

    // ---- delay: park until next_run_at, then resume at the next node ----
    if (node.type === 'delay') {
      const next = nextNodeId(g, node.id, null)
      if (!next) return completeEnrollment(enr, 'completed', 'ended after delay')
      db.run('UPDATE automation_enrollments SET status=?, current_node_id=?, next_run_at=? WHERE id=?', ['waiting', next, applyDelay(node.config || {}), enr.id])
      return
    }

    // ---- wait_until: park until an event resolves it or it times out ----
    if (node.type === 'wait_until') {
      const maxDays = Number(node.config?.max_days) || 7
      const deadline = new Date(Date.now() + maxDays * 86400000).toISOString()
      db.run('UPDATE automation_enrollments SET status=?, next_run_at=?, context=? WHERE id=?',
        ['waiting', deadline, JSON.stringify({ ...parse(enr.context, {}), wait: { node: node.id, ...node.config } }), enr.id])
      return
    }

    // ---- stop ----
    if (node.type === 'stop' || node.type === 'end_automation') return completeEnrollment(enr, 'completed', 'stopped')

    // ---- no client email/text on US federal holidays: defer the send ----
    if (MESSAGING_ACTIONS.includes(node.type) && isUsHoliday(new Date())) {
      db.run('UPDATE automation_enrollments SET status=?, current_node_id=?, next_run_at=? WHERE id=?', ['active', node.id, bumpPastHolidays(nowIso()), enr.id])
      return
    }

    // ---- action nodes: idempotent execute, then follow default edge ----
    const key = execKey(enr.id, node.id)
    const prior = priorExec(key)
    if (prior && prior.status === 'success') { nodeId = nextNodeId(g, node.id, null); continue }
    const attempt = (prior?.attempt || 0) + 1
    try {
      const out = await runAction(node, client, ctx)
      if (out === '__END__') { recordExec(enr.id, auto.id, node, key, 'success', 'ended', null, attempt); return completeEnrollment(enr, 'completed', 'ended by action') }
      recordExec(enr.id, auto.id, node, key, 'success', out, null, attempt)
      nodeId = nextNodeId(g, node.id, null)
      if (!nodeId) return completeEnrollment(enr, 'completed', 'reached end')
    } catch (e) {
      recordExec(enr.id, auto.id, node, key, 'failed', null, e.message, attempt)
      if (attempt < MAX_ATTEMPTS) {
        db.run('UPDATE automation_enrollments SET status=?, next_run_at=?, last_error=? WHERE id=?', ['active', new Date(Date.now() + RETRY_DELAY_MIN * 60000).toISOString(), e.message, enr.id])
      } else {
        db.run('UPDATE automation_enrollments SET status=?, next_run_at=NULL, last_error=?, completed_at=?, exit_reason=? WHERE id=?', ['failed', e.message, nowIso(), 'action failed after retries', enr.id])
        db.run("UPDATE automations SET status = CASE WHEN status='active' THEN 'active' ELSE status END WHERE id=?", [auto.id])
      }
      return
    }
  }
  if (guard >= STEP_GUARD) return completeEnrollment(enr, 'failed', 'loop guard tripped (circular flow)')
  return completeEnrollment(enr, 'completed', 'reached end')
}

function goalMet(cfg, client) {
  if (!cfg) return false
  if (cfg.goal === 'tag_added' && cfg.tag) return parseTags(client.tags).includes(cfg.tag)
  if (cfg.goal === 'status_changed') return true && false   // needs status snapshot; treated as not-met for now
  if (cfg.goal === 'replied') return false
  return false
}

// resolve any waiting `wait_until` enrollments a fresh event satisfies
function resolveWaits(eventType, clientId, payload) {
  const rows = db.all("SELECT * FROM automation_enrollments WHERE status='waiting' AND client_id=?", [clientId])
  for (const enr of rows) {
    const wait = parse(enr.context, {})?.wait
    if (!wait) continue
    let hit = false
    if (wait.event === 'tag_added' && eventType === 'tag_added' && (!wait.tag || payload?.tag === wait.tag)) hit = true
    if (wait.event === 'status_changed' && eventType === 'status_changed') hit = true
    if (wait.event === 'replied' && eventType === 'replied') hit = true
    if (wait.event === 'property_saved' && eventType === 'property_saved') hit = true
    if (!hit) continue
    const auto = db.get('SELECT * FROM automations WHERE id=?', [enr.automation_id])
    const g = parseGraph(auto?.active_graph)
    const cont = nextNodeId(g, wait.node, 'continue')
    db.run('UPDATE automation_enrollments SET status=?, current_node_id=?, next_run_at=? WHERE id=?', ['active', cont, nowIso(), enr.id])
  }
}

// ---------------------------------------------------------------------------
// EVENT INGESTION + SCHEDULER TICK
// ---------------------------------------------------------------------------
function insertEvent(eventType, clientId, payload, dedupeKey) {
  try {
    db.run('INSERT OR IGNORE INTO automation_events (event_type, client_id, dedupe_key, payload) VALUES (?,?,?,?)',
      [eventType, clientId || null, dedupeKey, JSON.stringify(payload || {})])
  } catch {}
}
// public: other modules/endpoints can emit events (contact_created, tag_added, ...)
export function emitAutomationEvent(eventType, clientId, payload = {}, dedupeKey = null) {
  insertEvent(eventType, clientId, payload, dedupeKey || `${eventType}_${clientId}_${Date.now()}`)
}

// Pull new property-view rows from fub_activity into the event queue (cursor).
function ingestFubViews() {
  // First run ever: start the cursor at the current max so historical views
  // don't flood the queue and enroll people for things they did months ago.
  if (getSetting('automation_fubview_cursor', null) == null) {
    const max = db.get('SELECT MAX(id) AS m FROM fub_activity')?.m || 0
    setSetting('automation_fubview_cursor', String(max))
    return
  }
  const cursor = Number(getSetting('automation_fubview_cursor', '0'))
  const rows = db.all('SELECT id, client_id, prop_mls, prop_city, prop_zip, prop_price, prop_street FROM fub_activity WHERE id > ? AND prop_mls IS NOT NULL AND client_id IS NOT NULL ORDER BY id ASC LIMIT 500', [cursor])
  for (const r of rows) {
    insertEvent('property_viewed', r.client_id, { mls: r.prop_mls, city: r.prop_city, zip: r.prop_zip, price: r.prop_price, street: r.prop_street }, `fubview_${r.id}`)
  }
  if (rows.length) setSetting('automation_fubview_cursor', String(rows[rows.length - 1].id))
}

// Does a property_viewed trigger's config match this event + client?
function propertyViewMatches(cfg, ev, client) {
  cfg = cfg || {}
  if (cfg.match === 'specific' && cfg.listing_id && String(ev.mls) !== String(cfg.listing_id)) return false
  if (cfg.city && !(ev.city || '').toLowerCase().includes(String(cfg.city).toLowerCase())) return false
  if (cfg.zip && String(ev.zip || '') !== String(cfg.zip)) return false
  const price = Number(String(ev.price || '').replace(/[^0-9.]/g, '')) || 0
  if (cfg.price_min && price && price < Number(cfg.price_min)) return false
  if (cfg.price_max && price && price > Number(cfg.price_max)) return false
  if (cfg.assigned_agent && client.agent_assigned !== cfg.assigned_agent) return false
  if (cfg.lead_source && (client.source || '') !== cfg.lead_source) return false
  const tags = parseTags(client.tags)
  if (Array.isArray(cfg.include_tags) && cfg.include_tags.length && !cfg.include_tags.some(t => tags.includes(t))) return false
  if (Array.isArray(cfg.exclude_tags) && cfg.exclude_tags.length && cfg.exclude_tags.some(t => tags.includes(t))) return false
  if (cfg.min_views && Number(cfg.min_views) > 1) {
    const days = cfg.time_window_days ? ` AND occurred_at >= datetime('now','-${Number(cfg.time_window_days)} days')` : ''
    const n = db.get(`SELECT COUNT(*) c FROM fub_activity WHERE client_id=? AND prop_mls=?${days}`, [client.id, ev.mls])?.c || 0
    if (n < Number(cfg.min_views)) return false
  }
  return true
}

// Match one event against active automations' triggers and enroll.
function processEvent(ev) {
  const client = ev.client_id ? db.get('SELECT * FROM clients WHERE id=?', [ev.client_id]) : null
  const autos = db.all("SELECT * FROM automations WHERE status='active'")
  for (const auto of autos) {
    const g = parseGraph(auto.active_graph)
    for (const trig of triggerNodes(g)) {
      const def = getDef(trig)
      if (!def) continue
      let match = false
      if (ev.event_type === 'property_viewed' && (trig.type === 'property_viewed' || trig.type === 'property_viewed_multiple')) {
        match = client ? propertyViewMatches(trig.config, parse(ev.payload, {}), client) : false
      } else if (ev.event_type === trig.type) {
        match = true // contact_created / tag_added / stage_changed / etc.
        const cfg = trig.config || {}
        const p = parse(ev.payload, {})
        if (trig.type === 'tag_added' && cfg.tag && p.tag !== cfg.tag) match = false
        if (trig.type === 'tag_removed' && cfg.tag && p.tag !== cfg.tag) match = false
        if ((trig.type === 'stage_changed' || trig.type === 'contact_status_changed') && cfg.to_status && p.status !== cfg.to_status) match = false
        if (trig.type === 'contact_created' && cfg.lead_source && client && client.source !== cfg.lead_source) match = false
      }
      if (match && client) { enrollClient(auto, client.id, { via: ev.event_type, payload: parse(ev.payload, {}) }); break }
    }
  }
  // let events resolve any parked wait_until steps too
  if (client) resolveWaits(ev.event_type, ev.client_id, parse(ev.payload, {}))
}

// Pull newly-created contacts into the event queue (cursor) — fires for every
// creation path (manual, Sierra import, FUB), so contact_created triggers work
// without hooking each writer.
function ingestNewContacts() {
  if (getSetting('automation_contact_cursor', null) == null) {
    const max = db.get('SELECT MAX(id) AS m FROM clients')?.m || 0
    setSetting('automation_contact_cursor', String(max))
    return
  }
  const cursor = Number(getSetting('automation_contact_cursor', '0'))
  const rows = db.all('SELECT id, source, agent_assigned FROM clients WHERE id > ? ORDER BY id ASC LIMIT 300', [cursor])
  for (const r of rows) insertEvent('contact_created', r.id, { lead_source: r.source, agent: r.agent_assigned }, `newcontact_${r.id}`)
  if (rows.length) setSetting('automation_contact_cursor', String(rows[rows.length - 1].id))
}

function processEventQueue() {
  ingestFubViews()
  ingestNewContacts()
  const rows = db.all('SELECT * FROM automation_events WHERE processed_at IS NULL ORDER BY id ASC LIMIT 300')
  for (const ev of rows) {
    try { processEvent(ev) } catch (e) { console.error('[automations] event error:', e.message) }
    db.run('UPDATE automation_events SET processed_at=? WHERE id=?', [nowIso(), ev.id])
  }
}

async function stepDueEnrollments() {
  const due = db.all("SELECT * FROM automation_enrollments WHERE status IN ('active','waiting') AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 200", [nowIso()])
  for (const enr of due) {
    // waiting rows that hit next_run_at while parked on a wait_until -> timeout path
    if (enr.status === 'waiting') {
      const wait = parse(enr.context, {})?.wait
      if (wait) {
        const auto = db.get('SELECT * FROM automations WHERE id=?', [enr.automation_id])
        const g = parseGraph(auto?.active_graph)
        const to = nextNodeId(g, wait.node, 'timeout')
        db.run('UPDATE automation_enrollments SET status=?, current_node_id=?, next_run_at=? WHERE id=?', ['active', to, nowIso(), enr.id])
        if (!to) { completeEnrollment(enr, 'completed', 'wait timed out'); continue }
      }
    }
    try { await advanceEnrollment(db.get('SELECT * FROM automation_enrollments WHERE id=?', [enr.id])) }
    catch (e) { console.error('[automations] step error:', e.message); db.run('UPDATE automation_enrollments SET last_error=? WHERE id=?', [e.message, enr.id]) }
  }
}

// Daily scheduled automations enroll their matching audience once per day.
async function runScheduledDaily() {
  const rows = db.all("SELECT * FROM automations WHERE status='active'")
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date())
  const nowMin = Number(parts.find(p => p.type === 'hour').value) * 60 + Number(parts.find(p => p.type === 'minute').value)
  const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date())
  for (const a of rows) {
    const g = parseGraph(a.active_graph)
    const trig = triggerNodes(g).find(t => t.type === 'recurring_schedule' || t.type === 'specific_date')
    if (!trig) continue
    if (trig.type === 'specific_date') { if (String(trig.config?.run_date) !== todayKey) continue }
    const [rh, rm] = String(trig.config?.run_time || '09:00').split(':').map(Number)
    if (nowMin < (rh || 9) * 60 + (rm || 0)) continue
    if (a.last_run_at && String(a.last_run_at).slice(0, 10) === todayKey) continue
    // audience = clients matching the first condition node right after the trigger (if any)
    const firstId = nextNodeId(g, trig.id, null)
    const firstNode = firstId ? nodeById(g, firstId) : null
    let clients = []
    if (firstNode && firstNode.type === 'condition') {
      clients = db.all('SELECT * FROM clients LIMIT 5000').filter(c => evalCondition(firstNode, deriveClient(c)))
    } else {
      clients = db.all("SELECT * FROM clients WHERE status NOT IN ('archived','closed') LIMIT 5000")
    }
    let enrolled = 0
    for (const c of clients) { if (enrollClient(a, c.id)) enrolled++ }
    db.run("UPDATE automations SET last_run_at=?, last_run_summary=? WHERE id=?", [nowIso(), `${enrolled} enrolled`, a.id])
  }
}

// Called every minute by the scheduler.
export async function automationTick() {
  try { processEventQueue() } catch (e) { console.error('[automations] queue:', e.message) }
  try { await runScheduledDaily() } catch (e) { console.error('[automations] daily:', e.message) }
  try { await stepDueEnrollments() } catch (e) { console.error('[automations] step:', e.message) }
}
// legacy name kept so scheduler.js keeps importing without change
export const runDueAutomations = automationTick

// ---------------------------------------------------------------------------
// derived list stats
// ---------------------------------------------------------------------------
function autoStats(id) {
  const s = db.get(`SELECT
    SUM(CASE WHEN status IN ('active','waiting') THEN 1 ELSE 0 END) AS enrolled,
    SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
    FROM automation_enrollments WHERE automation_id=?`, [id]) || {}
  return { enrolled: s.enrolled || 0, completed: s.completed || 0, failed: s.failed || 0 }
}
function withGraph(a) {
  // ensure both graphs exist (upgrade legacy flow_data on the fly)
  if (!a.active_graph && !a.draft_graph && a.flow_data) {
    const g = legacyToGraph(parse(a.flow_data, {}))
    a.draft_graph = JSON.stringify(g)
    if (a.enabled) a.active_graph = a.draft_graph
  }
  return a
}
const trigLabel = (a) => { const g = parseGraph(a.active_graph || a.draft_graph); const t = triggerNodes(g)[0]; return t ? labelFor(t) : '—' }

// ---------------------------------------------------------------------------
// CRUD + LIFECYCLE
// ---------------------------------------------------------------------------
router.get('/', (_req, res) => {
  const rows = db.all('SELECT * FROM automations ORDER BY updated_at DESC').map(withGraph)
  res.json(rows.map(a => ({
    id: a.id, name: a.name, description: a.description, status: a.status || (a.enabled ? 'active' : 'draft'),
    owner: a.owner || 'Matt', trigger_label: trigLabel(a), enabled: a.enabled,
    updated_at: a.updated_at, activated_at: a.activated_at, last_run_summary: a.last_run_summary,
    ...autoStats(a.id),
  })))
})

router.get('/:id', (req, res) => {
  const a = withGraph(db.get('SELECT * FROM automations WHERE id = ?', [Number(req.params.id)]))
  if (!a) return res.status(404).json({ error: 'Automation not found' })
  a.stats = autoStats(a.id)
  a.versions = db.all('SELECT id, version_number, status, created_by, created_at, published_at FROM automation_versions WHERE automation_id=? ORDER BY version_number DESC', [a.id])
  a.recent_runs = db.all('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY run_at DESC LIMIT 10', [a.id])
  res.json(a)
})

router.post('/', (req, res) => {
  const b = req.body || {}
  const graph = b.graph || emptyGraph()
  const r = db.run('INSERT INTO automations (name, description, status, enabled, owner, draft_graph, settings, trigger_type) VALUES (?,?,?,?,?,?,?,?)',
    [b.name || 'Untitled automation', b.description || null, 'draft', 0, b.owner || 'Matt', JSON.stringify(graph), JSON.stringify(b.settings || {}), 'event'])
  res.status(201).json({ id: r.lastInsertRowid })
})

// Save the DRAFT graph (autosave + manual save both hit this). Never touches the
// running active_graph.
router.put('/:id', (req, res) => saveDraft(req, res))
router.post('/:id/save-draft', (req, res) => saveDraft(req, res))
function saveDraft(req, res) {
  const b = req.body || {}
  const id = Number(req.params.id)
  const cur = db.get('SELECT * FROM automations WHERE id=?', [id])
  if (!cur) return res.status(404).json({ error: 'Automation not found' })
  const graph = b.graph !== undefined ? b.graph : parseGraph(cur.draft_graph)
  db.run("UPDATE automations SET name=?, description=?, owner=?, draft_graph=?, settings=?, updated_at=datetime('now') WHERE id=?",
    [b.name ?? cur.name, b.description ?? cur.description, b.owner ?? cur.owner, JSON.stringify(graph), JSON.stringify(b.settings ?? parse(cur.settings, {})), id])
  res.json({ success: true, saved_at: nowIso() })
}

router.post('/:id/validate', (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id=?', [Number(req.params.id)])
  if (!a) return res.status(404).json({ error: 'Automation not found' })
  const graph = req.body?.graph || parseGraph(a.draft_graph)
  res.json(validateGraph(graph, { name: req.body?.name ?? a.name }))
})

// Publish the draft -> becomes the active version. Snapshots into versions.
function publishDraft(id, createdBy = 'Matt') {
  const a = db.get('SELECT * FROM automations WHERE id=?', [id])
  if (!a) throw new Error('Automation not found')
  const graph = parseGraph(a.draft_graph)
  const v = (a.active_version || 0) + 1
  db.run('INSERT INTO automation_versions (automation_id, version_number, graph, settings, status, created_by, published_at) VALUES (?,?,?,?,?,?,?)',
    [id, v, JSON.stringify(graph), a.settings, 'published', createdBy, nowIso()])
  db.run("UPDATE automations SET active_graph=?, active_version=?, updated_at=datetime('now') WHERE id=?", [JSON.stringify(graph), v, id])
  return v
}

router.post('/:id/publish', (req, res) => {
  try { const v = publishDraft(Number(req.params.id)); res.json({ success: true, version: v }) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

router.post('/:id/activate', (req, res) => {
  const id = Number(req.params.id)
  const a = db.get('SELECT * FROM automations WHERE id=?', [id])
  if (!a) return res.status(404).json({ error: 'Automation not found' })
  const graph = parseGraph(a.draft_graph)
  const result = validateGraph(graph, { name: a.name })
  if (!result.ok) return res.status(400).json({ error: 'Cannot activate — fix validation errors first', validation: result })
  publishDraft(id)
  db.run("UPDATE automations SET status='active', enabled=1, activated_at=datetime('now') WHERE id=?", [id])
  res.json({ success: true, status: 'active' })
})

router.post('/:id/pause', (req, res) => {
  db.run("UPDATE automations SET status='paused', enabled=0 WHERE id=?", [Number(req.params.id)])
  res.json({ success: true, status: 'paused' })
})
router.post('/:id/resume', (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id=?', [Number(req.params.id)])
  if (!a || !a.active_graph) return res.status(400).json({ error: 'Nothing published to resume — activate first' })
  db.run("UPDATE automations SET status='active', enabled=1 WHERE id=?", [Number(req.params.id)])
  res.json({ success: true, status: 'active' })
})

router.post('/:id/duplicate', (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id=?', [Number(req.params.id)])
  if (!a) return res.status(404).json({ error: 'Automation not found' })
  const graph = a.draft_graph || a.active_graph || JSON.stringify(emptyGraph())
  const r = db.run('INSERT INTO automations (name, description, status, enabled, owner, draft_graph, settings, trigger_type) VALUES (?,?,?,?,?,?,?,?)',
    [`${a.name} (copy)`, a.description, 'draft', 0, a.owner || 'Matt', graph, a.settings || '{}', a.trigger_type || 'event'])
  res.status(201).json({ id: r.lastInsertRowid })
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  db.run('DELETE FROM automations WHERE id = ?', [id])
  db.run('DELETE FROM automation_enrollments WHERE automation_id = ?', [id])
  res.json({ success: true })
})

// ---- versions ----
router.get('/:id/versions', (req, res) => {
  res.json(db.all('SELECT id, version_number, status, created_by, created_at, published_at FROM automation_versions WHERE automation_id=? ORDER BY version_number DESC', [Number(req.params.id)]))
})
router.post('/:id/restore/:versionNumber', (req, res) => {
  const v = db.get('SELECT * FROM automation_versions WHERE automation_id=? AND version_number=?', [Number(req.params.id), Number(req.params.versionNumber)])
  if (!v) return res.status(404).json({ error: 'Version not found' })
  db.run("UPDATE automations SET draft_graph=?, updated_at=datetime('now') WHERE id=?", [v.graph, Number(req.params.id)])
  res.json({ success: true, restored_to_draft: v.version_number })
})

// ---- activity + metrics ----
router.get('/:id/activity', (req, res) => {
  const id = Number(req.params.id)
  const status = req.query.status
  const where = status ? ' AND e.status = ?' : ''
  const params = status ? [id, status] : [id]
  const rows = db.all(`SELECT e.*, c.first_name, c.last_name, c.email
    FROM automation_enrollments e LEFT JOIN clients c ON c.id = e.client_id
    WHERE e.automation_id = ?${where} ORDER BY e.entered_at DESC LIMIT 500`, params)
  res.json(rows)
})
router.get('/:id/metrics', (req, res) => {
  const id = Number(req.params.id)
  const s = autoStats(id)
  const waiting = db.get("SELECT COUNT(*) c FROM automation_enrollments WHERE automation_id=? AND status='waiting'", [id]).c
  const removed = db.get("SELECT COUNT(*) c FROM automation_enrollments WHERE automation_id=? AND status='removed'", [id]).c
  const emails = db.get("SELECT COUNT(*) c FROM automation_executions WHERE automation_id=? AND node_type='send_email' AND status='success'", [id]).c
  const total = db.get('SELECT COUNT(*) c FROM automation_enrollments WHERE automation_id=?', [id]).c
  res.json({ total_enrolled: total, active: s.enrolled, waiting, completed: s.completed, failed: s.failed, removed, emails_sent: emails })
})
router.get('/enrollments/:eid/history', (req, res) => {
  res.json(db.all('SELECT * FROM automation_executions WHERE enrollment_id=? ORDER BY started_at ASC', [Number(req.params.eid)]))
})

// ---- manual enrollment + removal ----
router.post('/:id/enroll', (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id=?', [Number(req.params.id)])
  if (!a || a.status !== 'active') return res.status(400).json({ error: 'Activate the automation before enrolling contacts' })
  const ids = req.body?.client_ids || []
  let n = 0
  for (const cid of ids) { if (enrollClient(a, Number(cid), { source: 'manual' })) n++ }
  res.json({ success: true, enrolled: n })
})
router.post('/enrollments/:eid/remove', (req, res) => {
  db.run("UPDATE automation_enrollments SET status='removed', exit_reason='manually removed', completed_at=? WHERE id=?", [nowIso(), Number(req.params.eid)])
  res.json({ success: true })
})
router.post('/executions/:xid/retry', async (req, res) => {
  const x = db.get('SELECT * FROM automation_executions WHERE id=?', [Number(req.params.xid)])
  if (!x) return res.status(404).json({ error: 'Execution not found' })
  db.run('DELETE FROM automation_executions WHERE id=?', [x.id])
  const enr = db.get('SELECT * FROM automation_enrollments WHERE id=?', [x.enrollment_id])
  if (enr) { db.run("UPDATE automation_enrollments SET status='active', current_node_id=?, next_run_at=? WHERE id=?", [x.node_id, nowIso(), enr.id]); await advanceEnrollment(db.get('SELECT * FROM automation_enrollments WHERE id=?', [enr.id])) }
  res.json({ success: true })
})

// ---- preview audience (kept; used by trigger/condition config) ----
router.post('/preview-audience', (req, res) => {
  try {
    const audience = req.body?.audience || {}
    const { where, params } = buildClientFilter(audience)
    const count = db.get(`SELECT COUNT(*) as c FROM clients${where}`, params).c
    const sample = db.all(`SELECT id, first_name, last_name, email, status FROM clients${where} LIMIT 6`, params)
    res.json({ count, sample })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

// ---- test a single action against a sample/real contact (dry, no enrollment) ----
router.post('/test-action', async (req, res) => {
  const node = req.body?.node
  if (!node) return res.status(400).json({ error: 'node required' })
  let client = req.body?.client_id ? db.get('SELECT * FROM clients WHERE id=?', [Number(req.body.client_id)]) : null
  if (!client) client = db.get('SELECT * FROM clients WHERE email IS NOT NULL LIMIT 1') || { id: 0, first_name: 'Test', last_name: 'Contact', email: req.body?.to_email }
  try { const out = await runAction(node, client, { automationId: 0 }); res.json({ success: true, output: out }) }
  catch (e) { res.status(400).json({ success: false, error: e.message }) }
})

// ---- run scheduled/daily automation now, or step a contact's enrollment ----
router.post('/:id/run-now', async (req, res) => {
  const a = db.get('SELECT * FROM automations WHERE id=?', [Number(req.params.id)])
  if (!a) return res.status(404).json({ error: 'Automation not found' })
  if (a.status !== 'active') return res.status(400).json({ error: 'Activate the automation first' })
  db.run('UPDATE automations SET last_run_at = NULL WHERE id=?', [a.id])  // force today's scheduled pass
  await runScheduledDaily()
  await stepDueEnrollments()
  res.json({ success: true, ...autoStats(a.id) })
})

export default router
