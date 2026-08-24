import React, { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../api'

// P1-5: Smart Audiences — a visual AND/OR condition builder over behavioral + CRM signals.
// Builds a v2 filter tree, previews the live count, and saves it as a dynamic list.
// SEGMENTATION ONLY: this screen never sends anything.

const OP_LABEL = {
  eq: 'is', ne: 'is not', gt: '>', gte: '≥', lt: '<', lte: '≤', between: 'between',
  in: 'is any of', not_in: 'is none of', contains: 'contains', not_contains: 'does not contain',
  is_null: 'is empty', not_null: 'is set', is_true: 'is yes', is_false: 'is no',
}
const NO_VALUE = new Set(['is_null', 'not_null', 'is_true', 'is_false'])
const LIST_OPS = new Set(['in', 'not_in'])

const blankCond = (fields) => ({ field: fields[0]?.key || 'type', op: (fields[0]?.ops || ['eq'])[0], value: '' })

export default function SmartAudiences() {
  const [fields, setFields] = useState([])
  const [match, setMatch] = useState('all')          // all = AND, any = OR
  const [conds, setConds] = useState([])
  const [preview, setPreview] = useState(null)
  const [busy, setBusy] = useState(false)
  const [lists, setLists] = useState([])
  const [name, setName] = useState('')
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    authFetch('/api/lists/smart/fields').then(r => r.json()).then(f => {
      setFields(f); setConds([blankCond(f)])
    }).catch(() => {})
    refreshLists()
  }, [])
  const refreshLists = () => authFetch('/api/lists').then(r => r.json()).then(d => setLists(Array.isArray(d) ? d : [])).catch(() => {})

  const fieldOf = (key) => fields.find(f => f.key === key)
  const tree = useCallback(() => {
    const leaves = conds.filter(c => c.field && c.op).map(c => {
      const f = fieldOf(c.field)
      if (NO_VALUE.has(c.op)) return { field: c.field, op: c.op }
      if (c.op === 'between') return { field: c.field, op: c.op, value: [Number(c.value), Number(c.value2)] }
      if (LIST_OPS.has(c.op)) return { field: c.field, op: c.op, value: String(c.value).split(',').map(s => s.trim()).filter(Boolean) }
      return { field: c.field, op: c.op, value: f?.type === 'num' ? Number(c.value) : c.value }
    })
    return { version: 2, tree: { [match]: leaves } }
  }, [conds, match, fields])

  // Live preview (debounced).
  useEffect(() => {
    if (!fields.length) return
    const t = setTimeout(() => {
      setBusy(true)
      authFetch('/api/lists/smart/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tree()) })
        .then(r => r.json()).then(d => setPreview(d && !d.error ? d : { error: d?.error || 'error' })).catch(() => setPreview(null)).finally(() => setBusy(false))
    }, 350)
    return () => clearTimeout(t)
  }, [tree, fields.length])

  const setCond = (i, patch) => setConds(cs => cs.map((c, j) => j === i ? { ...c, ...patch } : c))
  const changeField = (i, key) => { const f = fieldOf(key); setCond(i, { field: key, op: (f?.ops || ['eq'])[0], value: '', value2: '' }) }
  const addCond = () => setConds(cs => [...cs, blankCond(fields)])
  const removeCond = (i) => setConds(cs => cs.length > 1 ? cs.filter((_, j) => j !== i) : cs)

  const save = async () => {
    if (!name.trim()) { setSaveMsg('Name the audience first.'); return }
    setSaveMsg('')
    const r = await authFetch('/api/lists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), description: `Smart audience · ${preview?.count ?? 0} contacts`, filter_criteria: tree(), is_dynamic: true }),
    })
    if (r.ok) { setSaveMsg('Saved as a dynamic list.'); setName(''); refreshLists() }
    else setSaveMsg('Could not save.')
  }

  const groups = [...new Set(fields.map(f => f.group))]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Smart Audiences</h1>
          <p className="page-subtitle">Build a segment from behavior and CRM signals. This never sends — it defines who a campaign could target.</p>
        </div>
      </div>

      <div className="detail-section" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontWeight: 600 }}>Match</span>
          <select className="input" style={{ width: 'auto' }} value={match} onChange={e => setMatch(e.target.value)}>
            <option value="all">ALL conditions (AND)</option>
            <option value="any">ANY condition (OR)</option>
          </select>
          <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>of the following:</span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {conds.map((c, i) => {
            const f = fieldOf(c.field)
            const ops = f?.ops || ['eq']
            return (
              <div key={i} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <select className="input" style={{ width: 'auto', minWidth: 190 }} value={c.field} onChange={e => changeField(i, e.target.value)}>
                  {groups.map(g => (
                    <optgroup key={g} label={g}>
                      {fields.filter(x => x.group === g).map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
                    </optgroup>
                  ))}
                </select>
                <select className="input" style={{ width: 'auto' }} value={c.op} onChange={e => setCond(i, { op: e.target.value })}>
                  {ops.map(o => <option key={o} value={o}>{OP_LABEL[o] || o}</option>)}
                </select>
                {!NO_VALUE.has(c.op) && (
                  c.op === 'between' ? (
                    <>
                      <input className="input" style={{ width: 90 }} placeholder="min" value={c.value || ''} onChange={e => setCond(i, { value: e.target.value })} />
                      <span style={{ color: 'var(--text-muted)' }}>and</span>
                      <input className="input" style={{ width: 90 }} placeholder="max" value={c.value2 || ''} onChange={e => setCond(i, { value2: e.target.value })} />
                    </>
                  ) : (
                    <input className="input" style={{ width: 220 }} placeholder={LIST_OPS.has(c.op) ? 'comma, separated, values' : (f?.type === 'num' ? 'number' : 'value')} value={c.value || ''} onChange={e => setCond(i, { value: e.target.value })} />
                  )
                )}
                <button className="btn btn-sm btn-secondary" onClick={() => removeCond(i)} title="Remove" disabled={conds.length === 1}>✕</button>
              </div>
            )
          })}
        </div>
        <button className="btn btn-sm" style={{ marginTop: 12 }} onClick={addCond}>+ Add condition</button>
      </div>

      {/* Live preview */}
      <div className="detail-section" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--text-primary)' }}>
            {preview?.error ? '—' : (preview ? preview.count.toLocaleString() : '…')}
          </div>
          <div style={{ color: 'var(--text-muted)' }}>{busy ? 'updating…' : 'contacts match'}{preview?.error && <span style={{ color: '#ef4444' }}> · {preview.error}</span>}</div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="input" style={{ width: 220 }} placeholder="Name this audience" value={name} onChange={e => setName(e.target.value)} />
            <button className="btn btn-primary" onClick={save} disabled={!preview || preview.error}>Save as list</button>
          </div>
        </div>
        {saveMsg && <div style={{ fontSize: 12.5, color: saveMsg.startsWith('Saved') ? '#10b981' : '#b45309', marginTop: 6 }}>{saveMsg}</div>}
        {preview?.sample?.length > 0 && (
          <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {preview.sample.slice(0, 12).map(s => (
              <span key={s.id} style={{ fontSize: 12, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 9px' }}>
                {`${s.first_name || ''} ${s.last_name || ''}`.trim() || s.phone}{s.city ? ` · ${s.city}` : ''}
              </span>
            ))}
            {preview.count > 12 && <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center' }}>+{(preview.count - 12).toLocaleString()} more</span>}
          </div>
        )}
      </div>

      {/* Saved lists */}
      {lists.length > 0 && (
        <div className="detail-section">
          <h4 style={{ marginTop: 0 }}>Saved lists</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {lists.slice(0, 20).map(l => (
              <div key={l.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13, padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontWeight: 600 }}>{l.name}</span>
                {l.is_dynamic ? <span style={{ fontSize: 10, color: '#0369a1', textTransform: 'uppercase' }}>dynamic</span> : null}
                <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{(l.count ?? 0).toLocaleString()} contacts</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
