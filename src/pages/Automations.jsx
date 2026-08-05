import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import FlowBuilder from '../components/FlowBuilder'

export default function Automations() {
  const [items, setItems] = useState([])
  const [builder, setBuilder] = useState(null) // { initial } when open

  const load = () => authFetch('/api/automations').then(r => r.json()).then(setItems).catch(() => setItems([]))
  useEffect(() => { load() }, [])

  const openNew = () => setBuilder({ initial: null })
  const openEdit = async (item) => {
    const a = await authFetch(`/api/automations/${item.id}`).then(r => r.json())
    let flow = null
    try { flow = a.flow_data ? JSON.parse(a.flow_data) : null } catch {}
    setBuilder({ initial: { id: a.id, name: a.name, run_time: a.run_time, flow } })
  }
  const toggleEnabled = async (item) => {
    let flow = null; try { flow = item.flow_data ? JSON.parse(item.flow_data) : null } catch {}
    await authFetch(`/api/automations/${item.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: item.name, run_time: item.run_time, enabled: item.enabled ? 0 : 1, flow }) })
    load()
  }
  const remove = async (id) => { if (!confirm('Delete this automation?')) return; await authFetch(`/api/automations/${id}`, { method: 'DELETE' }); load() }
  const runNow = async (id) => {
    if (!confirm('Run this automation now on its whole audience?')) return
    const r = await authFetch(`/api/automations/${id}/run-now`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json())
    alert(r.error ? 'Run failed: ' + r.error : `✓ Ran: ${r.matched} matched · ${r.actions_done} actions · ${r.errors} errors`)
    load()
  }
  const stepCount = (a) => { try { return (JSON.parse(a.flow_data || '{}').steps || []).length } catch { return 0 } }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Automations</h1>
          <p className="page-subtitle">Build visual workflows — a trigger, then steps (conditions, delays, actions) that flow down.</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Automation</button>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {items.length === 0 ? <div className="empty-state-full">No automations yet. Create one to start automating.</div> :
          items.map(a => (
            <div key={a.id} className="detail-section" style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }} onClick={() => openEdit(a)}>
              <span onClick={e => { e.stopPropagation(); toggleEnabled(a) }} style={{ width: 40, height: 22, borderRadius: 11, background: a.enabled ? '#10b981' : 'var(--border)', position: 'relative', display: 'inline-block', cursor: 'pointer', flexShrink: 0 }}>
                <span style={{ position: 'absolute', top: 2, left: a.enabled ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: '.2s' }} />
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{a.name} {!a.enabled && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(off)</span>}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Daily at {a.run_time} · {stepCount(a)} step(s){a.last_run_summary ? ` · last run: ${a.last_run_summary}` : ' · never run'}
                </div>
              </div>
              <button className="btn btn-sm btn-secondary" onClick={e => { e.stopPropagation(); runNow(a.id) }}>▶ Run now</button>
              <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); remove(a.id) }}>Delete</button>
            </div>
          ))}
      </div>

      {builder && (
        <FlowBuilder
          initial={builder.initial}
          onClose={() => setBuilder(null)}
          onSaved={() => { setBuilder(null); load() }}
        />
      )}
    </div>
  )
}
