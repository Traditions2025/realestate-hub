import React, { useState, useEffect } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'

const checklistItems = [
  ['marketing_materials_sent', 'Marketing Materials Sent'],
  ['seller_discovery_form', 'Send Google Form "Home Seller Discovery Questions"'],
  ['cma', 'CMA'],
  ['seller_netsheet', 'Seller Netsheet'],
  ['loop_created', 'Loop Created'],
  ['listing_contract_signed', 'Listing Contract Signed'],
  ['getting_home_ready', 'Getting Your Home Ready'],
  ['schedule_photoshoot', 'Schedule Professional Photoshoot'],
  ['get_spare_keys', 'Get Spare Keys'],
  ['install_lockbox', 'Install Lockbox'],
  ['install_signs', 'Install For Sale Signs'],
  ['written_description', 'Written Property Description'],
  ['coming_soon_post', 'Coming Soon Post (24 Hrs Before)'],
  ['coming_soon_email', 'Coming Soon Email (24 Hrs Before)'],
  ['listing_submitted_mls', 'Listing Submitted in MLS'],
  ['posted_social_media', 'Posted on Social Media'],
]

const emptyForm = {
  property_address: '', owner_name: '', walkthrough: 'Not Scheduled', status: 'New', notes: '',
  ...Object.fromEntries(checklistItems.map(([k]) => [k, 0]))
}

