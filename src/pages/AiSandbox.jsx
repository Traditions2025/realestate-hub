import React, { useState, useRef, useEffect } from 'react'
import { authFetch } from '../api'

// AI Sandbox — chat with the real Hub AI as if you were a lead, watch it think in real
// time (intent, reasoning, extracted memory, chosen action), and drive it with canned
// lead activities. Nothing here sends a text or touches a real lead.

// Canned "lead activities" the AI treats as conversation starters.
const ACTIVITIES = [
  { icon: '🏠', label: 'Tour request', type: 'buyer', text: 'Hi, is that ranch on Prairie Rose Dr in Marion still available? Could we see it this Saturday?' },
  { icon: '💰', label: 'Home value (seller)', type: 'seller', text: "We're thinking about selling our house on Oakland Rd NE. What do you think it's worth in this market?" },
  { icon: '👀', label: 'Repeat viewer', type: 'buyer', text: "I keep coming back to that 3-bed on Example Ave, is it a good deal? What are the taxes like?" },
  { icon: '💵', label: 'Financing question', type: 'buyer', text: 'Do I need to be pre-approved before we start looking? Not sure where to start.' },
  { icon: '⏱️', label: 'Short timeframe', type: 'buyer', text: 'We need to be in a new place within 30 days, our lease is ending. Can you help fast?' },
  { icon: '🤔', label: 'Just browsing', type: 'buyer', text: 'Just looking for now, not really ready to buy yet. Maybe next year.' },
  { icon: '📍', label: 'Area question', type: 'buyer', text: 'What are the best neighborhoods in Cedar Rapids for a family with young kids?' },
  { icon: '🏡', label: 'FSBO owner', type: 'seller', text: "I'm selling my place myself right now. Why would I need an agent?" },
  { icon: '🚫', label: 'Opt out / STOP', type: 'buyer', text: 'Please stop texting me.' },
  { icon: '😐', label: 'Price objection', type: 'buyer', text: "Homes seem overpriced right now. What will sellers actually take off asking?" },
]

const LEVEL_COLOR = { URGENT: '#ef4444', HIGH: '#f59e0b', ENGAGED: '#10b981', NURTURE: '#2563eb', LOW: '#64748b' }
const ACTION_LABEL = { SEND_TEXT: 'Send text', NO_ACTION: 'No action', WAIT: 'Wait', HANDOFF: 'Hand to human' }

export default function AiSandbox() {
  const [leadName, setLeadName] = useState('Alex')
  const [leadType, setLeadType] = useState('buyer')
  const [leadCity, setLeadCity] = useState('Marion')
  const [messages, setMessages] = useState([])   // {role:'lead'|'agent', text, work?}
  const [intent, setIntent] = useState(0)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const scrollRef = useRef(null)
  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight) }, [messages, busy])

  const reset = () => { setMessages([]); setIntent(0); setErr(''); setInput('') }

  const send = async (text, typeOverride) => {
    const t = String(text || '').trim(); if (!t || busy) return
    const type = typeOverride || leadType
    if (typeOverride && typeOverride !== leadType) setLeadType(typeOverride)
    setErr('')
    const history = messages.map(m => ({ role: m.role === 'agent' ? 'agent' : 'lead', text: m.text }))
    const next = [...messages, { role: 'lead', text: t }]
    setMessages(next); setInput(''); setBusy(true)
    try {
      const r = await authFetch('/api/ai/sandbox', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead: { name: leadName, type, city: leadCity }, messages: history, latest: t, intent }),
      })
      const d = await r.json()
      if (d.error) { setErr(d.error); setBusy(false); return }
      setIntent(d.intent_after)
      setMessages(m => [...m, { role: 'agent', text: d.message || '(no message — the AI chose not to reply)', work: d }])
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  const startActivity = (a) => { reset(); setLeadType(a.type); setTimeout(() => send(a.text, a.type), 0) }

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>AI Sandbox</h1><p className="page-subtitle">Talk to the real Hub AI as if you were a lead and watch it work — intent, reasoning, what it learned, and what it decides. Nothing is sent; no real lead is touched.</p></div>
        <button className="btn btn-secondary" onClick={reset}>↺ Reset</button>
      </div>

      {/* Lead setup */}
      <div className="detail-section" style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
          <label style={{ fontSize: 12 }}>Lead name<br /><input className="input" value={leadName} onChange={e => setLeadName(e.target.value)} style={{ width: 130 }} /></label>
          <label style={{ fontSize: 12 }}>Type<br /><select className="input" value={leadType} onChange={e => setLeadType(e.target.value)} style={{ width: 130 }}><option value="buyer">Buyer</option><option value="seller">Seller</option><option value="both">Buyer/Seller</option></select></label>
          <label style={{ fontSize: 12 }}>City<br /><input className="input" value={leadCity} onChange={e => setLeadCity(e.target.value)} style={{ width: 130 }} /></label>
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Live intent</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: LEVEL_COLOR[levelName(intent)] }}>{intent} <span style={{ fontSize: 13 }}>{levelName(intent)}</span></div>
          </div>
        </div>
      </div>

      {/* Lead activity starters */}
      <div className="detail-section" style={{ marginBottom: 14 }}>
        <h4 style={{ marginTop: 0 }}>Start from a lead activity</h4>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {ACTIVITIES.map(a => (
            <button key={a.label} className="btn btn-sm btn-secondary" disabled={busy} onClick={() => startActivity(a)} title={a.text}>{a.icon} {a.label}</button>
          ))}
        </div>
      </div>

      {/* Conversation */}
      <div className="detail-section" style={{ marginBottom: 14 }}>
        <div ref={scrollRef} style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: 4 }}>
          {messages.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13, textAlign: 'center', padding: 20 }}>Pick a lead activity above, or type a message as the lead below.</div>}
          {messages.map((m, i) => m.role === 'lead' ? (
            <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '80%', background: '#2563eb', color: '#fff', padding: '8px 12px', borderRadius: '12px 12px 2px 12px', fontSize: 14 }}>{m.text}</div>
          ) : (
            <div key={i} style={{ alignSelf: 'flex-start', maxWidth: '88%' }}>
              <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', padding: '8px 12px', borderRadius: '12px 12px 12px 2px', fontSize: 14 }}>{m.text}</div>
              {m.work && <WorkPanel work={m.work} />}
            </div>
          ))}
          {busy && <div style={{ alignSelf: 'flex-start', color: 'var(--text-muted)', fontSize: 13 }}>AI is thinking…</div>}
        </div>
      </div>

      {err && <div className="detail-section" style={{ marginBottom: 14, color: '#ef4444', fontSize: 13 }}>{err}</div>}

      {/* Composer (you play the lead) */}
      <div style={{ display: 'flex', gap: 8 }}>
        <input className="input" style={{ flex: 1 }} placeholder="Type as the lead…" value={input}
          onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send(input) }} disabled={busy} />
        <button className="btn btn-primary" onClick={() => send(input)} disabled={busy || !input.trim()}>Send as lead</button>
      </div>
    </div>
  )
}

