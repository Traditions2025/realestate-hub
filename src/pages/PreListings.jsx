import React, { useState, useEffect, useRef } from 'react'
import { api, authFetch } from '../api'
import Modal from '../components/Modal'
import StatusBadge from '../components/StatusBadge'
import { inlineImagesIntoBody, autoEmbedYoutubeLinks } from '../components/inlineImages'
import EmailToolbar from '../components/EmailToolbar'

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
  const [emailTpls, setEmailTpls] = useState([])
  const [emailOpen, setEmailOpen] = useState(false)
  const [emailForm, setEmailForm] = useState({ template_id: '', to_email: '', to_name: '', subject: '', body: '', attachments: [] })
  const plEmailBodyRef = useRef(null)
  const [emailSending, setEmailSending] = useState(false)
  const [emailPreviewOpen, setEmailPreviewOpen] = useState(false)
  const [linkedClient, setLinkedClient] = useState(null)
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagData, setDiagData] = useState(null)
  const [diagLoading, setDiagLoading] = useState(false)

  const openDiagnostics = async () => {
    setDiagOpen(true)
    setDiagLoading(true)
    try {
      const r = await authFetch('/api/pre-listings/diagnostics')
      setDiagData(await r.json())
    } catch (err) {
      setDiagData({ error: err.message })
    } finally {
      setDiagLoading(false)
    }
  }

  const runCleanup = async (action) => {
    const label = action === 'flipToListed' ? 'flip matching to Listed'
      : action === 'mergeDuplicates' ? 'merge duplicates (newest kept, rest set to Withdrawn)'
      : 'flip + merge'
    if (!confirm(`Run cleanup: ${label}?`)) return
    setDiagLoading(true)
    try {
      const r = await authFetch('/api/pre-listings/cleanup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })
      const result = await r.json()
      alert(`Done. Flipped ${result.flippedCount || 0}, merged ${result.mergedCount || 0}.`)
      const r2 = await authFetch('/api/pre-listings/diagnostics')
      setDiagData(await r2.json())
      load()
    } catch (err) {
      alert('Cleanup failed: ' + err.message)
    } finally {
      setDiagLoading(false)
    }
  }

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

  // Google Sheet sync REMOVED 2026-05-14. The hub is the master file.

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
          attachments: emailForm.attachments || [],
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
          <button className="btn btn-secondary" onClick={openDiagnostics} title="Find duplicates and pre-listings that should be Listed">
            Diagnostics
          </button>
          <button className="btn btn-primary" onClick={openNew}>+ New Pre-Listing</button>
        </div>
      </div>

      <div className="toolbar">
        <input type="text" placeholder="Search address or owner..." value={search} onChange={e => setSearch(e.target.value)} className="search-input" />
      </div>

      <div className="project-grid">
        {(() => {
          // Hide pre-listings that have been promoted to a Listing/Transaction
          // (status='Listed') or pulled off the market ('Withdrawn'/'Cancelled').
          // They stay in the DB for history but shouldn't clutter the active view.
          const HIDE = new Set(['Listed', 'Withdrawn', 'Cancelled'])
          const visible = items.filter(it => !HIDE.has(it.status))
          if (visible.length === 0) {
            return <div className="empty-state-full">No active pre-listings. Click + New Pre-Listing to add one.</div>
          }
          return visible.map(item => {
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
          })
        })()}
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
          <label>To (email — separate multiple with comma)
            <input
              type="text"
              value={emailForm.to_email}
              onChange={e => setEmailForm(p => ({ ...p, to_email: e.target.value }))}
              placeholder="kevin@example.com, sara@example.com"
            />
          </label>
          <label>To (name)<input value={emailForm.to_name} onChange={e => setEmailForm(p => ({ ...p, to_name: e.target.value }))} /></label>
        </div>
        <div className="muted" style={{padding: '6px 10px', background: 'rgba(200, 155, 74, 0.08)', borderRadius: 4, marginBottom: 10}}>
          📋 Auto-CC: johnwithmattsmithteam@gmail.com, mattsmithremax@gmail.com
        </div>
        <label>Subject<input value={emailForm.subject} onChange={e => setEmailForm(p => ({ ...p, subject: e.target.value }))} style={{width: '100%'}} /></label>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, marginTop: 8}}>
          <span style={{fontSize: 13, fontWeight: 500}}>Body</span>
          <div style={{display: 'flex', gap: 6}}>
            <label className="btn btn-sm btn-secondary" style={{cursor: 'pointer', margin: 0, position: 'relative', overflow: 'hidden'}}>
              📁 Load HTML File
              <input
                type="file"
                accept=".html,.htm,text/html"
                style={{position: 'absolute', opacity: 0, top: 0, left: 0, width: '100%', height: '100%', cursor: 'pointer'}}
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const text = await file.text()
                  setEmailForm(p => ({ ...p, body: text }))
                  e.target.value = ''
                }}
              />
            </label>
            <button type="button" className="btn btn-sm btn-secondary" disabled={!emailForm.body} onClick={() => setEmailPreviewOpen(true)}>👁 Preview</button>
          </div>
        </div>
        <EmailToolbar
          textareaRef={plEmailBodyRef}
          body={emailForm.body}
          setBody={(b) => setEmailForm(p => ({ ...p, body: b }))}
          showPreview={false}
          compact
        />
        <textarea ref={plEmailBodyRef} rows={20} value={emailForm.body} onChange={e => setEmailForm(p => ({ ...p, body: e.target.value }))} style={{width: '100%', fontFamily: 'monospace', fontSize: 13, resize: 'vertical'}} />
        <p className="muted" style={{fontSize: 11, margin: '2px 0 0'}}>
          📁 Load HTML · 📷 Inline Images (so they render) · plain text auto-formats.
        </p>

        <div className="field-group">
          <h4>📎 Attachments</h4>
          <input
            type="file"
            multiple
            onChange={async (e) => {
              const files = Array.from(e.target.files || [])
              if (!files.length) return
              const newAtt = await Promise.all(files.map(file => new Promise((resolve, reject) => {
                const reader = new FileReader()
                reader.onload = () => resolve({
                  filename: file.name,
                  type: file.type || 'application/octet-stream',
                  size: file.size,
                  content_base64: reader.result.toString().split(',')[1],
                })
                reader.onerror = reject
                reader.readAsDataURL(file)
              })))
              setEmailForm(p => ({ ...p, attachments: [...(p.attachments || []), ...newAtt] }))
              e.target.value = ''
            }}
          />
          {(emailForm.attachments || []).length > 0 && (
            <div style={{marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6}}>
              {emailForm.attachments.map((att, i) => (
                <span key={i} className="lead-tag" style={{padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6}}>
                  📎 {att.filename} ({(att.size / 1024).toFixed(0)} KB)
                  <button
                    type="button"
                    onClick={() => setEmailForm(p => ({ ...p, attachments: p.attachments.filter((_, idx) => idx !== i) }))}
                    style={{background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 14}}
                  >✕</button>
                </span>
              ))}
            </div>
          )}
          <p className="muted" style={{fontSize: 11, margin: '4px 0 0'}}>SendGrid limit: 30 MB total.</p>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setEmailOpen(false)}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={sendEmail} disabled={emailSending || !emailForm.to_email}>
            {emailSending ? 'Sending...' : 'Send Email'}
          </button>
        </div>
      </Modal>

      <Modal open={diagOpen} onClose={() => setDiagOpen(false)} title="Pre-Listing Diagnostics" wide>
        {diagLoading && <div style={{padding: 20, textAlign: 'center'}}>Loading...</div>}
        {!diagLoading && diagData && diagData.error && (
          <div style={{color: '#ef4444', padding: 12}}>Error: {diagData.error}</div>
        )}
        {!diagLoading && diagData && !diagData.error && (
          <div style={{display: 'flex', flexDirection: 'column', gap: 16}}>
            <div style={{padding: '10px 14px', background: 'var(--bg-elevated)', borderRadius: 6, fontSize: 13}}>
              <strong>{diagData.summary.shouldBeListedCount}</strong> pre-listing(s) match an active transaction or listing and should be flipped to <em>Listed</em>.<br/>
              <strong>{diagData.summary.duplicateGroups}</strong> address(es) appear on multiple pre-listing rows ({diagData.summary.duplicateRows} total rows).
            </div>

            <div>
              <h3 style={{margin: '0 0 8px'}}>Should be Listed ({diagData.shouldBeListed.length})</h3>
              {diagData.shouldBeListed.length === 0 && <div style={{color: 'var(--text-muted)', fontSize: 13}}>None.</div>}
              {diagData.shouldBeListed.length > 0 && (
                <table style={{width: '100%', fontSize: 13, borderCollapse: 'collapse'}}>
                  <thead><tr style={{textAlign: 'left', borderBottom: '1px solid var(--border)'}}>
                    <th style={{padding: 6}}>Address</th><th style={{padding: 6}}>Owner</th>
                    <th style={{padding: 6}}>Current Status</th><th style={{padding: 6}}>Matched With</th>
                  </tr></thead>
                  <tbody>
                    {diagData.shouldBeListed.map(pl => (
                      <tr key={pl.id} style={{borderBottom: '1px solid var(--border)'}}>
                        <td style={{padding: 6}}>{pl.property_address}</td>
                        <td style={{padding: 6}}>{pl.owner_name || '-'}</td>
                        <td style={{padding: 6}}>{pl.status}</td>
                        <td style={{padding: 6}}>{pl.matched_with.kind} #{pl.matched_with.id}{pl.matched_with.status ? ` (${pl.matched_with.status})` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div>
              <h3 style={{margin: '0 0 8px'}}>Duplicate Address Groups ({diagData.duplicates.length})</h3>
              {diagData.duplicates.length === 0 && <div style={{color: 'var(--text-muted)', fontSize: 13}}>None.</div>}
              {diagData.duplicates.map(g => (
                <div key={g.normalized} style={{border: '1px solid var(--border)', borderRadius: 4, padding: 8, marginBottom: 8}}>
                  <div style={{fontSize: 12, color: 'var(--text-muted)', marginBottom: 4}}>{g.normalized}</div>
                  <table style={{width: '100%', fontSize: 13, borderCollapse: 'collapse'}}>
                    <tbody>
                      {g.rows.map((pl, i) => (
                        <tr key={pl.id} style={{borderBottom: '1px solid var(--border)'}}>
                          <td style={{padding: 4, width: 80}}>{i === 0 ? <strong style={{color: '#10b981'}}>KEEP</strong> : <span style={{color: '#ef4444'}}>withdraw</span>}</td>
                          <td style={{padding: 4}}>{pl.property_address}</td>
                          <td style={{padding: 4}}>{pl.status}</td>
                          <td style={{padding: 4, fontSize: 11, color: 'var(--text-muted)'}}>updated {pl.updated_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            <div className="form-actions" style={{borderTop: '1px solid var(--border)', paddingTop: 12}}>
              <button className="btn btn-secondary" onClick={() => setDiagOpen(false)}>Close</button>
              <button className="btn btn-secondary" disabled={diagData.shouldBeListed.length === 0} onClick={() => runCleanup('flipToListed')}>
                Flip {diagData.shouldBeListed.length} to Listed
              </button>
              <button className="btn btn-secondary" disabled={diagData.duplicates.length === 0} onClick={() => runCleanup('mergeDuplicates')}>
                Merge {diagData.duplicates.length} duplicate groups
              </button>
              <button className="btn btn-primary" disabled={diagData.shouldBeListed.length === 0 && diagData.duplicates.length === 0} onClick={() => runCleanup('both')}>
                Fix all
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={emailPreviewOpen} onClose={() => setEmailPreviewOpen(false)} title="Email Preview" wide>
        <div>
          <div style={{padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 4, marginBottom: 8, fontSize: 13}}>
            <strong>To:</strong> {emailForm.to_email || '(no recipient)'}<br/>
            <strong>Subject:</strong> {emailForm.subject || '(no subject)'}
          </div>
          <iframe
            title="Email preview"
            srcDoc={autoEmbedYoutubeLinks(emailForm.body || '')}
            style={{width: '100%', height: '60vh', border: '1px solid var(--border)', borderRadius: 4, background: 'white'}}
          />
          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setEmailPreviewOpen(false)}>Close</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
