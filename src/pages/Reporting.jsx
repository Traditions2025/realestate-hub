import React, { useState, useEffect } from 'react'
import { authFetch } from '../api'

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

  const load = () => authFetch('/api/reporting/campaigns').then(r => r.json()).then(d => { setCampaigns(d.campaigns || []); setSendgrid(d.sendgrid !== false) }).catch(() => setCampaigns([]))
  useEffect(() => { load() }, [])

  const stat = (n, den, color) => <span style={{ color }}>{n || 0} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>({pct(n, den)})</span></span>

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Reporting</h1>
          <p className="page-subtitle">Communication performance — batch email opens, clicks, bounces (live from SendGrid).</p>
        </div>
        <button className="btn btn-secondary" onClick={() => { setCampaigns(null); load() }}>↻ Refresh</button>
      </div>

      <div className="listing-tabs" style={{ marginBottom: 16 }}>
        <button className={`listing-tab ${tab === 'email' ? 'active' : ''}`} onClick={() => setTab('email')}>✉ Batch Emails</button>
      </div>

      {!sendgrid && (
        <div className="sierra-banner warning" style={{ marginBottom: 12 }}>SendGrid API key not set on the server — sent counts show, but opens/clicks won't populate until it's configured.</div>
      )}

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
              const s = c.stats || {}
              const opens = s.unique_opens || 0, clicks = s.unique_clicks || 0
              return (
                <tr key={c.id}>
                  <td style={td}>
                    <div style={{ fontWeight: 600, color: 'var(--accent, #2563eb)', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.subject}
                      {c.source === 'sendgrid' && <span style={{ marginLeft: 8, fontSize: 10, background: '#e0e7ff', color: '#3730a3', padding: '1px 6px', borderRadius: 4, verticalAlign: 'middle' }}>SendGrid</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>From: {c.from_name || 'Matt Smith Team'}</div>
                  </td>
                  <td style={{ ...td, color: 'var(--text-muted)' }}>🕒 {ago(c.created_at)}</td>
                  <td style={td}>{c.status === 'finished' ? <span style={{ color: '#10b981' }}>✓ Finished</span> : <span style={{ color: '#f59e0b' }}>⏳ Sending</span>}</td>
                  <td style={td}>✉ {c.recipients || 0}</td>
                  <td style={td}>➤ {c.sent || 0}</td>
                  <td style={td}>{stat(opens, c.sent, '#10b981')}</td>
                  <td style={td}>{stat(clicks, c.sent, '#3b82f6')}</td>
                  <td style={td}>{stat(s.unsubscribes, c.sent, '#f59e0b')}</td>
                  <td style={td}>{stat(s.bounces, c.recipients, '#ef4444')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
        Opens/clicks require open- &amp; click-tracking enabled in SendGrid (Settings → Tracking) and can take a few hours to populate after a send. % is of Sent (bounces are of Recipients).
      </p>
    </div>
  )
}
