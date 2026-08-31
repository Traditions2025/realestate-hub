import React, { useState, useRef, useEffect } from 'react'

// One control per filter dimension: search/add values, then flip each one between Include and
// Exclude with a per-value toggle. Manages two arrays (include, exclude) and reports both via
// onChange({ include, exclude }). Reuses the .ms-* styles from MultiSelect for the dropdown.
export default function IncludeExcludeSelect({ options, include = [], exclude = [], onChange, placeholder = 'Search...', format }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    setTimeout(() => document.addEventListener('click', h), 0)
    return () => document.removeEventListener('click', h)
  }, [open])

  const normalized = (options || []).map(o =>
    typeof o === 'string' ? { value: o, label: o } : { value: o.value || o.tag || o.name, label: o.label || o.tag || o.name, count: o.count })
  const labelFor = (v) => { if (format) return format(v); const o = normalized.find(x => x.value === v); return o ? o.label : v }
  const union = [...include, ...exclude]
  const term = search.toLowerCase().trim()
  const filtered = term ? normalized.filter(o => (o.label || '').toLowerCase().includes(term)) : normalized

  const add = (v) => { if (!union.includes(v)) onChange({ include: [...include, v], exclude }); setSearch('') }
  const setMode = (v, mode) => {
    if (mode === 'include') onChange({ include: [...include.filter(x => x !== v), v], exclude: exclude.filter(x => x !== v) })
    else onChange({ include: include.filter(x => x !== v), exclude: [...exclude.filter(x => x !== v), v] })
  }
  const remove = (v) => onChange({ include: include.filter(x => x !== v), exclude: exclude.filter(x => x !== v) })

  const seg = (active, color) => ({ padding: '2px 9px', fontSize: 11, fontWeight: 600, border: 'none', cursor: 'pointer', background: active ? color : 'transparent', color: active ? '#fff' : 'var(--text-muted)' })

  return (
    <div ref={ref}>
      <div className="ms-wrap">
        <div className={`ms-input ${open ? 'open' : ''}`} onClick={() => setOpen(true)}>
          {union.length === 0
            ? <span className="ms-placeholder">{placeholder}</span>
            : <span className="ms-placeholder">{union.length} selected ({include.length} incl, {exclude.length} excl)</span>}
          {open && (
            <input autoFocus type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Add..." className="ms-search" onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }} />
          )}
        </div>
        {open && (
          <div className="ms-dropdown">
            {filtered.slice(0, 50).map(o => (
              <button key={o.value} type="button" className={`ms-option ${union.includes(o.value) ? 'selected' : ''}`} onClick={() => add(o.value)}>
                <span className="ms-check">{include.includes(o.value) ? '✓' : exclude.includes(o.value) ? '✕' : ''}</span>
                <span className="ms-option-label">{o.label}</span>
                {o.count !== undefined && <span className="ms-option-count">{o.count}</span>}
              </button>
            ))}
            {filtered.length > 50 && <div className="ms-dropdown-more">+{filtered.length - 50} more — keep typing to narrow down</div>}
            {filtered.length === 0 && <div className="ms-dropdown-more">No matches</div>}
          </div>
        )}
      </div>
      {union.length > 0 && (
        <div style={{ display: 'grid', gap: 4, marginTop: 6 }}>
          {union.map(v => {
            const isExc = exclude.includes(v)
            return (
              <div key={v} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={labelFor(v)}>{labelFor(v)}</span>
                <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
                  <button type="button" onClick={() => setMode(v, 'include')} style={seg(!isExc, '#16a34a')}>Include</button>
                  <button type="button" onClick={() => setMode(v, 'exclude')} style={{ ...seg(isExc, '#dc2626'), borderLeft: '1px solid var(--border)' }}>Exclude</button>
                </div>
                <button type="button" onClick={() => remove(v)} title="Remove" style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, lineHeight: 1, flexShrink: 0 }}>&times;</button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
