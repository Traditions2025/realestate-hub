import React, { useState, useEffect, useMemo } from 'react'
import Modal from './Modal'
import { authFetch } from '../api'

// Normalized item shape: { id, name, company, phone, email, website, role }
// kind: 'vendor' | 'partner'  — used for labels + catalog endpoint

const CATALOG_ENDPOINTS = {
  vendor: '/api/vendors',
  partner: '/api/partners',
}

function normalizeItem(raw, kind) {
  if (!raw) return null
  if (kind === 'partner') {
    return {
      id: raw.id,
      name: raw.name || '',
      company: raw.company || '',
      phone: raw.phone || '',
      email: raw.email || '',
      website: raw.website || '',
      role: raw.role || '',
    }
  }
  // vendor (default)
  return {
    id: raw.id,
    name: raw.contact_name || raw.company_name || '',
    company: raw.company_name || '',
    phone: raw.phone || '',
    email: raw.email || '',
    website: raw.website || '',
    role: raw.category || '',
  }
}

function buildBody(items, recommendationFor) {
  const blocks = items.map(v => {
    const lines = []
    const headline = v.company ? `${v.company}${v.name && v.name !== v.company ? ' — ' + v.name : ''}` : v.name
    lines.push(headline)
    if (v.role) lines.push(v.role)
    if (v.phone) lines.push('Phone: ' + v.phone)
    if (v.email) lines.push('Email: ' + v.email)
    if (v.website) lines.push('Website: ' + v.website)
    return lines.join('\n')
  }).join('\n\n')

  const intro = recommendationFor
    ? `Per your request, here are my recommended vendors for ${recommendationFor}:`
    : `Here are my recommended vendors:`

  return `Hi {{first_name}},

${intro}

${blocks}

Let me know if you'd like an introduction, or if you have any questions about who they are or the work they've done with us.

Thanks,
Matt Smith Team
(319) 431-5859 | matt@mattsmithteam.com`
}

function buildSubject(items, recommendationFor) {
  const names = items.map(v => v.company || v.name).filter(Boolean).slice(0, 3).join(', ')
  if (recommendationFor) return `Recommended ${recommendationFor.toLowerCase()}: ${names}`
  return `Recommended: ${names}`
}

