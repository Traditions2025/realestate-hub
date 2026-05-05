import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import RecommendModal from '../components/RecommendModal'

const defaultCategories = [
  'Mortgage Lender', 'Title Company', 'Real Estate Attorney', 'Insurance Agent',
  'Home Inspector', 'Photographer', 'Stager', 'Handyman', 'Plumber', 'Electrician',
  'HVAC', 'Roofer', 'Painter', 'Landscaper', 'Cleaner', 'Pest Control', 'Appraiser',
  'Surveyor', 'Mover', 'Locksmith', 'Carpet/Flooring', 'Window/Door', 'Foundation',
  'General Contractor', 'Sign Company', 'Other'
]

const emptyVendor = {
  company_name: '', contact_name: '', category: 'Home Inspector', phone: '', email: '',
  website: '', address: '', city: '', state: 'IA', preferred: 0, notes: ''
}

export default function Vendors() {
  const [items, setItems] = useState([])
  const [search, setSearch] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyVendor)

  const load = () => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (catFilter) params.set('category', catFilter)
    authFetch('/api/vendors?' + params).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [search, catFilter])

  const openNew = () => { setEditing(null); setForm(emptyVendor); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyVendor }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }
    await authFetch(editing ? `/api/vendors/${editing}` : '/api/vendors', opts)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this vendor?')) return
    await authFetch(`/api/vendors/${id}`, { method: 'DELETE' })
    load()
  }

  const togglePreferred = async (item) => {
    await authFetch(`/api/vendors/${item.id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preferred: item.preferred ? 0 : 1 })
    })
    load()
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  // Multi-select for "Send to Client"
  const [selected, setSelected] = useState(new Set())
  const [recommendOpen, setRecommendOpen] = useState(false)
  const [recommendItems, setRecommendItems] = useState([])

  const toggleSelect = (id) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const openRecommendOne = (vendor) => {
    setRecommendItems([vendor])
    setRecommendOpen(true)
  }

  const openRecommendBulk = () => {
    const chosen = items.filter(v => selected.has(v.id))
    if (!chosen.length) return
    setRecommendItems(chosen)
    setRecommendOpen(true)
  }

  const copyContact = async (v, e) => {
    e?.stopPropagation()
    const lines = [
      v.contact_name ? `${v.contact_name}` : null,
      v.company_name ? `${v.company_name}` : null,
      v.phone ? `Phone: ${v.phone}` : null,
      v.email ? `Email: ${v.email}` : null,
      v.website ? `Website: ${v.website}` : null,
    ].filter(Boolean).join('\n')
    try {
      await navigator.clipboard.writeText(lines)
      // Quick visual feedback via title change handled by caller
    } catch {
      const t = document.createElement('textarea')
      t.value = lines; document.body.appendChild(t); t.select()
      document.execCommand('copy'); document.body.removeChild(t)
    }
  }

  // Group by category
  const grouped = {}
  items.forEach(item => {
    const cat = item.category || 'Other'
    if (!grouped[cat]) grouped[cat] = []
    grouped[cat].push(item)
  })

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Vendor List</h1>
          <p className="page-subtitle">Your go-to service providers for every transaction</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ Add Vendor</button>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search vendors..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
        <select value={catFilter} onChange={e => setCatFilter(e.target.value)}>
          <option value="">All Categories</option>
          {defaultCategories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {selected.size > 0 && (
          <>
            <button className="btn btn-primary" onClick={openRecommendBulk}>
              ✉ Send {selected.size} Selected to Client
            </button>
            <button className="btn btn-secondary" onClick={() => setSelected(new Set())}>
              Clear ({selected.size})
            </button>
          </>
        )}
      </div>

      {Object.keys(grouped).length === 0 ? (
        <div className="empty-state-full">No vendors yet. Add your first vendor above.</div>
      ) : Object.entries(grouped).map(([cat, vendors]) => (
        <div key={cat} className="vendor-group">
          <h3 className="vendor-group-title">{cat} <span className="vendor-group-count">({vendors.length})</span></h3>
          <div className="client-grid">
            {vendors.map(v => (
              <div key={v.id} className={`client-card ${selected.has(v.id) ? 'selected-card' : ''}`} onClick={() => openEdit(v)}>
                <div className="client-card-header">
                  <input
                    type="checkbox"
                    checked={selected.has(v.id)}
                    onChange={() => toggleSelect(v.id)}
                    onClick={e => e.stopPropagation()}
                    title="Select for bulk recommendation"
                    style={{marginRight: 6, accentColor: 'var(--accent)'}}
                  />
                  <div className="client-avatar" style={{background: v.preferred ? '#10b981' : '#6366f1'}}>
                    {v.company_name.substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <div className="client-name">{v.company_name}</div>
                    {v.contact_name && <div className="client-type">{v.contact_name}</div>}
                  </div>
                </div>
                <div className="client-card-body">
                  {v.phone && <div className="client-info">{v.phone}</div>}
                  {v.email && <div className="client-info">{v.email}</div>}
                  {v.website && <div className="client-info">{v.website}</div>}
                </div>
                <div className="client-card-footer" onClick={e => e.stopPropagation()}>
                  <div style={{display: 'flex', gap: 4, flexWrap: 'wrap'}}>
                    <button
                      className="btn-sm btn-secondary"
                      title="Copy contact info to clipboard"
                      onClick={async (e) => {
                        await copyContact(v, e)
                        e.target.textContent = '✓ Copied'
                        setTimeout(() => { e.target.textContent = '📋 Copy' }, 1500)
                      }}
                    >📋 Copy</button>
                    <button
                      className="btn-sm btn-primary"
                      title="Send this vendor's info to a client"
                      onClick={(e) => { e.stopPropagation(); openRecommendOne(v) }}
                    >✉ Send</button>
                    <button className="btn-sm" onClick={e => { e.stopPropagation(); togglePreferred(v) }}>
                      {v.preferred ? '★' : '☆'}
                    </button>
                  </div>
                  {v.preferred && <span className="preferred-badge">Preferred</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Vendor' : 'Add Vendor'}>
        <form onSubmit={save}>
          <label>Company Name<input value={form.company_name} onChange={e => f2('company_name', e.target.value)} required /></label>
          <label>Contact Name<input value={form.contact_name} onChange={e => f2('contact_name', e.target.value)} /></label>
          <label>Category<select value={form.category} onChange={e => f2('category', e.target.value)}>
            {defaultCategories.map(c => <option key={c} value={c}>{c}</option>)}
          </select></label>
          <div className="form-row">
            <label>Phone<input value={form.phone} onChange={e => f2('phone', e.target.value)} /></label>
            <label>Email<input value={form.email} onChange={e => f2('email', e.target.value)} /></label>
          </div>
          <label>Website<input value={form.website} onChange={e => f2('website', e.target.value)} /></label>
          <div className="form-row">
            <label>City<input value={form.city} onChange={e => f2('city', e.target.value)} /></label>
            <label>State<input value={form.state} onChange={e => f2('state', e.target.value)} /></label>
          </div>
          <label className="checkbox-label"><input type="checkbox" checked={!!form.preferred} onChange={e => f2('preferred', e.target.checked ? 1 : 0)} /> Preferred Vendor</label>
          <label>Notes<textarea value={form.notes} onChange={e => f2('notes', e.target.value)} rows={3} /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            {editing && <button type="button" className="btn btn-danger" onClick={() => { remove(editing); setModalOpen(false) }}>Delete</button>}
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add'} Vendor</button>
          </div>
        </form>
      </Modal>

      <RecommendModal
        open={recommendOpen}
        onClose={() => setRecommendOpen(false)}
        kind="vendor"
        initialItems={recommendItems}
      />
    </div>
  )
}
