// P1-5: Smart Audiences behavioral segmentation engine.
//
// Compiles a recursive AND/OR condition tree into a safe parameterized SQL WHERE over
// the clients table. Every field and operator is whitelisted (values are always bound
// params), so an audience definition can never inject SQL. Behavioral fields (intent,
// last-human-contact, repeat-view, ai-managed, handoff-pending, overdue-next-action) are
// resolved via correlated subqueries against the AI/comms/activity tables.
//
// SEGMENTATION ONLY. This module builds queries and previews counts. It never sends.

// ---- Field registry: key -> { sql, type, label, group } ----
// `sql` is a scalar SQL expression evaluated per clients row (may be a correlated subquery).
const FIELDS = {
  // Core client attributes
  type:              { sql: 'c.type', type: 'text', label: 'Lead type', group: 'Contact' },
  status:            { sql: 'c.status', type: 'text', label: 'Status', group: 'Contact' },
  city:              { sql: 'c.city', type: 'text', label: 'City', group: 'Contact' },
  zip:               { sql: 'c.zip', type: 'text', label: 'ZIP', group: 'Contact' },
  source:            { sql: 'c.source', type: 'text', label: 'Source', group: 'Contact' },
  agent:             { sql: 'c.agent_assigned', type: 'text', label: 'Assigned agent', group: 'Contact' },
  tag:               { sql: 'c.tags', type: 'tag', label: 'Tag', group: 'Contact' },
  fsbo_status:       { sql: 'c.fsbo_status', type: 'text', label: 'FSBO status', group: 'Contact' },
  lead_score:        { sql: 'CAST(c.lead_score AS INTEGER)', type: 'num', label: 'Lead score', group: 'Scores' },
  realist_sell_score:{ sql: 'c.realist_sell_score', type: 'num', label: 'Realist sell score', group: 'Scores' },
  has_email:         { sql: "(CASE WHEN c.email IS NOT NULL AND c.email != '' THEN 1 ELSE 0 END)", type: 'bool', label: 'Has email', group: 'Contact' },
  email_opt_out:     { sql: 'COALESCE(c.marketing_email_opt_out,0)', type: 'bool', label: 'Email opted out', group: 'Contact' },
  text_opt_out:      { sql: 'COALESCE(c.hub_text_opt_out,0)', type: 'bool', label: 'Text opted out (STOP)', group: 'Contact' },
  created_days:      { sql: "(julianday('now') - julianday(c.created_at))", type: 'num', label: 'Days since added', group: 'Timing' },

  // Behavioral / AI signals
  intent:            { sql: 'COALESCE((SELECT li.intent_score FROM lead_intelligence li WHERE li.client_id=c.id),0)', type: 'num', label: 'Intent score', group: 'AI signals' },
  peak_intent:       { sql: 'COALESCE((SELECT li.peak_intent FROM lead_intelligence li WHERE li.client_id=c.id),0)', type: 'num', label: 'Peak intent', group: 'AI signals' },
  conversation_type: { sql: '(SELECT li.conversation_type FROM lead_intelligence li WHERE li.client_id=c.id)', type: 'text', label: 'Conversation type', group: 'AI signals' },
  ai_managed:        { sql: "(CASE WHEN EXISTS(SELECT 1 FROM ai_lead_state s WHERE s.client_id=c.id AND s.ai_managed=1) THEN 1 ELSE 0 END)", type: 'bool', label: 'AI-managed', group: 'AI signals' },
  handoff_pending:   { sql: "(CASE WHEN EXISTS(SELECT 1 FROM ai_handoffs h WHERE h.client_id=c.id AND h.status='open') THEN 1 ELSE 0 END)", type: 'bool', label: 'Handoff pending', group: 'AI signals' },
  overdue_next_action:{ sql: "(CASE WHEN (SELECT s.ai_next_action_at FROM ai_lead_state s WHERE s.client_id=c.id) < datetime('now') THEN 1 ELSE 0 END)", type: 'bool', label: 'Overdue next action', group: 'AI signals' },
  // Days since the last HUMAN outbound touch (AI sends carry an ai_action_id; humans do not).
  last_human_contact_days: { sql: "(julianday('now') - julianday((SELECT MAX(co.occurred_at) FROM communications co WHERE co.client_id=c.id AND co.direction='outgoing' AND co.ai_action_id IS NULL)))", type: 'num', label: 'Days since human contact', group: 'Behavior' },
  repeat_views_14d:  { sql: "(SELECT COUNT(*) FROM lead_activity la WHERE la.client_id=c.id AND la.created_at >= datetime('now','-14 days'))", type: 'num', label: 'Website events (14d)', group: 'Behavior' },
}

