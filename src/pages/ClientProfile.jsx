import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { authFetch } from '../api'
import {
  InlineName, InlineField, InlineStatus, QuickAddTask, ContactTimeline, AiIsaCard,
  InlineTextComposer, COMM_META, commToText, fmtCommWhen, fmtDur, recUrl,
} from './Clients'
import { loadClientsNav, markClientsReturn } from '../lib/clientsNav'

// Full-screen Client/Lead workspace at /clients/:id. Reuses HUB's existing profile
// sub-components and APIs — no duplicated SMS/email/AI/task/transaction/Sierra systems.
const LEVEL_COLOR = { hot: '#ef4444', warm: '#f59e0b', engaged: '#10b981', cold: '#64748b', new: '#3b82f6' }

export default function ClientProfile() {
  const { id } = useParams()
  const cid = Number(id)
  const navigate = useNavigate()
  const [client, setClient] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [tab, setTab] = useState('overview')
  const [ai, setAi] = useState(null)
  const [textOpen, setTextOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')

  const nav = loadClientsNav()
  const ids = (nav && Array.isArray(nav.ids)) ? nav.ids : []
  const idx = ids.indexOf(cid)
  const backLabel = nav?.backLabel || 'Clients'

  const load = useCallback(() => {
    authFetch('/api/clients/' + cid)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('Client not found')))
      .then(d => { setClient(d); setErr(''); setLoading(false) })
      .catch(e => { setErr(e.message); setLoading(false) })
  }, [cid])
  useEffect(() => { setLoading(true); load() }, [load])
  useEffect(() => { authFetch('/api/ai/lead/' + cid).then(r => r.json()).then(setAi).catch(() => setAi(null)) }, [cid])
  // Keep the tab bar visible; scroll body to top when switching clients.
  useEffect(() => { window.scrollTo(0, 0) }, [cid])

  const backToClients = () => { markClientsReturn(); navigate(nav?.backTo || '/clients') }
  const goToIndex = (n) => { if (n >= 0 && n < ids.length) navigate('/clients/' + ids[n]) }

  const saveNote = async () => {
    if (!noteText.trim() || !client) return
    setSavingNote(true)
    try {
      const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      const combined = client.notes ? `[${stamp}] ${noteText.trim()}\n${client.notes}` : `[${stamp}] ${noteText.trim()}`
      await authFetch('/api/clients/' + cid, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: combined }) })
      setClient(c => ({ ...c, notes: combined })); setNoteText(''); setNoteOpen(false)
    } catch (e) { alert('Failed to save note: ' + e.message) } finally { setSavingNote(false) }
  }
  const refreshSierra = async () => {
    if (!client?.sierra_lead_id || refreshing) return
    setRefreshing(true); setRefreshMsg('')
    try {
      const r = await authFetch('/api/sierra/refresh-lead/' + client.sierra_lead_id, { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.success !== false) { setRefreshMsg('Refreshed from Sierra ✓'); load() }
      else setRefreshMsg('Sierra refresh failed' + (d.error ? ': ' + d.error : ''))
    } catch (e) { setRefreshMsg('Sierra refresh failed: ' + e.message) }
    finally { setRefreshing(false); setTimeout(() => setRefreshMsg(''), 4000) }
  }

  if (loading) return <div className="page"><div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading client…</div></div>
  if (err || !client) return (
    <div className="page">
      <button className="btn btn-secondary" onClick={backToClients}>← Back to {backLabel}</button>
      <div style={{ padding: 40, color: '#ef4444' }}>{err || 'Client not found.'}</div>
    </div>
  )

  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim() || `Lead ${cid}`
  const typeLabel = client.type === 'seller' ? 'Seller' : client.type === 'both' ? 'Buyer/Seller' : 'Buyer'
  const intent = ai?.intent?.score ?? ai?.intent ?? null
  const TABS = [
    ['overview', 'Overview'], ['communications', 'Communications'], ['activity', 'Activity'],
    ['transactions', 'Transactions'], ['tasks', 'Tasks'], ['ai', 'AI'],
  ]

  return (
    <div className="page client-profile">
      {/* ── Sticky header ─────────────────────────────────────────────── */}
      <div className="cp-sticky">
        <div className="cp-header-row">
          <button className="btn btn-secondary btn-sm" onClick={backToClients} title={`Return to the ${backLabel} list where you left off`}>← Back to {backLabel}</button>
          {ids.length > 1 && idx >= 0 && (
            <div className="cp-prevnext">
              <button className="btn btn-sm" disabled={idx <= 0} onClick={() => goToIndex(idx - 1)} title="Previous client in this list">‹ Prev</button>
              <span className="cp-count">{idx + 1} of {ids.length}</span>
              <button className="btn btn-sm" disabled={idx >= ids.length - 1} onClick={() => goToIndex(idx + 1)} title="Next client in this list">Next ›</button>
            </div>
          )}
        </div>
        <div className="cp-identity">
          <h1 className="cp-name">{name}</h1>
          <div className="cp-badges">
            <span className={`type-pill type-${client.type || 'buyer'}`}>{typeLabel}</span>
            {client.status && <span className="cp-badge">{client.status}</span>}
            {client.source && <span className="cp-badge cp-badge-muted">{client.source}</span>}
            {client.agent_assigned && <span className="cp-badge cp-badge-muted">👤 {client.agent_assigned}</span>}
            {intent != null && <span className="cp-badge" style={{ background: 'rgba(37,99,235,.12)', color: '#2563eb' }}>Intent {intent}</span>}
            {ai?.ai_managed && <span className="cp-badge" style={{ background: 'rgba(124,58,237,.12)', color: '#7c3aed' }}>AI Managed</span>}
          </div>
        </div>
        {/* Primary actions */}
        <div className="cp-actions">
          {client.phone && !client.hub_text_opt_out && <button className="lead-action-btn" onClick={() => { setTab('communications'); setTextOpen(true) }}><span className="lead-action-icon">💬</span><span>Text</span></button>}
          {client.phone && <button className="lead-action-btn" onClick={() => window.hubCall && window.hubCall(client.phone, name)}><span className="lead-action-icon">📞</span><span>Call</span></button>}
          <button className="lead-action-btn" onClick={() => setNoteOpen(o => !o)}><span className="lead-action-icon">📝</span><span>Add Note</span></button>
          <button className="lead-action-btn" onClick={() => setTab('tasks')}><span className="lead-action-icon">✅</span><span>Add Task</span></button>
          <button className="lead-action-btn" onClick={() => setTab('transactions')}><span className="lead-action-icon">➕</span><span>Transactions</span></button>
          {client.sierra_lead_id && <button className="lead-action-btn lead-action-refresh" onClick={refreshSierra} disabled={refreshing}><span className="lead-action-icon">{refreshing ? '⟳' : '↻'}</span><span>{refreshing ? 'Refreshing…' : 'Refresh from Sierra'}</span></button>}
          {refreshMsg && <span style={{ fontSize: 12, alignSelf: 'center', color: refreshMsg.includes('✓') ? '#10b981' : '#ef4444' }}>{refreshMsg}</span>}
        </div>
        {noteOpen && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}>
            <textarea value={noteText} autoFocus onChange={e => setNoteText(e.target.value)} placeholder="Add an internal note…" rows={2} style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, resize: 'vertical' }} />
            <button className="btn btn-primary btn-sm" onClick={saveNote} disabled={savingNote || !noteText.trim()}>{savingNote ? 'Saving…' : 'Save Note'}</button>
          </div>
        )}
        {/* Tabs */}
        <div className="cp-tabs" role="tablist">
          {TABS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`cp-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
      </div>

      {/* ── Tab body ──────────────────────────────────────────────────── */}
      <div className="cp-body">
        {tab === 'overview' && <OverviewTab client={client} ai={ai} onSaved={load} onGoTab={setTab} />}
        {tab === 'communications' && <CommunicationsTab client={client} textOpen={textOpen} setTextOpen={setTextOpen} onSent={load} />}
        {tab === 'activity' && <div className="cp-card"><ContactTimeline clientId={cid} /></div>}
        {tab === 'transactions' && <TransactionsTab cid={cid} navigate={navigate} />}
        {tab === 'tasks' && <TasksTab cid={cid} name={name} />}
        {tab === 'ai' && <div className="cp-card"><AiIsaCard clientId={cid} /></div>}
      </div>
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────
function OverviewTab({ client, ai, onSaved, onGoTab }) {
  const cid = client.id
  let listings = []
  try { listings = JSON.parse(client.fsbo_listings || '[]') } catch {}
  const g = (n, c) => c > 0 ? `${n} (${c})` : n
  return (
    <div className="cp-grid">
      <div className="cp-col-main">
        <section className="cp-card">
          <h4>Contact</h4>
          <InlineName detail={client} onSaved={onSaved} />
          <InlineField label="Phone" field="phone" value={client.phone} clientId={cid} onSaved={onSaved} />
          <InlineField label="Email" field="email" type="email" value={client.email} clientId={cid} onSaved={onSaved} />
          {client.alt_phones && <p style={{ margin: '2px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}><strong>Other phones:</strong> {client.alt_phones}</p>}
          {client.alt_emails && <p style={{ margin: '2px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}><strong>Other emails:</strong> {client.alt_emails}</p>}
          <InlineField label="Address" field="address" value={client.address} clientId={cid} onSaved={onSaved} />
          <p><strong>City:</strong> {client.city || '—'}{client.state ? `, ${client.state}` : ''} {client.zip || ''}</p>
          {listings.length > 0 && (
            <p style={{ margin: '4px 0' }}><strong>FSBO Listing{listings.length > 1 ? `s (${listings.length})` : ''}:</strong>
              <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                {listings.map((l, i) => <li key={i} style={{ fontSize: 13, marginBottom: 2 }}>{l.address || '—'}{l.status ? ` (${l.status})` : ''}{l.link && <> — <a href={l.link} target="_blank" rel="noopener noreferrer" style={{ color: '#006aff', fontWeight: 600 }}>View on Zillow ↗</a></>}</li>)}
              </ul>
            </p>
          )}
        </section>

        <section className="cp-card">
          <h4>CRM</h4>
          <InlineStatus detail={client} onSaved={onSaved} />
          <p><strong>Type:</strong> {client.type === 'seller' ? 'Seller' : client.type === 'both' ? 'Buyer/Seller' : 'Buyer'}</p>
          {client.source && <p><strong>Source:</strong> {client.source}</p>}
          {client.agent_assigned && <p><strong>Assigned:</strong> {client.agent_assigned}</p>}
          {client.tags && <p><strong>Tags:</strong> {String(client.tags).replace(/[\[\]"]/g, '')}</p>}
          {(client.register_date || client.created_at) && <p><strong>Registered:</strong> {new Date(String(client.register_date || client.created_at).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>}
        </section>

        {client.notes && (
          <section className="cp-card">
            <h4>Notes</h4>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, maxHeight: 220, overflowY: 'auto' }}>{client.notes}</div>
          </section>
        )}

        <SocialTools client={client} />
      </div>

      <div className="cp-col-side">
        <section className="cp-card">
          <h4>AI Intelligence</h4>
          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div><strong>Intent:</strong> {ai?.intent?.score ?? ai?.intent ?? '—'} {ai?.intent?.level ? `(${ai.intent.level})` : ''}</div>
            <div><strong>AI:</strong> {ai?.ai_managed ? 'Managed' : 'Manual'}</div>
            {ai?.ai_state && <div><strong>State:</strong> {String(ai.ai_state).replace(/_/g, ' ').toLowerCase()}</div>}
            {ai?.summary && <div style={{ marginTop: 6, color: 'var(--text-secondary)' }}>{ai.summary}</div>}
          </div>
          <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => onGoTab('ai')}>Open AI workspace →</button>
        </section>
        <section className="cp-card"><h4>Tasks</h4><MiniTasks cid={cid} onGoTab={onGoTab} /></section>
        <section className="cp-card"><h4>Transactions</h4><MiniTxns cid={cid} onGoTab={onGoTab} /></section>
      </div>
    </div>
  )
}

function SocialTools({ client }) {
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  const gq = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`
  return (
    <section className="cp-card">
      <h4>Research</h4>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <a className="btn btn-sm btn-secondary" href={gq(`"${name}" ${client.city || ''} ${client.email || ''}`.trim())} target="_blank" rel="noopener noreferrer">🔎 Google this lead</a>
        <a className="btn btn-sm btn-secondary" href={gq(`"${name}" site:linkedin.com`)} target="_blank" rel="noopener noreferrer">in LinkedIn</a>
        <a className="btn btn-sm btn-secondary" href={gq(`"${name}" site:facebook.com ${client.city || ''}`)} target="_blank" rel="noopener noreferrer">Facebook</a>
      </div>
    </section>
  )
}

