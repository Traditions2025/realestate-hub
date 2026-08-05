import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'

const STATUSES = ['new', 'active', 'prime', 'pending', 'watch', 'qualify', 'closed', 'archived']
const TEAM = ['Matt', 'John', 'Hunter', 'Cherryl']
const ACTION_TYPES = [
  { type: 'send_email', label: '✉ Send an email' },
  { type: 'add_tag', label: '🏷 Add a tag' },
  { type: 'remove_tag', label: '🏷 Remove a tag' },
  { type: 'add_note', label: '📝 Add a note' },
  { type: 'update_status', label: '🔄 Update status' },
  { type: 'assign', label: '👤 Assign a team member' },
  { type: 'create_task', label: '☑ Create a task' },
  { type: 'send_text', label: '💬 Send a text (coming with Twilio)' },
]
const emptyAuto = () => ({ name: '', enabled: false, trigger_type: 'schedule_daily', run_time: '09:00', audience: {}, actions: [] })
const lbl = { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }
const inp = { width: '100%', padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13, marginTop: 4 }

export default function Automations() {
  const [items, setItems] = useState([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(emptyAuto())
  const [templates, setTemplates] = useState([])
  const [audiencePreview, setAudiencePreview] = useState(null)
  const [saving, setSaving] = useState(false)

  const load = () => authFetch('/api/automations').then(r => r.json()).then(setItems).catch(() => setItems([]))
  useEffect(() => { load(); authFetch('/api/email/templates').then(r => r.json()).then(setTemplates).catch(() => {}) }, [])

  const openNew = () => { setEditing(null); setForm(emptyAuto()); setAudiencePreview(null); setModalOpen(true) }
  const openEdit = async (item) => {
    const a = await authFetch(`/api/automations/${item.id}`).then(r => r.json())
    setEditing(a.id)
    setForm({
      name: a.name || '', enabled: !!a.enabled, trigger_type: a.trigger_type || 'schedule_daily', run_time: a.run_time || '09:00',
      audience: (() => { try { return JSON.parse(a.audience || '{}') } catch { return {} } })(),
      actions: (() => { try { return JSON.parse(a.actions || '[]') } catch { return [] } })(),
    })
    setAudiencePreview(null); setModalOpen(true)
  }

  const save = async (enableOverride) => {
    setSaving(true)
    const payload = { ...form, enabled: enableOverride != null ? enableOverride : form.enabled }
    try {
      if (editing) await authFetch(`/api/automations/${editing}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      else await authFetch('/api/automations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      setModalOpen(false); load()
    } catch (e) { alert('Save failed: ' + e.message) }
    finally { setSaving(false) }
  }
  const toggleEnabled = async (item) => {
    await authFetch(`/api/automations/${item.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...item, enabled: item.enabled ? 0 : 1, audience: JSON.parse(item.audience || '{}'), actions: JSON.parse(item.actions || '[]') }) })
    load()
  }
  const remove = async (id) => { if (!confirm('Delete this automation?')) return; await authFetch(`/api/automations/${id}`, { method: 'DELETE' }); load() }
  const runNow = async (id) => {
    if (!confirm('Run this automation now on its whole audience?')) return
    const r = await authFetch(`/api/automations/${id}/run-now`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(x => x.json())
    if (r.error) alert('Run failed: ' + r.error)
    else alert(`✓ Ran: ${r.matched} matched · ${r.actions_done} actions · ${r.errors} errors`)
    load()
  }

  const setAud = (k, v) => setForm(p => ({ ...p, audience: { ...p.audience, [k]: v } }))
  const previewAudience = async () => {
    const r = await authFetch('/api/automations/preview-audience', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audience: form.audience }) }).then(x => x.json())
    setAudiencePreview(r)
  }

  // actions
  const addAction = (type) => setForm(p => ({ ...p, actions: [...p.actions, { type, config: {} }] }))
  const setActionCfg = (i, cfg) => setForm(p => ({ ...p, actions: p.actions.map((a, idx) => idx === i ? { ...a, config: { ...a.config, ...cfg } } : a) }))
  const moveAction = (i, dir) => setForm(p => { const a = [...p.actions]; const j = i + dir; if (j < 0 || j >= a.length) return p;[a[i], a[j]] = [a[j], a[i]]; return { ...p, actions: a } })
  const removeAction = (i) => setForm(p => ({ ...p, actions: p.actions.filter((_, idx) => idx !== i) }))

  const statusList = Array.isArray(form.audience.statuses_include) ? form.audience.statuses_include : []

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Automations</h1>
          <p className="page-subtitle">Build workflows: pick who to target, then what happens — runs on your schedule.</p>
        </div>
        <button className="btn btn-primary" onClick={openNew}>+ New Automation</button>
      </div>

      <div style={{ display: 'grid', gap: 12 }}>
        {items.length === 0 ? <div className="empty-state-full">No automations yet. Create one to start automating.</div> :
          items.map(a => (
            <div key={a.id} className="detail-section" style={{ display: 'flex', alignItems: 'center', gap: 14, cursor: 'pointer' }} onClick={() => openEdit(a)}>
              <label onClick={e => { e.stopPropagation(); toggleEnabled(a) }} style={{ display: 'inline-flex', alignItems: 'center' }}>
                <span style={{ width: 40, height: 22, borderRadius: 11, background: a.enabled ? '#10b981' : 'var(--border)', position: 'relative', transition: '.2s', display: 'inline-block' }}>
                  <span style={{ position: 'absolute', top: 2, left: a.enabled ? 20 : 2, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: '.2s' }} />
                </span>
              </label>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600 }}>{a.name} {!a.enabled && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(off)</span>}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                  Daily at {a.run_time} · {(() => { try { return JSON.parse(a.actions || '[]').length } catch { return 0 } })()} action(s)
                  {a.last_run_summary ? ` · last run: ${a.last_run_summary}` : ' · never run'}
                </div>
              </div>
              <button className="btn btn-sm btn-secondary" onClick={e => { e.stopPropagation(); runNow(a.id) }}>▶ Run now</button>
              <button className="btn btn-sm btn-danger" onClick={e => { e.stopPropagation(); remove(a.id) }}>Delete</button>
            </div>
          ))}
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Edit Automation' : 'New Automation'} wide>
        <div style={{ display: 'grid', gap: 16 }}>
          <label style={lbl}>Name<input style={inp} value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Re-engage cold Watch leads" /></label>

          {/* Trigger + timing */}
          <div className="detail-section">
            <h4 style={{ marginTop: 0 }}>1. Trigger</h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <label style={lbl}>When
                <select style={inp} value={form.trigger_type} onChange={e => setForm(p => ({ ...p, trigger_type: e.target.value }))}>
                  <option value="schedule_daily">On a daily schedule</option>
                </select>
              </label>
              <label style={lbl}>Time (default 9:00 AM)<input type="time" style={inp} value={form.run_time} onChange={e => setForm(p => ({ ...p, run_time: e.target.value }))} /></label>
            </div>
            <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>Event triggers (lead created, status changed, etc.) are coming — daily schedule is available now.</p>
          </div>

          {/* Audience — conditions + include/exclude */}
          <div className="detail-section">
            <h4 style={{ marginTop: 0 }}>2. Who it targets <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>(conditions + include / exclude)</span></h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div style={lbl}>Statuses (include any)
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {STATUSES.map(s => {
                    const on = statusList.includes(s)
                    return <button key={s} type="button" className={`btn btn-sm ${on ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setAud('statuses_include', on ? statusList.filter(x => x !== s) : [...statusList, s])}>{s}</button>
                  })}
                </div>
              </div>
              <label style={lbl}>Has listing views
                <select style={inp} value={form.audience.has_listing_views ? '1' : ''} onChange={e => setAud('has_listing_views', e.target.value === '1')}>
                  <option value="">Any</option><option value="1">Only leads who viewed listings</option>
                </select>
              </label>
              <label style={lbl}>Tags include (comma-sep)<input style={inp} value={(form.audience.tags_include || []).join?.(',') || form.audience.tags_include || ''} onChange={e => setAud('tags_include', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} /></label>
              <label style={lbl}>Tags exclude (comma-sep)<input style={inp} value={(form.audience.tags_exclude || []).join?.(',') || form.audience.tags_exclude || ''} onChange={e => setAud('tags_exclude', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} /></label>
              <label style={lbl}>Inactive for (days+)<input type="number" style={inp} placeholder="e.g. 30" value={form.audience.inactive_days || ''} onChange={e => setAud('inactive_days', e.target.value)} /></label>
              <label style={lbl}>Last listing visit ≤ (days)<input type="number" style={inp} placeholder="e.g. 30" value={form.audience.fub_days_max || ''} onChange={e => setAud('fub_days_max', e.target.value)} /></label>
              <label style={lbl}>Cities include (comma-sep)<input style={inp} value={(form.audience.cities_include || []).join?.(',') || form.audience.cities_include || ''} onChange={e => setAud('cities_include', e.target.value.split(',').map(s => s.trim()).filter(Boolean))} /></label>
              <label style={lbl}>Only with email
                <select style={inp} value={form.audience.has_email ? '1' : ''} onChange={e => setAud('has_email', e.target.value === '1' ? '1' : '')}>
                  <option value="">Any</option><option value="1">Only leads with an email</option>
                </select>
              </label>
            </div>
            <button type="button" className="btn btn-sm btn-secondary" onClick={previewAudience}>Preview audience</button>
            {audiencePreview && (
              <div style={{ marginTop: 8, fontSize: 13 }}>
                {audiencePreview.error ? <span style={{ color: '#ef4444' }}>{audiencePreview.error}</span> :
                  <><strong>{audiencePreview.count}</strong> leads match. {audiencePreview.sample?.length > 0 && <span style={{ color: 'var(--text-muted)' }}>e.g. {audiencePreview.sample.map(s => `${s.first_name} ${s.last_name}`).join(', ')}…</span>}</>}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="detail-section">
            <h4 style={{ marginTop: 0 }}>3. What happens <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)' }}>(runs in order, per matched lead)</span></h4>
            {form.actions.length === 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)' }}>No actions yet — add one below.</p>}
            <div style={{ display: 'grid', gap: 8 }}>
              {form.actions.map((a, i) => (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{i + 1}. {ACTION_TYPES.find(t => t.type === a.type)?.label || a.type}</span>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={i === 0} onClick={() => moveAction(i, -1)}>↑</button>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={i === form.actions.length - 1} onClick={() => moveAction(i, 1)}>↓</button>
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => removeAction(i)}>✕</button>
                  </div>
                  <ActionConfig action={a} onChange={cfg => setActionCfg(i, cfg)} templates={templates} />
                </div>
              ))}
            </div>
            <div style={{ marginTop: 10 }}>
              <select style={{ ...inp, width: 'auto', display: 'inline-block' }} value="" onChange={e => { if (e.target.value) addAction(e.target.value) }}>
                <option value="">+ Add action…</option>
                {ACTION_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
              </select>
            </div>
          </div>

          {/* Review + save */}
          <div className="detail-section" style={{ background: 'rgba(37,99,235,0.06)' }}>
            <h4 style={{ marginTop: 0 }}>4. Review</h4>
            <p style={{ fontSize: 13, margin: 0 }}>
              Every day at <strong>{form.run_time}</strong>, for <strong>{audiencePreview?.count ?? '—'}</strong> matching leads
              {statusList.length ? <> (status: {statusList.join(', ')})</> : null}, run <strong>{form.actions.length}</strong> action(s): {form.actions.map(a => ACTION_TYPES.find(t => t.type === a.type)?.label.replace(/^\S+ /, '')).join(' → ') || '(none)'}.
            </p>
          </div>

          <div className="form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setModalOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => save(false)}>{saving ? 'Saving…' : 'Save (keep off)'}</button>
            <button type="button" className="btn btn-primary" disabled={saving || !form.actions.length} onClick={() => save(true)}>{saving ? 'Saving…' : '✓ Save & Activate'}</button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function ActionConfig({ action, onChange, templates }) {
  const cfg = action.config || {}
  const s = { ...inp }
  switch (action.type) {
    case 'add_tag':
    case 'remove_tag':
      return <label style={lbl}>Tag<input style={s} value={cfg.tag || ''} onChange={e => onChange({ tag: e.target.value })} placeholder="Tag name" /></label>
    case 'add_note':
      return <label style={lbl}>Note text<textarea style={{ ...s, minHeight: 54 }} value={cfg.text || ''} onChange={e => onChange({ text: e.target.value })} placeholder="Supports {{first_name}}" /></label>
    case 'update_status':
      return <label style={lbl}>New status<select style={s} value={cfg.status || ''} onChange={e => onChange({ status: e.target.value })}><option value="">—</option>{STATUSES.map(x => <option key={x} value={x}>{x}</option>)}</select></label>
    case 'assign':
      return <label style={lbl}>Assign to<select style={s} value={cfg.agent || ''} onChange={e => onChange({ agent: e.target.value })}><option value="">—</option>{TEAM.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
    case 'create_task':
      return (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
          <label style={lbl}>Task title<input style={s} value={cfg.title || ''} onChange={e => onChange({ title: e.target.value })} placeholder="Follow up with {{first_name}}" /></label>
          <label style={lbl}>Priority<select style={s} value={cfg.priority || 'medium'} onChange={e => onChange({ priority: e.target.value })}><option>high</option><option>medium</option><option>low</option></select></label>
          <label style={lbl}>Due in (days)<input type="number" style={s} value={cfg.days_offset ?? ''} onChange={e => onChange({ days_offset: e.target.value })} placeholder="0" /></label>
        </div>
      )
    case 'send_email':
      return <label style={lbl}>Email template<select style={s} value={cfg.template_id || ''} onChange={e => onChange({ template_id: e.target.value })}><option value="">— pick a template —</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    case 'send_text':
      return <p style={{ fontSize: 12, color: '#f59e0b', margin: 0 }}>Text sending activates once Twilio is connected.</p>
    default:
      return null
  }
}
