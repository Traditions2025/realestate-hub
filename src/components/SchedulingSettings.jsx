// Settings > Calendar / Scheduling (John, 2026-09-18): team availability by
// weekday (multiple windows per day), blocked dates, and the appointment-type
// manager that powers the public /book/{slug} pages — new booking pages need
// zero code.
import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import { notify, confirmDialog } from '../notify'

const WD = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const toHM = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0) }
const inp = { padding: '6px 8px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }

export default function SchedulingSettings() {
  const [data, setData] = useState(null)
  const [types, setTypes] = useState([])
  const [member, setMember] = useState('Matt Smith')
  const load = () => {
    authFetch('/api/scheduling/availability').then(r => r.json()).then(setData).catch(() => {})
    authFetch('/api/scheduling/types').then(r => r.json()).then(d => setTypes(Array.isArray(d) ? d : [])).catch(() => {})
  }
  useEffect(() => { load() }, [])
  if (!data) return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Loading…</div>
  const members = [...new Set(['Matt Smith', ...data.hours.map(h => h.team_member)])]
  const hours = data.hours.filter(h => h.team_member === member)

  const saveHours = async (newHours) => {
    const r = await authFetch('/api/scheduling/availability', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team_member: member, hours: newHours }) })
    const d = await r.json(); if (d.error) notify('⚠ ' + d.error); else { notify('Availability saved'); load() }
  }

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {/* ── working hours ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <strong style={{ fontSize: 14 }}>Working hours</strong>
          <select style={inp} value={member} onChange={e => setMember(e.target.value)}>
            {members.map(m => <option key={m}>{m}</option>)}
          </select>
        </div>
        {WD.map((day, wd) => {
          const wins = hours.filter(h => h.weekday === wd)
          return (
            <div key={wd} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 13, flexWrap: 'wrap' }}>
              <span style={{ minWidth: 88, color: wins.length ? 'var(--text-primary)' : 'var(--text-muted)' }}>{day}</span>
              {wins.map(w => (
                <span key={w.id} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, padding: '3px 8px' }}>
                  {toHM(w.start_min)}–{toHM(w.end_min)}
                  <button className="tag-remove-btn" onClick={() => saveHours(hours.filter(h => h.id !== w.id))}>✕</button>
                </span>
              ))}
              {!wins.length && <span style={{ color: 'var(--text-muted)' }}>Unavailable</span>}
              <button className="btn-sm" onClick={async () => {
                const start = prompt(`${day} — start time (HH:MM, 24h):`, '09:00'); if (!start) return
                const end = prompt(`${day} — end time (HH:MM, 24h):`, '17:00'); if (!end) return
                saveHours([...hours, { weekday: wd, start_min: toMin(start), end_min: toMin(end) }])
              }}>+ window</button>
            </div>
          )
        })}
      </div>

      {/* ── blocked dates ── */}
      <div>
        <strong style={{ fontSize: 14 }}>Blocked dates (vacation / personal / manual holds)</strong>
        <div style={{ marginTop: 6 }}>
          {data.exceptions.map(x => (
            <div key={x.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
              <span>{x.date}</span>
              <span style={{ color: 'var(--text-muted)' }}>{x.start_min != null ? `${toHM(x.start_min)}–${toHM(x.end_min)}` : 'all day'} · {x.team_member}{x.reason ? ` · ${x.reason}` : ''}</span>
              <button className="tag-remove-btn" onClick={async () => { await authFetch('/api/scheduling/exceptions/' + x.id, { method: 'DELETE' }); load() }}>✕</button>
            </div>
          ))}
          {!data.exceptions.length && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Nothing blocked.</div>}
          <BlockForm member={member} onDone={load} />
        </div>
      </div>

      {/* ── appointment types ── */}
      <div>
        <strong style={{ fontSize: 14 }}>Appointment types</strong>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: '2px 0 8px' }}>Each active type has a public booking page at <code>/book/&#123;slug&#125;</code> — share that link anywhere (Meta forms, emails, texts).</div>
        {types.map(t => <TypeRow key={t.id} t={t} onChanged={load} />)}
        <NewTypeForm onDone={load} />
      </div>
    </div>
  )
}

function BlockForm({ member, onDone }) {
  const [date, setDate] = useState('')
  const [allDay, setAllDay] = useState(true)
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('17:00')
  const [reason, setReason] = useState('')
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
      <input style={inp} type="date" value={date} onChange={e => setDate(e.target.value)} />
      <label style={{ fontSize: 12.5, display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)} /> all day</label>
      {!allDay && <><input style={{ ...inp, width: 86 }} type="time" value={start} onChange={e => setStart(e.target.value)} /><input style={{ ...inp, width: 86 }} type="time" value={end} onChange={e => setEnd(e.target.value)} /></>}
      <input style={{ ...inp, width: 140 }} placeholder="Reason (optional)" value={reason} onChange={e => setReason(e.target.value)} />
      <button className="btn btn-sm btn-secondary" disabled={!date} onClick={async () => {
        const body = { team_member: member, date, reason }
        if (!allDay) { body.start_min = toMin(start); body.end_min = toMin(end) }
        const r = await authFetch('/api/scheduling/exceptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        const d = await r.json(); if (d.error) notify('⚠ ' + d.error); else { setDate(''); setReason(''); onDone() }
      }}>Block</button>
    </div>
  )
}

function TypeRow({ t, onChanged }) {
  const act = async (method, path, body) => {
    const r = await authFetch('/api/scheduling/types/' + t.id + (path || ''), { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const d = await r.json(); if (d.error) notify('⚠ ' + d.error); else onChanged()
  }
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 13, padding: '6px 0', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
      <strong style={{ opacity: t.active ? 1 : .5 }}>{t.name}</strong>
      <span style={{ color: 'var(--text-muted)' }}>{t.duration_min} min · /book/{t.slug}{t.active ? '' : ' · inactive'}</span>
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        <a className="btn-sm btn" style={{ textDecoration: 'none' }} href={'/book/' + t.slug} target="_blank" rel="noreferrer">Open</a>
        <button className="btn-sm" onClick={() => act('PUT', '', { active: !t.active })}>{t.active ? 'Deactivate' : 'Activate'}</button>
        <button className="btn-sm btn-danger" onClick={async () => { if (await confirmDialog(`Delete "${t.name}"?\nIf appointments reference it, it is archived instead.`)) act('DELETE', '') }}>Delete</button>
      </span>
    </div>
  )
}

function NewTypeForm({ onDone }) {
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ name: '', slug: '', duration_min: 30, description: '', min_notice_hours: 4, max_days_ahead: 21, buffer_after_min: 15, require_address: true })
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  if (!open) return <button className="btn btn-sm btn-secondary" style={{ marginTop: 8 }} onClick={() => setOpen(true)}>+ New appointment type</button>
  return (
    <div style={{ display: 'grid', gap: 8, marginTop: 10, maxWidth: 480 }}>
      <input style={inp} placeholder="Internal name (e.g. Seller Consultation)" value={f.name} onChange={e => { set('name', e.target.value); if (!f.slugEdited) set('slug', e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')) }} />
      <input style={inp} placeholder="slug (public URL: /book/slug)" value={f.slug} onChange={e => { set('slug', e.target.value); set('slugEdited', true) }} />
      <textarea style={{ ...inp, resize: 'vertical' }} rows={2} placeholder="Public description" value={f.description} onChange={e => set('description', e.target.value)} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12.5, alignItems: 'center' }}>
        <label>Duration <input style={{ ...inp, width: 60 }} type="number" value={f.duration_min} onChange={e => set('duration_min', +e.target.value)} /> min</label>
        <label>Notice <input style={{ ...inp, width: 54 }} type="number" value={f.min_notice_hours} onChange={e => set('min_notice_hours', +e.target.value)} /> h</label>
        <label>Horizon <input style={{ ...inp, width: 54 }} type="number" value={f.max_days_ahead} onChange={e => set('max_days_ahead', +e.target.value)} /> d</label>
        <label>Buffer after <input style={{ ...inp, width: 54 }} type="number" value={f.buffer_after_min} onChange={e => set('buffer_after_min', +e.target.value)} /> min</label>
        <label><input type="checkbox" checked={f.require_address} onChange={e => set('require_address', e.target.checked)} /> requires address</label>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm btn-primary" disabled={!f.name || !f.slug} onClick={async () => {
          const r = await authFetch('/api/scheduling/types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) })
          const d = await r.json(); if (d.error) notify('⚠ ' + d.error); else { notify(`Type created — booking page live at /book/${f.slug}`); setOpen(false); onDone() }
        }}>Create</button>
        <button className="btn btn-sm btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  )
}
