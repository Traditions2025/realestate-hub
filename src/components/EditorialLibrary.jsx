// Writing Reference Library and team writing rules for the editorial engine.
import React, { useEffect, useState } from 'react'
import { authFetch } from '../api'
import { notify, confirmDialog } from '../notify'
import Modal from './Modal'

const api = async (url, opts = {}) => {
  const r = await authFetch(url, opts)
  const d = await r.json().catch(() => ({}))
  if (!r.ok || d?.error) throw new Error(d?.error || `HTTP ${r.status}`)
  return d
}
const send = (method, url, body) => api(url, { method, body: JSON.stringify(body || {}) })
const LABEL_NAMES = { excellent: 'Excellent', acceptable: 'Acceptable', needs_improvement: 'Needs Improvement', do_not_imitate: 'Do Not Imitate' }
const when = (s) => s ? new Date(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z')).toLocaleDateString() : ''

function LibraryTab() {
  const [rows, setRows] = useState([])
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState(null)
  const load = () => api('/api/editorial/library' + (filter ? `?label=${filter}` : '')).then(setRows).catch(e => notify(e.message))
  useEffect(() => { load() }, [filter])
  const update = async (id, fields) => { try { await send('PUT', `/api/editorial/library/${id}`, fields); load() } catch (e) { notify(e.message) } }
  const remove = async (id) => { if (await confirmDialog('Remove this example from the library?')) { await send('DELETE', `/api/editorial/library/${id}`); load() } }
  return (
    <div>
      <p className="muted">Approved copy the engine learns style from. It picks the closest examples by property type and positioning, newest first, and never borrows their facts. "Do Not Imitate" examples are shown to it as what to avoid.</p>
      <div className="ed-controls">
        <label>Show
          <select value={filter} onChange={e => setFilter(e.target.value)}>
            <option value="">All labels</option>
            {Object.entries(LABEL_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </div>
      {!rows.length && <p className="muted">Nothing here yet. Use "Approve to library" on a listing's copy.</p>}
      {rows.map(r => (
        <div key={r.id} className="asset-card">
          <div className="asset-header">
            <h4>{[r.property_type, r.channel !== 'mls' ? r.channel : null].filter(Boolean).join(' · ') || 'Example'}</h4>
            <div className="asset-actions">
              <select value={r.label} onChange={e => update(r.id, { label: e.target.value })}>
                {Object.entries(LABEL_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button type="button" className="btn-sm btn-secondary" onClick={() => remove(r.id)}>Remove</button>
            </div>
          </div>
          <div className="muted ed-hmeta">{r.price_positioning}{r.approved_by ? ` · approved by ${r.approved_by}` : ''} · {when(r.approved_at)}</div>
          <p className="ed-libtext">{r.approved_text}</p>
          {r.edit_reasons && <p className="ed-review"><strong>Why:</strong> {r.edit_reasons}</p>}
          {r.original_draft && r.original_draft !== r.approved_text && (
            <button type="button" className="btn-sm btn-secondary" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Show'} original AI draft</button>
          )}
          {open === r.id && <p className="ed-libtext ed-draft">{r.original_draft}</p>}
        </div>
      ))}
    </div>
  )
}

function RulesTab() {
  const [rules, setRules] = useState([])
  const [feedback, setFeedback] = useState([])
  const [history, setHistory] = useState(null)
  const [draft, setDraft] = useState({ rule_text: '', kind: 'guidance', pattern: '' })
  const [editing, setEditing] = useState(null)
  const load = () => {
    api('/api/editorial/rules').then(setRules).catch(e => notify(e.message))
    api('/api/editorial/feedback').then(setFeedback).catch(() => {})
  }
  useEffect(() => { load() }, [])
  const create = async (body) => {
    try { await send('POST', '/api/editorial/rules', body); setDraft({ rule_text: '', kind: 'guidance', pattern: '' }); load(); setHistory(null) } catch (e) { notify(e.message) }
  }
  const update = async (id, fields) => {
    try { await send('PUT', `/api/editorial/rules/${id}`, fields); setEditing(null); load(); setHistory(null) } catch (e) { notify(e.message) }
  }
  const suggestions = feedback.filter(f => !f.has_rule)
  return (
    <div>
      <p className="muted">Team rules are added to every generation. "Avoid phrase" rules are also enforced by the checker, so copy containing the phrase is flagged as an error. Every change is kept in the history.</p>

      {suggestions.length > 0 && (
        <div className="asset-card">
          <div className="asset-header"><h4>Recurring feedback</h4></div>
          {suggestions.map(s => (
            <div key={s.feedback_key} className="ed-hrow">
              <div><strong>{s.text}</strong> <span className="muted">· {s.n}× · last {when(s.last_at)}</span>{s.suggest_rule && <span className="ed-chip">suggested rule</span>}</div>
              <div className="muted">{s.proposed_rule}</div>
              <button type="button" className="btn-sm btn-secondary" onClick={() => create({ rule_text: s.proposed_rule, kind: s.proposed_kind, pattern: s.proposed_pattern, feedback_key: s.feedback_key, reason: `Adopted from feedback given ${s.n} times` })}>Adopt as rule</button>
            </div>
          ))}
        </div>
      )}

      <div className="asset-card">
        <div className="asset-header"><h4>Rules</h4><button type="button" className="btn-sm btn-secondary" onClick={() => (history ? setHistory(null) : api('/api/editorial/rules/history').then(setHistory))}>{history ? 'Hide history' : 'Change history'}</button></div>
        {!rules.length && <p className="muted">No team rules yet.</p>}
        {rules.map(r => (
          <div key={r.id} className={`ed-hrow ${r.active ? '' : 'ed-off'}`}>
            {editing?.id === r.id ? (
              <>
                <input value={editing.rule_text} onChange={e => setEditing(x => ({ ...x, rule_text: e.target.value }))} />
                {r.kind === 'avoid_phrase' && <input value={editing.pattern || ''} onChange={e => setEditing(x => ({ ...x, pattern: e.target.value }))} placeholder="Phrase to flag" />}
                <div className="ed-actions">
                  <button type="button" className="btn-sm btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="btn-sm btn-primary" onClick={() => update(r.id, { rule_text: editing.rule_text, pattern: editing.pattern })}>Save</button>
                </div>
              </>
            ) : (
              <>
                <div>{r.rule_text} {r.kind === 'avoid_phrase' && <span className="ed-chip">checker flags “{r.pattern}”</span>}</div>
                <div className="muted ed-hmeta">{r.source}{r.created_by ? ` · ${r.created_by}` : ''} · {when(r.created_at)}</div>
                <div className="ed-actions">
                  <button type="button" className="btn-sm btn-secondary" onClick={() => setEditing({ id: r.id, rule_text: r.rule_text, pattern: r.pattern })}>Edit</button>
                  <button type="button" className="btn-sm btn-secondary" onClick={() => update(r.id, { active: !r.active })}>{r.active ? 'Turn off' : 'Turn on'}</button>
                </div>
              </>
            )}
          </div>
        ))}
        {history && (
          <div className="ed-history">
            {history.map(h => <div key={h.id} className="ed-hmeta">{when(h.changed_at)} · {h.action} · {h.rule_text}{h.changed_by ? ` · ${h.changed_by}` : ''}{h.reason ? ` · ${h.reason}` : ''}</div>)}
          </div>
        )}
      </div>

      <div className="asset-card">
        <div className="asset-header"><h4>Add a rule</h4></div>
        <div className="ed-more">
          <label>Type
            <select value={draft.kind} onChange={e => setDraft(d => ({ ...d, kind: e.target.value }))}>
              <option value="guidance">Writing guidance</option>
              <option value="avoid_phrase">Avoid a phrase (checker enforced)</option>
            </select>
          </label>
          <label className="ed-wide">Rule<input value={draft.rule_text} onChange={e => setDraft(d => ({ ...d, rule_text: e.target.value }))} placeholder='e.g. Say "primary bedroom", never "owner&apos;s suite"' /></label>
          {draft.kind === 'avoid_phrase' && <label className="ed-wide">Phrase to flag<input value={draft.pattern} onChange={e => setDraft(d => ({ ...d, pattern: e.target.value }))} placeholder="e.g. owner's suite" /></label>}
        </div>
        <div className="ed-actions"><button type="button" className="btn-sm btn-primary" disabled={!draft.rule_text.trim()} onClick={() => create({ ...draft, pattern: draft.kind === 'avoid_phrase' ? draft.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : null })}>Add rule</button></div>
      </div>
    </div>
  )
}

function SettingsTab() {
  const [s, setS] = useState(null)
  useEffect(() => { api('/api/editorial/meta').then(m => setS(m.settings)).catch(e => notify(e.message)) }, [])
  if (!s) return null
  const save = async () => { try { setS(await send('PUT', '/api/editorial/settings', s)); notify('Saved.') } catch (e) { notify(e.message) } }
  return (
    <div>
      <div className="ed-more">
        <label>Default MLS character limit<input type="number" min="200" max="5000" value={s.mls_char_limit} onChange={e => setS(x => ({ ...x, mls_char_limit: e.target.value }))} /></label>
      </div>
      <label className="ed-block">Verified local market context (optional)
        <textarea rows={6} value={s.market_context} onChange={e => setS(x => ({ ...x, market_context: e.target.value }))} placeholder="Only verified figures with their source and date, e.g. Linn County median sale price, days on market. Used for positioning judgment, never quoted as a promise." />
      </label>
      <div className="ed-actions"><button type="button" className="btn-sm btn-primary" onClick={save}>Save settings</button></div>
    </div>
  )
}

export default function EditorialLibrary({ open, onClose }) {
  const [tab, setTab] = useState('library')
  return (
    <Modal open={open} onClose={onClose} wide title="Writing library and rules">
      <div className="ed-channels">
        {[['library', 'Reference library'], ['rules', 'Rules and feedback'], ['settings', 'Settings']].map(([k, l]) => (
          <button key={k} type="button" className={`ed-ch ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'library' && <LibraryTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'settings' && <SettingsTab />}
    </Modal>
  )
}
