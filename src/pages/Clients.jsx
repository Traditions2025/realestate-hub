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

  const load = () => {
    const params = {}
    if (filter.type) params.type = filter.type
    if (tab !== 'all') params.status = tab
    if (search) params.search = search
    api.getClients(params).then(setItems)
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

  useEffect(() => { load() }, [filter, search, tab])

  const syncSierra = async (silent = false, statuses = 'Active,Prime') => {
    setSierraStatus('syncing')
    setSyncMenuOpen(false)
    try {
      const r = await authFetch(`/api/sierra/sync?statuses=${encodeURIComponent(statuses)}`, { method: 'POST' })
      const d = await r.json()
      if (d.error) {
        setSierraStatus({ error: d.error })
        if (!silent) alert('Sierra sync error: ' + d.error)
      } else {
        setSierraStatus(d)
        setSyncLog({ leads_synced: d.total_synced, leads_added: d.added, leads_updated: d.updated, synced_at: new Date().toISOString() })
        load()
      }
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
  const openDetail = async (id) => {
    const d = await api.getClient(id)
    setDetail(d)
    setDetailOpen(true)
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

  const addTransaction = async (client, type, e) => {
    if (e) e.stopPropagation()
    const address = client.address
      ? `${client.address}${client.city ? ', ' + client.city : ''}${client.state ? ', ' + client.state : ''}${client.zip ? ' ' + client.zip : ''}`
      : ''
    const addr = prompt(`Property address for ${type}:`, address)
    if (!addr) return
    const txData = {
      property_address: addr,
      type: type,
      property_status: 'Under Contract',
      client_id: client.id,
      buyer_name: type === 'purchase' ? `${client.first_name} ${client.last_name}` : '',
      seller_name: type === 'listing' ? `${client.first_name} ${client.last_name}` : '',
      buyers_agent_name: type === 'purchase' ? (client.agent_assigned || 'Matt Smith') : '',
      sellers_agent_name: type === 'listing' ? (client.agent_assigned || 'Matt Smith') : '',
      agency_type: type === 'purchase' ? "Buyer's Agent" : 'Listing Agent',
    }
    await api.createTransaction(txData)
    // Update client status to under_contract
    await api.updateClient(client.id, { status: 'under_contract' })
    alert(`${type === 'purchase' ? 'Purchase' : 'Listing'} transaction created for ${client.first_name} ${client.last_name}`)
    load()
    if (detail) openDetail(client.id)
  }

  // Stats - load all clients for counts
  const [allCounts, setAllCounts] = useState({ active: 0, prime: 0, potential: 0, watch: 0, buyers: 0, sellers: 0, total: 0 })
  useEffect(() => {
    api.getClients().then(all => {
      setAllCounts({
        active: all.filter(i => i.status === 'active').length,
        prime: all.filter(i => i.status === 'prime').length,
        potential: all.filter(i => i.status === 'potential').length,
        watch: all.filter(i => i.status === 'watch').length,
        buyers: all.filter(i => (i.type === 'buyer' || i.type === 'both')).length,
        sellers: all.filter(i => (i.type === 'seller' || i.type === 'both')).length,
        total: all.length,
      })
    })
  }, [items])

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Clients</h1>
          <p className="page-subtitle">Active buyers, sellers, and prospects — synced from Sierra Interactive</p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-primary"
            onClick={() => syncSierra(false, 'Active,Prime,Watch,Pending')}
            disabled={sierraStatus === 'syncing'}
            title="Pulls Active, Prime, Watch, and Pending leads - meaningful prospects only"
          >
            {sierraStatus === 'syncing' ? 'Syncing Sierra...' : (() => {
              if (!sierraCounts) return 'Sync Sierra Leads'
              const meaningful = (sierraCounts.Active || 0) + (sierraCounts.Prime || 0) + (sierraCounts.Watch || 0) + (sierraCounts.Pending || 0)
              return `Sync Sierra Leads (${meaningful})`
            })()}
          </button>
          <button className="btn btn-secondary" onClick={openNew}>+ Add Manually</button>
        </div>
      </div>

      {/* Sierra Sync Status Bar */}
      <div className="sierra-status-bar">
        {sierraStatus === 'syncing' && (
          <div className="sierra-banner syncing">Pulling Active leads from Sierra Interactive...</div>
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

      {/* Status Tabs */}
      <div className="client-tabs">
        <button className={`client-tab ${tab === 'active' ? 'active' : ''}`} onClick={() => setTab('active')}>
          <span className="tab-dot tab-dot-blue"></span>
          Active
          <span className="tab-count">{allCounts.active}</span>
        </button>
        <button className={`client-tab ${tab === 'prime' ? 'active' : ''}`} onClick={() => setTab('prime')}>
          <span className="tab-dot tab-dot-amber"></span>
          Prime
          <span className="tab-count">{allCounts.prime}</span>
        </button>
        {allCounts.potential > 0 && (
          <button className={`client-tab ${tab === 'potential' ? 'active' : ''}`} onClick={() => setTab('potential')}>
            <span className="tab-dot tab-dot-purple"></span>
            New / Potential
            <span className="tab-count">{allCounts.potential}</span>
          </button>
        )}
        {allCounts.watch > 0 && (
          <button className={`client-tab ${tab === 'watch' ? 'active' : ''}`} onClick={() => setTab('watch')}>
            <span className="tab-dot tab-dot-cyan"></span>
            Watch
            <span className="tab-count">{allCounts.watch}</span>
          </button>
        )}
        <button className={`client-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')}>
          All
          <span className="tab-count">{allCounts.total}</span>
        </button>
      </div>

      {/* Stats Row */}
      <div className="stats-grid stats-small">
        <div className="stat-card stat-blue">
          <div className="stat-number">{items.length}</div>
          <div className="stat-label">{tab === 'all' ? 'Total' : tab === 'active' ? 'Active' : 'Prime'} Showing</div>
        </div>
        <div className="stat-card stat-green">
          <div className="stat-number">{allCounts.buyers}</div>
          <div className="stat-label">Buyers</div>
        </div>
        <div className="stat-card stat-rose">
          <div className="stat-number">{allCounts.sellers}</div>
          <div className="stat-label">Sellers</div>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search name, email, phone, address, city, zip..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
        <select value={filter.type} onChange={e => setFilter(p => ({ ...p, type: e.target.value }))}>
          <option value="">All Types</option>
          <option value="buyer">Buyer</option>
          <option value="seller">Seller</option>
          <option value="both">Both</option>
        </select>
      </div>

      {/* Client Cards */}
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
              <div>
                <div className="client-name">{item.first_name} {item.last_name}</div>
                <div className="client-type">
                  <span className={`client-type-badge type-${item.type}`}>{item.type}</span>
                  {item.sierra_lead_id && <span className="sierra-tag">Sierra</span>}
                </div>
              </div>
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
                Pre-Listing
              </button>
              <button className="action-btn action-purchase" onClick={e => addTransaction(item, 'purchase', e)} title="Create Purchase Transaction">
                Purchase
              </button>
              <button className="action-btn action-listing" onClick={e => addTransaction(item, 'listing', e)} title="Create Listing Transaction">
                Listing
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Detail Modal */}
      <Modal open={detailOpen} onClose={() => setDetailOpen(false)} title={detail ? `${detail.first_name} ${detail.last_name}` : ''} wide>
        {detail && (
          <div className="detail-view">
            <div className="detail-grid">
              <div className="detail-section">
                <h4>Contact Info</h4>
                <p><strong>Phone:</strong> {detail.phone || '—'}</p>
                <p><strong>Email:</strong> {detail.email || '—'}</p>
                <p><strong>Address:</strong> {detail.address || '—'}</p>
                <p><strong>City:</strong> {detail.city || '—'}{detail.state ? `, ${detail.state}` : ''} {detail.zip || ''}</p>
                <p><strong>Source:</strong> {detail.source || '—'}</p>
                <p><strong>Agent:</strong> {detail.agent_assigned || '—'}</p>
                {detail.sierra_lead_id && <p><strong>Sierra ID:</strong> {detail.sierra_lead_id}</p>}
              </div>
              <div className="detail-section">
                <h4>Financial</h4>
                <p><strong>Budget:</strong> {formatCurrency(detail.budget_min)} - {formatCurrency(detail.budget_max)}</p>
                <p><strong>Pre-Approval:</strong> {formatCurrency(detail.preapproval_amount)}</p>
                <p><strong>Lender:</strong> {detail.preapproval_lender || '—'}</p>
                {detail.lead_score && <p><strong>Lead Score:</strong> {detail.lead_score}</p>}
                {detail.lead_grade && <p><strong>Lead Grade:</strong> {detail.lead_grade}</p>}
              </div>
            </div>

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

            {/* Quick Actions */}
            <div className="detail-section">
              <h4>Quick Actions</h4>
              <div className="detail-actions-grid">
                <button className="detail-action-btn action-prelisting" onClick={() => addToPreListing(detail)}>
                  <span className="detail-action-icon">&#8962;</span>
                  <span>Add to Pre-Listing</span>
                  <span className="detail-action-desc">Start the seller pipeline</span>
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
