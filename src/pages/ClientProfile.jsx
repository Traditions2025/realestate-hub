import { notify, confirmDialog } from '../notify'
import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { authFetch } from '../api'
import TemplatePicker from '../components/TemplatePicker'
import {
  InlineName, InlineField, QuickAddTask, ContactTimeline, AiIsaCard,
  InlineTextComposer, COMM_META, commToText, stripQuotedDisplay, fmtCommWhen, fmtDur, recUrl, SIERRA_STATUSES,
  phoneD10, phoneLabelMap,
} from './Clients'

// Phone deliverability badge — shows what Twilio Lookup / delivery results told us:
// mobile (can text), landline / fixed VoIP (can't text), disconnected/unknown, or unchecked.
function PhoneStatusBadge({ client }) {
  const lt = String(client.sms_line_type || '').toLowerCase()
  const reason = String(client.sms_undeliverable_reason || '')
  let label, tone
  if (client.sms_undeliverable) {
    if (/landline|fixedvoip/i.test(reason) || lt === 'landline' || lt === 'fixedvoip') { label = 'Landline — can’t receive texts'; tone = 'bad' }
    else if (/30005|unknown|non.?exist|disconnect/i.test(reason)) { label = 'Disconnected / unknown number'; tone = 'bad' }
    else { label = 'Undeliverable for SMS'; tone = 'bad' }
  } else if (lt === 'mobile') { label = 'Mobile — can receive texts'; tone = 'good' }
  else if (lt && lt !== 'unknown') { label = `Textable (${client.sms_line_type})`; tone = 'ok' }
  else if (client.sms_line_checked_at) { label = 'Verified (type unknown)'; tone = 'ok' }
  else return null   // never checked → show nothing
  const C = { good: ['#065f46', '#d1fae5'], bad: ['#991b1b', '#fee2e2'], ok: ['#374151', '#e5e7eb'] }
  const [fg, bg] = C[tone]
  let when = null
  try { if (client.sms_line_checked_at) when = new Date(String(client.sms_line_checked_at).replace(' ', 'T')).toLocaleDateString() } catch {}
  return (
    <div style={{ margin: '3px 0 5px' }}>
      <span style={{ fontSize: 12, fontWeight: 700, padding: '2px 8px', borderRadius: 10, color: fg, background: bg }}>
        {tone === 'good' ? '✓ ' : tone === 'bad' ? '⚠ ' : ''}{label}
      </span>
      {when && <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 6 }}>checked {when}</span>}
    </div>
  )
}

