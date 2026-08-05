import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import AutomationBuilder from '../components/AutomationBuilder'
import { STARTER_TEMPLATES } from '../components/automation/templates'

const STATUS_STYLE = {
  active: { label: '● Active', bg: 'rgba(16,185,129,0.15)', fg: '#10b981' },
  paused: { label: '❚❚ Paused', bg: 'rgba(245,158,11,0.15)', fg: '#f59e0b' },
  draft: { label: 'Draft', bg: 'var(--border)', fg: 'var(--text-muted)' },
  error: { label: '⚠ Error', bg: 'rgba(239,68,68,0.15)', fg: '#ef4444' },
}

export default function Automations() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [builderId, setBuilderId] = useState(null)
  const [gallery, setGallery] = useState(false)
  const [activity, setActivity] = useState(null)  // { id, name }
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [sort, setSort] = useState('updated')
  const [view, setView] = useState('cards')

  const load = () => { setLoading(true); authFetch('/api/automations').then(r => r.json()).then(d => { setItems(Array.isArray(d) ? d : []); setLoading(false) }).catch(() => { setItems([]); setLoading(false) }) }
  useEffect(() => { load() }, [])

  const createFrom = async (tpl) => {
    const body = tpl ? { name: tpl.name, description: tpl.description, graph: tpl.graph } : { name: 'Untitled automation', graph: { nodes: [], edges: [] } }
    const r = await authFetch('/api/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(x => x.json())
    setGallery(false)
    if (r.id) setBuilderId(r.id)
  }

  const closeBuilder = (_dirty, intent) => { const id = builderId; setBuilderId(null); load(); if (intent === 'activity' && id) setActivity({ id, name: items.find(i => i.id === id)?.name }) }

  const act = async (id, path) => { await authFetch(`/api/automations/${id}/${path}`, { method: 'POST' }); load() }
  const remove = async (id) => { if (!confirm('Delete this automation? Enrolled contacts are removed.')) return; await authFetch(`/api/automations/${id}`, { method: 'DELETE' }); load() }
  const rename = async (a) => { const n = prompt('Rename automation', a.name); if (!n) return; await authFetch(`/api/automations/${a.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: n }) }); load() }
  const duplicate = async (id) => { await authFetch(`/api/automations/${id}/duplicate`, { method: 'POST' }); load() }

  let list = items.filter(a => (statusFilter === 'all' || (a.status || 'draft') === statusFilter) && (!search || a.name.toLowerCase().includes(search.toLowerCase())))
  list = list.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'enrolled' ? (b.enrolled - a.enrolled) : String(b.updated_at || '').localeCompare(String(a.updated_at || '')))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Automations</h1>
          <p className="page-subtitle">Build visual workflows: a trigger, then conditions, delays and actions that run for each contact automatically.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setGallery(true)}>+ Create Automation</button>
      </div>

      {/* filter bar */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search automations…" style={ctl(220)} />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={ctl(140)}>
          <option value="all">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="draft">Draft</option>
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)} style={ctl(150)}>
          <option value="updated">Recently updated</option><option value="name">Name</option><option value="enrolled">Most enrolled</option>
        </select>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button className={`btn btn-sm ${view === 'cards' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('cards')}>▦ Cards</button>
          <button className={`btn btn-sm ${view === 'table' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('table')}>☰ Table</button>
        </div>
      </div>

      {loading ? <div className="empty-state-full">Loading automations…</div>
        : list.length === 0 ? (
          <div className="empty-state-full" style={{ textAlign: 'center', padding: 40 }}>
            <div style={{ fontSize: 40 }}>⚡</div>
            <div style={{ fontWeight: 600, marginTop: 8 }}>{items.length ? 'No automations match your filters' : 'No automations yet'}</div>
            <div style={{ color: 'var(--text-muted)', margin: '6px 0 14px' }}>{items.length ? 'Try clearing the search or status filter.' : 'Start from a template or a blank canvas.'}</div>
            {!items.length && <button className="btn btn-primary" onClick={() => setGallery(true)}>+ Create your first automation</button>}
          </div>
        ) : view === 'table' ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead><tr>{['Name', 'Status', 'Trigger', 'Enrolled', 'Completed', 'Failed', 'Updated', ''].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {list.map(a => { const s = STATUS_STYLE[a.status] || STATUS_STYLE.draft; return (
                  <tr key={a.id}>
                    <td style={td}><span style={{ fontWeight: 600, color: 'var(--accent,#2563eb)', cursor: 'pointer' }} onClick={() => setBuilderId(a.id)}>{a.name}</span></td>
                    <td style={td}><span style={{ ...pill, background: s.bg, color: s.fg }}>{s.label}</span></td>
                    <td style={td}>{a.trigger_label}</td>
                    <td style={td}>{a.enrolled}</td><td style={td}>{a.completed}</td>
                    <td style={{ ...td, color: a.failed ? '#ef4444' : 'inherit' }}>{a.failed}</td>
                    <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(a.updated_at)}</td>
                    <td style={td}><RowMenu a={a} act={act} remove={remove} rename={rename} duplicate={duplicate} edit={() => setBuilderId(a.id)} viewActivity={() => setActivity({ id: a.id, name: a.name })} /></td>
                  </tr>) })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 14 }}>
            {list.map(a => { const s = STATUS_STYLE[a.status] || STATUS_STYLE.draft; return (
              <div key={a.id} className="detail-section" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => setBuilderId(a.id)}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>{a.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{a.trigger_label} · updated {ago(a.updated_at)}</div>
                  </div>
                  <span style={{ ...pill, background: s.bg, color: s.fg }}>{s.label}</span>
                </div>
                <div style={{ display: 'flex', gap: 16, margin: '12px 0', fontSize: 12 }}>
                  <Stat n={a.enrolled} label="Enrolled" /><Stat n={a.completed} label="Completed" /><Stat n={a.failed} label="Failed" color={a.failed ? '#ef4444' : undefined} />
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => setBuilderId(a.id)}>Edit</button>
                  {a.status === 'active' ? <button className="btn btn-sm btn-secondary" onClick={() => act(a.id, 'pause')}>Pause</button>
                    : a.status === 'paused' ? <button className="btn btn-sm btn-primary" onClick={() => act(a.id, 'resume')}>Resume</button>
                      : <button className="btn btn-sm btn-primary" onClick={() => act(a.id, 'activate')}>Activate</button>}
                  <button className="btn btn-sm btn-secondary" onClick={() => setActivity({ id: a.id, name: a.name })}>Activity</button>
                  <RowMenu a={a} act={act} remove={remove} rename={rename} duplicate={duplicate} edit={() => setBuilderId(a.id)} viewActivity={() => setActivity({ id: a.id, name: a.name })} compact />
                </div>
              </div>) })}
          </div>
        )}

      {gallery && <TemplateGallery onPick={createFrom} onClose={() => setGallery(false)} />}
      {builderId && <AutomationBuilder automationId={builderId} onClose={closeBuilder} />}
      {activity && <ActivityModal id={activity.id} name={activity.name} onClose={() => setActivity(null)} />}
    </div>
  )
}

// ---------------- row menu ----------------
function RowMenu({ a, act, remove, rename, duplicate, edit, viewActivity, compact }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button className="btn btn-sm btn-secondary" onClick={() => setOpen(o => !o)} aria-label="More actions">⋯</button>
      {open && (
        <div onMouseLeave={() => setOpen(false)} style={{ position: 'absolute', right: 0, top: 34, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.3)', minWidth: 160, zIndex: 30 }}>
          <MI onClick={() => { edit(); setOpen(false) }}>Edit</MI>
          {a.status === 'active' ? <MI onClick={() => { act(a.id, 'pause'); setOpen(false) }}>Pause</MI> : <MI onClick={() => { act(a.id, a.status === 'paused' ? 'resume' : 'activate'); setOpen(false) }}>{a.status === 'paused' ? 'Resume' : 'Activate'}</MI>}
          <MI onClick={() => { duplicate(a.id); setOpen(false) }}>Duplicate</MI>
          <MI onClick={() => { rename(a); setOpen(false) }}>Rename</MI>
          <MI onClick={() => { viewActivity(); setOpen(false) }}>View activity</MI>
          <MI onClick={() => { remove(a.id); setOpen(false) }} danger>Delete</MI>
        </div>
      )}
    </div>
  )
}
const MI = ({ children, onClick, danger }) => <button onClick={onClick} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 14px', background: 'transparent', border: 'none', color: danger ? '#ef4444' : 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}>{children}</button>

// ---------------- template gallery ----------------
function TemplateGallery({ onPick, onClose }) {
  return (
    <div style={modalWrap} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 720, maxHeight: '82vh', background: 'var(--bg-primary,#0f172a)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <div><div style={{ fontWeight: 700, fontSize: 17 }}>Create an automation</div><div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Start blank or from a proven template.</div></div>
          <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        <div style={{ overflowY: 'auto', padding: 18, display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(210px,1fr))', gap: 14 }}>
          <div onClick={() => onPick(null)} style={tplCard}>
            <div style={{ fontSize: 26 }}>＋</div><div style={{ fontWeight: 600, marginTop: 6 }}>Blank automation</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>Start from an empty canvas.</div>
          </div>
          {STARTER_TEMPLATES.map(t => (
            <div key={t.id} onClick={() => onPick(t)} style={tplCard}>
              <div style={{ fontSize: 22 }}>{t.icon}</div>
              <div style={{ fontWeight: 600, marginTop: 6 }}>{t.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{t.description}</div>
              <div style={{ fontSize: 11, color: 'var(--accent,#2563eb)', marginTop: 6 }}>{t.audience}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------- activity modal ----------------
function ActivityModal({ id, name, onClose }) {
  const [rows, setRows] = useState([])
  const [metrics, setMetrics] = useState(null)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    Promise.all([
      authFetch(`/api/automations/${id}/activity${filter ? `?status=${filter}` : ''}`).then(r => r.json()),
      authFetch(`/api/automations/${id}/metrics`).then(r => r.json()),
    ]).then(([a, m]) => { setRows(Array.isArray(a) ? a : []); setMetrics(m); setLoading(false) }).catch(() => setLoading(false))
  }, [id, filter])
  const ecolor = { active: '#3b82f6', waiting: '#f59e0b', completed: '#10b981', failed: '#ef4444', removed: '#94a3b8' }
  return (
    <div style={modalWrap} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: 760, maxHeight: '85vh', background: 'var(--bg-primary,#0f172a)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <div><div style={{ fontWeight: 700 }}>{name} — Activity</div><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Who’s in this automation and where they are.</div></div>
          <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>✕</button>
        </div>
        {metrics && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
            <Stat n={metrics.total_enrolled} label="Total enrolled" /><Stat n={metrics.active} label="Active" color="#3b82f6" />
            <Stat n={metrics.waiting} label="Waiting" color="#f59e0b" /><Stat n={metrics.completed} label="Completed" color="#10b981" />
            <Stat n={metrics.failed} label="Failed" color="#ef4444" /><Stat n={metrics.emails_sent} label="Emails sent" color="#8b5cf6" />
          </div>
        )}
        <div style={{ padding: '10px 18px', display: 'flex', gap: 6 }}>
          {['', 'active', 'waiting', 'completed', 'failed'].map(s => <button key={s} className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter(s)}>{s || 'All'}</button>)}
        </div>
        <div style={{ overflowY: 'auto', padding: '0 18px 18px' }}>
          {loading ? <div style={{ color: 'var(--text-muted)', padding: 20 }}>Loading…</div>
            : rows.length === 0 ? <div style={{ color: 'var(--text-muted)', padding: 20, textAlign: 'center' }}>No contacts {filter ? `with status “${filter}”` : 'enrolled yet'}.</div>
              : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead><tr>{['Contact', 'Status', 'Entered', 'Last error'].map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
                  <tbody>{rows.map(r => (
                    <tr key={r.id}>
                      <td style={td}>{(r.first_name || '') + ' ' + (r.last_name || '') || r.email || `#${r.client_id}`}</td>
                      <td style={td}><span style={{ color: ecolor[r.status] || 'inherit', fontWeight: 600 }}>{r.status}</span></td>
                      <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(r.entered_at)}</td>
                      <td style={{ ...td, color: '#ef4444', fontSize: 12 }}>{r.last_error || ''}</td>
                    </tr>))}</tbody>
                </table>
              )}
        </div>
      </div>
    </div>
  )
}

// ---------------- bits ----------------
const Stat = ({ n, label, color }) => <div><div style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--text-primary)' }}>{n ?? 0}</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div></div>
const ago = (iso) => { if (!iso) return '—'; const s = Math.floor((Date.now() - new Date(iso.includes('Z') || iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').getTime()) / 1000); if (isNaN(s)) return '—'; if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)}m ago`; if (s < 86400) return `${Math.floor(s / 3600)}h ago`; return `${Math.floor(s / 86400)}d ago` }
const ctl = (w) => ({ width: w, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 })
const th = { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap' }
const td = { padding: '9px 10px', borderBottom: '1px solid var(--border)' }
const pill = { fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, whiteSpace: 'nowrap' }
const modalWrap = { position: 'fixed', inset: 0, zIndex: 1250, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }
const tplCard = { border: '1px solid var(--border)', borderRadius: 10, padding: 16, cursor: 'pointer', background: 'var(--bg-secondary)' }
