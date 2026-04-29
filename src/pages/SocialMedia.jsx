import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const platforms = ['Instagram', 'Facebook', 'TikTok', 'YouTube', 'LinkedIn', 'Twitter/X', 'Google Business']
const postTypes = ['Listing Post', 'Just Sold', 'Market Update', 'Tips & Education', 'Team/Personal', 'Testimonial', 'Open House', 'Coming Soon', 'Blog Share', 'Reel/Video', 'Carousel', 'Story', 'Other']
const statusOptions = ['draft', 'scheduled', 'posted', 'cancelled']

const emptyPost = {
  title: '', platform: 'Instagram', post_type: 'Listing Post', content: '', media_url: '',
  scheduled_date: '', scheduled_time: '', status: 'draft', hashtags: '',
  engagement_likes: 0, engagement_comments: 0, engagement_shares: 0, notes: ''
}

export default function SocialMedia() {
  const [items, setItems] = useState([])
  const [filter, setFilter] = useState({ platform: '', status: '' })
  const [view, setView] = useState('calendar')
  const [currentMonth, setCurrentMonth] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyPost)

  const load = () => {
    const params = new URLSearchParams()
    if (filter.platform) params.set('platform', filter.platform)
    if (filter.status) params.set('status', filter.status)
    if (view === 'calendar') params.set('month', currentMonth)
    authFetch('/api/social-media?' + params).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [filter, currentMonth, view])

  const openNew = (date) => { setEditing(null); setForm({ ...emptyPost, scheduled_date: date || '' }); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyPost }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const data = { ...form, engagement_likes: Number(form.engagement_likes), engagement_comments: Number(form.engagement_comments), engagement_shares: Number(form.engagement_shares) }
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
    await authFetch(editing ? `/api/social-media/${editing}` : '/api/social-media', opts)
    setModalOpen(false)
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this post?')) return
    await authFetch(`/api/social-media/${id}`, { method: 'DELETE' })
    load()
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  // Calendar helpers
  const [year, month] = currentMonth.split('-').map(Number)
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay = new Date(year, month - 1, 1).getDay()
  const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' })

  const prevMonth = () => {
    const d = new Date(year, month - 2)
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  const nextMonth = () => {
    const d = new Date(year, month)
    setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }

  const platformColors = {
    'Instagram': '#e1306c', 'Facebook': '#1877f2', 'TikTok': '#000000',
    'YouTube': '#ff0000', 'LinkedIn': '#0077b5', 'Twitter/X': '#1da1f2',
    'Google Business': '#4285f4'
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Social Media Calendar</h1>
          <p className="page-subtitle">Plan, schedule, and track social content</p>
        </div>
        <div className="header-actions">
          <div className="view-toggle">
            <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
          </div>
          <button className="btn btn-primary" onClick={() => openNew()}>+ New Post</button>
        </div>
      </div>

      <div className="toolbar">
        <select value={filter.platform} onChange={e => setFilter(p => ({ ...p, platform: e.target.value }))}>
          <option value="">All Platforms</option>
          {platforms.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select value={filter.status} onChange={e => setFilter(p => ({ ...p, status: e.target.value }))}>
          <option value="">All Statuses</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
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
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d} className="cal-header-cell">{d}</div>
            ))}
            {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} className="cal-cell empty"></div>)}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1
              const dateStr = `${currentMonth}-${String(day).padStart(2, '0')}`
              const dayPosts = items.filter(p => p.scheduled_date === dateStr)
              const isToday = dateStr === new Date().toISOString().split('T')[0]
              return (
                <div key={day} className={`cal-cell ${isToday ? 'today' : ''}`} onClick={() => openNew(dateStr)}>
                  <div className="cal-day">{day}</div>
                  <div className="cal-posts">
                    {dayPosts.map(p => (
                      <div key={p.id} className="cal-post" style={{ borderLeftColor: platformColors[p.platform] || '#6b7280' }}
                        onClick={e => { e.stopPropagation(); openEdit(p) }}>
                        <span className="cal-post-platform">{p.platform}</span>
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
        <>
        <div className="table-container desktop-only-table">
          <table className="data-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Platform</th>
                <th>Type</th>
                <th>Date</th>
                <th>Time</th>
                <th>Status</th>
                <th>Engagement</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan="8" className="empty-state">No posts scheduled</td></tr>
              ) : items.map(item => (
                <tr key={item.id}>
                  <td className="cell-primary" onClick={() => openEdit(item)}>{item.title}</td>
                  <td><span style={{color: platformColors[item.platform]}}>{item.platform}</span></td>
                  <td>{item.post_type || '—'}</td>
                  <td>{item.scheduled_date || '—'}</td>
                  <td>{item.scheduled_time || '—'}</td>
                  <td><StatusBadge status={item.status} /></td>
                  <td>{item.engagement_likes + item.engagement_comments + item.engagement_shares > 0 ?
                    `${item.engagement_likes}L ${item.engagement_comments}C ${item.engagement_shares}S` : '—'}</td>
                  <td>
                    <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                    <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Del</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mobile-only-cards">
          {items.length === 0 ? (
            <div className="empty-state-full">No posts scheduled</div>
          ) : items.map(item => (
            <div key={item.id} className="data-card" onClick={() => openEdit(item)}>
              <div className="data-card-header">
                <div className="data-card-title">{item.title}</div>
                <StatusBadge status={item.status} />
              </div>
              <div className="data-card-meta">
                <span style={{color: platformColors[item.platform]}}>{item.platform}</span>
                {item.post_type && <span>{item.post_type}</span>}
              </div>
              <div className="data-card-body">
                {item.scheduled_date && <div><strong>Scheduled:</strong> {item.scheduled_date}{item.scheduled_time ? ` ${item.scheduled_time}` : ''}</div>}
                {item.engagement_likes + item.engagement_comments + item.engagement_shares > 0 && (
                  <div><strong>Engagement:</strong> {item.engagement_likes}L · {item.engagement_comments}C · {item.engagement_shares}S</div>
                )}
              </div>
            </div>
          ))}
        </div>
        </>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Post' : 'New Post'}>
        <form onSubmit={save}>
          <label>Title<input value={form.title} onChange={e => f2('title', e.target.value)} required /></label>
          <div className="form-row">
            <label>Platform<select value={form.platform} onChange={e => f2('platform', e.target.value)}>
              {platforms.map(p => <option key={p} value={p}>{p}</option>)}
            </select></label>
            <label>Post Type<select value={form.post_type} onChange={e => f2('post_type', e.target.value)}>
              {postTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select></label>
          </div>
          <label>Content / Caption<textarea value={form.content} onChange={e => f2('content', e.target.value)} rows={4} /></label>
          <div className="form-row">
            <label>Scheduled Date<input type="date" value={form.scheduled_date} onChange={e => f2('scheduled_date', e.target.value)} /></label>
            <label>Scheduled Time<input type="time" value={form.scheduled_time} onChange={e => f2('scheduled_time', e.target.value)} /></label>
          </div>
          <label>Status<select value={form.status} onChange={e => f2('status', e.target.value)}>
            {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </select></label>
          <label>Hashtags<input value={form.hashtags} onChange={e => f2('hashtags', e.target.value)} placeholder="#realestate #cedarrapids..." /></label>
          <label>Media URL<input value={form.media_url} onChange={e => f2('media_url', e.target.value)} placeholder="Link to image/video" /></label>
          {editing && (
            <>
              <h4 style={{marginTop: 12, color: 'var(--accent)'}}>Engagement Tracking</h4>
              <div className="form-row" style={{gridTemplateColumns: '1fr 1fr 1fr'}}>
                <label>Likes<input type="number" value={form.engagement_likes} onChange={e => f2('engagement_likes', e.target.value)} /></label>
                <label>Comments<input type="number" value={form.engagement_comments} onChange={e => f2('engagement_comments', e.target.value)} /></label>
                <label>Shares<input type="number" value={form.engagement_shares} onChange={e => f2('engagement_shares', e.target.value)} /></label>
              </div>
            </>
          )}
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
