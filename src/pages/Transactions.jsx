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
  type_of_finance: '',
  earnest_money_due_date: '', ipi_due_date: '',
  lender_name: '', lender_company: '',
  dotloop_status: 'Not Submitted',
  remove_listing_alerts: 0, email_contract_closing: 0,
  ayse_added_to_loop: 0, ayse_contracts_signed: 0, earnest_money_deposit: 'Not Started',
  home_inspection: 'Not Started', home_inspector: '', inspection_date: '',
  whole_property_inspection: 0, radon_test: 0, wdi_inspection: 0, septic_inspection: 0,
  well_inspection: 0, sewer_inspection: 0, seller_acknowledgment: 0, abstract: 'Not Started',
  title_commitment: 'Not Started', mortgage_payoff: 'Not Started',
  alta_statement: 'Not Ready', deed_package: 'Not Ready',
  utilities_set: 0, sales_worksheet_added: 0, submit_loop_review: 0, approved_commission: 0,
  closing_complete: 0, testimonial_request: 0, client_id: '', tc_assigned: '', notes: ''
}

// Dropdown options for document/status fields
const ABSTRACT_OPTIONS = ['Not Started', 'Ordered', 'Received', 'N/A']
const TITLE_COMMITMENT_OPTIONS = ['Not Started', 'Ordered', 'Received', 'N/A']
const MORTGAGE_PAYOFF_OPTIONS = ['Not Started', 'Requested', 'Received', 'N/A']
const ALTA_OPTIONS = ['Not Ready', 'Ready']
const DEED_PACKAGE_OPTIONS = ['Not Ready', 'Ready', 'Signed']
const DOTLOOP_OPTIONS = ['Not Submitted', 'Needs Review', 'Listing Approved', 'Approved for Commission']

