import React, { useState, useEffect, useRef } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import EmailToolbar from '../components/EmailToolbar'
import RichTextEditor from '../components/RichTextEditor'
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

// Voicemail recordings — upload MP3/WAV clips (record on your phone/computer),
// used for live-call voicemail drops and as the voicemail greeting.
function VoicemailManager() {
  const [list, setList] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef(null)
  const load = () => authFetch('/api/voicemails').then(r => r.json()).then(d => setList(Array.isArray(d) ? d : [])).catch(() => {})
  useEffect(() => { load() }, [])
  const upload = async (file) => {
    if (!file) return
    setBusy(true)
    try {
      const fd = new FormData(); fd.append('name', name.trim() || 'Voicemail'); fd.append('file', file)
      const r = await authFetch('/api/voicemails', { method: 'POST', body: fd }); const d = await r.json()
      if (d.success) { setName(''); load() } else alert(d.error || 'Upload failed')
    } catch (e) { alert(e.message) } finally { setBusy(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const del = async (id) => { if (!confirm('Delete this voicemail recording?')) return; await authFetch('/api/voicemails/' + id, { method: 'DELETE' }).catch(() => {}); load() }
  return (
    <section className="detail-section" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>🎙 Voicemail Recordings</h3>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Upload MP3/WAV clips (record on your phone or computer). Use them for one-click voicemail drops during a call.</span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Name (e.g. Buyer follow-up drop)" style={{ padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, minWidth: 260 }} />
        <input ref={fileRef} type="file" accept="audio/mpeg,audio/mp3,audio/wav,.mp3,.wav" style={{ display: 'none' }} onChange={e => upload(e.target.files?.[0])} />
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => { if (!name.trim()) { alert('Give the voicemail a name first.'); return } fileRef.current?.click() }}>{busy ? 'Uploading…' : '＋ Upload MP3/WAV'}</button>
      </div>
      {list.length === 0 ? <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>No voicemails yet. Record one on your phone or computer and upload it here.</div> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {list.map(v => (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <span style={{ fontWeight: 600, minWidth: 160 }}>{v.name}</span>
              <audio controls src={v.url} style={{ height: 34, flex: 1, minWidth: 200 }} />
              <button className="btn btn-sm" onClick={() => del(v.id)}>Delete</button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
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
  const [tplView, setTplView] = useState('wysiwyg') // email body editor: 'wysiwyg' | 'html'
  const [fubBusy, setFubBusy] = useState(false)
  // Transaction emails — read-only, live from the transaction system
  const [txTemplates, setTxTemplates] = useState([])
  const [txOpen, setTxOpen] = useState(true)
  const [viewTx, setViewTx] = useState(null)
  useEffect(() => { authFetch('/api/email/transaction-templates?body=1').then(r => r.json()).then(t => setTxTemplates(Array.isArray(t) ? t : [])).catch(() => {}) }, [])
  const fileInputRef = useRef(null)
  const tplBodyRef = useRef(null)

  const load = () => {
    const params = new URLSearchParams()
    if (typeFilter) params.set('type', typeFilter)
    if (search.trim()) params.set('q', search.trim())
    authFetch('/api/templates?' + params).then(r => r.json()).then(setItems).catch(() => setItems([]))
  }
  const importFub = async () => {
    if (!confirm('Import your text templates from Follow Up Boss? FUB merge fields are converted to Hub fields; duplicates (by name) are skipped.')) return
    setFubBusy(true)
    try {
      const r = await authFetch('/api/templates/import-fub', { method: 'POST' })
      const d = await r.json()
      if (d.error) alert(d.error)
      else { alert(`Imported ${d.imported} text template${d.imported === 1 ? '' : 's'} from FUB.\nSkipped ${d.skipped} (duplicates/empty) and ${d.ylopo_skipped || 0} that used a Ylopo link.`); setTypeFilter('text'); load() }
    } catch (e) { alert('Import failed: ' + e.message) } finally { setFubBusy(false) }
  }

  useEffect(() => { load() }, [typeFilter])
  useEffect(() => {
    const t = setTimeout(load, 250)
    return () => clearTimeout(t)
  }, [search])

  const openNew = (type = 'email') => {
    setEditing(null)
    setForm({ ...emptyTemplate, type })
    setTplView('wysiwyg')
    setModalOpen(true)
  }
  const openEdit = (item) => {
    setEditing(item.id)
    setTplView('wysiwyg')
    const type = item.type || 'email'
    let body = item.body || ''
    // Plain-text email templates → convert to HTML so paragraphs render in the WYSIWYG editor.
    const isEmail = type === 'email'
    if (isEmail && !item.is_html && !looksLikeHtml(body) && body.trim()) {
      body = '<p>' + body.trim().replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>'
    }
    setForm({
      name: item.name || '',
      type,
      category: item.category || '',
      subject: item.subject || '',
      body,
      is_html: isEmail ? true : !!item.is_html,
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
          <button className="btn btn-secondary" onClick={importFub} disabled={fubBusy} title="Import your text templates from Follow Up Boss">{fubBusy ? 'Importing…' : '⬇ Import from FUB'}</button>
          <button className="btn btn-secondary" onClick={() => openNew('text')}>+ New Text</button>
          <button className="btn btn-primary" onClick={() => openNew('email')}>+ New Email</button>
        </div>
      </div>

      <VoicemailManager />

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

      {/* Transaction Emails — read-only, sent from the Transactions tab with deal details filled in */}
      <div style={{ marginTop: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} onClick={() => setTxOpen(v => !v)}>
          <h3 style={{ margin: 0 }}>Transaction Emails {txOpen ? '▾' : '▸'}</h3>
          <span className="email-status-tag">{txTemplates.length}</span>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sent from the Transactions tab — each deal's details (address, names, dates, price) fill in automatically</span>
        </div>
        {txOpen && (
          <div className="table-container" style={{ marginTop: 10 }}>
            <table className="data-table">
              <thead><tr><th>Name</th><th style={{ width: 110 }}>For</th><th>Subject</th><th style={{ width: 140 }}>Actions</th></tr></thead>
              <tbody>
                {txTemplates.length === 0 ? <tr><td colSpan="4" className="empty-state">Loading…</td></tr> : txTemplates.map(t => (
                  <tr key={t.id}>
                    <td className="cell-primary" style={{ cursor: 'pointer' }} onClick={() => setViewTx(t)}>{t.name}</td>
                    <td><span className="email-status-tag">{t.recipient === 'client' ? (t.role || 'client') : t.recipient}</span></td>
                    <td style={{ fontSize: 13 }}>{t.subject}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-sm" onClick={() => setViewTx(t)}>View</button>
                      <button className="btn-sm" onClick={() => { try { navigator.clipboard.writeText(t.body || '') } catch {} }} title="Copy body">Copy</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!viewTx} onClose={() => setViewTx(null)} title={viewTx?.name || 'Transaction Email'} wide>
        {viewTx && (<>
          <p style={{ margin: '0 0 8px' }}><strong>Subject:</strong> {viewTx.subject}</p>
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, maxHeight: '55vh', overflowY: 'auto' }}>{viewTx.body}</div>
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>Sent from the <strong>Transactions</strong> tab. Merge fields like {'{{property_address}}'}, {'{{client_first_names}}'}, {'{{closing_date}}'} fill in from the specific deal when you send it there.</p>
          <div className="form-actions"><button className="btn btn-secondary" onClick={() => setViewTx(null)}>Close</button></div>
        </>)}
      </Modal>

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

          {form.type === 'email' ? (
            <div>
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '6px 0 4px'}}>
                <span style={{fontSize: 13, fontWeight: 500}}>Message</span>
                <div style={{display: 'flex', gap: 6}}>
                  <button type="button" className={`btn btn-sm ${tplView === 'wysiwyg' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTplView('wysiwyg')}>✎ Edit</button>
                  <button type="button" className={`btn btn-sm ${tplView === 'html' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTplView('html')}>{'</>'} HTML</button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setPreviewOpen(true)} disabled={!form.body}>👁 Preview</button>
                  <input ref={fileInputRef} type="file" accept=".html,.htm" style={{display: 'none'}} onChange={onUploadHtmlFile} />
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => fileInputRef.current?.click()}>📁 Load HTML</button>
                </div>
              </div>
              {tplView === 'wysiwyg' ? (
                <RichTextEditor value={form.body} onChange={(b) => setForm(p => ({ ...p, body: b, is_html: true }))} minHeight={240} />
              ) : (
                <>
                  <EmailToolbar textareaRef={tplBodyRef} body={form.body} setBody={(b) => setForm(p => ({ ...p, body: b }))} showPreview={false} compact />
                  <textarea ref={tplBodyRef} value={form.body} onChange={e => setForm(p => ({ ...p, body: e.target.value }))} rows={16} style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}} />
                </>
              )}
              <p style={{fontSize: 11, color: 'var(--text-muted)', margin: '4px 0'}}>
                Write it like a normal email. Merge fields: {'{{first_name}} {{last_name}} {{city}} {{address}}'}.
              </p>
            </div>
          ) : (
            <label>Body
              <textarea
                ref={tplBodyRef}
                value={form.body}
                onChange={e => setForm(p => ({ ...p, body: e.target.value }))}
                rows={8}
                required
                placeholder={form.type === 'text' ? 'Hey {{first_name}}, quick note...' : 'Template body — supports {{first_name}}, {{address}}, etc.'}
                style={{width: '100%', fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical'}}
              />
            </label>
          )}

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
