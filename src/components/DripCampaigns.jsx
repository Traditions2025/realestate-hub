import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from './Modal'
import RichTextEditor from './RichTextEditor'

const uid = () => 's' + Math.random().toString(36).slice(2, 8)
const newStep = () => ({ id: uid(), delay_days: 0, send_time: '09:00', send_time_end: '11:00', subject: '', body: '', template_id: '', include_properties: false })

export default function DripCampaigns() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)  // drip object being edited (or {new:true})
  const [templates, setTemplates] = useState([])
  const [activity, setActivity] = useState(null)

  const load = () => { setLoading(true); authFetch('/api/drips').then(r => r.json()).then(d => { setItems(Array.isArray(d) ? d : []); setLoading(false) }).catch(() => { setItems([]); setLoading(false) }) }
  useEffect(() => { load(); authFetch('/api/templates?type=email').then(r => r.json()).then(t => setTemplates(Array.isArray(t) ? t : [])).catch(() => {}) }, [])

  const openNew = () => setEditing({ new: true, name: '', description: '', steps: [newStep()] })
  const openEdit = async (id) => { const d = await authFetch(`/api/drips/${id}`).then(r => r.json()); setEditing({ ...d, steps: d.steps && d.steps.length ? d.steps : [newStep()] }) }
  const remove = async (id, name) => { if (!confirm(`Delete drip "${name}"? Contacts currently in it stop receiving emails.`)) return; await authFetch(`/api/drips/${id}`, { method: 'DELETE' }); load() }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13, flex: 1 }}>Multi-email sequences: each email sends on its own schedule (e.g. “after 14 days at 9:00 AM”). Apply a drip from any automation with the <strong>Start Drip Campaign</strong> action.</p>
        <button className="btn btn-primary" onClick={openNew}>+ New Drip</button>
      </div>

      {loading ? <div className="empty-state-full">Loading drips…</div>
        : items.length === 0 ? (
          <div className="empty-state-full" style={{ textAlign: 'center', padding: 36 }}>
            <div style={{ fontSize: 34 }}>💧</div>
            <div style={{ fontWeight: 600, marginTop: 6 }}>No drip campaigns yet</div>
            <div style={{ color: 'var(--text-muted)', margin: '6px 0 14px' }}>Build a sequence of emails that go out over days or weeks.</div>
            <button className="btn btn-primary" onClick={openNew}>+ Create your first drip</button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: 14 }}>
            {items.map(d => (
              <div key={d.id} className="detail-section" style={{ padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => openEdit(d.id)}>
                    <div style={{ fontWeight: 600, fontSize: 15 }}>💧 {d.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{(d.steps || []).length} email{(d.steps || []).length === 1 ? '' : 's'}{d.description ? ` · ${d.description}` : ''}</div>
                  </div>
                </div>
                <div style={{ margin: '10px 0', fontSize: 12, color: 'var(--text-muted)' }}>
                  {(d.steps || []).slice(0, 4).map((s, i) => <span key={s.id || i}>{i > 0 && <span style={{ margin: '0 5px' }}>→</span>}{i === 0 ? (Number(s.delay_days) ? `day ${s.delay_days}` : 'day 0') : `+${s.delay_days}d`}</span>)}
                </div>
                <div style={{ display: 'flex', gap: 14, margin: '4px 0 12px', fontSize: 12 }}>
                  <Stat n={d.stats?.active} label="In sequence" /><Stat n={d.stats?.completed} label="Completed" /><Stat n={d.stats?.emails_sent} label="Emails sent" color="#8b5cf6" />
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-sm btn-secondary" onClick={() => openEdit(d.id)}>Edit</button>
                  <button className="btn btn-sm btn-secondary" onClick={() => setActivity({ id: d.id, name: d.name })}>Activity</button>
                  <button className="btn btn-sm btn-danger" style={{ marginLeft: 'auto' }} onClick={() => remove(d.id, d.name)}>Delete</button>
                </div>
              </div>
            ))}
          </div>
        )}

      {editing && <DripEditor drip={editing} templates={templates} setTemplates={setTemplates} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
      {activity && <DripActivity id={activity.id} name={activity.name} onClose={() => setActivity(null)} />}
    </div>
  )
}