// Calculate earnest money due date — 3 business days from contract date
function calcEarnestDue(contractDate) {
  if (!contractDate) return ''
  const d = new Date(contractDate)
  if (isNaN(d)) return ''
  let added = 0
  while (added < 3) {
    d.setDate(d.getDate() + 1)
    const dow = d.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return d.toISOString().split('T')[0]
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
  const [extractingPdf, setExtractingPdf] = useState(false)
  const [extractResult, setExtractResult] = useState(null)
  const [aiConfigured, setAiConfigured] = useState(false)
  const [linkedClient, setLinkedClient] = useState(null)
  // Email composer
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailTemplates, setEmailTemplates] = useState([])
  const [emailForm, setEmailForm] = useState({
    template_id: '', recipient_type: 'client', to_email: '', to_name: '',
    subject: '', body: '', auto_cc: [],
  })
  const [emailSending, setEmailSending] = useState(false)

  useEffect(() => {
    authFetch('/api/transactions/_meta/ai-status').then(r => r.json()).then(d => setAiConfigured(!!d.configured)).catch(() => {})
    authFetch('/api/email/transaction-templates').then(r => r.json()).then(setEmailTemplates).catch(() => {})
  }, [])

  const openEmailComposer = async (recipientType) => {
    if (!editing) { alert('Save the transaction first.'); return }
    let toEmail = ''
    let toName = ''
    if (recipientType === 'client') {
      toEmail = linkedClient?.email || ''
      toName = linkedClient ? `${linkedClient.first_name} ${linkedClient.last_name}` : ''
    } else if (recipientType === 'closer') {
      // Pull Cherryl's info from the Partners table dynamically
      try {
        const closer = await authFetch('/api/email/closer-info').then(r => r.json())
        toEmail = closer?.email || ''
        toName = closer?.name || ''
        if (!toEmail) {
          alert('Cherryl\'s email is not set. Add her on the Partners tab with role "Closer" or "Closing Coordinator", or set name "Cherryl" / company "At Your Service Escrow".')
          return
        }
      } catch {
        alert('Could not load closer info from Partners. Please check the Partners tab.')
        return
      }
    } else if (recipientType === 'lender') {
      toName = form.lender_name || ''
    }
    setEmailForm({
      template_id: '',
      recipient_type: recipientType,
      to_email: toEmail,
      to_name: toName,
      subject: '',
      body: '',
      auto_cc: ['johnwithmattsmithteam@gmail.com', 'mattsmithremax@gmail.com'],
    })
    setEmailOpen(true)
  }

  const loadEmailTemplate = async (templateId) => {
    if (!templateId || !editing) return
    try {
      const r = await authFetch(`/api/email/transaction-preview/${templateId}/${editing}`)
      const d = await r.json()
      if (d.error) { alert(d.error); return }
      setEmailForm(prev => ({
        ...prev,
        template_id: templateId,
        subject: d.subject,
        body: d.body,
        recipient_type: d.recipient,
        to_email: d.suggested_to || prev.to_email,
        auto_cc: d.auto_cc || prev.auto_cc,
      }))
    } catch (e) {
      alert('Failed to load template: ' + e.message)
    }
  }

  const sendTransactionEmail = async () => {
    if (!emailForm.to_email || !emailForm.subject || !emailForm.body) {
      alert('Recipient, subject, and body are required.'); return
    }
    setEmailSending(true)
    try {
      const r = await authFetch('/api/email/send-transaction', {
        method: 'POST',
        body: JSON.stringify({
          transaction_id: editing,
          to_email: emailForm.to_email,
          to_name: emailForm.to_name,
          subject: emailForm.subject,
          body: emailForm.body,
          template_id: emailForm.template_id,
        }),
      })
      const d = await r.json()
      if (d.error) { alert('Send failed: ' + d.error); return }
      alert(`✓ Email sent to ${emailForm.to_email}\nCC: ${(d.cc || []).join(', ')}`)
      setEmailOpen(false)
    } catch (e) {
      alert('Send failed: ' + e.message)
    } finally {
      setEmailSending(false)
    }
  }

  // When the modal-bound client_id changes, fetch full client info to display inline
  useEffect(() => {
    const cid = form.client_id
    if (!cid) { setLinkedClient(null); return }
    authFetch(`/api/clients/${cid}`).then(r => r.json()).then(setLinkedClient).catch(() => setLinkedClient(null))
  }, [form.client_id])

  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result.toString().split(',')[1])
    r.onerror = reject
    r.readAsDataURL(file)
  })

  // Auto-create a placeholder transaction so PDF extraction can work even on a brand new modal
  const ensureTransactionId = async () => {
    if (editing) return editing
    const placeholder = {
      property_address: form.property_address || `Pending Import — ${new Date().toLocaleString()}`,
      type: form.type || 'purchase',
      property_status: form.property_status || 'Active',
    }
    const r = await api.createTransaction(placeholder)
    setEditing(r.id)
    return r.id
  }

  const extractPurchaseAgreement = async (file) => {
    if (!aiConfigured) { alert('AI extraction needs ANTHROPIC_API_KEY on Render.'); return }
    setExtractingPdf(true)
    setExtractResult(null)
    try {
      const id = await ensureTransactionId()
      const pdf_base64 = await fileToBase64(file)
      const r = await authFetch(`/api/transactions/${id}/extract-pdf`, {
        method: 'POST',
        body: JSON.stringify({ pdf_base64, filename: file.name }),
      })
      const d = await r.json()
      if (d.error) {
        setExtractResult({ ok: false, message: d.error })
        return
      }
      // Refresh form with the updated row
      const updated = await api.getTransaction(id)
      const f = { ...emptyTx }
      Object.keys(f).forEach(k => { if (updated[k] !== undefined && updated[k] !== null) f[k] = updated[k] })
      setForm(f)
      setExtractResult({ ok: true, count: d.updated_fields, fields: Object.keys(d.extracted || {}) })
      load()
    } catch (e) {
      setExtractResult({ ok: false, message: e.message })
    } finally {
      setExtractingPdf(false)
    }
  }

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

  const openNew = () => { setEditing(null); setForm(emptyTx); setExtractResult(null); setModalOpen(true) }
  const openEdit = (item) => {
    setExtractResult(null)
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
        {/* Auto-extract from Purchase Agreement PDF */}
        <div className="addr-search-box" style={{marginBottom: 18}}>
          <h4>📄 Quick Fill — Upload Purchase Agreement</h4>
          <p className="muted" style={{margin: '0 0 10px'}}>
            Upload the signed Purchase Agreement (or Listing Agreement) PDF and Claude will auto-fill the property, parties, prices, and contingency dates below.
          </p>
          <div className="form-row" style={{gap: 8, alignItems: 'center'}}>
            <input
              type="file"
              accept="application/pdf"
              disabled={extractingPdf || !aiConfigured}
              onChange={e => { const f = e.target.files?.[0]; if (f) extractPurchaseAgreement(f); e.target.value = '' }}
            />
            {!aiConfigured && <span className="muted">(needs ANTHROPIC_API_KEY)</span>}
            {extractingPdf && <span className="muted">Reading PDF — 20-40 seconds...</span>}
          </div>
          {extractResult && (
            <div className={`addr-result ${extractResult.ok ? 'ok' : 'fail'}`} style={{marginTop: 10}}>
              {extractResult.ok ? (
                <>
                  ✓ Extracted {extractResult.count} field{extractResult.count === 1 ? '' : 's'}: {(extractResult.fields || []).slice(0, 8).join(', ')}{extractResult.fields?.length > 8 ? '...' : ''}. Review below and click Save.
                </>
              ) : (
                <>✗ {extractResult.message}</>
              )}
            </div>
          )}
        </div>

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
            <label>Client (from CRM — represents who we're working for)<select value={form.client_id} onChange={e => f('client_id', e.target.value)}>
              <option value="">Select client...</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name}{c.email ? ' · ' + c.email : ''}</option>)}
            </select></label>
            {linkedClient && (
              <div className="linked-client-card">
                <div className="linked-client-name">
                  📇 {linkedClient.first_name} {linkedClient.last_name}
                  {linkedClient.lead_score && <span className="email-status-tag">Score {linkedClient.lead_score}</span>}
                </div>
                <div className="linked-client-row">
                  {linkedClient.email && <span>✉ {linkedClient.email}</span>}
                  {linkedClient.phone && <span>☎ {linkedClient.phone}</span>}
                  {linkedClient.address && <span>📍 {linkedClient.address}{linkedClient.city ? ', ' + linkedClient.city : ''}</span>}
                </div>
              </div>
            )}
          </div>

          {/* Lender */}
          <div className="form-section">
            <h4>Lender</h4>
            <div className="form-row">
              <label>Lender Name<input value={form.lender_name} onChange={e => f('lender_name', e.target.value)} placeholder="e.g. Tim Lamb" /></label>
              <label>Lender Company<input value={form.lender_company} onChange={e => f('lender_company', e.target.value)} placeholder="e.g. Corda Credit Union" /></label>
            </div>
            <label>Type of Finance<select value={form.type_of_finance} onChange={e => f('type_of_finance', e.target.value)}>
              <option value="">Select...</option>
              {financeTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select></label>
          </div>

          {/* Pricing */}
          <div className="form-section">
            <h4>Pricing</h4>
            <label>Purchase Price<input type="number" value={form.purchase_price} onChange={e => f('purchase_price', e.target.value)} /></label>
            <label>Earnest Money Amount<input value={form.earnest_money_deposit} onChange={e => f('earnest_money_deposit', e.target.value)} placeholder="e.g. $5,000" /></label>
          </div>

          {/* Key Dates */}
          <div className="form-section">
            <h4>Key Dates</h4>
            <div className="form-row">
              <label>Contract Date
                <input
                  type="date"
                  value={form.contract_date}
                  onChange={e => {
                    const v = e.target.value
                    setForm(prev => {
                      const next = { ...prev, contract_date: v }
                      // Auto-populate earnest money due date if empty (3 business days after contract)
                      if (v && !prev.earnest_money_due_date) {
                        next.earnest_money_due_date = calcEarnestDue(v)
                      }
                      return next
                    })
                  }}
                />
              </label>
              <label>Closing Date<input type="date" value={form.closing_date} onChange={e => f('closing_date', e.target.value)} /></label>
            </div>
            <div className="form-row">
              <label title="Auto-set 3 business days after contract date — editable">
                Earnest Money Due
                <input type="date" value={form.earnest_money_due_date} onChange={e => f('earnest_money_due_date', e.target.value)} />
              </label>
              <label title="Initial Property Inspection response due">
                IPI Due Date
                <input type="date" value={form.ipi_due_date} onChange={e => f('ipi_due_date', e.target.value)} />
              </label>
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

          {/* Inspection */}
          <div className="form-section form-full">
            <h4>Inspection</h4>
            <div className="form-row">
              <label>Home Inspection<select value={form.home_inspection} onChange={e => f('home_inspection', e.target.value)}>
                <option value="Not Started">Not Started</option><option value="Scheduled">Scheduled</option>
                <option value="In Progress">In Progress</option><option value="Completed">Completed</option><option value="N/A">N/A</option>
              </select></label>
              <label>Home Inspector<input value={form.home_inspector} onChange={e => f('home_inspector', e.target.value)} placeholder="e.g. 5 Seasons Home Inspections" /></label>
              <label>Inspection Date<input type="date" value={form.inspection_date} onChange={e => f('inspection_date', e.target.value)} /></label>
            </div>
            <label>Appraisal Status<select value={form.appraisal_contingency_status} onChange={e => f('appraisal_contingency_status', e.target.value)}>
              <option value="Not Started">Not Started</option><option value="Ordered">Ordered</option>
              <option value="Completed">Completed</option><option value="N/A">N/A</option>
            </select></label>
            <div className="checklist-grid" style={{marginTop: 10}}>
              {[
                ['whole_property_inspection', 'Whole Property Inspection'],
                ['radon_test', 'Radon Test'],
                ['wdi_inspection', 'WDI (Wood-Destroying Insect)'],
                ['septic_inspection', 'Septic Inspection'],
                ['well_inspection', 'Well Inspection'],
                ['sewer_inspection', 'Sewer Inspection'],
              ].map(([key, label]) => (
                <label key={key} className="checkbox-label">
                  <input type="checkbox" checked={!!form[key]} onChange={() => check(key)} />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {/* Title & Closing Documents (dropdowns) */}
          <div className="form-section form-full">
            <h4>Title & Closing Documents</h4>
            <div className="form-row" style={{gridTemplateColumns: 'repeat(5, 1fr)'}}>
              <label>Abstract<select value={form.abstract || 'Not Started'} onChange={e => f('abstract', e.target.value)}>
                {ABSTRACT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              <label>Title Commitment<select value={form.title_commitment || 'Not Started'} onChange={e => f('title_commitment', e.target.value)}>
                {TITLE_COMMITMENT_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              <label>Mortgage Payoff<select value={form.mortgage_payoff || 'Not Started'} onChange={e => f('mortgage_payoff', e.target.value)}>
                {MORTGAGE_PAYOFF_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              <label>ALTA Statement<select value={form.alta_statement || 'Not Ready'} onChange={e => f('alta_statement', e.target.value)}>
                {ALTA_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
              <label>Deed Package<select value={form.deed_package || 'Not Ready'} onChange={e => f('deed_package', e.target.value)}>
                {DEED_PACKAGE_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
              </select></label>
            </div>
          </div>

          {/* Closing & Loop */}
          <div className="form-section form-full">
            <h4>Closing & Loop</h4>
            <label>Dotloop Transaction Status<select value={form.dotloop_status || 'Not Submitted'} onChange={e => f('dotloop_status', e.target.value)}>
              {DOTLOOP_OPTIONS.map(o => <option key={o} value={o}>{o}</option>)}
            </select></label>
            <div className="checklist-grid" style={{marginTop: 10}}>
              {[
                ['remove_listing_alerts', 'Remove Listing Alerts (Sierra & MLS)'],
                ['email_contract_closing', 'Email Contract to Closing & Next Steps'],
                ['ayse_added_to_loop', 'AYSE Added to Loop'],
                ['ayse_contracts_signed', 'AYSE Contracts Signed'],
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

          <div className="form-section form-full">
            <label>Notes<textarea value={form.notes} onChange={e => f('notes', e.target.value)} rows={3} /></label>
          </div>

          {editing && (
            <div className="form-section form-full">
              <h4>📧 Send Transaction Email</h4>
              <p className="muted" style={{margin: '0 0 10px'}}>
                All transaction emails auto-CC <strong>johnwithmattsmithteam@gmail.com</strong> and <strong>mattsmithremax@gmail.com</strong>.
              </p>
              <div style={{display: 'flex', gap: 8, flexWrap: 'wrap'}}>
                <button type="button" className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('client')} disabled={!linkedClient?.email}>
                  ✉ Email Client {linkedClient?.email ? `(${linkedClient.first_name})` : '(no email)'}
                </button>
                <button type="button" className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('lender')}>
                  🏦 Email Lender {form.lender_name ? `(${form.lender_name})` : ''}
                </button>
                <button type="button" className="lead-action-btn lead-action-email" onClick={() => openEmailComposer('closer')}>
                  📋 Email Cherryl
                </button>
                <button type="button" className="lead-action-btn" onClick={() => openEmailComposer('custom')}>
                  ✉ Custom Recipient
                </button>
              </div>
            </div>
          )}

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Transaction</button>
          </div>
        </form>
      </Modal>

      {/* Email Composer Modal */}
      <Modal open={emailOpen} onClose={() => setEmailOpen(false)} title="Send Transaction Email" wide>
        <div className="field-group">
          <h4>Template</h4>
          <select value={emailForm.template_id} onChange={e => loadEmailTemplate(e.target.value)} style={{width: '100%'}}>
            <option value="">— Choose a template (or write from scratch) —</option>
            {emailTemplates
              .filter(t => emailForm.recipient_type === 'custom' || t.recipient === emailForm.recipient_type)
              .map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>To (email)<input type="email" value={emailForm.to_email} onChange={e => setEmailForm(p => ({ ...p, to_email: e.target.value }))} /></label>
          <label>To (name)<input value={emailForm.to_name} onChange={e => setEmailForm(p => ({ ...p, to_name: e.target.value }))} /></label>
        </div>
        <div className="muted" style={{padding: '6px 10px', background: 'rgba(200, 155, 74, 0.08)', borderRadius: 4, marginBottom: 10}}>
          📋 Auto-CC: {(emailForm.auto_cc || []).join(', ')}
        </div>
        <label>Subject<input value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} style={{width: '100%'}} /></label>
        <label>Body<textarea rows={20} value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} style={{width: '100%', fontFamily: 'monospace', fontSize: 13}} /></label>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setEmailOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={sendTransactionEmail} disabled={emailSending || !emailForm.to_email}>
            {emailSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