export default function RecommendModal({ open, onClose, kind = 'vendor', initialItems = [] }) {
  const [items, setItems] = useState([])
  const [recommendationFor, setRecommendationFor] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [touchedSubject, setTouchedSubject] = useState(false)
  const [touchedBody, setTouchedBody] = useState(false)

  // Catalog (other vendors/partners to add)
  const [catalog, setCatalog] = useState([])
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)

  // Recipients (clients)
  const [recipients, setRecipients] = useState([])
  const [clientSearch, setClientSearch] = useState('')
  const [clientResults, setClientResults] = useState([])
  const [clientOpen, setClientOpen] = useState(false)

  const [previewOpen, setPreviewOpen] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (!open) return
    setItems(initialItems.map(it => normalizeItem(it, kind)).filter(Boolean))
    setRecipients([])
    setRecommendationFor('')
    setTouchedSubject(false)
    setTouchedBody(false)
    setCatalogSearch('')
    setClientSearch('')
    setCatalogOpen(false)
    setClientOpen(false)
  }, [open]) // eslint-disable-line

  // Load full catalog once when opened
  useEffect(() => {
    if (!open) return
    authFetch(CATALOG_ENDPOINTS[kind])
      .then(r => r.json())
      .then(rows => setCatalog(rows.map(r => normalizeItem(r, kind))))
      .catch(() => setCatalog([]))
  }, [open, kind])

  // Auto-rebuild subject/body unless user has manually edited them
  useEffect(() => {
    if (!touchedSubject) setSubject(items.length ? buildSubject(items, recommendationFor) : '')
    if (!touchedBody) setBody(items.length ? buildBody(items, recommendationFor) : '')
  }, [items, recommendationFor]) // eslint-disable-line

  // Debounced client search
  useEffect(() => {
    if (clientSearch.trim().length < 2) { setClientResults([]); return }
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ search: clientSearch, limit: 20 })
      authFetch('/api/clients?' + params)
        .then(r => r.json())
        .then(rows => setClientResults((rows || []).filter(c => c.email)))
        .catch(() => setClientResults([]))
    }, 300)
    return () => clearTimeout(handle)
  }, [clientSearch])

  const filteredCatalog = useMemo(() => {
    const selectedIds = new Set(items.map(i => i.id))
    const term = catalogSearch.trim().toLowerCase()
    return catalog
      .filter(c => !selectedIds.has(c.id))
      .filter(c => !term || (c.name + ' ' + c.company + ' ' + c.role).toLowerCase().includes(term))
      .slice(0, 30)
  }, [catalog, catalogSearch, items])

  const addItem = (item) => {
    setItems(prev => [...prev, item])
    setCatalogSearch('')
    setCatalogOpen(false)
  }
  const removeItem = (id) => setItems(prev => prev.filter(i => i.id !== id))

  const addRecipient = (c) => {
    if (recipients.some(r => r.id === c.id)) return
    setRecipients(prev => [...prev, c])
    setClientSearch('')
    setClientOpen(false)
  }
  const removeRecipient = (id) => setRecipients(prev => prev.filter(r => r.id !== id))

  const send = async () => {
    if (recipients.length === 0) { alert('Add at least one client recipient.'); return }
    if (items.length === 0) { alert('Add at least one ' + kind + ' to recommend.'); return }
    if (!subject || !body) { alert('Subject and body are required.'); return }
    setSending(true)
    try {
      const r = await authFetch('/api/email/bulk', {
        method: 'POST',
        body: JSON.stringify({
          client_ids: recipients.map(r => r.id),
          subject,
          body,
          template: '',
        }),
      })
      const d = await r.json()
      if (d.error) { alert('Send failed: ' + d.error); return }
      alert(`✓ Sent recommendation to ${d.sent || recipients.length} recipient${recipients.length === 1 ? '' : 's'}` + (d.failed ? ` (${d.failed} failed)` : ''))
      onClose?.()
    } catch (e) {
      alert('Send failed: ' + e.message)
    } finally {
      setSending(false)
    }
  }

  if (!open) return null

  const sample = recipients[0] || { first_name: 'there', last_name: '', email: '' }
  const renderedSubject = subject.replace(/\{\{first_name\}\}/g, sample.first_name)
  const renderedBody = body.replace(/\{\{first_name\}\}/g, sample.first_name)

  return (
    <>
      <Modal open={open} onClose={onClose} title={`Recommend ${kind === 'partner' ? 'Partners' : 'Vendors'} to Client(s)`} wide>
        {/* Selected items */}
        <div className="field-group">
          <h4>Recommending ({items.length})</h4>
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8}}>
            {items.map(it => (
              <span key={it.id} className="lead-tag" style={{padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6}}>
                {it.company || it.name}
                <button type="button" onClick={() => removeItem(it.id)} style={{background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 14}}>✕</button>
              </span>
            ))}
            {items.length === 0 && <span className="muted">No {kind}s selected yet</span>}
          </div>
          <div style={{position: 'relative'}}>
            <input
              type="text"
              placeholder={`+ Add another ${kind}...`}
              value={catalogSearch}
              onChange={e => { setCatalogSearch(e.target.value); setCatalogOpen(true) }}
              onFocus={() => setCatalogOpen(true)}
              onBlur={() => setTimeout(() => setCatalogOpen(false), 200)}
              style={{width: '100%'}}
            />
            {catalogOpen && filteredCatalog.length > 0 && (
              <div className="addr-suggestions">
                {filteredCatalog.map(c => (
                  <div key={c.id} className="addr-suggestion" onMouseDown={() => addItem(c)}>
                    <div className="addr-suggestion-line1">{c.company || c.name}</div>
                    <div className="addr-suggestion-line2">
                      {c.role}{c.phone ? ' · ' + c.phone : ''}{c.email ? ' · ' + c.email : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recipients */}
        <div className="field-group">
          <h4>Send to ({recipients.length})</h4>
          <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8}}>
            {recipients.map(c => (
              <span key={c.id} className="lead-tag" style={{padding: '5px 10px', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(59, 130, 246, 0.18)', color: '#93c5fd'}}>
                {c.first_name} {c.last_name}
                <button type="button" onClick={() => removeRecipient(c.id)} style={{background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 14}}>✕</button>
              </span>
            ))}
            {recipients.length === 0 && <span className="muted">No clients selected — search below to add</span>}
          </div>
          <div style={{position: 'relative'}}>
            <input
              type="text"
              placeholder="Search client by name or email..."
              value={clientSearch}
              onChange={e => { setClientSearch(e.target.value); setClientOpen(true) }}
              onFocus={() => setClientOpen(true)}
              onBlur={() => setTimeout(() => setClientOpen(false), 200)}
              style={{width: '100%'}}
            />
            {clientOpen && clientResults.length > 0 && (
              <div className="addr-suggestions">
                {clientResults.map(c => (
                  <div key={c.id} className="addr-suggestion" onMouseDown={() => addRecipient(c)}>
                    <div className="addr-suggestion-line1">{c.first_name} {c.last_name}</div>
                    <div className="addr-suggestion-line2">{c.email}{c.city ? ' · ' + c.city : ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Recommendation context */}
        <div className="field-group">
          <h4>Recommendation for (optional)</h4>
          <input
            type="text"
            placeholder="e.g. roof inspection, foundation work, home inspection"
            value={recommendationFor}
            onChange={e => setRecommendationFor(e.target.value)}
            style={{width: '100%'}}
          />
          <p className="muted" style={{fontSize: 11, margin: '4px 0 0'}}>Used in the subject + intro line. Leave blank for a generic recommendation.</p>
        </div>

        {/* Subject + body — auto-built but editable */}
        <div className="field-group">
          <h4>Subject</h4>
          <input
            type="text"
            value={subject}
            onChange={e => { setSubject(e.target.value); setTouchedSubject(true) }}
            style={{width: '100%'}}
          />
        </div>
        <div className="field-group">
          <h4>Body (use <code>{'{{first_name}}'}</code> for personalization)</h4>
          <textarea
            rows={12}
            value={body}
            onChange={e => { setBody(e.target.value); setTouchedBody(true) }}
            style={{width: '100%', fontFamily: 'monospace', fontSize: 13}}
          />
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-secondary" disabled={!recipients.length} onClick={() => setPreviewOpen(true)}>
            👁 Preview
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={sending || !recipients.length || !items.length}
            onClick={send}
          >
            {sending ? 'Sending...' : `Send to ${recipients.length} recipient${recipients.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </Modal>

      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} title="Email Preview" wide>
        <p className="muted">Sample using <strong>{sample.first_name} {sample.last_name}</strong> ({sample.email})</p>
        <div className="email-preview">
          <div className="email-preview-line"><strong>To:</strong> {sample.email}</div>
          <div className="email-preview-line"><strong>Subject:</strong> {renderedSubject}</div>
          <hr style={{margin: '12px 0', borderColor: 'var(--border)'}} />
          <div className="email-preview-body" style={{whiteSpace: 'pre-wrap'}}>{renderedBody}</div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setPreviewOpen(false)}>Close</button>
          <button type="button" className="btn btn-primary" onClick={send} disabled={sending}>
            {sending ? 'Sending...' : `Send to ${recipients.length}`}
          </button>
        </div>
      </Modal>
    </>
  )
}
