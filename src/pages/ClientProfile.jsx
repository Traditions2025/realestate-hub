import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { authFetch } from '../api'
import TemplatePicker from '../components/TemplatePicker'
import {
  InlineName, InlineField, QuickAddTask, ContactTimeline, AiIsaCard,
  InlineTextComposer, COMM_META, commToText, fmtCommWhen, fmtDur, recUrl, SIERRA_STATUSES,
} from './Clients'

// Clickable status pill (single status control — no redundant copies). Writes to Hub + Sierra.
function StatusPill({ client, onSaved }) {
  const change = async (v) => {
    try {
      await authFetch('/api/clients/' + client.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: v }) })
      if (client.sierra_lead_id) authFetch('/api/sierra/update-lead-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, status: v }) }).catch(() => {})
      onSaved && onSaved()
    } catch (e) { alert('Status update failed: ' + e.message) }
  }
  return <select className={`status-quick-select status-${client.status}`} value={client.status || ''} onChange={e => change(e.target.value)} title="Change status">
    {SIERRA_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
  </select>
}
// Clickable assigned-agent pill.
function AgentPill({ client, onSaved }) {
  const [agents, setAgents] = React.useState([])
  React.useEffect(() => { authFetch('/api/inbox/agents').then(r => r.json()).then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  const change = async (v) => { try { await authFetch('/api/clients/' + client.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_assigned: v || null }) }); onSaved && onSaved() } catch (e) { alert('Assign failed: ' + e.message) } }
  return <select className="status-quick-select" value={client.agent_assigned || ''} onChange={e => change(e.target.value)} title="Assign agent" style={{ maxWidth: 150 }}>
    <option value="">Unassigned</option>
    {agents.map(a => <option key={a} value={a}>{a}</option>)}
    {client.agent_assigned && !agents.includes(client.agent_assigned) && <option value={client.agent_assigned}>{client.agent_assigned}</option>}
  </select>
}
// Editable Buyer/Seller type.
function TypePill({ client, onSaved }) {
  const change = async (v) => { try { await authFetch('/api/clients/' + client.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: v }) }); onSaved && onSaved() } catch (e) { alert('Type update failed: ' + e.message) } }
  return <select className={`status-quick-select type-${client.type || 'buyer'}`} value={client.type || 'buyer'} onChange={e => change(e.target.value)} title="Change type">
    <option value="buyer">Buyer</option><option value="seller">Seller</option><option value="both">Buyer/Seller</option>
  </select>
}
import { loadClientsNav, markClientsReturn } from '../lib/clientsNav'

// One-page full-screen Client/Lead command center at /clients/:id. The whole relationship is
// reviewable by scrolling — no primary tabs. Reuses HUB's existing components + APIs (no
// duplicated SMS/email/AI/task/transaction/Sierra systems).

function Section({ title, children, right, defaultOpen = true, id }) {
  const key = id ? 'cp_sec_' + id : null
  const [open, setOpen] = useState(() => { try { return key && localStorage.getItem(key) != null ? localStorage.getItem(key) === '1' : defaultOpen } catch { return defaultOpen } })
  const toggle = () => setOpen(o => { const n = !o; try { if (key) localStorage.setItem(key, n ? '1' : '0') } catch {} return n })
  return (
    <section className="cp-card">
      <div className="cp-sec-head" onClick={toggle}>
        <h4 style={{ margin: 0 }}>{open ? '▾' : '▸'} {title}</h4>
        {right && <div onClick={e => e.stopPropagation()} style={{ marginLeft: 'auto' }}>{right}</div>}
      </div>
      {open && <div className="cp-sec-body">{children}</div>}
    </section>
  )
}

