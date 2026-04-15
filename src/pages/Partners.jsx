import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const roleOptions = [
  'Lender / Loan Officer', 'Title Company', 'Escrow Officer', 'Real Estate Attorney',
  'Insurance Agent', 'Appraiser', 'Referring Agent', 'Builder', 'Property Manager',
  'Financial Advisor', 'CPA / Tax', 'Other'
]

const emptyPartner = {
  name: '', company: '', role: 'Lender / Loan Officer', phone: '', email: '',
  website: '', address: '', city: '', state: 'IA', specialty: '',
  relationship_level: 'contact', referral_count: 0, last_referral_date: '', preferred: 0, notes: ''
}

export default function Partners() {
  const [items, setItems] = useState([])
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyPartner)

  const load = () => {
    const params = new URLSearchParams()
    if (search) params.set('search', search)
    if (roleFilter) params.set('role', roleFilter)
    authFetch('/api/partners?' + params).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [search, roleFilter])

  const openNew = () => { setEditing(null); setForm(emptyPartner); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyPartner }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form, referral_count: Number(form.referral_count) }
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
    await authFetch(editing ? `/api/partners/${editing}` : '/api/partners', opts)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this partner?')) return
    await authFetch(`/api/partners/${id}`, { method: 'DELETE' })
    load()
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const relationColors = { strategic: '#10b981', preferred: '#3b82f6', contact: '#6b7280' }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Partner Directory</h1>
          <p className="page-subtitle">Lenders, title companies, attorneys, and key relationships</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ Add Partner</button>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search partners..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
        <select value={roleFilter} onChange={e => setRoleFilter(e.target.value)}>
          <option value="">All Roles</option>
          {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Company</th>
              <th>Role</th>
              <th>Phone</th>
              <th>Email</th>
              <th>Specialty</th>
              <th>Relationship</th>
              <th>Referrals</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan="9" className="empty-state">No partners yet. Add your first partner above.</td></tr>
            ) : items.map(item => (
              <tr key={item.id}>
                <td className="cell-primary" onClick={() => openEdit(item)}>
                  {item.preferred ? <span style={{color: '#10b981', marginRight: 4}}>&#9733;</span> : null}
                  {item.name}
                </td>
                <td>{item.company || '—'}</td>
                <td>{item.role}</td>
                <td>{item.phone || '—'}</td>
                <td>{item.email || '—'}</td>
                <td>{item.specialty || '—'}</td>
                <td><span className="status-badge" style={{
                  backgroundColor: `${relationColors[item.relationship_level] || '#6b7280'}18`,
                  color: relationColors[item.relationship_level] || '#6b7280',
                  borderColor: `${relationColors[item.relationship_level] || '#6b7280'}40`
                }}>{item.relationship_level}</span></td>
                <td>{item.referral_count || 0}</td>
                <td>
                  <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                  <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Partner' : 'Add Partner'}>
        <form onSubmit={save}>
          <div className="form-row">
            <label>Name<input value={form.name} onChange={e => f2('name', e.target.value)} required /></label>
            <label>Company<input value={form.company} onChange={e => f2('company', e.target.value)} /></label>
          </div>
          <label>Role<select value={form.role} onChange={e => f2('role', e.target.value)}>
            {roleOptions.map(r => <option key={r} value={r}>{r}</option>)}
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
          <label>Specialty<input value={form.specialty} onChange={e => f2('specialty', e.target.value)} placeholder="FHA specialist, first-time buyers..." /></label>
          <div className="form-row">
            <label>Relationship Level<select value={form.relationship_level} onChange={e => f2('relationship_level', e.target.value)}>
              <option value="contact">Contact</option><option value="preferred">Preferred</option><option value="strategic">Strategic</option>
            </select></label>
            <label>Referrals Given<input type="number" value={form.referral_count} onChange={e => f2('referral_count', e.target.value)} /></label>
          </div>
          <label>Last Referral Date<input type="date" value={form.last_referral_date} onChange={e => f2('last_referral_date', e.target.value)} /></label>
          <label className="checkbox-label"><input type="checkbox" checked={!!form.preferred} onChange={e => f2('preferred', e.target.checked ? 1 : 0)} /> Preferred Partner</label>
          <label>Notes<textarea value={form.notes} onChange={e => f2('notes', e.target.value)} rows={3} /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Add'} Partner</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
