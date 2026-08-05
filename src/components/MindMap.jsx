import React, { useState, useEffect, useRef, useCallback } from 'react'
import { authFetch } from '../api'

const COLORS = ['#ffffff', '#fde68a', '#bbf7d0', '#bfdbfe', '#fecaca', '#e9d5ff', '#fed7aa', '#c7d2fe', '#cbd5e1']
const TEAM = ['Matt', 'John', 'Hunter', 'Cherryl']
const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }
const inp = { width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)', fontSize: 13, marginTop: 4 }

// Miro-style visual workspace for a project: draggable cards, connectors, colors,
// due dates, assignees, links. State persists to the project's canvas_data.
export default function MindMap({ projectId, projectName, initial, onClose }) {
  const [nodes, setNodes] = useState(initial?.nodes || [])
  const [edges, setEdges] = useState(initial?.edges || [])
  const [selectedId, setSelectedId] = useState(null)
  const [connectingFrom, setConnectingFrom] = useState(null)
  const [pan, setPan] = useState({ x: 40, y: 40 })
  const [scale, setScale] = useState(1)
  const [saved, setSaved] = useState('saved')
  const wrapRef = useRef(null)
  const drag = useRef(null)
  const saveTimer = useRef(null)
  const firstRun = useRef(true)

  const scheduleSave = useCallback((n, e) => {
    setSaved('saving')
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(async () => {
      try {
        await authFetch(`/api/projects/${projectId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ canvas_data: JSON.stringify({ nodes: n, edges: e }) }) })
        setSaved('saved')
      } catch { setSaved('error') }
    }, 700)
  }, [projectId])

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    scheduleSave(nodes, edges)
  }, [nodes, edges, scheduleSave])

  const updateNode = (id, patch) => setNodes(ns => ns.map(n => n.id === id ? { ...n, ...patch } : n))
  const deleteNode = (id) => { setNodes(ns => ns.filter(n => n.id !== id)); setEdges(es => es.filter(e => e.from !== id && e.to !== id)); setSelectedId(null) }

  const addNode = () => {
    const id = 'n' + Date.now()
    const W = wrapRef.current?.clientWidth || 700, Hh = wrapRef.current?.clientHeight || 450
    const x = (-pan.x + W / 2) / scale - 90
    const y = (-pan.y + Hh / 2) / scale - 40
    setNodes(ns => [...ns, { id, x, y, w: 190, title: 'New card', notes: '', color: '#ffffff', due_date: '', assignee: '', link: '' }])
    setSelectedId(id)
  }

  const onMouseDownCanvas = (e) => {
    if (e.target === wrapRef.current || e.target.dataset.bg) {
      drag.current = { type: 'pan', startX: e.clientX, startY: e.clientY, origX: pan.x, origY: pan.y }
      setSelectedId(null); setConnectingFrom(null)
    }
  }
  const onMouseDownNode = (e, id) => {
    e.stopPropagation()
    if (connectingFrom) {
      if (connectingFrom !== id) setEdges(es => [...es, { id: 'e' + Date.now(), from: connectingFrom, to: id }])
      setConnectingFrom(null); return
    }
    const node = nodes.find(n => n.id === id)
    drag.current = { type: 'node', id, startX: e.clientX, startY: e.clientY, origX: node.x, origY: node.y }
    setSelectedId(id)
  }

  useEffect(() => {
    const move = (e) => {
      if (!drag.current) return
      const dx = e.clientX - drag.current.startX, dy = e.clientY - drag.current.startY
      if (drag.current.type === 'pan') setPan({ x: drag.current.origX + dx, y: drag.current.origY + dy })
      else updateNode(drag.current.id, { x: drag.current.origX + dx / scale, y: drag.current.origY + dy / scale })
    }
    const up = () => { drag.current = null }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
  }, [scale])

  const nodeCenter = (id) => { const n = nodes.find(x => x.id === id); if (!n) return null; return { x: n.x + (n.w || 190) / 2, y: n.y + 40 } }
  const selected = nodes.find(n => n.id === selectedId)

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'var(--bg-primary, #0f172a)', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, padding: '10px 14px', borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
        <strong style={{ marginRight: 8 }}>🧠 {projectName || 'Mind Map'}</strong>
        <button className="btn btn-primary btn-sm" onClick={addNode}>+ Add Card</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setScale(s => Math.min(2, +(s + 0.1).toFixed(2)))}>+</button>
        <button className="btn btn-secondary btn-sm" onClick={() => setScale(s => Math.max(0.4, +(s - 0.1).toFixed(2)))}>−</button>
        <button className="btn btn-secondary btn-sm" onClick={() => { setPan({ x: 40, y: 40 }); setScale(1) }}>Reset view</button>
        <span style={{ fontSize: 12, color: connectingFrom ? '#2563eb' : 'var(--text-muted)' }}>
          {connectingFrom ? '➜ click another card to connect (or empty space to cancel)' : 'Drag cards • drag empty space to pan • ↔ handle to connect'}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: saved === 'saved' ? '#10b981' : saved === 'error' ? '#ef4444' : 'var(--text-muted)' }}>
          {saved === 'saving' ? 'Saving…' : saved === 'error' ? '⚠ Save failed' : '✓ Saved'}
        </span>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>✕ Close</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div ref={wrapRef} data-bg="1" onMouseDown={onMouseDownCanvas}
          style={{ flex: 1, position: 'relative', overflow: 'hidden', background: '#0b1220', backgroundImage: 'radial-gradient(#1e293b 1px, transparent 1px)', backgroundSize: `${24 * scale}px ${24 * scale}px`, backgroundPosition: `${pan.x}px ${pan.y}px`, cursor: drag.current?.type === 'pan' ? 'grabbing' : 'default' }}>
          <div style={{ position: 'absolute', transformOrigin: '0 0', transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})` }}>
            <svg style={{ position: 'absolute', overflow: 'visible', pointerEvents: 'none', left: 0, top: 0 }}>
              <defs><marker id="mm-arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6" fill="#64748b" /></marker></defs>
              {edges.map(e => {
                const a = nodeCenter(e.from), b = nodeCenter(e.to); if (!a || !b) return null
                return <line key={e.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#64748b" strokeWidth="2" markerEnd="url(#mm-arrow)"
                  style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                  onClick={() => { if (confirm('Delete this connection?')) setEdges(es => es.filter(x => x.id !== e.id)) }} />
              })}
            </svg>
            {nodes.map(n => (
              <div key={n.id} onMouseDown={(e) => onMouseDownNode(e, n.id)}
                style={{ position: 'absolute', left: n.x, top: n.y, width: n.w || 190, background: n.color || '#fff', border: selectedId === n.id ? '2px solid #2563eb' : '1px solid #cbd5e1', borderRadius: 8, boxShadow: '0 2px 8px rgba(0,0,0,0.25)', cursor: 'move', color: '#111827', userSelect: 'none' }}>
                <div style={{ padding: '8px 10px' }}>
                  <div style={{ fontWeight: 600, fontSize: 13, wordBreak: 'break-word' }}>{n.title || 'Untitled'}</div>
                  {n.notes && <div style={{ fontSize: 11, color: '#475569', marginTop: 4, whiteSpace: 'pre-wrap' }}>{n.notes}</div>}
                  {(n.due_date || n.assignee || n.link) && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      {n.due_date && <span style={{ fontSize: 10, background: '#0f172a', color: '#fff', borderRadius: 4, padding: '1px 5px' }}>📅 {n.due_date}</span>}
                      {n.assignee && <span style={{ fontSize: 10, background: '#1d4ed8', color: '#fff', borderRadius: 4, padding: '1px 5px' }}>👤 {n.assignee}</span>}
                      {n.link && <a href={n.link} target="_blank" rel="noreferrer" onMouseDown={e => e.stopPropagation()} style={{ fontSize: 10, color: '#2563eb' }}>🔗 link</a>}
                    </div>
                  )}
                </div>
                <button title="Connect to another card" onMouseDown={e => { e.stopPropagation(); setConnectingFrom(n.id) }}
                  style={{ position: 'absolute', right: -11, top: '50%', transform: 'translateY(-50%)', width: 22, height: 22, borderRadius: '50%', border: '2px solid #fff', background: '#2563eb', color: '#fff', cursor: 'crosshair', fontSize: 12, lineHeight: '18px', padding: 0 }}>↔</button>
              </div>
            ))}
          </div>
          {nodes.length === 0 && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569', fontSize: 14, pointerEvents: 'none' }}>
              Click <strong style={{ margin: '0 4px' }}>+ Add Card</strong> to start building your workspace.
            </div>
          )}
        </div>

        {selected && (
          <div style={{ width: 290, borderLeft: '1px solid var(--border)', padding: 16, overflowY: 'auto', background: 'var(--bg-secondary)' }}>
            <h4 style={{ margin: '0 0 12px' }}>Edit Card</h4>
            <label style={lbl}>Title<input style={inp} value={selected.title} onChange={e => updateNode(selected.id, { title: e.target.value })} /></label>
            <label style={lbl}>Notes<textarea style={{ ...inp, minHeight: 72, resize: 'vertical' }} value={selected.notes} onChange={e => updateNode(selected.id, { notes: e.target.value })} /></label>
            <div style={lbl}>Color
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {COLORS.map(c => <button key={c} onClick={() => updateNode(selected.id, { color: c })} style={{ width: 24, height: 24, borderRadius: 4, background: c, border: selected.color === c ? '2px solid #2563eb' : '1px solid #94a3b8', cursor: 'pointer' }} />)}
              </div>
            </div>
            <label style={lbl}>Due date<input type="date" style={inp} value={selected.due_date || ''} onChange={e => updateNode(selected.id, { due_date: e.target.value })} /></label>
            <label style={lbl}>Assignee<select style={inp} value={selected.assignee || ''} onChange={e => updateNode(selected.id, { assignee: e.target.value })}><option value="">—</option>{TEAM.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
            <label style={lbl}>Link<input style={inp} placeholder="https://…" value={selected.link || ''} onChange={e => updateNode(selected.id, { link: e.target.value })} /></label>
            <button className="btn btn-danger btn-sm" style={{ marginTop: 8 }} onClick={() => deleteNode(selected.id)}>Delete Card</button>
          </div>
        )}
      </div>
    </div>
  )
}
