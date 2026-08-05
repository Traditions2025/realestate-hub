import React, { useState, useEffect, useRef, useCallback } from 'react'
import { authFetch } from '../api'
import ConfigDrawer from './automation/ConfigDrawer'
import {
  TRIGGERS, CONTROLS, triggersByCategory, actionsByGroup, CATEGORY_COLOR, colorForNode,
  iconFor, labelFor, nodeSummary, branchKeysFor, validateGraph, validateNode, getDef,
} from '../../shared/automationRegistry.js'
import {
  makeNode, insertNode, addFirst, setTrigger as opSetTrigger, updateConfig, duplicateNode,
  removeNode, nodeById, childId, triggerNode, emptyGraph,
} from './automation/graphOps'

const BRANCH_LABEL = { yes: 'Yes', no: 'No', continue: 'Continue', timeout: 'Timed out', met: 'Goal met', a: 'Path A', b: 'Path B', other: 'Other' }
const branchLabel = (node, key) => {
  if (node.type === 'branch') return key === 'other' ? 'Other' : key
  return BRANCH_LABEL[key] || key
}

export default function AutomationBuilder({ automationId, onClose }) {
  const [graph, setGraph] = useState(emptyGraph())
  const [name, setName] = useState('Untitled automation')
  const [status, setStatus] = useState('draft')
  const [settings, setSettings] = useState({})
  const [selId, setSelId] = useState(null)
  const [tab, setTab] = useState('triggers')
  const [search, setSearch] = useState('')
  const [picker, setPicker] = useState(null)       // { fromId, branch }
  const [dirty, setDirty] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showValidation, setShowValidation] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [templates, setTemplates] = useState([])
  const [automations, setAutomations] = useState([])
  const [drips, setDrips] = useState([])
  const [loading, setLoading] = useState(true)
  const loadedRef = useRef(false)

  // ---- load ----
  useEffect(() => {
    authFetch('/api/email/templates').then(r => r.json()).then(setTemplates).catch(() => {})
    authFetch('/api/automations').then(r => r.json()).then(setAutomations).catch(() => {})
    authFetch('/api/drips').then(r => r.json()).then(d => setDrips(Array.isArray(d) ? d : [])).catch(() => {})
  }, [])
  useEffect(() => {
    setLoading(true)
    authFetch(`/api/automations/${automationId}`).then(r => r.json()).then(a => {
      setName(a.name || 'Untitled automation')
      setStatus(a.status || 'draft')
      let g = null
      try { g = a.draft_graph ? JSON.parse(a.draft_graph) : null } catch {}
      setGraph(g && Array.isArray(g.nodes) ? g : emptyGraph())
      try { setSettings(a.settings ? JSON.parse(a.settings) : {}) } catch { setSettings({}) }
      setLoading(false); loadedRef.current = true; setDirty(false)
    }).catch(() => setLoading(false))
  }, [automationId])

  // ---- autosave (debounced) ----
  const saveTimer = useRef(null)
  const doSave = useCallback(async () => {
    setSaving(true); setSaveError(null)
    try {
      const r = await authFetch(`/api/automations/${automationId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, graph, settings }),
      })
      if (!r.ok) throw new Error('save failed')
      const j = await r.json()
      setSavedAt(j.saved_at || new Date().toISOString()); setDirty(false)
    } catch (e) { setSaveError('Could not save. Retrying…'); setTimeout(doSave, 4000) }
    finally { setSaving(false) }
  }, [automationId, name, graph, settings])

  useEffect(() => {
    if (!loadedRef.current) return
    setDirty(true)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(doSave, 1200)
    return () => clearTimeout(saveTimer.current)
  }, [graph, name, settings]) // eslint-disable-line

  // ---- unsaved guard ----
  useEffect(() => {
    const h = (e) => { if (dirty) { e.preventDefault(); e.returnValue = '' } }
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  // ---- graph edits ----
  const trig = triggerNode(graph)
  const chooseTrigger = (def) => {
    const node = makeNode(def)
    setGraph(g => opSetTrigger(g, node))
    setSelId(triggerNode(graph)?.id || node.id)
    setTab('steps')
    setTimeout(() => setSelId(triggerNode(opSetTrigger(graph, node))?.id || node.id), 0)
  }
  const addStep = (def, at) => {
    if (!trig) { setTab('triggers'); return }
    const node = makeNode(def)
    setGraph(g => {
      if (at) return insertNode(g, at.fromId, at.branch, node)
      // no anchor: append to end of the trigger's default path
      let cursor = trig.id, branch = null, guard = 0
      let g2 = g
      while (guard++ < 200) { const next = childId(g2, cursor, branch); if (!next) break; cursor = next; branch = null }
      return insertNode(g2, cursor, branch, node)
    })
    setSelId(node.id); setPicker(null)
  }
  const patchConfig = (id, config) => setGraph(g => updateConfig(g, id, config))
  const delNode = (id) => { setGraph(g => removeNode(g, id)); setSelId(null) }
  const dupNode = (id) => setGraph(g => duplicateNode(g, id))

  const testAction = async (node) => {
    const r = await authFetch('/api/automations/test-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ node }) }).then(x => x.json()).catch(e => ({ error: e.message }))
    alert(r.success ? `✓ Test ran: ${r.output}` : `Test failed: ${r.error}`)
  }

  // ---- validation ----
  const validation = validateGraph(graph, { name })
  const errsByNode = {}
  for (const e of validation.errors) if (e.nodeId) (errsByNode[e.nodeId] = errsByNode[e.nodeId] || []).push(e.message)

  const activate = async () => {
    await doSave()
    const r = await authFetch(`/api/automations/${automationId}/activate`, { method: 'POST' }).then(x => x.json())
    if (r.success) { setStatus('active'); setShowValidation(false) }
    else { setShowValidation(true); alert(r.error || 'Fix validation errors first') }
  }
  const pause = async () => { await authFetch(`/api/automations/${automationId}/pause`, { method: 'POST' }); setStatus('paused') }
  const resume = async () => { const r = await authFetch(`/api/automations/${automationId}/resume`, { method: 'POST' }).then(x => x.json()); if (r.success) setStatus('active'); else alert(r.error) }
  const publish = async () => { await doSave(); const r = await authFetch(`/api/automations/${automationId}/publish`, { method: 'POST' }).then(x => x.json()); alert(r.success ? `Published v${r.version}. The live automation now runs this version.` : r.error) }
  const duplicate = async () => { const r = await authFetch(`/api/automations/${automationId}/duplicate`, { method: 'POST' }).then(x => x.json()); if (r.id) { onClose?.(true) } }
  const del = async () => { if (!confirm('Delete this automation? Enrolled contacts will be removed.')) return; await authFetch(`/api/automations/${automationId}`, { method: 'DELETE' }); onClose?.(true) }

  const selNode = selId ? nodeById(graph, selId) : null
  const sel = selNode ? { ...selNode, _autoId: Number(automationId) } : null

  // ---- sidebar item lists (filtered) ----
  const q = search.trim().toLowerCase()
  const matches = (it) => !q || it.label.toLowerCase().includes(q) || (it.desc || '').toLowerCase().includes(q)
  const triggerCats = triggersByCategory().map(c => ({ ...c, items: c.items.filter(matches) })).filter(c => c.items.length)
  const actionGroups = actionsByGroup().map(c => ({ ...c, items: c.items.filter(matches) })).filter(c => c.items.length)
  const controlItems = CONTROLS.filter(matches)

  const statusChip = STATUS_CHIP[status] || STATUS_CHIP.draft

  if (loading) return <div style={overlay}><div style={{ margin: 'auto', color: 'var(--text-muted)' }}>Loading automation…</div></div>

  return (
    <div style={overlay}>
      {/* ---------- HEADER ---------- */}
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <button className="btn btn-sm btn-secondary" onClick={() => onClose?.(dirty)} aria-label="Back to automations">← Back</button>
        <input aria-label="Automation name" value={name} onChange={e => setName(e.target.value)} style={{ fontSize: 16, fontWeight: 600, background: 'transparent', border: '1px solid transparent', borderRadius: 6, padding: '4px 8px', color: 'var(--text-primary)', width: 280 }} onFocus={e => e.target.style.borderColor = 'var(--border)'} onBlur={e => e.target.style.borderColor = 'transparent'} />
        <span style={{ ...chip, background: statusChip.bg, color: statusChip.fg }}>{statusChip.label}</span>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {saving ? 'Saving…' : saveError ? <span style={{ color: '#ef4444' }}>{saveError}</span> : dirty ? '● Unsaved changes' : savedAt ? `Saved ${timeago(savedAt)}` : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', position: 'relative' }}>
          <button className="btn btn-sm btn-secondary" onClick={doSave} disabled={!dirty || saving}>Save changes</button>
          {status === 'active'
            ? <><button className="btn btn-sm btn-secondary" onClick={publish}>Publish update</button><button className="btn btn-sm btn-secondary" onClick={pause}>❚❚ Pause</button></>
            : status === 'paused'
              ? <button className="btn btn-sm btn-primary" onClick={resume}>▶ Resume</button>
              : <button className="btn btn-sm btn-primary" onClick={activate} title={validation.ok ? 'Activate' : 'Resolve validation first'}>⚡ Activate</button>}
          <button className="btn btn-sm btn-secondary" onClick={() => setMenuOpen(m => !m)} aria-label="More options">⋯</button>
          {menuOpen && (
            <div style={menu} onMouseLeave={() => setMenuOpen(false)}>
              <button style={menuItem} onClick={duplicate}>Duplicate</button>
              <button style={menuItem} onClick={() => { const n = prompt('Rename automation', name); if (n) setName(n); setMenuOpen(false) }}>Rename</button>
              <button style={menuItem} onClick={() => { onClose?.(dirty, 'activity') }}>View activity</button>
              <button style={{ ...menuItem, color: '#ef4444' }} onClick={del}>Delete</button>
            </div>
          )}
        </div>
      </header>

      {/* validation banner */}
      {!validation.ok && (
        <div style={{ padding: '8px 16px', background: 'rgba(245,158,11,0.12)', borderBottom: '1px solid rgba(245,158,11,0.3)', display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ color: '#f59e0b', fontWeight: 600 }}>⚠ {validation.errors.length} thing{validation.errors.length === 1 ? '' : 's'} to fix before activating</span>
          <button className="btn btn-sm btn-secondary" onClick={() => setShowValidation(s => !s)}>{showValidation ? 'Hide' : 'Show'}</button>
        </div>
      )}
      {showValidation && !validation.ok && (
        <div style={{ padding: '8px 16px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', maxHeight: 140, overflowY: 'auto' }}>
          {validation.errors.map((e, i) => (
            <div key={i} style={{ fontSize: 13, padding: '3px 0', cursor: e.nodeId ? 'pointer' : 'default', color: e.nodeId ? 'var(--accent, #2563eb)' : 'var(--text-primary)' }} onClick={() => e.nodeId && setSelId(e.nodeId)}>• {e.message}</div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* ---------- SIDEBAR ---------- */}
        <aside style={{ width: 300, borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <input aria-label="Search steps" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search triggers & steps…" style={{ width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13 }} />
            <div style={{ display: 'flex', marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              {['triggers', 'steps'].map(t => (
                <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer', fontSize: 13, textTransform: 'capitalize', background: tab === t ? 'var(--accent, #2563eb)' : 'transparent', color: tab === t ? '#fff' : 'var(--text-primary)' }}>{t}</button>
              ))}
            </div>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
            {tab === 'triggers' ? (
              triggerCats.length === 0 ? <NoResults q={q} /> :
                triggerCats.map(cat => (
                  <div key={cat.category} style={{ marginBottom: 14 }}>
                    <CategoryHead color={CATEGORY_COLOR.trigger} label={cat.category} />
                    {cat.items.map(it => <SidebarItem key={it.type} it={it} onClick={() => chooseTrigger(it)} accent={CATEGORY_COLOR.trigger} />)}
                  </div>
                ))
            ) : (
              <>
                {(controlItems.length || !q) && <div style={{ marginBottom: 14 }}><CategoryHead color={CATEGORY_COLOR.control} label="Controls" />{controlItems.map(it => <SidebarItem key={it.type} it={it} onClick={() => addStep(it)} accent={CATEGORY_COLOR.control} />)}</div>}
                {actionGroups.map(cat => (
                  <div key={cat.category} style={{ marginBottom: 14 }}>
                    <CategoryHead color={cat.category === 'Communication' ? CATEGORY_COLOR.comm : CATEGORY_COLOR.crm} label={cat.category} />
                    {cat.items.map(it => <SidebarItem key={it.type} it={it} onClick={() => addStep(it)} accent={cat.category === 'Communication' ? CATEGORY_COLOR.comm : CATEGORY_COLOR.crm} />)}
                  </div>
                ))}
                {!controlItems.length && !actionGroups.length && <NoResults q={q} />}
              </>
            )}
          </div>
        </aside>

        {/* ---------- CANVAS ---------- */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--canvas-bg, #0b1220)', backgroundImage: 'radial-gradient(rgba(148,163,184,0.15) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
          onMouseDown={startPan(setPan)}>
          {/* zoom controls */}
          <div style={{ position: 'absolute', right: 14, bottom: 14, zIndex: 5, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ZoomBtn onClick={() => setZoom(z => Math.min(1.6, z + 0.1))}>＋</ZoomBtn>
            <ZoomBtn onClick={() => setZoom(z => Math.max(0.4, z - 0.1))}>－</ZoomBtn>
            <ZoomBtn onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }) }} title="Reset view">⤢</ZoomBtn>
          </div>
          <div style={{ position: 'absolute', left: '50%', top: 30, transform: `translate(-50%,0) translate(${pan.x}px,${pan.y}px) scale(${zoom})`, transformOrigin: 'top center', transition: 'transform .05s' }}>
            {!trig ? (
              <EmptyCanvas />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <NodeCard node={trig} selected={selId === trig.id} onClick={() => setSelId(trig.id)} errs={errsByNode[trig.id]} />
                <TreeRenderer graph={graph} fromId={trig.id} branch={null} onSelect={setSelId} selId={selId} errsByNode={errsByNode} openPicker={(fromId, branch) => setPicker({ fromId, branch })} branchLabel={branchLabel} />
              </div>
            )}
          </div>
        </div>

        {/* ---------- CONFIG DRAWER ---------- */}
        {trig && !selNode && (
          <div style={{ width: 300, borderLeft: '1px solid var(--border)', background: 'var(--bg-secondary)', padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>
            Click any step to configure it. Use the ＋ buttons on the canvas to add steps between others, or pick from the left.
          </div>
        )}
        {sel && (
          <ConfigDrawer node={sel} graph={graph} templates={templates} automations={automations} drips={drips}
            onChange={cfg => patchConfig(sel.id, cfg)} onClose={() => setSelId(null)}
            onDelete={delNode} onDuplicate={dupNode} onTest={testAction} />
        )}
      </div>

      {/* ---------- STEP PICKER ---------- */}
      {picker && <StepPicker onPick={(def) => addStep(def, picker)} onClose={() => setPicker(null)} />}
    </div>
  )
}

// ============================ canvas tree ============================
function TreeRenderer({ graph, fromId, branch, onSelect, selId, errsByNode, openPicker, branchLabel, visited }) {
  visited = visited || new Set()
  const cid = childId(graph, fromId, branch)
  if (!cid) return <PlusSlot onClick={() => openPicker(fromId, branch)} />
  if (visited.has(cid)) return <div style={{ fontSize: 11, color: '#94a3b8', padding: 8 }}>↩ loops to earlier step</div>
  visited.add(cid)
  const node = nodeById(graph, cid)
  if (!node) return null
  const branches = branchKeysFor(node)
  const isEnd = node.type === 'stop' || node.type === 'end_automation'
  return (
    <>
      <Connector />
      <NodeCard node={node} selected={selId === node.id} onClick={() => onSelect(node.id)} errs={errsByNode[node.id]} />
      {isEnd ? null : branches ? (
        <div style={{ display: 'flex', gap: 26, alignItems: 'flex-start', marginTop: 6 }}>
          {branches.map(bk => (
            <div key={bk} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: bk === 'no' || bk === 'timeout' ? '#ef4444' : bk === 'yes' || bk === 'met' || bk === 'continue' ? '#10b981' : '#6366f1', padding: '2px 10px', borderRadius: 10, marginTop: 8 }}>{branchLabel(node, bk)}</span>
              <TreeRenderer graph={graph} fromId={node.id} branch={bk} onSelect={onSelect} selId={selId} errsByNode={errsByNode} openPicker={openPicker} branchLabel={branchLabel} visited={new Set(visited)} />
            </div>
          ))}
        </div>
      ) : (
        <TreeRenderer graph={graph} fromId={node.id} branch={null} onSelect={onSelect} selId={selId} errsByNode={errsByNode} openPicker={openPicker} branchLabel={branchLabel} visited={visited} />
      )}
    </>
  )
}

function NodeCard({ node, selected, onClick, errs }) {
  const accent = colorForNode(node)
  const hasErr = errs && errs.length
  return (
    <div onClick={onClick} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}
      style={{ minWidth: 236, maxWidth: 236, background: 'var(--card-bg, #fff)', color: '#0f172a', borderRadius: 12, border: selected ? `2px solid ${accent}` : hasErr ? '2px solid #ef4444' : '1px solid #cbd5e1', boxShadow: '0 3px 12px rgba(0,0,0,0.28)', cursor: 'pointer', overflow: 'hidden' }}>
      <div style={{ height: 4, background: accent }} />
      <div style={{ padding: '11px 13px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 17 }}>{iconFor(node)}</span>
          <span style={{ fontWeight: 600, fontSize: 13.5, flex: 1 }}>{labelFor(node)}</span>
          {node.kind === 'trigger' && <span style={{ fontSize: 9, letterSpacing: 1, color: accent, fontWeight: 700 }}>TRIGGER</span>}
          {hasErr && <span title={errs.join('\n')} style={{ color: '#ef4444', fontSize: 14 }}>⚠</span>}
        </div>
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>{nodeSummary(node)}</div>
      </div>
    </div>
  )
}

const Connector = () => <div style={{ width: 2, height: 20, background: '#475569' }} />
const PlusSlot = ({ onClick }) => (
  <>
    <Connector />
    <button onClick={onClick} title="Add a step here" aria-label="Add step"
      style={{ width: 30, height: 30, borderRadius: 8, border: '1.5px dashed #64748b', background: 'rgba(15,23,42,0.6)', color: '#cbd5e1', fontSize: 17, cursor: 'pointer', lineHeight: '26px' }}>＋</button>
  </>
)

// ============================ step picker ============================
function StepPicker({ onPick, onClose }) {
  const [q, setQ] = useState('')
  const ql = q.trim().toLowerCase()
  const m = (it) => !ql || it.label.toLowerCase().includes(ql) || (it.desc || '').toLowerCase().includes(ql)
  const controls = CONTROLS.filter(m)
  const groups = actionsByGroup().map(g => ({ ...g, items: g.items.filter(m) })).filter(g => g.items.length)
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 440, maxHeight: '75vh', background: 'var(--bg-primary, #0f172a)', border: '1px solid var(--border)', borderRadius: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border)' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search steps…" style={{ width: '100%', padding: '9px 11px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14 }} />
        </div>
        <div style={{ overflowY: 'auto', padding: 12 }}>
          {(controls.length || !ql) && <><CategoryHead color={CATEGORY_COLOR.control} label="Controls" />{controls.map(it => <SidebarItem key={it.type} it={it} onClick={() => onPick(it)} accent={CATEGORY_COLOR.control} />)}</>}
          {groups.map(g => <div key={g.category} style={{ marginTop: 10 }}><CategoryHead color={g.category === 'Communication' ? CATEGORY_COLOR.comm : CATEGORY_COLOR.crm} label={g.category} />{g.items.map(it => <SidebarItem key={it.type} it={it} onClick={() => onPick(it)} accent={g.category === 'Communication' ? CATEGORY_COLOR.comm : CATEGORY_COLOR.crm} />)}</div>)}
          {!controls.length && !groups.length && <NoResults q={ql} />}
        </div>
      </div>
    </div>
  )
}

// ============================ small bits ============================
const CategoryHead = ({ color, label }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 7px' }}>
    <span style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
    <span style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 600 }}>{label}</span>
  </div>
)
function SidebarItem({ it, onClick, accent }) {
  return (
    <div onClick={onClick} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onClick() }} draggable
      style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: '8px 10px', marginBottom: 7, cursor: 'pointer', background: 'var(--bg-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span>{it.icon}</span>
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{it.label}</span>
        {it.live === false && <span style={{ fontSize: 9, background: '#fef3c7', color: '#92400e', padding: '1px 5px', borderRadius: 4 }}>SOON</span>}
      </div>
      {it.desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{it.desc}</div>}
    </div>
  )
}
const NoResults = ({ q }) => <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: 20 }}>{q ? `No steps match “${q}”` : 'Nothing here yet.'}</div>
const EmptyCanvas = () => (
  <div style={{ textAlign: 'center', color: '#94a3b8', marginTop: 60, maxWidth: 320 }}>
    <div style={{ fontSize: 40 }}>⚡</div>
    <div style={{ fontWeight: 600, color: '#e2e8f0', marginTop: 6 }}>Start with a trigger</div>
    <div style={{ fontSize: 13, marginTop: 4 }}>Pick what kicks off this automation from the <strong>Triggers</strong> list on the left.</div>
  </div>
)
const ZoomBtn = ({ children, ...p }) => <button {...p} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 15 }}>{children}</button>

function startPan(setPan) {
  return (e) => {
    if (e.target.closest('[role="button"]') || e.target.closest('button')) return
    const sx = e.clientX, sy = e.clientY
    let base
    setPan(p => { base = p; return p })
    const move = (ev) => setPan({ x: base.x + (ev.clientX - sx), y: base.y + (ev.clientY - sy) })
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
}
const timeago = (iso) => { const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000); if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; return `${Math.floor(s / 3600)}h ago` }

const overlay = { position: 'fixed', inset: 0, zIndex: 1200, background: 'var(--bg-primary, #0f172a)', display: 'flex', flexDirection: 'column' }
const chip = { fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 10, letterSpacing: 0.5 }
const STATUS_CHIP = {
  draft: { label: 'DRAFT', bg: '#e2e8f0', fg: '#475569' },
  active: { label: '● ACTIVE', bg: 'rgba(16,185,129,0.15)', fg: '#10b981' },
  paused: { label: '❚❚ PAUSED', bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' },
  error: { label: '⚠ ERROR', bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
}
const menu = { position: 'absolute', top: 40, right: 0, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', minWidth: 160, zIndex: 20, overflow: 'hidden' }
const menuItem = { display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }
