import React, { useState, useEffect } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const statusOptions = ['Active', 'Under Contract', 'Pending', 'Clear to Close', 'Closed', 'Pre-Listing', 'Withdrawn', 'Expired', 'Cancelled']
const financeTypes = ['Conventional', 'FHA', 'VA', 'USDA', 'Cash', 'Other']

const emptyTx = {
  property_address: '', mls_number: '', type: 'purchase', source: '', buyer_name: '',
  buyers_agent_name: '', seller_name: '', sellers_agent_name: '', agency_type: '',
  property_status: 'Active', list_price: '', purchase_price: '', contract_date: '',
  closing_date: '', mortgage_contingency_date: '', appraisal_contingency_date: '',
  appraisal_contingency_status: 'Not Started', inspection_contingency_date: '',
  financing_release: '', final_walkthrough: '', inspection_release: '', final_inspection_waiver: '',
  type_of_finance: '', remove_listing_alerts: 0, email_contract_closing: 0,
  ayse_added_to_loop: 0, ayse_contracts_signed: 0, earnest_money_deposit: 'Not Started',
  home_inspection: 'Not Started', home_inspector: '', inspection_date: '',
  whole_property_inspection: 0, radon_test: 0, wdi_inspection: 0, septic_inspection: 0,
  well_inspection: 0, sewer_inspection: 0, seller_acknowledgment: 0, abstract: '',
  title_commitment: '', mortgage_payoff: '', alta_statement: '', deed_package: '',
  utilities_set: 0, sales_worksheet_added: 0, submit_loop_review: 0, approved_commission: 0,
  closing_complete: 0, testimonial_request: 0, client_id: '', tc_assigned: '', notes: ''
}

