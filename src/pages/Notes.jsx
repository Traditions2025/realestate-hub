import React, { useState, useEffect } from 'react'
import { api } from '../api'
import Modal from '../components/Modal'

const colors = [
  { name: 'default', bg: '#1e293b', border: '#334155' },
  { name: 'blue', bg: '#1e3a5f', border: '#2563eb' },
  { name: 'green', bg: '#14532d', border: '#16a34a' },
  { name: 'yellow', bg: '#422006', border: '#ca8a04' },
  { name: 'red', bg: '#450a0a', border: '#dc2626' },
  { name: 'purple', bg: '#3b0764', border: '#9333ea' },
]

export default function Notes() {
  const [items, setItems] = useState([])
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState({ title: '', content: '', color: 'default', pinned: 0, tags: '' })

  const load = () => {
    const params = {}
    if (search) params.search = search
    api.getNotes(params).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [search])

  const openNew = () => {
    setEditing(null)
    setForm({ title: '', content: '', color: 'default', pinned: 0, tags: '' })
    setModalOpen(true)
  }
  const openEdit = (item) => {
    setEditing(item.id)
    setForm({ title: item.title, content: item.content || '', color: item.color || 'default', pinned: item.pinned || 0, tags: item.tags || '' })
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    if (editing) await api.updateNote(editing, form)
    else await api.createNote(form)
    setModalOpen(false)
    load()
  }

  const togglePin = async (item) => {
    await api.updateNote(item.id, { pinned: item.pinned ? 0 : 1 })
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this note?')) return
    await api.deleteNote(id)
    load()
  }

  const f = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const getColor = (name) => colors.find(c => c.name === name) || colors[0]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Notes</h1>
          <p className="page-subtitle">Quick notes, meeting notes, ideas</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Note</button>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search notes..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
      </div>

      <div className="notes-grid">
        {items.length === 0 ? (
          <div className="empty-state-full">No notes yet. Create your first one above.</div>
        ) : items.map(item => {
          const color = getColor(item.color)
          return (
            <div
              key={item.id}
              className={`note-card ${item.pinned ? 'pinned' : ''}`}
              style={{ backgroundColor: color.bg, borderColor: color.border }}
              onClick={() => openEdit(item)}
            >
              <div className="note-card-header">
                <h4>{item.title}</h4>
                <button className={`pin-btn ${item.pinned ? 'pinned' : ''}`} onClick={e => { e.stopPropagation(); togglePin(item) }}>
                  {item.pinned ? '\u25C6' : '\u25C7'}
                </button>
              </div>
              <div className="note-card-content">{item.content}</div>
              {item.tags && (
                <div className="note-tags">
                  {item.tags.split(',').map(t => <span key={t} className="note-tag">{t.trim()}</span>)}
                </div>
              )}
              <div className="note-card-footer">
                <span className="note-date">{new Date(item.updated_at).toLocaleDateString()}</span>
                <button className="btn-sm btn-danger" onClick={e => { e.stopPropagation(); remove(item.id) }}>Del</button>
              </div>
            </div>
          )
        })}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Note' : 'New Note'}>
        <form onSubmit={save}>
          <label>Title<input value={form.title} onChange={e => f('title', e.target.value)} required /></label>
          <label>Content<textarea value={form.content} onChange={e => f('content', e.target.value)} rows={8} /></label>
          <label>Tags (comma separated)<input value={form.tags} onChange={e => f('tags', e.target.value)} placeholder="meeting, listing, idea..." /></label>
          <div className="color-picker">
            <span>Color:</span>
            {colors.map(c => (
              <button
                key={c.name}
                type="button"
                className={`color-dot ${form.color === c.name ? 'selected' : ''}`}
                style={{ backgroundColor: c.border }}
                onClick={() => f('color', c.name)}
              />
            ))}
          </div>
          <label className="checkbox-label">
            <input type="checkbox" checked={form.pinned} onChange={e => f('pinned', e.target.checked ? 1 : 0)} />
            Pin to top
          </label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Note</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
