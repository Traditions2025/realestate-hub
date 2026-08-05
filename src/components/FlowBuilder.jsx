import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'

const TRIGGERS = [
  { type: 'schedule_daily', label: 'Daily Schedule', icon: '⏰', desc: 'Runs every day at a set time' },
  { type: 'property_viewed', label: 'Property Viewed', icon: '👁', desc: 'A lead views a listing' },
  { type: 'lead_created', label: 'Lead Created', icon: '➕', desc: 'A new lead comes in' },
  { type: 'status_changed', label: 'Status Changed', icon: '🔄', desc: 'A lead status changes' },
  { type: 'tag_added', label: 'Tag Added', icon: '🏷', desc: 'A tag is added to a lead' },
]
const CONTROLS = [
  { kind: 'condition', label: 'Conditions', icon: '🔻', desc: 'Only continue if criteria are met' },
  { kind: 'delay', label: 'Time Delay', icon: '⏱', desc: 'Wait before the next step' },
]
const ACTIONS = [
  { actionType: 'send_email', label: 'Send Email', icon: '✉' },
  { actionType: 'add_tag', label: 'Add Tag', icon: '🏷' },
  { actionType: 'remove_tag', label: 'Remove Tag', icon: '🏷' },
  { actionType: 'add_note', label: 'Add Note', icon: '📝' },
  { actionType: 'update_status', label: 'Update Status', icon: '🔄' },
  { actionType: 'assign', label: 'Reassign Agent', icon: '👤' },
  { actionType: 'create_task', label: 'Create Task', icon: '☑' },
  { actionType: 'send_text', label: 'Send Text (Twilio soon)', icon: '💬' },
]
const STATUSES = ['new', 'active', 'prime', 'pending', 'watch', 'qualify', 'closed', 'archived']
const TEAM = ['Matt', 'John', 'Hunter', 'Cherryl']
const EXECUTABLE_ACTIONS = ['send_email', 'add_tag', 'remove_tag', 'add_note', 'update_status', 'assign', 'create_task']

const inp = { width: '100%', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, marginTop: 4 }
const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }
const uid = () => 's' + Math.random().toString(36).slice(2, 9)

