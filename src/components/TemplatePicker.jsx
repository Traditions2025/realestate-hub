import React, { useState, useRef, useEffect } from 'react'

// Searchable template picker. Replaces the plain "Insert template…" <select> everywhere
// we compose a text/email: a button that opens a search box + filtered list. Clicking a
// template calls onPick(template). Matches on both the template name and its body.
export default function TemplatePicker({ templates, onPick, label = 'Insert template' }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef(null)
  const list = Array.isArray(templates) ? templates : []
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onEsc)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc) }
  }, [open])
  const plain = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
  const needle = q.trim().toLowerCase()
  const filtered = needle ? list.filter(t => (t.name || '').toLowerCase().includes(needle) || plain(t.body).toLowerCase().includes(needle)) : list
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
      <button type="button" className="btn btn-sm btn-secondary" onClick={() => { setOpen(o => !o); setQ('') }} style={{ fontSize: 12 }}
        title="Search and insert a saved template">📄 {label}{list.length ? ` (${list.length})` : ''} ▾</button>
      {open && (
        <div style={{ position: 'absolute', zIndex: 70, top: '100%', left: 0, marginTop: 4, width: 300, maxWidth: '86vw', background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 12px 32px rgba(0,0,0,0.28)', overflow: 'hidden' }}>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search templates…"
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: 'none', borderBottom: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', outline: 'none' }} />
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            {filtered.length === 0
              ? <div style={{ padding: '12px', fontSize: 12, color: 'var(--text-muted)' }}>{list.length ? 'No templates match.' : 'No templates yet.'}</div>
              : filtered.map(t => (
                <div key={t.id} onClick={() => { onPick(t); setOpen(false) }}
                  style={{ padding: '8px 11px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-secondary)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5, color: 'var(--text-primary)' }}>{t.name || '(untitled)'}</div>
                  {t.body && <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{plain(t.body).slice(0, 70)}</div>}
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}