function DripEditor({ drip, templates, setTemplates, onClose, onSaved }) {
  const [name, setName] = useState(drip.name || '')
  const [description, setDescription] = useState(drip.description || '')
  const [steps, setSteps] = useState(drip.steps || [newStep()])
  const [saving, setSaving] = useState(false)
  const [editingTplId, setEditingTplId] = useState(null)  // template being edited in place
  const templateById = (id) => templates.find(t => String(t.id) === String(id))

  const setStep = (i, patch) => setSteps(s => s.map((x, j) => j === i ? { ...x, ...patch } : x))
  const addStep = () => setSteps(s => [...s, { ...newStep(), delay_days: 3 }])
  const delStep = (i) => setSteps(s => s.filter((_, j) => j !== i))
  const move = (i, dir) => setSteps(s => { const j = i + dir; if (j < 0 || j >= s.length) return s; const a = [...s];[a[i], a[j]] = [a[j], a[i]]; return a })

  const valid = name.trim() && steps.length && steps.every(s => (s.template_id || (s.subject && s.body)))

  const save = async () => {
    if (!valid) { alert('Give the drip a name, and every email needs a subject + body (or a template).'); return }
    setSaving(true)
    const payload = { name, description, steps: steps.map(s => ({ ...s, delay_days: Number(s.delay_days) || 0 })) }
    try {
      if (drip.new) await authFetch('/api/drips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      else await authFetch(`/api/drips/${drip.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      onSaved()
    } catch (e) { alert('Save failed: ' + e.message) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title={drip.new ? 'New Drip Campaign' : 'Edit Drip Campaign'} wide>
      <div className="form">
        <div className="form-row">
          <label style={{ flex: 2 }}>Name<input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. New Buyer Nurture (30 days)" /></label>
          <label style={{ flex: 3 }}>Description<input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional — what this sequence is for" /></label>
        </div>

        <div style={{ marginTop: 6 }}>
          {steps.map((s, i) => (
            <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 14, marginBottom: 12, background: 'var(--bg-secondary)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: '#8b5cf6', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700 }}>{i + 1}</span>
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{i === 0 ? 'Send' : 'Then, after the previous email, wait'}</span>
                <input type="number" min="0" value={s.delay_days} onChange={e => setStep(i, { delay_days: e.target.value })} style={{ width: 64 }} />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>day{Number(s.delay_days) === 1 ? '' : 's'} between</span>
                <input type="time" value={s.send_time} onChange={e => setStep(i, { send_time: e.target.value })} style={{ width: 108 }} />
                <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>and</span>
                <input type="time" value={s.send_time_end || ''} onChange={e => setStep(i, { send_time_end: e.target.value })} style={{ width: 108 }} title="Leave equal to the start for a fixed time; a later time sends at a random moment in the window" />
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  <button className="btn-sm" onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                  <button className="btn-sm" onClick={() => move(i, 1)} disabled={i === steps.length - 1}>↓</button>
                  <button className="btn-sm btn-danger" onClick={() => delStep(i)} disabled={steps.length === 1}>✕</button>
                </div>
              </div>
              <div className="form-row" style={{ gap: 10 }}>
                {!s.template_id && (
                  <label style={{ flex: 2 }}>Subject<input value={s.subject} onChange={e => setStep(i, { subject: e.target.value })} placeholder="Supports {{first_name}}" /></label>
                )}
                <label style={{ flex: s.template_id ? 2 : 1 }}>{s.template_id ? 'Email template' : 'Or use a template'}
                  <select value={s.template_id || ''} onChange={e => setStep(i, { template_id: e.target.value })}>
                    <option value="">— write below —</option>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
              </div>
              {s.template_id ? (
                <TemplateStepPreview tpl={templateById(s.template_id)} onEdit={() => setEditingTplId(s.template_id)} />
              ) : (
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Message</div>
                  <RichTextEditor value={s.body} onChange={(b) => setStep(i, { body: b })} minHeight={140} />
                </div>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, fontSize: 13 }}>
                <input type="checkbox" checked={!!s.include_properties} onChange={e => setStep(i, { include_properties: e.target.checked })} />
                Append the homes this contact viewed (inserts property cards where <code>{'{{properties}}'}</code> appears, or at the end)
              </label>
            </div>
          ))}
          <button className="btn btn-secondary" onClick={addStep}>+ Add another email</button>
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving || !valid}>{saving ? 'Saving…' : (drip.new ? 'Create Drip' : 'Save Changes')}</button>
        </div>
      </div>

      {editingTplId != null && templateById(editingTplId) && (
        <TemplateEditModal
          template={templateById(editingTplId)}
          onClose={() => setEditingTplId(null)}
          onSaved={(upd) => { setTemplates?.(ts => ts.map(x => String(x.id) === String(upd.id) ? { ...x, ...upd } : x)); setEditingTplId(null) }}
        />
      )}
    </Modal>
  )
}

// Read-only preview of the template a step uses, with an "Edit email" button.
// Body is rendered on a white card (email content is authored for a white bg, so
// this keeps it legible in dark mode). Merge tokens like {{first_name}} show as-is;
// they fill in per-recipient at send time.
function TemplateStepPreview({ tpl, onEdit }) {
  if (!tpl) return (
    <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
      This template was not found (it may have been deleted). Pick another above, or choose “— write below —” to write inline.
    </div>
  )
  return (
    <div style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-primary)', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em' }}>Subject</span>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.subject || '(no subject)'}</span>
        <button type="button" className="btn btn-sm btn-secondary" onClick={onEdit}>✏️ Edit email</button>
      </div>
      <div style={{ maxHeight: 240, overflowY: 'auto', padding: '12px 14px', background: '#ffffff', color: '#111827', fontSize: 13, lineHeight: 1.55, fontFamily: 'Arial, Helvetica, sans-serif' }}
        dangerouslySetInnerHTML={{ __html: tpl.body || '<em>(empty)</em>' }} />
      <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
        Editing here also updates the “{tpl.name}” template in the Templates tab. Merge fields fill in when the email sends.
      </div>
    </div>
  )
}

