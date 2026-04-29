import React, { useState, useEffect, useRef } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const emptyClient = {
  first_name: '', last_name: '', email: '', phone: '', type: 'buyer', status: 'active',
  source: '', agent_assigned: '', address: '', city: '', state: 'IA', zip: '',
  budget_min: '', budget_max: '', preapproval_amount: '', preapproval_lender: '', notes: ''
}

export default function Clients() {
  const [items, setItems] = useState([])
  const [tab, setTab] = useState('active') // 'active', 'prime', 'all'
  const [filter, setFilter] = useState({ type: '' })
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyClient)
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [sierraStatus, setSierraStatus] = useState(null) // null = not started, 'syncing', { added, updated, total_synced, error }
  const [syncLog, setSyncLog] = useState(null)
  const [syncMenuOpen, setSyncMenuOpen] = useState(false)
  const [sierraCounts, setSierraCounts] = useState(null)
  const hasSynced = useRef(false)

  // Advanced filters
  const [advFilters, setAdvFilters] = useState({
    statuses_include: [],
    statuses_exclude: [],
    tags_include: [],
    tags_exclude: [],
    zips_include: [],
    cities_include: [],
    sources_include: [],
    has_email: false,
    exclude_optouts: false,
    score_min: '',
    score_max: '',
    visits_min: '',
  })
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [filterOptions, setFilterOptions] = useState({ zips: [], cities: [], sources: [], tags: [] })
  const [savedLists, setSavedLists] = useState([])
  const [activeListId, setActiveListId] = useState(null)
  const [saveListOpen, setSaveListOpen] = useState(false)
  const [newListName, setNewListName] = useState('')

  // Load filter options + saved lists once
  useEffect(() => {
    authFetch('/api/clients/filter-options').then(r => r.json()).then(setFilterOptions).catch(() => {})
    authFetch('/api/lists').then(r => r.json()).then(setSavedLists).catch(() => {})
  }, [])

  const advFilterCount = (
    advFilters.statuses_include.length + advFilters.statuses_exclude.length +
    advFilters.tags_include.length + advFilters.tags_exclude.length +
    advFilters.zips_include.length + advFilters.cities_include.length +
    advFilters.sources_include.length +
    (advFilters.has_email ? 1 : 0) + (advFilters.exclude_optouts ? 1 : 0) +
    (advFilters.score_min ? 1 : 0) + (advFilters.score_max ? 1 : 0) +
    (advFilters.visits_min ? 1 : 0)
  )

  const hasActiveFilters = advFilterCount > 0 || tab !== 'all'

  const [pageSize, setPageSize] = useState(() => Number(localStorage.getItem('clients_page_size')) || 100)
  useEffect(() => { localStorage.setItem('clients_page_size', String(pageSize)) }, [pageSize])
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false)
  const [bulkEmailForm, setBulkEmailForm] = useState({ subject: '', body: '', template: '' })
  const [bulkSending, setBulkSending] = useState(false)
  const [otherMenuOpen, setOtherMenuOpen] = useState(false)
  const [view, setView] = useState(() => localStorage.getItem('clients_view') || 'list')
  const [statusCounts, setStatusCounts] = useState([]) // [{status, count}]
  const [allCounts, setAllCounts] = useState({ buyers: 0, sellers: 0, total: 0 })

  const buildLoadParams = () => {
    const params = { limit: pageSize, offset: 0 }
    if (filter.type) params.type = filter.type
    if (tab !== 'all') params.status = tab
    if (search) params.search = search
    // Advanced filters
    if (advFilters.statuses_include.length) params.statuses_include = advFilters.statuses_include.join(',')
    if (advFilters.statuses_exclude.length) params.statuses_exclude = advFilters.statuses_exclude.join(',')
    if (advFilters.tags_include.length) params.tags_include = advFilters.tags_include.join(',')
    if (advFilters.tags_exclude.length) params.tags_exclude = advFilters.tags_exclude.join(',')
    if (advFilters.zips_include.length) params.zips_include = advFilters.zips_include.join(',')
    if (advFilters.cities_include.length) params.cities_include = advFilters.cities_include.join(',')
    if (advFilters.sources_include.length) params.sources_include = advFilters.sources_include.join(',')
    if (advFilters.has_email) params.has_email = '1'
    if (advFilters.exclude_optouts) params.exclude_optouts = '1'
    if (advFilters.score_min) params.score_min = advFilters.score_min
    if (advFilters.score_max) params.score_max = advFilters.score_max
    if (advFilters.visits_min) params.visits_min = advFilters.visits_min
    return params
  }

  const load = () => {
    api.getClientsPaged(buildLoadParams()).then(({ rows, total }) => {
      setItems(rows)
      setTotalCount(total)
      setHasMore(rows.length < total)
    })
  }

  const loadMore = () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    const params = { limit: pageSize, offset: items.length }
    if (filter.type) params.type = filter.type
    if (tab !== 'all') params.status = tab
    if (search) params.search = search
    api.getClientsPaged(params).then(({ rows, total }) => {
      setItems(prev => [...prev, ...rows])
      setTotalCount(total)
      setHasMore(items.length + rows.length < total)
      setLoadingMore(false)
    }).catch(() => setLoadingMore(false))
  }

  // Initial load - no auto-sync (would be too heavy with all leads)
  useEffect(() => {
    load()
    // Load last sync info
    authFetch('/api/sierra/sync-log').then(r => r.json()).then(logs => {
      if (logs.length > 0) setSyncLog(logs[0])
    })
    // Load Sierra lead counts so the button shows the total
    authFetch('/api/sierra/counts').then(r => r.json()).then(setSierraCounts).catch(() => {})
  }, [])

  // Close sync menu when clicking outside
  useEffect(() => {
    if (!syncMenuOpen) return
    const close = () => setSyncMenuOpen(false)
    setTimeout(() => document.addEventListener('click', close), 0)
    return () => document.removeEventListener('click', close)
  }, [syncMenuOpen])

  // Close other-status menu when clicking outside
  useEffect(() => {
    if (!otherMenuOpen) return
    const close = () => setOtherMenuOpen(false)
    setTimeout(() => document.addEventListener('click', close), 0)
    return () => document.removeEventListener('click', close)
  }, [otherMenuOpen])

  useEffect(() => { load(); setSelectedIds(new Set()) }, [filter, search, tab, pageSize, advFilters])

  const syncSierra = async (silent = false, statuses = 'Active,Prime,Watch,Pending') => {
    setSierraStatus('syncing')
    setSyncMenuOpen(false)
    try {
      // Kick off background sync
      const r = await authFetch(`/api/sierra/sync?statuses=${encodeURIComponent(statuses)}`, { method: 'POST' })
      const d = await r.json()
      if (d.error) {
        setSierraStatus({ error: d.error })
        if (!silent) alert('Sierra sync error: ' + d.error)
        return
      }

      // Poll for progress every 2 seconds
      const poll = setInterval(async () => {
        try {
          const sr = await authFetch('/api/sierra/sync-status')
          const status = await sr.json()
          if (status.running) {
            setSierraStatus({ syncing: true, progress: status.progress })
          } else {
            clearInterval(poll)
            if (status.error) {
              setSierraStatus({ error: status.error })
            } else if (status.lastResult) {
              setSierraStatus(status.lastResult)
              setSyncLog({
                leads_synced: status.lastResult.total_synced,
                leads_added: status.lastResult.added,
                leads_updated: status.lastResult.updated,
                synced_at: status.lastResult.finishedAt,
              })
              load()
            }
          }
        } catch (e) {
          clearInterval(poll)
        }
      }, 2000)
    } catch (e) {
      setSierraStatus({ error: e.message })
      if (!silent) alert('Sync failed: ' + e.message)
    }
  }

  const openNew = () => { setEditing(null); setForm(emptyClient); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    setForm({ ...emptyClient, ...Object.fromEntries(Object.entries(item).filter(([k, v]) => v !== null && k in emptyClient)) })
    setModalOpen(true)
  }
  const [sierraActivity, setSierraActivity] = useState(null)
  const [emailHistory, setEmailHistory] = useState([])
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [emailForm, setEmailForm] = useState({ subject: '', body: '', template: '' })
  const [emailTemplates, setEmailTemplates] = useState([])
  const [sending, setSending] = useState(false)

  // Load email templates on mount
  useEffect(() => {
    authFetch('/api/email/templates').then(r => r.json()).then(setEmailTemplates).catch(() => {})
  }, [])

  const openDetail = async (id) => {
    const d = await api.getClient(id)
    setDetail(d)
    setSierraActivity(null)
    setEmailHistory([])
    setDetailOpen(true)
    // Lazy-load Sierra activity if it's a Sierra-synced lead
    if (d.sierra_lead_id) {
      authFetch(`/api/sierra/lead-notes/${d.sierra_lead_id}`)
        .then(r => r.json())
        .then(setSierraActivity)
        .catch(() => setSierraActivity([]))
    }
    // Load email history
    authFetch(`/api/email/history/${id}`).then(r => r.json()).then(setEmailHistory).catch(() => {})
  }

  const openEmailComposer = (templateId = '') => {
    if (templateId && detail) {
      authFetch(`/api/email/preview/${templateId}/${detail.id}`)
        .then(r => r.json())
        .then(d => setEmailForm({ subject: d.subject, body: d.body, template: templateId }))
    } else {
      setEmailForm({ subject: '', body: '', template: '' })
    }
    setEmailModalOpen(true)
  }

  // Toggle a value in an array filter
  const toggleArrayFilter = (key, value) => {
    setAdvFilters(prev => {
      const arr = prev[key] || []
      const next = arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value]
      return { ...prev, [key]: next }
    })
  }

  const clearAllFilters = () => {
    setAdvFilters({
      statuses_include: [], statuses_exclude: [],
      tags_include: [], tags_exclude: [],
      zips_include: [], cities_include: [], sources_include: [],
      has_email: false, exclude_optouts: false,
      score_min: '', score_max: '', visits_min: '',
    })
    setTab('all')
    setSearch('')
    setActiveListId(null)
  }

  const saveAsList = async () => {
    if (!newListName.trim()) return alert('Please enter a list name')
    const filter_criteria = { ...advFilters }
    if (tab !== 'all') filter_criteria.statuses_include = [...(filter_criteria.statuses_include || []), tab]
    if (search) filter_criteria.search = search
    const r = await authFetch('/api/lists', {
      method: 'POST',
      body: JSON.stringify({
        name: newListName.trim(),
        description: `Filter-based list (${totalCount} matches at creation)`,
        filter_criteria,
        is_dynamic: true,
      }),
    })
    const d = await r.json()
    if (d.id) {
      alert(`List "${newListName}" saved`)
      setNewListName('')
      setSaveListOpen(false)
      authFetch('/api/lists').then(r => r.json()).then(setSavedLists)
    }
  }

  const loadSavedList = async (listId) => {
    if (!listId) {
      clearAllFilters()
      return
    }
    const r = await authFetch(`/api/lists/${listId}`)
    const list = await r.json()
    if (list.filter_criteria) {
      try {
        const f = JSON.parse(list.filter_criteria)
        setAdvFilters({
          statuses_include: f.statuses_include || [],
          statuses_exclude: f.statuses_exclude || [],
          tags_include: f.tags_include || [],
          tags_exclude: f.tags_exclude || [],
          zips_include: f.zips_include || [],
          cities_include: f.cities_include || [],
          sources_include: f.sources_include || [],
          has_email: !!f.has_email,
          exclude_optouts: !!f.exclude_optouts,
          score_min: f.score_min || '',
          score_max: f.score_max || '',
          visits_min: f.visits_min || '',
        })
        setTab('all')
        if (f.search) setSearch(f.search)
      } catch {}
    }
    setActiveListId(listId)
  }

  const deleteSavedList = async (listId) => {
    if (!confirm('Delete this list?')) return
    await authFetch(`/api/lists/${listId}`, { method: 'DELETE' })
    setSavedLists(prev => prev.filter(l => l.id !== listId))
    if (activeListId === listId) setActiveListId(null)
  }

  // Mass selection helpers
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  const selectAllVisible = () => {
    setSelectedIds(new Set(items.map(i => i.id)))
  }
  const selectAllFiltered = async (limit) => {
    const params = new URLSearchParams()
    if (filter.type) params.set('type', filter.type)
    if (tab !== 'all') params.set('status', tab)
    if (search) params.set('search', search)
    params.set('limit', limit)
    const r = await authFetch('/api/clients/ids?' + params)
    const d = await r.json()
    setSelectedIds(new Set(d.ids))
    alert(`Selected ${d.count} client${d.count !== 1 ? 's' : ''} with valid emails`)
  }
  const clearSelection = () => setSelectedIds(new Set())

  const openBulkEmail = (templateId = '') => {
    if (templateId) {
      const t = emailTemplates.find(x => x.id === templateId)
      if (t) {
        setBulkEmailForm({ subject: t.subject, body: t.body, template: templateId })
      }
    } else {
      setBulkEmailForm({ subject: '', body: '', template: '' })
    }
    setBulkEmailOpen(true)
  }

  const sendBulkEmail = async (e) => {
    e.preventDefault()
    if (selectedIds.size === 0) return alert('No clients selected')
    if (!confirm(`Send this email to ${selectedIds.size} clients?`)) return
    setBulkSending(true)
    try {
      const r = await authFetch('/api/email/bulk', {
        method: 'POST',
        body: JSON.stringify({
          client_ids: Array.from(selectedIds),
          subject: bulkEmailForm.subject,
          body: bulkEmailForm.body,
          template: bulkEmailForm.template,
        }),
      })
      const d = await r.json()
      if (d.error) {
        alert('Bulk send error: ' + d.error)
      } else {
        alert(`Bulk send complete: ${d.sent} sent, ${d.failed} failed, ${d.skipped} skipped`)
        setBulkEmailOpen(false)
        setSelectedIds(new Set())
      }
    } catch (err) {
      alert('Send failed: ' + err.message)
    }
    setBulkSending(false)
  }

  const sendEmail = async (e) => {
    e.preventDefault()
    if (!detail.email) { alert('No email address for this client'); return }
    setSending(true)
    try {
      const r = await authFetch('/api/email/send', {
        method: 'POST',
        body: JSON.stringify({
          client_id: detail.id,
          subject: emailForm.subject,
          body: emailForm.body,
          template: emailForm.template,
        }),
      })
      const d = await r.json()
      if (d.error) {
        alert('Send failed: ' + d.error)
      } else {
        alert('Email sent!')
        setEmailModalOpen(false)
        // Refresh history
        authFetch(`/api/email/history/${detail.id}`).then(r => r.json()).then(setEmailHistory)
      }
    } catch (err) {
      alert('Send failed: ' + err.message)
    }
    setSending(false)
  }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form }
    ;['budget_min', 'budget_max', 'preapproval_amount'].forEach(k => {
      if (data[k] === '') data[k] = null
      else if (data[k]) data[k] = Number(data[k])
    })
    if (editing) await api.updateClient(editing, data)
    else await api.createClient(data)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this client?')) return
    await api.deleteClient(id)
    load()
  }

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const formatCurrency = (n) => n ? `$${Number(n).toLocaleString()}` : ''

  // Quick actions
  const addToPreListing = async (client, e) => {
    if (e) e.stopPropagation()
    const address = client.address
      ? `${client.address}${client.city ? ', ' + client.city : ''}${client.state ? ', ' + client.state : ''}${client.zip ? ' ' + client.zip : ''}`
      : ''
    const addr = prompt('Property address for pre-listing:', address)
    if (!addr) return
    await authFetch('/api/pre-listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        property_address: addr,
        owner_name: `${client.first_name} ${client.last_name}`,
        client_id: client.id,
        status: 'New',
        walkthrough: 'Not Scheduled'
      })
    })
    alert(`${client.first_name} ${client.last_name} added to Pre-Listings`)
    if (detail) openDetail(client.id)
  }

  const addTransaction = async (client, type, e, propStatus = 'Under Contract') => {
    if (e) e.stopPropagation()
    const address = client.address
      ? `${client.address}${client.city ? ', ' + client.city : ''}${client.state ? ', ' + client.state : ''}${client.zip ? ' ' + client.zip : ''}`
      : ''
    const addr = prompt(`Property address for ${type}:`, address)
    if (!addr) return
    const txData = {
      property_address: addr,
      type: type,
      property_status: propStatus,
      client_id: client.id,
      buyer_name: type === 'purchase' ? `${client.first_name} ${client.last_name}` : '',
      seller_name: type === 'listing' ? `${client.first_name} ${client.last_name}` : '',
      buyers_agent_name: type === 'purchase' ? (client.agent_assigned || 'Matt Smith') : '',
      sellers_agent_name: type === 'listing' ? (client.agent_assigned || 'Matt Smith') : '',
      agency_type: type === 'purchase' ? "Buyer's Agent" : 'Listing Agent',
    }
    await api.createTransaction(txData)
    // Update client status only when going under contract
    if (propStatus === 'Under Contract') {
      await api.updateClient(client.id, { status: 'under_contract' })
    }
    const label = propStatus === 'Active' ? 'Active Listing' : (type === 'purchase' ? 'Purchase' : 'Listing')
    alert(`${label} created for ${client.first_name} ${client.last_name}`)
    load()
    if (detail) openDetail(client.id)
  }

  // Status counts for tabs (loaded from server, all statuses)
  // Only run on initial load + when sync completes - NOT every items change
  useEffect(() => {
    authFetch('/api/clients/status-counts').then(r => r.json()).then(setStatusCounts).catch(() => {})
    // Get total count + buyer/seller breakdown via lightweight server query (not 45K rows!)
    authFetch('/api/clients/breakdown').then(r => r.json()).then(setAllCounts).catch(() => {})
  }, [])

  // Color and order for status tabs - always show all Sierra statuses
  const statusColors = {
    prime: '#f59e0b', active: '#3b82f6', new: '#a78bfa', qualify: '#a78bfa',
    watch: '#06b6d4', pending: '#8b5cf6', closed: '#10b981', archived: '#6b7280',
    junk: '#6b7280', donotcontact: '#ef4444', blocked: '#ef4444',
    potential: '#a78bfa', under_contract: '#8b5cf6', on_hold: '#6b7280',
  }
  // Primary tabs (always visible) and "Other" tabs (in dropdown)
  const PRIMARY_STATUSES = ['prime', 'active', 'new', 'qualify', 'pending', 'watch', 'closed']
  const OTHER_STATUSES = ['archived', 'donotcontact', 'junk', 'blocked']
  const ALL_STATUSES = [...PRIMARY_STATUSES, ...OTHER_STATUSES]
  useEffect(() => { localStorage.setItem('clients_view', view) }, [view])

  // Build the tabs list: combine all known statuses + any extras from DB, with counts
  const countsMap = Object.fromEntries(statusCounts.map(s => [s.status, s.count]))
  const primaryTabs = PRIMARY_STATUSES.map(s => ({ status: s, count: countsMap[s] || 0 }))
  const otherTabs = OTHER_STATUSES.map(s => ({ status: s, count: countsMap[s] || 0 }))
  const otherTotal = otherTabs.reduce((sum, t) => sum + t.count, 0)
  const isOtherTab = OTHER_STATUSES.includes(tab)

  const formatStatus = (s) => {
    if (s === 'donotcontact') return 'Do Not Contact'
    return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }

  return (
    <div className={`page ${view === 'list' ? 'page-wide' : ''}`}>
      <div className="page-header">
        <div>
          <h1>Clients</h1>
          <p className="page-subtitle">All leads (buyers + sellers) synced from Sierra Interactive</p>
        </div>
        <div className="header-actions">
          <div className="view-toggle">
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
            <button className={view === 'card' ? 'active' : ''} onClick={() => setView('card')}>Cards</button>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => syncSierra(false, 'all')}
            disabled={sierraStatus === 'syncing'}
            title="Pulls every Sierra lead - all statuses"
          >
            {sierraStatus === 'syncing' ? 'Syncing Sierra...' : `Sync All Sierra Leads${sierraCounts ? ` (${sierraCounts.total.toLocaleString()})` : ''}`}
          </button>
          <button className="btn btn-secondary" onClick={openNew}>+ Add Manually</button>
        </div>
      </div>

      {/* Sierra Sync Status Bar */}
      <div className="sierra-status-bar">
        {sierraStatus === 'syncing' && (
          <div className="sierra-banner syncing">Starting Sierra sync...</div>
        )}
        {sierraStatus && sierraStatus.syncing && sierraStatus.progress && (
          <div className="sierra-banner syncing">
            Syncing Sierra leads... {sierraStatus.progress.synced} synced
            {sierraStatus.progress.currentStatus ? ` (currently: ${sierraStatus.progress.currentStatus})` : ''}
          </div>
        )}
        {sierraStatus && sierraStatus.total_synced !== undefined && (
          <div className="sierra-banner success">
            Sierra sync complete: {sierraStatus.total_synced} leads synced ({sierraStatus.added} new, {sierraStatus.updated} updated)
          </div>
        )}
        {sierraStatus && sierraStatus.error && (
          <div className="sierra-banner error">Sierra sync error: {sierraStatus.error}</div>
        )}
        {syncLog && !sierraStatus && (
          <div className="sierra-banner info">
            Last sync: {new Date(syncLog.synced_at).toLocaleString()} — {syncLog.leads_synced} leads
          </div>
        )}
      </div>

      {/* Status Tabs - primary statuses always visible, others in dropdown */}
      <div className="client-tabs">
        {primaryTabs.map(s => (
          <button
            key={s.status}
            className={`client-tab ${tab === s.status ? 'active' : ''}`}
            onClick={() => setTab(s.status)}
          >
            <span className="tab-dot" style={{ background: statusColors[s.status] || '#6b7280' }}></span>
            {formatStatus(s.status)}
            <span className="tab-count">{s.count}</span>
          </button>
        ))}

        {/* Other dropdown */}
        <div className="other-tab-wrap" onClick={e => e.stopPropagation()}>
          <button
            className={`client-tab ${isOtherTab ? 'active' : ''}`}
            onClick={() => setOtherMenuOpen(!otherMenuOpen)}
          >
            <span className="tab-dot" style={{ background: '#6b7280' }}></span>
            {isOtherTab ? formatStatus(tab) : 'Other'} <span className="tab-count">{isOtherTab ? (countsMap[tab] || 0) : otherTotal}</span>
            <span style={{marginLeft: 4, fontSize: 10}}>▾</span>
          </button>
          {otherMenuOpen && (
            <div className="other-menu">
              {otherTabs.map(s => (
                <button
                  key={s.status}
                  className={`other-menu-item ${tab === s.status ? 'active' : ''}`}
                  onClick={() => { setTab(s.status); setOtherMenuOpen(false) }}
                >
                  <span className="tab-dot" style={{ background: statusColors[s.status] || '#6b7280' }}></span>
                  <span style={{flex: 1}}>{formatStatus(s.status)}</span>
                  <span className="tab-count">{s.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button className={`client-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
          All
          <span className="tab-count">{allCounts.total}</span>
        </button>
      </div>


      <div className="toolbar">
        <input type="text" placeholder="Search name, email, phone, address, city, zip..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
        <select value={activeListId || ''} onChange={e => loadSavedList(e.target.value ? Number(e.target.value) : null)} title="Saved lists">
          <option value="">— Saved Lists —</option>
          {savedLists.map(l => (
            <option key={l.id} value={l.id}>{l.name} ({l.count})</option>
          ))}
        </select>
        <button className="btn btn-secondary" onClick={() => setFilterPanelOpen(!filterPanelOpen)}>
          Filters{advFilterCount > 0 ? ` (${advFilterCount})` : ''}
        </button>
        {hasActiveFilters && (
          <button className="btn btn-secondary" onClick={() => setSaveListOpen(true)}>
            Save as List
          </button>
        )}
        {hasActiveFilters && (
          <button className="btn-sm btn-danger" onClick={clearAllFilters}>Clear All</button>
        )}
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} title="Records per page">
          <option value={100}>100 per page</option>
          <option value={500}>500 per page</option>
          <option value={1000}>1,000 per page</option>
          <option value={2000}>2,000 per page</option>
        </select>
      </div>

      {/* Advanced Filter Panel */}
      {filterPanelOpen && (
        <div className="filter-panel">
          <div className="filter-section">
            <h5>Status (Include)</h5>
            <div className="filter-chips">
              {ALL_STATUSES.map(s => (
                <button key={s} type="button"
                  className={`filter-chip ${advFilters.statuses_include.includes(s) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('statuses_include', s)}>
                  {formatStatus(s)}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Status (Exclude)</h5>
            <div className="filter-chips">
              {ALL_STATUSES.map(s => (
                <button key={s} type="button"
                  className={`filter-chip exclude ${advFilters.statuses_exclude.includes(s) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('statuses_exclude', s)}>
                  {formatStatus(s)}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Tags (Include) — top 30 most used</h5>
            <div className="filter-chips">
              {filterOptions.tags.slice(0, 30).map(t => (
                <button key={t.tag} type="button"
                  className={`filter-chip ${advFilters.tags_include.includes(t.tag) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('tags_include', t.tag)}>
                  {t.tag} <span style={{opacity: 0.6}}>({t.count})</span>
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Tags (Exclude)</h5>
            <div className="filter-chips">
              {filterOptions.tags.slice(0, 20).map(t => (
                <button key={t.tag} type="button"
                  className={`filter-chip exclude ${advFilters.tags_exclude.includes(t.tag) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('tags_exclude', t.tag)}>
                  {t.tag}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Zip Codes</h5>
            <div className="filter-chips">
              {filterOptions.zips.slice(0, 30).map(z => (
                <button key={z} type="button"
                  className={`filter-chip ${advFilters.zips_include.includes(z) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('zips_include', z)}>
                  {z}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Cities</h5>
            <div className="filter-chips">
              {filterOptions.cities.slice(0, 20).map(c => (
                <button key={c} type="button"
                  className={`filter-chip ${advFilters.cities_include.includes(c) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('cities_include', c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Sources</h5>
            <div className="filter-chips">
              {filterOptions.sources.slice(0, 20).map(s => (
                <button key={s} type="button"
                  className={`filter-chip ${advFilters.sources_include.includes(s) ? 'active' : ''}`}
                  onClick={() => toggleArrayFilter('sources_include', s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
          <div className="filter-section">
            <h5>Other</h5>
            <div className="filter-row" style={{display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap'}}>
              <label className="checkbox-label" style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6}}>
                <input type="checkbox" checked={advFilters.has_email} onChange={e => setAdvFilters(p => ({ ...p, has_email: e.target.checked }))} />
                Has email
              </label>
              <label className="checkbox-label" style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6}}>
                <input type="checkbox" checked={advFilters.exclude_optouts} onChange={e => setAdvFilters(p => ({ ...p, exclude_optouts: e.target.checked }))} />
                Exclude opt-outs
              </label>
              <label style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6}}>
                Score min:
                <input type="number" value={advFilters.score_min} onChange={e => setAdvFilters(p => ({ ...p, score_min: e.target.value }))} style={{width: 80}} />
              </label>
              <label style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6}}>
                Score max:
                <input type="number" value={advFilters.score_max} onChange={e => setAdvFilters(p => ({ ...p, score_max: e.target.value }))} style={{width: 80}} />
              </label>
              <label style={{display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6}}>
                Min visits:
                <input type="number" value={advFilters.visits_min} onChange={e => setAdvFilters(p => ({ ...p, visits_min: e.target.value }))} style={{width: 80}} />
              </label>
            </div>
          </div>
          {activeListId && (
            <div style={{textAlign: 'right', paddingTop: 8}}>
              <button className="btn-sm btn-danger" onClick={() => deleteSavedList(activeListId)}>Delete this list</button>
            </div>
          )}
        </div>
      )}

      {/* Save as List Modal */}
      {saveListOpen && (
        <Modal open={saveListOpen} onClose={() => setSaveListOpen(false)} title="Save as List">
          <p style={{fontSize: 13, color: 'var(--text-muted)'}}>
            Save the current filters as a reusable list. Matches {totalCount.toLocaleString()} clients right now.
            The list updates dynamically — new leads matching the filter will appear automatically.
          </p>
          <label>List Name<input value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="e.g. Cedar Rapids Sellers Off Market" autoFocus /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setSaveListOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={saveAsList}>Save List</button>
          </div>
        </Modal>
      )}

      {/* Mass action bar */}
      <div className="mass-action-bar">
        <div className="mass-action-left">
          <button className="btn btn-sm btn-secondary" onClick={selectAllVisible}>
            Select Visible ({items.length})
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => selectAllFiltered(500)}>
            Select 500
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => selectAllFiltered(1000)}>
            Select 1,000
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => selectAllFiltered(2000)}>
            Select 2,000
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => selectAllFiltered(5000)}>
            Select All Filtered
          </button>
          {selectedIds.size > 0 && (
            <button className="btn btn-sm btn-danger" onClick={clearSelection}>
              Clear ({selectedIds.size})
            </button>
          )}
        </div>
        {selectedIds.size > 0 && (
          <div className="mass-action-right">
            <span className="mass-action-count">{selectedIds.size} selected</span>
            <button className="btn btn-primary btn-sm" onClick={() => openBulkEmail()}>
              Email Selected
            </button>
          </div>
        )}
      </div>

      {/* Client List View */}
      {view === 'list' && items.length === 0 && (
        <div className="empty-state-full">
          {sierraStatus === 'syncing' ? 'Syncing clients from Sierra...' : 'No clients found in this status. Try another tab or sync from Sierra.'}
        </div>
      )}
      {view === 'list' && items.length > 0 && (
        <div className="client-list">
          <div className="client-list-header">
            <div className="cl-check">
              <input type="checkbox"
                checked={items.length > 0 && items.every(i => selectedIds.has(i.id))}
                onChange={e => {
                  if (e.target.checked) selectAllVisible()
                  else clearSelection()
                }} />
            </div>
            <div className="cl-score">Score</div>
            <div className="cl-name">Name</div>
            <div className="cl-status">Status</div>
            <div className="cl-phone">Phone</div>
            <div className="cl-email">Email</div>
            <div className="cl-address">Address</div>
            <div className="cl-budget">Budget</div>
            <div className="cl-visits">Visits</div>
            <div className="cl-source">Source</div>
            <div className="cl-actions">Actions</div>
          </div>
          {items.map(item => (
            <div key={item.id} className={`client-list-row ${selectedIds.has(item.id) ? 'selected' : ''}`} onClick={() => openDetail(item.id)}>
              <div className="cl-check" onClick={e => e.stopPropagation()}>
                <input type="checkbox"
                  checked={selectedIds.has(item.id)}
                  onChange={() => toggleSelect(item.id)} />
              </div>
              <div className="cl-score">
                {item.lead_score !== null && item.lead_score !== undefined ? (
                  <span className={`lead-score grade-${(item.lead_grade || 'F').replace('+','plus').toLowerCase()}`}>
                    {item.lead_score}
                    {item.lead_grade && <span className="lead-grade">{item.lead_grade}</span>}
                  </span>
                ) : <span className="lead-score-empty">—</span>}
              </div>
              <div className="cl-name">
                <strong>{item.first_name} {item.last_name}</strong>
                {item.sierra_lead_id && <span className="sierra-tag">Sierra</span>}
                {item.tags && (() => {
                  try {
                    const tagList = JSON.parse(item.tags)
                    return tagList.slice(0, 2).map((t, i) => <span key={i} className="lead-tag">{t}</span>)
                  } catch { return null }
                })()}
              </div>
              <div className="cl-status"><StatusBadge status={item.status} /></div>
              <div className="cl-phone">{item.phone || '—'}</div>
              <div className="cl-email">
                {item.email || '—'}
                {item.email_status && item.email_status !== 'Unknown' && <span className="email-status-tag">{item.email_status}</span>}
              </div>
              <div className="cl-address">
                {item.address ? `${item.address}${item.city ? ', ' + item.city : ''}` : item.city || '—'}
              </div>
              <div className="cl-budget">
                {item.budget_min || item.budget_max
                  ? `${formatCurrency(item.budget_min) || '?'} - ${formatCurrency(item.budget_max) || '?'}`
                  : '—'}
              </div>
              <div className="cl-visits">{item.visits || 0}</div>
              <div className="cl-source">{item.source || '—'}</div>
              <div className="cl-actions" onClick={e => e.stopPropagation()}>
                <button className="action-btn action-prelisting" title="Add to Pre-Listing" onClick={e => addToPreListing(item, e)}>PL</button>
                <button className="action-btn action-active-listing" title="Active Listing (live on MLS)" onClick={e => addTransaction(item, 'listing', e, 'Active')}>AL</button>
                <button className="action-btn action-purchase" title="Purchase Under Contract" onClick={e => addTransaction(item, 'purchase', e)}>P</button>
                <button className="action-btn action-listing" title="Listing Under Contract" onClick={e => addTransaction(item, 'listing', e)}>L</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Client Cards */}
      {view === 'card' && (
      <div className="client-grid">
        {items.length === 0 ? (
          <div className="empty-state-full">
            {sierraStatus === 'syncing' ? 'Syncing clients from Sierra...' : 'No clients found. Sync from Sierra or add one manually.'}
          </div>
        ) : items.map(item => (
          <div key={item.id} className="client-card" onClick={() => openDetail(item.id)}>
            <div className="client-card-header">
              <div className="client-avatar" style={{background: item.sierra_lead_id ? '#8b5cf6' : '#3b82f6'}}>
                {item.first_name?.[0]}{item.last_name?.[0]}
              </div>
              <div style={{flex: 1}}>
                <div className="client-name">{item.first_name} {item.last_name}</div>
                <div className="client-type">
                  <span className={`client-type-badge type-${item.type}`}>{item.type}</span>
                  {item.sierra_lead_id && <span className="sierra-tag">Sierra</span>}
                </div>
              </div>
              {item.lead_score !== null && item.lead_score !== undefined && (
                <span className={`lead-score grade-${(item.lead_grade || 'F').replace('+','plus').toLowerCase()}`}>
                  {item.lead_score}
                  {item.lead_grade && <span className="lead-grade">{item.lead_grade}</span>}
                </span>
              )}
            </div>
            <div className="client-card-body">
              {item.phone && <div className="client-info">{item.phone}</div>}
              {item.email && <div className="client-info">{item.email}</div>}
              {(item.address || item.city) && (
                <div className="client-info">
                  {item.address}{item.address && item.city ? ', ' : ''}{item.city}{item.state ? `, ${item.state}` : ''}{item.zip ? ` ${item.zip}` : ''}
                </div>
              )}
              {item.source && <div className="client-info" style={{color: 'var(--text-muted)'}}>Source: {item.source}</div>}
              {(item.budget_min || item.budget_max) && (
                <div className="client-info budget">
                  {formatCurrency(item.budget_min)} - {formatCurrency(item.budget_max)}
                </div>
              )}
            </div>
            <div className="client-card-footer">
              <StatusBadge status={item.status} />
              {item.agent_assigned && <span className="client-agent">{item.agent_assigned}</span>}
            </div>
            <div className="client-actions" onClick={e => e.stopPropagation()}>
              <button className="action-btn action-prelisting" onClick={e => addToPreListing(item, e)} title="Add to Pre-Listings">
                Pre-List
              </button>
              <button className="action-btn action-active-listing" onClick={e => addTransaction(item, 'listing', e, 'Active')} title="Active Listing (live on MLS)">
                Active
              </button>
              <button className="action-btn action-purchase" onClick={e => addTransaction(item, 'purchase', e)} title="Purchase Under Contract">
                Purchase
              </button>
              <button className="action-btn action-listing" onClick={e => addTransaction(item, 'listing', e)} title="Listing Under Contract">
                Listing
              </button>
            </div>
          </div>
        ))}
      </div>
      )}

      {/* Load More */}
      {hasMore && (
        <div style={{textAlign: 'center', marginTop: 20}}>
          <button className="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading...' : `Load More (${totalCount - items.length} remaining)`}
          </button>
        </div>
      )}

      {/* Detail Modal */}
      <Modal open={detailOpen} onClose={() => setDetailOpen(false)} title={detail ? `${detail.first_name} ${detail.last_name}` : ''} wide>
        {detail && (
          <div className="detail-view">
            <div className="detail-grid">
              <div className="detail-section">
                <h4>Contact Info</h4>
                <p><strong>Phone:</strong> {detail.phone || '—'} {detail.phone_status && detail.phone_status !== 'Unknown' && <span className="email-status-tag">{detail.phone_status}</span>}</p>
                <p><strong>Email:</strong> {detail.email || '—'} {detail.email_status && detail.email_status !== 'Unknown' && <span className="email-status-tag">{detail.email_status}</span>}</p>
                <p><strong>Address:</strong> {detail.address || '—'}</p>
                <p><strong>City:</strong> {detail.city || '—'}{detail.state ? `, ${detail.state}` : ''} {detail.zip || ''}</p>
                <p><strong>Source:</strong> {detail.source || '—'}</p>
                <p><strong>Agent:</strong> {detail.agent_assigned || '—'}</p>
                {detail.marketing_email_opt_out ? <p style={{color: '#ef4444'}}><strong>Email Opt-Out:</strong> Yes</p> : null}
                {detail.text_opt_out ? <p style={{color: '#ef4444'}}><strong>Text Opt-Out:</strong> Yes</p> : null}
                {detail.sierra_lead_id && <p><strong>Sierra ID:</strong> {detail.sierra_lead_id}</p>}
              </div>
              <div className="detail-section">
                <h4>Activity & Engagement</h4>
                <p><strong>Website Visits:</strong> {detail.visits || 0}</p>
                {detail.lead_score && <p><strong>Realist Score:</strong> {detail.lead_score} {detail.lead_grade && <span className="email-status-tag">{detail.lead_grade}</span>}</p>}
                <p><strong>Budget:</strong> {formatCurrency(detail.budget_min)} - {formatCurrency(detail.budget_max)}</p>
                {detail.lender_name && <p><strong>Lender:</strong> {detail.lender_name} {detail.lender_status && <span className="email-status-tag">{detail.lender_status}</span>}</p>}
                {detail.listing_agent_status && detail.listing_agent_status !== 'None' && <p><strong>Listing Status:</strong> {detail.listing_agent_status}</p>}
                {detail.short_summary && <p style={{fontSize: 12, color: 'var(--text-muted)', marginTop: 8}}>{detail.short_summary}</p>}
                {detail.sierra_creation_date && <p style={{fontSize: 11, color: 'var(--text-muted)'}}>Created: {detail.sierra_creation_date.split('T')[0]}</p>}
                {detail.sierra_update_date && <p style={{fontSize: 11, color: 'var(--text-muted)'}}>Last Update: {detail.sierra_update_date.split('T')[0]}</p>}
              </div>
            </div>

            {/* Tags */}
            {detail.tags && (() => {
              let tagList = []
              try { tagList = JSON.parse(detail.tags) } catch {}
              if (!tagList.length) return null
              return (
                <div className="detail-section">
                  <h4>Tags ({tagList.length})</h4>
                  <div className="lead-tags-list">
                    {tagList.map((t, i) => <span key={i} className="lead-tag">{t}</span>)}
                  </div>
                </div>
              )
            })()}

            {/* Sierra Activity Log */}
            {detail.sierra_lead_id && (
              <div className="detail-section">
                <h4>Sierra Activity {sierraActivity && `(${sierraActivity.length})`}</h4>
                {sierraActivity === null ? (
                  <p style={{fontSize: 12, color: 'var(--text-muted)'}}>Loading activity...</p>
                ) : sierraActivity.length === 0 ? (
                  <p style={{fontSize: 12, color: 'var(--text-muted)'}}>No activity recorded</p>
                ) : (
                  <div className="sierra-activity-feed">
                    {sierraActivity.slice(0, 20).map(a => (
                      <div key={a.id} className="sierra-activity-item">
                        <div className="sierra-activity-meta">
                          <span className="sierra-activity-author">{a.author}</span>
                          <span className="sierra-activity-date">{a.date ? new Date(a.date).toLocaleDateString() : ''}</span>
                        </div>
                        <div className="sierra-activity-content">{a.contents}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {detail.transactions?.length > 0 && (
              <div className="detail-section">
                <h4>Transactions ({detail.transactions.length})</h4>
                {detail.transactions.map(t => (
                  <div key={t.id} className="mini-row">
                    <span>{t.property_address || t.address}</span>
                    <StatusBadge status={(t.property_status || t.status || '').toLowerCase().replace(/ /g, '_')} />
                  </div>
                ))}
              </div>
            )}

            {detail.showings?.length > 0 && (
              <div className="detail-section">
                <h4>Showings ({detail.showings.length})</h4>
                {detail.showings.map(s => (
                  <div key={s.id} className="mini-row">
                    <span>{s.address} — {s.showing_date}</span>
                    {s.interest_level && <StatusBadge status={s.interest_level} />}
                  </div>
                ))}
              </div>
            )}

            {detail.notes && <div className="detail-section"><h4>Notes</h4><p>{detail.notes}</p></div>}

            {/* Email section */}
            {detail.email && !detail.marketing_email_opt_out && (
              <div className="detail-section">
                <h4>Email</h4>
                <div className="email-templates">
                  <button className="btn btn-primary btn-sm" onClick={() => openEmailComposer('')}>
                    Compose Email
                  </button>
                  {emailTemplates.map(t => (
                    <button key={t.id} className="btn btn-secondary btn-sm" onClick={() => openEmailComposer(t.id)}>
                      {t.name}
                    </button>
                  ))}
                </div>
                {emailHistory.length > 0 && (
                  <div className="email-history">
                    <div style={{fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 4px'}}>
                      {emailHistory.length} email{emailHistory.length !== 1 ? 's' : ''} sent
                    </div>
                    {emailHistory.slice(0, 5).map(e => (
                      <div key={e.id} className="email-history-item">
                        <div className="email-history-meta">
                          <span style={{color: e.status === 'sent' ? '#10b981' : '#ef4444'}}>{e.status === 'sent' ? '✓' : '✗'}</span>
                          <span>{e.subject}</span>
                          <span className="email-history-date">{new Date(e.sent_at).toLocaleDateString()}</span>
                        </div>
                        {e.error && <div className="email-error">{e.error}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Quick Actions */}
            <div className="detail-section">
              <h4>Quick Actions</h4>
              <div className="detail-actions-grid">
                <button className="detail-action-btn action-prelisting" onClick={() => addToPreListing(detail)}>
                  <span className="detail-action-icon">&#8962;</span>
                  <span>Add to Pre-Listing</span>
                  <span className="detail-action-desc">Start the seller pipeline</span>
                </button>
                <button className="detail-action-btn action-active-listing" onClick={() => addTransaction(detail, 'listing', null, 'Active')}>
                  <span className="detail-action-icon">&#9733;</span>
                  <span>Active Listing</span>
                  <span className="detail-action-desc">Listing live on MLS</span>
                </button>
                <button className="detail-action-btn action-purchase" onClick={() => addTransaction(detail, 'purchase')}>
                  <span className="detail-action-icon">&#8644;</span>
                  <span>Purchase - Under Contract</span>
                  <span className="detail-action-desc">Create a buyer transaction</span>
                </button>
                <button className="detail-action-btn action-listing" onClick={() => addTransaction(detail, 'listing')}>
                  <span className="detail-action-icon">&#9878;</span>
                  <span>Listing - Under Contract</span>
                  <span className="detail-action-desc">Create a seller transaction</span>
                </button>
              </div>
            </div>

            <div className="form-actions">
              <button className="btn btn-secondary" onClick={() => { setDetailOpen(false); openEdit(detail) }}>Edit Client</button>
              <button className="btn btn-danger" onClick={() => { remove(detail.id); setDetailOpen(false) }}>Delete</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Bulk Email Modal */}
      <Modal open={bulkEmailOpen} onClose={() => setBulkEmailOpen(false)} title={`Bulk Email — ${selectedIds.size} recipients`} wide>
        <form onSubmit={sendBulkEmail}>
          <div style={{padding: '10px 14px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: 6, fontSize: 13, marginBottom: 12}}>
            ⚠️ This will send to {selectedIds.size} clients. Opt-outs and invalid emails will be skipped automatically.
          </div>
          <label>Template<select value={bulkEmailForm.template} onChange={e => {
            const t = emailTemplates.find(x => x.id === e.target.value)
            if (t) {
              setBulkEmailForm({ subject: t.subject, body: t.body, template: t.id })
            } else {
              setBulkEmailForm(p => ({ ...p, template: '' }))
            }
          }}>
            <option value="">Custom (no template)</option>
            {emailTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
          <label>Subject<input value={bulkEmailForm.subject} onChange={e => setBulkEmailForm(p => ({ ...p, subject: e.target.value }))} required /></label>
          <label>Body<textarea value={bulkEmailForm.body} onChange={e => setBulkEmailForm(p => ({ ...p, body: e.target.value }))} rows={14} required /></label>
          <p style={{fontSize: 11, color: 'var(--text-muted)'}}>
            Variables auto-fill per recipient: {'{{first_name}} {{last_name}} {{address}} {{city}}'}
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setBulkEmailOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={bulkSending}>
              {bulkSending ? 'Sending...' : `Send to ${selectedIds.size} Recipients`}
            </button>
          </div>
        </form>
      </Modal>

      {/* Email Composer Modal */}
      <Modal open={emailModalOpen} onClose={() => setEmailModalOpen(false)} title={`Email ${detail?.first_name || ''} ${detail?.last_name || ''}`} wide>
        <form onSubmit={sendEmail}>
          <label>To<input value={detail?.email || ''} disabled /></label>
          <label>Template<select value={emailForm.template} onChange={e => {
            const t = emailTemplates.find(x => x.id === e.target.value)
            if (t && detail) {
              authFetch(`/api/email/preview/${t.id}/${detail.id}`).then(r => r.json()).then(d =>
                setEmailForm({ subject: d.subject, body: d.body, template: t.id }))
            } else {
              setEmailForm(p => ({ ...p, template: '' }))
            }
          }}>
            <option value="">Custom (no template)</option>
            {emailTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
          <label>Subject<input value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} required /></label>
          <label>Body<textarea value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} rows={12} required /></label>
          <p style={{fontSize: 11, color: 'var(--text-muted)'}}>
            Available variables: {'{{first_name}} {{last_name}} {{full_name}} {{address}} {{city}}'}
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEmailModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              {sending ? 'Sending...' : 'Send Email'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit/New Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Client' : 'New Client'} wide>
        <form onSubmit={save} className="form-grid">
          <div className="form-section">
            <h4>Basic Info</h4>
            <div className="form-row">
              <label>First Name<input value={form.first_name} onChange={e => f('first_name', e.target.value)} required /></label>
              <label>Last Name<input value={form.last_name} onChange={e => f('last_name', e.target.value)} required /></label>
            </div>
            <div className="form-row">
              <label>Email<input type="email" value={form.email} onChange={e => f('email', e.target.value)} /></label>
              <label>Phone<input value={form.phone} onChange={e => f('phone', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Type<select value={form.type} onChange={e => f('type', e.target.value)}>
                <option value="buyer">Buyer</option><option value="seller">Seller</option><option value="both">Both</option>
              </select></label>
              <label>Status<select value={form.status} onChange={e => f('status', e.target.value)}>
                <option value="active">Active</option><option value="prime">Prime</option><option value="potential">Potential</option>
                <option value="under_contract">Under Contract</option><option value="closed">Closed</option><option value="on_hold">On Hold</option>
              </select></label>
            </div>
          </div>

          <div className="form-section">
            <h4>Details</h4>
            <div className="form-row">
              <label>Address<input value={form.address} onChange={e => f('address', e.target.value)} /></label>
              <label>City<input value={form.city} onChange={e => f('city', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Source<input value={form.source} onChange={e => f('source', e.target.value)} placeholder="Zillow, Sierra, referral..." /></label>
              <label>Agent Assigned<input value={form.agent_assigned} onChange={e => f('agent_assigned', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Budget Min<input type="number" value={form.budget_min} onChange={e => f('budget_min', e.target.value)} /></label>
              <label>Budget Max<input type="number" value={form.budget_max} onChange={e => f('budget_max', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Pre-Approval Amount<input type="number" value={form.preapproval_amount} onChange={e => f('preapproval_amount', e.target.value)} /></label>
              <label>Pre-Approval Lender<input value={form.preapproval_lender} onChange={e => f('preapproval_lender', e.target.value)} /></label>
            </div>
          </div>

          <div className="form-section form-full">
            <label>Notes<textarea value={form.notes} onChange={e => f('notes', e.target.value)} rows={3} /></label>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Client</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
