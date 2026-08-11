import React, { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import RichTextEditor from '../components/RichTextEditor'

const CHANNELS = [
  { key: 'email', label: 'Emails', icon: '✉', color: '#2563eb' },
  { key: 'text', label: 'Texts', icon: '💬', color: '#10b981' },
  { key: 'call', label: 'Calls', icon: '☎', color: '#8b5cf6' },
  { key: 'voicemail', label: 'Voicemails', icon: '🎙', color: '#f59e0b' },
]
const chMeta = (k) => CHANNELS.find(c => c.key === k) || CHANNELS[0]
const INTENT_COLORS = { 'Needs Response': '#2563eb', 'Question': '#0ea5e9', 'Scheduling Request': '#8b5cf6', 'Property Interest': '#10b981', 'High Intent': '#ef4444', 'Information Request': '#f59e0b', 'No Response Needed': '#64748b' }
const intentBadgeStyle = (intent) => ({ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: '#fff', background: INTENT_COLORS[intent] || '#64748b', padding: '2px 6px', borderRadius: 4, whiteSpace: 'nowrap' })
const FOLDERS = [{ key: 'inbox', label: 'Inbox' }, { key: 'sent', label: 'Sent' }, { key: 'closed', label: 'Closed' }]

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(String(iso).includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function Inbox() {
  const [folder, setFolder] = useState('inbox')
  const [unreadOnly, setUnreadOnly] = useState(true)
  const [channels, setChannels] = useState(['email', 'text', 'call'])
  const [filterOpen, setFilterOpen] = useState(false)
  const [q, setQ] = useState('')
  const [convos, setConvos] = useState(null)
  const [totalUnread, setTotalUnread] = useState(0)
  const [counts, setCounts] = useState({ by_channel: {} })
  const [sel, setSel] = useState(null)
  const [thread, setThread] = useState([])
  const [compose, setCompose] = useState(false)
  // AI suggested reply + editable draft
  const [ai, setAi] = useState(null)                       // { intent, summary, suggestion, stale, has_incoming, ai_available, error }
  const [reply, setReply] = useState({ subject: '', body: '' })
  const [aiBusy, setAiBusy] = useState('')
  const [aiCtx, setAiCtx] = useState('')
  const [sending, setSending] = useState(false)
  const [replyOpen, setReplyOpen] = useState(false)   // AI/reply composer minimized by default (saves space)
  const [openMsgs, setOpenMsgs] = useState({})        // per-message expand overrides (Gmail-style thread collapse)

  const load = useCallback(() => {
    const p = new URLSearchParams({ folder, unread: unreadOnly ? '1' : '0', channels: channels.join(','), q })
    authFetch('/api/inbox?' + p).then(r => r.json()).then(d => { setConvos(d.conversations || []); setTotalUnread(d.total_unread || 0) }).catch(() => setConvos([]))
    authFetch('/api/inbox/counts').then(r => r.json()).then(setCounts).catch(() => {})
  }, [folder, unreadOnly, channels, q])
  useEffect(() => { load() }, [load])

  const openThread = (clientId) => {
    if (!clientId) return
    setSel(clientId)
    setAi(null); setReply({ subject: '', body: '' }); setAiCtx(''); setReplyOpen(false); setOpenMsgs({})
    authFetch(`/api/inbox/thread/${clientId}`).then(r => r.json()).then(setThread).catch(() => setThread([]))
    authFetch(`/api/inbox/thread/${clientId}/read`, { method: 'POST' }).then(() => load()).catch(() => {})
    // AI: restore a saved draft, else the suggestion; generate on first open / when a newer email arrived
    authFetch(`/api/inbox/thread/${clientId}/ai`).then(r => r.json()).then(a => {
      setAi(a)
      const hasDraft = a.draft && (a.draft.subject || a.draft.body)
      if (hasDraft) setReply({ subject: a.draft.subject || '', body: a.draft.body || '' })
      else if (a.suggestion && !a.stale) setReply({ subject: a.suggestion.subject || '', body: a.suggestion.body || '' })
      else if (a.ai_available && a.has_incoming) generateSuggestion(clientId, true)
      else if (a.suggestion) setReply({ subject: a.suggestion.subject || '', body: a.suggestion.body || '' })
    }).catch(() => {})
  }
  const closeThread = (clientId) => authFetch(`/api/inbox/thread/${clientId}/close`, { method: 'POST' }).then(() => { setSel(null); load() })

  // Generate/regenerate the AI suggestion. force=true overwrites the editor
  // (Regenerate / first open); otherwise it only fills an empty editor.
  const generateSuggestion = async (cid, force) => {
    cid = cid || sel; if (!cid) return
    setAiBusy('suggest')
    try {
      const r = await authFetch(`/api/inbox/thread/${cid}/ai/suggest`, { method: 'POST' })
      const d = await r.json()
      if (d.error) setAi(a => ({ ...(a || {}), error: d.error }))
      else {
        setAi(a => ({ ...(a || {}), intent: d.intent, summary: d.summary, suggestion: d.suggestion, stale: false, has_incoming: d.has_incoming !== false, error: null }))
        setReply(prev => (force || !(prev.body && prev.body.trim())) ? { subject: d.suggestion?.subject || '', body: d.suggestion?.body || '' } : prev)
      }
    } catch (e) { setAi(a => ({ ...(a || {}), error: e.message })) }
    finally { setAiBusy('') }
  }
  const adjustReply = async (instruction, context) => {
    if (!sel) return
    setAiBusy(context ? 'context' : instruction)
    try {
      const r = await authFetch(`/api/inbox/thread/${sel}/ai/adjust`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction, context, current: reply }) })
      const d = await r.json()
      if (d.error) alert(d.error)
      else if (d.reply) { setReply({ subject: d.reply.subject || reply.subject, body: d.reply.body || '' }); if (context) setAiCtx('') }
    } catch (e) { alert(e.message) }
    finally { setAiBusy('') }
  }
  const useSuggested = () => { if (ai?.suggestion) setReply({ subject: ai.suggestion.subject || '', body: ai.suggestion.body || '' }) }
  const clearDraft = () => setReply({ subject: '', body: '' })
  const sendReply = async () => {
    if (!sel) return
    if (!reply.body.trim()) { alert('Write a reply first.'); return }
    // Reply in the same channel as the conversation (text thread → text, else email).
    const threadChannel = (thread && thread.length) ? (thread[thread.length - 1].channel || 'email') : 'email'
    setSending(true)
    try {
      let payload
      if (threadChannel === 'text') {
        payload = { channel: 'text', client_ids: [sel], body: reply.body.trim() }
      } else {
        const subject = reply.subject.trim() || 'Re: your message'
        const html = reply.body.split(/\n{2,}/).map(p => `<div>${p.replace(/\n/g, '<br>')}</div>`).join('<div><br></div>')
        payload = { channel: 'email', client_ids: [sel], subject, body: html }
      }
      const r = await authFetch('/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const d = await r.json()
      if (d.error || !(d.sent > 0)) { alert(d.error || 'Send failed: ' + ((d.results || [])[0]?.error || 'unknown')); return }
      // clear the draft, refresh the thread + list
      await authFetch(`/api/inbox/thread/${sel}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: '', body: '' }) }).catch(() => {})
      setReply({ subject: '', body: '' })
      authFetch(`/api/inbox/thread/${sel}`).then(x => x.json()).then(setThread).catch(() => {})
      load()
    } catch (e) { alert(e.message) }
    finally { setSending(false) }
  }
  // persist the editor as a draft so it survives leaving/returning to the thread
  useEffect(() => {
    if (!sel) return
    const t = setTimeout(() => { authFetch(`/api/inbox/thread/${sel}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reply) }).catch(() => {}) }, 900)
    return () => clearTimeout(t)
  }, [reply, sel])

  const toggleChannel = (k) => setChannels(cs => cs.includes(k) ? cs.filter(x => x !== k) : [...cs, k])
  const selConvo = convos && convos.find(c => c.client_id === sel)

  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="page-header">
        <div>
          <h1>Inbox</h1>
          <p className="page-subtitle">All client calls, texts, and emails in one place. Only messages that match one of your clients appear here.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCompose(true)}>✎ New Message</button>
      </div>

      <div className="inbox-panes" style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', height: 'calc(100vh - 168px)', minHeight: 460 }}>
        {/* left: folders + filters */}
        <aside className="inbox-folders" style={{ width: 210, borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', padding: 14, flexShrink: 0 }}>
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>My Inbox</div>
          {FOLDERS.map(f => (
            <button key={f.key} onClick={() => { setFolder(f.key); setSel(null) }} style={folderBtn(folder === f.key)}>
              <span>{f.label}</span>
              {f.key === 'inbox' && totalUnread > 0 && <span style={badge}>{totalUnread}</span>}
            </button>
          ))}
          <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0 10px' }} />
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>Channels</div>
          {CHANNELS.map(c => (
            <label key={c.key} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, padding: '5px 0', cursor: 'pointer', fontSize: 13, fontWeight: 400 }}>
              <input type="checkbox" checked={channels.includes(c.key)} onChange={() => toggleChannel(c.key)} />
              <span style={{ color: c.color, fontVariantEmoji: 'text' }}>{c.icon}</span> {c.label}
              {(counts.by_channel?.[c.key] || 0) > 0 && <span style={{ ...badge, marginLeft: 'auto' }}>{counts.by_channel[c.key]}</span>}
            </label>
          ))}
        </aside>

        {/* middle: conversation list */}
        <div className="inbox-list" style={{ width: 380, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
              <button onClick={() => setUnreadOnly(false)} style={toggleBtn(!unreadOnly)}>All</button>
              <button onClick={() => setUnreadOnly(true)} style={toggleBtn(unreadOnly)}>Unread</button>
            </div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search…" style={{ flex: 1, padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }} />
          </div>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {convos === null ? <div style={pad}>Loading…</div>
              : convos.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: 30 }}>📭</div>
                  <div style={{ fontWeight: 600, marginTop: 8, color: 'var(--text-primary)' }}>{unreadOnly ? 'No unread messages' : 'No messages yet'}</div>
                  <div style={{ fontSize: 13, marginTop: 6 }}>Incoming client texts, calls, and emails will show up here once texting is connected. Only messages from a matched client appear.</div>
                </div>
              ) : convos.map(c => {
                const m = chMeta(c.last?.channel)
                return (
                  <div key={c.client_id || c.last?.id} onClick={() => openThread(c.client_id)}
                    style={{ display: 'flex', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: sel === c.client_id ? 'var(--bg-secondary)' : 'transparent' }}>
                    <div style={{ width: 8, display: 'flex', alignItems: 'flex-start', paddingTop: 5 }}>
                      {c.unread_count > 0 && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2563eb', display: 'inline-block' }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: c.unread_count ? 700 : 600, fontSize: 14 }}>{c.contact_name}</span>
                        {c.msg_count > 1 && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.msg_count}</span>}
                        {c.ai_intent && c.ai_intent !== 'No Response Needed' && <span style={intentBadgeStyle(c.ai_intent)}>{c.ai_intent}</span>}
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{fmtDate(c.last?.occurred_at)}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        <span title={m.label} style={{ color: m.color, fontSize: 12, fontVariantEmoji: 'text' }}>{m.icon}</span>
                        <span style={{ fontSize: 13, fontWeight: c.unread_count ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.last?.subject || c.last?.preview || '(no subject)'}</span>
                        {c.last?.has_attachment ? <span style={{ marginLeft: 'auto' }}>📎</span> : null}
                      </div>
                      {c.last?.subject && <div style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{c.last?.preview}</div>}
                    </div>
                  </div>
                )
              })}
          </div>
        </div>

        {/* right: reading pane */}
        <div className="inbox-reading" style={{ flex: 1, minWidth: 0, overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {!sel ? (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>
              <div style={{ fontSize: 34 }}>💬</div>
              <div style={{ marginTop: 8 }}>Select a conversation to read it.</div>
            </div>
          ) : (
            <>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700 }}>{selConvo?.contact_name || 'Conversation'}</div>
                <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => closeThread(sel)}>Close</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {thread.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>No messages.</div> : thread.map((m, idx) => {
                  const meta = chMeta(m.channel)
                  const out = m.direction === 'outgoing'
                  const total = thread.length
                  // Gmail-style: only the latest (and any unread incoming) message is expanded;
                  // older read messages collapse to a one-line summary. Click to toggle.
                  const expanded = (m.id in openMsgs) ? openMsgs[m.id] : (idx === total - 1 || (m.status === 'unread' && m.direction === 'incoming'))
                  const toggle = () => setOpenMsgs(o => ({ ...o, [m.id]: !expanded }))
                  if (!expanded) {
                    return (
                      <div key={m.id} onClick={toggle} title="Click to expand" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '9px 12px', cursor: 'pointer', background: 'var(--bg-secondary)', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                        <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>{out ? 'You' : (m.contact_name || 'Them')}</span>
                        <span style={{ fontSize: 13, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{m.subject ? m.subject + ' — ' : ''}{m.preview || ''}</span>
                        <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{fmtDate(m.occurred_at)}</span>
                      </div>
                    )
                  }
                  // Emails: render the HTML in a sandboxed frame (like a real mail client).
                  if (m.channel === 'email') {
                    const html = m.body || ''
                    const isHtml = /<[a-z!][\s\S]*>/i.test(html)
                    // Force the email to fit the frame width — many marketing/listing
                    // emails (e.g. Sierra) use a fixed ~600px table that would otherwise
                    // overflow the reading pane on smaller windows and create a
                    // horizontal scrollbar. This caps everything to the frame width.
                    const frameHtml = isHtml ? EMAIL_FIT_CSS + html : html
                    return (
                      <div key={m.id} style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                        <div onClick={total > 1 ? toggle : undefined} title={total > 1 ? 'Click to collapse' : undefined} style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', cursor: total > 1 ? 'pointer' : 'default' }}>
                          <span style={{ color: meta.color, fontVariantEmoji: 'text' }}>{meta.icon}</span> {out ? `You → ${m.contact_name}` : `${m.contact_name} → You`} · {fmtDate(m.occurred_at)}
                          {m.subject && <span style={{ fontWeight: 700, color: 'var(--text-primary)', marginLeft: 8 }}>{m.subject}</span>}
                        </div>
                        {isHtml
                          ? <iframe title={`email-${m.id}`} srcDoc={frameHtml} sandbox="allow-same-origin" onLoad={autoSizeFrame} style={{ width: '100%', maxWidth: '100%', border: 0, background: '#fff', minHeight: 220, display: 'block' }} />
                          : <div style={{ padding: 14, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 14, background: '#fff', color: '#0f172a' }}>{html || m.preview}</div>}
                      </div>
                    )
                  }
                  // Texts / calls / voicemails: chat bubble.
                  return (
                    <div key={m.id} style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textAlign: out ? 'right' : 'left' }}>
                        <span style={{ color: meta.color, fontVariantEmoji: 'text' }}>{meta.icon}</span> {meta.label.replace(/s$/, '')} · {out ? 'You' : m.contact_name} · {fmtDate(m.occurred_at)}
                      </div>
                      <div style={{ padding: '10px 13px', borderRadius: 12, background: out ? '#2563eb' : 'var(--bg-secondary)', color: out ? '#fff' : 'var(--text-primary)', border: out ? 'none' : '1px solid var(--border)' }}>
                        <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body || m.preview}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* ===== Reply + AI Suggested Response (minimized by default to keep the email view large) ===== */}
              {!replyOpen ? (
                <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-primary)' }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setReplyOpen(true)}>✍ Reply</button>
                  {ai && ai.intent && <span style={intentBadgeStyle(ai.intent)}>{ai.intent}</span>}
                  {ai && ai.summary && <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{ai.summary}</span>}
                  {aiBusy === 'suggest' && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reading…</span>}
                </div>
              ) : (
                <div style={{ borderTop: '1px solid var(--border)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-primary)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#a78bfa' }}>🤖 Suggested Response</span>
                    {ai && ai.intent && <span style={intentBadgeStyle(ai.intent)}>{ai.intent}</span>}
                    {ai && ai.stale && <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>● new email since last suggestion</span>}
                    <button className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={!!aiBusy} onClick={() => generateSuggestion(sel, true)}>{aiBusy === 'suggest' ? '…' : '↻ Regenerate'}</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => setReplyOpen(false)} title="Minimize">▾ Minimize</button>
                  </div>
                  {ai && ai.ai_available === false && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI is not configured on the server.</div>}
                  {ai && ai.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{ai.error}</div>}
                  {ai && ai.summary && <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', borderLeft: '2px solid rgba(124,58,237,0.4)', paddingLeft: 8 }}>{ai.summary}</div>}
                  {aiBusy === 'suggest' && !(ai && ai.summary) && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reading the conversation…</div>}

                  <input value={reply.subject} onChange={e => setReply(v => ({ ...v, subject: e.target.value }))} placeholder="Subject" style={{ padding: '7px 9px', fontSize: 13, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />
                  <textarea value={reply.body} onChange={e => setReply(v => ({ ...v, body: e.target.value }))} rows={5} placeholder="Write your reply…" style={{ padding: '8px 10px', fontSize: 13, lineHeight: 1.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', resize: 'vertical' }} />

                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={aiCtx} onChange={e => setAiCtx(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && aiCtx.trim() && !aiBusy) adjustReply(null, aiCtx.trim()) }} placeholder="Add context for the AI (e.g. tell them we can meet Saturday)…" style={{ flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 12.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />
                    <button className="btn btn-sm" disabled={!!aiBusy || !aiCtx.trim()} onClick={() => adjustReply(null, aiCtx.trim())}>{aiBusy === 'context' ? '…' : 'Apply'}</button>
                  </div>

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ai && ai.suggestion && <button className="btn btn-sm" disabled={!!aiBusy} onClick={useSuggested}>Use suggested</button>}
                    {[['shorter', 'Shorter'], ['casual', 'More casual'], ['direct', 'More direct'], ['warmer', 'Warmer']].map(([k, l]) => (
                      <button key={k} className="btn btn-sm" disabled={!!aiBusy || !reply.body.trim()} onClick={() => adjustReply(k)}>{aiBusy === k ? '…' : l}</button>
                    ))}
                    <button className="btn btn-sm" disabled={!reply.body.trim()} onClick={clearDraft}>Clear</button>
                    <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={sending || !reply.body.trim()} onClick={sendReply}>{sending ? 'Sending…' : '✉ Send reply'}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {compose && <Composer onClose={() => setCompose(false)} onSent={() => { setCompose(false); load() }} />}
    </div>
  )
}

function Composer({ onClose, onSent }) {
  const [channel, setChannel] = useState('email')
  const [recips, setRecips] = useState([])
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => authFetch('/api/inbox/contacts?q=' + encodeURIComponent(q.trim())).then(r => r.json()).then(setResults).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [q])

  const add = (c) => { if (!recips.find(r => r.id === c.id)) setRecips([...recips, c]); setQ(''); setResults([]) }
  const remove = (id) => setRecips(recips.filter(r => r.id !== id))

  const send = async () => {
    if (!recips.length) { alert('Add at least one recipient.'); return }
    if (!subject.trim() || !body.trim()) { alert('Add a subject and a message.'); return }
    setSending(true)
    const r = await authFetch('/api/inbox/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, client_ids: recips.map(x => x.id), subject, body }) }).then(x => x.json()).catch(e => ({ error: e.message }))
    setSending(false)
    if (r.error) { alert(r.error); return }
    const failed = (r.results || []).filter(x => !x.ok)
    alert(`Sent to ${r.sent} recipient(s).` + (failed.length ? ` ${failed.length} skipped (${failed.map(f => f.error).join(', ')}).` : ''))
    onSent()
  }
  const fld = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 13 }

  return (
    <Modal open onClose={onClose} title="New Message" wide>
      <div style={{ display: 'grid', gap: 12 }}>
        {/* channel toggle */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[{ k: 'email', label: '✉ Email' }, { k: 'text', label: '💬 Text' }].map(c => (
            <button key={c.k} onClick={() => setChannel(c.k)} className={`btn btn-sm ${channel === c.k ? 'btn-primary' : 'btn-secondary'}`}>{c.label}</button>
          ))}
          {channel === 'text' && <span style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'center', marginLeft: 6 }}>Texts send via Twilio (set it up in Settings).</span>}
        </div>

        {/* recipients */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>To ({channel === 'email' ? 'client emails' : 'client phones'})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {recips.map(r => (
              <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 14, padding: '3px 10px', fontSize: 12 }}>
                {`${r.first_name || ''} ${r.last_name || ''}`.trim() || r.email}
                <button onClick={() => remove(r.id)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--text-muted)' }}>✕</button>
              </span>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search a client by name, email, or phone…" style={fld} />
            {results.length > 0 && (
              <div style={{ position: 'absolute', zIndex: 5, top: '100%', left: 0, right: 0, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, marginTop: 4, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
                {results.map(c => (
                  <div key={c.id} onClick={() => add(c)} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>{`${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{channel === 'email' ? (c.email || 'no email') : (c.phone || 'no phone')}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {channel === 'email' && <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="Subject" style={fld} />}
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Message</div>
          {channel === 'email'
            ? <RichTextEditor value={body} onChange={setBody} minHeight={200} />
            : <textarea value={body} onChange={e => setBody(e.target.value)} rows={5} style={{ ...fld, resize: 'vertical' }} placeholder="Message" />}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={send} disabled={sending || channel === 'text'}>{sending ? 'Sending…' : channel === 'text' ? 'Text (needs Twilio)' : `Send to ${recips.length || ''}`.trim()}</button>
        </div>
      </div>
    </Modal>
  )
}

// Injected into every HTML email so it fits the reading pane width instead of
// forcing a horizontal scrollbar. Caps images/tables/elements to 100% width.
const EMAIL_FIT_CSS = `<style>
  html,body{margin:0;padding:10px;box-sizing:border-box;overflow-x:hidden;}
  body{word-wrap:break-word;overflow-wrap:anywhere;}
  img{max-width:100%!important;height:auto!important;}
  table{max-width:100%!important;}
  *{max-width:100%!important;box-sizing:border-box;}
</style>`

// size an email iframe to its rendered content (sandbox allow-same-origin lets us
// read the height; scripts inside the email still don't run). Also belt-and-
// suspenders: kill any residual horizontal scroll inside the frame.
function autoSizeFrame(e) {
  try {
    const doc = e.target.contentDocument
    if (doc) {
      if (doc.documentElement) doc.documentElement.style.overflowX = 'hidden'
      if (doc.body) {
        doc.body.style.overflowX = 'hidden'
        e.target.style.height = Math.min(doc.body.scrollHeight + 28, 900) + 'px'
      }
    }
  } catch { e.target.style.height = '400px' }
}

const folderBtn = (active) => ({ display: 'flex', alignItems: 'center', width: '100%', padding: '8px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13.5, marginBottom: 2, background: active ? 'var(--accent, #2563eb)' : 'transparent', color: active ? '#fff' : 'var(--text-primary)' })
const toggleBtn = (active) => ({ padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 12.5, background: active ? 'var(--accent, #2563eb)' : 'var(--bg-secondary)', color: active ? '#fff' : 'var(--text-primary)' })
const badge = { fontSize: 11, fontWeight: 700, background: '#2563eb', color: '#fff', borderRadius: 10, padding: '1px 7px', marginLeft: 'auto' }
const pad = { padding: 20, color: 'var(--text-muted)' }
