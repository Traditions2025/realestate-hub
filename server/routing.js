// Lead routing engine (P1-6). Evaluates configured rules in priority order and assigns a
// lead to an agent (round-robin / weighted / specific). INERT until routing_enabled is on,
// and a manual reassignment is sticky (never auto-overridden). No trigger auto-calls this
// yet — it runs only when explicitly invoked (e.g. the "run on unassigned" admin action).
import db from './database.js'

export function routingEnabled() { return db.getSetting('routing_enabled', '0') === '1' }

const norm = (s) => String(s == null ? '' : s).toLowerCase().trim()
const inList = (val, list) => !list || !list.length || list.map(norm).includes(norm(val))

function matchRule(client, cond) {
  cond = cond || {}
  if (!inList(client.source, cond.sources)) return false
  if (!inList(client.city, cond.cities)) return false
  if (!inList(client.zip, cond.zips)) return false
  if (!inList(client.type, cond.types)) return false
  if (!inList(client.status, cond.statuses)) return false
  if (cond.tags_any && cond.tags_any.length) {
    const hay = norm(client.tags)
    if (!cond.tags_any.some(t => hay.includes(norm(t)))) return false
  }
  const price = Number(client.budget_max || client.search_price_max || 0)
  if (cond.price_min && price && price < Number(cond.price_min)) return false
  if (cond.price_max && price && price > Number(cond.price_max)) return false
  return true
}

// Pick the next agent for a rule. Round-robin and weighted advance rr_cursor so
// assignment rotates fairly; specific always uses the first target.
function pickAgent(rule, { advance = true } = {}) {
  let targets = []; try { targets = JSON.parse(rule.targets_json || '[]') } catch {}
  targets = targets.filter(t => t && t.agent)
  if (!targets.length) return null
  if (rule.method === 'specific') return targets[0].agent
  const pool = rule.method === 'weighted'
    ? targets.flatMap(t => Array(Math.max(1, Math.round(Number(t.weight) || 1))).fill(t.agent))
    : targets.map(t => t.agent)
  const idx = (rule.rr_cursor || 0) % pool.length
  if (advance) db.run('UPDATE routing_rules SET rr_cursor=? WHERE id=?', [(rule.rr_cursor || 0) + 1, rule.id])
  return pool[idx]
}

// Route one lead. Returns { routed, agent?, rule?, reason?, dryRun }.
export function routeLead(client, { source = 'routing', dryRun = false, force = false } = {}) {
  if (!force && !routingEnabled()) return { routed: false, reason: 'routing disabled' }
  if (!client) return { routed: false, reason: 'no client' }
  if (client.agent_assigned && String(client.agent_assigned).trim()) return { routed: false, reason: 'already assigned (manual assignment is sticky)' }
  const rules = db.all('SELECT * FROM routing_rules WHERE enabled=1 ORDER BY priority ASC, id ASC')
  for (const r of rules) {
    let cond = {}; try { cond = JSON.parse(r.conditions_json || '{}') } catch {}
    if (!matchRule(client, cond)) continue
    const agent = pickAgent(r, { advance: !dryRun })
    if (!agent) continue
    if (!dryRun) {
      db.run('UPDATE clients SET agent_assigned=? WHERE id=?', [agent, client.id])
      db.run('INSERT INTO routing_history (client_id, previous_owner, new_owner, rule_id, rule_name, reason, source) VALUES (?,?,?,?,?,?,?)',
        [client.id, client.agent_assigned || null, agent, r.id, r.name, `matched rule "${r.name}"`, source])
    }
    return { routed: true, agent, rule: r.name, dryRun }
  }
  return { routed: false, reason: 'no matching rule' }
}

// Run routing across currently-unassigned leads (manual admin action). dryRun previews.
export function routeUnassigned({ dryRun = false, limit = 500 } = {}) {
  if (!routingEnabled()) return { ok: false, reason: 'routing is turned off' }
  const rows = db.all("SELECT * FROM clients WHERE (agent_assigned IS NULL OR agent_assigned='') ORDER BY id DESC LIMIT ?", [Math.min(2000, limit)])
  let routed = 0; const sample = []
  for (const c of rows) {
    const r = routeLead(c, { source: 'routing', dryRun })
    if (r.routed) { routed++; if (sample.length < 25) sample.push({ client: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.id, agent: r.agent, rule: r.rule }) }
  }
  return { ok: true, considered: rows.length, routed, dryRun, sample }
}
