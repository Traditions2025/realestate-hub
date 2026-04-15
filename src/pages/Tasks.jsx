import React, { useState, useEffect } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const emptyTask = {
  title: '', description: '', priority: 'medium', status: 'todo',
  due_date: '', assigned_to: '', category: ''
}

export default function Tasks() {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState({ status: '', priority: '' })
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyTask)
  const [view, setView] = useState('board') // board or list

  const load = () => {
    const params = {}
    if (filter.status) params.status = filter.status
    if (filter.priority) params.priority = filter.priority
    api.getTasks(params).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [filter])

  const openNew = (status) => { setEditing(null); setForm({ ...emptyTask, status: status || 'todo' }); setModalOpen(true) }
  const openEdit = (item) => { setEditing(item.id); setForm({ ...emptyTask, ...item }); setModalOpen(true) }

  const save = async (e) => {
    e.preventDefault()
    if (editing) await api.updateTask(editing, form)
    else await api.createTask(form)
    setModalOpen(false)
    load()
  }

  const toggleDone = async (item) => {
    const newStatus = item.status === 'done' ? 'todo' : 'done'
    await api.updateTask(item.id, { status: newStatus })
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this task?')) return
    await api.deleteTask(id)
    load()
  }

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Tasks</h1>
          <p className="page-subtitle">Track what needs to get done</p>
        </div>
        <div className="header-actions">
          <div className="view-toggle">
            <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>Board</button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
          </div>
          <button className="btn btn-primary" onClick={() => openNew()}>+ New Task</button>
        </div>
      </div>

      <div className="toolbar">
        <select value={filter.priority} onChange={e => setFilter(p => ({ ...p, priority: e.target.value }))}>
          <option value="">All Priorities</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
        <select value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses</option>
          <option value="todo">To Do</option>
          <option value="in_progress">In Progress</option>
          <option value="done">Done</option>
        </select>
      </div>

      {view === 'board' ? (
        <div className="kanban">
          {['todo', 'in_progress', 'done'].map(status => {
            const statusItems = items.filter(i => i.status === status)
            return (
              <div key={status} className="kanban-column">
                <div className="kanban-header">
                  <span>{status.replace(/_/g, ' ')}</span>
                  <span className="kanban-count">{statusItems.length}</span>
                  {status !== 'done' && <button className="kanban-add" onClick={() => openNew(status)}>+</button>}
                </div>
                <div className="kanban-cards">
                  {statusItems.map(item => (
                    <div key={item.id} className="kanban-card" onClick={() => openEdit(item)}>
                      <div className="kanban-card-top">
                        <StatusBadge status={item.priority} />
                        {item.category && <span className="task-category">{item.category}</span>}
                      </div>
                      <div className="kanban-card-title">{item.title}</div>
                      {item.description && <div className="kanban-card-desc">{item.description}</div>}
                      <div className="kanban-card-footer">
                        {item.assigned_to && <span className="task-assigned">{item.assigned_to}</span>}
                        {item.due_date && (
                          <span className={`task-due ${item.due_date < today && item.status !== 'done' ? 'overdue' : ''}`}>
                            {item.due_date}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{width: 40}}></th>
                <th>Task</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Assigned</th>
                <th>Due Date</th>
                <th>Category</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan="8" className="empty-state">No tasks found</td></tr>
              ) : items.map(item => (
                <tr key={item.id} className={item.status === 'done' ? 'row-done' : ''}>
                  <td><input type="checkbox" checked={item.status === 'done'} onChange={() => toggleDone(item)} /></td>
                  <td className="cell-primary" onClick={() => openEdit(item)}>{item.title}</td>
                  <td><StatusBadge status={item.priority} /></td>
                  <td><StatusBadge status={item.status} /></td>
                  <td>{item.assigned_to || '—'}</td>
                  <td className={item.due_date && item.due_date < today && item.status !== 'done' ? 'overdue' : ''}>{item.due_date || '—'}</td>
                  <td>{item.category || '—'}</td>
                  <td>
                    <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Task' : 'New Task'}>
        <form onSubmit={save}>
          <label>Title<input value={form.title} onChange={e => f('title', e.target.value)} required /></label>
          <label>Description<textarea value={form.description} onChange={e => f('description', e.target.value)} rows={3} /></label>
          <div className="form-row">
            <label>Priority<select value={form.priority} onChange={e => f('priority', e.target.value)}>
              <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
            </select></label>
            <label>Status<select value={form.status} onChange={e => f('status', e.target.value)}>
              <option value="todo">To Do</option><option value="in_progress">In Progress</option><option value="done">Done</option>
            </select></label>
          </div>
          <div className="form-row">
            <label>Due Date<input type="date" value={form.due_date} onChange={e => f('due_date', e.target.value)} /></label>
            <label>Assigned To<input value={form.assigned_to} onChange={e => f('assigned_to', e.target.value)} /></label>
          </div>
          <label>Category<input value={form.category} onChange={e => f('category', e.target.value)} placeholder="TC, Marketing, Admin..." /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Task</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