function levelName(n) { return n >= 85 ? 'URGENT' : n >= 70 ? 'HIGH' : n >= 50 ? 'ENGAGED' : n >= 25 ? 'NURTURE' : 'LOW' }

// The AI's "actual work" for one turn.
function WorkPanel({ work }) {
  const mem = flattenMemory(work.memory)
  return (
    <div style={{ marginTop: 6, background: 'rgba(37,99,235,0.05)', border: '1px solid rgba(37,99,235,0.2)', borderRadius: 8, padding: '8px 11px', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, color: '#2563eb' }}>🤖 AI work</span>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#fff', background: '#2563eb', padding: '1px 7px', borderRadius: 4 }}>{ACTION_LABEL[work.action] || work.action}</span>
        <span>intent {work.intent_before} → <b style={{ color: LEVEL_COLOR[work.intent_level] }}>{work.intent_after}</b> ({work.intent_delta >= 0 ? '+' : ''}{work.intent_delta})</span>
        {work.conversation_type && <span style={{ color: 'var(--text-muted)' }}>· type: {work.conversation_type}</span>}
        {work.handoff?.required && <span style={{ color: '#b45309', fontWeight: 700 }}>· ⚑ handoff: {work.handoff.reason}</span>}
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: 11 }}>{work.latency_ms}ms</span>
      </div>
      {work.intent_signals?.length > 0 && <div style={{ marginTop: 4 }}><b>Signals:</b> {work.intent_signals.join(' · ')}</div>}
      {mem.length > 0 && <div style={{ marginTop: 4 }}><b>Learned:</b> {mem.map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>}
      {work.summary && <div style={{ marginTop: 4, color: 'var(--text-secondary)', fontStyle: 'italic' }}>{work.summary}</div>}
      {work.next_state && <div style={{ marginTop: 4, color: 'var(--text-muted)', fontSize: 11 }}>Next state: {work.next_state}</div>}
    </div>
  )
}
function flattenMemory(m) {
  const out = []
  for (const bucket of ['buyer', 'seller', 'general']) {
    const o = m && m[bucket]; if (!o || typeof o !== 'object') continue
    for (const [k, v] of Object.entries(o)) { if (v != null && v !== '' && !(Array.isArray(v) && !v.length)) out.push([k, Array.isArray(v) ? v.join(', ') : String(v)]) }
  }
  if (m && m.lead_type) out.push(['lead_type', m.lead_type])
  return out
}
