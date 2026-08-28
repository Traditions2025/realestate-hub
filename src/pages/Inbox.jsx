import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { authFetch } from '../api'
import Modal from '../components/Modal'
import RichTextEditor from '../components/RichTextEditor'
import TemplatePicker from '../components/TemplatePicker'

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
const DISPOSITIONS = ['Connected', 'Left voicemail', 'No answer', 'Busy', 'Wrong number', 'Appointment set', 'Interested', 'Not interested', 'Call back later', 'Do not call']

// Friendly delivery state for an outgoing text (never shows raw Twilio codes).
function deliveryText(m) {
  if (m.channel !== 'text' || m.direction !== 'outgoing') return null
  const s = String(m.delivery_status || '').toLowerCase()
  if (['queued', 'accepted', 'sending', 'scheduled'].includes(s)) return { t: 'Sending…', c: '#94a3b8' }
  if (s === 'sent') return { t: 'Sent', c: '#94a3b8' }
  if (s === 'delivered') return { t: '✓ Delivered', c: '#10b981' }
  if (['undelivered', 'failed'].includes(s)) return { t: '⚠ Failed' + (m.error_message ? ' · ' + m.error_message : ''), c: '#ef4444' }
  return null
}
const fmtDur = (s) => { s = Number(s || 0); return s ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '' }
const recUrl = (id) => `/api/inbox/recording/${id}?token=${encodeURIComponent(localStorage.getItem('mst_token') || '')}`
const mediaUrl = (id, idx) => `/api/inbox/media/${id}/${idx}?token=${encodeURIComponent(localStorage.getItem('mst_token') || '')}`
const stripTplHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim()
const firstUrl = (text) => { const m = String(text || '').match(/https?:\/\/[^\s<]+/); return m ? m[0].replace(/[.,)\]]+$/, '') : null }

// Render message text with clickable links (URLs become anchors).
function LinkifiedText({ text, light }) {
  const parts = String(text || '').split(/(https?:\/\/[^\s<]+)/g)
  return <>{parts.map((p, i) => /^https?:\/\//i.test(p)
    ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" style={{ color: light ? '#dbeafe' : '#2563eb', textDecoration: 'underline', wordBreak: 'break-all' }}>{p}</a>
    : <React.Fragment key={i}>{p}</React.Fragment>)}</>
}

// Rich preview card for the first link in a message (OpenGraph via the server).
function LinkPreview({ url }) {
  const [d, setD] = React.useState(undefined)
  React.useEffect(() => {
    let ok = true
    authFetch('/api/inbox/link-preview?url=' + encodeURIComponent(url)).then(r => r.json()).then(v => { if (ok) setD(v && !v.error ? v : null) }).catch(() => ok && setD(null))
    return () => { ok = false }
  }, [url])
  if (!d) return null
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: 'block', marginTop: 6, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', textDecoration: 'none', maxWidth: 300, background: 'var(--bg-primary)' }}>
      {d.image && <img src={d.image} alt="" onError={e => { e.target.style.display = 'none' }} style={{ width: '100%', maxHeight: 150, objectFit: 'cover', display: 'block' }} />}
      <div style={{ padding: '8px 10px' }}>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.03em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.site}</div>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.25, marginTop: 2 }}>{d.title}</div>
        {d.description && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{d.description}</div>}
      </div>
    </a>
  )
}

