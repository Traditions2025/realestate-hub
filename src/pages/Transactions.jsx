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
  const [clients, setClients] = useState([])
  const [filter, setFilter] = useState({ type: '', property_status: '' })
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyTx)
  const [syncing, setSyncing] = useState(false)

  const load = () => {
    const params = {}
    if (filter.type) params.type = filter.type
    if (filter.property_status) params.property_status = filter.property_status
    if (search) params.search = search
    api.getTransactions(params).then(setItems)
  }

  useEffect(() => { load(); api.getClients().then(setClients) }, [])
  useEffect(() => { load() }, [filter, search])

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

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const check = (k) => setForm(prev => ({ ...prev, [k]: prev[k] ? 0 : 1 }))

  // Pipeline groups
  const pipelineStatuses = ['Active', 'Under Contract', 'Pending', 'Clear to Close']

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Transaction Tracker</h1>
          <p className="page-subtitle">Matches your Google Sheet - every field, every checklist item</p>
        </div>
        <div className="header-actions">
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
        {pipelineStatuses.map(stage => {
          const stageItems = items.filter(i => i.property_status === stage)
          return (
            <div key={stage} className="pipeline-column">
              <div className="pipeline-header">
                <span>{stage}</span>
                <span className="pipeline-count">{stageItems.length}</span>
              </div>
              {stageItems.map(item => (
                <div key={item.id} className="pipeline-card" onClick={() => openEdit(item)}>
                  <div className="pipeline-card-type">
                    <StatusBadge status={item.type === 'purchase' ? 'active' : 'pending'} />
                    <span className="type-label">{item.type}</span>
                  </div>
                  <div className="pipeline-card-address">{item.property_address}</div>
                  <div className="pipeline-card-meta">
                    <span>{item.buyer_name || item.seller_name || '—'}</span>
                    {item.purchase_price && <span className="price">${Number(item.purchase_price).toLocaleString()}</span>}
                  </div>
                  {item.closing_date && <div className="pipeline-card-date">Close: {item.closing_date}</div>}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Full Table */}
      <div className="table-container">
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
