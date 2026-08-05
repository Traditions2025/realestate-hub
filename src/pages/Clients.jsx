import React, { useState, useEffect, useRef } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import MultiSelect from '../components/MultiSelect'
import StatusBadge from '../components/StatusBadge'
import { inlineImagesIntoBody, autoEmbedYoutubeLinks } from '../components/inlineImages'
import EmailToolbar from '../components/EmailToolbar'
import RichTextEditor from '../components/RichTextEditor'

// Turn a bare mattsmithteam.com property link (pasted into an email) into a rich
// listing card — photo + address + MLS — like the listing previews. URLs already
// inside an href/src (e.g. the generated "Homes They Viewed" cards) are skipped.
function embedPropertyLinks(html) {
  if (!html) return html
  const re = /(?<!["'>])https?:\/\/(?:www\.)?mattsmithteam\.com\/property-search\/detail\/\d+\/(\d+)\/([a-z0-9-]+)\/?/gi
  return html.replace(re, (url, mls, slug) => {
    const addr = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    const photo = `https://cdn.listingphotos.sierrastatic.com/large/352/352_${mls}_01.jpg`
    return `<table cellpadding="0" cellspacing="0" style="width:100%;max-width:560px;margin:8px 0;border:1px solid #e2e8f0;border-radius:8px;"><tr>` +
      `<td valign="top" style="padding:12px;width:174px;"><a href="${url}"><img src="${photo}" width="150" alt="${addr}" style="width:150px;height:auto;border-radius:6px;display:block;border:0;"/></a></td>` +
      `<td valign="top" style="padding:12px 12px 12px 0;font-family:Arial,Helvetica,sans-serif;"><a href="${url}" style="color:#2563eb;font-weight:bold;font-size:15px;text-decoration:none;">${addr} | MLS ${mls}</a>` +
      `<div style="color:#475569;font-size:13px;margin-top:6px;">View this listing &rarr;</div></td></tr></table>`
  })
}

const emptyClient = {
  first_name: '', last_name: '', email: '', phone: '', type: 'buyer', status: 'active',
  source: '', agent_assigned: '', address: '', city: '', state: 'IA', zip: '',
  budget_min: '', budget_max: '', preapproval_amount: '', preapproval_lender: '', notes: ''
}

// Column config for the list view. Users toggle visibility + reorder via the
// "Columns" picker; prefs persist in localStorage. `key` matches sortable
// indicators and the CSS .cl-{key} class on each cell.
const LIST_COLUMNS = [
  { key: 'score',      label: 'Score',      defaultVisible: true,  fr: '0.5fr', sort: { asc: 'lowest_score',  desc: 'highest_score' } },
  { key: 'name',       label: 'Name',       defaultVisible: true,  fr: '1.4fr', sort: { asc: 'name_az',       desc: 'name_za' } },
  { key: 'status',     label: 'Status',     defaultVisible: true,  fr: '0.9fr' },
  { key: 'type',       label: 'Type',       defaultVisible: true,  fr: '0.9fr' },
  { key: 'phone',      label: 'Phone',      defaultVisible: true,  fr: '1fr' },
  { key: 'email',      label: 'Email',      defaultVisible: true,  fr: '1.6fr' },
  { key: 'address',    label: 'Address',    defaultVisible: true,  fr: '1.4fr' },
  { key: 'budget',     label: 'Budget',     defaultVisible: false, fr: '1.2fr' },
  { key: 'visits',     label: 'Visits',     defaultVisible: true,  fr: '0.5fr', sort: { asc: 'least_visits',  desc: 'most_visits' } },
  { key: 'source',     label: 'Source',     defaultVisible: true,  fr: '0.8fr' },
  { key: 'last_fub_visit', label: 'Last Visit', defaultVisible: true, fr: '1.3fr', sort: { asc: 'oldest_fub_visit', desc: 'recent_fub_visit' } },
  { key: 'registered', label: 'Registered', defaultVisible: true,  fr: '0.8fr', sort: { asc: 'oldest_first', desc: 'recent_added' } },
]
const COLUMN_PREFS_KEY = 'mst_clients_columns_v1'

function loadColumnPrefs() {
  try {
    const raw = localStorage.getItem(COLUMN_PREFS_KEY)
    if (!raw) throw new Error('no prefs')
    const parsed = JSON.parse(raw)
    // Validate: keep only known keys; append any new ones at the end
    const knownKeys = new Set(LIST_COLUMNS.map(c => c.key))
    const order = (parsed.order || []).filter(k => knownKeys.has(k))
    for (const c of LIST_COLUMNS) if (!order.includes(c.key)) order.push(c.key)
    const visible = {}
    for (const c of LIST_COLUMNS) visible[c.key] = parsed.visible && c.key in parsed.visible ? !!parsed.visible[c.key] : c.defaultVisible
    return { order, visible }
  } catch {
    return {
      order: LIST_COLUMNS.map(c => c.key),
      visible: Object.fromEntries(LIST_COLUMNS.map(c => [c.key, c.defaultVisible])),
    }
  }
}

// Sierra-aligned status list: { hubValue (lowercase_underscore), label, sierraValue }
// hubValue must match what the sync writes via mapStatus() and what the backend's
// HUB_TO_SIERRA_STATUS map keys on. Order = display order in the quick dropdown.
const SIERRA_STATUSES = [
  { value: 'prime',         label: 'Prime' },
  { value: 'active',        label: 'Active' },
  { value: 'new',           label: 'New' },
  { value: 'qualify',       label: 'Qualify' },
  { value: 'watch',         label: 'Watch' },
  { value: 'pending',       label: 'Pending' },
  { value: 'closed',        label: 'Closed' },
  { value: 'archived',      label: 'Archived' },
  { value: 'junk',          label: 'Junk' },
  { value: 'donotcontact',  label: 'Do Not Contact' },
  { value: 'blocked',       label: 'Blocked' },
]

export default function Clients() {
  const [items, setItems] = useState([])
  const [tab, setTab] = useState('all') // default to All; 'active', 'prime', 'all'
  const [filter, setFilter] = useState({ type: '' })
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [editingOriginal, setEditingOriginal] = useState(null)
  const [form, setForm] = useState(emptyClient)
  const [colPrefs, setColPrefs] = useState(loadColumnPrefs)
  const [columnsPickerOpen, setColumnsPickerOpen] = useState(false)
  const [dragColKey, setDragColKey] = useState(null)

  useEffect(() => {
    try { localStorage.setItem(COLUMN_PREFS_KEY, JSON.stringify(colPrefs)) } catch {}
  }, [colPrefs])

  const visibleColumns = colPrefs.order
    .map(k => LIST_COLUMNS.find(c => c.key === k))
    .filter(c => c && colPrefs.visible[c.key])

  const toggleColumn = (key) => setColPrefs(p => ({ ...p, visible: { ...p.visible, [key]: !p.visible[key] } }))
  const reorderColumn = (fromKey, toKey) => {
    if (!fromKey || !toKey || fromKey === toKey) return
    setColPrefs(p => {
      const order = [...p.order]
      const fromIdx = order.indexOf(fromKey)
      const toIdx = order.indexOf(toKey)
      if (fromIdx < 0 || toIdx < 0) return p
      order.splice(fromIdx, 1)
      order.splice(toIdx, 0, fromKey)
      return { ...p, order }
    })
  }
  const resetColumns = () => setColPrefs({
    order: LIST_COLUMNS.map(c => c.key),
    visible: Object.fromEntries(LIST_COLUMNS.map(c => [c.key, c.defaultVisible])),
  })
  const [detailOpen, setDetailOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [sierraStatus, setSierraStatus] = useState(null) // null = not started, 'syncing', { added, updated, total_synced, error }
  const [syncLog, setSyncLog] = useState(null)
  const [batchRefreshState, setBatchRefreshState] = useState(null)
  const [realistStats, setRealistStats] = useState(null)
  const loadRealistStats = () => {
    authFetch('/api/realist/stats').then(r => r.json()).then(setRealistStats).catch(() => {})
  }
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
    viewed_cities_include: [],
    sources_include: [],
    email_statuses: [],
    has_email: false,
    exclude_optouts: false,
    score_min: '',
    score_max: '',
    visits_min: '',
    visits_max: '',
    activity_days: '',
    created_days: '',
    inactive_days: '',
    // Property criteria from saved searches
    has_saved_search: false,
    search_max_price_min: '',
    search_max_price_max: '',
    search_beds_min: '',
    search_baths_min: '',
    search_sqft_min: '',
    search_property_types: [],
    search_regions: [],
    // Realist enrichment filters
    has_realist: false,
    realist_value_min: '',
    realist_value_max: '',
    realist_year_built_min: '',
    realist_year_built_max: '',
    realist_sell_score_min: '',
    realist_owner_occupied: '', // '' | '1' | '0'
  })
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('clients_sort') || 'recent_activity')
  useEffect(() => { localStorage.setItem('clients_sort', sortBy) }, [sortBy])
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [filterOptions, setFilterOptions] = useState({ zips: [], cities: [], sources: [], tags: [], viewed_cities: [] })
  const [savedLists, setSavedLists] = useState([])
  const [activeListId, setActiveListId] = useState(null)
  const [saveListOpen, setSaveListOpen] = useState(false)
  const [newListName, setNewListName] = useState('')

  // Load filter options + saved lists once
  useEffect(() => {
    authFetch('/api/clients/filter-options').then(r => r.json()).then(setFilterOptions).catch(() => {})
    authFetch('/api/lists').then(r => r.json()).then(setSavedLists).catch(() => {})
  }, [])

  // Defensive — if any field is undefined (e.g. from a stale saved list), treat as empty
  const len = (v) => Array.isArray(v) ? v.length : 0
  const advFilterCount = (
    len(advFilters.statuses_include) + len(advFilters.statuses_exclude) +
    len(advFilters.tags_include) + len(advFilters.tags_exclude) +
    len(advFilters.zips_include) + len(advFilters.cities_include) +
    len(advFilters.viewed_cities_include) +
    len(advFilters.sources_include) + len(advFilters.email_statuses) +
    (advFilters.has_email ? 1 : 0) + (advFilters.exclude_optouts ? 1 : 0) +
    (advFilters.score_min ? 1 : 0) + (advFilters.score_max ? 1 : 0) +
    (advFilters.visits_min ? 1 : 0) + (advFilters.visits_max ? 1 : 0) +
    (advFilters.activity_days ? 1 : 0) + (advFilters.created_days ? 1 : 0) +
    (advFilters.inactive_days ? 1 : 0) +
    (advFilters.has_saved_search ? 1 : 0) +
    (advFilters.search_max_price_min ? 1 : 0) + (advFilters.search_max_price_max ? 1 : 0) +
    (advFilters.search_beds_min ? 1 : 0) + (advFilters.search_baths_min ? 1 : 0) +
    (advFilters.search_sqft_min ? 1 : 0) +
    len(advFilters.search_property_types) + len(advFilters.search_regions) +
    (advFilters.has_realist ? 1 : 0) +
    (advFilters.realist_value_min ? 1 : 0) + (advFilters.realist_value_max ? 1 : 0) +
    (advFilters.realist_year_built_min ? 1 : 0) + (advFilters.realist_year_built_max ? 1 : 0) +
    (advFilters.realist_sell_score_min ? 1 : 0) +
    (advFilters.realist_owner_occupied ? 1 : 0)
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
  const [bulkEmailPreviewOpen, setBulkEmailPreviewOpen] = useState(false)
  const [otherMenuOpen, setOtherMenuOpen] = useState(false)
  const [bulkActionsOpen, setBulkActionsOpen] = useState(false)
  const bulkActionsRef = useRef(null)
  useEffect(() => {
    if (!bulkActionsOpen) return
    const handler = (e) => {
      if (bulkActionsRef.current && !bulkActionsRef.current.contains(e.target)) setBulkActionsOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [bulkActionsOpen])
  const setBulkType = async (t) => {
    if (selectedIds.size === 0) return
    if (!confirm(`Set ${selectedIds.size} client${selectedIds.size === 1 ? '' : 's'} as ${t === 'both' ? 'Buyer/Seller' : t.charAt(0).toUpperCase() + t.slice(1)}?`)) return
    const r = await authFetch('/api/clients/bulk-type', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [...selectedIds], type: t })
    })
    const d = await r.json()
    if (d.success) {
      alert(`✓ Updated ${d.updated} client${d.updated === 1 ? '' : 's'} to ${t}`)
      setBulkActionsOpen(false)
      setSelectedIds(new Set())
      load()
    } else {
      alert('Failed: ' + (d.error || 'unknown error'))
    }
  }
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
    if (advFilters.viewed_cities_include.length) params.viewed_cities_include = advFilters.viewed_cities_include.join(',')
    if (advFilters.sources_include.length) params.sources_include = advFilters.sources_include.join(',')
    if (advFilters.email_statuses.length) params.email_statuses = advFilters.email_statuses.join(',')
    if (advFilters.has_email) params.has_email = '1'
    if (advFilters.exclude_optouts) params.exclude_optouts = '1'
    if (advFilters.score_min) params.score_min = advFilters.score_min
    if (advFilters.score_max) params.score_max = advFilters.score_max
    if (advFilters.visits_min) params.visits_min = advFilters.visits_min
    if (advFilters.visits_max) params.visits_max = advFilters.visits_max
    if (advFilters.activity_days) params.activity_days = advFilters.activity_days
    if (advFilters.created_days) params.created_days = advFilters.created_days
    if (advFilters.inactive_days) params.inactive_days = advFilters.inactive_days
    // Property criteria
    if (advFilters.has_saved_search) params.has_saved_search = '1'
    if (advFilters.search_max_price_min) params.search_max_price_min = advFilters.search_max_price_min
    if (advFilters.search_max_price_max) params.search_max_price_max = advFilters.search_max_price_max
    if (advFilters.search_beds_min) params.search_beds_min = advFilters.search_beds_min
    if (advFilters.search_baths_min) params.search_baths_min = advFilters.search_baths_min
    if (advFilters.search_sqft_min) params.search_sqft_min = advFilters.search_sqft_min
    if (advFilters.search_property_types.length) params.search_property_types = advFilters.search_property_types.join(',')
    if (advFilters.search_regions.length) params.search_regions = advFilters.search_regions.join(',')
    // Realist filters
    if (advFilters.has_realist) params.has_realist = '1'
    if (advFilters.realist_value_min) params.realist_value_min = advFilters.realist_value_min
    if (advFilters.realist_value_max) params.realist_value_max = advFilters.realist_value_max
    if (advFilters.realist_year_built_min) params.realist_year_built_min = advFilters.realist_year_built_min
    if (advFilters.realist_year_built_max) params.realist_year_built_max = advFilters.realist_year_built_max
    if (advFilters.realist_sell_score_min) params.realist_sell_score_min = advFilters.realist_sell_score_min
    if (advFilters.realist_owner_occupied) params.realist_owner_occupied = advFilters.realist_owner_occupied
    params.sort = sortBy
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
    // Use the SAME filters as the initial load — just bump the offset.
    // (Earlier this was rebuilding from scratch and dropping advanced filters → load-more was returning unfiltered results.)
    const params = { ...buildLoadParams(), offset: items.length }
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
    // Load last sync info + health
    authFetch('/api/sierra/sync-log').then(r => r.json()).then(logs => {
      if (logs.length > 0) setSyncLog(logs[0])
    })
    loadRealistStats()
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

  useEffect(() => { load(); setSelectedIds(new Set()) }, [filter, search, tab, pageSize, advFilters, sortBy])

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

  const openNew = () => { setEditing(null); setEditingOriginal(null); setForm(emptyClient); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    setEditingOriginal({ status: item.status, sierra_lead_id: item.sierra_lead_id, first_name: item.first_name, last_name: item.last_name })
    setForm({ ...emptyClient, ...Object.fromEntries(Object.entries(item).filter(([k, v]) => v !== null && k in emptyClient)) })
    setModalOpen(true)
  }
  const [sierraActivity, setSierraActivity] = useState(null)
  const [listingInterest, setListingInterest] = useState(null)
  const [hubActivity, setHubActivity] = useState(null)
  const [fubActivity, setFubActivity] = useState(null)
  const [emailHistory, setEmailHistory] = useState([])
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [emailForm, setEmailForm] = useState({ subject: '', body: '', template: '', attachments: [], cc: '', bcc: '' })
  const singleEmailBodyRef = useRef(null)
  const bulkEmailBodyRef = useRef(null)
  const [singleEmailPreviewOpen, setSingleEmailPreviewOpen] = useState(false)
  const [emailTemplates, setEmailTemplates] = useState([])
  const [sending, setSending] = useState(false)
  // Detail-panel UI state (collapsible sections, transaction menu, quick note)
  const [txMenuOpen, setTxMenuOpen] = useState(false)
  const [tagsExpanded, setTagsExpanded] = useState(false)
  const [fubExpanded, setFubExpanded] = useState(false)
  const [listingActExpanded, setListingActExpanded] = useState(false)
  const [sierraExpanded, setSierraExpanded] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteText, setNoteText] = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [composerView, setComposerView] = useState('wysiwyg') // 'wysiwyg' | 'html'
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [teamSignature, setTeamSignature] = useState('')
  useEffect(() => { authFetch('/api/settings/profile').then(r => r.json()).then(d => setTeamSignature(d.signature || '')).catch(() => {}) }, [])

  // Move to the prev/next client in the current list without closing the modal.
  const gotoAdjacent = (dir) => {
    if (!detail) return
    const idx = items.findIndex(i => i.id === detail.id)
    if (idx === -1) return
    const next = items[idx + dir]
    if (next) openDetail(next.id)
  }

  // Save a quick internal note (appended to the client's notes, newest first).
  const saveQuickNote = async () => {
    if (!detail || !noteText.trim()) return
    setSavingNote(true)
    try {
      const stamp = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
      const entry = `[${stamp}] ${noteText.trim()}`
      const combined = detail.notes ? `${entry}\n${detail.notes}` : entry
      await authFetch(`/api/clients/${detail.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notes: combined }) })
      setDetail(d => ({ ...d, notes: combined }))
      setNoteText(''); setNoteOpen(false)
    } catch (e) { alert('Failed to save note: ' + e.message) }
    finally { setSavingNote(false) }
  }

  // Load email templates on mount
  useEffect(() => {
    authFetch('/api/email/templates').then(r => r.json()).then(setEmailTemplates).catch(() => {})
  }, [])

  const openDetail = async (id) => {
    const d = await api.getClient(id)
    setDetail(d)
    setSierraActivity(null)
    setListingInterest(null)
    setEmailHistory([])
    setHubActivity(null)
    setFubActivity(null)
    // reset per-client detail UI state
    setTagsExpanded(false); setFubExpanded(false); setListingActExpanded(false)
    setSierraExpanded(false); setTxMenuOpen(false); setNoteOpen(false); setNoteText('')
    setDetailOpen(true)
    // Hub tracking activity (mattsmithteam.com pixel) — always fetch, not gated on Sierra link
    authFetch(`/api/track/activity/${id}?limit=50`).then(r => r.json()).then(setHubActivity).catch(() => {})
    // Follow Up Boss web activity — lazy-loaded LIVE from FUB (property views w/ address,
    // page visits, saved searches). Falls back to any stored rows if not linked.
    authFetch(`/api/fub/activity/live?client_id=${id}`).then(r => r.json())
      .then(d => setFubActivity(Array.isArray(d) ? d : (Array.isArray(d?.rows) ? d.rows : [])))
      .catch(() => setFubActivity([]))
    // Lazy-load Sierra activity + listing interest if it's a Sierra-synced lead
    if (d.sierra_lead_id) {
      authFetch(`/api/sierra/lead-notes/${d.sierra_lead_id}`)
        .then(r => r.json())
        .then(setSierraActivity)
        .catch(() => setSierraActivity([]))
      authFetch(`/api/sierra/lead-listings/${d.sierra_lead_id}`)
        .then(r => r.json())
        .then(setListingInterest)
        .catch(() => setListingInterest({ saved_searches: [], saved_listings: [], listing_activity: [] }))
    }
    // Load email history
    authFetch(`/api/email/history/${id}`).then(r => r.json()).then(setEmailHistory).catch(() => {})
  }

  const [refreshing, setRefreshing] = useState(false)

  const refreshFromSierra = async () => {
    if (!detail?.sierra_lead_id) return
    setRefreshing(true)
    try {
      const r = await authFetch(`/api/sierra/refresh-lead/${detail.sierra_lead_id}`, { method: 'POST' })
      const d = await r.json()
      if (!d.success) {
        alert('Refresh failed: ' + (d.error || 'unknown error'))
        return
      }
      // Reload the full detail (which re-pulls notes + listing interest too)
      await openDetail(detail.id)
      // Also refresh the row in the list view
      load()
    } catch (e) {
      alert('Refresh failed: ' + e.message)
    } finally {
      setRefreshing(false)
    }
  }

  const openEmailComposer = (templateId = '') => {
    setComposerView('wysiwyg'); setShowCcBcc(false)
    if (templateId && detail) {
      authFetch(`/api/email/preview/${templateId}/${detail.id}`)
        .then(r => r.json())
        .then(d => setEmailForm({ subject: d.subject, body: d.body, template: templateId, attachments: [], cc: '', bcc: '' }))
    } else {
      // New blank email — start with a couple of blank lines above the signature, Gmail-style.
      const startBody = teamSignature ? `<div><br></div><div><br></div>${teamSignature}` : ''
      setEmailForm({ subject: '', body: startBody, template: '', attachments: [], cc: '', bcc: '' })
    }
    setEmailModalOpen(true)
  }

  // Draft a "see these homes?" email from the properties this client viewed in FUB.
  const [draftingPropEmail, setDraftingPropEmail] = useState(false)
  const draftViewedPropertiesEmail = async () => {
    if (!detail) return
    setDraftingPropEmail(true)
    try {
      const r = await authFetch(`/api/fub/property-email?client_id=${detail.id}`)
      const d = await r.json()
      if (d.error) { alert('Could not build email: ' + d.error); return }
      if (!d.count) { alert(d.message || 'No viewed properties found for this client.'); return }
      setEmailForm(p => ({ subject: d.subject, body: d.body, template: '', attachments: [], cc: p.cc || '', bcc: p.bcc || '' }))
      setComposerView('preview')
      setEmailModalOpen(true)
    } catch (e) { alert('Failed: ' + e.message) }
    finally { setDraftingPropEmail(false) }
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
      zips_include: [], cities_include: [], viewed_cities_include: [], sources_include: [],
      email_statuses: [],
      has_email: false, exclude_optouts: false,
      score_min: '', score_max: '', visits_min: '', visits_max: '',
      activity_days: '', created_days: '', inactive_days: '',
      has_saved_search: false,
      search_max_price_min: '', search_max_price_max: '',
      search_beds_min: '', search_baths_min: '', search_sqft_min: '',
      search_property_types: [], search_regions: [],
      has_realist: false,
      realist_value_min: '', realist_value_max: '',
      realist_year_built_min: '', realist_year_built_max: '',
      realist_sell_score_min: '', realist_owner_occupied: '',
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
        // Merge with empty defaults so newer filter fields aren't undefined
        // (older saved lists won't have these keys, which previously crashed the render)
        setAdvFilters({
          statuses_include: f.statuses_include || [],
          statuses_exclude: f.statuses_exclude || [],
          tags_include: f.tags_include || [],
          tags_exclude: f.tags_exclude || [],
          zips_include: f.zips_include || [],
          cities_include: f.cities_include || [],
          viewed_cities_include: f.viewed_cities_include || [],
          sources_include: f.sources_include || [],
          email_statuses: f.email_statuses || [],
          has_email: !!f.has_email,
          exclude_optouts: !!f.exclude_optouts,
          score_min: f.score_min || '',
          score_max: f.score_max || '',
          visits_min: f.visits_min || '',
          visits_max: f.visits_max || '',
          activity_days: f.activity_days || '',
          created_days: f.created_days || '',
          inactive_days: f.inactive_days || '',
          has_saved_search: !!f.has_saved_search,
          search_max_price_min: f.search_max_price_min || '',
          search_max_price_max: f.search_max_price_max || '',
          search_beds_min: f.search_beds_min || '',
          search_baths_min: f.search_baths_min || '',
          search_sqft_min: f.search_sqft_min || '',
          search_property_types: f.search_property_types || [],
          search_regions: f.search_regions || [],
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
  const selectAllFiltered = async (limit, opts = {}) => {
    // Use the full filter set (advFilters, search, status tab, etc.) — matches what's on screen.
    const baseParams = buildLoadParams()
    delete baseParams.limit
    delete baseParams.offset
    delete baseParams.sort
    const params = new URLSearchParams(baseParams)
    params.set('limit', limit || 50000)
    if (opts.emailReady) params.set('email_ready', '1')
    const r = await authFetch('/api/clients/ids?' + params)
    const d = await r.json()
    setSelectedIds(new Set(d.ids))
    const suffix = opts.emailReady ? ' with valid emails (opt-outs excluded)' : ''
    alert(`Selected ${d.count} matched lead${d.count !== 1 ? 's' : ''}${suffix}`)
  }
  const clearSelection = () => setSelectedIds(new Set())

  const refreshSelectedFromSierra = async () => {
    if (selectedIds.size === 0) return
    if (selectedIds.size > 1000) {
      alert('Max 1,000 leads per batch refresh. For more, use "Sync All Sierra Leads".')
      return
    }
    if (!confirm(`Pull fresh data from Sierra for ${selectedIds.size} selected lead${selectedIds.size === 1 ? '' : 's'}?\n\nWill take ~${Math.ceil(selectedIds.size / 60)} minute${Math.ceil(selectedIds.size / 60) === 1 ? '' : 's'}. The hub stays usable during refresh.`)) return
    try {
      const r = await authFetch('/api/sierra/refresh-leads-batch', {
        method: 'POST',
        body: JSON.stringify({ client_ids: [...selectedIds] }),
      })
      const d = await r.json()
      if (d.error) { alert('Refresh failed: ' + d.error); return }
      // Poll status every 2 sec
      const poll = async () => {
        const sr = await authFetch('/api/sierra/refresh-leads-batch/status').then(x => x.json())
        setBatchRefreshState(sr)
        if (sr.running) setTimeout(poll, 2000)
        else {
          alert(`✓ Refresh complete: ${sr.done}/${sr.total} processed (${sr.added} new, ${sr.updated} updated, ${sr.errors} errors)`)
          load()
        }
      }
      poll()
    } catch (e) {
      alert('Refresh failed: ' + e.message)
    }
  }

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
    if (!emailForm.body || !emailForm.body.trim()) { alert('Add an email body first'); return }
    const parseList = (s) => (s || '').split(/[,;\s]+/).map(x => x.trim()).filter(x => /@/.test(x))
    setSending(true)
    try {
      const r = await authFetch('/api/email/send', {
        method: 'POST',
        body: JSON.stringify({
          client_id: detail.id,
          subject: emailForm.subject,
          body: embedPropertyLinks(emailForm.body),
          template: emailForm.template,
          cc: parseList(emailForm.cc),
          bcc: parseList(emailForm.bcc),
          attachments: emailForm.attachments || [],
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

    // Detect status change on an existing Sierra-sourced lead BEFORE the save,
    // so we can offer to push to Sierra after the local save succeeds.
    const statusChanged = editing
      && editingOriginal
      && editingOriginal.sierra_lead_id
      && editingOriginal.status !== data.status

    if (editing) await api.updateClient(editing, data)
    else await api.createClient(data)

    // Offer to push the status change to Sierra. Always local-first; the Sierra
    // call is gated on user confirmation so accidental flips don't propagate.
    if (statusChanged) {
      const fullName = `${editingOriginal.first_name || ''} ${editingOriginal.last_name || ''}`.trim() || 'this lead'
      const confirmMsg = `Push status change to Sierra?\n\n${fullName}: ${editingOriginal.status} → ${data.status}\n\n(Local change is already saved either way.)`
      if (confirm(confirmMsg)) {
        try {
          const r = await authFetch('/api/sierra/update-lead-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: editing, status: data.status })
          })
          const result = await r.json()
          if (!result.success) {
            alert('Sierra update failed. Local hub status was saved.\n\nDetails: ' + (result.error || 'unknown'))
          }
        } catch (err) {
          alert('Sierra update failed. Local hub status was saved.\n\n' + err.message)
        }
      }
    }

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

  // Tag add/remove from the detail modal. Local DB always updates; if it's a
  // Sierra lead, the backend also pushes to Sierra (no confirm — tags are
  // low-risk vs status). Always reloads the detail so the chip list refreshes.
  const tagAction = async (client, tag, action) => {
    if (!client || !tag) return
    try {
      const r = await authFetch('/api/sierra/update-lead-tag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: client.id, tag, action })
      })
      const result = await r.json()
      if (!result.success && !result.local_updated) {
        alert(`Tag ${action} failed: ${result.error || 'unknown'}`)
      }
      // Refresh the detail view + the list
      if (detail?.id === client.id) {
        const fresh = await authFetch(`/api/clients/${client.id}`).then(r => r.json())
        setDetail(fresh)
      }
      load()
    } catch (err) {
      alert(`Tag ${action} failed: ${err.message}`)
    }
  }
  const addTag = (client, tag) => tagAction(client, tag, 'add')
  const removeTag = (client, tag) => {
    if (!confirm(`Remove tag "${tag}"${client.sierra_lead_id ? ' from Sierra and the hub' : ''}?`)) return
    tagAction(client, tag, 'remove')
  }

  // Inline status change from a card/row - no modal. Local save first, then
  // confirm to push to Sierra (only when there's a sierra_lead_id).
  const quickStatusChange = async (item, newStatus, e) => {
    if (e) e.stopPropagation()
    if (!newStatus || newStatus === item.status) return
    try {
      await api.updateClient(item.id, { status: newStatus })
    } catch (err) {
      alert('Failed to update status locally: ' + err.message)
      return
    }
    if (item.sierra_lead_id) {
      const fullName = `${item.first_name || ''} ${item.last_name || ''}`.trim() || 'this lead'
      const ok = confirm(`Push status change to Sierra?\n\n${fullName}: ${item.status} → ${newStatus}\n\n(Local change is already saved either way.)`)
      if (ok) {
        try {
          const r = await authFetch('/api/sierra/update-lead-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: item.id, status: newStatus })
          })
          const result = await r.json()
          if (!result.success) {
            alert('Sierra update failed. Local hub status was saved.\n\nDetails: ' + (result.error || 'unknown'))
          }
        } catch (err) {
          alert('Sierra update failed. Local hub status was saved.\n\n' + err.message)
        }
      }
    }
    load()
  }

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
          {view === 'list' && (
            <div className="columns-picker-wrap">
              <button className="btn btn-secondary" onClick={() => setColumnsPickerOpen(o => !o)} title="Show/hide and reorder columns">
                Columns ({visibleColumns.length})
              </button>
              {columnsPickerOpen && (
                <>
                  <div className="columns-picker-overlay" onClick={() => setColumnsPickerOpen(false)} />
                  <div className="columns-picker-popover" onClick={e => e.stopPropagation()}>
                    <div className="columns-picker-header">
                      <strong>Columns</strong>
                      <button className="btn-link" onClick={resetColumns} title="Restore default visible columns and order">Reset</button>
                    </div>
                    <div className="columns-picker-hint">Drag to reorder. Toggle checkboxes to show/hide.</div>
                    <ul className="columns-picker-list">
                      {colPrefs.order.map(key => {
                        const col = LIST_COLUMNS.find(c => c.key === key)
                        if (!col) return null
                        return (
                          <li
                            key={key}
                            className={`columns-picker-item ${dragColKey === key ? 'dragging' : ''}`}
                            draggable
                            onDragStart={() => setDragColKey(key)}
                            onDragOver={e => { e.preventDefault() }}
                            onDrop={e => { e.preventDefault(); reorderColumn(dragColKey, key); setDragColKey(null) }}
                            onDragEnd={() => setDragColKey(null)}
                          >
                            <span className="drag-handle" title="Drag to reorder">⋮⋮</span>
                            <label>
                              <input
                                type="checkbox"
                                checked={!!colPrefs.visible[key]}
                                onChange={() => toggleColumn(key)}
                              />
                              {col.label}
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
          <button
            className="btn btn-primary"
            onClick={() => syncSierra(false, 'all')}
            disabled={sierraStatus === 'syncing'}
            title="Pulls every Sierra lead - all statuses"
          >
            {sierraStatus === 'syncing' ? 'Syncing Sierra...' : `Sync All Sierra Leads${sierraCounts ? ` (${sierraCounts.total.toLocaleString()})` : ''}`}
          </button>
          <label className="btn btn-secondary" style={{cursor: 'pointer', position: 'relative', overflow: 'hidden'}} title="Upload a Realist CSV to enrich leads with home values, sale prices, year built, sell score, owner-occupied flag">
            🏘 Import Realist CSV
            <input
              type="file"
              accept=".csv,text/csv"
              style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                if (!confirm(`Import ${file.name} (${(file.size / 1024).toFixed(0)} KB)?\n\nThis will add/update Realist property records and auto-match them to clients by address.`)) {
                  e.target.value = ''
                  return
                }
                try {
                  const csv = await file.text()
                  const r = await authFetch('/api/realist/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'text/csv' },
                    body: csv,
                  })
                  const d = await r.json()
                  if (d.error) { alert('Import failed: ' + d.error); return }
                  alert(`✓ Realist import complete:\n${d.properties_imported} properties imported\n${d.client_matches_enriched} client matches enriched\n${d.errors} errors`)
                  loadRealistStats()
                  load()
                } catch (err) {
                  alert('Import failed: ' + err.message)
                } finally {
                  e.target.value = ''
                }
              }}
            />
          </label>
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
        {/* Sierra sync + Realist enrichment status moved to Updates → Systems tab. */}
      </div>

      {/* Status Tabs - primary statuses always visible, others in dropdown */}
      <div className="client-tabs">
        <button className={`client-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
          <span className="tab-dot" style={{ background: '#6b7280' }}></span>
          All
          <span className="tab-count">{allCounts.total}</span>
        </button>
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

        {/* Saved-list shortcut tabs (replaces the old 'Other' dropdown).
            Pulls names from the savedLists state — click loads the saved filter. */}
        {savedLists.filter(l => /^(FSBO|Cancelled\/Expired|Cancelled|Expired)/i.test(l.name)).map(l => (
          <button
            key={`sl-${l.id}`}
            className={`client-tab ${activeListId === l.id ? 'active' : ''}`}
            onClick={() => loadSavedList(l.id)}
            title={l.description || l.name}
          >
            <span className="tab-dot" style={{ background: '#a855f7' }}></span>
            {l.name}
            <span className="tab-count">{l.count || 0}</span>
          </button>
        ))}
      </div>

      {/* Type filter: All / Buyers / Sellers — combines with Status tabs above */}
      <div className="type-tabs">
        <span className="type-tabs-label">Type:</span>
        <button
          className={`type-tab ${!filter.type ? 'active' : ''}`}
          onClick={() => setFilter(p => ({ ...p, type: '' }))}
        >
          All Types <span className="tab-count">{allCounts.total}</span>
        </button>
        <button
          className={`type-tab type-buyer ${filter.type === 'buyer' ? 'active' : ''}`}
          onClick={() => setFilter(p => ({ ...p, type: 'buyer' }))}
          title="Includes leads tagged as Buyer or Both"
        >
          🎯 Buyers {tab === 'active' && <span className="tab-count">Active</span>}
        </button>
        <button
          className={`type-tab type-seller ${filter.type === 'seller' ? 'active' : ''}`}
          onClick={() => setFilter(p => ({ ...p, type: 'seller' }))}
          title="Includes leads tagged as Seller or Both"
        >
          🏠 Sellers {tab === 'active' && <span className="tab-count">Active</span>}
        </button>
        <button
          className={`type-tab type-both ${filter.type === 'both' ? 'active' : ''}`}
          onClick={() => setFilter(p => ({ ...p, type: 'both' }))}
          title="Only leads tagged as Buyer & Seller"
        >
          🔄 Buyer/Seller
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
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} title="Sort by">
          <option value="recent_activity">📅 Most Recent Activity</option>
          <option value="hub_activity">🔥 Most Active on Site (Tracked)</option>
          <option value="recent_added">🆕 Recently Added</option>
          <option value="oldest_first">⏳ Oldest First</option>
          <option value="recent_fub_visit">🕒 Most Recent Web Visit (FUB)</option>
          <option value="most_visits">👁️ Most Visits (Sierra)</option>
          <option value="least_visits">📉 Fewest Visits</option>
          <option value="highest_score">🔥 Highest Score</option>
          <option value="lowest_score">❄️ Lowest Score</option>
          <option value="name_az">🔤 Name A-Z</option>
          <option value="name_za">🔡 Name Z-A</option>
          <option value="recent_update">🔄 Last Updated</option>
          <option disabled>──── Realist ────</option>
          <option value="highest_value">🏠 Highest Home Value</option>
          <option value="lowest_value">📉 Lowest Home Value</option>
          <option value="highest_sell_score">🎯 Highest Sell Score</option>
          <option value="newest_built">🆕 Newest Built</option>
          <option value="oldest_built">🏚️ Oldest Built</option>
          <option value="highest_last_sale">💰 Highest Last Sale</option>
        </select>
        <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} title="Records per page">
          <option value={100}>100 per page</option>
          <option value={500}>500 per page</option>
          <option value={1000}>1,000 per page</option>
          <option value={2000}>2,000 per page</option>
        </select>
      </div>

      {/* Advanced Filter Panel - searchable multi-selects */}
      {filterPanelOpen && (
        <div className="filter-panel">
          <div className="filter-grid">
            <div className="filter-section">
              <h5>Status</h5>
              <MultiSelect
                placeholder="Search statuses..."
                options={ALL_STATUSES.map(s => ({ value: s, label: formatStatus(s) }))}
                selected={advFilters.statuses_include}
                onChange={v => setAdvFilters(p => ({ ...p, statuses_include: v }))}
              />
              <p className="muted" style={{fontSize: 11, margin: '4px 0 0'}}>Only leads with these statuses are shown.</p>
            </div>
            <div className="filter-section">
              <h5>Tags (Include)</h5>
              <MultiSelect
                placeholder={`Search ${filterOptions.tags.length} tags...`}
                options={filterOptions.tags}
                selected={advFilters.tags_include}
                onChange={v => setAdvFilters(p => ({ ...p, tags_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Tags (Exclude)</h5>
              <MultiSelect mode="exclude"
                placeholder="Exclude tags..."
                options={filterOptions.tags}
                selected={advFilters.tags_exclude}
                onChange={v => setAdvFilters(p => ({ ...p, tags_exclude: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Zip Codes</h5>
              <MultiSelect
                placeholder={`Search ${filterOptions.zips.length} zips...`}
                options={filterOptions.zips}
                selected={advFilters.zips_include}
                onChange={v => setAdvFilters(p => ({ ...p, zips_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Cities (lead's home city)</h5>
              <MultiSelect
                placeholder={`Search ${filterOptions.cities.length} cities...`}
                options={filterOptions.cities}
                selected={advFilters.cities_include}
                onChange={v => setAdvFilters(p => ({ ...p, cities_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Looking In (cities they're viewing)</h5>
              <MultiSelect
                placeholder={`Search ${(filterOptions.viewed_cities || []).length} cities they've viewed...`}
                options={filterOptions.viewed_cities || []}
                selected={advFilters.viewed_cities_include}
                onChange={v => setAdvFilters(p => ({ ...p, viewed_cities_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Sources</h5>
              <MultiSelect
                placeholder={`Search ${filterOptions.sources.length} sources...`}
                options={filterOptions.sources}
                selected={advFilters.sources_include}
                onChange={v => setAdvFilters(p => ({ ...p, sources_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Email Status</h5>
              <MultiSelect
                placeholder="Email statuses..."
                options={[
                  { value: 'ValidAddress', label: 'Valid Address' },
                  { value: 'TwoWayEmailing', label: 'Two-Way Emailing' },
                  { value: 'Unknown', label: 'Unknown' },
                  { value: 'OptedOut', label: 'Opted Out' },
                  { value: 'WrongAddress', label: 'Wrong Address' },
                  { value: 'ReportedAsSpam', label: 'Reported As Spam' },
                ]}
                selected={advFilters.email_statuses}
                onChange={v => setAdvFilters(p => ({ ...p, email_statuses: v }))}
              />
            </div>
          </div>

          <div className="filter-section">
            <h5>Activity & Engagement</h5>
            <div className="filter-other-row">
              <label className="filter-num">
                Active in past (days)
                <select value={advFilters.activity_days} onChange={e => setAdvFilters(p => ({ ...p, activity_days: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="1">1 day</option>
                  <option value="3">3 days</option>
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                  <option value="90">90 days</option>
                </select>
              </label>
              <label className="filter-num">
                Inactive for (days+)
                <select value={advFilters.inactive_days} onChange={e => setAdvFilters(p => ({ ...p, inactive_days: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="30">30+ days</option>
                  <option value="60">60+ days</option>
                  <option value="90">90+ days</option>
                  <option value="180">6+ months</option>
                  <option value="365">1+ year</option>
                </select>
              </label>
              <label className="filter-num">
                New leads (days)
                <select value={advFilters.created_days} onChange={e => setAdvFilters(p => ({ ...p, created_days: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="1">Last 24 hours</option>
                  <option value="3">Last 3 days</option>
                  <option value="7">Last 7 days</option>
                  <option value="14">Last 14 days</option>
                  <option value="30">Last 30 days</option>
                </select>
              </label>
              <label className="filter-num">
                Min visits
                <input type="number" value={advFilters.visits_min} onChange={e => setAdvFilters(p => ({ ...p, visits_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Max visits
                <input type="number" value={advFilters.visits_max} onChange={e => setAdvFilters(p => ({ ...p, visits_max: e.target.value }))} />
              </label>
            </div>
          </div>

          <div className="filter-section">
            <h5>Other</h5>
            <div className="filter-other-row">
              <label className="filter-check">
                <input type="checkbox" checked={advFilters.has_email} onChange={e => setAdvFilters(p => ({ ...p, has_email: e.target.checked }))} />
                Has email
              </label>
              <label className="filter-check">
                <input type="checkbox" checked={advFilters.exclude_optouts} onChange={e => setAdvFilters(p => ({ ...p, exclude_optouts: e.target.checked }))} />
                Exclude marketing opt-outs
              </label>
              <label className="filter-num">
                Score min
                <input type="number" value={advFilters.score_min} onChange={e => setAdvFilters(p => ({ ...p, score_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Score max
                <input type="number" value={advFilters.score_max} onChange={e => setAdvFilters(p => ({ ...p, score_max: e.target.value }))} />
              </label>
            </div>
          </div>

          <div className="filter-section">
            <h5>🎯 Looking For (saved search criteria)</h5>
            <div className="filter-other-row">
              <label className="filter-check">
                <input type="checkbox" checked={advFilters.has_saved_search} onChange={e => setAdvFilters(p => ({ ...p, has_saved_search: e.target.checked }))} />
                Has saved search
              </label>
              <label className="filter-num">
                Max budget ≥
                <input type="number" placeholder="e.g. 250000" value={advFilters.search_max_price_min} onChange={e => setAdvFilters(p => ({ ...p, search_max_price_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Max budget ≤
                <input type="number" placeholder="e.g. 600000" value={advFilters.search_max_price_max} onChange={e => setAdvFilters(p => ({ ...p, search_max_price_max: e.target.value }))} />
              </label>
              <label className="filter-num">
                Beds min
                <input type="number" min="0" max="10" value={advFilters.search_beds_min} onChange={e => setAdvFilters(p => ({ ...p, search_beds_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Baths min
                <input type="number" min="0" max="10" value={advFilters.search_baths_min} onChange={e => setAdvFilters(p => ({ ...p, search_baths_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Sq Ft min
                <input type="number" placeholder="e.g. 1500" value={advFilters.search_sqft_min} onChange={e => setAdvFilters(p => ({ ...p, search_sqft_min: e.target.value }))} />
              </label>
            </div>
            <div className="filter-other-row" style={{marginTop: 6}}>
              <label className="filter-num" style={{flex: 1, minWidth: 220}}>
                Property types (comma-separated, e.g. SingleFamily, Condo)
                <input
                  type="text"
                  placeholder="SingleFamily, Condo, Townhouse"
                  value={advFilters.search_property_types.join(', ')}
                  onChange={e => setAdvFilters(p => ({ ...p, search_property_types: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                />
              </label>
              <label className="filter-num" style={{flex: 1, minWidth: 220}}>
                Regions (comma-separated, e.g. CRAAR, Cedar Rapids)
                <input
                  type="text"
                  placeholder="CRAAR, Marion, Hiawatha"
                  value={advFilters.search_regions.join(', ')}
                  onChange={e => setAdvFilters(p => ({ ...p, search_regions: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                />
              </label>
            </div>
          </div>

          <div className="filter-section">
            <h5>🏘 Realist Property Data (home values, sale history)</h5>
            <div className="filter-other-row">
              <label className="filter-check">
                <input type="checkbox" checked={advFilters.has_realist} onChange={e => setAdvFilters(p => ({ ...p, has_realist: e.target.checked }))} />
                Has Realist match
              </label>
              <label className="filter-num">
                Home value ≥
                <input type="number" placeholder="e.g. 250000" value={advFilters.realist_value_min} onChange={e => setAdvFilters(p => ({ ...p, realist_value_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Home value ≤
                <input type="number" placeholder="e.g. 600000" value={advFilters.realist_value_max} onChange={e => setAdvFilters(p => ({ ...p, realist_value_max: e.target.value }))} />
              </label>
              <label className="filter-num">
                Year built ≥
                <input type="number" min="1800" max="2030" value={advFilters.realist_year_built_min} onChange={e => setAdvFilters(p => ({ ...p, realist_year_built_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Sell score ≥
                <input type="number" min="0" max="1000" placeholder="e.g. 700" value={advFilters.realist_sell_score_min} onChange={e => setAdvFilters(p => ({ ...p, realist_sell_score_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Owner-occupied
                <select value={advFilters.realist_owner_occupied} onChange={e => setAdvFilters(p => ({ ...p, realist_owner_occupied: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="1">Yes (lives there)</option>
                  <option value="0">No (rental/investor)</option>
                </select>
              </label>
            </div>
          </div>

          <div className="filter-quick-presets">
            <span style={{fontSize: 11, color: 'var(--text-muted)', marginRight: 8}}>Quick presets:</span>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, has_email: true, exclude_optouts: true,
              email_statuses: ['ValidAddress', 'TwoWayEmailing'],
            }))}>Email-ready</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, has_email: true, exclude_optouts: true,
              statuses_include: ['prime', 'active'],
              email_statuses: ['ValidAddress', 'TwoWayEmailing'],
            }))}>Hot Leads (Prime+Active)</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, statuses_exclude: ['junk', 'donotcontact', 'blocked', 'archived', 'closed'],
              has_email: true, exclude_optouts: true,
            }))}>Active Pipeline</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, activity_days: '7', has_email: true, exclude_optouts: true,
            }))}>🔥 Active This Week</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, created_days: '7', has_email: true, exclude_optouts: true,
            }))}>🆕 New This Week</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, inactive_days: '90', has_email: true, exclude_optouts: true,
              statuses_exclude: ['junk', 'donotcontact', 'blocked', 'archived', 'closed'],
            }))}>💤 Re-engagement (90d+)</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, visits_min: '5', has_email: true, exclude_optouts: true,
            }))}>👁️ High Engagement (5+ visits)</button>
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
          <button
            className="btn btn-sm btn-primary"
            onClick={() => selectAllFiltered(50000)}
            title="Select every lead matching the current filters"
          >
            Select All Matched ({totalCount.toLocaleString()})
          </button>
          <button
            className="btn btn-sm btn-secondary"
            onClick={() => selectAllFiltered(50000, { emailReady: true })}
            title="Select only matched leads with valid emails (opt-outs excluded) — for bulk email"
          >
            ✉ Email-Ready Only
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
            <div className="bulk-actions-dropdown" ref={bulkActionsRef}>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => setBulkActionsOpen(o => !o)}
                disabled={batchRefreshState?.running}
              >
                {batchRefreshState?.running
                  ? `↻ Refreshing ${batchRefreshState.done}/${batchRefreshState.total}...`
                  : `Bulk Actions ▾`}
              </button>
              {bulkActionsOpen && (
                <div className="bulk-actions-menu">
                  <button onClick={() => { setBulkActionsOpen(false); openBulkEmail() }}>
                    ✉ Email Selected
                  </button>
                  <div className="bulk-actions-divider" />
                  <div className="bulk-actions-section-label">Set Type</div>
                  <button onClick={() => setBulkType('buyer')}>🎯 Mark as Buyer</button>
                  <button onClick={() => setBulkType('seller')}>🏠 Mark as Seller</button>
                  <button onClick={() => setBulkType('both')}>🔄 Mark as Buyer/Seller</button>
                  <div className="bulk-actions-divider" />
                  <button onClick={() => { setBulkActionsOpen(false); refreshSelectedFromSierra() }}>
                    ↻ Refresh Selected from Sierra
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Client List View */}
      {view === 'list' && items.length === 0 && (
        <div className="empty-state-full">
          {sierraStatus === 'syncing' ? 'Syncing clients from Sierra...' : 'No clients found in this status. Try another tab or sync from Sierra.'}
        </div>
      )}
      {view === 'list' && items.length > 0 && (() => {
        // Build grid-template-columns dynamically from the user's visible/ordered cols.
        // First track = checkbox (30px). All middle = minmax(0, Xfr). (Actions column removed.)
        const gridTemplate = `30px ${visibleColumns.map(c => `minmax(0, ${c.fr})`).join(' ')}`

        // Cell renderers: one entry per column key. Each returns JSX for one cell.
        const renderHeaderCell = (col) => {
          const isSorted = col.sort && (sortBy === col.sort.asc || sortBy === col.sort.desc)
          const arrow = !col.sort ? '' : (sortBy === col.sort.desc ? '▼' : sortBy === col.sort.asc ? '▲' : '⇅')
          const onClick = col.sort ? () => setSortBy(sortBy === col.sort.desc ? col.sort.asc : col.sort.desc) : undefined
          return (
            <div
              key={col.key}
              className={`cl-${col.key} ${col.sort ? 'sortable' : ''} ${isSorted ? 'active' : ''}`}
              onClick={onClick}
              title={col.sort ? `Click to sort by ${col.label.toLowerCase()}` : undefined}
            >
              {col.label} {col.sort ? arrow : ''}
            </div>
          )
        }
        const renderCell = (col, item) => {
          switch (col.key) {
            case 'score':
              return <div key="score" className="cl-score">
                {item.lead_score !== null && item.lead_score !== undefined ? (
                  <span className={`lead-score grade-${(item.lead_grade || 'F').replace('+','plus').toLowerCase()}`}>
                    {item.lead_score}{item.lead_grade && <span className="lead-grade">{item.lead_grade}</span>}
                  </span>
                ) : <span className="lead-score-empty">—</span>}
              </div>
            case 'name':
              return <div key="name" className="cl-name">
                <strong>{item.first_name} {item.last_name}</strong>
                {item.sierra_lead_id && <span className="sierra-tag">Sierra</span>}
                {item.tags && (() => {
                  try {
                    const tagList = JSON.parse(item.tags)
                    return tagList.slice(0, 2).map((t, i) => <span key={i} className="lead-tag">{t}</span>)
                  } catch { return null }
                })()}
              </div>
            case 'status':
              return <div key="status" className="cl-status" onClick={e => e.stopPropagation()}>
                <select
                  className={`status-quick-select status-${item.status}`}
                  value={item.status || ''}
                  onChange={e => quickStatusChange(item, e.target.value, e)}
                  title={item.sierra_lead_id ? 'Changes will optionally push to Sierra' : 'Local hub only'}
                >
                  {SIERRA_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
            case 'type':
              return <div key="type" className="cl-type">
                {item.type && (
                  <span className={`type-pill type-${item.type}`}>
                    {item.type === 'buyer' ? '🎯 Buyer' : item.type === 'seller' ? '🏠 Seller' : '🔄 Buyer/Seller'}
                  </span>
                )}
              </div>
            case 'phone':
              return <div key="phone" className="cl-phone">{item.phone || '—'}</div>
            case 'email':
              return <div key="email" className="cl-email">
                {item.email || '—'}
                {item.email_status && item.email_status !== 'Unknown' && <span className="email-status-tag">{item.email_status}</span>}
              </div>
            case 'address':
              return <div key="address" className="cl-address">
                {item.address ? `${item.address}${item.city ? ', ' + item.city : ''}` : item.city || '—'}
              </div>
            case 'budget':
              return <div key="budget" className="cl-budget">
                {item.budget_min || item.budget_max
                  ? `${formatCurrency(item.budget_min) || '?'} - ${formatCurrency(item.budget_max) || '?'}`
                  : '—'}
              </div>
            case 'visits':
              return <div key="visits" className="cl-visits">{item.visits || 0}</div>
            case 'source':
              return <div key="source" className="cl-source">{item.source || '—'}</div>
            case 'last_fub_visit':
              return <div key="last_fub_visit" className="cl-last-visit">
                {item.last_fub_activity_at ? (
                  <>
                    <div style={{ fontWeight: 600 }}>
                      {new Date(String(item.last_fub_activity_at).replace(' ', 'T')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </div>
                    {(item.last_fub_activity_type || item.last_fub_activity_detail) && (
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.25, marginTop: 2 }}>
                        {item.last_fub_activity_type}{item.last_fub_activity_detail ? ` ${item.last_fub_activity_detail}` : ''}
                      </div>
                    )}
                  </>
                ) : '—'}
              </div>
            case 'registered':
              return <div key="registered" className="cl-registered" title={item.sierra_creation_date || ''}>
                {item.sierra_creation_date
                  ? new Date(item.sierra_creation_date.replace(' ', 'T')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
                  : '—'}
              </div>
            default: return null
          }
        }

        return (
          <div className="client-list">
            <div className="client-list-header" style={{ gridTemplateColumns: gridTemplate }}>
              <div className="cl-check">
                <input type="checkbox"
                  checked={items.length > 0 && items.every(i => selectedIds.has(i.id))}
                  onChange={e => { if (e.target.checked) selectAllVisible(); else clearSelection() }} />
              </div>
              {visibleColumns.map(renderHeaderCell)}
            </div>
            {items.map(item => (
              <div key={item.id} className={`client-list-row ${selectedIds.has(item.id) ? 'selected' : ''}`}
                style={{ gridTemplateColumns: gridTemplate }}
                onClick={() => openDetail(item.id)}>
                <div className="cl-check" onClick={e => e.stopPropagation()}>
                  <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                </div>
                {visibleColumns.map(col => renderCell(col, item))}
              </div>
            ))}
          </div>
        )
      })()}

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
            <div className="client-card-footer" onClick={e => e.stopPropagation()}>
              <select
                className={`status-quick-select status-${item.status}`}
                value={item.status || ''}
                onChange={e => quickStatusChange(item, e.target.value, e)}
                title={item.sierra_lead_id ? 'Changes will optionally push to Sierra' : 'Local hub only'}
              >
                {SIERRA_STATUSES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
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
            {/* Prev / Next through the current list */}
            {(() => {
              const idx = items.findIndex(i => i.id === detail.id)
              return (
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10}}>
                  <button className="btn btn-secondary btn-sm" onClick={() => gotoAdjacent(-1)} disabled={idx <= 0}>‹ Prev</button>
                  <span style={{fontSize: 12, color: 'var(--text-muted)'}}>{idx >= 0 ? `${idx + 1} of ${items.length}` : ''}</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => gotoAdjacent(1)} disabled={idx < 0 || idx >= items.length - 1}>Next ›</button>
                </div>
              )
            })()}

            {/* Communication + transaction actions */}
            <div className="lead-action-bar">
              <div className="lead-action-bar-row">
                {detail.email && !detail.marketing_email_opt_out && (
                  <button className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('')}>
                    <span className="lead-action-icon">✉</span>
                    <span>Email</span>
                  </button>
                )}
                {detail.phone && !detail.text_opt_out && (
                  <button className="lead-action-btn lead-action-text" title="Twilio SMS coming soon" onClick={() => alert('Twilio SMS integration is in setup. Coming soon.')}>
                    <span className="lead-action-icon">💬</span>
                    <span>Text</span>
                    <span className="lead-action-soon">soon</span>
                  </button>
                )}
                {detail.phone && (
                  <a className="lead-action-btn lead-action-call" href={`tel:${detail.phone}`}>
                    <span className="lead-action-icon">📞</span>
                    <span>Call</span>
                  </a>
                )}
                <button className="lead-action-btn lead-action-voicemail" title="Recorded voicemail drops — coming with Twilio" onClick={() => alert('Recorded voicemail drops are planned with Twilio. Coming soon.')}>
                  <span className="lead-action-icon">🎙</span>
                  <span>Voicemail</span>
                  <span className="lead-action-soon">soon</span>
                </button>
                <button className="lead-action-btn" onClick={() => setNoteOpen(o => !o)}>
                  <span className="lead-action-icon">📝</span>
                  <span>Add Note</span>
                </button>

                {/* Add Transaction — single button with a dropdown of the 4 transaction types */}
                <div style={{position: 'relative', display: 'inline-block'}}>
                  <button className="lead-action-btn lead-action-prelisting" onClick={() => setTxMenuOpen(o => !o)}>
                    <span className="lead-action-icon">➕</span>
                    <span>Add Transaction ▾</span>
                  </button>
                  {txMenuOpen && (
                    <div style={{position: 'absolute', top: '100%', left: 0, zIndex: 30, background: 'var(--bg-elevated, #fff)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', minWidth: 230, marginTop: 4, overflow: 'hidden'}} onMouseLeave={() => setTxMenuOpen(false)}>
                      {[
                        { label: '⌂  Pre-Listing', fn: () => addToPreListing(detail) },
                        { label: '★  Active Listing (live on MLS)', fn: () => addTransaction(detail, 'listing', null, 'Active') },
                        { label: '⇄  Purchase Under Contract', fn: () => addTransaction(detail, 'purchase') },
                        { label: '◆  Listing Under Contract', fn: () => addTransaction(detail, 'listing') },
                      ].map((m, i) => (
                        <button key={i} onClick={() => { setTxMenuOpen(false); m.fn() }} style={{display: 'block', width: '100%', textAlign: 'left', padding: '10px 14px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer'}}>{m.label}</button>
                      ))}
                    </div>
                  )}
                </div>

                {detail.sierra_lead_id && (
                  <button className="lead-action-btn lead-action-refresh" onClick={refreshFromSierra} disabled={refreshing} title="Pull this lead's latest data from Sierra">
                    <span className="lead-action-icon">{refreshing ? '⟳' : '↻'}</span>
                    <span>{refreshing ? 'Refreshing...' : 'Refresh from Sierra'}</span>
                  </button>
                )}
              </div>
              {noteOpen && (
                <div style={{marginTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start'}}>
                  <textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Add an internal note…" rows={2} style={{flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, resize: 'vertical'}} />
                  <button className="btn btn-primary btn-sm" onClick={saveQuickNote} disabled={savingNote || !noteText.trim()}>{savingNote ? 'Saving…' : 'Save Note'}</button>
                </div>
              )}
            </div>

            {/* Lead type — dropdown */}
            <div className="type-toggle-row" style={{display: 'flex', alignItems: 'center', gap: 10}}>
              <span className="type-toggle-label">Type:</span>
              <select value={detail.type || 'buyer'} onChange={async (e) => {
                const t = e.target.value
                await authFetch(`/api/clients/${detail.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: t }) })
                setDetail(d => ({ ...d, type: t }))
                load()
              }} style={{padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13}}>
                <option value="buyer">🎯 Buyer</option>
                <option value="seller">🏠 Seller</option>
                <option value="both">🔄 Buyer/Seller</option>
              </select>
            </div>

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

            {/* Realist Property Data — only shows if matched */}
            {detail.realist_property_id && (
              <div className="detail-section" style={{background: 'rgba(200, 155, 74, 0.06)', border: '1px solid rgba(200, 155, 74, 0.25)', borderRadius: 8, padding: '12px 16px'}}>
                <h4 style={{color: 'var(--accent)'}}>🏘 Realist Property Data</h4>
                <div className="detail-grid" style={{gap: 12}}>
                  {detail.realist_market_value && <p><strong>Home Value:</strong> {formatCurrency(detail.realist_market_value)}</p>}
                  {detail.realist_assessed_value && <p><strong>Assessed:</strong> {formatCurrency(detail.realist_assessed_value)}</p>}
                  {detail.realist_year_built && <p><strong>Year Built:</strong> {detail.realist_year_built}</p>}
                  {detail.realist_bedrooms != null && <p><strong>Bedrooms:</strong> {detail.realist_bedrooms}</p>}
                  {detail.realist_bathrooms_full != null && <p><strong>Full Baths:</strong> {detail.realist_bathrooms_full}</p>}
                  {detail.realist_sell_score != null && (
                    <p><strong>Sell Score:</strong> {detail.realist_sell_score} <span className="muted" style={{fontSize: 11}}>(0-1000)</span></p>
                  )}
                  {detail.realist_owner_occupied != null && (
                    <p><strong>Owner-Occupied:</strong> {detail.realist_owner_occupied ? 'Yes' : 'No (rental/investor)'}</p>
                  )}
                  {detail.realist_last_sale_price && <p><strong>Last Sale:</strong> {formatCurrency(detail.realist_last_sale_price)}{detail.realist_last_sale_date ? ` (${detail.realist_last_sale_date})` : ''}</p>}
                </div>
                {detail.realist_matched_at && <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '8px 0 0'}}>Matched: {detail.realist_matched_at.split(' ')[0]}</p>}
              </div>
            )}

            {/* Tags - editable, with optional push to Sierra */}
            {(() => {
              let tagList = []
              try { tagList = detail.tags ? JSON.parse(detail.tags) : [] } catch {}
              if (!Array.isArray(tagList)) tagList = []
              return (
                <div className="detail-section">
                  <h4>Tags ({tagList.length}){detail.sierra_lead_id ? <span style={{fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8}}>↔ Sierra</span> : null}</h4>
                  <div className="lead-tags-list" style={!tagsExpanded ? { maxHeight: 30, overflow: 'hidden' } : undefined}>
                    {tagList.map((t, i) => (
                      <span key={i} className="lead-tag" style={{display: 'inline-flex', alignItems: 'center', gap: 4}}>
                        {t}
                        <button
                          className="tag-remove-btn"
                          onClick={() => removeTag(detail, t)}
                          title={`Remove tag "${t}"${detail.sierra_lead_id ? ' (will also remove from Sierra)' : ''}`}
                          aria-label={`Remove tag ${t}`}
                        >×</button>
                      </span>
                    ))}
                  </div>
                  {tagList.length > 6 && (
                    <button onClick={() => setTagsExpanded(v => !v)} style={{marginTop: 6, background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 12, cursor: 'pointer', padding: 0}}>
                      {tagsExpanded ? '− Show less' : `+ Show all ${tagList.length} tags`}
                    </button>
                  )}
                  <form
                    onSubmit={(e) => { e.preventDefault(); const v = e.target.elements.tag.value.trim(); if (v) { addTag(detail, v); e.target.reset() } }}
                    style={{display: 'flex', gap: 6, marginTop: 8}}
                  >
                    <input
                      name="tag"
                      type="text"
                      placeholder="Add tag..."
                      style={{flex: 1, padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 12}}
                      maxLength={64}
                    />
                    <button type="submit" className="btn btn-secondary" style={{fontSize: 12, padding: '4px 10px'}}>
                      + Add
                    </button>
                  </form>
                </div>
              )
            })()}

            {/* Hub-Tracked Site Activity (mattsmithteam.com pixel) */}
            {hubActivity && hubActivity.summary && hubActivity.summary.total_events > 0 && (
              <div className="detail-section">
                <h4>Site Activity ({hubActivity.summary.total_events} events)</h4>
                <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 12, fontSize: 12}}>
                  <div style={{padding: 8, background: 'var(--bg-elevated)', borderRadius: 4}}>
                    <div style={{color: 'var(--text-muted)', fontSize: 11}}>Page views</div>
                    <div style={{fontSize: 18, fontWeight: 700}}>{hubActivity.summary.pageviews || 0}</div>
                  </div>
                  <div style={{padding: 8, background: 'var(--bg-elevated)', borderRadius: 4}}>
                    <div style={{color: 'var(--text-muted)', fontSize: 11}}>Listings viewed</div>
                    <div style={{fontSize: 18, fontWeight: 700, color: '#3b82f6'}}>{hubActivity.summary.listing_views || 0}</div>
                  </div>
                  <div style={{padding: 8, background: 'var(--bg-elevated)', borderRadius: 4}}>
                    <div style={{color: 'var(--text-muted)', fontSize: 11}}>Saves</div>
                    <div style={{fontSize: 18, fontWeight: 700, color: '#f59e0b'}}>{hubActivity.summary.saves || 0}</div>
                  </div>
                  <div style={{padding: 8, background: 'var(--bg-elevated)', borderRadius: 4}}>
                    <div style={{color: 'var(--text-muted)', fontSize: 11}}>Time on site</div>
                    <div style={{fontSize: 18, fontWeight: 700}}>{Math.round((hubActivity.summary.total_seconds || 0) / 60)}m</div>
                  </div>
                </div>
                <div style={{maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 4}}>
                  {hubActivity.events.map(e => {
                    const eventLabel = { pageview: '👁 page view', listing_view: '🏠 listing view', save: '⭐ saved', pageduration: '⏱ time' }[e.event_type] || e.event_type
                    return (
                      <div key={e.id} style={{padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12}}>
                        <div style={{display: 'flex', justifyContent: 'space-between'}}>
                          <span style={{fontWeight: 600}}>{eventLabel}{e.listing_mls ? ` · MLS ${e.listing_mls}` : ''}</span>
                          <span style={{color: 'var(--text-muted)', fontSize: 11}}>{new Date(e.created_at).toLocaleString()}</span>
                        </div>
                        {e.page_title && <div style={{color: 'var(--text-secondary)', fontSize: 11, marginTop: 2}}>{e.page_title}</div>}
                        {e.duration_sec && <div style={{color: 'var(--text-muted)', fontSize: 10}}>{e.duration_sec}s on page</div>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}


            {/* Listing Interest */}
            {detail.sierra_lead_id && listingInterest && (
              <div className="detail-section">
                <h4>Listing Interest</h4>

                {/* Saved Searches */}
                {listingInterest.saved_searches?.length > 0 && (
                  <div className="listing-block">
                    <div className="listing-block-title">What they're looking for ({listingInterest.saved_searches.length} saved search{listingInterest.saved_searches.length > 1 ? 'es' : ''})</div>
                    {listingInterest.saved_searches.map((s, i) => (
                      <div key={i} className="saved-search-card">
                        <div className="ss-name">{s.name || 'Unnamed Search'}</div>
                        <div className="ss-criteria">
                          {(s.price_min || s.price_max) && <span>💰 {s.price_min ? `$${(s.price_min / 1000).toFixed(0)}K` : '?'} – {s.price_max ? `$${(s.price_max / 1000).toFixed(0)}K` : '?'}</span>}
                          {s.bedrooms_min && <span>🛏️ {s.bedrooms_min}+ bed</span>}
                          {s.bathrooms_min && <span>🛁 {s.bathrooms_min}+ bath</span>}
                          {s.regions && <span>📍 {s.regions}</span>}
                          {s.email_alerts && <span className="badge-on">Alerts ON</span>}
                        </div>
                        {s.property_types?.length > 0 && (
                          <div className="ss-types">
                            {s.property_types.map(t => <span key={t} className="ss-type">{t.replace(/([A-Z])/g, ' $1').trim()}</span>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}

                {/* Saved Listings (if accessible) */}
                {listingInterest.saved_listings?.length > 0 && (
                  <div className="listing-block">
                    <div className="listing-block-title">⭐ Saved Properties ({listingInterest.saved_listings.length})</div>
                    {listingInterest.saved_listings.map((l, i) => (
                      <div key={i} className="saved-listing">
                        <div className="sl-address">{l.address}{l.city ? `, ${l.city}` : ''}</div>
                        <div className="sl-meta">
                          {l.price && <span className="sl-price">${Number(l.price).toLocaleString()}</span>}
                          {l.bedrooms && <span>{l.bedrooms}bd</span>}
                          {l.bathrooms && <span>{l.bathrooms}ba</span>}
                          {l.mls && <span>MLS {l.mls}</span>}
                          {l.status && <span className="sl-status">{l.status}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Listing-related Activity — show 2, expand for the rest */}
                {listingInterest.listing_activity?.length > 0 && (
                  <div className="listing-block">
                    <div className="listing-block-title">🏠 Listing Activity ({listingInterest.listing_activity.length})</div>
                    {listingInterest.listing_activity.slice(0, listingActExpanded ? 50 : 2).map(a => (
                      <div key={a.id} className="listing-activity-item">
                        <div className="la-meta">
                          <span className="la-author">{a.author}</span>
                          <span className="la-date">{a.date ? new Date(a.date).toLocaleDateString() : ''}</span>
                        </div>
                        <div className="la-excerpt">{a.excerpt}</div>
                        {(a.addresses?.length > 0 || a.mls_numbers?.length > 0) && (
                          <div className="la-references">
                            {a.addresses?.map((addr, i) => <span key={i} className="la-addr">📍 {addr}</span>)}
                            {a.mls_numbers?.map((m, i) => <span key={`m${i}`} className="la-mls">MLS {m}</span>)}
                          </div>
                        )}
                      </div>
                    ))}
                    {listingInterest.listing_activity.length > 2 && (
                      <button onClick={() => setListingActExpanded(v => !v)} style={{marginTop: 6, background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 12, cursor: 'pointer', padding: 0}}>
                        {listingActExpanded ? '− Show less' : `+ See all ${listingInterest.listing_activity.length}`}
                      </button>
                    )}
                  </div>
                )}

                {(!listingInterest.saved_searches?.length && !listingInterest.saved_listings?.length && !listingInterest.listing_activity?.length) && (
                  <p style={{fontSize: 12, color: 'var(--text-muted)'}}>No listing activity recorded yet</p>
                )}
              </div>
            )}

            {/* Follow Up Boss web activity — property views w/ address, page visits, saved searches.
                Placed BELOW Listing Interest. Shows the last 4, expand for the full scrollable list. */}
            {fubActivity && fubActivity.length > 0 && (
              <div className="detail-section">
                <h4>Follow Up Boss Activity ({fubActivity.length}{(() => { const pv = fubActivity.filter(a => a.prop_street).length; return pv ? ` · ${pv} property views` : '' })()})</h4>
                <div style={fubExpanded ? { maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6 } : { border: '1px solid var(--border)', borderRadius: 6 }}>
                  {fubActivity.slice(0, fubExpanded ? 150 : 4).map(a => {
                    const when = a.occurred_at ? new Date(a.occurred_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''
                    const addr = a.prop_street ? `${a.prop_street}, ${a.prop_city || ''} ${a.prop_state || ''}`.trim() : ''
                    return (
                      <div key={a.id} style={{ padding: '6px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                          <span style={{ fontWeight: 600 }}>{a.type}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 11, whiteSpace: 'nowrap' }}>{when}</span>
                        </div>
                        {addr && <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 }}>{addr}{a.prop_mls ? ` · MLS ${a.prop_mls}` : ''}{a.prop_price ? ` · $${Number(a.prop_price).toLocaleString()}` : ''}</div>}
                        {!addr && a.page_title && <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 2 }}>{a.page_title}</div>}
                      </div>
                    )
                  })}
                </div>
                {fubActivity.length > 4 && (
                  <button onClick={() => setFubExpanded(v => !v)} style={{marginTop: 6, background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 12, cursor: 'pointer', padding: 0}}>
                    {fubExpanded ? '− Show less' : `+ See all ${fubActivity.length} (scroll)`}
                  </button>
                )}
              </div>
            )}

            {/* Sierra Activity Log — show 4, expand for the rest */}
            {detail.sierra_lead_id && (
              <div className="detail-section">
                <h4>Sierra Activity {sierraActivity && `(${sierraActivity.length})`}</h4>
                {sierraActivity === null ? (
                  <p style={{fontSize: 12, color: 'var(--text-muted)'}}>Loading activity...</p>
                ) : sierraActivity.length === 0 ? (
                  <p style={{fontSize: 12, color: 'var(--text-muted)'}}>No activity recorded</p>
                ) : (
                  <div className="sierra-activity-feed" style={sierraExpanded ? { maxHeight: 320, overflowY: 'auto' } : undefined}>
                    {sierraActivity.slice(0, sierraExpanded ? 50 : 4).map(a => (
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
                {sierraActivity && sierraActivity.length > 4 && (
                  <button onClick={() => setSierraExpanded(v => !v)} style={{marginTop: 6, background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 12, cursor: 'pointer', padding: 0}}>
                    {sierraExpanded ? '− Show less' : `+ See all ${sierraActivity.length} (scroll)`}
                  </button>
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

            {/* Email history — composing now happens via the Email button at the top. */}
            {emailHistory.length > 0 && (
              <div className="detail-section">
                <h4>Email History ({emailHistory.length})</h4>
                <div className="email-history">
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
              </div>
            )}

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
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4}}>
            <span style={{fontSize: 13, fontWeight: 500}}>Body</span>
            <div style={{display: 'flex', gap: 6}}>
              <label className="btn btn-sm btn-secondary" style={{cursor: 'pointer', margin: 0, position: 'relative', overflow: 'hidden'}} title="Load an HTML file (.html) into the body">
                📁 Load HTML File
                <input
                  type="file"
                  accept=".html,.htm,text/html"
                  style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
                  onChange={async (e) => {
                    const file = e.target.files?.[0]
                    if (!file) return
                    const text = await file.text()
                    setBulkEmailForm(p => ({ ...p, body: text }))
                    e.target.value = ''
                  }}
                />
              </label>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                disabled={!bulkEmailForm.body}
                onClick={() => setBulkEmailPreviewOpen(true)}
              >👁 Preview</button>
            </div>
          </div>
          <EmailToolbar
            textareaRef={bulkEmailBodyRef}
            body={bulkEmailForm.body}
            setBody={(b) => setBulkEmailForm(p => ({ ...p, body: b }))}
            showPreview={false}
            compact
          />
          <textarea ref={bulkEmailBodyRef} value={bulkEmailForm.body} onChange={e => setBulkEmailForm(p => ({ ...p, body: e.target.value }))} rows={20} required style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}} />
          <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '4px 0'}}>
            Variables auto-fill per recipient: {'{{first_name}} {{last_name}} {{address}} {{city}}'}
          </p>
          <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px'}}>
            <strong>Plain text auto-formats</strong> — blank lines become paragraph breaks; URLs, emails, and phone numbers become clickable links. <strong>For designed HTML emails</strong>, click <em>Load HTML File</em> above or paste the markup directly — it renders as-is.
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setBulkEmailOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={bulkSending}>
              {bulkSending ? 'Sending...' : `Send to ${selectedIds.size} Recipients`}
            </button>
          </div>
        </form>
      </Modal>

      {/* Bulk Email Preview Modal */}
      <Modal open={bulkEmailPreviewOpen} onClose={() => setBulkEmailPreviewOpen(false)} title="Email Preview" wide>
        {(() => {
          // Find first selected client to use as sample for merge variables
          const sampleId = [...selectedIds][0]
          const sample = sampleId ? items.find(i => i.id === sampleId) : null
          const fill = (s) => (s || '')
            .replace(/\{\{first_name\}\}/g, sample?.first_name || 'there')
            .replace(/\{\{last_name\}\}/g, sample?.last_name || '')
            .replace(/\{\{address\}\}/g, sample?.address || 'your home')
            .replace(/\{\{city\}\}/g, sample?.city || 'Cedar Rapids')
          const renderedSubject = fill(bulkEmailForm.subject)
          const renderedBody = fill(bulkEmailForm.body)
          return (
            <div>
              <p className="muted" style={{margin: '0 0 8px'}}>
                Sample using <strong>{sample ? `${sample.first_name} ${sample.last_name}` : 'first selected recipient'}</strong>
                {sample?.email ? ` (${sample.email})` : ''}
              </p>
              <div style={{padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, marginBottom: 8, fontSize: 13}}>
                <strong>Subject:</strong> {renderedSubject}
              </div>
              <iframe
                title="Email preview"
                srcDoc={autoEmbedYoutubeLinks(renderedBody)}
                style={{width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 4, background: 'white'}}
              />
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setBulkEmailPreviewOpen(false)}>Close</button>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Email Composer Modal */}
      <Modal open={emailModalOpen} onClose={() => setEmailModalOpen(false)} title={`Email ${detail?.first_name || ''} ${detail?.last_name || ''}`} wide>
        <form onSubmit={sendEmail}>
          <label>To<input value={detail?.email || ''} disabled /></label>
          <div style={{display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap'}}>
            <label style={{flex: 1, minWidth: 200}}>Template<select value={emailForm.template} onChange={e => {
              const t = emailTemplates.find(x => x.id === e.target.value)
              if (t && detail) {
                authFetch(`/api/email/preview/${t.id}/${detail.id}`).then(r => r.json()).then(d =>
                  setEmailForm(p => ({ ...p, subject: d.subject, body: d.body, template: t.id })))
                setComposerView('preview')
              } else {
                setEmailForm(p => ({ ...p, template: '' }))
              }
            }}>
              <option value="">Custom (no template)</option>
              {emailTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select></label>
            {detail?.fub_person_id && (
              <button type="button" className="btn btn-sm btn-secondary" style={{marginBottom: 2}} onClick={draftViewedPropertiesEmail} disabled={draftingPropEmail}
                title="Insert the homes this lead has viewed in Follow Up Boss">
                {draftingPropEmail ? 'Building…' : '🏡 Homes They Viewed'}
              </button>
            )}
          </div>
          <label>Subject<input value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} required /></label>

          {/* Cc / Bcc */}
          {!showCcBcc ? (
            <button type="button" onClick={() => setShowCcBcc(true)} style={{background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 12, cursor: 'pointer', padding: '2px 0', alignSelf: 'flex-start'}}>+ Add Cc / Bcc</button>
          ) : (
            <>
              <label>Cc<input value={emailForm.cc} onChange={e => setEmailForm(p => ({ ...p, cc: e.target.value }))} placeholder="comma-separated emails" /></label>
              <label>Bcc<input value={emailForm.bcc} onChange={e => setEmailForm(p => ({ ...p, bcc: e.target.value }))} placeholder="comma-separated emails" /></label>
            </>
          )}

          {/* Body — Gmail-style WYSIWYG editor by default; toggle to raw HTML source. */}
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, marginTop: 8}}>
            <span style={{fontSize: 13, fontWeight: 500}}>Body</span>
            <div style={{display: 'flex', gap: 6}}>
              <button type="button" className={`btn btn-sm ${composerView === 'wysiwyg' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setComposerView('wysiwyg')}>✎ Edit</button>
              <button type="button" className={`btn btn-sm ${composerView === 'html' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setComposerView('html')}>{'</>'} HTML</button>
              <button type="button" className="btn btn-sm btn-secondary" disabled={!emailForm.body} onClick={() => setSingleEmailPreviewOpen(true)}>👁 Preview</button>
              <label className="btn btn-sm btn-secondary" style={{cursor: 'pointer', margin: 0, position: 'relative', overflow: 'hidden'}}>
                📁 Load HTML
                <input type="file" accept=".html,.htm,text/html"
                  style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
                  onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const text = await file.text(); setEmailForm(p => ({ ...p, body: text })); setComposerView('wysiwyg'); e.target.value = '' }} />
              </label>
            </div>
          </div>
          {composerView === 'wysiwyg' ? (
            <RichTextEditor value={emailForm.body} onChange={(b) => setEmailForm(p => ({ ...p, body: b }))} minHeight={240} />
          ) : (
            <>
              <EmailToolbar textareaRef={singleEmailBodyRef} body={emailForm.body} setBody={(b) => setEmailForm(p => ({ ...p, body: b }))} showPreview={false} compact />
              <textarea ref={singleEmailBodyRef} value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} rows={18} style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}} />
            </>
          )}
          <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '4px 0'}}>
            Type freely like Gmail. Templates load in fully editable. Variables: {'{{first_name}} {{last_name}} {{city}}'} · paste a mattsmithteam.com property link → it becomes a listing card on send/preview.
          </p>

          {/* Attachments */}
          <div style={{marginTop: 8}}>
            <label className="btn btn-sm btn-secondary" style={{cursor: 'pointer', margin: 0, position: 'relative', overflow: 'hidden', display: 'inline-block'}}>
              📎 Add Attachment
              <input
                type="file"
                multiple
                style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
                onChange={async (e) => {
                  const files = Array.from(e.target.files || [])
                  if (!files.length) return
                  const newAtt = await Promise.all(files.map(file => new Promise((resolve, reject) => {
                    const reader = new FileReader()
                    reader.onload = () => resolve({
                      filename: file.name,
                      type: file.type || 'application/octet-stream',
                      size: file.size,
                      content_base64: reader.result.toString().split(',')[1],
                    })
                    reader.onerror = reject
                    reader.readAsDataURL(file)
                  })))
                  setEmailForm(p => ({ ...p, attachments: [...(p.attachments || []), ...newAtt] }))
                  e.target.value = ''
                }}
              />
            </label>
            {(emailForm.attachments || []).length > 0 && (
              <div style={{marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6}}>
                {emailForm.attachments.map((att, i) => (
                  <span key={i} className="lead-tag" style={{padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6}}>
                    📎 {att.filename} ({(att.size / 1024).toFixed(0)} KB)
                    <button
                      type="button"
                      onClick={() => setEmailForm(p => ({ ...p, attachments: p.attachments.filter((_, idx) => idx !== i) }))}
                      style={{background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 14}}
                    >✕</button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEmailModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              {sending ? 'Sending...' : 'Send Email'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Single Email Preview Modal */}
      <Modal open={singleEmailPreviewOpen} onClose={() => setSingleEmailPreviewOpen(false)} title="Email Preview" wide>
        {(() => {
          const c = detail || {}
          const fill = (s) => (s || '')
            .replace(/\{\{first_name\}\}/g, c.first_name || 'there')
            .replace(/\{\{last_name\}\}/g, c.last_name || '')
            .replace(/\{\{full_name\}\}/g, `${c.first_name || ''} ${c.last_name || ''}`.trim() || 'there')
            .replace(/\{\{address\}\}/g, c.address || 'your home')
            .replace(/\{\{city\}\}/g, c.city || 'Cedar Rapids')
          return (
            <div>
              <div style={{padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, marginBottom: 8, fontSize: 13}}>
                <strong>To:</strong> {c.email || '(no email)'}<br/>
                <strong>Subject:</strong> {fill(emailForm.subject)}
              </div>
              <iframe
                title="Email preview"
                srcDoc={autoEmbedYoutubeLinks(embedPropertyLinks(fill(emailForm.body)))}
                style={{width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 4, background: 'white'}}
              />
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setSingleEmailPreviewOpen(false)}>Close</button>
              </div>
            </div>
          )
        })()}
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
                {SIERRA_STATUSES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
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
