import React, { useState, useEffect, useMemo } from 'react'
import { authFetch } from '../api'

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
export default function Updates() {
  const [tab, setTab] = useState('hub')
  const subtitles = {
    hub: 'Hub development history — features added, fixes shipped, improvements over time',
    activity: 'Live activity feed — everything created, updated, synced or sent across the hub',
    email: 'Every email send attempt — successful + failed, with timestamps and error details',
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
        <button className={`listing-tab ${tab === 'hub' ? 'active' : ''}`} onClick={() => setTab('hub')}>
          🛠 Hub Updates
        </button>
        <button className={`listing-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          📊 Activity Log
        </button>
        <button className={`listing-tab ${tab === 'email' ? 'active' : ''}`} onClick={() => setTab('email')}>
          ✉ Email Log
        </button>
      </div>

      {tab === 'hub' && <HubUpdates />}
      {tab === 'activity' && <ActivityLog />}
      {tab === 'email' && <EmailLog />}
    </div>
  )
}
