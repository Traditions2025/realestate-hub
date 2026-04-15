import React, { useState, useEffect } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const emptyCampaign = {
  name: '', type: 'social_media', status: 'planned', platform: '',
  budget: '', spent: '', leads_generated: '', start_date: '', end_date: '',
  target_audience: '', description: '', notes: ''
}

const typeOptions = ['social_media', 'email', 'direct_mail', 'digital_ads', 'open_house', 'print', 'video', 'blog', 'event', 'other']

export default function Marketing() {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState({ type: '', status: '' })
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyCampaign)

  const load = () => {
    const params = {}
    if (filter.type) params.type = filter.type
    if (filter.status) params.status = filter.status
    api.getMarketing(params).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [filter])

  const openNew = () => { setEditing(null); setForm(emptyCampaign); setModalOpen(true) }
  const openEdit = (item) => { setEditing(item.id); setForm({ ...emptyCampaign, ...item }); setModalOpen(true) }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form }
    ;['budget', 'spent', 'leads_generated'].forEach(k => {
      if (data[k] === '') data[k] = null
      else if (data[k]) data[k] = Number(data[k])
    })
    if (editing) await api.updateCampaign(editing, data)
    else await api.createCampaign(data)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this campaign?')) return
    await api.deleteCampaign(id)
    load()
  }

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const formatCurrency = (n) => n ? `$${Number(n).toLocaleString()}` : '—'

  // Summary stats
  const totalBudget = items.reduce((s, i) => s + (i.budget || 0), 0)
  const totalSpent = items.reduce((s, i) => s + (i.spent || 0), 0)
  const totalLeads = items.reduce((s, i) => s + (i.leads_generated || 0), 0)
  const activeCampaigns = items.filter(i => i.status === 'active').length

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Marketing</h1>
          <p className="page-subtitle">Campaign tracking and performance</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Campaign</button>
      </div>

      {/* Marketing Stats */}
      <div className="stats-grid stats-small">
        <div className="stat-card stat-blue">
          <div className="stat-number">{activeCampaigns}</div>
          <div className="stat-label">Active Campaigns</div>
        </div>
        <div className="stat-card stat-green">
          <div className="stat-number">{formatCurrency(totalBudget)}</div>
          <div className="stat-label">Total Budget</div>
        </div>
        <div className="stat-card stat-amber">
          <div className="stat-number">{formatCurrency(totalSpent)}</div>
          <div className="stat-label">Total Spent</div>
        </div>
        <div className="stat-card stat-purple">
          <div className="stat-number">{totalLeads}</div>
          <div className="stat-label">Leads Generated</div>
        </div>
      </div>

      <div className="toolbar">
        <select value={filter.type} onChange={e => setFilter(p => ({ ...p, type: e.target.value }))}>
          <option value="">All Types</option>
          {typeOptions.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </select>
        <select value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses</option>
          <option value="planned">Planned</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
        </select>
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Type</th>
              <th>Status</th>
              <th>Platform</th>
              <th>Budget</th>
              <th>Spent</th>
              <th>Leads</th>
              <th>ROI</th>
              <th>Dates</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan="10" className="empty-state">No campaigns found. Create your first one above.</td></tr>
            ) : items.map(item => {
              const roi = item.budget && item.spent ? ((item.leads_generated * 100) / item.spent).toFixed(1) : '—'
              const spentPct = item.budget ? Math.round((item.spent / item.budget) * 100) : 0
              return (
                <tr key={item.id}>
                  <td className="cell-primary" onClick={() => openEdit(item)}>
                    <div>{item.name}</div>
                    {item.description && <div className="cell-sub">{item.description.substring(0, 60)}</div>}
                  </td>
                  <td>{item.type?.replace(/_/g, ' ')}</td>
                  <td><StatusBadge status={item.status} /></td>
                  <td>{item.platform || '—'}</td>
                  <td>{formatCurrency(item.budget)}</td>
                  <td>
                    <div>{formatCurrency(item.spent)}</div>
                    {item.budget > 0 && (
                      <div className="mini-progress">
                        <div className="mini-progress-fill" style={{ width: `${Math.min(spentPct, 100)}%`, backgroundColor: spentPct > 90 ? '#ef4444' : '#3b82f6' }}></div>
                      </div>
                    )}
                  </td>
                  <td>{item.leads_generated || 0}</td>
                  <td>{roi}</td>
                  <td className="cell-sub">
                    {item.start_date && <div>Start: {item.start_date}</div>}
                    {item.end_date && <div>End: {item.end_date}</div>}
                  </td>
                  <td>
                    <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Campaign' : 'New Campaign'} wide>
        <form onSubmit={save} className="form-grid">
          <div className="form-section">
            <h4>Campaign Info</h4>
            <label>Campaign Name<input value={form.name} onChange={e => f('name', e.target.value)} required /></label>
            <div className="form-row">
              <label>Type<select value={form.type} onChange={e => f('type', e.target.value)}>
                {typeOptions.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
              </select></label>
              <label>Status<select value={form.status} onChange={e => f('status', e.target.value)}>
                <option value="planned">Planned</option><option value="active">Active</option>
                <option value="paused">Paused</option><option value="completed">Completed</option>
              </select></label>
            </div>
            <label>Platform<input value={form.platform} onChange={e => f('platform', e.target.value)} placeholder="Instagram, Facebook, Google..." /></label>
            <label>Target Audience<input value={form.target_audience} onChange={e => f('target_audience', e.target.value)} placeholder="First-time buyers, sellers 78681..." /></label>
          </div>

          <div className="form-section">
            <h4>Budget & Performance</h4>
            <div className="form-row">
              <label>Budget<input type="number" value={form.budget} onChange={e => f('budget', e.target.value)} /></label>
              <label>Spent<input type="number" value={form.spent} onChange={e => f('spent', e.target.value)} /></label>
            </div>
            <label>Leads Generated<input type="number" value={form.leads_generated} onChange={e => f('leads_generated', e.target.value)} /></label>
            <div className="form-row">
              <label>Start Date<input type="date" value={form.start_date} onChange={e => f('start_date', e.target.value)} /></label>
              <label>End Date<input type="date" value={form.end_date} onChange={e => f('end_date', e.target.value)} /></label>
            </div>
          </div>

          <div className="form-section form-full">
            <label>Description<textarea value={form.description} onChange={e => f('description', e.target.value)} rows={2} /></label>
            <label>Notes<textarea value={form.notes} onChange={e => f('notes', e.target.value)} rows={2} /></label>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Campaign</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
