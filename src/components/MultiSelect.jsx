import React, { useState, useRef, useEffect } from 'react'

export default function MultiSelect({ label, options, selected, onChange, placeholder = 'Search...', mode = 'include' }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    setTimeout(() => document.addEventListener('click', handleClick), 0)
    return () => document.removeEventListener('click', handleClick)
  }, [open])

  // Normalize options to {value, label, count?}
  const normalized = (options || []).map(o =>
    typeof o === 'string' ? { value: o, label: o } : { value: o.value || o.tag || o.name, label: o.label || o.tag || o.name, count: o.count }
  )

  const term = search.toLowerCase().trim()
  const filtered = term
    ? normalized.filter(o => (o.label || '').toLowerCase().includes(term))
    : normalized

  const toggle = (value) => {
    if (selected.includes(value)) onChange(selected.filter(v => v !== value))
    else onChange([...selected, value])
  }

  const remove = (value, e) => {
    e.stopPropagation()
    onChange(selected.filter(v => v !== value))
  }

  const chipColor = mode === 'exclude' ? 'exclude' : 'include'

  return (
    <div className="ms-wrap" ref={ref}>
      <div className={`ms-input ${open ? 'open' : ''}`} onClick={() => setOpen(true)}>
        {selected.length === 0 && <span className="ms-placeholder">{placeholder}</span>}
        {selected.map(v => {
          const opt = normalized.find(o => o.value === v) || { value: v, label: v }
          return (
            <span key={v} className={`ms-chip ms-chip-${chipColor}`}>
              {opt.label}
              <button type="button" onClick={e => remove(v, e)} className="ms-chip-x">&times;</button>
            </span>
          )
        })}
        {open && (
          <input
            autoFocus
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={selected.length === 0 ? '' : 'Add more...'}
            className="ms-search"
            onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
          />
        )}
      </div>
      {open && filtered.length > 0 && (
        <div className="ms-dropdown">
          {filtered.slice(0, 50).map(o => (
            <button key={o.value} type="button" className={`ms-option ${selected.includes(o.value) ? 'selected' : ''}`}
              onClick={() => toggle(o.value)}>
              <span className="ms-check">{selected.includes(o.value) ? '✓' : ''}</span>
              <span className="ms-option-label">{o.label}</span>
              {o.count !== undefined && <span className="ms-option-count">{o.count}</span>}
            </button>
          ))}
          {filtered.length > 50 && (
            <div className="ms-dropdown-more">+{filtered.length - 50} more — keep typing to narrow down</div>
          )}
        </div>
      )}
      {open && filtered.length === 0 && (
        <div className="ms-dropdown">
          <div className="ms-dropdown-more">No matches</div>
        </div>
      )}
    </div>
  )
}