export default function ClientProfile() {
  const { id } = useParams()
  const cid = Number(id)
  const navigate = useNavigate()
  const [client, setClient] = useState(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [ai, setAi] = useState(null)
  const [followup, setFollowup] = useState(null)
  const [textOpen, setTextOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [layout, setLayout] = useState(loadLayout)
  const [dragKey, setDragKey] = useState(null)
  const [dragArmed, setDragArmed] = useState(null)
  const moveSection = (fromKey, toKey, toCol) => {
    setLayout(prev => {
      const next = { left: prev.left.filter(k => k !== fromKey), right: prev.right.filter(k => k !== fromKey) }
      const arr = next[toCol]; const at = toKey ? arr.indexOf(toKey) : arr.length
      arr.splice(at < 0 ? arr.length : at, 0, fromKey); saveLayout(next); return next
    })
    setDragKey(null); setDragArmed(null)
  }

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
  useEffect(() => { authFetch('/api/followup/' + cid).then(r => r.json()).then(setFollowup).catch(() => setFollowup(null)) }, [cid])
  useEffect(() => { window.scrollTo(0, 0); setTextOpen(false); setEmailOpen(false); setNoteOpen(false) }, [cid])

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
      if (r.ok && d.success !== false) { setRefreshMsg('Refreshed ✓'); load() } else setRefreshMsg('Sierra refresh failed')
    } catch { setRefreshMsg('Sierra refresh failed') } finally { setRefreshing(false); setTimeout(() => setRefreshMsg(''), 4000) }
  }
  const addTransaction = async () => {
    const kind = window.prompt('Transaction type — enter "buyer" or "seller":', 'buyer')
    if (!kind) return
    const type = /sell|list/i.test(kind) ? 'listing' : 'purchase'
    const addr = window.prompt('Property address:', client.address ? `${client.address}${client.city ? ', ' + client.city : ''}` : '')
    if (!addr) return
    const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
    const txData = { property_address: addr, type, property_status: 'Under Contract', client_id: cid,
      buyer_name: type === 'purchase' ? name : '', seller_name: type === 'listing' ? name : '',
      buyers_agent_name: type === 'purchase' ? (client.agent_assigned || 'Matt Smith') : '',
      sellers_agent_name: type === 'listing' ? (client.agent_assigned || 'Matt Smith') : '',
      agency_type: type === 'purchase' ? "Buyer's Agent" : 'Listing Agent' }
    try {
      const r = await authFetch('/api/transactions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(txData) })
      if (r.ok) { alert('Transaction added.'); window.dispatchEvent(new CustomEvent('cp-txns-changed')) } else alert('Could not add transaction.')
    } catch (e) { alert('Could not add transaction: ' + e.message) }
  }

  if (loading) return <div className="page"><div style={{ padding: 40, color: 'var(--text-muted)' }}>Loading client…</div></div>
  if (err || !client) return (
    <div className="page"><button className="btn btn-secondary" onClick={backToClients}>← Back to {backLabel}</button><div style={{ padding: 40, color: '#ef4444' }}>{err || 'Client not found.'}</div></div>
  )

  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim() || `Lead ${cid}`
  const typeLabel = client.type === 'seller' ? 'Seller' : client.type === 'both' ? 'Buyer/Seller' : 'Buyer'
  const intent = ai?.intent?.score ?? ai?.intent ?? null
  const alerts = buildAlerts(client, ai)

  return (
    <div className="page client-profile">
      {/* ── Sticky header ─────────────────────────────────────────────── */}
      <div className="cp-sticky">
        <div className="cp-header-row">
          <button className="btn btn-secondary btn-sm" onClick={backToClients} title={`Return to the ${backLabel} list where you left off`}>← Back to {backLabel}</button>
          {ids.length > 1 && idx >= 0 && (
            <div className="cp-prevnext">
              <button className="btn btn-sm" disabled={idx <= 0} onClick={() => goToIndex(idx - 1)}>‹ Prev</button>
              <span className="cp-count">{idx + 1} of {ids.length}</span>
              <button className="btn btn-sm" disabled={idx >= ids.length - 1} onClick={() => goToIndex(idx + 1)}>Next ›</button>
            </div>
          )}
        </div>
        <div className="cp-identity">
          <h1 className="cp-name">{name}</h1>
          <div className="cp-badges">
            <TypePill client={client} onSaved={load} />
            <StatusPill client={client} onSaved={load} />
            <AgentPill client={client} onSaved={load} />
            {client.source && <span className="cp-badge cp-badge-muted">{client.source}</span>}
            {intent != null && <span className="cp-badge" style={{ background: 'rgba(37,99,235,.12)', color: '#2563eb' }}>Intent {intent}</span>}
            {ai?.ai_managed && <span className="cp-badge" style={{ background: 'rgba(124,58,237,.12)', color: '#7c3aed' }}>AI Managed</span>}
          </div>
        </div>
        <div className="cp-actions">
          {client.phone && !client.hub_text_opt_out && <button className="lead-action-btn" onClick={() => { setTextOpen(v => !v); setEmailOpen(false) }}><span className="lead-action-icon">💬</span><span>Text</span></button>}
          {client.phone && <button className="lead-action-btn" onClick={() => window.hubCall && window.hubCall(client.phone, name)}><span className="lead-action-icon">📞</span><span>Call</span></button>}
          {client.email && <button className="lead-action-btn" onClick={() => { setEmailOpen(v => !v); setTextOpen(false) }}><span className="lead-action-icon">✉</span><span>Email</span></button>}
          <button className="lead-action-btn" onClick={() => setNoteOpen(o => !o)}><span className="lead-action-icon">📝</span><span>Add Note</span></button>
          <button className="lead-action-btn" onClick={() => { const el = document.getElementById('cp-tasks'); el && el.scrollIntoView({ behavior: 'smooth' }) }}><span className="lead-action-icon">✅</span><span>Add Task</span></button>
          <button className="lead-action-btn" onClick={addTransaction}><span className="lead-action-icon">➕</span><span>Transaction</span></button>
          {client.sierra_lead_id && <button className="lead-action-btn lead-action-refresh" onClick={refreshSierra} disabled={refreshing}><span className="lead-action-icon">{refreshing ? '⟳' : '↻'}</span><span>{refreshing ? 'Refreshing…' : 'Refresh from Sierra'}</span></button>}
          {refreshMsg && <span style={{ fontSize: 12, alignSelf: 'center', color: refreshMsg.includes('✓') ? '#10b981' : '#ef4444' }}>{refreshMsg}</span>}
        </div>
        {noteOpen && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}>
            <textarea value={noteText} autoFocus onChange={e => setNoteText(e.target.value)} placeholder="Add an internal note…" rows={2} style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, resize: 'vertical' }} />
            <button className="btn btn-primary btn-sm" onClick={saveNote} disabled={savingNote || !noteText.trim()}>{savingNote ? 'Saving…' : 'Save Note'}</button>
          </div>
        )}
        {textOpen && client.phone && !client.hub_text_opt_out && <div style={{ marginTop: 8 }}><InlineTextComposer client={client} onClose={() => setTextOpen(false)} onSent={() => { load(); window.dispatchEvent(new CustomEvent('cp-comms-changed')) }} /></div>}
        {emailOpen && client.email && <EmailComposer client={client} onClose={() => setEmailOpen(false)} onSent={() => window.dispatchEvent(new CustomEvent('cp-comms-changed'))} />}
      </div>

      {/* ── One-page body: two-column command center ──────────────────── */}
      <div className="cp-body">
        {alerts.length > 0 && (
          <div className="cp-alerts">{alerts.map((a, i) => <span key={i} className="cp-alert" style={{ background: a.tone === 'bad' ? 'rgba(239,68,68,.12)' : 'rgba(245,158,11,.14)', color: a.tone === 'bad' ? '#ef4444' : '#b45309' }}>⚠ {a.label}</span>)}</div>
        )}
        {(() => {
          const renderers = {
            details: () => <ClientDetails client={client} onSaved={load} />,
            bsprofile: () => <BuyerSellerProfile client={client} ai={ai} />,
            comms: () => <Communications client={client} onOpenText={() => { setTextOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />,
            propact: () => <PropertyActivity client={client} />,
            activity: () => <Section title="Activity" id="activity"><ContactTimeline clientId={cid} /></Section>,
            notes: () => <NotesSection client={client} onSaved={load} onAdd={() => setNoteOpen(true)} />,
            research: () => <Section title="Research" id="research" defaultOpen={false}><Research client={client} /></Section>,
            ai: () => <AiIntelligence ai={ai} followup={followup} cid={cid} />,
            plans: () => <ActionPlans cid={cid} />,
            tasks: () => <div id="cp-tasks"><TasksCard cid={cid} name={name} /></div>,
            txns: () => <TransactionsCard cid={cid} onAdd={addTransaction} navigate={navigate} />,
          }
          return (
            <div className="cp-grid">
              {['left', 'right'].map(col => (
                <div key={col} className={col === 'left' ? 'cp-col-main' : 'cp-col-side'}
                  onDragOver={e => { if (dragKey) e.preventDefault() }}
                  onDrop={e => { if (dragKey) { e.preventDefault(); moveSection(dragKey, null, col) } }}>
                  {layout[col].filter(k => renderers[k]).map(key => {
                    const node = renderers[key]()
                    if (!node) return null
                    return (
                      <div key={key} className={`cp-drag-wrap ${dragKey === key ? 'dragging' : ''}`} draggable={dragArmed === key}
                        onDragStart={() => setDragKey(key)}
                        onDragOver={e => { if (dragKey && dragKey !== key) { e.preventDefault(); e.stopPropagation() } }}
                        onDrop={e => { if (dragKey) { e.preventDefault(); e.stopPropagation(); moveSection(dragKey, key, col) } }}
                        onDragEnd={() => { setDragKey(null); setDragArmed(null) }}>
                        <span className="cp-drag-grip" title="Drag to rearrange this box" onMouseDown={() => setDragArmed(key)} onMouseUp={() => setDragArmed(null)}>⋮⋮</span>
                        {node}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          )
        })()}
      </div>
    </div>
  )
}

// ── Client Details (contact + CRM + tags) ────────────────────────────────
function ClientDetails({ client, onSaved }) {
  const cid = client.id
  return (
    <Section title="Client Details" id="details">
      <div className="cp-two">
        <div>
          <div className="cp-sub">Contact</div>
          <InlineName detail={client} onSaved={onSaved} />
          <InlineField label="Phone" field="phone" value={client.phone} clientId={cid} onSaved={onSaved} />
          <InlineField label="Email" field="email" type="email" value={client.email} clientId={cid} onSaved={onSaved} />
          {client.alt_phones && <p style={{ margin: '2px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}><strong>Other phones:</strong> {client.alt_phones}</p>}
          {client.alt_emails && <p style={{ margin: '2px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}><strong>Other emails:</strong> {client.alt_emails}</p>}
          <InlineField label="Address" field="address" value={client.address} clientId={cid} onSaved={onSaved} />
          <InlineField label="City" field="city" value={client.city} clientId={cid} onSaved={onSaved} />
          <InlineField label="State" field="state" value={client.state} clientId={cid} onSaved={onSaved} />
          <InlineField label="Zip" field="zip" value={client.zip} clientId={cid} onSaved={onSaved} />
        </div>
        <div>
          <div className="cp-sub">CRM</div>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Type:</strong> <TypePill client={client} onSaved={onSaved} /></p>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Status:</strong> <StatusPill client={client} onSaved={onSaved} /></p>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Agent:</strong> <AgentPill client={client} onSaved={onSaved} /></p>
          {client.source && <p><strong>Source:</strong> {client.source}</p>}
          {(client.register_date || client.created_at) && <p><strong>Registered:</strong> {new Date(String(client.register_date || client.created_at).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>}
        </div>
      </div>
      <div style={{ marginTop: 8 }}><div className="cp-sub">Tags</div><TagEditor client={client} onSaved={onSaved} /></div>
    </Section>
  )
}

// ── Tag editor: chips + add/remove (reuses /api/clients/bulk-tags) ────────
function parseTags(raw) {
  if (!raw) return []
  try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map(String).map(s => s.trim()).filter(Boolean) } catch {}
  return String(raw).split(',').map(s => s.trim().replace(/^["\[]+|["\]]+$/g, '')).filter(Boolean)
}
function TagEditor({ client, onSaved }) {
  const tags = parseTags(client.tags)
  const [showAll, setShowAll] = useState(false)
  const [adding, setAdding] = useState(false)
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = async (add, remove) => {
    setBusy(true)
    try { await authFetch('/api/clients/bulk-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [client.id], add, remove }) }); onSaved && onSaved() }
    catch (e) { alert('Tag update failed: ' + e.message) } finally { setBusy(false) }
  }
  const shown = showAll ? tags : tags.slice(0, 8)
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      {shown.map(t => (
        <span key={t} className="cp-tagchip">{t}<button title="Remove tag" disabled={busy} onClick={() => apply([], [t])} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'inherit', marginLeft: 4, fontSize: 12, opacity: 0.7 }}>×</button></span>
      ))}
      {tags.length > 8 && !showAll && <button className="btn btn-sm btn-secondary" onClick={() => setShowAll(true)}>+{tags.length - 8} more</button>}
      {!tags.length && <span style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No tags</span>}
      {adding
        ? <input autoFocus value={val} onChange={e => setVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && val.trim()) { apply([val.trim()], []); setVal(''); setAdding(false) } if (e.key === 'Escape') { setAdding(false); setVal('') } }} onBlur={() => { if (val.trim()) apply([val.trim()], []); setVal(''); setAdding(false) }} placeholder="new tag…" style={{ padding: '2px 7px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-secondary)', color: 'var(--text-primary)', width: 110 }} />
        : <button className="btn btn-sm" onClick={() => setAdding(true)} disabled={busy}>+ Tag</button>}
    </div>
  )
}

// ── Buyer/Seller profile (only known fields) ─────────────────────────────
function BuyerSellerProfile({ client, ai }) {
  const li = ai?.memory_fields || ai?.intelligence || {}
  const money = (v) => v ? '$' + Number(v).toLocaleString() : null
  const rows = client.type === 'seller' ? [
    ['Property', client.address], ['Timeline', li.selling_timeframe], ['Motivation', li.seller_motivation],
    ['Condition', li.condition], ['Price expectation', li.price_expectation], ['Also buying', li.needs_to_sell_first != null ? (li.needs_to_sell_first ? 'Yes' : 'No') : null],
  ] : [
    ['Areas', li.preferred_cities || client.city], ['Price range', (money(client.budget_min || li.price_min) || '?') + ' – ' + (money(client.budget_max || li.price_max) || '?')],
    ['Beds/Baths', [li.bedrooms_min, li.bathrooms_min].filter(Boolean).join(' / ')], ['Property type', li.property_types],
    ['Timeline', li.buying_timeframe], ['Financing', li.preapproved != null ? (li.preapproved ? 'Pre-approved' : 'Not pre-approved') : null],
    ['Lender', client.preapproval_lender], ['Needs to sell', li.needs_to_sell_first != null ? (li.needs_to_sell_first ? 'Yes' : 'No') : null],
    ['Representation', li.working_with_agent != null ? (li.working_with_agent ? 'Has an agent' : 'Unrepresented') : null],
  ]
  const known = rows.filter(([, v]) => v && String(v).trim() && v !== '? – ?')
  if (!known.length) return null
  return (
    <Section title={client.type === 'seller' ? 'Seller Profile' : 'Buyer Profile'} id="bsprofile">
      <div className="cp-kv">{known.map(([k, v]) => <div key={k}><span className="cp-kv-k">{k}</span><span className="cp-kv-v">{v}</span></div>)}</div>
    </Section>
  )
}

// ── Communications (major inline section) ────────────────────────────────
function Communications({ client, onOpenText }) {
  const cid = client.id
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(15)
  const [q, setQ] = useState('')
  const load = useCallback(() => authFetch('/api/inbox/thread/' + cid).then(r => r.json()).then(d => setRows(Array.isArray(d) ? d.slice().reverse() : [])).catch(() => setRows([])), [cid])
  useEffect(() => { load() }, [load])
  useEffect(() => { const h = () => load(); window.addEventListener('cp-comms-changed', h); return () => window.removeEventListener('cp-comms-changed', h) }, [load])
  const FILTERS = [['all', 'All'], ['text', 'Texts'], ['call', 'Calls'], ['email', 'Emails']]
  let items = (rows || []).filter(m => m.channel !== 'note').filter(m => filter === 'all' ? true : m.channel === filter)
  if (q.trim()) { const t = q.toLowerCase(); items = items.filter(m => `${m.body || ''} ${m.preview || ''} ${m.subject || ''}`.toLowerCase().includes(t)) }
  const shown = items.slice(0, limit)
  return (
    <Section title="Communications" id="comms"
      right={<div style={{ display: 'flex', gap: 4 }}>{FILTERS.map(([k, l]) => <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFilter(k)}>{l}</button>)}<button className="btn btn-sm btn-primary" onClick={onOpenText}>+ New</button></div>}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search communications…" style={{ width: '100%', padding: '6px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, marginBottom: 10 }} />
      {rows === null ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        : shown.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing here yet.</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{shown.map(m => <CommItem key={m.id} m={m} />)}</div>}
      {items.length > shown.length && <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setLimit(l => l + 25)}>Load more ({items.length - shown.length})</button>}
    </Section>
  )
}
function CommItem({ m }) {
  const meta = COMM_META[m.channel] || { icon: '•', label: m.channel, color: 'var(--text-muted)' }
  const out = m.direction === 'outgoing'
  const isCallish = m.channel === 'call' || m.channel === 'voicemail'
  const text = commToText(m.body || m.preview || m.subject || '')
  const aiSent = /ai/i.test(m.sent_by_type || m.agent || '')
  return (
    <div style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${meta.color}`, borderRadius: 6, padding: '7px 10px', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 3 }}>
        <span style={{ color: meta.color, fontWeight: 700 }}>{meta.icon} {meta.label}</span>
        <span>{out ? '↗ outbound' : '↙ inbound'}</span>
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

// ── Compact email composer (reuses /api/email/send + templates) ──────────
function EmailComposer({ client, onClose, onSent }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [templates, setTemplates] = useState([])
  const [sending, setSending] = useState(false)
  useEffect(() => { authFetch('/api/templates?type=email').then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {}) }, [])
  const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const send = async () => {
    if (!body.trim()) return
    setSending(true)
    try {
      const r = await authFetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, subject: subject || '(no subject)', body: body.replace(/\n/g, '<br>') }) })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.success !== false) { onSent && onSent(); onClose() } else alert('Email not sent: ' + (d.error || 'unknown'))
    } catch (e) { alert('Email failed: ' + e.message) } finally { setSending(false) }
  }
  return (
    <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>To: {client.email}</span>
        <TemplatePicker templates={templates} onPick={t => { if (t.subject) setSubject(t.subject); setBody(stripHtml(t.body)) }} />
      </div>
      <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" style={{ width: '100%', padding: '7px 9px', marginBottom: 6, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary,#fff)', color: 'var(--text-primary)', fontSize: 13 }} />
      <textarea value={body} onChange={e => setBody(e.target.value)} rows={6} placeholder="Write your email…" style={{ width: '100%', padding: 9, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }} />
      <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary btn-sm" onClick={send} disabled={sending || !body.trim()}>{sending ? 'Sending…' : 'Send Email'}</button>
      </div>
    </div>
  )
}

// ── Property / Web activity ──────────────────────────────────────────────
function PropertyActivity({ client }) {
  let listings = []
  try { listings = JSON.parse(client.fsbo_listings || '[]') } catch {}
  const lastViewed = client.last_fub_activity_at ? new Date(String(client.last_fub_activity_at).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
  if (!listings.length && !lastViewed) return null
  return (
    <Section title={client.type === 'seller' || listings.length ? 'Subject Property / Activity' : 'Property Activity'} id="propact">
      {listings.map((l, i) => (
        <div key={i} style={{ fontSize: 13, marginBottom: 6 }}>
          <strong>{l.address || '—'}</strong> {l.status ? <span className="cp-badge">{l.status}</span> : null} {l.dom != null ? <span style={{ color: 'var(--text-muted)' }}>DOM {l.dom}</span> : null}
          {l.link && <> — <a href={l.link} target="_blank" rel="noopener noreferrer" style={{ color: '#006aff', fontWeight: 600 }}>View Listing ↗</a></>}
        </div>
      ))}
      {lastViewed && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Last website activity: {lastViewed}{client.last_fub_activity_type ? ` · ${client.last_fub_activity_type}` : ''}</div>}
    </Section>
  )
}

// ── Notes ────────────────────────────────────────────────────────────────
function NotesSection({ client, onSaved, onAdd }) {
  const lines = client.notes ? String(client.notes).split('\n').filter(Boolean) : []
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? lines : lines.slice(0, 5)
  return (
    <Section title="Notes" id="notes" right={<button className="btn btn-sm" onClick={onAdd}>+ Add</button>}>
      {!lines.length ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No notes yet.</div>
        : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{shown.map((ln, i) => {
          const m = ln.match(/^\[([^\]]+)\]\s*(.*)$/)
          return <div key={i} style={{ fontSize: 13, borderLeft: '3px solid #f59e0b', paddingLeft: 8, background: 'rgba(245,158,11,0.05)', padding: '5px 8px', borderRadius: '0 6px 6px 0' }}>{m && <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{m[1]}</div>}<div style={{ whiteSpace: 'pre-wrap' }}>{m ? m[2] : ln}</div></div>
        })}</div>}
      {lines.length > 5 && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setShowAll(s => !s)}>{showAll ? 'Show less' : `View all (${lines.length})`}</button>}
    </Section>
  )
}

function Research({ client }) {
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  const gq = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <a className="btn btn-sm btn-secondary" href={gq(`"${name}" ${client.city || ''} ${client.email || ''}`.trim())} target="_blank" rel="noopener noreferrer">🔎 Google this lead</a>
      <a className="btn btn-sm btn-secondary" href={gq(`"${name}" site:linkedin.com`)} target="_blank" rel="noopener noreferrer">LinkedIn</a>
      <a className="btn btn-sm btn-secondary" href={gq(`"${name}" site:facebook.com ${client.city || ''}`)} target="_blank" rel="noopener noreferrer">Facebook</a>
    </div>
  )
}

// ── Sidebar: AI intelligence + next best action ──────────────────────────
function AiIntelligence({ ai, followup, cid }) {
  const [full, setFull] = useState(false)
  const intent = ai?.intent?.score ?? ai?.intent ?? null
  const level = ai?.intent?.level
  const rec = followup && followup.exists !== false ? followup : null
  return (
    <Section title="AI Intelligence" id="ai" right={<button className="btn btn-sm" onClick={() => setFull(f => !f)}>{full ? 'Hide' : 'Open Full AI'}</button>}>
      <div style={{ fontSize: 13, lineHeight: 1.7 }}>
        <div><strong>Intent:</strong> {intent ?? '—'} {level ? `· ${String(level).toUpperCase()}` : ''}</div>
        <div><strong>AI:</strong> {ai?.ai_managed ? 'Managed' : 'Manual'}</div>
        {ai?.ai_state && <div><strong>State:</strong> {String(ai.ai_state).replace(/_/g, ' ').toLowerCase()}</div>}
      </div>
      {rec && (rec.recommended_action || rec.reason || rec.summary) && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(124,58,237,.06)', border: '1px solid rgba(124,58,237,.25)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase' }}>Next Best Action</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{rec.recommended_action || rec.action || rec.title || 'Follow up'}</div>
          {(rec.reason || rec.summary) && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{rec.reason || rec.summary}</div>}
        </div>
      )}
      {full && <div style={{ marginTop: 10 }}><AiIsaCard clientId={cid} /></div>}
    </Section>
  )
}

// ── Sidebar: Tasks ───────────────────────────────────────────────────────
function TasksCard({ cid, name }) {
  const [tasks, setTasks] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const reload = useCallback(() => authFetch(`/api/tasks?related_type=client&related_id=${cid}`).then(r => r.json()).then(d => setTasks(Array.isArray(d) ? d : [])).catch(() => setTasks([])), [cid])
  useEffect(() => { reload() }, [reload])
  const today = new Date().toISOString().slice(0, 10)
  const open = (tasks || []).filter(t => t.status !== 'done')
  const overdue = open.filter(t => t.due_date && t.due_date < today)
  const upcoming = open.filter(t => !(t.due_date && t.due_date < today))
  const row = (t, bad) => <div key={t.id} style={{ fontSize: 13, display: 'flex', gap: 6, padding: '3px 0' }}><span>○</span><span style={{ flex: 1 }}>{t.title}</span>{t.due_date && <span style={{ fontSize: 11, color: bad ? '#ef4444' : 'var(--text-muted)' }}>{t.due_date}</span>}</div>
  return (
    <Section title={`Tasks${open.length ? ` (${open.length})` : ''}`} id="taskscard" right={<button className="btn btn-sm" onClick={() => setAddOpen(o => !o)}>+ Add</button>}>
      {addOpen && <QuickAddTask clientId={cid} clientName={name} onAdded={() => { reload(); setAddOpen(false) }} />}
      {tasks === null ? <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>…</div>
        : !open.length ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No open tasks.</div>
          : <div style={{ marginTop: addOpen ? 8 : 0 }}>
            {overdue.length > 0 && <><div className="cp-sub" style={{ color: '#ef4444' }}>Overdue</div>{overdue.map(t => row(t, true))}</>}
            {upcoming.length > 0 && <><div className="cp-sub">Upcoming</div>{upcoming.slice(0, 6).map(t => row(t, false))}</>}
          </div>}
    </Section>
  )
}

// ── Sidebar: Transactions ────────────────────────────────────────────────
function TransactionsCard({ cid, onAdd, navigate }) {
  const [txns, setTxns] = useState(null)
  const reload = useCallback(() => authFetch('/api/transactions?client_id=' + cid).then(r => r.ok ? r.json() : []).then(d => {
    const arr = Array.isArray(d) ? d : (d.transactions || d.rows || [])
    setTxns(arr.filter(t => String(t.client_id) === String(cid) || [t.buyer_client_id, t.seller_client_id].map(String).includes(String(cid))))
  }).catch(() => setTxns([])), [cid])
  useEffect(() => { reload() }, [reload])
  useEffect(() => { const h = () => reload(); window.addEventListener('cp-txns-changed', h); return () => window.removeEventListener('cp-txns-changed', h) }, [reload])
  return (
    <Section title="Transactions" id="txns" right={<button className="btn btn-sm" onClick={onAdd}>+ Add</button>}>
      {txns === null ? <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>…</div>
        : !txns.length ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>None</div>
          : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{txns.map(t => (
            <div key={t.id} style={{ fontSize: 13, cursor: 'pointer' }} onClick={() => navigate('/transactions')}>
              <strong>{t.property_address || t.address || t.type || 'Transaction'}</strong>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[t.type, t.property_status || t.status, t.closing_date].filter(Boolean).join(' · ')}</div>
            </div>
          ))}<button className="btn btn-sm" style={{ marginTop: 4 }} onClick={() => navigate('/transactions')}>View all →</button></div>}
    </Section>
  )
}

// ── Action Plans (drip / automation / action plan enrollments) ───────────
function ActionPlans({ cid }) {
  const [seq, setSeq] = useState(null)
  const [picker, setPicker] = useState(null)
  const reload = useCallback(() => authFetch(`/api/clients/${cid}/sequences`).then(r => r.json()).then(setSeq).catch(() => setSeq({ drips: [], automations: [] })), [cid])
  useEffect(() => { reload() }, [reload])
  const drips = seq?.drips || []; const autos = seq?.automations || []
  const remove = async (kind, eid) => {
    if (!eid || !window.confirm('Remove this enrollment?')) return
    await authFetch(kind === 'drip' ? `/api/drips/enrollments/${eid}/remove` : `/api/automations/enrollments/${eid}/remove`, { method: 'POST' }).catch(() => {})
    reload()
  }
  const row = (icon, kind, e) => { const eid = e.enrollment_id || e.id; return (
    <div key={kind + eid} style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' }}>
      <span>{icon}</span><span style={{ flex: 1 }}>{e.name || e.drip_name || e.automation_name || kind}</span>
      {e.status && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.status}</span>}
      <button title="Remove" onClick={() => remove(kind, eid)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
    </div>
  ) }
  return (
    <Section title="Action Plans" id="plans" right={<div style={{ display: 'flex', gap: 4 }}><button className="btn btn-sm" onClick={() => setPicker('drip')}>+ Drip</button><button className="btn btn-sm" onClick={() => setPicker('automation')}>+ Automation</button></div>}>
      {seq === null ? <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>…</div>
        : (!drips.length && !autos.length && !picker) ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Not enrolled in any plans.</div>
          : <>{drips.map(d => row('💧', 'drip', d))}{autos.map(a => row('⚡', 'automation', a))}</>}
      {picker && <EnrollPicker kind={picker} cid={cid} onClose={() => setPicker(null)} onDone={() => { setPicker(null); reload() }} />}
    </Section>
  )
}
function EnrollPicker({ kind, cid, onClose, onDone }) {
  const [items, setItems] = useState(null); const [sel, setSel] = useState(''); const [busy, setBusy] = useState(false)
  useEffect(() => { authFetch(kind === 'automation' ? '/api/automations' : '/api/drips').then(r => r.json()).then(d => { let l = Array.isArray(d) ? d : []; if (kind === 'automation') l = l.filter(a => a.status === 'active'); setItems(l) }).catch(() => setItems([])) }, [kind])
  const enroll = async () => {
    if (!sel) return; setBusy(true)
    const r = await authFetch(kind === 'automation' ? `/api/automations/${sel}/enroll` : `/api/drips/${sel}/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_ids: [cid] }) }).then(x => x.json()).catch(e => ({ error: e.message }))
    setBusy(false)
    if (r.error) return alert(r.error)
    if ((r.enrolled || 0) === 0) alert('Not enrolled — likely already in a drip, no email on file, or Do-Not-Contact.')
    onDone()
  }
  return (
    <div style={{ marginTop: 8, padding: 8, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      {items === null ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading…</div>
        : !items.length ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{kind === 'automation' ? 'No active automations.' : 'No drip campaigns.'}</div>
          : <select value={sel} onChange={e => setSel(e.target.value)} autoFocus style={{ width: '100%', padding: '6px 8px', fontSize: 13 }}><option value="">— pick a {kind} —</option>{items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}</select>}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}><button className="btn btn-sm btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-sm btn-primary" disabled={busy || !sel} onClick={enroll}>{busy ? 'Enrolling…' : 'Enroll'}</button></div>
    </div>
  )
}

// ── Draggable section layout (rearrange boxes; persists globally for all leads) ──────────
const DEFAULT_LAYOUT = { left: ['details', 'bsprofile', 'comms', 'propact', 'activity', 'notes', 'research'], right: ['ai', 'plans', 'tasks', 'txns'] }
export function loadLayout() {
  try {
    const s = JSON.parse(localStorage.getItem('cp_layout_v1') || 'null')
    if (s && Array.isArray(s.left) && Array.isArray(s.right)) {
      const all = [...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.right]
      const have = new Set([...s.left, ...s.right])
      const left = [...s.left.filter(k => all.includes(k)), ...DEFAULT_LAYOUT.left.filter(k => !have.has(k))]
      const right = [...s.right.filter(k => all.includes(k)), ...DEFAULT_LAYOUT.right.filter(k => !have.has(k))]
      return { left, right }
    }
  } catch {}
  return DEFAULT_LAYOUT
}
export function saveLayout(l) { try { localStorage.setItem('cp_layout_v1', JSON.stringify(l)) } catch {} }

// ── Alerts ───────────────────────────────────────────────────────────────
function buildAlerts(client, ai) {
  const a = []
  if (client.hub_text_opt_out) a.push({ label: 'SMS opted out (STOP)', tone: 'bad' })
  if (['donotcontact', 'blocked'].includes(String(client.status || '').toLowerCase())) a.push({ label: 'Do Not Contact', tone: 'bad' })
  if (client.do_not_call) a.push({ label: 'Do Not Call', tone: 'bad' })
  if (client.sms_undeliverable) a.push({ label: 'Number undeliverable', tone: 'bad' })
  if (client.email_status && /invalid|bounce/i.test(client.email_status)) a.push({ label: 'Invalid email', tone: 'bad' })
  if (ai?.ai_pause_until) a.push({ label: 'AI paused', tone: 'warn' })
  if (ai?.open_handoff) a.push({ label: 'Human handoff requested', tone: 'warn' })
  return a
}
