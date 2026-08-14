import React, { useState, useEffect, useMemo } from 'react'
import { authFetch } from '../api'
import WhatsNew from './WhatsNew'
import { MERGE_FIELDS } from '../components/RichTextEditor'

// =====================================================
// CUSTOM FIELDS — auto-generated reference of every email merge field.
// Reads the single MERGE_FIELDS source, so anything added there appears here.
// =====================================================
function CustomFields() {
  const [copied, setCopied] = useState('')
  const copy = (t) => { try { navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(''), 1200) } catch {} }
  return (
    <div>
      <div className="sierra-banner info" style={{ marginBottom: 14 }}>
        These are the personalization fields you can drop into any email (the <strong>+ Field</strong> menu in the composer inserts them).
        They fill in per recipient on send. This list is generated automatically — every field the Hub supports appears here with what it pulls and where it comes from.
      </div>
      <div className="table-container">
        <table className="data-table">
          <thead><tr><th style={{ width: 200 }}>Field</th><th style={{ width: 170 }}>Name</th><th>What it inserts</th><th style={{ width: 120 }}>Source</th></tr></thead>
          <tbody>
            {MERGE_FIELDS.map(([tok, label, desc, source]) => (
              <tr key={tok}>
                <td>
                  <code style={{ fontSize: 12.5, cursor: 'pointer' }} title="Click to copy" onClick={() => copy(tok)}>{tok}</code>
                  {copied === tok && <span style={{ fontSize: 11, color: 'var(--accent, #2563eb)', marginLeft: 6 }}>copied</span>}
                </td>
                <td style={{ fontWeight: 600 }}>{label}</td>
                <td style={{ fontSize: 13 }}>{desc || ''}</td>
                <td><span className="email-status-tag">{source || 'System'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
        {MERGE_FIELDS.length} fields · Transaction/closing emails also have deal-specific fields ({'{{closing_date}}'}, {'{{earnest_money}}'}, {'{{lender_name}}'}, etc.) that live in the transaction templates.
      </p>
    </div>
  )
}

// =====================================================
// HUB UPDATES (development changelog from git history)
// =====================================================
const CATEGORY_META = {
  feature:     { icon: '✨', label: 'Feature',     color: '#10b981' },
  improvement: { icon: '🔧', label: 'Improvement', color: '#3b82f6' },
  fix:         { icon: '🐛', label: 'Fix',         color: '#f59e0b' },
  refactor:    { icon: '♻️', label: 'Refactor',    color: '#a855f7' },
  schema:      { icon: '🗄', label: 'Schema',      color: '#ec4899' },
  removal:     { icon: '🗑', label: 'Removal',     color: '#6b7280' },
  docs:        { icon: '📝', label: 'Docs',        color: '#06b6d4' },
  other:       { icon: '•',  label: 'Other',       color: '#9ca3af' },
}

function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}
function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString()
}

function HubUpdates() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState(new Set())

  useEffect(() => {
    fetch('/changelog.json')
      .then(r => r.ok ? r.json() : { entries: [] })
      .then(d => { setData(d); setLoading(false) })
      .catch(() => { setData({ entries: [] }); setLoading(false) })
  }, [])

  const entries = data?.entries || []
  const filtered = useMemo(() => {
    return entries.filter(e => {
      if (filter && e.category !== filter) return false
      if (search) {
        const t = search.toLowerCase()
        if (!(e.subject + ' ' + e.body).toLowerCase().includes(t)) return false
      }
      return true
    })
  }, [entries, filter, search])

  // Group by day
  const grouped = useMemo(() => {
    const groups = {}
    for (const e of filtered) {
      if (!e.date) continue
      const key = fmtDate(e.date)
      if (!groups[key]) groups[key] = []
      groups[key].push(e)
    }
    return groups
  }, [filtered])

  const counts = useMemo(() => {
    const c = {}
    for (const e of entries) c[e.category] = (c[e.category] || 0) + 1
    return c
  }, [entries])

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  if (loading) return <div className="page-loading">Loading hub updates...</div>

  return (
    <div>
      <div className="toolbar" style={{flexWrap: 'wrap'}}>
        <input
          type="text"
          placeholder="Search updates..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="search-input"
        />
        <select value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="">All categories</option>
          {Object.entries(CATEGORY_META).map(([k, m]) => (
            <option key={k} value={k}>
              {m.icon} {m.label} ({counts[k] || 0})
            </option>
          ))}
        </select>
      </div>

      <div className="muted" style={{margin: '8px 0 14px', fontSize: 12}}>
        {entries.length} total updates
        {data?.generated_at && ` · last updated ${new Date(data.generated_at).toLocaleString()}`}
        {' · '}showing {filtered.length}
      </div>

      {Object.keys(grouped).length === 0 ? (
        <div className="empty-state-full">No updates match the current filters.</div>
      ) : Object.entries(grouped).map(([day, items]) => (
        <div key={day} className="updates-day">
          <h3 className="updates-day-header">{day}</h3>
          <div className="updates-feed">
            {items.map(e => {
              const meta = CATEGORY_META[e.category] || CATEGORY_META.other
              const isExpanded = expanded.has(e.hash)
              const hasBody = e.body && e.body.length > 0
              return (
                <div key={e.hash} className="updates-row" onClick={() => hasBody && toggle(e.hash)} style={{cursor: hasBody ? 'pointer' : 'default'}}>
                  <div className="updates-icon" style={{color: meta.color, borderColor: meta.color + '50', background: meta.color + '15'}}>
                    {meta.icon}
                  </div>
                  <div className="updates-content">
                    <div className="updates-line">
                      <span className="updates-entity-badge" style={{background: meta.color + '20', color: meta.color}}>
                        {meta.label}
                      </span>
                      <span className="updates-time" title={fmtTime(e.date)}>
                        {new Date(e.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    <div className="updates-action" style={{marginTop: 2}}>{e.subject}</div>
                    {hasBody && isExpanded && (
                      <div className="updates-details" style={{marginTop: 8, padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, whiteSpace: 'pre-wrap'}}>
                        {e.body}
                      </div>
                    )}
                    {hasBody && !isExpanded && (
                      <div className="muted" style={{fontSize: 11, marginTop: 2}}>Click to expand details</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// =====================================================
// ACTIVITY LOG (business actions from activity_log table)
// =====================================================
const ACTION_ICONS = {
  created: '✨', updated: '✎', deleted: '🗑', synced: '↻', refreshed: '↻',
  email_sent: '✉', generated: '🪄', extracted_pdf: '📄', extracted_url: '🔗',
  auto_populated: '🌐', webhook: '🔔', seeded: '🌱', note_added: '📝',
  batch_refresh: '↻',
}
const ENTITY_LABELS = {
  client: 'Client', transaction: 'Transaction', pre_listing: 'Pre-Listing',
  listing: 'Listing', task: 'Task', project: 'Project', note: 'Note',
  vendor: 'Vendor', partner: 'Partner', social_post: 'Social Post',
  marketing: 'Marketing', showing: 'Showing', calendar: 'Calendar',
  sierra: 'Sierra',
}
const ENTITY_COLORS = {
  client: '#3b82f6', transaction: '#10b981', pre_listing: '#a855f7',
  listing: '#c89b4a', task: '#f59e0b', project: '#8b5cf6', note: '#6b7280',
  vendor: '#06b6d4', partner: '#ec4899', social_post: '#f43f5e',
  marketing: '#ef4444', sierra: '#7c3aed',
}

function fmtAgo(ts) {
  if (!ts) return ''
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
  const mins = Math.floor((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  return d.toLocaleDateString()
}

function ActivityLog() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [filters, setFilters] = useState({ entity_type: '', action: '', search: '', since: '' })
  const [filterOptions, setFilterOptions] = useState({ entity_types: [], actions: [] })
  const [pageSize, setPageSize] = useState(100)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    authFetch('/api/activity/filters').then(r => r.json()).then(setFilterOptions).catch(() => {})
  }, [])
  useEffect(() => {
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) })
    if (filters.entity_type) params.set('entity_type', filters.entity_type)
    if (filters.action) params.set('action', filters.action)
    if (filters.search) params.set('search', filters.search)
    if (filters.since) params.set('since', filters.since)
    authFetch('/api/activity?' + params)
      .then(r => r.json())
      .then(d => { setItems(d.rows || []); setTotal(d.total || 0) })
  }, [pageSize, offset, filters])

  const grouped = useMemo(() => {
    const groups = {}
    for (const item of items) {
      if (!item.created_at) continue
      const d = new Date(item.created_at.includes('T') ? item.created_at : item.created_at.replace(' ', 'T') + 'Z')
      const key = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
      if (!groups[key]) groups[key] = []
      groups[key].push(item)
    }
    return groups
  }, [items])

  const setFilter = (k, v) => { setFilters(prev => ({ ...prev, [k]: v })); setOffset(0) }

  return (
    <div>
      <div className="toolbar">
        <input
          type="text"
          placeholder="Search activity..."
          value={filters.search}
          onChange={e => setFilter('search', e.target.value)}
          className="search-input"
        />
        <select value={filters.entity_type} onChange={e => setFilter('entity_type', e.target.value)}>
          <option value="">All Types</option>
          {filterOptions.entity_types.map(t => <option key={t} value={t}>{ENTITY_LABELS[t] || t}</option>)}
        </select>
        <select value={filters.action} onChange={e => setFilter('action', e.target.value)}>
          <option value="">All Actions</option>
          {filterOptions.actions.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={filters.since} onChange={e => setFilter('since', e.target.value)}>
          <option value="">All time</option>
          <option value={new Date(Date.now() - 60 * 60 * 1000).toISOString()}>Last hour</option>
          <option value={new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}>Last 24 hours</option>
          <option value={new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}>Last 7 days</option>
          <option value={new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}>Last 30 days</option>
        </select>
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={250}>250</option>
          <option value={500}>500</option>
        </select>
      </div>

      <div className="muted" style={{margin: '8px 0 14px', fontSize: 12}}>
        {items.length} of {total.toLocaleString()} entries
      </div>

      {Object.keys(grouped).length === 0 ? (
        <div className="empty-state-full">No activity matches the current filters.</div>
      ) : Object.entries(grouped).map(([day, entries]) => (
        <div key={day} className="updates-day">
          <h3 className="updates-day-header">{day}</h3>
          <div className="updates-feed">
            {entries.map(e => {
              const color = ENTITY_COLORS[e.entity_type] || '#6b7280'
              const icon = ACTION_ICONS[e.action] || '•'
              return (
                <div key={e.id} className="updates-row">
                  <div className="updates-icon" style={{color, borderColor: color + '50', background: color + '15'}}>
                    {icon}
                  </div>
                  <div className="updates-content">
                    <div className="updates-line">
                      <span className="updates-action">{(e.action || '').replace(/_/g, ' ')}</span>
                      {e.entity_type && (
                        <span className="updates-entity-badge" style={{background: color + '20', color}}>
                          {ENTITY_LABELS[e.entity_type] || e.entity_type}
                        </span>
                      )}
                      <span className="updates-time">{fmtAgo(e.created_at)}</span>
                    </div>
                    {e.details && <div className="updates-details">{e.details}</div>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {items.length === pageSize && offset + pageSize < total && (
        <div style={{textAlign: 'center', marginTop: 20}}>
          <button className="btn btn-secondary" onClick={() => setOffset(prev => prev + pageSize)}>
            Load More
          </button>
        </div>
      )}
    </div>
  )
}

// =====================================================
// EMAIL LOG (full history of all email sends — success + failed)
// =====================================================
function EmailLog() {
  const [rows, setRows] = useState([])
  const [total, setTotal] = useState(0)
  const [sentCount, setSentCount] = useState(0)
  const [failedCount, setFailedCount] = useState(0)
  const [filters, setFilters] = useState({ search: '', status: '', since: '' })
  const [pageSize, setPageSize] = useState(100)
  const [offset, setOffset] = useState(0)
  const [openRow, setOpenRow] = useState(null)
  const [loading, setLoading] = useState(false)

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) })
    if (filters.search) params.set('search', filters.search)
    if (filters.status) params.set('status', filters.status)
    if (filters.since) params.set('since', filters.since)
    authFetch('/api/email/log?' + params)
      .then(r => r.json())
      .then(d => {
        setRows(d.rows || [])
        setTotal(d.total || 0)
        setSentCount(d.sent || 0)
        setFailedCount(d.failed || 0)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [pageSize, offset, filters])

  const setFilter = (k, v) => { setFilters(prev => ({ ...prev, [k]: v })); setOffset(0) }

  const openDetail = async (id) => {
    const r = await authFetch(`/api/email/log/${id}`).then(r => r.json())
    setOpenRow(r)
  }

  return (
    <div>
      <div className="toolbar">
        <input
          type="text"
          placeholder="Search by recipient, subject, or error..."
          value={filters.search}
          onChange={e => setFilter('search', e.target.value)}
          className="search-input"
        />
        <select value={filters.status} onChange={e => setFilter('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="sent">✓ Sent only</option>
          <option value="failed">✗ Failed only</option>
        </select>
        <select value={filters.since} onChange={e => setFilter('since', e.target.value)}>
          <option value="">All time</option>
          <option value={new Date(Date.now() - 60 * 60 * 1000).toISOString()}>Last hour</option>
          <option value={new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}>Last 24 hours</option>
          <option value={new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}>Last 7 days</option>
          <option value={new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}>Last 30 days</option>
        </select>
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={250}>250</option>
        </select>
        <button className="btn btn-sm btn-secondary" onClick={load} disabled={loading}>{loading ? 'Loading...' : '↻ Refresh'}</button>
      </div>

      <div className="muted" style={{margin: '8px 0 14px', fontSize: 12}}>
        {total.toLocaleString()} total emails ·{' '}
        <span style={{color: '#10b981'}}>{sentCount.toLocaleString()} sent</span>
        {' · '}
        <span style={{color: '#ef4444'}}>{failedCount.toLocaleString()} failed</span>
        {' · '}showing {rows.length}
      </div>

      {rows.length === 0 ? (
        <div className="empty-state-full">No emails match the current filters.</div>
      ) : (
        <div className="updates-feed">
          {rows.map(r => {
            const isSent = r.status === 'sent'
            const color = isSent ? '#10b981' : '#ef4444'
            const icon = isSent ? '✓' : '✗'
            const dt = r.sent_at ? new Date(r.sent_at.includes('T') ? r.sent_at : r.sent_at.replace(' ', 'T') + 'Z') : null
            return (
              <div key={r.id} className="updates-row" style={{cursor: 'pointer'}} onClick={() => openDetail(r.id)}>
                <div className="updates-icon" style={{color, borderColor: color + '50', background: color + '15'}}>{icon}</div>
                <div className="updates-content">
                  <div className="updates-line">
                    <span className="updates-action">{r.subject || '(no subject)'}</span>
                    <span className="updates-entity-badge" style={{background: color + '20', color}}>
                      {r.status}
                    </span>
                    {r.template && (
                      <span className="updates-entity-badge" style={{background: 'rgba(168, 85, 247, 0.2)', color: '#c4b5fd'}}>
                        {r.template}
                      </span>
                    )}
                    <span className="updates-time" title={dt?.toLocaleString()}>
                      {dt ? dt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                    </span>
                  </div>
                  <div className="updates-details">
                    <strong>To:</strong> {r.to_email || '—'}
                    {r.error && (
                      <div style={{color: '#fca5a5', marginTop: 4}}>
                        <strong>Error:</strong> {r.error}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {rows.length === pageSize && offset + pageSize < total && (
        <div style={{textAlign: 'center', marginTop: 20}}>
          <button className="btn btn-secondary" onClick={() => setOffset(prev => prev + pageSize)}>
            Load More ({(total - offset - pageSize).toLocaleString()} remaining)
          </button>
        </div>
      )}

      {/* Detail modal */}
      {openRow && (
        <div className="modal-overlay" onClick={() => setOpenRow(null)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Email Detail</h2>
              <button className="modal-close" onClick={() => setOpenRow(null)}>&times;</button>
            </div>
            <div className="modal-body">
              <div className="email-preview" style={{marginBottom: 12}}>
                <div className="email-preview-line"><strong>Status:</strong> {openRow.status}{openRow.status === 'failed' && openRow.error ? ' — ' + openRow.error : ''}</div>
                <div className="email-preview-line"><strong>Sent at:</strong> {openRow.sent_at || '—'}</div>
                <div className="email-preview-line"><strong>To:</strong> {openRow.to_email}</div>
                <div className="email-preview-line"><strong>From:</strong> {openRow.from_name} &lt;{openRow.from_email}&gt;</div>
                <div className="email-preview-line"><strong>Subject:</strong> {openRow.subject}</div>
                {openRow.template && <div className="email-preview-line"><strong>Template:</strong> {openRow.template}</div>}
                {openRow.provider_message_id && <div className="email-preview-line"><strong>SendGrid ID:</strong> {openRow.provider_message_id}</div>}
                <hr style={{margin: '12px 0', borderColor: 'var(--border)'}} />
                <div className="email-preview-body" style={{whiteSpace: 'pre-wrap'}}>{openRow.body}</div>
              </div>
              <div className="form-actions">
                <button className="btn btn-secondary" onClick={() => setOpenRow(null)}>Close</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// =====================================================
// PAGE WITH TABS
// =====================================================
// One-click consolidation: pre_listings rows -> transactions w/ status=Pre-Listing
function MigratePreListings() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const run = async (dry_run) => {
    setRunning(true); setError(null); setResult(null)
    try {
      const r = await authFetch('/api/pre-listings/migrate-to-transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dry_run }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  return (
    <div style={{padding: 16, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 16}}>
      <h3 style={{margin: '0 0 10px'}}>Migrate pre-listings into Transactions</h3>
      <p style={{margin: '0 0 12px', fontSize: 13, color: 'var(--text-muted)'}}>
        Moves each existing pre-listing into the Transactions tab with status=<strong>Pre-Listing</strong>.
        Unchecked pre-listing checklist items become open tasks (category: Listing) linked to the new transaction.
        Source pre_listings rows are marked <strong>Migrated</strong> (not deleted) so nothing is lost.
        Skips any pre-listing whose address already exists as a transaction.
      </p>
      <div style={{display: 'flex', gap: 8}}>
        <button className="btn btn-secondary" onClick={() => run(true)} disabled={running}>{running ? 'Running…' : 'Preview (dry run)'}</button>
        <button className="btn btn-primary" onClick={() => { if (confirm('Migrate all pre-listings into Transactions? Source rows will be marked Migrated.')) run(false) }} disabled={running}>
          {running ? 'Running…' : 'Run migration'}
        </button>
      </div>

      {error && <div style={{padding: 12, marginTop: 12, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 6}}>Error: {error}</div>}

      {result && (
        <div style={{marginTop: 14, padding: 12, background: 'var(--bg-elevated)', borderRadius: 6}}>
          <div style={{display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginBottom: 10}}>
            <span>📋 <strong>{result.total_source}</strong> source pre-listings</span>
            <span style={{color: '#10b981'}}>✅ <strong>{result.created}</strong> {result.dry_run ? 'would migrate' : 'migrated'}</span>
            <span style={{color: '#f59e0b'}}>⏭ <strong>{result.skipped}</strong> skipped (already in transactions)</span>
            {!result.dry_run && <span>📌 <strong>{result.tasks_created}</strong> tasks created</span>}
          </div>
          <table style={{width: '100%', fontSize: 12, borderCollapse: 'collapse'}}>
            <thead><tr style={{textAlign: 'left', borderBottom: '1px solid var(--border)'}}>
              <th style={{padding: 6}}>Address</th>
              <th style={{padding: 6}}>Owner</th>
              <th style={{padding: 6}}>Action</th>
              <th style={{padding: 6}}>Detail</th>
            </tr></thead>
            <tbody>
              {result.report.map((r, i) => (
                <tr key={i} style={{borderBottom: '1px solid var(--border)'}}>
                  <td style={{padding: 6}}>{r.address}</td>
                  <td style={{padding: 6}}>{r.owner_name || '—'}</td>
                  <td style={{padding: 6}}>
                    {r.action === 'migrated'    && <span style={{color: '#10b981'}}>migrated → tx #{r.new_transaction_id}</span>}
                    {r.action === 'would-create'&& <span style={{color: '#3b82f6'}}>would create</span>}
                    {r.action === 'skip'        && <span style={{color: '#f59e0b'}}>skipped</span>}
                  </td>
                  <td style={{padding: 6, color: 'var(--text-muted)', fontSize: 11}}>
                    {r.tasks_created !== undefined ? `${r.tasks_created} open tasks` : (r.would_create_tasks !== undefined ? `${r.would_create_tasks} tasks would be created` : r.reason)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function BulkTagFromSheet() {
  const [form, setForm] = useState({
    sheet_id: '1i0p9ux3_4pluE24ioBajqTBZ2SqFkM6qtu7pofDDaJc',
    filter_column: 'FSBO Status',
    filter_value: 'Off Market',
    tag: 'FSBO_Off Market',
  })
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const run = async (dry_run) => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      const r = await authFetch('/api/sierra/bulk-tag-from-sheet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, dry_run })
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
      setResult(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setRunning(false)
    }
  }

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }))

  return (
    <div>
      <div style={{padding: 16, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)', marginBottom: 16}}>
        <h3 style={{margin: '0 0 10px'}}>Bulk-tag clients from a Google Sheet</h3>
        <p style={{margin: '0 0 14px', fontSize: 13, color: 'var(--text-muted)'}}>
          Pulls a public Google Sheet, filters rows where a column equals a value, matches each row to a hub client by phone (last 10 digits), and adds the tag both locally and to Sierra. Pre-filled for the FSBO Master Off Market batch.
        </p>
        <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10}}>
          <label style={{fontSize: 12}}>Sheet ID
            <input value={form.sheet_id} onChange={e => f('sheet_id', e.target.value)} style={{width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-primary)', color: 'var(--text-primary)'}} />
          </label>
          <label style={{fontSize: 12}}>Tag to apply
            <input value={form.tag} onChange={e => f('tag', e.target.value)} style={{width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-primary)', color: 'var(--text-primary)'}} />
          </label>
          <label style={{fontSize: 12}}>Filter column
            <input value={form.filter_column} onChange={e => f('filter_column', e.target.value)} style={{width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-primary)', color: 'var(--text-primary)'}} />
          </label>
          <label style={{fontSize: 12}}>Filter value
            <input value={form.filter_value} onChange={e => f('filter_value', e.target.value)} style={{width: '100%', padding: 6, border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-primary)', color: 'var(--text-primary)'}} />
          </label>
        </div>
        <div style={{display: 'flex', gap: 8, marginTop: 14}}>
          <button className="btn btn-secondary" onClick={() => run(true)} disabled={running}>{running ? 'Running…' : 'Preview (dry run)'}</button>
          <button className="btn btn-primary" onClick={() => { if (confirm(`Apply tag "${form.tag}" to all matching clients AND push to Sierra?`)) run(false) }} disabled={running}>
            {running ? 'Running…' : 'Run for real'}
          </button>
        </div>
      </div>

      {error && <div style={{padding: 12, background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: 6, marginBottom: 16}}>Error: {error}</div>}

      {result && (
        <div style={{padding: 16, background: 'var(--bg-secondary)', borderRadius: 8, border: '1px solid var(--border)'}}>
          <h3 style={{margin: '0 0 10px'}}>{result.dry_run ? 'Preview' : 'Results'}</h3>
          <div style={{display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, marginBottom: 14}}>
            <span><strong>{result.total_filtered}</strong> rows matched filter</span>
            <span><strong style={{color: '#10b981'}}>{result.matched}</strong> matched a hub client</span>
            <span><strong style={{color: '#f59e0b'}}>{result.no_match}</strong> no hub match</span>
            <span><strong>{result.already_tagged}</strong> already tagged</span>
            {!result.dry_run && <>
              <span><strong style={{color: '#3b82f6'}}>{result.pushed_to_sierra}</strong> pushed to Sierra</span>
              {result.sierra_failed > 0 && <span><strong style={{color: '#ef4444'}}>{result.sierra_failed}</strong> Sierra failed</span>}
            </>}
          </div>
          <table style={{width: '100%', fontSize: 12, borderCollapse: 'collapse'}}>
            <thead><tr style={{textAlign: 'left', borderBottom: '1px solid var(--border)'}}>
              <th style={{padding: 6}}>Sheet Name</th><th style={{padding: 6}}>Hub Match</th><th style={{padding: 6}}>Action</th><th style={{padding: 6}}>Sierra</th>
            </tr></thead>
            <tbody>
              {result.report.map((r, i) => (
                <tr key={i} style={{borderBottom: '1px solid var(--border)'}}>
                  <td style={{padding: 6}}>{r.sheet_name}</td>
                  <td style={{padding: 6}}>{r.matched ? `#${r.hub_client_id} ${r.hub_name}` : <span style={{color: '#f59e0b'}}>{r.reason}</span>}</td>
                  <td style={{padding: 6}}>{r.action || '—'}</td>
                  <td style={{padding: 6, fontSize: 11}}>{r.sierra || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// =====================================================
// SYSTEMS — data-source sync status (Sierra + Realist)
// Moved here from the Clients page so Clients stays focused on leads.
// =====================================================
function SystemsStatus() {
  const [syncHealth, setSyncHealth] = useState(null)
  const [realistStats, setRealistStats] = useState(null)
  const [runningIncremental, setRunningIncremental] = useState(false)
  const loadHealth = () => authFetch('/api/sierra/sync-health').then(r => r.json()).then(setSyncHealth).catch(() => {})
  const loadRealistStats = () => authFetch('/api/realist/stats').then(r => r.json()).then(setRealistStats).catch(() => {})
  useEffect(() => { loadHealth(); loadRealistStats() }, [])

  const fmtAgo = (ts) => {
    if (!ts) return 'never'
    const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
    const mins = Math.floor((Date.now() - d.getTime()) / 60000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins} min ago`
    if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`
    return `${Math.floor(mins / 1440)} day${Math.floor(mins / 1440) === 1 ? '' : 's'} ago`
  }

  const lastInc = syncHealth?.last_incremental
  const lastFull = syncHealth?.last_full
  const incrementalIsStale = syncHealth && (!lastInc || (Date.now() - new Date(lastInc.synced_at.replace(' ', 'T') + 'Z').getTime()) > 30 * 60 * 1000)

  return (
    <div style={{ display: 'grid', gap: 14, maxWidth: 900 }}>
      <h3 style={{ margin: '4px 0' }}>Sierra Interactive</h3>
      {syncHealth ? (
        <div className={`sierra-banner ${incrementalIsStale ? 'warning' : 'info'}`} style={{display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center'}}>
          <div style={{flex: 1, minWidth: 250}}>
            {lastFull && (
              <div><strong>Last full sync:</strong> {new Date(lastFull.synced_at.replace(' ', 'T') + 'Z').toLocaleString()} — {lastFull.leads_synced.toLocaleString()} leads</div>
            )}
            <div>
              <strong>Last incremental:</strong>{' '}
              {lastInc ? (
                <>{fmtAgo(lastInc.synced_at)} — {lastInc.leads_synced} updated · {syncHealth.incremental_runs_24h} runs in 24hr</>
              ) : (
                <span style={{color: '#fbbf24'}}>none on record</span>
              )}
            </div>
            {syncHealth.updates_since_full_sync > 0 && (
              <div style={{fontSize: 12, opacity: 0.8}}>{syncHealth.updates_since_full_sync.toLocaleString()} lead updates since last full sync</div>
            )}
            {incrementalIsStale && (
              <div style={{color: '#fbbf24', fontSize: 12, marginTop: 4}}>
                ⚠ Incremental sync hasn't run in 30+ min — scheduler may have stopped. Click "Run Sync Now" to trigger one.
              </div>
            )}
          </div>
          <button
            className="btn btn-sm btn-secondary"
            disabled={runningIncremental}
            onClick={async () => {
              setRunningIncremental(true)
              try {
                const r = await authFetch('/api/sierra/sync-incremental-now', { method: 'POST' })
                const d = await r.json()
                if (d.success) alert(`✓ Incremental sync complete: ${d.total} leads (${d.added} new, ${d.updated} updated)`)
                else alert('Sync failed: ' + (d.error || 'unknown error'))
                loadHealth()
              } catch (e) { alert('Failed: ' + e.message) }
              finally { setRunningIncremental(false) }
            }}
          >
            {runningIncremental ? 'Syncing...' : '↻ Run Sync Now'}
          </button>
        </div>
      ) : <div className="sierra-banner info">Loading sync status…</div>}

      <h3 style={{ margin: '10px 0 4px' }}>Realist Enrichment</h3>
      {realistStats && realistStats.total_properties > 0 && (
        <div className="sierra-banner info" style={{display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center'}}>
          <div style={{flex: 1, minWidth: 250}}>
            <strong>🏘 Realist data:</strong>{' '}
            {realistStats.total_properties.toLocaleString()} properties imported ·{' '}
            {realistStats.enriched_clients.toLocaleString()} clients enriched
            {realistStats.last_import && (
              <span style={{fontSize: 11, marginLeft: 10, opacity: 0.7}}>
                Last import: {realistStats.last_import.split('.')[0].replace('T', ' ')}
              </span>
            )}
          </div>
          <button
            className="btn btn-sm btn-secondary"
            onClick={async () => {
              const r = await authFetch('/api/realist/rematch', { method: 'POST' })
              const d = await r.json()
              alert(`✓ Re-matched: ${d.client_matches_updated} clients updated from ${d.properties_scanned} properties`)
              loadRealistStats()
            }}
            title="Re-run matching after Sierra adds new leads"
          >
            ↻ Re-match
          </button>
        </div>
      )}
      {realistStats && realistStats.total_properties === 0 && (
        <div className="sierra-banner warning">
          🏘 No Realist data imported yet. Click <strong>Import Realist CSV</strong> on the Clients page header to upload.
        </div>
      )}
      {!realistStats && <div className="sierra-banner info">Loading Realist status…</div>}
    </div>
  )
}

export default function Updates() {
  const [tab, setTab] = useState('whatsnew')
  const subtitles = {
    whatsnew: 'What’s new — a plain-English tour of everything added to the Hub, newest first',
    hub: 'Hub development history — features added, fixes shipped, improvements over time',
    activity: 'Live activity feed — everything created, updated, synced or sent across the hub',
    email: 'Every email send attempt — successful + failed, with timestamps and error details',
    bulk: 'Bulk admin tools — apply tags to many clients at once from a source sheet',
    systems: 'Data-source sync status — Sierra Interactive lead sync + Realist enrichment',
    fields: 'Custom fields — every email merge field, what it inserts, and where the data comes from',
  }
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Updates</h1>
          <p className="page-subtitle">{subtitles[tab]}</p>
        </div>
      </div>

      <div className="listing-tabs" style={{marginBottom: 18}}>
        <button className={`listing-tab ${tab === 'whatsnew' ? 'active' : ''}`} onClick={() => setTab('whatsnew')}>
          ✨ What’s New
        </button>
        <button className={`listing-tab ${tab === 'hub' ? 'active' : ''}`} onClick={() => setTab('hub')}>
          🛠 Hub Updates
        </button>
        <button className={`listing-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          📊 Activity Log
        </button>
        <button className={`listing-tab ${tab === 'email' ? 'active' : ''}`} onClick={() => setTab('email')}>
          ✉ Email Log
        </button>
        <button className={`listing-tab ${tab === 'bulk' ? 'active' : ''}`} onClick={() => setTab('bulk')}>
          🏷 Bulk Tools
        </button>
        <button className={`listing-tab ${tab === 'systems' ? 'active' : ''}`} onClick={() => setTab('systems')}>
          ⚙ Systems
        </button>
        <button className={`listing-tab ${tab === 'fields' ? 'active' : ''}`} onClick={() => setTab('fields')}>
          🔤 Custom Fields
        </button>
      </div>

      {tab === 'whatsnew' && <WhatsNew />}
      {tab === 'hub' && <HubUpdates />}
      {tab === 'activity' && <ActivityLog />}
      {tab === 'email' && <EmailLog />}
      {tab === 'bulk' && <MigratePreListings />}{/* BulkTagFromSheet removed 2026-08-06 — hub no longer connects to any Google Sheet */}
      {tab === 'systems' && <SystemsStatus />}
      {tab === 'fields' && <CustomFields />}
    </div>
  )
}
