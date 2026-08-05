import React, { useState } from 'react'
import RichTextEditor from '../RichTextEditor'
import {
  getDef, CONDITION_FIELDS, OPERATORS, operatorsForType, STATUSES, TEAM, MERGE_VARS, validateNode,
} from '../../../shared/automationRegistry.js'

const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, marginTop: 4 }
const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 12, fontWeight: 500 }
const help = { fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }

const asArray = (v) => Array.isArray(v) ? v : (v == null || v === '' ? [] : String(v).split(',').map(s => s.trim()).filter(Boolean))

export default function ConfigDrawer({ node, graph, templates = [], automations = [], onChange, onClose, onDelete, onDuplicate, onTest }) {
  const def = getDef(node)
  const c = node.config || {}
  const set = (patch) => onChange({ ...c, ...patch })
  const errs = validateNode(node)

  if (!def) return null
  const shouldShow = (field) => !field.showIf || Object.entries(field.showIf).every(([k, v]) => c[k] === v)

  const renderField = (field) => {
    if (!shouldShow(field)) return null
    const v = c[field.key]
    const common = { style: inp, value: v ?? '', onChange: e => set({ [field.key]: e.target.value }) }
    let control
    switch (field.type) {
      case 'textarea': control = <textarea {...common} style={{ ...inp, minHeight: 70 }} placeholder={field.placeholder} />; break
      case 'number': case 'percent': control = <input type="number" {...common} placeholder={field.placeholder} />; break
      case 'time': control = <input type="time" {...common} />; break
      case 'date': control = <input type="date" {...common} />; break
      case 'toggle': control = (
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 4 }}>
          <input type="checkbox" checked={!!v} onChange={e => set({ [field.key]: e.target.checked })} /> <span style={{ fontSize: 13 }}>{field.label}</span>
        </label>); break
      case 'select': control = (
        <select {...common}>
          <option value="">—</option>
          {(field.options || []).map(o => { const val = o.value ?? o; const label = o.label ?? o; return <option key={val} value={val}>{label}</option> })}
        </select>); break
      case 'status': control = <select {...common}><option value="">—</option>{STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>; break
      case 'agent': control = <select {...common}><option value="">—</option>{TEAM.map(t => <option key={t} value={t}>{t}</option>)}</select>; break
      case 'template': control = <select {...common}><option value="">— none —</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>; break
      case 'automation_ref': control = <select {...common}><option value="">—</option>{automations.filter(a => a.id !== node._autoId).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select>; break
      case 'node_ref': control = <select {...common}><option value="">—</option>{(graph?.nodes || []).filter(n => n.id !== node.id && n.kind !== 'trigger').map(n => <option key={n.id} value={n.id}>{getDef(n)?.label || n.type}</option>)}</select>; break
      case 'tags': case 'multiselect': control = <input style={inp} value={asArray(v).join(', ')} onChange={e => set({ [field.key]: asArray(e.target.value) })} placeholder={field.placeholder || 'comma, separated'} />; break
      case 'richtext': control = <div style={{ marginTop: 4 }}><RichTextEditor value={v || ''} onChange={html => set({ [field.key]: html })} /></div>; break
      default: control = <input {...common} placeholder={field.placeholder} />
    }
    if (field.type === 'toggle') return <div key={field.key} style={{ marginBottom: 12 }}>{control}{field.help && <div style={help}>{field.help}</div>}</div>
    return (
      <label key={field.key} style={lbl}>
        {field.label}{field.required && <span style={{ color: '#ef4444' }}> *</span>}
        {control}
        {field.help && <div style={help}>{field.help}</div>}
      </label>
    )
  }

  return (
    <div role="dialog" aria-label={`Configure ${def.label}`} style={{ width: 340, borderLeft: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 18 }}>{def.icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{def.label}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{def.desc}</div>
        </div>
        <button className="btn btn-sm btn-secondary" onClick={onClose} aria-label="Close">✕</button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {!def.live && <div style={{ background: '#fef3c7', color: '#92400e', padding: '8px 10px', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>⏳ This step is coming soon. You can add it to visualize the flow, but the automation can’t be activated while it’s in use.</div>}

        {node.type === 'condition' ? (
          <ConditionEditor c={c} set={set} />
        ) : node.type === 'branch' ? (
          <>
            {(def.config || []).map(renderField)}
            <div style={help}>Each value becomes its own path on the canvas, plus an “Other” path for everything else.</div>
          </>
        ) : (
          (def.config || []).map(renderField)
        )}

        {node.type === 'send_email' && (
          <div style={{ marginTop: 8, padding: 10, border: '1px dashed var(--border)', borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>Personalization — click to copy</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {MERGE_VARS.map(m => <button key={m.token} type="button" title={m.label} onClick={() => navigator.clipboard?.writeText(m.token)} style={{ fontSize: 11, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: 'var(--text-primary)' }}>{m.token}</button>)}
            </div>
          </div>
        )}

        {errs.length > 0 && (
          <div style={{ marginTop: 14, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '8px 10px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#ef4444', marginBottom: 4 }}>⚠ Needs attention</div>
            {errs.map((e, i) => <div key={i} style={{ fontSize: 12, color: 'var(--text-primary)' }}>• {e}</div>)}
          </div>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 16px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {node.kind === 'action' && def.live && <button className="btn btn-sm btn-secondary" onClick={() => onTest && onTest(node)}>Test</button>}
        {node.kind !== 'trigger' && <button className="btn btn-sm btn-secondary" onClick={() => onDuplicate(node.id)}>Duplicate</button>}
        {node.kind !== 'trigger' && <button className="btn btn-sm btn-danger" onClick={() => onDelete(node.id)} style={{ marginLeft: 'auto' }}>Delete step</button>}
      </div>
    </div>
  )
}

function ConditionEditor({ c, set }) {
  const rules = c.rules || []
  const update = (i, patch) => set({ rules: rules.map((r, j) => j === i ? { ...r, ...patch } : r) })
  const add = () => set({ rules: [...rules, { field: '', op: 'is', value: '' }] })
  const del = (i) => set({ rules: rules.filter((_, j) => j !== i) })
  return (
    <>
      <label style={lbl}>Match
        <select style={inp} value={c.logic || 'and'} onChange={e => set({ logic: e.target.value })}>
          <option value="and">ALL conditions (AND)</option>
          <option value="or">ANY condition (OR)</option>
        </select>
      </label>
      {rules.map((r, i) => {
        const fieldDef = CONDITION_FIELDS.find(f => f.value === r.field)
        const ops = fieldDef ? operatorsForType(fieldDef.type) : OPERATORS.map(o => o.value)
        const opDef = OPERATORS.find(o => o.value === r.op)
        return (
          <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Rule {i + 1}</span>
              <button className="btn btn-sm btn-danger" style={{ padding: '1px 7px' }} onClick={() => del(i)}>✕</button>
            </div>
            <select style={{ ...inp, marginTop: 0, marginBottom: 6 }} value={r.field || ''} onChange={e => { const fd = CONDITION_FIELDS.find(f => f.value === e.target.value); update(i, { field: e.target.value, op: operatorsForType(fd?.type)[0], value: '' }) }}>
              <option value="">— pick field —</option>
              {CONDITION_FIELDS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <select style={{ ...inp, marginTop: 0, marginBottom: 6 }} value={r.op || 'is'} onChange={e => update(i, { op: e.target.value })}>
              {ops.map(o => { const od = OPERATORS.find(x => x.value === o); return <option key={o} value={o}>{od?.label || o}</option> })}
            </select>
            {!opDef?.noValue && (
              fieldDef?.type === 'status' ? <select style={{ ...inp, marginTop: 0 }} value={r.value || ''} onChange={e => update(i, { value: e.target.value })}><option value="">—</option>{STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select>
                : fieldDef?.type === 'agent' ? <select style={{ ...inp, marginTop: 0 }} value={r.value || ''} onChange={e => update(i, { value: e.target.value })}><option value="">—</option>{TEAM.map(t => <option key={t} value={t}>{t}</option>)}</select>
                  : fieldDef?.type === 'bool' ? <select style={{ ...inp, marginTop: 0 }} value={String(r.value ?? '')} onChange={e => update(i, { value: e.target.value === 'true' })}><option value="true">true</option><option value="false">false</option></select>
                    : <input style={{ ...inp, marginTop: 0 }} type={fieldDef?.type === 'number' ? 'number' : fieldDef?.type === 'date' ? 'date' : 'text'} value={r.value ?? ''} onChange={e => update(i, { value: e.target.value })} placeholder="value" />
            )}
          </div>
        )
      })}
      <button className="btn btn-sm btn-secondary" onClick={add}>+ Add condition</button>
    </>
  )
}