// Clickable status pill (single status control — no redundant copies). Writes to Hub + Sierra.
// Realist Score badge (same score+grade styling as the Clients list) — click to edit.
function RealistScoreBadge({ client, onSaved }) {
  const edit = async () => {
    const v = window.prompt('Realist Score (0-1000, blank to clear):', client.lead_score ?? '')
    if (v === null) return
    const digits = String(v).replace(/[^0-9]/g, '')
    try {
      await authFetch(`/api/clients/${client.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lead_score: digits === '' ? null : digits }) })
      onSaved && onSaved()
    } catch (e) { notify('Failed to save Realist Score: ' + e.message) }
  }
  const has = client.lead_score !== null && client.lead_score !== undefined && client.lead_score !== ''
  return (
    <span onClick={edit} title={has ? 'Realist Score — click to edit' : 'Click to enter the Realist Score'} style={{ cursor: 'pointer' }}>
      {has
        ? <span className={`lead-score grade-${(client.lead_grade || 'F').replace('+', 'plus').toLowerCase()}`}>{client.lead_score}{client.lead_grade && <span className="lead-grade">{client.lead_grade}</span>}</span>
        : <span className="cp-badge cp-badge-muted">Realist —</span>}
    </span>
  )
}

function StatusPill({ client, onSaved }) {
  const change = async (v) => {
    try {
      await authFetch('/api/clients/' + client.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: v }) })
      if (client.sierra_lead_id) authFetch('/api/sierra/update-lead-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, status: v }) }).catch(() => {})
      onSaved && onSaved()
    } catch (e) { notify('Status update failed: ' + e.message) }
  }
  return <select className={`status-quick-select status-${client.status}`} value={client.status || ''} onChange={e => change(e.target.value)} title="Change status">
    {SIERRA_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
  </select>
}
// Clickable assigned-agent pill.
function AgentPill({ client, onSaved }) {
  const [agents, setAgents] = React.useState([])
  React.useEffect(() => { authFetch('/api/inbox/agents').then(r => r.json()).then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  const change = async (v) => { try { await authFetch('/api/clients/' + client.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent_assigned: v || null }) }); onSaved && onSaved() } catch (e) { notify('Assign failed: ' + e.message) } }
  return <select className="status-quick-select" value={client.agent_assigned || ''} onChange={e => change(e.target.value)} title="Assign agent" style={{ maxWidth: 150 }}>
    <option value="">Unassigned</option>
    {agents.map(a => <option key={a} value={a}>{a}</option>)}
    {client.agent_assigned && !agents.includes(client.agent_assigned) && <option value={client.agent_assigned}>{client.agent_assigned}</option>}
  </select>
}
// Editable Buyer/Seller type.
function TypePill({ client, onSaved }) {
  const change = async (v) => { try { await authFetch('/api/clients/' + client.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: v }) }); onSaved && onSaved() } catch (e) { notify('Type update failed: ' + e.message) } }
  return <select className={`status-quick-select type-${client.type || 'buyer'}`} value={client.type || 'buyer'} onChange={e => change(e.target.value)} title="Change type">
    <option value="buyer">Buyer</option><option value="seller">Seller</option><option value="both">Buyer/Seller</option>
  </select>
}
import { loadClientsNav, markClientsReturn } from '../lib/clientsNav'

// One-page full-screen Client/Lead command center at /clients/:id. The whole relationship is
// reviewable by scrolling — no primary tabs. Reuses HUB's existing components + APIs (no
// duplicated SMS/email/AI/task/transaction/Sierra systems).

function Section({ title, children, right, defaultOpen = true, id, className = '' }) {
  const key = id ? 'cp_sec_' + id : null
  const [open, setOpen] = useState(() => { try { return key && localStorage.getItem(key) != null ? localStorage.getItem(key) === '1' : defaultOpen } catch { return defaultOpen } })
  const toggle = () => setOpen(o => { const n = !o; try { if (key) localStorage.setItem(key, n ? '1' : '0') } catch {} return n })
  return (
    <section className={'cp-card' + (className ? ' ' + className : '')}>
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
  const [emailPrefill, setEmailPrefill] = useState(null)
  const [noteOpen, setNoteOpen] = useState(false)
  const [apptOpen, setApptOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [taskOpen, setTaskOpen] = useState(false)
  const [savingNote, setSavingNote] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [layout, setLayout] = useState(loadLayout)
  const [dragKey, setDragKey] = useState(null)
  const [dragArmed, setDragArmed] = useState(null)
  const moveSection = (fromKey, toKey, toCol) => {
    if (fromKey === 'details') { setDragKey(null); setDragArmed(null); return }   // Client Details is locked in place
    setLayout(prev => {
      let next = { left: prev.left.filter(k => k !== fromKey), right: prev.right.filter(k => k !== fromKey) }
      const arr = next[toCol]; const at = toKey ? arr.indexOf(toKey) : arr.length
      arr.splice(at < 0 ? arr.length : at, 0, fromKey)
      next = lockDetailsFirst(next)   // nothing can land above Client Details
      saveLayout(next); return next
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
  useEffect(() => { window.scrollTo(0, 0); setTextOpen(false); setEmailOpen(false); setNoteOpen(false); setTaskOpen(false) }, [cid])
  // "Use in Email" on the AI card opens the composer prefilled with the suggested draft.
  useEffect(() => {
    const h = (e) => { setEmailPrefill(e.detail || null); setTextOpen(false); setEmailOpen(true) }
    window.addEventListener('cp-compose-email', h)
    return () => window.removeEventListener('cp-compose-email', h)
  }, [])

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
    } catch (e) { notify('Failed to save note: ' + e.message) } finally { setSavingNote(false) }
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
      if (r.ok) { notify('Transaction added.'); window.dispatchEvent(new CustomEvent('cp-txns-changed')) } else notify('Could not add transaction.')
    } catch (e) { notify('Could not add transaction: ' + e.message) }
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
          {ids.length > 1 && (
            <div className="cp-prevnext">
              <button className="btn btn-sm" disabled={idx <= 0} onClick={() => goToIndex(idx - 1)}>‹ Prev</button>
              <span className="cp-count">{idx >= 0 ? `${idx + 1} of ${ids.length}` : `${ids.length} in list`}</span>
              <button className="btn btn-sm" disabled={idx >= 0 ? idx >= ids.length - 1 : false} onClick={() => goToIndex(idx >= 0 ? idx + 1 : 0)}>Next ›</button>
            </div>
          )}
        </div>
        <div className="cp-identity">
          <h1 className="cp-name">{name}</h1>
          <div className="cp-badges">
            <TypePill client={client} onSaved={load} />
            <StatusPill client={client} onSaved={load} />
            <AgentPill client={client} onSaved={load} />
            <RealistScoreBadge client={client} onSaved={load} />
            {client.source && <span className="cp-badge cp-badge-muted">{client.source}</span>}
            {intent != null && <span className="cp-badge" style={{ background: 'rgba(37,99,235,.12)', color: '#2563eb' }}>Intent {intent}</span>}
            {ai?.ai_managed && <span className="cp-badge" style={{ background: 'rgba(124,58,237,.12)', color: '#7c3aed' }}>AI Managed</span>}
          </div>
        </div>
        <div className="cp-actions">
          {client.phone && !client.hub_text_opt_out && <button className="lead-action-btn" onClick={() => { setTextOpen(v => !v); setEmailOpen(false) }}><span className="lead-action-icon">💬</span><span>Text</span></button>}
          {(client.phone || client.alt_phones) && <CallActionButton client={client} name={name} />}
          {client.email && <button className="lead-action-btn" onClick={() => { setEmailOpen(v => !v); setTextOpen(false) }}><span className="lead-action-icon">✉</span><span>Email</span></button>}
          <button className="lead-action-btn" onClick={() => setApptOpen(true)}><span className="lead-action-icon">📅</span><span>Appointment</span></button>
          <button className="lead-action-btn" onClick={() => setNoteOpen(o => !o)}><span className="lead-action-icon">📝</span><span>Add Note</span></button>
          <button className={`lead-action-btn${taskOpen ? ' active' : ''}`} onClick={() => setTaskOpen(o => !o)}><span className="lead-action-icon">✅</span><span>Add Task</span></button>
          <button className="lead-action-btn" onClick={addTransaction}><span className="lead-action-icon">➕</span><span>Transaction</span></button>
          {client.sierra_lead_id && <button className="lead-action-btn lead-action-refresh" onClick={refreshSierra} disabled={refreshing}><span className="lead-action-icon">{refreshing ? '⟳' : '↻'}</span><span>{refreshing ? 'Refreshing…' : 'Refresh from Sierra'}</span></button>}
          {refreshMsg && <span style={{ fontSize: 12, alignSelf: 'center', color: refreshMsg.includes('✓') ? '#10b981' : '#ef4444' }}>{refreshMsg}</span>}
        </div>
        {apptOpen && <AppointmentModal client={client} onClose={() => setApptOpen(false)} />}
        {noteOpen && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'flex-start' }}>
            <textarea value={noteText} autoFocus onChange={e => setNoteText(e.target.value)} placeholder="Add an internal note…" rows={2} style={{ flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, resize: 'vertical' }} />
            <button className="btn btn-primary btn-sm" onClick={saveNote} disabled={savingNote || !noteText.trim()}>{savingNote ? 'Saving…' : 'Save Note'}</button>
          </div>
        )}
        {textOpen && (client.phone || client.alt_phones) && !client.hub_text_opt_out && <div style={{ marginTop: 8 }}><InlineTextComposer client={client} onClose={() => setTextOpen(false)} onSent={() => { load(); window.dispatchEvent(new CustomEvent('cp-comms-changed')) }} /></div>}
        {emailOpen && (client.email || client.alt_emails) && <EmailComposer client={client} initial={emailPrefill} onClose={() => { setEmailOpen(false); setEmailPrefill(null) }} onSent={() => window.dispatchEvent(new CustomEvent('cp-comms-changed'))} />}
        {taskOpen && <div style={{ marginTop: 8 }}><QuickAddTask clientId={cid} clientName={name} clientAddress={[client.address, client.city, client.state, client.zip].filter(Boolean).join(', ')} onAdded={() => { setTaskOpen(false); window.dispatchEvent(new CustomEvent('cp-tasks-changed')) }} /></div>}
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
            comms: () => <Communications client={client} onOpenText={() => { setTextOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }) }} onAddNote={() => { setNoteOpen(true); window.scrollTo({ top: 0, behavior: 'smooth' }) }} />,
            propact: () => <PropertyActivity client={client} onSaved={load} />,
            interest: () => <ListingInterest client={client} />,
            website: () => <WebsiteActivity cid={cid} />,
            fub: () => <FubActivity cid={cid} />,
            sierra: () => <SierraActivity client={client} />,
            activity: () => <Section title="Activity" id="activity"><ContactTimeline clientId={cid} /></Section>,
            // "Social & Research" retired (John, 2026-09-25): LinkedIn and Facebook are now
            // editable rows inside Client Details, where the rest of the contact detail lives.
            coverage: () => <CoverageCard cid={cid} client={client} onChanged={load} />,
            cxcamp: () => (client.mls_status || client.off_market_date) ? <CxCampaignCard cid={cid} client={client} /> : null,
            fsbocamp: () => (client.fsbo_status || client.fsbo_listings) ? <FsboCampaignCard cid={cid} client={client} /> : null,
            ai: () => <AiIntelligence ai={ai} followup={followup} cid={cid} />,
            sellerintent: () => (String(client.tags || '').includes('FB Seller Ad') || client.seller_timeframe) ? <SellerIntentCard cid={cid} /> : null,
            appts: () => <AppointmentsCard cid={cid} client={client} />,
            plans: () => <ActionPlans cid={cid} />,
            tasks: () => <div id="cp-tasks"><TasksCard cid={cid} name={name} address={[client.address, client.city, client.state, client.zip].filter(Boolean).join(', ')} /></div>,
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
                    const locked = key === 'details' || key === 'comms'   // Details + Communications are pinned — no grip, not draggable
                    return (
                      <div key={key} className={`cp-drag-wrap ${dragKey === key ? 'dragging' : ''}`} draggable={!locked && dragArmed === key}
                        onDragStart={e => { if (locked) { e.preventDefault(); return } setDragKey(key) }}
                        onDragOver={e => { if (dragKey && dragKey !== key) { e.preventDefault(); e.stopPropagation() } }}
                        onDrop={e => { if (dragKey) { e.preventDefault(); e.stopPropagation(); moveSection(dragKey, key, col) } }}
                        onDragEnd={() => { setDragKey(null); setDragArmed(null) }}>
                        {!locked && <span className="cp-drag-grip" title="Drag to rearrange this box" onMouseDown={() => setDragArmed(key)} onMouseUp={() => setDragArmed(null)}>⋮⋮</span>}
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

// ── Cancelled/Expired Connection Campaign card ───────────────────────────
// Persistent make-contact SMS drip for Cancelled/Expired leads. Shows enrollment
// status, next outreach, attempt count, last angle, off-market age, and the send/
// suppression log. A response flips the card to HUMAN FOLLOW-UP REQUIRED and the
// AI never replies to these leads.
const CX_STATUS_META = {
  active: { label: 'ACTIVE', color: '#059669' },
  response_received: { label: 'RESPONSE RECEIVED — HUMAN FOLLOW-UP REQUIRED', color: '#dc2626' },
  paused: { label: 'PAUSED', color: '#d97706' },
  ineligible: { label: 'STOPPED', color: 'var(--text-muted)' },
  removed: { label: 'REMOVED', color: 'var(--text-muted)' },
}
// FSBO Automatic Text Campaign card — same shape as the CX card: state, attempts,
// next send, controls, log. RESPONSE RECEIVED gets the strong banner.
const FSBO_STATUS_META = {
  active: { label: 'ACTIVE', color: '#15803d' },
  responded: { label: '📨 RESPONSE RECEIVED', color: '#d97706' },
  paused: { label: 'PAUSED', color: '#b45309' },
  removed: { label: 'REMOVED', color: '#ef4444' },
  stopped: { label: 'STOPPED', color: 'var(--text-muted)' },
}
function FsboCampaignCard({ cid, client }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const [next, setNext] = useState(null)
  const load = useCallback(() => authFetch('/api/lists/fsbo/campaign/' + cid).then(r => r.json()).then(setSt).catch(() => setSt(null)), [cid])
  useEffect(() => { load() }, [load])
  const act = async (path, body) => {
    setBusy(true)
    try {
      const r = await authFetch(`/api/lists/fsbo/campaign/${cid}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      const d = await r.json()
      if (d && d.ok === false && d.reason) notify('Not possible: ' + d.reason)
      load()
    } catch (e) { notify('Failed: ' + e.message) } finally { setBusy(false) }
  }
  const previewNext = async () => {
    try { const r = await authFetch(`/api/lists/fsbo/campaign/${cid}/preview-next`); setNext(await r.json()) } catch { setNext(null) }
  }
  if (!st) return null
  const en = st.enrollment
  const ev = st.evaluation || {}
  const fmtD = (iso) => { try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' } catch { return '—' } }
  const meta = en ? (FSBO_STATUS_META[en.status] || { label: String(en.status || '').toUpperCase(), color: 'var(--text-muted)' }) : null
  return (
    <Section title="FSBO Campaign" id="fsbocamp">
      {!en ? (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          {ev.decision === 'waiting'
            ? <div><strong style={{ color: '#2563eb' }}>WAITING FOR DOM</strong> — DOM {ev.dom}, campaign starts at DOM {ev.dom + (ev.days_until || 0)} ({ev.days_until} day{ev.days_until === 1 ? '' : 's'} away).</div>
            : ev.decision === 'eligible'
              ? <div><strong style={{ color: '#15803d' }}>ELIGIBLE</strong> — DOM {ev.dom}; the next sweep will auto-enroll (master switch permitting).</div>
              : <div style={{ color: 'var(--text-muted)' }}>Not in the campaign — {ev.reason_code}: {ev.reason}</div>}
        </div>
      ) : (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 800, color: meta.color, marginBottom: 4 }}>{meta.label}</div>
          {en.status === 'responded' && <div style={{ fontSize: 12, marginBottom: 4 }}>{en.response_class ? <>Classified: <strong>{en.response_class}</strong> — </> : null}the campaign has stopped; reply personally.</div>}
          {en.status === 'stopped' && en.stop_reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Reason: {en.stop_reason}</div>}
          <div><strong>Property:</strong> {en.listing_address || client.address || '—'} · DOM {ev.dom ?? client.fsbo_dom ?? '?'} · {client.fsbo_status || 'off list'}</div>
          <div><strong>Attempts:</strong> {en.attempt_count || 0}{en.last_angle ? ` · last angle ${en.last_angle}` : ''}{en.started_dom != null ? ` · started at DOM ${en.started_dom}` : ''}</div>
          {en.status === 'active' && <div><strong>Next send:</strong> {en.next_send_at ? fmtD(en.next_send_at) : '—'} (weekday 9–4 window)</div>}
          {en.last_sent_at && <div><strong>Last sent:</strong> {fmtD(en.last_sent_at)}</div>}
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {en.status === 'active' && <button className="btn btn-sm" disabled={busy} onClick={() => act('pause')}>⏸ Pause</button>}
            {['paused', 'stopped'].includes(en.status) && <button className="btn btn-sm" disabled={busy} onClick={() => act('resume')}>▶ Resume</button>}
            {en.status !== 'removed' && <button className="btn btn-sm" disabled={busy} onClick={ async () => { if (await confirmDialog('Remove this lead from the FSBO campaign? Sweeps will never re-enroll them.')) act('remove') }} style={{ color: '#ef4444' }}>Remove</button>}
            {en.status === 'active' && <button className="btn btn-sm" onClick={previewNext}>👁 Preview next</button>}
            {(st.log || []).length > 0 && <button className="btn btn-sm" onClick={() => setShowLog(v => !v)}>{showLog ? 'Hide log' : `Log (${st.log.length})`}</button>}
          </div>
          {next && <div style={{ marginTop: 8, fontSize: 12, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)' }}>{next.eligible ? <><strong>Attempt {next.attempt} · {next.angle}:</strong> {next.message}</> : <>Would not send: {next.reason}</>}</div>}
          {showLog && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {st.log.map(l => (
                <div key={l.id} style={{ fontSize: 12, borderLeft: '2px solid var(--border)', paddingLeft: 7 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{fmtD(l.created_at)} · </span>
                  <strong>{l.event}</strong>{l.angle ? ` · ${l.angle}` : ''}{l.reason ? ` · ${l.reason}` : ''}{l.dom != null ? ` · DOM ${l.dom}` : ''}
                  {l.body ? <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{String(l.body).slice(0, 160)}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function CxCampaignCard({ cid, client }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [showLog, setShowLog] = useState(false)
  const loadCx = useCallback(() => authFetch('/api/cx/' + cid).then(r => r.json()).then(setSt).catch(() => setSt(null)), [cid])
  useEffect(() => { loadCx() }, [loadCx])
  const act = async (path) => {
    setBusy(true)
    try {
      const r = await authFetch(`/api/cx/${cid}/${path}`, { method: 'POST' })
      const d = await r.json()
      if (d && d.ok === false && d.reason) notify('Not possible: ' + d.reason)
      loadCx()
    } catch (e) { notify('Failed: ' + e.message) } finally { setBusy(false) }
  }
  if (!st) return null
  const fmtD = (iso) => { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) } catch { return '—' } }
  const meta = CX_STATUS_META[st.status] || { label: String(st.status || '').toUpperCase(), color: 'var(--text-muted)' }
  return (
    <Section title="Cancelled/Expired Campaign" id="cxcamp">
      {!st.enrolled ? (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 8 }}>Not enrolled in the connection campaign.</div>
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('enroll')}>Enroll in Campaign</button>
          {!st.enabled && <div style={{ fontSize: 12, color: '#d97706', marginTop: 6 }}>Master switch is OFF (Settings) — enrolled leads won't be texted until it's on.</div>}
        </div>
      ) : (
        <div style={{ fontSize: 13, lineHeight: 1.7 }}>
          <div style={{ fontWeight: 800, color: meta.color, marginBottom: 4 }}>{meta.label}</div>
          {st.status === 'ineligible' && st.stop_reason && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Reason: {st.stop_reason}</div>}
          {st.status === 'response_received' && st.response_class && <div style={{ fontSize: 12, marginBottom: 4 }}>Classified: <strong>{st.response_class}</strong> — reply personally; the AI stays silent on this lead.</div>}
          <div><strong>Attempts:</strong> {st.attempt_count || 0}{st.last_angle ? ` · last angle ${st.last_angle}` : ''}</div>
          {st.status === 'active' && <div><strong>Next outreach:</strong> {st.next_send_at ? fmtD(st.next_send_at) : '—'} (weekday window)</div>}
          <div><strong>Off market:</strong> {client.off_market_date || 'unknown'}{st.days_off_market != null ? ` · ${st.days_off_market}d · ${st.age_bucket}` : ` · ${st.age_bucket} language`}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {st.status === 'active' && <button className="btn btn-sm" disabled={busy} onClick={() => act('pause')}>⏸ Pause</button>}
            {(st.status === 'paused' || st.status === 'ineligible' || st.status === 'response_received' || st.status === 'removed') && <button className="btn btn-sm" disabled={busy} onClick={() => act('resume')}>▶ {st.status === 'paused' ? 'Resume' : 'Re-enroll'}</button>}
            {st.status !== 'removed' && <button className="btn btn-sm" disabled={busy} onClick={ async () => { if (await confirmDialog('Remove this lead from the campaign?')) act('remove') }} style={{ color: '#ef4444' }}>Remove</button>}
            {(st.log || []).length > 0 && <button className="btn btn-sm" onClick={() => setShowLog(v => !v)}>{showLog ? 'Hide log' : `Log (${st.log.length})`}</button>}
          </div>
          {showLog && (
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
              {st.log.map(l => (
                <div key={l.id} style={{ fontSize: 12, borderLeft: '2px solid var(--border)', paddingLeft: 7 }}>
                  <span style={{ color: 'var(--text-muted)' }}>{fmtD(l.created_at)} · </span>
                  <strong>{l.event}</strong>
                  {l.angle ? ` · ${l.angle}` : ''}{l.age_bucket ? ` · ${l.age_bucket}` : ''}
                  {l.suppression_reason ? ` · ${l.suppression_reason}` : ''}
                  {l.body ? <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap' }}>{String(l.body).slice(0, 160)}</div> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

// ── Call button with number picker ───────────────────────────────────────
// One number: dials it directly, same as before. Two or more (primary +
// Additional phones): opens a small picker so you choose which one to call.
function CallActionButton({ client, name }) {
  const nums = [client.phone, ...String(client.alt_phones || '').split(',')].map(p => String(p || '').trim()).filter(Boolean)
  const uniq = [...new Set(nums)]
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const click = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const key = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', click); document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key) }
  }, [open])
  const dial = (num) => { setOpen(false); if (window.hubCall) window.hubCall(num, name) }
  if (!uniq.length) return null
  if (uniq.length === 1) {
    return <button className="lead-action-btn" onClick={() => dial(uniq[0])}><span className="lead-action-icon">📞</span><span>Call</span></button>
  }
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="lead-action-btn" onClick={() => setOpen(o => !o)} title="Choose which number to call" aria-haspopup="menu" aria-expanded={open}>
        <span className="lead-action-icon">📞</span><span>Call ▾</span>
      </button>
      {open && (
        <div role="menu" style={{ position: 'absolute', top: '100%', left: 0, marginTop: 4, background: 'var(--card, var(--bg-secondary))', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,.18)', zIndex: 80, minWidth: 190, overflow: 'hidden' }}>
          {uniq.map(num => (
            <button key={num} role="menuitem" onClick={() => dial(num)}
              style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', cursor: 'pointer', padding: '8px 12px' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>{num}</div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{phoneLabelMap(client)[phoneD10(num)] || (num === String(client.phone || '').trim() ? 'Primary' : 'Additional')}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Client Details (contact + CRM + tags) ────────────────────────────────
// Tiny inline adder: appends one more phone/email to the comma-separated alt list.
// Opened by the ＋ next to the pencil on the Phone / Email rows.
function AltQuickAdd({ cid, field, placeholder, existing, existingLabels, onSaved, onClose }) {
  const [val, setVal] = useState('')
  const [nick, setNick] = useState('')
  const [saving, setSaving] = useState(false)
  const isPhone = field === 'alt_phones'
  const save = async () => {
    if (!val.trim()) { onClose(); return }
    setSaving(true)
    try {
      const combined = existing ? `${existing}, ${val.trim()}` : val.trim()
      const body = { [field]: combined }
      // Additional phones can carry a nickname ("Wife - Sarah", "Work") so every
      // number picker can say who the number belongs to.
      if (isPhone && nick.trim()) {
        let map = {}; try { map = JSON.parse(existingLabels || '{}') } catch {}
        map[phoneD10(val)] = nick.trim()
        body.alt_phone_labels = JSON.stringify(map)
      }
      await authFetch(`/api/clients/${cid}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      onSaved && onSaved(); onClose()
    } catch (e) { notify('Could not save: ' + e.message) } finally { setSaving(false) }
  }
  return (
    <p style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <input autoFocus value={val} placeholder={placeholder} onChange={e => setVal(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
        style={{ flex: 1, minWidth: 140, padding: '3px 6px' }} />
      {isPhone && <input value={nick} placeholder="Nickname (e.g. Wife - Sarah)" onChange={e => setNick(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onClose() }}
        style={{ flex: 1, minWidth: 130, padding: '3px 6px' }} />}
      <button className="btn btn-sm btn-primary" disabled={saving} onClick={save}>{saving ? '…' : 'Save'}</button>
      <button className="btn btn-sm btn-secondary" onClick={onClose}>Cancel</button>
    </p>
  )
}

// Nickname chips for the Additional phones row: shows each extra number with its
// label and lets you set/rename it in place.
function AltPhoneLabels({ client, onSaved }) {
  const nums = String(client.alt_phones || '').split(',').map(p => p.trim()).filter(Boolean)
  if (!nums.length) return null
  const map = phoneLabelMap(client)
  const rename = async (p) => {
    const cur = map[phoneD10(p)] || ''
    const nick = window.prompt(`Nickname for ${p} (who is this number?):`, cur)
    if (nick === null) return
    const next = { ...map }
    if (nick.trim()) next[phoneD10(p)] = nick.trim(); else delete next[phoneD10(p)]
    try {
      await authFetch(`/api/clients/${client.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alt_phone_labels: JSON.stringify(next) }) })
      onSaved && onSaved()
    } catch (e) { notify('Could not save: ' + e.message) }
  }
  return (
    <p style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '2px 0 3px' }}>
      {nums.map(p => (
        <button key={p} onClick={() => rename(p)} title="Click to set who this number belongs to"
          style={{ fontSize: 12, border: '1px solid var(--border)', borderRadius: 999, background: 'var(--bg-secondary)', color: 'var(--text-secondary)', padding: '2px 9px', cursor: 'pointer' }}>
          {p} — {map[phoneD10(p)] || 'set nickname ✎'}
        </button>
      ))}
    </p>
  )
}
const plusBtnStyle = { border: '1px solid var(--accent-border)', background: 'none', color: 'var(--accent)', borderRadius: 6, width: 20, height: 20, lineHeight: '16px', fontSize: 14, cursor: 'pointer', padding: 0 }

function ClientDetails({ client, onSaved }) {
  const cid = client.id
  const [altAdd, setAltAdd] = useState(null) // 'phones' | 'emails' | null
  // MLS # / Off Market Date are prospecting-list fields — only shown for FSBO and
  // Cancelled/Expired leads (or when the fields already hold data, so nothing gets hidden).
  const showMlsFields = !!(client.fsbo_status || client.mls_status || client.off_market_date || client.mls_number
    || /fsbo|expired|cancell?ed/i.test(`${client.tags || ''} ${client.source || ''}`))
  return (
    <Section title="Client Details" id="details" className="cp-details">
      <div className="cp-two">
        <div>
          <div className="cp-sub">Contact</div>
          <InlineName detail={client} onSaved={onSaved} />
          <InlineField label="Phone" field="phone" value={client.phone} clientId={cid} onSaved={onSaved}
            statusTag={<button title="Add another phone number for this lead" style={plusBtnStyle} onClick={() => setAltAdd(v => v === 'phones' ? null : 'phones')}>＋</button>} />
          {altAdd === 'phones' && <AltQuickAdd cid={cid} field="alt_phones" placeholder="(319) 555-0100" existing={client.alt_phones} existingLabels={client.alt_phone_labels} onSaved={onSaved} onClose={() => setAltAdd(null)} />}
          {client.phone && <PhoneStatusBadge client={client} />}
          {client.alt_phones && <InlineField label="Additional phones" field="alt_phones" value={client.alt_phones} clientId={cid} onSaved={onSaved} placeholder="(319) 555-0100, (319) 555-0200 — comma separated" />}
          {client.alt_phones && <AltPhoneLabels client={client} onSaved={onSaved} />}
          <InlineField label="Email" field="email" type="email" value={client.email} clientId={cid} onSaved={onSaved}
            statusTag={<button title="Add another email address for this lead" style={plusBtnStyle} onClick={() => setAltAdd(v => v === 'emails' ? null : 'emails')}>＋</button>} />
          {altAdd === 'emails' && <AltQuickAdd cid={cid} field="alt_emails" placeholder="name@gmail.com" existing={client.alt_emails} onSaved={onSaved} onClose={() => setAltAdd(null)} />}
          {client.alt_emails && <InlineField label="Additional emails" field="alt_emails" type="text" value={client.alt_emails} clientId={cid} onSaved={onSaved} placeholder="name@gmail.com, work@company.com — comma separated" />}
          <InlineField label="Address" field="address" value={client.address} clientId={cid} onSaved={onSaved} />
          <InlineField label="City" field="city" value={client.city} clientId={cid} onSaved={onSaved} />
          <InlineField label="State" field="state" value={client.state} clientId={cid} onSaved={onSaved} />
          <InlineField label="Zip" field="zip" value={client.zip} clientId={cid} onSaved={onSaved} />
          {showMlsFields && <InlineField label="Off Market Date" field="off_market_date" type="date" value={client.off_market_date} clientId={cid} onSaved={onSaved} />}
          {showMlsFields && <InlineField label="MLS #" field="mls_number" value={client.mls_number} clientId={cid} onSaved={onSaved} />}
          {/* Source + Registered sit with Contact (John, 2026-09-25): where the lead came
              from and when reads with the person, not with the CRM controls. */}
          {client.source && <p><strong>Source:</strong> {client.source}</p>}
          {(client.register_date || client.created_at) && <p><strong>Registered:</strong> {new Date(String(client.register_date || client.created_at).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</p>}
        </div>
        <div>
          <div className="cp-sub">CRM</div>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Type:</strong> <TypePill client={client} onSaved={onSaved} /></p>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Status:</strong> <StatusPill client={client} onSaved={onSaved} /></p>
          <p style={{ display: 'flex', alignItems: 'center', gap: 6 }}><strong>Agent:</strong> <AgentPill client={client} onSaved={onSaved} /></p>
          {(client.realist_market_value || client.realist_sell_score || client.realist_year_built) && (
            <p><strong>Realist:</strong> {[
              client.realist_market_value ? `$${Number(client.realist_market_value).toLocaleString()} est. value` : null,
              client.realist_sell_score ? `Sell Score ${client.realist_sell_score}` : null,
              client.realist_year_built ? `Built ${client.realist_year_built}` : null,
              client.realist_owner_occupied != null ? (client.realist_owner_occupied ? 'Owner-occupied' : 'Non-owner-occupied') : null,
            ].filter(Boolean).join(' · ')}</p>
          )}
          {/* Social sits in the CRM column (John, 2026-09-25): Contact runs long and CRM
              runs short, so these three rows fill the column that was ending early instead
              of adding height to the one that sets the card's height. Sierra holds neither
              URL, so neither pushes. Work only appears once something filled it. */}
          <div className="cp-sub">Social</div>
          {/* Picture sits immediately beside the links, not floated to the column edge
              (John, 2026-09-25): a float pins it to the far right, which on a wide screen
              strands it a long way from the rows it belongs to. As a flex sibling it stays
              adjacent at every width, and still adds no height while the rows are taller
              than it. Third-party URLs (Follow Up Boss, Gravatar) rot, so a broken one
              hides itself rather than leaving a torn-image icon. */}
          <div className="cp-social">
            <div className="cp-social-rows">
              <InlineField label="LinkedIn" field="linkedin_url" value={client.linkedin_url} clientId={cid} onSaved={onSaved}
                link linkColor="#0077b5" syncSierra={false} addLabel="+ Add LinkedIn" placeholder="https://linkedin.com/in/…" />
              <InlineField label="Facebook" field="facebook_url" value={client.facebook_url} clientId={cid} onSaved={onSaved}
                link linkColor="#1877f2" syncSierra={false} addLabel="+ Add Facebook" placeholder="https://facebook.com/…" />
              {(client.job_title || client.employer) && (
                <p><strong>Work:</strong> {[client.job_title, client.employer].filter(Boolean).join(' · ')}</p>
              )}
            </div>
            {client.avatar_url && (
              <img className="cp-avatar" src={client.avatar_url} alt="" referrerPolicy="no-referrer"
                onError={e => { e.currentTarget.style.display = 'none' }} />
            )}
          </div>
        </div>
      </div>
      <div className="cp-tags" style={{ marginTop: 8 }}><div className="cp-sub">Tags</div><TagEditor client={client} onSaved={onSaved} /></div>
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
    catch (e) { notify('Tag update failed: ' + e.message) } finally { setBusy(false) }
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
function Communications({ client, onOpenText, onAddNote }) {
  const cid = client.id
  const [rows, setRows] = useState(null)
  const [filter, setFilter] = useState('all')
  const [limit, setLimit] = useState(15)
  const [q, setQ] = useState('')
  const load = useCallback(() => authFetch('/api/inbox/thread/' + cid).then(r => r.json()).then(d => setRows(Array.isArray(d) ? d.slice().reverse() : [])).catch(() => setRows([])), [cid])
  useEffect(() => { load() }, [load])
  useEffect(() => { const h = () => load(); window.addEventListener('cp-comms-changed', h); return () => window.removeEventListener('cp-comms-changed', h) }, [load])
  // Notes live here now: the standalone Notes box merged into this tab strip.
  const noteLines = client.notes ? String(client.notes).split('\n').filter(Boolean) : []
  const FILTERS = [['all', 'All'], ['text', 'Texts'], ['call', 'Calls'], ['email', 'Emails'], ['note', noteLines.length ? `Notes (${noteLines.length})` : 'Notes']]
  let items = (rows || []).filter(m => m.channel !== 'note').filter(m => filter === 'all' ? true : m.channel === filter)
  if (q.trim()) { const t = q.toLowerCase(); items = items.filter(m => `${m.body || ''} ${m.preview || ''} ${m.subject || ''}`.toLowerCase().includes(t)) }
  const shown = items.slice(0, limit)
  let notes = noteLines
  if (q.trim()) { const t = q.toLowerCase(); notes = notes.filter(ln => ln.toLowerCase().includes(t)) }
  const shownNotes = notes.slice(0, limit)
  return (
    <Section title="Communications" id="comms"
      right={<div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{FILTERS.map(([k, l]) => <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => { setFilter(k); setLimit(15) }}>{l}</button>)}{filter === 'note'
        ? <button className="btn btn-sm btn-primary" onClick={onAddNote}>+ Add Note</button>
        : <button className="btn btn-sm btn-primary" onClick={onOpenText}>+ New</button>}</div>}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder={filter === 'note' ? 'Search notes…' : 'Search communications…'} style={{ width: '100%', padding: '6px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, marginBottom: 10 }} />
      {filter === 'note' ? (
        <>
          {!notes.length ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No notes yet.</div>
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>{shownNotes.map((ln, i) => {
              const m = ln.match(/^\[([^\]]+)\]\s*(.*)$/)
              return <div key={i} style={{ fontSize: 13, borderLeft: '3px solid #f59e0b', background: 'rgba(245,158,11,0.05)', padding: '5px 8px', borderRadius: '0 6px 6px 0' }}>{m && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{m[1]}</div>}<div style={{ whiteSpace: 'pre-wrap' }}>{m ? m[2] : ln}</div></div>
            })}</div>}
          {notes.length > shownNotes.length && <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setLimit(l => l + 25)}>Load more ({notes.length - shownNotes.length})</button>}
        </>
      ) : (
        <>
          {rows === null ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
            : shown.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Nothing here yet.</div>
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>{shown.map(m => <CommItem key={m.id} m={m} />)}</div>}
          {items.length > shown.length && <button className="btn btn-sm" style={{ marginTop: 10 }} onClick={() => setLimit(l => l + 25)}>Load more ({items.length - shown.length})</button>}
        </>
      )}
    </Section>
  )
}
// Tracked engagement chips + expandable event timeline for an outbound email.
// Opens are "tracked opens" (privacy proxies can inflate them) — soft signal; clicks stronger.
function EmailEngagement({ eng }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState(null)
  if (!eng) return null
  const chip = (label, color) => <span key={label} style={{ fontSize: 12, fontWeight: 700, color, border: `1px solid ${color}33`, background: `${color}14`, borderRadius: 10, padding: '1px 7px' }}>{label}</span>
  const chips = []
  if (['bounce', 'dropped', 'spamreport'].includes(eng.status)) chips.push(chip('⚠ ' + eng.status, '#ef4444'))
  else if (eng.delivered_at || eng.status === 'delivered') chips.push(chip('Delivered', '#059669'))
  if (eng.opens) chips.push(chip(`Opened ${eng.opens}×`, '#2563eb'))
  if (eng.clicks) chips.push(chip(`Clicked ${eng.clicks}×`, '#7c3aed'))
  if (!chips.length) chips.push(chip('No tracking data', '#6b7280'))
  const loadEvents = () => {
    setOpen(o => !o)
    if (!events) authFetch(`/api/email/engagement/${eng.email_id}/events`).then(r => r.json()).then(d => setEvents(Array.isArray(d) ? d : [])).catch(() => setEvents([]))
  }
  return (
    <div style={{ marginTop: 5 }}>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
        {chips}
        {eng.last_opened_at && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>last opened {fmtCommWhen(eng.last_opened_at)}</span>}
        {(eng.opens || eng.clicks) ? <button onClick={loadEvents} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: '#2563eb', padding: 0 }}>{open ? 'hide' : 'engagement ▾'}</button> : null}
      </div>
      {open && (
        <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text-secondary)', borderLeft: '2px solid var(--border)', paddingLeft: 8, overflowWrap: 'anywhere' }}>
          {events === null ? 'Loading…' : events.length === 0 ? 'No events.' : events.map((e, i) => (
            <div key={i}>{fmtCommWhen(e.occurred_at)} — {e.event_type}{e.url ? `: ${String(e.url).slice(0, 80)}` : ''}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function CommItem({ m }) {
  const meta = COMM_META[m.channel] || { icon: '•', label: m.channel, color: 'var(--text-muted)' }
  const out = m.direction === 'outgoing'
  const isCallish = m.channel === 'call' || m.channel === 'voicemail'
  const rawBody = m.body || m.preview || m.subject || ''
  const text = commToText(m.channel === 'email' && m.direction === 'incoming' ? stripQuotedDisplay(rawBody) : rawBody)
  const aiSent = /ai/i.test(m.sent_by_type || m.agent || '')
  // Texts render as chat bubbles like the Inbox — ours right/blue, theirs left/white — so a
  // back-and-forth reads at a glance. Emails/calls keep the card layout below.
  if (m.channel === 'text') {
    return (
      <div style={{ display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start' }}>
        <div style={{ maxWidth: '78%', minWidth: 110 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: out ? 'right' : 'left', margin: '0 4px 2px' }}>
            {out ? (aiSent ? '🤖 HUB AI' : 'You') : (m.contact_name || 'Them')}
            {!out && m.conversation_sid && m.from_addr ? ` · ${(() => { const d = String(m.from_addr).replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : m.from_addr })()}` : ''}
            {' · '}{fmtCommWhen(m.occurred_at)}
          </div>
          <div style={{ padding: '8px 12px', borderRadius: 12, background: out ? '#2563eb' : 'var(--bg-secondary)', color: out ? '#fff' : 'var(--text-primary)', border: out ? 'none' : '1px solid var(--border)', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.45, wordBreak: 'break-word' }}>
            {text || '📎 attachment'}
          </div>
        </div>
      </div>
    )
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${meta.color}`, borderRadius: 6, padding: '7px 10px', background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-muted)', marginBottom: 3 }}>
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
      {m.transcript && !m.call_summary && <div style={{ fontSize: 12, marginTop: 5, fontStyle: 'italic', color: 'var(--text-secondary)' }}>“{m.transcript}”</div>}
      {m.call_summary && (
        <details style={{ fontSize: 12.5, marginTop: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', background: 'var(--bg-secondary)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>📋 AI Call Summary</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5, margin: '6px 0 0', maxHeight: 320, overflowY: 'auto' }}>{m.call_summary}</pre>
        </details>
      )}
      {m.call_summary && m.transcript && (
        <details style={{ fontSize: 12.5, marginTop: 6, border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px', background: 'var(--bg-secondary)' }}>
          <summary style={{ cursor: 'pointer', fontWeight: 700 }}>💬 Transcript</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.5, margin: '6px 0 0', maxHeight: 320, overflowY: 'auto' }}>{m.transcript}</pre>
        </details>
      )}

      {m.channel === 'email' && out && <EmailEngagement eng={m.eng} />}
      {m.channel === 'email' && (
        <div style={{ marginTop: 6 }}>
          <button className="btn btn-sm" title="Reply to this email (opens the composer up top)"
            onClick={() => {
              const s = commToText(m.subject || '')
              window.dispatchEvent(new CustomEvent('cp-compose-email', { detail: { subject: s ? (/^re:/i.test(s) ? s : 'Re: ' + s) : '' } }))
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }}>↩ Reply</button>
        </div>
      )}
    </div>
  )
}

// ── Compact email composer (reuses /api/email/send + templates) ──────────
// The signature ({{signature}}) is pre-placed at the bottom so it's always there and can be
// moved anywhere. "Insert field" drops merge fields ({{first_name}}, {{city_of_interest}}, …)
// at the cursor, and Preview renders the final email — signature and fields filled in.
const DEFAULT_BODY = '\n\n{{signature}}'
function EmailComposer({ client, onClose, onSent, initial }) {
  // Which of the lead's saved addresses to send to (primary + any alt_emails).
  const clientEmails = [client.email, ...String(client.alt_emails || '').split(',')].map(e => String(e || '').trim()).filter(Boolean)
  const [toEmail, setToEmail] = useState('')
  const [subject, setSubject] = useState(initial?.subject || '')
  const [body, setBody] = useState(initial?.body ? String(initial.body).trimEnd() + DEFAULT_BODY : DEFAULT_BODY)
  const [templates, setTemplates] = useState([])
  const [fields, setFields] = useState([])
  const [sending, setSending] = useState(false)
  const [preview, setPreview] = useState(null)   // {subject, html} or null
  const [previewing, setPreviewing] = useState(false)
  // AI suggested reply — the SAME engine as the Inbox (thread-aware, cold-seller +
  // follow-up doctrine, angle picker). Collapsed until the user asks for it.
  const [aiOpen, setAiOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSug, setAiSug] = useState(null)       // { intent, summary, suggestion:{subject,body}, error }
  const [aiApproach, setAiApproach] = useState('')
  const [aiCtx, setAiCtx] = useState('')         // free-text context for the adjust flow (same as Inbox)
  const taRef = React.useRef(null)
  useEffect(() => {
    authFetch('/api/templates?type=email').then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {})
    authFetch('/api/email/merge-fields').then(r => r.json()).then(f => setFields(Array.isArray(f) ? f : [])).catch(() => {})
  }, [])
  const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  const withSig = (t) => /\{\{\s*signature\s*\}\}/i.test(t) ? t : t + DEFAULT_BODY
  // Insert a token at the caret (or replace the selection), keeping focus.
  const insertToken = (tok) => {
    const ta = taRef.current
    if (!ta) { setBody(b => b + tok); return }
    const s = ta.selectionStart ?? body.length, e = ta.selectionEnd ?? body.length
    const next = body.slice(0, s) + tok + body.slice(e)
    setBody(next)
    requestAnimationFrame(() => { ta.focus(); const p = s + tok.length; ta.setSelectionRange(p, p) })
  }
  const suggest = async (angle) => {
    const a = typeof angle === 'string' ? angle : aiApproach
    setAiBusy(true)
    try {
      const r = await authFetch(`/api/inbox/thread/${client.id}/ai/suggest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approach: a || '' }) })
      const d = await r.json()
      setAiSug(d && d.error ? { error: d.error } : d)
    } catch (e) { setAiSug({ error: e.message }) } finally { setAiBusy(false) }
  }
  const useSuggested = () => {
    const s = aiSug?.suggestion; if (!s) return
    if (s.subject) setSubject(s.subject)
    setBody(withSig(String(s.body || '').trimEnd()))
  }
  // Adjust the suggestion (tone buttons + free-text context) — same /ai/adjust flow as the Inbox.
  const adjustSuggestion = async (instruction, context) => {
    const current = aiSug?.suggestion || { subject, body: stripHtml(body).replace(/\{\{signature\}\}/g, '').trim() }
    setAiBusy(true)
    try {
      const r = await authFetch(`/api/inbox/thread/${client.id}/ai/adjust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: instruction || '', context: context || '', current }) })
      const d = await r.json()
      if (d.error) setAiSug(s => ({ ...(s || {}), error: d.error }))
      else if (d.reply) { setAiSug(s => ({ ...(s || {}), suggestion: d.reply, error: null })); if (context) setAiCtx('') }
    } catch (e) { setAiSug(s => ({ ...(s || {}), error: e.message })) } finally { setAiBusy(false) }
  }
  const doPreview = async () => {
    setPreviewing(true)
    try {
      const r = await authFetch('/api/email/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, subject, body: body.replace(/\n/g, '<br>') }) })
      setPreview(await r.json())
    } catch (e) { notify('Preview failed: ' + e.message) } finally { setPreviewing(false) }
  }
  const send = async () => {
    if (!stripHtml(body).trim()) return
    setSending(true)
    try {
      const r = await authFetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, to_email: toEmail || undefined, subject: subject || '(no subject)', body: body.replace(/\n/g, '<br>') }) })
      const d = await r.json().catch(() => ({}))
      if (r.ok && d.success !== false) { onSent && onSent(); onClose() } else notify('Email not sent: ' + (d.error || 'unknown'))
    } catch (e) { notify('Email failed: ' + e.message) } finally { setSending(false) }
  }
  const inputStyle = { width: '100%', padding: '7px 9px', marginBottom: 6, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary,#fff)', color: 'var(--text-primary)', fontSize: 13 }
  return (
    <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {clientEmails.length > 1 ? (
          <select value={toEmail || clientEmails[0]} onChange={e => setToEmail(e.target.value)} title="Which of this lead's email addresses to send to"
            style={{ fontSize: 12, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary,#fff)', color: 'var(--text-primary)' }}>
            {clientEmails.map((em, i) => <option key={em} value={em}>To: {em}{i === 0 ? ' (main)' : ''}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>To: {client.email}</span>
        )}
        <TemplatePicker templates={templates} onPick={t => { if (t.subject) setSubject(t.subject); setBody(withSig(stripHtml(t.body))) }} />
        <select value="" onChange={e => { if (e.target.value) { insertToken(e.target.value); e.target.value = '' } }}
          title="Insert a merge field at the cursor"
          style={{ fontSize: 12, padding: '4px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary,#fff)', color: 'var(--text-primary)' }}>
          <option value="">+ Insert field…</option>
          {fields.map(f => <option key={f.token} value={f.token}>{f.label}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 6 }}>
        <button className="btn btn-sm" style={{ color: '#7c3aed', borderColor: 'rgba(124,58,237,.4)' }}
          onClick={() => { const n = !aiOpen; setAiOpen(n); if (n && !aiSug && !aiBusy) suggest() }}>
          ✨ Suggested reply {aiOpen ? '▾' : '▸'}
        </button>
        {aiOpen && (
          <div style={{ marginTop: 6, border: '1px solid rgba(124,58,237,.35)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '.04em', color: 'var(--text-muted)' }}>ANGLE</span>
              {[['', 'Auto'], ['conversation', '💬 Continue conversation'], ['activity', '🌐 Website activity'], ['checkin', '👋 Soft check-in']].map(([k, l]) => (
                <button key={k || 'auto'} className="btn btn-sm" disabled={aiBusy}
                  style={aiApproach === k ? { background: '#7c3aed', color: '#fff', borderColor: '#7c3aed' } : {}}
                  title={k === 'conversation' ? 'Pick up naturally from what they last said or left open' : k === 'activity' ? 'Anchor on what they recently viewed on the website' : k === 'checkin' ? 'Warm, no-ask presence message: we are here when you are ready' : 'Let the AI pick the best angle'}
                  onClick={() => { setAiApproach(k); suggest(k) }}>{l}</button>
              ))}
            </div>
            {aiBusy && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reading the conversation…</div>}
            {aiSug?.error && <div style={{ fontSize: 12, color: '#ef4444' }}>{aiSug.error}</div>}
            {aiSug && aiSug.has_incoming === false && !aiBusy && !aiSug.error && (
              <div style={{ fontSize: 12, color: '#7c3aed', fontWeight: 600 }}>First outreach — they haven't written back yet, so this drafts an opener instead of a reply.</div>
            )}
            {aiSug?.summary && !aiBusy && <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', borderLeft: '2px solid rgba(124,58,237,.4)', paddingLeft: 8 }}>{aiSug.summary}</div>}
            {aiSug?.suggestion && !aiBusy && (aiSug.suggestion.body || aiSug.suggestion.subject) && (
              <>
                <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: 8, lineHeight: 1.45 }}>
                  {aiSug.suggestion.subject && <div style={{ fontWeight: 700, marginBottom: 4 }}>{aiSug.suggestion.subject}</div>}
                  {aiSug.suggestion.body}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button className="btn btn-sm btn-primary" onClick={useSuggested}>Use this</button>
                  <button className="btn btn-sm" disabled={aiBusy} onClick={() => suggest()}>↻ Regenerate</button>
                  {[['shorter', 'Shorter'], ['casual', 'More casual'], ['direct', 'More direct'], ['warmer', 'Warmer']].map(([k, l]) => (
                    <button key={k} className="btn btn-sm" disabled={aiBusy} onClick={() => adjustSuggestion(k)}>{l}</button>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={aiCtx} onChange={e => setAiCtx(e.target.value)}
                    placeholder="Add context for the AI (e.g. spoke on the phone yesterday, mention the open house)…"
                    onKeyDown={e => { if (e.key === 'Enter' && aiCtx.trim() && !aiBusy) adjustSuggestion('', aiCtx.trim()) }}
                    style={{ flex: 1, padding: '6px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 12.5 }} />
                  <button className="btn btn-sm" disabled={aiBusy || !aiCtx.trim()} onClick={() => adjustSuggestion('', aiCtx.trim())}>Apply</button>
                </div>
              </>
            )}
            {aiSug && !aiBusy && !aiSug.error && !(aiSug.suggestion && (aiSug.suggestion.body || aiSug.suggestion.subject)) && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No draft came back. Pick an angle above or hit an angle button again to retry.</div>
            )}
          </div>
        )}
      </div>
      <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" style={inputStyle} />
      <textarea ref={taRef} value={body} onChange={e => setBody(e.target.value)} rows={7} placeholder="Write your email…" style={{ width: '100%', padding: 9, fontSize: 13, lineHeight: 1.5, resize: 'vertical', fontFamily: 'inherit' }} />
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
        Fields like <code>{'{{first_name}}'}</code> and <code>{'{{signature}}'}</code> fill in automatically when the email is sent. Use Preview to see the final version for {client.first_name || 'this lead'}.
      </div>
      {preview && (
        <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 6, background: '#fff' }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', padding: '6px 9px', borderBottom: '1px solid var(--border)' }}>PREVIEW · Subject: {preview.subject || '(no subject)'}</div>
          <div style={{ padding: 12, color: '#0f172a', fontSize: 13, maxHeight: 320, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: preview.html || '' }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginTop: 6, justifyContent: 'flex-end' }}>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>Cancel</button>
        <button className="btn btn-secondary btn-sm" onClick={doPreview} disabled={previewing}>{previewing ? 'Loading…' : (preview ? 'Refresh Preview' : 'Preview')}</button>
        <button className="btn btn-primary btn-sm" onClick={send} disabled={sending || !stripHtml(body).trim()}>{sending ? 'Sending…' : 'Send Email'}</button>
      </div>
    </div>
  )
}

// Live days-on-market: today - List Date, always current. Falls back to the stored value.
function domLive(listDate, stored) {
  if (listDate) {
    const d = new Date(String(listDate).replace(' ', 'T'))
    if (!isNaN(d.getTime())) return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000))
  }
  return (stored != null && stored !== '') ? stored : null
}

// ── Property / Web activity ──────────────────────────────────────────────
function PropertyActivity({ client, onSaved }) {
  let listings = []
  try { listings = JSON.parse(client.fsbo_listings || '[]') } catch {}
  const hasFsbo = !!(client.fsbo_status || listings.length)
  const lastViewed = client.last_fub_activity_at ? new Date(String(client.last_fub_activity_at).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null
  if (!listings.length && !lastViewed && !client.fsbo_status) return null
  const removeFsbo = async () => {
    if (!await confirmDialog(`Remove the FSBO listing from ${client.first_name || 'this lead'}'s profile?\n\nUse this when the FSBO isn't really theirs (a phone number matched the wrong person). It clears the listing and stops the master-file sync from re-attaching it.`)) return
    try {
      const r = await authFetch('/api/clients/' + client.id + '/remove-fsbo', { method: 'POST' })
      if (r.ok) { onSaved && onSaved() } else notify('Could not remove FSBO.')
    } catch (e) { notify('Remove failed: ' + e.message) }
  }
  return (
    <Section title={client.type === 'seller' || listings.length ? 'Subject Property / Activity' : 'Property Activity'} id="propact"
      right={hasFsbo ? <button className="btn btn-sm btn-danger" onClick={removeFsbo} title="Not the owner? Remove this FSBO listing and stop it re-attaching.">Remove FSBO</button> : null}>
      {listings.map((l, i) => (
        <div key={i} style={{ fontSize: 13, marginBottom: 6 }}>
          <strong>{l.address || '—'}</strong> {l.status ? <span className="cp-badge">{l.status}</span> : null} {(() => { const dom = domLive(l.list_date, l.dom); return dom != null ? <span style={{ color: 'var(--text-muted)' }}>DOM {dom}</span> : null })()}
          {l.link && <> — <a href={l.link} target="_blank" rel="noopener noreferrer" style={{ color: '#006aff', fontWeight: 600 }}>View Listing ↗</a></>}
        </div>
      ))}
      {!listings.length && client.fsbo_status && <div style={{ fontSize: 13, marginBottom: 6 }}>FSBO status: <span className="cp-badge">{client.fsbo_status}</span></div>}
      {lastViewed && <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Last website activity: {lastViewed}{client.last_fub_activity_type ? ` · ${client.last_fub_activity_type}` : ''}</div>}
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

// ── Add Appointment (John, 2026-09-17): type + date/time + title + notes.
// Walkthrough auto-titles "Walkthrough - {address} - {name}"; notes always carry
// the Hub profile link; saving emails John + Matt a real calendar invite (ICS).
const APPT_TYPES = [['showing', 'Showing'], ['walkthrough', 'Walkthrough'], ['buyer_meeting', 'Buyer Meeting']]


// ── Seller Intent card (Fix It or Skip It, John 2026-09-19) ───────────────
// The Meta seller-ad answers, priority, exact campaign attribution and the
// contextual-sequence state — no digging through notes or raw webhook JSON.
function SellerIntentCard({ cid }) {
  const [d, setD] = useState(null)
  useEffect(() => { authFetch('/api/ai/seller-campaign/' + cid).then(r => r.ok ? r.json() : null).then(setD).catch(() => {}) }, [cid])
  if (!d) return null
  const PRI_COLOR = { 'PRIORITY 1': '#dc2626', 'PRIORITY 2': '#ea580c', 'PRIORITY 3': '#ca8a04', NURTURE: '#6b7280', EARLY: '#6b7280' }
  const sub = d.submissions?.[0]
  const L = ({ k, v }) => v ? <div style={{ display: 'flex', gap: 8, fontSize: 13, padding: '2px 0' }}><span style={{ color: 'var(--text-muted)', minWidth: 118 }}>{k}</span><span>{v}</span></div> : null
  return (
    <section className="cp-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14.5 }}>🏷 Seller Intent</h3>
        {d.priority && d.priority !== 'UNRANKED' && <span style={{ fontSize: 12, fontWeight: 800, color: PRI_COLOR[d.priority] || 'var(--text-muted)' }}>{d.priority}</span>}
      </div>
      <L k="Timeframe" v={d.seller_timeframe} />
      <L k="Considering" v={d.seller_improvement} />
      <L k="Walkthrough pref" v={d.seller_availability} />
      <L k="Property" v={sub?.property} />
      <L k="Campaign family" v={d.family} />
      <L k="Actual campaign" v={sub?.campaign_raw} />
      <L k="Submitted" v={sub ? String(sub.created_at).slice(0, 10) : null} />
      {d.sequence && <L k="Sequence" v={`${d.sequence.status}${d.sequence.status === 'active' ? ` — next text step ${d.sequence.next_step + 1}` : ''}`} />}
      {d.seller_availability && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, fontStyle: 'italic' }}>Scheduling tip: "You mentioned {d.seller_availability.toLowerCase()} usually work best — is there a day next week that's easiest?" (preference, not a confirmed time)</div>}
    </section>
  )
}

// ── Appointments card (scheduling system, John 2026-09-18) ────────────────
// Upcoming + past appointments from the scheduling engine, and a typed
// Schedule Appointment flow with REAL availability (same engine as the
// public booking pages). The old free-form calendar button stays for
// ad-hoc events.
function AppointmentsCard({ cid, client }) {
  const [rows, setRows] = useState(null)
  const [open, setOpen] = useState(false)
  const load = () => authFetch('/api/scheduling/client/' + cid + '/appointments').then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => setRows([]))
  useEffect(() => { load() }, [cid])
  const today = new Date().toISOString().slice(0, 10)
  const upcoming = (rows || []).filter(r => r.event_date >= today && ['scheduled', 'confirmed'].includes(r.appt_status || 'scheduled'))
  const past = (rows || []).filter(r => !upcoming.includes(r))
  const act = async (id, path, body) => {
    const r = await authFetch(`/api/scheduling/appointments/${id}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    const d = await r.json(); if (d.error) notify('⚠ ' + d.error); else load()
  }
  const STATUS_COLOR = { scheduled: '#3b82f6', confirmed: '#10b981', completed: '#059669', cancelled: '#ef4444', no_show: '#b45309' }
  const Row = ({ r }) => (
    <div style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
        <strong>{r.type_name || r.title}</strong>
        <span style={{ fontSize: 12, fontWeight: 700, color: STATUS_COLOR[r.appt_status] || 'var(--text-muted)' }}>{(r.appt_status || 'event').replace('_', '-')}</span>
      </div>
      <div style={{ color: 'var(--text-secondary)' }}>{r.when}{r.location ? ` · ${r.location}` : ''}{r.team_member ? ` · ${r.team_member}` : ''}</div>
      {['scheduled', 'confirmed'].includes(r.appt_status) && (
        <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
          <button className="btn-sm" onClick={() => act(r.id, 'status', { status: 'completed' })}>✓ Completed</button>
          <button className="btn-sm" onClick={() => act(r.id, 'status', { status: 'no_show' })}>No-show</button>
          <button className="btn-sm btn-danger" onClick={async () => { if (await confirmDialog('Cancel this appointment?\nThe lead keeps their record; reminders stop.')) act(r.id, 'cancel', {}) }}>Cancel</button>
        </div>
      )}
    </div>
  )
  return (
    <section className="cp-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h3 style={{ margin: 0, fontSize: 14.5 }}>📅 Appointments</h3>
        <button className="btn btn-sm btn-primary" onClick={() => setOpen(true)}>Schedule Appointment</button>
      </div>
      {rows === null ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div> : (
        <>
          {!rows.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No appointments yet — book one with Schedule Appointment.</div>}
          {upcoming.length > 0 && <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', margin: '6px 0 2px' }}>Upcoming</div>}
          {upcoming.map(r => <Row key={r.id} r={r} />)}
          {past.length > 0 && <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', margin: '10px 0 2px' }}>Previous</div>}
          {past.slice(0, 6).map(r => <Row key={r.id} r={r} />)}
        </>
      )}
      {open && <ScheduleTypedModal client={client} onClose={() => { setOpen(false); load() }} />}
    </section>
  )
}

function ScheduleTypedModal({ client, onClose }) {
  const [types, setTypes] = useState([])
  const [typeId, setTypeId] = useState(null)
  const [days, setDays] = useState([])
  const [date, setDate] = useState('')
  const [slots, setSlots] = useState([])
  const [time, setTime] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => { authFetch('/api/scheduling/types').then(r => r.json()).then(d => { const act = (d || []).filter(t => t.active); setTypes(act); if (act[0]) setTypeId(act[0].id) }).catch(() => {}) }, [])
  useEffect(() => { if (!typeId) return; setDays([]); setDate(''); setSlots([]); setTime(''); authFetch(`/api/scheduling/types/${typeId}/days`).then(r => r.json()).then(d => setDays(d.days || [])).catch(() => {}) }, [typeId])
  useEffect(() => { if (!date) return; setSlots([]); setTime(''); authFetch(`/api/scheduling/types/${typeId}/slots?date=${date}`).then(r => r.json()).then(d => setSlots(d.slots || [])).catch(() => {}) }, [date])
  const t12 = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}` }
  const save = async () => {
    setSaving(true)
    try {
      const r = await authFetch('/api/scheduling/appointments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type_id: typeId, client_id: client.id, date, time, notes }) })
      const d = await r.json()
      if (d.error) { notify('⚠ ' + d.error); return }
      notify('✓ Appointment booked — confirmations + team invite sent')
      onClose()
    } finally { setSaving(false) }
  }
  const inp = { padding: '7px 9px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, width: '100%', maxWidth: 480, maxHeight: '86vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>📅 Schedule — {`${client.first_name || ''} ${client.last_name || ''}`.trim()}</h3>
        <div style={{ display: 'grid', gap: 10 }}>
          <select style={inp} value={typeId || ''} onChange={e => setTypeId(Number(e.target.value))}>
            {types.map(t => <option key={t.id} value={t.id}>{t.name} ({t.duration_min} min)</option>)}
          </select>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {days.slice(0, 10).map(d => <button key={d} className={`btn btn-sm ${date === d ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDate(d)}>{new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</button>)}
            {!days.length && <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Finding open days…</span>}
          </div>
          {date && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {slots.map(sl => <button key={sl.time} className={`btn btn-sm ${time === sl.time ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTime(sl.time)}>{t12(sl.time)}</button>)}
              {!slots.length && <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading times…</span>}
            </div>
          )}
          <textarea style={{ ...inp, resize: 'vertical' }} rows={2} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (optional)" />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn btn-primary" disabled={saving || !date || !time} onClick={save}>{saving ? 'Booking…' : 'Book It'}</button>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function AppointmentModal({ client, onClose }) {
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  const address = [client.address, client.city].filter(Boolean).join(', ')
  const autoTitle = (t) => t === 'walkthrough' && address ? `Walkthrough - ${address} - ${name}`
    : `${(APPT_TYPES.find(x => x[0] === t) || [,'Appointment'])[1]} - ${name}`
  const [type, setType] = useState('showing')
  const [title, setTitle] = useState(autoTitle('showing'))
  const [edited, setEdited] = useState(false)
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [time, setTime] = useState('10:00')
  const [duration, setDuration] = useState(60)
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const pickType = (t) => { setType(t); if (!edited) setTitle(autoTitle(t)) }
  const save = async () => {
    setSaving(true); setMsg('')
    try {
      const r = await authFetch('/api/calendar/appointment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, type, title, date, time, duration_minutes: duration, notes }) })
      const d = await r.json()
      if (d.error) { setMsg('⚠ ' + d.error); return }
      setMsg('✓ Saved — calendar invite sent to John + Matt')
      setTimeout(onClose, 1400)
    } catch (e) { setMsg('⚠ ' + e.message) } finally { setSaving(false) }
  }
  const inp = { padding: '7px 9px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }} onClick={onClose}>
      <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 12, padding: 18, width: '100%', maxWidth: 460 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>📅 New Appointment — {name}</h3>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          {APPT_TYPES.map(([k, l]) => (
            <button key={k} className={`btn btn-sm ${type === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => pickType(k)}>{l}</button>
          ))}
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <input style={inp} value={title} onChange={e => { setTitle(e.target.value); setEdited(true) }} placeholder="Title" />
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...inp, flex: 1 }} type="date" value={date} onChange={e => setDate(e.target.value)} />
            <input style={{ ...inp, width: 110 }} type="time" value={time} onChange={e => setTime(e.target.value)} />
            <select style={inp} value={duration} onChange={e => setDuration(Number(e.target.value))}>
              <option value={30}>30 min</option><option value={60}>1 hour</option><option value={90}>1.5 hours</option><option value={120}>2 hours</option>
            </select>
          </div>
          <textarea style={{ ...inp, resize: 'vertical' }} rows={3} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes (their Hub profile link is included automatically)" />
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button className="btn btn-primary" disabled={saving || !title.trim()} onClick={save}>{saving ? 'Saving…' : 'Save + Send Invite'}</button>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          {msg && <span style={{ fontSize: 12.5, color: msg.startsWith('✓') ? '#10b981' : '#ef4444' }}>{msg}</span>}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar: AI intelligence + next best action ──────────────────────────
function AiIntelligence({ ai, followup, cid }) {
  const [full, setFull] = useState(false)
  const [enroll, setEnroll] = useState(null)
  const intent = ai?.intent?.score ?? ai?.intent ?? null
  const level = ai?.intent?.level
  const rec = followup && followup.exists !== false ? followup : null
  useEffect(() => { authFetch('/api/ai/enrollment/evaluate/' + cid).then(r => r.json()).then(setEnroll).catch(() => setEnroll(null)) }, [cid])
  const toggleExclude = async () => {
    const excluding = enroll?.reason_code !== 'MANUAL_EXCLUDE'
    if (excluding && !await confirmDialog('Exclude this lead from AI auto-enrollment? (You can still enable AI manually.)')) return
    await authFetch(`/api/ai/enrollment/${excluding ? 'exclude' : 'include'}/${cid}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
    authFetch('/api/ai/enrollment/evaluate/' + cid).then(r => r.json()).then(setEnroll).catch(() => {})
  }
  return (
    <Section title="AI Intelligence" id="ai" right={<button className="btn btn-sm" onClick={() => setFull(f => !f)}>{full ? 'Hide' : 'Open Full AI'}</button>}>
      <div style={{ fontSize: 13, lineHeight: 1.7 }}>
        <div><strong>Intent:</strong> {intent ?? '—'} {level ? `· ${String(level).toUpperCase()}` : ''}</div>
        <div><strong>AI:</strong> {ai?.ai_managed ? 'Managed' : 'Manual'}</div>
        {ai?.ai_state && <div><strong>State:</strong> {String(ai.ai_state).replace(/_/g, ' ').toLowerCase()}</div>}
        {enroll && enroll.decision && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <strong>Auto-enroll:</strong>
            <span style={{ color: enroll.decision === 'eligible' ? '#15803d' : enroll.decision === 'deferred' ? '#b45309' : 'var(--text-muted)' }}>
              {enroll.decision === 'eligible'
                ? `eligible · ${String(enroll.classification || '').replace(/_/g, ' ').toLowerCase()} · priority ${enroll.priority_score}`
                : `${enroll.decision} · ${enroll.reason || enroll.reason_code}`}
            </span>
            {!['ALREADY_ENROLLED', 'NOT_FOUND', 'MERGED'].includes(enroll.reason_code) && (
              <button className="btn btn-sm" style={{ fontSize: 12 }} onClick={toggleExclude}>
                {enroll.reason_code === 'MANUAL_EXCLUDE' ? 'Allow auto-enroll' : 'Exclude'}
              </button>
            )}
          </div>
        )}
      </div>
      {rec && (rec.recommended_action || rec.recommendation || rec.reason || rec.summary) && (
        <div style={{ marginTop: 8, padding: '8px 10px', background: 'rgba(124,58,237,.06)', border: '1px solid rgba(124,58,237,.25)', borderRadius: 8 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase' }}>Next Best Action</div>
          <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{rec.recommended_action || rec.recommendation?.label || rec.action || rec.title || 'Follow up'}</div>
          {(rec.reason || rec.recommendation?.rationale || rec.summary) && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3 }}>{rec.reason || rec.recommendation?.rationale || rec.summary}</div>}
        </div>
      )}
      {rec && rec.email && (rec.email.subject || rec.email.body) && (
        <div style={{ marginTop: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#7c3aed', textTransform: 'uppercase' }}>Suggested Email</div>
            <button className="btn btn-sm btn-primary" onClick={() => window.dispatchEvent(new CustomEvent('cp-compose-email', { detail: { subject: rec.email.subject || '', body: rec.email.body || '' } }))}>✉ Use in Email</button>
          </div>
          {rec.email.subject && <div style={{ fontSize: 12.5, fontWeight: 600, marginTop: 4 }}>{rec.email.subject}</div>}
          {rec.email.body && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 3, whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>{rec.email.body}</div>}
        </div>
      )}
      {full && <div style={{ marginTop: 10 }}><AiIsaCard clientId={cid} /></div>}
    </Section>
  )
}

// ── Sidebar: Tasks ───────────────────────────────────────────────────────
function TasksCard({ cid, name, address }) {
  const [tasks, setTasks] = useState(null)
  const [addOpen, setAddOpen] = useState(false)
  const reload = useCallback(() => authFetch(`/api/tasks?related_type=client&related_id=${cid}`).then(r => r.json()).then(d => setTasks(Array.isArray(d) ? d : [])).catch(() => setTasks([])), [cid])
  useEffect(() => { reload() }, [reload])
  // The Coverage card's "+ Follow-Up" button opens this add form directly.
  useEffect(() => { const h = () => setAddOpen(true); window.addEventListener('cp-open-task-add', h); return () => window.removeEventListener('cp-open-task-add', h) }, [])
  const today = new Date().toISOString().slice(0, 10)
  const open = (tasks || []).filter(t => t.status !== 'done')
  const overdue = open.filter(t => t.due_date && t.due_date < today)
  const upcoming = open.filter(t => !(t.due_date && t.due_date < today))
  const row = (t, bad) => <div key={t.id} style={{ fontSize: 13, display: 'flex', gap: 6, padding: '3px 0' }}><span>○</span><span style={{ flex: 1 }}>{t.title}</span>{t.due_date && <span style={{ fontSize: 12, color: bad ? '#ef4444' : 'var(--text-muted)' }}>{t.due_date}</span>}</div>
  return (
    <Section title={`Tasks${open.length ? ` (${open.length})` : ''}`} id="taskscard" right={<button className="btn btn-sm" onClick={() => setAddOpen(o => !o)}>+ Add</button>}>
      {addOpen && <QuickAddTask clientId={cid} clientName={name} clientAddress={address} onAdded={() => { reload(); setAddOpen(false) }} />}
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
  useEffect(() => { const h = () => reload(); window.addEventListener('cp-txns-changed', h); window.addEventListener('cp-tasks-changed', h); return () => { window.removeEventListener('cp-txns-changed', h); window.removeEventListener('cp-tasks-changed', h) } }, [reload])
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
// "Delay next…" — a preset dropdown (+N days) OR an exact date picker. Picking a date sets the
// next send to that day; presets push out from the current schedule.
function DelayMenu({ onDelayDays, onDelayUntil, disabled }) {
  const today = new Date().toISOString().slice(0, 10)
  const sel = { fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary,#fff)', color: 'var(--text-primary)' }
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <select disabled={disabled} value="" onChange={e => { if (e.target.value) { onDelayDays(Number(e.target.value)); e.target.value = '' } }} title="Delay by a preset" style={sel}>
        <option value="">⏱ Delay…</option>
        <option value="1">+1 day</option>
        <option value="3">+3 days</option>
        <option value="7">+1 week</option>
        <option value="14">+2 weeks</option>
        <option value="30">+1 month</option>
      </select>
      <input type="date" disabled={disabled} min={today} title="…or pick the exact next send date"
        onChange={e => { if (e.target.value) { onDelayUntil(e.target.value); e.target.value = '' } }}
        style={{ ...sel, padding: '2px 4px' }} />
    </span>
  )
}
const fmtPlanDate = (iso) => { if (!iso) return null; const d = new Date(String(iso).replace(' ', 'T')); return isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }

function ActionPlans({ cid }) {
  const [seq, setSeq] = useState(null)
  const [picker, setPicker] = useState(null)
  const [preview, setPreview] = useState(null)   // rendered {drip, subject, body}
  const [busyId, setBusyId] = useState(null)
  const reload = useCallback(() => authFetch(`/api/clients/${cid}/sequences`).then(r => r.json()).then(setSeq).catch(() => setSeq({ drips: [], automations: [] })), [cid])
  useEffect(() => { reload() }, [reload])
  const drips = seq?.drips || []; const autos = seq?.automations || []
  const call = async (kind, eid, action, body) => {
    setBusyId(eid)
    try {
      await authFetch(`/api/${kind === 'drip' ? 'drips' : 'automations'}/enrollments/${eid}/${action}`,
        { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
    } catch (e) { notify('Action failed: ' + e.message) } finally { setBusyId(null); reload() }
  }
  const remove = async (kind, eid) => { if (eid && await confirmDialog('Remove this action plan? The lead stops receiving it.')) call(kind, eid, 'remove') }
  const openPreview = async (e) => {
    try {
      const r = await authFetch(`/api/drips/${e.drip_id}/preview/${e.current_step || 0}/${cid}`).then(x => x.json())
      if (r.error) return notify(r.error)
      setPreview(r)
    } catch (err) { notify('Preview failed: ' + err.message) }
  }
  const pill = (label, on) => <span style={{ fontSize: 12, padding: '1px 7px', borderRadius: 10, background: on ? '#fef3c7' : '#dcfce7', color: on ? '#92400e' : '#166534' }}>{label}</span>
  const shell = { border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px', marginBottom: 6 }
  const dripRow = (e) => {
    const eid = e.enrollment_id, paused = e.status === 'paused', next = fmtPlanDate(e.next_run_at), busy = busyId === eid
    return (
      <div key={'d' + eid} style={shell}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>💧</span><span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{e.drip_name}</span>{pill(paused ? 'Paused' : 'Active', paused)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '5px 0 7px' }}>
          {e.next_step_subject
            ? <>Next: <button onClick={() => openPreview(e)} style={{ border: 'none', background: 'none', padding: 0, color: 'var(--primary,#2563eb)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }}>Email {e.next_step_number} of {e.total_steps}: {e.next_step_subject}</button></>
            : <>All {e.total_steps} emails sent</>}
          {next && <> · {paused ? 'was set for' : 'sends'} {next}</>}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {paused
            ? <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => call('drip', eid, 'resume')}>▶ Resume</button>
            : <button className="btn btn-sm" disabled={busy} onClick={() => call('drip', eid, 'pause')}>⏸ Pause</button>}
          {e.next_step_subject && <DelayMenu disabled={busy} onDelayDays={days => call('drip', eid, 'delay', { days })} onDelayUntil={until => call('drip', eid, 'delay', { until })} />}
          {e.next_step_subject && <button className="btn btn-sm" onClick={() => openPreview(e)}>📖 Read</button>}
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove('drip', eid)}>Remove</button>
        </div>
      </div>
    )
  }
  const autoRow = (e) => {
    const eid = e.enrollment_id, paused = e.status === 'paused', next = fmtPlanDate(e.next_run_at), busy = busyId === eid
    return (
      <div key={'a' + eid} style={shell}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>⚡</span><span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>{e.automation_name}</span>{pill(paused ? 'Paused' : (e.status === 'waiting' ? 'Waiting' : 'Active'), paused)}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', margin: '5px 0 7px' }}>{next ? `Next step ${paused ? 'was set for' : 'runs'} ${next}` : 'Running'}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {paused
            ? <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => call('automation', eid, 'resume')}>▶ Resume</button>
            : <button className="btn btn-sm" disabled={busy} onClick={() => call('automation', eid, 'pause')}>⏸ Pause</button>}
          <DelayMenu disabled={busy} onDelayDays={days => call('automation', eid, 'delay', { days })} onDelayUntil={until => call('automation', eid, 'delay', { until })} />
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => remove('automation', eid)}>Remove</button>
        </div>
      </div>
    )
  }
  return (
    <Section title="Action Plans" id="plans" right={<div style={{ display: 'flex', gap: 4 }}><button className="btn btn-sm" onClick={() => setPicker('drip')}>+ Drip</button><button className="btn btn-sm" onClick={() => setPicker('automation')}>+ Automation</button></div>}>
      {seq === null ? <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>…</div>
        : (!drips.length && !autos.length && !picker) ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Not enrolled in any plans.</div>
          : <>{drips.map(dripRow)}{autos.map(autoRow)}</>}
      {picker && <EnrollPicker kind={picker} cid={cid} onClose={() => setPicker(null)} onDone={() => { setPicker(null); reload() }} />}
      {preview && (
        <div onClick={() => setPreview(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, maxWidth: 640, width: '100%', maxHeight: '85vh', overflow: 'auto' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 13, color: '#0f172a' }}>{preview.drip} — Subject: {preview.subject || '(no subject)'}</strong>
              <button className="btn btn-sm" onClick={() => setPreview(null)}>Close</button>
            </div>
            <div style={{ padding: 16, fontSize: 13, color: '#0f172a' }} dangerouslySetInnerHTML={{ __html: preview.body || '' }} />
          </div>
        </div>
      )}
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
    if (r.error) return notify(r.error)
    if ((r.enrolled || 0) === 0) notify('Not enrolled — likely already in a drip, no email on file, or Do-Not-Contact.')
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

// ── Sierra activity / notes ──────────────────────────────────────────────
function SierraActivity({ client }) {
  const [rows, setRows] = useState(null); const [exp, setExp] = useState(false)
  useEffect(() => { if (!client.sierra_lead_id) { setRows([]); return } authFetch(`/api/sierra/lead-notes/${client.sierra_lead_id}`).then(r => r.json()).then(a => setRows(Array.isArray(a) ? a.slice().sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0)) : [])).catch(() => setRows([])) }, [client.sierra_lead_id])
  if (!client.sierra_lead_id) return null
  return (
    <Section title={`Sierra Activity${rows ? ` (${rows.length})` : ''}`} id="sierra">
      {rows === null ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading…</div>
        : !rows.length ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No Sierra activity.</div>
          : <><div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: exp ? 340 : 'none', overflowY: exp ? 'auto' : 'visible' }}>
            {rows.slice(0, exp ? 60 : 5).map((a, i) => (
              <div key={a.id || i} style={{ fontSize: 12.5, borderLeft: '3px solid var(--border)', paddingLeft: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: 12 }}><span>{a.author || 'Sierra System'}</span><span>{a.date ? new Date(a.date).toLocaleDateString() : ''}</span></div>
                <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-primary)' }}>{a.contents}</div>
              </div>))}
          </div>{rows.length > 5 && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setExp(v => !v)}>{exp ? 'Show less' : `View all (${rows.length})`}</button>}</>}
    </Section>
  )
}
// ── Follow Up Boss activity ──────────────────────────────────────────────
function FubActivity({ cid }) {
  const [rows, setRows] = useState(null); const [exp, setExp] = useState(false)
  useEffect(() => { authFetch(`/api/fub/activity/live?client_id=${cid}`).then(r => r.json()).then(d => { const arr = Array.isArray(d) ? d : (Array.isArray(d?.rows) ? d.rows : []); setRows(arr.slice().sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0))) }).catch(() => setRows([])) }, [cid])
  if (rows && !rows.length) return null
  const pv = (rows || []).filter(a => a.prop_street).length
  return (
    <Section title={`Follow Up Boss Activity${rows ? ` (${rows.length}${pv ? ` · ${pv} property views` : ''})` : ''}`} id="fub">
      {rows === null ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading…</div>
        : <><div style={{ display: 'flex', flexDirection: 'column', maxHeight: exp ? 340 : 'none', overflowY: exp ? 'auto' : 'visible', border: '1px solid var(--border)', borderRadius: 6 }}>
          {rows.slice(0, exp ? 150 : 5).map((a, i) => {
            const when = a.occurred_at ? new Date(a.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
            const addr = a.prop_street ? `${a.prop_street}, ${a.prop_city || ''} ${a.prop_state || ''}`.trim() : ''
            return (<div key={a.id || i} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><span style={{ fontWeight: 600 }}>{a.type}</span><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{when}</span></div>
              {addr && <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 }}>{addr}{a.prop_mls ? ` · MLS ${a.prop_mls}` : ''}{a.prop_price ? ` · $${Number(a.prop_price).toLocaleString()}` : ''}</div>}
              {!addr && a.page_title && <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 }}>{a.page_title}</div>}
            </div>)
          })}
        </div>{rows.length > 5 && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setExp(v => !v)}>{exp ? 'Show less' : `View all (${rows.length})`}</button>}</>}
    </Section>
  )
}
// ── Website (Hub pixel) activity ─────────────────────────────────────────
function WebsiteActivity({ cid }) {
  const [data, setData] = useState(null); const [exp, setExp] = useState(false)
  useEffect(() => { authFetch(`/api/track/activity/${cid}?limit=50`).then(r => r.json()).then(setData).catch(() => setData({ summary: { total_events: 0 }, events: [] })) }, [cid])
  const sum = data?.summary; const events = data?.events || []
  if (data && (!sum || !sum.total_events)) return null
  return (
    <Section title={`Website Activity${sum ? ` (${sum.total_events} events)` : ''}`} id="website">
      {data === null ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading…</div>
        : <>
          <div style={{ display: 'flex', gap: 14, marginBottom: 8, fontSize: 12 }}>
            <div><div style={{ fontSize: 17, fontWeight: 700 }}>{sum.pageviews || 0}</div><span style={{ color: 'var(--text-muted)' }}>page views</span></div>
            <div><div style={{ fontSize: 17, fontWeight: 700, color: '#3b82f6' }}>{sum.listing_views || 0}</div><span style={{ color: 'var(--text-muted)' }}>listings</span></div>
            <div><div style={{ fontSize: 17, fontWeight: 700, color: '#f59e0b' }}>{sum.saves || 0}</div><span style={{ color: 'var(--text-muted)' }}>saves</span></div>
            <div><div style={{ fontSize: 17, fontWeight: 700 }}>{Math.round((sum.total_seconds || 0) / 60)}m</div><span style={{ color: 'var(--text-muted)' }}>on site</span></div>
          </div>
          <div style={{ maxHeight: exp ? 300 : 'none', overflowY: exp ? 'auto' : 'visible', border: '1px solid var(--border)', borderRadius: 6 }}>
            {events.slice(0, exp ? 50 : 5).map(e => {
              const label = { pageview: '👁 page view', listing_view: '🏠 listing view', save: '⭐ saved', pageduration: '⏱ time' }[e.event_type] || e.event_type
              return (<div key={e.id} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ fontWeight: 600 }}>{label}{e.listing_mls ? ` · MLS ${e.listing_mls}` : ''}</span><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{e.created_at ? new Date(e.created_at).toLocaleString() : ''}</span></div>
                {e.page_title && <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginTop: 2 }}>{e.page_title}</div>}
              </div>)
            })}
          </div>
          {events.length > 5 && <button className="btn btn-sm" style={{ marginTop: 8 }} onClick={() => setExp(v => !v)}>{exp ? 'Show less' : `View all (${events.length})`}</button>}
        </>}
    </Section>
  )
}
// ── Listing interest (Sierra saved searches / properties) ────────────────
function ListingInterest({ client }) {
  const [d, setD] = useState(null)
  useEffect(() => { if (!client.sierra_lead_id) { setD({}); return } authFetch(`/api/sierra/lead-listings/${client.sierra_lead_id}`).then(r => r.json()).then(setD).catch(() => setD({})) }, [client.sierra_lead_id])
  if (!client.sierra_lead_id) return null
  const ss = d?.saved_searches || [], sl = d?.saved_listings || [], la = d?.listing_activity || []
  if (d && !ss.length && !sl.length && !la.length) return null
  const addrOf = (x) => x.address || x.street || [x.prop_street, x.prop_city].filter(Boolean).join(', ') || x.name || 'Listing'
  return (
    <Section title="Listing Interest" id="interest">
      {d === null ? <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Loading…</div> : <>
        {ss.length > 0 && <div style={{ marginBottom: 8 }}><div className="cp-sub">Saved searches ({ss.length})</div>{ss.slice(0, 4).map((s, i) => <div key={i} style={{ fontSize: 12.5 }}>{s.name || s.criteria || s.summary || [s.city, s.min_price && `$${Number(s.min_price).toLocaleString()}+`].filter(Boolean).join(' · ') || 'Search'}</div>)}</div>}
        {sl.length > 0 && <div style={{ marginBottom: 8 }}><div className="cp-sub">⭐ Saved properties ({sl.length})</div>{sl.slice(0, 6).map((l, i) => <div key={i} style={{ fontSize: 12.5 }}>{addrOf(l)}{l.price ? ` · $${Number(l.price).toLocaleString()}` : ''}</div>)}</div>}
        {la.length > 0 && <div><div className="cp-sub">🏠 Listing activity ({la.length})</div>{la.slice(0, 6).map((a, i) => <div key={i} style={{ fontSize: 12.5 }}>{addrOf(a)}<span style={{ color: 'var(--text-muted)' }}>{a.date ? ` · ${new Date(a.date).toLocaleDateString()}` : ''}</span></div>)}</div>}
      </>}
    </Section>
  )
}

// ── Draggable section layout (rearrange boxes; persists globally for all leads) ──────────
// 'notes' is gone as a standalone box (2026-09-11): notes live inside the Communications tab
// strip now, so loadLayout silently drops it from any saved layout.
const DEFAULT_LAYOUT = { left: ['details', 'bsprofile', 'comms', 'propact', 'interest', 'website', 'fub', 'sierra', 'activity'], right: ['sellerintent', 'coverage', 'appts', 'cxcamp', 'fsbocamp', 'ai', 'plans', 'tasks', 'txns'] }
// Client Details is locked: always the first box in the left column, never draggable —
// an accidental drag can't move it out of place.
export function lockDetailsFirst(l) {
  // Client Details is always first and Communications always second in the left
  // column (John, 2026-09-21: comms kept getting dragged out of place by
  // accident) — both are pinned and excluded from drag entirely.
  const left = ['details', 'comms', ...l.left.filter(k => k !== 'details' && k !== 'comms')]
  return { left, right: l.right.filter(k => k !== 'details' && k !== 'comms') }
}
export function loadLayout() {
  try {
    const s = JSON.parse(localStorage.getItem('cp_layout_v2') || 'null')
    if (s && Array.isArray(s.left) && Array.isArray(s.right)) {
      const all = [...DEFAULT_LAYOUT.left, ...DEFAULT_LAYOUT.right]
      const have = new Set([...s.left, ...s.right])
      const left = [...s.left.filter(k => all.includes(k)), ...DEFAULT_LAYOUT.left.filter(k => !have.has(k))]
      const right = [...s.right.filter(k => all.includes(k)), ...DEFAULT_LAYOUT.right.filter(k => !have.has(k))]
      return lockDetailsFirst({ left, right })
    }
  } catch {}
  return DEFAULT_LAYOUT
}
export function saveLayout(l) { try { localStorage.setItem('cp_layout_v2', JSON.stringify(l)) } catch {} }

// ── Follow-Up Coverage card ──────────────────────────────────────────────
// One glance answers: "if we do nothing manually, will this person hear from
// us again — and soon enough?" Same evaluator as the Dashboard KPI and smart
// lists (server/followup-coverage.js) — never a separate definition.
const COV_META = {
  protected: { label: '✓ PROTECTED', color: '#059669' },
  at_risk: { label: '⚠ AT RISK', color: '#d97706' },
  unprotected: { label: '⚠ UNPROTECTED', color: '#dc2626' },
  snoozed: { label: '⏸ SNOOZED', color: '#7c3aed' },
  excluded: { label: '— EXCLUDED', color: 'var(--text-muted)' },
}
function CoverageCard({ cid, client, onChanged }) {
  const [cov, setCov] = useState(null)
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [snoozeDate, setSnoozeDate] = useState('')
  const [snoozeWhy, setSnoozeWhy] = useState('')
  const [busy, setBusy] = useState(false)
  const loadCov = useCallback(() => authFetch('/api/coverage/' + cid).then(r => r.json()).then(setCov).catch(() => setCov(null)), [cid])
  useEffect(() => { loadCov() }, [loadCov])
  useEffect(() => { const h = () => loadCov(); window.addEventListener('cp-comms-changed', h); return () => window.removeEventListener('cp-comms-changed', h) }, [loadCov])
  const act = async (path, body) => {
    setBusy(true)
    try {
      const r = await authFetch(`/api/coverage/${cid}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      const d = await r.json()
      if (!r.ok) { notify(d.error || 'Failed'); return }
      if (d.coverage) setCov(d.coverage); else loadCov()
      setSnoozeOpen(false); setSnoozeDate(''); setSnoozeWhy('')
      onChanged && onChanged()
    } catch (e) { notify(e.message) } finally { setBusy(false) }
  }
  const meta = cov ? (COV_META[cov.coverage_status] || COV_META.excluded) : null
  const fmtD = (v) => v ? new Date(String(v).includes('T') ? v : v.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' }) : null
  const nextLabel = cov && cov.next_action_at
    ? `${{ human_task: 'Task', ai: 'AI follow-up', drip: 'Nurture', transaction: 'Transaction' }[cov.next_action_type] || cov.next_action_type} · ${fmtD(cov.next_action_at)}${cov.next_action_label ? ` — ${String(cov.next_action_label).slice(0, 40)}` : ''}`
    : cov && cov.coverage_type === 'transaction' ? 'Active transaction' : null
  const openTaskAdd = () => { window.dispatchEvent(new CustomEvent('cp-open-task-add')); document.getElementById('taskscard')?.scrollIntoView({ behavior: 'smooth' }) }
  return (
    <Section title="Follow-Up Coverage" id="coverage">
      {!cov ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Evaluating…</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: meta.color }}>{meta.label}</div>
          <div style={{ fontSize: 12.5, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 10px' }}>
            <span style={{ color: 'var(--text-muted)' }}>Relationship</span><span style={{ textTransform: 'capitalize' }}>{String(cov.relationship_level || '').replace(/_/g, ' ')}</span>
            <span style={{ color: 'var(--text-muted)' }}>Last real contact</span>
            <span>{cov.days_since_meaningful_contact != null ? `${cov.days_since_meaningful_contact} days ago` : 'never'}{cov.max_allowed_silence_days ? ` (limit ${cov.max_allowed_silence_days}d)` : ''}</span>
            <span style={{ color: 'var(--text-muted)' }}>Next action</span><span style={{ color: nextLabel ? 'inherit' : '#dc2626', fontWeight: nextLabel ? 500 : 700 }}>{nextLabel || (cov.coverage_status === 'snoozed' ? `Wakes ${fmtD(cov.snooze_until)}` : 'None scheduled')}</span>
            {cov.next_action_owner && <><span style={{ color: 'var(--text-muted)' }}>Owner</span><span>{cov.next_action_owner}</span></>}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>{cov.reason}</div>
          {cov.recommended_action && <div style={{ fontSize: 12.5, fontWeight: 600, color: meta.color }}>Recommended: {cov.recommended_action}</div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-primary" onClick={openTaskAdd}>+ Follow-Up</button>
            {cov.coverage_status !== 'snoozed'
              ? <button className="btn btn-sm" disabled={busy} onClick={() => setSnoozeOpen(o => !o)}>⏸ Snooze</button>
              : <button className="btn btn-sm" disabled={busy} onClick={() => act('unsnooze')}>Wake now</button>}
            {!client.exclude_reason
              ? <button className="btn btn-sm" disabled={busy} style={{ color: 'var(--text-muted)' }}
                  onClick={() => { const why = prompt('Exclude from follow-up — reason (required, tracked):'); if (why && why.trim()) act('exclude', { reason: why.trim() }) }}>Exclude…</button>
              : <button className="btn btn-sm" disabled={busy} onClick={() => act('unexclude')}>Remove exclusion</button>}
          </div>
          {snoozeOpen && (
            <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, flexDirection: 'row', display: 'flex', alignItems: 'center', gap: 6 }}>Until
                <input type="date" value={snoozeDate} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} onChange={e => setSnoozeDate(e.target.value)} style={{ padding: '3px 6px' }} />
              </label>
              <input placeholder="Reason (e.g. reconnect after the holidays, lease ends in March)" value={snoozeWhy} onChange={e => setSnoozeWhy(e.target.value)} style={{ padding: '5px 8px', fontSize: 12.5 }} />
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-sm btn-primary" disabled={busy || !snoozeDate} onClick={() => act('snooze', { until: snoozeDate, reason: snoozeWhy })}>Snooze</button>
                <button className="btn btn-sm" onClick={() => setSnoozeOpen(false)}>Cancel</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>When the date arrives the lead wakes up, re-evaluates, and surfaces in Needs Attention until covered again.</div>
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

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