export default function Transactions() {
  const [items, setItems] = useState([])
  const [preListings, setPreListings] = useState([])
  const [clients, setClients] = useState([])
  const [filter, setFilter] = useState({ type: '', property_status: '' })
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyTx)
  const [syncing, setSyncing] = useState(false)
  const [draggingId, setDraggingId] = useState(null)
  const [dragOverStage, setDragOverStage] = useState(null)

  // Drag payload format: "tx:<id>" or "pl:<id>"
  const onDragStart = (e, kind, item) => {
    const payload = `${kind}:${item.id}`
    setDraggingId(payload)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', payload) } catch {}
  }
  const onDragEnd = () => { setDraggingId(null); setDragOverStage(null) }
  const onDragOver = (e, stage) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverStage !== stage) setDragOverStage(stage)
  }

  const promotePreListingToTransaction = async (pl, newStatus) => {
    const txType = 'listing' // Pre-listings always become listing-type transactions
    const ok = confirm(`Promote "${pl.property_address}" from Pre-Listing to ${newStatus}?\n\nThis will create a new ${txType} transaction. The pre-listing record will be marked as Listed.`)
    if (!ok) return
    try {
      // Create the transaction
      await api.createTransaction({
        property_address: pl.property_address,
        type: txType,
        property_status: newStatus,
        seller_name: pl.owner_name || '',
        client_id: pl.client_id || null,
        notes: pl.notes || '',
      })
      // Mark the pre-listing as Listed (so it drops out of the Pre-Listing column)
      await authFetch(`/api/pre-listings/${pl.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'Listed' }),
      })
      load()
    } catch (err) {
      alert('Failed to promote pre-listing: ' + err.message)
    }
  }

  const demoteTransactionToPreListing = async (tx) => {
    const ok = confirm(`Move "${tx.property_address}" back to Pre-Listing?\n\nThis will create a new pre-listing record and mark the current transaction as Withdrawn.`)
    if (!ok) return
    try {
      await authFetch('/api/pre-listings', {
        method: 'POST',
        body: JSON.stringify({
          property_address: tx.property_address,
          owner_name: tx.seller_name || '',
          status: 'New',
          client_id: tx.client_id || null,
          notes: tx.notes || '',
        }),
      })
      await api.updateTransaction(tx.id, { property_status: 'Withdrawn' })
      load()
    } catch (err) {
      alert('Failed to demote transaction: ' + err.message)
    }
  }

  const onDrop = async (e, newStatus) => {
    e.preventDefault()
    setDragOverStage(null)
    const payload = draggingId || e.dataTransfer.getData('text/plain')
    setDraggingId(null)
    if (!payload) return
    const [kind, idStr] = payload.split(':')
    const id = Number(idStr)
    if (!id) return

    if (kind === 'pl') {
      // Pre-listing → transaction stage
      const pl = preListings.find(p => p.id === id)
      if (!pl) return
      if (newStatus === 'Pre-Listing') return // dropped on same column
      await promotePreListingToTransaction(pl, newStatus)
      return
    }

    // Transaction card
    const item = items.find(i => i.id === id)
    if (!item) return

    if (newStatus === 'Pre-Listing') {
      await demoteTransactionToPreListing(item)
      return
    }

    if (item.property_status === newStatus) return
    // Optimistic update
    setItems(prev => prev.map(i => i.id === id ? { ...i, property_status: newStatus } : i))
    try {
      await api.updateTransaction(id, { property_status: newStatus })
    } catch (err) {
      alert('Failed to update status: ' + err.message)
      load()
    }
  }

  const load = () => {
    const params = {}
    if (filter.type) params.type = filter.type
    if (filter.property_status) params.property_status = filter.property_status
    if (search) params.search = search
    api.getTransactions(params).then(setItems)
    // Pre-listings show in pipeline as the first column
    const plParams = new URLSearchParams()
    if (search) plParams.set('search', search)
    authFetch('/api/pre-listings?' + plParams).then(r => r.json()).then(setPreListings).catch(() => {})
  }

  useEffect(() => { load(); api.getClients().then(setClients) }, [])
  useEffect(() => { load() }, [filter, search])

  // Pre-listing checklist items for progress calculation
  const plChecklist = ['marketing_materials_sent', 'seller_discovery_form', 'cma', 'seller_netsheet',
    'loop_created', 'listing_contract_signed', 'getting_home_ready', 'schedule_photoshoot',
    'get_spare_keys', 'install_lockbox', 'install_signs', 'written_description',
    'coming_soon_post', 'coming_soon_email', 'listing_submitted_mls', 'posted_social_media']
  const getPlProgress = (pl) => {
    const done = plChecklist.filter(k => pl[k]).length
    return Math.round((done / plChecklist.length) * 100)
  }

  const openNew = () => { setEditing(null); setForm(emptyTx); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyTx }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form }
    ;['list_price', 'purchase_price', 'client_id'].forEach(k => {
      if (data[k] === '') data[k] = null
      else if (data[k]) data[k] = Number(data[k])
    })
    if (editing) await api.updateTransaction(editing, data)
    else await api.createTransaction(data)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this transaction?')) return
    await api.deleteTransaction(id)
    load()
  }

  const syncSheet = async () => {
    setSyncing(true)
    try {
      const r = await authFetch('/api/transactions/sync-sheet', { method: 'POST' })
      const d = await r.json()
      alert(`Synced ${d.synced} transactions from Google Sheet`)
      load()
    } catch (e) { alert('Sync failed: ' + e.message) }
    setSyncing(false)
  }

  const clearAndResync = async () => {
    if (!confirm('Clear all transactions and re-sync from Google Sheet? This will delete any manually added transactions.')) return
    setSyncing(true)
    try {
      await authFetch('/api/transactions/clear-all', { method: 'POST' })
      const r = await authFetch('/api/transactions/sync-sheet', { method: 'POST' })
      const d = await r.json()
      alert(`Cleared and re-synced ${d.synced} transactions from Google Sheet`)
      load()
    } catch (e) { alert('Resync failed: ' + e.message) }
    setSyncing(false)
  }

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const check = (k) => setForm(prev => ({ ...prev, [k]: prev[k] ? 0 : 1 }))

  // Pipeline groups - Pending merged into Under Contract
  const pipelineStatuses = ['Active', 'Under Contract', 'Clear to Close', 'Closed']

  // Compute upcoming action items for Under Contract transactions
  const today = new Date()
  today.setHours(0,0,0,0)
  const parseDate = (s) => {
    if (!s) return null
    const parts = s.split(/[\/\-]/)
    let d
    if (parts[0].length === 4) d = new Date(s)
    else d = new Date(`${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`)
    return isNaN(d) ? null : d
  }
  const daysUntil = (date) => {
    const d = parseDate(date)
    if (!d) return null
    return Math.ceil((d - today) / (1000 * 60 * 60 * 24))
  }
  const getUpcomingActions = (item) => {
    const actions = [
      { label: 'Inspection', date: item.inspection_contingency_date, status: item.home_inspection },
      { label: 'Appraisal Contingency', date: item.appraisal_contingency_date, status: item.appraisal_contingency_status },
      { label: 'Mortgage Contingency', date: item.mortgage_contingency_date },
      { label: 'Financing Release', date: item.financing_release },
      { label: 'Final Walkthrough', date: item.final_walkthrough },
      { label: 'Closing', date: item.closing_date },
    ]
    return actions
      .map(a => ({ ...a, days: daysUntil(a.date) }))
      .filter(a => a.days !== null && a.days >= -2)
      .sort((a, b) => a.days - b.days)
      .slice(0, 3)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Transaction Tracker</h1>
          <p className="page-subtitle">Hub is the source of truth. Edit directly here — Google Sheet sync is manual.</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={clearAndResync} disabled={syncing} title="Wipe all transactions and re-sync clean from Google Sheet">
            Clear & Re-sync
          </button>
          <button className="btn btn-secondary" onClick={syncSheet} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync from Google Sheet'}
          </button>
          <button className="btn btn-primary" onClick={openNew}>+ New Transaction</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search address, MLS, buyer, seller..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
        <select value={filter.type} onChange={e => setFilter(p => ({ ...p, type: e.target.value }))}>
          <option value="">All Types</option>
          <option value="purchase">Purchase</option>
          <option value="listing">Listing</option>
        </select>
        <select value={filter.property_status} onChange={e => setFilter(p => ({ ...p, property_status: e.target.value }))}>
          <option value="">All Statuses</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Pipeline View */}
      <div className="pipeline">
        {/* Pre-Listing column - pulls from pre_listings table */}
        <div
          className={`pipeline-column ${dragOverStage === 'Pre-Listing' ? 'drop-target' : ''}`}
          onDragOver={e => onDragOver(e, 'Pre-Listing')}
          onDragLeave={() => setDragOverStage(s => s === 'Pre-Listing' ? null : s)}
          onDrop={e => onDrop(e, 'Pre-Listing')}
        >
          <div className="pipeline-header">
            <span>Pre-Listing</span>
            <span className="pipeline-count">{preListings.length}</span>
          </div>
          <div className="pipeline-scroll">
            {preListings.map(pl => {
              const progress = getPlProgress(pl)
              return (
                <div
                  key={`pl-${pl.id}`}
                  className={`pipeline-card ${draggingId === `pl:${pl.id}` ? 'dragging' : ''}`}
                  draggable
                  onDragStart={e => onDragStart(e, 'pl', pl)}
                  onDragEnd={onDragEnd}
                  onClick={() => window.location.href = '/pre-listings'}
                >
                  <div className="pipeline-card-type">
                    <StatusBadge status="pre_listing" />
                    <span className="type-tag type-listing">pre-listing</span>
                  </div>
                  <div className="pipeline-card-address">{pl.property_address}</div>
                  <div className="pipeline-card-meta">
                    <span>{pl.owner_name || '—'}</span>
                    <span style={{fontSize: 11, color: progress === 100 ? '#10b981' : '#3b82f6'}}>{progress}%</span>
                  </div>
                  <div className="progress-bar" style={{marginTop: 6, height: 4}}>
                    <div className="progress-fill" style={{ width: `${progress}%`, backgroundColor: progress === 100 ? '#10b981' : '#3b82f6' }}></div>
                  </div>
                  {pl.walkthrough && pl.walkthrough !== 'Not Scheduled' && (
                    <div className="pipeline-card-date">Walkthrough: {pl.walkthrough}</div>
                  )}
                </div>
              )
            })}
            {preListings.length === 0 && (
              <div style={{padding: '20px 14px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center'}}>
                No pre-listings
              </div>
            )}
          </div>
        </div>

        {pipelineStatuses.map(stage => {
          // Merge Pending into Under Contract
          const stageItems = stage === 'Under Contract'
            ? items.filter(i => i.property_status === 'Under Contract' || i.property_status === 'Pending')
            : items.filter(i => i.property_status === stage)
          return (
            <div
              key={stage}
              className={`pipeline-column ${dragOverStage === stage ? 'drop-target' : ''}`}
              onDragOver={e => onDragOver(e, stage)}
              onDragLeave={() => setDragOverStage(s => s === stage ? null : s)}
              onDrop={e => onDrop(e, stage)}
            >
              <div className="pipeline-header">
                <span>{stage}</span>
                <span className="pipeline-count">{stageItems.length}</span>
              </div>
              <div className="pipeline-scroll">
              {stageItems.map(item => {
                const isUnderContract = stage === 'Under Contract'
                const actions = isUnderContract ? getUpcomingActions(item) : []
                return (
                  <div
                    key={item.id}
                    className={`pipeline-card ${draggingId === `tx:${item.id}` ? 'dragging' : ''}`}
                    draggable
                    onDragStart={e => onDragStart(e, 'tx', item)}
                    onDragEnd={onDragEnd}
                    onClick={() => openEdit(item)}
                  >
                    <div className="pipeline-card-type">
                      <StatusBadge status={item.property_status?.toLowerCase().replace(/ /g, '_')} />
                      <span className={`type-tag type-${item.type}`}>{item.type}</span>
                    </div>
                    <div className="pipeline-card-address">{item.property_address}</div>
                    <div className="pipeline-card-meta">
                      <span>{item.buyer_name || item.seller_name || '—'}</span>
                      {item.purchase_price && <span className="price">${Number(item.purchase_price).toLocaleString()}</span>}
                    </div>
                    {/* Upcoming actions for Under Contract */}
                    {actions.length > 0 && (
                      <div className="pipeline-actions">
                        {actions.map((a, i) => {
                          const urgent = a.days <= 3
                          const overdue = a.days < 0
                          return (
                            <div key={i} className={`pipeline-action ${overdue ? 'overdue' : urgent ? 'urgent' : ''}`}>
                              <span className="action-label">{a.label}</span>
                              <span className="action-date">
                                {a.date}
                                {a.days >= 0 ? ` (${a.days}d)` : ` (${Math.abs(a.days)}d ago)`}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {!isUnderContract && item.closing_date && (
                      <div className="pipeline-card-date">Close: {item.closing_date}</div>
                    )}
                  </div>
                )
              })}
              </div>
            </div>
          )
        })}
      </div>

      {/* Full Table - desktop */}
      <div className="table-container desktop-only-table">
        <table className="data-table">
          <thead>
            <tr>
              <th>Property Address</th>
              <th>MLS</th>
              <th>Type</th>
              <th>Status</th>
              <th>Buyer</th>
              <th>Seller</th>
              <th>Price</th>
              <th>Contract</th>
              <th>Closing</th>
              <th>TC</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan="11" className="empty-state">No transactions found. Sync from Google Sheet or create one.</td></tr>
            ) : items.map(item => (
              <tr key={item.id}>
                <td className="cell-primary" onClick={() => openEdit(item)}>{item.property_address}</td>
                <td>{item.mls_number || '—'}</td>
                <td><span className="type-inline">{item.type}</span></td>
                <td><StatusBadge status={item.property_status?.toLowerCase().replace(/ /g, '_')} /></td>
                <td>{item.buyer_name || '—'}</td>
                <td>{item.seller_name || '—'}</td>
                <td>{item.purchase_price ? `$${Number(item.purchase_price).toLocaleString()}` : item.list_price ? `$${Number(item.list_price).toLocaleString()}` : '—'}</td>
                <td>{item.contract_date || '—'}</td>
                <td>{item.closing_date || '—'}</td>
                <td>{item.tc_assigned || '—'}</td>
                <td>
                  <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                  <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Card list - mobile */}
      <div className="mobile-only-cards">
        {items.length === 0 ? (
          <div className="empty-state-full">No transactions found. Sync from Google Sheet or create one.</div>
        ) : items.map(item => (
          <div key={item.id} className="data-card" onClick={() => openEdit(item)}>
            <div className="data-card-header">
              <div className="data-card-title">{item.property_address}</div>
              <StatusBadge status={item.property_status?.toLowerCase().replace(/ /g, '_')} />
            </div>
            <div className="data-card-meta">
              <span className={`type-tag type-${item.type}`}>{item.type}</span>
              {item.mls_number && <span>MLS {item.mls_number}</span>}
            </div>
            <div className="data-card-body">
              {item.buyer_name && <div><strong>Buyer:</strong> {item.buyer_name}</div>}
              {item.seller_name && <div><strong>Seller:</strong> {item.seller_name}</div>}
              {(item.purchase_price || item.list_price) && (
                <div><strong>Price:</strong> {item.purchase_price ? `$${Number(item.purchase_price).toLocaleString()}` : `$${Number(item.list_price).toLocaleString()}`}</div>
              )}
              {item.contract_date && <div><strong>Contract:</strong> {item.contract_date}</div>}
              {item.closing_date && <div><strong>Closing:</strong> {item.closing_date}</div>}
              {item.tc_assigned && <div><strong>TC:</strong> {item.tc_assigned}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Full Transaction Form Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Transaction' : 'New Transaction'} wide>
        <form onSubmit={save} className="form-grid">
          {/* Property Info */}
          <div className="form-section">
            <h4>Property Info</h4>
            <label>Property Address<input value={form.property_address} onChange={e => f('property_address', e.target.value)} required /></label>
            <div className="form-row">
              <label>MLS #<input value={form.mls_number} onChange={e => f('mls_number', e.target.value)} /></label>
              <label>Type<select value={form.type} onChange={e => f('type', e.target.value)}>
                <option value="purchase">Purchase</option><option value="listing">Listing</option>
              </select></label>
            </div>
            <div className="form-row">
              <label>Source<input value={form.source} onChange={e => f('source', e.target.value)} placeholder="MLS, Zillow, Referral..." /></label>
              <label>Status<select value={form.property_status} onChange={e => f('property_status', e.target.value)}>
                {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
              </select></label>
            </div>
            <div className="form-row">
              <label>Agency Type<select value={form.agency_type} onChange={e => f('agency_type', e.target.value)}>
                <option value="">Select...</option>
                <option value="Buyer's Agent">Buyer's Agent</option>
                <option value="Listing Agent">Listing Agent</option>
                <option value="Dual Agent">Dual Agent</option>
              </select></label>
              <label>Type of Finance<select value={form.type_of_finance} onChange={e => f('type_of_finance', e.target.value)}>
                <option value="">Select...</option>
                {financeTypes.map(t => <option key={t} value={t}>{t}</option>)}
              </select></label>
            </div>
          </div>

          {/* People */}
          <div className="form-section">
            <h4>People</h4>
            <div className="form-row">
              <label>Buyer Name<input value={form.buyer_name} onChange={e => f('buyer_name', e.target.value)} /></label>
              <label>Buyer's Agent<input value={form.buyers_agent_name} onChange={e => f('buyers_agent_name', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Seller Name<input value={form.seller_name} onChange={e => f('seller_name', e.target.value)} /></label>
              <label>Seller's Agent<input value={form.sellers_agent_name} onChange={e => f('sellers_agent_name', e.target.value)} /></label>
            </div>
            <label>TC Assigned<input value={form.tc_assigned} onChange={e => f('tc_assigned', e.target.value)} /></label>
            <label>Client (from CRM)<select value={form.client_id} onChange={e => f('client_id', e.target.value)}>
              <option value="">Select client...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}</option>)}
            </select></label>
          </div>

          {/* Pricing */}
          <div className="form-section">
            <h4>Pricing</h4>
            <div className="form-row">
              <label>List Price<input type="number" value={form.list_price} onChange={e => f('list_price', e.target.value)} /></label>
              <label>Purchase Price<input type="number" value={form.purchase_price} onChange={e => f('purchase_price', e.target.value)} /></label>
            </div>
          </div>

          {/* Key Dates */}
          <div className="form-section">
            <h4>Key Dates</h4>
            <div className="form-row">
              <label>Contract Date<input type="date" value={form.contract_date} onChange={e => f('contract_date', e.target.value)} /></label>
              <label>Closing Date<input type="date" value={form.closing_date} onChange={e => f('closing_date', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Mortgage Contingency<input type="date" value={form.mortgage_contingency_date} onChange={e => f('mortgage_contingency_date', e.target.value)} /></label>
              <label>Appraisal Contingency<input type="date" value={form.appraisal_contingency_date} onChange={e => f('appraisal_contingency_date', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Inspection Contingency<input type="date" value={form.inspection_contingency_date} onChange={e => f('inspection_contingency_date', e.target.value)} /></label>
              <label>Final Walkthrough<input type="date" value={form.final_walkthrough} onChange={e => f('final_walkthrough', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label>Financing Release<input type="date" value={form.financing_release} onChange={e => f('financing_release', e.target.value)} /></label>
              <label>Inspection Release<input type="date" value={form.inspection_release} onChange={e => f('inspection_release', e.target.value)} /></label>
            </div>
            <label>Final Inspection Waiver<input type="date" value={form.final_inspection_waiver} onChange={e => f('final_inspection_waiver', e.target.value)} /></label>
          </div>

          {/* Inspections */}
          <div className="form-section">
            <h4>Inspections</h4>
            <div className="form-row">
              <label>Earnest Money<select value={form.earnest_money_deposit} onChange={e => f('earnest_money_deposit', e.target.value)}>
                <option value="Not Started">Not Started</option><option value="Completed">Completed</option><option value="N/A">N/A</option>
              </select></label>
              <label>Home Inspection<select value={form.home_inspection} onChange={e => f('home_inspection', e.target.value)}>
                <option value="Not Started">Not Started</option><option value="In Progress">In Progress</option>
                <option value="Completed">Completed</option><option value="N/A">N/A</option>
              </select></label>
            </div>
            <div className="form-row">
              <label>Home Inspector<input value={form.home_inspector} onChange={e => f('home_inspector', e.target.value)} /></label>
              <label>Inspection Date<input type="date" value={form.inspection_date} onChange={e => f('inspection_date', e.target.value)} /></label>
            </div>
            <label>Appraisal Status<select value={form.appraisal_contingency_status} onChange={e => f('appraisal_contingency_status', e.target.value)}>
              <option value="Not Started">Not Started</option><option value="Ordered">Ordered</option>
              <option value="Completed">Completed</option><option value="N/A">N/A</option>
            </select></label>
          </div>

          {/* Checklist */}
          <div className="form-section form-full">
            <h4>Checklist</h4>
            <div className="checklist-grid">
              {[
                ['remove_listing_alerts', 'Remove Listing Alerts (Sierra & MLS)'],
                ['email_contract_closing', 'Email Contract to Closing & Next Steps'],
                ['ayse_added_to_loop', 'AYSE Added to Loop'],
                ['ayse_contracts_signed', 'AYSE Contracts Signed'],
                ['whole_property_inspection', 'Whole Property Inspection'],
                ['radon_test', 'Radon Test'],
                ['wdi_inspection', 'WDI Inspection'],
                ['septic_inspection', 'Septic Inspection'],
                ['well_inspection', 'Well Inspection'],
                ['sewer_inspection', 'Sewer Inspection'],
                ['seller_acknowledgment', 'Seller Acknowledgment'],
                ['utilities_set', 'Utilities Set to New Owner'],
                ['sales_worksheet_added', 'Sales Worksheet Added'],
                ['submit_loop_review', 'Submit Loop for Review'],
                ['approved_commission', 'Approved for Commission'],
                ['closing_complete', 'Closing Complete'],
                ['testimonial_request', 'Testimonial Request Sent'],
              ].map(([key, label]) => (
                <label key={key} className="checkbox-label">
                  <input type="checkbox" checked={!!form[key]} onChange={() => check(key)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Title & Closing Docs */}
          <div className="form-section form-full">
            <h4>Title & Closing</h4>
            <div className="form-row" style={{gridTemplateColumns: 'repeat(5, 1fr)'}}>
              <label>Abstract<input value={form.abstract} onChange={e => f('abstract', e.target.value)} placeholder="Status..." /></label>
              <label>Title Commitment<input value={form.title_commitment} onChange={e => f('title_commitment', e.target.value)} placeholder="Status..." /></label>
              <label>Mortgage Payoff<input value={form.mortgage_payoff} onChange={e => f('mortgage_payoff', e.target.value)} /></label>
              <label>ALTA Statement<input value={form.alta_statement} onChange={e => f('alta_statement', e.target.value)} /></label>
              <label>Deed Package<input value={form.deed_package} onChange={e => f('deed_package', e.target.value)} /></label>
            </div>
          </div>

          <div className="form-section form-full">
            <label>Notes<textarea value={form.notes} onChange={e => f('notes', e.target.value)} rows={3} /></label>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Transaction</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
