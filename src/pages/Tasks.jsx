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

// Parse a date string (ISO or M/D/YYYY) into a local Date
function parseAnyDate(s) {
  if (!s) return null
  const str = String(s).trim()
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (m) return new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]))
  return null
}

// Terminal status values that mean "this milestone is done" (drop from view)
const DEADLINE_TERMINAL = {
  earnest_money_deposit:        new Set(['Completed']),
  home_inspection:              new Set(['Completed', 'N/A', 'Not Applicable']),
  appraisal_contingency_status: new Set(['Completed', 'N/A', 'Not Applicable']),
  financing_status:             new Set(['Approved']),
  financing_release:            new Set(['Completed and Sent', 'Waived', 'N/A', 'Not Applicable']),
  inspection_release:           new Set(['Completed and Sent', 'Waived', 'N/A', 'Not Applicable']),
}

// Status options per field — match the dropdowns in Transactions.jsx exactly.
const DEADLINE_STATUS_OPTIONS = {
  earnest_money_deposit:        ['Not Started', 'In Progress', 'Completed'],
  home_inspection:              ['Not Started', 'Scheduled', 'In Progress', 'Completed', 'N/A'],
  appraisal_contingency_status: ['Not Started', 'Ordered', 'Completed', 'N/A'],
  financing_status:             ['Not Started', 'In Progress', 'Approved'],
}

// Date column name (if any) for a status field — used by the date-only deadlines
// to know which underlying transaction date field to update.
const FIELD_TO_DATE_COLUMN = {
  earnest_money_deposit: 'earnest_money_due_date',
  home_inspection: 'inspection_contingency_date',
  appraisal_contingency_status: 'appraisal_contingency_date',
  financing_status: 'mortgage_contingency_date',
}

// Compute pending date-driven deadlines from one transaction
function deadlinesFromTransaction(tx) {
  const items = []
  const today = new Date()
  today.setHours(0,0,0,0)
  const push = (label, dateStr, statusField) => {
    const statusValue = statusField ? tx[statusField] : null
    if (statusField && DEADLINE_TERMINAL[statusField]?.has(statusValue)) return
    const d = parseAnyDate(dateStr)
    if (!d) return
    const daysOut = Math.round((d.getTime() - today.getTime()) / 86400000)
    items.push({
      txId: tx.id, address: tx.property_address, label,
      date: dateStr, daysOut,
      cls: daysOut < 0 ? 'overdue' : daysOut === 0 ? 'today' : daysOut <= 3 ? 'urgent' : daysOut <= 7 ? 'watch' : 'normal',
      status: statusValue,
      statusField,  // exposes the field name so the UI can render an inline dropdown
    })
  }
  // Skip mortgage / appraisal / financing for Cash deals
  const isCash = String(tx.type_of_finance || '').toLowerCase() === 'cash'
  // Listing-side transactions don't track buyer-side milestones (final walkthrough
  // is something the BUYER schedules to check the property before closing).
  const isListingOnly = tx.type === 'listing'

  push('Earnest money',         tx.earnest_money_due_date,      'earnest_money_deposit')
  push('IPI',                   tx.ipi_due_date)
  push('Inspection',            tx.inspection_contingency_date, 'home_inspection')
  push('Appraisal',             tx.appraisal_contingency_date,  'appraisal_contingency_status')
  // Mortgage contingency row carries the financing_status dropdown so the user
  // can update Not Started / In Progress / Approved inline. Approved → row drops off.
  if (!isCash) push('Mortgage / Financing',  tx.mortgage_contingency_date, 'financing_status')
  if (!isListingOnly) push('Final walkthrough', tx.final_walkthrough)
  push('Closing',               tx.closing_date)
  return items
}

const CLS_COLOR = {
  overdue: '#dc2626', today: '#dc2626', urgent: '#ea580c',
  watch: '#ca8a04', normal: '#6b7280',
}
const CLS_LABEL = {
  overdue: 'OVERDUE', today: 'TODAY', urgent: 'URGENT', watch: 'WATCH', normal: '',
}
const CLS_RANK = { overdue: 0, today: 1, urgent: 2, watch: 3, normal: 4 }

