import React, { useState, useEffect } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const emptyProject = {
  name: '', description: '', status: 'active', category: 'other',
  priority: 'medium', due_date: '', owner: '', progress: 0
}

const categories = ['marketing', 'operations', 'technology', 'training', 'events', 'other']

export default function Projects() {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState({ status: '', category: '' })
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyProject)

  const load = () => {
    const params = {}
    if (filter.status) params.status = filter.status
    if (filter.category) params.category = filter.category
    api.getProjects(params).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [filter])

  const openNew = () => { setEditing(null); setForm(emptyProject); setModalOpen(true) }
  const openEdit = (item) => { setEditing(item.id); setForm({ ...emptyProject, ...item }); setModalOpen(true) }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form, progress: Number(form.progress) }
    if (editing) await api.updateProject(editing, data)
    else await api.createProject(data)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this project?')) return
    await api.deleteProject(id)
    load()
  }

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p className="page-subtitle">Track team initiatives and campaigns</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Project</button>
      </div>

      <div className="toolbar">
        <select value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses</option>
          <option value="planning">Planning</option>
          <option value="active">Active</option>
          <option value="on_hold">On Hold</option>
          <option value="completed">Completed</option>
        </select>
        <select value={filter.category} onChange={e => setFilter(p => ({ ...p, category: e.target.value }))}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      <div className="project-grid">
        {items.length === 0 ? (
          <div className="empty-state-full">No projects found. Start one above.</div>
        ) : items.map(item => (
          <div key={item.id} className="project-card" onClick={() => openEdit(item)}>
            <div className="project-card-header">
              <div className="project-card-title">{item.name}</div>
              <StatusBadge status={item.priority} />
            </div>
            {item.description && <div className="project-card-desc">{item.description}</div>}
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${item.progress}%` }}></div>
              <span className="progress-label">{item.progress}%</span>
            </div>
            <div className="project-card-meta">
              <StatusBadge status={item.status} />
              <span className="project-category">{item.category}</span>
              {item.owner && <span className="project-owner">{item.owner}</span>}
            </div>
            {item.due_date && <div className="project-card-due">Due: {item.due_date}</div>}
            {item.task_counts?.length > 0 && (
              <div className="project-tasks">
                {item.task_counts.map(tc => (
                  <span key={tc.status} className="project-task-count">
                    {tc.count} {tc.status.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            )}
            <div className="project-card-actions" onClick={e => e.stopPropagation()}>
              <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Project' : 'New Project'}>
        <form onSubmit={save}>
          <label>Name<input value={form.name} onChange={e => f('name', e.target.value)} required /></label>
          <label>Description<textarea value={form.description} onChange={e => f('description', e.target.value)} rows={3} /></label>
          <div className="form-row">
            <label>Status<select value={form.status} onChange={e => f('status', e.target.value)}>
              <option value="planning">Planning</option><option value="active">Active</option>
              <option value="on_hold">On Hold</option><option value="completed">Completed</option>
            </select></label>
            <label>Category<select value={form.category} onChange={e => f('category', e.target.value)}>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select></label>
          </div>
          <div className="form-row">
            <label>Priority<select value={form.priority} onChange={e => f('priority', e.target.value)}>
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select></label>
            <label>Owner<input value={form.owner} onChange={e => f('owner', e.target.value)} /></label>
          </div>
          <label>Due Date<input type="date" value={form.due_date} onChange={e => f('due_date', e.target.value)} /></label>
          <label>Progress ({form.progress}%)
            <input type="range" min="0" max="100" value={form.progress} onChange={e => f('progress', e.target.value)} />
          </label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Project</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