// ── Communications ───────────────────────────────────────────────────────
function CommunicationsTab({ client, textOpen, setTextOpen, onSent }) {
  const cid = client.id
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('all')
  const [q, setQ] = useState('')
  const load = useCallback(() => { authFetch('/api/inbox/thread/' + cid).then(r => r.json()).then(d => setRows(Array.isArray(d) ? d.slice().reverse() : [])).catch(() => setRows([])) }, [cid])
  useEffect(() => { load() }, [load])
  const FILTERS = [['all', 'All'], ['text', 'Texts'], ['call', 'Calls'], ['email', 'Emails'], ['note', 'Notes']]
  const noteRows = (() => { // internal notes come from client.notes lines
    if (!client.notes) return []
    return String(client.notes).split('\n').filter(Boolean).map((line, i) => {
      const m = line.match(/^\[([^\]]+)\]\s*(.*)$/)
      return { id: 'note' + i, channel: 'note', direction: 'note', occurred_at: m ? m[1] : null, body: m ? m[2] : line }
    })
  })()
  let items = filter === 'note' ? noteRows
    : (rows || []).filter(m => filter === 'all' ? m.channel !== 'note' : m.channel === filter)
  if (filter === 'all' && client.notes) { /* notes shown only under Notes filter to keep them distinct */ }
  if (q.trim()) { const t = q.toLowerCase(); items = items.filter(m => `${m.body || ''} ${m.preview || ''} ${m.subject || ''}`.toLowerCase().includes(t)) }

  return (
    <div className="cp-card">
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {FILTERS.map(([k, l]) => <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search communications…" style={{ marginLeft: 'auto', minWidth: 180, padding: '6px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }} />
        {client.phone && !client.hub_text_opt_out && <button className="btn btn-sm btn-primary" onClick={() => setTextOpen(o => !o)}>💬 New text</button>}
      </div>
      {textOpen && client.phone && !client.hub_text_opt_out && (
        <div style={{ marginBottom: 12 }}>
          <InlineTextComposer client={client} onClose={() => setTextOpen(false)} onSent={() => { load(); onSent && onSent() }} />
        </div>
      )}
      {rows === null ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        : items.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing here yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{items.map(m => <CommItem key={m.id} m={m} />)}</div>}
    </div>
  )
}

function CommItem({ m }) {
  const meta = COMM_META[m.channel] || { icon: '•', label: m.channel, color: 'var(--text-muted)' }
  const out = m.direction === 'outgoing'
  const isNote = m.channel === 'note'
  const isCallish = m.channel === 'call' || m.channel === 'voicemail'
  const text = commToText(m.body || m.preview || m.subject || '')
  const aiSent = /ai/i.test(m.sent_by_type || m.agent || '')
  return (
    <div style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${isNote ? '#f59e0b' : meta.color}`, borderRadius: 6, padding: '7px 10px', background: isNote ? 'rgba(245,158,11,0.06)' : 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
        <span style={{ color: isNote ? '#f59e0b' : meta.color, fontWeight: 700 }}>{isNote ? '📝 Internal Note' : `${meta.icon} ${meta.label}`}</span>
        {!isNote && <span>{out ? '↗ sent' : '↙ received'}</span>}
        {aiSent && <span style={{ color: '#7c3aed', fontWeight: 700 }}>· HUB AI</span>}
        {m.duration_sec ? <span>· {fmtDur(m.duration_sec)}</span> : null}
        {m.disposition ? <span>· {m.disposition}</span> : null}
        <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{fmtCommWhen(m.occurred_at)}</span>
      </div>
      {m.channel === 'email' && m.subject && <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 2 }}>{commToText(m.subject)}</div>}
      {text && <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{text}</div>}
      {isCallish && m.recording_url && <audio controls preload="none" src={recUrl(m.id)} style={{ marginTop: 6, width: 260, maxWidth: '100%', height: 32 }} />}
      {m.transcript && <div style={{ fontSize: 12, marginTop: 5, fontStyle: 'italic', color: 'var(--text-secondary)' }}>“{m.transcript}”</div>}
    </div>
  )
}

// ── Transactions ─────────────────────────────────────────────────────────
function useClientTxns(cid) {
  const [txns, setTxns] = useState(null)
  useEffect(() => {
    authFetch('/api/transactions?client_id=' + cid).then(r => r.ok ? r.json() : []).then(d => {
      const arr = Array.isArray(d) ? d : (d.transactions || d.rows || [])
      setTxns(arr.filter(t => [t.client_id, t.buyer_client_id, t.seller_client_id].map(Number).includes(cid) || arr.length <= 200 && String(t.client_id) === String(cid)))
    }).catch(() => setTxns([]))
  }, [cid])
  return txns
}
function TransactionsTab({ cid, navigate }) {
  const txns = useClientTxns(cid)
  return (
    <div className="cp-card">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <h4 style={{ margin: 0, flex: 1 }}>Transactions</h4>
        <button className="btn btn-sm" onClick={() => navigate('/transactions')}>Open Transactions →</button>
      </div>
      {txns === null ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        : txns.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No transactions linked to this client. Create one from the Transactions workspace.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{txns.map(t => (
            <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, cursor: 'pointer' }} onClick={() => navigate('/transactions')}>
              <strong>{t.property_address || t.address || t.transaction_type || 'Transaction'}</strong>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[t.transaction_type, t.property_status || t.status, t.closing_date].filter(Boolean).join(' · ')}</div>
            </div>
          ))}</div>}
    </div>
  )
}
function MiniTxns({ cid, onGoTab }) {
  const txns = useClientTxns(cid)
  if (txns === null) return <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>…</div>
  if (!txns.length) return <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>None</div>
  return <div style={{ fontSize: 12.5 }}>{txns.slice(0, 3).map(t => <div key={t.id}>{t.property_address || t.transaction_type || 'Transaction'} <span style={{ color: 'var(--text-muted)' }}>· {t.property_status || t.status}</span></div>)}<button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => onGoTab('transactions')}>View all →</button></div>
}

// ── Tasks ────────────────────────────────────────────────────────────────
function useClientTasks(cid) {
  const [tasks, setTasks] = useState(null)
  const reload = useCallback(() => authFetch(`/api/tasks?related_type=client&related_id=${cid}`).then(r => r.json()).then(d => setTasks(Array.isArray(d) ? d : [])).catch(() => setTasks([])), [cid])
  useEffect(() => { reload() }, [reload])
  return [tasks, reload]
}
function TasksTab({ cid, name }) {
  const [tasks, reload] = useClientTasks(cid)
  const today = new Date().toISOString().slice(0, 10)
  const open = (tasks || []).filter(t => t.status !== 'done')
  const done = (tasks || []).filter(t => t.status === 'done')
  const row = (t) => (
    <div key={t.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 10px', fontSize: 13, display: 'flex', gap: 8, alignItems: 'center' }}>
      <span style={{ flex: 1 }}>{t.title}</span>
      {t.assigned_to && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t.assigned_to}</span>}
      {t.due_date && <span style={{ fontSize: 11.5, color: t.due_date < today && t.status !== 'done' ? '#ef4444' : 'var(--text-muted)' }}>{t.due_date}{t.due_time ? ' ' + t.due_time : ''}</span>}
    </div>
  )
  return (
    <div className="cp-card">
      <QuickAddTask clientId={cid} clientName={name} onAdded={reload} />
      <div style={{ marginTop: 12 }}>
        {tasks === null ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div> : (
          <>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', margin: '4px 0 6px' }}>OPEN ({open.length})</div>
            {open.length ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{open.map(row)}</div> : <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No open tasks.</div>}
            {done.length > 0 && <><div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', margin: '12px 0 6px' }}>COMPLETED ({done.length})</div><div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.65 }}>{done.slice(0, 10).map(row)}</div></>}
          </>
        )}
      </div>
    </div>
  )
}
function MiniTasks({ cid, onGoTab }) {
  const [tasks] = useClientTasks(cid)
  if (tasks === null) return <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>…</div>
  const open = tasks.filter(t => t.status !== 'done')
  if (!open.length) return <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No open tasks <button className="btn btn-sm" style={{ marginLeft: 6 }} onClick={() => onGoTab('tasks')}>Add →</button></div>
  return <div style={{ fontSize: 12.5 }}>{open.slice(0, 4).map(t => <div key={t.id}>• {t.title}{t.due_date ? <span style={{ color: 'var(--text-muted)' }}> · {t.due_date}</span> : ''}</div>)}<button className="btn btn-sm" style={{ marginTop: 6 }} onClick={() => onGoTab('tasks')}>View all →</button></div>
}