export default function Tasks() {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState({ status: '', priority: '' })
  const [assigneeFilter, setAssigneeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyTask)
  const [view, setView] = useState('board') // board or list
  const [draggingId, setDraggingId] = useState(null)
  const [dragOverStatus, setDragOverStatus] = useState(null)
  const [txDeadlines, setTxDeadlines] = useState([])

  const refreshDeadlines = () => {
    const ACTIVE = new Set(['Active', 'Under Contract', 'Pending', 'Clear to Close'])
    return authFetch('/api/transactions')
      .then(r => r.json())
      .then(rows => {
        const txs = (Array.isArray(rows) ? rows : []).filter(t => ACTIVE.has(t.property_status))
        const all = []
        for (const tx of txs) all.push(...deadlinesFromTransaction(tx))
        // Strict chronological order: most-overdue first, then today, then future.
        all.sort((a, b) => (a.daysOut ?? 9999) - (b.daysOut ?? 9999))
        setTxDeadlines(all)
      })
      .catch(() => setTxDeadlines([]))
  }
  useEffect(() => { refreshDeadlines() }, [])

  // Modal state for editing a deadline (status + date) without leaving Tasks
  const [deadlineEditing, setDeadlineEditing] = useState(null)
  const [deadlineForm, setDeadlineForm] = useState({ date: '', status: '' })
  const [deadlineSaving, setDeadlineSaving] = useState(false)

  const openDeadlineEditor = (it) => {
    // Normalize date to YYYY-MM-DD for the <input type="date">
    let d = it.date || ''
    const m = String(d).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (m) d = `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`
    setDeadlineForm({ date: d, status: it.status || '' })
    setDeadlineEditing(it)
  }

  const saveDeadlineEdit = async () => {
    if (!deadlineEditing || deadlineSaving) return
    setDeadlineSaving(true)
    try {
      const it = deadlineEditing
      const payload = {}
      // Date column: prefer the explicit FIELD_TO_DATE_COLUMN mapping for status
      // fields; otherwise use the date column the deadline was sourced from.
      const dateCol =
        it.statusField ? FIELD_TO_DATE_COLUMN[it.statusField] :
        it.label === 'Closing' ? 'closing_date' :
        it.label === 'Final walkthrough' ? 'final_walkthrough' :
        it.label === 'IPI' ? 'ipi_due_date' :
        null
      if (dateCol && deadlineForm.date !== '') payload[dateCol] = deadlineForm.date
      if (it.statusField && deadlineForm.status) payload[it.statusField] = deadlineForm.status
      if (Object.keys(payload).length === 0) { setDeadlineEditing(null); return }
      await authFetch(`/api/transactions/${it.txId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      await refreshDeadlines()
      setDeadlineEditing(null)
    } catch (err) {
      alert('Failed to save: ' + err.message)
    } finally {
      setDeadlineSaving(false)
    }
  }

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
  const [saving, setSaving] = useState(false)
  // Nudge state
  const [nudgeOpen, setNudgeOpen] = useState(false)
  const [nudgeTask, setNudgeTask] = useState(null)
  const [nudgeRecipient, setNudgeRecipient] = useState('')
  const [nudgeMessage, setNudgeMessage] = useState('')
  const [nudgeSender, setNudgeSender] = useState('')
  const [nudgeSending, setNudgeSending] = useState(false)

  const openNudge = (task) => {
    setNudgeTask(task)
    setNudgeRecipient(task?.assigned_to ? task.assigned_to.toLowerCase() : 'matt')
    setNudgeMessage('')
    setNudgeSender('Leo')
    setNudgeOpen(true)
  }
  const sendNudge = async () => {
    if (!nudgeTask) return
    setNudgeSending(true)
    try {
      const r = await authFetch(`/api/tasks/${nudgeTask.id}/nudge`, {
        method: 'POST',
        body: JSON.stringify({
          recipient: nudgeRecipient,
          message: nudgeMessage,
          sender: nudgeSender,
        }),
      })
      const d = await r.json()
      if (d.error) { alert('Nudge failed: ' + d.error); return }
      alert(`✓ Nudged ${nudgeRecipient} (${d.sent_to})`)
      setNudgeOpen(false)
      load()
    } catch (e) {
      alert('Nudge failed: ' + e.message)
    } finally {
      setNudgeSending(false)
    }
  }

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
    if (saving) return // guard against double-clicks during the network roundtrip
    setSaving(true)
    try {
      if (editing) await api.updateTask(editing, form)
      else await api.createTask(form)
      setModalOpen(false)
      load()
    } catch (err) {
      alert('Save failed: ' + err.message)
    } finally {
      setSaving(false)
    }
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
        <input
          type="text"
          className="search-input"
          placeholder="Search tasks (title, description, notes, assigned)..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{flex: 1, minWidth: 240}}
        />
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
        <select value={assigneeFilter} onChange={e => setAssigneeFilter(e.target.value)}>
          <option value="">All Assignees</option>
          <option value="Matt">Matt</option>
          <option value="Leo">Leo</option>
          <option value="__unassigned__">Unassigned</option>
        </select>
        {search && (
          <button className="btn btn-sm btn-secondary" onClick={() => setSearch('')}>Clear</button>
        )}
      </div>

      {view === 'board' ? (
        <div className="kanban">
          {['todo', 'in_progress', 'done'].map(status => {
            const q = search.trim().toLowerCase()
            const matchesSearch = (it) => {
              if (!q) return true
              const hay = [
                it.title,
                it.description,
                it.assigned_to,
                it.related_type,
                it.notes_log,
              ].filter(Boolean).join(' ').toLowerCase()
              return hay.includes(q)
            }
            const matchesAssignee = (it) => {
              if (!assigneeFilter) return true
              if (assigneeFilter === '__unassigned__') return !it.assigned_to
              return (it.assigned_to || '').toLowerCase() === assigneeFilter.toLowerCase()
            }
            let statusItems = items.filter(i => i.status === status && matchesSearch(i) && matchesAssignee(i))
            // Done column: sort by completion timestamp, newest first
            if (status === 'done') {
              statusItems = [...statusItems].sort((a, b) => {
                const ta = a.completed_at || a.updated_at || ''
                const tb = b.completed_at || b.updated_at || ''
                return tb.localeCompare(ta)
              })
            }
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
                        {item.due_date && item.status !== 'done' && (
                          <span className={`task-due ${item.due_date < today ? 'overdue' : ''}`}>
                            {item.due_date}
                          </span>
                        )}
                      </div>
                      {item.status === 'done' && item.completed_at && (
                        <div style={{marginTop: 6, fontSize: 11, color: '#10b981', display: 'flex', alignItems: 'center', gap: 4}} title={new Date(item.completed_at).toLocaleString()}>
                          ✓ Completed {new Date(item.completed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })}
                        </div>
                      )}
                      {item.status !== 'done' && (
                        <div style={{marginTop: 6, display: 'flex', gap: 4}} onClick={e => e.stopPropagation()}>
                          <button
                            type="button"
                            className="btn-sm btn-secondary"
                            style={{fontSize: 11, padding: '2px 8px'}}
                            onClick={(e) => { e.stopPropagation(); openNudge(item) }}
                            title="Send a quick email reminder to Matt or Leo about this task"
                          >👋 Nudge</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}

          {/* 4th column: TRANSACTION DEADLINES (read-only, not a drop target) */}
          <div className="kanban-column kanban-column-readonly">
            <div className="kanban-header">
              <span>deadlines</span>
              <span className="kanban-count">{txDeadlines.length}</span>
            </div>
            <div className="kanban-cards">
              {txDeadlines.length === 0 ? (
                <div style={{padding: '20px 12px', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center'}}>
                  No upcoming deadlines on active transactions.
                </div>
              ) : txDeadlines.map((it, idx) => {
                const c = CLS_COLOR[it.cls]
                const tag = CLS_LABEL[it.cls]
                const dateStr = (() => {
                  const d = parseAnyDate(it.date)
                  return d ? d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : it.date
                })()
                const daysOut = it.daysOut == null ? '' :
                  it.daysOut === 0 ? 'today' :
                  it.daysOut < 0 ? `${Math.abs(it.daysOut)}d ago` :
                  `in ${it.daysOut}d`
                return (
                  <div
                    key={`dl-${it.txId}-${idx}`}
                    className="kanban-card kanban-card-deadline"
                    style={{borderLeft: `4px solid ${c}`, cursor: 'pointer'}}
                    onClick={() => openDeadlineEditor(it)}
                    title="Click to update date or status without leaving Tasks"
                  >
                    <div className="kanban-card-top">
                      {tag ? (
                        <span style={{
                          fontSize: 10, fontWeight: 700, color: c, letterSpacing: 0.4,
                        }}>{tag}</span>
                      ) : (
                        <span style={{fontSize: 10, color: 'var(--text-muted)'}}>UPCOMING</span>
                      )}
                    </div>
                    <div className="kanban-card-title">{it.label}</div>
                    <div className="kanban-card-desc" style={{color: 'var(--text-muted)'}}>
                      {it.address}
                    </div>
                    <div className="kanban-card-footer">
                      <span style={{color: c, fontWeight: 600}}>{dateStr}</span>
                      <span style={{color: 'var(--text-muted)', fontSize: 11}}>{daysOut}</span>
                    </div>
                    {it.status && (
                      <div style={{fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', marginTop: 4}}>{it.status}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
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
                <th>Completed</th>
                <th>Category</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const q = search.trim().toLowerCase()
                const matchesAssignee = (it) => {
                  if (!assigneeFilter) return true
                  if (assigneeFilter === '__unassigned__') return !it.assigned_to
                  return (it.assigned_to || '').toLowerCase() === assigneeFilter.toLowerCase()
                }
                const filtered = items.filter(it => {
                  if (!matchesAssignee(it)) return false
                  if (!q) return true
                  const hay = [it.title, it.description, it.assigned_to, it.related_type, it.notes_log]
                    .filter(Boolean).join(' ').toLowerCase()
                  return hay.includes(q)
                })
                if (filtered.length === 0) {
                  return <tr><td colSpan="9" className="empty-state">No tasks found</td></tr>
                }
                return filtered.map(item => (
                <tr key={item.id} className={item.status === 'done' ? 'row-done' : ''}>
                  <td><input type="checkbox" checked={item.status === 'done'} onChange={() => toggleDone(item)} /></td>
                  <td className="cell-primary" onClick={() => openEdit(item)}>{item.title}</td>
                  <td><StatusBadge status={item.priority} /></td>
                  <td><StatusBadge status={item.status} /></td>
                  <td>{item.assigned_to || '—'}</td>
                  <td className={item.due_date && item.due_date < today && item.status !== 'done' ? 'overdue' : ''}>{item.due_date || '—'}</td>
                  <td style={{color: item.completed_at ? '#10b981' : 'var(--text-muted)', fontSize: 12}} title={item.completed_at ? new Date(item.completed_at).toLocaleString() : ''}>
                    {item.completed_at
                      ? new Date(item.completed_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' })
                      : '—'}
                  </td>
                  <td>{item.category || '—'}</td>
                  <td>
                    {item.status !== 'done' && (
                      <button className="btn-sm" onClick={() => openNudge(item)} title="Email Matt/Leo about this task">👋</button>
                    )}
                    <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                  </td>
                </tr>
                ))
              })()}
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
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)} disabled={saving}>Cancel</button>
            {editing && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  const cur = items.find(i => i.id === editing) || { ...form, id: editing }
                  openNudge(cur)
                }}
                title="Send a quick email reminder to Matt or Leo about this task"
              >👋 Nudge</button>
            )}
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? (editing ? 'Saving...' : 'Creating...') : (editing ? 'Update Task' : 'Create Task')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Nudge Modal */}
      <Modal open={nudgeOpen} onClose={() => setNudgeOpen(false)} title={`👋 Nudge — ${nudgeTask?.title || ''}`}>
        <p className="muted" style={{margin: '0 0 12px'}}>
          Sends a quick reminder email about this task. The full task details are auto-included.
        </p>
        <div className="form-row">
          <label>To
            <select value={nudgeRecipient} onChange={e => setNudgeRecipient(e.target.value)}>
              <option value="matt">Matt (mattsmithremax@gmail.com)</option>
              <option value="leo">Leo / John (johnwithmattsmithteam@gmail.com)</option>
            </select>
          </label>
          <label>From
            <select value={nudgeSender} onChange={e => setNudgeSender(e.target.value)}>
              <option value="Leo">Leo</option>
              <option value="Matt">Matt</option>
              <option value="the team">the team</option>
            </select>
          </label>
        </div>
        <label>Optional message
          <textarea
            rows={3}
            placeholder="e.g. Can you handle this today? Closing on Friday and we need it done."
            value={nudgeMessage}
            onChange={e => setNudgeMessage(e.target.value)}
          />
        </label>
        {nudgeTask && (
          <div className="muted" style={{padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, fontSize: 12, marginTop: 8}}>
            <strong>Task preview:</strong><br/>
            {nudgeTask.title}<br/>
            Status: {(nudgeTask.status || '').replace(/_/g, ' ')} · Priority: {nudgeTask.priority}
            {nudgeTask.due_date && <> · Due: {nudgeTask.due_date}</>}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setNudgeOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={sendNudge} disabled={nudgeSending}>
            {nudgeSending ? 'Sending...' : 'Send Nudge'}
          </button>
        </div>
      </Modal>

      {/* Deadline Edit Modal — click a deadline card → inline edit date + status */}
      <Modal
        open={!!deadlineEditing}
        onClose={() => setDeadlineEditing(null)}
        title={deadlineEditing ? `Update: ${deadlineEditing.label}` : ''}
      >
        {deadlineEditing && (() => {
          const it = deadlineEditing
          const opts = it.statusField ? DEADLINE_STATUS_OPTIONS[it.statusField] : null
          const dateCol =
            it.statusField ? FIELD_TO_DATE_COLUMN[it.statusField] :
            it.label === 'Closing' ? 'closing_date' :
            it.label === 'Final walkthrough' ? 'final_walkthrough' :
            it.label === 'IPI' ? 'ipi_due_date' :
            null
          return (
            <div>
              <div style={{fontSize: 13, color: 'var(--text-muted)', marginBottom: 14}}>
                <strong style={{color: 'var(--text-primary)'}}>{it.address}</strong>
              </div>

              {dateCol && (
                <label style={{display: 'block', marginBottom: 12}}>
                  Date
                  <input
                    type="date"
                    value={deadlineForm.date}
                    onChange={e => setDeadlineForm(p => ({ ...p, date: e.target.value }))}
                    style={{width: '100%', marginTop: 4}}
                  />
                </label>
              )}

              {opts && (
                <label style={{display: 'block', marginBottom: 12}}>
                  Status
                  <select
                    value={deadlineForm.status || opts[0]}
                    onChange={e => setDeadlineForm(p => ({ ...p, status: e.target.value }))}
                    style={{width: '100%', marginTop: 4}}
                  >
                    {opts.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </label>
              )}

              {!dateCol && !opts && (
                <p className="muted">Nothing to edit on this deadline type. Open the full transaction for more options.</p>
              )}

              <div className="form-actions">
                <a
                  href="/transactions"
                  className="btn btn-secondary btn-sm"
                  style={{marginRight: 'auto', textDecoration: 'none'}}
                >
                  Open Full Transaction →
                </a>
                <button type="button" className="btn btn-secondary" onClick={() => setDeadlineEditing(null)}>Cancel</button>
                <button type="button" className="btn btn-primary" onClick={saveDeadlineEdit} disabled={deadlineSaving}>
                  {deadlineSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          )
        })()}
      </Modal>
    </div>
  )
}