// ---- Operators allowed per field type ----
const OPS = {
  num:  ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'not_null'],
  text: ['eq', 'ne', 'in', 'not_in', 'contains', 'is_null', 'not_null'],
  bool: ['is_true', 'is_false'],
  tag:  ['contains', 'not_contains'],
}
const SQLOP = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' }

export function fieldMeta() {
  return Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label, type: f.type, group: f.group, ops: OPS[f.type] }))
}

// Compile a single leaf {field, op, value} into { sql, params }.
function compileLeaf(node) {
  const f = FIELDS[node.field]
  if (!f) throw new Error('unknown field: ' + node.field)
  const allowed = OPS[f.type]
  const op = node.op
  if (!allowed.includes(op)) throw new Error(`operator ${op} not allowed for ${node.field}`)
  const expr = f.sql
  const v = node.value

  if (op === 'is_null') return { sql: `${expr} IS NULL`, params: [] }
  if (op === 'not_null') return { sql: `${expr} IS NOT NULL`, params: [] }
  if (op === 'is_true') return { sql: `${expr} = 1`, params: [] }
  if (op === 'is_false') return { sql: `${expr} = 0`, params: [] }
  if (op === 'between') {
    if (!Array.isArray(v) || v.length !== 2) throw new Error('between needs [min,max]')
    return { sql: `${expr} BETWEEN ? AND ?`, params: [Number(v[0]), Number(v[1])] }
  }
  if (op === 'in' || op === 'not_in') {
    const arr = Array.isArray(v) ? v : [v]
    if (!arr.length) throw new Error(`${op} needs a non-empty list`)
    const kw = op === 'in' ? 'IN' : 'NOT IN'
    const clause = `${expr} ${kw} (${arr.map(() => '?').join(',')})`
    // NOT IN must also let NULLs through (a NULL is "not in" the set for our intent).
    return { sql: op === 'not_in' ? `(${expr} IS NULL OR ${clause})` : clause, params: arr.map(String) }
  }
  if (op === 'contains' || op === 'not_contains') {
    if (f.type === 'tag') {
      const like = `%"${v}"%`
      return op === 'contains'
        ? { sql: `${expr} LIKE ?`, params: [like] }
        : { sql: `(${expr} IS NULL OR ${expr} NOT LIKE ?)`, params: [like] }
    }
    return { sql: `${expr} LIKE ?`, params: [`%${v}%`] }
  }
  // scalar comparisons
  const val = f.type === 'num' ? Number(v) : String(v)
  return { sql: `${expr} ${SQLOP[op]} ?`, params: [val] }
}

// Compile a node: a group ({all:[...]}/{any:[...]}) or a leaf. Depth-limited.
function compileNode(node, depth = 0) {
  if (depth > 6) throw new Error('condition nesting too deep')
  if (!node || typeof node !== 'object') throw new Error('invalid condition')
  const kids = node.all || node.any
  if (Array.isArray(kids)) {
    if (!kids.length) return { sql: '1=1', params: [] }
    const joiner = node.all ? ' AND ' : ' OR '
    const parts = kids.map(k => compileNode(k, depth + 1))
    return { sql: '(' + parts.map(p => p.sql).join(joiner) + ')', params: parts.flatMap(p => p.params) }
  }
  return compileLeaf(node)
}

// Public: compile a tree into { where, params }. Empty tree matches everyone.
export function compileAudience(tree) {
  if (!tree || (Array.isArray(tree.all) && !tree.all.length) || (Array.isArray(tree.any) && !tree.any.length)) {
    return { where: ' WHERE 1=1', params: [] }
  }
  const { sql, params } = compileNode(tree)
  return { where: ' WHERE ' + sql, params }
}

// Preview: count + a small sample. `db` is injected to keep this module testable.
export function previewAudience(db, tree, { limit = 25 } = {}) {
  const { where, params } = compileAudience(tree)
  const count = db.get(`SELECT COUNT(*) c FROM clients c${where}`, params).c
  const sample = db.all(
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.city, c.type, c.status
     FROM clients c${where} ORDER BY CAST(c.lead_score AS INTEGER) DESC LIMIT ?`,
    [...params, Number(limit)]
  )
  return { count, sample }
}
