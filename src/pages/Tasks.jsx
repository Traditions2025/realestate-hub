import React, { useState, useEffect } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

function parseNotes(s) {
  if (!s) return []
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [] } catch { return [] }
}

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
  const [draggingId, setDraggingId] = useState(null)
  const [dragOverStatus, setDragOverStatus] = useState(null)

  const onDragStart = (e, item) => {
    setDraggingId(item.id)
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', String(item.id)) } catch {}
  }
  const onDragEnd = () => { setDraggingId(null); setDragOverStatus(null) }
  const onDragOver = (e, status) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (dragOverStatus !== status) setDragOverStatus(status)
  }
  const onDrop = async (e, newStatus) => {
    e.preventDefault()
    setDragOverStatus(null)
    const id = draggingId || Number(e.dataTransfer.getData('text/plain'))
    setDraggingId(null)
    if (!id) return
    const item = items.find(i => i.id === id)
    if (!item || item.status === newStatus) return
    setItems(prev => prev.map(i => i.id === id ? { ...i, status: newStatus } : i))
    try {
      await api.updateTask(id, { status: newStatus })
    } catch (err) {
      alert('Failed to update status: ' + err.message)
      load()
    }
  }

  const load = () => {
    const params = {}
    if (filter.status) params.status = filter.status
    if (filter.priority) params.priority = filter.priority
    api.getTasks(params).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [filter])

  const [noteText, setNoteText] = useState('')
  const [noteBy, setNoteBy] = useState('')

  const openNew = (status) => { setEditing(null); setForm({ ...emptyTask, status: status || 'todo' }); setNoteText(''); setNoteBy(''); setModalOpen(true) }
  const openEdit = (item) => { setEditing(item.id); setForm({ ...emptyTask, ...item }); setNoteText(''); setNoteBy(''); setModalOpen(true) }

  const addNote = async () => {
    if (!editing || !noteText.trim()) return
    const r = await authFetch(`/api/tasks/${editing}/notes`, {
      method: 'POST',
      body: JSON.stringify({ text: noteText.trim(), by: noteBy || '' }),
    })
    const d = await r.json()
    if (d.error) { alert(d.error); return }
    // Update form's notes_log so the thread re-renders
    setForm(prev => ({ ...prev, notes_log: JSON.stringify(d.notes_log) }))
    setNoteText('')
    load()
  }

  const removeNote = async (idx) => {
    if (!editing) return
    if (!confirm('Delete this note?')) return
    const r = await authFetch(`/api/tasks/${editing}/notes/${idx}`, { method: 'DELETE' })
    const d = await r.json()
    if (d.error) { alert(d.error); return }
    setForm(prev => ({ ...prev, notes_log: JSON.stringify(d.notes_log) }))
  }

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
          <button
            className="btn btn-secondary"
            onClick={async () => {
              if (!confirm("Import Matt's full task list (active transactions, pre-listings, outreach, marketing)?\n\nSafe to click — won't duplicate tasks that already exist.")) return
              try {
                const r = await authFetch('/api/tasks/seed-matts-list', { method: 'POST' })
                const d = await r.json()
                alert(`✓ Imported: ${d.added} new tasks added · ${d.skipped} already existed · ${d.total} total`)
                load()
              } catch (e) { alert('Import failed: ' + e.message) }
            }}
            title="One-time import of Matt's organized task backlog"
          >
            📥 Import Matt's Task List
          </button>
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
              <div
                key={status}
                className={`kanban-column ${dragOverStatus === status ? 'drop-target' : ''}`}
                onDragOver={e => onDragOver(e, status)}
                onDragLeave={() => setDragOverStatus(s => s === status ? null : s)}
                onDrop={e => onDrop(e, status)}
              >
                <div className="kanban-header">
                  <span>{status.replace(/_/g, ' ')}</span>
                  <span className="kanban-count">{statusItems.length}</span>
                  {status !== 'done' && <button className="kanban-add" onClick={() => openNew(status)}>+</button>}
                </div>
                <div className="kanban-cards">
                  {statusItems.map(item => (
                    <div
                      key={item.id}
                      className={`kanban-card ${draggingId === item.id ? 'dragging' : ''}`}
                      draggable
                      onDragStart={e => onDragStart(e, item)}
                      onDragEnd={onDragEnd}
                      onClick={() => openEdit(item)}
                    >
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
            <label>Assigned To<select value={form.assigned_to || ''} onChange={e => f('assigned_to', e.target.value)}>
              <option value="">Unassigned</option>
              <option value="Matt">Matt</option>
              <option value="Leo">Leo</option>
            </select></label>
          </div>
          <label>Category<input value={form.category} onChange={e => f('category', e.target.value)} placeholder="TC, Marketing, Admin..." /></label>

          {editing && (() => {
            const notes = parseNotes(form.notes_log)
            return (
              <div style={{marginTop: 16, padding: '12px 14px', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 6}}>
                <h4 style={{margin: '0 0 10px', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--accent)'}}>📝 Notes ({notes.length})</h4>
                {notes.length > 0 && (
                  <div style={{maxHeight: 240, overflowY: 'auto', marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 8}}>
                    {notes.map((nt, i) => (
                      <div key={i} style={{padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 4, fontSize: 13, position: 'relative'}}>
                        <div style={{fontSize: 11, color: 'var(--text-muted)', marginBottom: 4, display: 'flex', justifyContent: 'space-between', gap: 8}}>
                          <span>
                            {nt.by ? <strong>{nt.by}</strong> : <em>—</em>}
                            {' · '}
                            {nt.at ? new Date(nt.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                          </span>
                          <button type="button" className="btn-sm btn-danger" style={{padding: '0 6px', fontSize: 10}} onClick={() => removeNote(i)} title="Delete this note">✕</button>
                        </div>
                        <div style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{nt.text}</div>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{display: 'flex', gap: 6, alignItems: 'flex-start'}}>
                  <select value={noteBy} onChange={e => setNoteBy(e.target.value)} style={{width: 110, flexShrink: 0}}>
                    <option value="">— By —</option>
                    <option value="Matt">Matt</option>
                    <option value="Leo">Leo</option>
                  </select>
                  <textarea
                    rows={2}
                    placeholder="Add a note (status update, reminder, blocker)..."
                    value={noteText}
                    onChange={e => setNoteText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addNote() } }}
                    style={{flex: 1}}
                  />
                  <button type="button" className="btn btn-sm btn-primary" disabled={!noteText.trim()} onClick={addNote}>Add</button>
                </div>
                <div style={{fontSize: 10, color: 'var(--text-muted)', marginTop: 4}}>Tip: Cmd/Ctrl + Enter to add quickly</div>
              </div>
            )
          })()}

          <div className="form-actions">
            {editing && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={async () => {
                  if (!confirm('Delete this task?')) return
                  await api.deleteTask(editing)
                  setModalOpen(false)
                  load()
                }}
              >
                Delete
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Task</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
