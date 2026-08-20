import React, { useState, useEffect, useCallback, useRef } from 'react'
import { authFetch } from '../api'

const DISPOSITIONS = ['Connected', 'Left voicemail', 'No answer', 'Busy', 'Wrong number', 'Appointment set', 'Interested', 'Not interested', 'Call back later', 'Do not call']
const PRESETS = [
  ['oldest_contact', 'Least recently contacted'],
  ['never_called', 'Never called'],
  ['new_leads', 'New leads (last 30 days)'],
  ['assigned', 'Assigned to me'],
]
const fmtWhen = (iso) => { if (!iso) return 'never'; try { return new Date(String(iso).includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) } catch { return iso } }
const fmtPhone = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || '') }

export default function PowerDialer() {
  const [preset, setPreset] = useState('oldest_contact')
  const [status, setStatus] = useState('')
  const [limit, setLimit] = useState(40)
  const [queue, setQueue] = useState(null)   // null = not started
  const [idx, setIdx] = useState(0)
  const [loading, setLoading] = useState(false)
  const [onCall, setOnCall] = useState(false)
  const [ended, setEnded] = useState(false)   // a call just finished → prompt outcome
  const [disp, setDisp] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [autoAdvance, setAutoAdvance] = useState(false)
  const myAgent = localStorage.getItem('mst_agent') || ''
  const idxRef = useRef(0); idxRef.current = idx
  const queueRef = useRef(null); queueRef.current = queue
  const autoRef = useRef(false); autoRef.current = autoAdvance

  const current = queue && idx < queue.length ? queue[idx] : null
  const done = queue && idx >= queue.length

  const loadQueue = useCallback(async () => {
    setLoading(true)
    try {
      const p = new URLSearchParams({ preset, limit: String(limit) })
      if (status) p.set('status', status)
      if (preset === 'assigned' && myAgent) p.set('assigned', myAgent)
      const ids = new URLSearchParams(window.location.search).get('client_ids')
      if (ids) p.set('client_ids', ids)
      const r = await authFetch('/api/dialer/queue?' + p)
      const d = await r.json()
      setQueue(Array.isArray(d) ? d : []); setIdx(0); setEnded(false); setDisp(''); setNotes('')
    } catch (e) { alert('Could not load the queue: ' + e.message) } finally { setLoading(false) }
  }, [preset, status, limit, myAgent])

  // Call lifecycle from the global softphone.
  useEffect(() => {
    const onStart = () => { setOnCall(true); setEnded(false) }
    const onEnd = () => { setOnCall(false); setEnded(true) }
    window.addEventListener('hubcall:started', onStart)
    window.addEventListener('hubcall:ended', onEnd)
    return () => { window.removeEventListener('hubcall:started', onStart); window.removeEventListener('hubcall:ended', onEnd) }
  }, [])

  // Deep-linked from a Clients selection (/dialer?client_ids=...) → build immediately.
  useEffect(() => { if (new URLSearchParams(window.location.search).get('client_ids')) loadQueue() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  const callNow = (c) => { if (c && window.hubCall) { setEnded(false); window.hubCall(c.phone, c.name) } else if (!window.hubCall) alert('The Hub phone isn’t connected yet.') }

  const saveAndNext = async () => {
    if (!current) return
    setSaving(true)
    try {
      await authFetch('/api/dialer/outcome', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: current.id, disposition: disp, notes, agent: myAgent || 'dialer' }) })
    } catch (e) { alert('Could not save: ' + e.message); setSaving(false); return }
    setSaving(false)
    const next = idx + 1
    setIdx(next); setDisp(''); setNotes(''); setEnded(false)
    // Auto-advance: immediately dial the next contact.
    if (autoRef.current) { const nc = queueRef.current && queueRef.current[next]; if (nc) setTimeout(() => callNow(nc), 600) }
  }
  const skip = () => { setIdx(i => i + 1); setDisp(''); setNotes(''); setEnded(false) }

  // ---------- Setup screen ----------
  if (queue === null) {
    return (
      <div className="page">
        <div className="page-header"><div><h1>Power Dialer</h1><p className="page-subtitle">Work a call list end to end — call, log the outcome, move to the next. Calls ring right here in the Hub.</p></div></div>
        <div className="detail-section" style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14, padding: 20 }}>
          <label style={{ fontSize: 13 }}>
            <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Who to call</div>
            <select value={preset} onChange={e => setPreset(e.target.value)} style={fld}>
              {PRESETS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {preset === 'assigned' && !myAgent && <div style={{ fontSize: 12, color: '#f59e0b' }}>Pick who you are in the Inbox sidebar first (the “I am” selector), or choose another list.</div>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 13, flex: 1 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Status (optional)</div>
              <input value={status} onChange={e => setStatus(e.target.value)} placeholder="e.g. lead, active" style={fld} />
            </label>
            <label style={{ fontSize: 13, width: 120 }}>
              <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>How many</div>
              <input type="number" min="1" max="200" value={limit} onChange={e => setLimit(e.target.value)} style={fld} />
            </label>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Do Not Contact and Junk leads, and anyone without a phone, are automatically skipped.</div>
          <button className="btn btn-primary" onClick={loadQueue} disabled={loading}>{loading ? 'Building…' : 'Build call queue →'}</button>
        </div>
      </div>
    )
  }

  // ---------- Done screen ----------
  if (done) {
    return (
      <div className="page">
        <div className="page-header"><div><h1>Power Dialer</h1></div></div>
        <div className="detail-section" style={{ maxWidth: 520, textAlign: 'center', padding: 30 }}>
          <div style={{ fontSize: 34 }}>✅</div>
          <div style={{ fontWeight: 700, marginTop: 8, fontSize: 18 }}>Queue complete</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 6 }}>You worked through {queue.length} contact{queue.length === 1 ? '' : 's'}.</div>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setQueue(null)}>Start a new queue</button>
        </div>
      </div>
    )
  }

  // ---------- Active dialer ----------
  const pct = Math.round((idx / queue.length) * 100)
  return (
    <div className="page">
      <div className="page-header">
        <div><h1>Power Dialer</h1><p className="page-subtitle">{idx + 1} of {queue.length} · {queue.length - idx - 1} left</p></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <label style={{ fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={autoAdvance} onChange={e => setAutoAdvance(e.target.checked)} /> Auto-dial next
          </label>
          <button className="btn btn-secondary btn-sm" onClick={() => setQueue(null)}>End session</button>
        </div>
      </div>

      <div style={{ height: 6, background: 'var(--bg-secondary)', borderRadius: 3, overflow: 'hidden', marginBottom: 16 }}>
        <div style={{ width: pct + '%', height: '100%', background: '#2563eb', transition: 'width .3s' }} />
      </div>

      <div className="detail-section" style={{ maxWidth: 640, padding: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 24, fontWeight: 800 }}>{current.name}</div>
          {current.status && <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#0369a1', background: 'rgba(3,105,161,.12)', padding: '2px 8px', borderRadius: 4 }}>{current.status}</span>}
          {current.agent_assigned && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {current.agent_assigned}</span>}
        </div>
        <div style={{ fontSize: 18, color: 'var(--text-secondary)', marginTop: 4 }}>{fmtPhone(current.phone)}</div>
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 12.5, color: 'var(--text-muted)' }}>
          {current.source && <span>Source: {current.source}</span>}
          {current.city && <span>{current.city}</span>}
          <span>Last contact: {fmtWhen(current.last_contact_at)}</span>
          <span>Last call: {fmtWhen(current.last_call_at)}</span>
        </div>
        {current.notes && <div style={{ marginTop: 10, fontSize: 13, fontStyle: 'italic', color: 'var(--text-secondary)', borderLeft: '2px solid var(--border)', paddingLeft: 10 }}>“{current.notes}”</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button className="btn btn-primary" style={{ fontSize: 16, padding: '12px 22px', background: onCall ? '#6b7280' : undefined }} onClick={() => callNow(current)} disabled={onCall}>
            {onCall ? '📞 On call…' : '📞 Call'}
          </button>
          <button className="btn btn-secondary" onClick={skip}>Skip →</button>
        </div>

        {(ended || disp || notes) && (
          <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--text-muted)', marginBottom: 8 }}>Call outcome</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
              {DISPOSITIONS.map(d => (
                <button key={d} onClick={() => setDisp(d)} className={`btn btn-sm ${disp === d ? 'btn-primary' : 'btn-secondary'}`} style={d === 'Do not call' && disp === d ? { background: '#ef4444' } : undefined}>{d}</button>
              ))}
            </div>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3} placeholder="Call notes…" style={{ ...fld, width: '100%', resize: 'vertical' }} />
            {disp === 'Do not call' && <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>Marks the contact Do Not Contact and removes them from all campaigns.</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary" disabled={saving} onClick={saveAndNext}>{saving ? 'Saving…' : (idx + 1 >= queue.length ? 'Save & finish' : 'Save & next →')}</button>
              {(disp || notes) && <button className="btn btn-secondary btn-sm" onClick={() => { setDisp(''); setNotes('') }}>Clear</button>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const fld = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }
