import React, { useState, useEffect, useRef } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import EmailToolbar from '../components/EmailToolbar'
import { autoEmbedYoutubeLinks } from '../components/inlineImages'

const TYPE_OPTIONS = [
  { value: 'email', label: 'Email', icon: '✉' },
  { value: 'text', label: 'Text / SMS', icon: '\u{1F4AC}' },
  { value: 'script', label: 'Call Script', icon: '\u{1F4DE}' },
  { value: 'voicemail', label: 'Voicemail', icon: '\u{1F399}' },
  { value: 'note', label: 'Note Snippet', icon: '✍' },
]

const CATEGORY_SUGGESTIONS = [
  'Buyer', 'Seller', 'Listing', 'Pre-Listing', 'Under Contract', 'Closing',
  'Follow-Up', 'Nurture', 'Past Client', 'New Lead', 'Open House', 'Vendor Intro',
  'Lender Intro', 'Closer Intro', 'Inspection', 'Equity Check', 'Market Update'
]

const emptyTemplate = {
  name: '', type: 'email', category: '', subject: '', body: '', is_html: false, tags: ''
}

function looksLikeHtml(s) {
  if (!s) return false
  return /<\/?(p|div|br|a|h[1-6]|ul|ol|li|strong|em|b|i|table|tr|td|img|span|hr|blockquote|pre|code|style|center|html|head|body|!DOCTYPE)\b/i.test(s)
}

export default function Templates() {
  const [items, setItems] = useState([])
  const [typeFilter, setTypeFilter] = useState('')
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyTemplate)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInputRef = useRef(null)
  const tplBodyRef = useRef(null)

  const load = () => {
    const params = new URLSearchParams()
    if (typeFilter) params.set('type', typeFilter)
    if (search.trim()) params.set('q', search.trim())
    authFetch('/api/templates?' + params).then(r => r.json()).then(setItems).catch(() => setItems([]))
  }

  useEffect(() => { load() }, [typeFilter])
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [search])

  const openNew = (type = 'email') => {
    setEditing(null)
    setForm({ ...emptyTemplate, type })
    setModalOpen(true)
  }
  const openEdit = (item) => {
    setEditing(item.id)
    setForm({
      name: item.name || '',
      type: item.type || 'email',
      category: item.category || '',
      subject: item.subject || '',
      body: item.body || '',
      is_html: !!item.is_html,
      tags: item.tags || '',
    })
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    if (saving) return
    setSaving(true)
    try {
      const payload = { ...form }
      // Auto-detect HTML for email type
      if (payload.type === 'email' && !payload.is_html && looksLikeHtml(payload.body)) {
        payload.is_html = true
      }
      const opts = {
        method: editing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
      const r = await authFetch(editing ? `/api/templates/${editing}` : '/api/templates', opts)
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        alert('Save failed: ' + (d.error || r.statusText))
        return
      }
      setModalOpen(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id, name) => {
    if (!confirm(`Delete template "${name}"?`)) return
    await authFetch(`/api/templates/${id}`, { method: 'DELETE' })
    load()
  }

  const duplicate = async (id) => {
    await authFetch(`/api/templates/${id}/duplicate`, { method: 'POST' })
    load()
  }

  const copyBody = async (item) => {
    try {
      await navigator.clipboard.writeText(item.body || '')
      authFetch(`/api/templates/${item.id}/used`, { method: 'POST' })
      // brief visual feedback would be nice — for now use a tiny alert
      const el = document.getElementById(`tpl-row-${item.id}`)
      if (el) {
        el.classList.add('row-flash')
        setTimeout(() => el.classList.remove('row-flash'), 800)
      }
    } catch {
      alert('Copy failed — your browser may block clipboard access')
    }
  }

  const onUploadHtmlFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    setForm(p => ({ ...p, body: text, is_html: true, type: 'email' }))
    e.target.value = ''
  }

  const counts = items.reduce((acc, it) => { acc[it.type] = (acc[it.type] || 0) + 1; return acc }, {})

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Templates</h1>
          <p className="page-sub">Reusable email, text, script, and voicemail templates</p>
        </div>
        <div style={{display: 'flex', gap: 8}}>
          <button className="btn btn-secondary" onClick={() => openNew('text')}>+ New Text</button>
          <button className="btn btn-primary" onClick={() => openNew('email')}>+ New Email</button>
        </div>
      </div>

      {/* Type tabs */}
      <div className="type-tabs">
        <span className="type-tabs-label">Type:</span>
        <button
          className={`type-tab ${!typeFilter ? 'active' : ''}`}
          onClick={() => setTypeFilter('')}
        >
          All <span className="tab-count">{items.length}</span>
        </button>
        {TYPE_OPTIONS.map(t => (
          <button
            key={t.value}
            className={`type-tab ${typeFilter === t.value ? 'active' : ''}`}
            onClick={() => setTypeFilter(t.value)}
          >
            {t.icon} {t.label} <span className="tab-count">{counts[t.value] || 0}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <input
          type="text"
          className="search-input"
          placeholder="Search templates (name, subject, body, tags, category)..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{flex: 1, minWidth: 240}}
        />
        {search && (
          <button className="btn btn-sm btn-secondary" onClick={() => setSearch('')}>Clear</button>
        )}
      </div>

      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Category</th>
              <th>Subject</th>
              <th>Snippet</th>
              <th>Used</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan="8" className="empty-state">No templates yet. Click <strong>+ New Email</strong> or <strong>+ New Text</strong> to create one.</td></tr>
            ) : items.map(item => {
              const typeMeta = TYPE_OPTIONS.find(t => t.value === item.type) || TYPE_OPTIONS[0]
              const snippet = (item.body || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
              return (
                <tr key={item.id} id={`tpl-row-${item.id}`}>
                  <td className="cell-primary" onClick={() => openEdit(item)} style={{cursor: 'pointer'}}>
                    {item.name}
                    {item.is_html ? <span className="email-status-tag" style={{marginLeft: 6}}>HTML</span> : null}
                  </td>
                  <td><span className={`type-pill type-${item.type === 'both' ? 'both' : 'buyer'}`} style={{background: 'var(--bg-elevated)', color: 'var(--text-secondary)', borderColor: 'var(--border)'}}>{typeMeta.icon} {typeMeta.label}</span></td>
                  <td>{item.category || <span className="muted">—</span>}</td>
                  <td>{item.subject || <span className="muted">—</span>}</td>
                  <td className="muted" style={{fontSize: 12, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{snippet || '—'}</td>
                  <td>{item.used_count || 0}</td>
                  <td className="muted" style={{fontSize: 11}}>{(item.updated_at || '').split('T')[0] || (item.updated_at || '').split(' ')[0] || '—'}</td>
                  <td style={{whiteSpace: 'nowrap'}}>
                    <button className="btn-sm" onClick={() => copyBody(item)} title="Copy body to clipboard">Copy</button>
                    <button className="btn-sm" onClick={() => openEdit(item)}>Edit</button>
                    <button className="btn-sm" onClick={() => duplicate(item.id)} title="Duplicate">Dup</button>
                    <button className="btn-sm btn-danger" onClick={() => remove(item.id, item.name)}>Del</button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Template' : 'New Template'} wide>
        <form onSubmit={save} className="form">
          <div className="form-row">
            <label style={{flex: 2}}>Name<input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} required placeholder="e.g. Buyer — Under Contract Welcome" /></label>
            <label style={{flex: 1}}>Type
              <select value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))}>
                {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label style={{flex: 1}}>Category<input value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))} placeholder="e.g. Buyer, Listing, Follow-Up" list="tpl-categories" /></label>
            <label style={{flex: 1}}>Tags<input value={form.tags} onChange={e => setForm(p => ({ ...p, tags: e.target.value }))} placeholder="comma,separated,tags" /></label>
          </div>
          <datalist id="tpl-categories">
            {CATEGORY_SUGGESTIONS.map(c => <option key={c} value={c} />)}
          </datalist>

          {form.type === 'email' && (
            <label>Subject<input value={form.subject} onChange={e => setForm(p => ({ ...p, subject: e.target.value }))} placeholder="Email subject — supports {{merge_vars}}" /></label>
          )}

          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '6px 0 -4px'}}>
            <label style={{display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, margin: 0}}>
              <input
                type="checkbox"
                checked={form.is_html}
                onChange={e => setForm(p => ({ ...p, is_html: e.target.checked }))}
                disabled={form.type !== 'email'}
              />
              Body is HTML
              {form.type === 'email' && !form.is_html && looksLikeHtml(form.body) && (
                <span style={{color: '#fbbf24', fontSize: 11}}>(HTML detected — will auto-flag on save)</span>
              )}
            </label>
            {form.type === 'email' && (
              <div style={{display: 'flex', gap: 6}}>
                <input ref={fileInputRef} type="file" accept=".html,.htm" style={{display: 'none'}} onChange={onUploadHtmlFile} />
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>
                  Upload .html file
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() => setPreviewOpen(true)}
                  disabled={!form.body}
                >
                  Preview
                </button>
              </div>
            )}
          </div>

          {form.type === 'email' && (
            <EmailToolbar
              textareaRef={tplBodyRef}
              body={form.body}
              setBody={(b) => setForm(p => ({ ...p, body: b }))}
              showPreview={false}
              compact
            />
          )}
          <label>Body
            <textarea
              ref={tplBodyRef}
              value={form.body}
              onChange={e => setForm(p => ({ ...p, body: e.target.value }))}
              rows={form.type === 'email' ? 18 : 8}
              required
              placeholder={form.type === 'text' ? 'Hey {{first_name}}, quick note...' : 'Template body — supports {{first_name}}, {{address}}, etc.'}
              style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}}
            />
          </label>

          <div className="form-actions">
            {editing && (
              <button type="button" className="btn btn-danger" onClick={() => { setModalOpen(false); remove(editing, form.name) }} style={{marginRight: 'auto'}}>
                Delete
              </button>
            )}
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving...' : (editing ? 'Save Changes' : 'Create Template')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Email Preview" wide>
        <div className="email-preview">
          {form.subject && <div style={{padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)'}}>
            <strong>Subject:</strong> {form.subject}
          </div>}
          {form.is_html || looksLikeHtml(form.body) ? (
            <iframe
              title="preview"
              srcDoc={autoEmbedYoutubeLinks(form.body)}
              style={{width: '100%', height: 480, border: 0, background: '#fff'}}
            />
          ) : (
            <pre style={{whiteSpace: 'pre-wrap', padding: 16, margin: 0, fontFamily: 'inherit', fontSize: 14, lineHeight: 1.5}}>{form.body}</pre>
          )}
        </div>
      </Modal>
    </div>
  )
}