// Edit a shared template in place. Saves via PUT /api/templates/:id, so the change
// is reflected in the drip AND everywhere else the template is used.
function TemplateEditModal({ template, onClose, onSaved }) {
  const [subject, setSubject] = useState(template.subject || '')
  const [body, setBody] = useState(template.body || '')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      await authFetch(`/api/templates/${template.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject, body, is_html: 1 }) })
      onSaved({ ...template, subject, body })
    } catch (e) { alert('Save failed: ' + e.message) } finally { setSaving(false) }
  }
  return (
    <Modal open onClose={onClose} title={`Edit email — ${template.name}`} wide>
      <div className="form">
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6, border: '1px solid var(--border)' }}>
          This is the shared template <strong>{template.name}</strong>. Saving updates it everywhere it is used — this drip and the Templates tab.
        </div>
        <label>Subject<input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Supports {{first_name}}" /></label>
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Message</div>
          <RichTextEditor value={body} onChange={setBody} minHeight={240} />
        </div>
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save email'}</button>
        </div>
      </div>
    </Modal>
  )
}

function DripActivity({ id, name, onClose }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { authFetch(`/api/drips/${id}/activity`).then(r => r.json()).then(d => { setRows(Array.isArray(d) ? d : []); setLoading(false) }).catch(() => setLoading(false)) }, [id])
  const color = { active: '#3b82f6', completed: '#10b981', failed: '#ef4444', removed: '#94a3b8' }
  return (
    <Modal open onClose={onClose} title={`${name} — Activity`} wide>
      {loading ? <div style={{ padding: 20, color: 'var(--text-muted)' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center' }}>No contacts in this drip yet. They’re added by automations that use the “Start Drip Campaign” action.</div>
          : (
            <table className="data-table"><thead><tr><th>Contact</th><th>Status</th><th>On email</th><th>Next send</th></tr></thead>
              <tbody>{rows.map(r => (
                <tr key={r.id}>
                  <td>{(r.first_name || '') + ' ' + (r.last_name || '') || r.email || `#${r.client_id}`}</td>
                  <td><span style={{ color: color[r.status] || 'inherit', fontWeight: 600 }}>{r.status}</span></td>
                  <td>{(r.current_step ?? 0) + 1}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.next_run_at ? String(r.next_run_at).replace('T', ' ').slice(0, 16) : '—'}</td>
                </tr>))}</tbody>
            </table>
          )}
    </Modal>
  )
}

const Stat = ({ n, label, color }) => <div><div style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--text-primary)' }}>{n ?? 0}</div><div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</div></div>