// Notes + disposition editor for a call/voicemail row.
function CallDispo({ m, onSaved }) {
  const [notes, setNotes] = React.useState(m.notes || '')
  const [disp, setDisp] = React.useState(m.disposition || '')
  const [saving, setSaving] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const save = async (patch) => {
    setSaving(true)
    try { await authFetch(`/api/inbox/${m.id}/annotate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); setDirty(false); onSaved && onSaved() }
    catch (e) { alert('Could not save: ' + e.message) } finally { setSaving(false) }
  }
  const pickDisp = (v) => { setDisp(v); if (v === 'Do not call' && !confirm('Mark this contact Do Not Contact? This sets their status to Do Not Contact and removes them from every active drip + automation campaign. It does not block a deliberate 1:1 text or call.')) return; save({ disposition: v }) }
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <select value={disp} onChange={e => pickDisp(e.target.value)} style={{ fontSize: 12, padding: '3px 6px', maxWidth: 200 }}>
        <option value="">Set outcome…</option>
        {DISPOSITIONS.map(d => <option key={d} value={d}>{d}</option>)}
      </select>
      <textarea value={notes} onChange={e => { setNotes(e.target.value); setDirty(true) }} onBlur={() => dirty && save({ notes })} rows={2} placeholder="Call notes…" style={{ fontSize: 12, padding: '5px 7px', resize: 'vertical', width: '100%', maxWidth: 320 }} />
      {saving && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>saving…</span>}
    </div>
  )
}

const fmtDate = (iso) => {
  if (!iso) return ''
  const d = new Date(String(iso).includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  return sameDay ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function Inbox() {
  const navigate = useNavigate()
  // Inbox filters persist across visits (so "Texts only" stays set when you come back).
  const [folder, setFolder] = useState(() => localStorage.getItem('inbox_folder') || 'inbox')
  const [unreadOnly, setUnreadOnly] = useState(() => { const v = localStorage.getItem('inbox_unreadOnly'); return v === null ? true : v === '1' })
  const [channels, setChannels] = useState(() => { try { const v = JSON.parse(localStorage.getItem('inbox_channels') || 'null'); return Array.isArray(v) && v.length ? v : ['email', 'text', 'call'] } catch { return ['email', 'text', 'call'] } })
  const [filterOpen, setFilterOpen] = useState(false)
  const [agents, setAgents] = useState([])
  const [myAgent, setMyAgent] = useState(() => localStorage.getItem('mst_agent') || '')
  const [assignFilter, setAssignFilter] = useState(() => localStorage.getItem('inbox_assignFilter') || 'all')   // all | mine | unassigned
  useEffect(() => { try { localStorage.setItem('inbox_folder', folder) } catch {} }, [folder])
  useEffect(() => { try { localStorage.setItem('inbox_unreadOnly', unreadOnly ? '1' : '0') } catch {} }, [unreadOnly])
  useEffect(() => { try { localStorage.setItem('inbox_channels', JSON.stringify(channels)) } catch {} }, [channels])
  useEffect(() => { try { localStorage.setItem('inbox_assignFilter', assignFilter) } catch {} }, [assignFilter])
  const [q, setQ] = useState('')
  const [convos, setConvos] = useState(null)
  const [totalUnread, setTotalUnread] = useState(0)
  const [counts, setCounts] = useState({ by_channel: {} })
  const [sel, setSel] = useState(null)
  const [unknownSel, setUnknownSel] = useState(null)   // { key, phone, name } for an Unknown-queue conversation
  const [groupSel, setGroupSel] = useState(null)       // { sid, name, group_meta } for a group-MMS conversation
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
  const [replyMedia, setReplyMedia] = useState([])    // outgoing MMS photos: [{url,type}]
  const [uploadingPhoto, setUploadingPhoto] = useState(false)
  const [replyTemplates, setReplyTemplates] = useState([])
  const [schedOpen, setSchedOpen] = useState(false)
  const [sendAt, setSendAt] = useState('')
  const fileRef = React.useRef(null)

  const load = useCallback(() => {
    const p = new URLSearchParams({ folder, unread: unreadOnly ? '1' : '0', channels: channels.join(','), q })
    if (assignFilter === 'mine' && myAgent) p.set('assigned', myAgent)
    else if (assignFilter === 'unassigned') p.set('assigned', 'unassigned')
    authFetch('/api/inbox?' + p).then(r => r.json()).then(d => { setConvos(d.conversations || []); setTotalUnread(d.total_unread || 0) }).catch(() => setConvos([]))
    authFetch('/api/inbox/counts').then(r => r.json()).then(setCounts).catch(() => {})
  }, [folder, unreadOnly, channels, q, assignFilter, myAgent])
  useEffect(() => { load() }, [load])
  useEffect(() => { authFetch('/api/inbox/agents').then(r => r.json()).then(a => setAgents(Array.isArray(a) ? a : [])).catch(() => {}) }, [])
  const chooseAgent = (a) => { setMyAgent(a); localStorage.setItem('mst_agent', a) }
  const assignThread = async (clientId, agent) => { await authFetch(`/api/inbox/thread/${clientId}/assign`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent }) }).catch(() => {}); load(); if (sel === clientId) authFetch(`/api/inbox/thread/${clientId}`).then(r => r.json()).then(setThread).catch(() => {}) }
  // Real-time via Server-Sent Events: refresh the list + open thread the moment a
  // new message/call arrives. A slow poll stays as a backstop if SSE drops.
  const refreshNow = useCallback(() => {
    load()
    if (sel) authFetch(`/api/inbox/thread/${sel}`).then(r => r.json()).then(setThread).catch(() => {})
  }, [load, sel])
  useEffect(() => {
    let es
    try {
      es = new EventSource(`/api/inbox/stream?token=${encodeURIComponent(localStorage.getItem('mst_token') || '')}`)
      es.addEventListener('changed', refreshNow)
    } catch {}
    const t = setInterval(refreshNow, 45000)   // backstop (also catches delivery-status updates)
    return () => { try { es && es.close() } catch {}; clearInterval(t) }
  }, [refreshNow])

  const openConvo = (c) => { if (c.is_group) openGroup(c); else if (c.unknown) openUnknown(c); else openThread(c.client_id) }
  const openGroup = (c) => {
    setSel(null); setUnknownSel(null)
    setGroupSel({ sid: c.conversation_sid, name: c.contact_name, group_meta: c.group_meta })
    load()
  }
  const openUnknown = (c) => {
    setSel(null); setGroupSel(null); setUnknownSel({ key: c.thread_key, phone: c.phone, name: c.contact_name })
    authFetch('/api/inbox/unknown-thread/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: c.thread_key }) }).then(() => load()).catch(() => {})
  }
  const openThread = (clientId) => {
    if (!clientId) return
    setUnknownSel(null); setGroupSel(null)
    setSel(clientId)
    setAi(null); setReply({ subject: '', body: '' }); setAiCtx(''); setReplyOpen(false); setOpenMsgs({}); setReplyMedia([])
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

  // Open the most recent conversation automatically, so the full blue/white chat shows
  // without needing a click. Runs once after the list first loads; a manual Close does
  // NOT trigger a re-open (the ref stays set).
  const autoOpenedRef = React.useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (sel || unknownSel) { autoOpenedRef.current = true; return }
    if (Array.isArray(convos) && convos.length) { autoOpenedRef.current = true; openConvo(convos[0]) }
  }, [convos, sel, unknownSel]) // eslint-disable-line react-hooks/exhaustive-deps

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
  const clearDraft = () => { setReply({ subject: '', body: '' }); setReplyMedia([]) }
  // Which channel the reply sends on: mirrors the last message VISIBLE in the thread
  // (so with the Texts filter on, a reply is a text even if the client also emailed).
  const shownThread = thread.filter(m => channels.includes(m.channel))
  const lastShown = shownThread.length ? shownThread[shownThread.length - 1] : (thread.length ? thread[thread.length - 1] : null)
  const replyChannel = lastShown && lastShown.channel === 'text' ? 'text' : 'email'
  // Load templates for the reply channel when the composer is open.
  useEffect(() => {
    if (!replyOpen) return
    authFetch('/api/templates?type=' + replyChannel).then(r => r.json()).then(t => setReplyTemplates(Array.isArray(t) ? t : [])).catch(() => setReplyTemplates([]))
  }, [replyOpen, replyChannel])
  const insertTemplate = (id) => {
    const t = replyTemplates.find(x => String(x.id) === String(id)); if (!t) return
    const text = replyChannel === 'text' ? stripTplHtml(t.body) : t.body
    setReply(v => ({ subject: v.subject || (replyChannel === 'email' ? (t.subject || '') : ''), body: v.body ? v.body + '\n\n' + text : text }))
  }
  const scheduleReply = async () => {
    if (!sel) return
    if (!reply.body.trim() && !replyMedia.length) { alert('Write a text first.'); return }
    if (!sendAt) { alert('Pick a date and time.'); return }
    const iso = new Date(sendAt).toISOString()
    if (new Date(iso).getTime() < Date.now() + 60000) { alert('Pick a time in the future.'); return }
    setSending(true)
    try {
      const r = await authFetch('/api/inbox/schedule-text', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: sel, body: reply.body.trim(), media: replyMedia.map(m => m.url), send_at: iso, created_by: 'John', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) })
      const d = await r.json()
      if (d.success) { setReply({ subject: '', body: '' }); setReplyMedia([]); setSchedOpen(false); setSendAt(''); await authFetch(`/api/inbox/thread/${sel}/draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subject: '', body: '' }) }).catch(() => {}); alert('Text scheduled for ' + new Date(iso).toLocaleString()) }
      else alert(d.error || 'Could not schedule')
    } catch (e) { alert(e.message) } finally { setSending(false) }
  }
  const uploadPhoto = async (file) => {
    if (!file) return
    setUploadingPhoto(true)
    try {
      const fd = new FormData(); fd.append('file', file)
      const r = await authFetch('/api/inbox/upload-media', { method: 'POST', body: fd })
      const d = await r.json()
      if (d.url) setReplyMedia(m => [...m, { url: d.url, type: d.type }])
      else alert(d.error || 'Upload failed')
    } catch (e) { alert('Upload failed: ' + e.message) }
    finally { setUploadingPhoto(false); if (fileRef.current) fileRef.current.value = '' }
  }
  const sendReply = async () => {
    if (!sel) return
    const hasBody = !!reply.body.trim()
    if (!hasBody && !(replyChannel === 'text' && replyMedia.length)) { alert('Write a reply first.'); return }
    setSending(true)
    try {
      let payload
      if (replyChannel === 'text') {
        payload = { channel: 'text', client_ids: [sel], body: reply.body.trim(), media: replyMedia.map(m => m.url) }
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
      setReply({ subject: '', body: '' }); setReplyMedia([])
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
          <div style={{ borderTop: '1px solid var(--border)', margin: '14px 0 10px' }} />
          <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-muted)', fontWeight: 700, marginBottom: 8 }}>Assigned</div>
          {[['all', 'All'], ['mine', 'Mine'], ['unassigned', 'Unassigned']].map(([k, l]) => (
            <button key={k} onClick={() => setAssignFilter(k)} style={folderBtn(assignFilter === k)}>{l}</button>
          ))}
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>I am</div>
          <select value={myAgent} onChange={e => chooseAgent(e.target.value)} style={{ width: '100%', marginTop: 4, padding: '6px 8px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
            <option value="">(choose)</option>
            {agents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
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
                const isSelected = c.unknown ? unknownSel?.key === c.thread_key : sel === c.client_id
                return (
                  <div key={c.client_id || c.thread_key || c.last?.id} onClick={() => openConvo(c)}
                    style={{ display: 'flex', gap: 10, padding: '12px 14px', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: isSelected ? 'var(--bg-secondary)' : 'transparent' }}>
                    <div style={{ width: 8, display: 'flex', alignItems: 'flex-start', paddingTop: 5 }}>
                      {c.unread_count > 0 && <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#2563eb', display: 'inline-block' }} />}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: c.unread_count ? 700 : 600, fontSize: 14 }}>{c.contact_name}</span>
                        {c.unknown && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: '#fff', background: '#f59e0b', padding: '1px 6px', borderRadius: 4 }}>Unknown</span>}
                        {c.assigned_to && <span title={`Assigned to ${c.assigned_to}`} style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', background: 'rgba(3,105,161,.12)', padding: '1px 6px', borderRadius: 4 }}>{c.assigned_to}</span>}
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
          {groupSel ? (
            <GroupPane sel={groupSel} onClose={() => setGroupSel(null)} />
          ) : unknownSel ? (
            <UnknownPane sel={unknownSel} onClose={() => setUnknownSel(null)}
              onLinked={(cid) => { setUnknownSel(null); load(); if (cid) openThread(cid) }} />
          ) : !sel ? (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>
              <div style={{ fontSize: 34 }}>💬</div>
              <div style={{ marginTop: 8 }}>Select a conversation to read it.</div>
            </div>
          ) : (
            <>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 700 }}>{selConvo?.contact_name || 'Conversation'}</div>
                <a href={'/clients/' + sel} className="btn btn-sm btn-secondary" style={{ textDecoration: 'none' }} title="Open the full-screen profile (right-click or Ctrl/Cmd-click to open in a new tab)" onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return; e.preventDefault(); navigate('/clients/' + sel) }}>◉ View profile</a>
                <select value={selConvo?.assigned_to || ''} onChange={e => assignThread(sel, e.target.value)} title="Assign this conversation"
                  style={{ marginLeft: 'auto', padding: '5px 8px', fontSize: 12.5, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}>
                  <option value="">Unassigned</option>
                  {agents.map(a => <option key={a} value={a}>{a}</option>)}
                </select>
                <button className="btn btn-sm btn-secondary" onClick={() => closeThread(sel)}>Close</button>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', minWidth: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {shownThread.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>No messages.</div> : shownThread.map((m, idx) => {
                  const meta = chMeta(m.channel)
                  const out = m.direction === 'outgoing'
                  const total = shownThread.length
                  // Text/call/voicemail threads read like a chat, so show EVERY message in full
                  // by default (no click-to-expand). Emails keep the Gmail-style collapse (only
                  // the latest + any unread incoming expanded) since they can be long. Toggle still works.
                  const expanded = (m.id in openMsgs) ? openMsgs[m.id]
                    : (m.channel === 'email' ? (idx === total - 1 || (m.status === 'unread' && m.direction === 'incoming')) : true)
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
                  const dstat = deliveryText(m)
                  const isVoicemail = m.channel === 'voicemail'
                  const isCall = m.channel === 'call'
                  const isText = m.channel === 'text'
                  const missed = isCall && String(m.delivery_status || '').toLowerCase() === 'missed'
                  const mediaList = (() => { try { return JSON.parse(m.media_url || '[]') } catch { return [] } })()
                  const textBody = m.body || m.preview
                  const link0 = isText ? firstUrl(textBody) : null
                  return (
                    <div key={m.id} style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textAlign: out ? 'right' : 'left' }}>
                        <span style={{ color: meta.color, fontVariantEmoji: 'text' }}>{meta.icon}</span> {meta.label.replace(/s$/, '')} · {out ? (m.sent_by_type === 'ai' ? 'HUB AI' : 'You') : m.contact_name} · {fmtDate(m.occurred_at)}
                        {m.sent_by_type === 'ai' && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#fff', background: '#2563eb', padding: '1px 5px', borderRadius: 3, letterSpacing: '.03em' }}>AI</span>}
                        {m.duration_sec ? ` · ${fmtDur(m.duration_sec)}` : ''}
                      </div>
                      <div style={{ padding: '10px 13px', borderRadius: 12, background: missed ? 'rgba(239,68,68,.12)' : out ? '#2563eb' : 'var(--bg-secondary)', color: out && !missed ? '#fff' : 'var(--text-primary)', border: (out && !missed) ? 'none' : '1px solid var(--border)' }}>
                        {isCall || isVoicemail
                          ? <div style={{ fontSize: 14, fontWeight: missed ? 700 : 500, color: missed ? '#ef4444' : undefined }}>{missed ? '⚠ Missed call' : (m.preview || (isVoicemail ? 'Voicemail' : 'Call'))}</div>
                          : (textBody ? <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}><LinkifiedText text={textBody} light={out && !missed} /></div> : null)}
                        {/* Inline MMS photos (streamed through the auth'd media proxy) */}
                        {mediaList.map((mm, i) => (/image/i.test(mm.type || '') || !mm.type)
                          ? <img key={i} src={mediaUrl(m.id, i)} alt="attachment" onError={e => { e.target.style.display = 'none' }} style={{ marginTop: 6, maxWidth: 220, maxHeight: 240, borderRadius: 8, display: 'block' }} />
                          : <div key={i} style={{ fontSize: 12, marginTop: 4, opacity: .85 }}>📎 attachment</div>)}
                        {isVoicemail && m.recording_url && <audio controls src={recUrl(m.id)} style={{ marginTop: 8, width: 240, maxWidth: '100%' }} />}
                        {isVoicemail && m.transcript && <div style={{ fontSize: 12.5, marginTop: 6, fontStyle: 'italic', opacity: .9 }}>“{m.transcript}”</div>}
                        {isCall && m.recording_url && <audio controls src={recUrl(m.id)} style={{ marginTop: 8, width: 240, maxWidth: '100%' }} />}
                      </div>
                      {link0 && <LinkPreview url={link0} />}
                      {dstat && <div style={{ fontSize: 10.5, color: dstat.c, textAlign: 'right', marginTop: 2 }}>{dstat.t}</div>}
                      {(isCall || isVoicemail) && <CallDispo m={m} onSaved={() => openThread(sel)} />}
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
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: '#a78bfa' }}>🤖 {replyChannel === 'text' ? 'Suggested Text' : 'Suggested Response'}</span>
                    {ai && ai.intent && <span style={intentBadgeStyle(ai.intent)}>{ai.intent}</span>}
                    {ai && ai.stale && <span style={{ fontSize: 11, color: 'var(--warning, #f59e0b)' }}>● new email since last suggestion</span>}
                    <button className="btn btn-sm" style={{ marginLeft: 'auto' }} disabled={!!aiBusy} onClick={() => generateSuggestion(sel, true)}>{aiBusy === 'suggest' ? '…' : '↻ Regenerate'}</button>
                    <button className="btn btn-sm btn-secondary" onClick={() => setReplyOpen(false)} title="Minimize">▾ Minimize</button>
                  </div>
                  {ai && ai.ai_available === false && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>AI is not configured on the server.</div>}
                  {ai && ai.error && <div style={{ fontSize: 12, color: 'var(--danger)' }}>{ai.error}</div>}
                  {ai && ai.summary && <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', borderLeft: '2px solid rgba(124,58,237,0.4)', paddingLeft: 8 }}>{ai.summary}</div>}
                  {aiBusy === 'suggest' && !(ai && ai.summary) && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Reading the conversation…</div>}

                  {/* Template + photo toolbar */}
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <TemplatePicker templates={replyTemplates} onPick={t => insertTemplate(t.id)} />
                    {replyChannel === 'text' && <>
                      <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => uploadPhoto(e.target.files?.[0])} />
                      <button className="btn btn-sm btn-secondary" disabled={uploadingPhoto} onClick={() => fileRef.current?.click()}>{uploadingPhoto ? 'Uploading…' : '📷 Insert photo'}</button>
                    </>}
                  </div>
                  {replyMedia.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {replyMedia.map((mm, i) => (
                        <div key={i} style={{ position: 'relative' }}>
                          <img src={mm.url} alt="" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                          <button onClick={() => setReplyMedia(list => list.filter((_, j) => j !== i))} title="Remove" style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer', fontSize: 12, lineHeight: '20px', padding: 0 }}>✕</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {replyChannel === 'email' && <input value={reply.subject} onChange={e => setReply(v => ({ ...v, subject: e.target.value }))} placeholder="Subject" style={{ padding: '7px 9px', fontSize: 13, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />}
                  <textarea value={reply.body} onChange={e => setReply(v => ({ ...v, body: e.target.value }))} rows={replyChannel === 'text' ? 3 : 5} placeholder={replyChannel === 'text' ? 'Write your text…' : 'Write your reply…'} style={{ padding: '8px 10px', fontSize: 13, lineHeight: 1.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', resize: 'vertical' }} />

                  <div style={{ display: 'flex', gap: 6 }}>
                    <input value={aiCtx} onChange={e => setAiCtx(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && aiCtx.trim() && !aiBusy) adjustReply(null, aiCtx.trim()) }} placeholder="Add context for the AI (e.g. tell them we can meet Saturday)…" style={{ flex: 1, minWidth: 0, padding: '7px 9px', fontSize: 12.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />
                    <button className="btn btn-sm" disabled={!!aiBusy || !aiCtx.trim()} onClick={() => adjustReply(null, aiCtx.trim())}>{aiBusy === 'context' ? '…' : 'Apply'}</button>
                  </div>

                  {schedOpen && replyChannel === 'text' && (
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Send at:</span>
                      <input type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} style={{ padding: '6px 8px', fontSize: 12.5, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }} />
                      <button className="btn btn-primary btn-sm" disabled={sending || !sendAt || (!reply.body.trim() && !replyMedia.length)} onClick={scheduleReply}>{sending ? '…' : 'Schedule send'}</button>
                      <button className="btn btn-sm" onClick={() => setSchedOpen(false)}>Cancel</button>
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {ai && ai.suggestion && <button className="btn btn-sm" disabled={!!aiBusy} onClick={useSuggested}>Use suggested</button>}
                    {[['shorter', 'Shorter'], ['casual', 'More casual'], ['direct', 'More direct'], ['warmer', 'Warmer']].map(([k, l]) => (
                      <button key={k} className="btn btn-sm" disabled={!!aiBusy || !reply.body.trim()} onClick={() => adjustReply(k)}>{aiBusy === k ? '…' : l}</button>
                    ))}
                    <button className="btn btn-sm" disabled={!reply.body.trim() && !replyMedia.length} onClick={clearDraft}>Clear</button>
                    {replyChannel === 'text' && !schedOpen && <button className="btn btn-sm" disabled={!reply.body.trim() && !replyMedia.length} onClick={() => setSchedOpen(true)} title="Schedule for later">🕑 Schedule</button>}
                    <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} disabled={sending || (!reply.body.trim() && !(replyChannel === 'text' && replyMedia.length))} onClick={sendReply}>{sending ? 'Sending…' : replyChannel === 'text' ? '💬 Send text' : '✉ Send reply'}</button>
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

const fmtPhoneDisp = (p) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (p || 'Unknown') }

// Reading pane for an UNKNOWN-queue conversation (inbound text/call from a number
// not yet in the CRM). Shows the messages and a Create-lead / Link-to-existing bar.
// Replying is unlocked once the conversation is turned into a real lead.
// Reading pane for a GROUP-MMS conversation (Twilio Conversations). One shared thread:
// the group send + every reply, and a reply box that posts back into the group.
function GroupPane({ sel, onClose }) {
  const [rows, setRows] = React.useState([])
  const [reply, setReply] = React.useState('')
  const [sending, setSending] = React.useState(false)
  const load = React.useCallback(() => authFetch('/api/inbox/group-thread?sid=' + encodeURIComponent(sel.sid)).then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}), [sel.sid])
  React.useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [load])
  const send = async () => {
    if (!reply.trim()) return; setSending(true)
    try { const d = await authFetch('/api/inbox/group-reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_sid: sel.sid, body: reply.trim() }) }).then(r => r.json()); if (d.success) { setReply(''); load() } else alert(d.error || 'Reply failed') }
    catch (e) { alert('Reply failed: ' + e.message) } finally { setSending(false) }
  }
  let participants = []
  try { participants = (JSON.parse(sel.group_meta || '{}').participants || []).map(p => p.name || p.phone) } catch {}
  return (
    <>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 700 }}>👥 {sel.name || 'Group text'}</div>
        <button className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      {participants.length > 0 && <div style={{ padding: '6px 16px', fontSize: 12, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)' }}>Recipients: {participants.join(', ')}</div>}
      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.map(m => {
          const out = m.direction === 'outgoing'
          return (
            <div key={m.id} style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textAlign: out ? 'right' : 'left' }}>{out ? (m.sent_by_type === 'ai' ? 'HUB AI' : 'You') : (m.contact_name || 'Reply')} · {fmtDate(m.occurred_at)}</div>
              <div style={{ padding: '10px 13px', borderRadius: 12, background: out ? '#2563eb' : 'var(--bg-secondary)', color: out ? '#fff' : 'var(--text-primary)', border: out ? 'none' : '1px solid var(--border)' }}>
                <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body || m.preview}</div>
              </div>
            </div>
          )
        })}
        {rows.length === 0 && <div style={{ color: 'var(--text-muted)', margin: 'auto' }}>No messages yet.</div>}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: '10px 12px', display: 'flex', gap: 8 }}>
        <input value={reply} onChange={e => setReply(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') send() }} placeholder="Reply to the group…" style={{ flex: 1, padding: '9px 11px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontSize: 14 }} />
        <button className="btn btn-primary" onClick={send} disabled={sending || !reply.trim()}>{sending ? '…' : 'Send'}</button>
      </div>
    </>
  )
}

function UnknownPane({ sel, onClose, onLinked }) {
  const [rows, setRows] = React.useState([])
  const [mode, setMode] = React.useState(null)   // null | 'create' | 'link'
  const [fn, setFn] = React.useState(''); const [ln, setLn] = React.useState('')
  const [q, setQ] = React.useState(''); const [results, setResults] = React.useState([])
  const [busy, setBusy] = React.useState(false)
  const load = React.useCallback(() => { authFetch('/api/inbox/unknown-thread?key=' + encodeURIComponent(sel.key)).then(r => r.json()).then(d => setRows(Array.isArray(d) ? d : [])).catch(() => {}) }, [sel.key])
  React.useEffect(() => { load() }, [load])
  React.useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t) }, [load])
  React.useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => authFetch('/api/inbox/contacts?q=' + encodeURIComponent(q.trim())).then(r => r.json()).then(setResults).catch(() => {}), 200)
    return () => clearTimeout(t)
  }, [q])
  const createLead = async () => {
    setBusy(true)
    try { const r = await authFetch('/api/inbox/unknown/create-lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: sel.key, phone: sel.phone, first_name: fn, last_name: ln }) }); const d = await r.json(); if (d.client_id) onLinked(d.client_id); else alert(d.error || 'Could not create lead') }
    catch (e) { alert(e.message) } finally { setBusy(false) }
  }
  const linkTo = async (cid) => {
    setBusy(true)
    try { const r = await authFetch('/api/inbox/unknown/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: sel.key, client_id: cid }) }); const d = await r.json(); if (d.client_id) onLinked(d.client_id); else alert(d.error || 'Could not link') }
    catch (e) { alert(e.message) } finally { setBusy(false) }
  }
  const inp = { padding: '7px 9px', fontSize: 13, background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)' }
  return (
    <>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 700 }}>{fmtPhoneDisp(sel.phone)}</div>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: '#fff', background: '#f59e0b', padding: '1px 6px', borderRadius: 4 }}>Unknown</span>
        <button className="btn btn-sm btn-secondary" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>No messages.</div> : rows.map(m => {
          const meta = chMeta(m.channel)
          const out = m.direction === 'outgoing'
          const isCall = m.channel === 'call', isVoicemail = m.channel === 'voicemail'
          const missed = isCall && String(m.delivery_status || '').toLowerCase() === 'missed'
          const mediaList = (() => { try { return JSON.parse(m.media_url || '[]') } catch { return [] } })()
          const textBody = m.body || m.preview
          const dstat = deliveryText(m)
          const link0 = m.channel === 'text' ? firstUrl(textBody) : null
          return (
            <div key={m.id} style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textAlign: out ? 'right' : 'left' }}>
                <span style={{ color: meta.color, fontVariantEmoji: 'text' }}>{meta.icon}</span> {meta.label.replace(/s$/, '')} · {out ? 'You' : (m.contact_name || 'Them')} · {fmtDate(m.occurred_at)}{m.duration_sec ? ` · ${fmtDur(m.duration_sec)}` : ''}
              </div>
              <div style={{ padding: '10px 13px', borderRadius: 12, background: missed ? 'rgba(239,68,68,.12)' : out ? '#2563eb' : 'var(--bg-secondary)', color: out && !missed ? '#fff' : 'var(--text-primary)', border: (out && !missed) ? 'none' : '1px solid var(--border)' }}>
                {isCall || isVoicemail
                  ? <div style={{ fontSize: 14, fontWeight: missed ? 700 : 500, color: missed ? '#ef4444' : undefined }}>{missed ? '⚠ Missed call' : (m.preview || (isVoicemail ? 'Voicemail' : 'Call'))}</div>
                  : (textBody ? <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}><LinkifiedText text={textBody} light={out && !missed} /></div> : null)}
                {mediaList.map((mm, i) => (/image/i.test(mm.type || '') || !mm.type)
                  ? <img key={i} src={mediaUrl(m.id, i)} alt="attachment" onError={e => { e.target.style.display = 'none' }} style={{ marginTop: 6, maxWidth: 220, maxHeight: 240, borderRadius: 8, display: 'block' }} />
                  : <div key={i} style={{ fontSize: 12, marginTop: 4, opacity: .85 }}>📎 attachment</div>)}
                {isVoicemail && m.recording_url && <audio controls src={recUrl(m.id)} style={{ marginTop: 8, width: 240, maxWidth: '100%' }} />}
                {isVoicemail && m.transcript && <div style={{ fontSize: 12.5, marginTop: 6, fontStyle: 'italic', opacity: .9 }}>“{m.transcript}”</div>}
              </div>
              {link0 && <LinkPreview url={link0} />}
              {dstat && <div style={{ fontSize: 10.5, color: dstat.c, textAlign: 'right', marginTop: 2 }}>{dstat.t}</div>}
            </div>
          )
        })}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', padding: 12, background: 'var(--bg-primary)' }}>
        {mode === null && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>This number isn't a contact yet. Add them to reply and start a normal conversation.</span>
            <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setMode('create')}>+ Create lead</button>
            <button className="btn btn-sm" onClick={() => setMode('link')}>Link to existing</button>
          </div>
        )}
        {mode === 'create' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input value={fn} onChange={e => setFn(e.target.value)} placeholder="First name" style={inp} />
            <input value={ln} onChange={e => setLn(e.target.value)} placeholder="Last name" style={inp} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtPhoneDisp(sel.phone)}</span>
            <button className="btn btn-sm" onClick={() => setMode(null)}>Cancel</button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={createLead} style={{ marginLeft: 'auto' }}>{busy ? 'Creating…' : 'Create lead'}</button>
          </div>
        )}
        {mode === 'link' && (
          <div style={{ position: 'relative' }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search a client by name, email, or phone…" style={{ ...inp, flex: 1 }} autoFocus />
              <button className="btn btn-sm" onClick={() => { setMode(null); setQ('') }}>Cancel</button>
            </div>
            {results.length > 0 && (
              <div style={{ position: 'absolute', bottom: '100%', left: 0, right: 0, background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 4, maxHeight: 220, overflowY: 'auto', boxShadow: '0 8px 24px rgba(0,0,0,0.25)' }}>
                {results.map(c => (
                  <div key={c.id} onClick={() => linkTo(c.id)} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>{`${c.first_name || ''} ${c.last_name || ''}`.trim() || '(no name)'}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{c.phone || c.email || ''}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
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
