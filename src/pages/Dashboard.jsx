import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { api, authFetch } from '../api'
import StatusBadge from '../components/StatusBadge'

const DASHBOARD_CACHE_KEY = 'mst_dashboard_cache'

export default function Dashboard() {
  // Hydrate from localStorage on first render — instant paint with last-known data
  const [data, setData] = useState(() => {
    try {
      const raw = localStorage.getItem(DASHBOARD_CACHE_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  })
  const [loading, setLoading] = useState(false) // never show full-page loader if we have cached data
  const [refreshing, setRefreshing] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [leadActivity, setLeadActivity] = useState([])

  const load = () => {
    setRefreshing(true)
    api.dashboard().then(d => {
      setData(d)
      setLoading(false)
      setRefreshing(false)
      try { localStorage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(d)) } catch {}
    }).catch(() => { setLoading(false); setRefreshing(false) })
  }

  const loadLeadActivity = () => {
    authFetch('/api/track/recent?limit=25').then(r => r.json()).then(rows => {
      if (Array.isArray(rows)) setLeadActivity(rows)
    }).catch(() => {})
  }

  useEffect(() => { load(); loadLeadActivity() }, [])
  useEffect(() => {
    const t = setInterval(loadLeadActivity, 30_000)
    return () => clearInterval(t)
  }, [])

  const syncSierra = async () => {
    setSyncing(true)
    try {
      const r = await authFetch('/api/sierra/sync', { method: 'POST' })
      const d = await r.json()
      if (d.error) alert('Sierra sync error: ' + d.error)
      else alert(`Sierra sync complete: ${d.total_synced} leads (${d.added} new, ${d.updated} updated)`)
      load()
    } catch (e) { alert('Sync failed: ' + e.message) }
    setSyncing(false)
  }

  // Google Sheet sync REMOVED 2026-05-14 — the hub is the master file for
  // transactions and pre-listings. The 'Sync Google Sheet' and 'Sync
  // Everything' buttons used to pull the sheet and were creating duplicates
  // on every run because the sheet has multiple address variants for the
  // same property. Sierra incremental sync (every 10 min) is still active
  // and is what keeps Sierra leads up to date.

  // Only show full-page loader on truly first-ever load (no cache + no data yet)
  if (!data && loading) return <div className="page-loading">Loading dashboard...</div>
  if (!data) return <div className="page-loading">Failed to load dashboard</div>

  const { transactions, clients, tasks, projects, pre_listings, marketing, social_media, vendors, partners, calendar } = data

  const fmt = (n) => n ? `$${Number(n).toLocaleString()}` : '$0'

  // Show the client we actually represent, driven by the agency_type chosen on
  // the transaction (Buyer's Agent / Listing Agent / Dual Agent). Whoever we
  // represent is the name shown. Handles legacy spellings ("Buyers Agent",
  // "Dual Agency"). Falls back to deal type, then any available name.
  const representedClient = (t) => {
    const a = (t.agency_type || '').toLowerCase()
    if (a.includes('dual') || a.includes('both')) {
      const both = [t.seller_name, t.buyer_name].filter(Boolean).join(' / ')
      return both || t.client_name || 'No client'
    }
    if (a.includes('listing') || a.includes('seller')) return t.seller_name || t.client_name || t.buyer_name || 'No client'
    if (a.includes('buyer')) return t.buyer_name || t.client_name || t.seller_name || 'No client'
    // agency_type not set yet — fall back to the deal type
    if (t.type === 'listing') return t.seller_name || t.buyer_name || t.client_name || 'No client'
    if (t.type === 'purchase') return t.buyer_name || t.seller_name || t.client_name || 'No client'
    return t.buyer_name || t.seller_name || t.client_name || 'No client'
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Dashboard {refreshing && <span style={{fontSize: 12, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8}}>· refreshing...</span>}</h1>
          <p className="page-subtitle">Matt Smith Team Command Center</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={syncSierra} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Pull Sierra Leads'}
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="stats-grid">
        <div className="stat-card stat-blue">
          <div className="stat-number">{transactions.under_contract}</div>
          <div className="stat-label">Under Contract</div>
        </div>
        <div className="stat-card stat-purple">
          <div className="stat-number">{transactions.active}</div>
          <div className="stat-label">Active Transactions</div>
        </div>
        <div className="stat-card stat-green">
          <div className="stat-number">{transactions.closed_this_month}</div>
          <div className="stat-label">Closed This Month</div>
        </div>
        <div className="stat-card stat-teal">
          <div className="stat-number">{fmt(transactions.total_volume)}</div>
          <div className="stat-label">Monthly Volume</div>
        </div>
        <div className="stat-card stat-amber">
          <div className="stat-number">{clients.active_buyers}</div>
          <div className="stat-label">Active Buyers</div>
        </div>
        <div className="stat-card stat-rose">
          <div className="stat-number">{clients.active_sellers}</div>
          <div className="stat-label">Active Sellers</div>
        </div>
        <div className="stat-card stat-red">
          <div className="stat-number">{tasks.overdue}</div>
          <div className="stat-label">Overdue Tasks</div>
        </div>
        <div className="stat-card stat-indigo">
          <div className="stat-number">{pre_listings.total}</div>
          <div className="stat-label">Pre-Listings</div>
        </div>
      </div>

      {/* Quick Stats Row */}
      <div className="stats-grid stats-small">
        <div className="stat-card stat-blue">
          <div className="stat-number">{calendar.today}</div>
          <div className="stat-label">Events Today</div>
        </div>
        <div className="stat-card stat-purple">
          <div className="stat-number">{social_media.scheduled}</div>
          <div className="stat-label">Posts Scheduled</div>
        </div>
        <div className="stat-card stat-green">
          <div className="stat-number">{vendors.preferred}</div>
          <div className="stat-label">Preferred Vendors</div>
        </div>
        <div className="stat-card stat-amber">
          <div className="stat-number">{marketing.active_campaigns}</div>
          <div className="stat-label">Active Campaigns</div>
        </div>
      </div>

      {/* Sierra Sync Status */}
      {data.last_sierra_sync && (
        <div className="card" style={{marginBottom: 20}}>
          <div className="card-body" style={{padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
            <span style={{fontSize: 13, color: 'var(--text-muted)'}}>
              Last Sierra sync: {new Date(data.last_sierra_sync.synced_at).toLocaleString()} &mdash;
              {data.last_sierra_sync.leads_synced} leads ({data.last_sierra_sync.leads_added} new, {data.last_sierra_sync.leads_updated} updated)
            </span>
            <Link to="/clients" className="card-link">View Clients</Link>
          </div>
        </div>
      )}

      <div className="dashboard-grid">
        {/* Active Transactions */}
        <div className="card">
          <div className="card-header">
            <h3>Active Transactions</h3>
            <Link to="/transactions" className="card-link">View All</Link>
          </div>
          <div className="card-body">
            {data.active_transactions?.length === 0 ? (
              <p className="empty-state">No active transactions</p>
            ) : (
              <div className="mini-table">
                {data.active_transactions?.map(t => (
                  <div key={t.id} className="mini-row">
                    <div className="mini-row-main">
                      <span className="mini-row-title">{t.property_address}</span>
                      <span className="mini-row-sub">{representedClient(t)}</span>
                    </div>
                    <div className="mini-row-meta">
                      <StatusBadge status={t.property_status?.toLowerCase().replace(/ /g, '_')} />
                      {t.closing_date && <span className="mini-date">Close: {t.closing_date}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Upcoming Tasks */}
        <div className="card">
          <div className="card-header">
            <h3>Upcoming Tasks</h3>
            <Link to="/tasks" className="card-link">View All</Link>
          </div>
          <div className="card-body">
            {data.upcoming_tasks?.length === 0 ? (
              <p className="empty-state">No upcoming tasks</p>
            ) : (
              <div className="mini-table">
                {data.upcoming_tasks?.map(t => (
                  <div key={t.id} className="mini-row">
                    <div className="mini-row-main">
                      <span className="mini-row-title">{t.title}</span>
                      <span className="mini-row-sub">{t.assigned_to || 'Unassigned'}</span>
                    </div>
                    <div className="mini-row-meta">
                      <StatusBadge status={t.priority} />
                      {t.due_date && (
                        <span className={`mini-date ${t.due_date < new Date().toISOString().split('T')[0] ? 'overdue' : ''}`}>
                          {t.due_date}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Today's Events */}
        <div className="card">
          <div className="card-header">
            <h3>Today's Schedule</h3>
            <Link to="/calendar" className="card-link">Full Calendar</Link>
          </div>
          <div className="card-body">
            {data.todays_events?.length === 0 ? (
              <p className="empty-state">No events today</p>
            ) : (
              <div className="mini-table">
                {data.todays_events?.map(ev => (
                  <div key={ev.id} className="mini-row">
                    <div className="mini-row-main">
                      <span className="mini-row-title">{ev.title}</span>
                      <span className="mini-row-sub">{ev.event_type}{ev.location ? ` - ${ev.location}` : ''}</span>
                    </div>
                    <div className="mini-row-meta">
                      {ev.start_time && <span className="mini-date">{ev.start_time}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="card">
          <div className="card-header">
            <h3>Recent Activity</h3>
          </div>
          <div className="card-body">
            {data.recent_activity?.length === 0 ? (
              <p className="empty-state">No recent activity</p>
            ) : (
              <div className="activity-feed">
                {data.recent_activity?.map(a => (
                  <div key={a.id} className="activity-item">
                    <div className="activity-dot"></div>
                    <div className="activity-content">
                      <span className="activity-action">{a.action}</span>
                      <span className="activity-details">{a.details}</span>
                      <span className="activity-time">{new Date(a.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Live Lead Activity — from mattsmithteam.com tracking pixel */}
        <div className="card">
          <div className="card-header">
            <h3>Live Lead Activity</h3>
            <span style={{fontSize: 11, color: 'var(--text-muted)'}}>auto-refresh 30s · last {leadActivity.length}</span>
          </div>
          <div className="card-body">
            {leadActivity.length === 0 ? (
              <p className="empty-state">No tracked activity yet. Paste the snippet into Sierra (see Updates → Bulk Tools).</p>
            ) : (
              <div className="activity-feed">
                {leadActivity.map(a => {
                  const who = a.first_name ? `${a.first_name} ${a.last_name || ''}` : (a.sierra_lead_id ? `Lead #${a.sierra_lead_id}` : 'Anonymous')
                  const eventLabel = {
                    pageview: '👁 page view',
                    listing_view: '🏠 listing view',
                    save: '⭐ saved',
                    pageduration: '⏱ time on page',
                  }[a.event_type] || a.event_type
                  return (
                    <div key={a.id} className="activity-item">
                      <div className="activity-dot" style={{background: a.event_type === 'save' ? '#f59e0b' : a.event_type === 'listing_view' ? '#3b82f6' : '#6b7280'}}></div>
                      <div className="activity-content">
                        <span className="activity-action">
                          {a.client_id ? <Link to="/clients" style={{color: 'inherit', fontWeight: 600}}>{who}</Link> : who}
                          {' '}{eventLabel}
                        </span>
                        <span className="activity-details">
                          {a.listing_mls ? `MLS ${a.listing_mls} · ` : ''}
                          {a.page_title || a.page_url}
                          {a.duration_sec ? ` · ${a.duration_sec}s` : ''}
                        </span>
                        <span className="activity-time">{new Date(a.created_at).toLocaleString()}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
