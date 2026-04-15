import React, { useState, useEffect } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const checklistItems = [
  ['marketing_materials_sent', 'Marketing Materials Sent'],
  ['seller_discovery_form', 'Send Google Form "Home Seller Discovery Questions"'],
  ['cma', 'CMA'],
  ['seller_netsheet', 'Seller Netsheet'],
  ['loop_created', 'Loop Created'],
  ['listing_contract_signed', 'Listing Contract Signed'],
  ['getting_home_ready', 'Getting Your Home Ready'],
  ['schedule_photoshoot', 'Schedule Professional Photoshoot'],
  ['get_spare_keys', 'Get Spare Keys'],
  ['install_lockbox', 'Install Lockbox'],
  ['install_signs', 'Install For Sale Signs'],
  ['written_description', 'Written Property Description'],
  ['coming_soon_post', 'Coming Soon Post (24 Hrs Before)'],
  ['coming_soon_email', 'Coming Soon Email (24 Hrs Before)'],
  ['listing_submitted_mls', 'Listing Submitted in MLS'],
  ['posted_social_media', 'Posted on Social Media'],
]

const emptyForm = {
  property_address: '', owner_name: '', walkthrough: 'Not Scheduled', status: 'New', notes: '',
  ...Object.fromEntries(checklistItems.map(([k]) => [k, 0]))
}

export default function PreListings() {
  const [items, setItems] = useState([])
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [syncing, setSyncing] = useState(false)

  const load = () => {
    const params = {}
    if (search) params.search = search
    authFetch('/api/pre-listings?' + new URLSearchParams(params)).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [search])

  const openNew = () => { setEditing(null); setForm(emptyForm); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyForm }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }
    const url = editing ? `/api/pre-listings/${editing}` : '/api/pre-listings'
    await authFetch(url, opts)
    setModalOpen(false)
    load()
  }

  const toggleCheck = async (item, key) => {
    await authFetch(`/api/pre-listings/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: item[key] ? 0 : 1 })
    })
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this pre-listing?')) return
    await authFetch(`/api/pre-listings/${id}`, { method: 'DELETE' })
    load()
  }

  const syncSheet = async () => {
    setSyncing(true)
    try {
      const r = await authFetch('/api/pre-listings/sync-sheet', { method: 'POST' })
      const d = await r.json()
      alert(`Synced ${d.synced} potential sellers from Google Sheet`)
      load()
    } catch (e) { alert('Sync failed: ' + e.message) }
    setSyncing(false)
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const check = (k) => setForm(prev => ({ ...prev, [k]: prev[k] ? 0 : 1 }))

  const getProgress = (item) => {
    const done = checklistItems.filter(([k]) => item[k]).length
    return Math.round((done / checklistItems.length) * 100)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Pre-Listing Pipeline</h1>
          <p className="page-subtitle">Potential sellers - from walkthrough to MLS activation</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={syncSheet} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync from Google Sheet'}
          </button>
          <button className="btn btn-primary" onClick={openNew}>+ New Pre-Listing</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search address or owner..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
      </div>

      <div className="project-grid">
        {items.length === 0 ? (
          <div className="empty-state-full">No pre-listings. Sync from Google Sheet or add one above.</div>
        ) : items.map(item => {
          const progress = getProgress(item)
          return (
            <div key={item.id} className="project-card" onClick={() => openEdit(item)}>
              <div className="project-card-header">
                <div className="project-card-title">{item.property_address}</div>
                <StatusBadge status={item.status?.toLowerCase().replace(/ /g, '_') || 'planning'} />
              </div>
              <div className="project-card-desc">{item.owner_name || 'No owner name'}</div>
              <div className="project-card-meta">
                <span>Walkthrough: {item.walkthrough}</span>
              </div>
              <div className="progress-bar" style={{marginTop: 8}}>
                <div className="progress-fill" style={{ width: `${progress}%`, backgroundColor: progress === 100 ? '#10b981' : '#3b82f6' }}></div>
                <span className="progress-label">{progress}%</span>
              </div>

              {/* Inline checklist */}
              <div className="prelisting-checklist" onClick={e => e.stopPropagation()}>
                {checklistItems.map(([key, label]) => (
                  <label key={key} className="checkbox-label mini-check" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={!!item[key]} onChange={() => toggleCheck(item, key)} />
                    <span className={item[key] ? 'checked-text' : ''}>{label}</span>
                  </label>
                ))}
              </div>

              <div className="project-card-actions" onClick={e => e.stopPropagation()}>
                <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Delete</button>
              </div>
            </div>
          )
        })}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Pre-Listing' : 'New Pre-Listing'}>
        <form onSubmit={save}>
          <label>Property Address<input value={form.property_address} onChange={e => f2('property_address', e.target.value)} required /></label>
          <label>Owner's Name<input value={form.owner_name} onChange={e => f2('owner_name', e.target.value)} /></label>
          <div className="form-row">
            <label>Walkthrough<select value={form.walkthrough} onChange={e => f2('walkthrough', e.target.value)}>
              <option value="Not Scheduled">Not Scheduled</option><option value="Scheduled">Scheduled</option>
              <option value="Pending">Pending</option><option value="Completed">Completed</option>
            </select></label>
            <label>Status<select value={form.status} onChange={e => f2('status', e.target.value)}>
              <option value="New">New</option><option value="In Progress">In Progress</option>
              <option value="Ready">Ready</option><option value="Listed">Listed</option>
            </select></label>
          </div>
          <h4 style={{marginTop: 16, color: 'var(--accent)'}}>Checklist</h4>
          <div className="checklist-grid">
            {checklistItems.map(([key, label]) => (
              <label key={key} className="checkbox-label">
                <input type="checkbox" checked={!!form[key]} onChange={() => check(key)} />
                {label}
              </label>
            ))}
          </div>
          <label>Notes<textarea value={form.notes} onChange={e => f2('notes', e.target.value)} rows={3} /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
