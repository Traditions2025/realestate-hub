import React, { useState, useEffect, useRef } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import MultiSelect from '../components/MultiSelect'
import StatusBadge from '../components/StatusBadge'
import { inlineImagesIntoBody, autoEmbedYoutubeLinks } from '../components/inlineImages'
import EmailToolbar from '../components/EmailToolbar'
import RichTextEditor, { MERGE_FIELDS } from '../components/RichTextEditor'
import TemplatePicker from '../components/TemplatePicker'
import { useColumnWidths, ResizeHandle, defaultWidthFor } from '../lib/columnResize'
import { useNavigate } from 'react-router-dom'
import { saveClientsNav, loadClientsNav, consumeClientsReturn } from '../lib/clientsNav'

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

// Cc/Bcc recipient field — chips + type-to-search over clients (adds their email).
function RecipientPicker({ label, emails, onChange }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!q || q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => {
      authFetch(`/api/clients?search=${encodeURIComponent(q.trim())}&limit=8`).then(r => r.json())
        .then(rows => setResults((Array.isArray(rows) ? rows : []).filter(c => c.email)))
        .catch(() => {})
    }, 250)
    return () => clearTimeout(t)
  }, [q])
  const add = (email) => { const e = (email || '').trim(); if (e && !emails.includes(e)) onChange([...emails, e]); setQ(''); setResults([]); setOpen(false) }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px', background: 'var(--bg-secondary)' }}>
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', minWidth: 30 }}>{label}</span>
      {emails.map(e => (
        <span key={e} className="lead-tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px' }}>
          {e}
          <button type="button" onClick={() => onChange(emails.filter(x => x !== e))} style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 13 }}>×</button>
        </span>
      ))}
      <div style={{ position: 'relative', flex: 1, minWidth: 170 }}>
        <input
          value={q}
          onChange={e => { setQ(e.target.value); setOpen(true) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (q.includes('@')) add(q) } }}
          placeholder="Search clients or type an email…"
          style={{ width: '100%', border: 'none', outline: 'none', background: 'transparent', color: 'var(--text-primary)', fontSize: 13, padding: '2px 0' }}
        />
        {open && results.length > 0 && (
          <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, background: 'var(--bg-elevated, #fff)', border: '1px solid var(--border)', borderRadius: 6, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 22px rgba(0,0,0,0.18)', marginTop: 4 }}>
            {results.map(c => (
              <button key={c.id} type="button" onClick={() => add(c.email)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', background: 'none', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 12, color: 'var(--text-primary)' }}>
                <strong>{c.first_name} {c.last_name}</strong> <span style={{ color: 'var(--text-muted)' }}>· {c.email}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// A body that has no HTML tags is plain text — convert to HTML so it renders
// (and keeps its line breaks) in the WYSIWYG editor.
function ensureHtmlBody(s) {
  const body = s || ''
  const hasTags = /<\/?(p|div|br|a|h[1-6]|ul|ol|li|strong|em|b|i|table|tr|td|img|span)\b/i.test(body)
  if (hasTags || !body.trim()) return body
  return '<p>' + body.trim().replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
}

const emptyClient = {
  first_name: '', last_name: '', email: '', phone: '', type: 'buyer', status: 'active',
  source: '', agent_assigned: '', address: '', city: '', state: 'IA', zip: '',
  budget_min: '', budget_max: '', preapproval_amount: '', preapproval_lender: '', notes: '',
  linkedin_url: '', facebook_url: ''
}

// Columns have FIXED pixel widths (a sensible baseline from `size`), and the user drags the
// header edge to resize; widths persist per table (see lib/columnResize). `size` only picks the
// default width — compact ~74, normal ~132, flex ~210, wide ~280. `align` centers/right-aligns
// compact/number columns. Optional per-column `minWidth`/`defaultWidth` override the defaults.
const LIST_COLUMNS = [
  { key: 'score',      label: 'Score',      defaultVisible: true,  size: 'compact', align: 'center', sort: { asc: 'lowest_score',  desc: 'highest_score' } },
  { key: 'name',       label: 'Name',       defaultVisible: true,  size: 'flex',    sort: { asc: 'name_az',       desc: 'name_za' } },
  { key: 'status',     label: 'Status',     defaultVisible: true,  size: 'compact', defaultWidth: 104, align: 'center' },
  { key: 'type',       label: 'Type',       defaultVisible: true,  size: 'compact', align: 'center' },
  { key: 'phone',      label: 'Phone',      defaultVisible: true,  size: 'normal' },
  { key: 'email',      label: 'Email',      defaultVisible: true,  size: 'flex' },
  { key: 'address',    label: 'Address',    defaultVisible: true,  size: 'flex' },
  { key: 'budget',     label: 'Budget',     defaultVisible: false, size: 'normal' },
  { key: 'visits',     label: 'Visits',     defaultVisible: true,  size: 'compact', align: 'center', sort: { asc: 'least_visits',  desc: 'most_visits' } },
  { key: 'source',     label: 'Source',     defaultVisible: true,  size: 'normal' },
  { key: 'last_fub_visit', label: 'Last Visit', defaultVisible: true, size: 'flex', sort: { asc: 'oldest_fub_visit', desc: 'recent_fub_visit' } },
  { key: 'registered', label: 'Registered', defaultVisible: true,  size: 'normal', sort: { asc: 'oldest_first', desc: 'recent_added' } },
  { key: 'off_market_date', label: 'Off Market Date', defaultVisible: false, size: 'normal' },
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
export const SIERRA_STATUSES = [
  { value: 'prime',         label: 'Prime' },
  { value: 'active',        label: 'Active' },
  { value: 'new',           label: 'New' },
  { value: 'qualify',       label: 'Qualify' },
  { value: 'watch',         label: 'Watch' },
  { value: 'pending',       label: 'Pending' },
  { value: 'closed',        label: 'Closed' },
  { value: 'archived',      label: 'Archived' },
  { value: 'junk',          label: 'Junk' },
  { value: 'donotcontact',  label: 'DNC' },
  { value: 'blocked',       label: 'Blocked' },
]

// Clickable column-header filter dropdown (Type / Phone / Email / Address / Source).
// Self-contained open state so multiple headers don't clash. `value` is the current
// selection; `options` is [{value,label}]; `onSelect(value)` applies it.
function ColumnFilterHeader({ className, label, value, options, onSelect }) {
  const [open, setOpen] = useState(false)
  const v = value ?? ''
  const active = !!v
  const cur = options.find(o => o.value === v)
  return (
    <div
      className={`${className} sortable ${active ? 'active' : ''}`}
      style={{ position: 'relative', cursor: 'pointer' }}
      onClick={() => setOpen(o => !o)}
      title={`Filter by ${label.toLowerCase()}`}
    >
      {label}{active && cur ? `: ${cur.label}` : ''} ▾
      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={(e) => { e.stopPropagation(); setOpen(false) }} />
          <div
            style={{ position: 'absolute', top: '100%', left: 0, zIndex: 41, marginTop: 4, minWidth: 160, maxHeight: 300, overflowY: 'auto', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 18px rgba(0,0,0,0.18)', padding: 4 }}
            onClick={(e) => e.stopPropagation()}
          >
            {options.map(o => (
              <div
                key={o.value || '__all'}
                onClick={() => { onSelect(o.value); setOpen(false) }}
                style={{ padding: '7px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer', textTransform: 'none', letterSpacing: 0, whiteSpace: 'nowrap', fontWeight: v === o.value ? 700 : 400, color: 'var(--text-primary)', background: v === o.value ? 'var(--bg-elevated)' : 'transparent' }}
              >
                {o.label}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// Bulk-pull social profiles from Follow Up Boss for all FUB-linked leads.
function FubEnrichButton() {
  const [status, setStatus] = useState(null)
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    let alive = true
    const tick = async () => { try { const r = await authFetch('/api/clients/enrich-fub-bulk/status'); const j = await r.json(); if (alive) setStatus(j) } catch {} }
    tick()
    const t = setInterval(tick, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const running = status && status.running
  const start = async () => {
    if (!confirm('Pull social profiles (LinkedIn / Facebook / job title) from Follow Up Boss for every FUB-linked lead that hasn\'t been checked yet? It runs in the background and saves into the Hub.')) return
    setStarting(true)
    try { await authFetch('/api/clients/enrich-fub-bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }) } catch {}
    setStarting(false)
  }
  return (
    <button className="btn btn-secondary" onClick={start} disabled={starting || running} title="Pull LinkedIn / Facebook / job info from Follow Up Boss and save to each lead">
      {running ? `Pulling FUB… ${status.done}/${status.total} · ${status.found} found` : '⚡ Pull socials from FUB'}
    </button>
  )
}

// Free lead social enrichment. Prefilled search links (agent finds + verifies +
// pastes) plus a free Gravatar auto-check. No paid API, no scraping.
export function SocialProfiles({ detail, onSaved }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [li, setLi] = useState(detail.linkedin_url || '')
  const [fb, setFb] = useState(detail.facebook_url || '')
  useEffect(() => { setLi(detail.linkedin_url || ''); setFb(detail.facebook_url || ''); setMsg('') }, [detail.id, detail.linkedin_url, detail.facebook_url])

  const name = `${detail.first_name || ''} ${detail.last_name || ''}`.trim()
  const city = detail.city || 'Cedar Rapids'
  const gq = (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`
  const liSearch = gq(`site:linkedin.com/in "${name}" ${city}`)
  const fbSearch = gq(`site:facebook.com "${name}" ${city}`)
  const googleSearch = gq(`"${name}" ${city} ${detail.email || ''}`.trim())

  const save = async (fields) => { await api.updateClient(detail.id, fields); onSaved && onSaved() }
  const autoCheck = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await authFetch(`/api/clients/${detail.id}/enrich-free`, { method: 'POST' })
      const j = await r.json()
      if (j.found_any) { setMsg('Found a public profile — filled what it had.'); onSaved && onSaved() }
      else setMsg('No free auto-match (most consumers have no public Gravatar). Use the search buttons to find and paste the profile.')
    } catch { setMsg('Auto-check failed.') }
    setBusy(false)
  }

  return (
    <div>
      {detail.avatar_url && <img src={detail.avatar_url} alt="" style={{ width: 56, height: 56, borderRadius: '50%', objectFit: 'cover', marginBottom: 8 }} />}
      {(detail.job_title || detail.employer) && (
        <div style={{ fontSize: 13, marginBottom: 8 }}>{detail.job_title || ''}{detail.job_title && detail.employer ? ' · ' : ''}{detail.employer || ''}</div>
      )}

      {/* LinkedIn */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>LinkedIn</div>
        {detail.linkedin_url ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a href={detail.linkedin_url} target="_blank" rel="noreferrer" style={{ color: '#0077b5', fontWeight: 600, wordBreak: 'break-all' }}>{detail.linkedin_url}</a>
            <button className="btn btn-sm btn-secondary" onClick={() => save({ linkedin_url: '' })}>Remove</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input value={li} onChange={e => setLi(e.target.value)} placeholder="Paste LinkedIn URL…" style={{ flex: '1 1 200px', minWidth: 0 }} />
            <button className="btn btn-sm btn-primary" disabled={!li.trim()} onClick={() => save({ linkedin_url: li.trim() })}>Save</button>
            <a className="btn btn-sm btn-secondary" href={liSearch} target="_blank" rel="noreferrer">🔎 Find</a>
          </div>
        )}
      </div>

      {/* Facebook */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 2 }}>Facebook</div>
        {detail.facebook_url ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a href={detail.facebook_url} target="_blank" rel="noreferrer" style={{ color: '#1877f2', fontWeight: 600, wordBreak: 'break-all' }}>{detail.facebook_url}</a>
            <button className="btn btn-sm btn-secondary" onClick={() => save({ facebook_url: '' })}>Remove</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input value={fb} onChange={e => setFb(e.target.value)} placeholder="Paste Facebook URL…" style={{ flex: '1 1 200px', minWidth: 0 }} />
            <button className="btn btn-sm btn-primary" disabled={!fb.trim()} onClick={() => save({ facebook_url: fb.trim() })}>Save</button>
            <a className="btn btn-sm btn-secondary" href={fbSearch} target="_blank" rel="noreferrer">🔎 Find</a>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
        <button className="btn btn-sm" disabled={busy} onClick={autoCheck}>{busy ? 'Checking…' : '⚡ Auto-check (free)'}</button>
        <a className="btn btn-sm btn-secondary" href={googleSearch} target="_blank" rel="noreferrer">🔎 Google this lead</a>
      </div>
      {msg && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 0' }}>{msg}</p>}
      {detail.enriched_at && <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>Last checked {new Date(detail.enriched_at).toLocaleDateString()}</p>}
    </div>
  )
}

export default function Clients() {
  const navigate = useNavigate()
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
  // Manual column widths (drag-to-resize), persisted per table. One 'clients' layout — the FSBO
  // and Cancelled/Expired views reuse the same column KEYS (just relabeled), so widths carry over.
  const { widths: colWidths, setWidthLive: setColWidthLive, commitWidth: commitColWidth, reset: resetColWidths } = useColumnWidths('clients')
  const colWidthPx = (c) => colWidths[c.key] || defaultWidthFor(c)
  const colMin = (c) => Number(c.minWidth) || 60
  const resizingRef = useRef(false)   // set true while a resize drag is active, so it never starts a column-reorder drag
  // Auto-fit a column to its rendered header + cell content (double-click the divider, or menu).
  const autoFitColumn = React.useCallback((key) => {
    const vis = colPrefs.order.map(k => LIST_COLUMNS.find(c => c.key === k)).filter(c => c && colPrefs.visible[c.key])
    const i = vis.findIndex(c => c.key === key); if (i < 0) return
    const col = vis[i]; const childIdx = i + 1   // grid child 0 is the checkbox cell
    let max = 40
    const header = document.querySelector('.client-list-header')
    if (header && header.children[childIdx]) max = Math.max(max, header.children[childIdx].scrollWidth)
    for (const row of document.querySelectorAll('.client-list-row')) {
      const cell = row.children[childIdx]
      if (cell) max = Math.max(max, cell.scrollWidth)
    }
    const px = Math.min(560, Math.max(colMin(col), max + 20))
    commitColWidth(key, px)
  }, [colPrefs, commitColWidth])
  const autoFitVisible = () => { for (const c of visibleColumns) autoFitColumn(c.key) }

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
  const [mergeOpen, setMergeOpen] = useState(false)
  const [bulkMergeOpen, setBulkMergeOpen] = useState(false)
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false)
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [textComposeClient, setTextComposeClient] = useState(null)  // lead-profile SMS composer (bulk/legacy)
  const [textPanelOpen, setTextPanelOpen] = useState(false)         // inline text box on the lead profile
  const [dialerOpen, setDialerOpen] = useState(false)               // manual dial-any-number pad
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
    sources_exclude: [],
    agents_include: [],
    last_email_op: '', last_email_days: '',
    last_text_op: '', last_text_days: '',
    ai_applied: '',
    email_statuses: [],
    has_email: '', // '' (any) | '1' (with email) | '0' (no email)
    has_phone: '', // '' (any) | '1' (with phone) | '0' (no phone)
    exclude_optouts: false,
    score_min: '',
    score_max: '',
    visits_min: '',
    visits_max: '',
    activity_days: '',
    created_days: '',
    inactive_days: '',
    has_listing_views: false,
    properties_viewed_min: '',
    fub_days_min: '',
    fub_days_max: '',
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
    // Drip campaign enrollment
    in_drip: '',   // '' (any) | '1' (in a drip) | '0' (not in a drip)
    drip_id: '',   // '' (any campaign) | a specific drip campaign id
    has_address: '', // '' (any) | '1' (has address) | '0' (no address)
    has_fsbo_status: '', // '' (any) | '1' (in the FSBO master file)
    fsbo_statuses_include: [], // ['Available','Off Market']
  })
  const [sortBy, setSortBy] = useState(() => localStorage.getItem('clients_sort') || 'recent_activity')
  useEffect(() => { localStorage.setItem('clients_sort', sortBy) }, [sortBy])
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)
  const [filterOptions, setFilterOptions] = useState({ zips: [], cities: [], sources: [], tags: [], viewed_cities: [] })
  const [dripCampaigns, setDripCampaigns] = useState([])
  const [savedLists, setSavedLists] = useState([])
  const [activeListId, setActiveListId] = useState(null)
  const [saveListOpen, setSaveListOpen] = useState(false)
  const [newListName, setNewListName] = useState('')
  const [editScoreId, setEditScoreId] = useState(null) // client id whose Realist Score is being edited inline

  // Load filter options + saved lists once
  useEffect(() => {
    authFetch('/api/clients/filter-options').then(r => r.json()).then(setFilterOptions).catch(() => {})
    authFetch('/api/lists').then(r => r.json()).then(setSavedLists).catch(() => {})
    authFetch('/api/drips').then(r => r.json()).then(d => setDripCampaigns(Array.isArray(d) ? d : (d.drips || d.rows || []))).catch(() => {})
  }, [])

  // Defensive — if any field is undefined (e.g. from a stale saved list), treat as empty
  const len = (v) => Array.isArray(v) ? v.length : 0
  const advFilterCount = (
    len(advFilters.statuses_include) + len(advFilters.statuses_exclude) +
    len(advFilters.tags_include) + len(advFilters.tags_exclude) +
    len(advFilters.zips_include) + len(advFilters.cities_include) +
    len(advFilters.viewed_cities_include) +
    len(advFilters.sources_include) + len(advFilters.sources_exclude) + len(advFilters.agents_include) + len(advFilters.email_statuses) +
    ((advFilters.last_email_op && advFilters.last_email_days) ? 1 : 0) + ((advFilters.last_text_op && advFilters.last_text_days) ? 1 : 0) + (advFilters.ai_applied ? 1 : 0) +
    (advFilters.has_email ? 1 : 0) + (advFilters.has_phone ? 1 : 0) + (advFilters.exclude_optouts ? 1 : 0) +
    (advFilters.score_min ? 1 : 0) + (advFilters.score_max ? 1 : 0) +
    (advFilters.visits_min ? 1 : 0) + (advFilters.visits_max ? 1 : 0) +
    (advFilters.activity_days ? 1 : 0) + (advFilters.created_days ? 1 : 0) +
    (advFilters.inactive_days ? 1 : 0) +
    (advFilters.has_listing_views ? 1 : 0) + (advFilters.properties_viewed_min ? 1 : 0) + (advFilters.fub_days_min ? 1 : 0) + (advFilters.fub_days_max ? 1 : 0) +
    (advFilters.has_saved_search ? 1 : 0) +
    (advFilters.search_max_price_min ? 1 : 0) + (advFilters.search_max_price_max ? 1 : 0) +
    (advFilters.search_beds_min ? 1 : 0) + (advFilters.search_baths_min ? 1 : 0) +
    (advFilters.search_sqft_min ? 1 : 0) +
    len(advFilters.search_property_types) + len(advFilters.search_regions) +
    (advFilters.has_realist ? 1 : 0) +
    (advFilters.realist_value_min ? 1 : 0) + (advFilters.realist_value_max ? 1 : 0) +
    (advFilters.realist_year_built_min ? 1 : 0) + (advFilters.realist_year_built_max ? 1 : 0) +
    (advFilters.realist_sell_score_min ? 1 : 0) +
    (advFilters.realist_owner_occupied ? 1 : 0) +
    (advFilters.in_drip ? 1 : 0) +
    (advFilters.has_address ? 1 : 0)
  )

  const hasActiveFilters = advFilterCount > 0 || tab !== 'all'

  const [pageSize, setPageSize] = useState(() => Number(localStorage.getItem('clients_page_size')) || 100)
  useEffect(() => { localStorage.setItem('clients_page_size', String(pageSize)) }, [pageSize])
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkApply, setBulkApply] = useState(null) // 'automation' | 'drip'
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false)
  const [bulkTextOpen, setBulkTextOpen] = useState(false)
  const [bulkEmailForm, setBulkEmailForm] = useState({ subject: '', body: '', template: '' })
  const [bulkComposerView, setBulkComposerView] = useState('wysiwyg') // 'wysiwyg' | 'html'
  const [bulkSending, setBulkSending] = useState(false)
  const [bulkProgress, setBulkProgress] = useState(null)
  const [bulkEmailPreviewOpen, setBulkEmailPreviewOpen] = useState(false)
  const [bulkPreviewIdx, setBulkPreviewIdx] = useState(0)
  const [bulkPreviewData, setBulkPreviewData] = useState(null)
  // Render a real recipient's personalized email (merge fields + their listings) for verification.
  const loadBulkPreview = async (idx) => {
    const ids = [...selectedIds]
    const cid = ids[idx]
    if (!cid) { setBulkPreviewData({ error: 'No recipient at that position' }); return }
    setBulkPreviewData({ loading: true })
    // Retry a couple times — a mid-deploy server returns the HTML page (not JSON).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await authFetch('/api/email/render-preview', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: cid, subject: bulkEmailForm.subject, body: bulkEmailForm.body }),
        })
        const ct = r.headers.get('content-type') || ''
        if (!r.ok || !ct.includes('json')) throw new Error('not-json')
        const d = await r.json()
        setBulkPreviewData({ ...d, total: ids.length })
        return
      } catch (e) {
        if (attempt < 2) { await new Promise(res => setTimeout(res, 1500)); continue }
        setBulkPreviewData({ error: 'The server was updating for a moment — click "Preview a recipient" again in a few seconds.' })
      }
    }
  }
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
  // Bulk "Send AI now" — routes each selected lead through the AI (opener / reply /
  // qualifying follow-up). Skips excluded prospecting leads and honors quiet hours +
  // compliance server-side. Reports a sent / skipped / blocked summary.
  const [bulkAiRunning, setBulkAiRunning] = useState(false)
  const bulkSendAI = async () => {
    if (selectedIds.size === 0) return
    const n = selectedIds.size
    if (n > 500) { alert('Select 500 or fewer leads for a bulk AI send.'); return }
    if (!confirm(`Send an AI text to ${n} selected lead${n === 1 ? '' : 's'}?\n\n• Each gets a personalized message (opener, reply, or next qualifying question).\n• Prospecting leads (FSBO / MLS Expired / MLS Cancelled) are skipped automatically.\n• Quiet hours and STOP opt-outs are respected.\n• These leads become AI-managed.`)) return
    setBulkActionsOpen(false); setBulkAiRunning(true)
    try {
      const r = await authFetch('/api/ai/bulk-send-now', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_ids: [...selectedIds] }) })
      const d = await r.json()
      if (d.error) { alert('Bulk AI send failed: ' + d.error); return }
      const blockedReasons = (d.results || []).filter(x => !x.ok && !x.skipped).map(x => x.reason)
      const quiet = blockedReasons.some(r => /quiet/i.test(r || ''))
      let msg = `AI send complete:\n\n✓ Sent: ${d.sent}\n⤼ Skipped (excluded prospecting): ${d.skipped}\n⛔ Not sent (blocked/nothing to say): ${d.blocked}`
      if (quiet) msg += `\n\nNote: some were held for quiet hours — they'll need to be re-sent after quiet hours end, or enable them individually.`
      alert(msg)
      load()
    } catch (e) { alert('Bulk AI send failed: ' + e.message) } finally { setBulkAiRunning(false) }
  }

  // Bulk "Export to CSV" — downloads the selected leads as a CSV (export is always CSV).
  // Works across the full selection, not just the loaded page, since the server pulls by id.
  const [bulkExporting, setBulkExporting] = useState(false)
  const exportSelectedCsv = async () => {
    setBulkActionsOpen(false)
    const ids = [...selectedIds]
    if (!ids.length) return
    setBulkExporting(true)
    try {
      const r = await authFetch('/api/clients/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
      if (!r.ok) throw new Error('server returned ' + r.status)
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `clients-export-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
    } catch (e) { alert('Could not export CSV: ' + e.message) } finally { setBulkExporting(false) }
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
    if (advFilters.sources_exclude.length) params.sources_exclude = advFilters.sources_exclude.join(',')
    if (advFilters.agents_include.length) params.agents_include = advFilters.agents_include.join(',')
    if (advFilters.last_email_op && advFilters.last_email_days) { params.last_email_op = advFilters.last_email_op; params.last_email_days = advFilters.last_email_days }
    if (advFilters.last_text_op && advFilters.last_text_days) { params.last_text_op = advFilters.last_text_op; params.last_text_days = advFilters.last_text_days }
    if (advFilters.ai_applied) params.ai_applied = advFilters.ai_applied
    if (advFilters.email_statuses.length) params.email_statuses = advFilters.email_statuses.join(',')
    if (advFilters.has_email) params.has_email = advFilters.has_email === true ? '1' : advFilters.has_email
    if (advFilters.has_phone) params.has_phone = advFilters.has_phone === true ? '1' : advFilters.has_phone
    if (advFilters.exclude_optouts) params.exclude_optouts = '1'
    if (advFilters.score_min) params.score_min = advFilters.score_min
    if (advFilters.score_max) params.score_max = advFilters.score_max
    if (advFilters.visits_min) params.visits_min = advFilters.visits_min
    if (advFilters.visits_max) params.visits_max = advFilters.visits_max
    if (advFilters.activity_days) params.activity_days = advFilters.activity_days
    if (advFilters.created_days) params.created_days = advFilters.created_days
    if (advFilters.inactive_days) params.inactive_days = advFilters.inactive_days
    if (advFilters.has_listing_views) params.has_listing_views = '1'
    if (advFilters.properties_viewed_min) params.properties_viewed_min = advFilters.properties_viewed_min
    if (advFilters.fub_days_min) params.fub_days_min = advFilters.fub_days_min
    if (advFilters.fub_days_max) params.fub_days_max = advFilters.fub_days_max
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
    // Drip campaign enrollment
    if (advFilters.in_drip) {
      params.in_drip = advFilters.in_drip
      if (advFilters.drip_id) params.drip_id = advFilters.drip_id
    }
    if (advFilters.has_address) params.has_address = advFilters.has_address
    if (advFilters.has_fsbo_status) params.has_fsbo_status = advFilters.has_fsbo_status === true ? '1' : advFilters.has_fsbo_status
    if (advFilters.fsbo_statuses_include?.length) params.fsbo_statuses_include = advFilters.fsbo_statuses_include.join(',')
    params.sort = sortBy
    return params
  }

  const loadSeq = useRef(0)
  const load = () => {
    const seq = ++loadSeq.current
    api.getClientsPaged(buildLoadParams()).then(({ rows, total }) => {
      if (seq !== loadSeq.current) return  // a newer filter change superseded this — ignore stale response
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
  const [sequences, setSequences] = useState(null)
  // AI Suggested Follow-Up
  const [followup, setFollowup] = useState(null)        // { exists, enough_data, recommendation, why, known, summary, email, analyzed_at, stale, ai_available }
  const [followupLoading, setFollowupLoading] = useState(false)
  const [followupErr, setFollowupErr] = useState('')
  const [fuEmail, setFuEmail] = useState(null)          // editable { subject, body }
  const [fuEmailBusy, setFuEmailBusy] = useState('')
  const [fuContext, setFuContext] = useState('')        // agent-typed context to refine the email
  const [emailHistory, setEmailHistory] = useState([])
  const [commHistory, setCommHistory] = useState([])    // unified texts + calls + voicemails + emails
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [emailForm, setEmailForm] = useState({ subject: '', body: '', template: '', attachments: [], cc: [], bcc: [] })
  const singleEmailBodyRef = useRef(null)
  const bulkEmailBodyRef = useRef(null)
  const subjectRef = useRef(null)
  // Insert a merge token at the cursor of a text input / textarea (subject line,
  // HTML source view). Keeps the caret after the inserted token.
  const insertAtCursor = (ref, current, setValue, token) => {
    const el = ref.current
    if (!el) { setValue((current || '') + token); return }
    const start = el.selectionStart ?? (current || '').length
    const end = el.selectionEnd ?? start
    const next = (current || '').slice(0, start) + token + (current || '').slice(end)
    setValue(next)
    requestAnimationFrame(() => { try { el.focus(); const pos = start + token.length; el.setSelectionRange(pos, pos) } catch {} })
  }
  const FieldMenu = ({ onPick, title }) => (
    <select value="" title={title || 'Insert a personalization field'} onChange={e => { if (e.target.value) { onPick(e.target.value); e.target.value = '' } }}
      className="btn btn-sm btn-secondary" style={{ padding: '2px 6px', height: 28 }}>
      <option value="">+ Field</option>
      {MERGE_FIELDS.map(([tok, label]) => <option key={tok} value={tok}>{label}</option>)}
    </select>
  )
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
  const [taskOpen, setTaskOpen] = useState(false)
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

  // Snapshot the current Clients list state so the full-screen profile can drive Prev/Next and
  // "Back to Clients" restores exactly where the user was. Sort/pageSize/view/columns already
  // persist in localStorage, so only the list/search/filters + scroll need capturing here.
  const captureClientsNav = () => {
    const listName = activeListId ? ((savedLists || []).find(l => l.id === activeListId)?.name || 'Clients') : 'Clients'
    const base = { backTo: '/clients', backLabel: listName, restore: { activeListId, search, advFilters }, scrollY: window.scrollY }
    // Save the loaded ids SYNCHRONOUSLY first so Prev/Next always works, then upgrade to the FULL
    // matched set (e.g. all 68 FSBO across pages) in the background using the list's own filters.
    try { saveClientsNav({ ...base, ids: items.map(i => i.id) }) } catch {}
    try {
      const params = buildLoadParams(); delete params.limit; delete params.offset
      const usp = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v != null && v !== '') usp.set(k, v)
      usp.set('limit', '5000')
      authFetch('/api/clients/ids?' + usp.toString()).then(r => r.json()).then(d => {
        if (Array.isArray(d?.ids) && d.ids.length) { try { saveClientsNav({ ...base, ids: d.ids }) } catch {} }
      }).catch(() => {})
    } catch {}
  }
  const openFullProfile = (id) => { try { captureClientsNav() } catch (e) { console.error('captureClientsNav', e) } navigate('/clients/' + id) }
  // Keep the profile's Prev/Next + Back context continuously in sync with the loaded list, so it
  // is ALWAYS populated (not dependent on the click handler running cleanly). ids = current list.
  useEffect(() => {
    if (!items || !items.length) return
    const listName = activeListId ? ((savedLists || []).find(l => l.id === activeListId)?.name || 'Clients') : 'Clients'
    try { saveClientsNav({ ids: items.map(i => i.id), backTo: '/clients', backLabel: listName, restore: { activeListId, search, advFilters }, scrollY: window.scrollY }) } catch {}
  }, [items, activeListId, search, advFilters, savedLists])
  // When returning from a profile via "Back to Clients", restore the prior list state once.
  useEffect(() => {
    if (!consumeClientsReturn()) return
    const nav = loadClientsNav(); if (!nav?.restore) return
    if (nav.restore.activeListId != null) setActiveListId(nav.restore.activeListId)
    if (typeof nav.restore.search === 'string') setSearch(nav.restore.search)
    if (nav.restore.advFilters) setAdvFilters(nav.restore.advFilters)
    if (nav.scrollY) setTimeout(() => { try { window.scrollTo(0, nav.scrollY) } catch {} }, 400)
  }, [])

  const openDetail = async (id) => {
    const d = await api.getClient(id)
    setDetail(d)
    setSierraActivity(null)
    setListingInterest(null)
    setEmailHistory([])
    setCommHistory([])
    setHubActivity(null)
    setFubActivity(null)
    setSequences(null)
    // Currently-running plans (drips + automations) for this lead
    authFetch(`/api/clients/${id}/sequences`).then(r => r.json()).then(setSequences).catch(() => setSequences({ drips: [], automations: [] }))
    // AI Suggested Follow-Up — load the cached analysis; auto-generate the first
    // time this lead is opened (never re-runs the model on later opens).
    setFollowup(null); setFollowupErr(''); setFuEmail(null); setFuContext('')
    authFetch(`/api/followup/${id}`).then(r => r.json()).then(fu => {
      setFollowup(fu)
      if (fu && fu.email) setFuEmail({ subject: fu.email.subject || '', body: fu.email.body || '' })
      if (fu && fu.exists === false && fu.ai_available) analyzeFollowup(id)
    }).catch(() => {})
    // reset per-client detail UI state
    setTagsExpanded(false); setFubExpanded(false); setListingActExpanded(false)
    setSierraExpanded(false); setTxMenuOpen(false); setNoteOpen(false); setNoteText(''); setTextPanelOpen(false); setTaskOpen(false)
    setDetailOpen(true)
    // Hub tracking activity (mattsmithteam.com pixel) — always fetch, not gated on Sierra link
    authFetch(`/api/track/activity/${id}?limit=50`).then(r => r.json()).then(setHubActivity).catch(() => {})
    // Follow Up Boss web activity — lazy-loaded LIVE from FUB (property views w/ address,
    // page visits, saved searches). Falls back to any stored rows if not linked.
    authFetch(`/api/fub/activity/live?client_id=${id}`).then(r => r.json())
      .then(d => {
        const arr = Array.isArray(d) ? d : (Array.isArray(d?.rows) ? d.rows : [])
        // newest first
        setFubActivity(arr.slice().sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0)))
      })
      .catch(() => setFubActivity([]))
    // Lazy-load Sierra activity + listing interest if it's a Sierra-synced lead
    if (d.sierra_lead_id) {
      authFetch(`/api/sierra/lead-notes/${d.sierra_lead_id}`)
        .then(r => r.json())
        // newest first
        .then(a => setSierraActivity(Array.isArray(a) ? a.slice().sort((x, y) => new Date(y.date || 0) - new Date(x.date || 0)) : []))
        .catch(() => setSierraActivity([]))
      authFetch(`/api/sierra/lead-listings/${d.sierra_lead_id}`)
        .then(r => r.json())
        .then(setListingInterest)
        .catch(() => setListingInterest({ saved_searches: [], saved_listings: [], listing_activity: [] }))
    }
    // Load email history
    authFetch(`/api/email/history/${id}`).then(r => r.json()).then(setEmailHistory).catch(() => {})
    // Unified communication history — every text, call, voicemail (and logged email)
    // on this lead, newest first, so past conversations + call logs are reviewable.
    authFetch(`/api/inbox/thread/${id}`).then(r => r.json()).then(rows => setCommHistory(Array.isArray(rows) ? rows.slice().reverse() : [])).catch(() => setCommHistory([]))
  }

  // Deep-link: /clients?open=<id> (e.g. "View profile" from the Inbox) opens that lead.
  React.useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('open'))
    if (id) { openDetail(id); window.history.replaceState({}, '', '/clients') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Remove a lead from a running plan (drip or automation) from the profile.
  const removePlan = async (kind, enrollmentId) => {
    const url = kind === 'drip'
      ? `/api/drips/enrollments/${enrollmentId}/remove`
      : `/api/automations/enrollments/${enrollmentId}/remove`
    await authFetch(url, { method: 'POST' })
    if (detail?.id) authFetch(`/api/clients/${detail.id}/sequences`).then(r => r.json()).then(setSequences).catch(() => {})
  }
  const fmtWhen = (iso) => {
    if (!iso) return '—'
    try { return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT' } catch { return iso }
  }

  // ---- AI Suggested Follow-Up ----
  const analyzeFollowup = async (idArg) => {
    const cid = idArg || detail?.id
    if (!cid) return
    setFollowupLoading(true); setFollowupErr('')
    try {
      const r = await authFetch(`/api/followup/${cid}/analyze`, { method: 'POST' })
      const d = await r.json()
      if (d.error) setFollowupErr(d.error)
      else { setFollowup(d); setFuEmail(d.email ? { subject: d.email.subject || '', body: d.email.body || '' } : null) }
    } catch (e) { setFollowupErr(e.message) }
    finally { setFollowupLoading(false) }
  }
  const adjustFollowupEmail = async (instruction, context) => {
    if (!detail?.id || !fuEmail) return
    setFuEmailBusy(context ? 'context' : instruction); setFollowupErr('')
    try {
      const r = await authFetch(`/api/followup/${detail.id}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, context, current: fuEmail }) })
      const d = await r.json()
      if (d.error) setFollowupErr(d.error)
      else if (d.email) { setFuEmail({ subject: d.email.subject || '', body: d.email.body || '' }); if (context) setFuContext('') }
    } catch (e) { setFollowupErr(e.message) }
    finally { setFuEmailBusy('') }
  }
  const useFollowupEmail = () => {
    if (!fuEmail) return
    const html = (fuEmail.body || '').split(/\n{2,}/).map(p => `<div>${p.replace(/\n/g, '<br>')}</div>`).join('<div><br></div>')
    const body = teamSignature ? `${html}<div><br></div><div><br></div>${teamSignature}` : html
    setComposerView('wysiwyg'); setShowCcBcc(false)
    setEmailForm({ subject: fuEmail.subject || '', body, template: '__followup__', attachments: [], cc: [], bcc: [] })
    setEmailModalOpen(true)
  }
  const copyFollowupEmail = () => {
    if (!fuEmail) return
    const text = `Subject: ${fuEmail.subject || ''}\n\n${fuEmail.body || ''}`
    try { navigator.clipboard.writeText(text) } catch {}
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
        .then(d => setEmailForm({ subject: d.subject, body: d.body, template: templateId, attachments: [], cc: [], bcc: [] }))
    } else {
      // New blank email — start with a couple of blank lines above the signature, Gmail-style.
      const startBody = teamSignature ? `<div><br></div><div><br></div>${teamSignature}` : ''
      setEmailForm({ subject: '', body: startBody, template: '', attachments: [], cc: [], bcc: [] })
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
      setEmailForm(p => ({ subject: d.subject, body: d.body, template: '__homes__', attachments: [], cc: p.cc || [], bcc: p.bcc || [] }))
      setComposerView('wysiwyg')
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
      zips_include: [], cities_include: [], viewed_cities_include: [], sources_include: [], sources_exclude: [], agents_include: [],
      last_email_op: '', last_email_days: '', last_text_op: '', last_text_days: '', ai_applied: '',
      email_statuses: [],
      has_email: '', has_phone: '', exclude_optouts: false,
      score_min: '', score_max: '', visits_min: '', visits_max: '',
      activity_days: '', created_days: '', inactive_days: '',
      has_listing_views: false, properties_viewed_min: '', fub_days_min: '', fub_days_max: '',
      has_saved_search: false,
      search_max_price_min: '', search_max_price_max: '',
      search_beds_min: '', search_baths_min: '', search_sqft_min: '',
      search_property_types: [], search_regions: [],
      has_realist: false,
      realist_value_min: '', realist_value_max: '',
      realist_year_built_min: '', realist_year_built_max: '',
      realist_sell_score_min: '', realist_owner_occupied: '',
      in_drip: '', drip_id: '', has_address: '',
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

  // Overwrite the active saved list with whatever filters are currently set —
  // so you can tweak a filter and update the list without recreating it.
  const updateSavedList = async () => {
    if (!activeListId) return
    const filter_criteria = { ...advFilters }
    if (tab !== 'all') filter_criteria.statuses_include = [...(filter_criteria.statuses_include || []), tab]
    if (search) filter_criteria.search = search
    const r = await authFetch(`/api/lists/${activeListId}`, {
      method: 'PUT',
      body: JSON.stringify({ filter_criteria, description: `Filter-based list (${totalCount.toLocaleString()} matches)` }),
    })
    if (r.ok) {
      const name = savedLists.find(l => l.id === activeListId)?.name || 'List'
      alert(`Updated "${name}" — it now uses the current filters (${totalCount.toLocaleString()} matches).`)
      authFetch('/api/lists').then(r => r.json()).then(setSavedLists)
    } else alert('Could not update the list.')
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
          sources_exclude: f.sources_exclude || [],
          agents_include: f.agents_include || [],
          last_email_op: f.last_email_op || '', last_email_days: f.last_email_days || '',
          last_text_op: f.last_text_op || '', last_text_days: f.last_text_days || '',
          ai_applied: f.ai_applied || '',
          email_statuses: f.email_statuses || [],
          has_email: (f.has_email === true || f.has_email === '1') ? '1' : (f.has_email === '0' ? '0' : ''),
          has_phone: (f.has_phone === true || f.has_phone === '1') ? '1' : (f.has_phone === '0' ? '0' : ''),
          exclude_optouts: !!f.exclude_optouts,
          score_min: f.score_min || '',
          score_max: f.score_max || '',
          visits_min: f.visits_min || '',
          visits_max: f.visits_max || '',
          activity_days: f.activity_days || '',
          created_days: f.created_days || '',
          inactive_days: f.inactive_days || '',
          has_listing_views: !!f.has_listing_views,
          properties_viewed_min: f.properties_viewed_min || '',
          fub_days_min: f.fub_days_min || '',
          fub_days_max: f.fub_days_max || '',
          has_saved_search: !!f.has_saved_search,
          search_max_price_min: f.search_max_price_min || '',
          search_max_price_max: f.search_max_price_max || '',
          search_beds_min: f.search_beds_min || '',
          search_baths_min: f.search_baths_min || '',
          search_sqft_min: f.search_sqft_min || '',
          search_property_types: f.search_property_types || [],
          search_regions: f.search_regions || [],
          in_drip: f.in_drip || '',
          drip_id: f.drip_id || '',
          has_address: f.has_address || '',
          has_fsbo_status: (f.has_fsbo_status === true || f.has_fsbo_status === 1 || f.has_fsbo_status === '1') ? '1' : '',
          fsbo_statuses_include: f.fsbo_statuses_include || [],
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
    setBulkComposerView('wysiwyg')
    if (templateId) {
      const t = emailTemplates.find(x => x.id === templateId)
      if (t) {
        setBulkEmailForm({ subject: t.subject, body: ensureHtmlBody(t.body), template: templateId })
      }
    } else {
      setBulkEmailForm({ subject: '', body: '', template: '' })
    }
    setBulkEmailOpen(true)
  }

  // Step 1: clicking "Review & Send" opens the preview carousel (verify recipients first).
  const reviewBulkEmail = (e) => {
    if (e) e.preventDefault()
    if (selectedIds.size === 0) return alert('No clients selected')
    if (!bulkEmailForm.body || !bulkEmailForm.body.trim()) return alert('Add a message first')
    setBulkPreviewIdx(0); setBulkEmailPreviewOpen(true); loadBulkPreview(0)
  }
  // Step 2: actual send — fired from inside the preview modal after reviewing.
  const doBulkSend = async () => {
    if (selectedIds.size === 0) return alert('No clients selected')
    setBulkEmailPreviewOpen(false)
    setBulkSending(true)
    setBulkProgress({ running: true, done: 0, total: selectedIds.size, sent: 0, skipped: 0, failed: 0 })
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
      if (d.error) { alert('Bulk send error: ' + d.error); setBulkSending(false); setBulkProgress(null); return }
      // Poll progress until the background send finishes.
      const poll = async () => {
        const s = await authFetch('/api/email/bulk-status').then(x => x.json()).catch(() => null)
        if (s) setBulkProgress(s)
        if (!s || s.running) { setTimeout(poll, 1500); return }
        setBulkSending(false)
        setBulkProgress(null)
        alert(`✓ Bulk send complete: ${s.sent} sent · ${s.skipped} skipped${s.noListings ? ` (${s.noListings} had no listings)` : ''} · ${s.failed} failed`)
        setBulkEmailOpen(false)
        setSelectedIds(new Set())
      }
      poll()
    } catch (err) {
      alert('Send failed: ' + err.message)
      setBulkSending(false); setBulkProgress(null)
    }
  }

  const sendEmail = async (e) => {
    e.preventDefault()
    if (!detail.email) { alert('No email address for this client'); return }
    if (!emailForm.body || !emailForm.body.trim()) { alert('Add an email body first'); return }
    const clean = (arr) => (Array.isArray(arr) ? arr : []).map(x => String(x).trim()).filter(x => /@/.test(x))
    setSending(true)
    try {
      const r = await authFetch('/api/email/send', {
        method: 'POST',
        body: JSON.stringify({
          client_id: detail.id,
          subject: emailForm.subject,
          body: embedPropertyLinks(emailForm.body),
          template: emailForm.template === '__homes__' ? '' : emailForm.template,
          cc: clean(emailForm.cc),
          bcc: clean(emailForm.bcc),
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

    const isSierraLead = editing && editingOriginal && editingOriginal.sierra_lead_id

    // Local save first. If it fails, tell the user — the change did NOT save.
    try {
      if (editing) await api.updateClient(editing, data)
      else await api.createClient(data)
    } catch (err) {
      alert('Save failed — your change was NOT saved. Please try again.\n\n' + (err?.message || err))
      return
    }

    // For a Sierra-sourced lead, push the edited fields (name/phone/email/address/
    // status) to Sierra too — otherwise the next Sierra sync overwrites them back.
    if (isSierraLead) {
      try {
        const r = await authFetch('/api/sierra/update-lead-fields', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client_id: editing, fields: data })
        })
        const result = await r.json()
        if (!result.success && !result.skipped) {
          alert('Saved in the Hub, but pushing to Sierra failed — it may revert on the next sync.\n\nDetails: ' + (result.error || 'unknown'))
        }
      } catch (err) {
        alert('Saved in the Hub, but pushing to Sierra failed — it may revert on the next sync.\n\n' + err.message)
      }
    }

    setModalOpen(false)
    // Refresh the open profile so it reflects the edit (was showing stale data).
    if (editing && detail?.id === editing) {
      try { const fresh = await authFetch(`/api/clients/${editing}`).then(r => r.json()); setDetail(fresh) } catch {}
    }
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
  // always push to Sierra automatically (no confirm) when there's a sierra_lead_id.
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
    load()
  }

  // Inline Realist Score entry from the list. Saves to lead_score; the backend
  // derives the A-F grade and Sierra sync preserves it (won't overwrite with blank).
  const saveScore = async (item, value) => {
    setEditScoreId(null)
    const digits = String(value ?? '').replace(/[^0-9]/g, '')
    const nextVal = digits === '' ? null : digits
    if (String(item.lead_score ?? '') === String(nextVal ?? '')) return
    try {
      await api.updateClient(item.id, { lead_score: nextVal })
    } catch (err) {
      alert('Failed to save Realist Score: ' + err.message)
      return
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
    if (s === 'donotcontact') return 'DNC'
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
          <button className="btn btn-secondary" onClick={() => setDialerOpen(true)} title="Dial any number (even one not in the database)">☎ Dialer</button>
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
                    <div className="columns-picker-hint">Drag to reorder. Toggle checkboxes to show/hide. Drag a header edge to resize (double-click it to auto-fit).</div>
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
                    <div style={{ borderTop: '1px solid var(--border)', marginTop: 6, paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <button className="btn-link" style={{ textAlign: 'left' }} onClick={resetColWidths} title="Remove your custom column widths and restore the default widths (does not change which columns are shown)">↔ Reset Column Widths</button>
                      <button className="btn-link" style={{ textAlign: 'left' }} onClick={autoFitVisible} title="Size each visible column to fit its content">⇥ Auto-Fit Visible Columns</button>
                    </div>
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
              <h5>Sources (Include)</h5>
              <MultiSelect
                placeholder={`Search ${filterOptions.sources.length} sources...`}
                options={filterOptions.sources}
                selected={advFilters.sources_include}
                onChange={v => setAdvFilters(p => ({ ...p, sources_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Sources (Exclude)</h5>
              <MultiSelect mode="exclude"
                placeholder="Exclude sources..."
                options={filterOptions.sources}
                selected={advFilters.sources_exclude}
                onChange={v => setAdvFilters(p => ({ ...p, sources_exclude: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Assigned Agent</h5>
              <MultiSelect
                placeholder={`Search ${(filterOptions.agents || []).length} agents...`}
                options={[{ value: '__unassigned__', label: 'Unassigned' }, ...(filterOptions.agents || [])]}
                selected={advFilters.agents_include}
                onChange={v => setAdvFilters(p => ({ ...p, agents_include: v }))}
              />
            </div>
            <div className="filter-section">
              <h5>Last Email Sent</h5>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={advFilters.last_email_op} onChange={e => setAdvFilters(p => ({ ...p, last_email_op: e.target.value }))} style={{ padding: '6px 8px', fontSize: 13 }}>
                  <option value="">Any</option>
                  <option value="more">More than</option>
                  <option value="less">Less than</option>
                </select>
                <input type="number" min="1" value={advFilters.last_email_days} onChange={e => setAdvFilters(p => ({ ...p, last_email_days: e.target.value }))} placeholder="days" style={{ width: 70, padding: '6px 8px', fontSize: 13 }} disabled={!advFilters.last_email_op} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>days ago</span>
              </div>
            </div>
            <div className="filter-section">
              <h5>Last Text Sent</h5>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={advFilters.last_text_op} onChange={e => setAdvFilters(p => ({ ...p, last_text_op: e.target.value }))} style={{ padding: '6px 8px', fontSize: 13 }}>
                  <option value="">Any</option>
                  <option value="more">More than</option>
                  <option value="less">Less than</option>
                </select>
                <input type="number" min="1" value={advFilters.last_text_days} onChange={e => setAdvFilters(p => ({ ...p, last_text_days: e.target.value }))} placeholder="days" style={{ width: 70, padding: '6px 8px', fontSize: 13 }} disabled={!advFilters.last_text_op} />
                <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>days ago</span>
              </div>
            </div>
            <div className="filter-section">
              <h5>AI Applied</h5>
              <select value={advFilters.ai_applied} onChange={e => setAdvFilters(p => ({ ...p, ai_applied: e.target.value }))} style={{ padding: '6px 8px', fontSize: 13, width: '100%' }}>
                <option value="">Any</option>
                <option value="yes">Yes — AI applied</option>
                <option value="no">No — never touched by AI</option>
              </select>
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
            <h5>Listing Views (Follow Up Boss)</h5>
            <label style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 8}}>
              <input type="checkbox" checked={advFilters.has_listing_views}
                onChange={e => setAdvFilters(p => ({ ...p, has_listing_views: e.target.checked }))} />
              Only clients with website activity
            </label>
            <div className="filter-other-row" style={{marginBottom: 8}}>
              <label className="filter-num">
                Properties viewed (min #)
                <input type="number" min="1" placeholder="e.g. 1" value={advFilters.properties_viewed_min}
                  onChange={e => setAdvFilters(p => ({ ...p, properties_viewed_min: e.target.value }))} />
              </label>
            </div>
            <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px'}}>“Properties viewed” = leads who actually viewed that many listings (so the Homes email always has homes to show).</p>
            <div style={{fontSize: 12, color: 'var(--text-muted)', marginBottom: 4}}>Last listing visit (days ago):</div>
            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8}}>
              {[{ l: '≤ 30', min: '', max: '30' }, { l: '30–60', min: '30', max: '60' }, { l: '60–90', min: '60', max: '90' }, { l: '90+', min: '90', max: '' }].map(r => {
                const active = advFilters.fub_days_min === r.min && advFilters.fub_days_max === r.max && (r.min || r.max)
                return (
                  <button key={r.l} type="button" className={`btn btn-sm ${active ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setAdvFilters(p => active
                      ? ({ ...p, fub_days_min: '', fub_days_max: '' })
                      : ({ ...p, fub_days_min: r.min, fub_days_max: r.max, has_listing_views: true }))}>
                    {r.l}
                  </button>
                )
              })}
            </div>
            <div className="filter-other-row">
              <label className="filter-num">
                Min days ago
                <input type="number" min="0" placeholder="e.g. 30" value={advFilters.fub_days_min} onChange={e => setAdvFilters(p => ({ ...p, fub_days_min: e.target.value }))} />
              </label>
              <label className="filter-num">
                Max days ago
                <input type="number" min="0" placeholder="e.g. 60" value={advFilters.fub_days_max} onChange={e => setAdvFilters(p => ({ ...p, fub_days_max: e.target.value }))} />
              </label>
            </div>
          </div>

          <div className="filter-section">
            <h5>Drip Campaigns</h5>
            <div style={{display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8}}>
              {[{ v: '', l: 'Any' }, { v: '1', l: 'In a drip' }, { v: '0', l: 'Not in a drip' }].map(o => (
                <button key={o.l} type="button"
                  className={`btn btn-sm ${advFilters.in_drip === o.v ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAdvFilters(p => ({ ...p, in_drip: o.v, drip_id: o.v ? p.drip_id : '' }))}>
                  {o.l}
                </button>
              ))}
            </div>
            {advFilters.in_drip && (
              <label className="filter-num" style={{display: 'block'}}>
                {advFilters.in_drip === '0' ? 'Not enrolled in campaign' : 'Enrolled in campaign'}
                <select value={advFilters.drip_id} onChange={e => setAdvFilters(p => ({ ...p, drip_id: e.target.value }))}>
                  <option value="">Any drip campaign</option>
                  {dripCampaigns.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
            )}
            <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0'}}>“In a drip” = currently enrolled (active) in a drip sequence. Pick a campaign to scope it, or leave as Any campaign.</p>
          </div>

          <div className="filter-section">
            <h5>Other</h5>
            <div className="filter-other-row">
              <label className="filter-num">
                Email
                <select value={advFilters.has_email === true ? '1' : (advFilters.has_email || '')} onChange={e => setAdvFilters(p => ({ ...p, has_email: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="1">With email</option>
                  <option value="0">No email</option>
                </select>
              </label>
              <label className="filter-num">
                Phone
                <select value={advFilters.has_phone === true ? '1' : (advFilters.has_phone || '')} onChange={e => setAdvFilters(p => ({ ...p, has_phone: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="1">With phone</option>
                  <option value="0">No phone</option>
                </select>
              </label>
              <label className="filter-num">
                Address
                <select value={advFilters.has_address} onChange={e => setAdvFilters(p => ({ ...p, has_address: e.target.value }))}>
                  <option value="">Any</option>
                  <option value="1">Has address</option>
                  <option value="0">No address</option>
                </select>
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
              <label className="filter-num" style={{flex: 1, minWidth: 260}}>
                Property types (comma-separated, e.g. SingleFamily, Condo)
                <input
                  type="text"
                  placeholder="SingleFamily, Condo, Townhouse"
                  value={advFilters.search_property_types.join(', ')}
                  onChange={e => setAdvFilters(p => ({ ...p, search_property_types: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
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
              ...p, has_email: '1', exclude_optouts: true,
              email_statuses: ['ValidAddress', 'TwoWayEmailing'],
            }))}>Email-ready</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, has_email: '1', exclude_optouts: true,
              statuses_include: ['prime', 'active'],
              email_statuses: ['ValidAddress', 'TwoWayEmailing'],
            }))}>Hot Leads (Prime+Active)</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, statuses_exclude: ['junk', 'donotcontact', 'blocked', 'archived', 'closed'],
              has_email: '1', exclude_optouts: true,
            }))}>Active Pipeline</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, activity_days: '7', has_email: '1', exclude_optouts: true,
            }))}>🔥 Active This Week</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, created_days: '7', has_email: '1', exclude_optouts: true,
            }))}>🆕 New This Week</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, inactive_days: '90', has_email: '1', exclude_optouts: true,
              statuses_exclude: ['junk', 'donotcontact', 'blocked', 'archived', 'closed'],
            }))}>💤 Re-engagement (90d+)</button>
            <button className="btn btn-sm btn-secondary" onClick={() => setAdvFilters(p => ({
              ...p, visits_min: '5', has_email: '1', exclude_optouts: true,
            }))}>👁️ High Engagement (5+ visits)</button>
          </div>

          {activeListId && (
            <div style={{display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center', paddingTop: 8}}>
              <span style={{fontSize: 12, color: 'var(--text-muted)', marginRight: 'auto'}}>Editing “{savedLists.find(l => l.id === activeListId)?.name || 'list'}”</span>
              <button className="btn-sm btn-primary" onClick={updateSavedList} title="Save the current filters into this list">↻ Update this list</button>
              <button className="btn-sm btn-danger" onClick={() => deleteSavedList(activeListId)}>Delete this list</button>
            </div>
          )}
        </div>
      )}

      {/* Bulk apply automation / drip */}
      {bulkApply && (
        <BulkApplyModal kind={bulkApply} clientIds={[...selectedIds]} onClose={() => setBulkApply(null)}
          onDone={() => { setBulkApply(null); clearSelection() }} />
      )}

      {textComposeClient && (
        <TextComposerModal client={textComposeClient}
          onClose={() => setTextComposeClient(null)}
          onSent={() => { if (detail?.id === textComposeClient.id) openDetail(textComposeClient.id) }} />
      )}

      {dialerOpen && <ManualDialer onClose={() => setDialerOpen(false)} />}

      {bulkTextOpen && (
        <BulkTextModal clientIds={[...selectedIds]} onClose={() => setBulkTextOpen(false)}
          onDone={() => { setBulkTextOpen(false); clearSelection() }} />
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
                disabled={batchRefreshState?.running || bulkAiRunning}
              >
                {batchRefreshState?.running
                  ? `↻ Refreshing ${batchRefreshState.done}/${batchRefreshState.total}...`
                  : bulkAiRunning
                    ? `🤖 Sending AI…`
                    : `Bulk Actions ▾`}
              </button>
              {bulkActionsOpen && (
                <div className="bulk-actions-menu">
                  <button onClick={() => { setBulkActionsOpen(false); openBulkEmail() }}>
                    ✉ Email Selected
                  </button>
                  <button onClick={() => { setBulkActionsOpen(false); setBulkTextOpen(true) }}>
                    💬 Text Selected
                  </button>
                  <button onClick={bulkSendAI} title="Have the AI text each selected lead (opener / reply / next qualifying question). Skips prospecting leads; respects quiet hours + opt-outs.">
                    🤖 Send AI (First Text / Follow-Up)
                  </button>
                  <button onClick={() => { setBulkActionsOpen(false); if (selectedIds.size) window.location.assign('/dialer?client_ids=' + [...selectedIds].join(',')) }}>
                    ☎ Call Leads (Power Dialer)
                  </button>
                  <div className="bulk-actions-divider" />
                  <button onClick={exportSelectedCsv} disabled={bulkExporting} title="Download the selected leads as a CSV file">
                    ⬇ {bulkExporting ? 'Exporting…' : 'Export to CSV'}
                  </button>
                  <div className="bulk-actions-divider" />
                  <div className="bulk-actions-section-label">Organize</div>
                  <button onClick={() => { setBulkActionsOpen(false); setBulkMergeOpen(true) }} title="Merge the selected leads into one (combines all history, notes, calls, texts, emails)">🔀 Merge Selected</button>
                  <button onClick={() => { setBulkActionsOpen(false); setBulkAssignOpen(true) }}>👤 Assign Agent</button>
                  <button onClick={() => { setBulkActionsOpen(false); setBulkTagsOpen(true) }}>🏷 Add / Remove Tags</button>
                  <div className="bulk-actions-divider" />
                  <div className="bulk-actions-section-label">Enroll</div>
                  <button onClick={() => { setBulkActionsOpen(false); setBulkApply('drip') }}>💧 Apply Drip Campaign</button>
                  <button onClick={() => { setBulkActionsOpen(false); setBulkApply('automation') }}>⚡ Apply Automation</button>
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
        // Fixed pixel widths: columns keep the width the user set and never redistribute; when
        // the total exceeds the viewport the list scrolls horizontally (readability over squeeze).
        const gridTemplate = `30px ${visibleColumns.map(c => colWidthPx(c) + 'px').join(' ')}`

        // In the FSBO list the "Visits" column is repurposed as "FSBO Status"
        // (Available / Off Market) from the FSBO master file.
        const isFsboList = (savedLists.find(l => l.id === activeListId)?.name || '').toUpperCase() === 'FSBO'

        // Cell renderers: one entry per column key. Each returns JSX for one cell.
        const renderHeaderCell = (col) => {
          // FSBO Status -> click-to-filter (Available / Off Market).
          if (isFsboList && col.key === 'visits') {
            const cur = (advFilters.fsbo_statuses_include && advFilters.fsbo_statuses_include.length === 1) ? advFilters.fsbo_statuses_include[0] : ''
            return <ColumnFilterHeader key="visits" className="cl-visits" label="FSBO Status" value={cur}
              options={[{ value: '', label: 'All' }, { value: 'Available', label: 'Available' }, { value: 'Off Market', label: 'Off Market' }]}
              onSelect={v => setAdvFilters(p => ({ ...p, fsbo_statuses_include: v ? [v] : [] }))} />
          }
          // DOM -> sortable (days on market).
          if (isFsboList && col.key === 'type') {
            const arrow = sortBy === 'fsbo_dom_high' ? '▼' : sortBy === 'fsbo_dom_low' ? '▲' : '⇅'
            return <div key="type" className={`cl-type sortable ${(sortBy === 'fsbo_dom_high' || sortBy === 'fsbo_dom_low') ? 'active' : ''}`} onClick={() => setSortBy(sortBy === 'fsbo_dom_high' ? 'fsbo_dom_low' : 'fsbo_dom_high')} title="Click to sort by days on market">DOM {arrow}</div>
          }
          if (isFsboList && col.key === 'registered') return <div key="registered" className="cl-registered">List Date</div>
          // These column headers double as click-to-filter dropdowns.
          if (col.key === 'type') {
            return <ColumnFilterHeader key="type" className="cl-type" label="Type" value={filter.type}
              options={[{ value: '', label: 'All' }, { value: 'buyer', label: 'Buyer' }, { value: 'seller', label: 'Seller' }, { value: 'both', label: 'Buyer/Seller' }]}
              onSelect={v => setFilter(p => ({ ...p, type: v }))} />
          }
          if (col.key === 'phone') {
            return <ColumnFilterHeader key="phone" className="cl-phone" label="Phone" value={advFilters.has_phone === true ? '1' : (advFilters.has_phone || '')}
              options={[{ value: '', label: 'All' }, { value: '1', label: 'With phone' }, { value: '0', label: 'No phone' }]}
              onSelect={v => setAdvFilters(p => ({ ...p, has_phone: v }))} />
          }
          if (col.key === 'email') {
            return <ColumnFilterHeader key="email" className="cl-email" label="Email" value={advFilters.has_email === true ? '1' : (advFilters.has_email || '')}
              options={[{ value: '', label: 'All' }, { value: '1', label: 'With email' }, { value: '0', label: 'No email' }]}
              onSelect={v => setAdvFilters(p => ({ ...p, has_email: v }))} />
          }
          if (col.key === 'address') {
            return <ColumnFilterHeader key="address" className="cl-address" label="Address" value={advFilters.has_address || ''}
              options={[{ value: '', label: 'All' }, { value: '1', label: 'With address' }, { value: '0', label: 'No address' }]}
              onSelect={v => setAdvFilters(p => ({ ...p, has_address: v }))} />
          }
          if (col.key === 'source') {
            if (isFsboList) return <div key="source" className="cl-source">Listing</div>
            const srcVal = advFilters.sources_include.length === 1 ? advFilters.sources_include[0] : ''
            const srcOptions = [{ value: '', label: advFilters.sources_include.length > 1 ? `Multiple (${advFilters.sources_include.length})` : 'All sources' }]
            for (const s of (filterOptions.sources || [])) {
              const val = typeof s === 'string' ? s : (s.value ?? s.label)
              const lbl = typeof s === 'string' ? s : (s.label ?? s.value)
              if (val) srcOptions.push({ value: val, label: lbl })
            }
            return <ColumnFilterHeader key="source" className="cl-source" label="Source" value={srcVal}
              options={srcOptions}
              onSelect={v => setAdvFilters(p => ({ ...p, sources_include: v ? [v] : [] }))} />
          }
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
              return <div key="score" className="cl-score" onClick={e => e.stopPropagation()}>
                {editScoreId === item.id ? (
                  <input
                    type="number" min="0" max="1000" autoFocus
                    defaultValue={item.lead_score ?? ''}
                    onBlur={e => saveScore(item, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); else if (e.key === 'Escape') setEditScoreId(null) }}
                    style={{ width: 58, padding: '2px 4px', fontSize: 13, textAlign: 'center' }}
                  />
                ) : (
                  <span
                    onClick={() => setEditScoreId(item.id)}
                    title="Click to enter the Realist Score"
                    style={{ cursor: 'pointer' }}
                  >
                    {item.lead_score !== null && item.lead_score !== undefined && item.lead_score !== '' ? (
                      <span className={`lead-score grade-${(item.lead_grade || 'F').replace('+','plus').toLowerCase()}`}>
                        {item.lead_score}{item.lead_grade && <span className="lead-grade">{item.lead_grade}</span>}
                      </span>
                    ) : <span className="lead-score-empty">—</span>}
                  </span>
                )}
              </div>
            case 'name':
              // List view: just the name for a clean list. The Sierra source badge and
              // tags still render on each lead's profile detail drawer. The name is a real
              // link so right-click / middle-click / Cmd-click can open the full-screen
              // profile in a new tab; a plain click falls through to the row handler.
              return <div key="name" className="cl-name">
                <a href={'/clients/' + item.id} className="cl-name-link"
                  onClick={e => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) { e.stopPropagation(); return } e.preventDefault() /* let the row onClick open full screen */ }}
                  style={{ color: 'inherit', textDecoration: 'none' }}>
                  <strong>{item.first_name} {item.last_name}</strong>
                </a>
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
              if (isFsboList) return <div key="type" className="cl-type" title="Days on market (FSBO master file)">{item.fsbo_dom != null && item.fsbo_dom !== '' ? item.fsbo_dom : '—'}</div>
              return <div key="type" className="cl-type">
                {item.type && (
                  <span className={`type-pill type-${item.type}`}>
                    {item.type === 'buyer' ? 'Buyer' : item.type === 'seller' ? 'Seller' : 'Buyer/Seller'}
                  </span>
                )}
              </div>
            case 'phone':
              return <div key="phone" className="cl-phone">{item.phone || '—'}</div>
            case 'email':
              return <div key="email" className="cl-email">
                {item.email || '—'}
                {item.email_status && item.email_status !== 'Unknown' && <span className="email-status-tag">{item.email_status}</span>}
                {item.marketing_email_opt_out
                  ? <span className="email-status-tag" style={{ background: '#fee2e2', color: '#b91c1c' }} title="Opted out of marketing email (still emailable — tagged)">Email opt-out</span>
                  : (item.ealert_opt_out ? <span className="email-status-tag" style={{ background: '#fef3c7', color: '#92400e' }} title="Only unsubscribed from property alerts — still fine to email">Alerts off</span> : null)}
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
              if (isFsboList) {
                const fs = item.fsbo_status
                const color = fs === 'Available' ? '#10b981' : fs === 'Off Market' ? '#ef4444' : 'var(--text-muted)'
                return <div key="visits" className="cl-visits" title="FSBO status (master file)">
                  {fs ? <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: color, padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}>{fs}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </div>
              }
              return <div key="visits" className="cl-visits">{item.visits || 0}</div>
            case 'source':
              // FSBO list: the Source column becomes the listing link(s) (Zillow, from the master file).
              if (isFsboList) {
                let listings = []
                try { listings = JSON.parse(item.fsbo_listings || '[]') } catch {}
                const links = listings.map(l => l.link).filter(Boolean)
                const primary = links[0] || item.fsbo_link
                const extra = Math.max(0, (links.length || (item.fsbo_link ? 1 : 0)) - 1)
                return <div key="source" className="cl-source">
                  {primary
                    ? <a href={primary} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: '#006aff', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }} title={links.join('\n') || item.fsbo_link}>View Listing ↗{extra > 0 ? ` (+${extra})` : ''}</a>
                    : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                </div>
              }
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
            case 'registered': {
              // FSBO list: show the master-file List Date instead of the registration date.
              if (isFsboList) {
                const ld = item.fsbo_list_date
                return <div key="registered" className="cl-registered" title="List date (FSBO master file)">
                  {ld ? (() => { const d = new Date(String(ld).replace(' ', 'T')); return isNaN(d) ? ld : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) })() : '—'}
                </div>
              }
              // Prefer the real FUB registration date; fall back to the Sierra
              // import date only when a lead has no FUB register date.
              const reg = (item.register_date && item.register_date.trim()) ? item.register_date : item.sierra_creation_date
              const fromFub = !!(item.register_date && item.register_date.trim())
              return <div key="registered" className="cl-registered" title={fromFub ? `${reg} (from FUB)` : (reg || '')}>
                {reg
                  ? new Date(String(reg).replace(' ', 'T')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  : '—'}
              </div>
            }
            case 'off_market_date':
              return <div key="off_market_date" className="cl-registered">
                {item.off_market_date
                  ? (() => { const d = new Date(String(item.off_market_date).replace(' ', 'T')); return isNaN(d) ? item.off_market_date : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) })()
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
              {visibleColumns.map(col => (
                <div key={col.key} draggable
                  onDragStart={e => { if (resizingRef.current) { e.preventDefault(); return } setDragColKey(col.key); e.dataTransfer.effectAllowed = 'move' }}
                  onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                  onDrop={e => { e.preventDefault(); reorderColumn(dragColKey, col.key); setDragColKey(null) }}
                  onDragEnd={() => setDragColKey(null)}
                  className="cl-col-drag"
                  style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: col.align === 'center' ? 'center' : col.align === 'right' ? 'flex-end' : 'flex-start', minWidth: 0, cursor: 'grab', opacity: dragColKey === col.key ? 0.4 : 1, borderLeft: dragColKey && dragColKey !== col.key ? '2px solid transparent' : undefined }}
                  onDragEnter={e => { if (dragColKey && dragColKey !== col.key) e.currentTarget.style.borderLeft = '2px solid var(--accent, #2563eb)' }}
                  onDragLeave={e => { e.currentTarget.style.borderLeft = '2px solid transparent' }}
                  title="Drag to move this column">
                  {renderHeaderCell(col)}
                  <ResizeHandle
                    getWidth={() => colWidthPx(col)} min={colMin(col)}
                    onResizeLive={px => { resizingRef.current = true; setColWidthLive(col.key, px) }}
                    onCommit={px => { commitColWidth(col.key, px); setTimeout(() => { resizingRef.current = false }, 0) }}
                    onAutoFit={() => autoFitColumn(col.key)} />
                </div>
              ))}
            </div>
            {items.map(item => (
              <React.Fragment key={item.id}>
                {/* Desktop / tablet: full configurable row */}
                <div className={`client-list-row ${selectedIds.has(item.id) ? 'selected' : ''}`}
                  style={{ gridTemplateColumns: gridTemplate }}
                  onClick={() => openFullProfile(item.id)}>
                  <div className="cl-check" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                  </div>
                  {visibleColumns.map(col => {
                    const cell = renderCell(col, item)
                    // Line body cells up with their (aligned) header — center/right per the column's align.
                    if (cell && (col.align === 'center' || col.align === 'right')) {
                      const ta = col.align === 'center' ? 'center' : 'right'
                      const jc = col.align === 'center' ? 'center' : 'flex-end'
                      return React.cloneElement(cell, { style: { ...(cell.props.style || {}), textAlign: ta, justifyContent: jc } })
                    }
                    return cell
                  })}
                </div>
                {/* Mobile: condensed card — name, status, last activity only */}
                <div className={`client-card-m ${selectedIds.has(item.id) ? 'selected' : ''}`}
                  onClick={() => openFullProfile(item.id)}>
                  <div className="ccm-check" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                  </div>
                  <div className="ccm-name">
                    <strong>{item.first_name} {item.last_name}</strong>
                    {item.lead_score !== null && item.lead_score !== undefined && (
                      <span className={`lead-score grade-${(item.lead_grade || 'F').replace('+', 'plus').toLowerCase()}`}>
                        {item.lead_score}{item.lead_grade && <span className="lead-grade">{item.lead_grade}</span>}
                      </span>
                    )}
                  </div>
                  <div className="ccm-status" onClick={e => e.stopPropagation()}>
                    <select className={`status-quick-select status-${item.status}`} value={item.status || ''}
                      onChange={e => quickStatusChange(item, e.target.value, e)}>
                      {SIERRA_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                  <div className="ccm-activity">
                    {item.last_fub_activity_at ? (
                      <>
                        <span className="ccm-date">{new Date(String(item.last_fub_activity_at).replace(' ', 'T')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        {(item.last_fub_activity_type || item.last_fub_activity_detail) && (
                          <span className="ccm-muted"> · {item.last_fub_activity_type}{item.last_fub_activity_detail ? ` ${item.last_fub_activity_detail}` : ''}</span>
                        )}
                      </>
                    ) : <span className="ccm-muted">No recent activity</span>}
                  </div>
                </div>
              </React.Fragment>
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
          <div key={item.id} className="client-card" onClick={() => openFullProfile(item.id)}>
            <div className="client-card-header">
              <div className="client-avatar" style={{background: item.sierra_lead_id ? '#8b5cf6' : '#3b82f6'}}>
                {item.first_name?.[0]}{item.last_name?.[0]}
              </div>
              <div style={{flex: 1}}>
                <div className="client-name">{item.first_name} {item.last_name}</div>
                <div className="client-type">
                  <span className={`client-type-badge type-${item.type}`}>{item.type}</span>
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
                <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8}}>
                  <button className="btn btn-secondary btn-sm" onClick={() => gotoAdjacent(-1)} disabled={idx <= 0}>‹ Prev</button>
                  <button className="btn btn-sm" onClick={() => { setDetailOpen(false); openFullProfile(detail.id) }} title="Open this lead in the full-screen workspace">⤢ Full screen</button>
                  <span style={{fontSize: 12, color: 'var(--text-muted)'}}>{idx >= 0 ? `${idx + 1} of ${items.length}` : ''}</span>
                  <button className="btn btn-secondary btn-sm" onClick={() => gotoAdjacent(1)} disabled={idx < 0 || idx >= items.length - 1}>Next ›</button>
                </div>
              )
            })()}

            {/* Communication + transaction actions */}
            <div className="lead-action-bar">
              <div className="lead-action-bar-row">
                {detail.email && (
                  <button className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('')} title={detail.marketing_email_opt_out ? 'This contact is tagged opted-out of email — sending is allowed but use judgment' : undefined}>
                    <span className="lead-action-icon">✉</span>
                    <span>Email{detail.marketing_email_opt_out ? ' (opted out)' : ''}</span>
                  </button>
                )}
                {detail.phone && !detail.hub_text_opt_out && (
                  <button className={`lead-action-btn lead-action-text${textPanelOpen ? ' active' : ''}`} title="Send an SMS from your Hub number" onClick={() => setTextPanelOpen(o => !o)}>
                    <span className="lead-action-icon">💬</span>
                    <span>Text</span>
                  </button>
                )}
                {detail.phone && (
                  <button className="lead-action-btn lead-action-call" title="Call from the Hub" onClick={() => window.hubCall && window.hubCall(detail.phone, `${detail.first_name || ''} ${detail.last_name || ''}`.trim())}>
                    <span className="lead-action-icon">📞</span>
                    <span>Call</span>
                  </button>
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

                <button className={`lead-action-btn${taskOpen ? ' active' : ''}`} onClick={() => setTaskOpen(o => !o)}>
                  <span className="lead-action-icon">✅</span>
                  <span>Add Task</span>
                </button>

                {detail.sierra_lead_id && (
                  <button className="lead-action-btn lead-action-refresh" onClick={refreshFromSierra} disabled={refreshing} title="Pull this lead's latest data from Sierra">
                    <span className="lead-action-icon">{refreshing ? '⟳' : '↻'}</span>
                    <span>{refreshing ? 'Refreshing...' : 'Refresh from Sierra'}</span>
                  </button>
                )}
              </div>
              {taskOpen && (
                <QuickAddTask clientId={detail.id} clientName={`${detail.first_name || ''} ${detail.last_name || ''}`.trim()} onAdded={() => load()} />
              )}
              {noteOpen && (
                <div style={{marginTop: 10, display: 'flex', gap: 8, alignItems: 'flex-start'}}>
                  <textarea value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="Add an internal note…" rows={2} style={{flex: 1, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, resize: 'vertical'}} />
                  <button className="btn btn-primary btn-sm" onClick={saveQuickNote} disabled={savingNote || !noteText.trim()}>{savingNote ? 'Saving…' : 'Save Note'}</button>
                </div>
              )}
              {textPanelOpen && detail.phone && !detail.hub_text_opt_out && (
                <InlineTextComposer client={detail} onClose={() => setTextPanelOpen(false)}
                  onSent={() => { if (detail?.id) openDetail(detail.id) }} />
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

            {detail?.id && <AiIsaCard clientId={detail.id} />}

            {/* ===== AI Suggested Follow-Up ===== */}
            <div className="detail-section followup-card" style={{ border: '1px solid rgba(124,58,237,0.35)', background: 'rgba(124,58,237,0.06)', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h4 style={{ color: '#a78bfa', margin: 0, flex: 1 }}>🧭 Suggested Follow-Up</h4>
                {followup && followup.analyzed_at && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Last analyzed {fmtWhen(followup.analyzed_at)}</span>}
                <button className="btn btn-sm" onClick={() => analyzeFollowup()} disabled={followupLoading} title="Re-analyze this client's history and generate a fresh recommendation">
                  {followupLoading ? '…' : '↻ Refresh'}
                </button>
              </div>

              {followupErr && <div style={{ marginTop: 8, fontSize: 12, color: 'var(--danger)' }}>{followupErr}</div>}

              {followupLoading ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>Analyzing the full relationship…</div>
              ) : !followup ? (
                <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 10 }}>Loading…</div>
              ) : followup.ai_available === false ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 10 }}>AI is not configured on the server.</div>
              ) : followup.exists === false ? (
                <div style={{ marginTop: 10 }}><button className="btn btn-primary btn-sm" onClick={() => analyzeFollowup()}>✨ Generate recommendation</button></div>
              ) : followup.enough_data === false ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 10 }}>Not enough client history to make a confident follow-up recommendation yet.</div>
              ) : (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {followup.stale && (
                    <div style={{ fontSize: 11.5, color: 'var(--warning)' }}>● New activity since this was analyzed — <button onClick={() => analyzeFollowup()} style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11.5 }}>refresh</button></div>
                  )}
                  {followup.recommendation && (
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', fontWeight: 700 }}>Recommended next step</div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginTop: 3 }}>{followup.recommendation.label}</div>
                      {followup.recommendation.rationale && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>{followup.recommendation.rationale}</div>}
                    </div>
                  )}
                  {Array.isArray(followup.why) && followup.why.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 4 }}>Why this is recommended</div>
                      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{followup.why.map((w, i) => <li key={i}>{w}</li>)}</ul>
                    </div>
                  )}
                  {Array.isArray(followup.known) && followup.known.length > 0 && (
                    <details>
                      <summary style={{ fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer' }}>Known client context</summary>
                      <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>{followup.known.map((k, i) => <li key={i}>{k}</li>)}</ul>
                    </details>
                  )}
                  {followup.summary && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', fontStyle: 'italic', borderLeft: '2px solid rgba(124,58,237,0.4)', paddingLeft: 10 }}>{followup.summary}</div>}

                  {fuEmail ? (
                    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                      <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 6 }}>Suggested email</div>
                      <input value={fuEmail.subject} onChange={e => setFuEmail(v => ({ ...v, subject: e.target.value }))} placeholder="Subject" style={{ width: '100%', marginBottom: 6, padding: '7px 9px', fontSize: 13, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />
                      <textarea value={fuEmail.body} onChange={e => setFuEmail(v => ({ ...v, body: e.target.value }))} rows={7} style={{ width: '100%', padding: '8px 10px', fontSize: 13, lineHeight: 1.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', resize: 'vertical' }} />
                      {/* Agent-typed context: an insight the AI folds into the email (e.g. "this property is now pending") */}
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <input value={fuContext} onChange={e => setFuContext(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter' && fuContext.trim() && !fuEmailBusy) adjustFollowupEmail(null, fuContext.trim()) }}
                          placeholder="Add context for the AI (e.g. this property is now pending, they just had a baby, push showings)…"
                          style={{ flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 12.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />
                        <button className="btn btn-primary btn-sm" disabled={!!fuEmailBusy || !fuContext.trim()} onClick={() => adjustFollowupEmail(null, fuContext.trim())} title="Rewrite the email using this context">
                          {fuEmailBusy === 'context' ? '…' : 'Apply context'}
                        </button>
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                        {[['regenerate', '↻ Regenerate'], ['shorter', 'Shorter'], ['casual', 'More casual'], ['direct', 'More direct']].map(([ins, label]) => (
                          <button key={ins} className="btn btn-sm" disabled={!!fuEmailBusy} onClick={() => adjustFollowupEmail(ins)}>{fuEmailBusy === ins ? '…' : label}</button>
                        ))}
                        <button className="btn btn-sm" onClick={copyFollowupEmail}>Copy</button>
                        <button className="btn btn-primary btn-sm" onClick={useFollowupEmail} style={{ marginLeft: 'auto' }}>✉ Use in composer</button>
                      </div>
                    </div>
                  ) : (followup.recommendation && followup.recommendation.action !== 'none' && (
                    <div><button className="btn btn-sm" disabled={!!fuEmailBusy} onClick={() => adjustFollowupEmail('regenerate')}>{fuEmailBusy ? '…' : '✍ Draft a follow-up email'}</button></div>
                  ))}
                </div>
              )}
            </div>

            <div className="detail-grid">
              <div className="detail-section">
                <h4>Contact Info</h4>
                <InlineName detail={detail} onSaved={() => openDetail(detail.id)} />
                <InlineField label="Phone" field="phone" value={detail.phone} clientId={detail.id} onSaved={() => openDetail(detail.id)}
                  statusTag={detail.phone_status && detail.phone_status !== 'Unknown' ? <span className="email-status-tag">{detail.phone_status}</span> : null} />
                <InlineField label="Email" field="email" type="email" value={detail.email} clientId={detail.id} onSaved={() => openDetail(detail.id)}
                  statusTag={detail.email_status && detail.email_status !== 'Unknown' ? <span className="email-status-tag">{detail.email_status}</span> : null} />
                {detail.alt_phones && <p style={{ margin: '2px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}><strong>Other phones:</strong> {detail.alt_phones}</p>}
                {detail.alt_emails && <p style={{ margin: '2px 0', fontSize: 12.5, color: 'var(--text-secondary)' }}><strong>Other emails:</strong> {detail.alt_emails}</p>}
                <InlineField label="Address" field="address" value={detail.address} clientId={detail.id} onSaved={() => openDetail(detail.id)} />
                <p><strong>City:</strong> {detail.city || '—'}{detail.state ? `, ${detail.state}` : ''} {detail.zip || ''}</p>
                {(() => {
                  let listings = []
                  try { listings = JSON.parse(detail.fsbo_listings || '[]') } catch {}
                  if (!listings.length && (detail.fsbo_link || detail.fsbo_status)) listings = [{ address: detail.address, link: detail.fsbo_link, status: detail.fsbo_status }]
                  if (!listings.length) return null
                  return <div style={{ margin: '4px 0' }}>
                    <strong>FSBO Listing{listings.length > 1 ? `s (${listings.length})` : ''}:</strong>
                    <ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                      {listings.map((l, i) => <li key={i} style={{ fontSize: 13, marginBottom: 2 }}>
                        {l.address || '—'}{l.status ? ` (${l.status})` : ''}
                        {l.link && <> — <a href={l.link} target="_blank" rel="noopener noreferrer" style={{ color: '#006aff', fontWeight: 600, textDecoration: 'none' }}>View on Zillow ↗</a></>}
                      </li>)}
                    </ul>
                  </div>
                })()}
                <InlineStatus detail={detail} onSaved={() => openDetail(detail.id)} />
                <p><strong>Source:</strong> {detail.source || '—'}</p>
                <p><strong>Agent:</strong> {detail.agent_assigned || '—'}</p>
                {detail.register_date && <p><strong>Registered:</strong> {new Date(detail.register_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })} <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(from FUB)</span></p>}
                {detail.marketing_email_opt_out ? <p style={{color: '#b45309'}}><strong>Email Opt-Out:</strong> Tagged (still emailable — note many of these are only property-alert unsubscribes)</p> : null}
                {!detail.marketing_email_opt_out && detail.ealert_opt_out ? <p style={{color: '#92400e'}}><strong>Property Alerts:</strong> Unsubscribed (email is still fine)</p> : null}
                {detail.hub_text_opt_out ? <p style={{ color: '#ef4444' }}><strong>Texting stopped:</strong> replied STOP to our number — no texts (calling is still allowed)</p> : null}
                {!detail.hub_text_opt_out && detail.text_opt_out ? <p style={{ color: '#92400e' }}><strong>Prior text opt-out:</strong> on file from before (informational — texting from the Hub is still allowed)</p> : null}
                {detail.sierra_lead_id && <p><strong>Sierra ID:</strong> {detail.sierra_lead_id}</p>}
              </div>
              <div className="detail-section">
                <h4>Social Profiles</h4>
                <SocialProfiles detail={detail} onSaved={() => openDetail(detail.id)} />
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

            <ContactTimeline clientId={detail.id} />

            {/* Active Plans — drips + automations currently running for this lead */}
            {sequences && ((sequences.drips && sequences.drips.length) || (sequences.automations && sequences.automations.length)) ? (
              <div className="detail-section" style={{background: 'rgba(37,99,235,0.06)', border: '1px solid rgba(37,99,235,0.22)', borderRadius: 8, padding: '12px 16px'}}>
                <h4 style={{color: 'var(--accent)'}}>💧 Active Plans ({(sequences.drips ? sequences.drips.length : 0) + (sequences.automations ? sequences.automations.length : 0)})</h4>
                {(sequences.drips || []).map(d => (
                  <div key={'d' + d.enrollment_id} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)'}}>
                    <span style={{fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#2563eb', background: 'rgba(37,99,235,0.12)', padding: '2px 7px', borderRadius: 4}}>Drip</span>
                    <div style={{flex: 1, minWidth: 0}}>
                      <div style={{fontWeight: 600, fontSize: 13}}>{d.drip_name}</div>
                      <div style={{fontSize: 11.5, color: 'var(--text-muted)'}}>Email {(d.current_step || 0) + 1} of {d.total_steps} · next {fmtWhen(d.next_run_at)}</div>
                    </div>
                    <button className="btn btn-sm" onClick={() => removePlan('drip', d.enrollment_id)} style={{fontSize: 11, padding: '4px 8px'}}>Remove</button>
                  </div>
                ))}
                {(sequences.automations || []).map(a => (
                  <div key={'a' + a.enrollment_id} style={{display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)'}}>
                    <span style={{fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: '#7c3aed', background: 'rgba(124,58,237,0.12)', padding: '2px 7px', borderRadius: 4}}>Automation</span>
                    <div style={{flex: 1, minWidth: 0}}>
                      <div style={{fontWeight: 600, fontSize: 13}}>{a.automation_name}</div>
                      <div style={{fontSize: 11.5, color: 'var(--text-muted)'}}>{a.status === 'waiting' ? 'Waiting' : 'Active'}{a.next_run_at ? ` · next ${fmtWhen(a.next_run_at)}` : ''}</div>
                    </div>
                    <button className="btn btn-sm" onClick={() => removePlan('automation', a.enrollment_id)} style={{fontSize: 11, padding: '4px 8px'}}>Remove</button>
                  </div>
                ))}
              </div>
            ) : null}

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

            {/* ===== Communication History — every text, call, voicemail & logged email ===== */}
            <div className="detail-section">
              <h4>Communication History{commHistory.length ? ` (${commHistory.length})` : ''}</h4>
              {commHistory.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No texts, calls, or voicemails logged yet. Everything sent or received here is recorded automatically.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 360, overflowY: 'auto', paddingRight: 4 }}>
                  {commHistory.map(m => {
                    const meta = COMM_META[m.channel] || { icon: '•', label: m.channel, color: 'var(--text-muted)' }
                    const out = m.direction === 'outgoing'
                    const missed = m.channel === 'call' && String(m.delivery_status || '').toLowerCase() === 'missed'
                    const isCallish = m.channel === 'call' || m.channel === 'voicemail'
                    const text = commToText(m.body || m.preview || m.subject || '')
                    return (
                      <div key={m.id} style={{ border: '1px solid var(--border)', borderLeft: `3px solid ${meta.color}`, borderRadius: 6, padding: '7px 10px', background: 'var(--bg-secondary)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--text-muted)', marginBottom: text || isCallish ? 3 : 0 }}>
                          <span style={{ color: meta.color, fontWeight: 700 }}>{meta.icon} {meta.label}</span>
                          <span title={out ? 'Outgoing' : 'Incoming'}>{out ? '↗ sent' : '↙ received'}</span>
                          {m.duration_sec ? <span>· {fmtDur(m.duration_sec)}</span> : null}
                          {m.disposition ? <span>· {m.disposition}</span> : null}
                          {missed ? <span style={{ color: '#ef4444', fontWeight: 700 }}>· Missed</span> : null}
                          {m.agent ? <span>· {m.agent}</span> : null}
                          <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>{fmtCommWhen(m.occurred_at)}</span>
                        </div>
                        {m.channel === 'email' && m.subject && <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>{commToText(m.subject)}</div>}
                        {text && <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.45 }}>{text}</div>}
                        {isCallish && m.recording_url && <audio controls preload="none" src={recUrl(m.id)} style={{ marginTop: 6, width: 260, maxWidth: '100%', height: 32 }} />}
                        {m.transcript && <div style={{ fontSize: 12, marginTop: 5, fontStyle: 'italic', color: 'var(--text-secondary)' }}>“{m.transcript}”</div>}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

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
              <button className="btn btn-secondary" onClick={() => setMergeOpen(true)}>🔀 Merge with existing lead</button>
              <button className="btn btn-danger" onClick={() => { remove(detail.id); setDetailOpen(false) }}>Delete</button>
            </div>
          </div>
        )}
      </Modal>

      {/* Merge with existing lead */}
      {mergeOpen && detail && (
        <MergeLeadModal current={detail} onClose={() => setMergeOpen(false)}
          onDone={(survivorId) => { setMergeOpen(false); setDetailOpen(false); load(); if (survivorId) openDetail(survivorId) }} />
      )}

      {/* Bulk: merge / assign agent / tags */}
      {bulkMergeOpen && (
        <BulkMergeModal leads={items.filter(c => selectedIds.has(c.id))} ids={[...selectedIds]}
          onClose={() => setBulkMergeOpen(false)}
          onDone={(survivorId) => { setBulkMergeOpen(false); clearSelection(); load(); if (survivorId) openDetail(survivorId) }} />
      )}
      {bulkAssignOpen && (
        <BulkAssignAgentModal ids={[...selectedIds]} onClose={() => setBulkAssignOpen(false)}
          onDone={() => { setBulkAssignOpen(false); clearSelection(); load() }} />
      )}
      {bulkTagsOpen && (
        <BulkTagsModal ids={[...selectedIds]} allTags={filterOptions.tags || []} onClose={() => setBulkTagsOpen(false)}
          onDone={() => { setBulkTagsOpen(false); clearSelection(); load() }} />
      )}

      {/* Bulk Email Modal */}
      <Modal open={bulkEmailOpen} onClose={() => setBulkEmailOpen(false)} title={`Bulk Email — ${selectedIds.size} recipients`} wide>
        <form onSubmit={reviewBulkEmail}>
          <div style={{padding: '10px 14px', background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', borderRadius: 6, fontSize: 13, marginBottom: 12}}>
            ⚠️ This will send to {selectedIds.size} clients. Opt-outs and invalid emails will be skipped automatically.
          </div>
          <label>Template<select value={bulkEmailForm.template} onChange={async e => {
            const v = e.target.value
            setBulkComposerView('wysiwyg')
            if (v === '__homes__') {
              // Load the editable "Homes They Viewed" wording — each recipient's own
              // viewed listings get injected where {{properties}} is, at send time.
              const rows = await authFetch('/api/templates?type=email').then(r => r.json()).catch(() => [])
              const h = (Array.isArray(rows) ? rows : []).find(t => t.name === 'Homes They Viewed')
              setBulkEmailForm({
                template: '__homes__',
                subject: h?.subject || 'Do you want to see any of these properties?',
                body: ensureHtmlBody(h?.body || `<p>{{greeting}} {{first_name}}, would you like any more info or to go and see any of these properties?</p>\n{{properties}}\n<p>Just reply and let me know which ones catch your eye and I'll set up the showings.</p>\n{{signature}}`),
              })
              return
            }
            const t = emailTemplates.find(x => x.id === v)
            if (t) setBulkEmailForm({ subject: t.subject, body: ensureHtmlBody(t.body), template: t.id })
            else setBulkEmailForm(p => ({ ...p, template: '' }))
          }}>
            <option value="">Custom (no template)</option>
            <option value="__homes__">🏡 Homes They Viewed (each recipient's own listings)</option>
            {emailTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
          <label>Subject<input value={bulkEmailForm.subject} onChange={e => setBulkEmailForm(p => ({ ...p, subject: e.target.value }))} required /></label>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4}}>
            <span style={{fontSize: 13, fontWeight: 500}}>Message</span>
            <div style={{display: 'flex', gap: 6}}>
              <button type="button" className={`btn btn-sm ${bulkComposerView === 'wysiwyg' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBulkComposerView('wysiwyg')}>✎ Edit</button>
              <button type="button" className={`btn btn-sm ${bulkComposerView === 'html' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBulkComposerView('html')}>{'</>'} HTML</button>
              <button type="button" className="btn btn-sm btn-secondary" disabled={!bulkEmailForm.body || selectedIds.size === 0}
                onClick={() => { setBulkPreviewIdx(0); setBulkEmailPreviewOpen(true); loadBulkPreview(0) }}>👁 Preview a recipient</button>
              <label className="btn btn-sm btn-secondary" style={{cursor: 'pointer', margin: 0, position: 'relative', overflow: 'hidden'}} title="Load an HTML file (.html) into the body">
                📁 Load HTML
                <input type="file" accept=".html,.htm,text/html"
                  style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
                  onChange={async (e) => { const file = e.target.files?.[0]; if (!file) return; const text = await file.text(); setBulkEmailForm(p => ({ ...p, body: text })); setBulkComposerView('wysiwyg'); e.target.value = '' }} />
              </label>
            </div>
          </div>
          {bulkComposerView === 'wysiwyg' ? (
            <RichTextEditor value={bulkEmailForm.body} onChange={(b) => setBulkEmailForm(p => ({ ...p, body: b }))} minHeight={260} />
          ) : (
            <>
              <EmailToolbar textareaRef={bulkEmailBodyRef} body={bulkEmailForm.body} setBody={(b) => setBulkEmailForm(p => ({ ...p, body: b }))} showPreview={false} compact />
              <textarea ref={bulkEmailBodyRef} value={bulkEmailForm.body} onChange={e => setBulkEmailForm(p => ({ ...p, body: e.target.value }))} rows={18} style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}} />
            </>
          )}
          <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 8px'}}>
            Auto-fills per recipient: {'{{first_name}} {{last_name}} {{city}}'} · {'{{properties}}'} = their viewed listings · {'{{signature}}'} = your saved signature. Use <strong>👁 Preview a recipient</strong> to verify before sending.
          </p>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setBulkEmailOpen(false)} disabled={bulkSending}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={bulkSending}>
              {bulkSending
                ? (bulkProgress ? `Sending ${bulkProgress.done}/${bulkProgress.total}…` : 'Starting…')
                : `👁 Review & Send to ${selectedIds.size}`}
            </button>
          </div>
          {bulkSending && bulkProgress && (
            <div style={{marginTop: 8}}>
              <div style={{height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden'}}>
                <div style={{height: '100%', width: `${Math.round(100 * (bulkProgress.done || 0) / Math.max(1, bulkProgress.total || 1))}%`, background: 'var(--accent, #2563eb)', transition: 'width .3s'}} />
              </div>
              <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '6px 0 0'}}>
                {bulkProgress.sent || 0} sent · {bulkProgress.skipped || 0} skipped · {bulkProgress.failed || 0} failed — pulling each recipient's live listings, keep this open.
              </p>
            </div>
          )}
        </form>
      </Modal>

      {/* Bulk Email Preview Modal — renders a REAL recipient (merge fields + their listings) */}
      <Modal open={bulkEmailPreviewOpen} onClose={() => setBulkEmailPreviewOpen(false)} title="Preview a recipient" wide>
        {(() => {
          const d = bulkPreviewData
          if (!d || d.loading) return <p className="muted">Rendering this recipient's email…</p>
          if (d.error) return <p style={{color: '#ef4444'}}>Preview failed: {d.error}</p>
          return (
            <div>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, margin: '0 0 8px'}}>
                <p className="muted" style={{margin: 0}}>
                  Recipient <strong>{bulkPreviewIdx + 1} of {d.total || selectedIds.size}</strong>: <strong>{d.to}</strong>
                  {bulkEmailForm.body.includes('{{properties}}') && (
                    <span style={{marginLeft: 8, color: d.has_listings ? '#10b981' : '#ef4444'}}>
                      {d.has_listings ? '✓ listings found (live)' : '✗ no listings for this lead — will be skipped'}
                    </span>
                  )}
                </p>
                <div style={{display: 'flex', gap: 6}}>
                  <button type="button" className="btn btn-sm btn-secondary" disabled={bulkPreviewIdx <= 0} onClick={() => { const i = bulkPreviewIdx - 1; setBulkPreviewIdx(i); loadBulkPreview(i) }}>‹ Prev</button>
                  <button type="button" className="btn btn-sm btn-secondary" disabled={bulkPreviewIdx >= selectedIds.size - 1} onClick={() => { const i = bulkPreviewIdx + 1; setBulkPreviewIdx(i); loadBulkPreview(i) }}>Next recipient ›</button>
                </div>
              </div>
              <div style={{padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, marginBottom: 8, fontSize: 13}}>
                <strong>Subject:</strong> {d.subject}
              </div>
              <iframe
                title="Email preview"
                srcDoc={autoEmbedYoutubeLinks(embedPropertyLinks(d.body))}
                style={{width: '100%', height: '58vh', border: '1px solid var(--border)', borderRadius: 4, background: 'white'}}
              />
              <div className="form-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setBulkEmailPreviewOpen(false)}>Keep editing</button>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>Reviewed {bulkPreviewIdx + 1}/{selectedIds.size} — use Next › to check more</span>
                <button type="button" className="btn btn-primary" disabled={bulkSending} onClick={doBulkSend}>
                  ✉ Send to {selectedIds.size} Recipients
                </button>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Email Composer Modal */}
      <Modal open={emailModalOpen} onClose={() => setEmailModalOpen(false)} title={`Email ${detail?.first_name || ''} ${detail?.last_name || ''}`} wide>
        <form onSubmit={sendEmail}>
          <label>To<input value={detail?.email || ''} disabled /></label>
          <label>Template<select value={emailForm.template} disabled={draftingPropEmail} onChange={e => {
            const v = e.target.value
            if (v === '__homes__') { draftViewedPropertiesEmail(); return }
            const t = emailTemplates.find(x => x.id === v)
            if (t && detail) {
              authFetch(`/api/email/preview/${t.id}/${detail.id}`).then(r => r.json()).then(d =>
                setEmailForm(p => ({ ...p, subject: d.subject, body: d.body, template: t.id })))
              setComposerView('wysiwyg')
            } else {
              setEmailForm(p => ({ ...p, template: '' }))
            }
          }}>
            <option value="">Custom (no template)</option>
            {detail?.fub_person_id && <option value="__homes__">🏡 Homes They Viewed</option>}
            {emailTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select></label>
          {draftingPropEmail && <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '2px 0'}}>Building “Homes They Viewed”…</p>}
          <label>Subject
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input ref={subjectRef} value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} required style={{ flex: 1 }} />
              <FieldMenu title="Insert a field into the subject line" onPick={tok => insertAtCursor(subjectRef, emailForm.subject, (v) => setEmailForm(p => ({ ...p, subject: v })), tok)} />
            </div>
          </label>

          {/* Cc — always ready, with client search. Bcc behind a toggle. */}
          <div style={{marginTop: 4}}>
            <RecipientPicker label="Cc" emails={emailForm.cc} onChange={(arr) => setEmailForm(p => ({ ...p, cc: arr }))} />
          </div>
          {showCcBcc ? (
            <div style={{marginTop: 4}}>
              <RecipientPicker label="Bcc" emails={emailForm.bcc} onChange={(arr) => setEmailForm(p => ({ ...p, bcc: arr }))} />
            </div>
          ) : (
            <button type="button" onClick={() => setShowCcBcc(true)} style={{background: 'none', border: 'none', color: 'var(--accent, #2563eb)', fontSize: 12, cursor: 'pointer', padding: '2px 0', alignSelf: 'flex-start'}}>+ Add Bcc</button>
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
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                <EmailToolbar textareaRef={singleEmailBodyRef} body={emailForm.body} setBody={(b) => setEmailForm(p => ({ ...p, body: b }))} showPreview={false} compact />
                <FieldMenu title="Insert a field into the body" onPick={tok => insertAtCursor(singleEmailBodyRef, emailForm.body, (v) => setEmailForm(p => ({ ...p, body: v })), tok)} />
              </div>
              <textarea ref={singleEmailBodyRef} value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} rows={18} style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}} />
            </>
          )}
          <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '4px 0'}}>
            Type freely like Gmail. Use the <strong>+ Field</strong> menu (on the subject and body) to drop in personalization like {'{{first_name}}'}, {'{{address}}'}, {'{{city}}'} anywhere — they fill in per recipient on send. Paste a mattsmithteam.com property link → it becomes a listing card on send/preview.
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

// Bulk-enroll the selected clients into an automation or a drip campaign.
function BulkApplyModal({ kind, clientIds, onClose, onDone }) {
  const [items, setItems] = useState(null)
  const [selId, setSelId] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const url = kind === 'automation' ? '/api/automations' : '/api/drips'
    authFetch(url).then(r => r.json()).then(d => {
      let list = Array.isArray(d) ? d : []
      if (kind === 'automation') list = list.filter(a => a.status === 'active') // only active automations can enroll
      setItems(list)
    }).catch(() => setItems([]))
  }, [kind])
  const apply = async () => {
    if (!selId) return
    setBusy(true)
    const url = kind === 'automation' ? `/api/automations/${selId}/enroll` : `/api/drips/${selId}/enroll`
    const r = await authFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_ids: clientIds }) }).then(x => x.json()).catch(e => ({ error: e.message }))
    setBusy(false)
    if (r.error) return alert(r.error)
    const name = (items || []).find(i => i.id === Number(selId))?.name || (kind === 'automation' ? 'automation' : 'drip')
    const skipped = (r.skipped != null) ? r.skipped : (clientIds.length - (r.enrolled || 0))
    alert(`Enrolled ${r.enrolled} of ${clientIds.length} selected into “${name}”.` +
      (skipped > 0 ? `\n${skipped} skipped — already in a drip campaign, no email on file, a bad/wrong address, or Do-Not-Contact.` : ''))
    onDone()
  }
  const title = kind === 'automation' ? 'Apply Automation' : 'Apply Drip Campaign'
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="form">
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 10px' }}>
          Enroll the <strong>{clientIds.length.toLocaleString()}</strong> selected client{clientIds.length === 1 ? '' : 's'} into a {kind === 'automation' ? 'workflow' : 'drip campaign'}. Emails and texts are automatically held on US federal holidays.
        </p>
        {items === null ? <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
          : items.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>{kind === 'automation' ? 'No active automations. Activate one first on the Automations page.' : 'No drip campaigns yet. Create one on the Templates → Drip Campaigns tab.'}</p>
            : (
              <label>Choose {kind === 'automation' ? 'automation' : 'drip campaign'}
                <select value={selId} onChange={e => setSelId(e.target.value)} autoFocus>
                  <option value="">— pick one —</option>
                  {items.map(i => <option key={i.id} value={i.id}>{i.name}{kind === 'automation' ? ` (${i.enrolled || 0} enrolled)` : ` · ${(i.steps || []).length} emails`}</option>)}
                </select>
              </label>
            )}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={busy || !selId}>{busy ? 'Enrolling…' : `Enroll ${clientIds.length.toLocaleString()}`}</button>
        </div>
      </div>
    </Modal>
  )
}

// --- Inline field editors for the lead profile (edit a single field in place) ---
// Saves to the Hub, then pushes to Sierra (no-op for non-Sierra leads) so the edit
// sticks past the next sync. onSaved refreshes the profile.
export function InlineField({ label, value, field, clientId, onSaved, statusTag = null, type = 'text' }) {
  const [editing, setEditing] = React.useState(false)
  const [val, setVal] = React.useState(value || '')
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => { setVal(value || '') }, [value])
  const save = async () => {
    setSaving(true)
    try {
      await authFetch(`/api/clients/${clientId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: val }) })
      try { await authFetch('/api/sierra/update-lead-fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, fields: { [field]: val } }) }) } catch {}
      setEditing(false); onSaved && onSaved()
    } catch (e) { alert('Could not save ' + label.toLowerCase() + ': ' + e.message) }
    finally { setSaving(false) }
  }
  return (
    <p style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <strong>{label}:</strong>
      {editing ? (
        <>
          <input type={type} value={val} autoFocus onChange={e => setVal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setVal(value || ''); setEditing(false) } }}
            style={{ flex: 1, minWidth: 140, padding: '3px 6px' }} />
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>{saving ? '…' : 'Save'}</button>
          <button className="btn btn-sm btn-secondary" onClick={() => { setVal(value || ''); setEditing(false) }}>Cancel</button>
        </>
      ) : (
        <>
          <span>{value || '—'}</span>{statusTag}
          <button title={`Edit ${label.toLowerCase()}`} onClick={() => setEditing(true)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: '0 4px' }}>✎</button>
        </>
      )}
    </p>
  )
}

// Lead status shown + editable on the profile. Changing it writes the Hub immediately
// AND pushes the new status to Sierra (source of truth), so the next sync doesn't revert
// it. Junk/DoNotContact also pull the lead out of active drips server-side.
const STATUS_OPTIONS = ['new', 'watch', 'qualify', 'prime', 'active', 'pending', 'closed', 'archived', 'junk', 'donotcontact']
const STATUS_LABEL = { new: 'New', watch: 'Watch', qualify: 'Qualify', prime: 'Prime', active: 'Active', pending: 'Pending', closed: 'Closed', archived: 'Archived', junk: 'Junk', donotcontact: 'DNC' }
const STATUS_COLOR = { new: '#2563eb', watch: '#0891b2', qualify: '#7c3aed', prime: '#059669', active: '#10b981', pending: '#f59e0b', closed: '#64748b', archived: '#64748b', junk: '#ef4444', donotcontact: '#ef4444' }
export function InlineStatus({ detail, onSaved }) {
  const [saving, setSaving] = React.useState(false)
  const [msg, setMsg] = React.useState('')
  const cur = String(detail.status || '').toLowerCase()
  const change = async (next) => {
    if (!next || next === cur) return
    setSaving(true); setMsg('')
    try {
      await authFetch(`/api/clients/${detail.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: next }) })
      let pushed = false
      if (detail.sierra_lead_id) {
        try { const r = await authFetch('/api/sierra/update-lead-status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: detail.id, status: next }) }); pushed = !!(await r.json()).success } catch {}
      }
      setMsg(pushed ? '✓ Hub + Sierra' : (detail.sierra_lead_id ? '✓ Hub (Sierra push failed)' : '✓ Hub'))
      onSaved && onSaved()
    } catch (e) { alert('Could not change status: ' + e.message) }
    finally { setSaving(false) }
  }
  return (
    <p style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <strong>Status:</strong>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: '#fff', background: STATUS_COLOR[cur] || '#64748b', padding: '2px 8px', borderRadius: 4 }}>{STATUS_LABEL[cur] || detail.status || '—'}</span>
      <select value={STATUS_OPTIONS.includes(cur) ? cur : ''} disabled={saving} onChange={e => change(e.target.value)} style={{ padding: '3px 6px', fontSize: 12 }} title="Change status (updates Hub and Sierra)">
        {!STATUS_OPTIONS.includes(cur) && <option value="">{detail.status || 'Set status'}</option>}
        {STATUS_OPTIONS.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      {saving && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>saving…</span>}
      {msg && !saving && <span style={{ fontSize: 11, color: msg.includes('failed') ? '#b45309' : '#10b981' }}>{msg}</span>}
    </p>
  )
}

// P2-2: unified per-contact timeline — one filterable stream of every interaction.
const TIMELINE_FILTERS = [['all', 'All'], ['comm', 'Comms'], ['ai', 'AI'], ['note', 'Notes'], ['task', 'Tasks'], ['behavior', 'Activity']]
// Quick "add task" on the lead profile: text + due date + assignee -> Tasks tab, linked
// to this lead (related_type=client).
export function QuickAddTask({ clientId, clientName, onAdded }) {
  const [text, setText] = React.useState('')
  const [date, setDate] = React.useState('')
  const [time, setTime] = React.useState('')
  const [assignee, setAssignee] = React.useState('')
  const [agents, setAgents] = React.useState([])
  const [saving, setSaving] = React.useState(false)
  const [done, setDone] = React.useState('')
  React.useEffect(() => { authFetch('/api/inbox/agents').then(r => r.json()).then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  const add = async () => {
    if (!text.trim()) return
    setSaving(true); setDone('')
    try {
      const r = await authFetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: text.trim(), due_date: date || null, due_time: time || null, assigned_to: assignee || null, related_type: 'client', related_id: clientId, category: 'Lead' }) })
      const d = await r.json()
      if (d && d.error) { alert('Could not add task: ' + d.error); setSaving(false); return }
      setText(''); setDate(''); setTime(''); setDone('Added to the Tasks tab ✓'); setTimeout(() => setDone(''), 3000); onAdded && onAdded()
    } catch (e) { alert('Could not add task: ' + e.message) } finally { setSaving(false) }
  }
  const inp = { fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary, #fff)', color: 'var(--text-primary)' }
  return (
    <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input autoFocus value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder={`Task for ${clientName || 'this lead'}…`} style={{ ...inp, flex: '2 1 220px', minWidth: 160, padding: '7px 9px' }} />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} title="Due date" style={{ ...inp, padding: '6px 9px' }} />
        <input type="time" value={time} onChange={e => setTime(e.target.value)} title="Due time" style={{ ...inp, padding: '6px 9px' }} />
        <select value={assignee} onChange={e => setAssignee(e.target.value)} title="Assignee" style={{ ...inp, padding: '7px 9px' }}>
          <option value="">Assignee…</option>
          {agents.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
        <button className="btn btn-primary btn-sm" onClick={add} disabled={saving || !text.trim()}>{saving ? 'Adding…' : 'Add Task'}</button>
      </div>
      {done && <div style={{ fontSize: 12, color: '#10b981', marginTop: 6 }}>{done}</div>}
    </div>
  )
}

// Merge the current lead with an existing one: search, pick who to keep, keep both
// emails/phones, and combine all history/notes/communications onto the survivor.
function MergeLeadModal({ current, onClose, onDone }) {
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const [searching, setSearching] = React.useState(false)
  const [target, setTarget] = React.useState(null)
  const [survivor, setSurvivor] = React.useState('current')   // 'current' | 'target'
  const [keepBoth, setKeepBoth] = React.useState(true)
  const [merging, setMerging] = React.useState(false)
  const searchRef = React.useRef(0)
  React.useEffect(() => {
    const term = q.trim()
    if (term.length < 2) { setResults([]); return }
    const my = ++searchRef.current
    setSearching(true)
    const t = setTimeout(() => {
      authFetch('/api/clients?search=' + encodeURIComponent(term) + '&limit=12')
        .then(r => r.json()).then(d => {
          if (my !== searchRef.current) return
          setResults((Array.isArray(d) ? d : (d.clients || [])).filter(c => c.id !== current.id))
        }).catch(() => {}).finally(() => { if (my === searchRef.current) setSearching(false) })
    }, 300)
    return () => clearTimeout(t)
  }, [q, current.id])
  const label = (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'
  const sub = (c) => [c.phone, c.email, c.city].filter(Boolean).join(' · ') || '—'
  const doMerge = async () => {
    if (!target) return
    const survivorLead = survivor === 'current' ? current : target
    const mergedLead = survivor === 'current' ? target : current
    if (!confirm(`Merge "${label(mergedLead)}" INTO "${label(survivorLead)}"?\n\nAll calls, texts, emails, notes, tasks and history from both will live on ${label(survivorLead)}.${keepBoth ? "\nBoth leads' emails and phone numbers will be kept." : ''}\n\nThe other record is archived (recoverable).`)) return
    setMerging(true)
    try {
      const r = await authFetch('/api/clients/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ primary_id: survivorLead.id, duplicate_ids: [mergedLead.id], keep_both: keepBoth }) })
      const d = await r.json()
      if (d.error) { alert('Merge failed: ' + d.error); setMerging(false); return }
      onDone(survivorLead.id)
    } catch (e) { alert('Merge failed: ' + e.message); setMerging(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Merge ${label(current)} with another lead`}>
      <div className="form">
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px' }}>Search for the existing lead to merge with. All history, notes, calls, texts and emails from both leads are combined onto the one you keep.</p>
        <input autoFocus value={q} onChange={e => { setQ(e.target.value); setTarget(null) }} placeholder="Search by name, email, or phone…" style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }} />
        {searching && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Searching…</div>}
        {!target && results.length > 0 && (
          <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginTop: 6 }}>
            {results.map(c => (
              <div key={c.id} onClick={() => setTarget(c)} style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{label(c)}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub(c)}{c.status ? ` · ${c.status}` : ''}</div>
              </div>
            ))}
          </div>
        )}
        {!target && q.trim().length >= 2 && !searching && results.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginTop: 8 }}>No matching leads found.</div>}
        {target && (
          <div style={{ marginTop: 10 }}>
            <div style={{ padding: '8px 10px', border: '1px solid var(--accent, #b8863b)', borderRadius: 6, marginBottom: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div><div style={{ fontWeight: 600, fontSize: 13.5 }}>{label(target)}</div><div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{sub(target)}</div></div>
              <button className="btn btn-sm btn-secondary" onClick={() => setTarget(null)}>Change</button>
            </div>
            <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>Which record do you want to keep?</div>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 4, cursor: 'pointer' }}><input type="radio" checked={survivor === 'current'} onChange={() => setSurvivor('current')} /> Keep <b>{label(current)}</b> (merge {label(target)} into it)</label>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 10, cursor: 'pointer' }}><input type="radio" checked={survivor === 'target'} onChange={() => setSurvivor('target')} /> Keep <b>{label(target)}</b> (merge {label(current)} into it)</label>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 10, cursor: 'pointer' }}><input type="checkbox" checked={keepBoth} onChange={e => setKeepBoth(e.target.checked)} /> Keep <b>both</b> emails &amp; phone numbers (the extra is saved as a secondary contact)</label>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>All calls, texts, emails, notes, tasks and history from both leads are combined onto the record you keep. The other is archived and can be recovered.</div>
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!target || merging} onClick={doMerge}>{merging ? 'Merging…' : 'Merge leads'}</button>
        </div>
      </div>
    </Modal>
  )
}

// Bulk merge: fold the selected leads into one survivor (combines all history/comms/notes).
function BulkMergeModal({ leads, ids, onClose, onDone }) {
  const label = (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim() || `Lead ${c.id}`
  const [primaryId, setPrimaryId] = React.useState(leads[0]?.id || null)
  const [keepBoth, setKeepBoth] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const enough = ids.length >= 2
  const run = async () => {
    if (!primaryId || !enough) return
    const dupIds = ids.filter(id => id !== primaryId)
    const keep = leads.find(l => l.id === primaryId)
    if (!confirm(`Merge ${dupIds.length} lead${dupIds.length === 1 ? '' : 's'} INTO "${keep ? label(keep) : primaryId}"?\n\nAll calls, texts, emails, notes and history from all of them combine onto the one you keep.${keepBoth ? ' Every email and phone number is kept.' : ''}\nThe others are archived (recoverable).`)) return
    setBusy(true)
    try {
      const r = await authFetch('/api/clients/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ primary_id: primaryId, duplicate_ids: dupIds, keep_both: keepBoth }) })
      const d = await r.json()
      if (d.error) { alert('Merge failed: ' + d.error); setBusy(false); return }
      onDone(primaryId)
    } catch (e) { alert('Merge failed: ' + e.message); setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Merge ${ids.length} selected lead${ids.length === 1 ? '' : 's'}`}>
      <div className="form">
        {!enough ? <p style={{ fontSize: 13 }}>Select at least 2 leads to merge.</p> : (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px' }}>Pick the record to KEEP. Everything from the others (calls, texts, emails, notes, history) combines onto it.</p>
            {ids.length !== leads.length && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Showing {leads.length} of {ids.length} selected (the rest are on other pages but will still be merged in).</p>}
            <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, marginBottom: 10 }}>
              {leads.map(c => (
                <label key={c.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '7px 10px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }}>
                  <input type="radio" checked={primaryId === c.id} onChange={() => setPrimaryId(c.id)} />
                  <span><span style={{ fontWeight: 600, fontSize: 13.5 }}>{label(c)}</span> <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{[c.phone, c.email].filter(Boolean).join(' · ')}</span></span>
                </label>
              ))}
            </div>
            <label style={{ display: 'block', fontSize: 13, marginBottom: 8, cursor: 'pointer' }}><input type="checkbox" checked={keepBoth} onChange={e => setKeepBoth(e.target.checked)} /> Keep <b>all</b> emails &amp; phone numbers</label>
          </>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!enough || !primaryId || busy} onClick={run}>{busy ? 'Merging…' : 'Merge'}</button>
        </div>
      </div>
    </Modal>
  )
}

// Bulk assign (or clear) the owning agent.
function BulkAssignAgentModal({ ids, onClose, onDone }) {
  const [agents, setAgents] = React.useState([])
  const [agent, setAgent] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => { authFetch('/api/inbox/agents').then(r => r.json()).then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  const run = async () => {
    setBusy(true)
    try {
      const r = await authFetch('/api/clients/bulk-assign-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, agent }) })
      const d = await r.json()
      if (d.error) { alert(d.error); setBusy(false); return }
      alert(`Assigned ${d.updated} lead${d.updated === 1 ? '' : 's'} to ${agent || '(unassigned)'}.`)
      onDone()
    } catch (e) { alert('Failed: ' + e.message); setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Assign agent — ${ids.length} lead${ids.length === 1 ? '' : 's'}`}>
      <div className="form">
        <label style={{ fontSize: 13 }}>Agent<br />
          <select value={agent} onChange={e => setAgent(e.target.value)} style={{ width: '100%', padding: '8px 10px', marginTop: 4 }}>
            <option value="">— Unassign —</option>
            {agents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </label>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={run}>{busy ? 'Saving…' : 'Assign'}</button>
        </div>
      </div>
    </Modal>
  )
}

// Bulk add and/or remove tags.
function BulkTagsModal({ ids, allTags, onClose, onDone }) {
  const [add, setAdd] = React.useState('')
  const [remove, setRemove] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const parse = (s) => s.split(',').map(t => t.trim()).filter(Boolean)
  const chip = (setter) => (t) => setter(prev => parse(prev).some(x => x.toLowerCase() === t.toLowerCase()) ? prev : (prev ? prev + ', ' : '') + t)
  const run = async () => {
    const a = parse(add), r = parse(remove)
    if (!a.length && !r.length) return
    setBusy(true)
    try {
      const res = await authFetch('/api/clients/bulk-tags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, add: a, remove: r }) })
      const d = await res.json()
      if (d.error) { alert(d.error); setBusy(false); return }
      alert(`Updated tags on ${d.updated} lead${d.updated === 1 ? '' : 's'}.`)
      onDone()
    } catch (e) { alert('Failed: ' + e.message); setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Tags — ${ids.length} lead${ids.length === 1 ? '' : 's'}`}>
      <div className="form">
        <label style={{ fontSize: 13, fontWeight: 600 }}>Add tags (comma-separated)</label>
        <input value={add} onChange={e => setAdd(e.target.value)} placeholder="e.g. Relocation, Investor" style={{ width: '100%', padding: '8px 10px', margin: '4px 0 6px' }} />
        {allTags.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>{allTags.slice(0, 20).map(t => <button key={t} type="button" onClick={() => chip(setAdd)(t)} style={{ fontSize: 11, padding: '2px 7px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-secondary)' }}>+ {t}</button>)}</div>}
        <label style={{ fontSize: 13, fontWeight: 600 }}>Remove tags (comma-separated)</label>
        <input value={remove} onChange={e => setRemove(e.target.value)} placeholder="tags to remove" style={{ width: '100%', padding: '8px 10px', margin: '4px 0 6px' }} />
        {allTags.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>{allTags.slice(0, 20).map(t => <button key={t} type="button" onClick={() => chip(setRemove)(t)} style={{ fontSize: 11, padding: '2px 7px', border: '1px solid var(--border)', borderRadius: 12, background: 'var(--bg-secondary)', cursor: 'pointer', color: 'var(--text-secondary)' }}>− {t}</button>)}</div>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={busy || (!parse(add).length && !parse(remove).length)} onClick={run}>{busy ? 'Saving…' : 'Apply'}</button>
        </div>
      </div>
    </Modal>
  )
}

export function ContactTimeline({ clientId }) {
  const [items, setItems] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const [f, setF] = React.useState('all')
  React.useEffect(() => {
    if (!open || items) return
    authFetch(`/api/clients/${clientId}/timeline`).then(r => r.json()).then(d => setItems(Array.isArray(d) ? d : [])).catch(() => setItems([]))
  }, [open, clientId, items])
  const fmt = (iso) => { try { return new Date(String(iso).includes('Z') ? iso : iso + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return iso } }
  const shown = (items || []).filter(e => f === 'all' || e.type === f)
  return (
    <div className="detail-section">
      <h4 style={{ cursor: 'pointer', userSelect: 'none' }} onClick={() => setOpen(o => !o)}>{open ? '▾' : '▸'} Timeline {items && `(${items.length})`}</h4>
      {open && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '4px 0 12px' }}>
            {TIMELINE_FILTERS.map(([k, l]) => <button key={k} className={`btn btn-sm ${f === k ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setF(k)}>{l}</button>)}
          </div>
          {items === null ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
            : shown.length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No activity yet.</div>
              : (
                <div style={{ borderLeft: '2px solid var(--border)', paddingLeft: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {shown.map((e, i) => (
                    <div key={i} style={{ position: 'relative' }}>
                      <span style={{ position: 'absolute', left: -22, top: 0 }}>{e.icon}</span>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{e.title}</div>
                      {e.detail && <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{e.detail}</div>}
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{fmt(e.at)}</div>
                    </div>
                  ))}
                </div>
              )}
        </>
      )}
    </div>
  )
}

// Name is two columns (first + last), so it gets its own inline editor.
export function InlineName({ detail, onSaved }) {
  const [editing, setEditing] = React.useState(false)
  const [fn, setFn] = React.useState(detail.first_name || '')
  const [ln, setLn] = React.useState(detail.last_name || '')
  const [saving, setSaving] = React.useState(false)
  React.useEffect(() => { setFn(detail.first_name || ''); setLn(detail.last_name || '') }, [detail.first_name, detail.last_name])
  const save = async () => {
    setSaving(true)
    try {
      await authFetch(`/api/clients/${detail.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ first_name: fn, last_name: ln }) })
      try { await authFetch('/api/sierra/update-lead-fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: detail.id, fields: { first_name: fn, last_name: ln } }) }) } catch {}
      setEditing(false); onSaved && onSaved()
    } catch (e) { alert('Could not save name: ' + e.message) }
    finally { setSaving(false) }
  }
  return (
    <p style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <strong>Name:</strong>
      {editing ? (
        <>
          <input value={fn} autoFocus onChange={e => setFn(e.target.value)} placeholder="First" style={{ width: 110, padding: '3px 6px' }} />
          <input value={ln} onChange={e => setLn(e.target.value)} placeholder="Last" style={{ flex: 1, minWidth: 120, padding: '3px 6px' }} />
          <button className="btn btn-sm btn-primary" onClick={save} disabled={saving}>{saving ? '…' : 'Save'}</button>
          <button className="btn btn-sm btn-secondary" onClick={() => { setFn(detail.first_name || ''); setLn(detail.last_name || ''); setEditing(false) }}>Cancel</button>
        </>
      ) : (
        <>
          <span>{`${detail.first_name || ''} ${detail.last_name || ''}`.trim() || '—'}</span>
          <button title="Edit name" onClick={() => setEditing(true)}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13, padding: '0 4px' }}>✎</button>
        </>
      )}
    </p>
  )
}

// --- Text (SMS) composer for the lead profile — sends via the Hub/Twilio number ---
const TEXT_MERGE_FIELDS = [['{{first_name}}', 'First name'], ['{{last_name}}', 'Last name'], ['{{full_name}}', 'Full name'], ['{{city}}', 'City'], ['{{address}}', 'Address'], ['{{agent}}', 'Agent name'], ['{{price_range}}', 'Price range']]

// ---- communication-history helpers (mirrors the Inbox) ----
export const recUrl = (id) => `/api/inbox/recording/${id}?token=${encodeURIComponent(localStorage.getItem('mst_token') || '')}`
export const fmtDur = (s) => { s = Number(s) || 0; const m = Math.floor(s / 60), r = s % 60; return m ? `${m}m ${r}s` : `${r}s` }
export const COMM_META = {
  text: { icon: '💬', label: 'Text', color: '#10b981' },
  call: { icon: '☎', label: 'Call', color: '#8b5cf6' },
  voicemail: { icon: '🎙', label: 'Voicemail', color: '#f59e0b' },
  email: { icon: '✉', label: 'Email', color: '#3b82f6' },
}
export const fmtCommWhen = (iso) => { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return iso } }
// Turn a logged email's raw HTML into a clean, readable preview (drop tracking pixels,
// style/script, tags; keep link text; decode entities). Plain text passes through.
export function commToText(s) {
  s = String(s || '')
  if (!/<[a-z/!][^>]*>/i.test(s)) return s
  s = s.replace(/<\s*(style|script|head)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<img[^>]*>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n) } catch { return '' } })
  return s.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
function TextComposerModal({ client, onClose, onSent }) {
  const [body, setBody] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const [templates, setTemplates] = React.useState([])
  React.useEffect(() => { authFetch('/api/templates?type=email').then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {}) }, [])
  const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
  const insert = (t) => setBody(b => (b ? b + (b.endsWith(' ') || b.endsWith('\n') ? '' : ' ') : '') + t)
  // Fill merge fields for this lead so the composer is WYSIWYG (no raw {{tokens}}).
  const renderForLead = async (text) => {
    if (!/\{\{[^}]+\}\}/.test(text)) return text
    try {
      const d = await (await authFetch('/api/templates/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text, client_id: client.id }) })).json()
      return d.filled ? (d.body || text) : text
    } catch { return text }
  }
  // Applying a template REPLACES the box (picking another swaps it, never appends), with
  // custom fields already filled for this lead.
  const applyTemplate = async (t) => { setBody(await renderForLead(stripHtml(t.body))) }
  const insertMergeValue = async (tok) => { insert(await renderForLead(tok)) }
  const send = async () => {
    if (!body.trim()) return
    setSending(true)
    try {
      const r = await authFetch('/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'text', client_ids: [client.id], body: body.trim() }) })
      const d = await r.json()
      if (d.sent >= 1) { onSent && onSent(); onClose() }
      else alert('Text not sent: ' + (d.results?.[0]?.error || d.error || 'unknown error'))
    } catch (e) { alert('Text failed: ' + e.message) }
    finally { setSending(false) }
  }
  const name = `${client.first_name || ''} ${client.last_name || ''}`.trim()
  return (
    <Modal open onClose={onClose} title={`Text ${name || client.phone}`}>
      <div className="form">
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 10px' }}>To <strong>{client.phone}</strong> · from your Hub number (319) 343-1562</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <TemplatePicker templates={templates} onPick={t => insert(stripHtml(t.body))} />
          <select value="" onChange={e => { if (e.target.value) insert(e.target.value); e.target.value = '' }} style={{ fontSize: 12, padding: '4px 6px' }}>
            <option value="">+ Merge field…</option>
            {TEXT_MERGE_FIELDS.map(([tok, label]) => <option key={tok} value={tok}>{label}</option>)}
          </select>
        </div>
        <textarea value={body} autoFocus onChange={e => setBody(e.target.value)} rows={5} maxLength={1000}
          placeholder="Type your message…" onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() }}
          style={{ width: '100%', padding: 10, fontSize: 14, lineHeight: 1.5, resize: 'vertical' }} />
        <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>{body.length}/1000 · ⌘/Ctrl+Enter to send</div>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !body.trim()}>{sending ? 'Sending…' : 'Send Text'}</button>
        </div>
      </div>
    </Modal>
  )
}

// --- Manual dialer: type/keypad any phone number (not necessarily in the CRM) and
// call it through the Hub softphone. Also does a quick lookup so a known contact's
// name shows on the call. ---
function ManualDialer({ onClose }) {
  const [num, setNum] = React.useState('')
  const [match, setMatch] = React.useState(null)
  const digits = num.replace(/\D/g, '')
  React.useEffect(() => {
    if (digits.length < 10) { setMatch(null); return }
    const t = setTimeout(() => authFetch('/api/inbox/contacts?q=' + encodeURIComponent(digits.slice(-10))).then(r => r.json()).then(a => setMatch(Array.isArray(a) && a[0] ? a[0] : null)).catch(() => {}), 250)
    return () => clearTimeout(t)
  }, [digits])
  const fmt = (d) => d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (d.length === 11 && d[0] === '1' ? `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : num)
  const press = (k) => setNum(n => (n + k).slice(0, 20))
  const back = () => setNum(n => n.slice(0, -1))
  const call = () => {
    if (digits.length < 10) { alert('Enter a valid phone number.'); return }
    const name = match ? `${match.first_name || ''} ${match.last_name || ''}`.trim() : ''
    if (window.hubCall) { window.hubCall(digits.length >= 11 ? '+' + digits : digits, name); onClose() }
    else alert('The Hub phone isn’t connected yet. Keep the Hub open in a tab to place calls.')
  }
  const keyStyle = { padding: '14px 0', fontSize: 20, fontWeight: 600, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-secondary)', color: 'var(--text-primary)', cursor: 'pointer' }
  return (
    <Modal open onClose={onClose} title="Dialer">
      <div style={{ maxWidth: 300, margin: '0 auto' }}>
        <input value={fmt(digits)} onChange={e => setNum(e.target.value)} autoFocus placeholder="Enter a phone number"
          onKeyDown={e => { if (e.key === 'Enter') call() }}
          style={{ width: '100%', textAlign: 'center', fontSize: 24, padding: '10px 8px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-primary)', letterSpacing: 1 }} />
        <div style={{ textAlign: 'center', fontSize: 12, color: match ? '#10b981' : 'var(--text-muted)', minHeight: 18, marginTop: 4 }}>
          {match ? `${match.first_name || ''} ${match.last_name || ''}`.trim() + ' (in database)' : (digits.length >= 10 ? 'Not in database — will dial as a new number' : ' ')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginTop: 10 }}>
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map(k => (
            <button key={k} onClick={() => press(k)} style={keyStyle}>{k}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button className="btn btn-secondary" onClick={back} disabled={!digits} title="Delete">⌫</button>
          <button className="btn btn-primary" style={{ flex: 1, background: '#10b981', fontSize: 16, padding: '11px 0' }} onClick={call} disabled={digits.length < 10}>📞 Call</button>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>Calls from your Hub number (319) 343-1562. Keep the Hub open to talk.</div>
      </div>
    </Modal>
  )
}

// --- HUB AI ISA card on the lead profile: shows the AI state/intent/summary and
// gives the agent full control (enable, pause, take over, stop, send now). ---
export function AiIsaCard({ clientId }) {
  const [d, setD] = React.useState(undefined)
  const [busy, setBusy] = React.useState(false)
  const [preview, setPreview] = React.useState(null)
  const load = React.useCallback(() => { authFetch('/api/ai/lead/' + clientId).then(r => r.json()).then(setD).catch(() => setD(null)) }, [clientId])
  React.useEffect(() => { load() }, [load])
  React.useEffect(() => { setPreview(null) }, [clientId])
  const act = async (path, body) => { setBusy(true); try { await authFetch('/api/ai/lead/' + clientId + '/' + path, { method: 'POST', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }) } finally { setBusy(false); load() } }
  const doPreview = async () => { setBusy(true); setPreview({ loading: true }); try { const r = await authFetch('/api/ai/lead/' + clientId + '/preview', { method: 'POST' }); setPreview(await r.json()) } catch (e) { setPreview({ ok: false, reason: e.message }) } finally { setBusy(false) } }
  const sendNow = async (enableFirst) => {
    if (!confirm(enableFirst ? 'Enable AI for this lead and send a message now?' : 'Have HUB AI send a message to this contact now? It still follows all rules (STOP, opt-outs, quiet hours).')) return
    setBusy(true)
    try {
      const r = await authFetch('/api/ai/lead/' + clientId + '/send-now', { method: 'POST' })
      const d = await r.json()
      if (d.sent) alert('AI message sent.')
      else if (/quiet/i.test(d.reason || '')) alert('Not sent — quiet hours are on. It will send after quiet hours end (8 AM). You can change quiet hours in Settings.')
      else alert('Not sent: ' + (d.reason || d.error || 'the AI chose not to send right now'))
    } catch (e) { alert(e.message) } finally { setBusy(false); load() }
  }
  if (!d) return null
  const LEVEL = { URGENT: '#ef4444', HIGH: '#f59e0b', ENGAGED: '#10b981', NURTURE: '#2563eb', LOW: '#64748b' }
  const managed = d.ai_managed || (d.global?.autopilot && d.ai_enabled)
  const st = d.ai_state || 'NEW_UNCONTACTED'
  const fmt = (iso) => { try { return new Date(String(iso).includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return iso } }
  return (
    <div className="detail-section" style={{ border: '1px solid rgba(37,99,235,0.35)', background: 'rgba(37,99,235,0.05)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h4 style={{ margin: 0, color: '#2563eb' }}>🤖 HUB AI</h4>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: '#fff', background: '#2563eb', padding: '2px 7px', borderRadius: 4 }}>{st.replace(/_/g, ' ')}</span>
        {d.intent && <span style={{ fontSize: 12, fontWeight: 700, color: LEVEL[d.intent.level] || '#64748b' }}>intent {d.intent.score} · {d.intent.level}</span>}
        {d.conversation_type && <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', color: '#0369a1', background: 'rgba(3,105,161,0.12)', padding: '2px 7px', borderRadius: 4 }}>{d.conversation_type.replace(/_/g, ' ')}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: managed ? '#10b981' : 'var(--text-muted)' }}>{managed ? 'AI managing this lead' : 'AI not enabled here'}</span>
      </div>
      {!d.global?.master && <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>AI is off globally. Turn on HUB AI Follow-Up in Settings for it to run.</div>}
      {d.global?.master && !d.global?.autopilot && !managed && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Manual mode: AI won’t act on this lead until you turn it on here. (Autopilot is off.)</div>}
      {d.prefs?.hub_text_opt_out && <div style={{ fontSize: 12, color: '#ef4444', marginTop: 6 }}>This contact replied STOP — AI texting is blocked.</div>}
      {d.summary && <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.45, fontStyle: 'italic', borderLeft: '2px solid rgba(37,99,235,0.4)', paddingLeft: 8 }}>{d.summary}</div>}
      {d.intent?.reasons?.length > 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>Signals: {d.intent.reasons.join(' · ')}</div>}
      {Array.isArray(d.memory_fields) && d.memory_fields.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer', userSelect: 'none' }}>What HUB AI has learned ({d.memory_fields.length})</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
            {d.memory_fields.map(f => (
              <div key={f.field} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                <span style={{ minWidth: 130, color: 'var(--text-muted)', textTransform: 'capitalize' }}>{f.field.replace(/_/g, ' ')}</span>
                <span style={{ fontWeight: 600, flex: 1 }}>{f.value}</span>
                <span style={{ fontSize: 10, color: f.source === 'human' ? '#10b981' : 'var(--text-muted)', textTransform: 'uppercase' }}>{f.source}{f.confidence != null ? ` · ${Math.round(f.confidence * 100)}%` : ''}</span>
              </div>
            ))}
          </div>
        </details>
      )}
      {d.open_handoff && <div style={{ fontSize: 12.5, color: '#b45309', marginTop: 6, fontWeight: 600 }}>⚑ Open handoff: {d.open_handoff.reason}</div>}
      {d.ai_next_action_at && <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>Next AI action: {fmt(d.ai_next_action_at)}</div>}
      {preview && (
        <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 8, background: 'var(--bg-secondary)', border: '1px solid var(--border)' }}>
          {preview.loading ? <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Drafting preview…</span>
            : preview.ok ? <>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)', marginBottom: 4 }}>Preview · {preview.kind} {!preview.eligible && <span style={{ color: '#ef4444' }}>· would be blocked: {preview.block_reason}</span>}</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>{preview.message}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>Not sent — this is only a preview.</div>
            </> : <span style={{ fontSize: 12.5, color: '#ef4444' }}>{preview.reason || 'Could not preview'}</span>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 12 }}>
        <button className="btn btn-sm btn-secondary" disabled={busy} onClick={doPreview}>👁 Preview next text</button>
        {managed ? (
          <>
            {st === 'HUMAN_TAKEOVER' || st === 'AI_PAUSED'
              ? <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('resume')}>Resume AI</button>
              : <button className="btn btn-sm" disabled={busy} onClick={() => act('pause', { duration: 'today' })}>Pause today</button>}
            <button className="btn btn-sm" disabled={busy} onClick={() => act('takeover')}>Take over</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => sendNow(false)}>Send AI now</button>
            <button className="btn btn-sm" disabled={busy} style={{ color: '#ef4444' }} onClick={() => { if (confirm('Turn AI off for this contact?')) act('stop') }}>Stop AI</button>
          </>
        ) : (
          <>
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => act('enable')}>Enable AI for this lead</button>
            <button className="btn btn-sm" disabled={busy} onClick={() => sendNow(true)}>Send AI now</button>
          </>
        )}
      </div>
    </div>
  )
}

// --- Inline text box on the lead profile: opens under the action buttons (not a
// modal behind the drawer). Text, template, merge fields, photo (MMS), and add
// more recipients — sends from the Hub number to everyone in one shot. ---
export function InlineTextComposer({ client, onClose, onSent }) {
  const [recips, setRecips] = React.useState([client])
  const [q, setQ] = React.useState('')
  const [results, setResults] = React.useState([])
  const [body, setBody] = React.useState('')
  const [media, setMedia] = React.useState([])
  const [uploading, setUploading] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [templates, setTemplates] = React.useState([])
  const [schedOpen, setSchedOpen] = React.useState(false)
  const [sendAt, setSendAt] = React.useState('')
  const [scheduled, setScheduled] = React.useState([])
  const fileRef = React.useRef(null)
  const [agents, setAgents] = React.useState([])
  const [ai, setAi] = React.useState(null)          // { ok, kind, message, eligible, block_reason }
  const [aiBusy, setAiBusy] = React.useState(false)
  const [aiOpen, setAiOpen] = React.useState(false) // suggestions only generate when opened
  const [aiContext, setAiContext] = React.useState('')
  React.useEffect(() => { authFetch('/api/templates?type=text').then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {}); authFetch('/api/agents').then(r => r.json()).then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  // Text-native AI suggestion: drafts the right SMS for where this conversation is
  // (first text / reply / follow-up), strict-Central greeting + compliance-aware.
  // Only runs on demand (View suggested reply / Regenerate) — never auto-fires.
  const recommendText = React.useCallback(async () => {
    setAiOpen(true); setAiBusy(true)
    try { const r = await authFetch(`/api/ai/lead/${client.id}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: aiContext.trim() }) }); setAi(await r.json()) }
    catch (e) { setAi({ ok: false, reason: e.message }) } finally { setAiBusy(false) }
  }, [client.id, aiContext])
  const useAiText = () => { if (ai?.message) { setBody(ai.message); setAi(a => ({ ...a, used: true })) } }
  const addAgent = (a) => { const key = 'agent:' + a.id; if (!recips.find(r => r.id === key)) setRecips(rs => [...rs, { id: key, agent: true, name: a.name, phone: a.phone }]) }
  const loadScheduled = React.useCallback(() => { authFetch('/api/inbox/scheduled?client_id=' + client.id).then(r => r.json()).then(d => setScheduled(Array.isArray(d) ? d : [])).catch(() => {}) }, [client.id])
  React.useEffect(() => { loadScheduled() }, [loadScheduled])
  const scheduleText = async () => {
    if (!body.trim() && !media.length) return
    if (!sendAt) { alert('Pick a date and time.'); return }
    const iso = new Date(sendAt).toISOString()
    if (new Date(iso).getTime() < Date.now() + 60000) { alert('Pick a time in the future.'); return }
    setSending(true)
    try {
      const r = await authFetch('/api/inbox/schedule-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: client.id, body: body.trim(), media: media.map(m => m.url), send_at: iso, created_by: 'John', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) })
      const d = await r.json()
      if (d.success) { setBody(''); setMedia([]); setSchedOpen(false); setSendAt(''); loadScheduled() }
      else alert(d.error || 'Could not schedule')
    } catch (e) { alert('Schedule failed: ' + e.message) } finally { setSending(false) }
  }
  const cancelScheduled = async (id) => { await authFetch(`/api/inbox/scheduled/${id}/cancel`, { method: 'POST' }).catch(() => {}); loadScheduled() }
  const [previewSchedId, setPreviewSchedId] = React.useState(null)
  const sendScheduledNow = async (id) => {
    if (!confirm('Send this scheduled text now?')) return
    try {
      const d = await (await authFetch(`/api/inbox/scheduled/${id}/send-now`, { method: 'POST' })).json()
      if (d.ok || d.sent) { loadScheduled(); onSent && onSent() }
      else alert('Not sent: ' + (d.error || d.skipped || 'unknown'))
    } catch (e) { alert('Send now failed: ' + e.message) }
  }
  const fmtWhenLocal = (iso) => { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) } catch { return iso } }
  React.useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => authFetch('/api/inbox/contacts?q=' + encodeURIComponent(q.trim())).then(r => r.json()).then(setResults).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [q])
  const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
  const insert = (t) => setBody(b => (b ? b + (b.endsWith(' ') || b.endsWith('\n') ? '' : ' ') : '') + t)
  // Fill merge fields for this lead so the composer is WYSIWYG (no raw {{tokens}}).
  const renderForLead = async (text) => {
    if (!/\{\{[^}]+\}\}/.test(text)) return text
    try {
      const d = await (await authFetch('/api/templates/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: text, client_id: client.id }) })).json()
      return d.filled ? (d.body || text) : text
    } catch { return text }
  }
  // Applying a template REPLACES the box (picking another swaps it, never appends).
  const applyTemplate = async (t) => { setBody(await renderForLead(stripHtml(t.body))) }
  const insertMergeValue = async (tok) => { insert(await renderForLead(tok)) }
  const addRecip = (c) => { if (!recips.find(r => r.id === c.id)) setRecips([...recips, c]); setQ(''); setResults([]) }
  const removeRecip = (id) => setRecips(recips.filter(r => r.id !== id))
  const uploadPhoto = async (file) => {
    if (!file) return; setUploading(true)
    try { const fd = new FormData(); fd.append('file', file); const r = await authFetch('/api/inbox/upload-media', { method: 'POST', body: fd }); const d = await r.json(); if (d.url) setMedia(m => [...m, { url: d.url, type: d.type }]); else alert(d.error || 'Upload failed') }
    catch (e) { alert('Upload failed: ' + e.message) } finally { setUploading(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const send = async () => {
    if (!body.trim() && !media.length) return
    if (!recips.length) { alert('Add at least one recipient.'); return }
    setSending(true)
    try {
      // 2+ recipients + no photo → true group MMS (one shared thread, replies grouped).
      if (recips.length >= 2 && !media.length) {
        const recipients = recips.map(r => r.agent
          ? { phone: r.phone, name: r.name }
          : { client_id: r.id, name: r.name || `${r.first_name || ''} ${r.last_name || ''}`.trim() })
        const resp = await authFetch('/api/inbox/group-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: body.trim(), recipients }) })
        const d = await resp.json()
        if (d.success) {
          setBody(''); onSent && onSent()
          const notes = [...(d.blocked || []).map(b => `${b.name || b.phone || 'one'} skipped (${b.reason})`), ...(d.skipped || []).map(s => `${s.name || s.phone} couldn't be added`)]
          if (notes.length) alert(`Group text sent to ${d.sent_to}.\n${notes.join('\n')}`); else onClose()
        } else alert('Group text failed: ' + (d.error || 'unknown error'))
        return
      }
      const client_ids = recips.filter(r => !r.agent).map(r => r.id)
      const phones = recips.filter(r => r.agent).map(r => ({ phone: r.phone, name: r.name }))
      const r = await authFetch('/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'text', client_ids, phones, body: body.trim(), media: media.map(m => m.url) }) })
      const d = await r.json()
      if (d.sent >= 1) {
        setBody(''); setMedia([]); onSent && onSent()
        const failed = (d.results || []).filter(x => !x.ok)
        if (failed.length) alert(`Sent to ${d.sent}. ${failed.length} skipped (${failed.map(f => f.error).join(', ')}).`)
        else onClose()
      } else alert('Text not sent: ' + (d.results?.[0]?.error || d.error || 'unknown error'))
    } catch (e) { alert('Text failed: ' + e.message) } finally { setSending(false) }
  }
  const fld = { width: '100%', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }
  return (
    <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 10, padding: 12, background: 'var(--bg-secondary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#10b981' }}>💬 Text</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>from your Hub number (319) 343-1562</span>
        <button onClick={onClose} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16 }} title="Close">✕</button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
        {recips.map(r => (
          <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: r.agent ? 'rgba(37,99,235,.1)' : 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 14, padding: '3px 10px', fontSize: 12 }}>
            {r.agent && <span title="Team agent" style={{ fontSize: 10 }}>👤</span>}
            {r.name || `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.phone}
            {recips.length > 1 && <button onClick={() => removeRecip(r.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>}
          </span>
        ))}
      </div>
      {agents.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Loop in a teammate:</span>
          {agents.filter(a => a.phone && !recips.find(r => r.id === 'agent:' + a.id)).map(a => (
            <button key={a.id} onClick={() => addAgent(a)} className="btn btn-sm btn-secondary" title={`${a.phone}${a.title ? ' · ' + a.title : ''}`}>+ {a.name}</button>
          ))}
        </div>
      )}
      <div style={{ position: 'relative', marginBottom: 8 }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="+ Add another recipient (name or phone)…" style={fld} />
        {results.length > 0 && (
          <div style={{ position: 'absolute', zIndex: 40, top: '100%', left: 0, right: 0, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 200, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
            {results.map(c => (
              <div key={c.id} onClick={() => addRecip(c)} style={{ padding: '7px 11px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <div style={{ fontWeight: 600 }}>{`${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.phone || 'no phone'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
        <TemplatePicker templates={templates} onPick={applyTemplate} />
        <select value="" onChange={e => { if (e.target.value) insertMergeValue(e.target.value); e.target.value = '' }} style={{ ...fld, width: 'auto', fontSize: 12, padding: '5px 6px' }}>
          <option value="">+ Merge field…</option>
          {TEXT_MERGE_FIELDS.map(([tok, label]) => <option key={tok} value={tok}>{label}</option>)}
        </select>
        <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => uploadPhoto(e.target.files?.[0])} />
        <button className="btn btn-sm btn-secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>{uploading ? 'Uploading…' : '📷 Photo'}</button>
      </div>
      {media.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {media.map((mm, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <img src={mm.url} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
              <button onClick={() => setMedia(list => list.filter((_, j) => j !== i))} style={{ position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: '50%', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 11, lineHeight: '18px', padding: 0 }}>✕</button>
            </div>
          ))}
        </div>
      )}
      {scheduled.length > 0 && (
        <div style={{ marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {scheduled.map(s => (
            <div key={s.id} style={{ fontSize: 12, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6, padding: '5px 9px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: '#f59e0b' }}>🕑</span>
                <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }} title="Scheduled send time">{fmtWhenLocal(s.send_at)}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.body || '[photo]'}</span>
                <button onClick={() => setPreviewSchedId(p => p === s.id ? null : s.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: previewSchedId === s.id ? 'var(--accent, #2563eb)' : 'var(--text-muted)', fontSize: 13 }} title="Preview the full text">👁</button>
                <button onClick={() => sendScheduledNow(s.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#10b981', fontSize: 12, fontWeight: 700 }} title="Send this text now instead of waiting">▶ Send now</button>
                <button onClick={() => cancelScheduled(s.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 13 }} title="Cancel this scheduled text">✕</button>
              </div>
              {previewSchedId === s.id && (
                <div style={{ marginTop: 6, padding: '7px 9px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.45, color: 'var(--text-primary)' }}>
                  {s.body || '[photo]'}
                  {s.media_url && <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 11 }}>+ attachment</div>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* ===== AI text suggestion (on-demand only) ===== */}
      {client.phone && !client.hub_text_opt_out && (
        !aiOpen ? (
          <div style={{ marginBottom: 8 }}>
            <button className="btn btn-sm" onClick={recommendText} style={{ color: '#10b981', borderColor: 'rgba(16,185,129,.4)' }} title="Let AI draft a text for where this conversation is">✨ View suggested reply</button>
          </div>
        ) : (
          <div style={{ marginBottom: 8, border: '1px solid rgba(16,185,129,.35)', borderRadius: 8, padding: 10, background: 'rgba(16,185,129,.06)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 11.5, fontWeight: 700, color: '#10b981' }}>✨ AI text suggestion</span>
              {ai?.ok && ai.kind && <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 10, padding: '1px 7px' }}>{ai.kind}</span>}
              <button onClick={() => { setAiOpen(false); setAi(null) }} style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 14 }} title="Hide">✕</button>
            </div>
            {/* Optional steer for the AI — a fact to fold into the text */}
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <input value={aiContext} onChange={e => setAiContext(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !aiBusy) recommendText() }}
                placeholder="Add context to improve it (e.g. this home just went pending, push a Saturday tour)…"
                style={{ ...fld, flex: 1, minWidth: 0, fontSize: 12.5 }} />
              <button className="btn btn-primary btn-sm" disabled={aiBusy} onClick={recommendText} title="Draft / redraft with this context">{aiBusy ? '…' : (ai ? '↻ Regenerate' : 'Draft')}</button>
            </div>
            {aiBusy && !ai && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Drafting…</div>}
            {ai && !ai.ok && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Couldn’t draft a suggestion{ai.reason ? ` (${ai.reason})` : ''}.</div>}
            {ai?.ok && (
              <>
                <div style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px' }}>{ai.message}</div>
                {!ai.eligible && ai.block_reason && <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 5 }}>⚠ AI auto-send is blocked for this lead ({ai.block_reason}) — you can still send this manually.</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={useAiText}>Use this ↓</button>
                  <button className="btn btn-sm" onClick={() => { navigator.clipboard?.writeText(ai.message) }}>Copy</button>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--text-muted)', alignSelf: 'center' }}>{(ai.message || '').length} chars</span>
                </div>
              </>
            )}
          </div>
        )
      )}
      <textarea value={body} autoFocus onChange={e => setBody(e.target.value)} rows={3} maxLength={1000} placeholder="Type your message…" onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send() }} style={{ ...fld, resize: 'vertical', lineHeight: 1.5 }} />
      {schedOpen && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Send at:</span>
          <input type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} style={{ ...fld, width: 'auto' }} />
          <button className="btn btn-primary btn-sm" onClick={scheduleText} disabled={sending || (!body.trim() && !media.length) || !sendAt}>{sending ? '…' : 'Schedule send'}</button>
          <button className="btn btn-sm" onClick={() => setSchedOpen(false)}>Cancel</button>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', marginTop: 8, gap: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{body.length}/1000 · ⌘/Ctrl+Enter to send{recips.length > 1 ? ` · ${recips.length} recipients` : ''}</span>
        {!schedOpen && recips.length === 1 && <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setSchedOpen(true)} title="Schedule for later">🕑 Schedule</button>}
        <button className="btn btn-primary btn-sm" style={{ marginLeft: schedOpen || recips.length > 1 ? 'auto' : 0 }} onClick={send} disabled={sending || (!body.trim() && !media.length)}>{sending ? 'Sending…' : 'Send Text'}</button>
      </div>
    </div>
  )
}

// --- Bulk SMS to selected contacts (dedups phones, excludes STOP opt-outs, queues) ---
function BulkTextModal({ clientIds, onClose, onDone }) {
  const [parts, setParts] = React.useState([''])   // ordered texts, sent in sequence to each recipient
  const [activeIdx, setActiveIdx] = React.useState(0)
  const [name, setName] = React.useState('')
  const [templates, setTemplates] = React.useState([])
  const [sending, setSending] = React.useState(false)
  React.useEffect(() => { authFetch('/api/templates?type=text').then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {}) }, [])
  const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
  const setPart = (i, v) => setParts(ps => ps.map((p, idx) => idx === i ? v : p))
  const insert = (t) => setParts(ps => ps.map((p, idx) => idx === activeIdx ? (p ? p + (p.endsWith(' ') || p.endsWith('\n') ? '' : ' ') : '') + t : p))
  const addPart = () => setParts(ps => { const next = [...ps, '']; setActiveIdx(next.length - 1); return next })
  const removePart = (i) => setParts(ps => ps.length > 1 ? ps.filter((_, idx) => idx !== i) : ps)
  // One-click: load the 3-part FSBO Step 2 straight from the saved templates.
  const loadFsboStep2 = () => {
    const pick = (frag) => stripHtml((templates.find(t => (t.name || '').toLowerCase().includes(frag)) || {}).body || '')
    const seq = [pick('2a'), pick('2b'), pick('2c')].filter(Boolean)
    if (seq.length) { setParts(seq); setActiveIdx(seq.length - 1); if (!name.trim()) setName('FSBO Step 2') }
  }
  const filled = parts.filter(p => p.trim())
  // Preview the actual text a real recipient will get — merge/custom fields filled exactly the
  // way the send fills them (/api/templates/render mirrors the bulk-text fillTemplate + strip).
  const [preview, setPreview] = React.useState(null)
  const loadPreview = async (idx) => {
    const cid = clientIds[idx]
    if (!cid) { setPreview({ idx, error: 'No recipient at that position.' }); return }
    if (!filled.length) { setPreview({ idx, error: 'Type a message first.' }); return }
    setPreview({ idx, loading: true })
    try {
      const rendered = await Promise.all(filled.map(async part => {
        const d = await authFetch('/api/templates/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: part, client_id: cid }) }).then(r => r.json())
        return d && d.filled ? (d.body || part) : part
      }))
      setPreview({ idx, parts: rendered })
    } catch (e) { setPreview({ idx, error: e.message }) }
  }
  const doSend = async (force) => {
    const r = await authFetch('/api/inbox/bulk-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_ids: clientIds, bodies: filled, name: name.trim() || null, created_by: 'John', force }) })
    const d = await r.json()
    if (d.duplicate && !force) { if (confirm(d.error)) return doSend(true); setSending(false); return }
    if (d.error) { alert(d.error); setSending(false); return }
    const ex = d.excluded || {}
    alert(`Queued ${d.queued} recipient${d.queued === 1 ? '' : 's'}${filled.length > 1 ? ` × ${filled.length} texts` : ''} (sending in the background).\nSkipped — ${ex.no_phone || 0} no phone, ${ex.opted_out_stop || 0} replied STOP, ${ex.do_not_contact || 0} do-not-contact, ${ex.duplicate_number || 0} duplicate number.`)
    onDone()
  }
  const send = async () => {
    if (!filled.length) return
    if (!confirm(`Send ${filled.length > 1 ? `these ${filled.length} texts (in order)` : 'this text'} to up to ${clientIds.length} selected contact(s)? Contacts who replied STOP, are Do Not Contact, have no phone, or are duplicate numbers are automatically skipped.`)) return
    setSending(true)
    try { await doSend(false) } catch (e) { alert('Bulk text failed: ' + e.message); setSending(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Text ${clientIds.length.toLocaleString()} selected`}>
      <div className="form">
        <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 8px' }}>Sends from your Hub number (319) 343-1562. Merge fields fill per contact; anyone who replied STOP or is Do Not Contact is excluded.{filled.length > 1 ? ' Multi-part texts go out in order, a few seconds apart, to each recipient.' : ''}</p>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Campaign name (optional, for reporting)" style={{ width: '100%', padding: '7px 9px', marginBottom: 8, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }} />
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <TemplatePicker templates={templates} onPick={t => insert(stripHtml(t.body))} />
          <select value="" onChange={e => { if (e.target.value) insert(e.target.value); e.target.value = '' }} style={{ fontSize: 12, padding: '4px 6px' }}>
            <option value="">+ Merge field…</option>
            {TEXT_MERGE_FIELDS.map(([tok, label]) => <option key={tok} value={tok}>{label}</option>)}
          </select>
          <button type="button" className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 8px' }} onClick={loadFsboStep2}>FSBO Step 2 (3 texts)</button>
        </div>
        {parts.map((p, i) => (
          <div key={i} style={{ marginBottom: 8 }}>
            {parts.length > 1 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-muted)', marginBottom: 2 }}>
                <span>Text {i + 1} of {parts.length}</span>
                <button type="button" onClick={() => removePart(i)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12 }}>Remove</button>
              </div>
            )}
            <textarea value={p} autoFocus={i === 0} onFocus={() => setActiveIdx(i)} onChange={e => setPart(i, e.target.value)} rows={4} maxLength={1000} placeholder={i === 0 ? 'Type your message…' : `Follow-up text ${i + 1}…`} style={{ width: '100%', padding: 10, fontSize: 14, lineHeight: 1.5, resize: 'vertical', border: activeIdx === i && parts.length > 1 ? '1px solid var(--accent, #b8863b)' : undefined }} />
            <div style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-muted)' }}>{p.length}/1000</div>
          </div>
        ))}
        <button type="button" onClick={addPart} style={{ background: 'none', border: '1px dashed var(--border)', borderRadius: 6, padding: '5px 10px', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', marginBottom: 8 }}>+ Add another text (sent after, same recipients)</button>
        {preview && (
          <div style={{ border: '1px solid var(--accent, #b8863b)', borderRadius: 8, padding: '10px 12px', marginBottom: 10, background: 'var(--bg-secondary)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <strong style={{ fontSize: 12.5 }}>Preview — recipient {preview.idx + 1} of {clientIds.length}</strong>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                <button type="button" className="btn btn-sm btn-secondary" disabled={preview.idx <= 0} onClick={() => loadPreview(preview.idx - 1)}>‹ Prev</button>
                <button type="button" className="btn btn-sm btn-secondary" disabled={preview.idx >= clientIds.length - 1} onClick={() => loadPreview(preview.idx + 1)}>Next ›</button>
                <button type="button" className="btn btn-sm" onClick={() => setPreview(null)}>Close</button>
              </div>
            </div>
            {preview.loading ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Rendering…</div>
              : preview.error ? <div style={{ fontSize: 13, color: '#ef4444' }}>{preview.error}</div>
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{preview.parts.map((t, i) => (
                  <div key={i} style={{ background: 'var(--bg-primary,#fff)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 11px', fontSize: 14, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
                    {preview.parts.length > 1 && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 3 }}>Text {i + 1}</div>}{t || '(empty)'}
                  </div>))}</div>}
            {!preview.loading && !preview.error && /\{\{[^}]+\}\}/.test((preview.parts || []).join('')) && <div style={{ fontSize: 11.5, color: '#b45309', marginTop: 6 }}>⚠ A merge field didn't fill — check the field name matches a supported one.</div>}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-secondary" onClick={() => loadPreview(preview ? preview.idx : 0)} disabled={!filled.length} title="See the exact text a recipient gets, with custom fields filled">👁 Preview</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending || !filled.length}>{sending ? 'Queuing…' : `Send${filled.length > 1 ? ` ${filled.length} texts` : ''} to ${clientIds.length.toLocaleString()}`}</button>
        </div>
      </div>
    </Modal>
  )
}
