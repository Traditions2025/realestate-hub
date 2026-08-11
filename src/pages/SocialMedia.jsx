import React, { useState, useEffect } from 'react'
import { authFetch, apiUrl } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const platforms = ['Instagram', 'Facebook', 'TikTok', 'YouTube', 'LinkedIn', 'Twitter/X', 'Google Business']
const postTypes = ['Listing Post', 'Just Sold', 'Market Update', 'Tips & Education', 'Team/Personal', 'Testimonial', 'Open House', 'Coming Soon', 'Blog Share', 'Reel/Video', 'Carousel', 'Story', 'Other']
const statusOptions = ['draft', 'scheduled', 'posted', 'cancelled']
// Pages the n8n connector can post to. Each maps to one credential/account in n8n.
const publishTargets = ['Facebook', 'Instagram', 'LinkedIn', 'Google Business']

const emptyPost = {
  title: '', platform: 'Instagram', post_type: 'Listing Post', content: '', media_url: '',
  scheduled_date: '', scheduled_time: '', status: 'draft', hashtags: '',
  engagement_likes: 0, engagement_comments: 0, engagement_shares: 0, notes: '',
  image_file: '', targets: []
}

// In-app image src is the PUBLIC (whitelisted) route, so no auth header needed.
const imgSrc = (file) => file ? `/api/social-media/img/${file}` : null

