import React, { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../api'

const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '') }
const ago = (iso) => { try { const s = Math.max(0, (Date.now() - new Date(String(iso).includes('T') ? iso : iso.replace(' ', 'T') + 'Z')) / 1000); if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd' } catch { return '' } }
const LEVEL_COLOR = { URGENT: '#ef4444', HIGH: '#f59e0b', ENGAGED: '#10b981', NURTURE: '#2563eb', LOW: '#64748b' }

export default function AiOpportunities() {
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('all')   // all | mine | unassigned | urgent
  const myAgent = localStorage.getItem('mst_agent') || ''
  const load = useCallback(() => {
    const p = new URLSearchParams({ status: 'open' })
    if (filter === 'mine' && myAgent) p.set('assigned', myAgent)
    else if (filter === 'unassigned') p.set('assigned', 'unassigned')
    else if (filter === 'urgent') p.set('urgency', 'urgent')
    authFetch('/api/ai/opportunities?' + p).then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => setRows([]))
  }, [filter, myAgent])
  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(load, 20000); return () => clearInterval(t) }, [load])

  const act = async (id, path) => { await authFetch(`/api/ai/opportunities/${id}/${path}`, { method: 'POST' }).catch(() => {}); load() }
  const takeover = async (clientId, id) => { await authFetch(`/api/ai/lead/${clientId}/takeover`, { method: 'POST' }).catch(() => {}); await act(id, 'ack') }
  const call = (o) => { if (window.hubCall) window.hubCall(o.phone, o.name); else alert('The Hub phone isn’t connected yet.') }

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>AI Opportunities</h1><p className="page-subtitle">High-intent leads HUB AI has surfaced for a human. Sorted by urgency and intent.</p></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {[['all', 'All'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['urgent', 'Urgent']].map(([k, l]) => (
          <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      {rows === null ? <div style={{ color: 'var(--text-muted)' }}>Loading…</div>
        : rows.length === 0 ? (
          <div className="detail-section" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
            <div style={{ fontSize: 34 }}>✅</div>
            <div style={{ fontWeight: 600, marginTop: 8, color: 'var(--text-primary)' }}>No open opportunities</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>When AI detects high intent (tour request, offer interest, seller lead, hot buyer), it will appear here.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 14 }}>
            {rows.map(o => (
              <div key={o.id} className="detail-section" style={{ padding: 16, borderLeft: `4px solid ${o.urgency === 'urgent' ? '#ef4444' : '#f59e0b'}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontWeight: 800, fontSize: 17 }}>{o.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#fff', background: o.urgency === 'urgent' ? '#ef4444' : '#f59e0b', padding: '1px 7px', borderRadius: 4 }}>{o.urgency}</span>
                  {o.intent_score != null && <span style={{ fontSize: 12, fontWeight: 700, color: LEVEL_COLOR[o.intent_level] || '#64748b' }}>intent {o.intent_score}</span>}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{ago(o.created_at)} waiting</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 3 }}>{fmtPhone(o.phone)} · {o.type || 'lead'}{o.source ? ' · ' + o.source : ''}{o.assigned_to ? ' · ' + o.assigned_to : ' · unassigned'}</div>
                <div style={{ fontSize: 13, fontWeight: 600, marginTop: 8, color: '#b45309' }}>{o.reason}</div>
                {o.summary && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.4 }}>{o.summary}</div>}
                {o.recommended_action && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 6 }}>Next: {o.recommended_action}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => call(o)}>📞 Call</button>
                  <button className="btn btn-sm" onClick={() => takeover(o.client_id, o.id)}>Take over</button>
                  <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => act(o.id, 'resolve')}>Resolve</button>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}
