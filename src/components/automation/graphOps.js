// Pure helpers for editing the automation graph {nodes, edges}.
// The canvas renders a vertical tree by walking edges from the trigger; these
// ops keep the graph well-formed (reachable, single default edge per slot).
import { getDef, branchKeysFor } from '../../../shared/automationRegistry.js'

export const uid = () => 'n' + Math.random().toString(36).slice(2, 9)
export const emptyGraph = () => ({ nodes: [], edges: [] })

export const nodeById = (g, id) => g.nodes.find(n => n.id === id) || null
export const childEdge = (g, from, branch = null) =>
  g.edges.find(e => e.from === from && (branch == null ? (e.branch == null || e.branch === 'next') : e.branch === branch))
export const childId = (g, from, branch = null) => { const e = childEdge(g, from, branch); return e ? e.to : null }
export const triggerNode = (g) => g.nodes.find(n => n.kind === 'trigger') || null

// which branch a newly-inserted node hands its displaced child to
export function primaryBranch(node) {
  const keys = branchKeysFor(node)
  if (!keys) return null
  return keys[0]
}

export function makeNode(item) {
  // item may be a registry def or {type, kind}
  const def = getDef(item.type) || item
  const kind = def.kind || item.kind || 'action'
  const config = {}
  // seed defaults from schema
  for (const f of (def.config || [])) if (f.default !== undefined) config[f.key] = f.default
  if (def.type === 'condition') config.rules = [{ field: '', op: 'is', value: '' }]
  return { id: uid(), kind, type: def.type, config }
}

function setEdge(g, from, branch, to) {
  g.edges = g.edges.filter(e => !(e.from === from && (branch == null ? (e.branch == null || e.branch === 'next') : e.branch === branch)))
  if (to) g.edges.push({ from, to, branch: branch == null ? null : branch })
}

// Insert `node` into the slot leaving (fromId, branch). If that slot already
// points somewhere, the new node inherits that target on its primary branch.
export function insertNode(graph, fromId, branch, node) {
  const g = clone(graph)
  const existingTarget = childId(g, fromId, branch)
  g.nodes.push(node)
  setEdge(g, fromId, branch, node.id)
  if (existingTarget) {
    const pb = primaryBranch(node)
    setEdge(g, node.id, pb, existingTarget)
  }
  return gc(g)
}

// Add the very first node after the trigger (or replace an empty flow).
export function addFirst(graph, node) {
  const g = clone(graph)
  const t = triggerNode(g)
  g.nodes.push(node)
  if (t) setEdge(g, t.id, null, node.id)
  return gc(g)
}

export function setTrigger(graph, node) {
  const g = clone(graph)
  const existing = triggerNode(g)
  if (existing) {
    // replace type/config in place, keep downstream edges
    existing.type = node.type; existing.config = node.config || {}
    return g
  }
  g.nodes.push(node)
  return g
}

export function updateConfig(graph, id, config) {
  const g = clone(graph)
  const n = nodeById(g, id); if (n) n.config = config
  return g
}

export function duplicateNode(graph, id) {
  const g = clone(graph)
  const orig = nodeById(g, id); if (!orig || orig.kind === 'trigger') return graph
  const copy = { ...orig, id: uid(), config: JSON.parse(JSON.stringify(orig.config || {})) }
  // insert copy right after original on its default branch
  return insertNode(g, id, null, copy)
}

// Remove a node; splice its default child up to its parent(s). Non-primary
// branch subtrees are dropped (garbage-collected).
export function removeNode(graph, id) {
  const g = clone(graph)
  const n = nodeById(g, id); if (!n || n.kind === 'trigger') return graph
  const defaultChild = childId(g, id, primaryBranch(n) || null)
  // repoint incoming edges to the default child
  for (const e of g.edges) if (e.to === id) e.to = defaultChild || null
  g.edges = g.edges.filter(e => e.from !== id && e.to !== null && e.to !== id)
  g.nodes = g.nodes.filter(x => x.id !== id)
  return gc(g)
}

// keep only nodes reachable from the trigger
function gc(g) {
  const t = triggerNode(g)
  if (!t) return g
  const seen = new Set()
  const stack = [t.id]
  while (stack.length) {
    const cur = stack.pop()
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const e of g.edges) if (e.from === cur && e.to && !seen.has(e.to)) stack.push(e.to)
  }
  g.nodes = g.nodes.filter(n => seen.has(n.id))
  g.edges = g.edges.filter(e => seen.has(e.from) && seen.has(e.to))
  return g
}

const clone = (g) => ({ nodes: g.nodes.map(n => ({ ...n })), edges: g.edges.map(e => ({ ...e })) })