const pubBadge = { idle: '', queued: '⏳ Queued', posting: '📤 Posting', posted: '✅ Posted', failed: '⚠ Failed' }

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
  const [editingItem, setEditingItem] = useState(null)
  const [form, setForm] = useState(emptyPost)
  const [uploading, setUploading] = useState(false)

  // n8n setup panel
  const [setupOpen, setSetupOpen] = useState(false)
  const [config, setConfig] = useState(null)

  const load = () => {
    const params = new URLSearchParams()
    if (filter.platform) params.set('platform', filter.platform)
    if (filter.status) params.set('status', filter.status)
    if (view === 'calendar') params.set('month', currentMonth)
    authFetch('/api/social-media?' + params).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [filter, currentMonth, view])

  const openNew = (date) => { setEditing(null); setEditingItem(null); setForm({ ...emptyPost, targets: [], scheduled_date: date || '' }); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    setEditingItem(item)
    const f = { ...emptyPost }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    try { f.targets = item.targets ? JSON.parse(item.targets) : [] } catch { f.targets = [] }
    if (!Array.isArray(f.targets)) f.targets = []
    setForm(f)
    setModalOpen(true)
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))
  const toggleTarget = (t) => setForm(prev => ({
    ...prev, targets: prev.targets.includes(t) ? prev.targets.filter(x => x !== t) : [...prev.targets, t]
  }))

  const uploadImage = async (file) => {
    if (!file) return
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('image', file)
      const token = localStorage.getItem('mst_token') || ''
      const r = await fetch(apiUrl('/api/social-media/upload'), { method: 'POST', headers: { 'x-auth-token': token }, body: fd })
      const j = await r.json()
      if (j.file) f2('image_file', j.file)
      else alert(j.error || 'Upload failed')
    } catch { alert('Upload failed') }
    setUploading(false)
  }

  const save = async (e, thenQueue) => {
    if (e) e.preventDefault()
    const data = {
      ...form,
      engagement_likes: Number(form.engagement_likes), engagement_comments: Number(form.engagement_comments),
      engagement_shares: Number(form.engagement_shares),
    }
    const method = editing ? 'PUT' : 'POST'
    const url = editing ? `/api/social-media/${editing}` : '/api/social-media'
    const r = await authFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    const j = await r.json().catch(() => ({}))
    const id = editing || j.id
    if (thenQueue && id) {
      const qr = await authFetch(`/api/social-media/${id}/queue`, { method: 'POST' })
      const qj = await qr.json().catch(() => ({}))
      if (!qr.ok) { load(); return alert(qj.error || 'Saved, but could not queue for publishing') }
    }
    setModalOpen(false)
    load()
  }

  const refreshEditing = async () => {
    if (!editing) return
    const r = await authFetch(`/api/social-media/${editing}`)
    const item = await r.json()
    setEditingItem(item)
  }
  const queuePost = async () => {
    const r = await authFetch(`/api/social-media/${editing}/queue`, { method: 'POST' })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return alert(j.error || 'Could not queue')
    await refreshEditing(); load()
  }
  const unqueuePost = async () => {
    await authFetch(`/api/social-media/${editing}/unqueue`, { method: 'POST' })
    await refreshEditing(); load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this post?')) return
    await authFetch(`/api/social-media/${id}`, { method: 'DELETE' })
    load()
  }

  const openSetup = () => {
    setSetupOpen(true)
    authFetch('/api/social-media/config').then(r => r.json()).then(setConfig)
  }
  const saveBaseUrl = async () => {
    await authFetch('/api/social-media/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_base_url: config.public_base_url })
    })
    authFetch('/api/social-media/config').then(r => r.json()).then(setConfig)
  }
  const regenKey = async () => {
    if (!confirm('Regenerate the publishing key? You will need to update it in n8n.')) return
    await authFetch('/api/social-media/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regenerate: true })
    })
    authFetch('/api/social-media/config').then(r => r.json()).then(setConfig)
  }

  // Calendar helpers
  const [year, month] = currentMonth.split('-').map(Number)
  const daysInMonth = new Date(year, month, 0).getDate()
  const firstDay = new Date(year, month - 1, 1).getDay()
  const monthName = new Date(year, month - 1).toLocaleString('default', { month: 'long', year: 'numeric' })

  const prevMonth = () => { const d = new Date(year, month - 2); setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`) }
  const nextMonth = () => { const d = new Date(year, month); setCurrentMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`) }

  const platformColors = {
    'Instagram': '#e1306c', 'Facebook': '#1877f2', 'TikTok': '#000000',
    'YouTube': '#ff0000', 'LinkedIn': '#0077b5', 'Twitter/X': '#1da1f2', 'Google Business': '#4285f4'
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Social Media Calendar</h1>
          <p className="page-subtitle">Plan, schedule, auto-publish, and track social content</p>
        </div>
        <div className="header-actions">
          <div className="view-toggle">
            <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
            <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>List</button>
          </div>
          <button className="btn btn-secondary" onClick={openSetup} title="Connect n8n to auto-publish">⚙ Publishing</button>
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
                        {p.image_file && <img src={imgSrc(p.image_file)} alt="" className="cal-post-thumb" />}
                        <span className="cal-post-platform">{p.platform}</span>
                        <span className="cal-post-title">{p.title}</span>
                        {p.publish_status && p.publish_status !== 'idle' && (
                          <span className="cal-post-pub">{pubBadge[p.publish_status]}</span>
                        )}
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
                <th></th>
                <th>Title</th>
                <th>Platform</th>
                <th>Type</th>
                <th>Date</th>
                <th>Publishing</th>
                <th>Status</th>
                <th>Engagement</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr><td colSpan="9" className="empty-state">No posts scheduled</td></tr>
              ) : items.map(item => (
                <tr key={item.id}>
                  <td>{item.image_file ? <img src={imgSrc(item.image_file)} alt="" style={{ width: 42, height: 42, objectFit: 'cover', borderRadius: 6 }} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  <td className="cell-primary" onClick={() => openEdit(item)}>{item.title}</td>
                  <td><span style={{color: platformColors[item.platform]}}>{item.platform}</span></td>
                  <td>{item.post_type || '—'}</td>
                  <td>{item.scheduled_date || '—'}{item.scheduled_time ? ` ${item.scheduled_time}` : ''}</td>
                  <td>{item.publish_status && item.publish_status !== 'idle' ? pubBadge[item.publish_status] : '—'}</td>
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
                {item.publish_status && item.publish_status !== 'idle' && <span>{pubBadge[item.publish_status]}</span>}
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
        <form onSubmit={(e) => save(e, false)}>
          <label>Title<input value={form.title} onChange={e => f2('title', e.target.value)} required /></label>

          {/* Image */}
          <label style={{ display: 'block' }}>Image</label>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 10 }}>
            {form.image_file ? (
              <div style={{ position: 'relative' }}>
                <img src={imgSrc(form.image_file)} alt="" style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                <button type="button" className="btn-sm btn-danger" style={{ marginTop: 4 }} onClick={() => f2('image_file', '')}>Remove</button>
              </div>
            ) : (
              <div style={{ width: 120, height: 120, borderRadius: 8, border: '1px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: 12 }}>No image</div>
            )}
            <div>
              <input type="file" accept="image/*,video/mp4" onChange={e => uploadImage(e.target.files[0])} />
              {uploading && <div style={{ fontSize: 12, color: 'var(--accent)' }}>Uploading…</div>}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>JPG/PNG/MP4, up to 25MB. Stored on the Hub and served to the platforms.</div>
            </div>
          </div>

          <div className="form-row">
            <label>Platform (calendar category)<select value={form.platform} onChange={e => f2('platform', e.target.value)}>
              {platforms.map(p => <option key={p} value={p}>{p}</option>)}
            </select></label>
            <label>Post Type<select value={form.post_type} onChange={e => f2('post_type', e.target.value)}>
              {postTypes.map(t => <option key={t} value={t}>{t}</option>)}
            </select></label>
          </div>

          {/* Publish targets */}
          <label style={{ display: 'block' }}>Publish to (via n8n)</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, margin: '4px 0 12px' }}>
            {publishTargets.map(t => (
              <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400, margin: 0 }}>
                <input type="checkbox" checked={form.targets.includes(t)} onChange={() => toggleTarget(t)} style={{ width: 'auto' }} />
                {t}
              </label>
            ))}
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
          <label>Media URL (optional, if not uploading)<input value={form.media_url} onChange={e => f2('media_url', e.target.value)} placeholder="External image/video link" /></label>

          {editing && editingItem && (
            <div style={{ marginTop: 14, padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-subtle, rgba(127,127,127,.06))' }}>
              <h4 style={{ margin: '0 0 8px' }}>Auto-Publish</h4>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                Status: <strong>{pubBadge[editingItem.publish_status] || 'Not queued'}</strong>
                {editingItem.published_at && <span style={{ color: 'var(--text-muted)' }}> · {new Date(editingItem.published_at).toLocaleString()}</span>}
              </div>
              {editingItem.publish_results && (() => {
                let rs = []; try { rs = JSON.parse(editingItem.publish_results) } catch {}
                return rs.length ? (
                  <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12 }}>
                    {rs.map((r, i) => (
                      <li key={i} style={{ color: r.ok === false || r.error ? 'var(--danger, #e11)' : 'inherit' }}>
                        {r.platform || 'target'}: {r.ok === false || r.error ? `failed ${r.error || ''}` : 'posted'}
                        {r.url && <> · <a href={r.url} target="_blank" rel="noreferrer">view</a></>}
                      </li>
                    ))}
                  </ul>
                ) : null
              })()}
              {['queued', 'posting'].includes(editingItem.publish_status)
                ? <button type="button" className="btn btn-secondary" onClick={unqueuePost}>Cancel publish</button>
                : <button type="button" className="btn btn-primary" onClick={queuePost}>Queue for publishing now</button>}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Queued posts are picked up by n8n at (or after) the scheduled time and posted to the checked pages.
              </div>
            </div>
          )}

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
            <button type="submit" className="btn btn-secondary">{editing ? 'Save' : 'Create'}</button>
            <button type="button" className="btn btn-primary" onClick={(e) => save(e, true)} disabled={uploading}>
              {editing ? 'Save & Queue' : 'Create & Queue'}
            </button>
          </div>
        </form>
      </Modal>

      {/* n8n setup */}
      <Modal open={setupOpen} onClose={() => setSetupOpen(false)} title="Publishing Setup (n8n)">
        {!config ? <p>Loading…</p> : (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <p>n8n connects the Hub to your social pages. Point an n8n workflow at these endpoints and it will publish queued posts and report back.</p>
            <label>Public base URL of this Hub
              <input value={config.public_base_url} onChange={e => setConfig(c => ({ ...c, public_base_url: e.target.value }))} />
            </label>
            <button className="btn btn-sm btn-secondary" onClick={saveBaseUrl} style={{ marginBottom: 12 }}>Save base URL</button>
            <FieldRow label="Publishing key (x-social-key)" value={config.key} />
            <FieldRow label="Queue URL (n8n polls this, GET)" value={`${config.queue_url}?key=${config.key}`} />
            <FieldRow label="Result callback (n8n POSTs here)" value={`${config.result_url}?key=${config.key}`} />
            <button className="btn btn-sm btn-danger" onClick={regenKey} style={{ marginTop: 6 }}>Regenerate key</button>
            <div style={{ marginTop: 14, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
              <strong>How the n8n workflow works</strong>
              <ol style={{ paddingLeft: 18, margin: '6px 0 0' }}>
                <li>Schedule trigger (every 5–10 min) → HTTP GET the Queue URL.</li>
                <li>For each returned post, post <code>image_url</code> + <code>caption</code> to each name in <code>targets</code> (Facebook / Instagram / LinkedIn / Google Business nodes).</li>
                <li>HTTP POST the Result callback with <code>{'{ id, ok, results:[{platform, ok, post_id, url, error}] }'}</code>.</li>
              </ol>
            </div>
          </div>
        )}
        <div className="form-actions"><button className="btn btn-secondary" onClick={() => setSetupOpen(false)}>Close</button></div>
      </Modal>
    </div>
  )
}

function FieldRow({ label, value }) {
  const copy = () => { try { navigator.clipboard.writeText(value) } catch {} }
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input readOnly value={value} style={{ fontFamily: 'monospace', fontSize: 12 }} onFocus={e => e.target.select()} />
        <button type="button" className="btn btn-sm btn-secondary" onClick={copy}>Copy</button>
      </div>
    </div>
  )
}
