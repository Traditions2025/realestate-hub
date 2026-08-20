import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'
import Modal from '../components/Modal'

const ago = (ts) => {
  if (!ts) return ''
  const d = new Date(String(ts).includes('T') ? ts : ts.replace(' ', 'T') + 'Z')
  const mins = Math.floor((Date.now() - d.getTime()) / 60000)
  if (mins < 60) return `${mins} min ago`
  if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`
  return `${Math.floor(mins / 1440)} day${Math.floor(mins / 1440) === 1 ? '' : 's'} ago`
}
const pct = (num, den) => den > 0 ? `${Math.round((num / den) * 100)}%` : '0%'
const th = { textAlign: 'left', padding: '10px 12px', fontSize: 12, color: 'var(--text-muted)', fontWeight: 600, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
const td = { padding: '12px', fontSize: 13, borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }

export default function Reporting() {
  const [tab, setTab] = useState('email')
  const [campaigns, setCampaigns] = useState(null)
  const [sendgrid, setSendgrid] = useState(true)
  const [preview, setPreview] = useState(null)      // { subject, campaign_id }
  const [people, setPeople] = useState(null)        // { subject, date, metric, label }
  const [statsReady, setStatsReady] = useState(false)

  // Two-phase: render rows instantly from our DB, then fill engagement from
  // SendGrid (slow — cached server-side for 10 min so repeat loads are instant).
  const load = (refresh) => {
    setStatsReady(false)
    let full = false
    authFetch('/api/reporting/campaigns?stats=0').then(r => r.json()).then(d => { if (!full) { setCampaigns(d.campaigns || []); setSendgrid(d.sendgrid !== false) } }).catch(() => {})
    authFetch('/api/reporting/campaigns' + (refresh ? '?refresh=1' : '')).then(r => r.json()).then(d => { full = true; setCampaigns(d.campaigns || []); setSendgrid(d.sendgrid !== false); setStatsReady(true) }).catch(() => { full = true; setStatsReady(true) })
  }
  useEffect(() => { load() }, [])

  // A metric number becomes a button when there's a count to drill into.
  const stat = (n, den, color, onClick) => {
    const inner = <>{n || 0} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({pct(n, den)})</span></>
    if (!onClick || !(n > 0)) return <span style={{ color }}>{inner}</span>
    return <button onClick={onClick} title="See who" style={{ color, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }}>{inner}</button>
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Reporting</h1>
          <p className="page-subtitle">Communication performance — batch email opens, clicks, bounces (live from SendGrid).</p>
        </div>
        <button className="btn btn-secondary" onClick={() => load(true)}>↻ Refresh</button>
      </div>

      <div className="listing-tabs" style={{ marginBottom: 16 }}>
        <button className={`listing-tab ${tab === 'email' ? 'active' : ''}`} onClick={() => setTab('email')}>✉ Batch Emails</button>
        <button className={`listing-tab ${tab === 'comms' ? 'active' : ''}`} onClick={() => setTab('comms')}>💬 Texting &amp; Calls</button>
      </div>

      {tab === 'comms' && <CommsReport />}

      {tab === 'email' && !sendgrid && (
        <div className="sierra-banner warning" style={{ marginBottom: 12 }}>SendGrid API key not set on the server — sent counts show, but opens/clicks won't populate until it's configured.</div>
      )}

      {tab === 'email' && (<>
      <div className="detail-section" style={{ padding: 0, overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
          <thead>
            <tr>
              <th style={th}>Subject</th>
              <th style={th}>Created</th>
              <th style={th}>Status</th>
              <th style={th}>Recipients</th>
              <th style={th}>Sent</th>
              <th style={th}>Opens</th>
              <th style={th}>Clicks</th>
              <th style={th}>Unsubscribes</th>
              <th style={th}>Bounces</th>
            </tr>
          </thead>
          <tbody>
            {campaigns === null ? (
              <tr><td style={td} colSpan={9}>Loading…</td></tr>
            ) : campaigns.length === 0 ? (
              <tr><td style={{ ...td, color: 'var(--text-muted)' }} colSpan={9}>No batch emails sent yet. Send a Bulk Email from the Clients page and it'll show here.</td></tr>
            ) : campaigns.map(c => {
              const pending = !statsReady
              const wait = <span style={{ color: 'var(--text-muted)' }} title="Loading engagement from SendGrid…">…</span>
              const noStats = c.stats == null
              const dash = <span style={{ color: 'var(--text-muted)' }} title="Engagement not available for this send">—</span>
              const s = c.stats || {}
              const opens = s.unique_opens || 0, clicks = s.unique_clicks || 0
              const campaignId = /^\d+$/.test(String(c.id)) ? c.id : null
              const openPeople = (metric, label) => setPeople({ subject: c.subject, date: c.created_at, metric, label })
              return (
                <tr key={c.id}>
                  <td style={td}>
                    <div style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <button onClick={() => setPreview({ subject: c.subject, campaign_id: campaignId })} title="Open the email that was sent"
                        style={{ fontWeight: 600, color: 'var(--accent, #2563eb)', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
                        {c.subject}
                      </button>
                      {c.source === 'sendgrid' && <span style={{ marginLeft: 8, fontSize: 10, background: '#e0e7ff', color: '#3730a3', padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle' }}>SendGrid</span>}
                      {c.source === 'hub-log' && <span style={{ marginLeft: 8, fontSize: 10, background: '#fef3c7', color: '#92400e', padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle' }} title="Sent from the Hub before per-campaign tracking existed">Hub (log)</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>From: {c.from_name || 'Matt Smith Team'}</div>
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>{ago(c.created_at)}</td>
                  <td style={td}>{c.status === 'finished' ? <span style={{ color: '#10b981' }}>✓ Finished</span> : <span style={{ color: '#f59e0b' }}>Sending…</span>}</td>
                  <td style={td}>{c.recipients || 0}</td>
                  <td style={td}>{c.sent || 0}</td>
                  <td style={td}>{pending ? wait : noStats ? dash : stat(opens, c.sent, '#10b981', () => openPeople('opens', 'Opened'))}</td>
                  <td style={td}>{pending ? wait : noStats ? dash : stat(clicks, c.sent, '#3b82f6', () => openPeople('clicks', 'Clicked'))}</td>
                  <td style={td}>{pending ? wait : noStats ? dash : stat(s.unsubscribes, c.sent, '#f59e0b', () => openPeople('unsubscribes', 'Unsubscribed'))}</td>
                  <td style={td}>{pending ? wait : noStats ? dash : stat(s.bounces, c.recipients, '#ef4444', () => openPeople('bounces', 'Bounced'))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
        Click a subject to view the email that went out. Click any opens/clicks/unsubscribes/bounces number to see exactly who. Opens/clicks can take a few hours to populate after a send. % is of Sent (bounces are of Recipients).
      </p>
      </>)}

      {preview && <EmailPreview {...preview} onClose={() => setPreview(null)} />}
      {people && <PeopleList {...people} onClose={() => setPeople(null)} />}
    </div>
  )
}

function EmailPreview({ subject, campaign_id, onClose }) {
  const [data, setData] = useState(undefined) // undefined=loading, null=not found
  useEffect(() => {
    const p = new URLSearchParams()
    if (subject) p.set('subject', subject)
    if (campaign_id) p.set('campaign_id', campaign_id)
    authFetch('/api/reporting/email-content?' + p).then(r => r.ok ? r.json() : null).then(setData).catch(() => setData(null))
  }, [subject, campaign_id])
  return (
    <Modal open onClose={onClose} title="Email sent" wide>
      {data === undefined ? <div style={{ padding: 20, color: 'var(--text-muted)' }}>Loading email…</div>
        : data === null ? <div style={{ padding: 20, color: 'var(--text-muted)' }}>No stored copy of this email is available. (Emails sent outside the Hub don’t keep a body copy here.)</div>
          : (
            <div>
              <div style={{ padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <div><strong>Subject:</strong> {data.subject}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>From: {data.from_name || 'Matt Smith Team'}{data.from_email ? ` <${data.from_email}>` : ''} · {data.sent_at ? String(data.sent_at).replace('T', ' ').slice(0, 16) : ''}</div>
              </div>
              <iframe title="email" srcDoc={data.body || ''} style={{ width: '100%', height: 520, border: 0, background: '#fff' }} />
            </div>
          )}
    </Modal>
  )
}

function PeopleList({ subject, date, metric, label, onClose }) {
  const [data, setData] = useState(undefined)
  useEffect(() => {
    const p = new URLSearchParams({ subject: subject || '', date: (date || '').slice(0, 10), metric })
    authFetch('/api/reporting/recipients?' + p).then(r => r.json()).then(setData).catch(() => setData({ recipients: [] }))
  }, [subject, date, metric])
  const rows = data?.recipients || []
  return (
    <Modal open onClose={onClose} title={`${label} — ${rows.length} ${rows.length === 1 ? 'contact' : 'contacts'}`} wide>
      {data === undefined ? <div style={{ padding: 20, color: 'var(--text-muted)' }}>Loading…</div>
        : rows.length === 0 ? <div style={{ padding: 20, color: 'var(--text-muted)', textAlign: 'center' }}>No contacts to show for “{label.toLowerCase()}”.</div>
          : (
            <table className="data-table">
              <thead><tr><th>Contact</th><th>Email</th>{metric === 'opens' && <th>Opens</th>}{metric === 'clicks' && <th>Clicks</th>}<th>When</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.name || <span className="muted">—</span>}</td>
                    <td>{r.email}</td>
                    {metric === 'opens' && <td>{r.opens}</td>}
                    {metric === 'clicks' && <td>{r.clicks}</td>}
                    <td className="muted" style={{ fontSize: 12 }}>{r.last_event_time ? String(r.last_event_time).replace('T', ' ').slice(0, 16) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </Modal>
  )
}

// --- SMS + call analytics (Reporting → Texting & Calls) ---
function CommsReport() {
  const [days, setDays] = React.useState(30)
  const [d, setD] = React.useState(undefined)
  React.useEffect(() => { setD(undefined); authFetch(`/api/reporting/comms?days=${days}`).then(r => r.json()).then(setD).catch(() => setD(null)) }, [days])
  if (d === undefined) return <div className="detail-section" style={{ padding: 24, color: 'var(--text-muted)' }}>Loading…</div>
  if (d === null) return <div className="detail-section" style={{ padding: 24, color: 'var(--text-muted)' }}>Could not load communications analytics.</div>
  const dur = (s) => { s = Number(s || 0); return s ? `${Math.floor(s / 60)}m ${s % 60}s` : '0s' }
  const Card = ({ label, value, sub, color }) => (
    <div className="detail-section" style={{ padding: '14px 16px', minWidth: 130, flex: '1 1 130px' }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: color || 'var(--text-primary)', lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>{label}</div>
      {sub != null && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
  const maxDay = Math.max(1, ...(d.by_day || []).map(x => (x.texts_out || 0) + (x.texts_in || 0) + (x.calls || 0)))
  const maxDisp = Math.max(1, ...(d.dispositions || []).map(x => x.n))
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Range:</span>
        {[7, 30, 90].map(n => <button key={n} className={`btn btn-sm ${days === n ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setDays(n)}>{n}d</button>)}
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', margin: '4px 0 8px' }}>Texting</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <Card label="Texts sent" value={d.texts_out} color="#2563eb" />
        <Card label="Texts received" value={d.texts_in} color="#10b981" />
        <Card label="Delivery rate" value={d.delivery_rate == null ? '—' : d.delivery_rate + '%'} sub={`${d.delivered} delivered`} color="#10b981" />
        <Card label="Failed" value={d.failed} color={d.failed ? '#ef4444' : undefined} />
        <Card label="Reply rate" value={d.reply_rate == null ? '—' : d.reply_rate + '%'} sub={`${d.replied_contacts}/${d.texted_contacts} contacts`} color="#8b5cf6" />
      </div>

      <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-muted)', margin: '4px 0 8px' }}>Calls</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 18 }}>
        <Card label="Calls placed" value={d.calls_out} color="#8b5cf6" />
        <Card label="Calls received" value={d.calls_in} color="#8b5cf6" />
        <Card label="Answered" value={d.answered} color="#10b981" />
        <Card label="Missed" value={d.missed} color={d.missed ? '#f59e0b' : undefined} />
        <Card label="Voicemails" value={d.voicemails} color="#f59e0b" />
        <Card label="Avg call length" value={dur(d.avg_call_sec)} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))', gap: 16 }}>
        <div className="detail-section" style={{ padding: 16 }}>
          <h4 style={{ margin: '0 0 12px' }}>Volume by day</h4>
          {(d.by_day || []).length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No activity yet.</div> : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
                {d.by_day.map(x => {
                  const total = (x.texts_out || 0) + (x.texts_in || 0) + (x.calls || 0)
                  const h = (n) => `${(n / maxDay) * 110}px`
                  return (
                    <div key={x.day} title={`${x.day}\nTexts out ${x.texts_out} · in ${x.texts_in} · calls ${x.calls}`} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', gap: 1, minWidth: 4 }}>
                      <div style={{ height: h(x.texts_out), background: '#2563eb', borderRadius: '2px 2px 0 0' }} />
                      <div style={{ height: h(x.texts_in), background: '#10b981' }} />
                      <div style={{ height: h(x.calls), background: '#8b5cf6' }} />
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 10, fontSize: 11, color: 'var(--text-muted)' }}>
                <span><span style={{ display: 'inline-block', width: 9, height: 9, background: '#2563eb', borderRadius: 2, marginRight: 4 }} />Texts out</span>
                <span><span style={{ display: 'inline-block', width: 9, height: 9, background: '#10b981', borderRadius: 2, marginRight: 4 }} />Texts in</span>
                <span><span style={{ display: 'inline-block', width: 9, height: 9, background: '#8b5cf6', borderRadius: 2, marginRight: 4 }} />Calls</span>
              </div>
            </>
          )}
        </div>
        <div className="detail-section" style={{ padding: 16 }}>
          <h4 style={{ margin: '0 0 12px' }}>Call dispositions</h4>
          {(d.dispositions || []).length === 0 ? <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No dispositions logged yet. Set one on a call in the Inbox.</div> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {d.dispositions.map(x => (
                <div key={x.d} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 130, fontSize: 12, flexShrink: 0 }}>{x.d}</div>
                  <div style={{ flex: 1, background: 'var(--bg-secondary)', borderRadius: 4, height: 16, overflow: 'hidden' }}>
                    <div style={{ width: `${(x.n / maxDisp) * 100}%`, height: '100%', background: '#8b5cf6' }} />
                  </div>
                  <div style={{ width: 28, textAlign: 'right', fontSize: 12, fontWeight: 700 }}>{x.n}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>Live from the communications log — updates as texts and calls happen. Delivery rate is of texts with a final Twilio status; reply rate is distinct contacts who texted back.</p>
    </div>
  )
}
