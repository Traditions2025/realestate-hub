import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'
import RecommendModal from '../components/RecommendModal'

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
  const openRecommendOne = (p) => { setRecommendItems([p]); setRecommendOpen(true) }
  const openRecommendBulk = () => {
    const chosen = items.filter(p => selected.has(p.id))
    if (!chosen.length) return
    setRecommendItems(chosen)
    setRecommendOpen(true)
  }

  const copyContact = async (p) => {
    const lines = [
      p.name ? p.name : null,
      p.company ? p.company : null,
      p.role ? p.role : null,
      p.phone ? `Phone: ${p.phone}` : null,
      p.email ? `Email: ${p.email}` : null,
      p.website ? `Website: ${p.website}` : null,
    ].filter(Boolean).join('\n')
    try { await navigator.clipboard.writeText(lines) } catch {
      const t = document.createElement('textarea')
      t.value = lines; document.body.appendChild(t); t.select()
      document.execCommand('copy'); document.body.removeChild(t)
    }
  }

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

      {/* Desktop table */}
      <div className="table-container desktop-only-table">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{width: 30}}></th>
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
              <tr><td colSpan="10" className="empty-state">No partners yet. Add your first partner above.</td></tr>
            ) : items.map(item => (
              <tr key={item.id} className={selected.has(item.id) ? 'row-selected' : ''}>
                <td>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggleSelect(item.id)}
                    style={{accentColor: 'var(--accent)'}}
                    title="Select for bulk recommendation"
                  />
                </td>
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
                  <button
                    className="btn-sm btn-secondary"
                    title="Copy contact info"
                    onClick={async (e) => {
                      await copyContact(item)
                      const orig = e.target.textContent
                      e.target.textContent = '✓'
                      setTimeout(() => { e.target.textContent = orig }, 1200)
                    }}
                  >📋</button>
                  <button className="btn-sm btn-primary" title="Send to client" onClick={() => openRecommendOne(item)}>✉</button>
                  <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                  <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile card view */}
      <div className="mobile-only-cards">
        {items.length === 0 ? (
          <div className="empty-state-full">No partners yet. Add your first partner above.</div>
        ) : items.map(item => (
          <div key={item.id} className="data-card" onClick={() => openEdit(item)}>
            <div className="data-card-header">
              <div className="data-card-title">
                {item.preferred ? <span style={{color: '#10b981', marginRight: 4}}>&#9733;</span> : null}
                {item.name}
              </div>
              <span className="status-badge" style={{
                backgroundColor: `${relationColors[item.relationship_level] || '#6b7280'}18`,
                color: relationColors[item.relationship_level] || '#6b7280',
                borderColor: `${relationColors[item.relationship_level] || '#6b7280'}40`
              }}>{item.relationship_level}</span>
            </div>
            <div className="data-card-meta">
              <span>{item.role}</span>
              {item.company && <span>{item.company}</span>}
            </div>
            <div className="data-card-body">
              {item.phone && <div><strong>Phone:</strong> {item.phone}</div>}
              {item.email && <div><strong>Email:</strong> {item.email}</div>}
              {item.specialty && <div><strong>Specialty:</strong> {item.specialty}</div>}
              {item.referral_count > 0 && <div><strong>Referrals:</strong> {item.referral_count}</div>}
            </div>
            <div style={{display: 'flex', gap: 6, marginTop: 8}} onClick={e => e.stopPropagation()}>
              <button className="btn-sm btn-secondary" onClick={async () => {
                await copyContact(item)
                alert('✓ Contact copied to clipboard')
              }}>📋 Copy</button>
              <button className="btn-sm btn-primary" onClick={() => openRecommendOne(item)}>✉ Send</button>
            </div>
          </div>
        ))}
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

      <RecommendModal
        open={recommendOpen}
        onClose={() => setRecommendOpen(false)}
        kind="partner"
        initialItems={recommendItems}
      />
    </div>
  )
}
