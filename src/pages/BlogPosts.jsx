import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const statusOptions = ['posted', 'scheduled', 'draft', 'planned']
const statusColors = { posted: '#10b981', scheduled: '#3b82f6', draft: '#6b7280', planned: '#f59e0b' }

const emptyPost = {
  title: '', slug: '', category: '', status: 'draft', post_date: '', post_time: '',
  live_url: '', tags: '', cover_url: '', meta_title: '', meta_description: '', author: 'Matt Smith', notes: ''
}

export default function BlogPosts() {
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState([])
  const [filter, setFilter] = useState({ category: '', status: '' })
  const [view, setView] = useState('list')
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyPost)

  const load = () => {
    const params = new URLSearchParams()
    if (filter.category) params.set('category', filter.category)
    if (filter.status) params.set('status', filter.status)
    if (view === 'calendar') params.set('month', currentMonth)
    authFetch('/api/blog-posts?' + params).then(r => r.json()).then(d => setItems(Array.isArray(d) ? d : []))
  }
  const loadCategories = () => authFetch('/api/blog-posts/categories').then(r => r.json()).then(d => setCategories(Array.isArray(d) ? d : [])).catch(() => {})

  useEffect(() => { load(); loadCategories() }, [])
  useEffect(() => { load() }, [filter, currentMonth, view])

  const openNew = (date) => { setEditing(null); setForm({ ...emptyPost, post_date: date || '' }); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyPost }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }
  const save = async (e) => {
    e.preventDefault()
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }
    await authFetch(editing ? `/api/blog-posts/${editing}` : '/api/blog-posts', opts)
    setModalOpen(false); load(); loadCategories()
  }
  const remove = async (id) => {
    if (!confirm('Delete this blog post entry?')) return
    await authFetch(`/api/blog-posts/${id}`, { method: 'DELETE' }); load()
  }
  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  // Calendar helpers
  const [year, month] = currentMonth.split('-').map(Number)
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay = new Date(year, month - 1, 1).getDay()
  const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' })
  const prevMonth = () => { const d = new Date(year, month - 2); setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`) }
  const nextMonth = () => { const d = new Date(year, month); setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`) }

  const counts = statusOptions.reduce((a, s) => { a[s] = items.filter(i => i.status === s).length; return a }, {})

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Blog Post Calendar</h1>
          <p className="page-subtitle">Track posted, scheduled &amp; planned blog posts for mattsmithteam.com</p>
        </div>
        <div className="header-actions">
          <div className="view-toggle">
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
            <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
          </div>
          <button className="btn btn-primary" onClick={() => openNew()}>+ New Post</button>
        </div>
      </div>

      <div className="toolbar">
        <select value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses ({items.length})</option>
          {statusOptions.map(s => <option key={s} value={s}>{s} ({counts[s]})</option>)}
        </select>
        <select value={filter.category} onChange={e => setFilter(p => ({ ...p, category: e.target.value }))}>
          <option value="">All Categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {view === 'calendar' ? (
        <div className="cal-container">
          <div className="cal-nav">
            <button onClick={prevMonth} className="btn btn-secondary">&lt;</button>
            <h3>{monthName}</h3>
            <button onClick={nextMonth} className="btn btn-secondary">&gt;</button>
          </div>
          <div className="cal-grid">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="cal-header-cell">{d}</div>)}
            {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} className="cal-cell empty"></div>)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1
              const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`
              const dayPosts = items.filter(p => (p.post_date || '').slice(0, 10) === dateStr)
              const isToday = dateStr === new Date().toISOString().split('T')[0]
              return (
                <div key={day} className={`cal-cell ${isToday ? 'today' : ''}`} onClick={() => openNew(dateStr)}>
                  <div className="cal-day">{day}</div>
                  <div className="cal-posts">
                    {dayPosts.map(p => (
                      <div key={p.id} className="cal-post" style={{ borderLeftColor: statusColors[p.status] || '#6b7280' }}
                        onClick={e => { e.stopPropagation(); openEdit(p) }}>
                        <span className="cal-post-platform" style={{ color: statusColors[p.status] }}>{p.status}</span>
                        <span className="cal-post-title">{p.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr><th>Title</th><th>Category</th><th>Date</th><th>Status</th><th>Link</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan="6" className="empty-state">No blog posts yet</td></tr>
              ) : items.map(item => (
                <tr key={item.id}>
                  <td className="cell-primary" onClick={() => openEdit(item)} style={{ maxWidth: 420 }}>{item.title}</td>
                  <td>{item.category || '—'}</td>
                  <td>{item.post_date || '—'}{item.post_time ? ` ${item.post_time}` : ''}</td>
                  <td><span style={{ color: statusColors[item.status], fontWeight: 600, textTransform: 'capitalize' }}>{item.status}</span></td>
                  <td>{item.live_url
                    ? <a href={item.live_url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}>View post ↗</a>
                    : '—'}</td>
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

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Blog Post' : 'New Blog Post'} wide>
        <form onSubmit={save}>
          <label>Title<input value={form.title} onChange={e => f2('title', e.target.value)} required /></label>
          <div className="form-row">
            <label>Category<input value={form.category} onChange={e => f2('category', e.target.value)} placeholder="e.g. Cedar Rapids Real Estate" list="blog-cats" />
              <datalist id="blog-cats">{categories.map(c => <option key={c} value={c} />)}</datalist>
            </label>
            <label>Status<select value={form.status} onChange={e => f2('status', e.target.value)}>
              {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select></label>
          </div>
          <div className="form-row">
            <label>Post Date<input type="date" value={form.post_date} onChange={e => f2('post_date', e.target.value)} /></label>
            <label>Post Time<input value={form.post_time} onChange={e => f2('post_time', e.target.value)} placeholder="e.g. 6:00 AM" /></label>
          </div>
          <label>Live URL (direct link)
            <input value={form.live_url} onChange={e => f2('live_url', e.target.value)} placeholder="https://www.mattsmithteam.com/blog/..." />
          </label>
          {form.live_url && (
            <div style={{ margin: '4px 0 10px' }}>
              <a href={form.live_url} target="_blank" rel="noreferrer" className="btn btn-secondary">Open live post ↗</a>
            </div>
          )}
          <label>Slug<input value={form.slug} onChange={e => f2('slug', e.target.value)} placeholder="url-slug" /></label>
          <label>Tags<input value={form.tags} onChange={e => f2('tags', e.target.value)} placeholder="Cedar Rapids, Home Buying, ..." /></label>
          <label>Meta Title<input value={form.meta_title} onChange={e => f2('meta_title', e.target.value)} /></label>
          <label>Meta Description<textarea value={form.meta_description} onChange={e => f2('meta_description', e.target.value)} rows={2} /></label>
          <label>Cover Image URL<input value={form.cover_url} onChange={e => f2('cover_url', e.target.value)} /></label>
          <label>Notes<textarea value={form.notes} onChange={e => f2('notes', e.target.value)} rows={2} /></label>
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'} Post</button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