export default function PreListings() {
  const [items, setItems] = useState([])
  const [search, setSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [syncing, setSyncing] = useState(false)
  const [emailTpls, setEmailTpls] = useState([])
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailForm, setEmailForm] = useState({ template_id: '', to_email: '', to_name: '', subject: '', body: '' })
  const [emailSending, setEmailSending] = useState(false)
  const [linkedClient, setLinkedClient] = useState(null)

  useEffect(() => {
    authFetch('/api/email/prelisting-templates').then(r => r.json()).then(setEmailTpls).catch(() => {})
  }, [])

  const load = () => {
    const params = {}
    if (search) params.search = search
    authFetch('/api/pre-listings?' + new URLSearchParams(params)).then(r => r.json()).then(setItems)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { load() }, [search])

  const openNew = () => { setEditing(null); setForm(emptyForm); setModalOpen(true) }
  const openEdit = (item) => {
    setEditing(item.id)
    const f = { ...emptyForm }
    Object.keys(f).forEach(k => { if (item[k] !== undefined && item[k] !== null) f[k] = item[k] })
    setForm(f)
    setModalOpen(true)
  }

  const save = async (e) => {
    e.preventDefault()
    const opts = { method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }
    const url = editing ? `/api/pre-listings/${editing}` : '/api/pre-listings'
    await authFetch(url, opts)
    setModalOpen(false)
    load()
  }

  const toggleCheck = async (item, key) => {
    await authFetch(`/api/pre-listings/${item.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: item[key] ? 0 : 1 })
    })
    load()
  }

  const remove = async (id) => {
    if (!confirm('Delete this pre-listing?')) return
    await authFetch(`/api/pre-listings/${id}`, { method: 'DELETE' })
    load()
  }

  const syncSheet = async () => {
    setSyncing(true)
    try {
      const r = await authFetch('/api/pre-listings/sync-sheet', { method: 'POST' })
      const d = await r.json()
      alert(`Synced ${d.synced} potential sellers from Google Sheet`)
      load()
    } catch (e) { alert('Sync failed: ' + e.message) }
    setSyncing(false)
  }

  const f2 = (k, v) => setForm(prev => ({ ...prev, [k]: v }))

  const openEmail = async () => {
    if (!editing) { alert('Save the pre-listing first.'); return }
    let cl = null
    if (form.client_id) {
      try { cl = await authFetch(`/api/clients/${form.client_id}`).then(r => r.json()) } catch {}
    }
    setLinkedClient(cl)
    setEmailForm({
      template_id: '',
      to_email: cl?.email || '',
      to_name: cl ? `${cl.first_name} ${cl.last_name}` : '',
      subject: '',
      body: '',
    })
    setEmailOpen(true)
  }

  const loadTpl = async (tplId) => {
    if (!tplId || !editing) return
    try {
      const r = await authFetch(`/api/email/prelisting-preview/${tplId}/${editing}`)
      const d = await r.json()
      if (d.error) { alert(d.error); return }
      setEmailForm(prev => ({ ...prev, template_id: tplId, subject: d.subject, body: d.body, to_email: prev.to_email || d.suggested_to || '' }))
    } catch (e) { alert(e.message) }
  }

  const sendEmail = async () => {
    if (!emailForm.to_email || !emailForm.subject || !emailForm.body) { alert('Recipient, subject, and body required.'); return }
    setEmailSending(true)
    try {
      const r = await authFetch('/api/email/send-prelisting', {
        method: 'POST',
        body: JSON.stringify({
          pre_listing_id: editing,
          to_email: emailForm.to_email,
          to_name: emailForm.to_name,
          subject: emailForm.subject,
          body: emailForm.body,
          template_id: emailForm.template_id,
        }),
      })
      const d = await r.json()
      if (d.error) { alert('Send failed: ' + d.error); return }
      alert(`✓ Sent to ${emailForm.to_email}\nCC: ${(d.cc || []).join(', ')}`)
      setEmailOpen(false)
    } catch (e) { alert(e.message) } finally { setEmailSending(false) }
  }
  const check = (k) => setForm(prev => ({ ...prev, [k]: prev[k] ? 0 : 1 }))

  const getProgress = (item) => {
    const done = checklistItems.filter(([k]) => item[k]).length
    return Math.round((done / checklistItems.length) * 100)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Pre-Listing Pipeline</h1>
          <p className="page-subtitle">Potential sellers - from walkthrough to MLS activation</p>
        </div>
        <div className="header-actions">
          <button className="btn btn-secondary" onClick={syncSheet} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync from Google Sheet'}
          </button>
          <button className="btn btn-primary" onClick={openNew}>+ New Pre-Listing</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search address or owner..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
      </div>

      <div className="project-grid">
        {items.length === 0 ? (
          <div className="empty-state-full">No pre-listings. Sync from Google Sheet or add one above.</div>
        ) : items.map(item => {
          const progress = getProgress(item)
          return (
            <div key={item.id} className="project-card" onClick={() => openEdit(item)}>
              <div className="project-card-header">
                <div className="project-card-title">{item.property_address}</div>
                <StatusBadge status={item.status?.toLowerCase().replace(/ /g, '_') || 'planning'} />
              </div>
              <div className="project-card-desc">{item.owner_name || 'No owner name'}</div>
              <div className="project-card-meta">
                <span>Walkthrough: {item.walkthrough}</span>
              </div>
              <div className="progress-bar" style={{marginTop: 8}}>
                <div className="progress-fill" style={{ width: `${progress}%`, backgroundColor: progress === 100 ? '#10b981' : '#3b82f6' }}></div>
                <span className="progress-label">{progress}%</span>
              </div>

              {/* Inline checklist */}
              <div className="prelisting-checklist" onClick={e => e.stopPropagation()}>
                {checklistItems.map(([key, label]) => (
                  <label key={key} className="checkbox-label mini-check" onClick={e => e.stopPropagation()}>
                    <input type="checkbox" checked={!!item[key]} onChange={() => toggleCheck(item, key)} />
                    <span className={item[key] ? 'checked-text' : ''}>{label}</span>
                  </label>
                ))}
              </div>

              <div className="project-card-actions" onClick={e => e.stopPropagation()}>
                <button className="btn-sm btn-danger" onClick={() => remove(item.id)}>Delete</button>
              </div>
            </div>
          )
        })}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Pre-Listing' : 'New Pre-Listing'}>
        <form onSubmit={save}>
          <label>Property Address<input value={form.property_address} onChange={e => f2('property_address', e.target.value)} required /></label>
          <label>Owner's Name<input value={form.owner_name} onChange={e => f2('owner_name', e.target.value)} /></label>
          <div className="form-row">
            <label>Walkthrough<select value={form.walkthrough} onChange={e => f2('walkthrough', e.target.value)}>
              <option value="Not Scheduled">Not Scheduled</option><option value="Scheduled">Scheduled</option>
              <option value="Pending">Pending</option><option value="Completed">Completed</option>
            </select></label>
            <label>Status<select value={form.status} onChange={e => f2('status', e.target.value)}>
              <option value="New">New</option><option value="In Progress">In Progress</option>
              <option value="Ready">Ready</option><option value="Listed">Listed</option>
            </select></label>
          </div>
          <h4 style={{marginTop: 16, color: 'var(--accent)'}}>Checklist</h4>
          <div className="checklist-grid">
            {checklistItems.map(([key, label]) => (
              <label key={key} className="checkbox-label">
                <input type="checkbox" checked={!!form[key]} onChange={() => check(key)} />
                {label}
              </label>
            ))}
          </div>
          <label>Notes<textarea value={form.notes} onChange={e => f2('notes', e.target.value)} rows={3} /></label>
          {editing && (
            <div style={{marginTop: 16, padding: '12px 14px', background: 'rgba(200, 155, 74, 0.08)', border: '1px solid rgba(200, 155, 74, 0.3)', borderRadius: 6}}>
              <h4 style={{margin: '0 0 8px', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.8, color: 'var(--accent)'}}>📧 Send Pre-Listing Email</h4>
              <p className="muted" style={{margin: '0 0 8px', fontSize: 12}}>Templates: photo day prep, walkthrough recap, listing agreement ready. Auto-CC the team.</p>
              <button type="button" className="btn btn-secondary" onClick={openEmail}>Open Email Composer</button>
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </Modal>

      <Modal open={emailOpen} onClose={() => setEmailOpen(false)} title="Send Pre-Listing Email" wide>
        <div className="field-group">
          <h4>Template</h4>
          <select value={emailForm.template_id} onChange={e => loadTpl(e.target.value)} style={{width: '100%'}}>
            <option value="">— Choose a template (or write from scratch) —</option>
            {emailTpls.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label>To (email)<input type="email" value={emailForm.to_email} onChange={e => setEmailForm(p => ({ ...p, to_email: e.target.value }))} /></label>
          <label>To (name)<input value={emailForm.to_name} onChange={e => setEmailForm(p => ({ ...p, to_name: e.target.value }))} /></label>
        </div>
        <div className="muted" style={{padding: '6px 10px', background: 'rgba(200, 155, 74, 0.08)', borderRadius: 4, marginBottom: 10}}>
          📋 Auto-CC: johnwithmattsmithteam@gmail.com, mattsmithremax@gmail.com
        </div>
        <label>Subject<input value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} style={{width: '100%'}} /></label>
        <label>Body<textarea rows={20} value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} style={{width: '100%', fontFamily: 'monospace', fontSize: 13}} /></label>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setEmailOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={sendEmail} disabled={emailSending || !emailForm.to_email}>
            {emailSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </Modal>
    </div>
  )
}
