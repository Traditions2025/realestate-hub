import React, { useState, useEffect, useCallback } from 'react'
import { authFetch } from '../api'

const CHANNELS = [
  { key: 'email', label: 'Emails', icon: '✉', color: '#2563eb' },
  { key: 'text', label: 'Texts', icon: '💬', color: '#10b981' },
  { key: 'call', label: 'Calls', icon: '☎', color: '#8b5cf6' },
  { key: 'voicemail', label: 'Voicemails', icon: '🎙', color: '#f59e0b' },
]
const chMeta = (k) => CHANNELS.find(c => c.key === k) || CHANNELS[0]
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

  const load = useCallback(() => {
    const p = new URLSearchParams({ folder, unread: unreadOnly ? '1' : '0', channels: channels.join(','), q })
    authFetch('/api/inbox?' + p).then(r => r.json()).then(d => { setConvos(d.conversations || []); setTotalUnread(d.total_unread || 0) }).catch(() => setConvos([]))
    authFetch('/api/inbox/counts').then(r => r.json()).then(setCounts).catch(() => {})
  }, [folder, unreadOnly, channels, q])
  useEffect(() => { load() }, [load])

  const openThread = (clientId) => {
    if (!clientId) return
    setSel(clientId)
    authFetch(`/api/inbox/thread/${clientId}`).then(r => r.json()).then(setThread).catch(() => setThread([]))
    authFetch(`/api/inbox/thread/${clientId}/read`, { method: 'POST' }).then(() => load()).catch(() => {})
  }
  const closeThread = (clientId) => authFetch(`/api/inbox/thread/${clientId}/close`, { method: 'POST' }).then(() => { setSel(null); load() })

  const toggleChannel = (k) => setChannels(cs => cs.includes(k) ? cs.filter(x => x !== k) : [...cs, k])
  const selConvo = convos && convos.find(c => c.client_id === sel)

  return (
    <div className="page" style={{ paddingBottom: 0 }}>
      <div className="page-header">
        <div>
          <h1>Inbox</h1>
          <p className="page-subtitle">All client calls, texts, and emails in one place. Only messages that match one of your clients appear here.</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', height: 'calc(100vh - 168px)', minHeight: 460 }}>
        {/* left: folders + filters */}
        <aside style={{ width: 210, borderRight: '1px solid var(--border)', background: 'var(--bg-secondary)', padding: 14, flexShrink: 0 }}>
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
        <div style={{ width: 380, borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
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
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
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
              <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {thread.length === 0 ? <div style={{ color: 'var(--text-muted)' }}>No messages.</div> : thread.map(m => {
                  const meta = chMeta(m.channel)
                  const out = m.direction === 'outgoing'
                  return (
                    <div key={m.id} style={{ alignSelf: out ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3, textAlign: out ? 'right' : 'left' }}>
                        <span style={{ color: meta.color, fontVariantEmoji: 'text' }}>{meta.icon}</span> {meta.label.replace(/s$/, '')} · {out ? 'You' : m.contact_name} · {fmtDate(m.occurred_at)}
                      </div>
                      <div style={{ padding: '10px 13px', borderRadius: 12, background: out ? '#2563eb' : 'var(--bg-secondary)', color: out ? '#fff' : 'var(--text-primary)', border: out ? 'none' : '1px solid var(--border)' }}>
                        {m.subject && <div style={{ fontWeight: 700, marginBottom: 4 }}>{m.subject}</div>}
                        <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.body || m.preview}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div style={{ padding: 12, borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
                Replying from the Hub turns on with the texting feature (Twilio).
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const folderBtn = (active) => ({ display: 'flex', alignItems: 'center', width: '100%', padding: '8px 10px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13.5, marginBottom: 2, background: active ? 'var(--accent, #2563eb)' : 'transparent', color: active ? '#fff' : 'var(--text-primary)' })
const toggleBtn = (active) => ({ padding: '6px 12px', border: 'none', cursor: 'pointer', fontSize: 12.5, background: active ? 'var(--accent, #2563eb)' : 'var(--bg-secondary)', color: active ? '#fff' : 'var(--text-primary)' })
const badge = { fontSize: 11, fontWeight: 700, background: '#2563eb', color: '#fff', borderRadius: 10, padding: '1px 7px', marginLeft: 'auto' }
const pad = { padding: 20, color: 'var(--text-muted)' }