export default function FlowBuilder({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '')
  const [runTime, setRunTime] = useState(initial?.run_time || '09:00')
  const [trigger, setTrigger] = useState(initial?.flow?.trigger || null)
  const [steps, setSteps] = useState(initial?.flow?.steps || [])
  const [selKey, setSelKey] = useState(null) // 'trigger' | step id
  const [tab, setTab] = useState('triggers')
  const [templates, setTemplates] = useState([])
  const [audience, setAudience] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => { authFetch('/api/email/templates').then(r => r.json()).then(setTemplates).catch(() => {}) }, [])
  useEffect(() => { if (trigger && tab === 'triggers') setTab('steps') }, [trigger])

  const addStep = (item) => {
    if (!trigger) { alert('Pick a trigger first'); return }
    const step = item.kind
      ? { id: uid(), kind: item.kind, config: {} }
      : { id: uid(), kind: 'action', actionType: item.actionType, config: {} }
    setSteps(s => [...s, step]); setSelKey(step.id)
  }
  const updateStep = (id, patch) => setSteps(s => s.map(x => x.id === id ? { ...x, config: { ...x.config, ...patch } } : x))
  const removeStep = (id) => { setSteps(s => s.filter(x => x.id !== id)); setSelKey(null) }
  const moveStep = (id, dir) => setSteps(s => { const i = s.findIndex(x => x.id === id); const j = i + dir; if (j < 0 || j >= s.length) return s; const a = [...s];[a[i], a[j]] = [a[j], a[i]]; return a })

  const previewAudience = async () => {
    const r = await authFetch('/api/automations/preview-audience', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps }) }).then(x => x.json())
    setAudience(r)
  }

  const complete = trigger && steps.length > 0 && steps.every(isConfigured)
  const save = async (enable) => {
    if (!name.trim()) { alert('Give your automation a name'); return }
    if (!trigger) { alert('Pick a trigger'); return }
    setSaving(true)
    const payload = { name, enabled: enable ? 1 : 0, run_time: runTime, flow: { trigger, steps } }
    try {
      if (initial?.id) await authFetch(`/api/automations/${initial.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      else await authFetch('/api/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      onSaved && onSaved()
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }

  const sidebarItem = (it, onClick, key) => (
    <div key={key} onClick={onClick} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px', marginBottom: 8, cursor: 'pointer', background: 'var(--bg-secondary)' }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{it.icon} {it.label}</div>
      {it.desc && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{it.desc}</div>}
    </div>
  )

  const selectedStep = steps.find(s => s.id === selKey)

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'var(--bg-primary, #0f172a)', display: 'flex', flexDirection: 'column' }}>
      {/* header */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Automation name…" style={{ ...inp, marginTop: 0, width: 280 }} />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Runs at</span>
        <input type="time" value={runTime} onChange={e => setRunTime(e.target.value)} style={{ ...inp, marginTop: 0, width: 120 }} />
        <button className="btn btn-sm btn-secondary" onClick={previewAudience}>Preview audience</button>
        {audience && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{audience.error ? audience.error : `${audience.count} leads match`}</span>}
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn btn-sm btn-secondary" onClick={() => save(false)} disabled={saving}>Save draft</button>
        <button className="btn btn-sm btn-primary" onClick={() => save(true)} disabled={saving || !complete} title={complete ? '' : 'Configure all steps first'}>✓ Save &amp; Activate</button>
        <button className="btn btn-sm btn-secondary" onClick={onClose}>✕ Close</button>
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* left sidebar */}
        <div style={{ width: 300, borderRight: '1px solid var(--border)', padding: 14, overflowY: 'auto', background: 'var(--bg-secondary)' }}>
          <div style={{ display: 'flex', gap: 0, marginBottom: 12, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            <button onClick={() => setTab('triggers')} style={{ flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer', fontSize: 13, background: tab === 'triggers' ? 'var(--accent, #2563eb)' : 'transparent', color: tab === 'triggers' ? '#fff' : 'var(--text-primary)' }}>Triggers</button>
            <button onClick={() => setTab('steps')} style={{ flex: 1, padding: '7px 0', border: 'none', cursor: 'pointer', fontSize: 13, background: tab === 'steps' ? 'var(--accent, #2563eb)' : 'transparent', color: tab === 'steps' ? '#fff' : 'var(--text-primary)' }}>Steps</button>
          </div>
          {tab === 'triggers' ? (
            <>
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 8px' }}>Pick what starts the automation.</p>
              {TRIGGERS.map(t => sidebarItem(t, () => { setTrigger({ type: t.type, label: t.label, icon: t.icon }); setSelKey('trigger') }, t.type))}
              <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Only <strong>Daily Schedule</strong> fires automatically today; event triggers run on the daily pass for now.</p>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', margin: '4px 0 6px', letterSpacing: 1 }}>Controls</div>
              {CONTROLS.map(c => sidebarItem(c, () => addStep(c), c.kind))}
              <div style={{ fontSize: 11, textTransform: 'uppercase', color: 'var(--text-muted)', margin: '12px 0 6px', letterSpacing: 1 }}>Actions</div>
              {ACTIONS.map(a => sidebarItem(a, () => addStep(a), a.actionType))}
            </>
          )}
        </div>

        {/* canvas */}
        <div style={{ flex: 1, overflowY: 'auto', background: '#0b1220', backgroundImage: 'radial-gradient(#1e293b 1px, transparent 1px)', backgroundSize: '22px 22px', padding: '32px 0 60px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0 }}>
            {!trigger ? (
              <div style={{ marginTop: 60, color: '#64748b', fontSize: 14 }}>← Pick a <strong>Trigger</strong> from the left to begin.</div>
            ) : (
              <>
                <FlowCard selected={selKey === 'trigger'} onClick={() => setSelKey('trigger')} accent="#06b6d4"
                  title={<><span>{trigger.icon}</span> {trigger.label}</>} />
                {steps.map((s, i) => (
                  <React.Fragment key={s.id}>
                    <Connector />
                    {s.kind === 'delay'
                      ? <DelayPill step={s} selected={selKey === s.id} onClick={() => setSelKey(s.id)} />
                      : <FlowCard selected={selKey === s.id} onClick={() => setSelKey(s.id)}
                        accent={s.kind === 'condition' ? '#f59e0b' : '#6366f1'}
                        title={<><span>{stepIcon(s)}</span> {stepTitle(s)}</>}
                        badge={!isConfigured(s) ? 'CONFIGURE' : null} />}
                  </React.Fragment>
                ))}
                <Connector />
                <button onClick={() => setTab('steps')} title="Add a step from the left"
                  style={{ width: 34, height: 34, borderRadius: 8, border: '1px dashed #475569', background: '#0f172a', color: '#94a3b8', fontSize: 18, cursor: 'pointer' }}>+</button>
                <Connector />
                <div style={{ textAlign: 'center', padding: '18px 22px', border: '1px solid var(--border)', borderRadius: 12, background: '#0f172a', minWidth: 190 }}>
                  <div style={{ width: 32, height: 32, borderRadius: '50%', background: complete ? '#10b981' : '#f59e0b', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 8 }}>{complete ? '✓' : '⏱'}</div>
                  <div style={{ fontWeight: 600, color: complete ? '#10b981' : '#f59e0b' }}>{complete ? 'Ready to activate' : 'Almost there'}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>{complete ? 'Save & Activate up top' : 'Configure all steps completely'}</div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* config drawer */}
        {(selKey === 'trigger' || selectedStep) && (
          <div style={{ width: 320, borderLeft: '1px solid var(--border)', padding: 16, overflowY: 'auto', background: 'var(--bg-secondary)' }}>
            {selKey === 'trigger' ? (
              <>
                <h4 style={{ marginTop: 0 }}>Trigger</h4>
                <p style={{ fontSize: 13 }}>{trigger.icon} <strong>{trigger.label}</strong></p>
                <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>This automation starts on this trigger. Add Conditions below to control who qualifies, and Actions for what happens.</p>
              </>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <h4 style={{ margin: 0, flex: 1 }}>{stepIcon(selectedStep)} {stepTitle(selectedStep)}</h4>
                  <button className="btn btn-sm btn-secondary" onClick={() => moveStep(selectedStep.id, -1)}>↑</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => moveStep(selectedStep.id, 1)}>↓</button>
                  <button className="btn btn-sm btn-danger" onClick={() => removeStep(selectedStep.id)}>✕</button>
                </div>
                <StepConfig step={selectedStep} onChange={patch => updateStep(selectedStep.id, patch)} templates={templates} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function FlowCard({ title, badge, accent, selected, onClick }) {
  return (
    <div onClick={onClick} style={{ minWidth: 230, background: '#fff', color: '#0f172a', borderRadius: 10, border: selected ? `2px solid ${accent}` : '1px solid #cbd5e1', boxShadow: '0 2px 10px rgba(0,0,0,0.25)', cursor: 'pointer', overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: accent, borderLeft: `4px solid ${accent}` }}>
        {title}
        {badge && <span style={{ marginLeft: 'auto', fontSize: 10, background: '#fef3c7', color: '#b45309', padding: '2px 7px', borderRadius: 5, letterSpacing: 1 }}>{badge}</span>}
      </div>
    </div>
  )
}
function DelayPill({ step, selected, onClick }) {
  const c = step.config || {}
  return <div onClick={onClick} style={{ padding: '6px 12px', background: '#fff', color: '#b45309', border: selected ? '2px solid #f59e0b' : '1px solid #cbd5e1', borderRadius: 20, fontSize: 13, cursor: 'pointer', boxShadow: '0 1px 6px rgba(0,0,0,0.2)' }}>⏱ {c.amount || 1} {c.unit || 'day'}{(c.amount || 1) > 1 ? 's' : ''}</div>
}
function Connector() { return <div style={{ width: 2, height: 22, background: '#334155' }} /> }

const stepIcon = (s) => s.kind === 'condition' ? '🔻' : s.kind === 'delay' ? '⏱' : (ACTIONS.find(a => a.actionType === s.actionType)?.icon || '⚙')
const stepTitle = (s) => s.kind === 'condition' ? 'Conditions' : s.kind === 'delay' ? 'Time Delay' : (ACTIONS.find(a => a.actionType === s.actionType)?.label || s.actionType)
function isConfigured(s) {
  const c = s.config || {}
  if (s.kind === 'condition') return c.field && (c.value != null && c.value !== '' || c.field === 'has_listing_views' || c.field === 'has_email')
  if (s.kind === 'delay') return !!c.amount
  switch (s.actionType) {
    case 'send_email': return !!c.template_id
    case 'add_tag': case 'remove_tag': return !!c.tag
    case 'add_note': return !!c.text
    case 'update_status': return !!c.status
    case 'assign': return !!c.agent
    case 'create_task': return !!c.title
    case 'send_text': return false
    default: return true
  }
}

function StepConfig({ step, onChange, templates }) {
  const c = step.config || {}
  if (step.kind === 'condition') {
    const needsValue = !['has_listing_views', 'has_email'].includes(c.field)
    return (
      <>
        <label style={lbl}>Field
          <select style={inp} value={c.field || ''} onChange={e => onChange({ field: e.target.value, op: '', value: '' })}>
            <option value="">— pick —</option>
            <option value="status">Status</option>
            <option value="tag">Tag</option>
            <option value="has_listing_views">Has viewed listings</option>
            <option value="last_visit_days">Last listing visit (days)</option>
            <option value="inactive_days">Inactive for (days)</option>
            <option value="city">Lead city</option>
            <option value="has_email">Has an email</option>
          </select>
        </label>
        {c.field === 'status' && <>
          <label style={lbl}>Is / Is not<select style={inp} value={c.op || 'is'} onChange={e => onChange({ op: e.target.value })}><option value="is">is</option><option value="is_not">is not</option></select></label>
          <label style={lbl}>Status<select style={inp} value={c.value || ''} onChange={e => onChange({ value: e.target.value })}><option value="">—</option>{STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
        </>}
        {c.field === 'tag' && <>
          <label style={lbl}>Has / Doesn't have<select style={inp} value={c.op || 'has'} onChange={e => onChange({ op: e.target.value })}><option value="has">has tag</option><option value="not">does not have</option></select></label>
          <label style={lbl}>Tag<input style={inp} value={c.value || ''} onChange={e => onChange({ value: e.target.value })} /></label>
        </>}
        {c.field === 'last_visit_days' && <>
          <label style={lbl}>Within / Over<select style={inp} value={c.op || 'within'} onChange={e => onChange({ op: e.target.value })}><option value="within">within (≤)</option><option value="over">over (≥)</option></select></label>
          <label style={lbl}>Days<input type="number" style={inp} value={c.value || ''} onChange={e => onChange({ value: e.target.value })} /></label>
        </>}
        {c.field === 'inactive_days' && <label style={lbl}>Days+<input type="number" style={inp} value={c.value || ''} onChange={e => onChange({ value: e.target.value })} /></label>}
        {c.field === 'city' && <label style={lbl}>City<input style={inp} value={c.value || ''} onChange={e => onChange({ value: e.target.value })} /></label>}
        {(c.field === 'has_listing_views' || c.field === 'has_email') && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>Only leads where this is true continue.</p>}
      </>
    )
  }
  if (step.kind === 'delay') {
    return (
      <div style={{ display: 'flex', gap: 8 }}>
        <label style={{ ...lbl, flex: 1 }}>Wait<input type="number" min="1" style={inp} value={c.amount || ''} onChange={e => onChange({ amount: e.target.value })} /></label>
        <label style={{ ...lbl, flex: 1 }}>Unit<select style={inp} value={c.unit || 'day'} onChange={e => onChange({ unit: e.target.value })}><option value="hour">hours</option><option value="day">days</option><option value="week">weeks</option></select></label>
        <p style={{ fontSize: 11, color: 'var(--text-muted)', flexBasis: '100%' }}>Delays are shown in the flow; timed execution activates with the sequence engine.</p>
      </div>
    )
  }
  // action
  switch (step.actionType) {
    case 'send_email': return <label style={lbl}>Email template<select style={inp} value={c.template_id || ''} onChange={e => onChange({ template_id: e.target.value })}><option value="">— pick a template —</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    case 'add_tag': case 'remove_tag': return <label style={lbl}>Tag<input style={inp} value={c.tag || ''} onChange={e => onChange({ tag: e.target.value })} /></label>
    case 'add_note': return <label style={lbl}>Note<textarea style={{ ...inp, minHeight: 60 }} value={c.text || ''} onChange={e => onChange({ text: e.target.value })} placeholder="Supports {{first_name}}" /></label>
    case 'update_status': return <label style={lbl}>New status<select style={inp} value={c.status || ''} onChange={e => onChange({ status: e.target.value })}><option value="">—</option>{STATUSES.map(s => <option key={s} value={s}>{s}</option>)}</select></label>
    case 'assign': return <label style={lbl}>Assign to<select style={inp} value={c.agent || ''} onChange={e => onChange({ agent: e.target.value })}><option value="">—</option>{TEAM.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
    case 'create_task': return (<>
      <label style={lbl}>Title<input style={inp} value={c.title || ''} onChange={e => onChange({ title: e.target.value })} placeholder="Follow up with {{first_name}}" /></label>
      <div style={{ display: 'flex', gap: 8 }}>
        <label style={{ ...lbl, flex: 1 }}>Priority<select style={inp} value={c.priority || 'medium'} onChange={e => onChange({ priority: e.target.value })}><option>high</option><option>medium</option><option>low</option></select></label>
        <label style={{ ...lbl, flex: 1 }}>Due in (days)<input type="number" style={inp} value={c.days_offset ?? ''} onChange={e => onChange({ days_offset: e.target.value })} /></label>
      </div>
    </>)
    case 'send_text': return <p style={{ fontSize: 12, color: '#f59e0b' }}>Text sending activates once Twilio is connected.</p>
    default: return null
  }
}
