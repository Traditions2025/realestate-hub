import React, { useState, useEffect, useMemo } from 'react'
import { authFetch } from '../api'

const ACTION_ICONS = {
  created: '✨',
  updated: '✎',
  deleted: '🗑',
  synced: '↻',
  refreshed: '↻',
  email_sent: '✉',
  generated: '🪄',
  extracted_pdf: '📄',
  extracted_url: '🔗',
  auto_populated: '🌐',
  webhook: '🔔',
  seeded: '🌱',
  note_added: '📝',
  batch_refresh: '↻',
}

const ENTITY_LABELS = {
  client: 'Client',
  transaction: 'Transaction',
  pre_listing: 'Pre-Listing',
  listing: 'Listing',
  task: 'Task',
  project: 'Project',
  note: 'Note',
  vendor: 'Vendor',
  partner: 'Partner',
  social_post: 'Social Post',
  marketing: 'Marketing',
  showing: 'Showing',
  calendar: 'Calendar',
  sierra: 'Sierra',
}

const ENTITY_COLORS = {
  client: '#3b82f6',
  transaction: '#10b981',
  pre_listing: '#a855f7',
  listing: '#c89b4a',
  task: '#f59e0b',
  project: '#8b5cf6',
  note: '#6b7280',
  vendor: '#06b6d4',
  partner: '#ec4899',
  social_post: '#f43f5e',
  marketing: '#ef4444',
  sierra: '#7c3aed',
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

function fmtAbsolute(ts) {
  if (!ts) return ''
  const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
  return d.toLocaleString()
}

export default function Updates() {
  const [items, setItems] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [filters, setFilters] = useState({ entity_type: '', action: '', search: '', since: '' })
  const [filterOptions, setFilterOptions] = useState({ entity_types: [], actions: [] })
  const [pageSize, setPageSize] = useState(100)
  const [offset, setOffset] = useState(0)

  const load = () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset) })
    if (filters.entity_type) params.set('entity_type', filters.entity_type)
    if (filters.action) params.set('action', filters.action)
    if (filters.search) params.set('search', filters.search)
    if (filters.since) params.set('since', filters.since)
    authFetch('/api/activity?' + params)
      .then(r => r.json())
      .then(d => { setItems(d.rows || []); setTotal(d.total || 0) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    authFetch('/api/activity/filters').then(r => r.json()).then(setFilterOptions).catch(() => {})
  }, [])
  useEffect(() => { load() }, [pageSize, offset, filters])

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
  const clearFilters = () => { setFilters({ entity_type: '', action: '', search: '', since: '' }); setOffset(0) }
  const hasFilters = filters.entity_type || filters.action || filters.search || filters.since

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Updates</h1>
          <p className="page-subtitle">Everything created, updated, synced, or sent across the hub</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Loading...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="text"
          placeholder="Search updates..."
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
        <select
          value={filters.since}
          onChange={e => setFilter('since', e.target.value)}
          title="Time range"
        >
          <option value="">All time</option>
          <option value={new Date(Date.now() - 60 * 60 * 1000).toISOString()}>Last hour</option>
          <option value={new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()}>Last 24 hours</option>
          <option value={new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}>Last 7 days</option>
          <option value={new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()}>Last 30 days</option>
        </select>
        {hasFilters && (
          <button className="btn-sm btn-danger" onClick={clearFilters}>Clear filters</button>
        )}
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} title="Show per page">
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={250}>250</option>
          <option value={500}>500</option>
        </select>
      </div>

      <div className="muted" style={{margin: '8px 0 14px', fontSize: 12}}>
        Showing {items.length} of {total.toLocaleString()} updates
      </div>

      {Object.keys(grouped).length === 0 && !loading ? (
        <div className="empty-state-full">No updates match the current filters.</div>
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
                      <span className="updates-time" title={fmtAbsolute(e.created_at)}>{fmtAgo(e.created_at)}</span>
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
            Load More ({(total - offset - pageSize).toLocaleString()} remaining)
          </button>
        </div>
      )}
    </div>
  )
}
